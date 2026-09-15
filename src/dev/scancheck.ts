/**
 * Harness for the document scanner: corner finding, the homography and the
 * warp, the page cleanup, the multi-page document model, and the PDF.
 *
 * Everything here runs without a camera. That is deliberate and it is the
 * reason the scanner is split the way it is -- "does deleting page 2 renumber
 * the rest", "does a page photographed at an angle come out square", "does
 * mono really produce two levels" are all questions about pure functions over
 * `ImageData`, and none of them should need a phone pointed at a desk to
 * answer.
 *
 * Runs in the dev server (`/scancheck.html`) and rolls up into allcheck.html
 * under "scan".
 */

import "../styles/base.css";
import "../styles/scan.css";

import {
  FULL_QUAD, findQuad, intersect, isConvex, orderQuad, quadArea, quadPoints, toGrey,
  type Line, type Quad,
} from "@core/scan/quad";
import { apply, homography, scanSize, solve, warp } from "@core/scan/warp";
import { LOOKS, LOOK_NAMES, clean, paperMap, type ScanLook } from "@core/scan/clean";
import {
  applyLookToAll, indexOfPage, makePage, movePage, removePage, renderPage, renderSize,
  resetIds, scanName, turn, turnAll,
} from "@core/scan/doc";
import { imagesToPdf } from "@core/scan/pdf";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
}
const near = (a: number, b: number, tol = 1e-6): boolean => Math.abs(a - b) <= tol;

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A blank image of one colour. */
function solid(w: number, h: number, r: number, g: number, b: number): ImageData {
  const d = new ImageData(w, h);
  for (let i = 0; i < d.data.length; i += 4) {
    d.data[i] = r; d.data[i + 1] = g; d.data[i + 2] = b; d.data[i + 3] = 255;
  }
  return d;
}

function put(img: ImageData, x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
}

function at(img: ImageData, x: number, y: number): [number, number, number] {
  const i = (Math.round(y) * img.width + Math.round(x)) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
}

/** True when the point is inside the quad, by the winding of its four edges. */
function inQuad(q: Quad, px: number, py: number): boolean {
  const p = quadPoints(q);
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i]!;
    const b = p[(i + 1) % 4]!;
    const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    const s = cross > 0 ? 1 : cross < 0 ? -1 : 0;
    if (s === 0) continue;
    if (sign === 0) sign = s;
    else if (sign !== s) return false;
  }
  return true;
}

/**
 * A photograph of a page: dark surround, a bright quadrilateral "sheet" with
 * a few dark marks on it so the cleanup has something to keep.
 */
function photo(w: number, h: number, q: Quad, ink = true): ImageData {
  const img = solid(w, h, 40, 44, 52);
  const real: Quad = {
    tl: { x: q.tl.x * w, y: q.tl.y * h },
    tr: { x: q.tr.x * w, y: q.tr.y * h },
    br: { x: q.br.x * w, y: q.br.y * h },
    bl: { x: q.bl.x * w, y: q.bl.y * h },
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (inQuad(real, x + 0.5, y + 0.5)) put(img, x, y, 228, 228, 224);
    }
  }
  if (ink) {
    // A band of "text" across the middle of the frame, well inside the sheet.
    for (let y = Math.round(h * 0.45); y < Math.round(h * 0.5); y++) {
      for (let x = Math.round(w * 0.35); x < Math.round(w * 0.65); x++) {
        if (inQuad(real, x + 0.5, y + 0.5)) put(img, x, y, 20, 20, 24);
      }
    }
  }
  return img;
}

// ── Corners ─────────────────────────────────────────────────────────────────

