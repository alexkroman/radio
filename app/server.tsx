// The web app behind Caddy: the stations list (/), each show's station page
// (/<slug>) and cover (/<slug>/cover.jpg), /about, and the admin pages (/admin).
// Shows are shows/<slug>.md; Liquidsoap serves their streams via Caddy.
import { readdir, readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import { marked } from "marked";
import { admin } from "./admin.tsx";
import { login, throttle } from "./login.tsx";
import { type Play, recentPlays } from "./plays.ts";
import {
  Cover,
  Markdown,
  npData,
  PlayButton,
  PlayerBar,
  Poll,
  type Show,
  SITE_TITLE,
  SiteHeader,
  Time,
} from "./ui.tsx";

const SHOWS = process.env.SHOWS_DIR ?? "/shows";
const COVERS = process.env.COVERS_DIR ?? "/covers";
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "hello@example.com";
const SLUG = "[a-z0-9-]+";
// Pages with their own routes; a show with one of these slugs isn't listed.
const RESERVED = new Set(["about", "admin", "assets", "covers", "login"]);
// radio.liq: %mp3(bitrate = 256).
const FORMAT = "MP3 · 256 kbps";

declare module "hono" {
  interface ContextRenderer {
    (
      content: string | Promise<string>,
      props?: { title?: string; script?: boolean },
    ): Response | Promise<Response>;
  }
}

async function getShow(slug: string): Promise<Show | undefined> {
  if (RESERVED.has(slug)) return undefined;
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

// Track title over artist, as in the stations list.
const TrackLines = ({ play }: { play?: Play }) => (
  <div class="np-lines">
    {play && <span class="np-track">{play.title}</span>}
    {play?.artist && <span class="np-artist">{play.artist}</span>}
  </div>
);

// The station page's cover and text (the play button stays put when this is refreshed).
const NowPlaying = ({ show, play }: { show: Show; play?: Play }) => (
  <div id="np" class="np" {...npData(show.slug, play)}>
    <Cover play={play} size="cover-120" labelled />
    <div class="np-text">
      <span class="label np-status">
        <span class="dot" aria-hidden="true" />
        <span data-status={show.slug}>Live</span>
      </span>
      {play && <span class="np-track">{play.title}</span>}
      {play?.artist && <span class="np-artist">{play.artist}</span>}
    </div>
  </div>
);

const History = ({ plays }: { plays: Play[] }) => (
  <section id="history" class="history" aria-labelledby="recent-heading">
    <h2 id="recent-heading" class="label">
      Recently played
    </h2>
    {plays.length === 0 ? (
      <p class="muted">Nothing played yet.</p>
    ) : (
      <ol>
        {plays.map((p) => (
          <li>
            <Time seconds={p.time} />
            <Cover play={p} size="cover-40" />
            <span class="h-track">{p.title}</span>
            {p.artist && <span class="h-artist">{p.artist}</span>}
          </li>
        ))}
      </ol>
    )}
  </section>
);

const app = new Hono({ strict: false });

app.use(
  "/assets/*",
  serveStatic({ root: "dist/public", rewriteRequestPath: (p) => p.replace(/^\/assets/, "") }),
);
app.use("/:file{favicon\\.ico|favicon\\.svg|apple-touch-icon\\.png}", serveStatic({ root: "dist/public" }));

app.use(
  jsxRenderer(({ children, title, script = true }) => (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="htmx-config" content='{"includeIndicatorStyles":false,"allowEval":false}' />
        <title>{title ? `${title} — ${SITE_TITLE}` : SITE_TITLE}</title>
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap"
        />
        <link rel="stylesheet" href="/assets/app.css" />
        {script && <script src="/assets/app.js" defer />}
      </head>
      <body>
        {/* Links swap just <main> in here, so the audio and the player bar keep going. */}
        <div
          id="page"
          hx-history-elt
          {...(script
            ? { "hx-boost": "true", "hx-target": "#page", "hx-select": "main", "hx-swap": "innerHTML" }
            : {})}
        >
          {children}
        </div>
        {script && <PlayerBar />}
      </body>
    </html>
  )),
);

app.use(throttle);
login(app);
app.route("/admin", admin);

app.get("/", async (c) => {
  const shows = await getShows();
  const rows = await Promise.all(shows.map(async (s) => ({ ...s, play: (await recentPlays(s.slug, 1))[0] })));
  return c.render(
    <main class="page page-index">
      <SiteHeader current="stations" home />
      <section id="stations" class="stations" aria-label="Stations">
        {rows.map((s, i) => (
          <div class="station">
            <span class="station-num">{String(i + 1).padStart(2, "0")}</span>
            <div class="station-info">
              <a class="station-name" href={`/${s.slug}`}>
                {s.title}
              </a>
              <Markdown class="station-desc" html={s.description} />
            </div>
            <div id={`np-${s.slug}`} class="station-np" {...npData(s.slug, s.play)}>
              <Cover play={s.play} size="cover-56" labelled />
              <TrackLines play={s.play} />
            </div>
            <PlayButton show={s} />
          </div>
        ))}
      </section>
      <footer class="footer">{c.req.header("host")}</footer>
      <Poll path="/" ids={rows.map((s) => `np-${s.slug}`)} />
    </main>,
  );
});

app.get("/about", async (c) => {
  const shows = await getShows();
  const host = c.req.header("host") ?? "";
  return c.render(
    <main class="page page-about">
      <SiteHeader current="about" />
      <h1 class="display">About</h1>
      {/* Sample copy: placeholder text until the real About copy is written. */}
      <p class="lead">
        Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis
        dapibus, a pellentesque sem lacinia quam.
      </p>
      <section class="prose" aria-labelledby="about-stations">
        <h2 id="about-stations" class="label">
          The stations
        </h2>
        <p>
          Sed posuere consectetur est at lobortis. Cras mattis consectetur purus sit amet fermentum. Donec
          ullamcorper nulla non metus auctor fringilla. Vestibulum id ligula porta felis euismod semper,
          nullam quis risus eget urna mollis ornare vel eu leo.
        </p>
        <p>
          Maecenas faucibus mollis interdum, with an <a href="/">inline link</a> to the stations. Aenean eu
          leo quam pellentesque ornare sem lacinia quam venenatis vestibulum.
        </p>
      </section>
      <section class="prose" aria-labelledby="about-listen">
        <h2 id="about-listen" class="label">
          Listening
        </h2>
        <p>
          Curabitur blandit tempus porttitor. Nulla vitae elit libero, a pharetra augue: each station has a
          direct stream URL for apps and players.
        </p>
        <dl class="streams">
          {shows.map((s) => (
            <div>
              <dt class="label">{s.title}</dt>
              <dd>
                <a class="url" href={`/${s.slug}/stream`} hx-boost="false">{`${host}/${s.slug}/stream`}</a>
              </dd>
            </div>
          ))}
          <div>
            <dt class="label">Format</dt>
            <dd>{FORMAT}</dd>
          </div>
        </dl>
      </section>
      <section class="prose" aria-labelledby="about-contact">
        <h2 id="about-contact" class="label">
          Contact
        </h2>
        <p>
          Donec id elit non mi porta gravida at eget metus:{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
      </section>
      <footer class="footer footer-rule">{host}</footer>
    </main>,
    { title: "About" },
  );
});

app.get(`/:slug{${SLUG}}`, async (c) => {
  const show = await getShow(c.req.param("slug"));
  if (!show) return c.notFound();
  const [current, ...recent] = await recentPlays(show.slug, 11);
  const host = c.req.header("host") ?? "";
  const stream = `/${show.slug}/stream`;
  return c.render(
    <main class="page page-station">
      <SiteHeader current="stations" />
      <header class="title-block">
        <h1 class="display">{show.title}</h1>
        <Markdown class="subtitle" html={show.description} />
      </header>
      <section class="np-block" aria-label="Now playing">
        <PlayButton show={show} large />
        <NowPlaying show={show} play={current} />
      </section>
      <section class="stream" aria-label="Stream URL">
        <span class="label stream-label">Stream</span>
        <a class="url" href={stream} hx-boost="false">{`${host}${stream}`}</a>
        <button type="button" class="copy" data-copy={`https://${host}${stream}`}>
          Copy
        </button>
      </section>
      <History plays={recent} />
      <Poll path={`/${show.slug}`} ids={["np", "history"]} />
    </main>,
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

// Per-track covers extracted by scripts/import.sh → covers/<show>/<stem>.jpg
app.get(`/covers/:slug{${SLUG}}/:file{[^/]+\\.jpg}`, async (c) => {
  const { slug, file } = c.req.param();
  if (/[/\\]|^\.\.?$/.test(file)) return c.notFound();
  const jpg = await readFile(`${COVERS}/${slug}/${file}`).catch(() => undefined);
  if (!jpg) return c.notFound();
  c.header("Content-Type", "image/jpeg");
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(jpg);
});

app.notFound((c) => c.text("Not found", 404));

serve({ fetch: app.fetch, port: 3000 });
