#!/bin/sh
# Archive plays per block per day, for royalty reporting, from Icecast's
# access logs: GET /archive/<show>-<YYYY-MM-DD>.mp3 answered 200 (or 206, a
# range). A play can be several requests: a player that drops resumes with a
# range request, and some probe first; so a listener's (address and user
# agent) requests for a block that overlap or follow within two minutes are
# one play, connected from the first's start to the last's end, as in
# app/archive-plays.ts. Live listeners (/stream) aren't counted.
# Days are when the play ended, in Icecast's time zone (TZ in compose.yml);
# the reports count a play in the month it started.
#   scripts/archive-plays.sh                  # logs/access.log*
#   scripts/archive-plays.sh some/access.log  # or any logs, or - for stdin
# Prints: day, block, plays, hours connected (tab-separated, by day then block).
set -eu
cd "$(dirname "$0")/.."
if [ $# -eq 0 ]; then set -- logs/access.log*; fi
printf 'day\tblock\tplays\thours\n'
cat -- "$@" | awk '
  # Days since 1970-01-01 (no mktime in POSIX awk).
  function days(y, m, d) {
    if (m <= 2) { y--; m += 12 }
    return 365 * y + int(y / 4) - int(y / 100) + int(y / 400) + int((153 * (m - 3) + 2) / 5) + d - 719469
  }
  # IP - - [15/Nov/2026:20:47:13 -0800] "GET /archive/x.mp3 HTTP/1.1" 200 bytes "ref" "agent" seconds
  $6 == "\"GET" && ($9 == "200" || $9 == "206") &&
    $7 ~ /^\/archive\/[a-z0-9-]+-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]\.mp3$/ {
    split(substr($4, 2), t, /[\/:]/)
    m = (index("JanFebMarAprMayJunJulAugSepOctNovDec", t[2]) + 2) / 3
    end = ((days(t[3], m, t[1]) * 24 + t[4]) * 60 + t[5]) * 60 + t[6]
    agent = $0
    sub(/" [0-9]+$/, "", agent)
    sub(/.*"/, "", agent)
    # who, start, end, day (local), block
    printf "%s %s %s\t%d\t%d\t%s-%02d-%s\t%s\n", $1, agent, $7, end - $NF, end, t[3], m, t[1], substr($7, 10, length($7) - 13)
  }
' | sort -t "$(printf '\t')" -k1,1 -k2,2n | awk -F '\t' '
  function done() {
    if (who == "") return
    plays[day "\t" block]++
    secs[day "\t" block] += end - start
  }
  {
    if ($1 == who && $2 <= end + 120) {
      if ($3 > end) { end = $3; day = $4 }
      next
    }
    done()
    who = $1; start = $2; end = $3; day = $4; block = $5
  }
  END {
    done()
    for (k in plays) printf "%s\t%d\t%.2f\n", k, plays[k], secs[k] / 3600
  }
' | sort
