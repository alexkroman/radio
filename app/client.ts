// Browser code for the site, bundled by esbuild into /assets/app.js (+ app.css).
// One audio element for the whole site; links swap only <main> (hx-boost), so
// the station keeps playing while you browse.
// Archivo (variable, with its width axis), the site's one typeface, self-hosted (bundled into app.css + font files).
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource-variable/archivo/wdth-italic.css";
import "./tokens.css";
import "./style.css";
import htmx from "htmx.org";
import { mountBar, setBar } from "./bar.tsx";

// The browser plays the streams itself, in every browser: a tap sets the
// element's URL and calls play() in the tap, as iOS requires. (A player that
// decoded the stream into WebAudio left AirPlay speakers silent.) The track
// playing comes from the stream's now.json: /now.json for the station,
// /<slug>/now.json for a show's own.
const audio = new Audio();
// AirPlay (a WiiM, say, picked in Control Center) gets the page's audio as the
// phone's output, like any app's, rather than Safari handing the element
// itself to the speaker.
audio.disableRemotePlayback = true;
audio.setAttribute("x-webkit-airplay", "deny");
(window as unknown as { audio: HTMLAudioElement }).audio = audio; // for the e2e tests
const session = navigator.mediaSession;
// The station's name (#player's data; app.js is deferred, so the page is there).
const station = document.getElementById("player")!.dataset.title!;
// What the player plays: the station (/stream), or a show's own stream
// (/stream/<slug>), with where to ask what's playing on it and its status
// label. Set by a tap (a play button's data).
type Source = { src: string; title: string; now: string; status: string };
const LIVE: Source = { src: "/stream", title: station, now: "/now.json", status: "Live" };
let source = LIVE;
const live = () => source.src === LIVE.src;
// Whether it's playing: set on a tap, cleared when it stops.
let playing = false;
// A track: title, artist, album (all three shown while it plays, as the
// statutory license requires) and cover, and its show's title.
type Now = { track: string; artist: string; album: string; cover: string; title: string };
const NOTHING: Now = { track: "", artist: "", album: "", cover: "", title: "" };
// The track playing on the source (its now.json; unknown until fetched).
let now = NOTHING;
// The station's now.json as last fetched: when it changes, a page showing
// what's on air refreshes.
let onAirJson = "";
// What was last put on the lock screen.
let lockKey = "";
// When a dropped stream stops being retried (0: not retrying).
let retryUntil = 0;

function localTimes() {
  document.querySelectorAll("time[datetime]").forEach((el) => {
    const d = new Date(el.getAttribute("datetime")!);
    el.textContent = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  });
}

// Show the play state everywhere: play buttons (.current: what the player
// is on, playing or paused), "Live" labels, the player bar (app/bar.tsx).
function sync() {
  document.querySelectorAll<HTMLButtonElement>("button[data-play]").forEach((b) => {
    const current = b.dataset.play === source.src;
    const on = playing && current;
    b.classList.toggle("current", current);
    b.classList.toggle("playing", on);
    b.setAttribute("aria-label", `${on ? "Pause" : "Play"} ${b.dataset.title}`);
  });
  document.querySelectorAll<HTMLElement>("[data-status]").forEach((el) => {
    el.textContent = playing && live() ? "Listening live" : "Live";
  });
  document.body.classList.toggle("playing", playing);
  setBar({ ...now, title: now.title || source.title, station: source.title, status: source.status, playing });
  // The lock screen, when what's playing changes.
  if (!playing) return;
  const key = `${source.src}\n${now.track}\n${now.artist}\n${now.album}`;
  if (key === lockKey) return;
  lockKey = key;
  session.metadata = new MediaMetadata(
    now.track
      ? {
          title: now.track,
          artist: now.artist,
          album: now.album,
          artwork: now.cover ? [{ src: now.cover, type: "image/jpeg" }] : [],
        }
      : { title: source.title, artist: station },
  );
}

