// On iPhones (no MediaSource) icecast-metadata-player plays through one
// AudioContext for the whole page, which it resumes only on the first touch.
// iOS suspends that context when the page's audio stops while the phone is
// locked or the page is in the background (a server restart drops the
// stream), and only lets resume() work during a tap; the library's own
// resume runs outside one. A play button then "plays" into the suspended
// context, in silence, until the page is reloaded. So record the contexts the
// library makes (it reads window.AudioContext when loaded: import this first)
// for resumeAudio(), which start() calls in the click.
//
// Each of the library's WebAudio players also makes its own
// MediaStreamDestination and points the audio element at its stream, so a
// show switch (switchEndpoint() in client.ts) reloads the element, which iOS
// takes as a pause that can move AirPlay audio back to the phone. Instead,
// every player here gets a GainNode feeding one destination per context,
// whose stream never changes. A new player disconnects the previous one's
// node, cutting off the old show's buffered audio where the library would
// have removed its stream's track; that removal (in the player's end()) is a
// no-op on the shared stream.
const contexts: AudioContext[] = [];
const Base = window.AudioContext;
window.AudioContext = class extends Base {
  #out?: MediaStreamAudioDestinationNode;
  #input?: GainNode;
  constructor(options?: AudioContextOptions) {
    super(options);
    contexts.push(this);
  }
  override createMediaStreamDestination() {
    if (!this.#out) {
      this.#out = super.createMediaStreamDestination();
      this.#out.stream.removeTrack = () => {};
    }
    this.#input?.disconnect();
    const input = (this.#input = this.createGain());
    input.connect(this.#out);
    // The library uses `stream` and sets `channelCount`, which a GainNode has.
    return Object.assign(input, { stream: this.#out.stream }) as unknown as MediaStreamAudioDestinationNode;
  }
};

export function resumeAudio() {
  for (const c of contexts) if (c.state !== "running") c.resume().catch(() => {});
}

// Setting srcObject reloads the element even to the stream it already has.
// Skip that, so the shared stream above stays playing across a switch.
export function keepSource(audio: HTMLMediaElement) {
  const { get, set } = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject")!;
  Object.defineProperty(audio, "srcObject", {
    get() {
      return get!.call(this);
    },
    set(v: MediaProvider | null) {
      if (v !== get!.call(this)) set!.call(this, v);
    },
  });
}
