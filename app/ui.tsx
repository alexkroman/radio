// Shared page parts for the public site (DESIGN: a printed radio listing).
import type { Play, Track } from "./plays.ts";
import type { DjRef } from "./shows.ts";

export const SITE_TITLE = process.env.SITE_TITLE || "Mazes Radio";

// The site's icons (app/public/): linked from every page, served from the root
// (server.tsx) and public without a login (login.tsx).
export const ICONS = [
  { rel: "icon", href: "/favicon.ico", sizes: "any" },
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
];

// The labyrinth mark (design hand-off assets/logo-mark.svg), decorative here:
// the link around it carries the name. The lines follow --color-ink (via the
// link's color), so the mark turns white in dark mode; the centre stays orange.
const LogoMark = () => (
  <svg width="24" height="24" viewBox="0 0 48 48" aria-hidden="true">
    <g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="square">
      <path d="M20 4H4V44H44V4H28" />
      <path d="M28 36H36V12H12V36H20" />
    </g>
    <rect x="20" y="20" width="8" height="8" class="mark-centre" />
  </svg>
);

export const Lockup = () => (
  <a href="/" class="lockup" aria-label={`${SITE_TITLE}, home`}>
    <LogoMark />
    <span class="wordmark">{SITE_TITLE.toLowerCase()}</span>
  </a>
);

// `home`: the home page, where the lockup is the page's <h1>.
export const SiteHeader = ({ current, home }: { current?: "about"; home?: boolean }) => (
  <header class="site-header">
    {home ? (
      <h1>
        <Lockup />
      </h1>
    ) : (
      <Lockup />
    )}
    {/* The schedule is the home page, so the lockup is its link. */}
    <nav aria-label="Main">
      <a href="/about" aria-current={current === "about" ? "page" : undefined}>
        About
      </a>
    </nav>
  </header>
);

const PlayIcon = ({ size, d }: { size: number; d: string }) => (
  <svg class="i-play" width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
    <path d={d} fill="currentColor" />
  </svg>
);

const PauseIcon = ({ size }: { size: number }) => (
  <svg class="i-pause" width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
    <rect x="3" y="2" width="2.5" height="10" fill="currentColor" />
    <rect x="8.5" y="2" width="2.5" height="10" fill="currentColor" />
  </svg>
);

// Plays the station's stream (whatever is on air), or a show's own stream
// (src /stream/<slug>, with its title and its now.json). The client (app/client.ts) finds
// these by data-play and shows the pause state on every one for what's
// playing.
export const PlayButton = ({
  large,
  src = "/stream",
  title = SITE_TITLE,
  now = "/now.json",
  status = "Live",
}: {
  large?: boolean;
  src?: string;
  title?: string;
  now?: string; // its track playing, for the player bar and lock screen
  status?: string; // the player bar's word for it
}) => {
  const size = large ? 20 : 14;
  return (
    <button
      type="button"
      class={large ? "play play-lg" : "play"}
      data-play={src}
      data-title={title}
      data-now={now}
      data-status={status}
      aria-label={`Play ${title}`}
    >
      <PlayIcon size={size} d={large ? "M4.5 2.5v9l7.5-4.5z" : "M4 2.5v9l7.5-4.5z"} />
      <PauseIcon size={size} />
    </button>
  );
};

// "with A", "with A & B", "with A, B & C": each name links to its DJ page.
export const DjCredit = ({ djs, class: cls }: { djs: DjRef[]; class: string }) =>
  djs.length === 0 ? null : (
    <p class={`credit ${cls}`}>
      with{" "}
      {djs.map((d, i) => (
        <>
          {i > 0 && (i === djs.length - 1 ? " & " : ", ")}
          <a href={`/djs/${d.slug}`}>{d.name}</a>
        </>
      ))}
    </p>
  );

const coverUrl = (cover: string) => `/covers/${encodeURI(cover)}`;

// A track's artwork, or the placeholder square when it has none.
// Decorative unless `labelled` (now-playing positions).
export const Cover = ({ play, size, labelled }: { play?: Play; size: string; labelled?: boolean }) =>
  play?.cover ? (
    <img
      class={`cover ${size}`}
      src={coverUrl(play.cover)}
      alt={labelled ? `Cover art: ${[play.title, play.artist].filter(Boolean).join(", ")}` : ""}
    />
  ) : (
    <span class={`cover ${size} cover-ph`} aria-hidden="true" />
  );

// A track as the player shows it (client.ts `Track`), in /now.json and a
// channel's /<slug>/now.json.
const trackJson = (t?: Track) => ({
  track: t?.title ?? "",
  artist: t?.artist ?? "",
  album: t?.album ?? "",
  cover: t?.cover ? coverUrl(t.cover) : "",
});

// The track on air and its show's title, in /now.json.
export const nowTrack = (play: Play | undefined, title: string) => ({ title, ...trackJson(play) });

// Re-fetches the page on "refresh" (sent by client.ts when the track playing
// on one of the `watch` streams changes: their now.json URLs, the station's
// /now.json and any show's /<slug>/now.json) and swaps in just the elements
// with these ids.
export const Poll = ({ path, ids, watch }: { path: string; ids: string[]; watch: string[] }) => (
  <div
    id="poll"
    hidden
    data-watch={watch.join(" ")}
    hx-get={path}
    hx-trigger="refresh"
    hx-select="#poll"
    hx-select-oob={ids.map((id) => `#${id}`).join(",")}
    hx-target="this"
    hx-swap="outerHTML"
    hx-sync="this:replace"
  />
);

// A time of day, in the listener's time zone once client.ts has run.
export const Time = ({ at: d }: { at: Date }) => {
  return (
    <time class="time" datetime={d.toISOString()}>
      {d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
    </time>
  );
};

export const Markdown = ({ html, class: cls }: { html: string; class?: string }) => (
  <div class={cls} dangerouslySetInnerHTML={{ __html: html }} />
);
