/** @jsxImportSource hono/jsx/dom */
// The fixed player bar, rendered in the browser with hono/jsx/dom
// into #player (outside the swapped page, so it and the audio survive
// navigation). app/client.ts sets what it shows with setBar(); it shows only
// while a station is playing.
import { render, useLayoutEffect, useRef, useState } from "hono/jsx/dom";

export type BarState = { title: string; track: string; artist: string; cover: string };

// What the bar shows, and its setter once it has rendered (one bar per page).
let state: BarState | undefined;
let setState: ((s: BarState | undefined) => void) | undefined;
export function setBar(s: BarState | undefined) {
  state = s;
  setState?.(s);
}

// The placeholder square until (and unless) the cover loads. Keyed by src, so
// a new cover starts out as the placeholder again.
function Cover({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  // A cached image can finish loading before onLoad is attached.
  useLayoutEffect(() => {
    if (img.current?.complete && img.current.naturalWidth) setLoaded(true);
  }, []);
  return (
    <>
      <img
        ref={img}
        class="cover cover-44"
        src={src}
        alt={alt}
        hidden={!loaded}
        onLoad={() => setLoaded(true)}
      />
      {!loaded && <span class="cover cover-44 cover-ph" aria-hidden="true" />}
    </>
  );
}

function Bar({ onPause }: { onPause: () => void }) {
  const [s, set] = useState(state);
  setState = set;
  if (!s) return null;
  const parts = [s.track, s.artist].filter(Boolean);
  return (
    <div id="bar" role="region" aria-label="Player">
      <Cover key={s.cover} src={s.cover} alt={s.track ? `Cover art: ${parts.join(", ")}` : ""} />
      <div class="bar-text">
        <span id="bar-track">{parts.join(" · ")}</span>
        <span class="bar-status">
          <span class="dot" aria-hidden="true" />
          <span>{`${s.title} · Live`}</span>
        </span>
      </div>
      <button type="button" class="play play-bar" aria-label={`Pause ${s.title}`} onClick={onPause}>
        {/* ui.tsx PauseIcon (server JSX, so not shared). */}
        <svg class="i-pause" width={14} height={14} viewBox="0 0 14 14" aria-hidden="true">
          <rect x="3" y="2" width="2.5" height="10" fill="currentColor" />
          <rect x="8.5" y="2" width="2.5" height="10" fill="currentColor" />
        </svg>
      </button>
    </div>
  );
}

export function mountBar(el: HTMLElement, onPause: () => void) {
  render(<Bar onPause={onPause} />, el);
}
