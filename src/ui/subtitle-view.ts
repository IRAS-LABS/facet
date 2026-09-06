/**
 * The subtitle editor (item 31) — write them, fix them, export them beside the
 * video or burn them into it.
 *
 * The panel is built around one belief: **subtitles are a thing you watch, not
 * a thing you read in a table.** Every subtitle editor that shows a grid of
 * timecodes produces tracks that are technically correct and half a second
 * late, because nobody checked them against the picture. So the video is the
 * left half of this panel, the text sits on it exactly as it will look burned
 * in — same size, same colour, same box — and the cue list on the right
 * follows the playhead rather than the other way round.
 *
 * The other decision worth naming: this panel does not transcribe. It takes
 * cues from the transcription panel, from a `.srt` you already have, or from
 * nothing at all — but the model downloads, the progress bar and the speaker
 * clustering all live in `transcribe-view.ts`, and a second copy of them here
 * would be a second place for them to go wrong. The two panels hand off; they
 * do not overlap.
 *
 * Nothing here decides where a cue breaks or how a line wraps. That is all in
 * `@core/speech/subtitles`, which is checked exhaustively in `subcheck` —
 * this file is the surface, and a surface that also holds arithmetic is a
 * surface whose arithmetic is never tested.
 */

import type { Segment } from "@core/speech/transcript";
import {
  cueAt,
  cueText,
  cuesFromSegments,
  mergeCues,
  parseSubtitles,
  parseTime,
  problems,
  removeCue,
  renumber,
  setCueText,
  setCueTime,
  shiftCues,
  splitCue,
  STYLE,
  timecode,
  toSubtitles,
  type Cue,
  type CueOptions,
  type NameStyle,
  type Problem,
  type SubtitleFormat,
} from "@core/speech/subtitles";

/** How burned-in text should look. Percentages are of the picture's height. */
export interface Look {
  size: number;
  color: string;
  outline: number;
  boxBehind: boolean;
  margin: number;
}

export const LOOK: Look = {
  size: 5.5,
  color: "FFFFFF",
  outline: 0.6,
  boxBehind: false,
  margin: 4,
};

/** The burn-in job, as `ffmpeg.rs` expects it. */
export interface SubtitleJob {
  inputs: string[];
  output: string;
  quality: number;
  subtitles: Look & { text: string };
}

export interface SubtitleHost {
  fileUrl(path: string): Promise<string>;
  /** Returns the path actually written, which may differ if one was taken. */
  writeFile(path: string, bytes: Uint8Array, overwrite?: boolean): Promise<string>;
  refresh(): void;
  /** Burning in is native-only; without these the button explains itself. */
  runJob?(job: SubtitleJob): Promise<number>;
  cancelJob?(id: number): Promise<void>;
  onProgress?(cb: (p: { id: number; fraction: number }) => void): () => void;
  onDone?(cb: (d: { id: number; ok: boolean; output: string; error: string }) => void): () => void;
}

/** What to put in the panel when it opens. */
export interface Seed {
  /** A transcript to cue up. */
  segments?: readonly Segment[];
  /** Cues already made — from a sidecar, or from a previous visit. */
  cues?: readonly Cue[];
  /** Text of a subtitle file to parse. */
  text?: string;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** `mm:ss.mmm`, or with hours once there are any — what the time fields hold. */
function short(seconds: number): string {
  const full = timecode(seconds, true);
  return full.startsWith("00:") ? full.slice(3) : full;
}

/** A file's sibling, with a different extension. */
function beside(path: string, ext: string): string {
  const cut = Math.max(path.lastIndexOf("."), 0) || path.length;
  const stem = path.slice(0, cut) || path;
  return `${stem}.${ext}`;
}

/** A file's sibling, with something added to the name. */
function suffixed(path: string, add: string, ext: string): string {
  const cut = path.lastIndexOf(".");
  const stem = cut > 0 ? path.slice(0, cut) : path;
  return `${stem}${add}.${ext}`;
}

const nameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path;
const extOf = (path: string): string => (path.split(".").pop() ?? "").toLowerCase();

/** Files this panel can open directly rather than as a video to subtitle. */
export const SUBTITLE_EXTS = ["srt", "vtt", "sbv"];

export class SubtitleView {
  private readonly root = el("div", "subs");
  private readonly title = el("div", "subs-title");
  private readonly note = el("div", "subs-note");

