// Browser code for the site, bundled by esbuild into /assets/app.js (+ app.css).
import "@picocss/pico/css/pico.jade.min.css";
import "./style.css";
import htmx from "htmx.org";
import IcecastMetadataPlayer from "icecast-metadata-player";

// Simple password gate (not real security: the password ships with the page).
function gate() {
  if (sessionStorage.getItem("auth")) return;
  const el = document.createElement("div");
  el.id = "gate";
  el.innerHTML = `<article>
    <h2>Radio</h2>
    <form>
      <input type="password" placeholder="Password" autofocus />
      <button type="submit">Enter</button>
      <p hidden>Wrong password</p>
    </form>
  </article>`;
  document.body.prepend(el);
  el.querySelector("form")!.onsubmit = (e) => {
    e.preventDefault();
    if (el.querySelector("input")!.value === "mazes2026") {
      sessionStorage.setItem("auth", "1");
      el.remove();
    } else {
      el.querySelector("p")!.hidden = false;
    }
  };
}

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
  const cover = () => `/${show}/cover.jpg?t=${Date.now()}`;
  const refreshAlbumArt = () => {
    const img = document.getElementById("album-art") as HTMLImageElement | null;
    if (!img) return;
    const fresh = cover();
    const probe = new Image();
    probe.onload = () => {
      img.src = fresh;
      img.hidden = false;
    };
    probe.onerror = () => (img.hidden = true);
    probe.src = fresh;
  };
  const session =
    "mediaSession" in navigator ? navigator.mediaSession : undefined;

  const p = new IcecastMetadataPlayer(`/${show}/stream`, {
    retryTimeout: 120,
    onMetadata: (metadata: { StreamTitle?: string }) => {
      htmx.trigger("#np", "refresh");
      refreshAlbumArt();
      const raw = metadata.StreamTitle ?? "";
      const dash = raw.indexOf(" - ");
      if (session)
        session.metadata = new MediaMetadata({
          title: dash >= 0 ? raw.slice(dash + 3) : raw,
          artist: dash >= 0 ? raw.slice(0, dash) : "",
          artwork: [{ src: cover(), sizes: "512x512", type: "image/jpeg" }],
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

  document.addEventListener("htmx:afterSettle", () => {
    localTimes();
    refreshAlbumArt();
  });
  refreshAlbumArt();
  return p;
}

// Don't poll while the tab is hidden (an hx-trigger filter would need eval,
// which the CSP forbids).
document.addEventListener(
  "htmx:beforeRequest",
  (e) => document.hidden && e.preventDefault(),
);

gate();
localTimes();
const np = document.getElementById("np");
const button = document.getElementById("play") as HTMLButtonElement | null;
if (np?.dataset.show && button)
  (window as unknown as { player: unknown }).player = player(
    np.dataset.show,
    button,
  );