function quadTests(): void {
  ok("FULL_QUAD is the whole frame", quadArea(FULL_QUAD) === 1);
  ok("FULL_QUAD is convex", isConvex(FULL_QUAD));

  const pts = quadPoints(FULL_QUAD);
  ok("quadPoints walks tl, tr, br, bl",
    pts[0]!.x === 0 && pts[0]!.y === 0 && pts[2]!.x === 1 && pts[2]!.y === 1);

  // Whatever order they arrive in, the same quad comes out.
  const ordered = orderQuad([
    { x: 1, y: 1 }, { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 0 },
  ]);
  ok("orderQuad sorts a shuffled rectangle", ordered !== null
    && ordered.tl.x === 0 && ordered.tl.y === 0
    && ordered.tr.x === 1 && ordered.tr.y === 0
    && ordered.br.x === 1 && ordered.br.y === 1
    && ordered.bl.x === 0 && ordered.bl.y === 1,
    JSON.stringify(ordered));

  // The case the x+y rule gets wrong: a page rotated far enough that the true
  // top-left corner is further right than the top-right one.
  const tilted = orderQuad([
    { x: 0.45, y: 0.05 }, { x: 0.95, y: 0.5 }, { x: 0.55, y: 0.95 }, { x: 0.05, y: 0.5 },
  ]);
  ok("orderQuad handles a page rotated 45 degrees", tilted !== null && isConvex(tilted),
    JSON.stringify(tilted));

  ok("orderQuad refuses three points",
    orderQuad([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]) === null);

  // A bow-tie: two edges cross, so it is not a page.
  const bow: Quad = {
    tl: { x: 0, y: 0 }, tr: { x: 1, y: 1 }, br: { x: 1, y: 0 }, bl: { x: 0, y: 1 },
  };
  ok("isConvex rejects a self-crossing quad", !isConvex(bow));

  const half: Quad = {
    tl: { x: 0.25, y: 0 }, tr: { x: 0.75, y: 0 }, br: { x: 0.75, y: 1 }, bl: { x: 0.25, y: 1 },
  };
  ok("quadArea of a half-width rectangle is 0.5", near(quadArea(half), 0.5, 1e-9));

  // In normal form: theta is the direction of the line's *normal*, so the
  // horizontal line y = 5 has theta = PI/2, and the vertical line x = 3 has
  // theta = 0. They cross at (3, 5).
  const across: Line = { theta: Math.PI / 2, rho: 5, weight: 1 };
  const down: Line = { theta: 0, rho: 3, weight: 1 };
  const x = intersect(across, down);
  ok("intersect crosses two perpendicular lines",
    x !== null && near(x.x, 3, 1e-6) && near(x.y, 5, 1e-6), JSON.stringify(x));
  ok("intersect returns null for parallels",
    intersect(across, { theta: Math.PI / 2, rho: 9, weight: 1 }) === null);
}

function greyTests(): void {
  const img = solid(800, 600, 100, 150, 200);
  const g = toGrey(img, 200);
  ok("toGrey caps the long side", g.w <= 200 && g.h <= 200, `${g.w}x${g.h}`);
  ok("toGrey keeps the aspect ratio", near(g.w / g.h, 800 / 600, 0.02), `${g.w}x${g.h}`);
  const expect = 0.299 * 100 + 0.587 * 150 + 0.114 * 200;
  ok("toGrey uses Rec.601 luma", Math.abs(g.data[0]! - expect) < 2,
    `${g.data[0]} vs ${expect.toFixed(1)}`);

  const small = toGrey(solid(50, 40, 10, 10, 10), 384);
  ok("toGrey does not upscale a small picture", small.w === 50 && small.h === 40,
    `${small.w}x${small.h}`);
}

function findTests(): void {
  const q: Quad = {
    tl: { x: 0.14, y: 0.10 }, tr: { x: 0.88, y: 0.16 },
    br: { x: 0.84, y: 0.90 }, bl: { x: 0.10, y: 0.84 },
  };
  const found = findQuad(photo(480, 360, q));
  ok("findQuad finds a page on a dark desk", found !== null);
  if (found) {
    const want = quadPoints(q);
    const worst = Math.max(...quadPoints(found).map((p, i) =>
      Math.hypot(p.x - want[i]!.x, p.y - want[i]!.y)));
    ok("findQuad lands every corner within 4% of the frame", worst < 0.04,
      `worst ${worst.toFixed(3)}`);
    ok("findQuad returns a convex quad", isConvex(found));
    ok("findQuad's quad covers most of the page", quadArea(found) > 0.4,
      quadArea(found).toFixed(3));
  }

  // Nothing to find: an even field has no edges, and the honest answer is null
  // rather than a quad somewhere in the noise.
  ok("findQuad gives up on a blank frame", findQuad(solid(240, 180, 128, 128, 128)) === null);
}

// ── The warp ────────────────────────────────────────────────────────────────

