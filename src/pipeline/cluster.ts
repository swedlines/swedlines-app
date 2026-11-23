import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Article } from "../model/article.ts";
import { CLUSTER_PROMPT_VERSION, CLUSTER_SYSTEM_PROMPT } from "../prompts/cluster.ts";
import { toStockholmIso } from "../util/time.ts";
import type { ContentStore } from "./store.ts";
import { DEFAULT_MODEL } from "./translate.ts";

/**
 * Story grouping (SPEC §8, Top view). Articles that report the same story are grouped into a
 * story; a story's id is the id of the article that started it. Articles stay immutable: the
 * grouping lives in state/stories.json in the content repo.
 *
 * Each run only handles articles not yet in any story. A cheap word-overlap pass finds candidate
 * earlier articles within MATCH_WINDOW_HOURS; the model then confirms or rejects the match.
 * Articles with no candidates become single-article stories without a model call.
 */

export const MATCH_WINDOW_HOURS = 12;
/** Only articles published this recently are grouped; older ungrouped ones are left alone. */
export const NEW_WINDOW_HOURS = 24;
/** Stories whose newest article is older than this are dropped from the state file. */
export const KEEP_DAYS = 3;
export const MAX_CANDIDATES = 6;
export const CLUSTER_BATCH_SIZE = 40;
export const STORIES_STATE = "stories.json";

export const storiesStateSchema = z.object({
  version: z.literal(1),
  prompt_version: z.string(),
  updated_at: z.string(),
  stories: z.record(
    z.string(),
    z.object({
      items: z.array(z.string()).min(1),
      last_published_at: z.string(),
    }),
  ),
});
export type StoriesState = z.infer<typeof storiesStateSchema>;

export function emptyStories(now: Date): StoriesState {
  return {
    version: 1,
    prompt_version: CLUSTER_PROMPT_VERSION,
    updated_at: toStockholmIso(now),
    stories: {},
  };
}

// Common Swedish words of five or more letters that carry no story identity.
const STOPWORDS = new Set(
  (
    "efter under inför innan mellan genom utan över enligt kring sedan medan trots därför varför " +
    "också redan bara inget ingen inga några många flera alla allt andra annan annat första " +
    "stora stort större största detta denna dessa deras hennes vilket vilken vilka nästa senaste " +
    "säger sägs kommer skulle måste kunde kunna vill ville blir blev bliva varit hade hette " +
    "sverige svensk svenska svenskt svenskar landet idag igår imorgon dagen veckan året timmar " +
    "minuter nyheter direkt live just nu frågan talar menar uppger uppgifter"
  ).split(/\s+/),
);

/** Normalised word stems used for the candidate pass: 5-letter prefixes of significant words. */
export function stems(title: string): Set<string> {
  const out = new Set<string>();
  for (const raw of title.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 5 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(raw.slice(0, 5));
  }
  return out;
}

export interface ClusterCandidate {
  id: string;
  source: string;
  titles: string[];
}

export interface ClusterInput {
  id: string;
  source: string;
  published: string;
  title: string;
  summary?: string | undefined;
  candidates: ClusterCandidate[];
}

export const clusterOutputSchema = z.object({
  items: z.array(z.object({ id: z.string(), match: z.string().nullable() })),
});
export type ClusterOutput = z.infer<typeof clusterOutputSchema>;

export type ClusterBatchResult =
  | {
      ok: true;
      output: ClusterOutput;
      usage?: { input: number; output: number; cached: number };
    }
  | { ok: false; reason: string };

/** Decide one batch. Injected so tests never touch the network. */
export type ClusterBatchFn = (batch: ClusterInput[]) => Promise<ClusterBatchResult>;

