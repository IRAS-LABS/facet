/**
 * Transcription (item 30).
 *
 * Opens over any audio or video file with **T**. Everything runs on this
 * machine — the models are downloaded once from the Hugging Face hub and then
 * cached by the browser, and no audio ever leaves the computer. That is the
 * whole reason this is a panel in a file explorer rather than an upload form.
 *
 * The work is elsewhere: `@core/speech/transcript` holds every decision worth
 * arguing about, `@core/speech/scribe` walks a recording through the models.
 * This file is the surface, and four things about it are deliberate.
 *
 * **It says how long it will take before it starts.** A WebGPU machine does an
 * hour of audio in a couple of minutes; the same model on WASM takes closer to
 * an hour. Starting a run that will not finish before the user gives up is
 * worse than not offering it, so the estimate is on the Start button.
 *
 * **The transcript fills in as it goes.** Each window's words appear the moment
 * they exist rather than at the end. On a long recording that is the difference
 * between a progress bar you trust and one you kill.
 *
 * **Speaker names are editable, and renaming one renames all of them.** The
 * models can tell two voices apart; they cannot know that Speaker 2 is Dov.
 * The rename is a rename of the person, everywhere they appear, because doing
 * it line by line on a two-hour meeting is not a feature.
 *
 * **Nothing is written until asked.** The transcript lives in the panel; Save
 * writes a new file beside the recording. The source is never touched.
 */

import {
  clockOf,
  transcriptText,
  type Segment,
} from "@core/speech/transcript";
import {
  bestDevice,
  DEFAULTS,
  QUALITIES,
  Scribe,
  supported,
  type OnProgress,
  type QualityId,
  type ScribeOptions,
} from "@core/speech/scribe";

/**
 * The models, injected — same arrangement as the camera's device layer and for
 * the same reason. In the app this is a real `Scribe` with three ONNX models
 * behind it; in the harness it is a stub that returns fixed segments, which is
 * how the panel gets asserted on without a 500 MB download.
 */
export interface TranscribeEngine {
  decode(bytes: ArrayBuffer): Promise<Float32Array>;
  run(
    samples: Float32Array,
    opts: ScribeOptions,
    onProgress: OnProgress,
    signal?: AbortSignal,
  ): Promise<Segment[]>;
  close(): void;
}

export interface TranscribeHost {
  fileUrl(path: string): Promise<string>;
  writeFile(path: string, bytes: Uint8Array, overwrite?: boolean): Promise<string>;
  refresh(): void;
  /** Overrides the real models. Only the harness passes one. */
  engine?: TranscribeEngine;
  /** Overrides the WebGPU probe, so the harness can assert both messages. */
  device?: () => Promise<"webgpu" | "wasm">;
  /**
   * Hand the finished transcript to the subtitle panel (item 31).
   *
   * A hand-off rather than a second set of controls in here: cueing needs the
   * word timings this panel already has, and re-deriving them there would mean
   * two places that decide what a word's start time is.
   */
  onSubtitles?(path: string, segments: readonly Segment[]): void;
}

/**
 * Whisper's languages, shortened to the ones a person on this machine is
 * plausibly going to pick, with detection first.
 *
 * Naming the language is worth offering rather than always detecting: Whisper
 * decides from the first few seconds, and a recording that opens with "hello,
 * hello, is this thing on" in the wrong accent can send the whole transcript
 * into the wrong language and stay there.
 */
const LANGUAGES: [string, string][] = [
  ["", "Detect"],
  ["english", "English"],
  ["hebrew", "Hebrew"],
  ["spanish", "Spanish"],
  ["french", "French"],
  ["german", "German"],
  ["portuguese", "Portuguese"],
  ["russian", "Russian"],
  ["italian", "Italian"],
  ["arabic", "Arabic"],
  ["chinese", "Chinese"],
  ["japanese", "Japanese"],
  ["korean", "Korean"],
  ["hindi", "Hindi"],
];

/**
 * Rough seconds of compute per second of audio, per quality, per device.
 *
 * Measured badly and on one machine, which is why the estimate on the button
 * is given as "about" and rounded hard. It exists to separate "two minutes"
 * from "an hour" — a distinction that changes what the user does — and not to
 * be right to the minute.
 */