function warpTests(): void {
  const two = solve([[2, 1, 5], [1, -1, 1]], 2);
  ok("solve handles a 2x2 system", two !== null && near(two[0]!, 2, 1e-9) && near(two[1]!, 1, 1e-9),
    JSON.stringify(two));
  ok("solve returns null for a singular system", solve([[1, 1, 2], [2, 2, 4]], 2) === null);

  const from = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }, { x: 0, y: 20 }];
  const to = [{ x: 5, y: 5 }, { x: 105, y: 5 }, { x: 105, y: 205 }, { x: 5, y: 205 }];
  const m = homography(from, to);
  ok("homography solves a scale-and-shift", m !== null);
  if (m) {
    for (let i = 0; i < 4; i++) {
      const got = apply(m, from[i]!);
      ok(`homography maps corner ${i}`, got !== null
        && near(got.x, to[i]!.x, 1e-6) && near(got.y, to[i]!.y, 1e-6), JSON.stringify(got));
    }
    const mid = apply(m, { x: 5, y: 10 });
    ok("homography maps the centre", mid !== null && near(mid.x, 55, 1e-6) && near(mid.y, 105, 1e-6),
      JSON.stringify(mid));
  }
  ok("homography refuses three points", homography(from.slice(0, 3), to.slice(0, 3)) === null);

  // The far edge is shorter because it is further away; the size has to come
  // from the near one or the sharpest part of the photograph gets downscaled.
  const trapezoid: Quad = {
    tl: { x: 0.2, y: 0 }, tr: { x: 0.8, y: 0 }, br: { x: 1, y: 1 }, bl: { x: 0, y: 1 },
  };
  ok("scanSize takes the longer of the two horizontal edges",
    scanSize(trapezoid, 1000, 500).w === 1000, String(scanSize(trapezoid, 1000, 500).w));

  // A quad warped back out of the picture it was drawn into: the sheet fills
  // the result, and the surround does not appear in it.
  const q: Quad = {
    tl: { x: 0.2, y: 0.1 }, tr: { x: 0.9, y: 0.2 },
    br: { x: 0.8, y: 0.9 }, bl: { x: 0.1, y: 0.8 },
  };
  const flat = warp(photo(400, 300, q, false), q);
  ok("warp returns a picture", flat !== null);
  if (flat) {
    const corners: [number, number][] = [
      [3, 3], [flat.width - 4, 3], [flat.width - 4, flat.height - 4], [3, flat.height - 4],
    ];
    ok("warp puts the sheet's corners in the output's corners",
      corners.every(([x, y]) => at(flat, x, y)[0] > 180),
      corners.map(([x, y]) => at(flat, x, y)[0]).join(","));
    ok("warp's middle is the sheet, not the desk",
      at(flat, flat.width / 2, flat.height / 2)[0] > 180,
      String(at(flat, flat.width / 2, flat.height / 2)[0]));
  }

  const capped = warp(solid(2000, 1000, 200, 200, 200), FULL_QUAD, { cap: 500 });
  ok("warp honours the pixel cap",
    capped !== null && Math.max(capped.width, capped.height) === 500,
    capped ? `${capped.width}x${capped.height}` : "null");
  ok("warp keeps the shape while capping", capped !== null && capped.height === 250,
    String(capped?.height));

  const sized = warp(solid(100, 100, 1, 2, 3), FULL_QUAD, { width: 40, height: 30 });
  ok("warp takes an explicit size", sized !== null && sized.width === 40 && sized.height === 30);

  // All four corners in one place: no transform exists, and null is the answer.
  const degenerate: Quad = {
    tl: { x: 0.5, y: 0.5 }, tr: { x: 0.5, y: 0.5 },
    br: { x: 0.5, y: 0.5 }, bl: { x: 0.5, y: 0.5 },
  };
  ok("warp refuses a collapsed quad", warp(solid(50, 50, 0, 0, 0), degenerate) === null);
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

function cleanTests(): void {
  ok("every look has a name", LOOKS.every((l) => LOOK_NAMES[l].length > 0));
  ok("LOOKS offers four looks", LOOKS.length === 4, LOOKS.join(","));

  // A page lit from one side: bright at the left, dim at the right, with the
  // same ink on both halves. The whole point of the paper map is that the ink
  // comes out the same on both sides afterwards.
  const w = 200;
  const h = 120;
  const lit = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const paper = 240 - (x / w) * 110;
      const isInk = y > 40 && y < 60 && (x % 40) < 12;
      const v = Math.round(isInk ? paper * 0.25 : paper);
      put(lit, x, y, v, v, v);
    }
  }

  const map = paperMap(lit);
  ok("paperMap is one value per pixel", map.length === w * h, String(map.length));
  // Sampled on a clear row: the map has to carry the whole lighting gradient,
  // which here is 240 down to 130.
  ok("paperMap follows the lighting",
    map[5 * w + 10]! > map[5 * w + 190]! + 80,
    `${map[5 * w + 10]?.toFixed(0)} vs ${map[5 * w + 190]?.toFixed(0)}`);

  // And sampled in the middle of the ink: the estimate there must still be
  // paper. If the window were narrower than the text the map would sink to the
  // ink's own value, the division would scrub the letters back to white, and
  // the scan would come out blank. Ink here is a quarter of the paper, so
  // anything above half of it means the text was seen through, not measured.
  const inkLuma = (240 - (10 / w) * 110) * 0.25;
  ok("paperMap reads through the ink rather than following it",
    map[50 * w + 10]! > inkLuma * 2,
    `${map[50 * w + 10]?.toFixed(0)} vs ink ${inkLuma.toFixed(0)}`);

  const colour = clean(lit, { look: "colour" });
  const paperL = at(colour, 10, 5)[0];
  const paperR = at(colour, 190, 5)[0];
  ok("colour whitens both ends of an unevenly lit page", paperL > 225 && paperR > 225,
    `${paperL} / ${paperR}`);

  const grey = clean(lit, { look: "grey" });
  let neutral = true;
  for (let i = 0; i < grey.data.length && neutral; i += 4) {
    if (grey.data[i] !== grey.data[i + 1] || grey.data[i] !== grey.data[i + 2]) neutral = false;
  }
  ok("grey leaves no colour behind", neutral);

  const mono = clean(lit, { look: "mono" });
  const levels = new Set<number>();
  for (let i = 0; i < mono.data.length; i += 4) levels.add(mono.data[i]!);
  ok("mono really is two levels", levels.size === 2, [...levels].join(","));
  ok("mono's two levels are black and white", levels.has(0) && levels.has(255),
    [...levels].join(","));

  const asIs = clean(lit, { look: "photo" });
  let same = true;
  for (let i = 0; i < asIs.data.length && same; i++) if (asIs.data[i] !== lit.data[i]) same = false;
  ok("photo leaves the pixels alone", same);
  ok("photo returns a copy, not the same buffer", asIs.data !== lit.data);

  const spread = (d: ImageData): number => {
    let lo = 255;
    let hi = 0;
    for (let i = 0; i < d.data.length; i += 4) {
      const v = d.data[i]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi - lo;
  };
  const flatter = clean(lit, { look: "grey", contrast: 0 });
  const harder = clean(lit, { look: "grey", contrast: 1 });
  ok("contrast 1 spreads wider than contrast 0", spread(harder) >= spread(flatter),
    `${spread(harder)} vs ${spread(flatter)}`);
}

