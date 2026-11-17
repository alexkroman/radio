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

// Plays the stream (whatever is on air), or an archive block (src, with its
// title, and the blocks to play after it: the show's earlier ones, newest
// first). The client (app/client.ts) finds these by data-play and shows the
// pause state on every one for what's playing. `episode` (the block's date)
// makes it a pill: "Last episode · Nov 14", then "Paused · Nov 14" once
// started (client.ts marks it .current), "Playing last episode" while it plays.
export const PlayButton = ({
  large,
  src = "/stream",
  title = SITE_TITLE,
  then,
  episode,
}: {
  large?: boolean;
  src?: string;
  title?: string;
  then?: { src: string; title: string }[];
  episode?: string;
}) => {
  const size = large ? 20 : episode ? 12 : 14;
  return (
    <button
      type="button"
      class={large ? "play play-lg" : episode ? "play pill" : "play"}
      data-play={src}
      data-title={title}
      data-then={then?.length ? JSON.stringify(then) : undefined}
      aria-label={`Play ${title}`}
    >
      <PlayIcon size={size} d={large ? "M4.5 2.5v9l7.5-4.5z" : "M4 2.5v9l7.5-4.5z"} />
      <PauseIcon size={size} />
      {episode && (
        <>
          <span class="pill-text">
            <span class="pill-idle">Last episode</span>
            <span class="pill-paused">Paused</span>
            {` · ${episode}`}
          </span>
          <span class="pill-playing">Playing last episode</span>
        </>
      )}
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

// A track as the player shows it (client.ts `Track`): live in /now.json, and
// in an archive block's now.json.
export const trackJson = (t?: Track) => ({
  track: t?.title ?? "",
  artist: t?.artist ?? "",
  album: t?.album ?? "",
  cover: t?.cover ? coverUrl(t.cover) : "",
});

// The track on air and its show's title, in /now.json.
export const nowTrack = (play: Play | undefined, title: string) => ({ title, ...trackJson(play) });

// Re-fetches the page on "refresh" (sent by client.ts when the track on air
// changes) and swaps in just the elements with these ids.
export const Poll = ({ path, ids }: { path: string; ids: string[] }) => (
  <div
    id="poll"
    hidden
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
