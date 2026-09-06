/**
 * The camera, minus the camera (item 28).
 *
 * Everything here is arithmetic and strings: the look, the grid, the file name,
 * the constraints handed to `getUserMedia`, the choice of recording container.
 * No `navigator`, no `document`, no device. That split is what makes a camera
 * testable on a machine with no webcam attached — and this one is, end to end,
 * because a `<canvas>` can hand out a real `MediaStreamTrack`.
 *
 * **One filter string, two consumers.** The preview is a `<video>` with a CSS
 * `filter`; a still is drawn to a canvas with `ctx.filter`. Both take the same
 * string from `filterOf()`, and the same engine implements both — so a photo
 * cannot come out looking different from the preview it was framed in. That is
 * also why the look is restricted to what `filter` actually has: brightness,
 * contrast, saturation, sepia, hue-rotate, grayscale, invert and blur. Vignette,
 * grain and sharpening are all things a camera app is expected to offer and
 * none of them exist in `filter`; faking them on the still only would break the
 * one promise this module is built around, so they are simply absent rather
 * than half-present.
 *
 * **Mirror flips the file too.** The usual arrangement — mirror the preview,
 * save it unmirrored — is the same broken promise in a different coat: the
 * lettering on a mug reads one way while framing and the other way in the
 * folder. Here the toggle moves both, so someone who wants the unmirrored
 * image turns it off and frames the shot the way it will be saved.
 */

/** What the look is made of. Every field maps to one CSS filter function. */
export interface Look {
  /** `1` is the sensor's own. */
  brightness: number;
  contrast: number;
  saturation: number;
  /** 0–1 of `sepia()`. Warm rather than "sepia" because that is what it does. */
  warmth: number;
  /** `hue-rotate` degrees, −180 to 180. */
  tint: number;
  /** 0–1 of `grayscale()`. */
  mono: number;
  /** 0–1 of `invert()`. */
  negative: number;
  /** Pixels of `blur()`, on the whole frame. */
  blur: number;
}

export const NEUTRAL: Look = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  warmth: 0,
  tint: 0,
  mono: 0,
  negative: 0,
  blur: 0,
};

/** The bounds each control is offered within, and the step it moves by. */
export const RANGE: Readonly<Record<keyof Look, readonly [number, number, number]>> = {
  brightness: [0.2, 2, 0.01],
  contrast: [0.2, 2, 0.01],
  saturation: [0, 2, 0.01],
  warmth: [0, 1, 0.01],
  tint: [-180, 180, 1],
  mono: [0, 1, 0.01],
  negative: [0, 1, 0.01],
  blur: [0, 20, 0.1],
};

/** The words for each control, in the order they are shown. */
export const CONTROLS: ReadonlyArray<readonly [keyof Look, string, string]> = [
  ["brightness", "Brightness", "×"],
  ["contrast", "Contrast", "×"],
  ["saturation", "Colour", "×"],
  ["warmth", "Warmth", ""],
  ["tint", "Tint", "°"],
  ["mono", "Mono", ""],
  ["negative", "Negative", ""],
  ["blur", "Blur", "px"],
];

export interface Preset {
  name: string;
  look: Look;
  /** False for the ones FACET ships, true for anything the user made. */
  own: boolean;
}

/**
 * The presets that ship.
 *
 * Deliberately few and deliberately plain. A camera that opens on forty named
 * looks is a camera whose own picture is hard to find, and the point of the
 * sliders below them is that anyone who wants a forty-first can make it and
 * keep it.
 */
export const BUILT_IN: readonly Preset[] = [
  { name: "Natural", own: false, look: { ...NEUTRAL } },
  { name: "Vivid", own: false, look: { ...NEUTRAL, saturation: 1.35, contrast: 1.12 } },
  { name: "Warm", own: false, look: { ...NEUTRAL, warmth: 0.32, brightness: 1.04 } },
  { name: "Cool", own: false, look: { ...NEUTRAL, tint: -12, saturation: 1.1 } },
  { name: "Mono", own: false, look: { ...NEUTRAL, mono: 1, contrast: 1.08 } },
  { name: "Noir", own: false, look: { ...NEUTRAL, mono: 1, contrast: 1.45, brightness: 0.94 } },
  { name: "Faded", own: false, look: { ...NEUTRAL, saturation: 0.72, contrast: 0.88, brightness: 1.06 } },
  { name: "Negative", own: false, look: { ...NEUTRAL, negative: 1 } },
];

export function cloneLook(l: Look): Look {
  return { ...l };
}

