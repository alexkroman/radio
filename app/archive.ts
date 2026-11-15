// The archive: finished show blocks that radio.liq recorded, one MP3 each
// (/archive/blocks/<show>-<YYYY-MM-DD>.mp3), served by Icecast through Caddy
// at /archive/<file>. Listed as scripts/prune-archive.sh keeps them: the
// newest ARCHIVE_KEEP of each show, none finished over 14 days ago. Track
// names are never listed: a block is its show, date and length.
import { readdir, stat } from "node:fs/promises";
import { SLUG } from "./shows.ts";

const BLOCKS = `${process.env.ARCHIVE_DIR ?? "/archive"}/blocks`;
const KEEP = Math.max(1, Number.parseInt(process.env.ARCHIVE_KEEP ?? "", 10) || 1);
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;
// radio.liq: %mp3(bitrate = 128), constant bitrate, so the size gives the length.
const BYTES_PER_SECOND = 128_000 / 8;
const BLOCK_FILE = new RegExp(`^(${SLUG})-(\\d{4}-\\d{2}-\\d{2})\\.mp3$`);

export type Block = {
  show: string; // slug
  date: string; // YYYY-MM-DD, the day it started
  seconds: number;
  url: string; // /archive/<file>
};

// Each show's blocks, newest first, by show slug.
export async function archive(now = Date.now()): Promise<Map<string, Block[]>> {
  const files = await readdir(BLOCKS).catch(() => [] as string[]);
  const blocks = (
    await Promise.all(
      files.map(async (file) => {
        const m = BLOCK_FILE.exec(file);
        const st = m && (await stat(`${BLOCKS}/${file}`).catch(() => undefined));
        if (!m || !st?.isFile() || now - st.mtimeMs > MAX_AGE_MS) return [];
        const block: Block = {
          show: m[1]!,
          date: m[2]!,
          seconds: Math.round(st.size / BYTES_PER_SECOND),
          url: `/archive/${file}`,
        };
        return [block];
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
