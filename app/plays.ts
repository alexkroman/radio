// The play log: Liquidsoap appends one JSON line per play to
// /plays/YYYY-MM.jsonl (radio.liq), in local time (TZ).
import { open } from "node:fs/promises";

const PLAYS = process.env.PLAYS_DIR ?? "/plays";

export type Play = {
  time: number; // Unix seconds
  show: string;
  artist: string;
  title: string;
  album: string;
  label: string;
  isrc: string;
  cover?: string; // "<show>/<stem>.jpg" relative path, set when pre-extracted art exists
  listeners: number;
};

export const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const file = (month: string) => `${PLAYS}/${month}.jsonl`;

const parse = (text: string): Play[] =>
  text.split("\n").flatMap((line) => {
    try {
      return line ? [JSON.parse(line) as Play] : [];
    } catch {
      return [];
    }
  });

// Reads a month's log from byte `from` in 1 MB chunks (yielding to the event
// loop between them), calling `each` for every complete line. Returns where the
// next read starts (a line still being written is left for then), or -1 if the
// file is now shorter than `from` (replaced).
const CHUNK = 1 << 20;
async function scan(month: string, from: number, each: (p: Play) => void): Promise<number> {
  const fh = await open(file(month)).catch(() => undefined);
  if (!fh) return from;
  try {
    const { size } = await fh.stat();
    if (size < from) return -1;
    const buf = Buffer.alloc(Math.min(CHUNK, size - from));
    let pos = from;
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (!bytesRead) break;
      const end = buf.lastIndexOf(10, bytesRead - 1);
      if (end < 0) {
        if (bytesRead < CHUNK) break; // the last line, still being written
        pos += bytesRead; // a 1 MB line isn't a play: skip it
        continue;
      }
      for (const p of parse(buf.toString("utf8", 0, end))) each(p);
      pos += end + 1;
    }
    return pos;
  } finally {
    await fh.close();
  }
}

// Every play in a month ("YYYY-MM"), one at a time (a month of every show's
// plays is too big to hold as one string).
export async function eachPlay(month: string, each: (p: Play) => void): Promise<void> {
  await scan(month, 0, each);
}

// Each show's newest plays, oldest first, kept in memory: the log is read once
// (last month's and this month's), then only the bytes appended since the last
// request. Every open page polls, so a request costs a stat, not a re-read.
const KEEP = 20;
const byShow = new Map<string, Play[]>();
let read: { month: string; offset: number } | undefined;
let pending: Promise<void> | undefined;

function add(p: Play) {
  let plays = byShow.get(p.show);
  if (!plays) byShow.set(p.show, (plays = []));
  plays.push(p);
  if (plays.length > KEEP) plays.shift();
}

async function catchUp(): Promise<void> {
  const now = new Date();
  const month = monthOf(now);
  if (!read) {
    await scan(monthOf(new Date(now.getFullYear(), now.getMonth() - 1, 1)), 0, add);
    read = { month, offset: 0 };
  } else if (read.month !== month) {
    // A new month: finish last month's log, then start on this one.
    await scan(read.month, read.offset, add);
    read = { month, offset: 0 };
  }
  const offset = await scan(read.month, read.offset, add);
  if (offset >= 0) {
    read.offset = offset;
    return;
  }
  // The log was replaced: start over.
  byShow.clear();
  read = undefined;
  await catchUp();
}

// Concurrent requests share one catch-up.
const fresh = () => (pending ??= catchUp().finally(() => (pending = undefined)));

// A show's newest plays (up to 20), newest first.
export async function recentPlays(show: string, limit: number): Promise<Play[]> {
  await fresh();
  return (byShow.get(show) ?? []).slice(-limit).reverse();
}

// Each show's newest play, by show slug.
export async function latestPlays(): Promise<Map<string, Play>> {
  await fresh();
  return new Map([...byShow].map(([show, plays]) => [show, plays.at(-1)!]));
}
