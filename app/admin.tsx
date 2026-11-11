// Admin pages, mounted at /admin behind basic auth (user "admin",
// ADMIN_PASSWORD): SoundExchange Report of Use from the play log.
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
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

// One row per song across all shows; each play counts its listeners (at least 1).
// ISRCs come from tags written by scripts/import.sh (beet mbsync).
async function report(month: string): Promise<string> {
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
    rows.push([SERVICE, "A", s.artist, s.title, s.isrc, s.album, s.label, s.count]);
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
    <main class="page page-station">
      <h1 class="display">Admin</h1>
      <h2 class="label">SoundExchange reports</h2>
      <table class="admin-table">
        {months.map((m) => (
          <tr>
            <td>{m}</td>
            <td>
              <a href={`/admin/report?month=${m}`}>Download</a>
            </td>
          </tr>
        ))}
      </table>
    </main>,
    { title: "Radio admin", script: false },
  );
});

admin.get("/report", async (c) => {
  const month = c.req.query("month") ?? "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return c.text("month must be YYYY-MM", 400);
  const [y, m] = month.split("-");
  const last = new Date(Number(y), Number(m), 0).getDate();
  c.header("Content-Disposition", `attachment; filename="${SHORT}01${m}${y}-${last}${m}${y}_A.txt"`);
  return c.text(await report(month));
});
