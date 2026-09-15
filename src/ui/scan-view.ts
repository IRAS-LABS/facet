/**
 * The document scanner.
 *
 * Shoot a page, drag its corners if the finder got them wrong, watch it snap
 * flat and white, shoot the next one, save the lot as one PDF.
 *
 * The shape of this surface follows from one decision made in `core/scan/doc`:
 * a page holds its photograph and its corners separately and re-renders on
 * demand. That is why the corners stay draggable after you have moved on to
 * page five, why changing the look applies to a page you shot ten minutes ago,
 * and why "apply to all" is a real button and not a promise to re-shoot.
 *
 * Everything that is a decision rather than a drawing lives in `core/scan`.
 * This file owns the canvas, the drag, the strip and the save.
 */

import {
  FULL_QUAD,
  findQuad,
  quadPoints,
  type Quad,
} from "@core/scan/quad";
import { LOOKS, LOOK_NAMES, type ScanLook } from "@core/scan/clean";
import {
  applyLookToAll,
  indexOfPage,
  makePage,
  movePage,
  removePage,
  renderPage,
  scanName,
  type ScanPage,
} from "@core/scan/doc";
import { imagesToPdf, type PdfImage } from "@core/scan/pdf";
import { mergePdfs } from "@core/ocr/pdf";
import { LANGUAGES, Tesseract, type Recogniser } from "@core/ocr/engine";
import type { Point } from "@core/edit/blur";
import { writeFree } from "@core/save";

/** What the view needs from the world. */
export interface ScanHost {
  /** A camera, for shooting pages. The same shape the camera view takes. */
  source: {
    open(constraints: MediaStreamConstraints): Promise<MediaStream>;
    devices?(): Promise<MediaDeviceInfo[]>;
  };
  /** Where a finished scan is written. */
  folder(): string;
  /** Answers with the path actually written, which may be a stepped name. */
  writeFile(path: string, bytes: Uint8Array, overwrite: boolean): Promise<string>;
  /** Tell the file list something appeared. */
  refresh?(): void;
  /**
   * OCR, for a searchable PDF. Injected so the harness can answer "does the
   * searchable switch actually reach the reader" without a model download.
   */
  engine?: Recogniser;
  /** Language for that OCR, if the app has a preference. */
  language?(): string;
}

/** How big a page thumbnail is rendered, on the long side. */
const THUMB = 220;

/** How big the on-screen preview is rendered. Not the export size. */
const PREVIEW = 1400;

export class ScanView {
  private readonly root: HTMLElement;
  private readonly video = document.createElement("video");
  /** The page being adjusted, drawn at screen size. */
  private readonly canvas = document.createElement("canvas");
  private readonly overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  private readonly poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  private readonly handles: SVGCircleElement[] = [];
  private readonly stage = document.createElement("div");
  private readonly strip = document.createElement("div");
  private readonly status = document.createElement("div");
  private readonly count = document.createElement("span");
  private readonly lookSel = document.createElement("select");
  private readonly brightIn = document.createElement("input");
  private readonly contrastIn = document.createElement("input");
  private readonly searchIn = document.createElement("input");
  private readonly langSel = document.createElement("select");
  private readonly shutter: HTMLButtonElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly cornersBtn: HTMLButtonElement;

  private pages: ScanPage[] = [];
  private current: string | null = null;
  private stream: MediaStream | null = null;
  /** True while the stage is showing the camera rather than a page. */
  private shooting = true;
  /** True while the stage shows the source photo with corners on it. */
  private adjusting = false;
  private dragging = -1;
  private busy = false;
  /** Pending rAF handle for a coalesced strip repaint, or 0 for none. */
  private stripRaf = 0;
  private engine: Recogniser | null = null;
  private readonly urls: string[] = [];

