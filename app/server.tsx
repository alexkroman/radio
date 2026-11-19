// The web app behind Caddy: what's on air and the shows (/), each show's
// page (/<slug>), the track on air (/now.json, and on a show's channel
// /<slug>/now.json), DJ pages (/djs/<dj>),
// /about, and the SoundExchange reports (/reports). Shows are
// shows/<slug>.md (app/shows.ts), with their DJs and hours in the front matter;
// Liquidsoap plays them on their hours on the station's stream, /stream (via
// Caddy), and each around the clock on its own, /stream/<slug>.
import { archivedShows } from "./archive.ts";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { etag } from "hono/etag";
import { createMiddleware } from "hono/factory";
import type { Child } from "hono/jsx";
import { jsxRenderer } from "hono/jsx-renderer";
import { login, throttle } from "./login.tsx";
import { type Airing, latestPlay, pastAirings, type Play } from "./plays.ts";
import { reports } from "./reports.tsx";
import { nextSlot, scheduled, showAt } from "./schedule.ts";
import { getDj, getShow, getShows, type Show, SLUG } from "./shows.ts";
import {
  Cover,
  nowTrack,
  DjCredit,
  Footer,
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
// radio.liq: %mp3(bitrate = 256), the station and every show's channel.
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
    what: "archived programs must be at least five hours long and available for no more than two weeks. Each show's own stream plays only its recorded shows that meet both; shorter recordings are never played, and old ones come down automatically.",
  },
  {
    cite: "§ 114(d)(2)(C)(vi)",
    url: `${USC}/114#d_2_C_vi`,
    what: "nothing that helps listeners copy the music. There are no downloads, and no seeking or skipping.",
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
    what: "the copies a station makes in order to broadcast. This covers the recordings of its shows.",
  },
  {
    cite: "37 C.F.R. Part 380",
    url: `${CFR}/part-380`,
    what: "the rates and terms for noncommercial webcasters, set by the Copyright Royalty Judges.",
  },
  {
    cite: "37 C.F.R. Part 370",
    url: `${CFR}/part-370`,
    what: "reports of use. Every performance, on the station or a show's own stream, is reported to SoundExchange each month with the number of listeners. Ours are public.",
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
// st-artist, …).
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

// A show in a list (the home page's, a DJ page's): its own stream's play
// button (once it has an archived block) to the left of its name (linked to
// its page) over its description and the track playing on its stream; then
// its hours, after "On air" when it is.
const ShowItem = ({
  show,
  now,
  onAir,
  stream,
  playing,
}: {
  show: Show;
  now: Date;
  onAir: boolean;
  stream: boolean;
  playing?: Play;
}) => (
  <li class="item">
    {stream ? <ChannelButton show={show} /> : <span class="play-space" aria-hidden="true" />}
    <span class="item-info">
      <a class="item-title" href={`/${show.slug}`}>
        {show.title}
      </a>
      <Markdown class="desc" html={show.description} />
      <StreamTrack play={playing} />
    </span>
    <span class="item-date">
      {onAir && <OnAir />}
      <Hours show={show} now={now} />
    </span>
  </li>
);

const OnAir = () => (
  <span class="on-air">
    <span class="dot" aria-hidden="true" />
    On air
  </span>
);

// The top of the home page (the show on air) and of a show's page: "On air"
// when it is and its hours, its name, its description and its DJs.
const ShowHead = ({
  show,
  now,
  onAir,
  page,
}: {
  show: Show;
  now: Date;
  onAir: boolean;
  page?: boolean; // the show's own page: its name is the <h1>, not a link
}) => (
  <>
    <p id={page ? "show-hours" : undefined} class="label status">
      {onAir && <OnAir />}
      {onAir && show.hours && " · "}
      {show.hours && (
        <span>
          Daily <Hours show={show} now={now} />
        </span>
      )}
    </p>
    {page ? (
      <h1 class="display">{show.title}</h1>
    ) : (
      <h2 class="display">
        <a href={`/${show.slug}`}>{show.title}</a>
      </h2>
    )}
    <Markdown class="subtitle" html={show.description} />
    <DjCredit djs={show.djs} class="subtitle" />
  </>
);

// What a stream is playing: its big play button, then the track's cover and
// text. The station's on the home page (`cls` np); a show's own on its page
// (st, under "Replaying").
const NowPlaying = ({
  button,
  play,
  cls,
  label,
}: {
  button: Child;
  play?: Play;
  cls: string;
  label?: string;
}) => (
  <div class="np-block">
    {button}
    <Cover play={play} size="cover-lg" labelled />
    <div class="np-text">
      {label && <span class={`label ${cls}-label`}>{label}</span>}
      <TrackLines play={play} cls={cls} />
    </div>
  </div>
);

// A section: its heading and an optional note beside it, then its content.
const Section = ({
  id,
  heading,
  note,
  class: cls,
  children,
}: {
  id: string; // the section's (its heading's is <id>-heading)
  heading: string;
  note?: string;
  class?: string;
  children: Child;
}) => (
  <section id={id} class={cls ? `section ${cls}` : "section"} aria-labelledby={`${id}-heading`}>
    <div class="section-head">
      <h2 id={`${id}-heading`} class="heading">
        {heading}
      </h2>
      {note && <p class="section-note">{note}</p>}
    </div>
    {children}
  </section>
);

// A show's own stream: a replay of its past shows, one after another
// (radio.liq block_stream). Offered only once it has one (app/archive.ts):
// until then it's silence.
const channel = (show: Show) => `/stream/${show.slug}`;
const channelNow = (slug: string) => `/${slug}/now.json`;
const ChannelButton = ({ show, large }: { show: Show; large?: boolean }) => (
  <PlayButton
    large={large}
    src={channel(show)}
    title={show.title}
    now={channelNow(show.slug)}
    status="Replay"
  />
);

// The show on air: the newest play's (the schedule's until anything has played).
async function onAir(shows: Show[]) {
  const play = await latestPlay();
  const show = shows.find((s) => s.slug === play?.show) ?? showAt(shows, new Date());
  return { show, play: play && play.show === show?.slug ? play : undefined };
}

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
  const [{ show, play }, streams] = await Promise.all([onAir(shows), archivedShows()]);
  const playing = await streamPlays(streams);
  const now = new Date();
  return c.render(
    <main class="page page-home">
      <SiteHeader home />
      <section class="hero" aria-label="On air">
        <header id="on-air" class="hero-head">
          {show ? <ShowHead show={show} now={now} onAir /> : <h2 class="display">{SITE_TITLE}</h2>}
        </header>
        <div id="np">
          <NowPlaying button={<PlayButton large />} play={play} cls="np" />
        </div>
      </section>
      <Section id="shows" heading="Shows" note="Play any show's past shows, back to back, any time.">
        <ol class="item-list">
          {scheduled(shows, now).map((s) => (
            <ShowItem
              show={s}
              now={now}
              onAir={s.slug === show?.slug}
              stream={streams.has(s.slug)}
              playing={playing.get(s.slug)}
            />
          ))}
        </ol>
      </Section>
      <Footer host={c.req.header("host") ?? ""} />
      <Poll path="/" ids={["on-air", "np", "shows"]} watch={["/now.json", ...[...streams].map(channelNow)]} />
    </main>,
  );
});

