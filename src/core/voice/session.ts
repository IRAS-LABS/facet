/**
 * Lock-screen controls and keeping the screen awake (item 35).
 *
 * What this honestly does and does not do, because the difference matters and
 * is easy to oversell:
 *
 * **Does.** Puts the document's title and a play/pause/skip set on the
 * lock screen and in the notification shade, so the headphone button and the
 * car stereo work. Holds a screen wake lock so a long paper is not cut off by
 * the display timeout. Both degrade to nothing on a browser or a build that
 * lacks them, which is why every call here is guarded rather than
 * feature-detected once at the top: a WebView can have `navigator.mediaSession`
 * and still throw on an action it does not implement.
 *
 * **Does not.** Guarantee playback continues after the screen goes off.
 * Android suspends a WebView's timers aggressively, and surviving that needs a
 * foreground service on the Android side of the app, which FACET does not
 * have. A media element plus a wake lock is as far as the web side reaches. In
 * practice playback usually continues while the wake lock is held and stops
 * some time after the screen actually locks.
 */

export interface Controls {
  play(): void;
  pause(): void;
  next(): void;
  previous(): void;
  seek(fraction: number): void;
  stop(): void;
}

export interface NowPlaying {
  title: string;
  /** The section or page, shown as the "artist" line. */
  detail: string;
  /** 0-1 through the document. */
  progress: number;
}

type Session = MediaSession & {
  setActionHandler(action: string, handler: ((d: unknown) => void) | null): void;
};

const session = (): Session | null => {
  try {
    return (navigator.mediaSession as Session | undefined) ?? null;
  } catch {
    return null;
  }
};

/** Put the transport on the lock screen. Returns a function that takes it off. */
export function mediaControls(c: Controls): () => void {
  const ms = session();
  if (!ms) return () => {};

  const handlers: [string, (d: unknown) => void][] = [
    ["play", () => c.play()],
    ["pause", () => c.pause()],
    ["stop", () => c.stop()],
    ["nexttrack", () => c.next()],
    ["previoustrack", () => c.previous()],
    // Ten seconds either way is what every other player means by these, and
    // what a steering-wheel button sends. A sentence is the nearest thing this
    // reader has to it and is closer to what somebody actually wants back.
    ["seekforward", () => c.next()],
    ["seekbackward", () => c.previous()],
  ];

  for (const [action, fn] of handlers) {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      // Not every action exists in every WebView, and the ones that do not
      // throw rather than returning anything.
    }
  }

  return () => {
    for (const [action] of handlers) {
      try {
        ms.setActionHandler(action, null);
      } catch {
        /* going away anyway */
      }
    }
    try {
      ms.playbackState = "none";
      ms.metadata = null;
    } catch {
      /* ditto */
    }
  };
}

/** Update what the lock screen shows. Safe to call on every position change. */
export function nowPlaying(what: NowPlaying, playing: boolean): void {
  const ms = session();
  if (!ms) return;

  try {
    ms.playbackState = playing ? "playing" : "paused";
  } catch {
    /* older WebViews have the handlers but not the state */
  }

  try {
    // Rebuilt rather than mutated: `MediaMetadata` is not live, and assigning
    // to a field of the existing one is silently ignored on Android.
    ms.metadata = new MediaMetadata({
      title: what.title,
      artist: what.detail,
      album: "FACET",
    });
  } catch {
    /* no MediaMetadata in this engine */
  }
}

interface Sentinel {
  release(): Promise<void>;
  addEventListener(type: "release", fn: () => void): void;
}

/**
 * Keep the screen on while reading.
 *
 * The lock is dropped by the system whenever the page is hidden and must be
 * taken again when it comes back, which is what the visibility listener is
 * for. Without it, reading survives exactly one trip to another app.
 */
export class Awake {
  private lock: Sentinel | null = null;
  private wanted = false;
  private readonly onVisible = (): void => {
    if (this.wanted && document.visibilityState === "visible") void this.take();
  };

  constructor() {
    document.addEventListener("visibilitychange", this.onVisible);
  }

  async on(): Promise<void> {
    this.wanted = true;
    await this.take();
  }

  async off(): Promise<void> {
    this.wanted = false;
    const lock = this.lock;
    this.lock = null;
    try {
      await lock?.release();
    } catch {
      /* already gone */
    }
  }

  dispose(): void {
    document.removeEventListener("visibilitychange", this.onVisible);
    void this.off();
  }

  private async take(): Promise<void> {
    if (this.lock) return;
    const api = (navigator as Navigator & {
      wakeLock?: { request(kind: "screen"): Promise<Sentinel> };
    }).wakeLock;
    if (!api) return;
    try {
      const lock = await api.request("screen");
      if (!this.wanted) {
        void lock.release();
        return;
      }
      this.lock = lock;
      lock.addEventListener("release", () => {
        if (this.lock === lock) this.lock = null;
      });
    } catch {
      // Refused (a battery saver, a policy, no user gesture yet). Reading still
      // works; the screen just times out, which is the pre-existing behaviour.
    }
  }
}
