/**
 * The voices the machine already has (item 21).
 *
 * Every platform FACET runs on ships a speech synthesiser, and the browser
 * exposes it through one small API. It is not as good as Kokoro -- on Windows
 * it is noticeably not as good -- but it needs no download, no model, no wasm
 * and no waiting, so it is what plays the first time someone presses the play
 * button. Offering a 300 MB download before the feature has said a single word
 * is how features go unused.
 *
 * The API has three well-known problems and this file exists mostly to absorb
 * them:
 *
 * The voice list is empty on first call and arrives later, asynchronously,
 * with no promise to await -- only a `voiceschanged` event that some platforms
 * fire twice and some never fire at all.
 *
 * Long utterances are cut off. Chrome stops speaking after roughly fifteen
 * seconds unless the synthesiser is nudged; the standard workaround is to
 * pause and resume it on a timer, which is as silly as it sounds and is still
 * the only thing that works. Utterances here are capped at 300 characters
 * upstream, which keeps most of them under the limit, and the nudge covers the
 * rest.
 *
 * `cancel()` is asynchronous and can deliver the cancelled utterance's `end`
 * event *after* the next one has started, which makes a naive player skip a
 * sentence every time the user presses pause. Every callback here is gated on
 * a token that is invalidated the moment we stop caring.
 *
 * And a fourth problem, which is not a quirk but an absence: **Android's
 * WebView does not implement synthesis at all.** `speechSynthesis` is present,
 * so the checks above all pass, and then `getVoices()` is empty forever and
 * `speak()` is silent. The phone's own engines -- Google's and Samsung's, both
 * neural, both already installed -- are perfectly fine; the WebView just will
 * not hand them to web code the way Chrome for Android does. So when the
 * browser gives us nothing, this engine asks Android directly through
 * `android-tts`, and everything upstream carries on as if the browser had
 * answered.
 */

import type { Engine, SpeakCallbacks, Speaking, Utterance } from "./engine";
import { SILENT } from "./engine";
import * as native from "./android-tts";
import { languageName, type VoiceInfo } from "./voices";

/** How often to nudge the synthesiser so it does not stop early. */
const NUDGE = 10_000;

/** How long to wait for the voice list before giving up on it. */
const VOICE_WAIT = 3_000;

const speech = (): SpeechSynthesis | null =>
  typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;

/**
 * Wait for the voice list to be populated.
 *
 * Resolves with whatever is available when the event fires, when the poll
 * finds something, or when the timeout expires -- in that last case with an
 * empty list, which the caller reports as "no system voices" rather than
 * hanging on a promise that will never settle.
 */
function voiceList(): Promise<SpeechSynthesisVoice[]> {
  const s = speech();
  if (!s) return Promise.resolve([]);

  const now = s.getVoices();
  if (now.length > 0) return Promise.resolve(now);

  return new Promise((resolve) => {
    let done = false;
    const finish = (list: SpeechSynthesisVoice[]): void => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      s.removeEventListener("voiceschanged", onChange);
      resolve(list);
    };

    const onChange = (): void => {
      const list = s.getVoices();
      if (list.length > 0) finish(list);
    };

    // Belt and braces: some platforms populate the list without ever firing
    // the event, so the poll is the one that actually succeeds on them.
    const poll = setInterval(onChange, 150);
    const timer = setTimeout(() => finish(s.getVoices()), VOICE_WAIT);
    s.addEventListener("voiceschanged", onChange);
    onChange();
  });
}

/** Turn a platform voice into the shape the picker uses. */
function describe(v: SpeechSynthesisVoice): VoiceInfo {
  // Platform names are a mess: "Microsoft Aria Online (Natural) - English
  // (United States)", "Google UK English Female", "com.apple.voice.compact.
  // en-GB.Daniel". Everything after a dash, anything in brackets and any
  // vendor prefix is noise the user does not need in a list.
  let name = v.name
    .replace(/\s*[-–]\s*[^-–]*$/, "")
    .replace(/\((?:natural|enhanced|premium|compact|online)\)/gi, "")
    .replace(/^(microsoft|google|apple|amazon|samsung)\s+/i, "")
    .replace(/\s+(online|desktop|mobile)$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!name) name = v.name;

  const gender = /\bfemale\b/i.test(v.name) ? "female" : /\bmale\b/i.test(v.name) ? "male" : "";

  return {
    id: v.voiceURI,
    name,
    detail: [languageName(v.lang), gender].filter(Boolean).join(" "),
    lang: v.lang,
    gender,
    engine: "system",
    // `localService` is false for the cloud voices Edge and Chrome expose.
    offline: v.localService,
  };
}

export class SystemEngine implements Engine {
  readonly id = "system" as const;
  readonly label = "System voices";

  private cache: SpeechSynthesisVoice[] = [];
  /** Android's voices, when the WebView turned out to have none of its own. */
  private phone: VoiceInfo[] = [];
  /** Invalidated on every stop, so a late event from a cancelled utterance is ignored. */
  private token = 0;
  private nudge: ReturnType<typeof setInterval> | null = null;
  /** Bound once, for as long as the engine lives; utterances are told apart by id. */
  private unlisten: (() => void) | null = null;
  /** The utterance currently being followed, and where to send what happens to it. */
  private watching = "";
  private watcher: SpeakCallbacks | null = null;

  async ready(): Promise<boolean> {
    this.cache = speech() ? await voiceList() : [];
    if (this.cache.length > 0) return true;
    // Nothing from the browser. On a phone that is the WebView's gap, not a
    // machine without a voice, so ask Android before reporting failure.
    this.phone = await native.voices();
    return this.phone.length > 0;
  }

