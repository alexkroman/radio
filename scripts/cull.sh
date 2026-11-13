#!/usr/bin/env bash
# Listen through a show's tracks and send the ones you don't want to the Trash.
#
# Usage:
#   scripts/cull.sh gloaming          # tracks not reviewed yet, shuffled
#   scripts/cull.sh --all gloaming    # every track, reviewed or not
#
# Keys while a track plays:
#   k / Enter   keep it and go to the next track (as does letting it finish)
#   d           move it (and its cover) to the Trash, next track
#   s           skip it for now (asked again next run)
#   → / f       forward 30 s        ← / b   back 10 s
#   Space       pause / resume      r       replay from the start
#   q           quit
#
# Kept tracks are listed in scripts/beets/culled-<show>.txt, so a rerun picks
# up where you left off. Trashed files can be put back from the Trash until
# you run scripts/deploy.sh, which removes them from the server (rsync
# --delete); the next scripts/import.sh drops them from the beets library.
#
# Needs ffplay (brew install ffmpeg). It runs without a window, so its own
# keys don't work: seeking restarts it at the new position.

set -euo pipefail
cd "$(dirname "$0")/.."

all=no
if [[ ${1-} == --all ]]; then
  all=yes
  shift
fi
slug=${1-}
show_dir="music/$slug"
if [[ -z $slug || ! -d $show_dir ]]; then
  echo "usage: scripts/cull.sh [--all] <show>   (one of: $(find music -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort | tr '\n' ' '))" >&2
  exit 2
fi
[[ -t 0 ]] || {
  echo "cull.sh needs a terminal to read keys from." >&2
  exit 2
}
command -v ffplay >/dev/null || {
  echo "ffplay not found: brew install ffmpeg" >&2
  exit 1
}

kept_list="scripts/beets/culled-$slug.txt"
touch "$kept_list"

# Tracks to review, shuffled so a session samples the whole show.
tracks=()
while IFS= read -r f; do
  if [[ $all == no ]] && grep -Fxq "$(basename "$f")" "$kept_list"; then
    continue
  fi
  tracks+=("$f")
done < <(
  find "$show_dir" -maxdepth 1 -type f \( -name "*.mp3" -o -name "*.flac" -o -name "*.m4a" \) |
    awk 'BEGIN { srand() } { print rand() "\t" $0 }' | sort -n | cut -f2-
)
total=${#tracks[@]}
if ((total == 0)); then
  echo "Nothing left to review in $slug (use --all to go through every track)."
  exit 0
fi

# Playback state: ffplay's pid, where in the track it started (offset) and
# when ($SECONDS), so the position is offset + time since, unless paused.
player='' offset=0 started=0 paused=no
play() { # play <file> <from-second>
  stop
  offset=$2 started=$SECONDS paused=no
  ffplay -nodisp -autoexit -nostats -loglevel quiet -ss "$offset" "$1" </dev/null 2>/dev/null &
  player=$!
}
stop() {
  if [[ -n $player ]]; then
    kill -CONT "$player" 2>/dev/null || true # a paused ffplay can't exit
    kill "$player" 2>/dev/null || true
    wait "$player" 2>/dev/null || true
    player=
  fi
}
position() {
  if [[ $paused == yes ]]; then
    echo "$offset"
  else
    echo $((offset + SECONDS - started))
  fi
}
seek() { # seek <file> <seconds, + or ->
  local to=$(($(position) + $2))
  ((to < 0)) && to=0
  ((secs > 0 && to >= secs)) && to=$((secs - 1))
  play "$1" "$to"
}
clock() { printf '%d:%02d' $(($1 / 60)) $(($1 % 60)); }

kept=0 trashed=0
summary() {
  stop
  echo
  echo "Kept $kept, trashed $trashed."
  if ((trashed > 0)); then
    echo "Run scripts/deploy.sh to remove them from the server."
  fi
}
trap summary EXIT
trap 'exit 130' INT

echo "$slug: $total tracks to review."
echo "[k/Enter] keep  [d] trash  [s] skip  [→/f] +30s  [←/b] -10s  [Space] pause  [r] replay  [q] quit"
i=0
for f in "${tracks[@]}"; do
  i=$((i + 1))
  name=$(basename "$f")
  secs=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null | cut -d. -f1)
  secs=${secs:-0}
  printf '\n[%d/%d] %s\n' "$i" "$total" "${name%.*}"

  play "$f" 0
  action=
  while [[ -z $action ]]; do
    state=
    [[ $paused == yes ]] && state="  paused"
    printf '\r  %s / %s%s   ' "$(clock "$(position)")" "$(clock "$secs")" "$state"
    if IFS= read -rsn1 -t 1 key; then
      if [[ $key == $'\e' ]]; then # arrow keys: ESC [ C / ESC [ D
        IFS= read -rsn2 -t 1 rest || rest=
        key=$key$rest
      fi
      case $key in
      k | K | "") action=keep ;;
      d | D) action=trash ;;
      s | S) action=skip ;;
      q | Q) action=quit ;;
      f | F | $'\e[C') seek "$f" 30 ;;
      b | B | $'\e[D') seek "$f" -10 ;;
      r | R) play "$f" 0 ;;
      " ")
        if [[ $paused == yes ]]; then
          kill -CONT "$player" 2>/dev/null || true
          started=$SECONDS paused=no
        else
          kill -STOP "$player" 2>/dev/null || true
          offset=$(position) paused=yes
        fi
        ;;
      esac
    elif ! kill -0 "$player" 2>/dev/null; then
      action=keep # played to the end
    fi
  done
  stop
  echo

  case $action in
  keep)
    grep -Fxq "$name" "$kept_list" || echo "$name" >>"$kept_list"
    kept=$((kept + 1))
    echo "  kept"
    ;;
  trash)
    cover="covers/$slug/${name%.*}.jpg"
    if [[ -e $cover ]]; then
      trash "$f" "$cover"
    else
      trash "$f"
    fi
    trashed=$((trashed + 1))
    echo "  trashed"
    ;;
  skip) echo "  skipped" ;;
  quit) break ;;
  esac
done
