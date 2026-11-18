// The play log: Liquidsoap appends one JSON line per play to
// /plays/YYYY-MM.jsonl (radio.liq), in local time (TZ); each show's own
// channel (/stream/<show>) logs to /plays/YYYY-MM.<show>.jsonl.
import { open, readdir, readFile } from "node:fs/promises";

const PLAYS = process.env.PLAYS_DIR ?? "/plays";

// A track's tags, as logged with each play and in archive sidecars.
export type Track = Pick<Play, "title" | "artist" | "album" | "label" | "isrc" | "cover">;

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

// JSON Lines (the play log, the archive's sidecars), skipping a line that is
// still being written.
export const parseJsonl = <T>(text: string): T[] =>
  text.split("\n").flatMap((line) => {
    try {
      return line ? [JSON.parse(line) as T] : [];
    } catch {
      return [];
    }
  });
const parse = parseJsonl<Play>;

// Every play in a month ("YYYY-MM").
export async function monthPlays(month: string): Promise<Play[]> {
  return parse(await readFile(file(month), "utf8").catch(() => ""));
}

// Every play in a month on the shows' own channels.
export async function channelPlays(month: string): Promise<Play[]> {
  const files = (await readdir(PLAYS).catch(() => [] as string[])).filter(
    (f) => f.startsWith(`${month}.`) && f.endsWith(".jsonl") && f !== `${month}.jsonl`,
  );
  const texts = await Promise.all(files.map((f) => readFile(`${PLAYS}/${f}`, "utf8").catch(() => "")));
  return texts.flatMap(parse);
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

// The newest plays, newest first: a show's, or the station's.
export async function recentPlays(limit: number, show?: string): Promise<Play[]> {
  return (await recent())
    .filter((p) => !show || p.show === show)
    .slice(-limit)
    .reverse();
}

// The play on air now (the newest; its show is the show on air).
export async function latestPlay(): Promise<Play | undefined> {
  return (await recent()).at(-1);
}
