/**
 * What auto-blur is allowed to find and what it does with each thing.
 *
 * One record per category — on/off, blur style, strength, padding, minimum
 * size — because "blur faces softly but black out every screen" is exactly
 * the kind of request users make, and one global style cannot express
 * it. The phone stores this under `fct.autoblur.v1` (`autoblur-prefs.ts`);
 * the desktop and batch paths take it as a plain value. The *type* lives here
 * with the detectors, not in the phone layer, so nothing in core imports UI.
 */

import type { BlurKind } from "@core/edit/blur";

export type AutoCategory = "faces" | "plates" | "screens" | "terminals" | "cards" | "codes" | "text";

export const AUTO_CATEGORIES: readonly AutoCategory[] = [
  "faces", "plates", "screens", "terminals", "cards", "codes", "text",
];

/** Short human names, singular and plural, for labels and toasts. */
export const CATEGORY_NAMES: Record<AutoCategory, { one: string; many: string; title: string }> = {
  faces: { one: "face", many: "faces", title: "Faces" },
  plates: { one: "plate", many: "plates", title: "Licence plates" },
  screens: { one: "screen", many: "screens", title: "Screens" },
  terminals: { one: "terminal", many: "terminals", title: "Terminals" },
  cards: { one: "card", many: "cards", title: "Cards & documents" },
  codes: { one: "code", many: "codes", title: "QR & barcodes" },
  text: { one: "text", many: "text", title: "Text by rule" },
};

export interface CategoryConfig {
  on: boolean;
  kind: BlurKind;
  /** Blur strength, 0..1 — the region's `amount`. */
  amount: number;
  /** Grown on every side by this fraction of the box's short edge. */
  pad: number;
  /** Ignore detections whose short edge is under this many source pixels. */
  minSize: number;
  /** Detector confidence floor, 0..1. */
  conf: number;
}

export interface TextRules {
  emails: boolean;
  phones: boolean;
  urls: boolean;
  /** 13–19 digit runs that pass Luhn, spaced or not. */
  cardNumbers: boolean;
  /** Case-insensitive substrings the user typed. */
  keywords: string[];
}

export interface AutoBlurConfig {
  categories: Record<AutoCategory, CategoryConfig>;
  /** Count hand-held phones as screens. */
  screensIncludePhones: boolean;
  /** Use the neural face model when it loads; the cascade otherwise. */
  faceModel: boolean;
  text: TextRules;
  video: {
    /** Keep every found layer for the whole clip, held at its last known box. */
    wholeClip: boolean;
    /** Frames looked at per second of video, 1..4. */
    fps: number;
  };
}

const cat = (kind: BlurKind, amount: number, pad: number, minSize: number, conf: number, on = true): CategoryConfig => ({
  on, kind, amount, pad, minSize, conf,
});

export const AUTO_DEFAULTS: AutoBlurConfig = Object.freeze({
  categories: {
    faces: cat("gaussian", 0.05, 0.35, 16, 0.6),
    // 0.45, not 0.4: on the office test picture a power strip on the floor scored 0.42 as a plate; real plates score 0.8+.
    plates: cat("pixelate", 0.06, 0.15, 12, 0.45),
    // Screens pad more than anything else: the detector fits the glass, and the
    // bezel plus reflections are where a stray line of text survives.
    screens: cat("pixelate", 0.08, 0.12, 24, 0.35),
    terminals: cat("pixelate", 0.08, 0.12, 24, 0.35),
    cards: cat("pixelate", 0.06, 0.10, 32, 0.5),
    codes: cat("solid", 0.05, 0.15, 16, 0.5),
    text: cat("solid", 0.05, 0.25, 6, 0.5),
  },
  screensIncludePhones: true,
  faceModel: true,
  text: { emails: true, phones: true, urls: true, cardNumbers: true, keywords: [] },
  video: { wholeClip: true, fps: 2 },
}) as AutoBlurConfig;

/** A deep copy so callers can patch without touching the frozen defaults. */
export function defaultConfig(): AutoBlurConfig {
  const d = AUTO_DEFAULTS;
  const categories = {} as Record<AutoCategory, CategoryConfig>;
  for (const c of AUTO_CATEGORIES) categories[c] = { ...d.categories[c] };
  return {
    categories,
    screensIncludePhones: d.screensIncludePhones,
    faceModel: d.faceModel,
    text: { ...d.text, keywords: [...d.text.keywords] },
    video: { ...d.video },
  };
}

/** The categories switched on in a config, in canonical order. */
export function enabledCategories(cfg: AutoBlurConfig): AutoCategory[] {
  return AUTO_CATEGORIES.filter((c) => cfg.categories[c].on);
}
