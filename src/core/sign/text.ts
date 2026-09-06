/**
 * Words as vector paths — the other half of a watermark.
 *
 * A watermark is usually a word, not a drawing, and a word has to become
 * geometry somewhere. Three routes were open and two are worse than they look.
 *
 * Rasterising the text into a canvas gives a bitmap that blurs the moment
 * anyone zooms, and needs a font to be installed to look like anything.
 * Letting pdf-lib embed Helvetica works for the file and only for the file — a
 * text watermark would then take a second path through the exporter, could not
 * be previewed by the code that previews everything else, and the screen and
 * the page would be free to disagree.
 *
 * So the letters are polylines on a 7x10 grid, thickened into closed outlines.
 * Crude, plainly legible at watermark sizes and opacities, resolution-free, and
 * — the point — the same kind of thing as a drawn signature, so `artPaths`,
 * `stampMatrix`, the canvas preview and `stampPdf` all handle it already with
 * no branch anywhere for "this one is text".
 *
 * Outlines rather than stroked paths because pdf-lib's stroke width does not
 * scale with the placement: a stroked word would thin out as it grew until a
 * full-page DRAFT was drawn in hairlines. An outline is geometry and scales
 * with everything else.
 */

/** Letter strokes on a 7 wide x 10 tall grid, y-down. */
const GLYPHS: Record<string, ReadonlyArray<ReadonlyArray<readonly [number, number]>>> = {
  A: [[[0, 10], [3.5, 0], [7, 10]], [[1.4, 6], [5.6, 6]]],
  C: [[[7, 2], [5, 0], [2, 0], [0, 2], [0, 8], [2, 10], [5, 10], [7, 8]]],
  D: [[[0, 0], [4, 0], [7, 3], [7, 7], [4, 10], [0, 10], [0, 0]]],
  E: [[[7, 0], [0, 0], [0, 10], [7, 10]], [[0, 5], [5, 5]]],
  F: [[[7, 0], [0, 0], [0, 10]], [[0, 5], [5, 5]]],
  I: [[[3.5, 0], [3.5, 10]], [[1, 0], [6, 0]], [[1, 10], [6, 10]]],
  L: [[[0, 0], [0, 10], [7, 10]]],
  N: [[[0, 10], [0, 0], [7, 10], [7, 0]]],
  O: [[[2, 0], [5, 0], [7, 2], [7, 8], [5, 10], [2, 10], [0, 8], [0, 2], [2, 0]]],
  P: [[[0, 10], [0, 0], [5, 0], [7, 2], [5, 5], [0, 5]]],
  R: [[[0, 10], [0, 0], [5, 0], [7, 2], [5, 5], [0, 5]], [[3.5, 5], [7, 10]]],
  T: [[[0, 0], [7, 0]], [[3.5, 0], [3.5, 10]]],
  V: [[[0, 0], [3.5, 10], [7, 0]]],
  Y: [[[0, 0], [3.5, 5], [7, 0]], [[3.5, 5], [3.5, 10]]],
};

/**
 * Turn a word into filled outline paths, plus the box that bounds them.
 *
 * Unknown characters advance the pen without drawing, so a word with a digit or
 * a hyphen in it comes out spaced correctly with a gap rather than shifted.
 */
export function textPaths(word: string): { paths: string[]; box: [number, number, number, number] } | null {
  const letters = word.toUpperCase().split("");
  const w = 1.6;
  const advance = 9.5;
  const out: string[] = [];
  let x = 0;

  for (const ch of letters) {
    if (ch === " ") {
      x += advance * 0.6;
      continue;
    }
    const strokes = GLYPHS[ch];
    if (!strokes) {
      x += advance;
      continue;
    }
    for (const line of strokes) {
      // Each polyline becomes a closed ribbon of width `w`: one side forward,
      // the other back. A stroked path would be simpler but pdf-lib's stroke
      // width does not scale with the placement, so the mark would thin out as
      // it grew — an outline scales correctly because it is geometry.
      const pts = line.map(([px, py]) => ({ x: x + px, y: py }));
      const fwd: string[] = [];
      const back: string[] = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (!p) continue;
        const prev = pts[i - 1] ?? p;
        const next = pts[i + 1] ?? p;
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * (w / 2);
        const ny = (dx / len) * (w / 2);
        fwd.push(`${(p.x + nx).toFixed(2)},${(p.y + ny).toFixed(2)}`);
        back.unshift(`${(p.x - nx).toFixed(2)},${(p.y - ny).toFixed(2)}`);
      }
      if (fwd.length < 2) continue;
      out.push(`M${fwd.join("L")}L${back.join("L")}Z`);
    }
    x += advance;
  }

  if (out.length === 0) return null;
  return { paths: out, box: [-w, -w, x - advance + 7 + w * 2, 10 + w * 2] };
}

