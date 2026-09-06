/**
 * The signature pad — where a signature is actually made.
 *
 * One screen, two very different users of it: a finger on a phone, and a mouse
 * on a desktop. That is not a detail to paper over with a media query, because
 * the two fail in opposite ways. A finger is steady and blunt — it draws a
 * decent curve and cannot hit a 20 px target. A mouse is precise and *shaky* —
 * it can hit anything and cannot draw a smooth arc, because a signature is a
 * wrist movement and a mouse has no wrist.
 *
 * So the pad does three things that a plain "draw here" canvas does not:
 *
 * **It adapts to the pointer on first contact.** `PointerEvent.pointerType`
 * tells us which hand is on the controls, and the ink settings jump to the
 * profile for it — heavy stabilisation for a mouse, light for a finger, almost
 * none for a stylus. It only does this while the user has not touched the
 * sliders; the moment they do, their numbers win and are never overwritten.
 *
 * **The capture area is large and the result is trimmed.** Signing in a
 * 60 px-tall box produces a cramped signature, because people write at the size
 * the box suggests. The pad is as big as the screen allows and the ink is
 * trimmed to its own bounds on save, so the size of the pad has no effect on
 * the size of the stamp.
 *
 * **Every control is live.** Thickness, boldness, contrast, smoothing, slant
 * and colour all re-render the strokes already on the canvas rather than
 * applying to the next one. Getting the weight right is much easier when you
 * can see your own signature change than when you have to redraw it to compare,
 * and it is only possible because the store keeps strokes rather than pixels.
 *
 * Structurally this follows the trash sheet: a fixed full-screen overlay at
 * z-index ≥ 40 on the body, closed by Escape, which is what makes the Android
 * hardware back button close it with no extra wiring.
 */

import {
  buildAll,
  boundsOf,
  defaultsFor,
  trimAndScale,
  type InkPath,
  type InkSettings,
  type InkStroke,
} from "@core/sign/ink";
import { parseSvg } from "@core/sign/svg";
import type { SigKind, Signature, SignatureStore } from "@core/sign/store";
import { MAX_IMAGE_BYTES } from "@core/sign/store";
import { el, fill } from "./phone/dom";
import { icon } from "./phone/icons";

/** Ink colours offered as one tap. Deliberately short: this is ink, not art. */
const INK_COLOURS: ReadonlyArray<[string, string]> = [
  ["#111318", "Black"],
  ["#1b3fa8", "Blue"],
  ["#0f5132", "Green"],
  ["#8a1220", "Red"],
];

/** The height a saved signature is normalised to. Arbitrary but fixed. */
const CANON_HEIGHT = 120;

/** Cap on the backing store, so a 4K desktop does not allocate a huge canvas. */
const MAX_DPR = 2;

interface Opts {
  kind?: SigKind;
  /** Called with the saved signature. The pad closes itself first. */
  onSave?: (sig: Signature) => void;
}

export class SignPad {
  readonly el: HTMLElement;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private controls: HTMLElement;
  private nameInput: HTMLInputElement;
  private hint: HTMLElement;

  private strokes: InkStroke[] = [];
  private live: InkStroke | null = null;
  private ink: InkSettings = defaultsFor("mouse");
  private colour = "#111318";
  /** Shear applied to the whole signature. Baked in on save, live before it. */
  private slant = 0;
  private guides = true;
  private kind: SigKind = "signature";

  /**
   * Set the first time a slider moves. After that the pointer-type profile
   * stops overwriting the settings — a user who has dialled in their own feel
   * must not have it reset by picking up the mouse.
   */
  private tuned = false;
  private lastPointer: "mouse" | "touch" | "pen" | null = null;

  private frame = 0;
  private cache: InkPath[] | null = null;
  private onSave: ((sig: Signature) => void) | undefined;

  private resizeObs: ResizeObserver | null = null;