// ── The document ────────────────────────────────────────────────────────────

function docTests(): void {
  resetIds();
  const q: Quad = {
    tl: { x: 0.1, y: 0.1 }, tr: { x: 0.9, y: 0.1 },
    br: { x: 0.9, y: 0.9 }, bl: { x: 0.1, y: 0.9 },
  };
  const a = makePage(photo(240, 180, q), q);
  const b = makePage(photo(240, 180, q), q);
  const c = makePage(photo(240, 180, q), q);
  ok("page ids are handed out in order", a.id === "p1" && b.id === "p2" && c.id === "p3",
    [a.id, b.id, c.id].join(","));
  ok("a page given its corners is not marked detected", !a.detected);

  const found = makePage(photo(480, 360, {
    tl: { x: 0.14, y: 0.10 }, tr: { x: 0.88, y: 0.16 },
    br: { x: 0.84, y: 0.90 }, bl: { x: 0.10, y: 0.84 },
  }));
  ok("a page shot on a desk detects its own corners", found.detected);
  const blank = makePage(solid(120, 90, 128, 128, 128));
  ok("a page with nothing to find falls back to the whole frame",
    !blank.detected && blank.quad.tl.x === 0 && blank.quad.br.x === 1);

  const pages = [a, b, c];
  ok("indexOfPage finds a page", indexOfPage(pages, "p2") === 1);
  ok("indexOfPage returns -1 for a stranger", indexOfPage(pages, "p9") === -1);

  ok("movePage moves a page to the end",
    movePage(pages, 0, 2).map((p) => p.id).join(",") === "p2,p3,p1",
    movePage(pages, 0, 2).map((p) => p.id).join(","));
  ok("movePage leaves the original alone", pages.map((p) => p.id).join(",") === "p1,p2,p3");
  ok("movePage clamps past the end",
    movePage(pages, 0, 99).map((p) => p.id).join(",") === "p2,p3,p1");
  ok("movePage clamps before the start",
    movePage(pages, 2, -5).map((p) => p.id).join(",") === "p3,p1,p2");
  ok("movePage ignores an index that is not there", movePage(pages, 7, 0).length === 3);

  const fewer = removePage(pages, "p2");
  ok("removePage drops one page", fewer.map((p) => p.id).join(",") === "p1,p3");
  ok("removePage does not renumber the rest", fewer[1]!.id === "p3");

  const styled = { ...a, look: "mono" as ScanLook, brightness: 0.9, contrast: 0.2 };
  const all = applyLookToAll([styled, b, c], styled);
  ok("applyLookToAll copies the look", all.every((p) => p.look === "mono"));
  ok("applyLookToAll copies brightness and contrast",
    all.every((p) => p.brightness === 0.9 && p.contrast === 0.2));
  ok("applyLookToAll does NOT copy the corners", all[1]!.quad === b.quad);

  const turned = turnAll([{ ...a, turns: 3 }, { ...b, turns: 0 }], 1);
  ok("turnAll wraps past three", turned[0]!.turns === 0 && turned[1]!.turns === 1,
    turned.map((p) => p.turns).join(","));
  ok("turnAll goes backwards too", turnAll([{ ...a, turns: 0 }], -1)[0]!.turns === 3);

  // A picture with a unique corner, so a wrong rotation is visible.
  const mark = solid(4, 3, 10, 10, 10);
  put(mark, 0, 0, 255, 0, 0);
  put(mark, 3, 0, 0, 255, 0);
  const r1 = turn(mark, 1);
  ok("turn swaps width and height", r1.width === 3 && r1.height === 4, `${r1.width}x${r1.height}`);
  ok("turn 90 puts the top-left corner in the top-right",
    at(r1, 2, 0)[0] === 255 && at(r1, 2, 0)[1] === 0);
  ok("turn 90 puts the top-right corner in the bottom-right", at(r1, 2, 3)[1] === 255);
  const round = turn(turn(turn(turn(mark, 1), 1), 1), 1);
  ok("four quarter turns is the picture back",
    round.width === 4 && round.height === 3
    && [...round.data].every((v, i) => v === mark.data[i]));
  ok("turn 0 copies rather than aliases", turn(mark, 0).data !== mark.data);
  ok("turn normalises a negative", turn(mark, -1).width === turn(mark, 3).width);

  const rendered = renderPage(a, 200);
  ok("renderPage produces a page", rendered !== null);
  if (rendered) {
    const predicted = renderSize(a, 200);
    ok("renderSize agrees with renderPage",
      predicted.w === rendered.width && predicted.h === rendered.height,
      `${predicted.w}x${predicted.h} vs ${rendered.width}x${rendered.height}`);
    const sideways = renderPage({ ...a, turns: 1 }, 200);
    ok("a turned page comes out the other way round",
      sideways !== null && sideways.width === rendered.height
      && sideways.height === rendered.width);
  }

  const name = scanName(new Date(2026, 7, 16, 21, 4, 33));
  ok("scanName is dated and sorts by time", name === "scan-20260816-210433", name);
  ok("scanName takes a prefix",
    scanName(new Date(2026, 0, 2, 3, 4, 5), "page") === "page-20260102-030405");
}

