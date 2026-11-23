import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Article, articleSchema, serializeArticle } from "../model/article.ts";
import { stockholmDate } from "../util/time.ts";
import type { FeedState } from "./fetch.ts";

/**
 * The content repository on disk:
 *   content/YYYY/MM/DD/<id>.json   one file per article
 *   state/feeds.json               per-feed ETag / Last-Modified cache
 *   state/stories.json             story grouping for the Top view (pipeline/cluster.ts)
 */
export class ContentStore {
  readonly root: string;
  readonly contentDir: string;
  readonly stateDir: string;

  constructor(root: string) {
    this.root = root;
    this.contentDir = join(root, "content");
    this.stateDir = join(root, "state");
  }

  /** Relative path of an article's file, derived from its Stockholm publish date. */
  static relativePath(article: Article): string {
    const { year, month, day } = stockholmDate(new Date(article.published_at));
    return join("content", year, month, day, `${article.id}.json`);
  }

  /** All article ids currently stored. Walks the whole tree; cheap at this scale. */
  async knownIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    let entries: string[];
    try {
      entries = await readdir(this.contentDir, { recursive: true, encoding: "utf8" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return ids;
      throw err;
    }
    for (const name of entries) {
      const file = name.split("/").pop() ?? "";
      if (/^[0-9a-f]{12}\.json$/.test(file)) ids.add(file.slice(0, 12));
    }
    return ids;
  }

  /** Articles published on or after `since`, by walking only the day directories in range. */
  async listArticles(opts: { since: Date }): Promise<Article[]> {
    const out: Article[] = [];
    const start = stockholmDate(opts.since);
    const startKey = `${start.year}${start.month}${start.day}`;
    let entries: string[];
    try {
      entries = await readdir(this.contentDir, { recursive: true, encoding: "utf8" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
      throw err;
    }
    for (const rel of entries) {
      const m = /^(\d{4})\/(\d{2})\/(\d{2})\/[0-9a-f]{12}\.json$/.exec(rel);
      if (!m || `${m[1]}${m[2]}${m[3]}` < startKey) continue;
      const raw = JSON.parse(await readFile(join(this.contentDir, rel), "utf8"));
      out.push(articleSchema.parse(raw));
    }
    return out;
  }

  async write(article: Article): Promise<string> {
    articleSchema.parse(article);
    const rel = ContentStore.relativePath(article);
    const abs = join(this.root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    const tmp = `${abs}.tmp`;
    await writeFile(tmp, serializeArticle(article), "utf8");
    await rename(tmp, abs);
    return rel;
  }

  async readFeedStates(): Promise<Record<string, FeedState>> {
    try {
      const text = await readFile(join(this.stateDir, "feeds.json"), "utf8");
      return JSON.parse(text) as Record<string, FeedState>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  async writeFeedStates(states: Record<string, FeedState>): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    const sorted = Object.fromEntries(
      Object.entries(states).sort(([a], [b]) => a.localeCompare(b)),
    );
    await writeFile(
      join(this.stateDir, "feeds.json"),
      `${JSON.stringify(sorted, null, 2)}\n`,
      "utf8",
    );
  }

  /** A JSON file under state/, or null when it does not exist yet. */
  async readState(name: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(join(this.stateDir, name), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async writeState(name: string, data: unknown): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    const abs = join(this.stateDir, name);
    await writeFile(`${abs}.tmp`, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(`${abs}.tmp`, abs);
  }
}
