// The web app behind Caddy: what's on air and the schedule (/), each show's
// page (/<slug>), the track on air (/now.json), DJ pages (/djs/<dj>),
// /about, and the SoundExchange reports (/reports). Shows are
// shows/<slug>.md (app/shows.ts), with their DJs and hours in the front matter;
// Liquidsoap plays them on their hours on the one stream, /stream (via Caddy).
import { archive, BLOCK, type Block, day, duration, trackAt } from "./archive.ts";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { etag } from "hono/etag";
import { createMiddleware } from "hono/factory";
import { jsxRenderer } from "hono/jsx-renderer";
import { login, throttle } from "./login.tsx";
import { latestPlay, type Play, recentPlays } from "./plays.ts";
import { reports } from "./reports.tsx";
import { nextSlot, scheduled, showAt, upNext } from "./schedule.ts";
import { getDj, getShow, getShows, type Show, SLUG } from "./shows.ts";
import {
  Cover,
  coverUrl,
  nowTrack,
  DjCredit,
  ICONS,
  Markdown,
  PlayButton,
  Poll,
  SITE_TITLE,
  SiteHeader,
  Time,
} from "./ui.tsx";

const COVERS = process.env.COVERS_DIR ?? "/covers";
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "alex@mazesradio.com";
const GITHUB_URL = "https://github.com/alexkroman/radio";
// radio.liq: %mp3(bitrate = 256), the stream and the archive both.
const FORMAT = "MP3 · 256 kbps";

// The law the station plays music under, for the About page: each provision,
// where to read it, and how the station keeps it.
const USC = "https://www.law.cornell.edu/uscode/text/17";
const CFR = "https://www.law.cornell.edu/cfr/text/37";
const LAWS = [
  {
    cite: "17 U.S.C. § 114(d)(2)",
    url: `${USC}/114#d_2`,
    what: "the statutory license for noncommercial webcasting, which lets the station play any released recording without a deal with its label, on the conditions below.",
  },
  {
    cite: "§ 114(j)(13)",
    url: `${USC}/114#j_13`,
    what: "the sound recording performance complement: in any three hours, no more than 4 tracks by one artist (3 in a row) or 3 from one album (2 in a row). The station checks every track before it plays, and won't play one that would break it.",
  },
  {
    cite: "§ 114(d)(2)(C)(ii)",
    url: `${USC}/114#d_2_C_ii`,
    what: "no schedule of upcoming songs or artists. The schedule names shows, never what they'll play.",
  },
  {
    cite: "§ 114(d)(2)(C)(iii)",
    url: `${USC}/114#d_2_C_iii`,
    what: "archived programs are at least five hours long and up for less than two weeks. Shorter recordings are never published, and old ones come down automatically.",
  },
  {
    cite: "§ 114(d)(2)(C)(vi)",
    url: `${USC}/114#d_2_C_vi`,
    what: "nothing that helps listeners copy the music: no downloads, and no seeking or skipping in the archive.",
  },
  {
    cite: "§ 114(d)(2)(C)(ix)",
    url: `${USC}/114#d_2_C_ix`,
    what: "each track's title, album and artist shown while it plays, but not before: on the site, on your lock screen, and in the stream for radio apps.",
  },
  {
    cite: "§ 114(g)(2)",
    url: `${USC}/114#g_2`,
    what: "how the royalties are split: 50% to the rights owner, 45% to the featured artists, 5% to session musicians and singers, paid through SoundExchange.",
  },
  {
    cite: "17 U.S.C. § 112(e)",
    url: `${USC}/112#e`,
    what: "the copies a station makes to broadcast, which covers the archive's recordings.",
  },
  {
    cite: "37 C.F.R. Part 380",
    url: `${CFR}/part-380`,
    what: "the rates and terms for noncommercial webcasters, set by the Copyright Royalty Judges.",
  },
  {
    cite: "37 C.F.R. Part 370",
    url: `${CFR}/part-370`,
    what: "reports of use: every performance, live or archived, with its listeners, reported to SoundExchange each month. Ours are public.",
  },
];

