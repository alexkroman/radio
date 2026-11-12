#!/usr/bin/env bash
# End-to-end suite: builds and starts the real stack (compose.yml + test/compose.yml)
# on fixtures, runs the Playwright tests in Docker against it, then tears it all
# down. Extra args go to `playwright test`. E2E_COMPOSE adds a compose overlay
# and E2E_BAKE_FLAGS extra `buildx bake` flags (both set in Claude Code cloud
# sessions by .claude/hooks/session-start.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
files=(-f compose.yml -f test/compose.yml)
if [ -n "${E2E_COMPOSE:-}" ]; then files+=(-f "$E2E_COMPOSE"); fi
read -ra bake_flags <<<"${E2E_BAKE_FLAGS:-}"
dc() { docker compose -p radio-e2e --env-file test/test.env "${files[@]}" "$@"; }
# Start clean (a leftover stack would keep stale containers) and clean up after.
dc down -v --remove-orphans >/dev/null 2>&1
trap 'dc down -v --remove-orphans >/dev/null 2>&1' EXIT
# Build with bake (what `compose build` uses) so E2E_BAKE_FLAGS can be passed.
set -a
# shellcheck disable=SC1091 # plain KEY=value file
. ./test/test.env
set +a
docker buildx bake --load "${bake_flags[@]}" "${files[@]}" app e2e
# Start the stack from those images, then the tests. Plain `compose run` would
# rebuild the app (pull_policy: build) without E2E_BAKE_FLAGS, which fails in
# cloud sessions, and `run` has no --no-build.
dc up -d --no-build caddy liquidsoap
dc run --rm --no-deps e2e npx playwright test "$@"
# A listener stays connected through a Liquidsoap restart (Icecast's silence
# fallback, compose.yml) and is moved back to the show once it's up again.
status() { dc exec -T caddy wget -qO- "http://icecast:8000/status-json.xsl?mount=/default"; }
dc exec -d caddy wget -qO /dev/null http://icecast:8000/default
sleep 2
dc restart liquidsoap >/dev/null
for _ in $(seq 1 30); do
  status | grep -q '"listeners":1' && break
  sleep 1
done
status | grep -q '"listeners":1' || {
  echo "e2e: the listener was dropped when Liquidsoap restarted" >&2
  exit 1
}
echo "e2e: a listener stayed connected through a Liquidsoap restart"
