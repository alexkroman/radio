#!/usr/bin/env bash
# A show's own stream (radio.liq block_stream) plays its archived blocks
# seamlessly, starting each track in a block's sidecar at its offset, with
# its tags. Runs radio.liq's own block_stream (and the plain helpers it uses,
# pasted from radio.liq) in the Liquidsoap image on blocks recorded as
# radio.liq records them (256 kbps MP3), then test/block-stream.ts checks:
#   - the stream's audio is the block's, decoded straight through, sample for
#     sample, across every track change (a decoder restarted at a track
#     makes its first frame silence or noise: a dropout at every track);
#   - each track starts within a frame of its offset, even half an hour into
#     a block, with its tags.
# Run by pre-commit when radio.liq changes, and so in CI.
set -euo pipefail
cd "$(dirname "$0")/.."
image=$(sed -n 's/^ *image: \(savonet\/liquidsoap:.*\)$/\1/p' compose.yml)
work=$(mktemp -d)
# BLOCK_STREAM_KEEP=1 keeps what it rendered, to look into a failure.
if [ -n "${BLOCK_STREAM_KEEP:-}" ]; then
  echo "block-stream: in $work"
else
  trap 'rm -rf "$work"' EXIT
fi
mkdir -p "$work/blocks" "$work/tracks" "$work/out" "$work/ref"
# Liquidsoap on a script in $work, its output shown only on a failure.
liq() {
  docker run --rm -u "$(id -u):$(id -g)" -v "$work:/w" --entrypoint liquidsoap "$image" "/w/$1" \
    >"$work/liq.log" 2>&1 || {
    cat "$work/liq.log" >&2
    exit 1
  }
}

# The blocks: noise, where any slip shows. Seams has tracks a few seconds
# apart; long, tracks far into it.
cat >"$work/make.liq" <<'LIQ'
settings.log.level := 2
running = ref(2)
def block(file, seconds) =
  s = noise()
  clock.assign_new(sync="none", [s])
  o = output.file(%mp3(bitrate = 256), file, fallible=true, s)
  done = ref(false)
  s.on_frame(
    synchronous=true,
    fun () ->
      if
        not done() and s.time() >= seconds
      then
        done := true
        o.stop()
        running := running() - 1
        if running() == 0 then shutdown() end
      end
  )
end
block("/w/blocks/seams-2026-01-01.mp3", 30.)
block("/w/blocks/long-2026-01-01.mp3", 1800.)
LIQ
liq make.liq

# Their sidecars, as radio.liq writes them (a quote and a backslash in tags).
track() {
  printf '{"offset":%s,"title":"%s","artist":"%s","album":"Album","label":"Label","isrc":"ISRC%s","cover":"c/%s.jpg"}\n' "$@"
}
{
  track 0 One A 1 one
  track 4 Two B 2 two
  track 9.5 'Thr\"ee' 'C\\D' 3 three
  track 17.27 Four D 4 four
  track 23.6 Five E 5 five
} >"$work/tracks/seams-2026-01-01.jsonl"
{
  track 0 Start A 1 start
  track 900 Middle B 2 middle
  track 1799.5 End C 3 end
} >"$work/tracks/long-2026-01-01.jsonl"

# Each block decoded straight through, for the stream to match.
cat >"$work/ref.liq" <<'LIQ'
settings.log.level := 2
running = ref(2)
def decode(slug) =
  s = once(single("/w/blocks/#{slug}-2026-01-01.mp3"))
  clock.assign_new(sync="none", [s])
  output.file(
    %wav(stereo, samplerate=44100),
    "/w/ref/#{slug}.wav",
    fallible=true,
    on_stop=
      fun () ->
        begin
          running := running() - 1
          if running() == 0 then shutdown() end
        end,
    s
  )
end
decode("seams")
decode("long")
LIQ
liq ref.liq

# radio.liq's own block_stream, and the plain helpers it uses.
def() { awk -v d="def $1(" 'index($0, d) == 1 { p = 1 } p { print } p && /^end$/ { exit }' radio.liq; }
{
  cat test/block-stream.liq
  for f in slug_of slug_of_block sidecar_path icy_song block_stream; do def "$f"; done
  echo 'block_stream("/shows/seams.md")'
  echo 'block_stream("/shows/long.md")'
} >"$work/run.liq"
grep -q '^def block_stream(' "$work/run.liq" || {
  echo "block-stream: no block_stream in radio.liq" >&2
  exit 1
}
liq run.liq

node test/block-stream.ts "$work"