// Questions about what the license allows, for the About page.
const FAQ = [
  {
    q: "Why can't I see what's coming up next?",
    a: "The license forbids announcing songs or artists before they play (§ 114(d)(2)(C)(ii)). We can tell you which show is on next, but not what it will play.",
  },
  {
    q: "Why does a show's page list what's played, but the archive doesn't list a show's tracks?",
    a: "A list of what has already played on air is fine: those songs have been performed. An archived show hasn't played for you yet, so its track list would announce songs before they play. The archive shows each track, with its album and artist, while it plays.",
  },
  {
    q: "Why can't I pick a song, skip or rewind?",
    a: "Choosing songs would make this an interactive service (§ 114(j)(7)), which the statutory license doesn't cover: every song would need a deal with its label. We leave out skipping and rewinding too, so the station stays radio and the archive plays shows as they were broadcast.",
  },
  {
    q: "Why can't I download a show?",
    a: "The license requires us not to help listeners make copies (§ 114(d)(2)(C)(vi)). You can listen as often as you like while a show is in the archive.",
  },
  {
    q: "Why are archived shows only up for two weeks, and why only whole shows?",
    a: "An archived program has to be at least five hours long and can't be offered for more than two weeks (§ 114(d)(2)(C)(iii)). A show cut short, by a restart say, isn't archived.",
  },
  {
    q: "Why won't you play a whole album, or an hour of one artist?",
    a: "The performance complement (§ 114(j)(13)): in any three hours, at most 3 tracks from one album, 2 in a row, and 4 by one artist, 3 in a row. The station won't play a track that would break it, even if a show goes quiet for a moment.",
  },
  {
    q: "Why does every song show its album?",
    a: "The license requires each recording to be identified by title, album and featured artist while it plays (§ 114(d)(2)(C)(ix)).",
  },
  {
    q: "Do artists get paid when I listen to the archive?",
    a: "Yes. Every track you reach in an archived show counts as a performance in our monthly SoundExchange report, the same as live.",
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

// One show in a list: the schedule (with its DJs) or a DJ's page (without,
// since the DJ is the page's subject).
const ShowRow = ({
  show,
  now,
  onAir,
  credit,
}: {
  show: Show;
  now: Date;
  onAir: boolean;
  credit?: boolean;
}) => (
  <div class="station">
    <span class="station-hours">
      <Hours show={show} now={now} />
    </span>
    <div class="station-info">
      <a class="station-name" href={`/${show.slug}`}>
        {show.title}
      </a>
      <Markdown class="station-desc" html={show.description} />
      {credit && <DjCredit djs={show.djs} class="station-credit" />}
    </div>
    {onAir && (
      <span class="label on-air">
        <span class="dot" aria-hidden="true" />
        On air
      </span>
    )}
  </div>
);

// The track on air: its cover and text, with the play button.
const NowPlaying = ({ play }: { play?: Play }) => (
  <section class="np-block" aria-label="Now playing">
    <PlayButton large />
    <div class="np">
      <Cover play={play} size="cover-120" labelled />
      <div class="np-text">
        <span class="label np-status">
          <span class="dot" aria-hidden="true" />
          <span data-status>Live</span>
        </span>
        <TrackLines play={play} cls="np" />
      </div>
    </div>
  </section>
);

// The stream's address, to copy into a radio app.
const StreamUrl = ({ host }: { host: string }) => (
  <section class="stream" aria-label="Stream URL">
    <span class="label stream-label">Stream</span>
    <a class="url" href="/stream" hx-boost="false">{`${host}/stream`}</a>
    <button type="button" class="copy" data-copy={`https://${host}/stream`}>
      Copy
    </button>
  </section>
);

// The show on air: the newest play's (the schedule's until anything has played).
async function onAir(shows: Show[]) {
  const play = await latestPlay();
  const show = shows.find((s) => s.slug === play?.show) ?? showAt(shows, new Date());
  return { show, play: play && play.show === show?.slug ? play : undefined };
}

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
            <Time at={new Date(p.time * 1000)} />
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
  const [{ show, play }, recent, blocks] = await Promise.all([onAir(shows), recentPlays(11), archive()]);
  // The newest block of any show (by its date, then its show's start hour),
  // then that show's earlier ones.
  const started = (b: Block) =>
    `${b.date} ${String(shows.find((s) => s.slug === b.show)?.hours?.[0] ?? 0).padStart(2, "0")}`;
  const newest = [...blocks.values()]
    .map((b) => b[0]!)
    .sort((a, b) => started(b).localeCompare(started(a)))[0];
  const latestShow = newest && shows.find((s) => s.slug === newest.show);
  const latest = latestShow && { show: latestShow, blocks: blocks.get(latestShow.slug)! };
  const now = new Date();
  const next = upNext(shows, now);
  return c.render(
    <main class="page page-station page-home">
      <SiteHeader current="home" home />
      <header id="on-air" class="title-block">
        <span class="label">On air</span>
        {show ? (
          <>
            <h2 class="display">
              <a href={`/${show.slug}`}>{show.title}</a>
            </h2>
            <Markdown class="subtitle" html={show.description} />
            <DjCredit djs={show.djs} class="title-credit" />
          </>
        ) : (
          <h2 class="display">{SITE_TITLE}</h2>
        )}
      </header>
      <div id="np">
        <NowPlaying play={play} />
      </div>
      <p id="next" class="next">
        {next && (
          <>
            Up next: <a href={`/${next.show.slug}`}>{next.show.title}</a> at <Time at={next.start} />
          </>
        )}
      </p>
      {latest && (
        <section class="latest" aria-labelledby="latest-heading">
          <h2 id="latest-heading" class="label">
            Latest archive
          </h2>
          <div class="archive-blocks">
            <div class="archive-block">
              <BlockButton show={latest.show} blocks={latest.blocks} i={0} />
              <span class="archive-title">
                <a href={`/${latest.show.slug}`}>{latest.show.title}</a>
              </span>
              <span class="archive-date">{day(latest.blocks[0]!.date)}</span>
              <span class="archive-length">{duration(latest.blocks[0]!.seconds)}</span>
              <a class="archive-more" href="/archive">
                All archives
              </a>
            </div>
          </div>
        </section>
      )}
      <StreamUrl host={c.req.header("host") ?? ""} />
      <section id="schedule" class="schedule" aria-labelledby="schedule-heading">
        <h2 id="schedule-heading" class="label">
          Schedule
        </h2>
        <div class="stations">
          {scheduled(shows).map((s) => (
            <ShowRow show={s} now={now} onAir={s.slug === show?.slug} credit />
          ))}
        </div>
      </section>
      <History plays={recent.slice(1)} />
      <Poll path="/" ids={["on-air", "np", "next", "schedule", "history"]} />
    </main>,
  );
});