  constructor(private readonly store: SignatureStore, opts: Opts = {}) {
    this.kind = opts.kind ?? "signature";
    this.onSave = opts.onSave;

    this.canvas = el<"canvas">("canvas.fct-sign-canvas");
    this.ctx = this.canvas.getContext("2d");
    this.controls = el("div.fct-sign-controls");
    this.nameInput = el<"input">("input.fct-sign-name", {
      type: "text",
      placeholder: this.kind === "initials" ? "Initials" : "Your name",
      maxlength: "60",
    });
    this.hint = el("div.fct-sign-hint", { text: "Sign in the box" });

    const head = el("header.fct-sign-head", {},
      this.btn("x", "Close", () => this.close()),
      el("h2.fct-sign-title", { text: this.kind === "initials" ? "New initials" : "New signature" }),
      el("div.fct-sign-head-actions", {},
        this.btn("undo", "Undo last stroke", () => this.undo()),
        this.btn("trash", "Clear", () => this.clear()),
      ),
    );

    const padWrap = el("div.fct-sign-pad", {}, this.canvas, this.hint);
    const foot = el("footer.fct-sign-foot", {},
      this.nameInput,
      el("button.fct-btn.fct-sign-save", { type: "button", text: "Save" }),
    );

    this.el = el("div.fct-sign", { hidden: true },
      head,
      el("div.fct-sign-body", {}, padWrap, this.controls),
      foot,
    );

    foot.querySelector(".fct-sign-save")?.addEventListener("click", () => this.save());
    this.wirePointer();
    this.buildControls();

    this.el.addEventListener("keydown", (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === "Escape") this.close();
      // Ctrl-Z is the reflex, and a stroke you regret is the common case.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        this.undo();
      }
    });

    document.body.append(this.el);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  open(): void {
    this.el.hidden = false;
    this.el.tabIndex = -1;
    this.el.focus();
    this.resize();
    // The pad is sized by flex, so its pixel size is not known until it has
    // been laid out at least once — and it changes when the phone rotates.
    this.resizeObs?.disconnect();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(this.canvas.parentElement ?? this.canvas);
  }

  close(): void {
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.el.hidden = true;
  }

  dispose(): void {
    this.close();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.el.remove();
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  private wirePointer(): void {
    const pos = (ev: PointerEvent): { x: number; y: number } => {
      const r = this.canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };

    this.canvas.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 && ev.pointerType === "mouse") return;
      ev.preventDefault();
      this.adoptPointer(ev.pointerType);
      // Capture, or a stroke that leaves the canvas ends silently mid-letter
      // and the user sees a signature chopped at the edge.
      this.canvas.setPointerCapture(ev.pointerId);
      const p = pos(ev);
      this.live = { points: [{ x: p.x, y: p.y, t: ev.timeStamp, ...pressure(ev) }] };
      this.hint.hidden = true;
      this.schedule();
    });

    this.canvas.addEventListener("pointermove", (ev) => {
      if (!this.live) return;
      ev.preventDefault();
      // Coalesced events are the whole reason a 120 Hz phone feels different
      // from a 60 Hz one: without them, two thirds of the samples the digitiser
      // captured are thrown away before the ink engine ever sees them.
      const evs = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [ev];
      for (const e of evs.length > 0 ? evs : [ev]) {
        const p = pos(e);
        this.live.points.push({ x: p.x, y: p.y, t: e.timeStamp, ...pressure(e) });
      }
      this.schedule();
    });

    const end = (ev: PointerEvent): void => {
      if (!this.live) return;
      if (this.canvas.hasPointerCapture(ev.pointerId)) this.canvas.releasePointerCapture(ev.pointerId);
      // A stroke of one or two points is a stray tap, not a mark. Keeping it
      // would leave invisible dots that quietly enlarge the trimmed bounds.
      if (this.live.points.length >= 2) this.strokes.push(this.live);
      this.live = null;
      this.cache = null;
      this.schedule();
    };
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
    // Right-click on a drawing surface offers nothing and interrupts a stroke.
    this.canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());
  }

  /** Switch to the profile for this input, unless the user has tuned it. */
  private adoptPointer(type: string): void {
    const kind = type === "touch" || type === "pen" ? type : "mouse";
    if (kind === this.lastPointer) return;
    this.lastPointer = kind;
    if (this.tuned) return;
    this.ink = defaultsFor(kind);
    this.cache = null;
    this.buildControls();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private resize(): void {
    const box = this.canvas.parentElement?.getBoundingClientRect();
    if (!box || box.width < 8 || box.height < 8) return;
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const w = Math.round(box.width * dpr);
    const h = Math.round(box.height * dpr);
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = `${box.width}px`;
    this.canvas.style.height = `${box.height}px`;
    this.render();
  }

  /** Shear about the baseline, so slanting does not lift the ink off the line. */
  private slantMatrix(): [number, number, number, number, number, number] {
    const k = Math.tan((this.slant * Math.PI) / 180);
    const baseY = this.canvas.height / dprOf(this.canvas) * 0.66;
    return [1, 0, -k, 1, k * baseY, 0];
  }

  private render(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const dpr = dprOf(this.canvas);
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (this.guides) this.drawGuides(ctx, w, h);

    if (this.cache === null) this.cache = buildAll(this.strokes, this.ink);
    const paths = this.live ? [...this.cache, ...buildAll([this.live], this.ink)] : this.cache;

    ctx.save();
    const m = this.slantMatrix();
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.fillStyle = this.colour;
    for (const p of paths) {
      if (!p.d) continue;
      ctx.fill(new Path2D(p.d));
    }
    ctx.restore();
  }

  /**
   * A baseline with an ascender and descender rule.
   *
   * Signing on a blank rectangle produces a signature that drifts uphill,
   * because there is nothing to write along — the same reason cheque books and
   * delivery pads print a line.
   */
  private drawGuides(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const base = h * 0.66;
    // Read from the canvas, not the sheet: the pad redefines the border tokens
    // locally so the rules stay legible on paper, and only an element inside it
    // sees those values.
    const style = getComputedStyle(this.canvas);
    ctx.save();
    ctx.strokeStyle = style.getPropertyValue("--fct-border").trim() || "#333";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 5]);
    for (const y of [base - h * 0.3, base + h * 0.14]) {
      ctx.beginPath();
      ctx.moveTo(w * 0.04, y);
      ctx.lineTo(w * 0.96, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = style.getPropertyValue("--fct-border-strong").trim() || "#555";
    ctx.beginPath();
    ctx.moveTo(w * 0.04, base);
    ctx.lineTo(w * 0.96, base);
    ctx.stroke();
    ctx.restore();
  }

  // ── Editing ───────────────────────────────────────────────────────────────

  private undo(): void {
    if (this.strokes.length === 0) return;
    this.strokes.pop();
    this.cache = null;
    this.hint.hidden = this.strokes.length > 0;
    this.schedule();
  }

  private clear(): void {
    this.strokes = [];
    this.live = null;
    this.cache = null;
    this.hint.hidden = false;
    this.schedule();
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  private btn(name: string, label: string, onClick: () => void): HTMLElement {
    const b = el<"button">("button.fct-sign-icon", { type: "button", title: label, "aria-label": label });
    b.append(icon(name));
    b.addEventListener("click", onClick);
    return b;
  }

  /**
   * One labelled slider.
   *
   * The live value is shown as a number because "boldness 1.4" is repeatable
   * and "boldness, about two thirds along" is not — and a signature is a thing
   * people want to reproduce exactly on the next document.
   */
  private slider(
    label: string,
    min: number,
    max: number,
    step: number,
    value: number,
    onInput: (v: number) => void,
    format: (v: number) => string = (v) => v.toFixed(2),
  ): HTMLElement {
    const out = el("span.fct-sign-val", { text: format(value) });
    const input = el<"input">("input.fct-sign-range", {
      type: "range",
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
    });
    input.addEventListener("input", () => {
      const v = Number(input.value);
      out.textContent = format(v);
      this.tuned = true;
      onInput(v);
      this.cache = null;
      this.schedule();
    });
    return el("label.fct-sign-row", {},
      el("span.fct-sign-label", { text: label }),
      input,
      out,
    );
  }

  private buildControls(): void {
    const swatches = el("div.fct-sign-swatches");
    for (const entry of INK_COLOURS) {
      const hex = entry[0];
      const b = el<"button">("button.fct-sign-swatch", {
        type: "button",
        title: entry[1],
        "aria-label": entry[1],
        "aria-pressed": this.colour === hex ? "true" : "false",
      });
      b.style.background = hex;
      b.addEventListener("click", () => {
        this.colour = hex;
        this.buildControls();
        this.schedule();
      });
      swatches.append(b);
    }
    const custom = el<"input">("input.fct-sign-colour", { type: "color", value: this.colour, title: "Custom ink" });
    custom.addEventListener("input", () => {
      this.colour = custom.value;
      this.schedule();
    });
    swatches.append(custom);

    const guideBtn = el<"button">("button.fct-sign-toggle", {
      type: "button",
      "aria-pressed": this.guides ? "true" : "false",
    }, icon("guides"), el("span", { text: "Guides" }));
    guideBtn.addEventListener("click", () => {
      this.guides = !this.guides;
      this.buildControls();
      this.schedule();
    });

    const kindBtn = el<"button">("button.fct-sign-toggle", {
      type: "button",
      "aria-pressed": this.kind === "initials" ? "true" : "false",
    }, icon("signature"), el("span", { text: this.kind === "initials" ? "Initials" : "Signature" }));
    kindBtn.addEventListener("click", () => {
      this.kind = this.kind === "initials" ? "signature" : "initials";
      this.nameInput.placeholder = this.kind === "initials" ? "Initials" : "Your name";
      this.buildControls();
    });

    const importSvg = el<"button">("button.fct-sign-toggle", { type: "button" },
      icon("file-text"), el("span", { text: "Import SVG" }));
    importSvg.addEventListener("click", () => void this.importFile("svg"));

    const importImg = el<"button">("button.fct-sign-toggle", { type: "button" },
      icon("image"), el("span", { text: "Import image" }));
    importImg.addEventListener("click", () => void this.importFile("image"));

    fill(this.controls,
      el("div.fct-sign-group-title", { text: "Feel" }),
      this.slider("Steadiness", 0, 0.95, 0.01, this.ink.stabilise, (v) => { this.ink = { ...this.ink, stabilise: v }; },
        (v) => `${Math.round(v * 100)}%`),
      this.slider("Smoothing", 0, 1, 0.01, this.ink.smoothing, (v) => { this.ink = { ...this.ink, smoothing: v }; },
        (v) => `${Math.round(v * 100)}%`),

      el("div.fct-sign-group-title", { text: "Weight" }),
      this.slider("Thickness", 0.6, 14, 0.1, this.ink.thickness, (v) => { this.ink = { ...this.ink, thickness: v }; },
        (v) => v.toFixed(1)),
      this.slider("Boldness", 0.5, 2.5, 0.05, this.ink.boldness, (v) => { this.ink = { ...this.ink, boldness: v }; }),
      this.slider("Speed contrast", 0, 1, 0.01, this.ink.contrast, (v) => { this.ink = { ...this.ink, contrast: v }; },
        (v) => (v === 0 ? "off" : `${Math.round(v * 100)}%`)),
      this.slider("End taper", 0, 1, 0.01, this.ink.taper, (v) => { this.ink = { ...this.ink, taper: v }; },
        (v) => `${Math.round(v * 100)}%`),

      el("div.fct-sign-group-title", { text: "Shape" }),
      this.slider("Slant", -30, 30, 1, this.slant, (v) => { this.slant = v; }, (v) => `${v.toFixed(0)}°`),

      el("div.fct-sign-group-title", { text: "Ink" }),
      swatches,

      el("div.fct-sign-group-title", { text: "Options" }),
      el("div.fct-sign-toggles", {}, guideBtn, kindBtn, importSvg, importImg),
    );
  }

  // ── Import ────────────────────────────────────────────────────────────────

  /**
   * Bring in a signature that already exists as a file.
   *
   * The SVG route is the good one — it stays vector, scales, and recolours. The
   * image route exists because most people's existing signature is a phone
   * photo, and refusing it would send them back to the pad to redraw something
   * they already have.
   */
  private async importFile(mode: "svg" | "image"): Promise<void> {
    const input = el<"input">("input", {
      type: "file",
      accept: mode === "svg" ? "image/svg+xml,.svg" : "image/png,image/jpeg,image/webp",
    });
    const file = await new Promise<File | null>((resolve) => {
      input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
      // No cancel event exists that fires reliably across platforms, so a
      // dismissed picker simply leaves this promise pending and the element is
      // collected. Nothing is blocked on it.
      input.click();
    });
    if (!file) return;

    if (mode === "svg") {
      const art = parseSvg(await file.text());
      if (!art) {
        this.warn("That SVG has no drawable paths.");
        return;
      }
      const [, , vw, vh] = art.viewBox;
      const sig = this.store.add({
        name: this.nameInput.value.trim() || file.name.replace(/\.svg$/i, ""),
        kind: this.kind,
        art: { source: "svg", paths: art.paths, viewBox: art.viewBox },
        colour: this.colour,
        aspect: vw / vh,
      });
      this.finish(sig);
      return;
    }

    const data = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error("read failed"));
      fr.readAsDataURL(file);
    });
    if (data.length > MAX_IMAGE_BYTES) {
      this.warn("That image is too large — crop it to just the signature first.");
      return;
    }
    const img = new Image();
    await new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.onerror = () => resolve();
      img.src = data;
    });
    if (!img.naturalWidth) {
      this.warn("That image could not be read.");
      return;
    }
    const sig = this.store.add({
      name: this.nameInput.value.trim() || file.name.replace(/\.[a-z0-9]+$/i, ""),
      kind: this.kind,
      art: { source: "image", data, w: img.naturalWidth, h: img.naturalHeight },
      colour: this.colour,
      aspect: img.naturalWidth / img.naturalHeight,
    });
    this.finish(sig);
  }

  private warn(text: string): void {
    this.hint.textContent = text;
    this.hint.hidden = false;
  }

  // ── Saving ────────────────────────────────────────────────────────────────

  private save(): void {
    if (this.strokes.length === 0) {
      this.warn("Nothing drawn yet.");
      return;
    }
    // Bake the slant. It is geometry, not an ink property, so carrying it
    // separately would mean every renderer downstream had to know about it.
    const m = this.slantMatrix();
    const sheared: InkStroke[] = this.strokes.map((s) => ({
      points: s.points.map((p) => ({ ...p, x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] })),
    }));

    const norm = trimAndScale(sheared, this.ink, CANON_HEIGHT);
    const box = boundsOf(buildAll(norm.strokes, norm.settings));
    const sig = this.store.add({
      name: this.nameInput.value.trim() || (this.kind === "initials" ? "Initials" : "Signature"),
      kind: this.kind,
      art: { source: "drawn", strokes: norm.strokes, ink: norm.settings },
      colour: this.colour,
      aspect: box.h > 0 ? box.w / box.h : 3,
    });
    this.finish(sig);
  }

  private finish(sig: Signature): void {
    this.close();
    this.onSave?.(sig);
  }
}

/**
 * Pressure, but only when it means something.
 *
 * Browsers report 0.5 for any device without a pressure sensor and 0 for a
 * mouse button that is up. Passing either through as real pressure would halve
 * the width of every mouse-drawn signature for no reason, so both are dropped
 * and the ink engine falls back to velocity alone.
 */
function pressure(ev: PointerEvent): { p?: number } {
  if (ev.pointerType !== "pen") return {};
  if (!(ev.pressure > 0) || Math.abs(ev.pressure - 0.5) < 0.01) return {};
  return { p: ev.pressure };
}

function dprOf(canvas: HTMLCanvasElement): number {
  const css = parseFloat(canvas.style.width) || canvas.clientWidth || canvas.width;
  return css > 0 ? canvas.width / css : 1;
}
