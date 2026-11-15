// The archive: finished show blocks that radio.liq recorded, one 256 kbps
// MP3 each (/archive/blocks/<show>-<YYYY-MM-DD>.mp3), served by Icecast
// through Caddy at /archive/<file>, with a sidecar of the tracks in each
// (/archive/tracks/<show>-<YYYY-MM-DD>.jsonl: each track's offset in seconds
// and its tags). Listed as the statutory license allows archived programs
// and scripts/prune-archive.sh keeps them: at least ARCHIVE_MIN_SECONDS long
// (5 hours), up less than two weeks, the newest ARCHIVE_KEEP of each show.
// Track names are never listed: a block is its show, date and length, and a
// track is shown only while it plays (trackAt).
import { readdir, readFile, stat } from "node:fs/promises";
import { getShows, SLUG } from "./shows.ts";

const ARCHIVE = process.env.ARCHIVE_DIR ?? "/archive";
const KEEP = Math.max(1, Number.parseInt(process.env.ARCHIVE_KEEP ?? "", 10) || 1);
const MIN_SECONDS = Number(process.env.ARCHIVE_MIN_SECONDS ?? "") || 5 * 3600;
// As scripts/prune-archive.sh: 14 days less an hour since the block finished.
const MAX_AGE_MS = (14 * 24 - 1) * 3600 * 1000;
// radio.liq: %mp3(bitrate = 256), constant bitrate, so the size gives the length.
const BYTES_PER_SECOND = 256_000 / 8;
export const BLOCK = `${SLUG}-\\d{4}-\\d{2}-\\d{2}`;
const BLOCK_FILE = new RegExp(`^(${SLUG})-(\\d{4}-\\d{2}-\\d{2})\\.mp3$`);

export type Block = {
  name: string; // <show>-<YYYY-MM-DD>
  show: string; // slug
  date: string; // YYYY-MM-DD, the day it started
  seconds: number;
  url: string; // /archive/<name>.mp3
};

// A track in a block's sidecar.
export type BlockTrack = {
  offset: number; // seconds into the block
  title: string;
  artist: string;
  album: string;
  label: string;
  isrc: string;
  cover: string; // "<show>/<stem>.jpg" or ""
};

// Each show's blocks that can be played, newest first, by show slug (shows
// that exist only).
export async function archive(now = Date.now()): Promise<Map<string, Block[]>> {
  const dir = `${ARCHIVE}/blocks`;
  const [files, shows] = await Promise.all([readdir(dir).catch(() => [] as string[]), getShows()]);
  const slugs = new Set(shows.map((s) => s.slug));
  const blocks = (
    await Promise.all(
      files.map(async (file) => {
        const m = BLOCK_FILE.exec(file);
        const st = m && (await stat(`${dir}/${file}`).catch(() => undefined));
        if (!m || !slugs.has(m[1]!) || !st?.isFile() || now - st.mtimeMs > MAX_AGE_MS) return [];
        const seconds = Math.round(st.size / BYTES_PER_SECOND);
        if (seconds < MIN_SECONDS) return [];
        const name = file.slice(0, -4);
        return [{ name, show: m[1]!, date: m[2]!, seconds, url: `/archive/${file}` }];
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

// A block's tracks, in order (empty if it has no sidecar). Kept after the
// block itself, for the reports.
export async function blockTracks(name: string): Promise<BlockTrack[]> {
  const text = await readFile(`${ARCHIVE}/tracks/${name}.jsonl`, "utf8").catch(() => "");
  return text
    .split("\n")
    .flatMap((line) => {
      try {
        return line ? [JSON.parse(line) as BlockTrack] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.offset - b.offset);
}

// The track playing `seconds` into a block: the last to start by then.
export async function trackAt(name: string, seconds: number): Promise<BlockTrack | undefined> {
  return (await blockTracks(name)).filter((t) => t.offset <= seconds).at(-1);
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
