// Admin site (behind Caddy basic auth at /admin): SoundExchange Report of Use
// from Icecast's playlist.log. No dependencies; ffprobe reads tags from music/.
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, extname } from "node:path";
import { promisify } from "node:util";

const SERVICE = "MAZES RADIO";
const SHORT = "MAZESRADIO";
const MONTHS = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};
const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};
const unescape = (s) =>
  s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) => ENTITIES[e]);
const field = (v) =>
  typeof v === "number"
    ? String(v)
    : `^${String(v).toUpperCase().replace(/[|^]/g, "")}^`;
const pad = (n) => String(n).padStart(2, "0");

// Performances per "Artist - Title" for a month: each play counts its listeners (at least 1).
async function plays(year, month) {
  const log = await readFile("/logs/playlist.log", "utf8").catch(() => "");
  const counts = new Map();
  for (const line of log.split("\n")) {
    const [date, , listeners, title] = line.split("|");
    const d = date?.match(/^\d+\/(\w+)\/(\d+):/);
    if (!title || !d || +d[2] !== year || MONTHS[d[1]] !== month - 1) continue;
    const key = unescape(title.trim());
    counts.set(
      key,
      (counts.get(key) ?? 0) + Math.max(parseInt(listeners) || 0, 1),
    );
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// Tags from the file named "Artist- Title.*" anywhere under music/.
async function tags(files, artist, title) {
  const path = files.get(`${artist}- ${title}`.toLowerCase());
  if (!path) return {};
  try {
    const { stdout } = await promisify(execFile)(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_entries",
        "format_tags",
        path,
      ],
      { timeout: 5000 },
    );
    const t = Object.fromEntries(
      Object.entries(JSON.parse(stdout).format?.tags ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    return {
      album: t.album,
      label: t.label || t.organization || t.publisher,
      isrc: t.isrc,
    };
  } catch {
    return {};
  }
}

async function musicbrainzIsrc(artist, title) {
  const q = new URLSearchParams({
    query: `artist:"${artist}" AND recording:"${title}"`,
    fmt: "json",
    limit: 5,
  });
  await new Promise((r) => setTimeout(r, 1000)); // MusicBrainz: 1 request/second
  try {
    const res = await fetch(`https://musicbrainz.org/ws/2/recording/?${q}`, {
      headers: { "User-Agent": "radio-report/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    return (
      (await res.json()).recordings?.find((r) => r.isrcs?.length)?.isrcs[0] ??
      ""
    );
  } catch {
    return "";
  }
}

async function report(year, month, lookupIsrc) {
  const files = new Map(
    (await readdir("/music", { recursive: true }).catch(() => [])).map((f) => [
      basename(f, extname(f)).toLowerCase(),
      `/music/${f}`,
    ]),
  );
  const rows = [
    [
      "NAME_OF_SERVICE",
      "TRANSMISSION_CATEGORY",
      "FEATURED_ARTIST",
      "SOUND_RECORDING_TITLE",
      "ISRC",
      "ALBUM_TITLE",
      "MARKETING_LABEL",
      "ACTUAL_TOTAL_PERFORMANCES",
    ],
  ];
  for (const [song, count] of await plays(year, month)) {
    const [artist, title] = song.includes(" - ")
      ? [
          song.slice(0, song.indexOf(" - ")),
          song.slice(song.indexOf(" - ") + 3),
        ]
      : ["", song];
    const t = await tags(files, artist, title);
    const isrc =
      t.isrc || (lookupIsrc ? await musicbrainzIsrc(artist, title) : "");
    rows.push([
      SERVICE,
      "A",
      artist,
      title,
      isrc,
      t.album ?? "",
      t.label ?? "",
      count,
    ]);
  }
  return rows.map((r) => r.map(field).join("|")).join("\n") + "\n";
}

const page = (
  months,
) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Radio admin</title><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2.1.1/css/pico.jade.min.css">
<main class="container"><h1>Radio admin</h1><h2>SoundExchange reports</h2><table class="striped">
${months.map((m) => `<tr><td>${m}</td><td><a href="/admin/report?month=${m}">Download</a></td><td><a href="/admin/report?month=${m}&isrc=1">With MusicBrainz ISRCs (slow)</a></td></tr>`).join("\n")}
</table></main>`;

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    const now = new Date();
    const months = Array.from(
      { length: 12 },
      (_, i) => new Date(now.getFullYear(), now.getMonth() - i, 1),
    ).map((d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
    return res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(page(months));
  }
  const m =
    url.pathname === "/admin/report" &&
    url.searchParams.get("month")?.match(/^(\d{4})-(\d{2})$/);
  if (!m) return res.writeHead(404).end("Not found\n");
  const [year, month] = [+m[1], +m[2]];
  const last = new Date(year, month, 0).getDate();
  const name = `${SHORT}01${pad(month)}${year}-${last}${pad(month)}${year}_A.txt`;
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Disposition": `attachment; filename="${name}"`,
  });
  res.end(await report(year, month, url.searchParams.has("isrc")));
}).listen(3000);