// What's playing on each of these shows' own streams.
const streamPlays = async (slugs: Iterable<string>) =>
  new Map(await Promise.all([...slugs].map(async (s) => [s, await latestPlay(s)] as const)));

// The track playing on a show's own stream (a replay of a past show), in a
// list: its cover, then "Replaying" over its title over artist · album (all
// three, as the statutory license has us show).
const StreamTrack = ({ play }: { play?: Play }) =>
  play ? (
    <span class="stream-track">
      <Cover play={play} size="cover-40" />
      <span class="st-text">
        <span class="label st-label">Replaying</span>
        <TrackLines play={play} cls="st" />
      </span>
    </span>
  ) : null;

// "Sat, Nov 14": the station's day (TZ) an airing started.
const day = (t: number) =>
  new Date(t * 1000).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

// A past airing in a list: its day, when it ran and how many tracks it played.
const AiringRow = ({ airing }: { airing: Airing }) => (
  <li class="item item-plain">
    <span class="item-title">{day(airing.start)}</span>
    <span class="item-date">
      <Time at={new Date(airing.start * 1000)} />–<Time at={new Date(airing.end * 1000)} />
    </span>
    <span class="item-length">{`${airing.tracks} ${airing.tracks === 1 ? "track" : "tracks"}`}</span>
  </li>
);

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
          replace them with a single radio station, programmed by people, and a stream for each of its{" "}
          <a href="/">shows</a>, one for each genre, that you can listen to around the clock. No ads, no
          account, no tracking, and every play pays the artist.
        </p>
      </section>
      <section class="prose" aria-labelledby="about-law-way">
        <h2 id="about-law-way" class="heading">
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
        <h2 id="about-money" class="heading">
          Every play pays the artist
        </h2>
        <p>
          Every play, on the station or a show's own stream, is paid through SoundExchange at the same rate,
          superstar or unknown. The law sets the split: 50% to the recording's rights owner, 45% to the
          featured artists (directly, not through their label) and 5% to session musicians and singers. Our{" "}
          <a href="/reports">reports</a> are public and show every play.
        </p>
      </section>
      <section class="prose" aria-labelledby="about-channels">
        <h2 id="about-channels" class="heading">
          Every show, around the clock
        </h2>
        <p>
          Every show is recorded as it goes out, and its own stream plays its recent shows, one after another,
          around the clock, for two weeks. Missed this morning's show? Its stream is playing it, or one like
          it, tonight. A show's page lists when it was on the station.
        </p>
      </section>
      <section class="prose" aria-labelledby="about-not">
        <h2 id="about-not" class="heading">
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
        <h2 id="about-law" class="heading">
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
        <h2 id="about-listen" class="heading">
          Listening
        </h2>
        <p>
          Press play on any page, or open the stream address in a radio app or VLC. Each show also has its own
          stream of its recent shows, around the clock: its address is at the foot of its page.
        </p>
        <dl class="streams">
          <div>
            <dt>Stream</dt>
            <dd>
              <a class="url" href="/stream" hx-boost="false">{`${host}/stream`}</a>
            </dd>
          </div>
          <div>
            <dt>Format</dt>
            <dd>{FORMAT}</dd>
          </div>
        </dl>
      </section>
      <section class="prose" aria-labelledby="about-yours">
        <h2 id="about-yours" class="heading">
          Start your own
        </h2>
        <p>
          The code that runs this station is open source, and anyone can use it to start a station of their
          own: add some music, write a page for each show, set its hours and switch it on. It's all on{" "}
          <a href={GITHUB_URL}>GitHub</a>.
        </p>
      </section>
      <section class="prose" aria-labelledby="about-contact">
        <h2 id="about-contact" class="heading">
          Contact
        </h2>
        <p>
          Questions, records we should hear, takedowns:{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
      </section>
      <Footer host={host} />
    </main>,
    { title: "About" },
  );
});

