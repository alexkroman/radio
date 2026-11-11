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
  cover?: string; // "<show>/<stem>.jpg" relative path, set when pre-extracted art exists
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

// The last ~256 KB of a month's log: plenty for a show page's history.
async function tail(month: string, bytes = 262_144): Promise<Play[]> {
  const fh = await open(file(month)).catch(() => undefined);
  if (!fh) return [];
  try {
    const { size } = await fh.stat();
    const { buffer } = await fh.read(
      Buffer.alloc(Math.min(size, bytes)),
      0,
      Math.min(size, bytes),
      Math.max(0, size - bytes),
    );
    const text = buffer.toString("utf8");
    return parse(size > bytes ? text.slice(text.indexOf("\n") + 1) : text);
  } finally {
    await fh.close();
  }
}

// A show's newest plays, newest first (from this month's and last month's logs).
export async function recentPlays(show: string, limit = 21): Promise<Play[]> {
  const now = new Date();
  const months = [monthOf(new Date(now.getFullYear(), now.getMonth() - 1, 1)), monthOf(now)];
  const plays = (await Promise.all(months.map((m) => tail(m)))).flat();
  return plays
    .filter((p) => p.show === show)
    .slice(-limit)
    .reverse();
}
