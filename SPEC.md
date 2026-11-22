# Swedlines — Specification

**Status:** Draft v0.5 (2026-11-14) — sources verified, headline-stream UI and ticker added, domain swedlines.com
**Name:** Swedlines — https://swedlines.com (repo: `swedlines-app`)

## 1. Purpose

A daily aggregator of Swedish news that collects short items from popular Swedish news sites, stores them as dual-language content (Swedish original + English translation), and exposes them through:

- a versioned, read-only JSON API that other apps can query,
- RSS/Atom/JSON feeds in both languages,
- (optional, later) a minimal web UI.

The system is **git-backed**: every ingested item is a file committed to a git repository, which gives a free audit trail, trivial backups, diffable history, and the ability to serve the whole API as static files.

## 2. Goals and non-goals

### Goals

1. Produce a **daily edition** of Swedish news: a curated, deduplicated list of short items per calendar day (Europe/Stockholm).
2. Every item is available in **Swedish (original)** and **English (machine-translated)**, with the translation clearly marked as such.
3. Expose data via a **stable public API** and **standard feeds** so third-party apps (mobile clients, dashboards, bots, other aggregators) can consume it without scraping.
4. Run **cheaply and unattended**: a scheduled job, no always-on database required for the MVP.
5. **Respect publishers**: link back to the source, keep stored text short, honor `robots.txt` and feed terms.

### Non-goals (MVP)

- Hosting full article bodies or bypassing paywalls.
- User accounts, personalization, push notifications.
- Comments, social features.
- Real-time (sub-minute) latency. Fifteen-minute freshness is the target.
- Human editorial curation.

## 3. Sources

Only publicly offered RSS/Atom feeds are used. No HTML scraping in the MVP.

### Selection rationale

Audience rankings (Ocast/Orvesto, Nytthub, Hurbra, Reuters Institute Digital News Report 2026 for Sweden) consistently name the same brands: **Aftonbladet** is the largest news site, **Expressen** the main challenger, **SVT Nyheter** the leading public-service site, and **DN** and **SvD** the leading quality dailies. The Reuters Institute notes 87% of Swedes use online news weekly and that public-service media (SVT, SR) and local newspapers attract the highest trust. The source list therefore combines reach (tabloids), trust (public service), depth (quality dailies), and regional coverage (the two largest regional papers).

### Verified sources (feeds checked live 2026-11-14)

| Key | Publisher | Tier | Paywall | Feed | Items | Notes |
|---|---|---|---|---|---|---|
| `svt` | SVT Nyheter | 1 | none | `https://www.svt.se/rss.xml` | ~100 | Clean one-sentence teasers; section feeds exist (`/nyheter/inrikes/rss.xml`, `/nyheter/utrikes/rss.xml`) |
| `sr` | Sveriges Radio Ekot | 1 | none | `https://api.sr.se/api/rss/program/83` | 20 | Atom; HTML summaries, often >300 chars |
| `dn` | Dagens Nyheter | 1 | hard | `https://www.dn.se/rss/` | ~120 | Mixes news with columns |
| `svd` | Svenska Dagbladet | 1 | hard | `https://www.svd.se/feed/articles.rss` | ~40 | Some items lack description |
| `aftonbladet` | Aftonbladet | 1 | partial | `https://rss.aftonbladet.se/rss2/small/pages/sections/senastenytt/` | ~40 | `?utm_medium=rss` on links; enclosure images; live-chat items to filter |
| `expressen` | Expressen | 1 | partial | `https://feeds.expressen.se/nyheter/` | 20 | HTML `<p>` teasers in CDATA |
| `tv4` | TV4 Nyheterna | 1 | none | `https://www.tv4.se/rss` | ~50 | Largest commercial broadcaster |
| `di` | Dagens industri | 2 | hard | `https://www.di.se/rss` | 20 | Business; maps to `economy` |
| `gp` | Göteborgs-Posten | 2 | hard | `https://www.gp.se/rss` | 10 | Gzip body without `Content-Encoding` header |
| `sydsvenskan` | Sydsvenskan | 2 | hard | `https://www.sydsvenskan.se/rss.xml` | ~36 | Regional, Malmö/Skåne |