const SPEED: Record<QualityId, { webgpu: number; wasm: number }> = {
  fast: { webgpu: 0.02, wasm: 0.25 },
  balanced: { webgpu: 0.04, wasm: 0.55 },
  best: { webgpu: 0.12, wasm: 1.6 },
};

export class TranscribeView {
  private readonly root = document.createElement("div");
  private readonly audio = document.createElement("audio");
  private readonly titleEl = document.createElement("div");
  private readonly note = document.createElement("div");
  private readonly setup = document.createElement("div");
  private readonly body = document.createElement("div");
  private readonly barWrap = document.createElement("div");
  private readonly bar = document.createElement("div");
  private readonly barNote = document.createElement("div");
  private readonly startBtn = document.createElement("button");
  private readonly stopBtn = document.createElement("button");
  private readonly exportBar = document.createElement("div");
  private readonly nameIn = document.createElement("input");
  private readonly findIn = document.createElement("input");
  private readonly qualitySel = document.createElement("select");
  private readonly langSel = document.createElement("select");
  private readonly speakersBox = document.createElement("input");
  private readonly peopleIn = document.createElement("input");
  private readonly withTimes = document.createElement("input");
  private readonly withNames = document.createElement("input");

  private path = "";
  private duration = 0;
  private segments: Segment[] = [];
  private rows: HTMLElement[] = [];
  private engine: TranscribeEngine | null = null;
  private stop: AbortController | null = null;
  private running = false;
  private device: "webgpu" | "wasm" = "wasm";
  /** Speaker → the name the user gave them. Applied on render and on export. */
  private readonly names = new Map<string, string>();
  private opts: ScribeOptions = { ...DEFAULTS };

  constructor(private readonly host: TranscribeHost) {
    this.root.className = "scribe";
    this.root.hidden = true;

    const head = document.createElement("header");
    head.className = "scribe-bar";
    this.titleEl.className = "scribe-title";
    this.note.className = "scribe-note";
    head.append(this.titleEl, this.note, this.btn("✕", "Close  (Esc)", () => this.close()));

    this.buildSetup();
    this.buildProgress();

    this.body.className = "scribe-body";
    this.body.tabIndex = 0;

    this.buildExport();

    // Kept inside the panel so it dies with it: an <audio> parked on the
    // document keeps playing after the panel closes, which has happened.
    this.audio.hidden = true;
    this.audio.preload = "metadata";
    this.audio.addEventListener("timeupdate", () => this.follow());

    this.root.append(head, this.setup, this.barWrap, this.body, this.exportBar, this.audio);
    document.body.appendChild(this.root);

    this.root.addEventListener("keydown", (e) => this.onKey(e));
  }

  // ── Building ──────────────────────────────────────────────────────────────

  private buildSetup(): void {
    this.setup.className = "scribe-setup";

    for (const q of QUALITIES) {
      const o = document.createElement("option");
      o.value = q.id;
      o.textContent = `${q.label} — ${q.note}`;
      this.qualitySel.append(o);
    }
    this.qualitySel.value = this.opts.quality;
    this.qualitySel.addEventListener("change", () => {
      this.opts.quality = this.qualitySel.value as QualityId;
      this.sayEstimate();
    });

    for (const [value, label] of LANGUAGES) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      this.langSel.append(o);
    }
    this.langSel.addEventListener("change", () => {
      this.opts.language = this.langSel.value || null;
    });

    this.speakersBox.type = "checkbox";
    this.speakersBox.checked = this.opts.speakers;
    this.speakersBox.addEventListener("change", () => {
      this.opts.speakers = this.speakersBox.checked;
      this.peopleIn.disabled = !this.opts.speakers;
      this.sayEstimate();
    });

    this.peopleIn.type = "number";
    this.peopleIn.min = "0";
    this.peopleIn.max = "20";
    this.peopleIn.step = "1";
    this.peopleIn.value = "0";
    this.peopleIn.className = "scribe-num";
    this.peopleIn.title =
      "Leave at 0 and it works it out. Saying how many people were in the room " +
      "is a stronger signal than anything the model can measure.";
    this.peopleIn.addEventListener("change", () => {
      this.opts.people = Math.max(0, Math.min(20, Math.round(Number(this.peopleIn.value) || 0)));
      this.peopleIn.value = String(this.opts.people);
    });

    this.startBtn.className = "scribe-go";
    this.startBtn.textContent = "Transcribe";
    this.startBtn.addEventListener("click", () => void this.begin());

