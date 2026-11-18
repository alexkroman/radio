// The play log: Liquidsoap appends one JSON line per play to
// /plays/YYYY-MM.jsonl (radio.liq play_log), in local time (TZ); each show's
// own stream (/stream/<show>) logs to /plays/YYYY-MM.<show>.jsonl. A play has
// the stream's listeners as it started; when the next starts, an end line
// ({time, listeners_at_end}) gives them as it ended. Its performances are the
// more of the two.
import { open, readdir, readFile } from "node:fs/promises";

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
  listeners: number; // the more of its two counts, once its end line is read
};
type EndLine = { time: number; listeners_at_end: number };

export const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const file = (month: string) => `${PLAYS}/${month}.jsonl`;

// JSON Lines (the play log), skipping a line that is still being written.
const parseJsonl = <T>(text: string): T[] =>
  text.split("\n").flatMap((line) => {
    try {
      return line ? [JSON.parse(line) as T] : [];
    } catch {
      return [];
    }
  });
// A log's plays, each with its end line folded in (appended to `plays`, a
// log's plays read so far).
export function parsePlays(text: string, plays: Play[] = []): Play[] {
  for (const line of parseJsonl<Play | EndLine>(text)) {
    if (!("listeners_at_end" in line)) plays.push(line);
    else {
      const play = plays.findLast((p) => p.time === line.time);
      if (play) play.listeners = Math.max(play.listeners, line.listeners_at_end);
    }
  }
  return plays;
}

// Every play in a month ("YYYY-MM"): on the station and the shows' own
// streams (every YYYY-MM*.jsonl).
export async function monthPlays(month: string): Promise<Play[]> {
  const logs = (await readdir(PLAYS).catch(() => [] as string[])).filter(
    (f) => f.startsWith(month) && f.endsWith(".jsonl"),
  );
  const texts = await Promise.all(logs.map((f) => readFile(`${PLAYS}/${f}`, "utf8").catch(() => "")));
  return texts.flatMap((text) => parsePlays(text));
}

// The logs pages read (this month's and last, the station's and the
// channels'), as far as they've been read: a log that grows is read only from
// there, up to its last whole line, its plays appended. `size`, how far it's
// been read, says whether it has changed.
type Log = { size: number; plays: Play[] };
const NO_LOG: Log = { size: 0, plays: [] };
const logs = new Map<string, Log>();
async function readLog(name: string): Promise<Log> {
  const fh = await open(file(name)).catch(() => undefined);
  if (!fh) return NO_LOG;
  try {
    const { size } = await fh.stat();
    let hit = logs.get(name);
    if (!hit || size < hit.size) hit = { size: 0, plays: [] };
    if (size > hit.size) {
      const { buffer } = await fh.read(Buffer.alloc(size - hit.size), 0, size - hit.size, hit.size);
      const whole = buffer.lastIndexOf(0x0a) + 1;
      parsePlays(buffer.toString("utf8", 0, whole), hit.plays);
      hit.size += whole;
    }
    logs.set(name, hit);
    // Older months' logs aren't read again.
    const months = recentMonths();
    for (const k of logs.keys()) if (!months.includes(k.slice(0, 7))) logs.delete(k);
    return hit;
  } finally {
    await fh.close();
  }
}

// Last month and this one ("YYYY-MM").
const recentMonths = (now = new Date()) => [
  monthOf(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
  monthOf(now),
];

// This month's plays, on the station or a show's own channel.
const recent = async (channel?: string) =>
  (await readLog(channel ? `${monthOf(new Date())}.${channel}` : monthOf(new Date()))).plays;

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

// Every show's airings over last month and this, oldest first (the one on air
// now left out: it isn't over), by show; worked out again only when the logs grow.
let airings: { sizes: string; byShow: Map<string, Airing[]> } | undefined;
async function airingsByShow(): Promise<Map<string, Airing[]>> {
  const names = recentMonths();
  const months = await Promise.all(names.map(readLog));
  const sizes = months.map((m, i) => `${names[i]}:${m.size}`).join();
  if (airings?.sizes === sizes) return airings.byShow;
  const byShow = new Map<string, Airing[]>();
  let current: Airing | undefined;
  // The log is written in order, so the months are too.
  for (const p of months.flatMap((m) => m.plays)) {
    if (current?.show === p.show) {
      current.tracks++;
      current.end = p.time;
      continue;
    }
    if (current) {
      current.end = p.time;
      byShow.set(current.show, [...(byShow.get(current.show) ?? []), current]);
    }
    current = { show: p.show, start: p.time, end: p.time, tracks: 1 };
  }
  airings = { sizes, byShow };
  return byShow;
}

// A show's airings on the station that ended in the last `days` days (the
// one on air now isn't over), newest first.
export async function pastAirings(show: string, days = 14): Promise<Airing[]> {
  const since = Date.now() / 1000 - days * 86_400;
  return ((await airingsByShow()).get(show) ?? []).filter((a) => a.end > since).reverse();
}