  private readonly video = document.createElement("video");
  private readonly stage = el("div", "subs-stage");
  private readonly overlay = el("div", "subs-overlay");
  private readonly caption = el("div", "subs-caption");

  private readonly list = el("div", "subs-list");
  private readonly status = el("div", "subs-status");
  private readonly bar = el("div", "subs-progress");
  private readonly fill = el("i", "subs-fill");
  private readonly barNote = el("div", "subs-barnote");

  private readonly burnBtn: HTMLButtonElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly picker: HTMLInputElement;

  private path = "";
  private cues: Cue[] = [];
  private segments: readonly Segment[] | null = null;
  private style: CueOptions = { ...STYLE };
  private look: Look = { ...LOOK };
  private rows: HTMLElement[] = [];
  private chosen = -1;
  private job = 0;
  private following = true;
  private offProgress: (() => void) | null = null;
  private offDone: (() => void) | null = null;

  constructor(private readonly host: SubtitleHost) {
    this.root.hidden = true;

    // ── Head ───────────────────────────────────────────────────────────────
    const head = el("div", "subs-bar");
    const close = el("button", "", "Close");
    close.addEventListener("click", () => this.close());
    head.append(this.title, this.note, close);

    // ── Tools ──────────────────────────────────────────────────────────────
    const tools = el("div", "subs-tools");

    this.picker = document.createElement("input");
    this.picker.type = "file";
    this.picker.accept = ".srt,.vtt,.sbv,text/plain";
    this.picker.hidden = true;
    this.picker.addEventListener("change", () => void this.importPicked());

    const importBtn = el("button", "", "Import…");
    importBtn.title = "Open an existing .srt or .vtt";
    importBtn.addEventListener("click", () => this.picker.click());

    const srtBtn = el("button", "", "Save .srt");
    srtBtn.addEventListener("click", () => void this.save("srt"));
    const vttBtn = el("button", "", "Save .vtt");
    vttBtn.addEventListener("click", () => void this.save("vtt"));

    const tidy = el("button", "", "Tidy lines");
    tidy.title = "Re-wrap every cue to the current line width";
    tidy.addEventListener("click", () => this.tidy());

    this.burnBtn = el("button", "subs-go", "Burn in…");
    this.burnBtn.addEventListener("click", () => void this.burn());
    this.stopBtn = el("button", "subs-stop", "Stop");
    this.stopBtn.hidden = true;
    this.stopBtn.addEventListener("click", () => void this.halt());

    tools.append(
      importBtn,
      srtBtn,
      vttBtn,
      tidy,
      el("span", "subs-spacer"),
      this.shifter(),
      el("span", "subs-spacer"),
      this.burnBtn,
      this.stopBtn,
      this.picker,
    );

    // ── Look ───────────────────────────────────────────────────────────────
    const look = el("div", "subs-look");
    look.append(
      this.number("Text size", "%", this.look.size, 1, 20, 0.5, (v) => {
        this.look.size = v;
        this.dress();
      }),
      this.number("From the bottom", "%", this.look.margin, 0, 40, 0.5, (v) => {
        this.look.margin = v;
        this.dress();
      }),
      this.colour(),
      this.toggle("Box behind", this.look.boxBehind, (on) => {
        this.look.boxBehind = on;
        this.dress();
      }),
      el("span", "subs-spacer"),
      this.number("Line width", "chars", STYLE.chars, 20, 60, 1, (v) => {
        this.style.chars = v;
        this.reflow();
      }),
      this.names(),
    );

    // ── Progress ───────────────────────────────────────────────────────────
    this.bar.hidden = true;
    const track = el("div", "subs-track");
    track.append(this.fill);
    this.bar.append(track, this.barNote);

    // ── Body ───────────────────────────────────────────────────────────────
    this.video.controls = true;
    this.video.preload = "metadata";
    this.video.className = "subs-video";
    this.video.addEventListener("timeupdate", () => this.tick());
    this.video.addEventListener("seeked", () => this.tick());
    /* The stage takes the picture's shape as soon as it is known, so that a
       size given in per-cent of the stage really is a per-cent of the picture.
       Without this the overlay is honest on a 16:9 file and wrong on a phone
       video, which is exactly the case where subtitle size matters most. */
    this.video.addEventListener("loadedmetadata", () => {
      const { videoWidth: w, videoHeight: h } = this.video;
      this.stage.style.aspectRatio = w > 0 && h > 0 ? `${w} / ${h}` : "16 / 9";
    });

    this.overlay.append(this.caption);
    this.stage.append(this.video, this.overlay);

    /* Scrolling the list by hand means "I am reading, stop moving it".
       Following resumes at the next seek, which is the gesture that says the
       user is back to watching. */
    this.list.addEventListener("wheel", () => {
      this.following = false;
    }, { passive: true });

    const screen = el("div", "subs-screen");
    screen.append(this.stage);
    const body = el("div", "subs-body");
    body.append(screen, this.list);

    this.root.append(head, tools, look, this.bar, body, this.status);
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    document.body.append(this.root);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  get openPath(): string {
    return this.path;
  }

  /** The cues as they stand — so the caller can hand them back next time. */
  get track(): readonly Cue[] {
    return this.cues;
  }

  // ── Opening ──────────────────────────────────────────────────────────────

  /**
   * Open on a media file, optionally with something to show.
   *
   * A `.srt` opened from the file list arrives here as `seed.text` with the
   * *video* as the path when one is sitting next to it — the cues are the
   * document, but they are meaningless without the picture, and finding the
   * sibling is a thing the panel can do and the user should not have to.
   */
  async open(path: string, seed: Seed = {}): Promise<void> {
    this.path = path;
    this.chosen = -1;
    this.following = true;
    this.job = 0;
    this.segments = seed.segments ?? null;

    this.cues = seed.cues
      ? renumber(seed.cues)
      : seed.text
        ? parseSubtitles(seed.text)
        : seed.segments
          ? cuesFromSegments(seed.segments, this.style)
          : [];

    this.title.textContent = nameOf(path);
    this.title.title = path;
    this.root.hidden = false;
    this.bar.hidden = true;
    this.stopBtn.hidden = true;
    this.burnBtn.hidden = false;
    this.listen();
    this.paint();
    this.dress();
    this.root.tabIndex = -1;
    this.root.focus();

    if (SUBTITLE_EXTS.includes(extOf(path))) {
      // Nothing to play — a sidecar opened on its own. The editor still works;
      // it just cannot show you whether the timings are right, which is worth
      // saying out loud rather than leaving as a blank rectangle.
      this.stage.hidden = true;
      this.say("No video next to this file — timings can be edited but not checked.");
      return;
    }

    this.stage.hidden = false;
    try {
      this.video.src = await this.host.fileUrl(path);
    } catch {
      this.stage.hidden = true;
      this.say("That file could not be played here.", true);
    }
  }

  close(): void {
    this.root.hidden = true;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.offProgress?.();
    this.offDone?.();
    this.offProgress = null;
    this.offDone = null;
  }

  /** Subscribe to the encoder, once per opening. */
  private listen(): void {
    this.offProgress?.();
    this.offDone?.();
    this.offProgress =
      this.host.onProgress?.((p) => {
        if (p.id !== this.job) return;
        this.fill.style.width = `${Math.round(Math.max(0, p.fraction) * 100)}%`;
        this.barNote.textContent = `Burning in — ${Math.round(Math.max(0, p.fraction) * 100)}%`;
      }) ?? null;
    this.offDone =
      this.host.onDone?.((d) => {
        if (d.id !== this.job) return;
        this.job = 0;
        this.bar.hidden = true;
        this.stopBtn.hidden = true;
        this.burnBtn.hidden = false;
        if (d.ok) {
          this.say(`Burned in — ${nameOf(d.output)}`);
          this.host.refresh();
        } else {
          this.say(d.error || "The burn-in did not finish.", true);
        }
      }) ?? null;
  }

  // ── Controls ─────────────────────────────────────────────────────────────

  private number(
    label: string,
    unit: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
  ): HTMLElement {
    const wrap = el("label", "subs-field");
    wrap.append(el("span", "", `${label} (${unit})`));
    const input = document.createElement("input");
    input.type = "number";
    input.className = "subs-num";
    input.value = String(value);
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.addEventListener("change", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      const clamped = Math.min(max, Math.max(min, v));
      input.value = String(clamped);
      onChange(clamped);
    });
    wrap.append(input);
    return wrap;
  }

