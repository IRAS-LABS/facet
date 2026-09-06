/**
 * Text by rule: words the OCR read that look like something private.
 *
 * Runs over the recognised lines rather than words, because a phone number
 * is three words to Tesseract and a card number four. Each line's words are
 * joined with single spaces, the rules run over that string, and every word
 * whose span touches a match is returned with the rule that caught it. A
 * blur then lands on words, never on half a word.
 *
 * Rules, all deliberately loose — a missed email is a leak, an extra blurred
 * word is a click:
 *   emails    something@something.tld
 *   phones    7+ digits with the usual separators, optional +country
 *   urls      http(s)://…, www.…, or a bare host.tld/path
 *   cards     13–19 digits in groups, passing Luhn
 *   keywords  case-insensitive substrings the user typed
 */

import type { OcrLine, OcrPage, OcrWord } from "@core/ocr/page";
import type { TextRules } from "./autoblur-config";
import type { Det } from "./onnx";

export type TextRule = "email" | "phone" | "url" | "card" | "keyword";

export interface TextHit {
  word: OcrWord;
  rule: TextRule;
  /** What matched, for the layer label. */
  match: string;
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?/g;
const URL = /(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|net|org|io|dev|gov|edu|co|uk|de|fr|app|me|info|ai)\b(?:\/[^\s]*)?/gi;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;

/** Luhn check on the digits of a string. */
export function luhn(s: string): boolean {
  const digits = s.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

interface Span { start: number; end: number; rule: TextRule; match: string }

/** Character spans in `text` that a rule set catches. */
export function matchSpans(text: string, rules: TextRules): Span[] {
  const out: Span[] = [];
  const run = (re: RegExp, rule: TextRule, accept?: (m: string) => boolean): void => {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (accept && !accept(m[0])) continue;
      out.push({ start: m.index, end: m.index + m[0].length, rule, match: m[0] });
    }
  };
  if (rules.emails) run(EMAIL, "email");
  if (rules.urls) run(URL, "url");
  if (rules.cardNumbers) run(CARD, "card", luhn);
  if (rules.phones) run(PHONE, "phone", (m) => m.replace(/\D/g, "").length >= 7 && !luhn(m));
  for (const k of rules.keywords) {
    const key = k.trim().toLowerCase();
    if (!key) continue;
    const lower = text.toLowerCase();
    for (let i = lower.indexOf(key); i >= 0; i = lower.indexOf(key, i + key.length)) {
      out.push({ start: i, end: i + key.length, rule: "keyword", match: text.slice(i, i + key.length) });
    }
  }
  return out;
}

/** Hits within one OCR line. */
export function matchLine(line: OcrLine, rules: TextRules): TextHit[] {
  const offsets: { start: number; end: number; word: OcrWord }[] = [];
  let text = "";
  for (const w of line.words) {
    if (text) text += " ";
    const start = text.length;
    text += w.text;
    offsets.push({ start, end: text.length, word: w });
  }
  const spans = matchSpans(text, rules);
  const hits: TextHit[] = [];
  const seen = new Set<OcrWord>();
  for (const s of spans) {
    for (const o of offsets) {
      if (o.end <= s.start || o.start >= s.end) continue;
      if (seen.has(o.word)) continue;
      seen.add(o.word);
      hits.push({ word: o.word, rule: s.rule, match: s.match });
    }
  }
  return hits;
}

/** Every hit on a page, in reading order of the blocks. */
export function matchPage(page: OcrPage, rules: TextRules): TextHit[] {
  const out: TextHit[] = [];
  for (const b of page.blocks) for (const l of b.lines) out.push(...matchLine(l, rules));
  return out;
}

/** Hits as boxes, one per matched *run* of adjacent words on a line, in page pixels. */
export function textHitBoxes(page: OcrPage, rules: TextRules): { det: Det; rule: TextRule; text: string }[] {
  const out: { det: Det; rule: TextRule; text: string }[] = [];
  for (const b of page.blocks) {
    for (const l of b.lines) {
      const hits = matchLine(l, rules);
      if (hits.length === 0) continue;
      // Merge consecutive words of the same rule into one box.
      let cur: { det: Det; rule: TextRule; text: string; last: number } | null = null;
      for (const h of hits) {
        const i = l.words.indexOf(h.word);
        const bx = h.word.box;
        if (cur && cur.rule === h.rule && i === cur.last + 1) {
          const x0 = Math.min(cur.det.x, bx.x), y0 = Math.min(cur.det.y, bx.y);
          const x1 = Math.max(cur.det.x + cur.det.w, bx.x + bx.w), y1 = Math.max(cur.det.y + cur.det.h, bx.y + bx.h);
          cur.det = { ...cur.det, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
          cur.text += " " + h.word.text;
          cur.last = i;
        } else {
          if (cur) out.push({ det: cur.det, rule: cur.rule, text: cur.text });
          cur = {
            det: { x: bx.x, y: bx.y, w: bx.w, h: bx.h, score: Math.min(1, Math.max(0.3, h.word.confidence / 100)), cls: 0 },
            rule: h.rule, text: h.word.text, last: i,
          };
        }
      }
      if (cur) out.push({ det: cur.det, rule: cur.rule, text: cur.text });
    }
  }
  return out;
}
