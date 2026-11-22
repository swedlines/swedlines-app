import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { CATEGORIES, type Category } from "../config/sources.ts";
import type { Article } from "../model/article.ts";
import { CATEGORY_LIST, PROMPT_VERSION, SYSTEM_PROMPT } from "../prompts/translate.ts";
import { toStockholmIso } from "../util/time.ts";
import type { ContentStore } from "./store.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_BATCH_SIZE = 25;

export interface TranslateInput {
  id: string;
  title: string;
  summary?: string | undefined;
}

export const outputSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      title_en: z.string(),
      summary_en: z.string().nullable(),
      category: z.enum(CATEGORY_LIST),
    }),
  ),
});
export type TranslateOutput = z.infer<typeof outputSchema>;

export type BatchResult =
  | {
      ok: true;
      output: TranslateOutput;
      model: string;
      usage?: { input: number; output: number; cached: number };
    }
  | { ok: false; kind: "refusal"; reason: string }
  | { ok: false; kind: "error"; reason: string };

/** Translate one batch. Injected so tests never touch the network. */
export type TranslateBatchFn = (batch: TranslateInput[]) => Promise<BatchResult>;

export function createAnthropicTranslator(opts: {
  model?: string;
  effort?: "low" | "medium" | "high";
  client?: Anthropic;
}): TranslateBatchFn {
  const client = opts.client ?? new Anthropic();
  const model = opts.model ?? DEFAULT_MODEL;
  const effort = opts.effort ?? "low";

  return async (batch) => {
    const payload = batch.map((b) => ({ id: b.id, title: b.title, summary: b.summary ?? null }));
    try {
      const response = await client.messages.parse({
        model,
        max_tokens: 16000,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: `Translate and categorise these ${batch.length} items:\n\n${JSON.stringify(payload, null, 1)}`,
          },
        ],
        output_config: { effort, format: zodOutputFormat(outputSchema) },
      });
      if (response.stop_reason === "refusal") {
        const d = response.stop_details;
        return {
          ok: false,
          kind: "refusal",
          reason: `refusal${d?.category ? ` (${d.category})` : ""}`,
        };
      }
      if (response.stop_reason === "max_tokens") {
        return { ok: false, kind: "error", reason: "max_tokens reached; reduce batch size" };
      }
      if (!response.parsed_output) {
        return { ok: false, kind: "error", reason: "response did not match the output schema" };
      }
      return {
        ok: true,
        output: response.parsed_output,
        model: response.model,
        usage: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
          cached: response.usage.cache_read_input_tokens ?? 0,
        },
      };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new Error("Anthropic authentication failed: set ANTHROPIC_API_KEY");
      }
      if (err instanceof Anthropic.APIError) {
        return { ok: false, kind: "error", reason: `API error ${err.status}: ${err.message}` };
      }
      return { ok: false, kind: "error", reason: (err as Error).message };
    }
  };
}

export interface TranslateReport {
  candidates: number;
  translated: number;
  skipped: number;
  failed: number;
  batches: number;
  errors: string[];
  usage: { input: number; output: number; cached: number };
}

export interface TranslateOptions {
  store: ContentStore;
  translateBatch: TranslateBatchFn;
  /** Only consider articles published within this many days (default 3). */
  days?: number;
  /** Stop after this many articles (default: all pending). */
  limit?: number;
  batchSize?: number;
  dryRun?: boolean;
  now?: () => Date;
  log?: (line: string) => void;
  provider?: string;
}

function isCategory(c: string): c is Category {
  return (CATEGORIES as readonly string[]).includes(c);
}

export async function translatePending(opts: TranslateOptions): Promise<TranslateReport> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const report: TranslateReport = {
    candidates: 0,
    translated: 0,
    skipped: 0,
    failed: 0,
    batches: 0,
    errors: [],
    usage: { input: 0, output: 0, cached: 0 },
  };

  const since = new Date(now().getTime() - (opts.days ?? 3) * 86_400_000);
  const all = await opts.store.listArticles({ since });
  let pending = all
    .filter((a) => a.translation.status === "pending")
    .sort((a, b) => b.published_at.localeCompare(a.published_at));
  if (opts.limit !== undefined) pending = pending.slice(0, opts.limit);
  report.candidates = pending.length;
  if (pending.length === 0) return report;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    report.batches++;
    const result = await opts.translateBatch(
      batch.map((a) => ({ id: a.id, title: a.sv.title, summary: a.sv.summary })),
    );

    if (!result.ok) {
      report.errors.push(result.reason);
      if (result.kind === "refusal") {
        // Mark the whole batch skipped; a later run with a smaller batch can retry by hand.
        for (const a of batch) {
          a.translation = { status: "skipped", error: result.reason };
          if (!opts.dryRun) await opts.store.write(a);
          report.skipped++;
        }
      } else {
        report.failed += batch.length;
      }
      log(`batch ${report.batches}: ${result.kind} — ${result.reason}`);
      continue;
    }

    if (result.usage) {
      report.usage.input += result.usage.input;
      report.usage.output += result.usage.output;
      report.usage.cached += result.usage.cached;
    }
    const byId = new Map(result.output.items.map((o) => [o.id, o]));
    const translatedAt = toStockholmIso(now());
    for (const a of batch) {
      const out = byId.get(a.id);
      if (!out?.title_en.trim()) {
        report.failed++;
        report.errors.push(`${a.id}: missing from model output`);
        continue;
      }
      applyTranslation(a, out, {
        provider: opts.provider ?? "anthropic",
        model: result.model,
        translatedAt,
      });
      if (!opts.dryRun) await opts.store.write(a);
      report.translated++;
    }
    log(
      `batch ${report.batches}: ${batch.length} items, tokens in=${result.usage?.input ?? "?"} ` +
        `cached=${result.usage?.cached ?? "?"} out=${result.usage?.output ?? "?"}`,
    );
  }
  return report;
}

