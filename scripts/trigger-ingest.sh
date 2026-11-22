#!/usr/bin/env bash
# Start the Ingest workflow on GitHub (same as clicking "Run workflow").
#
# Needs a fine-grained GitHub token with "Actions: Read and write" on swedlines/swedlines-app.
# Provide it either in $SWEDLINES_GH_TOKEN or in the macOS keychain:
#   security add-generic-password -a swedlines -s swedlines-cron -w   # prompts for the token
set -euo pipefail

REPO="swedlines/swedlines-app"
TOKEN="${SWEDLINES_GH_TOKEN:-}"
if [ -z "$TOKEN" ] && command -v security >/dev/null; then
  TOKEN="$(security find-generic-password -a swedlines -s swedlines-cron -w 2>/dev/null || true)"
fi
if [ -z "$TOKEN" ]; then
  echo "no token: set SWEDLINES_GH_TOKEN or add it to the keychain (see comment at top)" >&2
  exit 1
fi

status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/$REPO/actions/workflows/ingest.yml/dispatches" \
  -d '{"ref":"main"}')"

case "$status" in
  204) echo "ingest triggered ($(date '+%H:%M')) — https://github.com/$REPO/actions";;
  401) echo "GitHub rejected the token (401)" >&2; exit 1;;
  404) echo "token lacks Actions write on $REPO, or wrong repo (404)" >&2; exit 1;;
  *)   echo "unexpected response $status" >&2; exit 1;;
esac
