// On iPhones (no MediaSource) icecast-metadata-player plays through one
// AudioContext for the whole page, which it resumes only on the first touch.
// iOS suspends that context when the page's audio stops while the phone is
// locked or the page is in the background (a server restart drops the
// stream), and only lets resume() work during a tap; the library's own
// resume runs outside one. A play button then "plays" into the suspended
// context, in silence, until the page is reloaded. So record the contexts the
// library makes (it reads window.AudioContext when loaded: import this first)
// for resumeAudio(), which start() calls in the click.
const contexts: AudioContext[] = [];
const Base = window.AudioContext;
if (Base)
  window.AudioContext = class extends Base {
    constructor(options?: AudioContextOptions) {
      super(options);
      contexts.push(this);
    }
  };

export function resumeAudio() {
  for (const c of contexts) if (c.state !== "running") c.resume().catch(() => {});
}
