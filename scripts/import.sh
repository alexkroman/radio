#!/usr/bin/env bash
# Import and tag music for one or all shows, then extract cover art.
#
# Usage:
#   scripts/import.sh              # process every show under music/
#   scripts/import.sh jazz         # process music/jazz/ only
#
# What it does (safe to re-run; re-checks tags/covers for changed files):
#   1. Remove exact duplicate files within each show directory
#   2. beet import -s  – fingerprint + MusicBrainz lookup for new tracks
#   3. beet update     – refresh tags for files changed since last run
#   4. beet mbsync     – re-sync MusicBrainz data (ISRC, album artist)
#   5. beet fetchart   – fetch missing cover art
#   6. beet move       – rename to "Artist - Title.ext"
#   7. ffmpeg          – extract embedded cover art to covers/<show>/<stem>.jpg
#
# Requirements:
#   brew install chromaprint fdupes ffmpeg pipx
#   pipx install beets && pipx inject beets pyacoustid
#   pipx ensurepath   # adds ~/.local/bin to PATH if needed; restart shell
#
# If using Homebrew beets instead of pipx:
#   /opt/homebrew/opt/beets/libexec/bin/pip install pyacoustid

set -euo pipefail
cd "$(dirname "$0")/.."

MUSIC_DIR="music"
COVERS_DIR="covers"
CONFIG="scripts/beets/config.yaml"

# ── Validate dependencies ────────────────────────────────────────────────────
for cmd in beet fpcalc ffmpeg fdupes; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' not found." >&2
    case "$cmd" in
    beet) echo "  brew install pipx && pipx install beets && pipx inject beets pyacoustid" >&2 ;;
    fpcalc) echo "  brew install chromaprint" >&2 ;;
    ffmpeg) echo "  brew install ffmpeg" >&2 ;;
    fdupes) echo "  brew install fdupes" >&2 ;;
    esac
    exit 1
  fi
done

# Verify pyacoustid is installed in beets' Python environment (needed for chroma plugin).
# Use a temp DB so beet doesn't prompt to create a directory.
tmpdb=$(mktemp /tmp/beet-check-XXXXXX)
rm -f "$tmpdb"
tmpdb="${tmpdb}.db"
beet_ver=$(beet -c "$CONFIG" -l "$tmpdb" version 2>&1 </dev/null || true)
rm -f "$tmpdb" "${tmpdb%.*}"*.bak
if ! echo "$beet_ver" | grep -q "chroma"; then
  beet_bin=$(command -v beet)
  echo "ERROR: pyacoustid not installed in beets' Python environment." >&2
  if [[ $beet_bin == */Cellar/* || $beet_bin == */opt/homebrew/* ]]; then
    echo "  Fix (Homebrew): /opt/homebrew/opt/beets/libexec/bin/pip install pyacoustid" >&2
  else
    echo "  Fix (pipx): pipx inject beets pyacoustid" >&2
  fi
  exit 1
fi

# ── Determine which shows to process ────────────────────────────────────────
if [[ ${1:-} != "" ]]; then
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
  [[ -d $show_dir ]] || {
    echo "WARN: $show_dir not found, skipping." >&2
    continue
  }
  slug=$(basename "$show_dir")

  echo ""
  echo "══ $slug ══════════════════════════════════"

  LIB="scripts/beets/library-$slug.db"
  BEET="beet -c $CONFIG -l $LIB"

  # 1. Remove exact duplicates (same audio content, different filenames)
  echo "── Deduplication"
  fdupes --delete --noprompt --quiet "$show_dir"

  # 2. Import new tracks (singleton mode — each file matched individually)
  echo "── Importing new tracks (beet import)"
  $BEET import -q -s "$show_dir" </dev/null

  # 3. Refresh tags for files changed on disk since last run
  echo "── Updating changed files (beet update)"
  $BEET update </dev/null

  # 4. Re-sync MusicBrainz data for complete ISRC and album artist
  echo "── Syncing MusicBrainz metadata (beet mbsync)"
  $BEET mbsync </dev/null

  # 5. Fetch cover art for tracks that are still missing it
  echo "── Fetching missing cover art (beet fetchart)"
  $BEET fetchart </dev/null

  # 6. Rename files to "Artist - Title.ext" within the show directory
  echo "── Renaming files (beet move)"
  $BEET -d "$show_dir" move </dev/null

  # 7. Extract embedded cover art from each track to covers/<show>/<stem>.jpg.
  #    Re-extracts if the audio file is newer than the existing cover.
  echo "── Extracting covers"
  cover_dir="$COVERS_DIR/$slug"
  mkdir -p "$cover_dir"

  while IFS= read -r -d '' file; do
    stem=$(basename "${file%.*}")
    out="$cover_dir/$stem.jpg"

    # Skip if cover exists and is newer than the audio file
    [[ -f $out && $out -nt $file ]] && continue

    # Extract the first video stream (embedded album art) and convert to JPEG.
    # ffmpeg exits non-zero when no video stream exists; that's fine.
    if ffmpeg -nostdin -i "$file" -map 0:v:0 "$out" -y -loglevel error 2>/dev/null; then
      echo "  ✓ $stem"
    else
      rm -f "$out"
    fi
  done < <(find "$show_dir" -maxdepth 1 \( -name "*.mp3" -o -name "*.flac" -o -name "*.m4a" \) -print0 | sort -z)
done

echo ""
echo "Done. Run 'docker compose restart liquidsoap' if the stack is running."
