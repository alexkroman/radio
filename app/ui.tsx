// Shared page parts for the public site (DESIGN: a printed radio listing).
import type { Play } from "./plays.ts";
import type { DjRef, Show } from "./shows.ts";

export const SITE_TITLE = process.env.SITE_TITLE || "Mazes Radio";

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
  <a href="/" class="lockup" aria-label={`${SITE_TITLE}, all stations`}>
    <LogoMark />
    <span class="wordmark">{SITE_TITLE.toLowerCase()}</span>
  </a>
);

// `home`: the stations list, where the lockup is the page's <h1>.
export const SiteHeader = ({ current, home }: { current?: "stations" | "about"; home?: boolean }) => (
  <header class="site-header">
    {home ? (
      <h1>
        <Lockup />
      </h1>
    ) : (
      <Lockup />
    )}
    <nav aria-label="Main">
      <a href="/" aria-current={current === "stations" ? "page" : undefined}>
        Stations
      </a>
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

// The client (app/client.ts) finds these by data-play and shows the pause
// state on every button for the station that's playing.
export const PlayButton = ({ show, large }: { show: Show; large?: boolean }) => (
  <button
    type="button"
    class={large ? "play play-lg" : "play"}
    data-play={show.slug}
    data-title={show.title}
    aria-label={`Play ${show.title}`}
  >
    <PlayIcon size={large ? 20 : 14} d={large ? "M4.5 2.5v9l7.5-4.5z" : "M4 2.5v9l7.5-4.5z"} />
    <PauseIcon size={large ? 20 : 14} />
  </button>
);

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

export const coverUrl = (cover: string) => `/covers/${encodeURI(cover)}`;

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

// Data the client reads to fill the phone player bar for a station.
export const npData = (slug: string, play?: Play) => ({
  "data-np": slug,
  "data-track": play?.title ?? "",
  "data-artist": play?.artist ?? "",
  "data-cover": play?.cover ? coverUrl(play.cover) : "",
});

// Re-fetches the page every 15 s (and on "refresh", sent when the stream's
// metadata changes) and swaps in just the elements with these ids.
export const Poll = ({ path, ids }: { path: string; ids: string[] }) => (
  <div
    id="poll"
    hidden
    hx-get={path}
    hx-trigger="every 15s, refresh"
    hx-select="#poll"
    hx-select-oob={ids.map((id) => `#${id}`).join(",")}
    hx-target="this"
    hx-swap="outerHTML"
    hx-sync="this:replace"
  />
);

export const Time = ({ seconds }: { seconds: number }) => {
  const d = new Date(seconds * 1000);
  return (
    <time class="time" datetime={d.toISOString()}>
      {d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
    </time>
  );
};

export const Markdown = ({ html, class: cls }: { html: string; class?: string }) => (
  <div class={cls} dangerouslySetInnerHTML={{ __html: html }} />
);

// The fixed player bar for phones, outside the swapped page so it (and the
// audio) survive navigation. The client fills it in and shows it while playing.
export const PlayerBar = () => (
  <div id="bar" role="region" aria-label="Player" hidden>
    <img id="bar-cover" class="cover cover-44" alt="" hidden />
    <span id="bar-ph" class="cover cover-44 cover-ph" aria-hidden="true" />
    <div class="bar-text">
      <span id="bar-track" />
      <span class="bar-status">
        <span class="dot" aria-hidden="true" />
        <span id="bar-station" />
      </span>
    </div>
    <button type="button" id="bar-button" class="play play-bar" aria-label="Pause">
      <PauseIcon size={14} />
    </button>
  </div>
);
