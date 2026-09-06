/**
 * The phone editor: the whole picture, always, with the controls in two slim
 * bands above and below it.
 *
 * The previous version put the tools in a sheet that rose over the bottom
 * 45% of the photograph, and user feedback was the brief for this
 * one: "when I'm editing an image I want to see the whole image while I'm
 * editing it. There's no way to undo." So the layout is now a grid of three
 * rows — a 48 px top bar, the stage, a dock of at most ~140 px — and nothing
 * ever floats over the stage. Every extra control the editor needs is one
 * horizontal, finger-scrollable row inside the dock: the chips for a group,
 * or a single big slider, or the filter thumbnails, or a confirm row. Never a
 * list you scroll down into, because down is where the picture is.
 *
 * Undo is the other half of the brief. Every committed change — a slider
 * released, a crop applied, a stroke finished, a preset picked — pushes exactly
 * one entry onto one history, and Undo / Redo sit in the top bar with a visible
 * disabled state. The history is the same `Snap` stack the old sheet kept; it
 * has grown a label per entry so the "N edits" button can list them.
 *
 * The engine is the shared one. `renderBlur`, `applyGeom` and `applyAdjust`
 * from `@core/edit` draw both this preview and the exported file, so what you
 * approve on the phone is byte-for-byte what gets written.
 */

import {
  newRegion,
  renderBlur,
  regionAt,
  type BlurKind,
  type BlurRegion,
  type Point,
  type ShapeKind,
  type Stroke,
} from "@core/edit/blur";
import {
  applyGeom,
  cropTo,
  identity,
  isIdentity,
  mirror,
  outSize,
  rotate,
  toOutput,
  toSource,
  type Geom,
} from "@core/edit/geom";
import {
  applyAdjust,
  isNeutral as lightIsNeutral,
  noAdjust,
  type Adjust,
} from "@core/edit/color";
import { combineAdjust, PRESETS, presetById, type Preset } from "@core/edit/presets";
import { detectIn, newFaceRegions, PHOTO_DETECT } from "@core/vision/apply";
import { detectAll, detectionsToRegions, summarise } from "@core/vision/autoblur";
import { AUTO_CATEGORIES, CATEGORY_NAMES, enabledCategories, type AutoCategory } from "@core/vision/autoblur-config";
import { prepareInput } from "@core/vision/autoblur-image";
import { getRunner } from "@core/vision/onnx-runner";
import { autoBlurStore, loadAutoPick, saveAutoPick } from "@core/phone/autoblur-prefs";
import { Tesseract } from "@core/ocr/engine";
import { perf } from "@core/phone/mark";
import { el, fill } from "./dom";
import { icon } from "./icons";
import { groupTools, TOOLS, type PhoneTool, type ToolGroup } from "./tools";
import type { FileKind } from "@core/explorer/types";

// ── Constants ─────────────────────────────────────────────────────────────

/** Brush width as a fraction of the short edge. See the old file for why 0.004. */
const BRUSH_MIN = 0.004;
const BRUSH_MAX = 0.4;
const BRUSH_W = 0.06;

/** Undo depth. Forty is more than a phone edit ever needs and bounds memory. */
const HISTORY_CAP = 40;

/** Longest edge of the canvas while a slider is being dragged. */
const PREVIEW_MAX = 1400;

/** Tint swatches. Few on purpose: a fill colour, not a paint box. */
const SWATCHES: ReadonlyArray<readonly [string, string]> = [
  ["Black", "#000000"],
  ["White", "#ffffff"],
  ["Grey", "#7d7d7d"],
  ["Red", "#d13438"],
  ["Amber", "#c98a00"],
  ["Yellow", "#f2d600"],
  ["Green", "#2f8f4e"],
  ["Blue", "#2a6fd6"],
  ["Purple", "#7a4fd0"],
];

/** Output-size rungs, as a fraction of the crop. */
const SCALES = [0.1, 0.25, 0.33, 0.5, 0.66, 0.75, 1, 1.5, 2];

/** JPEG qualities on offer. Three, because the honest choice is small/normal/max. */
const QUALITIES: ReadonlyArray<readonly [string, number]> = [
  ["Small", 0.8],
  ["Normal", 0.92],
  ["Max", 1],
];

/** The rail, in order. Ten groups plus the overflow that keeps every tool reachable. */
export type RailId =
  | "adjust" | "filters" | "crop" | "blur" | "draw" | "text"
  | "frame" | "sign" | "auto" | "share" | "more";

/**
 * The groups, in order. Every one but "share" gets a rail button: the save
 * strip is what the top bar's Save pill opens, and a second door to it in
 * the rail (next to a viewer that already has a Share action) was the same
 * place under a third name. `RAIL` still lists it so `railFor` and the
 * reachability checks see one complete map of where each tool lives.
 */
export const RAIL: ReadonlyArray<readonly [RailId, string, string]> = [
  ["adjust", "Adjust", "sliders"],
  ["filters", "Filters", "palette"],
  ["crop", "Crop", "crop"],
  ["blur", "Blur", "blur"],
  ["draw", "Draw", "pen"],
  ["text", "Text", "type"],
  ["frame", "Frame", "frame"],
  ["sign", "Sign", "signature"],
  ["auto", "Auto", "sparkles"],
  ["share", "Share", "share"],
  ["more", "More", "more"],
];

/** The twelve Adjust chips, in the order the brief lists them. */
const ADJUST_CHIPS: ReadonlyArray<{
  field: keyof Adjust; label: string; min: number; max: number; icon: string;
  format: (v: number) => string;
}> = [
  { field: "brightness", label: "Brightness", min: -1, max: 1, icon: "brightness", format: signedPct },
  { field: "contrast", label: "Contrast", min: -1, max: 1, icon: "contrast", format: signedPct },
  { field: "exposure", label: "Exposure", min: -1, max: 1, icon: "sun",
    format: (v) => (v === 0 ? "0" : `${v > 0 ? "+" : "−"}${(Math.abs(v) * 2).toFixed(1)} EV`) },
  { field: "highlights", label: "Highlights", min: -1, max: 1, icon: "highlights", format: signedPct },
  { field: "shadows", label: "Shadows", min: -1, max: 1, icon: "shadows", format: signedPct },
  { field: "warmth", label: "Warmth", min: -1, max: 1, icon: "warmth", format: signedPct },
  { field: "tint", label: "Tint", min: -1, max: 1, icon: "tint", format: signedPct },
  { field: "saturation", label: "Saturation", min: -1, max: 1, icon: "saturate", format: signedPct },
  { field: "vibrance", label: "Vibrance", min: -1, max: 1, icon: "droplet", format: signedPct },
  { field: "sharpness", label: "Sharpen", min: 0, max: 1, icon: "sharpen", format: plainPct },
  { field: "vignette", label: "Vignette", min: 0, max: 1, icon: "vignette", format: plainPct },
  { field: "fade", label: "Fade", min: 0, max: 1, icon: "fade", format: plainPct },
];

/** `light.*` ids to Adjust fields. `light.sharpen` is the one that differs. */
const LIGHT_FIELD: Readonly<Record<string, keyof Adjust>> = {
  "light.exposure": "exposure",
  "light.brightness": "brightness",
  "light.contrast": "contrast",
  "light.saturation": "saturation",
  "light.warmth": "warmth",
  "light.highlights": "highlights",
  "light.shadows": "shadows",
  "light.sharpen": "sharpness",
  "light.vignette": "vignette",
};

/** Crop ratios. `null` is free; 0 is "the original frame's own ratio". */
const RATIOS: ReadonlyArray<readonly [string, number | null]> = [
  ["Free", null],
  ["Original", 0],
  ["1:1", 1],
  ["4:5", 4 / 5],
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
];

function signedPct(v: number): string {
  return v === 0 ? "0" : `${v > 0 ? "+" : "−"}${Math.round(Math.abs(v) * 100)}`;
}

function plainPct(v: number): string {
  return v === 0 ? "0" : `${Math.round(v * 100)}%`;
}

// ── Types ─────────────────────────────────────────────────────────────────

/** What the stage does with a drag right now. */
type Gesture =
  | "none" | "draw" | "paint" | "move"
  | "crop-new" | "crop-move" | "crop-corner"
  | "text-move";

/** A caption laid over the picture, in output coordinates. */
interface TextItem {
  id: string;
  text: string;
  /** Centre, normalised to the output frame. */
  x: number;
  y: number;
  /** Height as a fraction of the output short edge. */
  size: number;
  color: string;
}

/** A border drawn inside the picture's edge. */
interface Frame {
  /** Fraction of the short edge. 0 is no frame. */
  width: number;
  color: string;
}

/**
 * One step of undo: the complete edit state, plus the name of the change
 * that moved *away* from it (for the history list).
 */
interface Snap {
  regions: BlurRegion[];
  geom: Geom;
  light: Adjust;
  look: { id: string | null; amount: number };
  texts: TextItem[];
  frame: Frame;
  label: string;
}

export interface SaveOptions {
  /** Write over the original file. Only ever true after an explicit confirm. */
  overwrite: boolean;
  /** JPEG quality, 0…1. Ignored for PNG. */
  quality: number;
}

export interface EditorHost {
  /** True under Tauri — gates save, share and anything else touching disk. */
  native: boolean;
  /** The ffmpeg sidecar is present. */
  ffmpeg: boolean;
  /** Leave the editor. The editor has already asked about unsaved work. */
  leave(): void;
  /**
   * Run a tool this editor does not own — OCR, the signing panel, the batch
   * queue. Returns false when nothing could take it.
   */
  runTool(id: string): boolean;
  /** Show a one-line message over the picture. */
  say(text: string): void;
  /** Encode the canvas and write it. Resolves to the path written, or null. */
  save(opts: SaveOptions): Promise<string | null>;
  /** Hand a written file to the system share sheet. */
  share(path: string): Promise<void>;
}

// ── The editor ────────────────────────────────────────────────────────────


export class PhoneEditor {
  /** The bottom dock: contextual strip over the tool rail. Mounted by the viewer. */
  readonly el: HTMLElement;
  /** The top bar: back, title, undo, redo, compare, save. Mounted by the viewer. */
  readonly top: HTMLElement;

  private strip: HTMLElement;
  private rail: HTMLElement;
  private titleEl: HTMLElement;
  private editsEl: HTMLElement;
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;
  private compareBtn: HTMLButtonElement;
  private saveBtn: HTMLButtonElement;

  private source: ImageBitmap | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private kind: FileKind = "image";

  private group: RailId = "adjust";

  private regions: BlurRegion[] = [];
  private selected: string | null = null;
  private nextId = 1;
  /** The brush region Draw paints into, kept apart from the blur brush. */
  private markerId: string | null = null;

  /** What a drag in the Blur group draws. */
  private shape: ShapeKind = "rect";
  /** The blur style for new regions and the selected one. */
  private style: BlurKind = "gaussian";
  /** Settings a new blur region is born with. See the old file for why. */
  private arm = {
    brush: BRUSH_W, amount: 0.03, feather: 0.01, opacity: 1, corners: 0, angle: 0,
    color: "#000000", colorAmount: 0,
  };
  /** The marker's own settings. */
  private pen = { width: 0.012, color: "#d13438", opacity: 1, erase: false };

  /** Categories ticked in the Auto-blur sheet for this run; null = "as configured". */
  private autoPick: Set<AutoCategory> | null = null;
  private autoBusy = false;
  /** The OCR engine, made on the first run that reads text and kept for the session. */
  private ocr: Tesseract | null = null;

  private geom: Geom = identity();
  private light: Adjust = noAdjust();
  private look: { id: string | null; amount: number } = { id: null, amount: 1 };
  private texts: TextItem[] = [];
  private selectedText: string | null = null;
  private textSize = 0.06;
  private textColor = "#ffffff";
  private frame: Frame = { width: 0, color: "#ffffff" };