export function applyTranslation(
  a: Article,
  out: TranslateOutput["items"][number],
  meta: { provider: string; model: string; translatedAt: string },
): void {
  a.en = { title: out.title_en.trim() };
  if (a.sv.summary && out.summary_en?.trim()) a.en.summary = out.summary_en.trim();
  if (a.category === "general" && isCategory(out.category)) a.category = out.category;
  a.translation = {
    status: "done",
    provider: meta.provider,
    model: meta.model,
    prompt_version: PROMPT_VERSION,
    translated_at: meta.translatedAt,
  };
}

/** Pending items as model-ready batches, for translating outside the API (e.g. in a Claude session). */
export async function exportPending(opts: {
  store: ContentStore;
  days?: number;
  batchSize?: number;
  now?: () => Date;
}): Promise<TranslateInput[][]> {
  const now = opts.now ?? (() => new Date());
  const since = new Date(now().getTime() - (opts.days ?? 3) * 86_400_000);
  const pending = (await opts.store.listArticles({ since }))
    .filter((a) => a.translation.status === "pending")
    .sort((a, b) => b.published_at.localeCompare(a.published_at))
    .map((a) => ({ id: a.id, title: a.sv.title, summary: a.sv.summary }));
  const size = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const batches: TranslateInput[][] = [];
  for (let i = 0; i < pending.length; i += size) batches.push(pending.slice(i, i + size));
  return batches;
}

/** Apply a translated batch produced outside the API. Unknown or already-done ids are ignored. */
export async function importTranslations(opts: {
  store: ContentStore;
  output: TranslateOutput;
  provider: string;
  model: string;
  days?: number;
  now?: () => Date;
}): Promise<{ applied: number; unknown: number; alreadyDone: number }> {
  const now = opts.now ?? (() => new Date());
  const since = new Date(now().getTime() - (opts.days ?? 30) * 86_400_000);
  const byId = new Map((await opts.store.listArticles({ since })).map((a) => [a.id, a]));
  const translatedAt = toStockholmIso(now());
  let applied = 0;
  let unknown = 0;
  let alreadyDone = 0;
  for (const out of opts.output.items) {
    const a = byId.get(out.id);
    if (!a) {
      unknown++;
      continue;
    }
    if (a.translation.status === "done") {
      alreadyDone++;
      continue;
    }
    applyTranslation(a, out, { provider: opts.provider, model: opts.model, translatedAt });
    await opts.store.write(a);
    applied++;
  }
  return { applied, unknown, alreadyDone };
}

/**
 * Mark translated items published on `date` (Stockholm, YYYY-MM-DD) as pending again so the next
 * translate run redoes them, e.g. after a glossary change. The existing `en` text is kept until
 * replaced, so the site never shows a gap.
 */
export async function resetTranslations(opts: {
  store: ContentStore;
  date: string;
  /** Only reset items translated with a prompt version other than this one (default: all). */
  exceptPromptVersion?: string | undefined;
  dryRun?: boolean;
}): Promise<{ reset: number; skipped: number }> {
  const since = new Date(`${opts.date}T00:00:00+01:00`);
  since.setDate(since.getDate() - 1); // listArticles walks by day directory; include the day before for safety
  const all = await opts.store.listArticles({ since });
  let reset = 0;
  let skipped = 0;
  for (const a of all) {
    if (!a.published_at.startsWith(opts.date) || a.translation.status !== "done") continue;
    if (opts.exceptPromptVersion && a.translation.prompt_version === opts.exceptPromptVersion) {
      skipped++;
      continue;
    }
    a.translation = { ...a.translation, status: "pending" };
    if (!opts.dryRun) await opts.store.write(a);
    reset++;
  }
  return { reset, skipped };
}