app.get(`/:slug{${SLUG}}`, async (c) => {
  const slug = c.req.param("slug");
  const [show, shows] = await Promise.all([getShow(slug), getShows()]);
  if (!show) return c.notFound();
  const [{ show: on }, past, streams, playing] = await Promise.all([
    onAir(shows),
    pastAirings(show.slug),
    archivedShows(),
    latestPlay(show.slug),
  ]);
  const stream = streams.has(show.slug);
  return c.render(
    <main class="page">
      <SiteHeader />
      <section class="hero" aria-label={show.title}>
        <header class="hero-head title-block">
          <ShowHead show={show} now={new Date()} onAir={on?.slug === show.slug} page />
        </header>
        {/* Its own stream: a replay of its past shows. */}
        {stream && (
          <div id="channel">
            <NowPlaying
              button={<ChannelButton show={show} large />}
              play={playing}
              cls="st"
              label="Replaying"
            />
          </div>
        )}
      </section>
      <Section id="past" heading="Past shows" note="When it was on the station, the last two weeks.">
        <>
          {past.length === 0 ? (
            <p class="muted">Not on the station in the last two weeks.</p>
          ) : (
            <ol class="item-list">
              {past.map((a) => (
                <AiringRow airing={a} />
              ))}
            </ol>
          )}
        </>
      </Section>
      <Footer host={c.req.header("host") ?? ""} path={stream ? channel(show) : undefined} />
      <Poll
        path={`/${show.slug}`}
        ids={["show-hours", "channel", "past"]}
        watch={["/now.json", ...(stream ? [channelNow(show.slug)] : [])]}
      />
    </main>,
    { title: show.title },
  );
});

