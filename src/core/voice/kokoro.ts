/**
 * Kokoro as an engine the player can use (item 22).
 *
 * This is the voice the owner's own console has always used, which is the
 * reason it is here rather than any of the other open models: the app and the
 * console should sound like the same thing.
 *
 * It works differently from the system engine in one way that shapes this
 * whole file. The system synthesiser speaks, streaming, and tells you where it
 * has got to. Kokoro produces a complete waveform and then you play it. So
 * everything the player needs -- pause, resume, stop, word positions, a speed
 * change part-way through -- has to be built here on top of an audio buffer
 * rather than asked for.
 *
 * That has one genuine advantage worth stating: because the audio exists
 * before it is played, the *next* sentence can be synthesised while the
 * current one is still speaking. Kokoro takes a few hundred milliseconds on a
 * laptop and rather longer on a phone, and without that overlap there would be
 * an audible gap at the end of every sentence. With it, there is none.
 *
 * The waveform is played through an `<audio>` element rather than Web Audio,
 * which looks like the more primitive choice and is not. Android only treats a
 * media element as playback: it is what earns the lock-screen controls, and it
 * is what has a chance of surviving the screen going off. A Web Audio graph
 * gets suspended with the page and shows the user nothing to press. The cost
 * is a WAV header per sentence, which is forty-four bytes.
 */

import type { Engine, SpeakCallbacks, Speaking, Utterance } from "./engine";
import { followClock, SILENT, wordSchedule } from "./engine";
import type { Ask, KokoroReply, KokoroRequest } from "./kokoro-worker";
import { SAMPLE_RATE } from "./kokoro-worker";
import { fetchModel, fetchVoice, part, status, voiceKey } from "./pack";
import { phonemise, tokenise } from "./phonemes";
import { DEFAULT_VOICE, kokoroInfo, kokoroVoices, type VoiceInfo } from "./voices";

/** Each voice file is 511 style vectors of 256 floats, one per token length. */
const STYLE_DIM = 256;
const STYLE_ROWS = 511;

/** How many sentences to keep synthesised ahead of the one playing. */
const LOOKAHEAD = 1;

class Worker0 {
  private worker: Worker | null = null;
  private next = 1;
  private waiting = new Map<number, { resolve(r: KokoroReply): void; reject(e: Error): void }>();

  private start(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL("./kokoro-worker.ts", import.meta.url), { type: "module" });

    w.onmessage = (e: MessageEvent<KokoroReply>): void => {
      const pending = this.waiting.get(e.data.id);
      if (!pending) return;
      this.waiting.delete(e.data.id);
      if (e.data.ok) pending.resolve(e.data);
      else pending.reject(new Error(e.data.error));
    };

    // A worker that dies takes every request in flight with it. Rejecting them
    // is what turns a hang into a message the user can act on.
    w.onerror = (e): void => {
      const err = new Error(e.message || "The voice engine stopped");
      for (const p of this.waiting.values()) p.reject(err);
      this.waiting.clear();
      this.worker = null;
    };

    this.worker = w;
    return w;
  }

  send(req: Ask<KokoroRequest>, transfer: Transferable[] = []): Promise<KokoroReply> {
    const w = this.start();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      w.postMessage({ ...req, id } as KokoroRequest, transfer);
    });
  }

  stop(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.waiting.values()) p.reject(new Error("The voice engine was stopped"));
    this.waiting.clear();
  }
}

export class KokoroEngine implements Engine {
  readonly id = "kokoro" as const;
  readonly label = "Kokoro (natural)";

  private worker = new Worker0();
  private loaded = false;
  private loading: Promise<void> | null = null;
  private styles = new Map<string, Float32Array>();
  /** Blob URLs handed to the media element, revoked when they are finished with. */
  private urls = new Set<string>();
  /** Synthesised and waiting to play, keyed by voice, speed and text. */
  private ahead = new Map<string, Promise<Float32Array>>();

  async ready(): Promise<boolean> {
    if (typeof Worker === "undefined") return false;
    return (await status()).installed;
  }

  async voices(): Promise<VoiceInfo[]> {
    return kokoroVoices();
  }

  /**
   * Get the model into the worker.
   *
   * Memoised on the promise rather than the result, so two sentences that
   * arrive at once do not load an 88 MB model twice.
   */
  private load(): Promise<void> {
    this.loading ??= (async () => {
      const model = await part("model");
      if (!model) throw new Error("The Kokoro voice pack is not installed");
      // The buffer is transferred into the worker, so IndexedDB's copy is read
      // again next time rather than being reused from here.
      await this.worker.send({ op: "load", model }, [model]);
      this.loaded = true;
    })();
    return this.loading;
  }

  /**
   * The style vector for a voice at a given token length.
   *
   * Kokoro's voice files hold one vector per possible utterance length -- the
   * voice is conditioned on how much it is about to say -- so the row is
   * picked by token count rather than the file being one flat embedding.
   */
  private async style(voice: string, tokens: number): Promise<Float32Array> {
    let data = this.styles.get(voice);
    if (!data) {
      const info = kokoroInfo(voice);
      const bytes = (await part(voiceKey(voice))) ?? (await fetchVoice(voice, info.name));
      data = new Float32Array(bytes);
      this.styles.set(voice, data);
    }

    const row = Math.max(0, Math.min(STYLE_ROWS - 1, tokens - 1));
    const at = row * STYLE_DIM;
    if (at + STYLE_DIM > data.length) throw new Error(`The voice file for ${voice} is the wrong size`);
    return data.slice(at, at + STYLE_DIM);
  }

