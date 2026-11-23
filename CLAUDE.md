# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Swedlines (https://swedlines.com): a dual-language (Swedish original + English translation) aggregator of Swedish news headlines. `SPEC.md` is the authoritative design document; read it before making architectural changes. `sources.yaml` is the verified list of publisher feeds.

## Commands

```
npm install
npm run check              # typecheck + lint + tests (what CI runs)
npm run typecheck          # tsc --noEmit
npm run lint               # biome check .
npm run lint:fix           # biome check --write .
npm test                   # vitest run
npm run test:watch
npx vitest run tests/sources.test.ts            # single file
npx vitest run -t "applies defaults"            # single test by name
npm run cli -- sources     # list configured sources
npm run cli -- sources --check
npm run build              # emit dist/ (production only; dev runs TS natively)
```

## Releases

Every change pushed to `main` is a release: the site footer and `/version` show `package.json`'s version, so bump it in the same commit as the change (or in the final commit of a batch).

- `npm version patch --no-git-tag-version` for fixes, copy and styling; `npm version minor --no-git-tag-version` for new features or pages; `major` only for breaking changes to the public API/feeds.
- Tag the release commit `vX.Y.Z` and push the tag together with `main` (`git push origin main vX.Y.Z`).
- Never push to `main` with the version unchanged from the previous release.

## Toolchain notes

- Node 24+ runs TypeScript natively, so `src/cli.ts` executes without a build step. This requires `erasableSyntaxOnly`: no `enum`, no parameter properties, no namespaces. Relative imports use explicit `.ts` extensions.
- Biome handles both lint and format. Run `npm run lint:fix` before committing.
- Zod 4 is used for all config and data validation (`z.url()`, `z.prettifyError()`, not the Zod 3 forms).

## Architecture (as implemented so far)

- `src/config/sources.ts` loads and validates `sources.yaml`, applies defaults, and exposes `Source` objects to the pipeline. Category enum lives here (`CATEGORIES`).
- `glossary.yaml` (loaded by `src/config/glossary.ts`) holds translation rules and Swedish→English terms; it is rendered into the translation system prompt in `src/prompts/translate.ts`. Edit the YAML to fix recurring translation issues; bump `PROMPT_VERSION` for large changes.
- `src/cli.ts` is the single entry point; each subcommand is a function returning an exit code.
- `src/pipeline/` holds the stages: fetch/parse/normalize/ingest, `translate.ts`, and `cluster.ts` (story grouping for the Top view, state in the content repo's `state/stories.json`). The workflow runs ingest → translate → cluster → build every 15 minutes.

## Core design constraints from the spec

- Content is git-backed in a separate content repo: one JSON file per article under `content/YYYY/MM/DD/<id>.json`. The public API, feeds, stream page, and ticker are generated as static files from those items.
- Every item is dual-language (`sv`, `en`) with translation provenance (model, prompt version, status).
- Only RSS/Atom feeds are ingested; only title + short teaser (≤300 chars target, 500 hard cap) + link + image URL are stored. Never fetch or store full article text.
- Item `id` = first 12 hex chars of SHA-256 of the canonical URL (tracking params stripped). Items are immutable once written; the pipeline must be idempotent.
- All day boundaries use Europe/Stockholm; timestamps are ISO 8601 with explicit offsets.
- Feed quirks to handle are documented in SPEC §3 and per-source `notes` in `sources.yaml` (SR is Atom with HTML summaries, Aftonbladet appends `utm_medium=rss`, GP returns gzip without a header).