  private history: Snap[] = [];
  private future: Snap[] = [];

  private gesture: Gesture = "none";
  private origin = { x: 0, y: 0 };
  private stroke: Stroke | null = null;
  /** Which corner is being dragged, as the *anchor* corner that stays put. */
  private anchor = { x: 0, y: 0 };

  /** Crop-in-progress, in output coordinates. Non-null only in the Crop group. */
  private cropRect: { x: number; y: number; w: number; h: number } | null = null;
  private cropRatio: number | null = null;

  /** Compare is held down: the canvas shows the untouched source. */
  private comparing = false;
  /** A slider is mid-drag: render at preview size. */
  private previewOn = false;
  private previewDims = { w: 0, h: 0 };

  private pending = 0;
  private compose: HTMLCanvasElement | null = null;
  private preview: HTMLCanvasElement | null = null;
  /** Filter thumbnails, built once per source. */
  private thumbBase: HTMLCanvasElement | null = null;
  private thumbs = new Map<string, HTMLCanvasElement>();

  constructor(private readonly host: EditorHost) {
    const back = this.iconBtn("arrow-left", "Back", () => this.requestClose());
    this.titleEl = el("span.phe-title-name", { text: "Edit" });
    this.editsEl = el("span.phe-title-edits", { text: "" });
    const title = el<"button">("button.phe-title", {
      type: "button", title: "Edit history", "aria-label": "Edit history",
    }, this.titleEl, this.editsEl);
    title.addEventListener("click", () => this.showHistory());

    this.undoBtn = this.iconBtn("undo", "Undo", () => this.undo());
    this.redoBtn = this.iconBtn("redo", "Redo", () => this.redo());
    this.compareBtn = this.iconBtn("compare", "Hold to compare with the original", () => {});
    this.wireCompare(this.compareBtn);
    const save = el<"button">("button.phe-save", { type: "button", text: "Save", "aria-pressed": "false" });
    save.addEventListener("click", () => this.open("share"));
    this.saveBtn = save;

    this.top = el("div.phe-top", { hidden: true, role: "toolbar", "aria-label": "Editor" },
      back, title, this.undoBtn, this.redoBtn, this.compareBtn, save,
    );

    this.strip = el("div.phe-strip", { role: "group", "aria-label": "Tool options" });
    this.rail = el("nav.phe-rail", { "aria-label": "Tools" });
    this.el = el("div.phe-dock", { hidden: true }, this.strip, this.rail);
    this.buildRail();
    this.wireScrollHints();
  }

  // ── Scroll hints ────────────────────────────────────────────────────────