  /** Synthesise one piece of text. Cached so a look-ahead is not wasted. */
  private synth(text: string, voice: string, speed: number): Promise<Float32Array> {
    const key = `${voice}|${speed}|${text}`;
    const have = this.ahead.get(key);
    if (have) return have;

    const job = (async () => {
      if (!this.loaded) await this.load();
      // The voice decides the accent the phonemiser aims at: a British voice
      // handed American phonemes says "wawter" in an English accent, which is
      // nobody's idea of either.
      const { ipa } = await phonemise(text, kokoroInfo(voice).lang);
      const tokens = tokenise(ipa);
      if (tokens.length <= 2) return new Float32Array(0);

      const style = await this.style(voice, tokens.length);
      const reply = await this.worker.send({ op: "speak", tokens, style, speed });
      if (!reply.ok || reply.op !== "speak") throw new Error("Synthesis failed");
      return reply.audio;
    })();

    this.ahead.set(key, job);
    // A failed synthesis must not be cached: the user pressing play again
    // should retry, not be handed the same rejection forever.
    job.catch(() => this.ahead.delete(key));

    // Keep the cache small. These are seconds of audio each.
    if (this.ahead.size > LOOKAHEAD + 2) {
      const oldest = this.ahead.keys().next().value;
      if (oldest !== undefined && oldest !== key) this.ahead.delete(oldest);
    }
    return job;
  }

  /** Synthesise something the player expects to need next. */
  prepare(text: string, voice: string, speed: number): void {
    if (!text.trim()) return;
    void this.synth(text, voice, speed).catch(() => {});
  }

  async speak(u: Utterance, cb: SpeakCallbacks): Promise<Speaking> {
    let stopped = false;
    let follower: { stop(): void } | null = null;
    let url = "";

    const release = (): void => {
      if (!url) return;
      URL.revokeObjectURL(url);
      this.urls.delete(url);
      url = "";
    };

    try {
      const voice = u.voice || DEFAULT_VOICE;
      // Kokoro takes speed as a synthesis parameter, so the audio is generated
      // at the right rate rather than resampled. Playing a buffer faster would
      // raise the pitch with it, which is exactly the chipmunk effect people
      // complain about in other readers.
      const audio = await this.synth(u.text, voice, clamp(u.rate, 0.5, 4));
      if (stopped) return SILENT;

      if (audio.length === 0) {
        cb.onEnd?.();
        return SILENT;
      }

      url = URL.createObjectURL(new Blob([wav(audio, SAMPLE_RATE)], { type: "audio/wav" }));
      this.urls.add(url);

      const el = new Audio(url);
      el.volume = clamp(u.volume, 0, 1);
      // Pitch is not something Kokoro takes. `preservesPitch = false` turns the
      // playback rate into a pitch shift, which is the honest way to offer the
      // control at all -- it moves the speed with it, so the reader only uses
      // it when the user has actually pushed the slider off 1.
      if (u.pitch !== 1) {
        el.preservesPitch = false;
        el.playbackRate = clamp(u.pitch, 0.5, 2);
      }

      const length = audio.length / SAMPLE_RATE;

      el.onended = (): void => {
        if (stopped) return;
        follower?.stop();
        release();
        cb.onEnd?.();
      };

      el.onerror = (): void => {
        if (stopped) return;
        follower?.stop();
        release();
        cb.onError?.(new Error("The voice could not be played"));
      };

      // Word positions are estimated against the element's own clock. Kokoro
      // does not report where it is, and an estimate driven by the clock stays
      // in step through a pause in a way a timer would not.
      follower = followClock(
        wordSchedule(u.text),
        () => Math.min(1, el.currentTime / length),
        (at) => cb.onWord?.(at),
      );

      await el.play();

      return {
        stop: (): void => {
          stopped = true;
          follower?.stop();
          el.pause();
          el.src = "";
          release();
        },
        pause: (): boolean => {
          el.pause();
          return true;
        },
        resume: (): boolean => {
          void el.play();
          return true;
        },
      };
    } catch (err) {
      release();
      if (!stopped) cb.onError?.(err);
      return SILENT;
    }
  }

  /** Download the model, with progress. The reader asks before calling this. */
  async installPack(
    onProgress: (done: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await fetchModel((p) => onProgress(p.done, p.total), signal);
    await fetchVoice(DEFAULT_VOICE, kokoroInfo(DEFAULT_VOICE).name, undefined, signal);
  }

  dispose(): void {
    this.worker.stop();
    this.ahead.clear();
    this.styles.clear();
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls.clear();
    this.loaded = false;
    this.loading = null;
  }
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Wrap a waveform in the smallest WAV that every decoder accepts.
 *
 * 16-bit rather than 32-bit float: half the size for audio that came out of a
 * quantised model in the first place, and no WAVE_FORMAT_EXTENSIBLE header to
 * get wrong. The clamp matters -- Kokoro occasionally pushes just past 1 on a
 * plosive, and without it that wraps around into a click.
 */
function wav(samples: Float32Array, rate: number): ArrayBuffer {
  const out = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(out);

  const text = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };

  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);     // bytes per second
  view.setUint16(32, 2, true);            // bytes per frame
  view.setUint16(34, 16, true);           // bits per sample
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const n = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, n < 0 ? n * 0x8000 : n * 0x7fff, true);
  }
  return out;
}
