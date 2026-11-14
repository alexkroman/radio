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
import htmx from "htmx.org";
import { mountBar, setBar } from "./bar.tsx";

// The browser plays each show's MP3 stream itself, in every browser: switching
// sets the element's URL and calls play() in the tap, as iOS requires. (A
// player that decoded the stream into WebAudio left AirPlay speakers silent
// after a switch.) The track comes from /<slug>/now.json.
const audio = new Audio();
// AirPlay (a WiiM, say, picked in Control Center) gets the page's audio as the
// phone's output, like any app's, rather than Safari handing the element
// itself to the speaker.
audio.disableRemotePlayback = true;
audio.setAttribute("x-webkit-airplay", "deny");
(window as unknown as { audio: HTMLAudioElement }).audio = audio; // for the e2e tests
const session = navigator.mediaSession;
type Show = { slug: string; title: string };
// The station shown as playing: set on click, cleared when it stops.
let active: Show | undefined;
// The station in the player bar: the playing one, else the last one played,
// else the page's first, else the site's first show (#player's data).
let shown: Show | undefined;
// The shown station's track, from the page or now.json.
type Track = { track: string; artist: string; cover: string };
let now: Track = { track: "", artist: "", cover: "" };
// The track last shown for the playing station (slug, track, artist).
let nowKey = "";
let nowTimer: ReturnType<typeof setInterval> | undefined;
// When a dropped stream stops being retried (0: not retrying).
let retryUntil = 0;

function localTimes() {
  document.querySelectorAll("time[datetime]").forEach((el) => {
    const d = new Date(el.getAttribute("datetime")!);
    el.textContent = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  });
}

// Take the shown station's track and cover from the page when it has them.
function readPage() {
  if (!shown) return;
  // ui.tsx npData sets all three.
  const np = document.querySelector<HTMLElement>(`[data-np="${shown.slug}"]`)?.dataset as Track | undefined;
  if (np?.track) now = { track: np.track, artist: np.artist, cover: np.cover };
}

function pickShown() {
  const button = document.querySelector<HTMLElement>("button[data-play]")?.dataset;
  const player = document.getElementById("player")?.dataset;
  const next =
    active ??
    shown ??
    (button && { slug: button.play!, title: button.title! }) ??
    (player?.slug ? { slug: player.slug, title: player.title! } : undefined);
  if (next?.slug !== shown?.slug) {
    now = { track: "", artist: "", cover: "" };
    nowKey = "";
  }
  shown = next;
  readPage();
  // A page without the station's track (the manifesto, a DJ's other shows).
  if (shown && !now.track) void fetchNow(shown.slug);
}

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
  setBar(shown && { title: shown.title, ...now, playing: !!active });
}

// The shown station's track from now.json, for the bar and the page, and the
// lock screen when it's playing.
async function fetchNow(slug: string) {
  const next = await fetch(`/${slug}/now.json`)
    .then((r) => (r.ok ? (r.json() as Promise<Track>) : undefined))
    .catch(() => undefined);
  const key = `${slug}\n${next?.track}\n${next?.artist}`;
  if (!next || shown?.slug !== slug || key === nowKey) return;
  nowKey = key;
  now = next;
  sync();
  if (active?.slug !== slug) return;
  // The page's now playing (and with it the cover) catches up.
  if (document.getElementById("poll")) htmx.trigger("#poll", "refresh");
  session.metadata = new MediaMetadata({
    title: now.track,
    artist: now.artist,
    album: active.title,
    artwork: now.cover ? [{ src: now.cover, type: "image/jpeg" }] : [],
  });
}

function playStream(slug: string) {
  audio.src = `/${slug}/stream`;
  audio.play().catch((e: DOMException) => {
    // AbortError: a newer src (a switch, a retry) replaced this one.
    if (e.name !== "AbortError" && active?.slug === slug && !retryUntil) stop();
  });
}

function start(slug: string, title: string) {
  active = { slug, title };
  shown = active;
  now = { track: "", artist: "", cover: "" };
  readPage();
  sync();
  retryUntil = 0;
  nowKey = "";
  // Synchronously, in the tap: iOS allows play() only there.
  playStream(slug);
  void fetchNow(slug);
  clearInterval(nowTimer);
  nowTimer = setInterval(() => active && void fetchNow(active.slug), 15_000);
}

function stop() {
  active = undefined;
  session.playbackState = "paused";
  clearInterval(nowTimer);
  sync();
  audio.pause();
  // Drop the connection, rather than buffer a live stream nobody hears.
  audio.removeAttribute("src");
  audio.load();
}

function toggle(slug: string, title: string) {
  if (active?.slug === slug) stop();
  else start(slug, title);
}

audio.addEventListener("playing", () => {
  retryUntil = 0;
  if (active) session.playbackState = "playing";
});
// The stream dropped (a server restart, a network change): reconnect for up
// to two minutes. iOS allows play() on an element a tap has started.
function dropped() {
  const slug = active?.slug;
  if (!slug) return;
  retryUntil ||= Date.now() + 120_000;
  if (Date.now() > retryUntil) return stop();
  setTimeout(() => active?.slug === slug && retryUntil && playStream(slug), 3000);
}
audio.addEventListener("error", dropped);
audio.addEventListener("ended", dropped);
// Paused by the system (a call, Siri, unplugged headphones), not by a switch,
// which plays again at once.
audio.addEventListener("pause", () => setTimeout(() => active && audio.paused && !retryUntil && stop()));

session.setActionHandler("play", () => shown && start(shown.slug, shown.title));
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

mountBar(document.getElementById("player")!, () => shown && toggle(shown.slug, shown.title));

function settle() {
  localTimes();
  pickShown();
  sync();
}
document.addEventListener("htmx:afterSettle", settle);
document.addEventListener("htmx:historyRestore", settle);
settle();
