// The web app behind Caddy: what's on air and the latest episodes (/), each show's
// page (/<slug>), the track on air (/now.json), DJ pages (/djs/<dj>),
// /about, and the SoundExchange reports (/reports). Shows are
// shows/<slug>.md (app/shows.ts), with their DJs and hours in the front matter;
// Liquidsoap plays them on their hours on the one stream, /stream (via Caddy).
import { archive, BLOCK, type Block, day, duration, inArchive, trackAt } from "./archive.ts";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { etag } from "hono/etag";
import { createMiddleware } from "hono/factory";
import { jsxRenderer } from "hono/jsx-renderer";
import { login, throttle } from "./login.tsx";
import { latestPlay, type Play, recentPlays } from "./plays.ts";
import { reports } from "./reports.tsx";
import { nextSlot, scheduled, showAt } from "./schedule.ts";
import { getDj, getShow, getShows, type Show, SLUG } from "./shows.ts";
import {
  Cover,
  nowTrack,
  DjCredit,
  ICONS,
  Markdown,
  PlayButton,
  Poll,
  SITE_TITLE,
  SiteHeader,
  Time,
  trackJson,
} from "./ui.tsx";

const COVERS = process.env.COVERS_DIR ?? "/covers";
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "alex@mazesradio.com";
const GITHUB_URL = "https://github.com/alexkroman/radio";
// radio.liq: %mp3(bitrate = 256), the stream and the archive both.
const FORMAT = "MP3, 256 kbps";

// The law the station plays music under, for the About page: each provision,
// where to read it, and how the station keeps it.
const USC = "https://www.law.cornell.edu/uscode/text/17";
const CFR = "https://www.law.cornell.edu/cfr/text/37";
const LAWS = [
  {
    cite: "17 U.S.C. § 114(d)(2)",
    url: `${USC}/114#d_2`,
    what: "the statutory license itself. It lets a noncommercial webcaster play any released recording without a deal with its label, on the conditions below.",
  },
  {
    cite: "§ 114(j)(13)",
    url: `${USC}/114#j_13`,
    what: "the sound recording performance complement. In any three hours, a station may play no more than 4 tracks by one artist (3 in a row) and no more than 3 from one album (2 in a row). The station checks every track before it plays and won't play one that would exceed the limit.",
  },
  {
    cite: "§ 114(d)(2)(C)(ii)",
    url: `${USC}/114#d_2_C_ii`,
    what: "no advance schedule of songs or artists. Our schedule names shows, never what they'll play.",
  },
  {
    cite: "§ 114(d)(2)(C)(iii)",
    url: `${USC}/114#d_2_C_iii`,
    what: "archived programs must be at least five hours long and available for no more than two weeks. Shorter recordings are never published, and old ones come down automatically.",
  },
  {
    cite: "§ 114(d)(2)(C)(vi)",
    url: `${USC}/114#d_2_C_vi`,
    what: "nothing that helps listeners copy the music. There are no downloads, and no seeking or skipping in the archive.",
  },
  {
    cite: "§ 114(d)(2)(C)(ix)",
    url: `${USC}/114#d_2_C_ix`,
    what: "each track's title, album and artist must be shown while it plays, and not before. We show them on the site, on your lock screen, and in the stream for radio apps.",
  },
  {
    cite: "§ 114(g)(2)",
    url: `${USC}/114#g_2`,
    what: "the royalty split. 50% goes to the rights owner, 45% to the featured artists and 5% to session musicians and singers, all paid through SoundExchange.",
  },
  {
    cite: "17 U.S.C. § 112(e)",
    url: `${USC}/112#e`,
    what: "the copies a station makes in order to broadcast. This covers the archive's recordings.",
  },
  {
    cite: "37 C.F.R. Part 380",
    url: `${CFR}/part-380`,
    what: "the rates and terms for noncommercial webcasters, set by the Copyright Royalty Judges.",
  },
  {
    cite: "37 C.F.R. Part 370",
    url: `${CFR}/part-370`,
    what: "reports of use. Every performance, live or archived, is reported to SoundExchange each month with the number of listeners. Ours are public.",
  },
];

declare module "hono" {
  interface ContextRenderer {
    (
      content: string | Promise<string>,
      props?: { title?: string; script?: boolean },
    ): Response | Promise<Response>;
  }
}

