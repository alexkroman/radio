// The web app behind Caddy: the show list (/), each show's player page
// (/<slug>) and cover (/<slug>/cover.jpg), and the admin pages (/admin).
// Shows are shows/<slug>.md; Liquidsoap serves their streams via Caddy.
import { readdir, readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import { marked } from "marked";
import { admin } from "./admin.tsx";
import { login } from "./login.tsx";
import { type Play, recentPlays } from "./plays.ts";

const SHOWS = process.env.SHOWS_DIR ?? "/shows";
const COVERS = process.env.COVERS_DIR ?? "/covers";
const SLUG = "[a-z0-9-]+";

type Show = { slug: string; title: string; description: string };

declare module "hono" {
  interface ContextRenderer {
    (
      content: string | Promise<string>,
      props?: { title?: string; script?: boolean },
    ): Response | Promise<Response>;
  }
}

async function getShow(slug: string): Promise<Show | undefined> {
  const text = await readFile(`${SHOWS}/${slug}.md`, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const md = text.replace(/\r\n?/g, "\n");
  const [, front = "", body = md] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(md) ?? [];
  // `title: x`, optionally quoted as in YAML.
  const title = /^title:\s*(.*?)\s*$/m.exec(front)?.[1]?.replace(/^(["'])(.*)\1$/, "$2") || slug;
  return { slug, title, description: await marked.parse(body) };
}

async function getShows(): Promise<Show[]> {
  const files = (await readdir(SHOWS)).filter((f) => new RegExp(`^${SLUG}\\.md$`).test(f)).sort();
  return (await Promise.all(files.map((f) => getShow(f.slice(0, -3))))).filter((s) => s !== undefined);
}

const hasCover = (slug: string) =>
  readFile(`${COVERS}/${slug}.jpg`).then(
    () => true,
    () => false,
  );

const Markdown = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;

const NowPlaying = ({ show, play }: { show: Show; play?: Play }) => (
  <div
    id="np"
    data-show={show.slug}
    hx-get={`/${show.slug}`}
    hx-select="#np"
    hx-select-oob="#history,#album-art"
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
      {plays.map((p) => {
        const time = new Date(p.time * 1000).toISOString();
        return (
          <tr>
            <td class="time">
              <time datetime={time}>{time.slice(11, 16)}</time>
            </td>
            <td>
              {p.title}
              {p.artist && <span class="muted"> · {p.artist}</span>}
            </td>
          </tr>
        );
      })}
    </table>
  </article>
);

const app = new Hono({ strict: false });

app.use(
  "/assets/*",
  serveStatic({ root: "dist/public", rewriteRequestPath: (p) => p.replace(/^\/assets/, "") }),
);

app.use(
  jsxRenderer(({ children, title, script = true }) => (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="htmx-config" content='{"includeIndicatorStyles":false,"allowEval":false}' />
        <title>{title ?? "Radio"}</title>
        <link rel="stylesheet" href="/assets/app.css" />
        {script && <script src="/assets/app.js" defer />}
      </head>
      <body>
        <main class="container">{children}</main>
      </body>
    </html>
  )),
);

login(app);
app.route("/admin", admin);

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
  ),
);

app.get(`/:slug{${SLUG}}`, async (c) => {
  const show = await getShow(c.req.param("slug"));
  if (!show) return c.notFound();
  const [current, ...recent] = await recentPlays(show.slug);
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
          <img
            id="album-art"
            src={`/${show.slug}/cover.jpg?t=${current?.time ?? 0}`}
            alt=""
            hidden={!(await hasCover(show.slug))}
          />
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
          Stream URL: <a href={stream}>{`https://${c.req.header("host")}${stream}`}</a>
        </small>
      </p>
      <History plays={recent} />
    </>,
    { title: show.title },
  );
});

app.get(`/:slug{${SLUG}}/cover.jpg`, async (c) => {
  const jpg = await readFile(`${COVERS}/${c.req.param("slug")}.jpg`).catch(() => undefined);
  if (!jpg) return c.notFound();
  c.header("Content-Type", "image/jpeg");
  c.header("Cache-Control", "public, max-age=30");
  return c.body(jpg);
});

app.notFound((c) => c.text("Not found", 404));

serve({ fetch: app.fetch, port: 3000 });
