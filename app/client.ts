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
// after a switch.) The track comes from /now.json.
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
// Every station's current track, by slug, from /now.json (and that JSON).
type Track = { track: string; artist: string; cover: string };
let tracks: Record<string, Track> = {};
let tracksJson = "";
// The track last put on the lock screen (slug, track, artist).
let lockKey = "";
// When a dropped stream stops being retried (0: not retrying).
let retryUntil = 0;

function localTimes() {
  document.querySelectorAll("time[datetime]").forEach((el) => {
    const d = new Date(el.getAttribute("datetime")!);
    el.textContent = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  });
}

function pickShown() {
  const button = document.querySelector<HTMLElement>("button[data-play]")?.dataset;
  const player = document.getElementById("player")?.dataset;
  shown =
    active ??
    shown ??
    (button && { slug: button.play!, title: button.title! }) ??
    (player?.slug ? { slug: player.slug, title: player.title! } : undefined);
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
  const none = { track: "", artist: "", cover: "" };
  setBar(shown && { title: shown.title, ...(tracks[shown.slug] ?? none), playing: !!active });
  // The lock screen, when the playing station's track changes.
  const now = active && tracks[active.slug];
  const key = `${active?.slug}\n${now?.track}\n${now?.artist}`;
  if (!active || !now || key === lockKey) return;
  lockKey = key;
  session.metadata = new MediaMetadata({
    title: now.track,
    artist: now.artist,
    album: active.title,
    artwork: now.cover ? [{ src: now.cover, type: "image/jpeg" }] : [],
  });
}

// The one poll, every 15 s: every station's current track, for the player bar
// and the lock screen. A page showing a station whose track changed refreshes
// itself (ui.tsx Poll).
async function poll() {
  const json = await fetch("/now.json")
    .then((r) => (r.ok ? r.text() : undefined))
    .catch(() => undefined);
  if (!json || json === tracksJson) return;
  const before = tracksJson ? tracks : undefined;
  tracksJson = json;
  tracks = JSON.parse(json) as Record<string, Track>;
  sync();
  const changed = (slug: string) => JSON.stringify(tracks[slug]) !== JSON.stringify(before?.[slug]);
  const shownHere = [...document.querySelectorAll<HTMLElement>("[data-np]")].map((el) => el.dataset.np!);
  if (before && document.getElementById("poll") && shownHere.some(changed)) htmx.trigger("#poll", "refresh");
}
setInterval(() => void poll(), 15_000);

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
  sync();
  retryUntil = 0;
  // Synchronously, in the tap: iOS allows play() only there.
  playStream(slug);
}

function stop() {
  active = undefined;
  session.playbackState = "paused";
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
void poll();
