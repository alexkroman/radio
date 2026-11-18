// The play log: Liquidsoap appends one JSON line per play to
// /plays/YYYY-MM.jsonl (radio.liq), in local time (TZ); each show's own
// channel (/stream/<show>) logs to /plays/YYYY-MM.<show>.jsonl.
import { open, readdir, readFile, stat } from "node:fs/promises";

const PLAYS = process.env.PLAYS_DIR ?? "/plays";

// A track's tags, as logged with each play.
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

// JSON Lines (the play log), skipping a line that is
// still being written.
const parseJsonl = <T>(text: string): T[] =>
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

// The last ~256 KB of a log (plenty for a show page's history), kept until
// the log grows: pages and the 15 s now.json poll all read it. `channel`: a
// show's own channel's log, else the station's.
const TAIL = 262_144;
const cached = new Map<string, { size: number; plays: Play[] }>();
async function recent(channel?: string): Promise<Play[]> {
  const name = channel ? `${monthOf(new Date())}.${channel}` : monthOf(new Date());
  const fh = await open(file(name)).catch(() => undefined);
  if (!fh) return [];
  try {
    const { size } = await fh.stat();
    let hit = cached.get(name);
    if (hit?.size !== size) {
      const length = Math.min(size, TAIL);
      const { buffer } = await fh.read(Buffer.alloc(length), 0, length, size - length);
      const text = buffer.toString("utf8");
      hit = { size, plays: parse(size > TAIL ? text.slice(text.indexOf("\n") + 1) : text) };
      // Only this month's: a new month's log starts a new key.
      for (const k of cached.keys()) if (!k.startsWith(monthOf(new Date()))) cached.delete(k);
      cached.set(name, hit);
    }
    return hit.plays;
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

// The play on air now (the newest; its show is the show on air), or on a
// show's own channel.
export async function latestPlay(channel?: string): Promise<Play | undefined> {
  return (await recent(channel)).at(-1);
}

// A stretch of one show's plays in a row on the station: from its first
// track's start to the next show's first (or its own last track's start, if
// nothing has played since).
export type Airing = { show: string; start: number; end: number; tracks: number };

// Whole months of the station's log, read again only when one grows.
const months = new Map<string, { size: number; plays: Play[] }>();
async function wholeMonth(month: string): Promise<Play[]> {
  const size = (await stat(file(month)).catch(() => undefined))?.size ?? 0;
  const hit = months.get(month);
  if (hit?.size === size) return hit.plays;
  const plays = size ? await monthPlays(month) : [];
  months.set(month, { size, plays });
  return plays;
}

// A show's airings on the station that ended in the last `days` days (the
// one on air now isn't over), newest first.
export async function pastAirings(show: string, days = 14, now = Date.now()): Promise<Airing[]> {
  const since = now / 1000 - days * 86_400;
  const d = new Date(now);
  const names = [monthOf(new Date(d.getFullYear(), d.getMonth() - 1, 1)), monthOf(d)];
  for (const k of months.keys()) if (!names.includes(k)) months.delete(k);
  const plays = (await Promise.all(names.map(wholeMonth))).flat().sort((a, b) => a.time - b.time);
  const airings: Airing[] = [];
  let current: Airing | undefined;
  for (const p of plays) {
    if (current?.show === p.show) {
      current.tracks++;
      current.end = p.time;
      continue;
    }
    if (current) current.end = p.time;
    current = { show: p.show, start: p.time, end: p.time, tracks: 1 };
    airings.push(current);
  }
  airings.pop(); // on air now
  return airings.filter((a) => a.show === show && a.end > since).reverse();
}
