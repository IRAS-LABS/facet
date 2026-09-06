/**
 * Cards and documents, v1: a heuristic over OCR word boxes, no model.
 *
 * A bank card, an ID, a boarding pass, a letter on a desk: to the OCR they
 * are all a dense cluster of words inside a rectangle with a card-like or
 * page-like aspect. Words are clustered by proximity (gap under two text
 * heights), each cluster's bounding box is scored on aspect, area and how
 * much of it is ink, and the clusters that look like a printed object rather
 * than a caption are returned.
 *
 * Shape alone is not enough: a poster, a diploma, a book page and a framed
 * photo caption are text-dense rectangles too, and on the office test
 * picture every one of them came back as a "card". So a cluster also has
 * to *read* like a card — a Luhn-valid card number, groups of four digits,
 * an expiry, an ID-style number, or the words printed on IDs and passes
 * ("VALID THRU", "PASSPORT", "DOB", "LICENSE"…). See `cardEvidence`.
 *
 * Limits, stated plainly: this needs *readable* text, so a card at an angle
 * or under glare, a card with only embossed digits, or one smaller than ~150
 * source pixels wide is missed; a card lying on a printed page merges with
 * the page; a letter with no numbers on it is not found.
 */

import type { OcrPage, OcrWord } from "@core/ocr/page";
import type { Det } from "./onnx";
import { luhn } from "./textrules";

export interface CardOptions {
  /** Minimum words in a cluster. */
  minWords: number;
  /** Min / max fraction of the image the box may cover. */
  minArea: number;
  maxArea: number;
  /** Accepted width/height range (portrait cards are flipped to landscape first). */
  minAspect: number;
  maxAspect: number;
  /** Words closer than this × median word height join a cluster. */
  gap: number;
}

export const CARD_DEFAULTS: CardOptions = {
  minWords: 4,
  minArea: 0.01,
  maxArea: 0.7,
  minAspect: 1.15,
  maxAspect: 2.4,
  gap: 2.0,
};

interface Cluster { words: OcrWord[]; x0: number; y0: number; x1: number; y1: number }

function median(v: number[]): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Group words by proximity; returns clusters with their bounding boxes. */
export function clusterWords(words: readonly OcrWord[], gapFactor: number): Cluster[] {
  const live = words.filter((w) => w.text.trim().length > 0 && w.box.w > 0 && w.box.h > 0);
  const h = median(live.map((w) => w.box.h));
  const gap = Math.max(4, h * gapFactor);
  const clusters: Cluster[] = [];
  const near = (c: Cluster, w: OcrWord): boolean =>
    w.box.x < c.x1 + gap && w.box.x + w.box.w > c.x0 - gap && w.box.y < c.y1 + gap && w.box.y + w.box.h > c.y0 - gap;
  for (const w of live) {
    const hits = clusters.filter((c) => near(c, w));
    if (hits.length === 0) {
      clusters.push({ words: [w], x0: w.box.x, y0: w.box.y, x1: w.box.x + w.box.w, y1: w.box.y + w.box.h });
      continue;
    }
    // Merge every cluster the word touches into the first.
    const base = hits[0]!;
    for (const other of hits.slice(1)) {
      base.words.push(...other.words);
      base.x0 = Math.min(base.x0, other.x0); base.y0 = Math.min(base.y0, other.y0);
      base.x1 = Math.max(base.x1, other.x1); base.y1 = Math.max(base.y1, other.y1);
      clusters.splice(clusters.indexOf(other), 1);
    }
    base.words.push(w);
    base.x0 = Math.min(base.x0, w.box.x); base.y0 = Math.min(base.y0, w.box.y);
    base.x1 = Math.max(base.x1, w.box.x + w.box.w); base.y1 = Math.max(base.y1, w.box.y + w.box.h);
  }
  return clusters;
}

