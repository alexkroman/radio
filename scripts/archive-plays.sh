#!/bin/sh
# Archive plays per block per day, for royalty reporting, from Icecast's
# access logs: each GET /archive/<show>-<YYYY-MM-DD>.mp3 answered 200 is one
# play (Caddy strips Range, so a play is one request from the beginning).
# Live listeners (/stream) are logged as their own requests and not counted.
# Days are when the play started, in Icecast's time zone (TZ in compose.yml).
#   scripts/archive-plays.sh                  # logs/access.log*
#   scripts/archive-plays.sh some/access.log  # or any logs, or - for stdin
# Prints: day, block, plays, hours connected (tab-separated, by day then block).
set -eu
cd "$(dirname "$0")/.."
if [ $# -eq 0 ]; then set -- logs/access.log*; fi
printf 'day\tblock\tplays\thours\n'
cat -- "$@" | awk '
  # IP - - [15/Nov/2026:20:47:13 -0800] "GET /archive/x.mp3 HTTP/1.1" 200 bytes "ref" "agent" seconds
  $6 == "\"GET" && $9 == "200" &&
    $7 ~ /^\/archive\/[a-z0-9-]+-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]\.mp3$/ {
    split(substr($4, 2, 11), d, "/")
    m = index("JanFebMarAprMayJunJulAugSepOctNovDec", d[2])
    day = sprintf("%s-%02d-%s", d[3], (m + 2) / 3, d[1])
    block = substr($7, 10, length($7) - 13)
    plays[day "\t" block]++
    secs[day "\t" block] += $NF
  }
  END {
    for (k in plays) printf "%s\t%d\t%.2f\n", k, plays[k], secs[k] / 3600
  }
' | sort
