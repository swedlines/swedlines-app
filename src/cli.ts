import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildApi } from "./build/api.ts";
import { serveStatic } from "./build/serve.ts";
import { buildSite } from "./build/site.ts";
import { enabledSources, loadSources, SourcesConfigError } from "./config/sources.ts";
import { clusterPending, createAnthropicClusterer } from "./pipeline/cluster.ts";
import { commitAll, push } from "./pipeline/git.ts";
import { commitMessage, ingest } from "./pipeline/ingest.ts";
import { ContentStore } from "./pipeline/store.ts";
import {
  createAnthropicTranslator,
  DEFAULT_MODEL,
  exportPending,
  importTranslations,
  outputSchema,
  resetTranslations,
  translatePending,
} from "./pipeline/translate.ts";

const USAGE = `Usage: npm run cli -- <command> [options]

Commands:
  sources            List configured sources
  sources --check    Validate sources.yaml and exit non-zero on error
  ingest             Fetch all enabled feeds and write new items to the content repo
    --content <dir>    Path to the content repo checkout (default: content-repo)
    --only <keys>      Comma-separated source keys
    --dry-run          Fetch and report, write nothing
    --commit           Commit new items in the content repo
    --push             Push after committing (implies --commit)
  translate          Translate pending items to English and categorise them (needs ANTHROPIC_API_KEY)
    --content <dir>    Path to the content repo checkout (default: content-repo)
    --days <n>         Only items published in the last n days (default: 3)
    --limit <n>        Translate at most n items
    --model <id>       Anthropic model (default: ${DEFAULT_MODEL}, or SWEDLINES_MODEL)
    --dry-run          Call the model but write nothing
  translate-reset    Mark one day's translated items pending again (e.g. after a glossary change)
    --date <YYYY-MM-DD>  Stockholm date (required)
    --only-older       Skip items already translated with the current prompt version
    --dry-run          Report only
  translate-export   Write pending items as JSON batches for translation outside the API
    --out <dir>        Output directory (default: translate-work)
    --batch-size <n>   Items per file (default: 25)
  translate-import   Apply translated JSON files (same schema as the model output)
    --in <file...>     One or more JSON files
    --provider <name>  Provenance (default: claude-code)
    --model <id>       Provenance (default: claude-fable-5-1)
  cluster            Group recent articles that report the same story (Top view; needs ANTHROPIC_API_KEY)
    --content <dir>    Path to the content repo checkout (default: content-repo)
    --model <id>       Anthropic model (default: ${DEFAULT_MODEL}, or SWEDLINES_MODEL)
    --dry-run          Call the model but write nothing
  build              Generate docs/ (static API + site) from the content repo
    --content <dir>    Path to the content repo checkout (default: content-repo)
    --domain <host>    Write a CNAME file for GitHub Pages (or SWEDLINES_DOMAIN env)
    --top-tab          Show the Top tab on the front page (or SWEDLINES_TOP_TAB=1)
  serve              Serve <content>/docs locally for preview
    --port <n>         Port (default: 8787)
`;

async function sourcesCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      check: { type: "boolean", default: false },
      file: { type: "string", default: "sources.yaml" },
    },
  });

  let config: Awaited<ReturnType<typeof loadSources>>;
  try {
    config = await loadSources(values.file);
  } catch (err) {
    if (err instanceof SourcesConfigError) {
      console.error(`sources.yaml invalid:\n${err.message}`);
      return 1;
    }
    throw err;
  }

  const enabled = enabledSources(config);
  if (values.check) {
    console.log(`ok: ${config.sources.length} sources, ${enabled.length} enabled`);
    return 0;
  }

  for (const s of config.sources) {
    const flag = s.enabled ? "on " : "off";
    const tier = s.tier ? `t${s.tier}` : "--";
    console.log(
      `${flag} ${tier} ${s.key.padEnd(12)} ${s.name.padEnd(22)} ${s.feeds.length} feed(s)`,
    );
  }
  return 0;
}

async function ingestCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      content: { type: "string", default: "content-repo" },
      only: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      commit: { type: "boolean", default: false },
      push: { type: "boolean", default: false },
      file: { type: "string", default: "sources.yaml" },
    },
  });

  const config = await loadSources(values.file);
  const store = new ContentStore(values.content);
  const report = await ingest({
    config,
    store,
    dryRun: values["dry-run"],
    ...(values.only ? { only: values.only.split(",").map((k) => k.trim()) } : {}),
    log: (line) => console.log(line),
  });
  console.log(`total new=${report.written} (${report.startedAt} → ${report.finishedAt})`);

  if (report.allFailed) {
    console.error("every feed failed or returned nothing; refusing to continue");
    return 1;
  }
  if (values["dry-run"]) return 0;

  if (values.commit || values.push) {
    const sha = await commitAll(values.content, commitMessage(report));
    if (!sha) {
      console.log("nothing to commit");
      return 0;
    }
    console.log(`committed ${sha}`);
    if (values.push) {
      await push(values.content);
      console.log("pushed");
    }
  }
  return 0;
}

async function translateCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      content: { type: "string", default: "content-repo" },
      days: { type: "string", default: "3" },
      limit: { type: "string" },
      model: { type: "string", default: process.env.SWEDLINES_MODEL || DEFAULT_MODEL },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const store = new ContentStore(values.content);
  const report = await translatePending({
    store,
    translateBatch: createAnthropicTranslator({ model: values.model }),
    days: Number(values.days),
    ...(values.limit ? { limit: Number(values.limit) } : {}),
    dryRun: values["dry-run"],
    log: (line) => console.log(line),
  });
  console.log(
    `translated=${report.translated} skipped=${report.skipped} failed=${report.failed} ` +
      `of ${report.candidates} pending in ${report.batches} batch(es); ` +
      `tokens in=${report.usage.input} cached=${report.usage.cached} out=${report.usage.output}`,
  );
  for (const e of report.errors.slice(0, 10)) console.error(`  ! ${e}`);
  return report.candidates > 0 && report.translated === 0 ? 1 : 0;
}