  constructor(private readonly host: ScanHost) {
    this.root = document.createElement("div");
    this.root.className = "scan";
    this.root.hidden = true;

    // ── Stage ───────────────────────────────────────────────────────────────
    this.video.className = "scan-video";
    this.video.autoplay = true;
    this.video.playsInline = true;
    // An attached-but-empty <video> paints the WebView's own grey poster --
    // a big grey rectangle with a play triangle in it -- for as long as the
    // camera takes to answer. That reads as a broken player rather than as a
    // camera warming up. Hold it transparent over the black stage until real
    // frames exist, and let the status line do the talking until then.
    this.video.addEventListener("loadeddata", () => this.video.classList.add("ready"));
    this.video.muted = true;
    this.canvas.className = "scan-canvas";
    this.canvas.hidden = true;

    this.overlay.setAttribute("class", "scan-overlay");
    this.overlay.setAttribute("viewBox", "0 0 100 100");
    this.overlay.setAttribute("preserveAspectRatio", "none");
    this.poly.setAttribute("class", "scan-quad");
    this.overlay.append(this.poly);
    for (let i = 0; i < 4; i++) {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("class", "scan-handle");
      // In viewBox units, which are stretched by `preserveAspectRatio: none`
      // — so the handle would be an ellipse on a non-square stage. The CSS
      // gives it a fixed pixel radius through `vector-effect` instead; this is
      // only the fallback for a browser that ignores that.
      c.setAttribute("r", "1.6");
      c.dataset["i"] = String(i);
      this.overlay.append(c);
      this.handles.push(c);
    }
    this.overlay.toggleAttribute("hidden", true);

    this.stage.className = "scan-stage";
    this.stage.append(this.video, this.canvas, this.overlay);
    this.wireDrag();

    // ── Bar ─────────────────────────────────────────────────────────────────
    const bar = document.createElement("header");
    bar.className = "scan-bar";
    this.count.className = "scan-count";

    this.lookSel.className = "scan-sel";
    this.lookSel.title = "How the finished page should look";
    for (const l of LOOKS) {
      const o = document.createElement("option");
      o.value = l;
      o.textContent = LOOK_NAMES[l];
      this.lookSel.append(o);
    }
    this.lookSel.value = "colour";
    this.lookSel.addEventListener("change", () => {
      const p = this.page();
      if (!p) return;
      p.look = this.lookSel.value as ScanLook;
      this.redraw();
      this.queueStrip();
    });

    this.cornersBtn = this.btn("⛶", "Adjust the corners of this page", () => this.toggleCorners(), "Corners");

    bar.append(
      this.count,
      this.lookSel,
      this.cornersBtn,
      this.btn("↺", "Turn this page a quarter anticlockwise", () => this.turnBy(-1), "Left"),
      this.btn("↻", "Turn this page a quarter clockwise", () => this.turnBy(1), "Right"),
      this.btn("⇊", "Give every page this page's look", () => this.applyAll(), "All pages"),
      spacer(),
      this.btn("✕", "Close  (Esc)", () => this.close(), "Close"),
    );

    // ── Sliders ─────────────────────────────────────────────────────────────
    const tune = document.createElement("div");
    tune.className = "scan-tune";
    this.brightIn.type = "range";
    this.brightIn.min = "0";
    this.brightIn.max = "100";
    this.brightIn.value = "50";
    this.brightIn.title = "How hard the paper is pushed to white";
    this.brightIn.addEventListener("input", () => {
      const p = this.page();
      if (!p) return;
      p.brightness = Number(this.brightIn.value) / 100;
      this.redraw();
      this.queueStrip();
    });
    this.contrastIn.type = "range";
    this.contrastIn.min = "0";
    this.contrastIn.max = "100";
    this.contrastIn.value = "50";
    this.contrastIn.title = "Contrast, after the paper is whitened";
    this.contrastIn.addEventListener("input", () => {
      const p = this.page();
      if (!p) return;
      p.contrast = Number(this.contrastIn.value) / 100;
      this.redraw();
      this.queueStrip();
    });
    tune.append(label("Paper", this.brightIn), label("Contrast", this.contrastIn));

    // ── Strip ───────────────────────────────────────────────────────────────
    this.strip.className = "scan-strip";

    // ── Foot ────────────────────────────────────────────────────────────────
    const foot = document.createElement("footer");
    foot.className = "scan-foot";
    this.shutter = this.btn("", "Shoot this page  (Space)", () => void this.shoot(), "Shoot");
    this.shutter.className = "scan-shutter";

    this.searchIn.type = "checkbox";
    this.searchIn.id = "scan-searchable";
    const searchLabel = document.createElement("label");
    searchLabel.className = "scan-check";
    searchLabel.title =
      "Read the text and put it under the picture, so the PDF can be searched. Slower, and it downloads a language model the first time.";
    searchLabel.append(this.searchIn, document.createTextNode("Searchable"));

    this.langSel.className = "scan-sel";
    this.langSel.title = "Which language the text is in";
    for (const l of LANGUAGES) {
      const o = document.createElement("option");
      o.value = l.code;
      o.textContent = l.name;
      this.langSel.append(o);
    }
    this.langSel.value = "eng";
    // Hidden rather than absent, and only while it means something: a language
    // picker beside an unticked Searchable box is a control that does nothing,
    // which is worse than no control at all.
    this.langSel.hidden = true;
    this.searchIn.addEventListener("change", () => {
      this.langSel.hidden = !this.searchIn.checked;
    });

    this.saveBtn = this.btn("Save PDF", "Write every page to one PDF", () => void this.save("pdf"), "PDF");
    this.saveBtn.className = "scan-go";

    this.status.className = "scan-status";
    foot.append(
      this.btn("＋", "Shoot another page", () => this.newPage(), "Add"),
      spacer(),
      this.shutter,
      spacer(),
      searchLabel,
      this.langSel,
      this.saveBtn,
      this.btn("⧉", "Write every page as its own image instead", () => void this.save("images"), "Images"),
      this.status,
    );

    this.root.append(bar, this.stage, this.overlayTune(tune), this.strip, foot);
    document.body.appendChild(this.root);
    this.wireKeys();
  }

