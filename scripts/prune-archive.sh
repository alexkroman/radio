#!/bin/sh
# Archive retention (compose.yml's archive-prune service runs it every hour):
#   - deletes finished blocks (archive/blocks/<show>-<YYYY-MM-DD>.mp3,
#     recorded by radio.liq) once they've been up 14 days less an hour, so
#     with this running hourly none is available for more than two weeks (the
#     statutory license's limit for archived programs);
#   - then all but the newest ARCHIVE_KEEP (default 1) blocks of each show;
#   - empties archive/short/ (blocks too short to be archived programs).
# The block being recorded (archive/recording/) and the track sidecars
# (archive/tracks/, kept for the SoundExchange reports) aren't touched.
# ARCHIVE_DIR (default /archive) for a run elsewhere.
set -eu
root=${ARCHIVE_DIR:-/archive}
keep=${ARCHIVE_KEEP:-1}
case $keep in '' | *[!0-9]* | 0) keep=1 ;; esac
if [ -d "$root/short" ]; then
  find "$root/short" -maxdepth 1 -name '*.mp3' -exec sh -c 'for f; do echo "prune-archive: ${f##*/} (too short to archive)"; rm -f "$f"; done' sh {} +
fi
[ -d "$root/blocks" ] || exit 0
cd "$root/blocks"
# 14 days less an hour = 20100 minutes, whatever the setting.
find . -maxdepth 1 -name '*.mp3' -mmin +20100 -exec sh -c 'for f; do echo "prune-archive: ${f#./} (up two weeks)"; rm -f "$f"; done' sh {} +
# Newest first by name (the date), so each show's first $keep stay.
# (Blocks are named <slug>-<date>.mp3: no spaces to split on.)
for f in $(printf '%s\n' *-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].mp3 | sort -r); do
  [ -e "$f" ] || continue
  show=${f%-*-*-*.mp3}
  var=seen_$(printf %s "$show" | tr -c 'a-z0-9\n' _)
  eval "n=\${$var:-0}"
  n=$((n + 1))
  eval "$var=$n"
  if [ "$n" -gt "$keep" ]; then
    echo "prune-archive: $f (keeping $keep a show)"
    rm -f -- "$f"
  fi
done
