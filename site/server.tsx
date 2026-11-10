// Public site: the show list (/) and each show's player page (/<slug>).
// Shows are shows/<slug>.md; their streams are served by Icecast via Caddy.
import { readdir, readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import { marked } from "marked";
import { type Play, readPlays } from "../shared/playlist.ts";

const SHOWS = process.env.SHOWS_DIR ?? "/shows";
const COVERS = process.env.COVERS_DIR ?? "/covers";
const SLUG = "[a-z0-9-]+";

type Show = { slug: string; title: string; description: string };

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
  const md = text.replace(/\r\n?/g, "\n");
  const [, front = "", body = md] =
    /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(md) ?? [];
  // `title: x`, optionally quoted as in YAML.
  const raw = /^title:\s*(.*?)\s*$/m.exec(front)?.[1];
  const title = raw?.replace(/^(["'])(.*)\1$/, "$2") || slug;
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

// The newest plays on a show (the current log plus the last rotated one).
async function getPlays(slug: string, limit = 21): Promise<Play[]> {
  return (await readPlays(1))
    .filter((p) => p.mount === `/${slug}`)
    .slice(-limit)
    .reverse();
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
