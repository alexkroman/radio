// Browser code for the site, bundled by esbuild into /assets/app.js (+ app.css).
import "@picocss/pico/css/pico.jade.min.css";
import "./style.css";
import htmx from "htmx.org";
import IcecastMetadataPlayer from "icecast-metadata-player";

function localTimes() {
  document.querySelectorAll("time[datetime]").forEach((el) => {
    const d = new Date(el.getAttribute("datetime")!);
    if (!isNaN(d.valueOf()))
      el.textContent = d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
  });
}

function player(show: string, button: HTMLButtonElement) {
  const session = "mediaSession" in navigator ? navigator.mediaSession : undefined;

  const p = new IcecastMetadataPlayer(`/${show}/stream`, {
    retryTimeout: 120,
    onMetadata: (metadata: { StreamTitle?: string }) => {
      htmx.trigger("#np", "refresh");
      const raw = metadata.StreamTitle ?? "";
      const dash = raw.indexOf(" - ");
      if (session)
        session.metadata = new MediaMetadata({
          title: dash >= 0 ? raw.slice(dash + 3) : raw,
          artist: dash >= 0 ? raw.slice(0, dash) : "",
          artwork: [{ src: `/${show}/cover.jpg?t=${Date.now()}`, sizes: "512x512", type: "image/jpeg" }],
        });
    },
    onPlay: () => {
      button.textContent = "■";
      button.setAttribute("aria-label", "Stop");
      if (session) session.playbackState = "playing";
    },
    onStop: () => {
      button.textContent = "▶";
      button.setAttribute("aria-label", "Play");
      if (session) session.playbackState = "paused";
    },
  });
  button.onclick = () => (p.state === "stopped" ? p.play() : p.stop());
  session?.setActionHandler("play", () => p.play());
  session?.setActionHandler("pause", () => p.stop());
  session?.setActionHandler("stop", () => p.stop());

  return p;
}

// Don't poll while the tab is hidden (an hx-trigger filter would need eval,
// which the CSP forbids).
document.addEventListener("htmx:beforeRequest", (e) => document.hidden && e.preventDefault());

document.addEventListener("htmx:afterSettle", localTimes);
localTimes();
const np = document.getElementById("np");
const button = document.getElementById("play") as HTMLButtonElement | null;
if (np?.dataset.show && button)
  (window as unknown as { player: unknown }).player = player(np.dataset.show, button);
