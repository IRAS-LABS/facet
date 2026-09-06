/**
 * Photo viewer and editor.
 *
 * One surface, two modes. View mode is a fast look: fit-or-100%, wheel zoom
 * anchored at the cursor, arrow keys through the folder. Edit mode reveals the
 * blur stack on the same canvas — no separate window, no "open in editor"
 * round-trip, because the whole point of the shell is that a file is one
 * keypress from being worked on.
 *
 * The canvas is always the full source resolution and is scaled by CSS. That
 * means the preview and the export run the identical `renderBlur` call, so a
 * blur that looks tight on screen is tight in the file. Previewing at viewport
 * resolution would be faster and would quietly lie about edge softness.
 */

import {
  newRegion,
  renderBlur,
  regionAt,
  type BlurKind,
  type BlurRegion,
  type ShapeKind,
  type Stroke,
} from "@core/edit/blur";
import {
  applyAdjust,
  isNeutral as lightIsNeutral,
  noAdjust,
  type Adjust,
} from "@core/edit/color";
import { formatSize, type FileEntry, type FileKind } from "@core/explorer/types";
import { drop, flush, load, save } from "@core/undo/store";
import { detectIn, newFaceRegions, PHOTO_DETECT } from "@core/vision/apply";
import { detectAll, detectionsToRegions, summarise } from "@core/vision/autoblur";
import { AUTO_CATEGORIES, CATEGORY_NAMES, enabledCategories, type AutoCategory } from "@core/vision/autoblur-config";
import { prepareInput } from "@core/vision/autoblur-image";
import { getRunner } from "@core/vision/onnx-runner";
import { autoBlurStore } from "@core/phone/autoblur-prefs";
import { Tesseract } from "@core/ocr/engine";

import { EditRail, type RailStatus } from "./edit-rail";
import type { PhoneTool } from "./phone/tools";

export interface ViewerHost {
  /** Full-resolution URL for a path. */
  fileUrl(path: string): Promise<string>;
  writeFile(path: string, bytes: Uint8Array, overwrite: boolean): Promise<string>;
  openExternal(path: string): Promise<void>;
  /**
   * Hand this photo to the signing view.
   *
   * Optional because the viewer is also constructed where there is no signing
   * view to hand it to, and the shell having one should not be a fact this
   * file guesses at -- `railTarget` asks whether the function is there and
   * drops the whole Sign category when it is not, which keeps it one fact in
   * one place.
   */
  sign?(path: string, mode?: "sign" | "redact" | "crop"): void;
}

const SHAPES: ReadonlyArray<readonly [ShapeKind, string, string]> = [
  ["rect", "▭", "Rectangle — drag the corners tight"],
  ["ellipse", "◯", "Ellipse"],
  ["polygon", "⬠", "Lasso — click points, double-click to close"],
  ["brush", "✎", "Brush — paint the mask freehand"],
  ["linear", "▤", "Band — tilt-shift across the frame"],
  ["radial", "◎", "Spot — round falloff"],
  ["full", "▣", "Whole image"],
];

const KINDS: ReadonlyArray<readonly [BlurKind, string]> = [
  ["gaussian", "Gaussian"],
  ["box", "Box"],
  ["pixelate", "Pixelate"],
  ["mosaic", "Mosaic"],
  ["motion", "Motion"],
  ["radial", "Radial"],
  ["frosted", "Frosted"],
  ["solid", "Solid"],
];

/** Handle positions on the bounding box, as fractions of it. */
const HANDLES: ReadonlyArray<readonly [string, number, number]> = [
  ["nw", 0, 0], ["n", 0.5, 0], ["ne", 1, 0],
  ["w", 0, 0.5], ["e", 1, 0.5],
  ["sw", 0, 1], ["s", 0.5, 1], ["se", 1, 1],
];

let seq = 0;
const nextId = (): string => `r${++seq}`;

/*
 * Which catalogue tool means what here (item 2).
 *
 * The category bar is driven by `@ui/phone/tools`, which is the whole catalogue
 * and knows nothing about which surface implements what. These three tables are
 * this surface's half of that contract: an id in one of them is a tool the
 * desktop photo editor actually wires up, and an id in none of them is a tool
 * whose category still appears -- because other tools in it are routed -- but
 * whose row says so instead of doing nothing.
 *
 * Tables rather than a switch with fifty cases so that the answer to "does the
 * desktop have this?" is one lookup, used by both the bar's filtering and the
 * row's enabled state. Two code paths disagreeing about that is how you get a
 * category with one live row in it.
 */

/** `light.*` ids to the field on `Adjust` they move. */
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

/**
 * `adj.*` ids to the selected region's setting they move.
 *
 * `adj.brush` is absent on purpose: brush width on the desktop is the wheel
 * over the canvas while the brush is held, not a slider in the panel, so there
 * is no control for a menu row to jump to. Routing it would put a row in the
 * menu that focuses nothing.
 */
const ADJ_PARAM: Readonly<Record<string, string>> = {
  "adj.amount": "amount",
  "adj.feather": "feather",
  "adj.opacity": "opacity",
  "adj.corners": "corners",
  "adj.angle": "angle",
  "adj.color": "color",
};

/**
 * The rows that hand the file to another view entirely.
 *
 * Grouped because whether they appear is one question -- does the shell have a
 * signing view -- and asking it id by id is how the two newest ones came to be
 * missing from the desktop rail while working on the phone.
 */
const SIGN_ROWS: ReadonlySet<string> = new Set([
  "sign.doc",
  "sign.mark",
  "sign.redact",
  "sign.crop",
]);

/** Ids that do something rather than move something. */
const RAIL_ACTS: ReadonlySet<string> = new Set([
  "light.reset",
  "sign.doc",
  "sign.mark",
  "sign.redact",
  "sign.crop",
  "blur.invert",
  "blur.clear",
  "blur.layers",
  "ai.faces",
  "out.save",
  "info.undo",
  "info.redo",
  "info.openwith",
]);

/** Where a catalogue id lands in this editor. */
type RailTarget =
  | { at: "shape"; shape: ShapeKind }
  | { at: "kind"; kind: BlurKind }
  | { at: "light"; field: keyof Adjust }
  | { at: "param"; key: string }
  | { at: "act"; id: string };

/** The reason a row is greyed, said once so every row says it the same way. */
const NEEDS_REGION = "Select a region in the list first — this changes the one you picked";

export class Viewer {
  private readonly root: HTMLElement;
  private readonly canvas = document.createElement("canvas");
  private readonly overlay = document.createElement("div");
  private readonly panel = document.createElement("aside");
  private readonly title = document.createElement("div");
  private readonly hint = document.createElement("div");

  private entries: FileEntry[] = [];
  private index = 0;
  private img: HTMLImageElement | null = null;

