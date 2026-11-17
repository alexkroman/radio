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

// Questions about what the license allows, for the About page.
const FAQ = [
  {
    q: "Why can't I see what's coming up next?",
    a: "The license forbids announcing songs or artists before they play (§ 114(d)(2)(C)(ii)). We can tell you which show is on next, but not what it will play.",
  },
  {
    q: "Why does a show's page list what has played on air, but not the tracks in an archived episode?",
    a: "Songs that have played on air have already been performed, so listing them is fine. An archived episode hasn't played for you yet, so its track list would announce songs before you hear them. Instead, the archive shows each track's title, album and artist while it plays.",
  },
  {
    q: "Why can't I pick a song, skip or rewind?",
    a: "Letting you choose songs would make this an interactive service (§ 114(j)(7)), which the statutory license doesn't cover: every song would need a deal with its label. We leave out skipping and rewinding too, so the station stays radio and the archive plays shows as they were broadcast.",
  },
  {
    q: "Why can't I download a show?",
    a: "The license requires that we not help listeners make copies (§ 114(d)(2)(C)(vi)). You can listen as often as you like while a show is in the archive.",
  },
  {
    q: "Why are archived shows only up for two weeks, and why only whole shows?",
    a: "An archived program must be at least five hours long and can't be offered for more than two weeks (§ 114(d)(2)(C)(iii)). A show that gets cut short, by a restart for example, isn't archived.",
  },
  {
    q: "Why won't you play a whole album, or an hour of one artist?",
    a: "The performance complement (§ 114(j)(13)) limits any three hours to 3 tracks from one album (2 in a row) and 4 by one artist (3 in a row). The station won't play a track that would exceed the limit, even if that means a show goes quiet for a moment.",
  },
  {
    q: "Why does every song show its album?",
    a: "The license requires each recording to be identified by title, album and featured artist while it plays (§ 114(d)(2)(C)(ix)).",
  },
  {
    q: "Do artists get paid when I listen to the archive?",
    a: "Yes. Every track you reach in an archived show counts as a performance in our monthly SoundExchange report, the same as a live play.",
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
      <h1 class="display">About {SITE_TITLE}</h1>
      <p class="lead">Public radio for the streaming era: a nonprofit alternative to Spotify.</p>
      <section class="prose" aria-label="Introduction">
        <p>
          {SITE_TITLE} is one station, on around the clock, where a person picks every song. Every show is
          kept in an archive, so you can hear it again from the start, exactly as it went out. No ads. No
          account. No tracking. Every play, live or archived, pays the artist directly, at the same rate for a
          superstar as for a band you've never heard of.
        </p>
        <p>It isn't trying to be a better Spotify. It's trying to be what Spotify's business can't be.</p>
      </section>
      <section class="prose" aria-labelledby="about-radio">
        <h2 id="about-radio" class="label">
          What radio got right
        </h2>
        <p>
          Radio was free to anyone with a receiver. Everyone heard the same song at the same moment, a person
          had chosen it, and how it was paid for was public. You didn't need an account, and nobody kept a
          record of what you heard.
        </p>
        <p>
          Streaming gave us almost any song on demand and took the rest away. You need an account. Every play
          is reported back to a company. Ads are mixed in with the music. Algorithms choose songs to keep you
          listening longer, not because the songs are good. And subscription money goes into one pool, most of
          which is paid out to the biggest artists.
        </p>
        <p>
          Listeners didn't choose this; licensing costs did. On-demand music costs so much to license that
          only companies selling attention at scale can afford the catalogue.
        </p>
        <p>The way a culture hears its music shouldn't have to be an advertising product.</p>
      </section>
      <section class="prose" aria-labelledby="about-law-way">
        <h2 id="about-law-way" class="label">
          The way out is already in the law
        </h2>
        <p>
          Spotify pays roughly 70% of its revenue for on-demand licenses, on every stream, for as long as it
          runs. But US copyright law has another license, a statutory one, for stations where the listener
          can't pick the song. Give up that one thing and everything else changes:
        </p>
        <ul>
          <li>Every released recording is licensed from day one. No label deals, no holdouts.</li>
          <li>
            The cost is flat. A noncommercial station pays a minimum fee per channel, which covers a large
            block of listening hours. Until the station outgrows that block, one more listener costs nothing.
          </li>
          <li>
            Nobody else is owed anything. Nobody takes a cut of revenue, and no shareholder is owed growth.
          </li>
        </ul>
        <p>
          So the station doesn't need a big audience to survive. It doesn't have to grow, sell ads or hold
          your attention. It only has to be worth paying for to the listeners who choose to pay.
        </p>
      </section>
      <section class="prose" aria-labelledby="about-money">
        <h2 id="about-money" class="label">
          Every play pays the artist
        </h2>
        <p>
          Royalties are paid through SoundExchange, and every play pays the same rate, superstar or unknown.
          The law sets the split:
        </p>
        <ul>
          <li>50% to the recording's rights owner</li>
          <li>45% to the featured artists, paid to them directly rather than through their label</li>
          <li>5% to session musicians and singers</li>
        </ul>
        <p>
          On Spotify, the money goes through label deals, and most of it reaches the top artists. Here,
          whenever the station plays a band, on the live stream or in an archived show, the band is paid
          directly, at the same rate as everyone else. You don't have to take our word for it: our{" "}
          <a href="/reports">reports</a> are public and show every play.
        </p>
      </section>
      <section class="prose" aria-labelledby="about-what">
        <h2 id="about-what" class="label">
          What you hear
        </h2>
        <p>
          A few <a href="/">shows</a> a day, each programmed by a person: music for working, driving, cooking,
          the background of a day. Press play and you're hearing what everyone else tuned in is hearing.
        </p>
      </section>
      <section class="prose" aria-labelledby="about-archive">
        <h2 id="about-archive" class="label">
          Every show, kept so you can hear it again
        </h2>
        <p>
          Radio used to vanish as it aired. Here, every show is recorded in full as it goes out, at the same
          quality as the stream, and its latest episodes stay on the show's page. Missed this morning's show?
          Start it from the beginning tonight, exactly as it was broadcast. Each track's title, album and
          artist appear as it plays, and when an episode ends, the one before it starts, so a show you like
          can keep going for hours.
        </p>
        <p>
          An archived show plays the way radio does: at least five hours long, with no skipping, rewinding or
          downloading, and it comes down within two weeks. Those are the license's conditions for an archive,
          and keeping them means archive plays pay artists just as live plays do.
        </p>
      </section>
      <section class="prose" aria-labelledby="about-not">
        <h2 id="about-not" class="label">
          The trade
        </h2>
        <p>All of this depends on the station staying radio, so there are things we don't do:</p>
        <ul>
          <li>
            On-demand listening, offline listening or personal libraries. The license forbids them, so the
            station complements Spotify rather than replacing it.
          </li>
          <li>
            Artist marathons or whole albums. The license limits how many tracks from one artist or one album
            can play within three hours, and how many in a row.
          </li>
          <li>Algorithms. People pick every song.</li>
          <li>
            Ads, or selling your data. Listening is free and untracked. The station is paid for by listeners
            who choose to pay, which is enough because its costs are flat.
          </li>
        </ul>
        <p>
          That's the whole trade. You give up choosing the song. In return you get music chosen by people,
          shows you can catch up on for two weeks, and a station that pays every artist the same rate and
          doesn't watch you listen.
        </p>
        <p>
          And it doesn't have to be the only one. The code that runs this station is open source, so anyone
          can <a href="#about-yours">start their own</a>.
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
