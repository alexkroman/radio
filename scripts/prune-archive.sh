#!/bin/sh
# Archive retention: deletes finished blocks (archive/blocks/<show>-<YYYY-MM-DD>.mp3,
# recorded by radio.liq) finished over 14 days ago, then all but the newest
# ARCHIVE_KEEP (default 1) blocks of each show. compose.yml's archive-prune
# service runs it every hour. The block being recorded (archive/recording/)
# isn't touched. ARCHIVE_DIR (default /archive) for a run elsewhere.
set -eu
dir=${ARCHIVE_DIR:-/archive}/blocks
keep=${ARCHIVE_KEEP:-1}
case $keep in '' | *[!0-9]*) keep=1 ;; esac
[ -d "$dir" ] || exit 0
cd "$dir"
# 14 days = 20160 minutes, whatever the setting.
find . -maxdepth 1 -name '*.mp3' -mmin +20160 -exec sh -c 'for f; do echo "prune-archive: ${f#./} (over 14 days old)"; rm -f "$f"; done' sh {} +
# Newest first by name (the date), so each show's first $keep stay.
# (Blocks are named <slug>-<date>.mp3: no spaces to split on.)
for f in $(printf '%s\n' *-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].mp3 | sort -r); do
  [ -e "$f" ] || continue
  show=${f%-*-*-*.mp3}
  eval "n=\${seen_$(printf %s "$show" | tr -c 'a-z0-9\n' _):-0}"
  n=$((n + 1))
  eval "seen_$(printf %s "$show" | tr -c 'a-z0-9\n' _)=$n"
  if [ "$n" -gt "$keep" ]; then
    echo "prune-archive: $f (keeping $keep a show)"
    rm -f -- "$f"
  fi
done