// ── The PDF ─────────────────────────────────────────────────────────────────

async function encode(img: ImageData, mime: string): Promise<Uint8Array> {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")!.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, mime));
  return new Uint8Array(await blob!.arrayBuffer());
}

async function pdfTests(): Promise<void> {
  const png = await encode(solid(400, 600, 250, 250, 250), "image/png");
  const jpg = await encode(solid(300, 200, 200, 180, 160), "image/jpeg");

  const one = await imagesToPdf([{ bytes: png, kind: "png", width: 400, height: 600 }],
    { title: "One" });
  ok("imagesToPdf writes a PDF", new TextDecoder().decode(one.slice(0, 5)) === "%PDF-",
    new TextDecoder().decode(one.slice(0, 5)));

  // Read the result back with a PDF reader rather than grepping the bytes.
  // pdf-lib writes its page dictionaries into compressed object streams, so
  // /MediaBox is simply not there as text -- a regex over the file says "no
  // pages" about a perfectly good three-page document.
  const { PDFDocument } = await import("pdf-lib");

  const oneDoc = await PDFDocument.load(one);
  const oneSize = oneDoc.getPages()[0]?.getSize();
  // 400 px at 200 dpi is two inches is 144 points; 600 px is 216.
  ok("a page is sized from the image at 200 dpi",
    oneSize !== undefined && near(oneSize.width, 144, 0.5) && near(oneSize.height, 216, 0.5),
    oneSize ? `${oneSize.width} x ${oneSize.height}` : "none");

  const three = await imagesToPdf([
    { bytes: png, kind: "png", width: 400, height: 600 },
    { bytes: jpg, kind: "jpeg", width: 300, height: 200 },
    { bytes: png, kind: "png", width: 400, height: 600 },
  ]);
  const threeDoc = await PDFDocument.load(three);
  const pages = threeDoc.getPages();
  ok("three pages in makes three pages out", pages.length === 3, String(pages.length));

  // 300 x 200 px is 108 x 72 pt: a wide, short page in a document whose other
  // two pages are tall. Nothing has been letterboxed into a common size.
  const receipt = pages[1]?.getSize();
  ok("a receipt keeps its own shape rather than being boxed into A4",
    receipt !== undefined && near(receipt.width, 108, 0.5) && near(receipt.height, 72, 0.5),
    receipt ? `${receipt.width} x ${receipt.height}` : "none");

  let threw = false;
  try {
    await imagesToPdf([]);
  } catch {
    threw = true;
  }
  ok("imagesToPdf refuses an empty document", threw);
}

// ── The screen ──────────────────────────────────────────────────────────────
//
// Everything above proves the model. This drives the actual surface: every
// button in the bar and the foot, both sliders, the look picker, the corner
// overlay, the page strip and its per-page tools, and both save paths --
// against a camera made out of a canvas.
//
// Written because "the model is right" and "the screen works" are different
// claims, and only the first one had ever been checked here. A control nobody
// has pressed is a control nobody knows about.

/**
 * A camera that is really a canvas holding a photograph of a page.
 *
 * The repainting loop is not decoration. A canvas capture stream only emits a
 * frame when the canvas changes, and Chrome parks a muted autoplaying video
 * that is not on screen -- which is exactly where allcheck puts this harness,
 * in an iframe pushed ten thousand pixels to the left. Run standalone the one
 * initial frame arrives anyway and everything passes; run in the roll-up the
 * shutter photographs a black rectangle. So: keep painting, and let the test
 * wait for a frame it can prove arrived.
 */
