/**
 * Both cameras at once: where the two pictures go, and how to say so.
 *
 * Android is the only platform that can do this at all -- `getUserMedia` opens
 * one camera per process there, so a second video element answers
 * `NotReadableError` no matter how the page is written -- and underneath, the
 * previews are not in the page. Camera2 draws them into two native views
 * parked behind a transparent WebView, because two 1440p streams pushed
 * through the JS bridge as data URLs is megabytes a second of base64 and looks
 * like it.
 *
 * What is left for the page is the part the page is best placed to decide: the
 * geometry. It knows the screen, the safe areas and where its own controls
 * are, and since it sits on top it is the only layer a tap reaches at all. So
 * it does not ask for "picture-in-picture" or "split" -- it says where each
 * camera's rectangle is, and picture-in-picture, half-and-half, dragging a
 * divider and swapping the two are then the same message with different
 * numbers. That is why there is no swap command anywhere in this file.
 *
 * Everything here is arithmetic on a layout, deliberately: it is the part that
 * has to be right at every screen size and in both orientations, and it can be
 * read without a phone in hand.
 */

/** Which lens, in the only terms a person thinks in. */
export type Lens = "back" | "front";

/** Two ways to show two cameras. Everything else is these with numbers moved. */
export type DualShape = "pip" | "split";

export interface DualLayout {
  shape: DualShape;
  /** The one shown large -- the full frame in `pip`, the bigger half in `split`. */
  big: Lens;
  /**
   * How much of the screen the big one gets in `split`, as a fraction.
   *
   * Half is the obvious value and not the only one worth having: a person
   * dragging the divider is saying they care more about one of the two, and a
   * split that snaps back to even would be arguing with them.
   */
  share: number;
  /** The inset in `pip`: top-left corner and width, as fractions of the stage. */
  inset: { x: number; y: number; w: number };
}

/** One camera's rectangle, in device pixels, as the native side wants it. */
export interface DualRect {
  cam: Lens;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Higher is nearer the viewer. */
  z: number;
}