  /** The sliders only mean anything on a page, so they live with the strip. */
  private overlayTune(tune: HTMLElement): HTMLElement {
    return tune;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Not a file. The session record asks every surface the same question. */
  get openPath(): string | null {
    return null;
  }

  async open(): Promise<void> {
    if (this.isOpen) return;
    this.root.hidden = false;
    this.pages = [];
    this.current = null;
    this.shooting = true;
    this.adjusting = false;
    this.render();
    await this.start();
  }

  close(): void {
    if (!this.isOpen) return;
    this.stop();
    if (this.stripRaf) { cancelAnimationFrame(this.stripRaf); this.stripRaf = 0; }
    for (const u of this.urls.splice(0)) URL.revokeObjectURL(u);
    this.pages = [];
    this.current = null;
    this.root.hidden = true;
  }

  /**
   * Open the camera.
   *
   * The rear camera, asked for by `facingMode`, and at the highest resolution
   * the device will give: a scan is read afterwards, by a person or by an OCR
   * engine, and 720p of a page of body text is not readable by either. `ideal`
   * rather than `exact` throughout, because `exact` on a laptop with one
   * front-facing webcam fails outright rather than falling back, and a laptop
   * is a perfectly good thing to hold a receipt up to.
   */
  private async start(): Promise<void> {
    this.stop();
    // Said before the await, not after. Asking for a camera can sit there for
    // as long as it takes someone to answer a permission prompt, and until it
    // resolves the scanner is a black rectangle with no explanation -- which
    // reads as broken rather than as waiting. The camera view already does
    // this; the scanner should not be the one screen that stays silent.
    this.say("Opening the camera…");
    try {
      this.stream = await this.host.source.open({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
        audio: false,
      });
      this.video.srcObject = this.stream;
      this.say("Fill the frame with the page.");
    } catch (e) {
      this.say(`No camera: ${message(e)}`);
    }
  }

  private stop(): void {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.video.srcObject = null;
    this.video.classList.remove("ready");
  }

  // ── Pages ─────────────────────────────────────────────────────────────────

  private page(): ScanPage | null {
    return this.pages.find((p) => p.id === this.current) ?? null;
  }

  /** Back to the viewfinder, keeping every page already shot. */
  private newPage(): void {
    this.shooting = true;
    this.adjusting = false;
    this.render();
    if (!this.stream) void this.start();
  }

  /**
   * Take the frame and turn it into a page.
   *
   * `videoWidth` rather than the element's box, for the reason the camera
   * states at length: the element is whatever size the window is, and drawing
   * that would quietly scan a 4K page at 900 pixels wide with nothing on
   * screen saying so. On a page of 9 pt type that is the difference between a
   * scan you can read and one you cannot.
   */
  private async shoot(): Promise<void> {
    if (this.busy) return;
    if (!this.shooting) {
      this.newPage();
      return;
    }
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (w === 0 || h === 0) {
      this.say("The camera has not started yet.");
      return;
    }

    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(this.video, 0, 0, w, h);

    const page = makePage(ctx.getImageData(0, 0, w, h));
    this.pages.push(page);
    this.current = page.id;
    this.shooting = false;
    this.adjusting = !page.detected;
    this.say(
      page.detected
        ? `Page ${this.pages.length}. Corners found — tap Corners to move them.`
        : `Page ${this.pages.length}. No page edge found — drag the corners.`,
    );
    this.render();
    await Promise.resolve();
  }

  /** Look for the corners again, for a page whose quad has been dragged about. */
  private redetect(): void {
    const p = this.page();
    if (!p) return;
    const found = findQuad(p.source);
    p.quad = found ?? FULL_QUAD;
    p.detected = found !== null;
    this.say(found ? "Corners found." : "Still no page edge — drag them yourself.");
    this.render();
  }

  private toggleCorners(): void {
    if (this.shooting) return;
    this.adjusting = !this.adjusting;
    this.render();
  }

  private turnBy(by: number): void {
    const p = this.page();
    if (!p) return;
    p.turns = (((p.turns + by) % 4) + 4) % 4;
    this.redraw();
    this.queueStrip();
    // While the corners are up the stage is showing the source photo, which
    // does not turn -- so without this the button looks broken. Say what
    // happened, because the thumbnail is the only thing that moved.
    if (this.adjusting) this.say("Turned. The stage keeps the photo upright while you move corners.");
  }

  private applyAll(): void {
    const p = this.page();
    if (!p) return;
    this.pages = applyLookToAll(this.pages, p);
    this.say(`Every page now looks like page ${indexOfPage(this.pages, p.id) + 1}.`);
    this.render();
  }

  private dropPage(id: string): void {
    this.pages = removePage(this.pages, id);
    if (this.current === id) {
      this.current = this.pages[this.pages.length - 1]?.id ?? null;
      if (this.current === null) this.shooting = true;
    }
    this.render();
  }

  private shift(id: string, by: number): void {
    const at = indexOfPage(this.pages, id);
    if (at < 0) return;
    this.pages = movePage(this.pages, at, at + by);
    this.render();
  }

  private select(id: string): void {
    this.current = id;
    this.shooting = false;
    this.adjusting = false;
    this.render();
  }

  // ── Corner dragging ───────────────────────────────────────────────────────

  /**
   * Pointer events on the overlay rather than on each handle.
   *
   * A finger is about ten millimetres across and a corner handle is about
   * four, so hit-testing the circle itself misses more often than it hits.
   * Taking every pointer down on the whole overlay and snapping to the nearest
   * corner means a tap anywhere near one grabs it -- and a drag that starts in
   * the middle of the page grabs the nearest corner too, which is wrong often
   * enough that there is a distance limit.
   */
  private wireDrag(): void {
    const at = (e: PointerEvent): Point => {
      const r = this.stage.getBoundingClientRect();
      return {
        x: r.width > 0 ? (e.clientX - r.left) / r.width : 0,
        y: r.height > 0 ? (e.clientY - r.top) / r.height : 0,
      };
    };

    this.overlay.addEventListener("pointerdown", (e) => {
      const p = this.page();
      if (!p || !this.adjusting) return;
      const here = at(e);
      const pts = quadPoints(p.quad);
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < 4; i++) {
        const d = Math.hypot(pts[i]!.x - here.x, pts[i]!.y - here.y);
        if (d < bestD) { bestD = d; best = i; }
      }
      // A tenth of the frame. Bigger than any thumb, small enough that a tap
      // in the middle of the page is not read as a wild drag of one corner.
      if (bestD > 0.12) return;
      this.dragging = best;
      this.overlay.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    this.overlay.addEventListener("pointermove", (e) => {
      if (this.dragging < 0) return;
      const p = this.page();
      if (!p) return;
      const here = at(e);
      const x = Math.min(1, Math.max(0, here.x));
      const y = Math.min(1, Math.max(0, here.y));
      const key = (["tl", "tr", "br", "bl"] as const)[this.dragging]!;
      // A new object, not a mutation: `quad` is read by the renderer on the
      // next frame and shared with nothing, but the page is copied wholesale
      // by `applyLookToAll`, and a quad two pages share is a quad that moves
      // on both.
      p.quad = { ...p.quad, [key]: { x, y } } as Quad;
      p.detected = false;
      this.drawOverlay();
      e.preventDefault();
    });

    const end = (e: PointerEvent): void => {
      if (this.dragging < 0) return;
      this.dragging = -1;
      try { this.overlay.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
      this.renderStrip();
    };
    this.overlay.addEventListener("pointerup", end);
    this.overlay.addEventListener("pointercancel", end);
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  private render(): void {
    this.count.textContent =
      this.pages.length === 0
        ? "No pages yet"
        : `${this.pages.length} page${this.pages.length === 1 ? "" : "s"}`;

    const p = this.page();
    this.video.hidden = !this.shooting;
    this.canvas.hidden = this.shooting;
    // `hidden` as an attribute, not a property: this is an <svg>, and
    // SVGElement has no `hidden` IDL attribute to assign to.
    this.overlay.toggleAttribute("hidden", !(this.adjusting && p !== null));
    this.cornersBtn.classList.toggle("on", this.adjusting);
    this.shutter.textContent = this.shooting ? "" : "＋";
    this.shutter.title = this.shooting ? "Shoot this page  (Space)" : "Shoot another page  (Space)";
    this.saveBtn.disabled = this.pages.length === 0 || this.busy;

    if (p) {
      this.lookSel.value = p.look;
      this.brightIn.value = String(Math.round(p.brightness * 100));
      this.contrastIn.value = String(Math.round(p.contrast * 100));
    }

    this.redraw();
    this.renderStrip();
  }

  /**
   * Repaint the stage for the current page.
   *
   * Two different pictures depending on the mode, and that is the whole point
   * of the Corners button: while you are adjusting you need to see the *photo*
   * with the quad drawn on it, because the corners are meaningless against the
   * flattened result. Otherwise you want the result, because that is the thing
   * being saved.
   */
  private redraw(): void {
    const p = this.page();
    if (!p || this.shooting) return;

    const img = this.adjusting ? p.source : renderPage(p, PREVIEW);
    if (!img) {
      this.say("Those four corners do not make a page — drag one of them.");
      return;
    }
    this.canvas.width = img.width;
    this.canvas.height = img.height;
    this.canvas.getContext("2d")?.putImageData(img, 0, 0);
    this.drawOverlay();
  }

  private drawOverlay(): void {
    const p = this.page();
    if (!p) return;
    const pts = quadPoints(p.quad);
    this.poly.setAttribute(
      "points",
      pts.map((q) => `${q.x * 100},${q.y * 100}`).join(" "),
    );
    for (let i = 0; i < 4; i++) {
      this.handles[i]!.setAttribute("cx", String(pts[i]!.x * 100));
      this.handles[i]!.setAttribute("cy", String(pts[i]!.y * 100));
    }
  }

  /**
   * Repaint the strip on the next frame, at most once per frame.
   *
   * The look controls -- turn, paper, contrast, colour -- change nothing on
   * the stage while the corners are up, because the stage is deliberately
   * showing the untouched photo. The thumbnail is then the only feedback
   * there is, so it has to keep up; and a slider dragged across its range
   * fires far faster than a full strip re-render can run, hence the frame
   * coalescing rather than a direct call.
   */
  private queueStrip(): void {
    if (this.stripRaf) return;
    this.stripRaf = requestAnimationFrame(() => {
      this.stripRaf = 0;
      this.renderStrip();
    });
  }

  /**
   * The page strip.
   *
   * Rebuilt whole rather than patched. A scan is a handful of pages, the
   * thumbnails are already cached as data URLs on the elements, and a diffing
   * strip that gets reordering subtly wrong is a worse bug than a rebuild
   * nobody can perceive.
   */
  private renderStrip(): void {
    this.strip.replaceChildren();
    this.pages.forEach((p, i) => {
      const cell = document.createElement("div");
      cell.className = "scan-page";
      cell.classList.toggle("on", p.id === this.current);

      const img = document.createElement("canvas");
      img.className = "scan-thumb";
      const small = renderPage(p, THUMB);
      if (small) {
        img.width = small.width;
        img.height = small.height;
        img.getContext("2d")?.putImageData(small, 0, 0);
      }
      img.addEventListener("click", () => this.select(p.id));

      const n = document.createElement("span");
      n.className = "scan-no";
      n.textContent = String(i + 1);

      const tools = document.createElement("div");
      tools.className = "scan-pagetools";
      tools.append(
        this.btn("‹", "Move this page earlier", () => this.shift(p.id, -1), "Earlier"),
        this.btn("›", "Move this page later", () => this.shift(p.id, 1), "Later"),
        this.btn("⌫", "Drop this page", () => this.dropPage(p.id), "Drop"),
      );

      cell.append(img, n, tools);
      this.strip.append(cell);
    });

    if (this.pages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "scan-empty";
      empty.textContent = "Pages you shoot appear here.";
      this.strip.append(empty);
    }
  }

  // ── Saving ────────────────────────────────────────────────────────────────

  /**
   * Write the scan out.
   *
   * Rendered at full size here and nowhere else. Everything on screen has been
   * a preview at 1400 px or a thumbnail at 220; the file is the first time the
   * warp runs against all the pixels the camera gave, and on a twelve-page
   * scan that is most of the wait.
   */
  private async save(how: "pdf" | "images"): Promise<void> {
    if (this.busy || this.pages.length === 0) return;
    this.busy = true;
    this.saveBtn.disabled = true;
    const folder = this.host.folder().replace(/[/\\]+$/, "");
    const stem = scanName(new Date());

    try {
      if (how === "images") {
        for (let i = 0; i < this.pages.length; i++) {
          this.say(`Saving page ${i + 1} of ${this.pages.length}…`);
          const blob = await this.encode(this.pages[i]!);
          const name = this.pages.length === 1 ? `${stem}.jpg` : `${stem}-${pad(i + 1)}.jpg`;
          // `writeFree` throughout: two scans inside one second share a stem,
          // and the backend refuses a taken name rather than stepping past it.
          await writeFree(this.host, `${folder}/${name}`, blob.bytes);
        }
        this.say(`Saved ${this.pages.length} image${this.pages.length === 1 ? "" : "s"} to ${folder}`);
      } else if (this.searchIn.checked) {
        const bytes = await this.searchablePdf(stem);
        const out = await writeFree(this.host, `${folder}/${stem}.pdf`, bytes);
        // The name that came back, not the one asked for: `writeFree` may have
        // stepped past a stem a scan a second earlier had already taken.
        this.say(`Saved a searchable ${out.split(/[\\/]/).pop()} to ${folder}`);
      } else {
        const parts: PdfImage[] = [];
        for (let i = 0; i < this.pages.length; i++) {
          this.say(`Rendering page ${i + 1} of ${this.pages.length}…`);
          parts.push(await this.encode(this.pages[i]!));
        }
        const bytes = await imagesToPdf(parts, { title: stem });
        const out = await writeFree(this.host, `${folder}/${stem}.pdf`, bytes);
        this.say(`Saved ${out.split(/[\\/]/).pop()} to ${folder}`);
      }
      this.host.refresh?.();
    } catch (e) {
      this.say(`Could not save: ${message(e)}`);
    } finally {
      this.busy = false;
      this.saveBtn.disabled = this.pages.length === 0;
    }
  }

  /**
   * OCR each page into a one-page searchable PDF, then join them.
   *
   * Tesseract's PDF renderer is handed one image and closed, so this is the
   * only shape the API allows -- twelve pages is twelve documents and a merge.
   * `mergePdfs` already existed for exactly this, from the OCR panel.
   */
  private async searchablePdf(title: string): Promise<Uint8Array> {
    const engine = this.engine ?? this.host.engine ?? (this.engine = new Tesseract());
    const language = this.host.language?.() ?? (this.langSel.value || "eng");
    const parts: Uint8Array[] = [];

    for (let i = 0; i < this.pages.length; i++) {
      const img = renderPage(this.pages[i]!);
      if (!img) continue;
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      c.getContext("2d")?.putImageData(img, 0, 0);

      const res = await engine.read(c, {
        language,
        pdf: true,
        title,
        onProgress: (pr) =>
          this.say(`Page ${i + 1} of ${this.pages.length}: ${pr.what}…`),
      });
      if (res.pdf) parts.push(res.pdf);
    }

    if (parts.length === 0) throw new Error("the reader produced nothing");
    return mergePdfs(parts);
  }

  /**
   * A page as JPEG bytes.
   *
   * JPEG at 88, not PNG. A photographed page is a photograph -- continuous
   * tone, sensor noise, no flat colour to speak of -- and PNG of one is
   * routinely eight times the size for a difference nobody can see on paper.
   * The exception is `mono`, which really is flat, and PNG really is smaller;
   * but it also has to go into a PDF beside the others, and one encoder
   * throughout is worth more than the megabyte.
   */
  private async encode(page: ScanPage): Promise<PdfImage> {
    const img = renderPage(page);
    if (!img) throw new Error("a page has corners that do not make a rectangle");

    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    c.getContext("2d")?.putImageData(img, 0, 0);

    const blob = await new Promise<Blob | null>((res) =>
      c.toBlob((b) => res(b), "image/jpeg", 0.88),
    );
    if (!blob) throw new Error("the browser could not encode that page");
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      kind: "jpeg",
      width: img.width,
      height: img.height,
    };
  }

  // ── Chrome ────────────────────────────────────────────────────────────────

  private btn(label: string, title: string, on: () => void, short?: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "scan-btn";
    b.type = "button";
    b.textContent = label;
    b.title = title;
    if (short !== undefined) b.dataset["fctShort"] = short;
    b.addEventListener("click", on);
    return b;
  }

  private say(what: string): void {
    this.status.textContent = what;
  }

  private wireKeys(): void {
    document.addEventListener("keydown", (e) => {
      if (!this.isOpen) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "Escape") { this.close(); e.preventDefault(); return; }
      if (e.key === " ") { void this.shoot(); e.preventDefault(); return; }
      if (e.key === "c" || e.key === "C") { this.toggleCorners(); e.preventDefault(); return; }
      if (e.key === "d" || e.key === "D") { this.redetect(); e.preventDefault(); }
    });
  }
}

function spacer(): HTMLElement {
  const s = document.createElement("span");
  s.className = "scan-spacer";
  return s;
}

function label(text: string, control: HTMLElement): HTMLElement {
  const l = document.createElement("label");
  l.className = "scan-slider";
  const t = document.createElement("span");
  t.textContent = text;
  l.append(t, control);
  return l;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