export function sameLook(a: Look, b: Look): boolean {
  return (Object.keys(NEUTRAL) as Array<keyof Look>).every((k) => near(a[k], b[k]));
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

/** Force anything loaded off disk into a look the filter string can hold. */
export function coerceLook(raw: unknown): Look {
  const out = cloneLook(NEUTRAL);
  if (!raw || typeof raw !== "object") return out;
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(NEUTRAL) as Array<keyof Look>) {
    const v = src[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const [min, max] = RANGE[key];
    out[key] = Math.min(max, Math.max(min, v));
  }
  return out;
}

/**
 * The look as a `filter` value, for both the preview and the still.
 *
 * Only the parts that do something are written. An untouched look is the empty
 * string and not `"none"`, because `ctx.filter = ""` is the documented way to
 * say "no filter" while `"none"` is merely the initial value — and a blur of 0
 * still costs a full-frame convolution on some drivers, so leaving the term out
 * is not only tidiness.
 */
export function filterOf(l: Look): string {
  const parts: string[] = [];
  if (!near(l.brightness, 1)) parts.push(`brightness(${round(l.brightness)})`);
  if (!near(l.contrast, 1)) parts.push(`contrast(${round(l.contrast)})`);
  if (!near(l.saturation, 1)) parts.push(`saturate(${round(l.saturation)})`);
  if (l.warmth > 0) parts.push(`sepia(${round(l.warmth)})`);
  if (!near(l.tint, 0)) parts.push(`hue-rotate(${round(l.tint)}deg)`);
  if (l.mono > 0) parts.push(`grayscale(${round(l.mono)})`);
  if (l.negative > 0) parts.push(`invert(${round(l.negative)})`);
  if (l.blur > 0) parts.push(`blur(${round(l.blur)}px)`);
  return parts.join(" ");
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ── Presets a user made ─────────────────────────────────────────────────────

/**
 * Read a stored preset list.
 *
 * Total, like `coerce` in the settings schema and for the same reason: this
 * file is small, hand-editable and older than the next control that gets added
 * to `Look`. A half-valid entry is repaired rather than dropped, and a
 * completely broken one is skipped rather than throwing away the eleven good
 * presets that came after it in the file.
 */
export function parsePresets(text: string): Preset[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Preset[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const name = String((item as { name?: unknown }).name ?? "").trim();
    if (!name) continue;
    out.push({ name, own: true, look: coerceLook((item as { look?: unknown }).look) });
  }
  return out;
}

export function writePresets(list: readonly Preset[]): string {
  return JSON.stringify(list.filter((p) => p.own).map((p) => ({ name: p.name, look: p.look })));
}

/**
 * Add or replace by name.
 *
 * Replace, not "add a second Warm": someone who saves over a name is adjusting
 * that look, and a list with two identical names is a list where the wrong one
 * gets deleted.
 */
export function withPreset(list: readonly Preset[], name: string, look: Look): Preset[] {
  const clean = name.trim();
  const kept = list.filter((p) => p.name.toLowerCase() !== clean.toLowerCase());
  return [...kept, { name: clean, own: true, look: cloneLook(look) }];
}

export function withoutPreset(list: readonly Preset[], name: string): Preset[] {
  return list.filter((p) => p.name.toLowerCase() !== name.trim().toLowerCase());
}

/** Where a user's own looks are kept, in the same shape the folder rules use. */
export interface PresetBackend {
  read(): string | null;
  write(text: string): void;
}

const PRESET_KEY = "facet.camera.presets";

/** localStorage, with every failure mode swallowed — see `settings/store.ts`. */
export function browserPresets(): PresetBackend {
  return {
    read: () => {
      try {
        return localStorage.getItem(PRESET_KEY);
      } catch {
        return null;
      }
    },
    write: (text) => {
      try {
        localStorage.setItem(PRESET_KEY, text);
      } catch {
        /* private mode, quota, disabled — a forgotten filter is not a crash */
      }
    },
  };
}

export function memoryPresets(seed: string | null = null): PresetBackend {
  let value = seed;
  return { read: () => value, write: (text) => { value = text; } };
}

/** The shipped looks followed by the user's, which is the order they are shown. */
export function allPresets(backend: PresetBackend): Preset[] {
  return [...BUILT_IN, ...parsePresets(backend.read() ?? "")];
}

// ── The grid ────────────────────────────────────────────────────────────────

export type GridKind = "none" | "thirds" | "golden" | "square" | "cross";

export const GRIDS: ReadonlyArray<readonly [GridKind, string]> = [
  ["none", "No grid"],
  ["thirds", "Rule of thirds"],
  ["golden", "Golden ratio"],
  ["square", "Square crop"],
  ["cross", "Centre cross"],
];

/** A line across the frame, in fractions of it, so it survives any resize. */
export interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * The guides for a grid, as fractions.
 *
 * Fractions rather than pixels because the preview is resized by every window
 * drag and by the aspect of whichever camera is selected, and a grid computed
 * in pixels is a grid that has to be recomputed on each of those — which is the
 * version that ends up one frame stale and visibly wrong while dragging.
 *
 * The square guide is the exception that needs the aspect: "the square crop" is
 * a statement about the frame's shape, and on a 16:9 preview it is two vertical
 * lines while on a portrait one it is two horizontal.
 */
export function gridLines(kind: GridKind, aspect: number): Line[] {
  switch (kind) {
    case "none":
      return [];
    case "thirds":
      return [
        ...at([1 / 3, 2 / 3], "v"),
        ...at([1 / 3, 2 / 3], "h"),
      ];
    case "golden": {
      // 1/φ, which is where the eye is said to settle — 0.382 and 0.618.
      const a = 1 - 1 / 1.618;
      return [...at([a, 1 - a], "v"), ...at([a, 1 - a], "h")];
    }
    case "square": {
      if (!Number.isFinite(aspect) || aspect <= 0) return [];
      if (Math.abs(aspect - 1) < 1e-3) return [];
      if (aspect > 1) {
        const w = 1 / aspect; // the square's width, as a fraction of the frame
        return at([(1 - w) / 2, (1 + w) / 2], "v");
      }
      const h = aspect;
      return at([(1 - h) / 2, (1 + h) / 2], "h");
    }
    case "cross":
      return [
        { x1: 0.5, y1: 0.42, x2: 0.5, y2: 0.58 },
        { x1: 0.42, y1: 0.5, x2: 0.58, y2: 0.5 },
      ];
  }
}

function at(positions: readonly number[], dir: "v" | "h"): Line[] {
  return positions.map((p) =>
    dir === "v" ? { x1: p, y1: 0, x2: p, y2: 1 } : { x1: 0, y1: p, x2: 1, y2: p },
  );
}

// ── What lands on disk ──────────────────────────────────────────────────────

export type PhotoFormat = "jpeg" | "png" | "webp";

export const PHOTO_FORMATS: ReadonlyArray<readonly [PhotoFormat, string, string]> = [
  ["jpeg", "JPEG", "Smallest, and what every phone and website expects."],
  ["png", "PNG", "Lossless and large. Worth it for screenshots of text, not for a face."],
  ["webp", "WebP", "Smaller than JPEG at the same quality; a few old programs cannot read it."],
];

export function mimeOf(f: PhotoFormat): string {
  return `image/${f}`;
}

export function extOf(f: PhotoFormat): string {
  // `.jpg` and not `.jpeg`: the mime type is `image/jpeg` and the extension in
  // the world is three letters, and this is the one place they differ.
  return f === "jpeg" ? "jpg" : f;
}

/**
 * `facet-2026-08-16-201530.jpg`.
 *
 * Sorts chronologically as text, which is the only property a camera's file
 * name really has to have — a folder of these in a shell that sorts by name is
 * in the order they were taken, whatever the filesystem thinks the times are.
 * Seconds are included because a burst of three is three files, and the shell's
 * own collision handling adds the ` (2)` if a second lands anyway.
 */
export function stampName(when: Date, ext: string, prefix = "facet"): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${prefix}-${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}` +
    `-${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}.${ext}`
  );
}

/** `1:04` — a running time nobody has to parse. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const p = (n: number): string => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
}

// ── The device ──────────────────────────────────────────────────────────────

/** The self-timer's offered delays, in seconds. */
export const COUNTDOWNS: readonly number[] = [0, 3, 5, 10];

/**
 * What to ask `getUserMedia` for.
 *
 * `ideal` rather than `exact` throughout, and that is the whole design of this
 * function. `exact` on a width the camera does not have is an
 * `OverconstrainedError` and a black preview; `ideal` on the same number gets
 * the closest mode the driver has. A camera app that refuses to open because it
 * asked for 4K on a 720p webcam is worse than one that quietly shows 720p and
 * says so in the status line, which is what this pairs with.
 *
 * The device id is the exception and is `exact` on purpose: when someone picks
 * a specific camera from the list, silently opening a *different* one because
 * the chosen is busy is the one substitution that is never acceptable.
 */
export function videoConstraints(deviceId: string | null, height: number): MediaTrackConstraints {
  const c: MediaTrackConstraints = {
    width: { ideal: Math.round((height * 16) / 9) },
    height: { ideal: height },
    frameRate: { ideal: 30 },
  };
  if (deviceId) c.deviceId = { exact: deviceId };
  return c;
}

/** The heights offered, largest first — a camera app should open on its best. */
export const HEIGHTS: readonly number[] = [2160, 1440, 1080, 720, 480];

/**
 * The best container this browser will actually record.
 *
 * Asked rather than assumed: WebView2 records VP9 in WebM and Safari does not,
 * and a hard-coded mime that `MediaRecorder` rejects throws at the moment the
 * record button is pressed — the worst possible time to discover it, since
 * whatever was being recorded is gone. Ordered by what survives being handed to
 * ffmpeg afterwards, which every other part of FACET is going to do to it.
 */
export const VIDEO_MIMES: readonly string[] = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

export function bestVideoMime(supported: (mime: string) => boolean): string | null {
  return VIDEO_MIMES.find((m) => supported(m)) ?? null;
}

export function extOfMime(mime: string): string {
  return mime.startsWith("video/mp4") ? "mp4" : "webm";
}