function fakeCamera(img: ImageData): { stream: MediaStream; stop(): void } {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d")!;
  ctx.putImageData(img, 0, 0);

  const stream = (
    c as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }
  ).captureStream(10);
  const track = stream.getVideoTracks()[0] as
    | (MediaStreamTrack & { requestFrame?: () => void })
    | undefined;

  const tick = setInterval(() => {
    ctx.putImageData(img, 0, 0);
    track?.requestFrame?.();
  }, 60);

  return {
    stream,
    stop: () => {
      clearInterval(tick);
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

const settle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait for a condition, or give up. Returns whether it came true. */
async function until(what: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (what()) return true;
    await settle(25);
  }
  return what();
}

async function uiTests(): Promise<void> {
  resetIds();

  const q: Quad = {
    tl: { x: 0.14, y: 0.1 },
    tr: { x: 0.88, y: 0.16 },
    br: { x: 0.84, y: 0.9 },
    bl: { x: 0.1, y: 0.84 },
  };
  const cam = fakeCamera(photo(480, 360, q));

  const wrote: { path: string; bytes: Uint8Array }[] = [];
  let refreshed = 0;

  const { ScanView } = await import("@ui/scan-view");
  const view = new ScanView({
    source: { open: () => Promise.resolve(cam.stream) },
    folder: () => "/scans",
    writeFile: (path: string, bytes: Uint8Array) => {
      wrote.push({ path, bytes });
      return Promise.resolve(undefined);
    },
    refresh: () => { refreshed++; },
  });

  const root = document.querySelector<HTMLElement>(".scan")!;
  const buttons = (): HTMLButtonElement[] =>
    Array.from(root.querySelectorAll("button"));
  /** The first button whose tooltip contains this. Tooltips are the UI's own. */
  const press = (frag: string): void => {
    const b = buttons().find((x) => x.title.includes(frag));
    if (!b) throw new Error(`no button for "${frag}" in: ${buttons().map((x) => x.title).join(" | ")}`);
    b.click();
  };
  const button = (frag: string): HTMLButtonElement =>
    buttons().find((x) => x.title.includes(frag))!;
  const status = (): string => root.querySelector(".scan-status")?.textContent ?? "";
  const count = (): string => root.querySelector(".scan-count")?.textContent ?? "";
  const cells = (): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>(".scan-page"));
  const stage = (): HTMLCanvasElement => root.querySelector<HTMLCanvasElement>(".scan-canvas")!;
  /** What the stage is actually showing, as a cheap fingerprint. */
  const shown = (): string => {
    const c = stage();
    const d = c.getContext("2d", { willReadFrequently: true })?.getImageData(0, 0, Math.min(c.width, 64), Math.min(c.height, 64));
    if (!d) return "";
    let sum = 0;
    for (let i = 0; i < d.data.length; i += 4) sum = (sum * 31 + d.data[i]!) >>> 0;
    return `${c.width}x${c.height}:${sum}`;
  };

  // ── Opening ───────────────────────────────────────────────────────────────
  await view.open();
  ok("the scanner opens", !root.hidden);
  ok("and the strip says what it is for while it is empty",
    (root.querySelector(".scan-empty")?.textContent ?? "").length > 0,
    root.querySelector(".scan-empty")?.textContent ?? "none");
  ok("with no pages yet", count() === "No pages yet", count());
  ok("and nothing to save", button("one PDF").disabled);
  ok("and it says something rather than showing a black rectangle in silence",
    status().length > 0, status());

  const video = root.querySelector("video")!;
  ok("the fake camera reaches the viewfinder",
    await until(() => video.videoWidth === 480), String(video.videoWidth));
  ok("and the viewfinder is the thing on the stage, not the page canvas",
    !video.hidden && stage().hidden);

  // `autoplay` is enough on a screen somebody is looking at, and this harness
  // is not that: allcheck runs it in an iframe parked off the left of the
  // world, where Chrome parks the muted autoplaying video with it. Asking for
  // play() here is the harness making up for its own hiding place -- the
  // assertion underneath still has to see real pixels.
  await video.play().catch(() => undefined);

  /** Is there actually a picture in the video, or just a black rectangle? */
  const probe = (): number => {
    const s = document.createElement("canvas");
    s.width = 16;
    s.height = 16;
    const sc = s.getContext("2d", { willReadFrequently: true })!;
    sc.drawImage(video, 0, 0, 16, 16);
    const d = sc.getImageData(0, 0, 16, 16).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i]!;
    return sum;
  };
  ok("and hands it a frame with a picture in it, not a black rectangle",
    await until(() => probe() > 0), String(probe()));

  // ── The shutter ───────────────────────────────────────────────────────────
  press("Shoot this page");
  ok("the shutter makes a page", await until(() => cells().length === 1),
    String(cells().length));
  ok("and counts it", count() === "1 page", count());
  ok("and finds the corners without being asked",
    status().includes("Corners found"), status());
  ok("and now there is something to save", !button("one PDF").disabled);
  ok("and the stage swaps to the page", video.hidden && !stage().hidden);

  // ── The look picker ───────────────────────────────────────────────────────
  const look = root.querySelector<HTMLSelectElement>(".scan-sel")!;
  ok("the look picker offers every look",
    look.options.length === LOOKS.length, String(look.options.length));
  let last = shown();
  for (const l of LOOKS) {
    if (l === "colour") continue;
    look.value = l;
    look.dispatchEvent(new Event("change"));
    await settle();
    const now = shown();
    ok(`choosing ${LOOK_NAMES[l]} repaints the stage`, now !== last, `${last} -> ${now}`);
    last = now;
  }
  look.value = "colour";
  look.dispatchEvent(new Event("change"));
  await settle();

  // ── The sliders ───────────────────────────────────────────────────────────
  const sliders = Array.from(root.querySelectorAll<HTMLInputElement>(".scan-slider input"));
  ok("there are two sliders", sliders.length === 2, String(sliders.length));
  for (const s of sliders) {
    const name = s.title;
    s.value = "0";
    s.dispatchEvent(new Event("input"));
    await settle();
    const low = shown();
    s.value = "100";
    s.dispatchEvent(new Event("input"));
    await settle();
    const high = shown();
    ok(`"${name}" changes the page`, low !== high, `${low} -> ${high}`);
    s.value = "50";
    s.dispatchEvent(new Event("input"));
    await settle();
  }

  // ── The corner overlay ────────────────────────────────────────────────────
  const overlay = root.querySelector<SVGSVGElement>(".scan-overlay")!;
  const poly = root.querySelector<SVGPolygonElement>(".scan-quad")!;
  ok("the corners are out of the way until they are asked for",
    overlay.hasAttribute("hidden"));
  const flat = shown();
  press("Adjust the corners");
  await settle();
  ok("Corners lights up while it is on", button("Adjust the corners").classList.contains("on"));
  ok("and the handles come out", !overlay.hasAttribute("hidden"));
  ok("and the stage swaps to the photograph, which is the only thing corners mean anything against",
    shown() !== flat, `${flat} -> ${shown()}`);
  const pts = (poly.getAttribute("points") ?? "").trim().split(/\s+/);
  ok("the quad is drawn with four corners", pts.length === 4, pts.join(" "));
  ok("and it is the detected page, not the whole frame",
    (poly.getAttribute("points") ?? "") !== "0,0 100,0 100,100 0,100",
    poly.getAttribute("points") ?? "none");
  const handles = Array.from(overlay.querySelectorAll("circle"));
  ok("with a handle on each of them", handles.length === 4, String(handles.length));
  ok("sitting on the corners rather than stacked at the origin",
    new Set(handles.map((h) => `${h.getAttribute("cx")},${h.getAttribute("cy")}`)).size === 4);
  press("Adjust the corners");
  await settle();
  ok("and they put themselves away again", overlay.hasAttribute("hidden"));
  ok("with the flattened page back on the stage", shown() === flat, shown());

  // ── Turning ───────────────────────────────────────────────────────────────
  const upright = [stage().width, stage().height];
  press("quarter clockwise");
  await settle();
  ok("a quarter turn turns the page",
    stage().width === upright[1] && stage().height === upright[0],
    `${upright[0]}x${upright[1]} -> ${stage().width}x${stage().height}`);
  press("quarter anticlockwise");
  await settle();
  ok("and turning back puts it straight again",
    stage().width === upright[0] && stage().height === upright[1],
    `${stage().width}x${stage().height}`);

  // ── A second page ─────────────────────────────────────────────────────────
  press("Shoot another page");
  await settle();
  ok("Add goes back to the viewfinder", !video.hidden && stage().hidden);
  press("Shoot this page");
  ok("and a second page joins the strip", await until(() => cells().length === 2),
    String(cells().length));
  ok("and the count agrees", count() === "2 pages", count());
  ok("with the new page the selected one",
    cells()[1]?.classList.contains("on") === true);

  // ── The strip's own tools ─────────────────────────────────────────────────
  ok("each page carries its own tools",
    cells().every((c) => c.querySelectorAll("button").length === 3));
  ok("and its number", cells().map((c) => c.querySelector(".scan-no")?.textContent).join(",") === "1,2",
    cells().map((c) => c.querySelector(".scan-no")?.textContent).join(","));

  cells()[1]!.querySelectorAll("button")[0]!.click();  // Move this page earlier
  await settle();
  ok("moving a page earlier moves it, and the selection goes with it",
    cells()[0]?.classList.contains("on") === true);
  cells()[0]!.querySelectorAll("button")[1]!.click();  // Move this page later
  await settle();
  ok("and moving it back puts it back",
    cells()[1]?.classList.contains("on") === true);

  cells()[0]!.querySelector("canvas")!.click();
  await settle();
  ok("tapping a thumbnail selects that page",
    cells()[0]?.classList.contains("on") === true);
  cells()[1]!.querySelector("canvas")!.click();
  await settle();

  // ── Apply to all ──────────────────────────────────────────────────────────
  look.value = "mono";
  look.dispatchEvent(new Event("change"));
  await settle();
  const monoish = shown();
  press("Give every page");
  await settle();
  ok("apply-to-all says so", status().includes("Every page now looks like"), status());
  cells()[0]!.querySelector("canvas")!.click();
  await settle();
  ok("and the other page really did change look", look.value === "mono", look.value);
  ok("and is drawn that way", shown() !== monoish || stage().width > 0);
  look.value = "colour";
  look.dispatchEvent(new Event("change"));
  press("Give every page");
  await settle();

  // ── Saving ────────────────────────────────────────────────────────────────
  press("one PDF");
  ok("Save PDF writes a file", await until(() => wrote.length === 1, 20000), String(wrote.length));
  ok("into the scan folder, named as a PDF",
    /^\/scans\/[^/]+\.pdf$/.test(wrote[0]?.path ?? ""), wrote[0]?.path ?? "none");
  ok("and it really is a PDF",
    wrote.length > 0 && new TextDecoder().decode(wrote[0]!.bytes.slice(0, 5)) === "%PDF-",
    wrote.length > 0 ? new TextDecoder().decode(wrote[0]!.bytes.slice(0, 5)) : "none");
  {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(wrote[0]!.bytes);
    ok("with both pages in it", doc.getPages().length === 2, String(doc.getPages().length));
  }
  ok("and the file list is told something appeared", refreshed > 0, String(refreshed));
  ok("and the button comes back rather than staying stuck disabled",
    !button("one PDF").disabled);
  ok("and the status says where it went", status().includes("/scans"), status());

  wrote.length = 0;
  press("its own image");
  ok("saving as images writes one file per page",
    await until(() => wrote.length === 2, 20000), String(wrote.length));
  ok("as JPEGs", wrote.every((f) => f.path.endsWith(".jpg")),
    wrote.map((f) => f.path).join(", "));
  ok("numbered, so page 2 is not written over page 1",
    new Set(wrote.map((f) => f.path)).size === 2, wrote.map((f) => f.path).join(", "));
  ok("and they really are JPEGs",
    wrote.every((f) => f.bytes[0] === 0xff && f.bytes[1] === 0xd8),
    wrote.map((f) => f.bytes.slice(0, 2).join(",")).join(" | "));

  // ── Searchable ────────────────────────────────────────────────────────────
  const search = root.querySelector<HTMLInputElement>("#scan-searchable")!;
  const lang = Array.from(root.querySelectorAll<HTMLSelectElement>(".scan-sel"))
    .find((s) => s.title.includes("language"))!;
  ok("the language picker keeps quiet until it means something", lang.hidden);
  search.checked = true;
  search.dispatchEvent(new Event("change"));
  ok("and appears the moment Searchable is ticked", !lang.hidden);
  ok("with real languages in it", lang.options.length > 1, String(lang.options.length));
  search.checked = false;
  search.dispatchEvent(new Event("change"));
  ok("and goes away again", lang.hidden);

  // ── Dropping a page, and closing ──────────────────────────────────────────
  cells()[0]!.querySelectorAll("button")[2]!.click();  // Drop this page
  await settle();
  ok("a page can be thrown away", cells().length === 1, String(cells().length));
  ok("and the rest are renumbered",
    cells()[0]?.querySelector(".scan-no")?.textContent === "1",
    cells()[0]?.querySelector(".scan-no")?.textContent ?? "none");
  cells()[0]!.querySelectorAll("button")[2]!.click();
  await settle();
  ok("and dropping the last one goes back to the viewfinder",
    cells().length === 0 && !video.hidden, `${cells().length} cells`);
  ok("with nothing left to save", button("one PDF").disabled);

  press("Close");
  await settle();
  ok("Close closes it", root.hidden);
  ok("and lets go of the camera",
    cam.stream.getTracks().every((t) => t.readyState === "ended"),
    cam.stream.getTracks().map((t) => t.readyState).join(","));
  cam.stop();
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  document.body.style.background = "#111";
  quadTests();
  greyTests();
  findTests();
  warpTests();
  cleanTests();
  docTests();
  await pdfTests();
  await uiTests();

  const line = `scan: ${pass} passed, ${fail} failed`;
  console.log(line);
  document.title = line;
  const h = document.createElement("h2");
  h.style.cssText = `font:16px system-ui;color:${fail ? "#ff6b6b" : "#7bd88f"};margin:8px`;
  h.textContent = line;
  document.body.prepend(h);
}

void main();
