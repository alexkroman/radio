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
docker buildx bake --load ${bake_flags[@]+"${bake_flags[@]}"} "${files[@]}" app e2e
# Start the stack from those images, then the tests. Plain `compose run` would
# rebuild the app (pull_policy: build) without E2E_BAKE_FLAGS, which fails in
# cloud sessions, and `run` has no --no-build.
dc up -d --no-build caddy liquidsoap
dc run --rm --no-deps e2e npx playwright test "$@"

# Deploys don't drop listeners: add and then remove a show and run what
# scripts/deploy.sh runs after a sync (scripts/reconcile.sh) with listeners
# connected, and check after each that they still are and on their own show
# (Icecast's per-show silence fallbacks hold them while Liquidsoap restarts;
# see icecast/config.sh).
fail() {
  echo "e2e deploy: $*" >&2
  exit 1
}
step() { echo "e2e deploy: $*"; }
# Run a check every second until it passes, for up to 30 s (Liquidsoap takes a
# few to reconnect, and a stopped one's sources can linger in Icecast).
wait_for() {
  for _ in $(seq 1 30); do
    "$@" && return
    sleep 1
  done
  return 1
}
# Listeners on an Icecast mount right now; 0 if it has no source.
listeners() {
  dc exec -T caddy wget -qO- "http://icecast:8000/status-json.xsl?mount=/$1" |
    sed -n 's/.*"listeners":\([0-9]*\).*/\1/p' || true
}
has_listeners() { [ "$(listeners "$1")" = "$2" ]; }
# /$1 has $2 listeners; a listener moved to a fallback or another show never comes back.
expect() { wait_for has_listeners "$1" "$2" || fail "after $3, /$1 has $(listeners "$1") listeners, not $2"; }
listen() { dc exec -d caddy wget -qO /dev/null "http://icecast:8000/$1"; }
edit_shows() { dc run --rm --no-deps -T seed sh -c "$1"; }
has_fallback() { dc exec -T icecast grep -q "<fallback-mount>/fallback-$1.mp3<" /tmp/icecast.xml; }
# Times Icecast has moved listeners from /$1's fallback back to /$1.
returns() {
  dc exec -T icecast grep -c "passing [1-9][0-9]* listeners from \"/fallback-$1.mp3\" to \"/$1\"" \
    /var/log/icecast/error.log || true
}
returned() { [ "$(returns "$1")" -gt "$2" ]; }
liquidsoap_started() { docker inspect -f '{{.State.StartedAt}}' "$(dc ps -q liquidsoap)"; }
# Run scripts/reconcile.sh, as a deploy does, and wait until the listeners on
# each of the shows given went to their fallback and back (Liquidsoap
# restarted). Waiting on Icecast's log, not the listener counts: a stopped
# container's connections can linger in Icecast (until its source-timeout)
# with listeners still attached, which would pass a count without testing the
# fallback at all.
reconcile() {
  local slug before=() i=0
  for slug in "$@"; do before+=("$(returns "$slug")"); done
  COMPOSE="docker compose -p radio-e2e --env-file test/test.env ${files[*]}" sh scripts/reconcile.sh
  for slug in "$@"; do
    wait_for returned "$slug" "${before[i]}" ||
      fail "after restarting Liquidsoap, /$slug's listeners never came back from its fallback"
    i=$((i + 1))
  done
}
no_listeners() { [ -z "$(listeners "$1")" ]; }

listen default
expect default 1 "connecting"

step "a deploy with no show added or removed restarts nothing"
started=$(liquidsoap_started)
reconcile
[ "$(liquidsoap_started)" = "$started" ] || fail "reconcile.sh restarted Liquidsoap with nothing changed"

step "adding a show"
edit_shows 'printf -- "---\ntitle: Added\n---\n" >/shows/added.md && chmod a+r /shows/added.md'
reconcile default
has_fallback added || fail "the reload didn't give the new show a fallback"
expect default 1 "deploying a new show"
listen added
expect added 1 "connecting to the new show"

step "removing a show"
edit_shows 'rm /shows/night.md'
reconcile default added
! has_fallback night || fail "the reload kept the removed show's fallback"
expect default 1 "deploying a removed show"
expect added 1 "deploying a removed show (the new show's fallback)"
wait_for no_listeners night || fail "the removed show is still streaming"
step "listeners stayed connected through adding and removing a show"
