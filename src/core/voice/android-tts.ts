/**
 * Android's own voices, reached natively.
 *
 * **Why this file exists.** Android's WebView does not implement the Web Speech
 * API's synthesis side. `window.speechSynthesis` is there, so feature detection
 * says the feature is available; `getVoices()` returns an empty list forever and
 * `speak()` makes no sound. Chrome for Android has it. The WebView that every
 * Tauri and Cordova app actually runs in does not. That is how read-aloud came
 * to say "No voices on this machine" on a phone with two working speech engines
 * and an English voice pack installed.
 *
 * The fix is to stop asking the WebView and ask Android. `SpeechBridge.kt` binds
 * `android.speech.tts.TextToSpeech`; `speech.rs` fences it and re-emits its
 * progress as a Tauri event. This file is the frontend half, shaped to look
 * exactly like the browser API from the outside so `SystemEngine` can prefer
 * whichever one actually works and nothing above it has to know.
 *
 * It matters more here than anywhere else that this works: on a phone the
 * platform voices are *the good option*. Google's and Samsung's Android voices
 * are neural, local and free, which is a better default than asking somebody on
 * mobile data to fetch an 88 MB model.
 */

import type { VoiceInfo } from "./voices";
import { languageName } from "./voices";

/** One voice, as Kotlin describes it. */
interface NativeVoice {
  id: string;
  name: string;
  lang: string;
  network: boolean;
  quality: number;
}

interface VoiceReply {
  /** 0 not started, 1 binding, 2 usable, -1 refused. */
  state: number;
  voices: NativeVoice[];
}

/** What `speech.rs` emits while an utterance is in flight. */
export interface SpeechEvent {
  id: string;
  kind: "start" | "word" | "end" | "error" | "stop";
  from: number;
  to: number;
}

/** How long to let the engine bind before calling it absent. */
const BIND_WAIT = 4_000;
const BIND_POLL = 200;

let invokeOnce: Promise<typeof import("@tauri-apps/api/core").invoke> | null = null;

async function invoker(): Promise<typeof import("@tauri-apps/api/core").invoke> {
  invokeOnce ??= import("@tauri-apps/api/core").then((m) => m.invoke);
  return invokeOnce;
}

/**
 * The voices Android will speak with.
 *
 * Waits for the engine to finish binding rather than reporting the empty list
 * it has during the first second -- that empty list is exactly the bug this
 * file exists to fix, and reproducing it here would be a poor joke.
 */
export async function voices(): Promise<VoiceInfo[]> {
  const list = await nativeVoices();
  if (!list) return [];
  return list.map(describe);
}

async function nativeVoices(): Promise<NativeVoice[] | null> {
  let invoke: Awaited<ReturnType<typeof invoker>>;
  try {
    invoke = await invoker();
  } catch {
    return null;
  }

  const deadline = Date.now() + BIND_WAIT;
  for (;;) {
    let reply: VoiceReply;
    try {
      const raw = await invoke<string>("speech_voices");
      reply = JSON.parse(raw) as VoiceReply;
    } catch {
      // The command is not in this build, or the bridge is not reachable.
      return null;
    }
    if (reply.state === 2 && Array.isArray(reply.voices) && reply.voices.length > 0) {
      return reply.voices;
    }
    // -1 is a refusal and 0 is "no engine here": neither gets better by asking
    // again. 1 is the engine still binding, which is the only case worth
    // waiting on.
    if (reply.state !== 1 || Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, BIND_POLL));
  }
}

/**
 * Turn an Android voice into the shape the picker uses.
 *
 * Kotlin has already turned the identifier into something readable; what is
 * added here is the two things a person chooses on. A voice that needs the
 * network is marked, because the whole promise of read-aloud is that nothing
 * leaves the machine, and picking one of those quietly breaks it.
 */
function describe(v: NativeVoice): VoiceInfo {
  const gender = /\bfemale\b/i.test(v.name) ? "female" : /\bmale\b/i.test(v.name) ? "male" : "";
  const language = languageName(v.lang) || v.lang;
  const name = shortName(v.name, language) || v.id;
  const detail = [
    // An engine that gives no real voice name gets the language as its name,
    // and printing that twice reads as a bug ("Urdu (Pakistan) - Urdu
    // (Pakistan)"), so the language is dropped when it is already the name.
    language === name ? "" : language,
    gender,
    v.network ? "needs the network" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    id: v.id,
    name,
    detail,
    lang: v.lang,
    gender,
    engine: "system",
    // Kotlin has already weighed three engine signals; the name is the fourth
    // and it costs nothing to check on this side too, because the cost of
    // getting this wrong is a picker offering a hundred languages the phone
    // cannot actually speak.
    offline: !v.network && !/-network$/i.test(v.id),
  };
}

/**
 * What is left of a voice's name once the list has said the rest.
 *
 * Google's engine names a voice after its identifier, so `vi-vn-x-gft-network`
 * arrives as "Vietnamese (Vietnam) gft female" -- and the picker then prints
 * the language and the gender again in the detail line beside it. What
 * actually tells two voices of one language apart is the middle part, so that
 * is all the name keeps. Samsung's voices have real names and match none of
 * this, which is the point: nothing is stripped that was not already shown.
 */
function shortName(raw: string, language: string): string {
  let name = raw.replace(/\s{2,}/g, " ").trim();
  if (name.toLowerCase().startsWith(language.toLowerCase())) {
    name = name.slice(language.length).trim();
  }
  name = name
    .replace(/(?:fe)?male/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return name || language;
}

/** Start speaking. Resolves with the utterance id, or "" when nothing was said. */
export async function speak(
  text: string,
  voice: string,
  rate: number,
  pitch: number,
  volume: number,
): Promise<string> {
  try {
    const invoke = await invoker();
    return await invoke<string>("speech_speak", { text, voice, rate, pitch, volume });
  } catch {
    return "";
  }
}

export async function stop(): Promise<void> {
  try {
    const invoke = await invoker();
    await invoke("speech_stop");
  } catch {
    // Stopping something that is not speaking is not a failure worth showing.
  }
}

/**
 * Listen to what happens to the utterances, until the returned function is
 * called.
 *
 * One listener serves every utterance -- they are distinguished by id in the
 * payload -- because binding and unbinding a Tauri listener per sentence is
 * both slower and racier than filtering here.
 */
export async function listen(on: (e: SpeechEvent) => void): Promise<() => void> {
  try {
    const { listen: bind } = await import("@tauri-apps/api/event");
    const drop = await bind<SpeechEvent>("speech", (e) => on(e.payload));
    return () => void drop();
  } catch {
    return () => {};
  }
}
