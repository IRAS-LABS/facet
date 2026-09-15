/**
 * Read aloud — the desktop reader.
 *
 * Opens over any document that has words in it and reads them out, with the
 * sentence being spoken marked on the page. Four things about the design are
 * deliberate and are the difference between this and the readers people
 * already have and dislike.
 *
 * **It reads the paper, not the furniture.** A research PDF read literally
 * says the running head at the top of every page, the page number, the line
 * numbers down the margin, and then forty minutes of bibliography. Everything
 * that gets skipped is listed, with the reason, and every one of them can be
 * put back with one press — which matters, because the one thing worse than
 * reading the furniture is silently skipping a paragraph.
 *
 * **The reading order is visible and fixable.** Two columns read straight
 * across interleave into word-perfect nonsense. `readingOrder` gets this right
 * on most papers; the overlay exists for the ones it does not, and the fix is
 * remembered for that document so it is made once.
 *
 * **Nothing downloads without being asked.** The system voices speak
 * instantly and cost nothing. The natural voices are far better and are an
 * 88 MB download, so the size is on the button before it is pressed.
 *
 * **You can move.** Sentence, paragraph, page, the scrubber, or tapping any
 * word on the page. Somebody listening to a paper is not listening
 * front-to-back; they are going back over the paragraph they missed.
 */

import { CLEAN, clean, spoken, summary, type CleanOptions } from "@core/voice/cleanup";
import { readableText, type ReadBlock, type ReadDoc } from "@core/voice/doc";
import type { Engine } from "@core/voice/engine";
import { KokoroEngine } from "@core/voice/kokoro";
import { apply, OrderStore, type Fixes } from "@core/voice/order";
import { MODEL_BYTES, niceSize, remove as removePack, status as packStatus } from "@core/voice/pack";
import { Player, type Position } from "@core/voice/player";
import { Awake, mediaControls, nowPlaying } from "@core/voice/session";
import { SystemEngine } from "@core/voice/system";
import { build, canRead, extensionOf, fromPlain, READ_EXTS } from "@core/voice/source";
import { baseLang, grouped, languages, type VoiceInfo } from "@core/voice/voices";
import { hasPages, Sheets } from "./read-pages";
import { attachTextZoom, type Zoom } from "./zoom";
import { PREF } from "@core/settings/registry";
import { settings } from "@core/settings/store";
import type { Recogniser } from "@core/ocr/engine";

export { READ_EXTS, canRead };

export interface ReadHost {
  /** A URL the WebView can fetch the file's bytes from. */
  fileUrl(path: string): Promise<string>;
  /** Overrides the real OCR engine. Only the harness passes one. */
  engine?: Recogniser;
}

/**
 * The speed range, and what one press of - or + moves.
 *
 * It used to be a table of ten fixed speeds, which meant 1.6x was a speed the
 * reader simply did not have. There is no reason for that: every engine here
 * takes a float. The slider and the typed box reach any value in the range to
 * the nearest 0.05, and the buttons move in tenths because that is a useful
 * nudge rather than a fixed rung.
 */
const SPEED_MIN = 0.25;
const SPEED_MAX = 5;
const SPEED_STEP = 0.05;

/** How far from the edge the spoken sentence is kept when following. */
const FOLLOW_MARGIN = 0.35;

/** A hand scroll suspends following for this long. */
const HAND_PAUSE = 4_000;

type Highlight = "both" | "sentence" | "word" | "none";

export class ReadView {
  private readonly root = document.createElement("div");
  private readonly titleEl = document.createElement("div");
  private readonly note = document.createElement("div");
  private readonly tightBtn = document.createElement("button");

  private readonly setup = document.createElement("div");
  private readonly engineSel = document.createElement("select");
  private readonly voiceSel = document.createElement("select");
  private readonly langSel = document.createElement("select");
  private readonly speedSel = document.createElement("select");
  private readonly tryBtn = document.createElement("button");
  private readonly packBtn = document.createElement("button");
  private readonly moreBtn = document.createElement("button");

  private readonly extra = document.createElement("div");
  private readonly pitchIn = document.createElement("input");
  private readonly volumeIn = document.createElement("input");
  private readonly markSel = document.createElement("select");
  private readonly followBox = document.createElement("input");
  private readonly onlineBox = document.createElement("input");
  private readonly skipBoxes = new Map<keyof CleanOptions, HTMLInputElement>();

  private readonly barWrap = document.createElement("div");
  private readonly bar = document.createElement("div");
  private readonly barNote = document.createElement("div");
  private readonly stopBtn = document.createElement("button");

  private readonly skipped = document.createElement("div");
  private readonly page = document.createElement("div");
  private readonly transport = document.createElement("div");
  private readonly playBtn = document.createElement("button");
  private readonly scrub = document.createElement("input");
  private readonly place = document.createElement("span");
  private readonly repeatBtn = document.createElement("button");
  private readonly orderBtn = document.createElement("button");
  private readonly viewBtn = document.createElement("button");

  private readonly player: Player;
  private readonly awake = new Awake();
  private dropControls: (() => void) | null = null;
  private readonly system = new SystemEngine();
  private kokoro: KokoroEngine | null = null;
  private readonly orders = new OrderStore();
  private readonly sheets: Sheets;
  private zoom: Zoom | null = null;

  private path = "";
  private raw: ReadDoc | null = null;
  private doc: ReadDoc | null = null;
  private fixes: Fixes = { print: "", at: 0 };
  private work: AbortController | null = null;
  private busy = false;

  /** Block elements by index, so the highlight is a lookup rather than a query. */
  private readonly blockEls: HTMLElement[] = [];
  private lit = { block: -1, sentence: -1, word: -1 };
  private ordering = false;
  /** Which view the page area is showing. Only "page" needs geometry. */
  private onPage = false;
  private awakeOn = false;
  private handScrollUntil = 0;
  private dragging: number | null = null;

  constructor(private readonly host: ReadHost) {
    this.player = new Player(this.system);
    this.sheets = new Sheets(host);
    this.player.onError = (err) => this.say(message(err), true);
    this.player.on((p) => this.draw(p));

    this.root.className = "read";
    this.root.hidden = true;
    this.root.tabIndex = -1;

    const head = document.createElement("header");
    head.className = "read-bar";
    this.titleEl.className = "read-title";
    this.note.className = "read-note";
    this.tightBtn.type = "button";
    this.tightBtn.className = "read-btn read-gear";
    this.tightBtn.textContent = "⚙";
    this.tightBtn.title = "Voice, speed and what to skip";
    this.tightBtn.setAttribute("aria-label", "Voice, speed and what to skip");
    this.tightBtn.addEventListener("click", () => this.toggleTight());
    bare(this.tightBtn);

    const closeBtn = this.btn("✕", "Close  (Esc)", () => this.close());
    bare(closeBtn);
    head.append(this.titleEl, this.note, this.tightBtn, closeBtn);

    this.buildSetup();
    this.buildExtra();
    this.buildProgress();
    this.buildPage();
    this.buildTransport();

    this.root.append(head, this.setup, this.extra, this.barWrap, this.skipped, this.page, this.transport);
    document.body.appendChild(this.root);
    this.root.addEventListener("keydown", (e) => this.onKey(e));
  }