export interface Stage {
  /** The stage's top-left within the window, in CSS pixels. */
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Sensible before anyone has touched anything: the rear lens, full screen. */
export const DUAL_START: DualLayout = {
  shape: "pip",
  big: "back",
  share: 0.5,
  inset: { x: 0.04, y: 0.06, w: 0.3 },
};

/** The inset's limits, as a fraction of the stage's width. */
export const INSET_MIN = 0.18;
export const INSET_MAX = 0.6;

/** How lopsided a split may get before it stops being two pictures. */
export const SHARE_MIN = 0.2;
export const SHARE_MAX = 0.8;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The other one. */
export function other(lens: Lens): Lens {
  return lens === "back" ? "front" : "back";
}

/**
 * Where the two cameras go, in device pixels.
 *
 * Device pixels, not CSS pixels, because the far side is placing Android views
 * and Android views are measured in the real thing. A phone at a 2.625 device
 * ratio would otherwise get an inset a third of the size asked for, which
 * looks like a layout bug and is a unit mistake.
 *
 * A split divides across the short side, so two frames stack on a phone held
 * upright and sit beside each other when it is turned -- in both cases each
 * half keeps roughly the shape of the screen, which is the shape the cameras
 * are already being cropped to.
 */
export function dualRects(layout: DualLayout, stage: Stage, dpr: number): DualRect[] {
  const px = (v: number): number => Math.round(v * dpr);
  const x0 = stage.left;
  const y0 = stage.top;
  const w = stage.width;
  const h = stage.height;
  const small = other(layout.big);

  if (layout.shape === "split") {
    const share = clamp(layout.share, SHARE_MIN, SHARE_MAX);
    if (h >= w) {
      const cut = Math.round(h * share);
      return [
        { cam: layout.big, x: px(x0), y: px(y0), w: px(w), h: px(cut), z: 0 },
        { cam: small, x: px(x0), y: px(y0 + cut), w: px(w), h: px(h - cut), z: 0 },
      ];
    }
    const cut = Math.round(w * share);
    return [
      { cam: layout.big, x: px(x0), y: px(y0), w: px(cut), h: px(h), z: 0 },
      { cam: small, x: px(x0 + cut), y: px(y0), w: px(w - cut), h: px(h), z: 0 },
    ];
  }

  // The inset keeps the shape of the screen rather than the sensor's 4:3, so
  // the small picture is the same crop of the world as the big one behind it
  // -- two different crops of the same room, side by side, read as a mistake.
  const iw = clamp(layout.inset.w, INSET_MIN, INSET_MAX) * w;
  const ih = (iw * h) / w;
  const ix = clamp(layout.inset.x, 0, 1 - iw / w) * w;
  const iy = clamp(layout.inset.y, 0, 1 - ih / h) * h;
  return [
    { cam: layout.big, x: px(x0), y: px(y0), w: px(w), h: px(h), z: 0 },
    { cam: small, x: px(x0 + ix), y: px(y0 + iy), w: px(iw), h: px(ih), z: 1 },
  ];
}

/**
 * The same rectangles in CSS pixels, relative to the stage.
 *
 * The page needs these to know what a finger landed on, and computing them
 * from the device-pixel ones rather than separately means the thing you can
 * touch is the thing you can see, exactly, at every ratio.
 */
export function dualBoxes(
  layout: DualLayout,
  stage: Stage,
  dpr: number,
): Array<DualRect & { cssX: number; cssY: number; cssW: number; cssH: number }> {
  return dualRects(layout, stage, dpr).map((r) => ({
    ...r,
    cssX: r.x / dpr - stage.left,
    cssY: r.y / dpr - stage.top,
    cssW: r.w / dpr,
    cssH: r.h / dpr,
  }));
}

/** Which camera is under a point, in stage-relative CSS pixels. Topmost wins. */
export function dualHit(
  boxes: ReturnType<typeof dualBoxes>,
  x: number,
  y: number,
): Lens | null {
  let found: Lens | null = null;
  let best = -Infinity;
  for (const b of boxes) {
    const inside = x >= b.cssX && x <= b.cssX + b.cssW && y >= b.cssY && y <= b.cssY + b.cssH;
    if (inside && b.z >= best) {
      best = b.z;
      found = b.cam;
    }
  }
  return found;
}

/** What `dual_place` is given. */
export function placeSpec(rects: readonly DualRect[]): string {
  return JSON.stringify(rects);
}

let invokeOnce: Promise<typeof import("@tauri-apps/api/core").invoke> | null = null;

async function invoker(): Promise<typeof import("@tauri-apps/api/core").invoke> {
  invokeOnce ??= import("@tauri-apps/api/core").then((m) => m.invoke);
  return invokeOnce;
}

/**
 * Whether this device will run both cameras together.
 *
 * False on a desktop and false on most phones: having a front and a back
 * camera says nothing about being able to stream both, and the camera service
 * is the only thing that knows. A false is what keeps the button off the bar,
 * so it is asked once and believed.
 */
export async function dualAvailable(): Promise<boolean> {
  try {
    const invoke = await invoker();
    return await invoke<boolean>("dual_available");
  } catch {
    return false;
  }
}

export async function dualStart(): Promise<void> {
  const invoke = await invoker();
  await invoke("dual_start");
}

export async function dualStop(): Promise<void> {
  try {
    const invoke = await invoker();
    await invoke("dual_stop");
  } catch {
    // Closing down. Whatever went wrong, there is nothing left to tell.
  }
}

export async function dualPlace(rects: readonly DualRect[]): Promise<void> {
  const invoke = await invoker();
  await invoke("dual_place", { spec: placeSpec(rects) });
}

/** Both cameras, one picture. Returns where it was written. */
export async function dualPhoto(): Promise<string> {
  const invoke = await invoker();
  return await invoke<string>("dual_photo");
}

export async function dualRecordStart(): Promise<void> {
  const invoke = await invoker();
  await invoke("dual_record_start");
}

/** Stop filming. Instant when combined live; slow on the two-clip fallback. */
export async function dualRecordStop(): Promise<string> {
  const invoke = await invoker();
  return await invoke<string>("dual_record_stop");
}
