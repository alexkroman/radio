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

// The last ~256 KB of a month's log: plenty for a show page's history. Kept
// until the log grows (pages and their 15 s polls all read it).
const TAIL = 262_144;
const tails = new Map<string, { size: number; plays: Play[] }>();
async function tail(month: string): Promise<Play[]> {
  const fh = await open(file(month)).catch(() => undefined);
  if (!fh) return [];
  try {
    const { size } = await fh.stat();
    let hit = tails.get(month);
    if (hit?.size !== size) {
      const length = Math.min(size, TAIL);
      const { buffer } = await fh.read(Buffer.alloc(length), 0, length, size - length);
      const text = buffer.toString("utf8");
      hit = { size, plays: parse(size > TAIL ? text.slice(text.indexOf("\n") + 1) : text) };
      // Newest last; only this month and the one before are ever asked for.
      tails.delete(month);
      tails.set(month, hit);
      if (tails.size > 2) tails.delete(tails.keys().next().value!);
    }
    return hit.plays;
  } finally {
    await fh.close();
  }
}

// The newest plays, oldest first: this month's log, and last month's too when
// that isn't `enough` (early in a month, or a show quiet for a while).
async function recent(enough: (plays: Play[]) => boolean): Promise<Play[]> {
  const now = new Date();
  const current = await tail(monthOf(now));
  if (enough(current)) return current;
  return [...(await tail(monthOf(new Date(now.getFullYear(), now.getMonth() - 1, 1)))), ...current];
}

// A show's newest plays, newest first.
export async function recentPlays(show: string, limit: number): Promise<Play[]> {
  const mine = (plays: Play[]) => plays.filter((p) => p.show === show);
  return mine(await recent((plays) => mine(plays).length >= limit))
    .slice(-limit)
    .reverse();
}

// These shows' newest plays, by show slug.
export async function latestPlays(shows: string[]): Promise<Map<string, Play>> {
  const plays = await recent((plays) => {
    const seen = new Set(plays.map((p) => p.show));
    return shows.every((s) => seen.has(s));
  });
  return new Map(plays.map((p) => [p.show, p]));
}
