// Browser code for the site, bundled by esbuild into /assets/app.js (+ app.css).
// One audio element for the whole site; links swap only <main> (hx-boost), so
// a station keeps playing while you browse.
// Inter and JetBrains Mono, self-hosted (bundled into app.css + font files).
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "./tokens.css";
import "./style.css";
// Before icecast-metadata-player, which reads window.AudioContext when loaded.
import { resumeAudio } from "./audio.ts";
import htmx from "htmx.org";
import IcecastMetadataPlayer, { type IcyMetadata } from "icecast-metadata-player";
import { mountBar, setBar } from "./bar.tsx";

// `stopping`: the player's stop() after a pause, awaited before the player
// (or the audio element) is used again; its stop() returns early while stopping.
type Station = { slug: string; title: string; player: IcecastMetadataPlayer; stopping?: Promise<void> };

const audio = new Audio();
const session = navigator.mediaSession;
let station: Station | undefined;
// The station shown as playing: set on click, cleared when it stops.
let active: { slug: string; title: string } | undefined;
// The playing station's track, from the page or the stream's metadata.
let now = { track: "", artist: "", cover: "" };

function localTimes() {
  document.querySelectorAll("time[datetime]").forEach((el) => {
    const d = new Date(el.getAttribute("datetime")!);
    el.textContent = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  });
}

// Take the playing station's track and cover from the page when it has them.
function readPage() {
  if (!active) return;
  // ui.tsx npData sets all three.
  const np = document.querySelector<HTMLElement>(`[data-np="${active.slug}"]`)?.dataset as
    typeof now | undefined;
  if (np?.track) now = { track: np.track, artist: np.artist, cover: np.cover };
}

// The playing track's cover: from the page, else the station's current cover
// (keyed by track so a browser fetches it once per track).
const coverSrc = (slug: string) => now.cover || `/${slug}/cover.jpg?t=${encodeURIComponent(now.track)}`;

// Show the play state everywhere: play buttons, "Live" labels, the player bar (app/bar.tsx).
function sync() {
  document.querySelectorAll<HTMLButtonElement>("button[data-play]").forEach((b) => {
    const on = b.dataset.play === active?.slug;
    b.classList.toggle("playing", on);
    b.setAttribute("aria-label", `${on ? "Pause" : "Play"} ${b.dataset.title}`);
  });
  document.querySelectorAll<HTMLElement>("[data-status]").forEach((el) => {
    el.textContent = el.dataset.status === active?.slug ? "Listening · Live" : "Live";
  });
  document.body.classList.toggle("playing", !!active);
  setBar(active && { title: active.title, ...now, cover: coverSrc(active.slug) });
}

// The stream stopped on its own (a pause is already shown by stop()).
function stopped(p: IcecastMetadataPlayer) {
  if (station?.player !== p || station.stopping) return;
  active = undefined;
  session.playbackState = "paused";
  sync();
}

// Start the audio element, as icecast-metadata-player's play() would (to keep
// iOS's permission from the click), but catch the rejection when the player
// then loads the stream into it: the player's own call leaves that unhandled.
function unlock() {
  audio.play().catch(() => {});
}

async function start(slug: string, title: string) {
  // Synchronously, in the click: iOS allows it only there.
  resumeAudio();
  active = { slug, title };
  now = { track: "", artist: "", cover: "" };
  readPage();
  sync();
  const paused = station;
  if (paused?.stopping) {
    await paused.stopping;
    paused.stopping = undefined;
    if (active?.slug !== slug || station !== paused) return; // another click meanwhile
  }
  if (station?.slug === slug && station.player.state !== "stopped") {
    unlock();
    return void station.player.play();
  }
  const old = station;
  station = undefined;
  if (old) await old.player.detachAudioElement();
  if (active?.slug !== slug) return; // another click while the old one stopped
  const p: IcecastMetadataPlayer = new IcecastMetadataPlayer(`/${slug}/stream`, {
    audioElement: audio,
    retryTimeout: 120,
    // Seconds of audio to hold before playing (default 1), so a dip in
    // bandwidth drains the buffer instead of stuttering. Icecast's burst
    // (compose.yml) sends ~10 s on connect, so this rarely delays the start.
    bufferLength: 5,
    onMetadata: (metadata: IcyMetadata) => {
      if (station?.player !== p) return;
      const raw = metadata.StreamTitle ?? "";
      const dash = raw.indexOf(" - ");
      now = {
        track: dash >= 0 ? raw.slice(dash + 3) : raw,
        artist: dash >= 0 ? raw.slice(0, dash) : "",
        cover: "",
      };
      sync();
      // The page's now playing (and with it the cover) catches up.
      if (document.getElementById("poll")) htmx.trigger("#poll", "refresh");
      session.metadata = new MediaMetadata({
        title: now.track,
        artist: now.artist,
        album: title,
        artwork: [{ src: coverSrc(slug), sizes: "512x512", type: "image/jpeg" }],
      });
    },
    onPlay: () => {
      if (station?.player !== p) return;
      session.playbackState = "playing";
    },
    onStop: () => stopped(p),
    onError: () => {
      if (p.state === "stopped") stopped(p);
    },
  });
  station = { slug, title, player: p };
  (window as unknown as { player: unknown }).player = p;
  sync();
  unlock();
  await p.play();
}

function stop() {
  active = undefined;
  session.playbackState = "paused";
  sync();
  if (station) station.stopping ??= station.player.stop();
}

function toggle(slug: string, title: string) {
  if (active?.slug === slug) stop();
  else void start(slug, title);
}

session.setActionHandler("play", () => station && void start(station.slug, station.title));
session.setActionHandler("pause", stop);
session.setActionHandler("stop", stop);

document.addEventListener("click", (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>("button[data-play], button[data-copy]");
  if (!button) return;
  if (button.dataset.play) return toggle(button.dataset.play, button.dataset.title!);
  const url = button.dataset.copy!;
  navigator.clipboard.writeText(url).then(
    () => {
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = "Copy"), 1600);
    },
    () => {
      // No clipboard access: select the URL so it can be copied by hand.
      getSelection()!.selectAllChildren(button.parentElement!.querySelector("a")!);
    },
  );
});

document.addEventListener("htmx:beforeRequest", (e) => {
  const poll = e.target as Element;
  if (poll.id !== "poll") return;
  // Don't poll while the tab is hidden (an hx-trigger filter would need eval,
  // which the CSP forbids).
  if (document.hidden) return e.preventDefault();
  // A refresh still in flight when its page is swapped out (a link, back) would
  // otherwise land in the next page: htmx swaps a removed element's
  // hx-select-oob into the document. Its events no longer reach `document`.
  poll.addEventListener("htmx:beforeOnLoad", (l) => poll.isConnected || l.preventDefault(), { once: true });
});

mountBar(document.getElementById("player")!, stop);

function settle() {
  localTimes();
  readPage();
  sync();
}
document.addEventListener("htmx:afterSettle", settle);
document.addEventListener("htmx:historyRestore", settle);
settle();