// Track title, artist and album (the statutory license has us show all
// three while a track plays); `cls` prefixes their classes (np-track,
// h-artist, …).
const TrackLines = ({ play, cls }: { play?: Play; cls: string }) => (
  <>
    {play && <span class={`${cls}-track`}>{play.title}</span>}
    {(play?.artist || play?.album) && (
      <span class={`${cls}-artist`}>
        {play.artist}
        {play.album && <span class="album">{`${play.artist ? " · " : ""}${play.album}`}</span>}
      </span>
    )}
  </>
);

// A show's hours, as times (the listener's own, once client.ts has run).
const Hours = ({ show, now }: { show: Show; now: Date }) => {
  const slot = nextSlot(show, now);
  return slot ? (
    <span class="hours">
      <Time at={slot.start} />–<Time at={slot.end} />
    </span>
  ) : null;
};

// "until 11:00 PM": when the show on air's hours end.
const Until = ({ show, now }: { show: Show; now: Date }) => {
  const slot = nextSlot(show, now);
  return slot && slot.start <= now ? (
    <span class="until">
      {" until "}
      <Time at={slot.end} />
    </span>
  ) : null;
};

// A show as a row (a DJ's shows): its hours, name and mood on one line;
// "On air" when it is, else its last archived block to play from the start,
// so a listener can pick another show to suit the mood. (The DJs are on the
// show's page.)
const ShowRow = ({
  show,
  now,
  onAir,
  blocks = [],
}: {
  show: Show;
  now: Date;
  onAir: boolean;
  blocks?: Block[];
}) => (
  <article class={onAir ? "station row row-on" : "station row"}>
    <span class="station-hours">
      <Hours show={show} now={now} />
    </span>
    <span class="station-info">
      <a class="station-name" href={`/${show.slug}`}>
        {show.title}
      </a>
      <Markdown class="station-desc" html={show.description} />
    </span>
    {onAir ? (
      <span class="label on-air">
        <span class="dot" aria-hidden="true" />
        On air
      </span>
    ) : (
      blocks[0] && (
        <span class="station-archive">
          <BlockButton show={show} blocks={blocks} i={0} episode />
        </span>
      )
    )}
  </article>
);

// The track on air: its cover and text, with the play button.
// `status`: "Live" over the track (not on the home page, whose on-air line says it).
const NowPlaying = ({ play, status = true }: { play?: Play; status?: boolean }) => (
  <section class="np-block" aria-label="Now playing">
    <PlayButton large />
    <div class="np">
      <Cover play={play} size="cover-120" labelled />
      <div class="np-text">
        {status && (
          <span class="label np-status">
            <span class="dot" aria-hidden="true" />
            <span data-status>Live</span>
          </span>
        )}
        <TrackLines play={play} cls="np" />
      </div>
    </div>
  </section>
);

// The stream's address, for a radio app, at the foot of the home page.
const StreamUrl = ({ host }: { host: string }) => (
  <footer class="footer">
    Stream URL: <a class="url" href="/stream" hx-boost="false">{`${host}/stream`}</a>
  </footer>
);

// The show on air: the newest play's (the schedule's until anything has played).
async function onAir(shows: Show[]) {
  const play = await latestPlay();
  const show = shows.find((s) => s.slug === play?.show) ?? showAt(shows, new Date());
  return { show, play: play && play.show === show?.slug ? play : undefined };
}