Evaluated and excluded:

- **Omni** has no public RSS feed (`/rss` and `/feed` return HTML) and is itself an aggregator.
- **The Local Sweden** works (`https://feeds.thelocal.com/rss/se`) but is English-language, so it does not fit the Swedish-original model. Kept disabled as a reference.
- Dead URLs found in older lists: `aftonbladet.se/rss.xml`, `aftonbladet.se/rss/nyheter.xml`, `sverigesradio.se/ekot/rss`, `gp.se/feeds/feed.xml`.

### Fetcher requirements learned from the probe

- Accept both RSS 2.0 and Atom 1.0 (SR is Atom).
- Strip HTML from descriptions and summaries (Expressen, SR).
- Strip tracking parameters before computing `id` (Aftonbladet appends `utm_medium=rss`).
- Sniff gzip magic bytes and decompress even without `Content-Encoding` (GP).
- Prefer `<enclosure>` or `<media:content>` for `image_url` when present.
- Expect ~500 new items per day across all ten sources; poll every 15 minutes.

### Configuration

Sources are configured in `sources.yaml` (one entry per publisher, one or more feeds each). The committed file contains the verified list above with per-source notes. Adding a source must never require a code change.

### Legal and ethical constraints

- Store and republish **title, a short teaser (target ≤ 300 characters, hard cap 500), link, publisher, timestamp, and optional image URL** only. Never store full article text.
- Swedish copyright law and the EU DSM Directive (Art. 15, press publishers' right) exempt hyperlinks and "very short extracts". Keep extracts short and always link to the original.
- Translations and summaries are derivative works of the teaser; keep them equally short and label them as machine-generated.
- Honor `robots.txt`, feed `ttl`, and conditional requests (`ETag` / `If-Modified-Since`). Identify with the `User-Agent` `swedlines/<version> (+https://swedlines.com)`; the site must carry a contact address for publishers.
- If a publisher asks to be removed, disabling the source and purging its items must be a one-line config change plus one pipeline run.

## 4. Architecture

```
                 ┌─────────────────────────────────────────────┐
  scheduler ───► │  Ingestion pipeline (runs every 15 min)     │
 (GitHub Actions │  fetch → normalize → dedupe → summarize      │
  cron)          │  → translate → categorize → write files      │
                 └───────────────┬─────────────────────────────┘
                                 │ commit + push
                                 ▼
                 ┌─────────────────────────────────────────────┐
                 │  Content repository (git)                   │
                 │  content/2026/11/14/<id>.json               │
                 └───────────────┬─────────────────────────────┘
                                 │ build step
                                 ▼
                 ┌─────────────────────────────────────────────┐
                 │  Static output (docs/)                      │
                 │  /api/v1/*.json   /feeds/*.xml   /index.html │
                 └───────────────┬─────────────────────────────┘
                                 │ deploy (GitHub Pages / any CDN)
                                 ▼
                           consumers: apps, feed readers, browsers
```

### 4.1 Two repositories

| Repo | Contents | Commit cadence |
|---|---|---|
| `swedlines-app` (this repo) | pipeline code, API/feed builders, optional UI, tests, this spec | on development |
| `swedish-news-content` | `sources.yaml` snapshot, `content/` item files, generated `docs/` | every pipeline run with new items (up to every 15 min) |

Keeping data in a separate repo prevents thousands of data commits from swamping the code history, and lets the content repo be published via GitHub Pages independently. (Alternative: an orphan `data` branch in this repo. See Open decisions.)

### 4.2 Static-first API

The MVP serves the entire API and all feeds as pre-built static files. This needs no server, scales for free behind a CDN, and the git history doubles as the database. A thin dynamic query layer (search, arbitrary filters, pagination) is a later phase that reads the same content files.

### 4.3 Pipeline stages

1. **Fetch** — For each enabled feed, GET with conditional headers. Per-source failures are logged and skipped; one dead feed must not fail the run.
2. **Normalize** — Map feed entries to the canonical `Article` shape. Resolve relative URLs, strip tracking parameters (`utm_*`), strip HTML from teasers, decode entities, normalize whitespace.
3. **Dedupe** — Skip items already present (by `id`, see §5). Items are immutable once written; a changed headline for an existing URL creates no new item in the MVP.
4. **Summarize** — If the teaser exceeds `max_summary_chars`, produce a shorter Swedish summary (LLM). If the teaser is missing, use the title only. Never fetch the article page to obtain more text.
5. **Translate** — Translate title and teaser/summary to English (LLM). Preserve proper nouns, Swedish place names, and currency (SEK). Record the model and a prompt version in the item.
6. **Categorize** — Assign one coarse category from a fixed enum (§5.3) using the feed's declared category if present, otherwise the LLM. Multiple categories are out of scope for MVP.
7. **Write** — Write one JSON file per item under `content/YYYY/MM/DD/<id>.json`, using the `published_at` date in Europe/Stockholm.
8. **Build** — Regenerate static API files, feeds, and indexes from `content/` (full rebuild for the current and previous day; incremental for older days is an optimization).
9. **Commit & push** — One commit per run with a message like `ingest: 2026-11-14T09:00+01:00 — 37 new items (svt 12, dn 9, …)`. If nothing changed, do not commit.

The pipeline is **idempotent**: re-running on the same inputs produces no new commits.

### 4.4 LLM usage

Summarization, translation, and categorization are single-call tasks (no agents). They go through the Anthropic Messages API with structured outputs so the pipeline receives validated JSON, not prose.

- **Default model:** `claude-opus-5-5` (quality baseline; $4 / $20 per MTok). For this workload each item is a few hundred tokens in and out, so cost is dominated by item count. Rough estimate at ~500 items/day × ~600 tokens total ≈ 0.3 MTok/day ≈ well under $10/day at Opus pricing; `claude-haiku-5-5` ($0.10 / $0.50 per MTok) would be ~40× cheaper if translation quality is acceptable. This is a cost/quality decision for the owner, not the pipeline. See Open decisions.
- **Batching:** Each run collects all new items into one request per task (or uses the Message Batches API at 50% cost when latency is irrelevant, e.g. the nightly daily-edition rebuild).
- **Caching:** The system prompt (translation guidelines, glossary, category definitions) is static and placed first so prompt caching applies across runs.
- **Prompt versioning:** Prompts live in `prompts/` and carry a version string stored on every item (`translation.prompt_version`). Changing a prompt never rewrites existing items; a deliberate backfill is a separate command.
- **Failure handling:** A translation failure leaves the item in Swedish-only state with `translation.status = "pending"`; the next run retries. Refusals (`stop_reason: "refusal"`) are logged and the item is marked `translation.status = "skipped"`.
- **Provider abstraction:** Translation is behind a small interface so a conventional MT service can be swapped in or run alongside for comparison.

#### Why an LLM rather than a public MT service (evaluated 2026-11-14)

Workload: ~500 items/day × ~400 characters (title + teaser) ≈ 6M characters/month. Third-party pricing, verify on official pages before buying:

| Provider | List price | Monthly cost at 6M chars | Notes |
|---|---|---|---|
| Azure AI Translator (S1) | $10 / 1M chars | ~$60 | Separate F0 tier gives 2M chars/month free, cannot be combined with S1 |
| Google Cloud Translation (NMT) | $20 / 1M chars | ~$110 | 500K chars/month free |
| DeepL API Growth | $26/month + $27.50 / 1M over 1M/month | ~$160 | Best-regarded sv→en quality; free tier is a one-time 1M credit |
| `claude-haiku-5-5` | $0.10 in / $0.50 out per 1M tokens | ~$1–3 | ~1.7M tokens in, ~1.5M out, plus prompt overhead; halve with Batch API |
| `claude-opus-5-5` | $4 in / $20 out per 1M tokens | ~$35–45 | Same tokens; halve with Batch API |

The LLM also performs summarization and categorization in the same call, handles HTML-ish teasers and Swedish idiom in headlines, and can follow a glossary (party names, agencies, "riksdagen" vs "parliament"). MT services return only a literal translation, so shortening and categorizing would still need a second system.

Decision: LLM-first. Keep the provider interface, and use the Azure F0 free tier (2M chars/month) as an optional second translation for quality sampling, never as the primary path.


## 5. Data model

### 5.1 Article (one file per item)

Path: `content/YYYY/MM/DD/<id>.json`

```json
{
  "id": "a9f3c1e2b7d4",
  "schema_version": 1,
  "source": "svt",
  "url": "https://www.svt.se/nyheter/inrikes/exempel",
  "guid": "https://www.svt.se/nyheter/inrikes/exempel",
  "published_at": "2026-11-14T07:42:00+01:00",
  "fetched_at": "2026-11-14T08:00:13+01:00",
  "category": "politics",
  "image_url": "https://www.svt.se/.../bild.jpg",
  "sv": {
    "title": "Regeringen presenterar ny budget",
    "summary": "Finansministern lade på torsdagen fram …",
    "summary_origin": "feed"
  },
  "en": {
    "title": "Government presents new budget",
    "summary": "On Thursday the finance minister presented …"
  },
  "translation": {
    "status": "done",
    "provider": "anthropic",
    "model": "claude-opus-5-5",
    "prompt_version": "2026-11-01",
    "translated_at": "2026-11-14T08:00:21+01:00"
  }
}
```

Field rules:

- `id` — first 12 hex chars of SHA-256 of the canonical URL (after tracking-parameter stripping). Stable across runs; the same story URL never produces two items.
- `published_at` / `fetched_at` — ISO 8601 with explicit offset. All day boundaries use Europe/Stockholm.
- `sv.summary_origin` — `"feed"` (teaser used as-is), `"truncated"`, or `"llm"` (LLM-shortened).
- `en` is absent while `translation.status` is `"pending"` or `"skipped"`.
- `category` — one of the enum in §5.3.
- `topics` (phase 2) — optional array of entity/topic slugs (e.g. `ulf-kristersson`, `nato`, `riksbanken`) extracted by the LLM, powering topic pages and feeds.
- Unknown fields are ignored by readers; `schema_version` bumps on breaking changes.

### 5.2 Edition (derived, not stored in `content/`)

An Edition is the set of all items whose `published_at` falls on a given Stockholm date, ordered by `published_at` descending. It is generated into the API, never hand-edited.

### 5.3 Category enum

`politics`, `economy`, `world`, `sweden`, `sports`, `culture`, `science_tech`, `crime`, `weather`, `other`.

Feeds often provide their own section names; `sources.yaml` may map those to this enum to avoid an LLM call.

## 6. Public API (v1)

Base URL: `https://swedlines.com/api/v1/`. All responses are JSON, UTF-8, `Cache-Control: public, max-age=300`, CORS `*`. Static files; every endpoint below is a path, not a query.

| Path | Content |
|---|---|
| `latest.json` | The 200 most recent items across all sources (feeds the headline stream) |
| `top.json` | Phase 2: story clusters ranked by cross-source coverage (§8) |
| `days/YYYY-MM-DD.json` | Full edition for one day |
| `days/index.json` | List of available days with item counts |
| `sources.json` | Enabled sources with names, homepages, item counts |
| `sources/<key>/latest.json` | 100 most recent items from one source |
| `sources/<key>/days/YYYY-MM-DD.json` | One source, one day |
| `categories/<category>/latest.json` | 100 most recent items in one category |
| `items/<id>.json` | Single item |
| `status.json` | Last run time, per-source fetch status, item totals, pipeline version |
| `openapi.json` | OpenAPI 3.1 description of the above |

Every list response has the same envelope:

```json
{
  "generated_at": "2026-11-14T09:00:40+01:00",
  "count": 37,
  "items": [ ...Article objects... ]
}
```

Language selection is the client's job: both `sv` and `en` are always present in the payload. This keeps the static file count manageable and makes side-by-side display trivial.

**Versioning:** Breaking changes get `/api/v2/`. `v1` keeps being generated for at least six months after `v2` ships.

### 6.1 Dynamic query layer (phase 2, optional)

A small HTTP service (same language as the pipeline) that loads `content/` into memory or SQLite on start and serves:

- `GET /api/v1/search?q=&lang=sv|en&from=&to=&source=&category=&limit=&cursor=`
- `GET /api/v1/items?since=<ISO timestamp>` for incremental sync.

It reads the same files, so static and dynamic answers never disagree. Deployable to any container host or serverless runtime.

## 7. Feeds

| Path | Format | Content |
|---|---|---|
| `/feeds/sv.xml` | RSS 2.0 | All items, Swedish |

All feed paths are relative to `https://swedlines.com`.
| `/feeds/en.xml` | RSS 2.0 | All items, English |
| `/feeds/sv.atom`, `/feeds/en.atom` | Atom 1.0 | Same |
| `/feeds/sv.json`, `/feeds/en.json` | JSON Feed 1.1 | Same |
| `/feeds/<source>/{sv,en}.xml` | RSS 2.0 | Per source |
| `/feeds/<category>/{sv,en}.xml` | RSS 2.0 | Per category |
| `/feeds/daily/{sv,en}.xml` | RSS 2.0 | One entry per day linking to the day's edition; good for digest readers |

Feed rules:

- Each entry's `<link>` points to the **original publisher URL**, not to this site.
- `<guid>` is the item `id`, `isPermaLink="false"`.
- `<language>` / `xml:lang` set correctly per feed.
- English entries append a one-line footer: "Machine translation by Swedlines of an article from {publisher}. Original (Swedish): {url}".
- Feeds contain the latest 100 items; the daily feed contains the latest 30 days.
- Validate against the W3C feed validator in CI.

## 8. Web UI (MVP: headline stream)

Reference: NewsNow's Sweden page (newsnow.co.uk/h/World+News/Europe/Northern+Europe/Sweden). It is a dense, image-free headline stream and nothing else. Its Sweden coverage is almost entirely English-language outlets (Sweden Herald and similar), so a stream built on Swedish primary sources with a Swedish/English toggle fills a real gap.

### Shape

- **One page, one list.** Each row: headline (link), publisher name, relative time ("12 min", "3 h"), and the publisher's teaser beneath in muted type (`sv.summary`, or `en.summary` in English view; decided 2026-11-16). No images. Rows without a teaser show the headline only.
- **Language toggle** in the header: `sv` / `en` / `both`. Persisted in `localStorage`. "Both" shows the English headline with the Swedish original beneath in smaller type.
- **Time-window grouping** in the Latest view: "Senaste 10 minuterna / Last 10 minutes", "Senaste timmen", "Senaste 4 timmarna", "Tidigare i dag", then by day.
- **Tabs:** `Latest` (reverse chronological, MVP) and `Top` (phase 2, see below). No "Popular" tab until there is click data worth ranking on.
- **Sidebar/topic links:** one link per category (§5.3), each a filtered view of the same stream. Phase 2 adds entity topics (e.g. "Ulf Kristersson", "NATO", "Riksbanken") derived from a `topics` field.
- **My Sources:** a checkbox list of publishers, client-side filter, persisted in `localStorage`. Static site, so no account needed.
- **Direct links.** Headlines link straight to the publisher URL, never through a redirect.
- **Auto-refresh:** the page re-fetches `latest.json` every 5 minutes and prepends new rows; a "Refresh" control forces it.
- **Day pages** (`/day/2026-11-14`) remain for the archive and for the daily feed, rendered from `days/YYYY-MM-DD.json`.

### Brand

Logo chosen 2026-11-14: a blue rounded tile (Swedish flag blue, Pantone 301, `#006AA7`) with three yellow (Pantone 116, `#FECC02`) bars of decreasing length, reading as a stack of headlines. Wordmark is lowercase `swedlines` in Manrope ExtraBold. Sources in `assets/logo/` (`mark.svg`, `lockup.svg`); the site header pairs the mark with a yellow ticker line.

### Implementation

Static HTML plus a small amount of vanilla JS that reads `/api/v1/latest.json` and the category/source files. Rendered at build time for first paint, hydrated by the client for refresh and filters. No framework in the MVP.

### Ticker (MVP companion client)

A scrolling headline ticker, the classic broadcast-style bar, as a standalone page and an embeddable widget. Headlines only, so the payload is tiny and the client is trivial.

- **`https://swedlines.com/ticker`** — full-width page: one horizontally scrolling line of headlines with publisher tag; click goes to the publisher. Controls: language (`sv` / `en` / alternate every pass), speed, pause on hover, category filter. Suited to a second monitor, a wall display, or a browser tab.
- **Embeddable widget** — `<script src="https://swedlines.com/ticker.js" data-lang="en" data-category="politics"></script>` renders the same bar inside any site. Also an `<iframe>` variant for hosts that block scripts. Styles are scoped so the host page is untouched.
- **Daily mode** — the ticker loops the current day's edition (`days/YYYY-MM-DD.json`) instead of the live stream, so a display shows "today's headlines in Sweden" end to end.
- **Native ticker apps** (phase 2 candidates, all consumers of the same endpoint): a macOS menu-bar app, a Windows taskbar widget, a Raspberry Pi/LED-matrix display, a Slack/Discord bot posting the daily edition.

Dedicated endpoint, generated with the rest of the static API:

| Path | Content |
|---|---|
| `api/v1/ticker.json` | Latest 50 items, headline fields only: `id`, `source`, `url`, `published_at`, `sv.title`, `en.title`. Target size under 10 KB. |
| `api/v1/ticker/<category>.json` | Same, filtered by category |
| `api/v1/ticker/daily.json` | Today's edition, headline fields only |

The ticker refreshes its data every 5 minutes and dedupes by `id`, so a long-running display never repeats a headline within one pass.

### Top view (phase 2)

NewsNow ranks "Top" editorially/algorithmically. The cheapest honest signal available here is **cross-source coverage**: cluster items that report the same story (title similarity across publishers within a 12-hour window, LLM-assisted), and rank clusters by publisher count, then recency. A `top.json` endpoint exposes the ranked clusters. This is also the hook for a later "one story, many sources" grouping in the stream.

## 9. Operations

- **Repos must be public.** 96 runs/day ≈ 6,000 Actions minutes/month, three times the free allowance for private repos (~$32/month overage). Public repos get unlimited minutes, and the content is public by design.
- **Scheduler:** GitHub Actions cron every 15 minutes (a headline stream needs sub-hour freshness; Actions cron is best-effort and often runs a few minutes late, which is acceptable). ~96 runs and up to ~96 content commits per day; LLM cost scales with new items, not runs. A separate nightly job at 04:00 Stockholm rebuilds the previous day's edition and all feeds from scratch to catch late items and translation retries.
- **Hosting and DNS:** GitHub Pages serves the content repo's `docs/` at `https://swedlines.com` (branch `main`, folder `/docs`, with a `.nojekyll` file). Live since 2026-11-14 at https://swedlines.github.io/swedlines-content/ pending DNS. GitHub Pages branch deployment only allows the root or `/docs` as the folder, which is why the output folder is `docs/`. Soft limits: 100 GB/month bandwidth and 10 deploys/hour; four deploys/hour is within limits. Put Cloudflare's free tier in front once ticker polling approaches ~1,000 daily viewers. The build writes a `CNAME` file containing `swedlines.com` into `docs/` on every run (Pages removes the custom domain if the file disappears). DNS: apex `A` records to GitHub Pages' four IPs plus `www` as a `CNAME` to `<owner>.github.io`, with `www` redirecting to the apex. Enforce HTTPS in the Pages settings once the certificate is issued. As of 2026-11-14 the domain has no DNS records yet.
- **Secrets:** `ANTHROPIC_API_KEY` and a deploy token for the content repo, stored as Actions secrets.
- **Observability:** `status.json` is the health check. Each run writes a one-line summary to the commit message and the Actions log. A run that fetches zero items from every source fails loudly (exit non-zero) so Actions sends an email.
- **Rate limits:** Max one request per feed per run; respect `Retry-After`. LLM calls use SDK retries with backoff.
- **Retention:** Keep everything (text is tiny). Reconsider if the content repo exceeds ~1 GB; options are yearly archive repos or pruning `docs/` from history.
- **Cost ceiling:** Alert if a single run makes more than N LLM calls (configurable, default 1000) to catch feed loops.

## 10. Testing

- **Unit:** normalization (URL canonicalization, HTML stripping, timezone handling), `id` derivation, dedupe, category mapping, feed/JSON serialization.
- **Fixtures:** Recorded feed responses per source under `tests/fixtures/`; tests run fully offline. LLM calls are mocked by default; a tagged integration test hits the real API with a tiny sample.
- **Contract:** Generated API output is validated against `openapi.json`; feeds against the W3C validator (or a local equivalent) in CI.
- **Golden run:** A fixture-driven end-to-end run must produce byte-identical `docs/` output across two executions (idempotency check).

## 11. Milestones

| # | Milestone | Deliverable |
|---|---|---|
| 0 | Scaffold | Stack chosen, repo layout, CI, lint, test runner, this spec committed |
| 1 | Ingest | Fetch + normalize + dedupe for 3 sources; items written to `content/`; commits pushed |
| 2 | Translate | Dual-language items; prompt versioning; retry/skip states |
| 3 | API + stream UI | Static `/api/v1/` and the NewsNow-style headline stream page deployed to GitHub Pages; `openapi.json` |
| 3b | Ticker | `/ticker` page, `ticker.json` endpoints, embeddable `ticker.js` widget |
| 4 | Feeds | RSS/Atom/JSON feeds, validated |
| 5 | Harden | All sources enabled, nightly rebuild, status endpoint, cost guard, fixtures for every source |
| 6 | Phase 2 | Top view via story clustering, entity topics, dynamic search service |

## 12. Open decisions

These change the implementation materially and need an owner's call before Milestone 0:

1. **Language / stack.** Recommendation: TypeScript on Node (strong RSS/XML libraries, first-class Anthropic SDK, easy static site build, same language for the optional UI). Python is an equally good fit if preferred.
2. **"Git-backed" interpretation.** This spec assumes the *content* lives in git and the API is served statically from it. If you only meant "the code is in a repo", the storage section simplifies to a conventional database and the static-first design becomes optional.
3. **One repo or two.** Recommendation: separate content repo (§4.1). Alternative: orphan `data` branch here.
4. **Translation model.** `claude-opus-5-5` for quality vs `claude-haiku-5-5` for ~40× lower cost (§4.4). Suggest starting with Opus for a week, sampling quality, then deciding.
5. **Source list.** Resolved 2026-11-14: ten verified sources in §3 and `sources.yaml`; Omni (no feed) and The Local (English) excluded. Confirm whether Di belongs in a general-news feed.
6. **Extract length.** 300-character target is conservative. Confirm you are comfortable with that given the press-publisher-right constraints in §3.
7. **Hosting.** Resolved 2026-11-14: GitHub Pages behind the custom domain `swedlines.com` (§9). Cloudflare in front is optional and can be added later for caching and analytics without changing the build.
8. **Web UI.** Resolved 2026-11-14: a NewsNow-style headline stream is in the MVP (§8). Teaser shown by default under every headline (resolved 2026-11-16).
9. **Data licence for API consumers.** Titles and teasers remain the publishers' copyright; our translations and metadata could be CC BY 4.0. Needs a decision and a `LICENSE-DATA` file.
