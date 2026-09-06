/**
 * Terminals and code windows: a screen that is mostly dark and full of
 * monospaced text.
 *
 * Not a model — a decision over things the other stages already produced.
 * The candidates are the screens the COCO detector found, or the whole image
 * when it *is* a screenshot (PNG at a device's exact resolution, or no photo
 * metadata and a screen-shaped size). For each candidate: the share of dark
 * pixels, how many OCR words landed inside, and how uniform the pitch
 * (box width ÷ character count) of those words is. Proportional fonts vary
 * by ±30% word to word; a monospaced face is within a few percent.
 *
 * Result per candidate is a score, so the caller can say "blur terminals
 * only" (candidates above the threshold) versus "blur all screens".
 *
 * Limits: a light-themed terminal is a "screen" but not a "terminal" (the
 * dark test is the one that separates a shell from a spreadsheet, and a
 * light theme fails it); a screen too far away for OCR to read anything is
 * judged on darkness alone and needs the stronger `darkOnly` share; a code
 * *photo* at an angle reads badly and may drop below the word floor.
 */

import type { OcrPage, OcrWord } from "@core/ocr/page";
import type { Det } from "./onnx";

export interface TerminalOptions {
  /** Luminance under this is "dark". */
  darkLevel: number;
  /** Share of dark pixels needed (with text evidence). */
  darkShare: number;
  /** Share of dark pixels needed when OCR found too few words to judge pitch. */
  darkOnly: number;
  /** Words inside the box needed to judge pitch. */
  minWords: number;
  /** Coefficient of variation of pitch under which the text counts as monospaced. */
  monoCv: number;
  /** Score floor for "is a terminal". */
  threshold: number;
}

export const TERMINAL_DEFAULTS: TerminalOptions = {
  darkLevel: 80,
  darkShare: 0.45,
  darkOnly: 0.7,
  minWords: 6,
  monoCv: 0.22,
  threshold: 0.6,
};

export interface TerminalJudgement {
  box: Det;
  dark: number;
  words: number;
  /** Pitch coefficient of variation, or null with too few words. */
  pitchCv: number | null;
  score: number;
  terminal: boolean;
}

/** Share of pixels under `level` inside a box of a luminance image. */
export function darkShare(gray: Uint8ClampedArray | Uint8Array, width: number, height: number, box: Det, level: number): number {
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.w)), y1 = Math.min(height, Math.ceil(box.y + box.h));
  if (x1 <= x0 || y1 <= y0) return 0;
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 40_000)));
  let dark = 0, n = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      if (gray[y * width + x]! < level) dark++;
      n++;
    }
  }
  return n ? dark / n : 0;
}

/** Words whose centre lies inside the box. */
export function wordsInside(page: OcrPage, box: Det): OcrWord[] {
  const out: OcrWord[] = [];
  for (const b of page.blocks) for (const l of b.lines) for (const w of l.words) {
    const cx = w.box.x + w.box.w / 2, cy = w.box.y + w.box.h / 2;
    if (cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h) out.push(w);
  }
  return out;
}

/** Coefficient of variation of per-character pitch over words of 3+ characters, or null. */
export function pitchCv(words: readonly OcrWord[], minWords: number): number | null {
  const p = words.filter((w) => w.text.length >= 3 && w.box.w > 0).map((w) => w.box.w / w.text.length);
  if (p.length < minWords) return null;
  const mean = p.reduce((a, b) => a + b, 0) / p.length;
  if (mean <= 0) return null;
  const sd = Math.sqrt(p.reduce((a, b) => a + (b - mean) ** 2, 0) / p.length);
  return sd / mean;
}

/** Judge one candidate box. */
export function judgeTerminal(
  gray: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  box: Det,
  page: OcrPage | null,
  opts: Partial<TerminalOptions> = {},
): TerminalJudgement {
  const o = { ...TERMINAL_DEFAULTS, ...opts };
  const dark = darkShare(gray, width, height, box, o.darkLevel);
  const words = page ? wordsInside(page, box) : [];
  const cv = pitchCv(words, o.minWords);
  let score: number;
  if (cv !== null) {
    const mono = Math.max(0, 1 - cv / (o.monoCv * 2)); // 1 at cv 0, 0.5 at the limit, 0 at 2×
    const darkness = Math.min(1, dark / o.darkShare);
    const density = Math.min(1, words.length / 20);
    score = 0.5 * mono + 0.35 * darkness + 0.15 * density;
    if (dark < o.darkShare * 0.6) score *= 0.5;
  } else {
    score = dark >= o.darkOnly ? 0.6 + 0.4 * Math.min(1, (dark - o.darkOnly) / (1 - o.darkOnly)) : dark * 0.5;
  }
  return { box, dark, words: words.length, pitchCv: cv, score, terminal: score >= o.threshold };
}

/** Common device and desktop resolutions, either orientation. */
const SCREEN_SIZES: ReadonlyArray<readonly [number, number]> = [
  [1080, 2400], [1080, 2340], [1080, 2280], [1080, 1920], [1440, 3200], [1440, 3088], [1440, 2960], [1440, 2560],
  [1170, 2532], [1179, 2556], [1290, 2796], [1284, 2778], [1125, 2436], [828, 1792], [750, 1334], [1206, 2622],
  [1920, 1080], [2560, 1440], [3840, 2160], [2560, 1600], [1366, 768], [1536, 864], [1600, 900], [1280, 720],
  [2880, 1800], [3024, 1964], [3456, 2234], [2560, 1664], [1728, 1117], [1512, 982], [2736, 1824], [2048, 1536],
];

/** True when the image's size and type say "screenshot" rather than "photo". */
export function looksLikeScreenshot(width: number, height: number, mime?: string): boolean {
  const png = mime === "image/png";
  for (const [a, b] of SCREEN_SIZES) if ((width === a && height === b) || (width === b && height === a)) return true;
  // A PNG whose edges are both multiples of 8 and screen-shaped is very likely a capture.
  if (png && width % 8 === 0 && height % 8 === 0 && width >= 640 && height >= 480) {
    const aspect = Math.max(width, height) / Math.min(width, height);
    return aspect >= 1.2 && aspect <= 2.4;
  }
  return false;
}

/** Judge every candidate; when there are none and the image is a screenshot, judge the whole frame. */
export function detectTerminals(
  gray: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  screens: readonly Det[],
  page: OcrPage | null,
  opts: Partial<TerminalOptions> & { screenshot?: boolean } = {},
): TerminalJudgement[] {
  const candidates: Det[] = screens.length > 0 || !opts.screenshot
    ? [...screens]
    : [{ x: 0, y: 0, w: width, h: height, score: 1, cls: 0 }];
  return candidates.map((box) => judgeTerminal(gray, width, height, box, page, opts));
}
