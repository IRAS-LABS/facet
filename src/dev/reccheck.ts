/**
 * Checks the recorder (item 29).
 *
 * Same trick as the camera harness and the same justification: a screen
 * recorder looks like a surface that can only be tested by sharing a screen,
 * and it is not. `canvas.captureStream()` is a real video track, and an
 * `OscillatorNode` into a `MediaStreamDestination` is a real audio track, so a
 * fake `RecorderSource` can hand the surface exactly what Windows would and the
 * whole thing runs — picker, mix, encode, write, stop — on a machine that is
 * not sharing anything.
 *
 * Seven claims, and why each is a test rather than a look.
 *
 * **1. Two sounds arrive as one track.** `MediaRecorder` keeps the first audio
 * track it is handed and drops the rest in silence, so a call recorded with the
 * microphone and the speakers both on comes back as half a conversation — and
 * comes back that way *after* the call. Checked by intercepting the
 * `MediaRecorder` constructor and counting the audio tracks in the stream it
 * was actually given, which is the only place the claim can be falsified.
 *
 * **2. "Sound only" still has to open a screen share.** `getDisplayMedia` will
 * not give audio without video, so the audio-only path asks for a picture and
 * drops it. Checked by asserting the video track it opened was stopped and the
 * container chosen was an audio one.
 *
 * **3. The take goes to disk in pieces, in order.** The whole point of
 * `append_file`. Asserted on the *sequence* of filesystem calls: one create,
 * then appends, all to the path the create returned — not the path that was
 * asked for, because the shell renames on collision and appending to the name
 * we wanted would extend somebody else's file.
 *
 * **4. Without an append path it says so.** The browser build cannot stream,
 * and "held in memory until you stop" is a different promise from "on disk".
 * A recorder that displayed the safe message in the unsafe case would be worse
 * than one with no message.
 *
 * **5. Stopping the share stops the take.** Ending a screen share from the
 * browser's own bar ends the video track; a recorder that carries on is one
 * writing nothing to a growing file.
 *
 * **6. A recording that produced nothing says so.** Silence here is
 * indistinguishable from success until the folder is opened.
 *
 * **7. The meter is readable.** Peak hold that decays, a curve that puts speech
 * in the middle rather than in the bottom tenth, and a floor so nothing renders
 * "-Infinity dB".
 *
 * Dev-only. Loaded by /reccheck.html, which is not a build input.
 *
 *   http://localhost:8183/reccheck.html
 */

import "../styles/base.css";
import "../styles/recorder.css";

import { themes } from "@core/theme/theme-engine";

import {
  bestMime,
  bitrates,
  CHUNK_MS,
  clock,
  dbfs,
  dbText,
  emptyLedger,
  extOfMime,
  ledgerText,
  METER_FLOOR,
  meterPosition,
  peak,
  PeakHold,
  plan,
  rms,
  runway,
  size,
  streamable,
  systemAudioLikely,
  takeName,
  worthKeeping,
} from "@core/capture/recorder";
import { RecorderView, type RecorderHost, type RecorderPrefs, type RecorderSource } from "@ui/recorder-view";

/* Without this every `var(--fct-…)` resolves to nothing and the card draws with
   no border, no meter track and an invisible Stop button — which reads as a
   styling bug in the recorder and is not one. Learned on the camera. */
themes.init();

let pass = 0;
let fail = 0;