async function translateResetCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      content: { type: "string", default: "content-repo" },
      date: { type: "string" },
      "only-older": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.date || !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
    console.error("translate-reset needs --date YYYY-MM-DD");
    return 2;
  }
  const { PROMPT_VERSION } = await import("./prompts/translate.ts");
  const r = await resetTranslations({
    store: new ContentStore(values.content),
    date: values.date,
    exceptPromptVersion: values["only-older"] ? PROMPT_VERSION : undefined,
    dryRun: values["dry-run"],
  });
  console.log(
    `${values["dry-run"] ? "would reset" : "reset"} ${r.reset} items on ${values.date} (skipped ${r.skipped} already on current prompt)`,
  );
  return 0;
}

async function translateExportCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      content: { type: "string", default: "content-repo" },
      days: { type: "string", default: "3" },
      out: { type: "string", default: "translate-work" },
      "batch-size": { type: "string", default: "25" },
    },
  });
  const batches = await exportPending({
    store: new ContentStore(values.content),
    days: Number(values.days),
    batchSize: Number(values["batch-size"]),
  });
  await mkdir(values.out, { recursive: true });
  let total = 0;
  for (const [i, batch] of batches.entries()) {
    const name = `batch-${String(i + 1).padStart(3, "0")}.json`;
    await writeFile(join(values.out, name), `${JSON.stringify(batch, null, 1)}\n`, "utf8");
    total += batch.length;
  }
  console.log(`${total} pending items in ${batches.length} file(s) under ${values.out}/`);
  return 0;
}

async function translateImportCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      content: { type: "string", default: "content-repo" },
      in: { type: "string", multiple: true },
      provider: { type: "string", default: "claude-code" },
      model: { type: "string", default: "claude-fable-5-1" },
    },
  });
  if (!values.in?.length) {
    console.error("translate-import needs at least one --in <file>");
    return 2;
  }
  const store = new ContentStore(values.content);
  let applied = 0;
  for (const file of values.in) {
    const parsed = outputSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) {
      console.error(`${file}: does not match the output schema\n${parsed.error.message}`);
      return 1;
    }
    const r = await importTranslations({
      store,
      output: parsed.data,
      provider: values.provider,
      model: values.model,
    });
    console.log(`${file}: applied=${r.applied} unknown=${r.unknown} alreadyDone=${r.alreadyDone}`);
    applied += r.applied;
  }
  console.log(`total applied=${applied}`);
  return 0;
}

async function clusterCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      content: { type: "string", default: "content-repo" },
      model: { type: "string", default: process.env.SWEDLINES_MODEL || DEFAULT_MODEL },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const report = await clusterPending({
    store: new ContentStore(values.content),
    clusterBatch: createAnthropicClusterer({ model: values.model }),
    dryRun: values["dry-run"],
    log: (line) => console.log(line),
  });
  console.log(
    `clustered ${report.candidates} new: joined=${report.joined} started=${report.started} ` +
      `single=${report.singletons} failed=${report.failed} in ${report.batches} batch(es); ` +
      `${report.stories} stories kept; tokens in=${report.usage.input} cached=${report.usage.cached} out=${report.usage.output}`,
  );
  for (const e of report.errors.slice(0, 10)) console.error(`  ! ${e}`);
  return report.batches > 0 && report.errors.length === report.batches ? 1 : 0;
}

/** package.json version plus the current commit of this checkout (GITHUB_SHA in Actions, git otherwise). */
async function appVersion(): Promise<{ version: string; commit?: string | undefined }> {
  const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
    version: string;
  };
  let commit = process.env.GITHUB_SHA;
  if (!commit) {
    try {
      commit = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      commit = undefined;
    }
  }
  return { version: pkg.version, commit: commit || undefined };
}

async function buildCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      content: { type: "string", default: "content-repo" },
      file: { type: "string", default: "sources.yaml" },
      domain: { type: "string", default: process.env.SWEDLINES_DOMAIN },
      "top-tab": { type: "boolean", default: process.env.SWEDLINES_TOP_TAB === "1" },
    },
  });
  const config = await loadSources(values.file);
  const store = new ContentStore(values.content);
  const publicDir = join(values.content, "docs");
  const api = await buildApi({ store, config, publicDir });
  const site = await buildSite({
    publicDir,
    appRoot: process.cwd(),
    domain: values.domain,
    config,
    version: await appVersion(),
    topTab: values["top-tab"],
  });
  console.log(
    `built ${api.files} API files (${api.articles} articles, ${api.days} days) + ${site.join(", ")}`,
  );
  return 0;
}

async function serveCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      content: { type: "string", default: "content-repo" },
      port: { type: "string", default: "8787" },
    },
  });
  const port = await serveStatic(join(values.content, "docs"), Number(values.port));
  console.log(`serving ${join(values.content, "docs")} at http://localhost:${port}/`);
  return new Promise(() => {}); // run until killed
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "sources":
      return sourcesCommand(rest);
    case "ingest":
      return ingestCommand(rest);
    case "translate":
      return translateCommand(rest);
    case "translate-reset":
      return translateResetCommand(rest);
    case "translate-export":
      return translateExportCommand(rest);
    case "translate-import":
      return translateImportCommand(rest);
    case "cluster":
      return clusterCommand(rest);
    case "build":
      return buildCommand(rest);
    case "serve":
      return serveCommand(rest);
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