  // ── Building ──────────────────────────────────────────────────────────────

  private btn(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "read-btn";
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title.split("  (")[0] ?? title);
    b.addEventListener("click", onClick);
    return b;
  }

  private field(label: string, control: HTMLElement): HTMLLabelElement {
    const l = document.createElement("label");
    l.className = "read-field";
    const span = document.createElement("span");
    span.textContent = label;
    l.append(span, control);
    return l;
  }

  private check(label: string, box: HTMLInputElement, title = ""): HTMLLabelElement {
    box.type = "checkbox";
    const l = document.createElement("label");
    l.className = "read-check";
    if (title) l.title = title;
    const span = document.createElement("span");
    span.textContent = label;
    l.append(box, span);
    return l;
  }

  private buildSetup(): void {
    this.setup.className = "read-setup";

    for (const [value, label] of [["system", "System voices"], ["kokoro", "Natural voices"]]) {
      const o = document.createElement("option");
      o.value = value as string;
      o.textContent = label as string;
      this.engineSel.append(o);
    }
    this.engineSel.className = "read-engines";
    this.engineSel.title = "Which speech engine to read with";
    this.engineSel.setAttribute("aria-label", "Voice engine");
    this.engineSel.addEventListener("change", () => void this.chooseEngine(this.engineSel.value));

    this.voiceSel.className = "read-voices";
    this.voiceSel.addEventListener("change", () => this.chooseVoice(this.voiceSel.value));

    this.langSel.className = "read-langs";
    this.langSel.title = "Which language's voices to offer";
    this.langSel.setAttribute("aria-label", "Voice language");
    this.langSel.addEventListener("change", () => {
      settings.set(PREF.readLang, this.langSel.value);
      void this.fillVoices();
    });

    // Speed is picked from a list, not dragged to and not nudged towards.
    //
    // A slider plus a minus plus a plus plus a typed box was four controls
    // spending a third of the panel to answer one question, and on a phone it
    // was the wrong four: a thumb cannot reliably land on 1.15, and ten taps
    // of `+` to get from 1 to 1.5 is not configuring anything, it is waiting.
    // A native picker is one control, it is the widget Android already shows
    // as a scrollable dialog with the current value ticked, and every value
    // the engines honour is one tap away at the precision somebody actually
    // wants -- every 0.05, all the way from a quarter speed to five times.
    for (const v of speedChoices()) {
      const o = document.createElement("option");
      o.value = speedText(v);
      o.textContent = `${speedText(v)}×`;
      this.speedSel.append(o);
    }
    this.speedSel.className = "read-speedsel";
    this.speedSel.title = "Speed";
    this.speedSel.setAttribute("aria-label", "Speed");
    this.speedSel.addEventListener("change", () => this.setSpeed(Number(this.speedSel.value)));

    // A preview button per voice would be 54 buttons; one button that speaks
    // in whatever is selected is the same thing with less furniture.
    this.tryBtn.type = "button";
    this.tryBtn.className = "read-btn";
    this.tryBtn.textContent = "Try";
    this.tryBtn.title = "Hear this voice at this speed";
    this.tryBtn.addEventListener("click", () => void this.preview());

    this.packBtn.type = "button";
    this.packBtn.className = "read-btn";
    this.packBtn.addEventListener("click", () => void this.packPressed());

    this.moreBtn.type = "button";
    this.moreBtn.className = "read-btn";
    this.moreBtn.textContent = "More…";
    this.moreBtn.title = "Pitch, volume, highlighting, and what to skip";
    this.moreBtn.setAttribute("aria-expanded", "false");
    this.moreBtn.addEventListener("click", () => this.toggleExtra());

    this.setup.append(
      this.viewBtn,
      this.orderBtn,
      this.engineSel,
      this.langSel,
      this.voiceSel,
      this.tryBtn,
      this.packBtn,
      this.speedSel,
      this.moreBtn,
    );
  }

  private buildExtra(): void {
    this.extra.className = "read-extra";
    this.extra.hidden = true;

    this.pitchIn.type = "range";
    this.pitchIn.min = "0.5";
    this.pitchIn.max = "2";
    this.pitchIn.step = "0.05";
    this.pitchIn.addEventListener("input", () => {
      settings.set(PREF.readPitch, Number(this.pitchIn.value));
      this.player.set({ pitch: Number(this.pitchIn.value) });
    });

    this.volumeIn.type = "range";
    this.volumeIn.min = "0";
    this.volumeIn.max = "1";
    this.volumeIn.step = "0.05";
    this.volumeIn.addEventListener("input", () => {
      settings.set(PREF.readVolume, Number(this.volumeIn.value));
      this.player.set({ volume: Number(this.volumeIn.value) });
    });

    for (const [value, label] of [
      ["both", "Sentence and word"],
      ["sentence", "Sentence only"],
      ["word", "Word only"],
      ["none", "Nothing"],
    ]) {
      const o = document.createElement("option");
      o.value = value as string;
      o.textContent = label as string;
      this.markSel.append(o);
    }
    this.markSel.addEventListener("change", () => {
      settings.set(PREF.readHighlight, this.markSel.value);
      this.relight(true);
    });

    this.followBox.addEventListener("change", () =>
      settings.set(PREF.readFollow, this.followBox.checked),
    );

    this.onlineBox.addEventListener("change", () => {
      settings.set(PREF.readOnline, this.onlineBox.checked);
      void this.fillVoices();
    });

    const skips: [keyof CleanOptions, string, string][] = [
      ["headers", "Running heads", "The title repeated at the top of every page, the journal name along the bottom."],
      ["pageNumbers", "Page numbers", "A bare number in the margin."],
      ["lineNumbers", "Line numbers", "The column of numbers down the side of a manuscript."],
      ["references", "Reference list", "Everything after the References heading, up to any appendix."],
      ["captions", "Figure captions", "Off by default — a caption often carries the finding."],
      ["footnotes", "Footnotes", "Off by default — a footnote is sometimes the argument."],
      ["equations", "Equations", "Says “equation” rather than reading the symbols out."],
      ["headings", "Section headings", "Off by default — headings are how you keep your place by ear."],
    ];

    const skipWrap = document.createElement("div");
    skipWrap.className = "read-skips";
    const legend = document.createElement("span");
    legend.className = "read-legend";
    legend.textContent = "Skip";
    skipWrap.append(legend);

    for (const [key, label, title] of skips) {
      const box = document.createElement("input");
      box.addEventListener("change", () => this.reclean());
      this.skipBoxes.set(key, box);
      skipWrap.append(this.check(label, box, title));
    }

    this.extra.append(
      this.field("Pitch", this.pitchIn),
      this.field("Volume", this.volumeIn),
      this.field("Highlight", this.markSel),
      this.check("Scroll to keep up", this.followBox),
      this.check(
        "Include voices that need the internet",
        this.onlineBox,
        "Off. Most of the voices a phone advertises are not on the phone — they send the sentence to a server and play back the reply.",
      ),
      skipWrap,
    );
  }

  private buildProgress(): void {
    this.barWrap.className = "read-progress";
    this.barWrap.hidden = true;
    this.bar.className = "read-fill";
    const track = document.createElement("div");
    track.className = "read-track";
    track.append(this.bar);
    this.barNote.className = "read-barnote";
    this.stopBtn.type = "button";
    this.stopBtn.className = "read-btn";
    this.stopBtn.textContent = "Stop";
    this.stopBtn.addEventListener("click", () => this.work?.abort());
    this.barWrap.append(track, this.barNote, this.stopBtn);
  }

  private buildPage(): void {
    this.skipped.className = "read-skipped";
    this.skipped.hidden = true;

    this.page.className = "read-page";
    this.page.tabIndex = 0;

    // One listener on the container rather than one per word: a 200-page paper
    // is a hundred thousand words, and a hundred thousand listeners is a
    // measurable amount of memory for something a delegate does for free.
    // Pinch, double-tap and ctrl-wheel. The app turns the browser's own zoom
    // off app-wide so the 2D canvas can own every gesture, and the reader --
    // the one surface in the whole app whose entire job is reading something
    // -- was never given it back. A 9pt footnote in a two-column paper is not
    // readable on a phone at any fixed size.
    //
    // The font kind rather than the transform kind, for both views. Scaling
    // the type reflows the text view, which is what somebody reading it wants;
    // and the page view widens its sheets so the render can rasterise at the
    // new width instead of stretching pixels it already has. A transform would
    // give a blurry paper and a text column that got no easier to read.
    this.zoom = attachTextZoom(this.page, this.page, {
      remeasure: () => this.rezoom(),
      onSettle: () => this.sheets.rescale(),
    });

    this.page.addEventListener("click", (e) => this.clicked(e));
    this.page.addEventListener("scroll", () => {
      this.handScrollUntil = Date.now() + HAND_PAUSE;
    }, { passive: true });
  }

  private buildTransport(): void {
    this.transport.className = "read-transport";

    this.playBtn.type = "button";
    this.playBtn.className = "read-play";
    this.playBtn.addEventListener("click", () => this.player.toggle());

    // U+FE0E is the text-presentation selector. Without it Samsung's emoji font
    // claims the double-arrows and paints them orange, so half the transport
    // arrives coloured and the other half does not -- on the same row.
    const pageBack = this.btn("⏮︎", "Previous page", () => this.player.page(-1));
    const paraBack = this.btn("⏪︎", "Previous paragraph  (↑)", () => this.player.paragraph(-1));
    const sentBack = this.btn("‹", "Previous sentence  (←)", () => this.player.sentence(-1));
    const sentFwd = this.btn("›", "Next sentence  (→)", () => this.player.sentence(1));
    const paraFwd = this.btn("⏩︎", "Next paragraph  (↓)", () => this.player.paragraph(1));
    const pageFwd = this.btn("⏭︎", "Next page", () => this.player.page(1));
    // Glyph only, on the phone as well. `panel-fit` normally staples the
    // tooltip's word under a bare glyph, which is the right call for a panel
    // full of one-off icons -- but a transport is the one row of buttons
    // everybody already knows by shape, and seven words under seven arrows
    // cost two lines of the document to say what the arrows said.
    for (const b of [pageBack, paraBack, sentBack, sentFwd, paraFwd, pageFwd]) bare(b);
    bare(this.playBtn);

    this.scrub.type = "range";
    this.scrub.min = "0";
    this.scrub.max = "1000";
    this.scrub.value = "0";
    this.scrub.className = "read-scrub";
    this.scrub.setAttribute("aria-label", "Position in the document");
    this.scrub.addEventListener("input", () => {
      this.paintScrub();
      this.player.seek(Number(this.scrub.value) / 1000);
    });

    this.place.className = "read-place";

    this.repeatBtn.type = "button";
    this.repeatBtn.className = "read-btn";
    this.repeatBtn.textContent = "↻";
    this.repeatBtn.title = "Start again at the end";
    this.repeatBtn.setAttribute("aria-pressed", "false");
    this.repeatBtn.setAttribute("aria-label", "Start again at the end");
    this.repeatBtn.addEventListener("click", () => this.toggleRepeat());
    bare(this.repeatBtn);

    this.orderBtn.type = "button";
    this.orderBtn.className = "read-btn";
    this.orderBtn.textContent = "Order";
    this.orderBtn.title = "Show the order the paragraphs will be read in, and fix it";
    this.orderBtn.setAttribute("aria-pressed", "false");
    this.orderBtn.addEventListener("click", () => this.toggleOrder());

    // Page or text. Hidden rather than disabled for a file that has no pages
    // at all -- a permanently dead button on every text file is worse than no
    // button, and the reader already tells you what it is reading.
    this.viewBtn.type = "button";
    this.viewBtn.className = "read-btn";
    this.viewBtn.textContent = "Page";
    this.viewBtn.addEventListener("click", () => this.toggleView());

    // One row, and the scrubber is not in it.
    //
    // Every phone media player worth copying does the same two things: the
    // position bar is a hairline welded to the top edge of the bar rather than
    // a chunky slider taking a control's worth of width, and the keys sit in
    // the middle of the bar with the play button bigger than the rest. What
    // was a twelve-control, two-line block is now a hairline and nine things
    // on one line.
    //
    // The three-part row is what centres the play button: the left side holds
    // the repeat toggle and the counter, the right side is a matching empty
    // weight, and the keys in between land on the middle of the screen no
    // matter how long "487 / 487 · page 12" gets.
    const left = document.createElement("div");
    left.className = "read-side";
    left.append(this.repeatBtn, this.place);

    const right = document.createElement("div");
    right.className = "read-side read-side-r";

    const keys = document.createElement("div");
    keys.className = "read-keys";
    // The sentence pair is the one that goes on a phone: seven keys plus a
    // counter do not fit across 412 points, and on a touchscreen stepping a
    // sentence at a time is the slow way to do what tapping the sentence does
    // in one go. On a window they stay, because there a mouse has no better
    // route and there is room for them.
    sentBack.classList.add("read-wide-only");
    sentFwd.classList.add("read-wide-only");
    keys.append(pageBack, paraBack, sentBack, this.playBtn, sentFwd, paraFwd, pageFwd);

    const row = document.createElement("div");
    row.className = "read-row";
    row.append(left, keys, right);

    this.transport.append(this.scrub, row);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  get openPath(): string | null {
    return this.root.hidden ? null : this.path;
  }

  /** Open a file. */
  async open(path: string): Promise<void> {
    this.show(path.split(/[\\/]/).pop() ?? path);
    this.path = path;
    await this.rebuild(false);
  }

  /** Read a selection, or any text somebody already has (items 5, 6). */
  read(text: string, title: string): void {
    this.show(title);
    this.path = title;
    this.settle(fromPlain(text, title));
    this.say(`${this.doc?.blocks.length ?? 0} paragraphs · press play`);
  }

  private show(title: string): void {
    this.onPage = String(settings.get(PREF.readOnPage) ?? "page") !== "text";
    this.root.hidden = false;
    // On a phone the three setup rows and the skip banner were taking the top
    // third of the screen off a document that is the entire point of the
    // panel. They open behind the gear instead, and the reader opens showing
    // the paper. A window with the room keeps them where they were.
    this.setTight(narrow());
    this.titleEl.textContent = title;
    this.skipped.hidden = true;
    this.page.replaceChildren();
    this.blockEls.length = 0;
    this.loadPrefs();
    void this.pickEngine().then(() => this.fillVoices());
    this.root.focus();

    // Item 35. Taken when the panel opens rather than when playback starts, so
    // the headphone button works for the first press as well as the second.
    this.dropControls ??= mediaControls({
      play: () => this.player.play(),
      pause: () => this.player.pause(),
      stop: () => this.player.stop(),
      next: () => this.player.paragraph(1),
      previous: () => this.player.paragraph(-1),
      seek: (fraction) => this.player.seek(fraction),
    });
  }

  close(): void {
    this.player.stop();
    this.work?.abort();
    this.work = null;
    this.dropControls?.();
    this.dropControls = null;
    void this.awake.off();
    this.root.hidden = true;
    this.page.replaceChildren();
    this.sheets.release();
    this.blockEls.length = 0;
    this.doc = null;
    this.raw = null;
  }

  /** Free the engines. Called when the app shuts down. */
  dispose(): void {
    this.player.dispose();
    this.kokoro?.dispose();
    this.kokoro = null;
    this.dropControls?.();
    this.dropControls = null;
    this.awake.dispose();
  }

  // ── Getting the text ──────────────────────────────────────────────────────

  /** Build (or rebuild, with OCR) the document from the open file. */
  private async rebuild(ocr: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.player.stop();
    this.work?.abort();
    const work = new AbortController();
    this.work = work;
    this.barWrap.hidden = false;
    this.bar.style.width = "0%";
    this.say("Opening…");

    try {
      const url = await this.host.fileUrl(this.path);
      const res = await fetch(url, { signal: work.signal });
      if (!res.ok) throw new Error(`the file would not open (${res.status})`);
      const bytes = await res.arrayBuffer();

      const doc = await build(this.path, bytes, {
        signal: work.signal,
        ocr,
        ...(this.host.engine ? { engine: this.host.engine } : {}),
        onProgress: (p) => {
          this.barNote.textContent = p.what;
          this.bar.style.width = `${Math.round(Math.max(0, p.done) * 100)}%`;
          this.bar.classList.toggle("read-unknown", p.done < 0);
        },
      });

      this.settle(doc);
      this.afterBuild(doc, ocr);
    } catch (e) {
      if (work.signal.aborted) this.say("Stopped.");
      else this.say(`Cannot read this — ${message(e)}`, true);
    } finally {
      this.barWrap.hidden = true;
      this.busy = false;
      if (this.work === work) this.work = null;
    }
  }

  /** What to say once a document is on screen. */
  private afterBuild(doc: ReadDoc, didOcr: boolean): void {
    const pending = doc.scanned?.length ?? 0;
    const words = readableText(doc).split(/\s+/).filter(Boolean).length;

    if (pending > 0 && !didOcr) {
      const what = extensionOf(this.path) === "pdf"
        ? `${pending} page${pending === 1 ? "" : "s"} of this PDF are pictures, not text`
        : "This is a picture";
      this.say(`${what}. Press Recognise to read ${pending === 1 ? "it" : "them"} anyway.`);
      this.offerOcr();
      return;
    }

    if (words === 0) {
      this.say("There is no text in this to read.", true);
      return;
    }

    const mins = Math.max(1, Math.round(words / (150 * this.player.opts.rate)));
    this.say(`${words.toLocaleString()} words · about ${mins} min · press play`);
  }

  /** Put a Recognise button in the status line. */
  private offerOcr(): void {
    const go = this.btn("Recognise", "Run text recognition on the pages that are pictures", () => {
      go.remove();
      void this.rebuild(true);
    });
    go.classList.add("read-offer");
    this.note.append(" ", go);
  }

  /**
   * Take a freshly-built document, apply the saved fixes and the cleanup
   * rules, and put it on screen.
   */
  private settle(raw: ReadDoc): void {
    this.raw = raw;
    const saved = this.orders.get(raw);
    this.fixes = saved ?? { print: "", at: 0 };
    this.doc = clean(apply(raw, saved), this.cleanOptions());
    this.player.load(this.doc);
    this.paint();
  }

  /** Re-run the cleanup rules after a skip switch moved, keeping the place. */
  private reclean(): void {
    const raw = this.raw;
    if (!raw) return;
    const where = this.player.position();
    const id = this.doc?.blocks[where.block]?.id;

    this.doc = clean(apply(raw, this.savedFixes()), this.cleanOptions());
    this.player.load(this.doc);
    this.paint();

    // Put the player back on the paragraph it was on, if that paragraph still
    // gets read. Losing your place because you ticked a box is the failure
    // this exists to avoid.
    if (id) {
      const again = this.doc.blocks.findIndex((b) => b.id === id && !b.skip);
      if (again >= 0) this.player.startAtBlock(again);
    }
  }

  private cleanOptions(): CleanOptions {
    const out = { ...CLEAN };
    for (const [key, box] of this.skipBoxes) out[key] = box.checked;
    return out;
  }

  private savedFixes(): Fixes | null {
    const has = this.fixes.order?.length || this.fixes.off?.length || this.fixes.on?.length;
    return has ? this.fixes : null;
  }

  // ── Drawing the page ──────────────────────────────────────────────────────

  /**
   * The zoom's re-measure hook, which for this view has nothing to do.
   *
   * It exists because the hex view and the spreadsheet -- the other two users
   * of `attachTextZoom` -- draw only the rows they can see and work out which
   * ones from a row height they measured, so the size has to change before
   * they redraw. The reader does not virtualise: the text view is real
   * elements the browser lays out, and the page view's highlight boxes are
   * percentages inside a sheet that grew with the zoom. Both follow on their
   * own, and the recogniser puts the scroll position back itself. The page
   * pixels are the one thing that does not follow, and those are redrawn on
   * `onSettle` rather than on every frame of a pinch.
   */
  private rezoom(): void {
    // Deliberately empty. See above.
  }

  private paint(): void {
    const doc = this.doc;
    // A zoom belongs to the document it was set on: carrying 3x from a phone
    // screenshot into a research paper is a reader that opens unusable.
    this.zoom?.reset();
    this.page.replaceChildren();
    this.sheets.release();
    this.blockEls.length = 0;
    this.lit = { block: -1, sentence: -1, word: -1 };
    this.tellView();
    if (!doc) return;

    // The page view builds the same blocks against the real document instead
    // of rebuilding it as text. Everything downstream -- the highlight, the
    // follow-scrolling, tapping a word to start there -- reads the elements,
    // not this branch, so it needs to know nothing about which one ran.
    this.page.classList.toggle("read-onpage", this.showingPage());
    if (this.showingPage()) {
      this.page.append(this.sheets.build(this.path, doc, this.blockEls, this.page));
      this.tellSkipped();
      return;
    }

    let page = -1;
    const frag = document.createDocumentFragment();

    for (let i = 0; i < doc.blocks.length; i++) {
      const block = doc.blocks[i] as ReadBlock;

      if (block.page !== page) {
        page = block.page;
        if (doc.pages > 1) {
          const rule = document.createElement("div");
          rule.className = "read-pagemark";
          rule.textContent = `Page ${page + 1}`;
          frag.append(rule);
        }
      }

      frag.append(this.blockEl(block, i));
    }

    this.page.append(frag);
    this.tellSkipped();
  }

  private blockEl(block: ReadBlock, index: number): HTMLElement {
    const el = document.createElement("p");
    el.className = `read-block read-${block.kind}`;
    el.dataset.block = String(index);
    el.classList.toggle("read-off", block.skip);

    if (this.ordering) {
      el.draggable = true;
      const n = document.createElement("span");
      n.className = "read-number";
      n.textContent = String(index + 1);
      el.append(n);
    }

    if (block.skip) {
      const why = document.createElement("span");
      why.className = "read-why";
      why.textContent = block.why ?? "Skipped";
      el.append(why);
    }

    // Each word is its own span so the word highlight and tap-to-start-here
    // are both a class change on an element that already exists, rather than
    // a re-render of the paragraph.
    let at = 0;
    for (let w = 0; w < block.words.length; w++) {
      const word = block.words[w];
      if (!word) continue;
      if (word.from > at) el.append(block.text.slice(at, word.from));
      const span = document.createElement("span");
      span.className = "read-word";
      span.dataset.word = String(w);
      span.textContent = block.text.slice(word.from, word.to);
      el.append(span);
      at = word.to;
    }
    if (at < block.text.length) el.append(block.text.slice(at));

    // An equation is announced rather than read, so the page should say so.
    if (block.kind === "equation" && !block.skip) {
      const said = document.createElement("span");
      said.className = "read-said";
      said.textContent = ` (read as “${spoken(block, this.cleanOptions())}”)`;
      el.append(said);
    }

    this.blockEls[index] = el;
    return el;
  }

  /** The line above the page: what is being left out, and how to put it back. */
  private tellSkipped(): void {
    const doc = this.doc;
    this.skipped.replaceChildren();
    if (!doc) return;

    // `summary` says "Reading everything" when nothing is being dropped, and
    // a bar that says so with a button offering to do what is already
    // happening is furniture. Hide it.
    const text = summary(doc);
    if (!text || !doc.blocks.some((b) => b.skip)) {
      this.skipped.hidden = true;
      return;
    }

    this.skipped.hidden = false;
    const label = document.createElement("span");
    label.textContent = text;
    const all = this.btn("Read everything", "Turn every skip off for this document", () => {
      for (const box of this.skipBoxes.values()) box.checked = false;
      this.fixes = { ...this.fixes, off: [] };
      this.reclean();
    });
    all.classList.add("read-offer");
    this.skipped.append(label, all);
  }

  // ── The highlight (items 32, 33) ──────────────────────────────────────────

  /**
   * Tell the track how far along it is.
   *
   * A range input paints its track in one flat colour; the filled-so-far look
   * every other player has is a gradient whose stop has to be moved by hand.
   * Done here rather than with an inline `background` so the colours stay in
   * the stylesheet where the theme can reach them.
   */
  private paintScrub(): void {
    const at = Number(this.scrub.value) / 10;
    this.scrub.style.setProperty("--fct-scrub", `${at}%`);
  }

  private draw(p: Position): void {
    this.playBtn.textContent = p.state === "playing" ? "❚❚" : "▶";
    this.playBtn.title = p.state === "playing" ? "Pause  (Space)" : "Play  (Space)";
    this.playBtn.setAttribute("aria-label", this.playBtn.title.split("  (")[0] ?? "Play");
    this.playBtn.classList.toggle("read-loading", p.state === "loading");

    if (document.activeElement !== this.scrub) {
      this.scrub.value = String(Math.round(p.progress * 1000));
      this.paintScrub();
    }

    this.session(p);

    const pages = this.doc?.pages ?? 1;
    this.place.textContent = p.steps === 0
      ? ""
      : pages > 1
        ? `${p.step + 1} / ${p.steps} · page ${p.page + 1}`
        : `${p.step + 1} / ${p.steps}`;

    this.relight(false, p);
  }

  /**
   * Keep the lock screen and the wake lock in step with the transport.
   *
   * The wake lock is only held while something is actually being spoken. A
   * panel left open on a paused document must not hold the screen on, which is
   * the single most common way a reader ends up blamed for a flat battery.
   */
  private session(p: Position): void {
    const playing = p.state === "playing";

    if (playing !== this.awakeOn) {
      this.awakeOn = playing;
      if (playing && Boolean(settings.get(PREF.readAwake) ?? true)) void this.awake.on();
      else void this.awake.off();
    }

    const detail = this.doc && this.doc.pages > 1
      ? `Page ${p.page + 1} of ${this.doc.pages}`
      : `${p.step + 1} of ${p.steps}`;
    nowPlaying({ title: this.titleEl.textContent ?? "Reading", detail, progress: p.progress }, playing);
  }

  private relight(force: boolean, at?: Position): void {
    const p = at ?? this.player.position();
    const mark = String(settings.get(PREF.readHighlight) || "both") as Highlight;

    if (!force && p.block === this.lit.block && p.sentence === this.lit.sentence && p.word === this.lit.word) {
      return;
    }

    // Clear the old marks by element, not by querying the document: on a long
    // paper a querySelectorAll per word would be the slowest thing here.
    const old = this.blockEls[this.lit.block];
    if (old) {
      old.classList.remove("read-now");
      for (const el of old.querySelectorAll(".read-lit, .read-said-now")) {
        el.classList.remove("read-lit", "read-said-now");
      }
    }

    this.lit = { block: p.block, sentence: p.sentence, word: p.word };
    const el = this.blockEls[p.block];
    if (!el || mark === "none") return;

    if (mark === "both" || mark === "sentence") {
      el.classList.add("read-now");
      const block = this.doc?.blocks[p.block];
      const sentence = block?.sentences[p.sentence];
      if (sentence) {
        for (let w = sentence.first; w <= sentence.last; w++) {
          el.querySelector(`[data-word="${w}"]`)?.classList.add("read-lit");
        }
      }
    }

    if ((mark === "both" || mark === "word") && p.word >= 0) {
      el.querySelector(`[data-word="${p.word}"]`)?.classList.add("read-said-now");
    }

    this.follow(el);
  }

  /**
   * Keep the spoken sentence on screen.
   *
   * Suspended for a few seconds after a hand scroll. Somebody who has just
   * scrolled back to re-read a paragraph does not want the page yanked
   * forward under their eyes half a second later, and a reader that fights
   * the user's own scrolling is one they stop using.
   */
  private follow(el: HTMLElement): void {
    if (!this.followBox.checked) return;
    if (Date.now() < this.handScrollUntil) return;

    const view = this.page.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const margin = view.height * FOLLOW_MARGIN;
    if (box.top >= view.top + margin && box.bottom <= view.bottom - margin) return;

    const want = this.page.scrollTop + (box.top - view.top) - margin;
    // The scroll this causes must not count as a hand scroll.
    const until = this.handScrollUntil;
    this.page.scrollTo({ top: Math.max(0, want), behavior: "smooth" });
    this.handScrollUntil = until;
  }

  // ── Clicks on the page (items 18, 19, 34) ─────────────────────────────────

  private clicked(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    const blockEl = target?.closest<HTMLElement>(".read-block");
    if (!blockEl) return;
    const index = Number(blockEl.dataset.block ?? -1);
    const block = this.doc?.blocks[index];
    if (!block) return;

    if (this.ordering) {
      // In order mode a tap is "exclude this" / "put this back", because that
      // is what somebody is doing when they have the overlay open.
      this.setSkipped(block, !block.skip);
      return;
    }

    if (block.skip) {
      // Tapping something that is being skipped puts it back and reads it,
      // which is the only interpretation of that tap that makes sense.
      this.setSkipped(block, false);
      return;
    }

    const wordEl = target?.closest<HTMLElement>(".read-word");
    if (wordEl) this.player.startAtWord(index, Number(wordEl.dataset.word ?? 0));
    else this.player.startAtBlock(index);
  }

  private setSkipped(block: ReadBlock, skip: boolean): void {
    const off = new Set(this.fixes.off ?? []);
    const on = new Set(this.fixes.on ?? []);
    if (skip) {
      off.add(block.id);
      on.delete(block.id);
    } else {
      on.add(block.id);
      off.delete(block.id);
    }
    this.fixes = { ...this.fixes, off: [...off], on: [...on] };
    this.remember();
    this.reclean();
  }

  // ── Reading order (items 17, 19, 20) ──────────────────────────────────────

  // ── Page or text ──────────────────────────────────────────────────────────

  /**
   * Is the real page what is on screen right now?
   *
   * Three things have to be true, and the last two are why this is a method
   * rather than a flag: a text file has no page to show, and the ordering
   * overlay is about the rebuilt reading order, which only means anything in
   * the rebuilt view.
   */
  private showingPage(): boolean {
    return this.onPage && !this.ordering && hasPages(this.doc);
  }

  /** Put the button in the state the view is actually in. */
  private tellView(): void {
    const possible = hasPages(this.doc);
    this.viewBtn.hidden = !possible;
    const page = this.showingPage();
    this.viewBtn.textContent = page ? "Text" : "Page";
    this.viewBtn.setAttribute("aria-pressed", String(page));
    this.viewBtn.title = page
      ? "Show the rebuilt text instead of the page"
      : "Follow along on the document itself, laid out as it really is";
  }

  private toggleView(): void {
    this.onPage = !this.onPage;
    settings.set(PREF.readOnPage, this.onPage ? "page" : "text");

    // The order overlay numbers the rebuilt reading order, so asking for the
    // page is also asking to leave it.
    if (this.onPage && this.ordering) {
      this.ordering = false;
      this.orderBtn.setAttribute("aria-pressed", "false");
      this.page.classList.remove("read-ordering");
    }

    const where = this.player.position();
    this.paint();
    this.relight(true, where);
    this.say(this.showingPage() ? "Reading along on the page itself." : "");
  }

  private toggleOrder(): void {
    this.ordering = !this.ordering;
    this.orderBtn.setAttribute("aria-pressed", String(this.ordering));
    this.page.classList.toggle("read-ordering", this.ordering);
    this.paint();

    if (this.ordering) {
      this.wireDrag();
      this.say("Numbered in reading order. Drag to move a paragraph, tap to exclude it.");
    } else {
      this.say("");
    }
  }

  /**
   * Drag to reorder.
   *
   * HTML drag-and-drop rather than pointer events: it is what the rest of the
   * app uses for moving rows (`@ui/dnd`), so it behaves the same, and it gives
   * the drag image for free.
   */
  private wireDrag(): void {
    this.page.addEventListener("dragstart", (e) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(".read-block");
      if (!el) return;
      this.dragging = Number(el.dataset.block ?? -1);
      e.dataTransfer?.setData("text/plain", el.dataset.block ?? "");
      el.classList.add("read-dragging");
    });

    this.page.addEventListener("dragover", (e) => {
      if (this.dragging === null) return;
      e.preventDefault();
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(".read-block");
      for (const other of this.blockEls) other?.classList.remove("read-drop");
      el?.classList.add("read-drop");
    });

    this.page.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = this.dragging;
      this.dragging = null;
      for (const other of this.blockEls) other?.classList.remove("read-drop", "read-dragging");
      if (from === null) return;
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(".read-block");
      if (!el) return;
      this.move(from, Number(el.dataset.block ?? -1));
    });

    this.page.addEventListener("dragend", () => {
      this.dragging = null;
      for (const other of this.blockEls) other?.classList.remove("read-drop", "read-dragging");
    });
  }

  private move(from: number, to: number): void {
    const doc = this.doc;
    if (!doc || from === to || from < 0 || to < 0) return;

    const ids = doc.blocks.map((b) => b.id);
    const [moved] = ids.splice(from, 1);
    if (!moved) return;
    ids.splice(to, 0, moved);

    this.fixes = { ...this.fixes, order: ids };
    this.remember();
    this.reclean();
  }

  private remember(): void {
    const raw = this.raw;
    if (!raw) return;
    this.orders.put(raw, {
      ...(this.fixes.order ? { order: this.fixes.order } : {}),
      ...(this.fixes.off ? { off: this.fixes.off } : {}),
      ...(this.fixes.on ? { on: this.fixes.on } : {}),
    });
  }

  // ── Voices (items 21-27) ──────────────────────────────────────────────────

  private loadPrefs(): void {
    const rate = Number(settings.get(PREF.readSpeed) ?? 1);
    const pitch = Number(settings.get(PREF.readPitch) ?? 1);
    const volume = Number(settings.get(PREF.readVolume) ?? 1);
    const repeat = Boolean(settings.get(PREF.readRepeat));

    this.speedSel.value = speedText(clampSpeed(rate));
    this.pitchIn.value = String(pitch);
    this.volumeIn.value = String(volume);
    this.markSel.value = String(settings.get(PREF.readHighlight) ?? "both");
    this.followBox.checked = Boolean(settings.get(PREF.readFollow) ?? true);
    this.onlineBox.checked = Boolean(settings.get(PREF.readOnline) ?? false);
    this.repeatBtn.setAttribute("aria-pressed", String(repeat));
    this.repeatBtn.classList.toggle("read-on", repeat);

    const boxes: [keyof CleanOptions, string][] = [
      ["headers", PREF.readSkipHeaders],
      ["pageNumbers", PREF.readSkipPageNumbers],
      ["captions", PREF.readSkipCaptions],
      ["references", PREF.readSkipReferences],
      ["footnotes", PREF.readSkipFootnotes],
      ["lineNumbers", PREF.readSkipLineNumbers],
      ["equations", PREF.readSkipEquations],
      ["headings", PREF.readSkipHeadings],
    ];
    for (const [key, pref] of boxes) {
      const box = this.skipBoxes.get(key);
      if (box) box.checked = Boolean(settings.get(pref) ?? CLEAN[key]);
    }

    this.player.set({ rate, pitch, volume, repeat, clean: this.cleanOptions() });
    this.engineSel.value = String(settings.get(PREF.readEngine) ?? "system");
  }

  /**
   * Which engine to open on when the reader has never been told.
   *
   * The stored preference wins whenever there is one — someone who chose the
   * system voices chose them. With nothing stored the old answer was always
   * "system", which meant a machine that had gone to the trouble of
   * downloading the 88 MB voice pack still opened on Microsoft David and
   * sounded like 2003. If the pack is on the machine it is the better voice by
   * a distance and it is what the download was for, so it is the one to open
   * on. Nothing is fetched here: `status` only looks at what is already
   * stored.
   */
  private async pickEngine(): Promise<void> {
    if (settings.get(PREF.readEngine) !== undefined) return;
    try {
      const st = await packStatus();
      if (st.installed && st.voices.length > 0) this.engineSel.value = "kokoro";
    } catch {
      // No pack store on this machine; the system voices are the only ones.
    }
  }

  /** Fill the voice list for whichever engine is selected. */
  private async fillVoices(): Promise<void> {
    const wantKokoro = this.engineSel.value === "kokoro";
    const engine: Engine = wantKokoro ? this.kokoroEngine() : this.system;

    await this.showPack(wantKokoro);

    let all: VoiceInfo[] = [];
    try {
      all = await engine.voices();
    } catch {
      all = [];
    }

    // Two cuts, in this order, and the order matters: the language list is
    // built from what is left after the network voices go, so it never offers
    // a language whose only voices are ones the reader will not show.
    const offline = this.onlineBox.checked ? all : all.filter((v) => v.offline);
    const usable = offline.length > 0 ? offline : all;

    this.voiceSel.replaceChildren();
    this.langSel.replaceChildren();
    if (usable.length === 0) {
      const o = document.createElement("option");
      o.textContent = wantKokoro ? "Download the voices first" : "No voices on this machine";
      o.value = "";
      this.voiceSel.append(o);
      this.voiceSel.disabled = true;
      this.langSel.disabled = true;
      this.tryBtn.disabled = true;
      return;
    }

    this.voiceSel.disabled = false;
    this.langSel.disabled = false;
    this.tryBtn.disabled = false;

    const langs = languages(usable);
    const tag = this.wantedLang(langs.map((l) => l.tag));
    for (const l of langs) {
      const o = document.createElement("option");
      o.value = l.tag;
      o.textContent = l.label;
      this.langSel.append(o);
    }
    // Last, so somebody who does want the whole pile can still have it.
    const every = document.createElement("option");
    every.value = "*";
    every.textContent = "All languages";
    this.langSel.append(every);
    this.langSel.value = tag;

    const shown = tag === "*" ? usable : usable.filter((v) => baseLang(v.lang) === tag);

    for (const group of grouped(shown)) {
      // With one language on screen the language is the one thing every entry
      // in the list has in common, so the group headings say nothing. They
      // come back when "All languages" is chosen, which is when they earn it.
      const into =
        tag === "*"
          ? (() => {
              const g = document.createElement("optgroup");
              g.label = group.label;
              this.voiceSel.append(g);
              return g;
            })()
          : this.voiceSel;
      for (const v of group.voices) {
        const o = document.createElement("option");
        o.value = v.id;
        const detail = tag === "*" ? v.detail : trimLang(v.detail, group.label);
        o.textContent = detail ? `${v.name} — ${detail}` : v.name;
        into.append(o);
      }
    }

    const pref = String(settings.get(wantKokoro ? PREF.readVoice : PREF.readSystemVoice) ?? "");
    const want = shown.some((v) => v.id === pref) ? pref : firstSensible(shown);
    this.voiceSel.value = want;
    this.player.set({ voice: want });
  }

  /**
   * Which language the picker should be showing.
   *
   * A remembered choice wins, then this device's own language, then whatever
   * is first -- which `languages()` has already sorted English-first, so on a
   * phone set to a language with no voices installed the list still opens on
   * something a person can read rather than on the alphabet's first accident.
   */
  private wantedLang(have: readonly string[]): string {
    const saved = String(settings.get(PREF.readLang) ?? "");
    if (saved === "*" || have.includes(saved)) return saved;
    const here = baseLang(typeof navigator !== "undefined" ? navigator.language || "en" : "en");
    if (have.includes(here)) return here;
    return have[0] ?? "*";
  }

  private kokoroEngine(): KokoroEngine {
    this.kokoro ??= new KokoroEngine();
    return this.kokoro;
  }

  private async chooseEngine(id: string): Promise<void> {
    settings.set(PREF.readEngine, id);
    const engine: Engine = id === "kokoro" ? this.kokoroEngine() : this.system;

    if (id === "kokoro" && !(await engine.ready())) {
      this.say(`The natural voices need a ${niceSize(MODEL_BYTES)} download. Press Download to get them.`);
    }

    await this.player.setEngine(engine);
    await this.fillVoices();
  }

  private chooseVoice(id: string): void {
    settings.set(this.engineSel.value === "kokoro" ? PREF.readVoice : PREF.readSystemVoice, id);
    this.player.set({ voice: id });
  }

  private setSpeed(rate: number): void {
    const safe = clampSpeed(rate);
    settings.set(PREF.readSpeed, safe);
    this.speedSel.value = speedText(safe);
    this.player.set({ rate: safe });
  }

  /** What `[` and `]` do. The panel has no buttons for this any more. */
  private stepSpeed(delta: number): void {
    // Rounded onto the step grid so that ten presses of ] from 1.0 land on
    // 1.5 exactly, rather than on 1.4999999999999998.
    const now = Number(this.speedSel.value);
    const next = Math.round((now + delta * SPEED_STEP) * 100) / 100;
    this.setSpeed(next);
  }

  private toggleRepeat(): void {
    const on = !this.player.opts.repeat;
    settings.set(PREF.readRepeat, on);
    this.player.set({ repeat: on });
    this.repeatBtn.setAttribute("aria-pressed", String(on));
    this.repeatBtn.classList.toggle("read-on", on);
  }

  private toggleExtra(): void {
    this.extra.hidden = !this.extra.hidden;
    this.moreBtn.setAttribute("aria-expanded", String(!this.extra.hidden));
  }

  private toggleTight(): void {
    this.setTight(!this.root.classList.contains("read-tight"));
  }

  /** Fold the voice and skip rows away, or bring them back. */
  private setTight(tight: boolean): void {
    this.root.classList.toggle("read-tight", tight);
    this.tightBtn.setAttribute("aria-expanded", String(!tight));
    this.tightBtn.classList.toggle("read-on", !tight);
  }

  /** Hear the selected voice without starting the document (item 26). */
  private async preview(): Promise<void> {
    const engine: Engine = this.engineSel.value === "kokoro" ? this.kokoroEngine() : this.system;
    this.player.stop();
    this.tryBtn.disabled = true;
    try {
      await engine.speak(
        {
          text: "This is how this voice sounds at this speed.",
          voice: this.voiceSel.value,
          rate: Number(this.speedSel.value),
          pitch: Number(this.pitchIn.value),
          volume: Number(this.volumeIn.value),
        },
        { onError: (err) => this.say(message(err), true) },
      );
    } finally {
      this.tryBtn.disabled = false;
    }
  }

  // ── The voice pack (item 22) ──────────────────────────────────────────────

  private async showPack(forKokoro: boolean): Promise<void> {
    this.packBtn.hidden = !forKokoro;
    if (!forKokoro) return;
    const state = await packStatus();
    this.packBtn.textContent = state.installed ? `Remove (${niceSize(state.size)})` : `Download ${niceSize(MODEL_BYTES)}`;
    this.packBtn.title = state.installed
      ? "Delete the downloaded voices. The system voices keep working."
      : "One-off download of the natural voices. Nothing else leaves this machine.";
  }

  private async packPressed(): Promise<void> {
    const state = await packStatus();
    if (state.installed) {
      this.player.stop();
      this.kokoro?.dispose();
      this.kokoro = null;
      await removePack();
      this.say("The downloaded voices have been removed.");
      await this.fillVoices();
      return;
    }

    const work = new AbortController();
    this.work = work;
    this.barWrap.hidden = false;
    this.packBtn.disabled = true;
    try {
      await this.kokoroEngine().installPack((done, total) => {
        this.barNote.textContent = `Downloading the voices — ${niceSize(done)} of ${niceSize(total)}`;
        this.bar.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
      }, work.signal);
      this.say("The natural voices are ready.");
    } catch (e) {
      this.say(work.signal.aborted ? "Download stopped." : `Download failed — ${message(e)}`, !work.signal.aborted);
    } finally {
      this.barWrap.hidden = true;
      this.packBtn.disabled = false;
      if (this.work === work) this.work = null;
      await this.fillVoices();
    }
  }

  // ── Keys ──────────────────────────────────────────────────────────────────

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement && e.target.type !== "range") return;
    if (e.target instanceof HTMLSelectElement) return;

    switch (e.key) {
      case "Escape":
        e.preventDefault();
        this.close();
        return;
      case " ":
        e.preventDefault();
        this.player.toggle();
        return;
      case "ArrowLeft":
        e.preventDefault();
        this.player.sentence(-1);
        return;
      case "ArrowRight":
        e.preventDefault();
        this.player.sentence(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        this.player.paragraph(-1);
        return;
      case "ArrowDown":
        e.preventDefault();
        this.player.paragraph(1);
        return;
      case "[":
        e.preventDefault();
        this.stepSpeed(-1);
        return;
      case "]":
        e.preventDefault();
        this.stepSpeed(1);
        return;
      default:
    }
  }

  // ── Saying things ─────────────────────────────────────────────────────────

  private say(text: string, bad = false): void {
    this.note.replaceChildren(document.createTextNode(text));
    this.note.classList.toggle("read-bad", bad);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Which voice to open on when nothing has been chosen.
 *
 * The old answer was `voices[0]`, which is whatever order the platform
 * happened to hand back. On a desktop browser that is the system default and
 * is fine; on Android it is the raw engine list, and on 2026-09-14 that meant
 * an English research paper opening on a Urdu voice. So: a voice in the
 * reader's own language first, then any English one, and only then the
 * platform's first — the same English-first order the dropdown itself groups
 * by, so the selection matches what the list looks like.
 */
function firstSensible(voices: readonly VoiceInfo[]): string {
  const here = (typeof navigator !== "undefined" ? navigator.language : "en-US") || "en-US";
  const base = (here.split("-")[0] ?? "en").toLowerCase();

  const exact = voices.find((v) => v.lang.toLowerCase() === here.toLowerCase());
  if (exact) return exact.id;

  const sameLanguage = voices.find((v) => v.lang.toLowerCase().startsWith(`${base}`));
  if (sameLanguage) return sameLanguage.id;

  const english = voices.find((v) => v.lang.toLowerCase().startsWith("en"));
  if (english) return english.id;

  return voices[0]?.id ?? "";
}

/**
 * Keep the word off this button's face.
 *
 * `panel-fit.ts` walks every open panel on a phone and puts the tooltip's own
 * text under any button that shows nothing but a glyph, because a row of
 * unexplained icons is a row of riddles to a finger that cannot hover. A
 * transport is the exception it was always going to have: play, pause and six
 * arrows are the one set of controls everybody can already read, and the words
 * underneath them turned one row of buttons into two rows of captions on top
 * of a document there was already not enough room for. The name stays on
 * `title` and `aria-label`, so a screen reader and a hover both still say it.
 */
function bare(b: HTMLElement): void {
  b.dataset["fctLabelled"] = "";
}

/** A screen the setup rows would eat a third of. Matches read.css's breakpoint. */
function narrow(): boolean {
  return typeof matchMedia === "function" && matchMedia("(max-width: 720px)").matches;
}

/**
 * Every speed the picker offers: 0.25 to 5, every 0.05.
 *
 * Built rather than written out because ninety-six hand-typed numbers is
 * ninety-six chances to typo one, and the grid has to agree exactly with
 * `clampSpeed` or a saved preference lands on a value no option carries and
 * the picker shows blank.
 */
function speedChoices(): number[] {
  const out: number[] = [];
  for (let v = SPEED_MIN; v <= SPEED_MAX + 1e-9; v += 0.05) out.push(Math.round(v * 20) / 20);
  return out;
}

/** Inside the range the engines will actually honour, on the step grid. */
function clampSpeed(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  const onGrid = Math.round(rate * 20) / 20;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, onGrid));
}

/** "1", "1.5", "2.25" -- no trailing zeroes, because "1.50x" reads as noise. */
function speedText(rate: number): string {
  return String(Math.round(rate * 100) / 100);
}

/**
 * The detail line, with the language taken out of it.
 *
 * With one language on screen the picker's group heading already said it, and
 * repeating it on all eleven rows is the same clutter this filter exists to
 * remove.
 */
function trimLang(detail: string, language: string): string {
  return detail
    .split(" · ")
    .filter((part) => part.trim() !== "" && part.trim() !== language)
    .join(" · ");
}