  async voices(): Promise<VoiceInfo[]> {
    if (this.cache.length === 0 && this.phone.length === 0) await this.ready();
    if (this.cache.length > 0) return this.cache.map(describe);
    return this.phone;
  }

  async speak(u: Utterance, cb: SpeakCallbacks): Promise<Speaking> {
    if (this.cache.length === 0 && this.phone.length === 0) await this.ready();
    if (this.phone.length > 0 && this.cache.length === 0) return this.speakNative(u, cb);

    const s = speech();
    if (!s) {
      cb.onError?.(new Error("No speech synthesiser on this system"));
      return SILENT;
    }

    const mine = ++this.token;
    const live = (): boolean => this.token === mine;

    // A cancel already in flight can still deliver events; bumping the token
    // above before cancelling means those events are already disowned.
    s.cancel();

    const said = new SpeechSynthesisUtterance(u.text);
    const voice = this.cache.find((v) => v.voiceURI === u.voice);
    if (voice) {
      said.voice = voice;
      said.lang = voice.lang;
    }
    // The API's own range is 0.1-10, but nothing above 4 is intelligible and
    // several platforms simply refuse values outside 0.5-2 by speaking at 1.
    said.rate = Math.min(4, Math.max(0.5, u.rate));
    said.pitch = Math.min(2, Math.max(0, u.pitch));
    said.volume = Math.min(1, Math.max(0, u.volume));

    said.onboundary = (e): void => {
      if (!live()) return;
      if (e.name && e.name !== "word") return;
      cb.onWord?.({
        charIndex: e.charIndex,
        // charLength is optional in the spec and absent on Windows; measuring
        // the word from the text is exact where it is missing.
        length: e.charLength || wordLength(u.text, e.charIndex),
        estimated: false,
      });
    };

    said.onend = (): void => {
      if (!live()) return;
      this.stopNudge();
      cb.onEnd?.();
    };

    said.onerror = (e): void => {
      if (!live()) return;
      this.stopNudge();
      // "interrupted" and "canceled" are what a deliberate stop looks like
      // from in here, and reporting them as errors would put a failure notice
      // on screen every time the user pressed pause.
      if (e.error === "interrupted" || e.error === "canceled") return;
      cb.onError?.(new Error(`Speech failed: ${e.error}`));
    };

    s.speak(said);
    this.startNudge();

    return {
      stop: (): void => {
        if (this.token === mine) this.token++;
        this.stopNudge();
        s.cancel();
      },
      pause: (): boolean => {
        s.pause();
        this.stopNudge();
        return true;
      },
      resume: (): boolean => {
        s.resume();
        this.startNudge();
        return true;
      },
    };
  }

  /**
   * Speak through Android's own engine.
   *
   * Shaped to be indistinguishable from the browser path above: the same token
   * gate, the same callbacks, the same `Speaking` handle. The one honest
   * difference is `pause()`, which returns false because `TextToSpeech` has no
   * pause -- the player already handles that by stopping and re-speaking from
   * the word it had reached, which is what it does for Kokoro too.
   */
  private async speakNative(u: Utterance, cb: SpeakCallbacks): Promise<Speaking> {
    const mine = ++this.token;
    const live = (): boolean => this.token === mine;

    await this.bind();
    this.watcher = cb;

    const id = await native.speak(u.text, u.voice, u.rate, u.pitch, u.volume);
    if (!live()) {
      // Stopped while the call was in flight. Whatever started must not be left
      // talking over the next sentence.
      if (id) void native.stop();
      return SILENT;
    }
    if (!id) {
      cb.onError?.(new Error("The phone's speech engine would not start"));
      return SILENT;
    }
    this.watching = id;

    return {
      stop: (): void => {
        if (this.token === mine) this.token++;
        this.watching = "";
        this.watcher = null;
        void native.stop();
      },
      pause: (): boolean => false,
      resume: (): boolean => false,
    };
  }

  /** Start listening for Android's progress, once. */
  private async bind(): Promise<void> {
    if (this.unlisten) return;
    this.unlisten = await native.listen((e) => {
      if (e.id !== this.watching) return;
      const cb = this.watcher;
      if (!cb) return;
      if (e.kind === "word") {
        cb.onWord?.({
          charIndex: e.from,
          length: Math.max(1, e.to - e.from),
          estimated: false,
        });
        return;
      }
      if (e.kind === "end") {
        this.watching = "";
        this.watcher = null;
        cb.onEnd?.();
        return;
      }
      if (e.kind === "error") {
        this.watching = "";
        this.watcher = null;
        cb.onError?.(new Error("The phone's speech engine stopped"));
        return;
      }
      // "start" needs nothing doing, and "stop" is a deliberate pause: telling
      // the player it ended would advance it a sentence every time.
    });
  }

  dispose(): void {
    this.token++;
    this.stopNudge();
    this.watching = "";
    this.watcher = null;
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    speech()?.cancel();
    if (this.phone.length > 0) void native.stop();
  }

  /**
   * Keep the synthesiser awake.
   *
   * Chrome's synthesiser stops speaking after about fifteen seconds of one
   * utterance. Pausing and immediately resuming resets that timer and is
   * inaudible. It is a well-known bug with no better workaround.
   */
  private startNudge(): void {
    this.stopNudge();
    this.nudge = setInterval(() => {
      const s = speech();
      if (!s || !s.speaking || s.paused) return;
      s.pause();
      s.resume();
    }, NUDGE);
  }

  private stopNudge(): void {
    if (this.nudge !== null) {
      clearInterval(this.nudge);
      this.nudge = null;
    }
  }
}

/** Length of the word starting at `at`. */
function wordLength(text: string, at: number): number {
  let i = at;
  while (i < text.length && !/\s/.test(text[i] as string)) i++;
  return Math.max(1, i - at);
}
