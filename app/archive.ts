// The archive: finished show blocks that radio.liq recorded, one 256 kbps
// MP3 each (/archive/blocks/<show>-<YYYY-MM-DD>.mp3), served by Icecast
// through Caddy at /archive/<file>, with a sidecar of the tracks in each
// (/archive/tracks/<show>-<YYYY-MM-DD>.jsonl: each track's offset in seconds
// and its tags). radio.liq moves only blocks long enough to be archived
// programs (5 hours) into blocks/; scripts/prune-archive.sh removes them
// before they've been up two weeks and keeps the newest ARCHIVE_KEEP of each
// show, hourly. Listed the same way between its runs. Blocks are numbered
// per show (Frequency #12: the days since the show's first block, sidecars
// included, so a number stays put as old blocks go). Track names are never
// listed: a track is shown only while it plays (trackAt).
import { readdir, readFile, stat } from "node:fs/promises";
import { parseJsonl, type Track } from "./plays.ts";
import { type Show, SLUG } from "./shows.ts";

const ARCHIVE = process.env.ARCHIVE_DIR ?? "/archive";
const KEEP = Math.max(1, Number.parseInt(process.env.ARCHIVE_KEEP ?? "", 10) || 1);
// As scripts/prune-archive.sh: 14 days less an hour since the block finished.
const MAX_AGE_MS = (14 * 24 - 1) * 3600 * 1000;
// radio.liq: %mp3(bitrate = 256), constant bitrate, so the size gives the length.
const BYTES_PER_SECOND = 256_000 / 8;
export const BLOCK = `${SLUG}-\\d{4}-\\d{2}-\\d{2}`;
const NAME = new RegExp(`^(${SLUG})-(\\d{4}-\\d{2}-\\d{2})\\.(mp3|jsonl)$`);
const DAY_MS = 24 * 3600 * 1000;

export type Block = {
  name: string; // <show>-<YYYY-MM-DD>
  show: string; // slug
  date: string; // YYYY-MM-DD, the day it started
  number: number; // the show's nth day with a block
  seconds: number;
  finished: number; // ms, when the file was last written
  url: string; // /archive/<name>.mp3
};

// A track in a block's sidecar.
export type BlockTrack = Track & { offset: number }; // seconds into the block

// Each show's blocks that can be played, newest first, by show slug.
export async function archive(shows: Show[], now = Date.now()): Promise<Map<string, Block[]>> {
  const [files, sidecars] = await Promise.all(
    ["blocks", "tracks"].map((d) => readdir(`${ARCHIVE}/${d}`).catch(() => [] as string[])),
  );
  const slugs = new Set(shows.map((s) => s.slug));
  // Each show's first day, from its blocks and sidecars.
  const first = new Map<string, string>();
  for (const f of [...files!, ...sidecars!]) {
    const m = NAME.exec(f);
    if (m && !(first.get(m[1]!)! <= m[2]!)) first.set(m[1]!, m[2]!);
  }
  const blocks = (
    await Promise.all(
      files!.map(async (file): Promise<Block[]> => {
        const m = NAME.exec(file);
        if (!m || m[3] !== "mp3" || !slugs.has(m[1]!)) return [];
        const st = await stat(`${ARCHIVE}/blocks/${file}`).catch(() => undefined);
        if (!st?.isFile() || now - st.mtimeMs > MAX_AGE_MS) return [];
        const [show, date] = [m[1]!, m[2]!];
        const number = Math.round((Date.parse(date) - Date.parse(first.get(show)!)) / DAY_MS) + 1;
        const seconds = Math.round(st.size / BYTES_PER_SECOND);
        const name = file.slice(0, -4);
        return [{ name, show, date, number, seconds, finished: st.mtimeMs, url: `/archive/${file}` }];
      }),
    )
  ).flat();
  const byShow = new Map<string, Block[]>();
  for (const b of blocks.sort((a, b) => b.date.localeCompare(a.date))) {
    const list = byShow.get(b.show) ?? [];
    if (list.length < KEEP) byShow.set(b.show, [...list, b]);
  }
  return byShow;
}

// Whether a show's block is in the archive (finished, long enough).
export const inArchive = (name: string) =>
  stat(`${ARCHIVE}/blocks/${name}.mp3`).then(
    (st) => st.isFile(),
    () => false,
  );

// A block's tracks, in order (empty if it has no sidecar), read again only
// when the sidecar changes. Kept after the block itself, for the reports.
const sidecars = new Map<string, { size: number; tracks: BlockTrack[] }>();
export async function blockTracks(name: string): Promise<BlockTrack[]> {
  const file = `${ARCHIVE}/tracks/${name}.jsonl`;
  const size = (await stat(file).catch(() => undefined))?.size ?? 0;
  const hit = sidecars.get(name);
  if (hit?.size === size) return hit.tracks;
  const text = size ? await readFile(file, "utf8").catch(() => "") : "";
  const tracks = parseJsonl<BlockTrack>(text).sort((a, b) => a.offset - b.offset);
  sidecars.set(name, { size, tracks });
  return tracks;
}

// The track playing `seconds` into a block (the last to start by then), and
// when the next one starts (when to ask again; no more about it).
export async function trackAt(name: string, seconds: number) {
  const tracks = await blockTracks(name);
  const i = tracks.findLastIndex((t) => t.offset <= seconds);
  return { track: tracks[i], until: tracks[i + 1]?.offset };
}

// "5 h 2 min", "40 min", "20 s".
export function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h) return `${h} h ${m} min`;
  return m ? `${m} min` : `${seconds} s`;
}

// "Sat, Nov 14" for "2026-11-14" (a calendar date: no time zone).
export const day = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