export function createAnthropicClusterer(opts: {
  model?: string;
  client?: Anthropic;
}): ClusterBatchFn {
  const client = opts.client ?? new Anthropic();
  const model = opts.model ?? DEFAULT_MODEL;
  return async (batch) => {
    try {
      const response = await client.messages.parse({
        model,
        max_tokens: 16000,
        system: [
          { type: "text", text: CLUSTER_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        ],
        messages: [
          {
            role: "user",
            content: `Group these ${batch.length} new articles:\n\n${JSON.stringify(batch, null, 1)}`,
          },
        ],
        output_config: { effort: "low", format: zodOutputFormat(clusterOutputSchema) },
      });
      if (response.stop_reason === "refusal") {
        const d = response.stop_details;
        return { ok: false, reason: `refusal${d?.category ? ` (${d.category})` : ""}` };
      }
      if (response.stop_reason === "max_tokens") {
        return { ok: false, reason: "max_tokens reached; reduce batch size" };
      }
      if (!response.parsed_output) {
        return { ok: false, reason: "response did not match the output schema" };
      }
      return {
        ok: true,
        output: response.parsed_output,
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
        return { ok: false, reason: `API error ${err.status}: ${err.message}` };
      }
      return { ok: false, reason: (err as Error).message };
    }
  };
}

export interface ClusterReport {
  candidates: number;
  singletons: number;
  joined: number;
  started: number;
  failed: number;
  batches: number;
  stories: number;
  errors: string[];
  usage: { input: number; output: number; cached: number };
}

const HOUR = 3_600_000;
const ms = (a: Article) => new Date(a.published_at).getTime();
const clip = (s: string | undefined, n: number) =>
  s && s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** Group every not-yet-grouped article from the last NEW_WINDOW_HOURS into stories. */
export async function clusterPending(opts: {
  store: ContentStore;
  clusterBatch: ClusterBatchFn;
  batchSize?: number;
  dryRun?: boolean;
  now?: () => Date;
  log?: (line: string) => void;
}): Promise<ClusterReport> {
  const now = (opts.now ?? (() => new Date()))();
  const log = opts.log ?? (() => {});
  const batchSize = opts.batchSize ?? CLUSTER_BATCH_SIZE;
  const report: ClusterReport = {
    candidates: 0,
    singletons: 0,
    joined: 0,
    started: 0,
    failed: 0,
    batches: 0,
    stories: 0,
    errors: [],
    usage: { input: 0, output: 0, cached: 0 },
  };

  const raw = await opts.store.readState(STORIES_STATE);
  const state = raw ? storiesStateSchema.parse(raw) : emptyStories(now);

  // Load enough history for the match window behind the oldest new article.
  const since = new Date(now.getTime() - (NEW_WINDOW_HOURS + MATCH_WINDOW_HOURS) * HOUR);
  const articles = (await opts.store.listArticles({ since })).sort(
    (a, b) => ms(a) - ms(b) || a.id.localeCompare(b.id),
  );
  const byId = new Map(articles.map((a) => [a.id, a]));
  const storyOf = new Map<string, string>();
  for (const [sid, s] of Object.entries(state.stories))
    for (const id of s.items) storyOf.set(id, sid);

  const newCutoff = now.getTime() - NEW_WINDOW_HOURS * HOUR;
  const pending = articles.filter((a) => !storyOf.has(a.id) && ms(a) >= newCutoff);
  report.candidates = pending.length;
  const stemCache = new Map<string, Set<string>>();
  const stemOf = (a: Article) => {
    let s = stemCache.get(a.id);
    if (!s) {
      s = stems(a.sv.title);
      stemCache.set(a.id, s);
    }
    return s;
  };

  const addTo = (sid: string, a: Article) => {
    const s = state.stories[sid];
    if (s) {
      s.items.push(a.id);
      if (ms(a) > new Date(s.last_published_at).getTime()) s.last_published_at = a.published_at;
    } else {
      state.stories[sid] = { items: [a.id], last_published_at: a.published_at };
    }
    storyOf.set(a.id, sid);
  };

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const inBatch = new Set(batch.map((a) => a.id));

    // Candidate pass: earlier articles (grouped already, or earlier in this batch) sharing a stem.
    const inputs: ClusterInput[] = [];
    const allowed = new Map<string, Set<string>>();
    for (const a of batch) {
      const mine = stemOf(a);
      const scored = new Map<string, { score: number; gap: number }>();
      for (const b of articles) {
        if (b.id === a.id) continue;
        if (ms(b) > ms(a) || (ms(b) === ms(a) && b.id >= a.id)) continue; // only earlier ones
        if (ms(a) - ms(b) > MATCH_WINDOW_HOURS * HOUR) continue;
        const key = storyOf.get(b.id) ?? (inBatch.has(b.id) ? b.id : undefined);
        if (!key) continue;
        let shared = 0;
        for (const st of stemOf(b)) if (mine.has(st)) shared++;
        if (shared === 0) continue;
        const gap = ms(a) - ms(b);
        const prev = scored.get(key);
        if (!prev || shared > prev.score || (shared === prev.score && gap < prev.gap)) {
          scored.set(key, { score: shared, gap });
        }
      }
      const top = [...scored.entries()]
        .sort((x, y) => y[1].score - x[1].score || x[1].gap - y[1].gap)
        .slice(0, MAX_CANDIDATES);
      if (top.length === 0) continue;
      const candidates = top.map(([key]) => {
        const ids = state.stories[key]?.items ?? [key];
        const members = ids.map((id) => byId.get(id)).filter((m): m is Article => !!m);
        const lead = members[0] ?? byId.get(key);
        return {
          id: key,
          source: lead?.source ?? "",
          titles: members.slice(-2).map((m) => m.sv.title),
        };
      });
      allowed.set(a.id, new Set(candidates.map((c) => c.id)));
      inputs.push({
        id: a.id,
        source: a.source,
        published: a.published_at.slice(11, 16),
        title: a.sv.title,
        summary: clip(a.sv.summary, 200),
        candidates,
      });
    }

    let decisions = new Map<string, string | null>();
    let failed = false;
    if (inputs.length > 0) {
      report.batches++;
      const result = await opts.clusterBatch(inputs);
      if (!result.ok) {
        failed = true;
        report.errors.push(result.reason);
        log(`batch ${report.batches}: failed — ${result.reason}`);
      } else {
        if (result.usage) {
          report.usage.input += result.usage.input;
          report.usage.output += result.usage.output;
          report.usage.cached += result.usage.cached;
        }
        decisions = new Map(result.output.items.map((o) => [o.id, o.match]));
        log(
          `batch ${report.batches}: ${inputs.length} with candidates, tokens in=${result.usage?.input ?? "?"} ` +
            `cached=${result.usage?.cached ?? "?"} out=${result.usage?.output ?? "?"}`,
        );
      }
    }

    // Resolve in publish order, so a match to an earlier article in this batch finds its story.
    for (const a of batch) {
      const hadCandidates = allowed.has(a.id);
      if (!hadCandidates) {
        addTo(a.id, a);
        report.singletons++;
        continue;
      }
      if (failed || !decisions.has(a.id)) {
        report.failed++; // left ungrouped; the next run retries while it is still recent
        continue;
      }
      const match = decisions.get(a.id) ?? null;
      const target = match && allowed.get(a.id)?.has(match) ? storyOf.get(match) : undefined;
      if (target) {
        addTo(target, a);
        report.joined++;
      } else {
        addTo(a.id, a);
        report.started++;
      }
    }
  }

  // Forget stories that have gone quiet.
  const keepCutoff = now.getTime() - KEEP_DAYS * 24 * HOUR;
  for (const [sid, s] of Object.entries(state.stories)) {
    if (new Date(s.last_published_at).getTime() < keepCutoff) delete state.stories[sid];
  }
  state.prompt_version = CLUSTER_PROMPT_VERSION;
  state.updated_at = toStockholmIso(now);
  report.stories = Object.keys(state.stories).length;
  if (!opts.dryRun) await opts.store.writeState(STORIES_STATE, sortedState(state));
  return report;
}

/** Stable key order so the state file diffs cleanly. */
function sortedState(state: StoriesState): StoriesState {
  const stories = Object.fromEntries(
    Object.entries(state.stories).sort(([a], [b]) => a.localeCompare(b)),
  );
  return { ...state, stories };
}
