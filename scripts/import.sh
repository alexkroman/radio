#!/usr/bin/env bash
# Import and tag music for one or all shows, then extract cover art.
#
# Usage:
#   scripts/import.sh              # process every show under music/
#   scripts/import.sh jazz         # process music/jazz/ only
#
# What it does (safe to re-run; existing tagged files and covers are skipped):
#   1. beet import – MusicBrainz lookup, writes tags, embeds cover art
#   2. Remove exact duplicate files within each show directory
#   3. Extract embedded cover art from each track to covers/<show>/<stem>.jpg
#
# Requirements: beets (pip install beets), ffmpeg, fdupes
#   First run: edit scripts/beets/config.yaml and set your AcoustID API key.

set -euo pipefail
cd "$(dirname "$0")/.."

MUSIC_DIR="music"
COVERS_DIR="covers"
CONFIG="scripts/beets/config.yaml"

# ── Validate dependencies ────────────────────────────────────────────────────
for cmd in beet ffmpeg fdupes; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' not found. Install it and try again." >&2
    exit 1
  fi
done

# ── Determine which shows to process ────────────────────────────────────────
if [[ "${1:-}" != "" ]]; then
  show_dirs=("$MUSIC_DIR/$1")
else
  show_dirs=()
  while IFS= read -r dir; do show_dirs+=("$dir"); done < <(find "$MUSIC_DIR" -mindepth 1 -maxdepth 1 -type d | sort)
fi

if [[ ${#show_dirs[@]} -eq 0 ]]; then
  echo "No show directories found under $MUSIC_DIR/."
  exit 0
fi

# ── Process each show ────────────────────────────────────────────────────────
for show_dir in "${show_dirs[@]}"; do
  [[ -d "$show_dir" ]] || { echo "WARN: $show_dir not found, skipping." >&2; continue; }
  slug=$(basename "$show_dir")

  echo ""
  echo "══ $slug ══════════════════════════════════"

  # 1. Remove exact duplicates (same content, different filenames)
  echo "── Deduplication"
  fdupes --delete --noprompt --quiet "$show_dir" || true

  # 2. Tag with MusicBrainz via beets (incremental: skips already-imported)
  echo "── Tagging (beets import)"
  beet -c "$CONFIG" import -q "$show_dir" || true

  # 3. Extract cover art from each track
  echo "── Extracting covers"
  cover_dir="$COVERS_DIR/$slug"
  mkdir -p "$cover_dir"

  while IFS= read -r -d '' file; do
    stem=$(basename "${file%.*}")
    out="$cover_dir/$stem.jpg"

    # Skip if already extracted (re-run safety)
    [[ -f "$out" ]] && continue

    # Extract the first video stream (embedded album art) and convert to JPEG.
    # ffmpeg exits non-zero when no video stream exists; suppress that.
    if ffmpeg -i "$file" -map 0:v:0 "$out" -y -loglevel error 2>/dev/null; then
      echo "  ✓ $stem"
    else
      rm -f "$out"
    fi
  done < <(find "$show_dir" -maxdepth 1 \( -name "*.mp3" -o -name "*.flac" -o -name "*.m4a" \) -print0 | sort -z)
done

echo ""
echo "Done. Run 'docker compose restart liquidsoap' if the stack is running."
