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
dc up -d --no-build caddy liquidsoap archive-prune
dc run --rm --no-deps e2e npx playwright test "$@"

# Deploys disturb no listener. With a listener playing the stream through
# Caddy (as players do, test/listen.ts), run a deploy's server side (`compose
# up`, then scripts/reconcile.sh) for each kind of change, and check that it
# stays connected without a pause in the audio longer than MAX_GAP_MS
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
# A listener on /stream through Caddy, in the background (radio-e2e-listen).
listen() { dc run -d --no-deps --name radio-e2e-listen e2e node test/listen.ts >/dev/null; }
# Stop the listener and check its log: never dropped, no pause over MAX_GAP_MS.
heard() {
  local log longest
  docker stop radio-e2e-listen >/dev/null
  log=$(docker logs radio-e2e-listen)
  docker rm radio-e2e-listen >/dev/null
  printf '%s\n' "$log" | sed "s|^|  |"
  longest=$(printf '%s\n' "$log" | sed -n 's/.* longest gap \([0-9]*\) ms$/\1/p')
  [ -n "$longest" ] || fail "the listener was dropped"
  [ "$longest" -le "$MAX_GAP_MS" ] || fail "the listener heard a ${longest} ms pause"
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
  dc up -d --no-build --remove-orphans caddy liquidsoap archive-prune 2>/dev/null
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
# The archive (radio.liq): the block being recorded (its file name), a file's
# size, whether a finished block exists, and a sidecar's offsets.
recording() { dc exec -T liquidsoap ls /archive/recording | head -n 1; }
size() { dc exec -T liquidsoap sh -c "wc -c <\"/archive/$1\"" 2>/dev/null || echo 0; }
grows() { [ "$(size "recording/$1")" -gt "$2" ]; }
finished() { dc exec -T liquidsoap test -s "/archive/blocks/$1"; }
too_short() { dc exec -T liquidsoap test -s "/archive/short/$1"; }
recording_is() { [ "$(recording)" = "$1" ]; }
recording_not() { [ -n "$(recording)" ] && [ "$(recording)" != "$1" ]; }
offsets() { dc exec -T liquidsoap sed -n 's/^{"offset":\([0-9.]*\),.*/\1/p' "/archive/tracks/${1%.mp3}.jsonl"; }
# Icecast's answer to a block's URL (Caddy passes /archive/<block>.mp3 to it).
served() { dc exec -T caddy wget -q -O /dev/null "http://icecast:8000/archive/$1"; }
# Swap two shows' hours (Liquidsoap re-reads them within a minute).
swap_hours() {
  edit_files "a=\$(grep '^hours:' /shows/$1.md) b=\$(grep '^hours:' /shows/$2.md)
    sed -i \"s/^hours:.*/\$b/\" /shows/$1.md && sed -i \"s/^hours:.*/\$a/\" /shows/$2.md"
}

step "archive plays are counted per block and day from Icecast's access log, apart from the stream"
plays=$(dc exec -T icecast cat /var/log/icecast/access.log | sh scripts/archive-plays.sh -)
printf '%s\n' "$plays" | sed 's/^/  /'
printf '%s\n' "$plays" | grep -qE "^[0-9]{4}-[0-9]{2}-[0-9]{2}	night-2026-11-14	[1-9][0-9]*	" ||
  fail "archive-plays.sh counted no plays of the archive block"
! printf '%s\n' "$plays" | grep -q stream || fail "archive-plays.sh counted the live stream"
dc exec -T icecast grep -q '"GET /stream HTTP' /var/log/icecast/access.log ||
  fail "the access log has no live stream requests to tell apart"

# Back to the schedule: the specs leave the show they last needed on air
# (test/helpers.ts onAir), and a block follows the show on air by its hours.
dc exec -T caddy wget -q -O /dev/null --post-data= http://liquidsoap:7000/onair ||
  fail "couldn't put the schedule back on air"
# The show put on air by hand may play one more track (up to 48 s) as it
# goes, which counts as on air for ARCHIVE_OVERRUN (60 s) from its start.
# Wait that out, so the block recorded is the show whose hours it is.
sleep 110

step "the archive records the block on air at 256 kbps, into a growing file named for its show and date"
wait_for test -n "$(recording)" || fail "nothing is being recorded"
block=$(recording)
echo "  recording $block"
printf '%s\n' "$block" | grep -qE '^[a-z0-9-]+-[0-9]{4}-[0-9]{2}-[0-9]{2}\.mp3$' || fail "recording a badly named $block"
before=$(size "recording/$block")
sleep 10
rate=$((($(size "recording/$block") - before) / 10))
echo "  $rate bytes a second"
[ "$rate" -ge 30000 ] && [ "$rate" -le 34000 ] || fail "recording at $rate bytes a second, not 256 kbps (32000)"

listen
expect 1 "connecting"

step "nothing changed: nothing restarts"
deploy_change "" "nothing" :

step "a new app: only the app restarts"
deploy_change app "a new app" "dc up -d --no-build --no-deps --force-recreate app 2>/dev/null"

step "a Caddyfile change: Caddy reloads in place"
deploy_change "" "a Caddyfile change" "dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile --force 2>/dev/null"

step "music added and removed: nothing restarts"
deploy_change "" "a music change" \
  "edit_files 'cp /music/night/*.mp3 /music/default/ && rm \"/music/default/Alpha Artist- First Light.mp3\"'"

step "a block boundary: the recording finishes its block, with its tracks, and starts the next, without a restart"
# Swap the hours of the show recorded now and another, so the other's block
# starts with its first track: up to a minute for Liquidsoap to see the new
# hours, then the track playing finishes, then the ended block's tail.
show=${block%-*-*-*.mp3}
other=default
[ "$show" != default ] || other=edge
deploy_change "" "a new block" "swap_hours $show $other"
WAIT=150 wait_for finished "$block" || fail "$block wasn't moved to blocks/ when its block ended"
wait_for recording_not "$block" || fail "no new block is being recorded after $block"
seconds=$(($(size "blocks/$block") / 32000))
echo "  finished $block ($seconds s); now recording $(recording)"
ended=$block
block=$(recording)
case $block in "$other"-*) ;; *) fail "recording $block, not $other's block" ;; esac
# It starts with its show's first track, as the crossfade into it starts.
[ "$(offsets "$block" | head -n 1 | cut -d. -f1)" = 0 ] || fail "$block doesn't start with a track"
# Its sidecar: a line per track, in order, within the block.
offsets "$ended" | sed 's/^/  track at /'
[ "$(offsets "$ended" | wc -l)" -ge 2 ] || fail "$ended's sidecar has under two tracks"
offsets "$ended" | sort -n -c || fail "$ended's sidecar isn't in order"
[ "$(offsets "$ended" | tail -n 1 | cut -d. -f1)" -le "$seconds" ] || fail "$ended's sidecar runs past its end"
served "$ended" || fail "Icecast doesn't serve $ended"