  private colour(): HTMLElement {
    const wrap = el("label", "subs-field");
    wrap.append(el("span", "", "Colour"));
    const input = document.createElement("input");
    input.type = "color";
    input.className = "subs-colour";
    input.value = `#${this.look.color}`;
    input.addEventListener("input", () => {
      this.look.color = input.value.replace("#", "").toUpperCase();
      this.dress();
    });
    wrap.append(input);
    return wrap;
  }

  private toggle(label: string, on: boolean, onChange: (v: boolean) => void): HTMLElement {
    const wrap = el("label", "subs-check");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = on;
    box.addEventListener("change", () => onChange(box.checked));
    wrap.append(box, el("span", "", label));
    return wrap;
  }

  private names(): HTMLElement {
    const wrap = el("label", "subs-field");
    wrap.append(el("span", "", "Speaker names"));
    const select = document.createElement("select");
    for (const [value, label] of [
      ["change", "When they change"],
      ["always", "On every cue"],
      ["never", "Never"],
    ] as Array<[NameStyle, string]>) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      select.append(opt);
    }
    select.value = String(this.style.names ?? STYLE.names);
    select.addEventListener("change", () => {
      this.style.names = select.value as NameStyle;
      this.reflow();
    });
    wrap.append(select);
    return wrap;
  }

