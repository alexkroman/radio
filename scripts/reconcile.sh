#!/bin/sh
# Brings the running streams in line with the files on disk, without dropping
# a listener. scripts/deploy.sh runs it on the server after every sync, and
# test/e2e.sh after adding and removing a show. It compares what is running
# with what is on disk, so a deploy cut short is caught up by the next one.
#   - Icecast: `config.sh reload` rebuilds its config (a fallback mount per
#     show) and has it re-read the config, keeping everyone connected, if it
#     changed.
#   - Liquidsoap reads radio.liq and the list of shows once, at startup (one
#     output per show; radio.liq writes the list to /tmp/shows): restart it
#     when either differs from the files. radio.liq is a single-file bind
#     mount, so the container still has the one it started with. Listeners
#     hear their show's fallback meanwhile.
# Edits to a show need neither: the app reads shows/ on every request.
# Run from the checkout. COMPOSE overrides the compose command (test/e2e.sh's
# names its project and files).
set -eu
# shellcheck disable=SC2086 # COMPOSE is a command with arguments
dc() { ${COMPOSE:-docker compose} "$@"; }
dc exec -T icecast sh /icecast/config.sh reload
# shellcheck disable=SC2016 # expands in the container
if ! dc exec -T liquidsoap cat /radio.liq | cmp -s - radio.liq ||
  ! dc exec -T liquidsoap sh -c '[ "$(sort /tmp/shows)" = "$(ls /shows/*.md 2>/dev/null | sort)" ]'; then
  echo "Restarting Liquidsoap (radio.liq or the shows changed)"
  dc restart liquidsoap >/dev/null
fi
