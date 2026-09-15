/**
 * Typed text as a placeable mark — the date next to the signature.
 *
 * Signing a form is almost never just the signature. There is a date, a
 * printed name, a reference number, sometimes "per pro". Drawing those by hand
 * on a trackpad is miserable and the result looks it, so they are typed.
 *
 * **Why this is not `text.ts`.** That module turns a word into polylines on a
 * 7x10 grid, which is exactly right for a watermark: DRAFT at 12% opacity
 * across a page does not need letterforms, it needs geometry that scales. It
 * is wrong for a date written beside a signature, where the thing is read at
 * full opacity an inch from the eye, needs lower case, digits, slashes and
 * commas, and has to look like it was written by a person rather than by a
 * plotter in 1974.
 *
 * **So this renders a real font.** The text is drawn into a canvas at a large
 * fixed size and becomes {@link ImageArt} — the same shape as a photographed
 * signature, which the placer, the canvas preview and `stampPdf` all already
 * handle. No new export path, no second geometry, nothing else to keep in
 * agreement.
 *
 * The cost of that choice is that the mark is pixels: the colour is baked in,
 * so changing it re-renders (cheap — a few milliseconds), and it is resolution
 * bound rather than infinite. {@link RENDER_PX} is chosen so a normal date on
 * a normal page is oversampled several times over, which is the part that
 * actually matters.
 */

import type { ImageArt } from "./store";

/**
 * Cap height in pixels for the render.
 *
 * A date placed at about 90 points wide comes out around 1000 px here, which
 * is roughly a 10x oversample of where it lands on the page. Bigger buys
 * nothing a printer can show and costs memory on the phone.
 */
const RENDER_PX = 180;

/** Never make an image wider than this, however long the sentence. */
const MAX_PX = 2400;

/** Padding around the glyphs, so a descender or an italic lean is not clipped. */
const PAD = Math.round(RENDER_PX * 0.28);

/**
 * The type choices offered.
 *
 * Four, not forty. Each stack names what Windows has, then what Android has,
 * then the generic — so a missing font degrades to the right *kind* of face
 * rather than to whatever the platform's default happens to be.
 */
export interface TypeFace {
  id: string;
  label: string;
  stack: string;
}

export const TYPE_FACES: readonly TypeFace[] = [
  { id: "hand", label: "Handwritten", stack: '"Segoe Script", "Bradley Hand", "Brush Script MT", "Dancing Script", cursive' },
  { id: "serif", label: "Serif", stack: 'Georgia, "Times New Roman", "Noto Serif", serif' },
  { id: "sans", label: "Plain", stack: '"Segoe UI", Roboto, system-ui, sans-serif' },
  { id: "mono", label: "Typewriter", stack: 'Consolas, "Roboto Mono", "Courier New", monospace' },
];

/** What the user typed, and how they want it to look. */
export interface TypeSpec {
  text: string;
  /** One of {@link TYPE_FACES}. An unknown id falls back to the first. */
  face: string;
  bold: boolean;
  italic: boolean;
  /** `#rrggbb`. Baked into the pixels, so a change re-renders. */
  colour: string;
}

export function defaultTypeSpec(): TypeSpec {
  return { text: today(), face: "hand", bold: false, italic: false, colour: "#12203a" };
}

/** Today, as the local short date. What the field is pre-filled with. */
export function today(): string {
  return new Date().toLocaleDateString();
}

const faceStack = (id: string): string =>
  (TYPE_FACES.find((f) => f.id === id) ?? TYPE_FACES[0])?.stack ?? "sans-serif";

const fontOf = (spec: TypeSpec, px: number): string =>
  `${spec.italic ? "italic " : ""}${spec.bold ? "700" : "400"} ${px}px ${faceStack(spec.face)}`;

/**
 * Measure and draw, returning art ready to place.
 *
 * Returns `null` for empty text rather than a 1x1 image, so the caller can
 * refuse to create a mark that would be invisible and undeletable.
 */
export function typeArt(spec: TypeSpec): ImageArt | null {
  const text = spec.text.replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;

  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) return null;
  probe.font = fontOf(spec, RENDER_PX);
  const m = probe.measureText(text);

  // `actualBoundingBox*` is what the glyphs really occupy, which for a script
  // face is a good deal taller and wider than the em box. Falling back to the
  // em box keeps this working on a canvas implementation that omits them.
  const ascent = m.actualBoundingBoxAscent || RENDER_PX * 0.8;
  const descent = m.actualBoundingBoxDescent || RENDER_PX * 0.25;
  const left = m.actualBoundingBoxLeft || 0;
  const right = m.actualBoundingBoxRight || m.width;
  const inkW = Math.max(1, right + left);
  const inkH = Math.max(1, ascent + descent);

  const scale = Math.min(1, MAX_PX / (inkW + PAD * 2));
  const w = Math.max(1, Math.round((inkW + PAD * 2) * scale));
  const h = Math.max(1, Math.round((inkH + PAD * 2) * scale));

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx) return null;

  // No background fill: the canvas starts transparent and stays that way, so
  // the mark sits on the page instead of on a white card over the page.
  ctx.scale(scale, scale);
  ctx.font = fontOf(spec, RENDER_PX);
  ctx.fillStyle = spec.colour;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, PAD + left, PAD + ascent);

  return { source: "image", data: out.toDataURL("image/png"), w, h };
}

/** Width ÷ height of rendered art, for the placer. 4 if it cannot be known. */
export function typeAspect(art: ImageArt | null): number {
  if (!art || art.h <= 0) return 4;
  return art.w / art.h;
}
