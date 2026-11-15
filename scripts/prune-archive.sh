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
  find "$root/short" -maxdepth 1 -name '*.mp3' -print -delete | sed 's|.*/|prune-archive: too short to archive: |'
fi
[ -d "$root/blocks" ] || exit 0
cd "$root/blocks"
# 14 days less an hour = 20100 minutes, whatever the setting.
find . -maxdepth 1 -name '*.mp3' -mmin +20100 -print -delete | sed 's|^\./|prune-archive: up two weeks: |'
# Newest first by name (the date), so each show's first $keep stay. (Blocks
# are named <slug>-<date>.mp3: nothing to quote.)
printf '%s\n' *-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].mp3 | sort -r |
  awk -v keep="$keep" '{ show = $0; sub(/-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]\.mp3$/, "", show) } ++n[show] > keep' |
  while read -r f; do
    [ -e "$f" ] || continue
    echo "prune-archive: keeping $keep a show: $f"
    rm -f -- "$f"
  done
