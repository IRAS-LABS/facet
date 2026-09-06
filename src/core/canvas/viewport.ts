/**
 * 2D spatial viewport — pan, zoom, pinch.
 *
 * This is the single source of truth for the canvas transform. Everything that
 * draws on the canvas reads `scale/tx/ty` from here; nothing keeps its own copy.
 *
 * The transform maps world → screen as:  screen = world * scale + t
 * so the inverse is:                     world  = (screen - t) / scale
 *
 * Cursor-anchored zoom falls straight out of that: keep the world point under
 * the pointer fixed while scale changes, and solve for the new translation.
 *
 * Zoom is not just navigation here — it is the preview mechanism. Levels of
 * detail are keyed off `scale`, so zooming into a video card is what starts it
 * playing, and the same engine later drives tight-corner blur precision.
 */

export interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

export interface ViewportOptions {
  minScale?: number;
  maxScale?: number;
  /** Wheel sensitivity. Higher = faster zoom per notch. */
  zoomSpeed?: number;
}

const DEFAULTS = {
  minScale: 0.05,
  maxScale: 40,
  zoomSpeed: 0.0016,
};

/**
 * How far a press may travel before it counts as a pan rather than a tap.
 * Kept in step with the tap threshold in canvas-view so the two layers agree on
 * where a click ends and a drag begins.
 */
const PAN_SLOP = 4;

type ChangeFn = (t: Readonly<Transform>) => void;

interface Pointer {
  x: number;
  y: number;
}

export class Viewport {
  scale = 1;
  tx = 0;
  ty = 0;

  readonly #el: HTMLElement;
  readonly #min: number;
  readonly #max: number;
  readonly #zoomSpeed: number;
  readonly #listeners = new Set<ChangeFn>();
  readonly #pointers = new Map<number, Pointer>();
  /** Where each live pointer went down, for measuring travel against the slop. */
  readonly #origins = new Map<number, Pointer>();
  /** Pointers this viewport has captured, i.e. gestures it has claimed as pans. */
  readonly #claimed = new Set<number>();
  readonly #detach: Array<() => void> = [];

  /** Distance and midpoint of the last two-finger sample, for pinch deltas. */
  #pinchDist = 0;
  #pinchMid: Pointer = { x: 0, y: 0 };
  #frame = 0;

  constructor(el: HTMLElement, opts: ViewportOptions = {}) {
    this.#el = el;
    this.#min = opts.minScale ?? DEFAULTS.minScale;
    this.#max = opts.maxScale ?? DEFAULTS.maxScale;
    this.#zoomSpeed = opts.zoomSpeed ?? DEFAULTS.zoomSpeed;

    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (ev: HTMLElementEventMap[K]) => void,
      opt?: AddEventListenerOptions,
    ): void => {
      el.addEventListener(type, fn as EventListener, opt);
      this.#detach.push(() => el.removeEventListener(type, fn as EventListener, opt));
    };

