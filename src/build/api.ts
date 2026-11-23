import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourcesConfig } from "../config/sources.ts";
import { enabledSources } from "../config/sources.ts";
import { type Article, articleSchema } from "../model/article.ts";
import { STORIES_STATE, type StoriesState, storiesStateSchema } from "../pipeline/cluster.ts";
import type { ContentStore } from "../pipeline/store.ts";
import { stockholmDate, toStockholmIso } from "../util/time.ts";

export const API_PREFIX = "api/v1";
export const LATEST_COUNT = 200;
export const TICKER_COUNT = 50;
/** Top view: stories need this many distinct publishers and an article within the window. */
export const TOP_MIN_SOURCES = 2;
export const TOP_WINDOW_HOURS = 12;
export const TOP_COUNT = 30;

export async function loadAllArticles(store: ContentStore): Promise<Article[]> {
  let files: string[];
  try {
    files = await readdir(store.contentDir, { recursive: true, encoding: "utf8" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const articles: Article[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const raw = JSON.parse(await readFile(join(store.contentDir, f), "utf8"));
    articles.push(articleSchema.parse(raw));
  }
  // Newest first; ties broken by id for a stable order.
  articles.sort((a, b) => b.published_at.localeCompare(a.published_at) || a.id.localeCompare(b.id));
  return articles;
}

function envelope(items: Article[], generatedAt: string) {
  return { generated_at: generatedAt, count: items.length, items };
}

function tickerItem(a: Article) {
  return {
    id: a.id,
    source: a.source,
    url: a.url,
    published_at: a.published_at,
    sv: { title: a.sv.title },
    ...(a.en ? { en: { title: a.en.title } } : {}),
  };
}

export interface TopStory {
  id: string;
  source_count: number;
  sources: string[];
  first_published_at: string;
  last_published_at: string;
  lead: Article;
  items: ReturnType<typeof tickerItem>[];
}

/**
 * Rank stories by distinct publishers, then by their newest article (SPEC §8). The lead is the
 * earliest article: Swedlines shows a publisher's own headline, never one it writes itself.
 */
export function rankTopStories(all: Article[], state: StoriesState | null, now: Date): TopStory[] {
  if (!state) return [];
  const byId = new Map(all.map((a) => [a.id, a]));
  const cutoff = now.getTime() - TOP_WINDOW_HOURS * 3_600_000;
  const out: TopStory[] = [];
  for (const [id, story] of Object.entries(state.stories)) {
    const items = story.items
      .map((i) => byId.get(i))
      .filter((a): a is Article => !!a)
      .sort((a, b) => a.published_at.localeCompare(b.published_at) || a.id.localeCompare(b.id));
    const lead = items[0];
    const last = items.at(-1);
    if (!lead || !last) continue;
    const sources = [...new Set(items.map((a) => a.source))];
    if (sources.length < TOP_MIN_SOURCES) continue;
    if (new Date(last.published_at).getTime() < cutoff) continue;
    out.push({
      id,
      source_count: sources.length,
      sources,
      first_published_at: lead.published_at,
      last_published_at: last.published_at,
      lead,
      items: [...items].reverse().map(tickerItem),
    });
  }
  out.sort(
    (a, b) =>
      b.source_count - a.source_count ||
      new Date(b.last_published_at).getTime() - new Date(a.last_published_at).getTime() ||
      a.id.localeCompare(b.id),
  );
  return out.slice(0, TOP_COUNT);
}

async function writeJson(root: string, rel: string, data: unknown): Promise<void> {
  const abs = join(root, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export interface BuildApiResult {
  articles: number;
  days: number;
  files: number;
}

/** Generate the static JSON API under <publicDir>/api/v1 (SPEC §6). */
export async function buildApi(opts: {
  store: ContentStore;
  config: SourcesConfig;
  publicDir: string;
  now?: Date;
}): Promise<BuildApiResult> {
  const now = opts.now ?? new Date();
  const generatedAt = toStockholmIso(now);
  const all = await loadAllArticles(opts.store);
  const sources = enabledSources(opts.config);
  let files = 0;
  const put = async (rel: string, data: unknown) => {
    await writeJson(opts.publicDir, join(API_PREFIX, rel), data);
    files++;
  };

  await put("latest.json", envelope(all.slice(0, LATEST_COUNT), generatedAt));
  await put("ticker.json", {
    generated_at: generatedAt,
    count: Math.min(TICKER_COUNT, all.length),
    items: all.slice(0, TICKER_COUNT).map(tickerItem),
  });

  const rawStories = await opts.store.readState(STORIES_STATE);
  const top = rankTopStories(all, rawStories ? storiesStateSchema.parse(rawStories) : null, now);
  await put("top.json", { generated_at: generatedAt, count: top.length, stories: top });

  const byDay = new Map<string, Article[]>();
  for (const a of all) {
    const { year, month, day } = stockholmDate(new Date(a.published_at));
    const key = `${year}-${month}-${day}`;
    const list = byDay.get(key);
    if (list) list.push(a);
    else byDay.set(key, [a]);
  }
  const dayKeys = [...byDay.keys()].sort().reverse();
  for (const key of dayKeys) {
    await put(`days/${key}.json`, envelope(byDay.get(key) ?? [], generatedAt));
  }
  await put("days/index.json", {
    generated_at: generatedAt,
    days: dayKeys.map((d) => ({ date: d, count: byDay.get(d)?.length ?? 0 })),
  });
  const today = dayKeys[0];
  await put("ticker/daily.json", {
    generated_at: generatedAt,
    date: today ?? null,
    count: today ? (byDay.get(today)?.length ?? 0) : 0,
    items: today ? (byDay.get(today) ?? []).map(tickerItem) : [],
  });

  const counts = new Map<string, number>();
  for (const a of all) counts.set(a.source, (counts.get(a.source) ?? 0) + 1);
  await put("sources.json", {
    generated_at: generatedAt,
    sources: sources.map((s) => ({
      key: s.key,
      name: s.name,
      homepage: s.homepage,
      paywall: s.paywall ?? null,
      items: counts.get(s.key) ?? 0,
    })),
  });
  for (const s of sources) {
    const mine = all.filter((a) => a.source === s.key);
    await put(`sources/${s.key}/latest.json`, envelope(mine.slice(0, LATEST_COUNT), generatedAt));
  }

  const categories = new Set(all.map((a) => a.category));
  for (const c of categories) {
    const mine = all.filter((a) => a.category === c);
    await put(`categories/${c}/latest.json`, envelope(mine.slice(0, LATEST_COUNT), generatedAt));
    await put(`ticker/${c}.json`, {
      generated_at: generatedAt,
      count: Math.min(TICKER_COUNT, mine.length),
      items: mine.slice(0, TICKER_COUNT).map(tickerItem),
    });
  }

  const feedStates = await opts.store.readFeedStates();
  await put("status.json", {
    generated_at: generatedAt,
    articles: all.length,
    days: dayKeys.length,
    translated: all.filter((a) => a.translation.status === "done").length,
    feeds: feedStates,
  });

  return { articles: all.length, days: dayKeys.length, files };
}
