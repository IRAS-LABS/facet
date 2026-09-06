/**
 * Signing a document — where a saved signature meets a page.
 *
 * The pad (`sign-pad.ts`) makes a signature; this places one. They are separate
 * screens because they are separate jobs done at different times: you draw your
 * signature carefully, once, and then you use it for years without wanting to
 * see a slider again.
 *
 * Three decisions shape everything below.
 *
 * **The page is a canvas, the marks are DOM.** pdf.js paints the page once per
 * page turn; every stamp is a positioned element over it. Dragging a stamp is
 * then two style writes instead of a full re-render, which is what keeps it
 * smooth on the phone — and rotation, opacity and scaling all come free from
 * CSS rather than from arithmetic that would have to agree with the exporter's.
 *
 * **The screen and the file share one geometry.** Every placement is stored in
 * PDF points with a bottom-left origin, exactly as `stamp.ts` wants it, and the
 * overlay converts to per-cent for display. Nothing is ever stored in screen
 * pixels, so zooming, turning the phone, or resizing the window cannot move a
 * mark by a hair — there is no pixel value to become stale.
 *
 * **Export goes through the same module as the preview.** `stampPdf` is not a
 * second implementation of what you are looking at; `artPaths`/`stampMatrix`
 * built the preview too. A signature that sits right on screen and lands two
 * millimetres off in the file is the failure this whole layout is arranged to
 * make impossible.
 */

import { loadPdfjs } from "@core/explorer/preview";
import {
  artPaths,
  artToSvg,
  dataUrlBytes,
  placement,
  stampPdf,
  tilePositions,
  type CropBox,
  type PageRaster,
  type PageSelection,
  type PdfExtras,
  type Placement,
  type Redaction,
  type StampRequest,
  type Watermark,
} from "@core/sign/stamp";
import { browserSigBackend, SignatureStore, type SigKind, type Signature } from "@core/sign/store";
import { textPaths } from "@core/sign/text";
import { el, fill } from "./phone/dom";
import { icon } from "./phone/icons";
import { SignPad } from "./sign-pad";

/** What the panel will open: anything you would reasonably sign. */
export const SIGN_EXTS = ["pdf", "png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"];

export interface SignHost {
  fileUrl(path: string): Promise<string>;
  readAll(path: string, max: number): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array, overwrite?: boolean): Promise<string>;
  refresh(): void;
  /** Shared with the pad and the phone build. One store per session. */
  store?: SignatureStore;
}

/** 64 MB. A scan larger than this is not something to hold three copies of. */
const MAX_BYTES = 64 * 1024 * 1024;

/** How wide the page is drawn, as a percentage of the space available. */
const ZOOMS = [75, 100, 125, 150, 200, 300];

/** Default stamp size in points — about 55 mm wide, a normal signature. */
const DEFAULT_W = 160;

/**
 * Watermark presets (item 19).
 *
 * Not a gallery. These are the four things people actually stamp across a page,
 * and each one carries its own placement — DRAFT belongs tiled and diagonal
 * across everything, CONFIDENTIAL belongs once and large, and a preset that got
 * the word right and the layout wrong would still have to be adjusted by hand.
 */
interface Preset {
  id: string;
  label: string;
  text: string;
  colour: string;
  opacity: number;
  rotate: number;
  tiled: boolean;
}

const PRESETS: readonly Preset[] = [
  { id: "draft", label: "DRAFT tiled", text: "DRAFT", colour: "#8a1220", opacity: 0.1, rotate: 35, tiled: true },
  { id: "conf", label: "CONFIDENTIAL", text: "CONFIDENTIAL", colour: "#8a1220", opacity: 0.14, rotate: 35, tiled: false },
  { id: "copy", label: "COPY", text: "COPY", colour: "#111318", opacity: 0.12, rotate: 0, tiled: false },
  { id: "void", label: "VOID tiled", text: "VOID", colour: "#111318", opacity: 0.11, rotate: 20, tiled: true },
];

/**
 * Something placed on a page. The unit of everything this panel does.
 *
 * One type for both because everything except what gets painted is shared --
 * the drag, the resize, the selection, the per-page filter and the export
 * ordering are the same job whether the box holds a signature or hides a bank
 * balance. `sigId` is empty for a cover; `colour` is unused for a signature.
 */
type MarkKind = "sig" | "redact";

interface Mark {
  id: string;
  kind: MarkKind;
  sigId: string;
  colour: string;
  page: number;
  place: Placement;
}

/** The crop window being dragged, and where it applies. */
interface CropState {
  on: boolean;
  place: Placement;
  scope: "all" | "this";
}

/** Ink for a new cover. Black, because that is what a redaction looks like. */
const REDACT_INK = "#000000";

/** The watermark being composed, if any. Kept flat so the controls are simple. */
interface WmState {
  on: boolean;
  sigId: string | null;
  preset: string | null;
  colour: string;
  opacity: number;
  rotate: number;
  width: number;
  tiled: boolean;
  gap: number;
  scope: "all" | "range" | "this";
  from: number;
  to: number;
}

const newId = (): string => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const toRedaction = (m: Mark): Redaction => ({ page: m.page, place: m.place, colour: m.colour });

export class SignView {
  private readonly root = el<"div">("div.fct-signv", { hidden: true });
  private readonly titleEl = el("div.fct-signv-title");
  private readonly pageNote = el("span.fct-signv-note");
  private readonly zoomNote = el("span.fct-signv-note");
  private readonly stage = el("div.fct-signv-stage");
  private readonly pageBox = el("div.fct-signv-page");
  private readonly canvas = document.createElement("canvas");
  private readonly overlay = el("div.fct-signv-overlay");
  private readonly side = el("aside.fct-signv-side");
  private readonly nameIn = el("input.fct-signv-name") as HTMLInputElement;
  private readonly status = el("div.fct-signv-status");

