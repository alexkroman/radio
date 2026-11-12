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

# Deploys don't drop listeners: run scripts/deploy.sh's steps for adding and
# then removing a show (edit shows/, reload Icecast's config, restart
# Liquidsoap) with listeners connected, and check after each step that they
# still are and on their own show (Icecast's per-show silence fallbacks hold
# them while Liquidsoap restarts; see icecast/config.sh).
fail() {
  echo "e2e deploy: $*" >&2
  exit 1
}
step() { echo "e2e deploy: $*"; }
# Listeners on an Icecast mount right now; 0 if it has no source.
listeners() {
  dc exec -T caddy wget -qO- "http://icecast:8000/status-json.xsl?mount=/$1" |
    sed -n 's/.*"listeners":\([0-9]*\).*/\1/p' || true
}
# Wait (up to 30 s: Liquidsoap takes a few to reconnect) for /$1 to have $2
# listeners; a listener moved to a fallback or another show never comes back.
expect() {
  local n
  for _ in $(seq 1 30); do
    n=$(listeners "$1")
    [ "${n:-0}" = "$2" ] && return
    sleep 1
  done
  fail "after $3, /$1 has ${n:-0} listeners, not $2"
}
listen() { dc exec -d caddy wget -qO /dev/null "http://icecast:8000/$1"; }
edit_shows() { dc run --rm --no-deps -T init sh -c "$1"; }
reload() { dc exec -T icecast sh /icecast/config.sh reload; }
has_fallback() { dc exec -T icecast grep -q "<fallback-mount>/fallback-$1.mp3<" /tmp/icecast.xml; }

listen default
expect default 1 "connecting"

step "adding a show"
edit_shows 'printf -- "---\ntitle: Added\n---\n" >/shows/added.md && chmod a+r /shows/added.md'
reload
has_fallback added || fail "the reload didn't give the new show a fallback"
expect default 1 "reloading Icecast for a new show"
dc restart liquidsoap >/dev/null
expect default 1 "restarting Liquidsoap for a new show"
listen added
expect added 1 "connecting to the new show"

step "removing a show"
edit_shows 'rm /shows/night.md'
reload
! has_fallback night || fail "the reload kept the removed show's fallback"
expect default 1 "reloading Icecast for a removed show"
expect added 1 "reloading Icecast for a removed show"
dc restart liquidsoap >/dev/null
expect default 1 "restarting Liquidsoap for a removed show"
expect added 1 "restarting Liquidsoap for a removed show (the new show's fallback)"
[ -z "$(listeners night)" ] || fail "the removed show is still streaming"
step "listeners stayed connected through adding and removing a show"