  private regions: BlurRegion[] = [];
  /**
   * Light and colour for the whole picture (item 1).
   *
   * One set of adjustments, not one per region: a photograph has a single
   * exposure. The blur regions are objects laid *on* the picture and each
   * carries its own settings; this is a property *of* the picture, and giving
   * it a layer list would invite the question of what two disagreeing
   * exposures on one image are supposed to mean.
   */
  private light: Adjust = noAdjust();
  private selected: string | null = null;
  private editing = false;
  private tool: ShapeKind | null = null;

  private zoom = 1;
  private fitZoom = 1;
  private panX = 0;
  private panY = 0;

  /**
   * Which panel groups are open, by heading (item 2).
   *
   * Held here rather than read off the DOM because `buildPanel` throws the
   * panel away and rebuilds it on every commit, and a group that collapsed
   * itself every time you nudged a slider would be worse than the single long
   * scroll this replaces.
   */
  private openGroups = new Set<string>(["Add", "Light & colour", "Regions"]);

  /** rAF handle for `drawSoon`. 0 when no redraw is scheduled. */
  private pendingDraw = 0;

  /**
   * The category bar and its dropdowns (item 2), at the top of the panel.
   *
   * The bar answers "where is that tool" and the panel below it stays about the
   * picture in front of you — the regions on it, the settings of the selected
   * one, the nine light sliders. That split is the point: a menu is a thing you
   * open and it closes again, so the tools stop competing for the same column
   * as the work.
   *
   * Declared as a field initialiser rather than built in the constructor
   * because the host below only ever reaches `this` through arrow functions,
   * which are not called until the bar is on screen.
   */
  private readonly rail = new EditRail({
    // This viewer opens photographs; `load` decodes through `<img>` and nothing
    // else reaches it. Reporting the real kind rather than the open file's
    // means the catalogue greys the video and audio tools with its own reason
    // instead of this file having to invent one.
    kind: (): FileKind => "image",
    routes: (t: PhoneTool): boolean => this.railTarget(t) !== null,
    status: (t: PhoneTool): RailStatus => this.railStatus(t),
    run: (t: PhoneTool): void => this.railRun(t),
    say: (m: string): void => {
      this.hint.textContent = m;
    },
  });

  /** Undo is a stack of edit snapshots; images are never mutated. */
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** Whether this photo currently has a row in the durable store. */
  private saved = false;

  constructor(private readonly host: ViewerHost) {
    this.root = document.createElement("div");
    this.root.className = "viewer";
    this.root.hidden = true;

    const stage = document.createElement("div");
    stage.className = "viewer-stage";
    this.canvas.className = "viewer-canvas";
    this.overlay.className = "viewer-overlay";
    stage.append(this.canvas, this.overlay);

    const bar = document.createElement("header");
    bar.className = "viewer-bar";
    this.title.className = "viewer-title";
    bar.append(
      this.btn("‹", "Previous  (←)", () => this.step(-1)),
      this.btn("›", "Next  (→)", () => this.step(1)),
      this.title,
      this.btn("−", "Zoom out", () => this.setZoom(this.zoom / 1.25)),
      this.btn("⤢", "Fit  (0)", () => this.fit()),
      this.btn("1:1", "Actual size  (1)", () => this.setZoom(1)),
      this.btn("+", "Zoom in", () => this.setZoom(this.zoom * 1.25)),
      this.btn("✎ Edit", "Blur & edit  (E)", () => this.toggleEdit()),
      this.btn("↗", "Open in the default app", () => void this.openExternal()),
      this.btn("✕", "Close  (Esc)", () => this.close()),
    );

    this.panel.className = "viewer-panel";
    this.panel.hidden = true;

    this.hint.className = "viewer-hint";

    this.root.append(bar, stage, this.panel, this.hint);
    document.body.appendChild(this.root);

    this.wireStage(stage);
    this.wireKeys();
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async open(entries: FileEntry[], entry: FileEntry): Promise<void> {
    this.entries = entries.filter((e) => e.kind === "image");
    this.index = Math.max(0, this.entries.findIndex((e) => e.path === entry.path));
    this.root.hidden = false;
    await this.load();
  }

  close(): void {
    // Before anything is cleared. The debounce that keeps a drag smooth is the
    // same half-second in which closing the viewer would drop the last stroke.
    void flush();
    this.root.hidden = true;
    this.img = null;
    this.regions = [];
    this.light = noAdjust();
    this.undoStack = [];
    this.redoStack = [];
    this.saved = false;
    this.editing = false;
    this.panel.hidden = true;
    this.root.querySelector(".viewer-restored")?.remove();
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** What this surface is showing, for the session record. Null when closed. */
  get openPath(): string | null {
    return this.isOpen ? (this.current()?.path ?? null) : null;
  }

  private current(): FileEntry | null {
    return this.entries[this.index] ?? null;
  }

  private async load(): Promise<void> {
    const entry = this.current();
    if (!entry) return;
    // Regions belong to the image they were drawn on. Carrying them to the
    // next photo would silently blur a different face at the same coordinates.
    this.regions = [];
    this.light = noAdjust();
    this.selected = null;
    this.undoStack = [];
    this.redoStack = [];
    this.saved = false;
    this.root.querySelector(".viewer-restored")?.remove();

    this.title.textContent = `${entry.name}   ${formatSize(entry.size)}`;
    try {
      const url = await this.host.fileUrl(entry.path);
      const img = await loadImage(url);
      this.img = img;
      this.title.textContent =
        `${entry.name}   ${img.naturalWidth}×${img.naturalHeight}   ${formatSize(entry.size)}`;
      this.fit();
      this.draw();
    } catch (e) {
      this.img = null;
      this.title.textContent = `${entry.name} — cannot decode (${String(e)})`;
    }
    this.buildPanel();
    await this.restore(entry);
  }

  private step(dir: number): void {
    if (this.entries.length === 0) return;
    this.index = (this.index + dir + this.entries.length) % this.entries.length;
    void this.load();
  }

  private async openExternal(): Promise<void> {
    const e = this.current();
    if (e) await this.host.openExternal(e.path);
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  private draw(): void {
    const img = this.img;
    if (!img) return;
    renderBlur(this.canvas, img, img.naturalWidth, img.naturalHeight, this.regions);
    // Light after blur, so a redaction is graded along with everything else
    // rather than sitting on the picture at a different exposure. `isNeutral`
    // guards the expensive path inside, so an untouched photo pays nothing.
    //
    // This is also all it takes to make the adjustments export: `saveCopy`
    // hands this very canvas to `toBlob`, so what is written is what was on
    // screen, with no second render path that could disagree with the first.
    applyAdjust(this.canvas, this.light);
    this.layout();
  }

  /**
   * Redraw at most once per frame.
   *
   * A dragged slider fires `input` far faster than a full-resolution repaint
   * can finish, and `applyAdjust` walks every pixel of what may be a 45 MP
   * canvas. Without coalescing, the queue of half-finished repaints outlives
   * the gesture and the control lags a second behind the thumb.
   */
  private drawSoon(): void {
    if (this.pendingDraw !== 0) return;
    this.pendingDraw = requestAnimationFrame(() => {
      this.pendingDraw = 0;
      this.draw();
    });
  }

  /** CSS-scale the full-res canvas into the viewport. */
  private layout(): void {
    const img = this.img;
    if (!img) return;
    this.canvas.style.width = `${img.naturalWidth * this.zoom}px`;
    this.canvas.style.height = `${img.naturalHeight * this.zoom}px`;
    this.canvas.style.transform = `translate(${this.panX}px, ${this.panY}px)`;
    this.overlay.style.width = this.canvas.style.width;
    this.overlay.style.height = this.canvas.style.height;
    this.overlay.style.transform = this.canvas.style.transform;
    this.drawHandles();
  }

  private fit(): void {
    const img = this.img;
    if (!img) return;
    const box = this.root.getBoundingClientRect();
    const avail = box.width - (this.editing ? 300 : 0) - 48;
    this.fitZoom = Math.min(avail / img.naturalWidth, (box.height - 120) / img.naturalHeight, 1);
    this.zoom = this.fitZoom;
    this.panX = 0;
    this.panY = 0;
    this.layout();
  }

  private setZoom(z: number, anchor?: { x: number; y: number }): void {
    const next = Math.max(0.02, Math.min(24, z));
    if (anchor) {
      // Keep the pixel under the cursor under the cursor.
      const k = next / this.zoom;
      this.panX = anchor.x - (anchor.x - this.panX) * k;
      this.panY = anchor.y - (anchor.y - this.panY) * k;
    }
    this.zoom = next;
    this.layout();
  }

  // ── Stage interaction ───────────────────────────────────────────────────

  private wireStage(stage: HTMLElement): void {
    stage.addEventListener("wheel", (e) => {
      e.preventDefault();
      const box = stage.getBoundingClientRect();
      this.setZoom(this.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), {
        x: e.clientX - box.left - box.width / 2,
        y: e.clientY - box.top - box.height / 2,
      });
    }, { passive: false });

    this.overlay.addEventListener("pointerdown", (e) => this.onOverlayDown(e));

    // Middle-drag and plain drag in view mode pan the image.
    stage.addEventListener("pointerdown", (e) => {
      if (this.editing && e.button === 0 && e.target === this.overlay && this.tool) return;
      if (e.button !== 1 && !(e.button === 0 && !this.editing)) return;
      e.preventDefault();
      const sx = e.clientX - this.panX;
      const sy = e.clientY - this.panY;
      const move = (m: PointerEvent): void => {
        this.panX = m.clientX - sx;
        this.panY = m.clientY - sy;
        this.layout();
      };
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });

    window.addEventListener("resize", () => this.layout());
  }

  /** Pointer position in normalised image space (0..1). */
  private norm(e: PointerEvent): { x: number; y: number } {
    const box = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - box.left) / box.width,
      y: (e.clientY - box.top) / box.height,
    };
  }