// The one poll, every 15 s: the track playing on the source, for the player
// bar and the lock screen, and the station's, so a page showing what's on
// air refreshes itself when it changes (ui.tsx Poll).
async function poll() {
  const get = (url: string) =>
    fetch(url)
      .then((r) => (r.ok ? r.text() : undefined))
      .catch(() => undefined);
  const { src, now: url } = source;
  const [onAir, own] = await Promise.all([get(LIVE.now), url === LIVE.now ? undefined : get(url)]);
  const json = url === LIVE.now ? onAir : own;
  if (source.src === src && json) now = JSON.parse(json) as Now;
  sync();
  if (!onAir || onAir === onAirJson) return;
  const first = !onAirJson;
  onAirJson = onAir;
  if (!first && document.getElementById("poll")) htmx.trigger("#poll", "refresh");
}
setInterval(() => void poll(), 15_000);

function playSource() {
  const src = source.src;
  audio.src = src;
  audio.play().catch((e: DOMException) => {
    // AbortError: a newer src (a switch, a retry) replaced this one.
    if (e.name !== "AbortError" && playing && source.src === src && !retryUntil) stop();
  });
}

function start(to: Source) {
  const changed = to.src !== source.src;
  source = to;
  if (changed) now = NOTHING;
  playing = true;
  sync();
  retryUntil = 0;
  // Synchronously, in the tap: iOS allows play() only there.
  playSource();
  if (changed) void poll();
}

function stop() {
  playing = false;
  session.playbackState = "paused";
  sync();
  audio.pause();
  // Drop the connection, rather than buffer audio nobody hears.
  audio.removeAttribute("src");
  audio.load();
}

const toggle = (to: Source) => (playing && source.src === to.src ? stop() : start(to));

audio.addEventListener("playing", () => {
  retryUntil = 0;
  if (playing) session.playbackState = "playing";
});
// The stream dropped (a server restart, a network change) or ended:
// reconnect for up to two minutes. iOS allows play() on an element a tap has
// started.
function dropped() {
  if (!playing) return;
  retryUntil ||= Date.now() + 120_000;
  if (Date.now() > retryUntil) return stop();
  const src = source.src;
  setTimeout(() => playing && source.src === src && retryUntil && playSource(), 3000);
}
audio.addEventListener("error", dropped);
audio.addEventListener("ended", dropped);
// Paused by the system (a call, Siri, unplugged headphones), not by a tap.
audio.addEventListener("pause", () => setTimeout(() => playing && audio.paused && !retryUntil && stop()));

// Play and pause only: no seeking, on the lock screen or anywhere else.
session.setActionHandler("play", () => start(source));
session.setActionHandler("pause", stop);
session.setActionHandler("stop", stop);
for (const action of ["seekto", "seekforward", "seekbackward", "previoustrack", "nexttrack"] as const) {
  try {
    session.setActionHandler(action, null);
  } catch {
    // A browser without this action.
  }
}

document.addEventListener("click", (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>("button[data-play]");
  if (!button) return;
  const { play: src, title, now: url, status } = button.dataset;
  toggle({ src: src!, title: title!, now: url!, status: status! });
});

document.addEventListener("htmx:beforeRequest", (e) => {
  const poll = e.target as Element;
  if (poll.id !== "poll") return;
  // A refresh still in flight when its page is swapped out (a link, back) would
  // otherwise land in the next page: htmx swaps a removed element's
  // hx-select-oob into the document. Its events no longer reach `document`.
  poll.addEventListener("htmx:beforeOnLoad", (l) => poll.isConnected || l.preventDefault(), { once: true });
});

mountBar(document.getElementById("player")!, () => toggle(source));

function settle() {
  localTimes();
  sync();
}
document.addEventListener("htmx:afterSettle", settle);
document.addEventListener("htmx:historyRestore", settle);
settle();
void poll();