// An archive block's title, as its play button and the player show it.
const blockTitle = (show: Show, b: Block) => `${show.title}, ${day(b.date)}`;

// A block's play button: when it ends, the show's earlier blocks follow.
const BlockButton = ({
  show,
  blocks,
  i,
  large,
}: {
  show: Show;
  blocks: Block[];
  i: number;
  large?: boolean;
}) => (
  <PlayButton
    large={large}
    src={blocks[i]!.url}
    title={blockTitle(show, blocks[i]!)}
    then={blocks.slice(i + 1).map((b) => ({ src: b.url, title: blockTitle(show, b) }))}
  />
);

// Each show's recorded blocks, newest first, played (from the beginning, no
// seeking) in the site's player, which shows each track while it plays. No
// track lists: a block is its show, date and length.
app.get("/archive", async (c) => {
  const [shows, blocks] = await Promise.all([getShows(), archive()]);
  const listed = scheduled(shows).filter((s) => blocks.has(s.slug));
  return c.render(
    <main class="page page-station page-archive">
      <SiteHeader current="archive" />
      <header class="title-block">
        <h1 class="display">Archive</h1>
        <p class="subtitle">
          Recent shows as broadcast, for up to two weeks. Each plays from the start, then the show before it.
        </p>
      </header>
      {listed.length === 0 ? (
        <p class="muted">Nothing recorded yet.</p>
      ) : (
        listed.map((show) => (
          <section class="archive-show" aria-labelledby={`archive-${show.slug}`}>
            <h2 id={`archive-${show.slug}`} class="label">
              {show.title}
            </h2>
            <ol class="archive-blocks">
              {blocks.get(show.slug)!.map((b, i, all) => (
                <li class="archive-block">
                  <BlockButton show={show} blocks={all} i={i} />
                  <span class="archive-title">
                    <a href={`/${show.slug}`}>{show.title}</a>
                  </span>
                  <span class="archive-date">{day(b.date)}</span>
                  <span class="archive-length">{duration(b.seconds)}</span>
                </li>
              ))}
            </ol>
          </section>
        ))
      )}
    </main>,
    { title: "Archive" },
  );
});

// The track playing t seconds into an archive block, for the player (only
// that track: never a block's track list). As /now.json.
app.get(`/archive/:block{${BLOCK}}/now.json`, async (c) => {
  const name = c.req.param("block");
  const blocks = [...(await archive()).values()].flat();
  if (!blocks.some((b) => b.name === name)) return c.notFound();
  const t = c.req.query("t") ?? "";
  if (!/^\d+(\.\d+)?$/.test(t)) return c.text("t: seconds into the block", 400);
  const track = await trackAt(name, Number(t));
  return c.json({
    track: track?.title ?? "",
    artist: track?.artist ?? "",
    album: track?.album ?? "",
    cover: track?.cover ? coverUrl(track.cover) : "",
  });
});