  private onOverlayDown(e: PointerEvent): void {
    if (!this.editing || e.button !== 0) return;
    const p = this.norm(e);

    if (this.tool === "brush") {
      this.paint(e);
      return;
    }
    if (this.tool === "polygon") {
      this.addPolygonPoint(p);
      return;
    }
    if (this.tool) {
      this.dragNew(e, this.tool);
      return;
    }

    const hit = regionAt(this.regions, p);
    this.selected = hit ? hit.id : null;
    this.buildPanel();
    this.drawHandles();
    if (hit && hit.shape !== "full") this.dragMove(e, hit);
  }

  /** Drag out a brand-new rect/ellipse/band/spot. */
  private dragNew(e: PointerEvent, shape: ShapeKind): void {
    const start = this.norm(e);
    const r = newRegion(shape, nextId());
    r.label = `${shape} ${this.regions.length + 1}`;
    r.rect = { x: start.x, y: start.y, w: 0, h: 0 };
    if (shape === "full") {
      this.pushUndo();
      this.regions.push(r);
      this.selected = r.id;
      this.tool = null;
      this.commit();
      return;
    }
    this.pushUndo();
    this.regions.push(r);
    this.selected = r.id;

    const move = (m: PointerEvent): void => {
      const q = this.norm(m);
      r.rect = {
        x: Math.min(start.x, q.x),
        y: Math.min(start.y, q.y),
        w: Math.abs(q.x - start.x),
        h: Math.abs(q.y - start.y),
      };
      this.draw();
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      // A click with no drag would leave a zero-area region that can never be
      // grabbed again; give it a default box instead of stranding it.
      if (r.rect.w < 0.005 || r.rect.h < 0.005) {
        r.rect = { x: Math.max(0, start.x - 0.1), y: Math.max(0, start.y - 0.1), w: 0.2, h: 0.2 };
      }
      this.tool = null;
      this.commit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private dragMove(e: PointerEvent, r: BlurRegion): void {
    const start = this.norm(e);
    const orig = { ...r.rect };
    this.pushUndo();
    const move = (m: PointerEvent): void => {
      const q = this.norm(m);
      r.rect = { ...orig, x: orig.x + (q.x - start.x), y: orig.y + (q.y - start.y) };
      this.draw();
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.commit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private dragHandle(e: PointerEvent, r: BlurRegion, id: string): void {
    e.stopPropagation();
    const orig = { ...r.rect };
    this.pushUndo();
    const move = (m: PointerEvent): void => {
      const q = this.norm(m);
      let { x, y, w, h } = orig;
      if (id.includes("w")) { w = orig.x + orig.w - q.x; x = q.x; }
      if (id.includes("e")) { w = q.x - orig.x; }
      if (id.includes("n")) { h = orig.y + orig.h - q.y; y = q.y; }
      if (id.includes("s")) { h = q.y - orig.y; }
      // Normalise a dragged-through-itself box rather than letting w go
      // negative — a negative box breaks roundRect and the hit test both.
      if (w < 0) { x += w; w = -w; }
      if (h < 0) { y += h; h = -h; }
      r.rect = { x, y, w, h };
      this.draw();
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.commit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private paint(e: PointerEvent): void {
    let r = this.regions.find((x) => x.id === this.selected && x.shape === "brush");
    if (!r) {
      r = newRegion("brush", nextId());
      r.label = `brush ${this.regions.length + 1}`;
      this.pushUndo();
      this.regions.push(r);
      this.selected = r.id;
    } else {
      this.pushUndo();
    }
    const stroke: Stroke = { width: 0.06, points: [this.norm(e)], erase: e.shiftKey };
    r.strokes.push(stroke);

    const move = (m: PointerEvent): void => {
      stroke.points.push(this.norm(m));
      this.draw();
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.commit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    this.draw();
  }

  private addPolygonPoint(p: { x: number; y: number }): void {
    let r = this.regions.find((x) => x.id === this.selected && x.shape === "polygon");
    if (!r) {
      r = newRegion("polygon", nextId());
      r.label = `lasso ${this.regions.length + 1}`;
      this.regions.push(r);
      this.selected = r.id;
    }
    this.pushUndo();
    r.points.push(p);
    // The bounding box is what the hit test and the radial centre use, so it
    // has to track the points rather than staying at the default.
    const xs = r.points.map((q) => q.x);
    const ys = r.points.map((q) => q.y);
    r.rect = {
      x: Math.min(...xs), y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
    };
    this.commit();
  }

  // ── Handles ─────────────────────────────────────────────────────────────

  private drawHandles(): void {
    this.overlay.replaceChildren();
    this.overlay.dataset["edit"] = String(this.editing);
    if (!this.editing) return;

    for (const r of this.regions) {
      const box = document.createElement("div");
      box.className = "vr-box";
      if (r.id === this.selected) box.dataset["sel"] = "true";
      if (!r.enabled) box.dataset["off"] = "true";
      box.style.left = `${r.rect.x * 100}%`;
      box.style.top = `${r.rect.y * 100}%`;
      box.style.width = `${r.rect.w * 100}%`;
      box.style.height = `${r.rect.h * 100}%`;
      this.overlay.append(box);

      if (r.id !== this.selected || r.shape === "full") continue;
      for (const [id, fx, fy] of HANDLES) {
        const h = document.createElement("i");
        h.className = "vr-handle";
        h.dataset["h"] = id;
        h.style.left = `${(r.rect.x + r.rect.w * fx) * 100}%`;
        h.style.top = `${(r.rect.y + r.rect.h * fy) * 100}%`;
        h.addEventListener("pointerdown", (e) => this.dragHandle(e, r, id));
        this.overlay.append(h);
      }
    }
  }

  // ── Undo ────────────────────────────────────────────────────────────────

  /** Everything an undo step has to put back. */
  private snapshot(): string {
    return JSON.stringify({ regions: this.regions, light: this.light });
  }

  /**
   * Restore a snapshot in either shape.
   *
   * Snapshots outlive the session -- `persist` writes the undo stack to the
   * durable store -- so a stack saved before light and colour existed is a
   * bare region array and has to keep working. An array means "regions only,
   * neutral light", which is exactly what those edits were.
   */
  private restoreSnapshot(json: string): void {
    const v = JSON.parse(json) as BlurRegion[] | { regions: BlurRegion[]; light: Adjust };
    if (Array.isArray(v)) {
      this.regions = v;
      this.light = noAdjust();
      return;
    }
    this.regions = v.regions;
    this.light = v.light;
  }

  private pushUndo(): void {
    this.undoStack.push(this.snapshot());
    // 60 steps is generous for an edit session and bounded for memory; the
    // snapshots are region lists, not pixels, so each is a few hundred bytes.
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(this.snapshot());
    this.restoreSnapshot(prev);
    this.commit();
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.snapshot());
    this.restoreSnapshot(next);
    this.commit();
  }

  // ── Persistence ─────────────────────────────────────────────────────────
  //
  // Undo that dies with the window is a feature of the session, not of the
  // work. Every change — including an undo, which is itself a change worth not
  // losing — queues the whole stack to disk under the path of the photo. The
  // write is debounced and never awaited: an editor that waits on its own
  // autosave stutters on the stroke that triggered it.

  private persist(): void {
    const entry = this.current();
    if (!entry) return;
    // Nothing drawn and nothing to undo is not a document. Writing one would
    // mean every photo merely *looked at* leaves a row behind, and the restore
    // note would then fire on files that were never edited.
    // A photo carrying only a colour grade is still an unfinished edit. Before
    // light existed, "no regions" meant "nothing drawn"; now it does not, and
    // without this clause a graded photo would be dropped from the store on
    // the way out and the work lost with it.
    if (
      this.regions.length === 0 &&
      this.undoStack.length === 0 &&
      lightIsNeutral(this.light)
    ) {
      if (this.saved) { this.saved = false; void drop(entry.path); }
      return;
    }
    this.saved = true;
    save({
      key: entry.path,
      kind: "photo",
      state: this.snapshot(),
      undo: this.undoStack,
      redo: this.redoStack,
      at: Date.now(),
      size: entry.size,
      modified: entry.modified,
    });
  }

  /** Take back whatever was left unfinished on this photo, if anything was. */
  private async restore(entry: FileEntry): Promise<void> {
    const doc = await load(entry.path, entry);
    // `load` is async and the user may have paged on to the next photo while
    // it was in flight; regions belong to the image they were drawn on.
    if (!doc || this.current()?.path !== entry.path) return;
    try {
      this.restoreSnapshot(doc.state);
    } catch {
      return;
    }
    this.undoStack = doc.undo;
    this.redoStack = doc.redo;
    this.saved = true;
    // Not commit(): that would write the document straight back and reset the
    // "restored from" time to now, which is the one thing the note needs.
    this.draw();
    this.buildPanel();
    this.drawHandles();
    this.noteRestored(entry, doc.at, doc.stale);
  }

  private noteRestored(entry: FileEntry, at: number, stale: boolean): void {
    const bar = document.createElement("div");
    bar.className = `viewer-restored${stale ? " is-stale" : ""}`;
    const n = this.regions.length;
    bar.append(
      Object.assign(document.createElement("span"), {
        textContent: stale
          // Said plainly, because the alternative is a user compositing old
          // regions onto a photo that has since been replaced and not knowing.
          ? `${n} unsaved ${n === 1 ? "region" : "regions"} restored from ${when(at)}` +
            " — but this file has changed on disk since. Check them before saving."
          : `${n} unsaved ${n === 1 ? "region" : "regions"} restored from ${when(at)}.`,
      }),
      this.btn("Discard", "Throw the restored edits away", () => {
        this.regions = [];
        this.light = noAdjust();
        this.undoStack = [];
        this.redoStack = [];
        this.saved = false;
        void drop(entry.path);
        bar.remove();
        this.commit();
        this.drawHandles();
      }),
      this.btn("✕", "Dismiss", () => { bar.remove(); }),
    );
    this.root.append(bar);
  }

  /**
   * Repaint, rebuild the panel, and queue the save.
   *
   * The panel is always rebuilt, including after an undo. It used to take a
   * flag to skip that, and undo passed it -- but undo is exactly the case that
   * needs it: putting a deleted region back has to put its row back in the
   * Regions list too, and a stale list offers controls for a region that is no
   * longer there. The flag survived long enough for both of its branches to be
   * written the same way, which is the form this replaces.
   */
  private commit(): void {
    this.draw();
    this.buildPanel();
    this.persist();
  }

  // ── Panel ───────────────────────────────────────────────────────────────

  private toggleEdit(): void {
    this.editing = !this.editing;
    this.panel.hidden = !this.editing;
    // A dropdown left hanging over a panel that has just been hidden is a menu
    // floating on the photo with nothing to dismiss it.
    if (!this.editing) this.rail.close();
    this.hint.textContent = this.editing
      ? "pick a shape, drag it on the photo  ·  shift-drag with the brush erases  ·  ctrl+Z undo"
      : "";
    this.fit();
    this.buildPanel();
    this.drawHandles();
  }

  /** `section`, wired to the remembered open/closed state. */
  private group(title: string, body: HTMLElement): HTMLElement {
    return section(title, body, this.openGroups.has(title), (open) => {
      if (open) this.openGroups.add(title);
      else this.openGroups.delete(title);
    });
  }

  /**
   * Light and colour, as nine sliders (item 1).
   *
   * Built from a table rather than nine hand-written blocks for the reason
   * `paramsFor` is: the field name is the write target, so a renamed heading
   * cannot quietly detach a slider from the value it is supposed to move.
   * The ranges match the phone's to the step, so the same photo graded on
   * either shows the same numbers.
   */
  private lightPanel(): HTMLElement {
    const box = document.createElement("div");
    box.className = "vp-params";

    const rows: ReadonlyArray<readonly [string, keyof Adjust, number, number]> = [
      ["Exposure", "exposure", -1, 1],
      ["Brightness", "brightness", -1, 1],
      ["Contrast", "contrast", -1, 1],
      ["Saturation", "saturation", -1, 1],
      ["Warmth", "warmth", -1, 1],
      ["Highlights", "highlights", -1, 1],
      ["Shadows", "shadows", -1, 1],
      ["Sharpen", "sharpness", 0, 1],
      ["Vignette", "vignette", 0, 1],
    ];

    for (const [label, field, min, max] of rows) {
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.step = "0.02";
      input.value = String(this.light[field]);
      // What `railRun` jumps to when a Light & colour row is picked. The field
      // name, so the menu and the slider cannot drift apart.
      input.dataset["light"] = field;
      const out = document.createElement("output");
      const show = (v: number): string =>
        min < 0 ? `${v > 0 ? "+" : ""}${Math.round(v * 100)}%` : `${Math.round(v * 100)}%`;
      out.textContent = show(this.light[field]);
      input.addEventListener("input", () => {
        const v = Number(input.value);
        this.light[field] = v;
        out.textContent = show(v);
        // Coalesced: a full-resolution grade cannot keep up with `input`.
        this.drawSoon();
      });
      // One undo entry per gesture, not per pixel of slider travel -- the same
      // rule the blur sliders follow, so Undo means the same thing in both.
      input.addEventListener("pointerdown", () => this.pushUndo());
      input.addEventListener("change", () => this.persist());
      box.append(labelled(label, input, out));
    }

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "vp-reset";
    reset.textContent = "Reset light & colour";
    reset.title = "Put every slider above back to neutral. The blur regions are left alone.";
    reset.addEventListener("click", () => {
      if (lightIsNeutral(this.light)) return;
      this.pushUndo();
      this.light = noAdjust();
      this.commit();
    });
    box.append(reset);
    return box;
  }

  private buildPanel(): void {
    if (!this.editing) return;
    this.panel.replaceChildren();

    // The bar first, and rebuilt with the panel: which categories have anything
    // live behind them changes with the selection, and a bar that answered for
    // the previous photo is worse than no bar.
    this.panel.append(this.rail.element);
    this.rail.refresh();

    const tools = document.createElement("div");
    tools.className = "vp-tools";
    for (const [shape, glyph, tip] of SHAPES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "vp-tool";
      b.textContent = glyph;
      b.title = tip;
      if (this.tool === shape) b.dataset["on"] = "true";
      b.addEventListener("click", () => this.pickShape(shape));
      tools.append(b);
    }

    // Detection is a shortcut for drawing, so it lives with the shapes rather
    // than in a mode of its own. What it produces is ordinary ellipses in the
    // list below, which is the whole point: the detector will be wrong
    // sometimes, and a wrong region you can drag off is a shrug where a wrong
    // one baked into the pixels is a ruined photo.
    const faces = document.createElement("button");
    faces.type = "button";
    faces.className = "vp-faces";
    faces.textContent = "Find faces";
    faces.title = "Detect faces and add a blur over each one. Every result stays editable.";
    faces.addEventListener("click", () => void this.blurFaces(faces));

    // Auto-blur: the same categories the phone has. Chips tick what this run
    // looks for (pre-set from the shared Auto-blur settings), the button runs
    // them, and every hit lands in the list below as an ordinary region.
    const picks = document.createElement("div");
    picks.className = "vp-tools vp-auto-picks";
    if (!this.autoPick) this.autoPick = new Set(enabledCategories(autoBlurStore().get()));
    for (const c of AUTO_CATEGORIES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "vp-tool vp-auto-pick";
      b.dataset["cat"] = c;
      b.textContent = CATEGORY_NAMES[c].title;
      b.title = `Look for ${CATEGORY_NAMES[c].many} on the next Auto-blur`;
      if (this.autoPick.has(c)) b.dataset["on"] = "true";
      b.addEventListener("click", () => {
        const pick = this.autoPick!;
        if (pick.has(c)) pick.delete(c); else pick.add(c);
        b.dataset["on"] = pick.has(c) ? "true" : "false";
      });
      picks.append(b);
    }
    const auto = document.createElement("button");
    auto.type = "button";
    auto.className = "vp-faces vp-auto";
    auto.textContent = "Auto-blur";
    auto.title = "Find everything ticked above — plates, screens, terminals, cards, codes, text — and blur each one. Every result stays editable.";
    auto.addEventListener("click", () => void this.autoBlur(auto));
    this.panel.append(this.group("Add", tools), faces, this.group("Auto-blur", picks), auto);

    // Light and colour sits above the region list because it applies to the
    // whole picture: the thing you reach for first, and the thing that does
    // not need a region selected before it will do anything.
    this.panel.append(this.group("Light & colour", this.lightPanel()));

    // Layer list, topmost first — the order regions are composited in.
    const layers = document.createElement("div");
    layers.className = "vp-layers";
    [...this.regions].reverse().forEach((r) => {
      const row = document.createElement("div");
      row.className = "vp-layer";
      if (r.id === this.selected) row.dataset["sel"] = "true";

      const eye = document.createElement("button");
      eye.type = "button";
      eye.className = "vp-eye";
      eye.textContent = r.enabled ? "◉" : "○";
      eye.title = "Show / hide this region";
      eye.addEventListener("click", (e) => {
        e.stopPropagation();
        this.pushUndo();
        r.enabled = !r.enabled;
        this.commit();
      });

      const name = document.createElement("input");
      name.className = "vp-name";
      name.value = r.label;
      name.addEventListener("change", () => { r.label = name.value; });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "vp-del";
      del.textContent = "✕";
      del.title = "Remove";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.pushUndo();
        this.regions = this.regions.filter((x) => x.id !== r.id);
        if (this.selected === r.id) this.selected = null;
        this.commit();
      });

      row.append(eye, name, del);
      row.addEventListener("click", () => {
        this.selected = r.id;
        this.commit();
        this.drawHandles();
      });
      layers.append(row);
    });
    if (this.regions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "vp-empty";
      empty.textContent = "No blur yet. Pick a shape above and drag it on the photo.";
      layers.append(empty);
    }
    this.panel.append(this.group("Regions", layers));

    const sel = this.regions.find((r) => r.id === this.selected);
    if (sel) this.panel.append(this.paramsFor(sel));

    const actions = document.createElement("div");
    actions.className = "vp-actions";
    actions.append(
      this.btn("↶", "Undo  (ctrl+Z)", () => this.undo()),
      this.btn("↷", "Redo  (ctrl+shift+Z)", () => this.redo()),
    );
    const save = document.createElement("button");
    save.className = "vp-save";
    save.type = "button";
    save.textContent = "Save a copy";
    save.title = "Writes <name>-facet.png next to the original. The original is never touched.";
    save.addEventListener("click", () => void this.saveCopy(save));
    this.panel.append(section("", actions), save);
  }

  /**
   * The parameter panel is generated from the region, not hand-built per shape.
   * That is the keystone decision paying off early: adding a blur kind or a
   * knob means editing the schema below, and batch, presets and the op graph
   * pick it up without a second UI.
   */
  private paramsFor(r: BlurRegion): HTMLElement {
    const box = document.createElement("div");
    box.className = "vp-params";

    const kind = document.createElement("select");
    kind.className = "vp-select";
    for (const [k, label] of KINDS) {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = label;
      kind.append(o);
    }
    kind.value = r.kind;
    kind.addEventListener("change", () => {
      this.pushUndo();
      r.kind = kind.value as BlurKind;
      this.commit();
    });
    box.append(labelled("Type", kind));

    const sliders: ReadonlyArray<readonly [string, keyof BlurRegion, number, number, number]> = [
      ["Strength", "amount", 0, 0.25, 0.002],
      ["Feather", "feather", 0, 0.15, 0.002],
      ["Opacity", "opacity", 0, 1, 0.01],
      ["Colour", "colorAmount", 0, 1, 0.01],
      ["Corners", "corners", 0, 0.5, 0.01],
      ["Angle", "angle", 0, 360, 1],
    ];
    for (const [label, key, min, max, step] of sliders) {
      // Angle and corners only mean something for some shapes/kinds; showing a
      // dead slider is worse than showing none.
      if (key === "corners" && r.shape !== "rect") continue;
      if (key === "angle" && !["linear", "motion"].includes(r.shape === "linear" ? "linear" : r.kind)) continue;
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(r[key] as number);
      input.dataset["param"] = key;
      const out = document.createElement("output");
      out.textContent = fmt(key, r[key] as number);
      input.addEventListener("input", () => {
        (r[key] as number) = Number(input.value);
        out.textContent = fmt(key, Number(input.value));
        this.draw();
      });
      // One undo entry per gesture, not per pixel of slider travel.
      input.addEventListener("pointerdown", () => this.pushUndo());
      box.append(labelled(label, input, out));
    }

    const colour = document.createElement("input");
    colour.type = "color";
    colour.className = "vp-colour";
    colour.value = r.color;
    colour.dataset["param"] = "color";
    colour.addEventListener("input", () => {
      r.color = colour.value;
      this.draw();
    });
    box.append(labelled("Tint", colour));

    const inv = document.createElement("button");
    inv.type = "button";
    inv.className = "vp-toggle";
    inv.textContent = r.invert ? "Protecting this area" : "Blurring this area";
    inv.title = "Flip between blurring the shape and blurring everything except it";
    inv.addEventListener("click", () => {
      this.pushUndo();
      r.invert = !r.invert;
      this.commit();
    });
    box.append(inv);

    return section("Settings", box);
  }

  // ── The category bar ───────────────────────────────────────

  /** Where a catalogue tool lands here, or null if this surface has no answer. */
  private railTarget(t: PhoneTool): RailTarget | null {
    const shape = t.id.startsWith("blur.shape.") ? t.id.slice(11) : null;
    // Matched against `SHAPES` rather than cast, because the catalogue and this
    // file are two lists of shapes, and a name added to one and not the other
    // has to fall out of the bar rather than into a click that does nothing.
    if (shape !== null) {
      const hit = SHAPES.find(([k]) => k === shape);
      return hit ? { at: "shape", shape: hit[0] } : null;
    }
    const kind = t.id.startsWith("blur.kind.") ? t.id.slice(10) : null;
    if (kind !== null) {
      const hit = KINDS.find(([k]) => k === kind);
      return hit ? { at: "kind", kind: hit[0] } : null;
    }
    // The one pair whose availability is not a property of this file: signing
    // happens in another view, and whether there is one is the shell's answer.
    if (SIGN_ROWS.has(t.id) && !this.host.sign) return null;
    const field = LIGHT_FIELD[t.id];
    if (field !== undefined) return { at: "light", field };
    const key = ADJ_PARAM[t.id];
    if (key !== undefined) return { at: "param", key };
    return RAIL_ACTS.has(t.id) ? { at: "act", id: t.id } : null;
  }

  /**
   * Whether a row can act, why not, and whether it names the setting in force.
   *
   * `why` is a sentence in every branch, including the ones that succeed:
   * `ContextMenu` puts the whole string on the row's `title`, so this is the
   * tooltip a working row gets as well as the explanation a greyed one owes
   * the person who clicked it.
   */
  private railStatus(t: PhoneTool): RailStatus {
    const target = this.railTarget(t);
    if (!target) {
      return { enabled: false, why: "Not part of the desktop photo editor", on: false };
    }
    const sel = this.regions.find((r) => r.id === this.selected) ?? null;
    switch (target.at) {
      case "shape":
        return { enabled: true, why: t.hint, on: this.tool === target.shape };
      case "kind":
        if (!sel) return { enabled: false, why: NEEDS_REGION, on: false };
        return { enabled: true, why: t.hint, on: sel.kind === target.kind };
      case "light":
        // "In use" means off neutral, which for all nine is zero -- see
        // `noAdjust`. So a closed Light & colour still says which of its
        // sliders are doing something.
        return { enabled: true, why: t.hint, on: this.light[target.field] !== 0 };
      case "param":
        if (!sel) return { enabled: false, why: NEEDS_REGION, on: false };
        // `paramsFor` omits the corners slider for anything but a box, so the
        // row would otherwise jump to a control that is not on screen.
        if (target.key === "corners" && sel.shape !== "rect") {
          return { enabled: false, why: "Only a box region has corners to round", on: false };
        }
        return { enabled: true, why: t.hint, on: false };
      case "act":
        return this.railActStatus(target.id, t, sel);
    }
  }

  private railActStatus(id: string, t: PhoneTool, sel: BlurRegion | null): RailStatus {
    switch (id) {
      case "light.reset": {
        const neutral = lightIsNeutral(this.light);
        return {
          enabled: !neutral,
          why: neutral ? "Every slider is already neutral" : t.hint,
          on: false,
        };
      }
      case "blur.invert":
        if (!sel) return { enabled: false, why: NEEDS_REGION, on: false };
        return { enabled: true, why: t.hint, on: sel.invert };
      case "blur.clear":
        return this.regions.length > 0
          ? { enabled: true, why: t.hint, on: false }
          : { enabled: false, why: "There are no regions to clear", on: false };
      case "blur.layers":
        return { enabled: true, why: t.hint, on: this.openGroups.has("Regions") };
      case "ai.faces":
        return this.img
          ? { enabled: true, why: t.hint, on: false }
          : { enabled: false, why: "No photo is open", on: false };
      case "sign.doc":
      case "sign.mark":
      case "sign.redact":
      case "sign.crop": {
        if (!this.current()) return { enabled: false, why: "No photo is open", on: false };
        // Both rows open the same view; the watermark is a control inside it,
        // so Watermark says where it is going rather than pretending to be a
        // second destination.
        const where =
          id === "sign.mark"
            ? "Opens the signing view, where the watermark lives"
            : t.hint;
        // The unsaved-work note is said plainly rather than by greying the row,
        // because the edit is not lost -- it is still here when you come back.
        // Greying would imply the two surfaces cannot both be used on one
        // photo, which is wrong; what is true is that signing opens the file as
        // it is on disk.
        const clean = this.regions.length === 0 && lightIsNeutral(this.light);
        return {
          enabled: true,
          why: clean
            ? where
            : `${where} — as it is on disk. Save a copy first if you want the` +
              " blur and colour signed in",
          on: false,
        };
      }
      case "info.undo":
        return this.undoStack.length > 0
          ? { enabled: true, why: t.hint, on: false }
          : { enabled: false, why: "Nothing to undo yet", on: false };
      case "info.redo":
        return this.redoStack.length > 0
          ? { enabled: true, why: t.hint, on: false }
          : { enabled: false, why: "Nothing to redo", on: false };
      default:
        // `out.save` and `info.openwith`: both need a file and nothing else.
        return this.current()
          ? { enabled: true, why: t.hint, on: false }
          : { enabled: false, why: "No photo is open", on: false };
    }
  }

  private railRun(t: PhoneTool): void {
    const target = this.railTarget(t);
    if (!target) return;
    switch (target.at) {
      case "shape":
        this.pickShape(target.shape);
        return;
      case "kind": {
        const sel = this.regions.find((r) => r.id === this.selected);
        if (!sel) return;
        this.pushUndo();
        sel.kind = target.kind;
        this.commit();
        return;
      }
      case "light":
        // Open the section before looking for the slider: a closed `<details>`
        // still has its children in the tree, so focusing one inside it lands
        // on a control nobody can see.
        this.openGroups.add("Light & colour");
        this.buildPanel();
        this.reveal(`[data-light="${target.field}"]`);
        return;
      case "param":
        this.reveal(`[data-param="${target.key}"]`);
        return;
      case "act":
        this.railAct(target.id);
        return;
    }
  }

  private railAct(id: string): void {
    switch (id) {
      case "light.reset":
        this.pushUndo();
        this.light = noAdjust();
        this.commit();
        return;
      case "blur.invert": {
        const sel = this.regions.find((r) => r.id === this.selected);
        if (!sel) return;
        this.pushUndo();
        sel.invert = !sel.invert;
        this.commit();
        return;
      }
      case "blur.clear":
        this.pushUndo();
        this.regions = [];
        this.selected = null;
        this.commit();
        this.drawHandles();
        return;
      case "blur.layers":
        this.openGroups.add("Regions");
        this.buildPanel();
        this.reveal(".vp-layers");
        return;
      case "info.undo":
        this.undo();
        return;
      case "info.redo":
        this.redo();
        return;
      case "info.openwith":
        void this.openExternal();
        return;
      case "sign.doc":
      case "sign.mark":
      case "sign.redact":
      case "sign.crop": {
        const entry = this.current();
        if (!entry || !this.host.sign) return;
        // Closed first: the signing view is a full-screen surface, and leaving
        // this one open underneath means an Escape out of it lands back on a
        // photo whose panel still claims to be the thing in front of you.
        this.close();
        this.host.sign(
          entry.path,
          id === "sign.redact" ? "redact" : id === "sign.crop" ? "crop" : "sign",
        );
        return;
      }
      default:
        // `ai.faces` and `out.save` both run through a button that reports its
        // own progress in its own label. Clicking the live button rather than
        // calling the method keeps that feedback where it already is, instead
        // of growing a second, quieter path that says nothing.
        this.panel
          .querySelector<HTMLButtonElement>(id === "ai.faces" ? ".vp-faces" : ".vp-save")
          ?.click();
    }
  }

  /** Pick a shape to draw with, or drop a whole-image region if that is it. */
  private pickShape(shape: ShapeKind): void {
    if (shape === "full") {
      const r = newRegion("full", nextId());
      r.label = "whole image";
      this.pushUndo();
      this.regions.push(r);
      this.selected = r.id;
      this.tool = null;
      this.commit();
      this.drawHandles();
      return;
    }
    this.tool = this.tool === shape ? null : shape;
    this.buildPanel();
  }

  /**
   * Scroll a control into view and say which one it was.
   *
   * The menu row that sent you here has closed by the time this runs, so
   * without the outline the only trace of the trip is a focus ring on one of
   * nine identical slider tracks. It fades on its own rather than on the next
   * click, because clearing it would mean another listener for something a
   * second and a bit of highlight says just as well.
   */
  private reveal(selector: string): void {
    const el = this.panel.querySelector<HTMLElement>(selector);
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    el.focus();
    const row = el.closest<HTMLElement>(".vp-row") ?? el;
    row.dataset["lit"] = "true";
    window.setTimeout(() => {
      delete row.dataset["lit"];
    }, 1400);
  }

  // ── Faces ───────────────────────────────────────────────────────────────

  /**
   * Detect, and add one editable ellipse per face (item 19).
   *
   * Synchronous once it starts — the detector is a tight loop over an integral
   * image with no await in it, so a 12 MP photo locks the frame for a second or
   * two. Rather than pretend otherwise with a spinner that cannot paint, the
   * button says what it is doing and a paint is forced before the work begins.
   * Moving this to a worker is the right answer and is a change to `detect.ts`'s
   * callers, not to `detect.ts`; it is deliberately not being smuggled in here.
   *
   * Faces already under an enabled region are skipped, so pressing the button
   * twice does not stack a second blur on the first one's work, and pressing it
   * after covering a face by hand leaves that hand-drawn region alone.
   */
  private async blurFaces(btn: HTMLButtonElement): Promise<void> {
    const img = this.img;
    if (!img) return;
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Looking…";
    // Two frames: one to paint the label, one because a single rAF fires before
    // the style change has been composited.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    try {
      const boxes = detectIn(img, img.naturalWidth, img.naturalHeight, PHOTO_DETECT);
      const fresh = newFaceRegions(this.regions, boxes, img.naturalWidth, img.naturalHeight);

      if (fresh.length === 0) {
        // Three different facts, said as three different sentences. "0 faces"
        // for a photo whose faces are already blurred is a bug report waiting
        // to happen.
        btn.textContent =
          boxes.length === 0 ? "No faces found" : `All ${boxes.length} already covered`;
      } else {
        this.pushUndo();
        this.regions.push(...fresh);
        this.selected = fresh[fresh.length - 1]?.id ?? null;
        this.commit();
        this.drawHandles();
        btn.textContent = `Blurred ${fresh.length} ${fresh.length === 1 ? "face" : "faces"}`;
      }
      this.hint.textContent =
        fresh.length > 0
          ? "drag any face region to move it, corners to resize, ✕ in the list to remove it"
          : this.hint.textContent;
    } catch (e) {
      btn.textContent = `Failed: ${String(e).slice(0, 40)}`;
    } finally {
      btn.disabled = false;
      // buildPanel() rebuilds this button from scratch, so the restore has to
      // survive a rebuild having already replaced the node — hence writing to
      // the live one by class rather than to the captured reference.
      window.setTimeout(() => {
        const live = this.panel.querySelector(".vp-faces");
        if (live) live.textContent = was;
      }, 2600);
    }
  }

  // ── Auto-blur ───────────────────────────────────────────────────────────

  /** Categories ticked for the next run; null until the panel is first built. */
  private autoPick: Set<AutoCategory> | null = null;
  private ocr: Tesseract | null = null;

  /**
   * The desktop twin of the phone editor's `runAuto`: detect for the ticked
   * categories and add one editable region per hit, skipping anything already
   * covered so a second press does not stack.
   */
  private async autoBlur(btn: HTMLButtonElement): Promise<void> {
    const img = this.img;
    if (!img) return;
    const categories = AUTO_CATEGORIES.filter((c) => this.autoPick?.has(c));
    if (categories.length === 0) {
      btn.textContent = "Tick a category first";
      window.setTimeout(() => { btn.textContent = "Auto-blur"; }, 2000);
      return;
    }
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Looking…";
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const cfg = autoBlurStore().get();
      const needOcr = categories.some((c) => c === "terminals" || c === "cards" || c === "text");
      if (needOcr && !this.ocr) this.ocr = new Tesseract();
      const mime = /\.png$/i.test(img.src) ? "image/png" : undefined;
      const input = prepareInput(img, img.naturalWidth, img.naturalHeight, {
        ocr: needOcr ? this.ocr : null, ...(mime ? { mime } : {}),
      });
      const result = await detectAll(input, categories, {
        runner: getRunner(), config: cfg,
        onProgress: (_f, m) => { btn.textContent = m; },
      });
      const fresh = detectionsToRegions(result.detections, input.width, input.height, cfg, this.regions);
      if (fresh.length === 0) {
        btn.textContent = result.detections.length === 0
          ? `Nothing found${result.notes.length ? ` — ${result.notes[0]}` : ""}`
          : `All ${result.detections.length} already covered`;
      } else {
        this.pushUndo();
        this.regions.push(...fresh);
        this.selected = fresh[fresh.length - 1]?.id ?? null;
        this.commit();
        this.drawHandles();
        btn.textContent = `Blurred ${summarise(result.detections)}`;
        this.hint.textContent = "drag any region to move it, corners to resize, ✕ in the list to remove it";
      }
    } catch (e) {
      btn.textContent = `Failed: ${String(e).slice(0, 40)}`;
    } finally {
      btn.disabled = false;
      window.setTimeout(() => {
        const live = this.panel.querySelector(".vp-auto");
        if (live) live.textContent = was;
      }, 3200);
    }
  }

  // ── Export ──────────────────────────────────────────────────────────────

  private async saveCopy(btn: HTMLButtonElement): Promise<void> {
    const entry = this.current();
    if (!entry) return;
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const blob = await new Promise<Blob | null>((res) =>
        this.canvas.toBlob((b) => res(b), "image/png"),
      );
      if (!blob) throw new Error("encode failed");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const dot = entry.path.lastIndexOf(".");
      const stem = dot > 0 ? entry.path.slice(0, dot) : entry.path;
      const out = await this.host.writeFile(`${stem}-facet.png`, bytes, false);
      btn.textContent = `Saved  ${out.split("/").pop()}`;
    } catch (e) {
      btn.textContent = `Failed: ${String(e).slice(0, 40)}`;
    } finally {
      btn.disabled = false;
      window.setTimeout(() => { btn.textContent = was; }, 2600);
    }
  }

  // ── Keys ────────────────────────────────────────────────────────────────

  private wireKeys(): void {
    window.addEventListener("keydown", (e) => {
      if (this.root.hidden) return;
      if (e.target instanceof HTMLInputElement && e.target.type !== "range") return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
        return;
      }
      switch (e.key) {
        case "Escape": e.preventDefault(); this.close(); break;
        case "ArrowLeft": e.preventDefault(); this.step(-1); break;
        case "ArrowRight": e.preventDefault(); this.step(1); break;
        case "0": this.fit(); break;
        case "1": this.setZoom(1); break;
        case "e": case "E": this.toggleEdit(); break;
        case "Delete": case "Backspace":
          if (this.editing && this.selected) {
            e.preventDefault();
            this.pushUndo();
            this.regions = this.regions.filter((x) => x.id !== this.selected);
            this.selected = null;
            this.commit();
          }
          break;
        default: break;
      }
    });
  }

