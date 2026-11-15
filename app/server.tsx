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
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "hello@mazesradio.com";
const GITHUB_URL = "https://github.com/alexkroman/radio";
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

app.get("/about", (c) => c.redirect("/manifesto", 301));

app.get("/manifesto", async (c) => {
  const shows = await getShows();
  const host = c.req.header("host") ?? "";
  return c.render(
    <main class="page page-manifesto">
      <SiteHeader current="manifesto" />
      <h1 class="display">Manifesto</h1>
      <p class="lead">Public radio for the streaming era: a nonprofit alternative to Spotify.</p>
      <section class="prose" aria-labelledby="manifesto-why">
        <h2 id="manifesto-why" class="label">
          Why
        </h2>
        <p>
          Radio was free to anyone with a receiver, heard by everyone at once, programmed by people and paid
          for in the open. You didn't need an account to hear a song, and nobody kept a record of what you
          heard.
        </p>
        <p>
          Streaming made listening private. It needs an account, reports every play back to a company and
          mixes the music with advertising. Algorithms pick songs to keep you listening longer, not to play
          you something good. And subscription money flows into a pool where the biggest artists take most of
          it.
        </p>
        <p>
          Listeners didn't choose this; licensing costs did. On-demand music is so expensive to license that
          only companies selling attention at scale can afford the catalogue.
        </p>
        <p>
          The way a culture hears its music shouldn't have to be an advertising product. Musicians need a
          place where every play pays the same rate and pays them directly. Listeners need a way to hear music
          that doesn't watch them back. The law already allows it. It just needs building.
        </p>
      </section>
      <section class="prose" aria-labelledby="manifesto-how">
        <h2 id="manifesto-how" class="label">
          How
        </h2>
        <p>
          Spotify pays roughly 70% of its revenue for on-demand licenses, on every stream, for as long as it
          runs. A station like this one, where you can't pick the song, uses the statutory license in US
          copyright law instead:
        </p>
        <ul>
          <li>Every recording is licensed from day one. No label deals, no holdouts.</li>
          <li>
            A noncommercial station pays a flat minimum per channel that covers a large block of listening
            hours. Until we pass it, one more listener costs nothing.
          </li>
          <li>Nobody takes a cut of revenue, and no shareholder is owed growth.</li>
        </ul>
        <p>So the station doesn't need a big audience to survive.</p>
      </section>
      <section class="prose" aria-labelledby="manifesto-what">
        <h2 id="manifesto-what" class="label">
          What it is
        </h2>
        <p>
          A few <a href="/">channels</a>, each programmed by a person, playing around the clock: music for
          work, driving, cooking, the background of a day. No ads. No account. No tracking.
        </p>
        <p>It isn't trying to be a better Spotify. It's trying to be what Spotify's business can't be.</p>
      </section>
      <section class="prose" aria-labelledby="manifesto-money">
        <h2 id="manifesto-money" class="label">
          Where the money goes
        </h2>
        <p>
          Through SoundExchange, every play pays the same rate, superstar or unknown. The law sets the split:
          50% to the rights owner, 45% straight to the featured artists rather than through their label, and
          5% to session musicians and singers. On Spotify, most of the money goes to the top artists, through
          label deals.
        </p>
        <p>
          When a channel here plays a band, the band gets paid, directly, at the same rate as anyone else. Our{" "}
          <a href="/reports">reports</a> show every play.
        </p>
      </section>
      <section class="prose" aria-labelledby="manifesto-not">
        <h2 id="manifesto-not" class="label">
          What we don't do
        </h2>
        <ul>
          <li>
            On-demand, offline or personal libraries. The license forbids them, so this complements Spotify
            rather than replacing it.
          </li>
          <li>
            Artist marathons or whole albums. The license limits how many tracks from one artist or album can
            play in a row.
          </li>
          <li>Algorithms. People pick every song.</li>
          <li>
            Ads, or selling your data. Listening is free and untracked. The station runs on listeners who
            choose to pay, which is enough because the costs are flat.
          </li>
        </ul>
      </section>
      <section class="prose" aria-labelledby="manifesto-listen">
        <h2 id="manifesto-listen" class="label">
          Listening
        </h2>
        <p>Press play on any station, or open its stream URL in a radio app or VLC.</p>
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
      <section class="prose" aria-labelledby="manifesto-yours">
        <h2 id="manifesto-yours" class="label">
          Start your own
        </h2>
        <p>
          The code that runs this station is open source. Anyone can use it to start their own: add some
          music, write a page for each channel and switch it on. It's all on <a href={GITHUB_URL}>GitHub</a>.
        </p>
      </section>
      <section class="prose" aria-labelledby="manifesto-contact">
        <h2 id="manifesto-contact" class="label">
          Contact
        </h2>
        <p>
          Questions, records we should hear, takedowns:{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
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
