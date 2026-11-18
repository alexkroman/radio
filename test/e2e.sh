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

# Deploys disturb no listener. With a listener playing the stream through
# Caddy (as players do, test/listen.ts), and another a show's own channel, run a
# deploy's server side (`compose up`, then scripts/reconcile.sh) for each kind
# of change, and check that each stays connected without a pause in the audio
# longer than MAX_GAP_MS
# (Icecast's burst gives a player ~10 s of audio in hand), and that only what
# had to restart did. Icecast's silent fallback holds the listener while
# Liquidsoap restarts (icecast/config.sh).
MAX_GAP_MS=5000
fail() {
  echo "e2e deploy: $*" >&2
  exit 1
}
step() { echo "e2e deploy: $*"; }
# Run a check every second until it passes, for up to $WAIT s (default 30:
# Liquidsoap takes a few to reconnect, and a stopped one's source can linger in
# Icecast).
wait_for() {
  for _ in $(seq 1 "${WAIT:-30}"); do
    "$@" && return
    sleep 1
  done
  return 1
}
# Listeners on the stream right now; nothing if it has no source.
listeners() {
  dc exec -T caddy wget -qO- "http://icecast:8000/status-json.xsl?mount=/stream" |
    sed -n 's/.*"listeners":\([0-9]*\).*/\1/p' || true
}
has_listeners() { [ "$(listeners)" = "$1" ]; }
# The stream has $1 listeners; a listener moved to the fallback never comes back.
expect() { wait_for has_listeners "$1" || fail "after $2, the stream has $(listeners) listeners, not $1"; }
# A listener through Caddy, in the background (radio-e2e-listen$1): on
# /stream, or with $2, on that show's channel (/stream/<show>).
listen() { dc run -d --no-deps --name "radio-e2e-listen${1:-}" e2e node test/listen.ts ${2:+"/stream/$2"} >/dev/null; }
# Stop a listener ($1 as for listen) and check its log: never dropped, no
# pause over MAX_GAP_MS.
heard() {
  local log longest name=radio-e2e-listen${1:-}
  docker stop "$name" >/dev/null
  log=$(docker logs "$name")
  docker rm "$name" >/dev/null
  printf '%s\n' "$log" | sed "s|^|  |"
  longest=$(printf '%s\n' "$log" | sed -n 's/.* longest gap \([0-9]*\) ms$/\1/p')
  [ -n "$longest" ] || fail "the listener${1:+ on $2} was dropped"
  [ "$longest" -le "$MAX_GAP_MS" ] || fail "the listener${1:+ on $2} heard a ${longest} ms pause"
}
# Change the shows or music volumes (as a deploy's sync does).
edit_files() { dc run --rm --no-deps -T seed sh -c "$1"; }
# Times Icecast has moved listeners from the fallback back to the stream.
returns() {
  dc exec -T icecast grep -c 'passing [1-9][0-9]* listeners from "/fallback.mp3" to "/stream"' \
    /var/log/icecast/error.log || true
}
returned() { [ "$(returns)" -gt "$1" ]; }
# When each long-running container started: unchanged means not restarted.
started() {
  local service
  for service in icecast liquidsoap app caddy; do
    printf '%s %s\n' "$service" "$(docker inspect -f '{{.State.StartedAt}}' "$(dc ps -q "$service")")"
  done
}
# The changed lines of started's output: the containers that restarted.
restarted() { { diff <(printf '%s\n' "$1") <(started) || true; } | sed -n 's/^> \([a-z]*\) .*/\1/p' | xargs; }
# A deploy's server side (scripts/deploy.sh): `compose up` (the images are
# already built), then scripts/reconcile.sh. With "restart", then wait until
# the listener went to the fallback and back (Liquidsoap restarted). Waiting
# on Icecast's log, not the listener count: a stopped container's connection
# can linger in Icecast (until its source-timeout) with listeners still
# attached, which would pass a count without testing the fallback at all.
deploy() {
  local before
  before=$(returns)
  dc up -d --no-build --remove-orphans caddy liquidsoap 2>/dev/null
  COMPOSE="docker compose -p radio-e2e --env-file test/test.env ${files[*]}" sh scripts/reconcile.sh
  if [ "${1:-}" = restart ]; then
    wait_for returned "$before" ||
      fail "after restarting Liquidsoap, the listener never came back from the fallback"
  fi
}
# Make a change (the command $3, described by $2) and deploy it, then check
# that exactly the containers named in $1 (none if "") restarted, and that the
# listener is still there. Further arguments go to deploy.
deploy_change() {
  local want=$1 change=$2 before got
  before=$(started)
  eval "$3"
  shift 3
  deploy "$@"
  got=$(restarted "$before")
  [ "$got" = "$want" ] || fail "deploying $change restarted \"$got\", not \"$want\""
  expect 1 "deploying $change"
}
# Liquidsoap's log has a line matching $1.
logged() { dc logs liquidsoap 2>&1 | grep -q "$1"; }
# Swap two shows' hours (Liquidsoap re-reads them within a minute).
swap_hours() {
  edit_files "a=\$(grep '^hours:' /shows/$1.md) b=\$(grep '^hours:' /shows/$2.md)
    sed -i \"s/^hours:.*/\$b/\" /shows/$1.md && sed -i \"s/^hours:.*/\$a/\" /shows/$2.md"
}