  private btn(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "viewer-btn";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * A titled block of the edit panel.
 *
 * Titled blocks are `<details>`, which is the dropdown the desktop half of
 * item 2 asked for: every group is one click from open and none of them can
 * push another off the bottom of a scroll. Untitled blocks -- the action row
 * -- stay a plain `<div>`, because a disclosure triangle over two icon buttons
 * is a control that hides less than it costs.
 *
 * `<details>` rather than a hand-rolled toggle so the arrow, the keyboard and
 * the accessibility tree come from the platform instead of from three more
 * event listeners.
 */
function section(
  title: string,
  body: HTMLElement,
  open = true,
  onToggle?: (open: boolean) => void,
): HTMLElement {
  if (!title) {
    const plain = document.createElement("div");
    plain.className = "vp-section";
    plain.append(body);
    return plain;
  }
  const s = document.createElement("details");
  s.className = "vp-section";
  s.open = open;
  const h = document.createElement("summary");
  h.className = "vp-summary";
  h.textContent = title;
  s.append(h, body);
  if (onToggle) s.addEventListener("toggle", () => onToggle(s.open));
  return s;
}

function labelled(label: string, ...controls: HTMLElement[]): HTMLElement {
  const row = document.createElement("label");
  row.className = "vp-row";
  const s = document.createElement("span");
  s.textContent = label;
  row.append(s, ...controls);
  return row;
}

function fmt(key: string, v: number): string {
  if (key === "angle") return `${Math.round(v)}°`;
  if (key === "opacity" || key === "colorAmount") return `${Math.round(v * 100)}%`;
  return v.toFixed(3);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode failed"));
    img.src = url;
  });
}

/**
 * How long ago, in words.
 *
 * "restored from 3 minutes ago" answers the question the note is actually
 * asking — is this from this session or from last week — which a timestamp
 * makes the reader work out for themselves.
 */
function when(at: number): string {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 90) return "a moment ago";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return new Date(at).toLocaleDateString();
}
