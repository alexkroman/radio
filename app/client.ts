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
// played from the beginning, or where it was paused; `then`, the show's
// earlier blocks, play after it). Set by a tap.
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
// The track on air and its show's title, from /now.json (and that JSON).
type Now = Track & { title: string };
let now: Now = { ...NO_TRACK, title: "" };
let nowJson = "";
// The track playing in an archive block, from the block's now.json (by how
// far into it the player is), and when the next starts (seconds into the
// block; undefined once it's the last). Unknown until fetched.
let blockTrack = NO_TRACK;
let blockUntil: number | undefined;
let blockFetched = false;
// What was last put on the lock screen.
let lockKey = "";
// When a dropped stream stops being retried (0: not retrying).
let retryUntil = 0;
// How far into the archive block the player last was, and where it picks up
// again after a drop or a pause (0: from the beginning).
let blockAt = 0;
let resumeAt = 0;

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
  const track: Track = live() ? now : blockTrack;
  setBar({
    ...NO_TRACK,
    ...(live() || playing ? track : {}),
    station: source.title,
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

// While an archive block plays: the track playing in it, by how far in the
// player is (it plays on from where it starts, without seeking), fetched when it
// starts and again when that track ends. Only that track: the block's track
// list is never fetched.
let blockFetching = false;
async function pollBlock() {
  const src = source.src;
  if (!playing || live() || audio.paused || blockFetching) return;
  const t = audio.currentTime;
  if (blockFetched && (blockUntil === undefined || t < blockUntil)) return;
  blockFetching = true;
  const res = await fetch(`${src.replace(/\.mp3$/, "")}/now.json?t=${Math.floor(t)}`)
    .then((r) => (r.ok ? (r.json() as Promise<Track & { until?: number }>) : undefined))
    .catch(() => undefined);
  blockFetching = false;
  if (source.src !== src) return;
  blockFetched = true;
  // Unknown (the block was just pruned, the network's down): show no track
  // rather than a stale one, and ask again in 15 s.
  if (res) ({ until: blockUntil, ...blockTrack } = res);
  else [blockTrack, blockUntil] = [NO_TRACK, t + 15];
  sync();
}
setInterval(() => void pollBlock(), 1_000);

// The one poll, every 15 s: the track on air, for the player bar and the
// lock screen. When it changes, a page showing it refreshes itself (ui.tsx Poll).
async function poll() {
  const json = await fetch("/now.json")
    .then((r) => (r.ok ? r.text() : undefined))
    .catch(() => undefined);
  if (!json || json === nowJson) return;
  const first = !nowJson;
  nowJson = json;
  now = JSON.parse(json) as Now;
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
  // The block it was on, paused: where it was. Anything else: the beginning.
  blockAt = resumeAt = !live() && to.src === source.src ? blockAt : 0;
  source = to;
  blockTrack = NO_TRACK;
  blockFetched = false;
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
  source = LIVE;
  stop();
}
// The stream dropped (a server restart, a network change): reconnect for up
// to two minutes. iOS allows play() on an element a tap has started. An
// archive block picks up where it was (the server takes ranges; the browser
// resumes a short blip that way itself); given up on, it goes back to the
// live stream, paused.
function dropped() {
  if (!playing) return;
  retryUntil ||= Date.now() + 120_000;
  if (Date.now() > retryUntil) return live() ? stop() : backToLive();
  if (!live()) resumeAt ||= blockAt;
  const src = source.src;
  setTimeout(() => playing && source.src === src && retryUntil && playSource(), 3000);
}
audio.addEventListener("error", dropped);
audio.addEventListener("timeupdate", () => {
  if (!live() && !retryUntil && audio.currentTime > 0) blockAt = audio.currentTime;
});
audio.addEventListener("loadedmetadata", () => {
  if (!live() && resumeAt) audio.currentTime = resumeAt;
  resumeAt = 0;
});
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
  const button = (e.target as Element).closest<HTMLButtonElement>("button[data-play]");
  if (!button) return;
  const then = JSON.parse(button.dataset.then ?? "[]") as Source[];
  toggle({ src: button.dataset.play!, title: button.dataset.title!, then });
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