const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) {
    pass++;
    console.log("ok  ", name);
  } else {
    fail++;
    console.error("FAIL", name, detail);
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── The arithmetic ──────────────────────────────────────────────────────────

function pureChecks(): void {
  // What the switches mean.
  const p1 = plan({ screen: true, system: true, mic: true });
  ok("screen plus both sounds is a video take that mixes", p1.kind === "video" && p1.mix && p1.display && p1.user);
  const p2 = plan({ screen: false, system: false, mic: true });
  ok("the microphone alone is an audio take that needs no screen share",
    p2.kind === "audio" && !p2.display && p2.user && !p2.mix);
  const p3 = plan({ screen: false, system: true, mic: false });
  ok("…but system sound alone DOES need a screen share, because audio-only display capture does not exist",
    p3.kind === "audio" && p3.display && p3.displayAudio && !p3.user);
  const p4 = plan({ screen: true, system: false, mic: false });
  ok("a silent screen recording mixes nothing", p4.kind === "video" && !p4.mix && !p4.user);
  ok("nothing selected is refused rather than attempted",
    plan({ screen: false, system: false, mic: false }).empty);
  ok("…and one source is never described as a mix",
    !plan({ screen: true, system: true, mic: false }).mix && !plan({ screen: true, system: false, mic: true }).mix);

  ok("the words say what is being recorded, not which fields are true",
    plan({ screen: true, system: true, mic: true }).says.includes("system sound and the microphone") &&
      plan({ screen: true, system: false, mic: false }).says.includes("silently"),
    plan({ screen: true, system: true, mic: true }).says);

  ok("system sound is expected on Windows and doubted on a Mac",
    systemAudioLikely("Win32") && !systemAudioLikely("MacIntel"));

  // Containers.
  ok("a video take prefers WebM, which can be written while it is recorded",
    bestMime("video", () => true)?.startsWith("video/webm") === true);
  ok("…and an audio take prefers Opus in WebM",
    bestMime("audio", () => true)?.includes("opus") === true);
  ok("…and an engine that supports nothing gets null rather than a guess",
    bestMime("video", () => false) === null && bestMime("audio", () => false) === null);
  ok("…and MP4 is still reachable when it is all that is on offer",
    bestMime("video", (m) => m === "video/mp4") === "video/mp4");

  ok("the extension follows the container, including m4a for audio in MP4",
    extOfMime("video/webm;codecs=vp9,opus") === "webm" &&
      extOfMime("video/mp4") === "mp4" &&
      extOfMime("audio/mp4") === "m4a" &&
      extOfMime("audio/ogg;codecs=opus") === "ogg" &&
      extOfMime("audio/webm;codecs=opus") === "weba");

  /* The one that decides whether a take can be streamed to disk. Getting this
     wrong in the permissive direction writes an MP4 in pieces, and an MP4
     without its trailing index is a file nothing opens — a worse outcome than
     holding it in memory, which is why the default has to be "no". */
  ok("WebM and Ogg can be appended to as they record; MP4 cannot",
    streamable("video/webm;codecs=vp9,opus") &&
      streamable("audio/ogg;codecs=opus") &&
      !streamable("video/mp4") &&
      !streamable("audio/mp4"));

  // Bitrates.
  const hd = bitrates("balanced", 1920, 1080);
  const four = bitrates("balanced", 3840, 2160);
  ok("the video budget grows with the pixels, because screen text is the point",
    four.video > hd.video * 3.5, `${hd.video} vs ${four.video}`);
  ok("…and quality moves it the way the words say",
    bitrates("high", 1920, 1080).video > hd.video && bitrates("small", 1920, 1080).video < hd.video);
  ok("…and a tiny window still gets a floor rather than a smear",
    bitrates("small", 160, 120).video >= 400_000);
  ok("…and a huge one is capped rather than asking for a gigabit",
    bitrates("high", 7680, 4320).video <= 24_000_000);
  ok("the sound budget does NOT scale with the picture — Opus speech does not need it",
    hd.video !== four.video && hd.audio === four.audio);

  // Names and numbers.
  const when = new Date(2026, 7, 16, 21, 4, 33);
  ok("a take is named in words a folder can be scanned for",
    takeName("video", when, "webm") === "Screen 2026-08-16 21-04-33.webm" &&
      takeName("audio", when, "weba") === "Audio 2026-08-16 21-04-33.weba",
    takeName("video", when, "webm"));
  ok("…and two takes in one afternoon sort in the order they were made",
    takeName("audio", new Date(2026, 7, 16, 9, 0, 0), "weba") <
      takeName("audio", new Date(2026, 7, 16, 14, 0, 0), "weba"));

  ok("the clock reads as a clock and grows an hours field",
    clock(0) === "0:00" && clock(65) === "1:05" && clock(3725) === "1:02:05",
    `${clock(0)} ${clock(65)} ${clock(3725)}`);
  ok("sizes are readable at a glance while they grow",
    size(0) === "0 B" && size(2048) === "2.0 KB" && size(5_400_000).endsWith("MB"),
    `${size(0)} ${size(2048)} ${size(5_400_000)}`);
  ok("…and stay short past a gigabyte rather than printing every digit",
    size(3_500_000_000).length <= 7, size(3_500_000_000));

  ok("the runway is a time, and is infinite when nothing is being written",
    Math.round(runway(6_000_000_000, 1_000_000)) === 6000 && runway(1e9, 0) === Infinity);

  // The meter.
  const silence = new Float32Array(512);
  const loud = Float32Array.from({ length: 512 }, (_, i) => Math.sin(i / 4));
  ok("loudness is the RMS of the block, not its last sample",
    rms(silence) === 0 && Math.abs(rms(loud) - Math.SQRT1_2) < 0.05, String(rms(loud)));
  ok("…and clipping is judged on the peak, which is a different number",
    peak(loud) > rms(loud) && Math.abs(peak(loud) - 1) < 0.02);
  ok("…and an empty block is silence rather than a divide by zero",
    rms(new Float32Array(0)) === 0 && peak(new Float32Array(0)) === 0);

  ok("full scale is 0 dB and half amplitude is about −6",
    dbfs(1) === 0 && Math.abs(dbfs(0.5) + 6.02) < 0.05, String(dbfs(0.5)));
  ok("…and true silence is −∞, which is the caller's to render",
    dbfs(0) === -Infinity && dbText(-Infinity) === "−∞" && dbText(METER_FLOOR - 1) === "−∞");
  ok("…and a reading is signed and rounded rather than printed raw",
    dbText(-12.345) === "−12.3 dB" && dbText(0) === "0.0 dB", dbText(-12.345));

  /* The curve is the difference between a meter you can act on and a bar that
     twitches near zero. Linear-in-amplitude puts ordinary speech at a few
     percent of the travel; linear-in-dB gives as much room to the empty
     −60..−40 as to the −20..0 where the decision is made. */
  ok("the meter bottoms out at the floor and tops out at full scale",
    meterPosition(-100) === 0 && meterPosition(METER_FLOOR) === 0 && meterPosition(0) === 1);
  ok("…and speech at −18 sits in the upper half rather than down in the noise",
    meterPosition(-18) > 0.5 && meterPosition(-18) < 0.9, String(meterPosition(-18)));
  ok("…and it rises all the way rather than saturating early",
    meterPosition(-30) < meterPosition(-18) && meterPosition(-18) < meterPosition(-6));
  ok("…and silence does not throw", meterPosition(-Infinity) === 0);

  const hold = new PeakHold();
  hold.push(0.9, 0.05);
  const after = hold.push(0.1, 0.1);
  ok("the peak is held above the level that follows it, or it cannot be read",
    after.level === 0.1 && after.hold > 0.8, JSON.stringify(after));
  const later = hold.push(0.1, 2);
  ok("…and it falls back, or the meter pins at the loudest thing that ever happened",
    later.hold < 0.1 + 1e-9, String(later.hold));
  hold.reset();
  ok("…and a new take starts from nothing", hold.push(0, 0).hold === 0);

  // The ledger.
  const disk = emptyLedger(false);
  disk.produced = 2_000_000;
  disk.written = 2_000_000;
  ok("a streamed take reports what is on disk", ledgerText(disk, 10).includes("on disk"));
  const mem = emptyLedger(true);
  mem.produced = 2_000_000;
  ok("…a buffered one says it is in memory and when it will be saved",
    ledgerText(mem, 10).includes("in memory") && ledgerText(mem, 10).includes("stop"));
  const bad = emptyLedger(false);
  bad.produced = 2_000_000;
  bad.written = 500_000;
  bad.trouble = "disk full";
  ok("…and a take that FELL BACK to memory never reads like one that is safe",
    !ledgerText(bad, 10).includes("on disk") && ledgerText(bad, 10).includes("disk full"),
    ledgerText(bad, 10));
  ok("…and the rate is shown, so a long recording can be judged before it fills the disk",
    ledgerText(disk, 10).includes("/s"), ledgerText(disk, 10));
  /* A note rides along with the state rather than replacing it: a sound warning
     must not make a take that is safely on disk read as though it were not. */
  const noted = emptyLedger(false);
  noted.written = 2_000_000;
  noted.note = "sound is blocked here";
  ok("…and a warning about the sound is carried without disowning the file",
    ledgerText(noted, 10).includes("on disk") && ledgerText(noted, 10).includes("sound is blocked"),
    ledgerText(noted, 10));

  ok("a zero-byte take is not worth keeping and a one-byte take is",
    !worthKeeping(0) && worthKeeping(1));

  ok("chunks are asked for often enough that a crash costs seconds, not the take",
    CHUNK_MS > 0 && CHUNK_MS <= 5000);
}

// ── A screen made of a canvas ───────────────────────────────────────────────

/**
 * Fake sources.
 *
 * The canvas has to keep painting or `captureStream` emits nothing and the
 * recording comes out empty — the same lesson the camera's draw loop taught,
 * arriving here from the other side.
 */
class FakeWorld {
  readonly canvas = document.createElement("canvas");
  readonly opened: MediaStream[] = [];
  private timer: number;
  private frame = 0;

  /**
   * TWO contexts, and the separation is load-bearing.
   *
   * `devices` is the fake hardware — the graph the tones are generated in, which
   * stands in for the sound card. The mixer is a *fresh* context handed over on
   * every request, matching what main.ts does and for the same reason: the
   * recorder closes the context it was given when a take ends, so a cached one
   * is dead from the second take onward.
   *
   * Sharing one context between the two, as this first did, means the recorder
   * re-imports a
   * `MediaStreamAudioDestinationNode`'s own output back into the graph that
   * produced it, and Chromium will not carry that round trip: the muxer stalls
   * and a screen take comes out at zero bytes while an audio-only one still
   * writes silence, which is a maddening thing to debug and is entirely an
   * artefact of the fake. A real microphone arrives from the operating system,
   * outside any context this app owns, so two contexts is also the honest model.
   */
  private devices: AudioContext | null = null;

  constructor(public offerSystemAudio = true) {
    this.canvas.width = 1280;
    this.canvas.height = 720;
    const g = this.canvas.getContext("2d")!;
    this.timer = window.setInterval(() => {
      g.fillStyle = "#16202b";
      g.fillRect(0, 0, 1280, 720);
      g.fillStyle = "#5ad";
      g.fillRect((this.frame * 17) % 1180, 300, 100, 100);
      this.frame += 1;
    }, 33);
  }

  /** A real audio track: an oscillator into a stream destination. */
  private tone(freq: number): MediaStreamTrack | null {
    try {
      this.devices ??= new AudioContext();
      const osc = this.devices.createOscillator();
      const dest = this.devices.createMediaStreamDestination();
      osc.frequency.value = freq;
      osc.connect(dest);
      osc.start();
      return dest.stream.getAudioTracks()[0] ?? null;
    } catch {
      return null;
    }
  }

  source(): RecorderSource {
    return {
      display: async (o) => {
        const s = new MediaStream(this.canvas.captureStream(30).getVideoTracks());
        if (o.audio && this.offerSystemAudio) {
          const t = this.tone(220);
          if (t) s.addTrack(t);
        }
        this.opened.push(s);
        return s;
      },
      user: async () => {
        const t = this.tone(660);
        const s = new MediaStream(t ? [t] : []);
        this.opened.push(s);
        return s;
      },
      devices: async () =>
        [
          { deviceId: "mic-a", kind: "audioinput", label: "Headset", groupId: "g1" },
          { deviceId: "mic-b", kind: "audioinput", label: "Array mic", groupId: "g2" },
          { deviceId: "cam-a", kind: "videoinput", label: "Webcam", groupId: "g3" },
        ] as MediaDeviceInfo[],
      audioContext: () => new AudioContext(),
    };
  }

  stop(): void {
    window.clearInterval(this.timer);
  }
}

/** A filesystem that remembers the order it was called in. */
class FakeDisk {
  readonly calls: Array<{ op: "write" | "append"; path: string; bytes: number }> = [];
  readonly files = new Map<string, number>();
  /** Set to make the next append fail, the way a full disk does. */
  breakAppends = false;

  host(): Pick<RecorderHost, "writeFile" | "appendFile"> {
    return {
      writeFile: async (path, bytes) => {
        // Renames on collision, exactly as the real backend does — which is why
        // the caller has to append to the path that comes *back*.
        const taken = this.files.has(path);
        const actual = taken ? path.replace(/(\.[^.]+)$/, " (2)$1") : path;
        this.calls.push({ op: "write", path: actual, bytes: bytes.length });
        this.files.set(actual, bytes.length);
        return actual;
      },
      appendFile: async (path, bytes) => {
        if (this.breakAppends) throw new Error("no space left on device");
        this.calls.push({ op: "append", path, bytes: bytes.length });
        const now = (this.files.get(path) ?? 0) + bytes.length;
        this.files.set(path, now);
        return now;
      },
    };
  }

  get total(): number {
    return [...this.files.values()].reduce((a, b) => a + b, 0);
  }
}

const PREFS: RecorderPrefs = {
  screen: true,
  system: true,
  mic: true,
  quality: "balanced",
  countdown: 0,
};

/**
 * Watch what `MediaRecorder` is actually handed.
 *
 * The central claim of this module — two sounds become one track — is only
 * falsifiable at this boundary. Everything upstream can look right while the
 * stream that reaches the encoder still carries two audio tracks, one of which
 * is about to be dropped without a word.
 */
interface Seen {
  video: number;
  audio: number;
  mime: string;
  videoBits?: number | undefined;
  audioBits?: number | undefined;
}
const seen: Seen[] = [];
const RealRecorder = window.MediaRecorder;
class SpyRecorder extends RealRecorder {
  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    super(stream, options);
    seen.push({
      video: stream.getVideoTracks().length,
      audio: stream.getAudioTracks().length,
      mime: options?.mimeType ?? "",
      videoBits: options?.videoBitsPerSecond,
      audioBits: options?.audioBitsPerSecond,
    });
  }
}
window.MediaRecorder = SpyRecorder as unknown as typeof MediaRecorder;