  /**
   * Nudges, and the one that matters: sync to the playhead.
   *
   * A track that is uniformly late is the commonest fault in a subtitle file
   * anybody downloads, and the fix is one number. Finding that number by
   * typing seconds is guesswork; parking the playhead on the frame where the
   * line should appear and pressing a button is not.
   */
  private shifter(): HTMLElement {
    const wrap = el("span", "subs-shift");
    for (const by of [-0.5, -0.1, 0.1, 0.5]) {
      const b = el("button", "", `${by > 0 ? "+" : ""}${by}s`);
      b.title = `Move every cue ${by > 0 ? "later" : "earlier"} by ${Math.abs(by)} seconds`;
      b.addEventListener("click", () => {
        this.cues = shiftCues(this.cues, by);
        this.paint();
        this.say(`Every cue moved ${by > 0 ? "later" : "earlier"} by ${Math.abs(by)}s.`);
      });
      wrap.append(b);
    }
    const sync = el("button", "", "Sync to playhead");
    sync.title = "Move the whole track so the chosen cue starts here";
    sync.addEventListener("click", () => this.sync());
    wrap.append(sync);
    return wrap;
  }

  private sync(): void {
    const cue = this.cues[this.chosen];
    if (!cue) {
      this.say("Choose the cue that should start here first.", true);
      return;
    }
    const by = this.video.currentTime - cue.start;
    this.cues = shiftCues(this.cues, by);
    this.paint();
    this.say(`Every cue moved ${Math.abs(by).toFixed(2)}s ${by > 0 ? "later" : "earlier"}.`);
  }

  // ── The list ─────────────────────────────────────────────────────────────