step "a block cut short isn't archived: it's kept from Icecast and the site"
# Swap again before the new block reaches ARCHIVE_MIN_SECONDS (150).
third=long
[ "$show" != long ] || third=plain
deploy_change "" "a short block" "swap_hours $other $third"
WAIT=150 wait_for too_short "$block" || fail "$block, cut short, wasn't moved to short/"
! finished "$block" || fail "$block, cut short, was archived"
! served "$block" || fail "Icecast serves $block, cut short"
short=$block
block=$(recording)

step "retention: blocks up two weeks less an hour go, all but ARCHIVE_KEEP (1) of a show, and every short one"
# shellcheck disable=SC2016 # expands in the container
edit_files 'cd /archive/blocks && for d in 2026-10-01 2026-11-10 2026-11-12; do : >"zz-$d.mp3"; done &&
  touch -d "$(date -d @$(($(date +%s) - 14 * 86400 + 3000)) "+%Y-%m-%d %H:%M:%S")" zz-2026-10-01.mp3'
dc run --rm --no-deps -T -e ARCHIVE_KEEP=1 archive-prune sh /prune-archive.sh | sed 's/^/  /'
[ "$(dc exec -T liquidsoap sh -c 'ls /archive/blocks | grep ^zz-')" = zz-2026-11-12.mp3 ] ||
  fail "pruning left $(dc exec -T liquidsoap sh -c 'ls /archive/blocks | grep ^zz- | xargs')"
finished "$ended" || fail "pruning took $ended, its show's newest block"
[ -z "$(dc exec -T liquidsoap ls /archive/short)" ] || fail "pruning left a short block"
dc exec -T liquidsoap test -e "/archive/tracks/${short%.mp3}.jsonl" || fail "pruning took a sidecar"
dc exec -T liquidsoap test -s "/archive/tracks/night-2026-11-13.jsonl" || fail "pruning took a pruned block's sidecar"

step "hours changed: nothing restarts; Liquidsoap re-reads them, and a gap is an error in its log"
deploy_change "" "an hours change" "edit_files 'sed -i \"s/^hours: 0-3$/hours: 0-2/\" /shows/*.md'"
WAIT=90 wait_for logged "2:00: no show on air" || fail "Liquidsoap didn't log the gap the new hours left"

block=$(recording)
before=$(size "recording/$block")
step "a show added: Liquidsoap restarts, and the recording carries on in the same file"
deploy_change liquidsoap "a new show" \
  "edit_files 'printf -- \"---\\ntitle: Added\\nhours: 2-3\\n---\\n\" >/shows/added.md && chmod a+r /shows/added.md'" restart

wait_for recording_is "$block" || fail "after the restart, recording $(recording), not $block"
wait_for grows "$block" "$before" || fail "after the restart, $block didn't grow from $before bytes"

step "a show removed: Liquidsoap restarts"
deploy_change liquidsoap "a removed show" "edit_files 'rm /shows/night.md'" restart

step "what the listener heard"
heard
step "the listener stayed connected, without a pause over ${MAX_GAP_MS} ms, through every deploy"