    this.setup.append(
      this.field("Quality", this.qualitySel),
      this.field("Language", this.langSel),
      this.check("Tell speakers apart", this.speakersBox),
      this.field("People", this.peopleIn),
      this.startBtn,
    );
  }

  private buildProgress(): void {
    this.barWrap.className = "scribe-progress";
    this.barWrap.hidden = true;
    this.bar.className = "scribe-fill";
    const track = document.createElement("div");
    track.className = "scribe-track";
    track.append(this.bar);
    this.barNote.className = "scribe-barnote";
    this.stopBtn.className = "scribe-stop";
    this.stopBtn.textContent = "Stop";
    this.stopBtn.title = "Keeps everything transcribed so far.";
    this.stopBtn.addEventListener("click", () => this.halt());
    this.barWrap.append(track, this.barNote, this.stopBtn);
  }

  private buildExport(): void {
    this.exportBar.className = "scribe-export";
    this.exportBar.hidden = true;

    this.findIn.type = "search";
    this.findIn.placeholder = "Find in transcript";
    this.findIn.className = "scribe-find";
    this.findIn.addEventListener("input", () => this.filter());

    this.nameIn.type = "text";
    this.nameIn.className = "scribe-name";

    this.withTimes.type = "checkbox";
    this.withTimes.checked = true;
    this.withNames.type = "checkbox";
    this.withNames.checked = true;

    const copy = this.btn("Copy", "Copy the whole transcript", () => void this.copy());
    const save = this.btn("Save", "Write it beside the recording", () => void this.save());
    save.classList.add("scribe-go");

    this.exportBar.append(
      this.findIn,
      this.check("Times", this.withTimes),
      this.check("Names", this.withNames),
      this.nameIn,
      copy,
    );

    // Only when there is somewhere to hand it to. A button that explains it
    // cannot do anything is worse than a button that is not there.
    if (this.host.onSubtitles) {
      this.exportBar.append(
        this.btn("Subtitles", "Cue this up as subtitles", () => {
          this.host.onSubtitles?.(this.path, this.segments);
        }),
      );
    }
    this.exportBar.append(save);
  }

  private field(label: string, control: HTMLElement): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "scribe-field";
    const text = document.createElement("span");
    text.textContent = label;
    wrap.append(text, control);
    return wrap;
  }

  private check(label: string, box: HTMLInputElement): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "scribe-check";
    const text = document.createElement("span");
    text.textContent = label;
    wrap.append(box, text);
    return wrap;
  }

  private btn(text: string, tip: string, run: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = tip;
    b.addEventListener("click", run);
    return b;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  get openPath(): string | null {
    return this.root.hidden ? null : this.path;
  }

  async open(path: string): Promise<void> {
    this.path = path;
    this.root.hidden = false;
    this.segments = [];
    this.names.clear();
    this.rows = [];
    this.body.replaceChildren();
    this.exportBar.hidden = true;
    this.barWrap.hidden = true;
    this.setup.hidden = false;
    this.startBtn.disabled = false;

    const name = path.split(/[\\/]/).pop() ?? path;
    this.titleEl.textContent = name;
    this.nameIn.value = `${name.replace(/\.[^.]+$/, "")}.txt`;

    if (!supported()) {
      this.say("This build cannot transcribe — it has no worker or audio support.", true);
      this.startBtn.disabled = true;
      return;
    }

    this.say("Reading the file…");
    try {
      this.audio.src = await this.host.fileUrl(path);
      this.device = await (this.host.device ?? bestDevice)();
    } catch (e) {
      this.say(`Cannot open this file — ${String(e)}`, true);
      this.startBtn.disabled = true;
      return;
    }
    this.duration = await this.lengthOf();
    this.sayEstimate();
    this.body.focus();
  }

  close(): void {
    this.halt();
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.engine?.close();
    this.engine = null;
    this.root.hidden = true;
  }

  /** Metadata only — the whole decode happens later and once. */
  private lengthOf(): Promise<number> {
    if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
      return Promise.resolve(this.audio.duration);
    }
    return new Promise((resolve) => {
      const done = (): void => {
        this.audio.removeEventListener("loadedmetadata", done);
        this.audio.removeEventListener("error", done);
        resolve(Number.isFinite(this.audio.duration) ? this.audio.duration : 0);
      };
      this.audio.addEventListener("loadedmetadata", done);
      this.audio.addEventListener("error", done);
    });
  }

  // ── Running ───────────────────────────────────────────────────────────────

  private async begin(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stop = new AbortController();
    this.setup.hidden = true;
    this.barWrap.hidden = false;
    this.exportBar.hidden = true;
    this.body.replaceChildren();
    this.progress({ note: "Getting ready…", done: 0, segments: [] });

    const engine = this.engine ?? this.host.engine ?? new Scribe();
    this.engine = engine;

    try {
      const url = await this.host.fileUrl(this.path);
      const bytes = await (await fetch(url)).arrayBuffer();
      this.progress({ note: "Decoding the audio…", done: null, segments: [] });
      const samples = await engine.decode(bytes);
      this.duration = samples.length / 16_000;

      const out = await engine.run(
        samples,
        this.opts,
        (p) => this.progress(p),
        this.stop.signal,
      );
      this.segments = out;
      this.paint();
      this.done();
    } catch (e) {
      this.barWrap.hidden = true;
      this.setup.hidden = false;
      this.say(`Transcription failed — ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      this.running = false;
      this.stop = null;
    }
  }

  /** Stop means "keep what you have", not "throw it away". */
  private halt(): void {
    this.stop?.abort();
    this.stopBtn.disabled = true;
  }

  private progress: OnProgress = (p) => {
    this.barNote.textContent = p.note;
    this.bar.style.width = p.done == null ? "100%" : `${Math.round(p.done * 100)}%`;
    this.bar.classList.toggle("scribe-unknown", p.done == null);
    if (p.segments.length !== this.segments.length) {
      this.segments = [...p.segments];
      this.paint();
    }
  };

  private done(): void {
    this.barWrap.hidden = true;
    this.stopBtn.disabled = false;
    this.setup.hidden = false;
    this.exportBar.hidden = this.segments.length === 0;
    const people = new Set(this.segments.map((s) => s.speaker).filter(Boolean)).size;
    this.say(
      this.segments.length === 0
        ? "Nothing was said in this recording — or nothing the model could hear."
        : `${this.segments.length} lines` +
            (people > 0 ? ` · ${people} ${people === 1 ? "voice" : "voices"}` : "") +
            ` · ${clockOf(this.duration)}`,
    );
  }

  // ── The transcript ────────────────────────────────────────────────────────

  private paint(): void {
    this.rows = [];
    const frag = document.createDocumentFragment();
    for (const seg of this.segments) {
      const row = document.createElement("div");
      row.className = "scribe-line";

      const time = document.createElement("button");
      time.type = "button";
      time.className = "scribe-at";
      time.textContent = clockOf(seg.start);
      time.title = "Play from here";
      time.addEventListener("click", () => this.seek(seg.start));

      const who = document.createElement("button");
      who.type = "button";
      who.className = "scribe-who";
      const label = seg.speaker ? this.names.get(seg.speaker) ?? seg.speaker : "";
      who.textContent = label;
      who.hidden = !seg.speaker;
      who.title = "Rename this speaker everywhere";
      if (seg.speaker) {
        who.dataset["speaker"] = seg.speaker;
        who.addEventListener("click", () => this.rename(seg.speaker as string, who));
      }

      const text = document.createElement("div");
      text.className = "scribe-text";
      text.textContent = seg.text;

      row.append(time, who, text);
      frag.append(row);
      this.rows.push(row);
    }
    this.body.replaceChildren(frag);
    this.filter();
  }

  /**
   * Renaming in place rather than through a dialog.
   *
   * A modal would be one line of code, and it would also block the whole
   * webview — including the transcription still running behind it. This swaps
   * the chip for an input and puts it back.
   */
  private rename(speaker: string, chip: HTMLElement): void {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "scribe-rename";
    input.value = this.names.get(speaker) ?? speaker;
    // Enter puts the chip back, which blurs the input, which calls this again —
    // and the second call throws, because the node it wants to replace is no
    // longer in the document. One latch rather than removing the blur handler,
    // because clicking away is a real way to finish a rename and must keep it.
    let over = false;
    const finish = (keep: boolean): void => {
      if (over) return;
      over = true;
      const value = input.value.trim();
      if (keep && value) this.names.set(speaker, value);
      else if (keep) this.names.delete(speaker);
      input.replaceWith(chip);
      this.relabel();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
    chip.replaceWith(input);
    input.focus();
    input.select();
  }

  /** One rename touches every line that person speaks, without a repaint. */
  private relabel(): void {
    for (const chip of this.body.querySelectorAll<HTMLElement>(".scribe-who")) {
      const speaker = chip.dataset["speaker"];
      if (speaker) chip.textContent = this.names.get(speaker) ?? speaker;
    }
  }

  private seek(at: number): void {
    this.audio.currentTime = at;
    void this.audio.play().catch(() => undefined);
  }

  /** Highlights the line being played, and keeps it on screen. */
  private follow(): void {
    if (this.rows.length === 0) return;
    const t = this.audio.currentTime;
    let at = -1;
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      if (s && s.start <= t) at = i;
      else break;
    }
    for (let i = 0; i < this.rows.length; i++) {
      this.rows[i]?.classList.toggle("scribe-now", i === at);
    }
    const row = at >= 0 ? this.rows[at] : null;
    if (!row) return;
    const box = this.body.getBoundingClientRect();
    const line = row.getBoundingClientRect();
    if (line.top < box.top || line.bottom > box.bottom) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  /**
   * Find dims rather than hides.
   *
   * A transcript is a thing you read *around* a hit — the sentence before is
   * usually the reason you searched — so removing everything else takes the
   * answer away with the noise.
   */
  private filter(): void {
    const q = this.findIn.value.trim().toLowerCase();
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const seg = this.segments[i];
      if (!row || !seg) continue;
      const hit = q.length === 0 || seg.text.toLowerCase().includes(q);
      row.classList.toggle("scribe-dim", !hit && q.length > 0);
    }
  }

  // ── Out ───────────────────────────────────────────────────────────────────

  /** The transcript as text, with the user's renames applied. */
  private text(): string {
    const renamed = this.segments.map((s) => ({
      ...s,
      speaker: s.speaker ? this.names.get(s.speaker) ?? s.speaker : null,
    }));
    return transcriptText(renamed, {
      speakers: this.withNames.checked,
      timestamps: this.withTimes.checked,
    });
  }

  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.text());
      this.say("Copied.");
    } catch {
      this.say("The clipboard refused — save it instead.", true);
    }
  }

  private async save(): Promise<void> {
    const name = this.nameIn.value.trim();
    if (!name) {
      this.say("Give the file a name first.", true);
      return;
    }
    const folder = this.path.replace(/[\\/][^\\/]+$/, "");
    const target = `${folder}/${name}`;
    try {
      const written = await this.host.writeFile(
        target,
        new TextEncoder().encode(this.text()),
        false,
      );
      this.host.refresh();
      this.say(`Saved as ${written.split(/[\\/]/).pop()}`);
    } catch (e) {
      this.say(`Could not save — ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  // ── Odds and ends ─────────────────────────────────────────────────────────

  /**
   * Which processor is doing the work, said plainly and always.
   *
   * Always, including when the length of the file could not be read and there
   * is no estimate to attach it to — that is precisely the case where the user
   * is about to start something open-ended, and "this machine has no GPU" is
   * the one fact that tells them what they are in for.
   */
  private deviceNote(): string {
    return this.device === "webgpu"
      ? "using the GPU"
      : "no GPU — this build is running on the CPU";
  }

  private sayEstimate(): void {
    if (this.duration <= 0) {
      this.say(`Ready — ${this.deviceNote()}.`);
      return;
    }
    const rate = SPEED[this.opts.quality][this.device] * (this.opts.speakers ? 1.35 : 1);
    const seconds = this.duration * rate;
    const rough =
      seconds < 90
        ? "under a minute"
        : seconds < 3600
          ? `about ${Math.round(seconds / 60)} minutes`
          : `about ${(seconds / 3600).toFixed(1)} hours`;
    this.say(
      `${clockOf(this.duration)} of audio · ${rough} on this machine · ${this.deviceNote()}`,
    );
  }

  private say(message: string, bad = false): void {
    this.note.textContent = message;
    this.note.classList.toggle("scribe-bad", bad);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
    if (typing) return;
    if (e.key === " ") {
      e.preventDefault();
      if (this.audio.paused) void this.audio.play().catch(() => undefined);
      else this.audio.pause();
    }
  }
}