    on("wheel", this.#onWheel, { passive: false });
    on("pointerdown", this.#onPointerDown);
    on("pointermove", this.#onPointerMove);
    on("pointerup", this.#onPointerUp);
    on("pointercancel", this.#onPointerUp);
    on("pointerleave", this.#onPointerUp);
    // Browsers still fire a synthetic gesture/zoom on trackpad pinch; the
    // wheel handler already covers it via ctrlKey, so suppress the default.
    on("contextmenu", (e) => e.preventDefault());
  }

  destroy(): void {
    for (const fn of this.#detach) fn();
    this.#detach.length = 0;
    this.#listeners.clear();
    this.#pointers.clear();
    if (this.#frame) cancelAnimationFrame(this.#frame);
  }

  onChange(fn: ChangeFn): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Coalesce bursts of wheel/pointer events into one paint per frame. */
  #emit(): void {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      for (const fn of this.#listeners) fn(this);
    });
  }

  /** Pointer position relative to the viewport element. */
  #local(ev: { clientX: number; clientY: number }): Pointer {
    const r = this.#el.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  screenToWorld(sx: number, sy: number): Pointer {
    return { x: (sx - this.tx) / this.scale, y: (sy - this.ty) / this.scale };
  }

  worldToScreen(wx: number, wy: number): Pointer {
    return { x: wx * this.scale + this.tx, y: wy * this.scale + this.ty };
  }

  panBy(dx: number, dy: number): void {
    this.tx += dx;
    this.ty += dy;
    this.#emit();
  }

  /** Zoom to `next`, keeping the world point under (sx, sy) pinned. */
  zoomTo(next: number, sx: number, sy: number): void {
    const clamped = Math.min(this.#max, Math.max(this.#min, next));
    if (clamped === this.scale) return;
    const w = this.screenToWorld(sx, sy);
    this.scale = clamped;
    this.tx = sx - w.x * clamped;
    this.ty = sy - w.y * clamped;
    this.#emit();
  }

  zoomBy(factor: number, sx: number, sy: number): void {
    this.zoomTo(this.scale * factor, sx, sy);
  }

  /**
   * Frame a world-space rect in the element, with `pad` screen px of margin.
   *
   * `floor` stops the frame from zooming out past a scale the caller says is
   * useless to it. Framing is still centred on the rect either way; the caller
   * just gets a middle of it rather than the whole. A view whose contents stop
   * being drawn below some size -- which is every level-of-detail view -- would
   * otherwise be asked to frame a folder and answer with an empty screen.
   */
  fit(x: number, y: number, w: number, h: number, pad = 48, floor = 0): void {
    const r = this.#el.getBoundingClientRect();
    if (w <= 0 || h <= 0 || r.width <= 0 || r.height <= 0) return;
    const s = Math.max(
      floor,
      Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h),
    );
    this.scale = Math.min(this.#max, Math.max(this.#min, s));
    this.tx = r.width / 2 - (x + w / 2) * this.scale;
    this.ty = r.height / 2 - (y + h / 2) * this.scale;
    this.#emit();
  }

  set(t: Partial<Transform>): void {
    if (t.scale !== undefined) {
      this.scale = Math.min(this.#max, Math.max(this.#min, t.scale));
    }
    if (t.tx !== undefined) this.tx = t.tx;
    if (t.ty !== undefined) this.ty = t.ty;
    this.#emit();
  }

  // ── Input ───────────────────────────────────────────────────────────────

  #onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    const p = this.#local(ev);

    // Trackpad pinch arrives as wheel + ctrlKey. A plain two-finger scroll
    // should pan, matching every map and design tool.
    if (ev.ctrlKey || ev.metaKey) {
      this.zoomBy(Math.exp(-ev.deltaY * this.#zoomSpeed * 6), p.x, p.y);
      return;
    }
    if (ev.shiftKey) {
      // Shift+wheel = horizontal pan, the usual convention.
      this.panBy(-ev.deltaY, 0);
      return;
    }
    // A mouse wheel reports large deltaY in lines/pages; a trackpad reports
    // small pixel deltas. deltaMode !== PIXEL means a real wheel → zoom.
    if (ev.deltaMode !== 0 || Math.abs(ev.deltaY) >= 40) {
      this.zoomBy(Math.exp(-ev.deltaY * this.#zoomSpeed), p.x, p.y);
    } else {
      this.panBy(-ev.deltaX, -ev.deltaY);
    }
  };

  /**
   * Take ownership of a pointer. Capturing retargets every later event for that
   * pointer at this element, which is what makes a pan survive the cursor
   * leaving the window — and exactly why it must not happen a moment too early.
   */
  #claim(id: number): void {
    if (this.#claimed.has(id)) return;
    this.#el.setPointerCapture(id);
    this.#claimed.add(id);
  }

  #onPointerDown = (ev: PointerEvent): void => {
    // Deliberately no setPointerCapture here. Capturing on the down event
    // retargets the matching pointerup at the viewport, so the card the user
    // pressed never sees the release and clicking a file selected nothing. A
    // press only becomes a pan once it has travelled past the slop below; until
    // then it stays a tap and belongs to whatever is under it.
    if (ev.pointerType === "mouse" && ev.button !== 0 && ev.button !== 1) return;
    const at = this.#local(ev);
    this.#pointers.set(ev.pointerId, at);
    this.#origins.set(ev.pointerId, at);
    // Middle-drag and pinch are unambiguous — nothing else claims them, so
    // there is no tap to protect and they can be taken immediately.
    if (ev.pointerType === "mouse" && ev.button === 1) this.#claim(ev.pointerId);
    if (this.#pointers.size === 2) {
      for (const id of this.#pointers.keys()) this.#claim(id);
      this.#samplePinch();
    }
  };

  #onPointerMove = (ev: PointerEvent): void => {
    if (!this.#pointers.has(ev.pointerId)) return;
    const prev = this.#pointers.get(ev.pointerId)!;
    const next = this.#local(ev);
    this.#pointers.set(ev.pointerId, next);

    if (this.#pointers.size >= 2) {
      const before = { dist: this.#pinchDist, mid: this.#pinchMid };
      this.#samplePinch();
      if (before.dist > 0) {
        // Pan by the midpoint travel, then scale about the new midpoint.
        this.panBy(
          this.#pinchMid.x - before.mid.x,
          this.#pinchMid.y - before.mid.y,
        );
        this.zoomBy(
          this.#pinchDist / before.dist,
          this.#pinchMid.x,
          this.#pinchMid.y,
        );
      }
      return;
    }

    if (!this.#claimed.has(ev.pointerId)) {
      const from = this.#origins.get(ev.pointerId);
      if (!from) return;
      if (Math.hypot(next.x - from.x, next.y - from.y) <= PAN_SLOP) return;
      this.#claim(ev.pointerId);
    }
    this.panBy(next.x - prev.x, next.y - prev.y);
  };

  #onPointerUp = (ev: PointerEvent): void => {
    this.#pointers.delete(ev.pointerId);
    this.#origins.delete(ev.pointerId);
    this.#claimed.delete(ev.pointerId);
    if (this.#el.hasPointerCapture(ev.pointerId)) {
      this.#el.releasePointerCapture(ev.pointerId);
    }
    // Lifting one of two fingers must not make the remaining one jump: drop
    // the stale pinch sample so the next move re-seeds from scratch.
    this.#pinchDist = 0;
  };

  #samplePinch(): void {
    const pts = [...this.#pointers.values()];
    const a = pts[0];
    const b = pts[1];
    if (!a || !b) {
      this.#pinchDist = 0;
      return;
    }
    this.#pinchDist = Math.hypot(b.x - a.x, b.y - a.y);
    this.#pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
}
