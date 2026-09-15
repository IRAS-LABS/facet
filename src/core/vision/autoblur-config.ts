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

export type AutoCategory = "faces" | "plates" | "windshields" | "screens" | "terminals" | "cards" | "codes" | "text";

export const AUTO_CATEGORIES: readonly AutoCategory[] = [
  "faces", "plates", "windshields", "screens", "terminals", "cards", "codes", "text",
];

/** Short human names, singular and plural, for labels and toasts. */
export const CATEGORY_NAMES: Record<AutoCategory, { one: string; many: string; title: string }> = {
  faces: { one: "face", many: "faces", title: "Faces" },
  plates: { one: "plate", many: "plates", title: "Licence plates" },
  windshields: { one: "windscreen", many: "windscreens", title: "Windscreens (VIN & permits)" },
  screens: { one: "screen", many: "screens", title: "Screens" },
  terminals: { one: "terminal", many: "terminals", title: "Terminals" },
  cards: { one: "card", many: "cards", title: "Cards & documents" },
  codes: { one: "code", many: "codes", title: "QR & barcodes" },
  text: { one: "private text", many: "emails, phone numbers, links, card numbers, VINs or registrations", title: "Text by rule" },
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
  /**
   * Vehicle identification numbers — the 17-character code on a title, an
   * insurance card, a registration document or the plate inside a windscreen.
   *
   * Separate from `plates`, which is the object detector finding a number
   * plate in a photograph of a car. This is the same vehicle written down,
   * which is the more identifying of the two: a VIN is unique to one car for
   * its whole life, survives every change of plate and owner, and free lookup
   * sites will turn it into a history and often a location.
   */
  vins: boolean;
  /**
   * Registration and licence-plate numbers written as text.
   *
   * Anchored to a label ("REG", "PLATE", "TAG", "LICENCE NO") except for the
   * few national formats rigid enough to recognise on their own, and that
   * restraint is the whole design. A bare plate is three to eight letters and
   * digits, which is also every part number, order reference, seat number and
   * airport code in existence; catching those unanchored would blur a third of
   * an ordinary document and teach people to switch the whole feature off.
   */
  registrations: boolean;
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

/**
 * Every category defaults to `redact`, and that is a deliberate reversal.
 *
 * Faces used to default to a soft blur and plates, screens, terminals and
 * cards to pixelation, because those look better -- and both are recoverable.
 * A gaussian blur can be deconvolved, and for text an attacker can simply
 * render candidates, blur them identically and match; pixelated text comes
 * back outright once the font is guessable, which on a screenshot or a
 * terminal it always is. Auto-blur is the path where that matters most,
 * because it runs unattended on a picture nobody is inspecting closely, and
 * the whole point of it is that you can trust the result without checking.
 *
 * Softer styles are still one tap away per category in Settings, for the
 * pictures where the goal is tidiness rather than privacy. The default is not
 * the place to make that trade on someone's behalf.
 */
export const AUTO_DEFAULTS: AutoBlurConfig = Object.freeze({
  categories: {
    faces: cat("redact", 0.05, 0.35, 16, 0.6),
    // 0.45, not 0.4: on the office test picture a power strip on the floor scored 0.42 as a plate; real plates score 0.8+.
    plates: cat("redact", 0.06, 0.15, 12, 0.45),
    // Off by default, and the only category that is. It covers a band across
    // the top half of every car in the picture, which on a street scene or a
    // photograph of somebody's own car is a large and obvious change to the
    // image -- unreasonable to do to a holiday snap without being asked. It
    // matters when it matters: the VIN plate at the base of the screen, the
    // permit and the toll tag are the things that identify a vehicle after
    // the plate is covered, and none of them can be read by OCR from a photo.
    // `conf` is low and `minSize` counts the whole car, not the band.
    windshields: cat("redact", 0.06, 0.02, 72, 0.3, false),
    // Screens pad more than anything else: the detector fits the glass, and the
    // bezel plus reflections are where a stray line of text survives.
    screens: cat("redact", 0.08, 0.12, 24, 0.35),
    terminals: cat("redact", 0.08, 0.12, 24, 0.35),
    cards: cat("redact", 0.06, 0.10, 32, 0.5),
    codes: cat("redact", 0.05, 0.15, 16, 0.5),
    text: cat("redact", 0.05, 0.25, 6, 0.5),
  },
  screensIncludePhones: true,
  faceModel: true,
  text: { emails: true, phones: true, urls: true, cardNumbers: true, vins: true, registrations: true, keywords: [] },
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
