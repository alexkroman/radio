#!/bin/sh
# End-to-end suite: builds and starts the real stack (compose.yml + test/compose.yml)
# on fixtures, runs the Playwright tests in Docker against it, then tears it all
# down. Extra args go to `playwright test`. E2E_COMPOSE adds a compose overlay
# and E2E_BAKE_FLAGS extra `buildx bake` flags (both set in Claude Code cloud
# sessions by .claude/hooks/session-start.sh).
set -eu
cd "$(dirname "$0")/.."
files="-f compose.yml -f test/compose.yml ${E2E_COMPOSE:+-f $E2E_COMPOSE}"
dc() { docker compose -p radio-e2e --env-file test/test.env $files "$@"; }
trap 'dc down -v --remove-orphans >/dev/null 2>&1' EXIT
# Build with bake (what `compose build` uses) so E2E_BAKE_FLAGS can be passed.
set -a && . ./test/test.env && set +a
docker buildx bake --load ${E2E_BAKE_FLAGS:-} $files app e2e
dc run --rm e2e npx playwright test "$@"