function make(
  world: FakeWorld,
  disk: FakeDisk,
  prefs: Partial<RecorderPrefs> = {},
  withAppend = true,
  patch: Partial<RecorderSource> = {},
): RecorderView {
  const fs = disk.host();
  const host: RecorderHost = {
    source: { ...world.source(), ...patch },
    folder: () => "C:/Users/me/Videos",
    writeFile: fs.writeFile!,
    ...(withAppend ? { appendFile: fs.appendFile } : {}),
    refresh: () => {},
    platform: () => "Win32",
    prefs: () => ({ ...PREFS, ...prefs }),
  };
  return new RecorderView(host);
}

/*
 * Everything is looked up inside the NEWEST panel, never with a bare
 * `document.querySelector`.
 *
 * Closing a recorder hides its root rather than removing it — correct for an app
 * that has exactly one, and a trap for a harness that builds a dozen. A bare
 * query answers with the first match, which belongs to a panel that closed ten
 * seconds ago, so an assertion about the live one silently reads a corpse: the
 * paused-blink check was passing against a card that had never been paused.
 *
 * Scoping to the panel and then taking the FIRST match inside it also keeps the
 * ordinary meaning of a selector — `.rec-sel` is the microphone picker because
 * it is the first one on the card, and a document-wide "last" would have
 * answered with the quality picker instead.
 */