app.get("/about", (c) => {
  const host = c.req.header("host") ?? "";
  return c.render(
    <main class="page page-about">
      <SiteHeader current="about" />
      <h1 class="display">About</h1>
      <p class="lead">Public radio for the streaming era: a nonprofit alternative to Spotify.</p>
      <section class="prose" aria-labelledby="about-why">
        <h2 id="about-why" class="label">
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
      <section class="prose" aria-labelledby="about-how">
        <h2 id="about-how" class="label">
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
      <section class="prose" aria-labelledby="about-what">
        <h2 id="about-what" class="label">
          What it is
        </h2>
        <p>
          One station playing around the clock, a few <a href="/">shows</a> a day, each programmed by a
          person: music for work, driving, cooking, the background of a day. No ads. No account. No tracking.
        </p>
        <p>It isn't trying to be a better Spotify. It's trying to be what Spotify's business can't be.</p>
      </section>
      <section class="prose" aria-labelledby="about-money">
        <h2 id="about-money" class="label">
          Where the money goes
        </h2>
        <p>
          Through SoundExchange, every play pays the same rate, superstar or unknown. The law sets the split:
          50% to the rights owner, 45% straight to the featured artists rather than through their label, and
          5% to session musicians and singers. On Spotify, most of the money goes to the top artists, through
          label deals.
        </p>
        <p>
          When the station plays a band, live or from the archive, the band gets paid, directly, at the same
          rate as anyone else. Our <a href="/reports">reports</a> show every play.
        </p>
      </section>
      <section class="prose" aria-labelledby="about-not">
        <h2 id="about-not" class="label">
          What we don't do
        </h2>
        <ul>
          <li>
            On-demand, offline or personal libraries. The license forbids them, so this complements Spotify
            rather than replacing it.
          </li>
          <li>
            Artist marathons or whole albums. The license limits how many tracks from one artist or album can
            play in three hours, and in a row.
          </li>
          <li>Algorithms. People pick every song.</li>
          <li>
            Ads, or selling your data. Listening is free and untracked. The station runs on listeners who
            choose to pay, which is enough because the costs are flat.
          </li>
        </ul>
      </section>
      <section class="prose" aria-labelledby="about-archive">
        <h2 id="about-archive" class="label">
          The archive
        </h2>
        <p>
          Every show is recorded as it goes out, start to finish, at the same quality as the stream. The{" "}
          <a href="/archive">archive</a> keeps the latest of each show for you to hear again, from the
          beginning, as it was broadcast: each track, its album and its artist show as it plays, and when a
          show ends, the one before it starts. Archived shows are at least five hours long and come down
          before they've been up two weeks. You can't skip, rewind or download them, and archive plays pay the
          artists like any other.
        </p>
      </section>
      <section class="prose" aria-labelledby="about-law">
        <h2 id="about-law" class="label">
          The law
        </h2>
        <p>
          The station plays music under the statutory license for noncommercial webcasting, which comes with
          conditions. These are the ones we keep, and how:
        </p>
        <ul>
          {LAWS.map((l) => (
            <li>
              <a href={l.url}>{l.cite}</a>: {l.what}
            </li>
          ))}
        </ul>
      </section>
      <section class="prose faq" aria-labelledby="about-faq">
        <h2 id="about-faq" class="label">
          Questions
        </h2>
        {FAQ.map((q) => (
          <>
            <h3>{q.q}</h3>
            <p>{q.a}</p>
          </>
        ))}
      </section>
      <section class="prose" aria-labelledby="about-listen">
        <h2 id="about-listen" class="label">
          Listening
        </h2>
        <p>Press play, or open the stream URL in a radio app or VLC.</p>
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
          The code that runs this station is open source. Anyone can use it to start their own: add some
          music, write a page for each show, give it its hours and switch it on. It's all on{" "}
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
  const [show, shows, recent] = await Promise.all([getShow(slug), getShows(), recentPlays(11, slug)]);
  if (!show) return c.notFound();
  const { show: on, play } = await onAir(shows);
  const isOn = on?.slug === show.slug;
  const next = nextSlot(show, new Date());
  return c.render(
    <main class="page page-station">
      <SiteHeader />
      <header class="title-block">
        <h1 class="display">{show.title}</h1>
        <Markdown class="subtitle" html={show.description} />
        <DjCredit djs={show.djs} class="title-credit" />
        {show.hours && (
          <p class="label">
            Daily <Hours show={show} now={new Date()} />
          </p>
        )}
      </header>
      <div id="np">
        {isOn ? (
          <NowPlaying play={play} />
        ) : (
          <p class="next">
            {next ? (
              <>
                Off air. Next on at <Time at={next.start} />.
              </>
            ) : (
              "Not on the schedule."
            )}
          </p>
        )}
      </div>
      <History plays={isOn ? recent.slice(1) : recent} />
      <Poll path={`/${show.slug}`} ids={["np", "history"]} />
    </main>,
    { title: show.title },
  );
});

app.get(`/djs/:dj{${SLUG}}`, async (c) => {
  const [dj, shows] = await Promise.all([getDj(c.req.param("dj")), getShows()]);
  if (!dj) return c.notFound();
  const { show: on } = await onAir(shows);
  const now = new Date();
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
        <div id="dj-shows-list" class="stations">
          {dj.shows.map((s) => (
            <ShowRow show={s} now={now} onAir={s.slug === on?.slug} />
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
