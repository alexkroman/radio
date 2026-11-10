// Admin pages, mounted at /admin behind basic auth (user "admin",
// ADMIN_PASSWORD): SoundExchange Report of Use from the play log.
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { validator } from "hono/validator";
import { monthOf, monthPlays } from "./plays.ts";

const PASSWORD = process.env.ADMIN_PASSWORD;
if (!PASSWORD) throw new Error("ADMIN_PASSWORD is not set");

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
  typeof v === "number" ? String(v) : `^${v.toUpperCase().replace(/[|^]/g, "")}^`;

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

// One row per song across all shows; each play counts its listeners (at least 1).
async function report(month: string, lookupIsrc: boolean): Promise<string> {
  const songs = new Map<
    string,
    { artist: string; title: string; isrc: string; album: string; label: string; count: number }
  >();
  for (const p of await monthPlays(month)) {
    const key = `${p.artist}\n${p.title}`;
    const song = songs.get(key) ?? { ...p, count: 0 };
    song.count += Math.max(p.listeners, 1);
    songs.set(key, song);
  }
  const rows: (string | number)[][] = [HEADER];
  const sorted = [...songs.values()].sort(
    (a, b) => b.count - a.count || a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
  );
  for (const s of sorted) {
    const isrc = s.isrc || (lookupIsrc ? await musicbrainzIsrc(s.artist, s.title) : "");
    rows.push([SERVICE, "A", s.artist, s.title, isrc, s.album, s.label, s.count]);
  }
  return rows.map((r) => r.map(field).join("|")).join("\n") + "\n";
}

export const admin = new Hono();

admin.use(basicAuth({ username: "admin", password: PASSWORD }));

admin.get("/", (c) => {
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, i) =>
    monthOf(new Date(now.getFullYear(), now.getMonth() - i, 1)),
  );
  return c.render(
    <>
      <h1>Radio admin</h1>
      <h2>SoundExchange reports</h2>
      <table class="striped">
        {months.map((m) => (
          <tr>
            <td>{m}</td>
            <td>
              <a href={`/admin/report?month=${m}`}>Download</a>
            </td>
            <td>
              <a href={`/admin/report?month=${m}&isrc=1`}>With MusicBrainz ISRCs (slow)</a>
            </td>
          </tr>
        ))}
      </table>
    </>,
    { title: "Radio admin", script: false },
  );
});

admin.get(
  "/report",
  validator("query", (q, c) => {
    const month = typeof q.month === "string" ? q.month : "";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return c.text("month must be YYYY-MM", 400);
    return { month, isrc: q.isrc !== undefined };
  }),
  async (c) => {
    const { month, isrc } = c.req.valid("query");
    const [y, m] = month.split("-");
    const last = new Date(Number(y), Number(m), 0).getDate();
    c.header("Content-Disposition", `attachment; filename="${SHORT}01${m}${y}-${last}${m}${y}_A.txt"`);
    return c.text(await report(month, isrc));
  },
);
