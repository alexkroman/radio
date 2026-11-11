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
import IcecastMetadataPlayer, { type IcyMetadata } from "icecast-metadata-player";

type Station = { slug: string; title: string; player: IcecastMetadataPlayer };

const audio = new Audio();
const session = "mediaSession" in navigator ? navigator.mediaSession : undefined;
let station: Station | undefined;
// The station shown as playing: set on click, cleared when it stops.
let active: string | undefined;
// The playing station's track, from the page or the stream's metadata.
let now = { track: "", artist: "", cover: "" };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function localTimes() {
  document.querySelectorAll("time[datetime]").forEach((el) => {
    const d = new Date(el.getAttribute("datetime")!);
    if (!isNaN(d.valueOf()))
      el.textContent = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  });
}

// Take the playing station's track and cover from the page when it has them.
function readPage() {
  if (!active) return;
  const el = document.querySelector<HTMLElement>(`[data-np="${active}"]`);
  if (el?.dataset.track)
    now = { track: el.dataset.track, artist: el.dataset.artist ?? "", cover: el.dataset.cover ?? "" };
}

// Show the play state everywhere: play buttons, "Live" labels, the phone bar.
function sync() {
  document.querySelectorAll<HTMLButtonElement>("button[data-play]").forEach((b) => {
    const on = b.dataset.play === active;
    b.classList.toggle("playing", on);
    b.setAttribute("aria-label", `${on ? "Pause" : "Play"} ${b.dataset.title}`);
  });
  document.querySelectorAll<HTMLElement>("[data-status]").forEach((el) => {
    el.textContent = el.dataset.status === active ? "Listening · Live" : "Live";
  });
  document.body.classList.toggle("playing", !!active);
  $("bar").hidden = !active;
  if (!station || !active) return;
  $("bar-track").textContent = [now.track, now.artist].filter(Boolean).join(" · ");
  $("bar-station").textContent = `${station.title} · Live`;
  $("bar-button").setAttribute("aria-label", `Pause ${station.title}`);
  const img = $<HTMLImageElement>("bar-cover");
  const src = now.cover || `/${station.slug}/cover.jpg?t=${encodeURIComponent(now.track)}`;
  if (img.getAttribute("src") !== src) {
    img.hidden = true;
    $("bar-ph").hidden = false;
    img.src = src;
  }
  img.alt = now.track ? `Cover art: ${[now.track, now.artist].filter(Boolean).join(", ")}` : "";
}

// The bar shows the placeholder square until (and unless) the cover loads.
const barCover = $<HTMLImageElement>("bar-cover");
barCover?.addEventListener("load", () => {
  barCover.hidden = false;
  $("bar-ph").hidden = true;
});

function stopped(p: IcecastMetadataPlayer) {
  if (station?.player !== p) return;
  active = undefined;
  if (session) session.playbackState = "paused";
  sync();
}

async function start(slug: string, title: string) {
  active = slug;
  now = { track: "", artist: "", cover: "" };
  readPage();
  sync();
  if (station?.slug === slug) return void station.player.play();
  const old = station;
  station = undefined;
  if (old) await old.player.detachAudioElement();
  if (active !== slug) return; // another click while the old one stopped
  const p: IcecastMetadataPlayer = new IcecastMetadataPlayer(`/${slug}/stream`, {
    audioElement: audio,
    retryTimeout: 120,
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
      if (session)
        session.metadata = new MediaMetadata({
          title: now.track,
          artist: now.artist,
          album: title,
          artwork: [{ src: `/${slug}/cover.jpg?t=${Date.now()}`, sizes: "512x512", type: "image/jpeg" }],
        });
    },
    onPlay: () => {
      if (station?.player !== p) return;
      if (session) session.playbackState = "playing";
    },
    onStop: () => stopped(p),
    onError: () => {
      if (p.state === "stopped") stopped(p);
    },
  });
  station = { slug, title, player: p };
  (window as unknown as { player: unknown }).player = p;
  sync();
  await p.play();
}

function stop() {
  active = undefined;
  sync();
  void station?.player.stop();
}

function toggle(slug: string, title: string) {
  if (active === slug) stop();
  else void start(slug, title);
}

session?.setActionHandler("play", () => station && void start(station.slug, station.title));
session?.setActionHandler("pause", stop);
session?.setActionHandler("stop", stop);

document.addEventListener("click", (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>(
    "button[data-play], button[data-copy], #bar-button",
  );
  if (!button) return;
  if (button.id === "bar-button") return stop();
  if (button.dataset.play) return toggle(button.dataset.play, button.dataset.title ?? button.dataset.play);
  const url = button.dataset.copy!;
  navigator.clipboard.writeText(url).then(
    () => {
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = "Copy"), 1600);
    },
    () => {
      // No clipboard access: select the URL so it can be copied by hand.
      const link = button.parentElement?.querySelector("a");
      if (link) getSelection()?.selectAllChildren(link);
    },
  );
});

// Don't poll while the tab is hidden (an hx-trigger filter would need eval,
// which the CSP forbids).
document.addEventListener("htmx:beforeRequest", (e) => {
  if (document.hidden && (e.target as Element).id === "poll") e.preventDefault();
});

function settle() {
  localTimes();
  readPage();
  sync();
}
document.addEventListener("htmx:afterSettle", settle);
document.addEventListener("htmx:historyRestore", settle);
settle();
