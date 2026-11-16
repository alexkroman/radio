#!/bin/sh
# Brings the running streams in line with the files on disk, without dropping
# a listener. scripts/deploy.sh runs it on the server after every sync, and
# test/e2e.sh after adding and removing a show. It compares what is running
# with what is on disk, so a deploy cut short is caught up by the next one.
#   - Icecast: `config.sh reload` rebuilds its config and has it re-read it,
#     keeping everyone connected.
#   - Liquidsoap reads radio.liq and the list of shows once, at startup
#     (radio.liq writes the list to /tmp/shows): restart it when either
#     differs from the files. radio.liq is a single-file bind mount, so the
#     container still has the one it started with. Listeners hear the
#     stream's silent fallback meanwhile. A container `up` just created gets
#     up to 30 s to write /tmp/shows first.
#   - Caddy reloads its config in place, keeping every connection (a no-op
#     when it's unchanged).
# Edits to a show (its hours included) and music need none of these: the app
# re-reads a show file when it changes, Liquidsoap re-reads the hours every
# minute and watches the music folders.
# Run from the checkout. COMPOSE overrides the compose command (test/e2e.sh's
# names its project and files).
set -eu
# shellcheck disable=SC2086 # COMPOSE is a command with arguments
dc() { ${COMPOSE:-docker compose} "$@"; }
dc exec -T icecast sh /icecast/config.sh reload
# shellcheck disable=SC2016 # expands in the container
if ! dc exec -T liquidsoap cat /radio.liq | cmp -s - radio.liq ||
  ! dc exec -T liquidsoap sh -c 'for _ in $(seq 30); do [ -e /tmp/shows ] && break; sleep 1; done
    [ "$(sort /tmp/shows)" = "$(ls /shows/*.md 2>/dev/null | sort)" ]'; then
  echo "Restarting Liquidsoap (radio.liq or the shows changed)"
  # Icecast applies the reload above in the background: a source that stopped
  # in the same second could lose its fallback and drop its listeners.
  sleep 5
  dc restart liquidsoap >/dev/null
fi
# Its output (info lines like "using config from file") only if it fails.
out=$(dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>&1) ||
  { printf '%s\n' "$out" >&2 && exit 1; }
