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
import { opaque } from "@core/edit/blur";
import { flattenPdf } from "@core/sign/flatten";
import { loadPicture } from "@core/canvas/picture";
import { browserSigBackend, SignatureStore, type ImageArt, type SigKind, type Signature } from "@core/sign/store";
import { textPaths } from "@core/sign/text";
import { defaultTypeSpec, typeArt, TYPE_FACES, type TypeSpec } from "@core/sign/type";
import { suffixed } from "@core/save";
import { el, fill } from "./phone/dom";
import { icon } from "./phone/icons";
import { SaveBar } from "./save-bar";
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
 * One type for all three because everything except what gets painted is shared
 * -- the drag, the resize, the selection, the per-page filter and the export
 * ordering are the same job whether the box holds a signature, types today's
 * date or hides a bank balance.
 *
 * `colour` used to be documented here as "unused for a signature", which was
 * the bug rather than the design: a signature saved in black could not be
 * placed in blue on the one form that demands blue ink without editing the
 * saved signature itself and breaking it everywhere else. It is now the
 * placement's own colour, seeded from the signature's, and the preview and
 * both exporters read it from here.
 */
type MarkKind = "sig" | "redact" | "text";

interface Mark {
  id: string;
  kind: MarkKind;
  /** Empty for a cover and for typed text. */
  sigId: string;
  colour: string;
  page: number;
  place: Placement;
  /** `kind: "text"` only — what was typed and how it is set. */
  type?: TypeSpec;
  /**
   * `kind: "text"` only — the rendered pixels, cached so that dragging does
   * not re-run the type setter sixty times a second. Re-made whenever the
   * text, face or colour changes; never on a move or a resize, because the
   * image is scaled into the placement rather than rendered at it.
   */
  art?: ImageArt;
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
  // Page turners. A picture has exactly one page, and a control that is always
  // there and never does anything is worse than no control: on a phone the
  // common case IS a picture, so these two chevrons sat in the bar looking
  // live and answering every tap with nothing. They are hidden unless the file
  // actually has pages, and greyed at the first and last one.
  private readonly prevBtn = this.iconBtn("chevron-left", "Previous page", () => void this.turn(-1));
  private readonly nextBtn = this.iconBtn("chevron-right", "Next page", () => void this.turn(1));
  private readonly zoomNote = el("span.fct-signv-note");
  private readonly stage = el("div.fct-signv-stage");
  private readonly pageBox = el("div.fct-signv-page");
  private readonly canvas = document.createElement("canvas");
  private readonly overlay = el("div.fct-signv-overlay");
  private readonly side = el("aside.fct-signv-side");
  private readonly saveBar: SaveBar;

  private readonly store: SignatureStore;
  private pad: SignPad | null = null;
  private unsub: (() => void) | null = null;

  /**
   * The last signature deleted from the library, kept for one Undo.
   *
   * Deleting a signature you spent a minute drawing, from a grid of thumbnails
   * where two of them look alike, is the most plausible mis-click on this
   * screen. A confirmation would stop it and would also stand between the user
   * and the perfectly ordinary act of tidying up; an undo costs a variable.
   */
  private undoSig: Signature | null = null;

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
  /**
   * Save the whole document as pictures of itself, so nothing on it can be
   * taken off.
   *
   * Off by default, unlike `burnIn`, and the difference is who is being
   * protected. A cover is a promise to the person in the document that a
   * particular thing is gone, so it defaults to being kept. This is a promise
   * to the person *sending* the document that their signature and watermark
   * cannot be lifted off it -- worth a great deal on an agreement and worth
   * nothing on a form somebody still has to fill in, and it costs the whole
   * document its text: no search, no copying, no screen reader, and a file
   * many times the size. A cost that large is not one to impose on a save
   * nobody asked to be locked.
   */
  private lockPage = false;
  private busy = false;
  private pdfTask: import("pdfjs-dist").PDFDocumentLoadingTask | null = null;
  private pdfDoc: import("pdfjs-dist").PDFDocumentProxy | null = null;

