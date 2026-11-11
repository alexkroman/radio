// The web app behind Caddy: the stations list (/), each show's station page
// (/<slug>) and current cover (/<slug>/cover.jpg), DJ pages (/djs/<dj>), /about,
// and the admin pages (/admin). Shows are shows/<slug>.md (app/shows.ts), with
// their DJs in the front matter; Liquidsoap serves their streams via Caddy.
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import { admin } from "./admin.tsx";
import { login, throttle } from "./login.tsx";
import { latestPlays, type Play, recentPlays } from "./plays.ts";
import { getDj, getShow, getShows, PHOTO_TYPES, type Show, SLUG } from "./shows.ts";
import {
  Cover,
  coverUrl,
  DjCredit,
  Markdown,
  npData,
  PlayButton,
  PlayerBar,
  Poll,
  SITE_TITLE,
  SiteHeader,
  Time,
} from "./ui.tsx";

const COVERS = process.env.COVERS_DIR ?? "/covers";
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "hello@example.com";
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

// Track title and artist; `cls` prefixes their classes (np-track, h-artist, …).
const TrackLines = ({ play, cls }: { play?: Play; cls: string }) => (
  <>
    {play && <span class={`${cls}-track`}>{play.title}</span>}
    {play?.artist && <span class={`${cls}-artist`}>{play.artist}</span>}
  </>
);

// One station in a list: the stations list (numbered, with its DJs) or a DJ's
// page (neither, since the DJ is the page's subject).
const StationRow = ({ show, play, num }: { show: Show; play?: Play; num?: number }) => (
  <div class="station">
    {num !== undefined && <span class="station-num">{String(num).padStart(2, "0")}</span>}
    <div class="station-info">
      <a class="station-name" href={`/${show.slug}`}>
        {show.title}
      </a>
      <Markdown class="station-desc" html={show.description} />
      {num !== undefined && <DjCredit djs={show.djs} class="station-credit" />}
    </div>
    <div id={`np-${show.slug}`} class="station-np" {...npData(show.slug, play)}>
      <Cover play={play} size="cover-56" labelled />
      <div class="np-lines">
        <TrackLines play={play} cls="np" />
      </div>
    </div>
    <PlayButton show={show} />
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
      <TrackLines play={play} cls="np" />
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
            <TrackLines play={p} cls="h" />
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

app.use("/login", throttle);
app.use("/admin/*", throttle);
login(app);
app.route("/admin", admin);

app.get("/", async (c) => {
  const [shows, latest] = await Promise.all([getShows(), latestPlays()]);
  const rows = shows.map((s) => ({ ...s, play: latest.get(s.slug) }));
  return c.render(
    <main class="page page-index">
      <SiteHeader current="stations" home />
      <section id="stations" class="stations" aria-label="Stations">
        {rows.map((s, i) => (
          <StationRow show={s} play={s.play} num={i + 1} />
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
  const slug = c.req.param("slug");
  const [show, [current, ...recent]] = await Promise.all([getShow(slug), recentPlays(slug, 11)]);
  if (!show) return c.notFound();
  const host = c.req.header("host") ?? "";
  const stream = `/${show.slug}/stream`;
  return c.render(
    <main class="page page-station">
      <SiteHeader current="stations" />
      <header class="title-block">
        <h1 class="display">{show.title}</h1>
        <Markdown class="subtitle" html={show.description} />
        <DjCredit djs={show.djs} class="title-credit" />
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

app.get(`/djs/:dj{${SLUG}}`, async (c) => {
  const [dj, latest] = await Promise.all([getDj(c.req.param("dj")), latestPlays()]);
  if (!dj) return c.notFound();
  return c.render(
    <main class="page page-dj">
      <SiteHeader />
      <section class="profile" aria-label="Profile">
        {dj.photo ? (
          <img class="cover photo" src={`/djs/${dj.slug}/photo`} alt={`Photo of ${dj.name}`} />
        ) : (
          <span class="cover photo cover-ph" aria-hidden="true" />
        )}
        <div class="profile-text">
          <span class="label">DJ</span>
          <h1 class="display">{dj.name}</h1>
          {dj.tagline && <p class="subtitle">{dj.tagline}</p>}
        </div>
      </section>
      {dj.bio && <Markdown class="lead" html={dj.bio} />}
      <section class="dj-shows" aria-labelledby="dj-shows">
        <h2 id="dj-shows" class="label">
          Shows
        </h2>
        <div class="stations">
          {dj.shows.map((s) => (
            <StationRow show={s} play={latest.get(s.slug)} />
          ))}
        </div>
      </section>
      {dj.links.length > 0 && (
        <section class="prose" aria-labelledby="dj-links">
          <h2 id="dj-links" class="label">
            Elsewhere
          </h2>
          <dl class="streams">
            {dj.links.map((l) => (
              <div>
                <dt class="label">{l.label}</dt>
                <dd>
                  <a class="url" href={l.url} rel="me noopener" hx-boost="false">
                    {l.url.replace(/^https?:\/\//i, "").replace(/\/$/, "")}
                  </a>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <footer class="footer footer-rule">{c.req.header("host")}</footer>
      <Poll path={`/djs/${dj.slug}`} ids={dj.shows.map((s) => `np-${s.slug}`)} />
    </main>,
    { title: dj.name },
  );
});

// A DJ's photo: the file named by `photo:` in a show's front matter.
app.get(`/djs/:dj{${SLUG}}/photo`, async (c) => {
  const photo = (await getDj(c.req.param("dj")))?.photo;
  const body = photo && (await readFile(photo).catch(() => undefined));
  if (!photo || !body) return c.notFound();
  c.header("Content-Type", PHOTO_TYPES[extname(photo).toLowerCase()]);
  c.header("Cache-Control", "public, max-age=300");
  return c.body(body);
});

// The current track's cover: a redirect to its pre-extracted art (play log).
app.get(`/:slug{${SLUG}}/cover.jpg`, async (c) => {
  const cover = (await recentPlays(c.req.param("slug"), 1))[0]?.cover;
  if (!cover) return c.notFound();
  // ?t= includes the track title so this URL is unique per track; short cache
  // prevents the browser from refetching the same redirect in rapid succession.
  c.header("Cache-Control", "private, max-age=15");
  return c.redirect(coverUrl(cover));
});

// Per-track covers extracted by scripts/import.sh → covers/<show>/<stem>.jpg
// (beets keeps "#" and "%" out of file names, so ui.tsx coverUrl's encodeURI
// round-trips through serveStatic's decodeURI).
app.use(
  "/covers/*",
  serveStatic({
    root: COVERS,
    rewriteRequestPath: (p) => p.replace(/^\/covers/, ""),
    onFound: (_, c) => c.header("Cache-Control", "public, max-age=3600"),
  }),
);

app.notFound((c) => c.text("Not found", 404));

serve({ fetch: app.fetch, port: 3000 });
