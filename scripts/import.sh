#!/usr/bin/env bash
# Import and tag music for one or all shows, then extract cover art.
#
# Usage:
#   scripts/import.sh                    # process every show under music/
#   scripts/import.sh frequency          # process music/frequency/ only
#   scripts/import.sh --all frequency    # re-match every track, not just new
#                                        # ones, for MusicBrainz additions and
#                                        # fixes (hours per show)
#
# What it does (safe to re-run; re-checks tags/covers for changed files):
#   1. Remove exact duplicate files within each show directory
#   2. beet import     – group new tracks into albums by their tags, fingerprint
#                        + MusicBrainz lookup, then embed the best cover art
#                        found (fetchart + embedart). With --all, every track
#                        in the folder, matched or not.
#   3. beet update     – refresh tags for files changed since last run
#   4. beet mbsync     – with --all: re-sync MusicBrainz data (ISRC, album
#                        artist) for matched tracks
#   5. beet move       – rename to "Artist - Title.ext"
#   6. report duplicates (files import skipped, and tracks matched to the same
#      MusicBrainz recording); nothing is deleted
#   7. ffmpeg          – extract embedded cover art to covers/<show>/<stem>.jpg
#                        (and remove covers whose track is gone)
#
# Requirements:
#   brew install chromaprint fdupes ffmpeg pipx
#   pipx install beets && pipx inject beets pyacoustid pillow
#   pipx ensurepath   # adds ~/.local/bin to PATH if needed; restart shell
#
# If using Homebrew beets instead of pipx:
#   /opt/homebrew/opt/beets/libexec/bin/pip install pyacoustid pillow

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
    beet) echo "  brew install pipx && pipx install beets && pipx inject beets pyacoustid pillow" >&2 ;;
    fpcalc) echo "  brew install chromaprint" >&2 ;;
    ffmpeg) echo "  brew install ffmpeg" >&2 ;;
    fdupes) echo "  brew install fdupes" >&2 ;;
    esac
    exit 1
  fi
done