  /**
   * Rebuild the cue rows.
   *
   * Called for structural changes only — adding, removing, splitting, shifting.
   * Typing into a cue deliberately does *not* come through here: replacing the
   * textarea a user is typing into moves their caret to the end of the line,
   * which is the single most irritating bug a text editor can have.
   */
  private paint(): void {
    this.list.textContent = "";
    this.rows = [];

    if (this.cues.length === 0) {
      const empty = el("div", "subs-empty");
      empty.append(
        el("p", "", "No subtitles yet."),
        el("p", "subs-dim",
          this.segments
            ? "The transcript came through empty."
            : "Import a .srt or .vtt, or transcribe the audio first (press T on the file)."),
      );
      this.list.append(empty);
      this.summarise();
      return;
    }

    const faults = new Map<number, Problem[]>();
    for (const p of problems(this.cues, this.style)) {
      const list = faults.get(p.at) ?? [];
      list.push(p);
      faults.set(p.at, list);
    }

    this.cues.forEach((cue, at) => {
      const row = el("div", "subs-row");
      row.dataset["at"] = String(at);

      const num = el("div", "subs-num-cell", String(cue.index));
      const times = el("div", "subs-times");
      times.append(
        this.timeField(cue.start, (v) => this.retime(at, v, null)),
        el("span", "subs-arrow", "→"),
        this.timeField(cue.end, (v) => this.retime(at, null, v)),
      );

      const text = document.createElement("textarea");
      text.className = "subs-text";
      text.value = cueText(cue);
      text.rows = Math.max(1, cue.lines.length);
      text.spellcheck = true;
      text.addEventListener("input", () => {
        const here = this.cues[at];
        if (!here) return;
        /* The user's own line breaks are kept exactly as typed. A subtitle
           broken by hand is broken for a reason — usually a phrase the
           wrapper cannot see — and silently re-flowing it while they type
           would undo the very edit they are making. "Tidy lines" is there
           when they want ours back. */
        this.cues[at] = { ...here, lines: text.value.split("\n") };
        text.rows = Math.max(1, text.value.split("\n").length);
        this.dress();
        this.summarise();
      });
      text.addEventListener("focus", () => this.choose(at, false));

      const acts = el("div", "subs-acts");
      acts.append(
        this.rowButton("⤢", "Split at the playhead", () => this.split(at)),
        this.rowButton("⤡", "Join with the next cue", () => this.join(at)),
        this.rowButton("✕", "Delete this cue", () => this.drop(at)),
      );

      const bad = faults.get(at);
      if (bad) {
        const flag = el("div", "subs-flag", "!");
        flag.title = bad.map((p) => p.note).join("\n");
        row.classList.add("subs-warn");
        acts.prepend(flag);
      }

      row.append(num, times, text, acts);
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).tagName === "TEXTAREA") return;
        this.choose(at, true);
      });
      this.list.append(row);
      this.rows.push(row);
    });

    this.summarise();
    this.dress();
  }

  private rowButton(glyph: string, title: string, run: () => void): HTMLButtonElement {
    const b = el("button", "subs-act", glyph);
    b.title = title;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      run();
    });
    return b;
  }

  private timeField(at: number, set: (v: number) => void): HTMLInputElement {
    const input = document.createElement("input");
    input.className = "subs-time";
    input.value = short(at);
    input.addEventListener("change", () => {
      const v = parseTime(input.value);
      if (v === null) {
        input.value = short(at);
        this.say("That is not a time — try 1:02.500", true);
        return;
      }
      set(v);
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    return input;
  }

  private choose(at: number, seek: boolean): void {
    this.chosen = at;
    this.rows.forEach((r, i) => r.classList.toggle("subs-chosen", i === at));
    const cue = this.cues[at];
    if (seek && cue) {
      this.video.currentTime = cue.start;
      this.following = true;
      this.tick();
    }
  }

  // ── Editing ──────────────────────────────────────────────────────────────

  private retime(at: number, start: number | null, end: number | null): void {
    const cue = this.cues[at];
    if (!cue) return;
    this.cues = setCueTime(this.cues, at, start ?? cue.start, end ?? cue.end);
    this.paint();
    this.choose(at, false);
  }

  private split(at: number): void {
    const before = this.cues.length;
    this.cues = splitCue(this.cues, at, this.video.currentTime, this.style);
    if (this.cues.length === before) {
      this.say("Put the playhead inside the cue, away from either end.", true);
      return;
    }
    this.paint();
    this.choose(at, false);
  }

  private join(at: number): void {
    if (at >= this.cues.length - 1) {
      this.say("There is nothing after this one to join it to.", true);
      return;
    }
    this.cues = mergeCues(this.cues, at, this.style);
    this.paint();
    this.choose(at, false);
  }

  private drop(at: number): void {
    this.cues = removeCue(this.cues, at);
    this.paint();
    this.choose(Math.min(at, this.cues.length - 1), false);
  }

  /** Re-wrap every cue to the current line width, hand breaks and all. */
  private tidy(): void {
    let next = this.cues;
    for (let at = 0; at < next.length; at++) {
      next = setCueText(next, at, cueText(next[at] as Cue), this.style);
    }
    this.cues = next;
    this.paint();
    this.say("Lines re-wrapped.");
  }

  /**
   * Rebuild the cues from the transcript, at the current settings.
   *
   * Only possible when the panel was opened from a transcript — an imported
   * `.srt` has no word timings behind it, so changing the line width can
   * re-wrap what is there but cannot decide the cue boundaries again. Saying
   * so beats a button that silently does less than it looks like it does.
   */
  private reflow(): void {
    if (!this.segments) {
      this.tidy();
      return;
    }
    this.cues = cuesFromSegments(this.segments, this.style);
    this.paint();
    this.say("Cues rebuilt from the transcript.");
  }

  // ── The picture ──────────────────────────────────────────────────────────

  /** Follow the playhead: show the right cue, highlight the right row. */
  private tick(): void {
    const now = this.video.currentTime;
    const cue = cueAt(this.cues, now);
    this.caption.textContent = cue ? cueText(cue) : "";
    this.caption.hidden = !cue;

    const at = cue ? this.cues.indexOf(cue) : -1;
    this.rows.forEach((r, i) => r.classList.toggle("subs-now", i === at));
    if (this.following && at >= 0) {
      this.rows[at]?.scrollIntoView({ block: "nearest" });
    }
  }

  /**
   * Make the overlay look like the burn will.
   *
   * Sizes are in per-cent of the picture's height on both sides — that is the
   * whole reason `Subtitles::force_style` works in per-cent too. A preview
   * measured in pixels would be honest at one window size and a lie at every
   * other, which is worse than no preview.
   */
  private dress(): void {
    const s = this.look;
    this.caption.style.fontSize = `${s.size}cqh`;
    this.caption.style.color = `#${s.color}`;
    this.overlay.style.paddingBottom = `${s.margin}cqh`;
    this.caption.style.background = s.boxBehind ? "rgba(0,0,0,0.75)" : "transparent";
    this.caption.style.textShadow = s.boxBehind
      ? "none"
      : `0 0 ${Math.max(1, s.outline * 4)}px #000, 0 0 ${Math.max(2, s.outline * 8)}px #000`;
    this.tick();
  }

  private summarise(): void {
    const faults = problems(this.cues, this.style);
    const kinds = new Set(faults.map((f) => f.kind));
    const bits = [`${this.cues.length} cue${this.cues.length === 1 ? "" : "s"}`];
    if (faults.length > 0) {
      bits.push(`${faults.length} to look at (${[...kinds].join(", ")})`);
    } else if (this.cues.length > 0) {
      bits.push("all within the reading budget");
    }
    this.status.textContent = bits.join(" · ");
  }

  private say(text: string, bad = false): void {
    this.note.textContent = text;
    this.note.classList.toggle("subs-bad", bad);
  }

  // ── In and out ───────────────────────────────────────────────────────────

  private async importPicked(): Promise<void> {
    const file = this.picker.files?.[0];
    this.picker.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const found = parseSubtitles(text);
      if (found.length === 0) {
        this.say(`${file.name} has no subtitles in it that I can read.`, true);
        return;
      }
      this.cues = found;
      this.segments = null;
      this.paint();
      this.say(`${found.length} cues from ${file.name}.`);
    } catch {
      this.say("That file could not be read.", true);
    }
  }

  private async save(format: SubtitleFormat): Promise<void> {
    if (this.cues.length === 0) {
      this.say("There is nothing to save yet.", true);
      return;
    }
    const text = toSubtitles(this.cues, format);
    const want = beside(this.path, format);
    try {
      const written = await this.host.writeFile(want, new TextEncoder().encode(text));
      this.host.refresh();
      this.say(`Saved as ${nameOf(written)}`);
    } catch (e) {
      this.say(e instanceof Error ? e.message : "That could not be saved.", true);
    }
  }

  /**
   * Burn the cues into the picture.
   *
   * A copy, always, and never over the original. Burning in is the one
   * subtitle operation that cannot be undone — the text becomes pixels — so
   * the source file has to still be there afterwards, and the sidecar you
   * could have saved instead is one button to the left.
   */
  private async burn(): Promise<void> {
    if (!this.host.runJob) {
      this.say("Burning in needs the desktop app — save a .srt instead.", true);
      return;
    }
    if (this.cues.length === 0) {
      this.say("There is nothing to burn in yet.", true);
      return;
    }
    if (SUBTITLE_EXTS.includes(extOf(this.path))) {
      this.say("Open the video and import this file to burn it in.", true);
      return;
    }

    const keep = ["mp4", "mkv", "mov"].includes(extOf(this.path)) ? extOf(this.path) : "mp4";
    const out = suffixed(this.path, " (subtitled)", keep);
    const job: SubtitleJob = {
      inputs: [this.path],
      output: out,
      quality: 20,
      subtitles: { ...this.look, text: toSubtitles(this.cues, "srt") },
    };

    this.bar.hidden = false;
    this.fill.style.width = "0%";
    this.barNote.textContent = "Starting…";
    this.burnBtn.hidden = true;
    this.stopBtn.hidden = false;
    this.say(`Burning into ${nameOf(out)} — the original is left alone.`);

    try {
      this.job = await this.host.runJob(job);
    } catch (e) {
      this.job = 0;
      this.bar.hidden = true;
      this.stopBtn.hidden = true;
      this.burnBtn.hidden = false;
      this.say(e instanceof Error ? e.message : "The burn-in could not be started.", true);
    }
  }

  private async halt(): Promise<void> {
    if (this.job && this.host.cancelJob) await this.host.cancelJob(this.job);
    this.job = 0;
    this.bar.hidden = true;
    this.stopBtn.hidden = true;
    this.burnBtn.hidden = false;
    this.say("Stopped. The original is untouched.");
  }

  // ── Keys ─────────────────────────────────────────────────────────────────

  private onKey(e: KeyboardEvent): void {
    const typing =
      e.target instanceof HTMLTextAreaElement ||
      (e.target instanceof HTMLInputElement && e.target.type !== "range");

    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    if (typing) return;

    switch (e.key) {
      case " ":
        e.preventDefault();
        if (this.video.paused) void this.video.play();
        else this.video.pause();
        return;
      case "ArrowDown":
        e.preventDefault();
        this.choose(Math.min(this.cues.length - 1, this.chosen + 1), true);
        return;
      case "ArrowUp":
        e.preventDefault();
        this.choose(Math.max(0, this.chosen - 1), true);
        return;
      case "i":
      case "I":
        e.preventDefault();
        this.edge(true);
        return;
      case "o":
      case "O":
        e.preventDefault();
        this.edge(false);
        return;
      case "m":
      case "M":
        e.preventDefault();
        if (this.chosen >= 0) this.join(this.chosen);
        return;
      case "Delete":
        e.preventDefault();
        if (this.chosen >= 0) this.drop(this.chosen);
        return;
      default:
    }
  }

  /** Set the chosen cue's in or out point to where the playhead is. */
  private edge(start: boolean): void {
    const cue = this.cues[this.chosen];
    if (!cue) {
      this.say("Choose a cue first.", true);
      return;
    }
    const now = this.video.currentTime;
    this.retime(this.chosen, start ? now : null, start ? null : now);
    this.say(`${start ? "In" : "Out"} point set to ${short(now)}.`);
  }
}
