import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rankTopStories } from "../src/build/api.ts";
import type { Article } from "../src/model/article.ts";
import {
  type ClusterBatchFn,
  type ClusterInput,
  clusterPending,
  STORIES_STATE,
  type StoriesState,
  stems,
} from "../src/pipeline/cluster.ts";
import { ContentStore } from "../src/pipeline/store.ts";
import { toStockholmIso } from "../src/util/time.ts";

const NOW = new Date("2026-11-23T12:00:00Z");
const hoursAgo = (h: number) => toStockholmIso(new Date(NOW.getTime() - h * 3_600_000));

function article(id: string, source: string, title: string, h: number): Article {
  return {
    id,
    schema_version: 1,
    source,
    url: `https://example.com/${source}/${id}`,
    guid: id,
    published_at: hoursAgo(h),
    fetched_at: hoursAgo(h),
    category: "sweden",
    sv: { title },
    en: { title: `EN ${title}` },
    translation: { status: "done" },
  };
}

// Deterministic stand-in for the model: match the first candidate that shares two stems.
const fakeClusterer =
  (calls: ClusterInput[][] = []): ClusterBatchFn =>
  async (batch) => {
    calls.push(batch);
    return {
      ok: true,
      usage: { input: 100, output: 10, cached: 0 },
      output: {
        items: batch.map((b) => {
          const mine = stems(b.title);
          const hit = b.candidates.find((c) => {
            let n = 0;
            for (const st of stems(c.titles.join(" "))) if (mine.has(st)) n++;
            return n >= 2;
          });
          return { id: b.id, match: hit?.id ?? null };
        }),
      },
    };
  };

describe("story grouping", () => {
  let root: string;
  let store: ContentStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "swedlines-cluster-"));
    store = new ContentStore(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stems significant words and drops stopwords", () => {
    expect([...stems("Riksbanken sänker räntan efter beskedet i Sverige")].sort()).toEqual([
      "beske",
      "riksb",
      "räntan".slice(0, 5),
      "sänke",
    ]);
  });

  it("groups reports of one story across publishers and leaves unrelated ones alone", async () => {
    for (const a of [
      article("aaaaaaaaaaa1", "svt", "Riksbanken sänker styrräntan till två procent", 5),
      article("aaaaaaaaaaa2", "dn", "Riksbanken sänker styrräntan – lägsta på tre år", 4),
      article("aaaaaaaaaaa3", "svd", "Styrräntan sänks av Riksbanken", 3),
      article("bbbbbbbbbbb1", "expressen", "Brand i flerfamiljshus i Göteborg", 2),
      article("ccccccccccc1", "di", "Riksbanken får ny vice riksbankschef", 1),
    ]) {
      await store.write(a);
    }
    const calls: ClusterInput[][] = [];
    const report = await clusterPending({
      store,
      clusterBatch: fakeClusterer(calls),
      now: () => NOW,
    });
    expect(report.candidates).toBe(5);
    expect(report.joined).toBe(2);
    expect(report.failed).toBe(0);
    // The first article and the fire have no earlier lookalikes, so they never reach the model.
    const sent = calls.flat().map((c) => c.id);
    expect(sent).not.toContain("aaaaaaaaaaa1");
    expect(sent).not.toContain("bbbbbbbbbbb1");

    const state = (await store.readState(STORIES_STATE)) as StoriesState;
    expect(state.stories.aaaaaaaaaaa1?.items).toEqual([
      "aaaaaaaaaaa1",
      "aaaaaaaaaaa2",
      "aaaaaaaaaaa3",
    ]);
    expect(state.stories.ccccccccccc1?.items).toEqual(["ccccccccccc1"]);

    // Second run is a no-op: everything is grouped already.
    const again = await clusterPending({ store, clusterBatch: fakeClusterer(), now: () => NOW });
    expect(again.candidates).toBe(0);
    expect(again.batches).toBe(0);
  });

  it("ignores matches outside the candidate list and retries failed batches next run", async () => {
    await store.write(article("aaaaaaaaaaa1", "svt", "Riksbanken sänker styrräntan", 3));
    await store.write(article("aaaaaaaaaaa2", "dn", "Riksbanken sänker styrräntan igen", 2));

    const failing: ClusterBatchFn = async () => ({
      ok: false,
      reason: "API error 529: overloaded",
    });
    const r1 = await clusterPending({ store, clusterBatch: failing, now: () => NOW });
    expect(r1.failed).toBe(1);
    expect(r1.errors).toEqual(["API error 529: overloaded"]);

    const rogue: ClusterBatchFn = async (batch) => ({
      ok: true,
      output: { items: batch.map((b) => ({ id: b.id, match: "ffffffffffff" })) },
    });
    const r2 = await clusterPending({ store, clusterBatch: rogue, now: () => NOW });
    expect(r2.candidates).toBe(1);
    expect(r2.started).toBe(1);
    const state = (await store.readState(STORIES_STATE)) as StoriesState;
    expect(Object.keys(state.stories).sort()).toEqual(["aaaaaaaaaaa1", "aaaaaaaaaaa2"]);
  });

  it("does not look further back than the match window", async () => {
    await store.write(article("aaaaaaaaaaa1", "svt", "Riksbanken sänker styrräntan", 20));
    await store.write(article("aaaaaaaaaaa2", "dn", "Riksbanken sänker styrräntan", 2));
    const calls: ClusterInput[][] = [];
    await clusterPending({ store, clusterBatch: fakeClusterer(calls), now: () => NOW });
    expect(calls).toHaveLength(0);
  });
});

describe("top stories ranking", () => {
  const all = [
    article("aaaaaaaaaaa1", "svt", "A1", 5),
    article("aaaaaaaaaaa2", "dn", "A2", 4),
    article("bbbbbbbbbbb1", "svt", "B1", 3),
    article("bbbbbbbbbbb2", "dn", "B2", 2),
    article("bbbbbbbbbbb3", "svd", "B3", 1),
    article("ccccccccccc1", "svt", "C1", 2),
    article("ccccccccccc2", "svt", "C2", 1),
    article("ddddddddddd1", "svt", "D1", 30),
    article("ddddddddddd2", "dn", "D2", 20),
  ];
  const state: StoriesState = {
    version: 1,
    prompt_version: "test",
    updated_at: hoursAgo(0),
    stories: {
      aaaaaaaaaaa1: { items: ["aaaaaaaaaaa1", "aaaaaaaaaaa2"], last_published_at: hoursAgo(4) },
      bbbbbbbbbbb1: {
        items: ["bbbbbbbbbbb1", "bbbbbbbbbbb2", "bbbbbbbbbbb3"],
        last_published_at: hoursAgo(1),
      },
      ccccccccccc1: { items: ["ccccccccccc1", "ccccccccccc2"], last_published_at: hoursAgo(1) },
      ddddddddddd1: { items: ["ddddddddddd1", "ddddddddddd2"], last_published_at: hoursAgo(20) },
    },
  };

  it("ranks by distinct publishers, needs two, and drops stories gone quiet", () => {
    const top = rankTopStories(all, state, NOW);
    expect(top.map((s) => s.id)).toEqual(["bbbbbbbbbbb1", "aaaaaaaaaaa1"]);
    const [first] = top;
    expect(first?.source_count).toBe(3);
    expect(first?.lead.id).toBe("bbbbbbbbbbb1");
    expect(first?.items.map((i) => i.id)).toEqual(["bbbbbbbbbbb3", "bbbbbbbbbbb2", "bbbbbbbbbbb1"]);
  });

  it("is empty without a state file", () => {
    expect(rankTopStories(all, null, NOW)).toEqual([]);
  });
});