# Verify beets' Python environment has pyacoustid (the chroma plugin) and
# Pillow (fetchart/embedart size checks and resizing; without it they quietly
# skip both). Use a temp DB so beet doesn't prompt to create a directory.
tmpdir=$(mktemp -d)
beet_ver=$(beet -c "$CONFIG" -l "$tmpdir/check.db" version 2>&1 </dev/null || true)
rm -rf "$tmpdir"
beet_python=$(head -n1 "$(command -v beet)" | sed 's/^#! *//; s/ .*//')
if ! echo "$beet_ver" | grep -q "chroma" || ! "$beet_python" -c "import PIL" 2>/dev/null; then
  beet_bin=$(command -v beet)
  echo "ERROR: pyacoustid or Pillow not installed in beets' Python environment." >&2
  if [[ $beet_bin == */Cellar/* || $beet_bin == */opt/homebrew/* ]]; then
    echo "  Fix (Homebrew): /opt/homebrew/opt/beets/libexec/bin/pip install pyacoustid pillow" >&2
  else
    echo "  Fix (pipx): pipx inject beets pyacoustid pillow" >&2
  fi
  exit 1
fi

# ── Determine which shows to process ────────────────────────────────────────
all=false
if [[ ${1:-} == "--all" ]]; then
  all=true
  shift
fi
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
  # Every command gets the show dir as beets' library directory: beets 2.x
  # stores paths under it relative to it, so a command run with another
  # directory can't find the files (and `beet update` drops them).
  BEET="beet -c $CONFIG -l $LIB -d $PWD/$show_dir"

  # 1. Remove exact duplicates (same audio content, different filenames)
  echo "── Deduplication"
  fdupes --delete --noprompt --quiet "$show_dir"

  # 2. Import new tracks, grouped into albums by their tags (config.yaml);
  #    fetchart and embedart add cover art as each album is imported.
  # beet import exits 1 when tracks are imported as-is (no MusicBrainz match); that's expected.
  if $all; then
    # beets re-matches files already in the library, so this redoes them all:
    # unmatched tracks MusicBrainz has since added get a match, and matched
    # ones pick up its corrections.
    echo "── Re-importing every track (beet import)"
    $BEET import -q "$show_dir" </dev/null || true
  else
    # Only files not in the library yet: move them to a staging folder (on the
    # same disk, outside music/ so Liquidsoap doesn't see it) and import that
    # with -m, which moves each one back into the show folder under its
    # library name. A file import skips (a duplicate) stays in staging and is
    # moved back after, as are files left by an interrupted run.
    echo "── Importing new tracks (beet import)"
    staging="scripts/beets/staging-$slug"
    unstage() {
      [[ -d $staging ]] || return 0
      find "$staging" -type f -exec mv -n {} "$show_dir/" \;
      find "$staging" -depth -type d -empty -delete
    }
    unstage
    mkdir -p "$staging"
    trap unstage EXIT
    # shellcheck disable=SC2016 # $path is a beets format field, not shell
    comm -23 \
      <(find "$PWD/$show_dir" -maxdepth 1 \( -name "*.mp3" -o -name "*.flac" -o -name "*.m4a" \) | sort) \
      <($BEET ls -f '$path' </dev/null | sort) |
      while IFS= read -r file; do mv -n "$file" "$staging/"; done
    new=$(find "$staging" -type f | wc -l | tr -d ' ')
    if [[ $new -gt 0 ]]; then
      echo "  $new new"
      $BEET import -q -m "$staging" </dev/null || true
    fi
    unstage
    trap - EXIT
  fi

  # 3. Refresh tags for files changed on disk since last run
  echo "── Updating changed files (beet update)"
  $BEET update </dev/null

  # 4. Re-sync MusicBrainz data for complete ISRC and album artist. A match
  #    already brings these, so only with --all: it looks up every album.
  # beet mbsync exits 1 when no items match; that's expected.
  if $all; then
    echo "── Syncing MusicBrainz metadata (beet mbsync)"
    $BEET mbsync </dev/null || true
  fi

  # 5. Rename files to "Artist - Title.ext" within the show directory
  echo "── Renaming files (beet move)"
  $BEET move </dev/null

  # 6. Report duplicates; deleting is left to you. Import skips a file whose
  #    artist and title (after matching, so two rips of one song) are already
  #    in the library, but the file stays here and still plays. The duplicates
  #    plugin finds library tracks matched to the same MusicBrainz recording
  #    under different titles.
  echo "── Duplicates (not deleted; remove by hand)"
  # shellcheck disable=SC2016 # $path is a beets format field, not shell
  comm -23 \
    <(find "$PWD/$show_dir" -maxdepth 1 \( -name "*.mp3" -o -name "*.flac" -o -name "*.m4a" \) | sort) \
    <($BEET ls -f '$path' </dev/null | sort) |
    sed 's|^|  not imported (a library track has its artist and title): |'
  # shellcheck disable=SC2016
  $BEET duplicates -s -F -k mb_trackid -f '  same recording: $path' </dev/null

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
    # A file whose tags were rewritten (--all) is newer than its cover even
    # when its art is the same: then keep the cover as it is (so a deploy
    # doesn't upload it again) and only mark it current.
    tmp="$cover_dir/.$stem.tmp.jpg"
    if ffmpeg -nostdin -i "$file" -map 0:v:0 "$tmp" -y -loglevel error 2>/dev/null; then
      if [[ -f $out ]] && cmp -s "$tmp" "$out"; then
        rm -f "$tmp"
        touch "$out"
      else
        mv -f "$tmp" "$out"
        echo "  ✓ $stem"
      fi
    else
      rm -f "$tmp" "$out"
    fi
  done < <(find "$show_dir" -maxdepth 1 \( -name "*.mp3" -o -name "*.flac" -o -name "*.m4a" \) -print0 | sort -z)

  # Remove covers whose track is gone (deleted, or renamed by beet move).
  for cover in "$cover_dir"/*.jpg; do
    [[ -e $cover ]] || continue
    stem=$(basename "${cover%.jpg}")
    [[ -e "$show_dir/$stem.mp3" || -e "$show_dir/$stem.flac" || -e "$show_dir/$stem.m4a" ]] || rm -f "$cover"
  done
done

echo ""
echo "Done. Now run: scripts/deploy.sh"
