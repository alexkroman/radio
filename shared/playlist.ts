// Icecast's playlist.log, shared by site/ and admin/. Lines look like
//   10/Nov/2026:16:05:34 +0000|/mount|listeners|Artist - Title
// (the title may itself contain "|", and Icecast HTML-escapes it). Icecast
// rotates the log to playlist.log.<timestamp> (logarchive in compose.yml).
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const LOG = process.env.PLAYLIST_LOG ?? "/logs/playlist.log";

export type Play = {
  time: Date;
  year: number;
  month: number;
  mount: string;
  listeners: number;
  artist: string;
  title: string;
};

const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};
const LINE =
  /^(\d\d)\/(\w{3})\/(\d{4}):(\d\d):(\d\d):(\d\d) ([+-]\d\d)(\d\d)\|([^|]*)\|(\d*)\|(.*)$/;

const unescape = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e: string) => ENTITIES[e]!);

function parse(line: string): Play | undefined {
  const m = LINE.exec(line);
  if (!m) return undefined;
  const [
    ,
    day,
    mon,
    year,
    h,
    min,
    s,
    tzh,
    tzm,
    mount = "",
    listeners,
    raw = "",
  ] = m;
  const month = MONTHS.indexOf(mon!) / 3 + 1;
  const time = new Date(
    `${year}-${String(month).padStart(2, "0")}-${day}T${h}:${min}:${s}${tzh}:${tzm}`,
  );
  const song = unescape(raw.trim());
  const dash = song.indexOf(" - ");
  const [artist, title] =
    dash < 0 ? ["", song] : [song.slice(0, dash), song.slice(dash + 3)];
  return {
    time,
    year: Number(year),
    month,
    mount,
    listeners: Number(listeners) || 0,
    artist,
    title,
  };
}

// Plays oldest first, from the current log plus the newest `archives` rotated logs.
export async function readPlays(archives = Infinity): Promise<Play[]> {
  const prefix = `${basename(LOG)}.`;
  const rotated = (await readdir(dirname(LOG)).catch(() => [] as string[]))
    .filter((f) => f.startsWith(prefix))
    .sort();
  const files = [
    ...rotated
      .slice(Math.max(0, rotated.length - archives))
      .map((f) => join(dirname(LOG), f)),
    LOG,
  ];
  const texts = await Promise.all(
    files.map((f) => readFile(f, "utf8").catch(() => "")),
  );
  return texts.flatMap((t) => t.split("\n")).flatMap((l) => parse(l) ?? []);
}
