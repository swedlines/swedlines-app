# Swedlines


**https://swedlines.com**
A dual-language (Swedish original, English translation) aggregator of Swedish news headlines. Collects short items from the public RSS feeds of the ten most-used Swedish news sites, stores them as JSON files in a git repository, and publishes a static JSON API, RSS/Atom/JSON feeds, a NewsNow-style headline stream, and a scrolling ticker.

See [SPEC.md](SPEC.md) for the full specification and [sources.yaml](sources.yaml) for the source list.

## Run it locally

Requires Node 24 or newer and git.

```
git clone git@github.com:swedlines/swedlines-app.git
cd swedlines-app
npm install
git clone git@github.com:swedlines/swedlines-content.git content-repo   # the data repo, gitignored here

npm run cli -- ingest        # fetch all ten feeds, write new items into content-repo/content/
npm run cli -- build         # generate content-repo/docs/ (JSON API + stream page)
npm run cli -- serve         # http://localhost:8787/
```

Open http://localhost:8787/ for the headline stream and http://localhost:8787/api/v1/latest.json for the API. Re-run `ingest` then `build` whenever you want fresh headlines; `serve` picks up the new files without a restart.

Add `--push` to `ingest` to commit and push new items to the content repo (needs write access). Add `--dry-run` to only report what would be fetched.

## Development

```
npm run check          # typecheck + lint + tests
npm run cli -- sources # list configured sources
npm run cli -- help    # all commands
```