  /**
   * Both dock rows scroll sideways and neither shows a scrollbar, so a row
   * that runs past the edge used to look like it simply ended there — on a
   * 360 px phone the rail stopped dead at "Text" with four more groups
   * hidden behind it. Each row now carries `data-more` ("left", "right",
   * "both" or absent) and the stylesheet fades that edge out. Recomputed on
   * scroll, on resize, and whenever the strip is refilled; a row that fits
   * gets nothing, so the hint only ever appears when there IS more.
   */
  private wireScrollHints(): void {
    for (const row of [this.strip, this.rail]) {
      row.addEventListener("scroll", () => this.hintScroll(row), { passive: true });
    }
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => this.hintScrollAll());
      ro.observe(this.strip);
      ro.observe(this.rail);
    } else {
      window.addEventListener("resize", () => this.hintScrollAll());
    }
  }

  private hintScrollAll(): void {
    this.hintScroll(this.strip);
    this.hintScroll(this.rail);
  }

  private hintScroll(row: HTMLElement): void {
    // Measure to the last real child, not `scrollWidth`: each row ends in an
    // `::after` spacer that keeps the final button clear of the edge-gesture
    // zone, and a fade that only covers the spacer would say "more" over a
    // row that has none.
    const last = row.lastElementChild;
    const edge = row.getBoundingClientRect();
    const end = last ? last.getBoundingClientRect().right : edge.left;
    const cs = getComputedStyle(row);
    const pad = parseFloat(cs.paddingRight) || 0;
    const rightOver = end - (edge.right - pad);
    const left = row.scrollLeft > 2;
    const right = rightOver > 2;
    const v = left && right ? "both" : left ? "left" : right ? "right" : "";
    if (v) row.dataset.more = v; else delete row.dataset.more;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Take a decoded picture and start a fresh edit of it. */
  begin(source: ImageBitmap, canvas: HTMLCanvasElement, kind: FileKind, name = ""): void {
    this.source = source;
    this.canvas = canvas;
    this.kind = kind;
    this.regions = [];
    this.selected = null;
    this.markerId = null;
    this.nextId = 1;
    this.history = [];
    this.future = [];
    this.geom = identity();
    this.light = noAdjust();
    this.look = { id: null, amount: 1 };
    this.texts = [];
    this.selectedText = null;
    this.frame = { width: 0, color: "#ffffff" };
    this.cropRect = null;
    this.cropRatio = null;
    this.comparing = false;
    this.previewOn = false;
    this.shape = "rect";
    this.style = "gaussian";
    this.thumbBase = null;
    this.thumbs.clear();
    this.titleEl.textContent = name || "Edit";
    this.paintHistory();
    this.draw();
    // Sticky group, like before: the last thing you did is the likely next.
    this.open(this.group);
  }

  end(): void {
    this.source = null;
    this.canvas = null;
    this.regions = [];
    this.texts = [];
    this.history = [];
    this.future = [];
    this.geom = identity();
    this.light = noAdjust();
    this.cropRect = null;
    if (this.pending !== 0) {
      cancelAnimationFrame(this.pending);
      this.pending = 0;
    }
    // Released, not kept: sized to the last source, which on a 45 MP file is
    // 180 MB of backing store for a picture already navigated away from.
    this.compose = null;
    this.preview = null;
    this.thumbBase = null;
    this.thumbs.clear();
  }

  get dirty(): boolean {
    return (
      this.regions.length > 0 ||
      !isIdentity(this.geom) ||
      !lightIsNeutral(this.light) ||
      (this.look.id !== null && this.look.amount > 0) ||
      this.texts.length > 0 ||
      this.frame.width > 0
    );
  }

  /** How many committed changes there are to undo. */
  get edits(): number {
    return this.history.length;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Keep the old name working: show the current group. */
  showTools(): void {
    this.open(this.group);
  }

  showBlurPanel(): void {
    this.open("blur");
  }

  /**
   * Back was pressed — the button, or the hardware key via the viewer.
   *
   * Not a `confirm()`: a JavaScript modal in an Android WebView blocks the
   * bridge and cannot be styled. The question goes in the strip, where every
   * other decision is made, and the picture stays fully visible behind it.
   */
  requestClose(): void {
    if (!this.dirty) {
      this.host.leave();
      return;
    }
    const n = this.history.length;
    this.confirmRow(
      `Discard ${n === 1 ? "this edit" : `${n} edits`}?`,
      "Discard",
      () => this.host.leave(),
      "Keep editing",
    );
  }

  // ── Drawing ─────────────────────────────────────────────────────────────

  /**
   * Re-render: blur pass, geometry, light, then the overlays.
   *
   * `chrome` false leaves out the crop overlay and selection handles, for the
   * read-back before an export. Captions and the frame are content and stay.
   */
  draw(chrome = true): void {
    if (!this.source || !this.canvas) return;

    if (this.comparing) {
      const c = this.canvas;
      if (c.width !== this.source.width || c.height !== this.source.height) {
        c.width = this.source.width;
        c.height = this.source.height;
      }
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.source, 0, 0);
      return;
    }

    let src: CanvasImageSource = this.source;
    let w = this.source.width;
    let h = this.source.height;

    // Mid-drag, everything runs on a downscaled copy of the source. A 12 MP
    // tone pass is far more work than a frame allows; at 1400 px it is not.
    if (this.previewOn && this.previewDims.w > 0 && this.previewDims.w < w) {
      const p = this.previewFor(this.previewDims.w, this.previewDims.h);
      const pctx = p.getContext("2d");
      if (pctx) {
        pctx.setTransform(1, 0, 0, 1, 0, 0);
        pctx.drawImage(this.source, 0, 0, p.width, p.height);
        src = p;
        w = p.width;
        h = p.height;
      }
    }

    if (isIdentity(this.geom)) {
      renderBlur(this.canvas, src, w, h, this.regions);
    } else {
      const mid = this.composeFor(w, h);
      renderBlur(mid, src, w, h, this.regions);
      applyGeom(this.canvas, mid, w, h, this.geom);
    }

    applyAdjust(this.canvas, this.effectiveLight());
    this.drawTexts();
    this.drawFrame();

    if (chrome) {
      this.drawHandles();
      this.drawCropOverlay();
    }
  }

  /** Redraw at most once per frame. */
  private drawSoon(): void {
    if (this.pending !== 0) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.draw();
    });
  }

  private composeFor(w: number, h: number): HTMLCanvasElement {
    let c = this.compose;
    if (!c) {
      c = document.createElement("canvas");
      this.compose = c;
    }
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    return c;
  }

  private previewFor(w: number, h: number): HTMLCanvasElement {
    let c = this.preview;
    if (!c) {
      c = document.createElement("canvas");
      this.preview = c;
    }
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    return c;
  }

  /** Manual light plus the chosen preset. */
  private effectiveLight(): Adjust {
    const p = this.look.id ? presetById(this.look.id) : undefined;
    return combineAdjust(this.light, p, this.look.amount);
  }

  /**
   * Work out the preview size once, when a drag starts. The canvas box on
   * screen times the device ratio is every pixel anyone can see; anything
   * beyond that is wasted while a finger is moving.
   */
  private beginPreview(): void {
    if (!this.source || !this.canvas) return;
    const box = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const sw = this.source.width;
    const sh = this.source.height;
    const long = Math.max(sw, sh);
    const want = Math.min(PREVIEW_MAX, Math.max(box.width, box.height) * dpr || PREVIEW_MAX);
    const k = Math.min(1, want / long);
    this.previewDims = { w: Math.max(1, Math.round(sw * k)), h: Math.max(1, Math.round(sh * k)) };
    this.previewOn = k < 1;
  }

  private endPreview(): void {
    if (!this.previewOn) return;
    this.previewOn = false;
    if (this.pending !== 0) {
      cancelAnimationFrame(this.pending);
      this.pending = 0;
    }
    this.draw();
  }

  // ── The top bar ─────────────────────────────────────────────────────────

  private iconBtn(name: string, label: string, onTap: () => void): HTMLButtonElement {
    const b = el<"button">("button.phe-btn", { type: "button", "aria-label": label, title: label });
    b.append(icon(name));
    b.addEventListener("click", onTap);
    return b;
  }

  /** Hold shows the original; release goes back to the edit. */
  private wireCompare(b: HTMLButtonElement): void {
    const down = (ev: Event): void => {
      ev.preventDefault();
      if (this.comparing) return;
      this.comparing = true;
      b.setAttribute("aria-pressed", "true");
      this.draw();
    };
    const up = (): void => {
      if (!this.comparing) return;
      this.comparing = false;
      b.setAttribute("aria-pressed", "false");
      this.draw();
    };
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("pointerdown", down);
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
    b.addEventListener("pointerleave", up);
    // A held finger is a long press to the WebView, and a long press opens
    // the context menu — which would swallow the release and leave the
    // original showing. The hold is the whole interaction, so no menu.
    b.addEventListener("contextmenu", (ev) => ev.preventDefault());
    b.addEventListener("keydown", (ev) => { if (ev.key === " " || ev.key === "Enter") down(ev); });
    b.addEventListener("keyup", up);
  }

  /** Is the compare view showing right now? For the harness. */
  get comparingNow(): boolean {
    return this.comparing;
  }

  /** Press and release compare from code — the harness has no pointer. */
  compare(on: boolean): void {
    if (on === this.comparing) return;
    this.comparing = on;
    this.compareBtn.setAttribute("aria-pressed", String(on));
    this.draw();
  }

  private paintHistory(): void {
    const n = this.history.length;
    this.editsEl.textContent = n === 0 ? "No edits" : n === 1 ? "1 edit" : `${n} edits`;
    this.undoBtn.disabled = n === 0;
    this.redoBtn.disabled = this.future.length === 0;
  }

  // ── The rail ────────────────────────────────────────────────────────────

  private buildRail(): void {
    const frag = document.createDocumentFragment();
    for (const [id, label, glyph] of RAIL) {
      if (id === "share") continue; // the top bar's Save pill is its button
      const b = el<"button">("button.phe-rail-btn", {
        type: "button",
        "data-rail": id,
        "aria-label": label,
        "aria-pressed": "false",
      },
        el("span.phe-rail-icon", { "aria-hidden": true }, icon(glyph)),
        el("span.phe-rail-label", { text: label }),
      );
      b.addEventListener("click", () => this.open(id));
      frag.append(b);
    }
    fill(this.rail, frag);
  }

  /** Switch group. Leaving Crop commits any pending crop first. */
  open(id: RailId): void {
    if (this.group === "crop" && id !== "crop") this.commitCrop();
    if (id !== "text") this.selectedText = null;
    this.group = id;

    for (const b of this.rail.querySelectorAll<HTMLButtonElement>(".phe-rail-btn")) {
      const on = b.dataset["rail"] === id;
      b.setAttribute("aria-pressed", String(on));
      if (on) b.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    // The save strip has no rail button; the Save pill lights up instead.
    this.saveBtn.setAttribute("aria-pressed", String(id === "share"));

    switch (id) {
      case "adjust": this.showAdjust(); break;
      case "filters": this.showFilters(); break;
      case "crop": this.showCrop(); break;
      case "blur": this.showBlur(); break;
      case "draw": this.showDraw(); break;
      case "text": this.showText(); break;
      case "frame": this.showFrame(); break;
      case "sign": this.showHostGroup("sign"); break;
      case "auto": this.showAuto(); break;
      case "share": this.showShare(); break;
      case "more": this.showMore(); break;
    }
    this.draw();
  }

  /** The group showing. For the harness. */
  get current(): RailId {
    return this.group;
  }

  // ── Strip primitives ────────────────────────────────────────────────────

  /** A chip in the strip. `tool` tags it so a tool id can be found by tests. */
  private chip(
    label: string,
    onTap: () => void,
    opts: { icon?: string; on?: boolean; tool?: string | undefined; disabled?: boolean; why?: string; value?: string } = {},
  ): HTMLButtonElement {
    const b = el<"button">("button.phe-chip", {
      type: "button",
      "aria-pressed": opts.on ? "true" : "false",
      title: opts.why ?? label,
      "aria-label": opts.why ? `${label}. ${opts.why}` : label,
    });
    if (opts.tool) b.dataset["tool"] = opts.tool;
    if (opts.disabled) b.disabled = true;
    if (opts.icon) b.append(el("span.phe-chip-icon", { "aria-hidden": true }, icon(opts.icon)));
    b.append(el("span.phe-chip-label", { text: label }));
    if (opts.value !== undefined) {
      b.append(el("span.phe-chip-value", { text: opts.value }));
      b.classList.add("phe-chip-set");
    }
    b.addEventListener("click", onTap);
    return b;
  }

  private divider(): HTMLElement {
    return el("span.phe-divider", { "aria-hidden": true });
  }

  private setStrip(...kids: (Node | string)[]): void {
    fill(this.strip, ...kids);
    this.strip.scrollLeft = 0;
    this.hintScroll(this.strip);
    // The rail's active button may just have been scrolled into view.
    this.hintScroll(this.rail);
  }

  /**
   * The one big slider. Takes the whole strip; a chevron returns to the chips.
   *
   * One undo entry per drag: the state is snapped on the first input and
   * committed on release, so Undo returns to how the picture looked before
   * you reached for the control. Double-tap anywhere on the row resets it.
   * While the finger is down the picture renders at preview size.
   */
  private slider(o: {
    label: string; value: number; min: number; max: number; step: number;
    format: (v: number) => string;
    onInput: (v: number) => void;
    /** Undo label. */
    commit: string;
    back: () => void;
    reset?: number;
    /** Light sliders redraw every pixel; blur ones do not need the preview. */
    preview?: boolean;
  }): void {
    const readout = el("span.phe-slider-value", { text: o.format(o.value) });
    const range = el<"input">("input.phe-range", {
      type: "range",
      min: String(o.min),
      max: String(o.max),
      step: String(o.step),
      value: String(o.value),
      "aria-label": o.label,
    });
    let before: Snap | null = null;
    /** Where the last settled drag left the control. */
    let start = o.value;

    const arm = (): void => {
      if (before) return;
      before = this.snap(o.commit);
      if (o.preview !== false) this.beginPreview();
    };
    const settle = (): void => {
      const v = Number(range.value);
      const was = before;
      before = null;
      this.endPreview();
      if (was && v !== start) this.commit(was);
      else this.drawSoon();
      start = v;
    };

    range.addEventListener("pointerdown", arm);
    range.addEventListener("input", () => {
      // Keyboard and some WebViews skip pointerdown. The model has not been
      // written yet when `input` fires, so snapping here is still in time.
      if (!before) arm();
      const v = Number(range.value);
      readout.textContent = o.format(v);
      o.onInput(v);
      this.drawSoon();
    });
    range.addEventListener("change", settle);
    range.addEventListener("pointercancel", settle);

    const back = this.iconBtn("chevron-left", "Back to options", o.back);
    back.classList.add("phe-slider-back");

    const row = el("div.phe-slider", {},
      back,
      el("span.phe-slider-label", { text: o.label }),
      range,
      readout,
    );

    // Double-tap resets. Detected by hand rather than `dblclick`, which a
    // range input swallows on most touch WebViews.
    let last = 0;
    row.addEventListener("pointerdown", (ev) => {
      const now = performance.now();
      if (now - last < 320 && o.reset !== undefined) {
        ev.preventDefault();
        const was = this.snap(o.commit);
        o.onInput(o.reset);
        range.value = String(o.reset);
        readout.textContent = o.format(o.reset);
        before = null;
        this.endPreview();
        if (start !== o.reset) this.commit(was);
        start = o.reset;
        this.draw();
        last = 0;
        return;
      }
      last = now;
    });

    this.setStrip(row);
  }

  /** A yes/no in the strip. Picture stays visible; no modal anywhere. */
  private confirmRow(question: string, yes: string, onYes: () => void, no = "Cancel"): void {
    const y = el<"button">("button.phe-chip.phe-chip-danger", { type: "button", text: yes });
    y.addEventListener("click", onYes);
    const n = el<"button">("button.phe-chip", { type: "button", text: no });
    n.addEventListener("click", () => this.open(this.group));
    this.setStrip(el("span.phe-question", { text: question }), y, n);
  }

  // ── Adjust ──────────────────────────────────────────────────────────────

  private showAdjust(): void {
    const frag = document.createDocumentFragment();
    for (const c of ADJUST_CHIPS) {
      const v = this.light[c.field];
      frag.append(this.chip(c.label, () => this.adjustSlider(c.field), {
        icon: c.icon,
        tool: LIGHT_FIELD_ID[c.field],
        ...(v !== 0 ? { value: c.format(v) } : {}),
      }));
    }
    frag.append(this.divider());
    frag.append(this.chip("Reset", () => this.resetLight(), {
      icon: "clear", tool: "light.reset", disabled: lightIsNeutral(this.light),
    }));
    this.setStrip(frag);
  }

  private adjustSlider(field: keyof Adjust): void {
    const c = ADJUST_CHIPS.find((x) => x.field === field);
    if (!c) return;
    this.slider({
      label: c.label,
      value: this.light[field],
      min: c.min,
      max: c.max,
      step: 0.01,
      format: c.format,
      onInput: (v) => { this.light[field] = v; },
      commit: c.label,
      back: () => this.showAdjust(),
      reset: 0,
    });
  }

  private resetLight(): void {
    if (lightIsNeutral(this.light)) return;
    const was = this.snap("Reset light");
    this.light = noAdjust();
    this.commit(was);
    this.showAdjust();
  }

  // ── Filters ─────────────────────────────────────────────────────────────

  private showFilters(): void {
    const frag = document.createDocumentFragment();
    const base = this.thumbBaseCanvas();

    const none = el<"button">("button.phe-filter", {
      type: "button",
      "aria-pressed": String(this.look.id === null),
      "aria-label": "No filter",
    }, this.thumbFor(null, base), el("span.phe-filter-label", { text: "None" }));
    none.addEventListener("click", () => this.pickPreset(null));
    frag.append(none);

    for (const p of PRESETS) {
      const b = el<"button">("button.phe-filter", {
        type: "button",
        "aria-pressed": String(this.look.id === p.id),
        "aria-label": `${p.label} filter`,
        "data-preset": p.id,
      }, this.thumbFor(p, base), el("span.phe-filter-label", { text: p.label }));
      b.addEventListener("click", () => this.pickPreset(p.id));
      frag.append(b);
    }

    frag.append(this.divider());
    frag.append(this.chip("Strength", () => this.presetSlider(), {
      icon: "gauge",
      disabled: this.look.id === null,
      value: `${Math.round(this.look.amount * 100)}%`,
    }));
    this.setStrip(frag);
  }

  private pickPreset(id: string | null): void {
    if (this.look.id === id) {
      if (id !== null) this.presetSlider();
      return;
    }
    const was = this.snap(id ? `${presetById(id)?.label ?? id} filter` : "Remove filter");
    this.look = { id, amount: this.look.amount > 0 ? this.look.amount : 1 };
    this.commit(was);
    this.showFilters();
  }

  private presetSlider(): void {
    this.slider({
      label: presetById(this.look.id ?? "")?.label ?? "Strength",
      value: this.look.amount,
      min: 0,
      max: 1,
      step: 0.01,
      format: plainPct,
      onInput: (v) => { this.look.amount = v; },
      commit: "Filter strength",
      back: () => this.showFilters(),
      reset: 1,
    });
  }

  /** A ~96 px copy of the source for the thumbnail strip, made once. */
  private thumbBaseCanvas(): HTMLCanvasElement | null {
    if (!this.source) return null;
    if (this.thumbBase) return this.thumbBase;
    const sw = this.source.width;
    const sh = this.source.height;
    const k = 96 / Math.max(sw, sh);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw * k));
    c.height = Math.max(1, Math.round(sh * k));
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.imageSmoothingQuality = "medium";
      ctx.drawImage(this.source, 0, 0, c.width, c.height);
    }
    this.thumbBase = c;
    return c;
  }

  private thumbFor(p: Preset | null, base: HTMLCanvasElement | null): HTMLElement {
    const key = p ? p.id : "";
    let c = this.thumbs.get(key);
    if (!c) {
      c = document.createElement("canvas");
      c.className = "phe-filter-thumb";
      c.width = base?.width ?? 1;
      c.height = base?.height ?? 1;
      const ctx = c.getContext("2d");
      if (ctx && base) ctx.drawImage(base, 0, 0);
      if (p) applyAdjust(c, combineAdjust(noAdjust(), p, 1));
      this.thumbs.set(key, c);
    }
    return c;
  }

  // ── Crop & rotate ───────────────────────────────────────────────────────

  private showCrop(): void {
    if (!this.cropRect) this.cropRect = { x: 0, y: 0, w: 1, h: 1 };
    const frag = document.createDocumentFragment();

    for (const [label, ratio] of RATIOS) {
      frag.append(this.chip(label, () => {
        this.cropRatio = ratio;
        this.cropRect = ratio === null ? { x: 0, y: 0, w: 1, h: 1 } : this.fitRect(this.ratioValue(ratio));
        this.showCrop();
        this.draw();
      }, { on: this.cropRatio === ratio, tool: label === "Free" ? "tf.crop" : undefined }));
    }

    frag.append(this.divider());
    frag.append(this.chip("Rotate", () => this.turn(), { icon: "rotate", tool: "tf.rotate" }));
    frag.append(this.chip("Flip H", () => this.flip("x"), { icon: "flip", tool: "tf.flip" }));
    frag.append(this.chip("Flip V", () => this.flip("y"), { icon: "flip-v" }));
    frag.append(this.chip("Straighten", () => this.straightenSlider(), {
      icon: "straighten",
      ...((this.geom.tilt ?? 0) !== 0 ? { value: `${this.geom.tilt}°` } : {}),
    }));
    const px = this.outPx();
    frag.append(this.chip("Size", () => this.sizeSlider(), {
      icon: "resize", tool: "tf.resize", value: `${px.w}×${px.h}`,
    }));
    frag.append(this.divider());
    frag.append(this.chip("Reset", () => this.resetGeom(), { icon: "clear", disabled: isIdentity(this.geom) }));
    frag.append(this.chip("Done", () => { this.commitCrop(); this.showCrop(); }, {
      icon: "check", disabled: !this.cropPending(),
    }));
    this.setStrip(frag);
  }

  /** "Original" is the source's own ratio, which only exists once we have one. */
  private ratioValue(r: number): number {
    if (r !== 0) return r;
    if (!this.source) return 1;
    const t = this.geom.turns % 2 === 1;
    return t ? this.source.height / this.source.width : this.source.width / this.source.height;
  }

  private cropPending(): boolean {
    const c = this.cropRect;
    return !!c && (c.x > 1e-3 || c.y > 1e-3 || c.w < 1 - 1e-3 || c.h < 1 - 1e-3);
  }

  /** Apply the rectangle as one undo step. Called by Done and on leaving Crop. */
  private commitCrop(): void {
    const c = this.cropRect;
    if (!c || !this.source || !this.cropPending()) {
      this.cropRect = null;
      return;
    }
    const was = this.snap("Crop");
    this.geom = cropTo(this.geom, this.source.width, this.source.height, c);
    this.cropRect = null;
    this.cropRatio = null;
    this.commit(was);
    const px = this.outPx();
    this.host.say(`Cropped · ${px.w}×${px.h}`);
  }

  private turn(): void {
    const was = this.snap("Rotate");
    this.geom = rotate(this.geom, 1);
    this.cropRect = { x: 0, y: 0, w: 1, h: 1 };
    this.commit(was);
    this.showCrop();
  }

  private flip(axis: "x" | "y"): void {
    const was = this.snap(axis === "x" ? "Flip horizontal" : "Flip vertical");
    this.geom = mirror(this.geom, axis);
    this.commit(was);
    this.showCrop();
  }

  private resetGeom(): void {
    if (isIdentity(this.geom)) return;
    const was = this.snap("Reset crop");
    this.geom = identity();
    this.cropRect = { x: 0, y: 0, w: 1, h: 1 };
    this.cropRatio = null;
    this.commit(was);
    this.showCrop();
  }

  private straightenSlider(): void {
    this.slider({
      label: "Straighten",
      value: this.geom.tilt ?? 0,
      min: -45,
      max: 45,
      step: 0.5,
      format: (v) => `${v > 0 ? "+" : ""}${v}°`,
      onInput: (v) => { this.geom = { ...this.geom, tilt: v }; },
      commit: "Straighten",
      back: () => this.showCrop(),
      reset: 0,
    });
  }

  private sizeSlider(): void {
    const idx = (): number => {
      let best = 0;
      for (let i = 1; i < SCALES.length; i++) {
        const a = SCALES[i] ?? 1;
        const b = SCALES[best] ?? 1;
        if (Math.abs(Math.log(a / this.geom.scale)) < Math.abs(Math.log(b / this.geom.scale))) best = i;
      }
      return best;
    };
    this.slider({
      label: "Size",
      value: idx(),
      min: 0,
      max: SCALES.length - 1,
      step: 1,
      format: (i) => {
        const px = this.outPx();
        return `${Math.round((SCALES[i] ?? 1) * 100)}% · ${px.w}×${px.h}`;
      },
      onInput: (i) => { this.geom = { ...this.geom, scale: SCALES[i] ?? 1 }; },
      commit: "Resize",
      back: () => this.showCrop(),
      reset: SCALES.indexOf(1),
      preview: false,
    });
  }

  /** The largest rectangle of a given aspect that fits the frame, centred. */
  private fitRect(ratio: number): { x: number; y: number; w: number; h: number } {
    const px = this.outPx();
    const frame = px.w / Math.max(1, px.h);
    const rel = ratio / frame;
    const w = rel >= 1 ? 1 : rel;
    const h = rel >= 1 ? 1 / rel : 1;
    return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }

  // ── Blur & redact ───────────────────────────────────────────────────────

  private showBlur(): void {
    const frag = document.createDocumentFragment();
    const have = { native: this.host.native, ffmpeg: this.host.ffmpeg };

    for (const { tool, enabled, why } of groupTools("shape", this.kind, have)) {
      const id = tool.id.slice(11) as ShapeKind;
      frag.append(this.chip(tool.label, () => this.setShape(id), {
        icon: tool.icon, tool: tool.id, on: this.shape === id, disabled: !enabled, why,
      }));
    }
    frag.append(this.divider());
    for (const { tool, enabled, why } of groupTools("blur", this.kind, have)) {
      if (!tool.id.startsWith("blur.kind.")) continue;
      const id = tool.id.slice(10) as BlurKind;
      frag.append(this.chip(tool.label, () => this.setStyle(id), {
        icon: tool.icon, tool: tool.id, on: this.style === id, disabled: !enabled, why,
      }));
    }
    frag.append(this.divider());

    const t = this.blurTarget();
    const val = (f: "amount" | "feather" | "opacity" | "corners" | "angle"): number =>
      t ? t[f] : this.arm[f];
    frag.append(this.chip("Size", () => this.brushSlider(), {
      icon: "brush", tool: "adj.brush", value: this.brushLabel(this.arm.brush),
    }));
    frag.append(this.chip("Strength", () => this.regionSlider("Strength", "amount", 0, 0.25, 0.005,
      (v) => `${Math.round(v * 400)}%`), { icon: "gauge", tool: "adj.amount", value: `${Math.round(val("amount") * 400)}%` }));
    frag.append(this.chip("Feather", () => this.regionSlider("Feather", "feather", 0, 0.1, 0.002,
      (v) => `${Math.round(v * 1000)}`), { icon: "feather", tool: "adj.feather", value: `${Math.round(val("feather") * 1000)}` }));
    frag.append(this.chip("Opacity", () => this.regionSlider("Opacity", "opacity", 0, 1, 0.02, plainPct),
      { icon: "opacity", tool: "adj.opacity", value: plainPct(val("opacity")) }));
    frag.append(this.chip("Corners", () => this.regionSlider("Corners", "corners", 0, 0.5, 0.01,
      (v) => `${Math.round(v * 200)}%`), { icon: "corners", tool: "adj.corners" }));
    frag.append(this.chip("Angle", () => this.regionSlider("Angle", "angle", 0, Math.PI * 2, 0.05,
      (v) => `${Math.round((v * 180) / Math.PI)}°`), { icon: "angle", tool: "adj.angle" }));
    frag.append(this.chip("Tint", () => this.showSwatches("blur"), { icon: "tint", tool: "adj.color" }));
    frag.append(this.divider());
    frag.append(this.chip("Faces", () => void this.blurFaces(), { icon: "face", tool: "ai.faces" }));
    frag.append(this.chip("Auto-blur", () => this.showAutoSheet(), { icon: "sparkles", tool: "ai.auto" }));
    frag.append(this.chip("Invert", () => this.patch("Invert", (r) => { r.invert = !r.invert; }), {
      icon: "invert", tool: "blur.invert", on: !!t?.invert, disabled: !t,
    }));
    frag.append(this.chip("Layers", () => this.showLayers(), {
      icon: "layers", tool: "blur.layers", value: String(this.regions.length),
    }));
    frag.append(this.chip("Clear", () => this.clearAll(), {
      icon: "clear", tool: "blur.clear", disabled: this.regions.length === 0,
    }));
    // The clip tools (blur at a moment, follow, layers) live in the video
    // editor's workspace; here they are doors to it, greyed for a still.
    frag.append(this.divider());
    for (const { tool, enabled, why } of groupTools("blur", this.kind, have)) {
      if (tool.id.startsWith("blur.video.")) frag.append(this.toolChip(tool, enabled, why));
    }
    this.setStrip(frag);
  }

  private setShape(shape: ShapeKind): void {
    if (shape === "full") {
      const was = this.snap("Blur everything");
      const r = newRegion("full", `r${this.nextId++}`);
      r.kind = this.style;
      r.label = "Everything";
      this.regions.push(r);
      this.selected = r.id;
      this.commit(was);
      this.host.say("Whole picture blurred — draw a shape and tap Invert to punch a hole");
    } else {
      this.shape = shape;
      this.host.say(shape === "brush" ? "Paint over what to hide" : `Drag on the picture to place a ${shape}`);
    }
    this.open("blur");
  }

  private setStyle(kind: BlurKind): void {
    this.style = kind;
    const t = this.blurTarget();
    if (t) this.patch("Blur style", (r) => { r.kind = kind; });
    else this.showBlur();
  }

  /** The region sliders write to the selected region and to the armed defaults. */
  private regionSlider(
    label: string,
    field: "amount" | "feather" | "opacity" | "corners" | "angle",
    min: number, max: number, step: number,
    format: (v: number) => string,
  ): void {
    const t = this.blurTarget();
    this.slider({
      label,
      value: t ? t[field] : this.arm[field],
      min, max, step, format,
      onInput: (v) => {
        this.arm[field] = v;
        if (t) t[field] = v;
      },
      commit: label,
      back: () => this.showBlur(),
      preview: false,
    });
  }

  private brushSlider(): void {
    this.slider({
      label: "Brush size",
      value: Math.round(this.brushToSlider(this.arm.brush) * 1000),
      min: 0, max: 1000, step: 1,
      format: (t) => this.brushLabel(this.sliderToBrush(t / 1000)),
      onInput: (t) => { this.arm.brush = this.sliderToBrush(t / 1000); },
      commit: "Brush size",
      back: () => {
        // Arming the brush is the point of having come here.
        this.shape = "brush";
        this.showBlur();
      },
      preview: false,
    });
  }

  private brushLabel(v: number): string {
    const short = this.source ? Math.min(this.source.width, this.source.height) : 0;
    return short > 0 ? `${Math.round(v * short)} px` : `${(v * 100).toFixed(1)}%`;
  }

  /** Square law: the small widths get a third of the travel. */
  private brushToSlider(v: number): number {
    const t = (v - BRUSH_MIN) / (BRUSH_MAX - BRUSH_MIN);
    return Math.sqrt(Math.max(0, Math.min(1, t)));
  }

  private sliderToBrush(t: number): number {
    return BRUSH_MIN + (BRUSH_MAX - BRUSH_MIN) * t * t;
  }

  /** Colour swatches for the blur tint, the marker, a caption or the frame. */
  private showSwatches(what: "blur" | "draw" | "text" | "frame"): void {
    const current =
      what === "blur" ? (this.blurTarget()?.color ?? this.arm.color)
      : what === "draw" ? this.pen.color
      : what === "text" ? (this.textTarget()?.color ?? this.textColor)
      : this.frame.color;

    const back = this.iconBtn("chevron-left", "Back to options", () => this.open(this.group));
    const frag = document.createDocumentFragment();
    frag.append(back);
    for (const [name, hex] of SWATCHES) {
      const b = el<"button">("button.phe-swatch", {
        type: "button", "aria-label": name, title: name, "aria-pressed": String(hex === current),
      });
      b.style.background = hex;
      b.addEventListener("click", () => this.setColor(what, hex));
      frag.append(b);
    }
    if (what === "blur") {
      const t = this.blurTarget();
      frag.append(this.divider());
      frag.append(this.chip("Strength", () => this.slider({
        label: "Tint strength",
        value: t ? t.colorAmount : this.arm.colorAmount,
        min: 0, max: 1, step: 0.05, format: plainPct,
        onInput: (v) => { this.arm.colorAmount = v; if (t) t.colorAmount = v; },
        commit: "Tint strength",
        back: () => this.showSwatches("blur"),
        preview: false,
      }), { icon: "gauge", value: plainPct(t ? t.colorAmount : this.arm.colorAmount) }));
    }
    this.setStrip(frag);
  }

  private setColor(what: "blur" | "draw" | "text" | "frame", hex: string): void {
    switch (what) {
      case "blur": {
        const t = this.blurTarget();
        const was = this.snap("Tint");
        this.arm.color = hex;
        if (this.arm.colorAmount === 0) this.arm.colorAmount = 1;
        if (t) {
          t.color = hex;
          if (t.colorAmount === 0) t.colorAmount = 1;
          this.commit(was);
        }
        break;
      }
      case "draw": {
        this.pen.color = hex;
        this.pen.erase = false;
        break;
      }
      case "text": {
        this.textColor = hex;
        const t = this.textTarget();
        if (t) {
          const was = this.snap("Text colour");
          t.color = hex;
          this.commit(was);
        }
        break;
      }
      case "frame": {
        const was = this.snap("Frame colour");
        this.frame.color = hex;
        if (this.frame.width === 0) this.frame.width = 0.02;
        this.commit(was);
        break;
      }
    }
    this.showSwatches(what);
    this.draw();
  }

  private showLayers(): void {
    const back = this.iconBtn("chevron-left", "Back to options", () => this.showBlur());
    const frag = document.createDocumentFragment();
    frag.append(back);
    if (this.regions.length === 0) {
      frag.append(el("span.phe-question", { text: "Nothing added yet — draw on the picture" }));
    }
    for (const r of [...this.regions].reverse()) {
      if (r.id === this.markerId) continue;
      const b = this.chip(r.label, () => {
        this.selected = r.id;
        this.showLayers();
        this.draw();
      }, { icon: r.enabled ? "eye" : "eye-off", on: r.id === this.selected });
      const x = el<"button">("button.phe-chip-x", { type: "button", "aria-label": `Remove ${r.label}` });
      x.append(icon("x"));
      x.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const was = this.snap(`Remove ${r.label}`);
        this.regions = this.regions.filter((q) => q.id !== r.id);
        if (this.selected === r.id) this.selected = null;
        this.commit(was);
        this.showLayers();
      });
      frag.append(el("span.phe-layer", {}, b, x));
    }
    this.setStrip(frag);
  }

  private clearAll(): void {
    const keep = this.regions.filter((r) => r.id === this.markerId);
    if (keep.length === this.regions.length) return;
    const was = this.snap("Clear blurs");
    this.regions = keep;
    this.selected = null;
    this.commit(was);
    this.showBlur();
  }

  private async blurFaces(): Promise<void> {
    if (!this.source) return;
    this.host.say("Looking for faces…");
    await new Promise((r) => setTimeout(r, 0));
    // The edit may have ended while the message was drawing.
    if (!this.source) return;
    const { width, height } = this.source;
    const boxes = detectIn(this.source, width, height, PHOTO_DETECT);
    if (boxes.length === 0) {
      this.host.say("No faces found");
      return;
    }
    const was = this.snap("Blur faces");
    const fresh = newFaceRegions(this.regions, boxes, width, height);
    for (const r of fresh) {
      r.kind = this.style;
      this.dress(r);
      r.id = `face-${this.nextId++}`;
    }
    this.regions.push(...fresh);
    this.commit(was);
    this.host.say(`${fresh.length} ${fresh.length === 1 ? "face" : "faces"} blurred`);
    if (this.group === "blur") this.showBlur();
  }

  // ── Auto-blur ───────────────────────────────────────────────────────────

  /**
   * The per-run sheet, in the strip like everything else: one chip per
   * category to tick for this run, "Everything" to tick them all, "Go" to run.
   * The categories themselves — style, strength, padding — are configured in
   * Settings; this is only "which ones, this time".
   *
   * Nothing is pre-ticked on first use. Pre-filling from Settings (where
   * every detector is on by default) meant the user had to untick five
   * things to blur one, and the sheet is remembered between runs so the
   * second photo starts where the first one ended.
   *
   * Taps update the chips in place rather than rebuilding the strip: the
   * strip resets its scroll on every rebuild, which on a phone meant every
   * tick threw the row back to its left edge and the chip you were on was
   * off-screen again. Only Go and Everything change the count.
   */
  private showAutoSheet(): void {
    if (!this.autoPick) this.autoPick = loadAutoPick();
    const pick = this.autoPick;
    const frag = document.createDocumentFragment();
    const back = this.iconBtn("chevron-left", "Back to blur options", () => this.showBlur());
    back.classList.add("phe-slider-back");
    frag.append(back);
    frag.append(this.chip("Go", () => void this.runAuto([...AUTO_CATEGORIES].filter((c) => pick.has(c))), {
      icon: "sparkles", tool: "ai.auto.go", value: String(pick.size), disabled: this.autoBusy || pick.size === 0,
    }));
    frag.append(this.chip("Everything", () => {
      // Tapping it again when everything is ticked clears the lot: the one
      // gesture that would otherwise take seven taps.
      if (pick.size === AUTO_CATEGORIES.length) pick.clear();
      else for (const c of AUTO_CATEGORIES) pick.add(c);
      this.syncAutoSheet();
    }, {
      icon: "fill-all", tool: "ai.auto.all", on: pick.size === AUTO_CATEGORIES.length,
    }));
    frag.append(this.divider());
    for (const c of AUTO_CATEGORIES) {
      const tool = TOOLS.find((t) => t.id === `ai.${c}`);
      const usable = !tool || tool.kinds === "any" || tool.kinds.includes(this.kind);
      frag.append(this.chip(CATEGORY_NAMES[c].title, () => {
        if (pick.has(c)) pick.delete(c); else pick.add(c);
        this.syncAutoSheet();
      }, {
        icon: tool?.icon ?? "sparkles", tool: `ai.pick.${c}`, on: pick.has(c), disabled: !usable,
        why: tool?.hint ?? CATEGORY_NAMES[c].title,
      }));
    }
    this.setStrip(frag);
  }

  /** Reflect `autoPick` on the chips already in the strip; no rebuild, no scroll reset. */
  private syncAutoSheet(): void {
    const pick = this.autoPick;
    if (!pick) return;
    saveAutoPick(pick);
    const q = (tool: string): HTMLButtonElement | null =>
      this.strip.querySelector<HTMLButtonElement>(`[data-tool="${tool}"]`);
    for (const c of AUTO_CATEGORIES) q(`ai.pick.${c}`)?.setAttribute("aria-pressed", pick.has(c) ? "true" : "false");
    q("ai.auto.all")?.setAttribute("aria-pressed", pick.size === AUTO_CATEGORIES.length ? "true" : "false");
    const go = q("ai.auto.go");
    if (go) {
      const v = go.querySelector(".phe-chip-value");
      if (v) v.textContent = String(pick.size);
      go.disabled = this.autoBusy || pick.size === 0;
    }
  }

  /**
   * Run the detectors for `categories` and add one editable region per hit.
   *
   * Regions come back through `detectionsToRegions`, which skips anything
   * already under an enabled region — so Go twice does not stack. Timing goes
   * out through `perf()` because that is the only thing that reaches logcat
   * in a release build.
   */
  private async runAuto(categories: readonly AutoCategory[], label = "Auto-blur"): Promise<void> {
    if (!this.source || this.autoBusy) return;
    if (categories.length === 0) {
      this.host.say("Nothing ticked — choose what to look for");
      return;
    }
    this.autoBusy = true;
    const cfg = autoBlurStore().get();
    const names = categories.map((c) => CATEGORY_NAMES[c].many).join(", ");
    this.host.say(`Looking for ${names}…`);
    await new Promise((r) => setTimeout(r, 0));
    try {
      if (!this.source) return;
      const { width, height } = this.source;
      const needOcr = categories.some((c) => c === "terminals" || c === "cards" || c === "text");
      if (needOcr && !this.ocr) this.ocr = new Tesseract();
      const title = this.titleEl.textContent ?? "";
      const mime = /\.png$/i.test(title) ? "image/png" : /\.jpe?g$/i.test(title) ? "image/jpeg" : undefined;
      const input = prepareInput(this.source, width, height, {
        ocr: needOcr ? this.ocr : null,
        ...(mime ? { mime } : {}),
      });
      perf(`autoblur start ${categories.join("+")} ${input.width}x${input.height}`);
      const t0 = performance.now();
      const result = await detectAll(input, categories, {
        runner: getRunner(),
        config: cfg,
        onProgress: (_f, m) => this.host.say(m),
      });
      const ms = Object.entries(result.ms).map(([k, v]) => `${k}=${Math.round(v)}`).join(" ");
      perf(`autoblur done ${Math.round(performance.now() - t0)}ms ${result.detections.length} hits faces=${result.faceEngine} ${ms}`);
      if (!this.source) return;
      const fresh = detectionsToRegions(result.detections, input.width, input.height, cfg, this.regions);
      if (fresh.length === 0) {
        const why = result.notes.length ? ` (${result.notes[0]})` : "";
        this.host.say(result.detections.length > 0
          ? `All ${result.detections.length} already covered`
          : `No ${names} found${why}`);
        return;
      }
      const was = this.snap(label);
      this.regions.push(...fresh);
      this.selected = fresh[fresh.length - 1]?.id ?? null;
      this.commit(was);
      this.host.say(`${summarise(result.detections)} — blurred${result.notes.length ? ` · ${result.notes[0]}` : ""}`);
    } catch (e) {
      perf(`autoblur failed ${String(e).slice(0, 80)}`);
      this.host.say(`Auto-blur failed — ${String(e).slice(0, 60)}`);
    } finally {
      this.autoBusy = false;
      if (this.group === "blur") this.showBlur();
    }
  }

  /** `ai.plates` → ["plates"], `ai.auto` → everything switched on in Settings, else null. */
  private autoCategoriesFor(id: string): readonly AutoCategory[] | null {
    if (id === "ai.auto") return enabledCategories(autoBlurStore().get());
    const c = id.startsWith("ai.") ? id.slice(3) : "";
    return c !== "faces" && (AUTO_CATEGORIES as readonly string[]).includes(c) ? [c as AutoCategory] : null;
  }

  // ── Draw ────────────────────────────────────────────────────────────────

  /**
   * Draw is the brush with a solid colour: a marker. It reuses the blur
   * engine's `solid` kind at full tint, so a stroke exports exactly as drawn
   * and the whole thing costs no second pipeline.
   */
  private showDraw(): void {
    this.shape = "brush";
    const frag = document.createDocumentFragment();
    for (const [name, hex] of SWATCHES) {
      const b = el<"button">("button.phe-swatch", {
        type: "button", "aria-label": name, title: name,
        "aria-pressed": String(!this.pen.erase && hex === this.pen.color),
      });
      b.style.background = hex;
      b.addEventListener("click", () => { this.pen.color = hex; this.pen.erase = false; this.showDraw(); });
      frag.append(b);
    }
    frag.append(this.divider());
    frag.append(this.chip("Size", () => this.slider({
      label: "Pen size",
      value: Math.round(this.brushToSlider(this.pen.width) * 1000),
      min: 0, max: 1000, step: 1,
      format: (t) => this.brushLabel(this.sliderToBrush(t / 1000)),
      onInput: (t) => { this.pen.width = this.sliderToBrush(t / 1000); },
      commit: "Pen size",
      back: () => this.showDraw(),
      preview: false,
    }), { icon: "brush", value: this.brushLabel(this.pen.width) }));
    frag.append(this.chip("Opacity", () => this.slider({
      label: "Pen opacity",
      value: this.pen.opacity,
      min: 0.1, max: 1, step: 0.05, format: plainPct,
      onInput: (v) => {
        this.pen.opacity = v;
        const m = this.marker(false);
        if (m) m.opacity = v;
      },
      commit: "Pen opacity",
      back: () => this.showDraw(),
      preview: false,
    }), { icon: "opacity", value: plainPct(this.pen.opacity) }));
    frag.append(this.chip("Erase", () => { this.pen.erase = !this.pen.erase; this.showDraw(); }, {
      icon: "clear", on: this.pen.erase,
    }));
    frag.append(this.divider());
    frag.append(this.chip("Clear", () => {
      const m = this.marker(false);
      if (!m) return;
      const was = this.snap("Clear drawing");
      this.regions = this.regions.filter((r) => r.id !== m.id);
      this.markerId = null;
      this.commit(was);
      this.showDraw();
    }, { icon: "trash", disabled: !this.marker(false) }));
    this.setStrip(frag);
  }

  /** The marker region, created on first use. */
  private marker(create: boolean): BlurRegion | undefined {
    const have = this.regions.find((r) => r.id === this.markerId);
    if (have || !create) return have;
    const r = newRegion("brush", `pen${this.nextId++}`);
    r.kind = "solid";
    r.label = "Drawing";
    r.color = this.pen.color;
    r.colorAmount = 1;
    r.feather = 0;
    r.opacity = this.pen.opacity;
    this.regions.push(r);
    this.markerId = r.id;
    return r;
  }

  // ── Text ────────────────────────────────────────────────────────────────

  private showText(): void {
    const t = this.textTarget();
    const field = el<"input">("input.phe-field", {
      type: "text",
      placeholder: t ? "Edit caption" : "Type a caption",
      value: t?.text ?? "",
      "aria-label": "Caption text",
      autocapitalize: "sentences",
      autocomplete: "off",
      enterkeyhint: "done",
    });
    const put = (): void => {
      const text = field.value.trim();
      if (text === "") return;
      const cur = this.textTarget();
      if (cur) {
        if (cur.text === text) return;
        const was = this.snap("Edit text");
        cur.text = text;
        this.commit(was);
      } else {
        const was = this.snap("Add text");
        const item: TextItem = {
          id: `t${this.nextId++}`, text, x: 0.5, y: 0.5, size: this.textSize, color: this.textColor,
        };
        this.texts.push(item);
        this.selectedText = item.id;
        this.commit(was);
        this.host.say("Drag the caption to place it");
      }
      this.showText();
    };
    field.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { put(); field.blur(); } });
    field.addEventListener("change", put);

    const frag = document.createDocumentFragment();
    frag.append(field);
    frag.append(this.chip(t ? "Update" : "Add", put, { icon: t ? "check" : "plus" }));
    frag.append(this.divider());
    frag.append(this.chip("Size", () => this.slider({
      label: "Text size",
      value: t ? t.size : this.textSize,
      min: 0.02, max: 0.25, step: 0.005,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => { this.textSize = v; const c = this.textTarget(); if (c) c.size = v; },
      commit: "Text size",
      back: () => this.showText(),
      preview: false,
    }), { icon: "type", value: `${Math.round((t ? t.size : this.textSize) * 100)}%` }));
    frag.append(this.chip("Colour", () => this.showSwatches("text"), { icon: "palette" }));
    frag.append(this.divider());
    for (const item of this.texts) {
      frag.append(this.chip(item.text.length > 12 ? `${item.text.slice(0, 12)}…` : item.text, () => {
        this.selectedText = item.id;
        this.showText();
        this.draw();
      }, { on: item.id === this.selectedText }));
    }
    frag.append(this.chip("Delete", () => {
      const cur = this.textTarget();
      if (!cur) return;
      const was = this.snap("Delete text");
      this.texts = this.texts.filter((x) => x.id !== cur.id);
      this.selectedText = null;
      this.commit(was);
      this.showText();
    }, { icon: "trash", disabled: !t }));
    this.setStrip(frag);
  }

  private textTarget(): TextItem | undefined {
    return this.texts.find((t) => t.id === this.selectedText);
  }

  private drawTexts(): void {
    if (!this.canvas || this.texts.length === 0) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const short = Math.min(w, h);
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const t of this.texts) {
      const px = Math.max(8, t.size * short);
      ctx.font = `700 ${px}px system-ui, sans-serif`;
      ctx.shadowColor = "rgba(0,0,0,0.55)";
      ctx.shadowBlur = px * 0.12;
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x * w, t.y * h);
    }
    ctx.restore();
  }

  /** Approximate box of a caption in output coordinates, for hit-tests and the outline. */
  private textBox(t: TextItem): { x: number; y: number; w: number; h: number } {
    if (!this.canvas) return { x: t.x, y: t.y, w: 0, h: 0 };
    const w = this.canvas.width;
    const h = this.canvas.height;
    const short = Math.min(w, h);
    const px = Math.max(8, t.size * short);
    const bw = (px * 0.58 * Math.max(1, t.text.length)) / w;
    const bh = (px * 1.25) / h;
    return { x: t.x - bw / 2, y: t.y - bh / 2, w: bw, h: bh };
  }

  // ── Frame ───────────────────────────────────────────────────────────────

  private showFrame(): void {
    const frag = document.createDocumentFragment();
    const sizes: ReadonlyArray<readonly [string, number]> = [
      ["None", 0], ["Thin", 0.012], ["Medium", 0.03], ["Thick", 0.06], ["Wide", 0.1],
    ];
    for (const [label, width] of sizes) {
      frag.append(this.chip(label, () => {
        if (this.frame.width === width) return;
        const was = this.snap(width === 0 ? "Remove frame" : `${label} frame`);
        this.frame = { ...this.frame, width };
        this.commit(was);
        this.showFrame();
      }, { on: this.frame.width === width, tool: label === "Thin" ? "out.frame" : undefined }));
    }
    frag.append(this.divider());
    frag.append(this.chip("Colour", () => this.showSwatches("frame"), { icon: "palette" }));
    this.setStrip(frag);
  }

  private drawFrame(): void {
    if (!this.canvas || this.frame.width <= 0) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const t = this.frame.width * Math.min(w, h);
    ctx.save();
    ctx.fillStyle = this.frame.color;
    ctx.fillRect(0, 0, w, t);
    ctx.fillRect(0, h - t, w, t);
    ctx.fillRect(0, 0, t, h);
    ctx.fillRect(w - t, 0, t, h);
    ctx.restore();
  }

  // ── Host-owned groups: Sign, Auto, Share, More ──────────────────────────

  /** A group whose every tool is a panel the desktop owns. */
  private showHostGroup(group: ToolGroup): void {
    const frag = document.createDocumentFragment();
    const have = { native: this.host.native, ffmpeg: this.host.ffmpeg };
    for (const { tool, enabled, why } of groupTools(group, this.kind, have)) {
      frag.append(this.toolChip(tool, enabled, why));
    }
    this.setStrip(frag);
  }

  private showAuto(): void {
    const frag = document.createDocumentFragment();
    const have = { native: this.host.native, ffmpeg: this.host.ffmpeg };
    frag.append(this.chip("Enhance", () => this.autoEnhance(), { icon: "sparkles" }));
    for (const { tool, enabled, why } of groupTools("ai", this.kind, have)) {
      if (tool.id === "ai.faces") {
        frag.append(this.chip("Blur faces", () => void this.blurFaces(), { icon: tool.icon, tool: tool.id }));
        continue;
      }
      const cats = this.autoCategoriesFor(tool.id);
      if (cats) {
        frag.append(this.chip(tool.label, () => {
          this.open("blur");
          if (tool.id === "ai.auto") this.showAutoSheet();
          else void this.runAuto(cats, tool.label);
        }, { icon: tool.icon, tool: tool.id, disabled: !enabled, why }));
        continue;
      }
      frag.append(this.toolChip(tool, enabled, why));
    }
    this.setStrip(frag);
  }

  /** One tap: a gentle lift that suits most phone photographs. */
  private autoEnhance(): void {
    const was = this.snap("Auto enhance");
    this.light = {
      ...this.light,
      shadows: Math.min(1, this.light.shadows + 0.18),
      highlights: Math.max(-1, this.light.highlights - 0.1),
      contrast: Math.min(1, this.light.contrast + 0.08),
      vibrance: Math.min(1, this.light.vibrance + 0.2),
    };
    this.commit(was);
    this.host.say("Enhanced — Undo to compare");
  }

  private quality = 0.92;

  private showShare(): void {
    const frag = document.createDocumentFragment();
    const have = { native: this.host.native, ffmpeg: this.host.ffmpeg };
    const can = this.host.native && this.dirty;
    frag.append(this.chip("Save copy", () => void this.saveCopy(), {
      icon: "save", tool: "out.save", disabled: !can,
      why: !this.host.native ? "Needs the installed app" : !this.dirty ? "Nothing changed yet" : "Writes a new file beside the original",
    }));
    frag.append(this.chip("Save over original", () => this.confirmRow(
      "Replace the original file? This cannot be undone.",
      "Replace",
      () => void this.saveOver(),
    ), { icon: "trash", disabled: !can, why: "Replaces the original — asks first" }));
    frag.append(this.chip("Share", () => void this.shareCopy(), {
      icon: "share", tool: "out.share", disabled: !can, why: "Saves a copy, then shares it",
    }));
    frag.append(this.divider());
    for (const [label, q] of QUALITIES) {
      frag.append(this.chip(label, () => { this.quality = q; this.showShare(); }, {
        on: this.quality === q, tool: label === "Normal" ? "out.quality" : undefined,
        why: `JPEG quality ${Math.round(q * 100)}`,
      }));
    }
    frag.append(this.divider());
    for (const { tool, enabled, why } of groupTools("export", this.kind, have)) {
      if (tool.id === "out.save" || tool.id === "out.share" || tool.id === "out.quality" || tool.id === "out.frame") continue;
      frag.append(this.toolChip(tool, enabled, why));
    }
    this.setStrip(frag);
  }

  /** Every catalogue tool not placed in a group above. Keeps all 59 reachable. */
  private showMore(): void {
    const frag = document.createDocumentFragment();
    const have = { native: this.host.native, ffmpeg: this.host.ffmpeg };
    frag.append(this.chip("Undo", () => this.undo(), { icon: "undo", tool: "info.undo", disabled: this.history.length === 0 }));
    frag.append(this.chip("Redo", () => this.redo(), { icon: "redo", tool: "info.redo", disabled: this.future.length === 0 }));
    frag.append(this.divider());
    for (const group of ["adjust", "transform", "info"] as const) {
      for (const { tool, enabled, why } of groupTools(group, this.kind, have)) {
        if (PLACED.has(tool.id)) continue;
        frag.append(this.toolChip(tool, enabled, why));
      }
    }
    this.setStrip(frag);
  }

  private toolChip(tool: PhoneTool, enabled: boolean, why: string): HTMLButtonElement {
    return this.chip(tool.label, () => this.hostTool(tool), {
      icon: tool.icon, tool: tool.id, disabled: !enabled, why,
    });
  }

  /**
   * Hand a tool to the host. If there is unsaved work the host's panel would
   * take the screen and lose it, so the strip asks first.
   */
  private hostTool(tool: PhoneTool): void {
    const go = (): void => {
      if (!this.host.runTool(tool.id)) this.host.say(`${tool.label} — ${tool.hint}`);
    };
    if (!this.dirty) {
      go();
      return;
    }
    this.confirmRow(`Leave the edit for ${tool.label}? Unsaved changes are lost.`, "Leave", go, "Stay");
  }

  // ── Save & share ────────────────────────────────────────────────────────

  private async saveCopy(): Promise<void> {
    if (!this.dirty) {
      this.host.say("Nothing to save yet");
      return;
    }
    this.draw(false);
    const path = await this.host.save({ overwrite: false, quality: this.quality });
    if (path) this.host.leave();
    else this.draw();
  }

  private async saveOver(): Promise<void> {
    this.draw(false);
    const path = await this.host.save({ overwrite: true, quality: this.quality });
    if (path) this.host.leave();
    else this.open("share");
  }

  private async shareCopy(): Promise<void> {
    if (!this.dirty) {
      this.host.say("Nothing to share yet");
      return;
    }
    this.draw(false);
    const path = await this.host.save({ overwrite: false, quality: this.quality });
    if (!path) {
      this.draw();
      return;
    }
    try {
      await this.host.share(path);
    } catch {
      this.host.say("Nothing available to share to");
    }
    this.host.leave();
  }

  /** The edited picture, encoded. Null when nothing has been changed. */
  async encode(type: string, quality = 0.92): Promise<Uint8Array | null> {
    if (!this.canvas || !this.dirty) return null;
    const blob = await new Promise<Blob | null>((resolve) => {
      this.canvas?.toBlob(resolve, type, quality);
    });
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  }

  /** Strip the overlays before an export reads the canvas back. */
  clearHandles(): void {
    this.draw(false);
  }

  // ── Tool ids ────────────────────────────────────────────────────────────

  /**
   * Fire a tool by id, from outside. Every id in the catalogue lands somewhere:
   * the ones this editor implements act directly, the rest open their group's
   * strip so the chip is on screen, or go to the host.
   */
  runById(id: string): boolean {
    if (id === "panel.blur") {
      this.open("blur");
      return true;
    }
    if (id === "info.undo") { this.undo(); return true; }
    if (id === "info.redo") { this.redo(); return true; }

    const field = LIGHT_FIELD[id];
    if (field) {
      this.open("adjust");
      this.adjustSlider(field);
      return true;
    }
    if (id === "light.reset") { this.open("adjust"); this.resetLight(); return true; }

    if (id.startsWith("blur.kind.")) { this.open("blur"); this.setStyle(id.slice(10) as BlurKind); return true; }
    if (id.startsWith("blur.shape.")) { this.open("blur"); this.setShape(id.slice(11) as ShapeKind); return true; }

    switch (id) {
      case "blur.invert": this.open("blur"); this.patch("Invert", (r) => { r.invert = !r.invert; }); return true;
      case "blur.layers": this.open("blur"); this.showLayers(); return true;
      case "blur.clear": this.open("blur"); this.clearAll(); return true;
      case "ai.faces": this.open("blur"); void this.blurFaces(); return true;
      case "ai.auto": this.open("blur"); this.showAutoSheet(); return true;
      case "ai.plates": case "ai.screens": case "ai.terminals": case "ai.cards": case "ai.codes": case "ai.text": {
        const cats = this.autoCategoriesFor(id);
        this.open("blur");
        if (cats) void this.runAuto(cats, TOOLS.find((t) => t.id === id)?.label ?? "Auto-blur");
        return true;
      }
      case "adj.brush": this.open("blur"); this.brushSlider(); return true;
      case "adj.amount": this.open("blur"); this.regionSlider("Strength", "amount", 0, 0.25, 0.005, (v) => `${Math.round(v * 400)}%`); return true;
      case "adj.feather": this.open("blur"); this.regionSlider("Feather", "feather", 0, 0.1, 0.002, (v) => `${Math.round(v * 1000)}`); return true;
      case "adj.opacity": this.open("blur"); this.regionSlider("Opacity", "opacity", 0, 1, 0.02, plainPct); return true;
      case "adj.corners": this.open("blur"); this.regionSlider("Corners", "corners", 0, 0.5, 0.01, (v) => `${Math.round(v * 200)}%`); return true;
      case "adj.angle": this.open("blur"); this.regionSlider("Angle", "angle", 0, Math.PI * 2, 0.05, (v) => `${Math.round((v * 180) / Math.PI)}°`); return true;
      case "adj.color": this.open("blur"); this.showSwatches("blur"); return true;
      case "tf.rotate": this.open("crop"); this.turn(); return true;
      case "tf.flip": this.open("crop"); this.flip("x"); return true;
      case "tf.crop": this.open("crop"); return true;
      case "tf.resize": this.open("crop"); this.sizeSlider(); return true;
      case "out.save": this.open("share"); void this.saveCopy(); return true;
      case "out.share": this.open("share"); void this.shareCopy(); return true;
      case "out.quality": this.open("share"); return true;
      case "out.frame": this.open("frame"); return true;
      default: break;
    }

    const tool = TOOLS.find((t) => t.id === id);
    if (!tool) return false;
    const home = RAIL_HOME[tool.group];
    this.open(home);
    this.hostTool(tool);
    return true;
  }

  // ── History ─────────────────────────────────────────────────────────────

  private snap(label: string): Snap {
    return {
      regions: this.regions.map((r) => structuredClone(r)),
      geom: { ...this.geom, crop: { ...this.geom.crop } },
      light: { ...this.light },
      look: { ...this.look },
      texts: this.texts.map((t) => ({ ...t })),
      frame: { ...this.frame },
      label,
    };
  }

  private restore(s: Snap): void {
    this.regions = s.regions.map((r) => structuredClone(r));
    this.geom = { ...s.geom, crop: { ...s.geom.crop } };
    this.light = { ...s.light };
    this.look = { ...s.look };
    this.texts = s.texts.map((t) => ({ ...t }));
    this.frame = { ...s.frame };
    if (this.markerId && !this.regions.some((r) => r.id === this.markerId)) this.markerId = null;
    if (this.selected && !this.regions.some((r) => r.id === this.selected)) this.selected = null;
    if (this.selectedText && !this.texts.some((t) => t.id === this.selectedText)) this.selectedText = null;
  }

  /**
   * One committed change: the pre-state goes on the stack, the future is
   * cleared, the bar repaints, the canvas redraws. Every edit path ends here
   * exactly once.
   */
  private commit(before: Snap): void {
    this.history.push(before);
    if (this.history.length > HISTORY_CAP) this.history.shift();
    this.future = [];
    this.paintHistory();
    this.draw();
  }

  undo(): void {
    const prev = this.history.pop();
    if (!prev) return;
    this.future.push({ ...this.snap(prev.label) });
    this.restore(prev);
    this.cropRect = this.group === "crop" ? { x: 0, y: 0, w: 1, h: 1 } : null;
    this.paintHistory();
    this.draw();
    this.open(this.group);
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.history.push(this.snap(next.label));
    this.restore(next);
    this.cropRect = this.group === "crop" ? { x: 0, y: 0, w: 1, h: 1 } : null;
    this.paintHistory();
    this.draw();
    this.open(this.group);
  }

  /** Walk to a point in the history: `k` committed edits applied. */
  jumpTo(k: number): void {
    while (this.history.length > k && this.history.length > 0) this.undo();
    while (this.history.length < k && this.future.length > 0) this.redo();
  }

  /** The edits so far, as a row you can tap to jump back and forward in. */
  private showHistory(): void {
    const back = this.iconBtn("chevron-left", "Back to options", () => this.open(this.group));
    const frag = document.createDocumentFragment();
    frag.append(back);
    const total = this.history.length + this.future.length;
    const at = this.history.length;
    const labels: string[] = [
      ...this.history.map((s) => s.label),
      ...[...this.future].reverse().map((s) => s.label),
    ];
    frag.append(this.chip("Original", () => { this.jumpTo(0); this.showHistory(); }, {
      icon: "history", on: at === 0,
    }));
    for (let i = 0; i < total; i++) {
      const label = labels[i] ?? "Edit";
      frag.append(this.chip(`${i + 1} ${label}`, () => { this.jumpTo(i + 1); this.showHistory(); }, {
        on: at === i + 1,
      }));
    }
    this.setStrip(frag);
  }

  // ── Interaction on the picture ──────────────────────────────────────────

  /** Is a drag on the picture an edit right now, or a pan? */
  get armed(): boolean {
    switch (this.group) {
      case "crop": return true;
      case "draw": return true;
      case "text": return this.texts.length > 0;
      case "blur": return this.shape !== "full";
      default: return false;
    }
  }

  get busy(): boolean {
    return this.gesture !== "none";
  }

  /** Corner handle within reach of a tap, if any. Output coordinates. */
  private cornerAt(x: number, y: number): { x: number; y: number } | null {
    const c = this.cropRect;
    if (!c) return null;
    const tol = 0.06;
    for (const cx of [c.x, c.x + c.w]) {
      for (const cy of [c.y, c.y + c.h]) {
        if (Math.abs(x - cx) < tol && Math.abs(y - cy) < tol) {
          return { x: cx === c.x ? c.x + c.w : c.x, y: cy === c.y ? c.y + c.h : c.y };
        }
      }
    }
    return null;
  }

  private pendingSnap: Snap | null = null;

  dragStart(ox: number, oy: number): void {
    if (!this.source) return;

    if (this.group === "crop") {
      const c = this.cropRect ?? { x: 0, y: 0, w: 1, h: 1 };
      this.cropRect = c;
      const anchor = this.cornerAt(ox, oy);
      // A full-frame rectangle has nowhere to move to, so a drag inside it
      // draws a new one; anything smaller moves under the finger.
      if (anchor) {
        this.anchor = anchor;
        this.gesture = "crop-corner";
      } else if (this.cropPending() && ox > c.x && ox < c.x + c.w && oy > c.y && oy < c.y + c.h) {
        this.origin = { x: ox - c.x, y: oy - c.y };
        this.gesture = "crop-move";
      } else {
        this.origin = { x: ox, y: oy };
        this.anchor = { x: ox, y: oy };
        this.cropRect = { x: ox, y: oy, w: 0, h: 0 };
        this.gesture = "crop-new";
      }
      this.draw();
      return;
    }

    if (this.group === "text") {
      const hit = [...this.texts].reverse().find((t) => {
        const b = this.textBox(t);
        return ox >= b.x && ox <= b.x + b.w && oy >= b.y && oy <= b.y + b.h;
      });
      if (!hit) return;
      this.selectedText = hit.id;
      this.origin = { x: ox - hit.x, y: oy - hit.y };
      this.pendingSnap = this.snap("Move text");
      this.gesture = "text-move";
      this.draw();
      return;
    }

    const { x, y } = this.fromScreen(ox, oy);

    if (this.group === "draw") {
      this.pendingSnap = this.snap(this.pen.erase ? "Erase" : "Draw");
      const m = this.marker(true);
      if (!m) return;
      m.color = this.pen.color;
      this.stroke = { width: this.pen.width, points: [{ x, y }], erase: this.pen.erase };
      m.strokes.push(this.stroke);
      this.gesture = "paint";
      this.draw();
      return;
    }

    if (this.shape === "brush") {
      this.pendingSnap = this.snap("Brush");
      const r = this.brushRegion();
      this.stroke = { width: this.arm.brush, points: [{ x, y }], erase: false };
      r.strokes.push(this.stroke);
      this.gesture = "paint";
      this.draw();
      return;
    }

    const hit = regionAt(this.regions.filter((r) => r.id !== this.markerId), { x, y });
    if (hit && hit.shape !== "full") {
      this.pendingSnap = this.snap("Move");
      this.selected = hit.id;
      this.origin = { x: x - hit.rect.x, y: y - hit.rect.y };
      this.gesture = "move";
      return;
    }

    this.pendingSnap = this.snap(`Add ${this.shape}`);
    const r = newRegion(this.shape, `r${this.nextId++}`);
    r.kind = this.style;
    this.dress(r);
    r.label = `${this.shape} ${this.regions.length + 1}`;
    r.rect = { x, y, w: 0, h: 0 };
    this.regions.push(r);
    this.selected = r.id;
    this.origin = { x, y };
    this.gesture = "draw";
  }

  dragMove(ox: number, oy: number): void {
    switch (this.gesture) {
      case "crop-new":
      case "crop-corner": {
        const ax = this.anchor.x;
        const ay = this.anchor.y;
        let x = Math.max(0, Math.min(1, ox));
        let y = Math.max(0, Math.min(1, oy));
        if (this.cropRatio !== null) {
          // Lock the aspect: the drag sets the width, the height follows.
          const px = this.outPx();
          const want = this.ratioValue(this.cropRatio);
          const w = Math.abs(x - ax);
          const h = (w * px.w) / Math.max(1, px.h) / want;
          y = ay + Math.sign(y - ay || 1) * h;
          if (y < 0 || y > 1) {
            y = Math.max(0, Math.min(1, y));
            const hh = Math.abs(y - ay);
            const ww = (hh * want * px.h) / Math.max(1, px.w);
            x = ax + Math.sign(x - ax || 1) * ww;
          }
        }
        this.cropRect = {
          x: Math.min(ax, x), y: Math.min(ay, y), w: Math.abs(x - ax), h: Math.abs(y - ay),
        };
        this.draw();
        return;
      }
      case "crop-move": {
        const c = this.cropRect;
        if (!c) return;
        const x = Math.max(0, Math.min(1 - c.w, ox - this.origin.x));
        const y = Math.max(0, Math.min(1 - c.h, oy - this.origin.y));
        this.cropRect = { ...c, x, y };
        this.draw();
        return;
      }
      case "text-move": {
        const t = this.textTarget();
        if (!t) return;
        t.x = Math.max(0, Math.min(1, ox - this.origin.x));
        t.y = Math.max(0, Math.min(1, oy - this.origin.y));
        this.drawSoon();
        return;
      }
      default: break;
    }

    const { x, y } = this.fromScreen(ox, oy);

    if (this.gesture === "paint" && this.stroke) {
      const last = this.stroke.points[this.stroke.points.length - 1];
      if (!last || Math.hypot(x - last.x, y - last.y) > 0.004) {
        this.stroke.points.push({ x, y });
      }
      this.drawSoon();
      return;
    }

    const r = this.blurTarget();
    if (!r) return;

    if (this.gesture === "draw") {
      r.rect = {
        x: Math.min(this.origin.x, x),
        y: Math.min(this.origin.y, y),
        w: Math.abs(x - this.origin.x),
        h: Math.abs(y - this.origin.y),
      };
      this.drawSoon();
      return;
    }

    if (this.gesture === "move") {
      r.rect = { ...r.rect, x: x - this.origin.x, y: y - this.origin.y };
      this.drawSoon();
    }
  }

  dragEnd(): void {
    const g = this.gesture;
    this.gesture = "none";
    const before = this.pendingSnap;
    this.pendingSnap = null;

    if (g === "crop-new" || g === "crop-corner" || g === "crop-move") {
      const c = this.cropRect;
      // A tap rather than a drag clears back to the full frame.
      if (c && (c.w < 0.02 || c.h < 0.02)) this.cropRect = { x: 0, y: 0, w: 1, h: 1 };
      this.showCrop();
      this.draw();
      return;
    }

    if (g === "text-move") {
      if (before) this.commit(before);
      return;
    }

    if (g === "paint") {
      const s = this.stroke;
      this.stroke = null;
      // A single-point tap still paints a dot, which is what a tap with a
      // marker means. It counts as one edit.
      if (before && s) this.commit(before);
      if (this.group === "draw") this.showDraw();
      return;
    }

    if (g === "draw") {
      const r = this.blurTarget();
      // A tap that produced no rectangle is a tap, not a zero-size region.
      if (r && (r.rect.w < 0.01 || r.rect.h < 0.01)) {
        this.regions = this.regions.filter((x) => x.id !== r.id);
        this.selected = null;
        this.draw();
        return;
      }
      if (before) this.commit(before);
      this.showBlur();
      return;
    }

    if (g === "move") {
      if (before) this.commit(before);
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** The blur region a setting applies to: the selected one, else the newest. */
  private blurTarget(): BlurRegion | undefined {
    if (this.selected && this.selected !== this.markerId) {
      const found = this.regions.find((r) => r.id === this.selected);
      if (found) return found;
    }
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i];
      if (r && r.id !== this.markerId) return r;
    }
    return undefined;
  }

  /** Brush strokes accumulate into one region rather than one per stroke. */
  private brushRegion(): BlurRegion {
    const current = this.blurTarget();
    if (current && current.shape === "brush") return current;
    const r = newRegion("brush", `r${this.nextId++}`);
    r.kind = this.style;
    this.dress(r);
    r.label = "Painted";
    this.regions.push(r);
    this.selected = r.id;
    return r;
  }

  private patch(label: string, fn: (r: BlurRegion) => void): void {
    const r = this.blurTarget();
    if (!r) {
      this.host.say("Add a blur first");
      return;
    }
    const was = this.snap(label);
    fn(r);
    this.commit(was);
    if (this.group === "blur") this.showBlur();
  }

  private dress(r: BlurRegion): void {
    r.amount = this.arm.amount;
    r.feather = this.arm.feather;
    r.opacity = this.arm.opacity;
    r.corners = this.arm.corners;
    r.angle = this.arm.angle;
    r.color = this.arm.color;
    r.colorAmount = this.arm.colorAmount;
  }

  private fromScreen(x: number, y: number): Point {
    if (!this.source || isIdentity(this.geom)) return { x, y };
    return toSource(this.geom, this.source.width, this.source.height, { x, y });
  }

  private outPx(): { w: number; h: number } {
    if (!this.source) return { w: 0, h: 0 };
    return outSize(this.geom, this.source.width, this.source.height);
  }

  // ── Overlays ────────────────────────────────────────────────────────────

  /** Dim outside the crop, thirds inside it, a handle on each corner. */
  private drawCropOverlay(): void {
    const c = this.cropRect;
    if (!this.canvas || this.group !== "crop" || !c) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;

    const w = this.canvas.width;
    const h = this.canvas.height;
    const line = Math.max(2, Math.round(Math.min(w, h) / 300));
    const rx = c.x * w;
    const ry = c.y * h;
    const rw = c.w * w;
    const rh = c.h * h;

    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, 0, w, ry);
    ctx.fillRect(0, ry + rh, w, h - (ry + rh));
    ctx.fillRect(0, ry, rx, rh);
    ctx.fillRect(rx + rw, ry, w - (rx + rw), rh);

    ctx.strokeStyle = "#fff";
    ctx.lineWidth = line;
    ctx.strokeRect(rx, ry, rw, rh);

    ctx.globalAlpha = 0.45;
    ctx.lineWidth = Math.max(1, line / 2);
    for (let i = 1; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(rx + (rw * i) / 3, ry);
      ctx.lineTo(rx + (rw * i) / 3, ry + rh);
      ctx.moveTo(rx, ry + (rh * i) / 3);
      ctx.lineTo(rx + rw, ry + (rh * i) / 3);
      ctx.stroke();
    }

    // Corner handles: an L in each corner, thick enough to see under a thumb.
    ctx.globalAlpha = 1;
    ctx.lineWidth = line * 3;
    const arm = Math.min(rw, rh) * 0.12;
    const corners: Array<[number, number, number, number]> = [
      [rx, ry, 1, 1], [rx + rw, ry, -1, 1], [rx, ry + rh, 1, -1], [rx + rw, ry + rh, -1, -1],
    ];
    for (const [x, y, sx, sy] of corners) {
      ctx.beginPath();
      ctx.moveTo(x, y + sy * arm);
      ctx.lineTo(x, y);
      ctx.lineTo(x + sx * arm, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** A dashed outline around the selected blur region or caption. */
  private drawHandles(): void {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const line = Math.max(2, Math.round(Math.min(w, h) / 300));

    let box: { x: number; y: number; w: number; h: number } | null = null;

    if (this.group === "text") {
      const t = this.textTarget();
      if (t) box = this.textBox(t);
    } else if (this.group === "blur") {
      const r = this.regions.find((x) => x.id === this.selected);
      if (r && r.shape !== "full" && r.shape !== "brush") {
        box = r.rect;
        if (this.source && !isIdentity(this.geom)) {
          const sw = this.source.width;
          const sh = this.source.height;
          const a = toOutput(this.geom, sw, sh, { x: r.rect.x, y: r.rect.y });
          const b = toOutput(this.geom, sw, sh, { x: r.rect.x + r.rect.w, y: r.rect.y + r.rect.h });
          box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
        }
      }
    }
    if (!box) return;

    ctx.save();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = line;
    ctx.setLineDash([line * 4, line * 3]);
    ctx.strokeRect(box.x * w, box.y * h, box.w * w, box.h * h);
    ctx.restore();
  }
}

// ── Static maps ───────────────────────────────────────────────────────────

/** Adjust fields back to `light.*` ids, for the chips' `data-tool` tags. */
const LIGHT_FIELD_ID: Partial<Record<keyof Adjust, string>> = Object.fromEntries(
  Object.entries(LIGHT_FIELD).map(([id, field]) => [field, id]),
) as Partial<Record<keyof Adjust, string>>;

/** Which rail group a catalogue group's host tools open in. */
const RAIL_HOME: Readonly<Record<ToolGroup, RailId>> = {
  light: "adjust",
  blur: "blur",
  shape: "blur",
  adjust: "more",
  transform: "more",
  sign: "sign",
  ai: "auto",
  export: "share",
  info: "more",
};

/** Tool ids that have a chip in a named group, so More does not repeat them. */
const PLACED: ReadonlySet<string> = new Set([
  ...Object.keys(LIGHT_FIELD), "light.reset",
  "adj.brush", "adj.amount", "adj.feather", "adj.opacity", "adj.corners", "adj.angle", "adj.color",
  "tf.rotate", "tf.flip", "tf.crop", "tf.resize",
  "info.undo", "info.redo",
]);

/** Where a tool id lands. Exported for the harness. */
export function railFor(id: string): RailId {
  if (id === "panel.blur" || id.startsWith("blur.") || id === "ai.faces" ||
    id === "ai.auto" ||
    /^adj\.(brush|amount|feather|opacity|corners|angle|color)$/.test(id)) return "blur";
  if (id.startsWith("light.")) return "adjust";
  if (/^tf\.(rotate|flip|crop|resize)$/.test(id)) return "crop";
  if (id === "out.frame") return "frame";
  if (id === "info.undo" || id === "info.redo") return "more";
  const tool = TOOLS.find((t) => t.id === id);
  return tool ? RAIL_HOME[tool.group] : "more";
}