app.get(`/djs/:dj{${SLUG}}`, async (c) => {
  const [dj, shows] = await Promise.all([getDj(c.req.param("dj")), getShows()]);
  if (!dj) return c.notFound();
  const [{ show: on }, streams] = await Promise.all([onAir(shows), archivedShows()]);
  const mine = dj.shows.filter((s) => streams.has(s.slug)).map((s) => s.slug);
  const playing = await streamPlays(mine);
  const now = new Date();
  return c.render(
    <main class="page">
      <SiteHeader />
      <section class="profile" aria-label="Profile">
        {dj.photo && <img class="cover photo" src={`/djs/${dj.slug}/photo`} alt={`Photo of ${dj.name}`} />}
        <div class="profile-text">
          <h1 class="display">{dj.name}</h1>
          {dj.tagline && <p class="subtitle">{dj.tagline}</p>}
        </div>
      </section>
      {dj.bio && <Markdown class="lead" html={dj.bio} />}
      <Section id="dj-shows" heading="Shows" class="dj-shows">
        <ol id="dj-shows-list" class="item-list">
          {dj.shows.map((s) => (
            <ShowItem
              show={s}
              now={now}
              onAir={s.slug === on?.slug}
              stream={streams.has(s.slug)}
              playing={playing.get(s.slug)}
            />
          ))}
        </ol>
      </Section>
      {dj.links.length > 0 && (
        <Section id="dj-links" heading="Elsewhere">
          <dl class="links">
            {dj.links.map((l) => (
              <div>
                <dt>{l.label}</dt>
                <dd>
                  <a class="url" href={l.url} rel="me noopener" hx-boost="false">
                    {l.url.replace(/^https?:\/\//i, "").replace(/\/$/, "")}
                  </a>
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      )}
      <Footer host={c.req.header("host") ?? ""} />
      <Poll path={`/djs/${dj.slug}`} ids={["dj-shows-list"]} watch={["/now.json", ...mine.map(channelNow)]} />
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

// The track playing on a stream and its show's title: on the station
// (/now.json, the show on air) or a show's own (/<slug>/now.json, its newest
// play there). client.ts polls them for the player bar, the lock screen and
// when to refresh the page.
app.on("GET", ["/now.json", `/:slug{${SLUG}}/now.json`], async (c) => {
  const slug = c.req.param("slug");
  if (!slug) {
    const { show, play } = await onAir(await getShows());
    return c.json(nowTrack(play, show?.title ?? SITE_TITLE));
  }
  const show = await getShow(slug);
  return show ? c.json(nowTrack(await latestPlay(slug), show.title)) : c.notFound();
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
