// Admin site (behind Caddy basic auth at /admin): SoundExchange Report of Use
// from Icecast's playlist.log, with album/label/ISRC read from music/ tags.
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import { validator } from "hono/validator";
import { parseFile } from "music-metadata";
import { readPlays } from "../shared/playlist.ts";

const MUSIC = process.env.MUSIC_DIR ?? "/music";
const SERVICE = "MAZES RADIO";
const SHORT = "MAZESRADIO";
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
const field = (v: string | number) =>
  typeof v === "number"
    ? String(v)
    : `^${v.toUpperCase().replace(/[|^]/g, "")}^`;
const pad = (n: number) => String(n).padStart(2, "0");

// Performances per song in a month, across all shows and rotated logs: each
// play counts its listeners (at least 1).
async function getPerformances(year: number, month: number) {
  const counts = new Map<
    string,
    { artist: string; title: string; count: number }
  >();
  for (const p of await readPlays()) {
    if (p.year !== year || p.month !== month) continue;
    const key = `${p.artist}\n${p.title}`;
    const row = counts.get(key) ?? {
      artist: p.artist,
      title: p.title,
      count: 0,
    };
    row.count += Math.max(p.listeners, 1);
    counts.set(key, row);
  }
  return [...counts.values()].sort(
    (a, b) =>
      b.count - a.count ||
      a.artist.localeCompare(b.artist) ||
      a.title.localeCompare(b.title),
  );
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
  for (const { artist, title, count } of await getPerformances(year, month)) {
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
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(
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
