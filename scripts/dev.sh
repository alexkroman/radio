#!/bin/sh
# The site alone (no audio) on http://localhost:3000/, on your shows/ and
# covers/ and the server's play log: first brought up to date in backup/plays/
# (where scripts/deploy.sh keeps it too) when .env has IP=, so what's on air
# and its covers match the music you have. Without the server, the last copy.
set -e
cd "$(dirname "$0")/.."
IP=${IP:-$(grep -E '^IP=' .env 2>/dev/null | cut -d= -f2- || true)}
mkdir -p backup/plays
if [ -n "$IP" ]; then
  rsync -rt -e "ssh -o ConnectTimeout=5" "ubuntu@$IP:radio/plays/" backup/plays/ ||
    echo "dev: couldn't reach $IP; using the last copy of the play log" >&2
fi
npm run build
SHOWS_DIR=shows PLAYS_DIR=backup/plays ARCHIVE_DIR=archive COVERS_DIR=covers exec node dist/server.js
