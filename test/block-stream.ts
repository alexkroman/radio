// Checks what test/block-stream.sh rendered (in the directory it's given):
// each show's stream against its block decoded straight through, and the
// tracks it started against the block's sidecar. Exits non-zero on a fault.
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2]!;
const RATE = 44_100;
// Liquidsoap's frame (settings.frame.duration): a track starts at the first
// frame past its offset.
const FRAME = 0.02;
const faults: string[] = [];
const fault = (s: string) => faults.push(s);

// A WAV file's left channel, `count` samples from sample `from`: 16-bit
// stereo after its "data" chunk header.
function samples(file: string, from: number, count: number): Int16Array {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(4096);
    readSync(fd, head, 0, head.length, 0);
    const data = head.indexOf("data") + 8;
    const bytes = Buffer.alloc(count * 4);
    const read = readSync(fd, bytes, 0, bytes.length, data + from * 4);
    const out = new Int16Array(Math.floor(read / 4));
    for (let i = 0; i < out.length; i++) out[i] = bytes.readInt16LE(i * 4);
    return out;
  } finally {
    closeSync(fd);
  }
}

// The largest difference between the stream and the block over
// [from, from + count) samples of the block, the stream being `lag` samples
// behind it.
function diff(slug: string, lag: number, from: number, count: number): number {
  const ref = samples(join(dir, "ref", `${slug}.wav`), from, count);
  const out = samples(join(dir, "out", `${slug}.wav`), from + lag, count);
  if (out.length < ref.length) return Infinity;
  let max = 0;
  for (let i = 0; i < ref.length; i++) max = Math.max(max, Math.abs(out[i]! - ref[i]!));
  return max;
}

type Line = {
  offset: number;
  title: string;
  artist: string;
  album: string;
  label: string;
  isrc: string;
  cover: string;
};
type Started = {
  at: number;
  title: string;
  artist: string;
  album: string;
  label: string;
  isrc: string;
  cover: string;
  song: string;
};
const jsonl = <T>(file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);

for (const slug of ["seams", "long"]) {
  const sidecar = jsonl<Line>(join(dir, "tracks", `${slug}-2026-01-01.jsonl`));
  // From the block's first track (before it, the stream's fallback starts a
  // silent one), once through.
  const all = jsonl<Started>(join(dir, "out", `${slug}.jsonl`));
  const first = all.findIndex((s) => s.title === sidecar[0]!.title);
  const started = first < 0 ? [] : all.slice(first, first + sidecar.length);
  // To a second past its last track, or its end.
  const length = (statSync(join(dir, "ref", `${slug}.wav`)).size - 44) / 4 / RATE;
  const end = Math.min(sidecar.at(-1)!.offset + 1, Math.floor(length * 100) / 100);

  // Tracks: each at its offset (by the stream's clock, from the block's
  // start), within a frame, with its tags, and its ICY title.
  if (started.length < sidecar.length)
    fault(`${slug}: ${started.length} of ${sidecar.length} tracks started`);
  sidecar.forEach((t, i) => {
    const s = started[i];
    if (!s) return;
    const at = s.at - started[0]!.at;
    if (at < t.offset - 1e-6 || at > t.offset + FRAME + 1e-6)
      fault(`${slug}: ${t.title} started at ${at.toFixed(3)} s, not at ${t.offset} s`);
    const tags = {
      title: t.title,
      artist: t.artist,
      album: t.album,
      label: t.label,
      isrc: t.isrc,
      cover: t.cover,
    };
    const got = {
      title: s.title,
      artist: s.artist,
      album: s.album,
      label: s.label,
      isrc: s.isrc,
      cover: s.cover,
    };
    if (JSON.stringify(got) !== JSON.stringify(tags))
      fault(`${slug}: track ${i} tagged ${JSON.stringify(got)}, not ${JSON.stringify(tags)}`);
    const song = `${t.artist} - ${t.title} (${t.album})`;
    if (s.song !== song)
      fault(`${slug}: track ${i}'s ICY title ${JSON.stringify(s.song)}, not ${JSON.stringify(song)}`);
  });
  if (!started[0]) continue;

  // Audio: the stream is the block, sample for sample (1 LSB for rounding),
  // from its start. Find where in the stream the block starts (around its
  // first track; the stream is silence before), then compare.
  const near = Math.round(started[0].at * RATE);
  let lag = NaN;
  for (
    let l = Math.max(0, near - 2 * Math.round(FRAME * RATE));
    l <= near + 2 * Math.round(FRAME * RATE);
    l++
  )
    if (diff(slug, l, RATE / 2, 2000) <= 1) {
      lag = l;
      break;
    }
  if (Number.isNaN(lag)) {
    fault(`${slug}: the stream isn't the block's audio near its start`);
    continue;
  }
  // Everything for a short block; for a long one, a second either side of
  // each track change (and of its start and end).
  const windows =
    end < 60
      ? [[0, end]]
      : [...sidecar.map((t) => t.offset), end].map((t) => [Math.max(0, t - 1), Math.min(end, t + 1)]);
  for (const [a, b] of windows) {
    const d = diff(slug, lag, Math.round(a! * RATE), Math.round((b! - a!) * RATE));
    if (d > 1) fault(`${slug}: the stream differs from the block by ${d} between ${a} s and ${b} s`);
  }
  // The next block (the same one again: a show's only block) follows with
  // no gap: its first track where this one ends, its audio from its start.
  const next = all[first + sidecar.length];
  if (slug === "seams") {
    const gap = next ? next.at - started[0].at - length : NaN;
    if (!next || next.title !== sidecar[0]!.title || Math.abs(gap) > FRAME + 1e-6)
      fault(
        `${slug}: the next block's first track ${next ? `started ${gap.toFixed(3)} s after the block's end` : "never started"}`,
      );
    else {
      const d = diff(slug, lag + Math.round(length * RATE), 0, RATE);
      if (d > 1) fault(`${slug}: the next block's start differs from the block's by ${d}`);
    }
  }
  console.log(
    `block-stream: ${slug}: ${started.length} tracks, the block's audio from ${(lag / RATE).toFixed(2)} s in the stream`,
  );
}

if (faults.length) {
  for (const f of faults) console.error(`block-stream: ${f}`);
  process.exit(1);
}
console.log("block-stream: ok");