  private readonly store: SignatureStore;
  private pad: SignPad | null = null;
  private unsub: (() => void) | null = null;

  private path = "";
  private isPdf = false;
  private pageCount = 1;
  private at = 0;
  private zoom = 1;
  private pageW = 612;
  private pageH = 792;
  private marks: Mark[] = [];
  private picked: string | null = null;
  private crop: CropState = {
    on: false,
    place: placement({ x: 0, y: 0, w: 100, h: 100 }),
    scope: "all",
  };
  /**
   * Rebuild redacted pages from a picture of themselves.
   *
   * On by default, and it is the whole difference between a redaction and a
   * decoration: a rectangle drawn over a word hides it from a reader and from
   * no software at all. Off is offered because it keeps the page searchable,
   * and some covers are only tidying.
   */
  private burnIn = true;
  private busy = false;
  private pdfTask: import("pdfjs-dist").PDFDocumentLoadingTask | null = null;
  private pdfDoc: import("pdfjs-dist").PDFDocumentProxy | null = null;

  private wm: WmState = {
    on: false, sigId: null, preset: "draft", colour: "#8a1220", opacity: 0.1,
    rotate: 35, width: 220, tiled: true, gap: 90, scope: "all", from: 1, to: 1,
  };

  constructor(private readonly host: SignHost) {
    this.store = host.store ?? new SignatureStore(browserSigBackend());

    this.canvas.className = "fct-signv-canvas";
    this.pageBox.append(this.canvas, this.overlay);
    this.stage.append(this.pageBox);

    const head = el("header.fct-signv-bar",
      undefined,
      this.titleEl,
      el("div.fct-signv-spacer"),
      this.iconBtn("chevron-left", "Previous page", () => void this.turn(-1)),
      this.pageNote,
      this.iconBtn("chevron-right", "Next page", () => void this.turn(1)),
      el("div.fct-signv-gap"),
      this.iconBtn("minus", "Zoom out", () => this.stepZoom(-1)),
      this.zoomNote,
      this.iconBtn("plus", "Zoom in", () => this.stepZoom(1)),
      el("div.fct-signv-gap"),
      this.iconBtn("x", "Close  (Esc)", () => this.close()),
    );

    const foot = el("footer.fct-signv-foot",
      undefined,
      this.status,
      el("div.fct-signv-spacer"),
      this.nameIn,
      el("button.fct-signv-save", { type: "button", text: "Save signed copy" }),
    );
    (foot.querySelector(".fct-signv-save") as HTMLElement | null)
      ?.addEventListener("click", () => void this.save());

    this.nameIn.placeholder = "signed file name";
    this.root.append(head, el("div.fct-signv-body", undefined, this.stage, this.side), foot);
    this.root.tabIndex = -1;
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    // A click on bare page deselects, which is how you get the handles out of
    // the way to look at what you have actually done.
    this.stage.addEventListener("pointerdown", (e) => {
      if (e.target === this.stage || e.target === this.canvas || e.target === this.pageBox) this.pick(null);
    });
    document.body.appendChild(this.root);

    window.addEventListener("resize", () => this.layout());
  }

  /** Is the panel up? The shell asks before routing a key. */
  isOpen(): boolean {
    return !this.root.hidden;
  }

  /** The document being signed, or null. */
  openPath(): string | null {
    return this.root.hidden ? null : this.path;
  }

  /**
   * Open a document, optionally straight into a job.
   *
   * The mode exists because the phone reaches this panel from a named button:
   * tapping "Redact" and landing on a signature list with the cover tool three
   * scrolls down would be the same complaint that got this written.
   */
  async open(path: string, mode: "sign" | "redact" | "crop" = "sign"): Promise<void> {
    this.path = path;
    this.isPdf = /\.pdf$/i.test(path);
    this.at = 0;
    this.marks = [];
    this.picked = null;
    this.crop = { on: false, place: placement({ x: 0, y: 0, w: 100, h: 100 }), scope: "all" };
    this.burnIn = true;
    this.root.hidden = false;
    this.root.focus();

    const name = path.split(/[\\/]/).pop() ?? path;
    this.titleEl.textContent = name;
    this.nameIn.value = name.replace(/\.([^.]+)$/, "-signed.$1");
    this.say("");

    this.unsub?.();
    this.unsub = this.store.subscribe(() => this.buildSide());

    try {
      await this.showPage();
    } catch (err) {
      this.say(err instanceof Error ? err.message : String(err), true);
    }
    // After the page, because both need to know how big it is.
    if (mode === "redact") this.addRedaction();
    if (mode === "crop") this.toggleCrop(true);
    this.buildSide();
  }

  close(): void {
    this.root.hidden = true;
    this.unsub?.();
    this.unsub = null;
    this.pad?.dispose();
    this.pad = null;
    void this.shutPdf();
  }

  private async shutPdf(): Promise<void> {
    const task = this.pdfTask;
    this.pdfTask = null;
    this.pdfDoc = null;
    try {
      await task?.destroy();
    } catch {
      // A document torn down mid-render rejects. Nothing left to clean up.
    }
  }

  // ── Page rendering ────────────────────────────────────────────────────────

