// Admin site (behind Caddy basic auth at /admin): SoundExchange Report of Use
// from Icecast's playlist.log, with album/label/ISRC read from music/ tags.
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import { validator } from "hono/validator";
import { parseFile } from "music-metadata";

const LOG = process.env.PLAYLIST_LOG ?? "/logs/playlist.log";
const MUSIC = process.env.MUSIC_DIR ?? "/music";
const SERVICE = "MAZES RADIO";
const SHORT = "MAZESRADIO";
const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";
const HEADER = [
  "NAME_OF_SERVICE",
  "TRANSMISSION_CATEGORY",
  "FEATURED_ARTIST",
  "SOUND_RECORDING_TITLE",
  "ISRC",
  "ALBUM_TITLE",
  "MARKETING_LABEL",
  "ACTUAL_TOTAL_PERFORMANCES",
];
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

const unescape = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e: string) => ENTITIES[e]!);
const field = (v: string | number) =>
  typeof v === "number"
    ? String(v)
    : `^${v.toUpperCase().replace(/[|^]/g, "")}^`;
const pad = (n: number) => String(n).padStart(2, "0");

// Performances per "Artist - Title" in a month, across all shows: each play
// counts its listeners (at least 1).
async function getPlays(
  year: number,
  month: number,
): Promise<[string, number][]> {
  const log = await readFile(LOG, "utf8").catch(() => "");
  const counts = new Map<string, number>();
  for (const line of log.split("\n")) {
    const [date, , listeners, title] = line.split("|");
    const d = /^\d+\/(\w+)\/(\d+):/.exec(date ?? "");
    if (
      !title ||
      !d ||
      Number(d[2]) !== year ||
      MONTHS.indexOf(d[1]!) / 3 + 1 !== month
    )
      continue;
    const key = unescape(title.trim());
    counts.set(
      key,
      (counts.get(key) ?? 0) + Math.max(parseInt(listeners ?? "") || 0, 1),
    );
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// Tags from the file named "Artist- Title.*" anywhere under music/.
async function getTags(
  files: Map<string, string>,
  artist: string,
  title: string,
) {
  const path = files.get(`${artist}- ${title}`.toLowerCase());
  if (!path) return {};
  const { common } = await parseFile(path, { skipCovers: true }).catch(() => ({
    common: undefined,
  }));
  return {
    album: common?.album,
    label: common?.label?.[0],
    isrc: common?.isrc?.[0],
  };
}

async function musicbrainzIsrc(artist: string, title: string): Promise<string> {
  const q = new URLSearchParams({
    query: `artist:"${artist}" AND recording:"${title}"`,
    fmt: "json",
    limit: "5",
  });
  await new Promise((r) => setTimeout(r, 1000)); // MusicBrainz: 1 request/second
  try {
    const res = await fetch(`https://musicbrainz.org/ws/2/recording/?${q}`, {
      headers: { "User-Agent": "radio-report/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as { recordings?: { isrcs?: string[] }[] };
    return data.recordings?.find((r) => r.isrcs?.length)?.isrcs?.[0] ?? "";
  } catch {
    return "";
  }
}

async function report(
  year: number,
  month: number,
  lookupIsrc: boolean,
): Promise<string> {
  const names = await readdir(MUSIC, { recursive: true }).catch(
    () => [] as string[],
  );
  const files = new Map(
    names.map((f) => [basename(f, extname(f)).toLowerCase(), join(MUSIC, f)]),
  );
  const rows: (string | number)[][] = [HEADER];
  for (const [song, count] of await getPlays(year, month)) {
    const dash = song.indexOf(" - ");
    const [artist, title] =
      dash < 0 ? ["", song] : [song.slice(0, dash), song.slice(dash + 3)];
    const tags = await getTags(files, artist, title);
    const isrc =
      tags.isrc || (lookupIsrc ? await musicbrainzIsrc(artist, title) : "");
    rows.push([
      SERVICE,
      "A",
      artist,
      title,
      isrc,
      tags.album ?? "",
      tags.label ?? "",
      count,
    ]);
  }
  return rows.map((r) => r.map(field).join("|")).join("\n") + "\n";
}

const app = new Hono({ strict: false }).basePath("/admin");

app.use(
  jsxRenderer(({ children }) => (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Radio admin</title>
        <link rel="stylesheet" href="/assets/app.css" />
      </head>
      <body>
        <main class="container">{children}</main>
      </body>
    </html>
  )),
);

app.get("/", (c) => {
  const now = new Date();
  const months = Array.from(
    { length: 12 },
    (_, i) => new Date(now.getFullYear(), now.getMonth() - i, 1),
  );
  return c.render(
    <>
      <h1>Radio admin</h1>
      <h2>SoundExchange reports</h2>
      <table class="striped">
        {months.map((d) => {
          const m = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
          return (
            <tr>
              <td>{m}</td>
              <td>
                <a href={`/admin/report?month=${m}`}>Download</a>
              </td>
              <td>
                <a href={`/admin/report?month=${m}&isrc=1`}>
                  With MusicBrainz ISRCs (slow)
                </a>
              </td>
            </tr>
          );
        })}
      </table>
    </>,
  );
});

app.get(
  "/report",
  validator("query", (q, c) => {
    const m = /^(\d{4})-(\d{2})$/.exec(
      typeof q.month === "string" ? q.month : "",
    );
    if (!m) return c.text("month must be YYYY-MM", 400);
    return {
      year: Number(m[1]),
      month: Number(m[2]),
      isrc: q.isrc !== undefined,
    };
  }),
  async (c) => {
    const { year, month, isrc } = c.req.valid("query");
    const last = new Date(year, month, 0).getDate();
    c.header(
      "Content-Disposition",
      `attachment; filename="${SHORT}01${pad(month)}${year}-${last}${pad(month)}${year}_A.txt"`,
    );
    return c.text(await report(year, month, isrc));
  },
);

app.notFound((c) => c.text("Not found", 404));

serve({ fetch: app.fetch, port: 3000 });
