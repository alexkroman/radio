// Public site: the show list (/) and each show's player page (/<slug>).
// Shows are shows/<slug>.md; their streams are served by Icecast via Caddy.
import { readdir, readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import { marked } from "marked";

const SHOWS = process.env.SHOWS_DIR ?? "/shows";
const LOG = process.env.PLAYLIST_LOG ?? "/logs/playlist.log";
const COVERS = process.env.COVERS_DIR ?? "/covers";
const SLUG = "[a-z0-9-]+";

type Show = { slug: string; title: string; description: string };
type Play = { time: Date; artist: string; title: string };

declare module "hono" {
  interface ContextRenderer {
    (
      content: string | Promise<string>,
      props?: { title?: string },
    ): Response | Promise<Response>;
  }
}

async function getShow(slug: string): Promise<Show | undefined> {
  const text = await readFile(`${SHOWS}/${slug}.md`, "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return undefined;
  const [, front = "", body = text] =
    /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text) ?? [];
  const title = /^title:\s*(.*?)\s*$/m.exec(front)?.[1] ?? slug;
  return { slug, title, description: await marked.parse(body) };
}

async function getShows(): Promise<Show[]> {
  const files = (await readdir(SHOWS))
    .filter((f) => new RegExp(`^${SLUG}\\.md$`).test(f))
    .sort();
  return (await Promise.all(files.map((f) => getShow(f.slice(0, -3))))).filter(
    (s) => s !== undefined,
  );
}

// Icecast's playlist.log lines: "10/Nov/2026:16:05:34 +0000|/mount|listeners|Artist - Title".
// Icecast HTML-escapes the title.
const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";
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

async function getPlays(slug: string, limit = 21): Promise<Play[]> {
  const log = await readFile(LOG, "utf8").catch(() => "");
  const plays: Play[] = [];
  for (const line of log.trimEnd().split("\n").reverse()) {
    const [date = "", mount, , escaped = ""] = line.split("|");
    const song = unescape(escaped);
    const d = /^(\d+)\/(\w+)\/(\d+):(\d+):(\d+):(\d+) ([+-]\d\d)(\d\d)$/.exec(
      date,
    );
    if (mount !== `/${slug}` || !d) continue;
    const [, day, mon, year, h, m, s, tzh, tzm] = d;
    const mm = String(MONTHS.indexOf(mon!) / 3 + 1).padStart(2, "0");
    const time = new Date(`${year}-${mm}-${day}T${h}:${m}:${s}${tzh}:${tzm}`);
    const dash = song.indexOf(" - ");
    plays.push(
      dash < 0
        ? { time, artist: "", title: song }
        : { time, artist: song.slice(0, dash), title: song.slice(dash + 3) },
    );
    if (plays.length === limit) break;
  }
  return plays;
}

const Markdown = ({ html }: { html: string }) => (
  <div dangerouslySetInnerHTML={{ __html: html }} />
);

const NowPlaying = ({ show, play }: { show: Show; play?: Play }) => (
  <div
    id="np"
    data-show={show.slug}
    hx-get={`/${show.slug}`}
    hx-select="#np"
    hx-select-oob="#history"
    hx-swap="outerHTML"
    hx-trigger="every 15s, refresh"
    hx-sync="this:replace"
  >
    {play && (
      <hgroup>
        <h2>{play.title}</h2>
        {play.artist && <p>{play.artist}</p>}
      </hgroup>
    )}
  </div>
);

const History = ({ plays }: { plays: Play[] }) => (
  <article id="history">
    <small class="label">Recently played</small>
    <table class="striped">
      {plays.map((p) => (
        <tr>
          <td class="time">
            <time datetime={p.time.toISOString()}>
              {p.time.toISOString().slice(11, 16)}
            </time>
          </td>
          <td>
            {p.title}
            {p.artist && <span class="muted"> · {p.artist}</span>}
          </td>
        </tr>
      ))}
    </table>
  </article>
);

const app = new Hono();

app.use(
  "/assets/*",
  serveStatic({
    root: "dist/site/public",
    rewriteRequestPath: (p) => p.replace(/^\/assets/, ""),
  }),
);

app.use(
  jsxRenderer(({ children, title }) => (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="htmx-config"
          content='{"includeIndicatorStyles":false,"allowEval":false}'
        />
        <title>{title ?? "Radio"}</title>
        <link rel="stylesheet" href="/assets/app.css" />
        <script src="/assets/app.js" defer />
      </head>
      <body>
        <main class="container">{children}</main>
      </body>
    </html>
  )),
);

app.get("/", async (c) =>
  c.render(
    <>
      <hgroup>
        <h1>Radio</h1>
        <p>Pick a show</p>
      </hgroup>
      {(await getShows()).map((s) => (
        <article>
          <h2>
            <a href={`/${s.slug}`}>{s.title}</a>
          </h2>
          <Markdown html={s.description} />
        </article>
      ))}
    </>,
    { title: "Radio" },
  ),
);

app.get(`/:slug{${SLUG}}`, async (c) => {
  const show = await getShow(c.req.param("slug"));
  if (!show) return c.notFound();
  const [current, ...recent] = await getPlays(show.slug);
  const stream = `/${show.slug}/stream`;
  return c.render(
    <>
      <p>
        <small>
          <a href="/">← All shows</a>
        </small>
      </p>
      <hgroup>
        <h1>{show.title}</h1>
        <Markdown html={show.description} />
      </hgroup>
      <article>
        <small class="label">Now playing</small>
        <div class="np-row">
          <img id="album-art" src={`/${show.slug}/cover.jpg`} alt="" hidden />
          <div class="np-info">
            <NowPlaying show={show} play={current} />
          </div>
          <button id="play" aria-label="Play">
            ▶
          </button>
        </div>
      </article>
      <p>
        <small>
          Stream URL:{" "}
          <a href={stream}>{`https://${c.req.header("host")}${stream}`}</a>
        </small>
      </p>
      <History plays={recent} />
    </>,
    { title: show.title },
  );
});

app.get(`/:slug{${SLUG}}/cover.jpg`, async (c) => {
  const jpg = await readFile(`${COVERS}/${c.req.param("slug")}.jpg`).catch(
    () => undefined,
  );
  if (!jpg) return c.notFound();
  c.header("Content-Type", "image/jpeg");
  c.header("Cache-Control", "public, max-age=30");
  return c.body(jpg);
});

app.notFound((c) => c.text("Not found", 404));

serve({ fetch: app.fetch, port: 3000 });