  private async showPage(): Promise<void> {
    const url = await this.host.fileUrl(this.path);
    if (this.isPdf) await this.drawPdfPage(url, this.at);
    else await this.drawImage(url);
    this.layout();
    this.paintMarks();
    this.pageNote.textContent = this.isPdf ? `${this.at + 1} / ${this.pageCount}` : "";
    this.zoomNote.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  private async drawImage(url: string): Promise<void> {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const node = new Image();
      node.decoding = "async";
      node.addEventListener("load", () => resolve(node));
      node.addEventListener("error", () => reject(new Error("not a picture this build can open")));
      node.src = url;
    });
    // For a picture, one pixel is one "point". There is no other unit on offer
    // and inventing a dpi would only make the numbers in the panel lie.
    this.pageW = img.naturalWidth;
    this.pageH = img.naturalHeight;
    this.pageCount = 1;
    this.canvas.width = this.pageW;
    this.canvas.height = this.pageH;
    this.canvas.getContext("2d")?.drawImage(img, 0, 0);
  }

  private async drawPdfPage(url: string, index: number): Promise<void> {
    if (!this.pdfTask) {
      const pdfjs = await loadPdfjs();
      this.pdfTask = pdfjs.getDocument({ url });
      this.pdfDoc = await this.pdfTask.promise;
    }
    const doc = this.pdfDoc;
    if (!doc) throw new Error("the PDF would not open");
    this.pageCount = doc.numPages;
    const page = await doc.getPage(Math.min(index, doc.numPages - 1) + 1);

    const unit = page.getViewport({ scale: 1 });
    this.pageW = unit.width;
    this.pageH = unit.height;

    // 2× so the page is still crisp at 200% zoom without allocating four times
    // the memory a 4× backing store would need on a long document.
    const view = page.getViewport({ scale: 2 });
    this.canvas.width = Math.round(view.width);
    this.canvas.height = Math.round(view.height);
    const ctx = this.canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      await page.render({ canvas: this.canvas, canvasContext: ctx, viewport: view }).promise;
    }
  }

  /** Size the page box from the points, not from the backing store. */
  private layout(): void {
    const avail = Math.max(120, this.stage.clientWidth - 32);
    const wide = Math.min(avail, this.pageW * this.zoom * 1.333);
    this.pageBox.style.width = `${Math.round(wide)}px`;
    this.pageBox.style.height = `${Math.round((wide * this.pageH) / this.pageW)}px`;
  }

  private stepZoom(dir: number): void {
    const now = Math.round(this.zoom * 100);
    const i = ZOOMS.findIndex((z) => z >= now);
    const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + dir))];
    this.zoom = (next ?? 100) / 100;
    this.zoomNote.textContent = `${Math.round(this.zoom * 100)}%`;
    this.layout();
    this.paintMarks();
  }

  private async turn(dir: number): Promise<void> {
    if (!this.isPdf) return;
    const next = Math.max(0, Math.min(this.pageCount - 1, this.at + dir));
    if (next === this.at) return;
    this.at = next;
    this.pick(null);
    await this.showPage();
    this.buildSide();
  }

  // ── Marks on the page ─────────────────────────────────────────────────────

  /**
   * Draw the overlay from scratch.
   *
   * Rebuilding rather than patching because the node count is tiny (a handful
   * of stamps plus at most a few dozen watermark tiles) and a diff would be
   * more code than the thing it optimised. Dragging does not come through here
   * — it writes two style properties directly — so the rebuild never runs on a
   * pointer move.
   */
  private paintMarks(): void {
    const kids: HTMLElement[] = [];

    if (this.wm.on) {
      const art = this.watermarkArt();
      if (art) {
        const place = this.watermarkPlace();
        const spots = this.wm.tiled
          ? tilePositions(this.pageW, this.pageH, place, { gapX: this.wm.gap, gapY: this.wm.gap, angle: 45 })
          : [{ x: place.x, y: place.y }];
        const svg = artToSvg(art, this.wm.colour, 400);
        for (const spot of spots) {
          if (!this.wmCoversPage(this.at)) break;
          const node = el("div.fct-signv-wm", { html: svg });
          this.position(node, { ...place, x: spot.x, y: spot.y });
          node.style.opacity = String(this.wm.opacity);
          kids.push(node);
        }
      }
    }

    for (const mark of this.marks) {
      if (mark.page !== this.at) continue;

      if (mark.kind === "redact") {
        const node = el("div.fct-signv-mark.is-redact", { "data-id": mark.id });
        if (mark.id === this.picked) node.classList.add("is-picked");
        node.style.opacity = String(mark.place.opacity);
        node.style.background = mark.colour;
        node.append(el("div.fct-signv-grip", { title: "Drag to resize" }));
        this.position(node, mark.place);
        this.wire(node, mark, { id: mark.id, free: true });
        kids.push(node);
        continue;
      }

      const sig = this.store.get(mark.sigId);
      if (!sig) continue;
      const node = el("div.fct-signv-mark", { "data-id": mark.id });
      if (mark.id === this.picked) node.classList.add("is-picked");
      node.style.opacity = String(mark.place.opacity);

      if (sig.art.source === "image") {
        const img = new Image();
        img.src = sig.art.data;
        img.className = "fct-signv-art";
        node.append(img);
      } else {
        const art = artPaths(sig.art);
        if (art) node.innerHTML = artToSvg(art, sig.colour, 400);
      }
      node.append(el("div.fct-signv-grip", { title: "Drag to resize" }));
      this.position(node, mark.place);
      this.wire(node, mark, { id: mark.id, free: false });
      kids.push(node);
    }

    if (this.crop.on) {
      const node = el("div.fct-signv-crop");
      node.append(el("div.fct-signv-grip", { title: "Drag to resize" }));
      this.position(node, this.crop.place);
      this.wire(node, this.crop, { id: null, free: true });
      kids.push(node);
    }

    fill(this.overlay, ...kids);
  }

  /** A cover, dropped where you can see it, sized to be obviously draggable. */
  private addRedaction(): void {
    const w = Math.min(this.pageW * 0.5, Math.max(80, this.pageW * 0.35));
    const h = Math.max(18, this.pageH * 0.035);
    const mark: Mark = {
      id: newId(),
      kind: "redact",
      sigId: "",
      colour: REDACT_INK,
      page: this.at,
      place: placement({ x: (this.pageW - w) / 2, y: this.pageH * 0.55, w, h, opacity: 1 }),
    };
    this.marks.push(mark);
    this.picked = mark.id;
    this.paintMarks();
    this.buildSide();
  }

  /** Turn the crop window on or off, starting at a comfortable inset. */
  private toggleCrop(on: boolean): void {
    this.crop.on = on;
    if (on) {
      const inset = 0.08;
      this.crop.place = placement({
        x: this.pageW * inset,
        y: this.pageH * inset,
        w: this.pageW * (1 - inset * 2),
        h: this.pageH * (1 - inset * 2),
      });
    }
    this.paintMarks();
    this.buildSide();
  }

  /** PDF points, bottom-left origin → per-cent of the page box, top-left. */
  private position(node: HTMLElement, place: Placement): void {
    node.style.left = `${(place.x / this.pageW) * 100}%`;
    node.style.top = `${((this.pageH - place.y - place.h) / this.pageH) * 100}%`;
    node.style.width = `${(place.w / this.pageW) * 100}%`;
    node.style.height = `${(place.h / this.pageH) * 100}%`;
    // Negated: the placement angle is anticlockwise in a y-up space, and CSS is
    // clockwise in a y-down one. Same negation `stampMatrix` makes.
    node.style.transform = place.rotate ? `rotate(${-place.rotate}deg)` : "";
  }

  /**
   * Drag to move, grip to resize. Pointer capture so a fast drag cannot escape.
   *
   * Takes anything with a `place`, so the signature marks, the covers and the
   * crop window are one implementation rather than three that drift apart.
   * `free` is the difference between them: a signature must keep its aspect or
   * the handwriting distorts, and a cover or a crop must not, because the
   * thing being covered is whatever shape it is.
   */
  private wire(
    node: HTMLElement,
    ref: { place: Placement },
    opts: { id: string | null; free: boolean },
  ): void {
    let from: { x: number; y: number; place: Placement; grip: boolean } | null = null;

    node.addEventListener("pointerdown", (e) => {
      const grip = (e.target as HTMLElement).classList.contains("fct-signv-grip");
      this.pick(opts.id);
      from = { x: e.clientX, y: e.clientY, place: { ...ref.place }, grip };
      node.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });

    node.addEventListener("pointermove", (e) => {
      if (!from) return;
      const box = this.pageBox.getBoundingClientRect();
      const perX = this.pageW / Math.max(1, box.width);
      const perY = this.pageH / Math.max(1, box.height);
      const dx = (e.clientX - from.x) * perX;
      const dy = (e.clientY - from.y) * perY;

      if (from.grip) {
        // Resize keeps the top-left corner either way, so the box grows the way
        // the handle is pulled instead of sliding away from it.
        const w = Math.max(16, from.place.w + dx);
        const h = opts.free
          ? Math.max(16, from.place.h + dy)
          : (w / from.place.w) * from.place.h;
        ref.place = { ...ref.place, w, h, y: from.place.y + from.place.h - h };
      } else {
        ref.place = { ...ref.place, x: from.place.x + dx, y: from.place.y - dy };
      }
      this.position(node, ref.place);
      this.syncFields();
    });

    const end = (e: PointerEvent): void => {
      if (!from) return;
      from = null;
      if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
    };
    node.addEventListener("pointerup", end);
    node.addEventListener("pointercancel", end);
  }

  private pick(id: string | null): void {
    if (this.picked === id) return;
    this.picked = id;
    for (const node of this.overlay.querySelectorAll(".fct-signv-mark")) {
      node.classList.toggle("is-picked", (node as HTMLElement).dataset["id"] === id);
    }
    this.buildSide();
  }

  private pickedMark(): Mark | null {
    return this.marks.find((m) => m.id === this.picked) ?? null;
  }

  /** Drop a signature onto the middle-right of the page, where one usually goes. */
  private placeSig(sig: Signature): void {
    const w = Math.min(DEFAULT_W, this.pageW * 0.45);
    const h = w / Math.max(0.2, sig.aspect);
    const mark: Mark = {
      id: newId(),
      kind: "sig",
      sigId: sig.id,
      colour: sig.colour,
      page: this.at,
      place: placement({ x: this.pageW - w - 56, y: 72, w, h, rotate: 0, opacity: 1 }),
    };
    this.marks.push(mark);
    this.store.touch(sig.id);
    this.picked = mark.id;
    this.paintMarks();
    this.buildSide();
    this.say(`${sig.name} placed — drag it where you want it`);
  }

  // ── Watermark ─────────────────────────────────────────────────────────────

  private watermarkArt(): { paths: string[]; box: [number, number, number, number] } | null {
    if (this.wm.sigId) {
      const sig = this.store.get(this.wm.sigId);
      return sig ? artPaths(sig.art) : null;
    }
    const preset = PRESETS.find((p) => p.id === this.wm.preset);
    return preset ? textPaths(preset.text) : null;
  }

  private watermarkPlace(): Placement {
    const art = this.watermarkArt();
    const aspect = art ? Math.max(0.05, art.box[2] / Math.max(art.box[3], 1e-6)) : 4;
    const w = Math.min(this.wm.width, this.pageW * 1.2);
    const h = w / aspect;
    return placement({
      x: (this.pageW - w) / 2,
      y: (this.pageH - h) / 2,
      w, h,
      rotate: this.wm.rotate,
      opacity: this.wm.opacity,
    });
  }

  private wmPages(): PageSelection {
    if (this.wm.scope === "all") return { kind: "all" };
    if (this.wm.scope === "this") return { kind: "list", pages: [this.at + 1] };
    const from = Math.max(1, Math.min(this.pageCount, this.wm.from));
    const to = Math.max(1, Math.min(this.pageCount, this.wm.to));
    return { kind: "range", from, to };
  }

  private wmCoversPage(index: number): boolean {
    const sel = this.wmPages();
    const one = index + 1;
    if (sel.kind === "all") return true;
    if (sel.kind === "list") return sel.pages.includes(one);
    return one >= Math.min(sel.from, sel.to) && one <= Math.max(sel.from, sel.to);
  }

  // ── Side panel ────────────────────────────────────────────────────────────

  private buildSide(): void {
    const kids: HTMLElement[] = [];

    kids.push(el("h3.fct-signv-h", undefined, "Signatures"));
    const sigs = this.store.list();
    if (sigs.length === 0) {
      kids.push(el("p.fct-signv-empty", undefined, "None yet. Draw one and it is kept for every document after this."));
    }
    const grid = el("div.fct-signv-sigs");
    for (const sig of sigs) {
      const card = el("button.fct-signv-sig", { type: "button", title: `Place ${sig.name}` });
      const art = sig.art.source === "image" ? null : artPaths(sig.art);
      if (art) card.innerHTML = artToSvg(art, sig.colour, 200);
      else if (sig.art.source === "image") {
        const img = new Image();
        img.src = sig.art.data;
        card.append(img);
      }
      card.append(el("span.fct-signv-signame", undefined, sig.name));
      card.addEventListener("click", () => this.placeSig(sig));
      grid.append(card);
    }
    kids.push(grid);

    kids.push(el("div.fct-signv-btns",
      undefined,
      this.textBtn("Draw signature", "signature", () => this.draw("signature")),
      this.textBtn("Draw initials", "signature", () => this.draw("initials")),
    ));

    // Selected mark
    const mark = this.pickedMark();
    if (mark && mark.kind === "redact") {
      kids.push(el("h3.fct-signv-h", undefined, "Selected cover"));
      kids.push(this.slider("Width", mark.place.w, 8, Math.round(this.pageW), 1, (v) => {
        mark.place = { ...mark.place, w: v };
        this.paintMarks();
      }, (v) => `${Math.round(v)}`));
      kids.push(this.slider("Height", mark.place.h, 8, Math.round(this.pageH), 1, (v) => {
        mark.place = { ...mark.place, h: v, y: mark.place.y + mark.place.h - v };
        this.paintMarks();
      }, (v) => `${Math.round(v)}`));
      const ink = el("input.fct-signv-colour", { type: "color", value: mark.colour }) as HTMLInputElement;
      ink.addEventListener("input", () => {
        mark.colour = ink.value;
        this.paintMarks();
      });
      kids.push(el("div.fct-signv-row", undefined, el("span.fct-signv-label", undefined, "Fill"), ink));
      kids.push(el("div.fct-signv-btns",
        undefined,
        this.textBtn("Another cover", "plus", () => this.addRedaction()),
        this.textBtn("Remove", "trash", () => {
          this.marks = this.marks.filter((m) => m.id !== mark.id);
          this.picked = null;
          this.paintMarks();
          this.buildSide();
        }),
      ));
    } else if (mark) {
      const sig = this.store.get(mark.sigId);
      kids.push(el("h3.fct-signv-h", undefined, sig ? `Placed: ${sig.name}` : "Placed"));
      kids.push(this.slider("Width", mark.place.w, 20, Math.round(this.pageW), 1, (v) => {
        const h = (v / mark.place.w) * mark.place.h;
        mark.place = { ...mark.place, w: v, h };
        this.paintMarks();
      }, (v) => `${Math.round(v)}`));
      kids.push(this.slider("Rotate", mark.place.rotate, -180, 180, 1, (v) => {
        mark.place = { ...mark.place, rotate: v };
        this.paintMarks();
      }, (v) => `${Math.round(v)}°`));
      kids.push(this.slider("Opacity", mark.place.opacity, 0.05, 1, 0.01, (v) => {
        mark.place = { ...mark.place, opacity: v };
        this.paintMarks();
      }, (v) => `${Math.round(v * 100)}%`));
      kids.push(el("div.fct-signv-btns",
        undefined,
        this.textBtn("Duplicate", "copy", () => {
          this.marks.push({ ...mark, id: newId(), place: { ...mark.place, y: mark.place.y - mark.place.h - 12 } });
          this.paintMarks();
        }),
        this.textBtn("Remove", "trash", () => {
          this.marks = this.marks.filter((m) => m.id !== mark.id);
          this.picked = null;
          this.paintMarks();
          this.buildSide();
        }),
      ));
    }

    // Redact & crop
    kids.push(el("h3.fct-signv-h", undefined, "Black out & crop"));
    const covers = this.marks.filter((m) => m.kind === "redact").length;
    kids.push(el("div.fct-signv-btns",
      undefined,
      this.textBtn(covers === 0 ? "Black out an area" : "Add another cover", "blur", () => this.addRedaction()),
    ));

    // The switch, and the sentence under it, only on a PDF. A picture has no
    // text under the paint and no searchability to lose, so there is no choice
    // to offer -- and offering it would be saying something untrue about a JPG.
    if (covers > 0 && this.isPdf) {
      const burn = el("button.fct-signv-toggle", {
        type: "button", "aria-pressed": this.burnIn ? "true" : "false",
      }, this.burnIn ? "Text underneath removed" : "Cover only — text stays");
      burn.addEventListener("click", () => {
        this.burnIn = !this.burnIn;
        this.buildSide();
      });
      kids.push(el("div.fct-signv-btns", undefined, burn));
      kids.push(el("p.fct-signv-empty", undefined, this.burnIn
        ? "The covered pages are saved as pictures, so the words underneath are gone for good. Those pages stop being searchable."
        : "A black rectangle drawn on top. The words underneath are still in the file and can still be copied out of it."));
    } else if (covers > 0) {
      kids.push(el("p.fct-signv-empty", undefined,
        "The fill is painted into the picture, so what is under it is gone from the saved copy."));
    }

    const cropBtn = el("button.fct-signv-toggle", {
      type: "button", "aria-pressed": this.crop.on ? "true" : "false",
    }, icon("crop"), this.crop.on ? "Cropping" : "Crop");
    cropBtn.addEventListener("click", () => this.toggleCrop(!this.crop.on));
    kids.push(el("div.fct-signv-btns", undefined, cropBtn));

    if (this.crop.on) {
      kids.push(this.slider("Crop width", this.crop.place.w, 24, Math.round(this.pageW), 1, (v) => {
        this.crop.place = { ...this.crop.place, w: v };
        this.paintMarks();
      }, (v) => `${Math.round(v)}`));
      kids.push(this.slider("Crop height", this.crop.place.h, 24, Math.round(this.pageH), 1, (v) => {
        this.crop.place = { ...this.crop.place, h: v, y: this.crop.place.y + this.crop.place.h - v };
        this.paintMarks();
      }, (v) => `${Math.round(v)}`));
      if (this.isPdf) {
        const row = el("div.fct-signv-chips");
        for (const [id, label] of [["all", "All pages"], ["this", "This page"]] as ReadonlyArray<[CropState["scope"], string]>) {
          const chip = el("button.fct-signv-chip", {
            type: "button", "aria-pressed": this.crop.scope === id ? "true" : "false",
          }, label);
          chip.addEventListener("click", () => {
            this.crop.scope = id;
            this.buildSide();
          });
          row.append(chip);
        }
        kids.push(row);
        kids.push(el("p.fct-signv-empty", undefined,
          "A crop hides the margins rather than deleting them, which is what every PDF reader means by a crop."));
      }
    }

    // Watermark
    kids.push(el("h3.fct-signv-h", undefined, "Watermark"));
    const onBtn = el("button.fct-signv-toggle", {
      type: "button", "aria-pressed": this.wm.on ? "true" : "false",
    }, icon("watermark"), this.wm.on ? "On" : "Off");
    onBtn.addEventListener("click", () => {
      this.wm.on = !this.wm.on;
      this.paintMarks();
      this.buildSide();
    });
    kids.push(el("div.fct-signv-btns", undefined, onBtn));

    if (this.wm.on) {
      const presets = el("div.fct-signv-chips");
      for (const p of PRESETS) {
        const chip = el("button.fct-signv-chip", {
          type: "button",
          "aria-pressed": this.wm.preset === p.id && !this.wm.sigId ? "true" : "false",
        }, p.label);
        chip.addEventListener("click", () => {
          this.wm = {
            ...this.wm, sigId: null, preset: p.id, colour: p.colour,
            opacity: p.opacity, rotate: p.rotate, tiled: p.tiled,
          };
          this.paintMarks();
          this.buildSide();
        });
        presets.append(chip);
      }
      for (const sig of this.store.list()) {
        if (sig.art.source === "image") continue;
        const chip = el("button.fct-signv-chip", {
          type: "button", "aria-pressed": this.wm.sigId === sig.id ? "true" : "false",
        }, sig.name);
        chip.addEventListener("click", () => {
          this.wm = { ...this.wm, sigId: sig.id, preset: null, colour: sig.colour };
          this.paintMarks();
          this.buildSide();
        });
        presets.append(chip);
      }
      kids.push(presets);

      const colour = el("input.fct-signv-colour", { type: "color", value: this.wm.colour }) as HTMLInputElement;
      colour.addEventListener("input", () => {
        this.wm.colour = colour.value;
        this.paintMarks();
      });
      kids.push(el("div.fct-signv-row", undefined, el("span.fct-signv-label", undefined, "Colour"), colour));

      kids.push(this.slider("Size", this.wm.width, 60, Math.round(this.pageW * 1.2), 1, (v) => {
        this.wm.width = v;
        this.paintMarks();
      }, (v) => `${Math.round(v)}`));
      kids.push(this.slider("Rotate", this.wm.rotate, -90, 90, 1, (v) => {
        this.wm.rotate = v;
        this.paintMarks();
      }, (v) => `${Math.round(v)}°`));
      kids.push(this.slider("Opacity", this.wm.opacity, 0.02, 1, 0.01, (v) => {
        this.wm.opacity = v;
        this.paintMarks();
      }, (v) => `${Math.round(v * 100)}%`));

      const tileBtn = el("button.fct-signv-toggle", {
        type: "button", "aria-pressed": this.wm.tiled ? "true" : "false",
      }, "Tile across the page");
      tileBtn.addEventListener("click", () => {
        this.wm.tiled = !this.wm.tiled;
        this.paintMarks();
        this.buildSide();
      });
      kids.push(el("div.fct-signv-btns", undefined, tileBtn));

      if (this.wm.tiled) {
        kids.push(this.slider("Spacing", this.wm.gap, 0, 400, 1, (v) => {
          this.wm.gap = v;
          this.paintMarks();
        }, (v) => `${Math.round(v)}`));
      }

      if (this.isPdf) {
        const scopes: ReadonlyArray<[WmState["scope"], string]> =
          [["all", "All pages"], ["this", "This page"], ["range", "Range"]];
        const row = el("div.fct-signv-chips");
        for (const [id, label] of scopes) {
          const chip = el("button.fct-signv-chip", {
            type: "button", "aria-pressed": this.wm.scope === id ? "true" : "false",
          }, label);
          chip.addEventListener("click", () => {
            this.wm.scope = id;
            this.paintMarks();
            this.buildSide();
          });
          row.append(chip);
        }
        kids.push(row);
        if (this.wm.scope === "range") {
          const from = el("input.fct-signv-num", { type: "number", min: 1, max: this.pageCount, value: this.wm.from }) as HTMLInputElement;
          const to = el("input.fct-signv-num", { type: "number", min: 1, max: this.pageCount, value: this.wm.to }) as HTMLInputElement;
          const sync = (): void => {
            this.wm.from = Number(from.value) || 1;
            this.wm.to = Number(to.value) || 1;
            this.paintMarks();
          };
          from.addEventListener("input", sync);
          to.addEventListener("input", sync);
          kids.push(el("div.fct-signv-row", undefined,
            el("span.fct-signv-label", undefined, "Pages"), from, el("span.fct-signv-label", undefined, "to"), to));
        }
      }
    }

    fill(this.side, ...kids);
  }

  /** Re-read the numbers next to a slider after a drag moved the mark. */
  private syncFields(): void {
    const mark = this.pickedMark();
    if (!mark) return;
    const w = this.side.querySelector<HTMLInputElement>('input[data-key="Width"]');
    if (w) w.value = String(mark.place.w);
  }

  private draw(kind: SigKind): void {
    this.pad?.dispose();
    this.pad = new SignPad(this.store, {
      kind,
      onSave: (sig) => {
        this.buildSide();
        this.placeSig(sig);
      },
    });
    this.pad.open();
  }

  // ── Saving ────────────────────────────────────────────────────────────────

  private async save(): Promise<void> {
    if (this.busy) return;
    const name = this.nameIn.value.trim();
    if (!name) {
      this.say("give the copy a name first", true);
      return;
    }
    this.busy = true;
    this.say("writing…");
    try {
      const bytes = this.isPdf ? await this.signedPdf() : await this.signedImage();
      if (bytes.length === 0) throw new Error("nothing was produced");
      const dir = this.path.slice(0, Math.max(this.path.lastIndexOf("/"), this.path.lastIndexOf("\\")));
      const out = await this.host.writeFile(`${dir}/${name}`, bytes, false);
      this.host.refresh();
      this.say(`saved ${out.split(/[\\/]/).pop() ?? out}`);
    } catch (err) {
      this.say(err instanceof Error ? err.message : String(err), true);
    } finally {
      this.busy = false;
    }
  }

  private async signedPdf(): Promise<Uint8Array> {
    const src = await this.host.readAll(this.path, MAX_BYTES);
    const stamps: StampRequest[] = [];
    for (const mark of this.marks) {
      const sig = this.store.get(mark.sigId);
      if (!sig) continue;
      stamps.push({ art: sig.art, colour: sig.colour, place: mark.place, page: mark.page });
    }

    const marks: Watermark[] = [];
    if (this.wm.on) {
      const art = this.watermarkArt();
      if (art) {
        marks.push({
          art: { source: "svg", paths: art.paths, viewBox: art.box },
          colour: this.wm.colour,
          place: this.watermarkPlace(),
          pages: this.wmPages(),
          ...(this.wm.tiled ? { tile: { gapX: this.wm.gap, gapY: this.wm.gap, angle: 45 } } : {}),
        });
      }
    }

    const covers = this.marks.filter((m) => m.kind === "redact");
    if (stamps.length === 0 && marks.length === 0 && covers.length === 0 && !this.crop.on) {
      throw new Error("nothing placed yet");
    }

    const extras: PdfExtras = {};
    if (covers.length > 0) {
      if (this.burnIn) {
        // The covers go onto the picture, not onto the page: that is what makes
        // them a redaction rather than a sticker over the words.
        const pages = [...new Set(covers.map((c) => c.page))].sort((a, b) => a - b);
        const rasters: PageRaster[] = [];
        for (const page of pages) {
          this.say(`flattening page ${page + 1}…`);
          const data = await this.rasterPage(page, covers.filter((c) => c.page === page));
          if (data) rasters.push({ page, data });
        }
        if (rasters.length > 0) extras.flatten = rasters;
        // Anything that would not rasterise still gets a drawn cover, so a
        // failure degrades to the weaker guarantee instead of to none.
        const done = new Set(rasters.map((r) => r.page));
        const left = covers.filter((c) => !done.has(c.page));
        if (left.length > 0) extras.redactions = left.map(toRedaction);
      } else {
        extras.redactions = covers.map(toRedaction);
      }
    }
    if (this.crop.on) {
      extras.crop = {
        x: this.crop.place.x, y: this.crop.place.y,
        w: this.crop.place.w, h: this.crop.place.h,
        pages: this.crop.scope === "all"
          ? { kind: "all" }
          : { kind: "list", pages: [this.at + 1] },
      } satisfies CropBox;
    }

    return stampPdf(src, stamps, marks, extras);
  }

  /**
   * One page, rendered to a picture with its covers already on it.
   *
   * At 2× the page's own points — the same factor the preview uses, which on a
   * letter page is about 144 dpi: legible, printable, and not so heavy that a
   * ten-page redaction blows the phone's memory budget.
   */
  private async rasterPage(index: number, covers: readonly Mark[]): Promise<string | null> {
    const doc = this.pdfDoc;
    if (!doc) return null;
    try {
      const page = await doc.getPage(index + 1);
      const unit = page.getViewport({ scale: 1 });
      const view = page.getViewport({ scale: 2 });
      const out = document.createElement("canvas");
      out.width = Math.round(view.width);
      out.height = Math.round(view.height);
      const ctx = out.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, out.width, out.height);
      await page.render({ canvas: out, canvasContext: ctx, viewport: view }).promise;

      const sx = out.width / unit.width;
      const sy = out.height / unit.height;
      for (const c of covers) {
        ctx.globalAlpha = c.place.opacity;
        ctx.fillStyle = c.colour;
        // Points are y-up from the bottom; a canvas is y-down from the top.
        ctx.fillRect(
          c.place.x * sx,
          (unit.height - c.place.y - c.place.h) * sy,
          c.place.w * sx,
          c.place.h * sy,
        );
      }
      ctx.globalAlpha = 1;
      return out.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  /**
   * A signed picture, composited at full resolution.
   *
   * Not the preview canvas: that one is sized for the screen, and saving it
   * would quietly downscale the user's scan. A fresh canvas at the natural size
   * costs one allocation and keeps the file the size it arrived.
   */
  private async signedImage(): Promise<Uint8Array> {
    const { drawStampOnCanvas, drawImageStampOnCanvas } = await import("@core/sign/stamp");
    const url = await this.host.fileUrl(this.path);
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const node = new Image();
      node.addEventListener("load", () => resolve(node));
      node.addEventListener("error", () => reject(new Error("could not re-read the picture")));
      node.src = url;
    });

    const out = document.createElement("canvas");
    out.width = img.naturalWidth;
    out.height = img.naturalHeight;
    const ctx = out.getContext("2d");
    if (!ctx) throw new Error("no 2D canvas in this build");
    ctx.drawImage(img, 0, 0);

    if (this.wm.on) {
      const art = this.watermarkArt();
      if (art && this.wmCoversPage(0)) {
        const place = this.watermarkPlace();
        const spots = this.wm.tiled
          ? tilePositions(this.pageW, this.pageH, place, { gapX: this.wm.gap, gapY: this.wm.gap, angle: 45 })
          : [{ x: place.x, y: place.y }];
        for (const spot of spots) {
          drawStampOnCanvas(ctx, art, this.wm.colour, { ...place, x: spot.x, y: spot.y }, this.pageH);
        }
      }
    }

    for (const mark of this.marks) {
      const sig = this.store.get(mark.sigId);
      if (!sig || mark.page !== 0) continue;
      if (sig.art.source === "image") {
        const raster = sig.art;
        const node = await new Promise<HTMLImageElement>((resolve, reject) => {
          const im = new Image();
          im.addEventListener("load", () => resolve(im));
          im.addEventListener("error", () => reject(new Error("a saved signature would not load")));
          im.src = raster.data;
        });
        drawImageStampOnCanvas(ctx, node, { w: raster.w, h: raster.h }, mark.place, this.pageH);
      } else {
        const art = artPaths(sig.art);
        if (art) drawStampOnCanvas(ctx, art, sig.colour, mark.place, this.pageH);
      }
    }

    // Covers over the picture and under the signatures, same order as the PDF.
    // On a picture there is nothing underneath a filled rectangle to recover,
    // so this is a true redaction with no flattening step needed.
    for (const cover of this.marks) {
      if (cover.kind !== "redact" || cover.page !== 0) continue;
      ctx.globalAlpha = cover.place.opacity;
      ctx.fillStyle = cover.colour;
      ctx.fillRect(
        cover.place.x,
        this.pageH - cover.place.y - cover.place.h,
        cover.place.w,
        cover.place.h,
      );
      ctx.globalAlpha = 1;
    }

    // A picture is actually cut, unlike a PDF page: there is no crop box in a
    // PNG, and a viewer that ignored one would show what was meant to be gone.
    let final: HTMLCanvasElement = out;
    if (this.crop.on) {
      const x = Math.max(0, Math.round(this.crop.place.x));
      const y = Math.max(0, Math.round(this.pageH - this.crop.place.y - this.crop.place.h));
      const w = Math.max(1, Math.min(Math.round(this.crop.place.w), out.width - x));
      const h = Math.max(1, Math.min(Math.round(this.crop.place.h), out.height - y));
      const cut = document.createElement("canvas");
      cut.width = w;
      cut.height = h;
      cut.getContext("2d")?.drawImage(out, x, y, w, h, 0, 0, w, h);
      final = cut;
    }

    const blob = await new Promise<Blob | null>((resolve) => final.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("the picture would not encode");
    return new Uint8Array(await blob.arrayBuffer());
  }

  // ── Small parts ───────────────────────────────────────────────────────────

  private iconBtn(name: string, title: string, run: () => void): HTMLElement {
    const btn = el("button.fct-signv-icon", { type: "button", title }, icon(name));
    btn.addEventListener("click", run);
    return btn;
  }

  private textBtn(label: string, name: string, run: () => void): HTMLElement {
    const btn = el("button.fct-signv-btn", { type: "button" }, icon(name), label);
    btn.addEventListener("click", run);
    return btn;
  }

  private slider(
    label: string, value: number, min: number, max: number, step: number,
    run: (v: number) => void, show: (v: number) => string,
  ): HTMLElement {
    const input = el("input.fct-signv-range", {
      type: "range", min, max, step, value, "data-key": label,
    }) as HTMLInputElement;
    const out = el("span.fct-signv-val", undefined, show(value));
    input.addEventListener("input", () => {
      const v = Number(input.value);
      out.textContent = show(v);
      run(v);
    });
    return el("div.fct-signv-row", undefined, el("span.fct-signv-label", undefined, label), input, out);
  }

  private say(text: string, bad = false): void {
    this.status.textContent = text;
    this.status.classList.toggle("is-bad", bad && text.length > 0);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      // A selection is the innermost thing Escape can cancel, so it goes first
      // — closing the whole panel on the key that was meant to drop a handle
      // loses every placement on the page.
      if (this.picked) this.pick(null);
      else this.close();
      e.stopPropagation();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this.picked) {
      this.marks = this.marks.filter((m) => m.id !== this.picked);
      this.picked = null;
      this.paintMarks();
      this.buildSide();
      e.preventDefault();
      return;
    }
    if (this.isPdf && (e.key === "PageDown" || e.key === "ArrowRight")) void this.turn(1);
    if (this.isPdf && (e.key === "PageUp" || e.key === "ArrowLeft")) void this.turn(-1);
  }
}

/** Exported for the phone build, which shares one store with the desktop shell. */
export function sharedStore(): SignatureStore {
  return new SignatureStore(browserSigBackend());
}

export { dataUrlBytes };