/** Words printed on bank cards, IDs, passports, boarding passes and insurance cards. */
const CARD_WORDS = /^(valid|thru|through|expires?|exp|expiry|good|member|since|debit|credit|visa|mastercard|amex|discover|maestro|cvv|cvc|passport|license|licence|driver|driver's|identity|identification|id|dob|birth|sex|height|hgt|eyes|class|issued|iss|boarding|pass|gate|seat|flight|policy|group|plan|rx|bin|pcn|ssn|social|security|national|insurance|card|no|nº|number|nr)$/i;

/**
 * How strongly a cluster of words reads like a card, 0..1, and why.
 * 0 means "no card evidence at all": the words are just words.
 */
export function cardEvidence(words: readonly OcrWord[]): { score: number; why: string } {
  const texts = words.map((w) => w.text.trim()).filter((t) => t.length > 0);
  const joined = texts.join(" ");
  const digits = joined.replace(/\D/g, "").length;
  const letters = joined.replace(/[^A-Za-z]/g, "").length;
  const digitShare = digits / Math.max(1, digits + letters);
  let score = 0;
  const why: string[] = [];
  // A Luhn-valid 13–19 digit run across neighbouring words: as sure as this gets.
  for (let i = 0; i < texts.length; i++) {
    let run = "";
    for (let j = i; j < Math.min(texts.length, i + 5); j++) {
      if (!/^[\d\s-]+$/.test(texts[j]!)) break;
      run += texts[j];
      if (luhn(run)) { score = Math.max(score, 1); why.push("luhn"); break; }
    }
  }
  const groups4 = texts.filter((t) => /^\d{4}$/.test(t)).length;
  if (groups4 >= 3) { score = Math.max(score, 0.9); why.push("4-digit groups"); }
  else if (groups4 === 2) { score = Math.max(score, 0.55); why.push("two 4-digit groups"); }
  if (texts.some((t) => /^(0[1-9]|1[0-2])\/\d{2}(\d{2})?$/.test(t))) { score = Math.max(score, 0.6); why.push("expiry"); }
  if (texts.some((t) => /^[A-Z]{0,3}\d{6,}[A-Z]?$/i.test(t) || /^\d{3}-\d{2}-\d{4}$/.test(t))) { score = Math.max(score, 0.5); why.push("id number"); }
  const cardWords = texts.filter((t) => CARD_WORDS.test(t.replace(/[.:]+$/, ""))).length;
  if (cardWords >= 2) { score = Math.max(score, 0.5); why.push("card words"); }
  else if (cardWords === 1) score = Math.max(score, 0.25);
  if (digitShare >= 0.35 && digits >= 8) { score = Math.max(score, 0.45); why.push("mostly digits"); }
  // Weak evidence stacks: one card word plus an ID-ish number is a card; one alone is not.
  if (score < 0.5 && why.length + (cardWords === 1 ? 1 : 0) >= 2) score = 0.5;
  return { score, why: why.join("+") };
}

/** Card-like text clusters on an OCR page, in page pixels. */
export function detectCards(page: OcrPage, opts: Partial<CardOptions> = {}): Det[] {
  const o = { ...CARD_DEFAULTS, ...opts };
  const words = page.blocks.flatMap((b) => b.lines.flatMap((l) => l.words));
  const clusters = clusterWords(words, o.gap);
  const area = page.width * page.height;
  const out: Det[] = [];
  for (const c of clusters) {
    if (c.words.length < o.minWords) continue;
    const w = c.x1 - c.x0, h = c.y1 - c.y0;
    if (w <= 0 || h <= 0) continue;
    const frac = (w * h) / area;
    if (frac < o.minArea || frac > o.maxArea) continue;
    const aspect = Math.max(w, h) / Math.min(w, h);
    if (aspect < o.minAspect || aspect > o.maxAspect) continue;
    const ink = c.words.reduce((s, x) => s + x.box.w * x.box.h, 0) / (w * h);
    if (ink < 0.08) continue;
    const lines = new Set(c.words.map((x) => Math.round(x.box.y / Math.max(1, x.box.h)))).size;
    if (lines < 2) continue;
    const conf = c.words.reduce((s, x) => s + x.confidence, 0) / c.words.length / 100;
    const ev = cardEvidence(c.words);
    if (ev.score < 0.5) continue;
    // Evidence carries the score; shape and OCR confidence only nudge it.
    const score = Math.min(1, 0.35 * ev.score + 0.35 * Math.min(1, ev.score / 0.6) + 0.15 * Math.min(1, ink * 3) + 0.15 * conf);
    out.push({ x: c.x0, y: c.y0, w, h, score, cls: 0 });
  }
  return out.sort((a, b) => b.score - a.score);
}