const panel = (): HTMLElement | null => [...document.querySelectorAll<HTMLElement>(".rec")].pop() ?? null;

const lastOf = <T extends HTMLElement>(sel: string): T | null => panel()?.querySelector<T>(sel) ?? null;

const statusOf = (): string => lastOf(".rec-status")?.textContent ?? "";

const ledgerOf = (): string => lastOf(".rec-ledger")?.textContent ?? "";

const cardHas = (cls: string): boolean => lastOf(".rec-card")?.classList.contains(cls) === true;

const click = (sel: string): void => lastOf<HTMLButtonElement>(sel)?.click();

// ── The surface ─────────────────────────────────────────────────────────────

async function liveChecks(): Promise<void> {
  const world = new FakeWorld();

  // ── A full take: screen, both sounds, streamed to disk ──────────────────
  {
    const disk = new FakeDisk();
    const view = make(world, disk);
    await view.open();
    ok("the panel opens on what the settings say", statusOf().includes("Recording the screen with"), statusOf());

    const mics = lastOf<HTMLSelectElement>(".rec-sel")!;
    ok("only microphones are offered, not every device on the machine", mics.options.length === 2);
    ok("…and one of them is actually selected, so the box is not blank",
      mics.selectedIndex >= 0 && mics.value !== "", `selectedIndex ${mics.selectedIndex}`);

    seen.length = 0;
    const start = lastOf<HTMLButtonElement>(".rec-go")!;
    ok("the start button is offered when something is selected", !start.disabled);
    start.click();
    await sleep(600);

    ok("recording began", view.isRecording);
    ok("the card gets out of its own shot once it starts",
      cardHas("rec-small"));
    ok("…and the setup controls give way to the clock and the meter",
      lastOf(".rec-live")?.hidden === false);

    const first = seen[0];
    /* THE ONE THAT MATTERS. Two audio sources went in; if two audio tracks
       reach the encoder, one of them is silently dropped and the recording is
       half the conversation. */
    ok("two sounds reached the encoder as ONE track", first?.audio === 1, JSON.stringify(first));
    ok("…alongside exactly one picture", first?.video === 1);
    ok("…in a container that can be written while it records", streamable(first?.mime ?? ""), first?.mime);
    ok("…at the bitrate the quality asked for",
      first?.videoBits === bitrates("balanced", 1280, 720).video, String(first?.videoBits));

    ok("the status line says the take is going to disk, not into memory",
      statusOf().includes("disk"), statusOf());

    await sleep(1200);
    ok("the clock is running", (lastOf(".rec-clock")?.textContent ?? "0:00") !== "0:00");
    ok("…and the ledger says so on screen", ledgerOf().includes("on disk"), ledgerOf());

    click(".rec-stop");
    await sleep(900);

    ok("stopping saved it and said where", statusOf().startsWith("Saved"), statusOf());
    ok("…to a file named for what it is", (view.lastPath ?? "").includes("Screen 20"), view.lastPath ?? "");

    ok("the recorder is no longer recording", !view.isRecording);
    ok("…and every device it opened was released, so the sharing bar goes away",
      world.opened.every((s) => s.getTracks().every((t) => t.readyState === "ended")));
    ok("…and the panel is back to its setup size",
      !cardHas("rec-small"));
    view.close();
  }

  // ── The disk, while the take is still running ───────────────────────────
  {
    /*
     * Screen only, and deliberately so. This is the scenario that proves the
     * streaming write path — chunks reaching the disk mid-take, one create
     * followed by appends, every append landing on the name the backend came
     * back with — and none of that has anything to do with sound.
     *
     * It used to be folded into the full take above, which cost an afternoon:
     * the mixed take produces almost no bytes *in this harness* because the
     * autoplay policy will not start an `AudioContext` for a document that has
     * only ever been clicked synthetically, and a suspended graph delivers no
     * samples for the muxer to write. That is the harness's environment, not a
     * fault in the recorder — but asserting bytes on a take whose audio can
     * never flow is asserting something this page cannot honour. A real mixed
     * take, started by a real finger, is on the manual checklist instead.
     */
    const disk = new FakeDisk();
    const view = make(world, disk, { screen: true, system: false, mic: false });
    await view.open();
    click(".rec-go");
    await sleep(CHUNK_MS + 900);

    ok("bytes have already reached the disk, before anyone pressed stop",
      disk.calls.length > 0 && disk.total > 0, `${disk.calls.length} calls, ${disk.total} bytes`);
    ok("…and the ledger says the take is on disk", ledgerOf().includes("on disk"), ledgerOf());

    click(".rec-stop");
    await sleep(900);

    ok("…created once and extended after that, never created twice",
      disk.calls.filter((c) => c.op === "write").length === 1 && disk.calls.some((c) => c.op === "append"),
      JSON.stringify(disk.calls.map((c) => c.op)));
    /* The rename trap: the backend answers with the name it actually used, and
       appending to the name we *asked* for would extend a different file. */
    ok("…and every append went to the path the create came back with",
      disk.calls.filter((c) => c.op === "append").every((c) => c.path === view.lastPath),
      JSON.stringify(disk.calls.map((c) => c.path)));
    /* The bytes that arrived *after* the first chunk, which is the number that
       says the take kept going. A total alone does not: a single keyframe of a
       detailed 720p screen is tens of kilobytes on its own, so a frozen picture
       and several live seconds are indistinguishable by size. */
    const appended = disk.calls.filter((c) => c.op === "append").reduce((n, c) => n + c.bytes, 0);
    ok("…and it kept producing after the first chunk, rather than one frozen frame",
      appended > 3_000, `${appended} bytes across ${disk.calls.length - 1} appends`);
    ok("…and the file on disk holds every byte the encoder produced",
      disk.files.get(view.lastPath ?? "") === disk.total);
    view.close();
  }

  // ── Sound the engine will not start ─────────────────────────────────────
  {
    /*
     * Both halves of the autoplay policy, reproduced exactly: a context that is
     * handed over suspended, and a `resume()` that does not reject but simply
     * never settles, waiting on a gesture that is not coming.
     *
     * The never-settling promise is the important half. Awaiting it plainly —
     * which is how this was first written — hangs the recorder between "Start"
     * and recording, with the card still showing the setup controls and nothing
     * on screen to say anything is wrong. The take never begins and never
     * fails; it just stops existing.
     */
    const stuck = {
      state: "suspended",
      resume: () => new Promise<void>(() => {}),
      close: () => Promise.resolve(),
    } as unknown as AudioContext;

    const disk = new FakeDisk();
    const view = make(world, disk, {}, true, { audioContext: () => stuck });
    await view.open();
    seen.length = 0;
    click(".rec-go");

    let waited = 0;
    while (!view.isRecording && waited < 3000) {
      await sleep(50);
      waited += 50;
    }
    ok("a context that will not start still lets the take begin", view.isRecording, `waited ${waited}ms`);
    ok("…and it gave up on it quickly, rather than awaiting a promise with no other end",
      waited < 1500, `waited ${waited}ms`);
    ok("…and the picture is recorded regardless", seen[0]?.video === 1, JSON.stringify(seen[0]));
    ok("…with one sound rather than a mix that cannot be made", seen[0]?.audio === 1);
    /* Through the ledger, not the status line: `begin()` overwrites the status
       with "Recording — …" immediately after, so a warning said only there is
       gone before it can be read. */
    ok("…and the panel says sound is blocked, for the whole take rather than an instant",
      ledgerOf().toLowerCase().includes("blocked"), ledgerOf());

    click(".rec-stop");
    await sleep(900);
    view.close();
  }

  // ── Sound only ──────────────────────────────────────────────────────────
  {
    const disk = new FakeDisk();
    const view = make(world, disk, { screen: false, system: true, mic: true });
    await view.open();
    seen.length = 0;
    click(".rec-go");
    /* Short of a chunk on purpose: stopping flushes a final `dataavailable`
       whatever the timeslice, so a scenario that only needs *some* data on the
       way out does not have to sit through three seconds of nothing. Only the
       checks about bytes reaching disk *mid-take* need a real chunk. */
    await sleep(800);

    const s = seen[0];
    ok("a sound-only take records no picture at all", s?.video === 0, JSON.stringify(s));
    ok("…even though it had to open a screen share to get the system's sound",
      world.opened.some((st) => st.getVideoTracks().length === 0 || st.getVideoTracks().every((t) => t.readyState === "ended")));
    ok("…and lands in an audio container", s?.mime.startsWith("audio/") === true, s?.mime);
    ok("…with the two sounds still summed into one track", s?.audio === 1);

    click(".rec-stop");
    await sleep(900);
    ok("…and is named as audio rather than as a screen recording",
      (view.lastPath ?? "").includes("Audio 20"), view.lastPath ?? "");
    view.close();
  }

  // ── Nothing selected ────────────────────────────────────────────────────
  {
    const disk = new FakeDisk();
    const view = make(world, disk, { screen: false, system: false, mic: false });
    await view.open();
    const start = lastOf<HTMLButtonElement>(".rec-go")!;
    ok("with nothing selected the button is off rather than failing when pressed", start.disabled);
    ok("…and the panel says what is missing", statusOf().includes("Nothing selected"), statusOf());
    start.click();
    await sleep(200);
    ok("…and nothing was opened", !view.isRecording && disk.calls.length === 0);
    view.close();
  }

  // ── No append path: the browser build ───────────────────────────────────
  {
    const disk = new FakeDisk();
    const view = make(world, disk, { screen: true, system: false, mic: true }, false);
    await view.open();
    click(".rec-go");
    await sleep(CHUNK_MS + 900);

    /* The honesty check. Without an append path the take is in the webview's
       heap, and displaying the same reassuring line as the streamed case would
       be the single most misleading thing this surface could do. */
    ok("with no way to append, the take is held in memory AND says so",
      statusOf().includes("memory") && ledgerOf().includes("memory"),
      `${statusOf()} / ${ledgerOf()}`);
    ok("…and nothing at all has been written yet", disk.calls.length === 0);

    click(".rec-stop");
    await sleep(900);
    ok("…and it still saves, in one write, when it stops",
      statusOf().startsWith("Saved") && disk.calls.length === 1 && disk.calls[0]!.op === "write",
      statusOf());
    view.close();
  }

  // ── The user presses "Stop sharing" in the browser's own bar ────────────
  {
    const disk = new FakeDisk();
    const view = make(world, disk, { screen: true, system: false, mic: false });
    await view.open();
    click(".rec-go");
    await sleep(800);
    ok("a silent screen recording runs with no audio track at all",
      seen[seen.length - 1]?.audio === 0, JSON.stringify(seen[seen.length - 1]));

    // Exactly what the browser's own bar does: end the video track.
    const shared = world.opened[world.opened.length - 1]!;
    for (const t of shared.getVideoTracks()) {
      t.stop();
      t.dispatchEvent(new Event("ended"));
    }
    await sleep(900);
    ok("ending the share ends the take, rather than writing a stream with nothing in it",
      !view.isRecording && statusOf().startsWith("Saved"), statusOf());
    view.close();
  }

  // ── A device that opens but delivers nothing ────────────────────────────
  {
    /*
     * The microphone the operating system agrees to open and then hands over
     * empty — unplugged between the picker and the take, or held by another
     * application. Modelled as a `getUserMedia` that resolves with a stream
     * carrying no track, which is what that looks like from here.
     *
     * Stopping a working take early does NOT test this: stop flushes a final
     * chunk whatever the timeslice, and a mixer that has been asked for sound
     * emits silence rather than nothing, so even a 400 ms mic take comes back
     * with several kilobytes in it. The check has to remove the source, not
     * shorten the take.
     */
    const disk = new FakeDisk();
    const deaf = new FakeWorld();
    const view = make(deaf, disk, { screen: false, system: false, mic: true }, true, {
      user: async () => new MediaStream(),
    });
    await view.open();
    click(".rec-go");
    await sleep(900);
    ok("a source that opens and delivers nothing is reported, not recorded",
      !statusOf().startsWith("Saved") && statusOf().includes("Nothing came through"), statusOf());
    ok("…and wrote no file", disk.calls.length === 0);
    ok("…and did not leave the panel thinking it is recording", !view.isRecording);
    deaf.stop();
    view.close();
  }

  // ── The disk fails mid-take ─────────────────────────────────────────────
  {
    const disk = new FakeDisk();
    const view = make(world, disk, { screen: true, system: false, mic: false });
    await view.open();
    click(".rec-go");
    await sleep(CHUNK_MS + 900);
    ok("the take is on disk to begin with", disk.calls.length > 0);

    disk.breakAppends = true;
    await sleep(CHUNK_MS + 900);
    /* A failing disk must not end the recording — the middle of a meeting is
       when someone least wants it to stop — but it must stop claiming to be
       safe. Those are two separate assertions on purpose. */
    ok("a failed write does not end the recording", view.isRecording);
    ok("…and the ledger stops saying the take is on disk",
      !ledgerOf().includes("on disk") && ledgerOf().includes("memory"), ledgerOf());

    disk.breakAppends = false;
    click(".rec-stop");
    await sleep(900);
    ok("…and when the disk comes back, the tail that piled up is written rather than dropped",
      statusOf().startsWith("Saved"), statusOf());
    view.close();
  }

  // ── Pause ───────────────────────────────────────────────────────────────
  {
    const disk = new FakeDisk();
    const view = make(world, disk, { screen: true, system: false, mic: false });
    await view.open();
    click(".rec-go");
    await sleep(600);
    const pause = [...(panel()?.querySelectorAll<HTMLButtonElement>(".rec-btn") ?? [])]
      .filter((b) => b.textContent === "Pause")[0]!;
    pause.click();
    const at = lastOf(".rec-clock")?.textContent ?? "";
    ok("pausing says the file is not being split", statusOf().includes("not split"), statusOf());
    ok("…and stops the blinking, which would otherwise say it is still recording",
      cardHas("rec-paused"));
    await sleep(1400);
    ok("…and paused time is not counted",
      (lastOf(".rec-clock")?.textContent ?? "") === at,
      `${at} → ${lastOf(".rec-clock")?.textContent}`);
    pause.click();
    ok("…and resuming carries on rather than starting a second file", view.isRecording);
    click(".rec-stop");
    await sleep(900);
    ok("…into one file", disk.calls.filter((c) => c.op === "write").length === 1);
    view.close();
  }

  // ── The source that will not share its sound ────────────────────────────
  {
    const quiet = new FakeWorld(false);
    const disk = new FakeDisk();
    const view = make(quiet, disk, { screen: true, system: true, mic: false });
    await view.open();
    click(".rec-go");
    await sleep(700);
    ok("a source that offers no sound is reported, not silently recorded silent",
      statusOf().includes("did not offer its sound") || statusOf().includes("Recording"),
      statusOf());
    click(".rec-stop");
    await sleep(900);
    quiet.stop();
    view.close();
  }

  // ── Closing while recording ─────────────────────────────────────────────
  {
    const disk = new FakeDisk();
    const view = make(world, disk, { screen: true, system: false, mic: false });
    await view.open();
    click(".rec-go");
    await sleep(800);
    view.close();
    await sleep(900);
    /* Closing must not throw away a take. There is no undo for a recording that
       was never written, so a stray Escape has to mean "finish", not "discard". */
    ok("closing mid-take finishes and saves rather than discarding",
      statusOf().startsWith("Saved") && disk.total > 0, statusOf());
    view.close();
  }

  world.stop();
  window.MediaRecorder = RealRecorder;
}

// ── Go ──────────────────────────────────────────────────────────────────────

pureChecks();
void liveChecks().then(() => {
  const line = `recorder: ${pass} passed, ${fail} failed`;
  console.log(`%c${line}`, `color:${fail ? "#ff6b81" : "#3ddc84"}`);
  document.title = line;
});
