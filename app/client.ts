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
// Whether the stream is playing: set on a tap, cleared when it stops.
let playing = false;
// The track on air and its show, from /now.json (and that JSON).
type Now = { show: string; title: string; track: string; artist: string; cover: string };
let now: Now = { show: "", title: "", track: "", artist: "", cover: "" };
let nowJson = "";
// The track last put on the lock screen.
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
    b.classList.toggle("playing", playing);
    b.setAttribute("aria-label", `${playing ? "Pause" : "Play"} ${station}`);
  });
  document.querySelectorAll<HTMLElement>("[data-status]").forEach((el) => {
    el.textContent = playing ? "Listening · Live" : "Live";
  });
  document.body.classList.toggle("playing", playing);
  setBar({ ...now, station, title: now.title || station, playing });
  // The lock screen, when the track on air changes.
  const key = `${now.show}\n${now.track}\n${now.artist}`;
  if (!playing || !now.track || key === lockKey) return;
  lockKey = key;
  session.metadata = new MediaMetadata({
    title: now.track,
    artist: now.artist,
    album: now.title,
    artwork: now.cover ? [{ src: now.cover, type: "image/jpeg" }] : [],
  });
}

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

function playStream() {
  audio.src = "/stream";
  audio.play().catch((e: DOMException) => {
    // AbortError: a newer src (a retry) replaced this one.
    if (e.name !== "AbortError" && playing && !retryUntil) stop();
  });
}

function start() {
  playing = true;
  sync();
  retryUntil = 0;
  // Synchronously, in the tap: iOS allows play() only there.
  playStream();
}

function stop() {
  playing = false;
  session.playbackState = "paused";
  sync();
  audio.pause();
  // Drop the connection, rather than buffer a live stream nobody hears.
  audio.removeAttribute("src");
  audio.load();
}

const toggle = () => (playing ? stop() : start());

audio.addEventListener("playing", () => {
  retryUntil = 0;
  if (playing) session.playbackState = "playing";
});
// The stream dropped (a server restart, a network change): reconnect for up
// to two minutes. iOS allows play() on an element a tap has started.
function dropped() {
  if (!playing) return;
  retryUntil ||= Date.now() + 120_000;
  if (Date.now() > retryUntil) return stop();
  setTimeout(() => playing && retryUntil && playStream(), 3000);
}
audio.addEventListener("error", dropped);
audio.addEventListener("ended", dropped);
// Paused by the system (a call, Siri, unplugged headphones), not by a tap.
audio.addEventListener("pause", () => setTimeout(() => playing && audio.paused && !retryUntil && stop()));

session.setActionHandler("play", start);
session.setActionHandler("pause", stop);
session.setActionHandler("stop", stop);

document.addEventListener("click", (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>("button[data-play], button[data-copy]");
  if (!button) return;
  if (button.dataset.play !== undefined) return toggle();
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

mountBar(document.getElementById("player")!, toggle);

function settle() {
  localTimes();
  sync();
}
document.addEventListener("htmx:afterSettle", settle);
document.addEventListener("htmx:historyRestore", settle);
settle();
void poll();
