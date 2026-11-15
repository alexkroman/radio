// The play log: Liquidsoap appends one JSON line per play to
// /plays/YYYY-MM.jsonl (radio.liq), in local time (TZ).
import { open, readFile } from "node:fs/promises";

const PLAYS = process.env.PLAYS_DIR ?? "/plays";

export type Play = {
  time: number; // Unix seconds
  show: string;
  artist: string;
  title: string;
  album: string;
  label: string;
  isrc: string;
  cover: string; // "<show>/<stem>.jpg" relative path, or "" when no art was pre-extracted
  listeners: number;
};

export const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const file = (month: string) => `${PLAYS}/${month}.jsonl`;

// Skips a line that is still being written.
const parse = (text: string): Play[] =>
  text.split("\n").flatMap((line) => {
    try {
      return line ? [JSON.parse(line) as Play] : [];
    } catch {
      return [];
    }
  });

// Every play in a month ("YYYY-MM").
export async function monthPlays(month: string): Promise<Play[]> {
  return parse(await readFile(file(month), "utf8").catch(() => ""));
}

// The last ~256 KB of this month's log (plenty for a show page's history),
// kept until the log grows: pages and the 15 s now.json poll all read it.
const TAIL = 262_144;
let cached: { month: string; size: number; plays: Play[] } | undefined;
async function recent(): Promise<Play[]> {
  const month = monthOf(new Date());
  const fh = await open(file(month)).catch(() => undefined);
  if (!fh) return [];
  try {
    const { size } = await fh.stat();
    if (cached?.month !== month || cached.size !== size) {
      const length = Math.min(size, TAIL);
      const { buffer } = await fh.read(Buffer.alloc(length), 0, length, size - length);
      const text = buffer.toString("utf8");
      cached = { month, size, plays: parse(size > TAIL ? text.slice(text.indexOf("\n") + 1) : text) };
    }
    return cached.plays;
  } finally {
    await fh.close();
  }
}

// A show's newest plays, newest first.
export async function recentPlays(show: string, limit: number): Promise<Play[]> {
  return (await recent())
    .filter((p) => p.show === show)
    .slice(-limit)
    .reverse();
}

// Each show's newest play, by show slug.
export async function latestPlays(): Promise<Map<string, Play>> {
  return new Map((await recent()).map((p) => [p.show, p]));
}
