// Browser code for the site, bundled by esbuild into /assets/app.js (+ app.css).
// One audio element for the whole site; links swap only <main> (hx-boost), so
// the station keeps playing while you browse.
// Inter and JetBrains Mono, self-hosted (bundled into app.css + font files).
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "./tokens.css";
import "./style.css";
import htmx from "htmx.org";
import { mountBar, setBar } from "./bar.tsx";

// The browser plays the station's one MP3 stream itself, in every browser: a
// tap sets the element's URL and calls play() in the tap, as iOS requires. (A
// player that decoded the stream into WebAudio left AirPlay speakers silent.)
// The track and show on air come from /now.json.
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
// What the player plays: the live stream, or an archive block (/archive/...,
// played from the beginning; `then`, the show's earlier blocks, play after
// it). Set by a tap.
type Source = { src: string; title: string; then?: Source[] };
const LIVE: Source = { src: "/stream", title: station };
let source = LIVE;
const live = () => source.src === LIVE.src;
// Whether it's playing: set on a tap, cleared when it stops.
let playing = false;
// A track: title, artist, album (all three shown while it plays, as the
// statutory license requires) and cover.
type Track = { track: string; artist: string; album: string; cover: string };
const NO_TRACK: Track = { track: "", artist: "", album: "", cover: "" };
// The track on air and its show, from /now.json (and that JSON).
type Now = Track & { show: string; title: string };
let now: Now = { ...NO_TRACK, show: "", title: "" };
let nowJson = "";
// The track playing in an archive block, from the block's now.json (by how
// far into it the player is), and that JSON.
let blockTrack = NO_TRACK;
let blockJson = "";
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

// Show the play state everywhere: play buttons, "Live" labels, the player bar (app/bar.tsx).
function sync() {
  document.querySelectorAll<HTMLButtonElement>("button[data-play]").forEach((b) => {
    const on = playing && b.dataset.play === source.src;
    b.classList.toggle("playing", on);
    b.setAttribute("aria-label", `${on ? "Pause" : "Play"} ${b.dataset.title}`);
  });
  document.querySelectorAll<HTMLElement>("[data-status]").forEach((el) => {
    el.textContent = playing && live() ? "Listening · Live" : "Live";
  });
  document.body.classList.toggle("playing", playing);
  const track: Track = live() ? now : blockTrack;
  setBar({
    ...NO_TRACK,
    ...(live() || playing ? track : {}),
    station: live() ? station : source.title,
    title: live() ? now.title || station : source.title,
    live: live(),
    playing,
  });
  // The lock screen, when what's playing changes.
  if (!playing) return;
  const key = `${source.src}\n${track.track}\n${track.artist}\n${track.album}`;
  if ((live() && !track.track) || key === lockKey) return;
  lockKey = key;
  session.metadata = new MediaMetadata(
    track.track
      ? {
          title: track.track,
          artist: track.artist,
          album: track.album,
          artwork: track.cover ? [{ src: track.cover, type: "image/jpeg" }] : [],
        }
      : { title: source.title, artist: station },
  );
}

// While an archive block plays, every 2 s: the track playing in it, by how
// far in the player is (it plays from the beginning, without seeking). Only
// that track: the block's track list is never fetched.
async function pollBlock() {
  const src = source.src;
  if (!playing || live() || audio.paused) return;
  const t = Math.floor(audio.currentTime);
  const json = await fetch(`${src.replace(/\.mp3$/, "")}/now.json?t=${t}`)
    .then((r) => (r.ok ? r.text() : undefined))
    .catch(() => undefined);
  if (!json || source.src !== src || json === blockJson) return;
  blockJson = json;
  blockTrack = JSON.parse(json) as Track;
  sync();
}
setInterval(() => void pollBlock(), 2_000);

// The one poll, every 15 s: the track on air, for the player bar and the
// lock screen. When it changes, a page showing it refreshes itself (ui.tsx Poll).
async function poll() {
  const json = await fetch("/now.json")
    .then((r) => (r.ok ? r.text() : undefined))
    .catch(() => undefined);
  if (!json || json === nowJson) return;
  const first = !nowJson;
  nowJson = json;
  now = { ...NO_TRACK, ...(JSON.parse(json) as Partial<Now>) } as Now;
  sync();
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
  source = to;
  blockTrack = NO_TRACK;
  blockJson = "";
  playing = true;
  sync();
  retryUntil = 0;
  // Synchronously, in the tap: iOS allows play() only there.
  playSource();
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
  void pollBlock();
});
// Back to the live stream, paused.
function backToLive() {
  stop();
  source = LIVE;
  sync();
}
// The live stream dropped (a server restart, a network change): reconnect for
// up to two minutes. iOS allows play() on an element a tap has started. An
// archive block that fails isn't restarted, which would start it over: the
// player goes back to the live stream, paused.
function dropped() {
  if (!playing) return;
  if (!live()) return backToLive();
  retryUntil ||= Date.now() + 120_000;
  if (Date.now() > retryUntil) return stop();
  setTimeout(() => playing && live() && retryUntil && playSource(), 3000);
}
audio.addEventListener("error", dropped);
// An archive block that ends goes on to the show's block before it (iOS
// allows play() on an element a tap has started); after the last, back to
// live, paused. The live stream ending is a drop.
audio.addEventListener("ended", () => {
  if (!playing || live()) return dropped();
  const [next, ...rest] = source.then ?? [];
  if (next) start({ ...next, then: rest });
  else backToLive();
});
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
  const button = (e.target as Element).closest<HTMLButtonElement>("button[data-play], button[data-copy]");
  if (!button) return;
  if (button.dataset.play) {
    const then = JSON.parse(button.dataset.then ?? "[]") as Source[];
    return toggle({ src: button.dataset.play, title: button.dataset.title!, then });
  }
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
