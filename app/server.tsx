// The web app behind Caddy: the stations list (/), each show's station page
// (/<slug>) and current track (/<slug>/now.json), DJ pages (/djs/<dj>), /manifesto,
// and the SoundExchange reports (/reports). Shows are shows/<slug>.md (app/shows.ts), with
// their DJs in the front matter; Liquidsoap serves their streams via Caddy.
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { etag } from "hono/etag";
import { createMiddleware } from "hono/factory";
import { jsxRenderer } from "hono/jsx-renderer";
import { login, throttle } from "./login.tsx";
import { latestPlays, type Play, recentPlays } from "./plays.ts";
import { reports } from "./reports.tsx";
import { getDj, getShow, getShows, type Show, SLUG } from "./shows.ts";
import {
  Cover,
  coverUrl,
  DjCredit,
  Markdown,
  npData,
  PlayButton,
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

export const app = new Hono({ strict: false });

// Every GET gets an ETag, so a repeat (the now-playing poll, the unhashed
// app.js/app.css, a DJ photo) is answered 304 when nothing changed.
app.use(etag());
// The only form is the login (a password and a path): no bigger body is read.
app.use(bodyLimit({ maxSize: 4096, onError: (c) => c.text("Too large", 413) }));

// Cache-Control for a file serveStatic found (its onFound runs too late to add one).
const cacheFor = (value: string) =>
  createMiddleware(async (c, next) => {
    await next();
    if (c.res.ok) c.res.headers.set("Cache-Control", value);
  });

// Fonts have content hashes in their names, so they never change.
app.use("/assets/fonts/*", cacheFor("public, max-age=31536000, immutable"));
// app.js and app.css keep their names, so make browsers revalidate them every
// time: with only a Last-Modified, a phone may run yesterday's app.js for hours.
app.use("/assets/:file{app\\.(?:js|css)}", cacheFor("no-cache"));
app.use(
  "/assets/*",
  serveStatic({ root: "dist/public", rewriteRequestPath: (p) => p.replace(/^\/assets/, "") }),
);
app.use("/:file{favicon\\.ico|favicon\\.svg|apple-touch-icon\\.png}", serveStatic({ root: "dist/public" }));

// The player bar's mount, with the station it shows before any is played or
// found on the page: the first show.
async function Player() {
  const [first] = await getShows();
  return <div id="player" data-slug={first?.slug} data-title={first?.title} />;
}

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
      <body class={script ? "with-bar" : undefined}>
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
        {/* The player bar (app/bar.tsx), rendered by the client. */}
        {script && <Player />}
      </body>
    </html>
  )),
);

app.use("/login", throttle);
login(app);
app.route("/reports", reports);

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

app.get("/manifesto", async (c) => {
  const shows = await getShows();
  const host = c.req.header("host") ?? "";
  return c.render(
    <main class="page page-manifesto">
      <SiteHeader current="manifesto" />
      <h1 class="display">Manifesto</h1>
      <p class="lead">Music is not a feed. We are taking it back from Spotify and Apple Music.</p>
      <section class="prose" aria-labelledby="manifesto-problem">
        <h2 id="manifesto-problem" class="label">
          What went wrong
        </h2>
        <p>
          Streaming turned music into a utility: rented by the month, sorted by an algorithm, and paid for in
          fractions of a cent. You own nothing, and nobody chose any of it for you.
        </p>
      </section>
      <section class="prose" aria-labelledby="manifesto-stations">
        <h2 id="manifesto-stations" class="label">
          What we do instead
        </h2>
        <p>
          People pick the records. Every <a href="/">station</a> here is programmed by a DJ with a name and
          taste, and plays the same song for everyone at the same time. No algorithm, no profile, no skip
          button.
        </p>
        <p>
          Every play is logged, and the <a href="/reports">reports</a> are public, so the people who made the
          music get paid.
        </p>
      </section>
      <section class="prose" aria-labelledby="manifesto-listen">
        <h2 id="manifesto-listen" class="label">
          Listening
        </h2>
        <p>Radio belongs in any player, not one company's app. Each station has a direct stream URL.</p>
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
      <section class="prose" aria-labelledby="manifesto-contact">
        <h2 id="manifesto-contact" class="label">
          Contact
        </h2>
        <p>
          Want in? Write to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
      </section>
      <footer class="footer footer-rule">{host}</footer>
    </main>,
    { title: "Manifesto" },
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
        {dj.photo && <img class="cover photo" src={`/djs/${dj.slug}/photo`} alt={`Photo of ${dj.name}`} />}
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
  // No max-age: the ETag makes a repeat a 304, and an edited photo shows at once.
  return (photo && (await serveStatic({ path: photo })(c, async () => {}))) || c.notFound();
});

// The current track, for the player (client.ts) and the lock screen.
app.get(`/:slug{${SLUG}}/now.json`, async (c) => {
  const slug = c.req.param("slug");
  const [show, [play]] = await Promise.all([getShow(slug), recentPlays(slug, 1)]);
  if (!show) return c.notFound();
  return c.json({
    track: play?.title ?? "",
    artist: play?.artist ?? "",
    cover: play?.cover ? coverUrl(play.cover) : "",
  });
});

// Per-track covers extracted by scripts/import.sh → covers/<show>/<stem>.jpg
// (beets keeps "#" and "%" out of file names, so ui.tsx coverUrl's encodeURI
// round-trips through serveStatic's decodeURI).
app.use(
  "/covers/*",
  cacheFor("public, max-age=3600"),
  serveStatic({ root: COVERS, rewriteRequestPath: (p) => p.replace(/^\/covers/, "") }),
);

app.notFound((c) => c.text("Not found", 404));