// The tracks played before the one on air, newest first: when, the cover, and
// title — artist.
const History = ({ plays }: { plays: Play[] }) => (
  <section id="history" class="history" aria-labelledby="recent-heading">
    <h2 id="recent-heading" class="section-label">
      Just played
    </h2>
    {plays.length === 0 ? (
      <p class="muted">Nothing played yet.</p>
    ) : (
      <ol>
        {plays.map((p) => (
          <li>
            <Time at={new Date(p.time * 1000)} />
            <Cover play={p} size="cover-40" />
            <span class="h-text">
              <span class="h-track">{p.title}</span>
              {p.artist && <span class="h-artist">{` — ${p.artist}`}</span>}
            </span>
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
app.on(
  ["GET", "HEAD"],
  ICONS.map((i) => i.href),
  serveStatic({ root: "dist/public" }),
);

// The player bar's mount, with the station's name until now.json says
// what's on.
const Player = () => <div id="player" data-title={SITE_TITLE} />;

app.use(
  jsxRenderer(({ children, title, script = true }) => (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="htmx-config" content='{"includeIndicatorStyles":false,"allowEval":false}' />
        <title>{title ? `${title} — ${SITE_TITLE}` : SITE_TITLE}</title>
        {ICONS.map((icon) => (
          <link {...icon} />
        ))}
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
  const shows = await getShows();
  const [{ show, play }, recent, blocks] = await Promise.all([onAir(shows), recentPlays(6), archive(shows)]);
  const now = new Date();
  return c.render(
    <main class="page page-station page-home">
      <SiteHeader home />
      <section class="hero" aria-label="On air">
        <header id="on-air" class="hero-head">
          <p class="label on-air-label">
            <span class="dot" aria-hidden="true" />
            On air
            {show && <Until show={show} now={now} />}
          </p>
          {show ? (
            <>
              <h2 class="display">
                <a href={`/${show.slug}`}>{show.title}</a>
              </h2>
              <div class="hero-sub">
                <Markdown class="subtitle" html={show.description} />
                <DjCredit djs={show.djs} class="subtitle" />
              </div>
            </>
          ) : (
            <h2 class="display">{SITE_TITLE}</h2>
          )}
        </header>
        <div id="np">
          <NowPlaying play={play} status={false} />
        </div>
      </section>
      <LatestEpisodes shows={shows} blocks={blocks} />
      <History plays={recent.slice(1)} />
      <StreamUrl host={c.req.header("host") ?? ""} />
      <Poll path="/" ids={["on-air", "np", "episodes", "history"]} />
    </main>,
  );
});

// An archive block's title, as its row, play button and the player show it:
// shows' blocks have no names of their own, so they're numbered.
const blockTitle = (show: Show, b: Block) => `${show.title} #${b.number}`;

// A block's play button: when it ends, the show's earlier blocks follow.
// `episode`: as a "Last episode · Nov 14" pill.
const BlockButton = ({
  show,
  blocks,
  i,
  episode,
}: {
  show: Show;
  blocks: Block[];
  i: number;
  episode?: boolean;
}) => (
  <PlayButton
    src={blocks[i]!.url}
    title={blockTitle(show, blocks[i]!)}
    then={blocks.slice(i + 1).map((e) => ({ src: e.url, title: blockTitle(show, e) }))}
    episode={episode ? day(blocks[i]!.date).replace(/^\w+, /, "") : undefined}
  />
);

// Each show's latest archived block, newest first: its play button to the
// left of the show's name (linked to its page) over its description, then
// its date and length.
const LatestEpisodes = ({ shows, blocks }: { shows: Show[]; blocks: Map<string, Block[]> }) => {
  const latest = scheduled(shows)
    .filter((s) => blocks.get(s.slug)?.length)
    .sort((a, b) => blocks.get(b.slug)![0]!.date.localeCompare(blocks.get(a.slug)![0]!.date));
  return (
    <section id="episodes" class="episodes" aria-labelledby="episodes-heading">
      <h2 id="episodes-heading" class="section-label">
        Latest episodes
      </h2>
      {latest.length === 0 ? (
        <p class="muted">No episodes yet.</p>
      ) : (
        <ol class="archive-blocks">
          {latest.map((show) => {
            const list = blocks.get(show.slug)!;
            return (
              <li class="archive-block episode">
                <BlockButton show={show} blocks={list} i={0} />
                <span class="episode-info">
                  <a class="archive-title" href={`/${show.slug}`}>
                    {show.title}
                    <span class="episode-number">{` #${list[0]!.number}`}</span>
                  </a>
                  <Markdown class="station-desc" html={show.description} />
                </span>
                <span class="archive-date">{day(list[0]!.date)}</span>
                <span class="archive-length">{duration(list[0]!.seconds)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
};

// A block in a list: its play button, title, date and length.
const BlockRow = ({ show, blocks, i }: { show: Show; blocks: Block[]; i: number }) => (
  <li class="archive-block">
    <BlockButton show={show} blocks={blocks} i={i} />
    <span class="archive-title">{blockTitle(show, blocks[i]!)}</span>
    <span class="archive-date">{day(blocks[i]!.date)}</span>
    <span class="archive-length">{duration(blocks[i]!.seconds)}</span>
  </li>
);

// The track playing t seconds into an archive block, for the player (only
// that track, never a block's track list), as /now.json does live, and when
// it ends (`until`, seconds into the block; absent for the last), so the
// player asks again only then.
app.get(`/archive/:block{${BLOCK}}/now.json`, async (c) => {
  const name = c.req.param("block");
  const show = await getShow(name.slice(0, -11));
  if (!show || !(await inArchive(name))) return c.notFound();
  const t = c.req.query("t") ?? "";
  if (!/^\d+(\.\d+)?$/.test(t)) return c.text("t: seconds into the block", 400);
  const { track, until } = await trackAt(name, Number(t));
  return c.json({ ...trackJson(track), until });
});

// Also at /manifesto, its old name: /about once answered with a 301 there,
// which browsers cache and follow without asking, so for them /about still
// leads to /manifesto. (Redirecting /manifesto back to /about would loop.)
app.on("GET", ["/about", "/manifesto"], (c) => {
  const host = c.req.header("host") ?? "";
  return c.render(
    <main class="page page-about">
      <SiteHeader current="about" />
      <h1 class="display">About</h1>
      <p class="lead">A nonprofit alternative to Spotify's AI playlists.</p>
      <section class="prose" aria-label="Introduction">
        <p>
          About a third of Spotify's listeners are on playlists made by an algorithm or an AI. We want to
          replace them with a single radio station, programmed by people, and an archive of its{" "}
          <a href="/">shows</a>, one for each genre, that you can stream around the clock. No ads, no account,
          no tracking, and every play pays the artist.
        </p>
      </section>
      <section class="prose" aria-labelledby="about-law-way">
        <h2 id="about-law-way" class="label">
          Why a nonprofit can do this
        </h2>
        <p>
          A playlist is already radio: you press play and hear music you didn't choose. But Spotify licenses
          every song as if you'd picked it yourself, which costs roughly 70% of its revenue, so it has to sell
          ads, subscriptions and your attention.
        </p>
        <p>
          US law has a cheaper license for stations where the listener can't pick the song. A noncommercial
          station can play any released recording, with no label deals, for a flat fee that covers a large
          block of listening hours. It can broadcast a show and keep it in an archive for two weeks, which is
          all you need to replace a playlist. That flat fee is only for stations not run for profit, so we
          don't need ads or a big audience, only listeners who think it's worth paying for.
        </p>
      </section>
      <section class="prose" aria-labelledby="about-money">
        <h2 id="about-money" class="label">
          Every play pays the artist
        </h2>
        <p>
          Every play, live or archived, is paid through SoundExchange at the same rate, superstar or unknown.
          The law sets the split: 50% to the recording's rights owner, 45% to the featured artists (directly,
          not through their label) and 5% to session musicians and singers. Our <a href="/reports">reports</a>{" "}
          are public and show every play.
        </p>
      </section>
      <section class="prose" aria-labelledby="about-archive">
        <h2 id="about-archive" class="label">
          Every show, kept so you can hear it again
        </h2>
        <p>
          Every show is recorded as it goes out, and its latest episodes stay on the show's page for two
          weeks. Missed this morning's show? Start it from the beginning tonight. When an episode ends, the
          one before it starts, so a show you like can keep going for hours.
        </p>
      </section>
      <section class="prose" aria-labelledby="about-not">
        <h2 id="about-not" class="label">
          The trade
        </h2>
        <p>The license only holds while the station stays radio, so there are things we don't do:</p>
        <ul>
          <li>
            Pick, skip, rewind or download songs. If you want one particular song, that's what Spotify is for;
            we're replacing its playlists, not its search box.
          </li>
          <li>Whole albums or artist marathons. The license limits plays per album and artist.</li>
          <li>Algorithms or AI. People pick every song.</li>
        </ul>
        <p>
          The code that runs this station is open source, so anyone can{" "}
          <a href="#about-yours">start their own</a>.
        </p>
      </section>
      <section class="prose" aria-labelledby="about-law">
        <h2 id="about-law" class="label">
          The law
        </h2>
        <p>
          The station plays music under the statutory license for noncommercial webcasting. That license comes
          with conditions. These are the ones that shape the station, and how we keep each of them.
        </p>
        <ul>
          {LAWS.map((l) => (
            <li>
              <a href={l.url}>{l.cite}</a>: {l.what}
            </li>
          ))}
        </ul>
      </section>
      <section class="prose" aria-labelledby="about-listen">
        <h2 id="about-listen" class="label">
          Listening
        </h2>
        <p>Press play on any page, or open the stream address in a radio app or VLC.</p>
        <dl class="streams">
          <div>
            <dt class="label">Stream</dt>
            <dd>
              <a class="url" href="/stream" hx-boost="false">{`${host}/stream`}</a>
            </dd>
          </div>
          <div>
            <dt class="label">Format</dt>
            <dd>{FORMAT}</dd>
          </div>
        </dl>
      </section>
      <section class="prose" aria-labelledby="about-yours">
        <h2 id="about-yours" class="label">
          Start your own
        </h2>
        <p>
          The code that runs this station is open source, and anyone can use it to start a station of their
          own: add some music, write a page for each show, set its hours and switch it on. It's all on{" "}
          <a href={GITHUB_URL}>GitHub</a>.
        </p>
      </section>
      <section class="prose" aria-labelledby="about-contact">
        <h2 id="about-contact" class="label">
          Contact
        </h2>
        <p>
          Questions, records we should hear, takedowns:{" "}
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
  const [show, shows, recent] = await Promise.all([getShow(slug), getShows(), recentPlays(6, slug)]);
  if (!show) return c.notFound();
  const [{ show: on, play }, archived] = await Promise.all([onAir(shows), archive(shows)]);
  const blocks = archived.get(show.slug) ?? [];
  const isOn = on?.slug === show.slug;
  const now = new Date();
  const next = nextSlot(show, now);
  return c.render(
    <main class="page page-station">
      <SiteHeader />
      <section class="hero" aria-label={show.title}>
        <header class="title-block hero-head">
          {show.hours && (
            <p class={isOn ? "label on-air-label" : "label"}>
              {isOn && (
                <>
                  <span class="dot" aria-hidden="true" />
                  On air ·{" "}
                </>
              )}
              Daily <Hours show={show} now={now} />
            </p>
          )}
          <h1 class="display">{show.title}</h1>
          <Markdown class="subtitle" html={show.description} />
          <DjCredit djs={show.djs} class="title-credit" />
        </header>
        <div id="np">
          {isOn ? (
            <NowPlaying play={play} />
          ) : (
            <p class="next off-air">
              {next ? (
                <>
                  {next.start <= now ? (
                    "Starting after this track."
                  ) : (
                    <>
                      Off air. Next on at <Time at={next.start} />.
                    </>
                  )}
                </>
              ) : (
                "Not on the schedule."
              )}
            </p>
          )}
        </div>
      </section>
      {blocks.length > 0 && (
        <section class="archive-show" aria-labelledby="show-archive">
          <div class="section-head">
            <h2 id="show-archive" class="label">
              Past episodes
            </h2>
            <p class="section-note">Each plays from the start, as broadcast.</p>
          </div>
          <ol class="archive-blocks">
            {blocks.map((_, i) => (
              <BlockRow show={show} blocks={blocks} i={i} />
            ))}
          </ol>
        </section>
      )}
      <History plays={(isOn ? recent.slice(1) : recent).slice(0, 5)} />
      <Poll path={`/${show.slug}`} ids={["np", "history"]} />
    </main>,
    { title: show.title },
  );
});

app.get(`/djs/:dj{${SLUG}}`, async (c) => {
  const [dj, shows] = await Promise.all([getDj(c.req.param("dj")), getShows()]);
  if (!dj) return c.notFound();
  const [{ show: on }, blocks] = await Promise.all([onAir(shows), archive(shows)]);
  const now = new Date();
  return c.render(
    <main class="page page-dj">
      <SiteHeader />
      <section class="profile" aria-label="Profile">
        {dj.photo && <img class="cover photo" src={`/djs/${dj.slug}/photo`} alt={`Photo of ${dj.name}`} />}
        <div class="profile-text">
          <h1 class="display">{dj.name}</h1>
          {dj.tagline && <p class="subtitle">{dj.tagline}</p>}
        </div>
      </section>
      {dj.bio && <Markdown class="lead" html={dj.bio} />}
      <section class="dj-shows" aria-labelledby="dj-shows">
        <h2 id="dj-shows" class="label">
          Shows
        </h2>
        <div id="dj-shows-list" class="rows">
          {dj.shows.map((s) => (
            <ShowRow show={s} now={now} onAir={s.slug === on?.slug} blocks={blocks.get(s.slug)} />
          ))}
        </div>
      </section>
      {dj.links.length > 0 && (
        <section class="prose" aria-labelledby="dj-links">
          <h2 id="dj-links" class="label">
            Elsewhere
          </h2>
          <dl class="streams links">
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
      <Poll path={`/djs/${dj.slug}`} ids={["dj-shows-list"]} />
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

// The track on air and its show: client.ts polls it for the player bar, the
// lock screen and when to refresh the page.
app.get("/now.json", async (c) => {
  const { show, play } = await onAir(await getShows());
  return c.json(nowTrack(play, show?.title ?? SITE_TITLE));
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