  /** The Watermark heading, so `open(_, "mark")` can scroll to it. */
  private wmHead: HTMLElement | null = null;

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
      this.prevBtn,
      this.pageNote,
      this.nextBtn,
      el("div.fct-signv-gap"),
      this.iconBtn("minus", "Zoom out", () => this.stepZoom(-1)),
      this.zoomNote,
      this.iconBtn("plus", "Zoom in", () => this.stepZoom(1)),
      el("div.fct-signv-gap"),
      this.iconBtn("x", "Close  (Esc)", () => this.close()),
    );

    // Both endings, on every document. Which one is offered used to be decided
    // by whichever screen you happened to be on; see `@ui/save-bar`.
    this.saveBar = new SaveBar({
      host,
      path: () => this.path,
      bytes: () => this.signedBytes(),
      copyLabel: "Save a signed copy",
      done: () => this.host.refresh(),
    });

    this.root.append(
      head,
      el("div.fct-signv-body", undefined, this.stage, this.side),
      this.saveBar.root,
    );
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
  async open(path: string, mode: "sign" | "redact" | "crop" | "mark" = "sign"): Promise<void> {
    this.path = path;
    this.isPdf = /\.pdf$/i.test(path);
    this.at = 0;
    this.marks = [];
    this.picked = null;
    this.crop = { on: false, place: placement({ x: 0, y: 0, w: 100, h: 100 }), scope: "all" };
    this.burnIn = true;
    this.lockPage = false;
    this.root.hidden = false;
    this.root.focus();

    const name = path.split(/[\\/]/).pop() ?? path;
    this.titleEl.textContent = name;
    // A picture always comes out as a PNG: the page is composited on a canvas,
    // and re-encoding somebody's JPEG scan a second time would quietly cost
    // them detail. That means the name changes extension, and that in turn
    // means this file cannot be written back over itself.
    const png = !this.isPdf;
    this.saveBar.setName(suffixed(name, "-signed", png ? "png" : undefined));
    this.saveBar.allowOverwrite(
      this.isPdf || /\.png$/i.test(path),
      png ? "A signed picture is saved as a PNG, so it cannot replace the original file." : undefined,
    );
    this.undoSig = null;
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
    // "Watermark" used to land on the signature list, which is exactly the
    // failure the redact and crop doors were added to prevent. Turn the
    // watermark on and put its controls in front of the eye.
    if (mode === "mark") this.wm.on = true;
    this.buildSide();
    if (mode === "mark") {
      this.wmHead?.scrollIntoView({ block: "start" });
      this.paintMarks();
    }
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
    const paged = this.isPdf && this.pageCount > 1;
    this.pageNote.textContent = this.isPdf ? `${this.at + 1} / ${this.pageCount}` : "";
    this.prevBtn.hidden = !paged;
    this.nextBtn.hidden = !paged;
    (this.prevBtn as HTMLButtonElement).disabled = this.at <= 0;
    (this.nextBtn as HTMLButtonElement).disabled = this.at >= this.pageCount - 1;
    this.zoomNote.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  private async drawImage(url: string): Promise<void> {
    const img = await loadPicture(url, "not a picture this build can open");
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
        node.style.background = mark.colour;
        this.dressMark(node, mark, true);
        kids.push(node);
        continue;
      }

      if (mark.kind === "text") {
        const node = el("div.fct-signv-mark.is-text", { "data-id": mark.id });
        const art = mark.art ?? this.renderType(mark);
        if (art) {
          const img = new Image();
          img.src = art.data;
          img.className = "fct-signv-art";
          node.append(img);
        }
        // Free-form: typed text is set at one size and stretched into the box,
        // so letting the box change shape would squash the letters. Same reason
        // a signature is locked, so it is locked the same way.
        this.dressMark(node, mark, false);
        kids.push(node);
        continue;
      }

      const sig = this.store.get(mark.sigId);
      if (!sig) continue;
      const node = el("div.fct-signv-mark", { "data-id": mark.id });

      if (sig.art.source === "image") {
        const img = new Image();
        img.src = sig.art.data;
        img.className = "fct-signv-art";
        node.append(img);
      } else {
        const art = artPaths(sig.art);
        // `mark.colour`, not `sig.colour`: the ink is a property of this
        // placement, so the same saved signature can be black here and blue on
        // the form that insists on blue.
        if (art) node.innerHTML = artToSvg(art, mark.colour, 400);
      }
      this.dressMark(node, mark, false);
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

  /**
   * The parts every mark on the page gets: selection, opacity, a resize grip,
   * a delete button, and the pointer wiring.
   *
   * It is one function because the complaint that started this was "I can't
   * delete it and if I do initials I can delete it" — three render branches
   * that each decided for themselves what handles to put on a mark is exactly
   * how one kind ends up deletable and another does not. Now there is one
   * place for that decision and it cannot disagree with itself.
   */
  private dressMark(node: HTMLElement, mark: Mark, free: boolean): void {
    if (mark.id === this.picked) node.classList.add("is-picked");
    node.style.opacity = String(mark.place.opacity);

    // Visible only on the selected mark (CSS), so the page is not covered in
    // little crosses — but always in the DOM, so selecting anything at all
    // puts a delete within one click of the thing being deleted rather than
    // across the panel in a list.
    const kill = el("button.fct-signv-kill", { type: "button", title: "Remove this (Delete)" }, icon("x"));
    kill.addEventListener("pointerdown", (e) => e.stopPropagation());
    kill.addEventListener("click", (e) => {
      e.stopPropagation();
      this.removeMark(mark.id);
    });
    node.append(el("div.fct-signv-grip", { title: "Drag to resize" }), kill);

    this.position(node, mark.place);
    this.wire(node, mark, { id: mark.id, free });
  }

  /** Take a mark off the page. The one path all four delete affordances use. */
  private removeMark(id: string): void {
    const before = this.marks.length;
    this.marks = this.marks.filter((m) => m.id !== id);
    if (this.marks.length === before) return;
    if (this.picked === id) this.picked = null;
    this.paintMarks();
    this.buildSide();
    this.say("removed");
  }

  /** Re-run the type setter for a text mark and cache the pixels on it. */
  private renderType(mark: Mark): ImageArt | null {
    if (!mark.type) return null;
    const art = typeArt(mark.type);
    // Deleted rather than set to `undefined`: `exactOptionalPropertyTypes` is
    // on, and an explicit `undefined` is not the same as an absent key.
    if (art) mark.art = art;
    else delete mark.art;
    return art;
  }

  /**
   * Drop a typed mark on the page, pre-filled with today's date.
   *
   * Pre-filled rather than empty because the overwhelmingly common case is a
   * date beside a signature, and an empty box that has to be found, clicked
   * and typed into is three steps to reach the thing that was wanted anyway.
   * The text is selected in the side panel, so replacing it is one action.
   */
  private addText(): void {
    const spec = defaultTypeSpec();
    const art = typeArt(spec);
    const aspect = art && art.h > 0 ? art.w / art.h : 4;
    const w = Math.min(this.pageW * 0.4, Math.max(90, this.pageW * 0.22));
    const mark: Mark = {
      id: newId(),
      kind: "text",
      sigId: "",
      colour: spec.colour,
      page: this.at,
      place: placement({ x: this.pageW - w - 56, y: 150, w, h: w / aspect, opacity: 1 }),
      type: spec,
      ...(art ? { art } : {}),
    };
    this.marks.push(mark);
    this.picked = mark.id;
    this.paintMarks();
    this.buildSide();
    this.say("type what you want, then drag it into place");
    this.side.querySelector<HTMLInputElement>(".fct-signv-text")?.select();
  }

  /**
   * Re-render a text mark after an edit, keeping its width and its left edge.
   *
   * The height follows the new aspect rather than being kept, because a longer
   * word in a fixed box is a squashed word. Keeping the left edge and the
   * baseline-ish top means typing does not walk the mark across the page.
   */
  private retype(mark: Mark, patch: Partial<TypeSpec>): void {
    mark.type = { ...(mark.type ?? defaultTypeSpec()), ...patch };
    if (patch.colour !== undefined) mark.colour = patch.colour;
    const art = this.renderType(mark);
    if (art && art.h > 0) {
      const h = mark.place.w / (art.w / art.h);
      mark.place = { ...mark.place, h, y: mark.place.y + mark.place.h - h };
    }
    this.paintMarks();
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
      grid.append(this.sigCard(sig));
    }
    kids.push(grid);

    // The undo sits under the grid rather than in a toast, because a toast
    // that has already faded is the same as no undo at all and this one has to
    // survive the user looking away to check what they just lost.
    if (this.undoSig) {
      const gone = this.undoSig;
      kids.push(el("div.fct-signv-btns", undefined,
        this.textBtn(`Undo — put “${gone.name}” back`, "undo", () => this.restoreSig(gone))));
    }

    kids.push(el("div.fct-signv-btns",
      undefined,
      this.textBtn("Draw signature", "signature", () => this.draw("signature")),
      this.textBtn("Draw initials", "signature", () => this.draw("initials")),
    ));
    kids.push(el("div.fct-signv-btns",
      undefined,
      this.textBtn("Type text or a date", "type", () => this.addText()),
    ));

    // Selected mark — one editor, three kinds, in the same order every time.
    const mark = this.pickedMark();
    if (mark) kids.push(...this.markEditor(mark));

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

    // Only on a PDF, and for the same reason the burn-in switch is: a picture
    // has no removable layer to lock down. A signature on a JPG is already
    // pixels the moment it is saved.
    if (this.isPdf) {
      const lock = el("button.fct-signv-toggle", {
        type: "button", "aria-pressed": this.lockPage ? "true" : "false",
      }, icon("lock"), this.lockPage ? "Locked — nothing removable" : "Lock the page");
      lock.addEventListener("click", () => {
        this.lockPage = !this.lockPage;
        this.buildSide();
      });
      kids.push(el("div.fct-signv-btns", undefined, lock));
      kids.push(el("p.fct-signv-empty", undefined, this.lockPage
        ? "Every page is saved as a picture of itself, so the signature and the watermark are part of the page and cannot be peeled off. The whole document stops being searchable and the file gets a lot bigger."
        : "Normally a signature and a watermark sit on top of the page, and anyone with a PDF editor can take them off again. Lock the page to make them permanent."));
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
    this.wmHead = el("h3.fct-signv-h", undefined, "Watermark");
    kids.push(this.wmHead);
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

  /**
   * One saved signature in the library: place it, rename it, delete it.
   *
   * It used to be a bare button that could only be placed, which is why the
   * library could grow to its 24-entry cap and then silently start dropping
   * the least-used one — the only way to remove a signature was to make
   * twenty-four better ones. Rename matters for the same reason delete does:
   * "Signature 3" and "Signature 4" are indistinguishable in a thumbnail grid.
   */
  private sigCard(sig: Signature): HTMLElement {
    const card = el("div.fct-signv-sig", { "data-sig": sig.id });

    const place = el("button.fct-signv-sigart", { type: "button", title: `Place ${sig.name}` });
    const art = sig.art.source === "image" ? null : artPaths(sig.art);
    if (art) place.innerHTML = artToSvg(art, sig.colour, 200);
    else if (sig.art.source === "image") {
      const img = new Image();
      img.src = sig.art.data;
      place.append(img);
    }
    place.append(el("span.fct-signv-signame", undefined, sig.name));
    place.addEventListener("click", () => this.placeSig(sig));

    const tools = el("div.fct-signv-sigtools");
    const rename = el("button.fct-signv-sigtool", { type: "button", title: "Rename" }, icon("edit"));
    rename.addEventListener("click", () => this.renameSig(sig));
    const drop = el("button.fct-signv-sigtool", { type: "button", title: "Delete this signature" }, icon("trash"));
    drop.addEventListener("click", () => this.deleteSig(sig));
    tools.append(rename, drop);

    card.append(place, tools);
    return card;
  }

  /**
   * Rename in place — the card becomes a text field until Enter or blur.
   *
   * In place rather than a prompt because `window.prompt` is a modal browser
   * dialog, and this app deliberately does not raise those: on the Android
   * build it is a system alert over the webview, and it is exactly the kind of
   * thing that leaves the page unresponsive if it is dismissed oddly.
   */
  private renameSig(sig: Signature): void {
    const card = this.side.querySelector<HTMLElement>(`.fct-signv-sig[data-sig="${sig.id}"]`);
    const field = el("input.fct-signv-rename", { value: sig.name }) as HTMLInputElement;
    const commit = (): void => {
      const name = field.value.trim();
      if (name.length > 0 && name !== sig.name) this.store.update(sig.id, { name });
      this.buildSide();
    };
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") this.buildSide();
      e.stopPropagation();
    });
    field.addEventListener("blur", commit);
    if (card) {
      fill(card, field);
      field.focus();
      field.select();
    }
  }

  /**
   * Delete a saved signature, keeping it for one Undo.
   *
   * Marks already on the page that used it are left alone: they hold the
   * signature's id, `paintMarks` skips a mark whose signature has gone, and
   * silently deleting somebody's placed signature because they tidied the
   * library would be a far worse surprise than a blank spot. The undo puts
   * both back together — see {@link restoreSig}.
   */
  private deleteSig(sig: Signature): void {
    this.undoSig = sig;
    this.store.remove(sig.id);
    this.paintMarks();
    this.buildSide();
    this.say(`deleted “${sig.name}” — Undo is under the list`);
  }

  /**
   * Put a deleted signature back, and re-point anything that was using it.
   *
   * `store.add` mints a new id (it has to: an import could collide with a live
   * one), so every mark still carrying the old id would render as nothing.
   * Re-pointing them is two lines and is the difference between an undo and an
   * apology.
   */
  private restoreSig(gone: Signature): void {
    const back = this.store.add({
      name: gone.name, kind: gone.kind, art: gone.art, colour: gone.colour, aspect: gone.aspect,
    });
    for (const m of this.marks) {
      if (m.kind === "sig" && m.sigId === gone.id) m.sigId = back.id;
    }
    this.undoSig = null;
    this.paintMarks();
    this.buildSide();
    this.say(`“${back.name}” is back`);
  }

  /**
   * The controls for whatever is selected — the same controls in the same
   * order, whether it is a signature, a typed date or a cover.
   *
   * Before this there were two branches with different capabilities: a cover
   * could be recoloured and could not be rotated, a signature could be rotated
   * and could not be recoloured, and only one of them could be duplicated. The
   * shape of the panel told you nothing about what a mark could do, so every
   * kind had to be learned separately.
   */
  private markEditor(mark: Mark): HTMLElement[] {
    const kids: HTMLElement[] = [];
    const sig = mark.kind === "sig" ? this.store.get(mark.sigId) : undefined;
    const title = mark.kind === "redact"
      ? "Selected cover"
      : mark.kind === "text"
        ? "Selected text"
        : sig ? `Placed: ${sig.name}` : "Placed signature";
    kids.push(el("h3.fct-signv-h", undefined, title));

    if (mark.kind === "text") {
      const spec = mark.type ?? defaultTypeSpec();
      const field = el("input.fct-signv-text", { value: spec.text, placeholder: "type here" }) as HTMLInputElement;
      field.addEventListener("input", () => this.retype(mark, { text: field.value }));
      // Keys are swallowed so Delete inside the field edits the text instead of
      // deleting the mark being edited, which is the sort of thing that only
      // happens once before the tool is abandoned.
      field.addEventListener("keydown", (e) => e.stopPropagation());
      kids.push(el("div.fct-signv-row", undefined, el("span.fct-signv-label", undefined, "Text"), field));

      const faces = el("div.fct-signv-chips");
      for (const f of TYPE_FACES) {
        const chip = el("button.fct-signv-chip", {
          type: "button", "aria-pressed": spec.face === f.id ? "true" : "false",
        }, f.label);
        chip.style.fontFamily = f.stack;
        chip.addEventListener("click", () => {
          this.retype(mark, { face: f.id });
          this.buildSide();
        });
        faces.append(chip);
      }
      kids.push(faces);

      const style = el("div.fct-signv-chips");
      for (const [key, label] of [["bold", "Bold"], ["italic", "Italic"]] as ReadonlyArray<["bold" | "italic", string]>) {
        const chip = el("button.fct-signv-chip", {
          type: "button", "aria-pressed": spec[key] ? "true" : "false",
        }, label);
        chip.addEventListener("click", () => {
          this.retype(mark, { [key]: !spec[key] } as Partial<TypeSpec>);
          this.buildSide();
        });
        style.append(chip);
      }
      kids.push(style);
    }

    // Colour. Offered for every kind that has one to offer: the cover's fill,
    // the typed ink, and — the thing that was missing — the ink of this
    // particular placement of a signature. A photographed signature is the one
    // exception, because its colours are in its pixels.
    const recolourable = mark.kind !== "sig" || (sig !== undefined && sig.art.source !== "image");
    if (recolourable) {
      const ink = el("input.fct-signv-colour", { type: "color", value: mark.colour }) as HTMLInputElement;
      ink.addEventListener("input", () => {
        if (mark.kind === "text") this.retype(mark, { colour: ink.value });
        else {
          mark.colour = ink.value;
          this.paintMarks();
        }
      });
      kids.push(el("div.fct-signv-row", undefined,
        el("span.fct-signv-label", undefined, mark.kind === "redact" ? "Fill" : "Ink"), ink));
    }

    const free = mark.kind === "redact";
    kids.push(this.slider("Size", mark.place.w, 8, Math.round(this.pageW), 1, (v) => {
      // A cover is whatever shape the thing it hides is; a signature and a
      // typed word keep their proportions or the letters distort.
      const h = free ? mark.place.h : (v / mark.place.w) * mark.place.h;
      mark.place = { ...mark.place, w: v, h, y: mark.place.y + mark.place.h - h };
      this.paintMarks();
    }, (v) => `${Math.round(v)}`));
    if (free) {
      kids.push(this.slider("Height", mark.place.h, 8, Math.round(this.pageH), 1, (v) => {
        mark.place = { ...mark.place, h: v, y: mark.place.y + mark.place.h - v };
        this.paintMarks();
      }, (v) => `${Math.round(v)}`));
    }
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
        const copy: Mark = {
          ...mark,
          id: newId(),
          place: { ...mark.place, y: mark.place.y - mark.place.h - 12 },
          ...(mark.type ? { type: { ...mark.type } } : {}),
        };
        this.marks.push(copy);
        this.picked = copy.id;
        this.paintMarks();
        this.buildSide();
      }),
      this.textBtn("Remove", "trash", () => this.removeMark(mark.id)),
    ));
    return kids;
  }

  /** Re-read the numbers next to a slider after a drag moved the mark. */
  private syncFields(): void {
    const mark = this.pickedMark();
    if (!mark) return;
    const w = this.side.querySelector<HTMLInputElement>('input[data-key="Size"]');
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

  /**
   * The finished document, whichever kind it is.
   *
   * The save bar owns *where* it goes — copy beside the original or in place of
   * it, with a backup either way — and this owns only what the bytes are. That
   * split is why "Save a copy" and "Overwrite original" cannot end up producing
   * different documents.
   */
  private signedBytes(): Promise<Uint8Array> {
    if (this.busy) return Promise.reject(new Error("already saving"));
    this.busy = true;
    const work = this.isPdf ? this.signedPdf() : this.signedImage();
    return work.finally(() => {
      this.busy = false;
    });
  }

  private async signedPdf(): Promise<Uint8Array> {
    const src = await this.host.readAll(this.path, MAX_BYTES);
    const stamps: StampRequest[] = [];
    for (const mark of this.marks) {
      if (mark.kind === "text") {
        // The cache is normally warm; re-rendering here covers the mark that
        // was typed and never re-drawn because nothing about it changed after.
        const art = mark.art ?? this.renderType(mark);
        if (art) stamps.push({ art, colour: mark.colour, place: mark.place, page: mark.page });
        continue;
      }
      if (mark.kind !== "sig") continue;
      const sig = this.store.get(mark.sigId);
      if (!sig) continue;
      // `mark.colour`, so the file matches the preview — see `paintMarks`.
      stamps.push({ art: sig.art, colour: mark.colour, place: mark.place, page: mark.page });
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
        // A page that would not rasterise stops the save. It used to fall back
        // to a drawn cover, which is defensible as engineering and indefensible
        // here: the checkbox said the text underneath would be removed, the
        // file would have been named and saved and sent, and the one page that
        // quietly got a sticker instead is exactly the page somebody chose to
        // redact. A save that fails is an inconvenience. A save that succeeds
        // and lies is how people get hurt.
        const done = new Set(rasters.map((r) => r.page));
        const left = [...new Set(covers.filter((c) => !done.has(c.page)).map((c) => c.page))];
        if (left.length > 0) {
          const which = left.map((p) => p + 1).join(", ");
          throw new Error(
            `page ${which} could not be flattened, so the text under the covers would still be in the file. Nothing was saved. Turn off “Text underneath removed” to save it with covers drawn on top instead — but then the words are still there.`,
          );
        }
        extras.flatten = rasters;
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

    const out = await stampPdf(src, stamps, marks, extras);
    if (!this.lockPage) return out;
    // Last, and over the finished document, so the signature and the watermark
    // are flattened along with everything else. Doing it earlier would flatten
    // the page and then draw removable operators back on top of it, which is
    // the same file with extra steps.
    return flattenPdf(out, ({ page, pages }) => this.say(`locking page ${page} of ${pages}…`));
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
        // Opaque, and `c.place.opacity` is not consulted. Burning a cover in
        // at 60% burns in `orig x 0.4` -- the words are still there, dimmer,
        // and one division by 0.4 brings them back exactly. Baking a leak into
        // the pixels is worse than leaving it on top of them, because now it
        // looks permanent.
        ctx.globalAlpha = 1;
        ctx.fillStyle = opaque(c.colour);
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
    const img = await loadPicture(url, "could not re-read the picture");

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

    const asImage = async (raster: ImageArt, place: Placement): Promise<void> => {
      const node = await new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image();
        im.addEventListener("load", () => resolve(im));
        im.addEventListener("error", () => reject(new Error("a saved signature would not load")));
        im.src = raster.data;
      });
      drawImageStampOnCanvas(ctx, node, { w: raster.w, h: raster.h }, place, this.pageH);
    };

    for (const mark of this.marks) {
      if (mark.page !== 0) continue;
      if (mark.kind === "text") {
        const art = mark.art ?? this.renderType(mark);
        if (art) await asImage(art, mark.place);
        continue;
      }
      if (mark.kind !== "sig") continue;
      const sig = this.store.get(mark.sigId);
      if (!sig) continue;
      if (sig.art.source === "image") {
        await asImage(sig.art, mark.place);
      } else {
        const art = artPaths(sig.art);
        if (art) drawStampOnCanvas(ctx, art, mark.colour, mark.place, this.pageH);
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
    this.saveBar.say(text, bad);
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
    // Not while a field has the focus, or Backspace deletes the mark instead
    // of the character just typed into its own text box.
    const inField = document.activeElement instanceof HTMLInputElement;
    if ((e.key === "Delete" || e.key === "Backspace") && this.picked && !inField) {
      this.removeMark(this.picked);
      e.preventDefault();
      return;
    }
    if (inField) return;
    if (this.isPdf && (e.key === "PageDown" || e.key === "ArrowRight")) void this.turn(1);
    if (this.isPdf && (e.key === "PageUp" || e.key === "ArrowLeft")) void this.turn(-1);
  }
}

/** Exported for the phone build, which shares one store with the desktop shell. */
export function sharedStore(): SignatureStore {
  return new SignatureStore(browserSigBackend());
}

export { dataUrlBytes };