# Back to the schedule: the specs leave the show they last needed on air
# (test/helpers.ts onAir).
dc exec -T caddy wget -q -O /dev/null --post-data= http://liquidsoap:7000/onair ||
  fail "couldn't put the schedule back on air"

listen
expect 1 "connecting"
# A listener on a show's own channel (default's: the last step removes night).
listen -channel default

step "nothing changed: nothing restarts"
deploy_change "" "nothing" :

step "a new app: only the app restarts"
deploy_change app "a new app" "dc up -d --no-build --no-deps --force-recreate app 2>/dev/null"

step "a Caddyfile change: Caddy reloads in place"
deploy_change "" "a Caddyfile change" "dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile --force 2>/dev/null"

step "music added and removed: nothing restarts"
deploy_change "" "a music change" \
  "edit_files 'cp /music/night/*.mp3 /music/default/ && rm \"/music/default/Alpha Artist- First Light.mp3\"'"

step "hours changed: nothing restarts; Liquidsoap re-reads them, and a gap is an error in its log"
deploy_change "" "an hours change" "edit_files 'sed -i \"s/^hours: 0-3$/hours: 0-2/\" /shows/*.md'"
WAIT=90 wait_for logged "2:00: no show on air" || fail "Liquidsoap didn't log the gap the new hours left"

step "a deploy cut short after syncing a new show: Liquidsoap keeps the hours it has"
edit_files 'printf -- "---\ntitle: Added\nhours: 2-3\n---\n" >/shows/added.md && chmod a+r /shows/added.md'
WAIT=90 wait_for logged "differ from the ones running" ||
  fail "Liquidsoap didn't log that the shows on disk differ from the ones it runs"

step "a show added: Liquidsoap restarts, and Icecast has its channel"
deploy_change liquidsoap "a new show" \
  "edit_files 'printf -- \"---\\ntitle: Added\\nhours: 2-3\\n---\\n\" >/shows/added.md && chmod a+r /shows/added.md'" restart
channel_on() { dc exec -T caddy wget -qO- "http://icecast:8000/status-json.xsl?mount=/stream/added" | grep -q listenurl; }
wait_for channel_on || fail "after the restart, Icecast has no /stream/added"

step "a show removed: Liquidsoap restarts"
deploy_change liquidsoap "a removed show" "edit_files 'rm /shows/night.md'" restart

step "what the listener heard"
heard
step "what the channel listener heard"
heard -channel default
step "the listeners stayed connected, without a pause over ${MAX_GAP_MS} ms, through every deploy"
