// SoundExchange reports, mounted at /reports (linked from the site nav): the
// last 12 months, each a Report of Use from the play log at /reports/<YYYY-MM>.
import { Hono } from "hono";
import { monthOf, monthPlays } from "./plays.ts";
import { SiteHeader } from "./ui.tsx";

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

export const reports = new Hono();

reports.get("/", (c) => {
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, i) =>
    monthOf(new Date(now.getFullYear(), now.getMonth() - i, 1)),
  );
  return c.render(
    <main class="page page-reports">
      <SiteHeader current="reports" />
      <h1 class="display">Reports</h1>
      <p class="lead">
        Monthly SoundExchange Reports of Use: every song played on every station, with its listener count.
      </p>
      <table class="reports-table">
        {months.map((m) => (
          <tr>
            <td>{m}</td>
            <td>
              <a href={`/reports/${m}`} hx-boost="false" download>
                Download
              </a>
            </td>
          </tr>
        ))}
      </table>
      <footer class="footer footer-rule">{c.req.header("host")}</footer>
    </main>,
    { title: "Reports" },
  );
});

reports.get("/:month{\\d{4}-(?:0[1-9]|1[0-2])}", async (c) => {
  const month = c.req.param("month");
  const [y, m] = month.split("-");
  const last = new Date(Number(y), Number(m), 0).getDate();
  c.header("Content-Disposition", `attachment; filename="${SHORT}01${m}${y}-${last}${m}${y}_A.txt"`);
  return c.text(await report(month));
});
