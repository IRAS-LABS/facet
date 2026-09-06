/**
 * Checks face detection against the claims that justify it (item 19).
 *
 * The hard part of this feature is not the code, it is knowing whether the code
 * is right. A cascade evaluator with one bit out of order in the LBP code, or a
 * `>` where the model was trained with `>=`, does not crash and does not look
 * broken — it just quietly finds nothing, or finds walls. So this harness runs
 * the real detector over real photographs and asserts on the boxes, and it also
 * draws them, because a green run over a detector is worth less than usual: the
 * only convincing evidence is a rectangle sitting on a face.
 *
 * The photographs are staged by `scripts/fixtures.ps1` into
 * `fixtures/_autoblurcheck/` and fetched over the dev server, the same way
 * autoblurcheck reaches its own. They are deliberately *not* `import`ed: a
 * static import of a file the repository does not carry is a module that fails
 * to resolve on a fresh clone, and the failure lands at build time on someone
 * who has no idea what a fixture is. Fetched, a missing file 404s with the name
 * of the script that stages it. They never reach the app bundle either way.
 *
 * Dev-only. Loaded by /facecheck.html, which is not a build input.
 *
 *   http://localhost:8183/facecheck.html
 */

import "../styles/base.css";

const faceAUrl = "/_autoblurcheck/face-a.jpg";
const faceBUrl = "/_autoblurcheck/face-b.jpg";

import {
  DEFAULTS,
  detectFaces,
  downscale,
  group,
  integral,
  toGray,
  type Box,
  type Gray,
} from "@core/vision/detect";
import { FACE_DEFAULTS, facesToRegions, overlap, track, unionAt } from "@core/vision/faces";
import { WIN } from "@core/vision/face-model";
import { newFaceRegions } from "@core/vision/apply";
import { sampleTimes, spansFor } from "@core/vision/video";

let pass = 0;
let fail = 0;

const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { pass++; console.log("ok  ", name); }
  else { fail++; console.log("FAIL", name, " ", detail); }
};

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

async function load(url: string): Promise<{ gray: Gray; img: HTMLImageElement }> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const px = g.getImageData(0, 0, c.width, c.height);
  return { gray: toGray(px.data, c.width, c.height), img };
}

/** Draw the picture with its boxes on it, so a human can check the machine. */
function show(title: string, img: HTMLImageElement, boxes: Box[], note: string): void {
  const wrap = document.createElement("figure");
  wrap.style.cssText = "margin:0 0 24px;display:inline-block;vertical-align:top";
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.style.cssText = "max-width:420px;height:auto;display:block;border:1px solid #444";
  const g = c.getContext("2d")!;
  g.drawImage(img, 0, 0);
  g.lineWidth = Math.max(2, c.width / 200);
  g.strokeStyle = "#3ddc84";
  g.font = `${Math.max(12, c.width / 32)}px system-ui`;
  g.fillStyle = "#3ddc84";
  for (const b of boxes) {
    g.strokeRect(b.x, b.y, b.w, b.h);
    g.fillText(String(b.score), b.x + 4, b.y - 4);
  }
  const cap = document.createElement("figcaption");
  cap.style.cssText = "font:13px system-ui;color:#ccc;padding:6px 2px;max-width:420px";
  cap.textContent = `${title} — ${note}`;
  wrap.append(c, cap);
  document.body.append(wrap);
}

async function main(): Promise<void> {
  document.body.style.cssText = "background:#111;color:#eee;font:14px system-ui;padding:16px";

  // ── The pieces, before the whole ─────────────────────────────────────────
  //
  // If the integral image is wrong then every assertion below is meaningless,
  // so it gets checked against arithmetic that is obviously right.

  {
    const g: Gray = { width: 3, height: 2, data: new Uint8ClampedArray([1, 2, 3, 4, 5, 6]) };
    const { w, sum } = integral(g);
    const rect = (x: number, y: number, rw: number, rh: number): number =>
      sum[(y + rh) * w + x + rw]! - sum[y * w + x + rw]! - sum[(y + rh) * w + x]! + sum[y * w + x]!;
    ok("an integral image sums the whole picture", rect(0, 0, 3, 2) === 21, String(rect(0, 0, 3, 2)));
    ok("and any rectangle inside it", rect(1, 0, 2, 2) === 16, String(rect(1, 0, 2, 2)));
    ok("including a single pixel", rect(2, 1, 1, 1) === 6, String(rect(2, 1, 1, 1)));
    ok("and an empty one", rect(1, 1, 0, 0) === 0);
  }

  {
    // Box filtering, not pixel dropping: a checkerboard must average to grey,
    // not alias to solid black or solid white.
    const data = new Uint8ClampedArray(16);
    for (let i = 0; i < 16; i++) data[i] = (i + Math.floor(i / 4)) % 2 === 0 ? 0 : 255;
    const small = downscale({ width: 4, height: 4, data }, 2, 2);
    ok(
      "downscaling averages rather than drops",
      [...small.data].every((v) => near(v, 128, 2)),
      [...small.data].join(","),
    );
    const same = { width: 4, height: 4, data };
    ok("downscaling to the same size is a no-op", downscale(same, 4, 4) === same);
  }

  {
    // Luma, not a flat average. A pure green and a pure blue of the same
    // nominal brightness must not come out as the same grey.
    const rgba = new Uint8ClampedArray([0, 255, 0, 255, 0, 0, 255, 255]);
    const g = toGray(rgba, 2, 1);
    ok("green reads far brighter than blue", g.data[0]! > g.data[1]! + 100, `${g.data[0]},${g.data[1]}`);
  }

  {
    // Grouping is where a real detector's output becomes a usable one.
    const at = (x: number, y: number, s: number): Box => ({ x, y, w: s, h: s, score: 1 });
    const cluster = [at(100, 100, 50), at(102, 101, 50), at(101, 103, 51), at(400, 20, 50)];
    const kept = group(cluster, 3);
    ok("a cluster of three becomes one box", kept.length === 1, String(kept.length));
    ok("and the box is the average of the cluster", near(kept[0]!.x, 101, 1.5), String(kept[0]?.x));
    ok("and remembers how many agreed", kept[0]!.score === 3, String(kept[0]?.score));
    ok("a lone window is not a face", group([at(10, 10, 40)], 3).length === 0);
    ok("unless you ask for one", group([at(10, 10, 40)], 1).length === 1);
    ok("nothing in, nothing out", group([], 3).length === 0);

    // Proportional tolerance: the same 12 px gap is one face at 400 px and two
    // faces at 40. Two boxes only — a third sitting between them would bridge
    // the two by transitivity and prove nothing about the tolerance.
    const big = group([at(0, 0, 400), at(12, 0, 400)], 2);
    ok("12 px apart is the same big face", big.length === 1, String(big.length));
    const small = group([at(0, 0, 40), at(12, 0, 40)], 2);
    ok("12 px apart is not the same small face", small.length === 0, String(small.length));

    // ...and that bridging is deliberate, not an accident. A face found at a
    // run of adjacent positions must come out as one cluster even though the
    // two ends of the run are further apart than the tolerance.
    const drifted = group([at(0, 0, 40), at(6, 0, 40), at(12, 0, 40), at(18, 0, 40)], 4);
    ok("a run of overlapping windows is one face end to end", drifted.length === 1,
      String(drifted.length));

    // An eye inside a head is not a second person.
    const nested = group(
      [
        at(0, 0, 200), at(1, 1, 200), at(2, 0, 201), at(0, 2, 200),
        at(60, 60, 40), at(61, 61, 40), at(60, 62, 41),
      ],
      3,
    );
    ok("a box swallowed by a stronger one is dropped", nested.length === 1, String(nested.length));
  }

  {
    ok("the model window is what the cascade was trained at", WIN === 45, String(WIN));
    let threw = false;
    try {
      detectFaces({ width: 60, height: 60, data: new Uint8ClampedArray(3600) }, { scaleStep: 1 });
    } catch { threw = true; }
    ok("a scale step of 1 is refused rather than looping forever", threw);
    ok(
      "a picture smaller than the window finds nothing",
      detectFaces({ width: 20, height: 20, data: new Uint8ClampedArray(400) }).length === 0,
    );
    // Flat grey is the case that catches an inverted comparison: every LBP code
    // is 255, and a detector with `>` instead of `>=` lights up the whole frame.
    const flat = new Uint8ClampedArray(300 * 300);
    flat.fill(128);
    ok(
      "a blank wall is not a crowd",
      detectFaces({ width: 300, height: 300, data: flat }).length === 0,
      String(detectFaces({ width: 300, height: 300, data: flat }).length),
    );
  }

  // ── Real photographs ─────────────────────────────────────────────────────

  {
    const { gray, img } = await load(faceAUrl);
    const t0 = performance.now();
    const faces = detectFaces(gray);
    const ms = Math.round(performance.now() - t0);

    ok("it finds the one face in a portrait", faces.length === 1, `found ${faces.length}`);
    const f = faces[0];
    if (f) {
      // The face sits in the upper-middle of this 512x512 frame. Loose bounds:
      // this asserts "on the face", not "to the pixel".
      ok("and puts the box on the face", near(f.x + f.w / 2, 265, 45) && near(f.y + f.h / 2, 275, 45),
        `centre ${Math.round(f.x + f.w / 2)},${Math.round(f.y + f.h / 2)}`);
      ok("at a plausible size", f.w > 120 && f.w < 260, String(Math.round(f.w)));
      ok("with several windows agreeing", f.score >= 3, String(f.score));
    }
    ok("and does it fast enough to feel instant", ms < 1500, `${ms} ms`);
    show("portrait", img, faces, `${faces.length} face(s), ${ms} ms`);

    // Working size is an optimisation, not a change of answer.
    const full = detectFaces(gray, { workingSize: 4096 });
    ok("working small does not change the answer", full.length === faces.length,
      `${full.length} vs ${faces.length}`);
    if (full[0] && f) {
      ok("nor move the box far", overlap(full[0], f) > 0.7, String(overlap(full[0], f).toFixed(2)));
    }

    // minSize is a floor on the answer, not a hint.
    ok("a minimum size larger than the face finds nothing",
      detectFaces(gray, { minSize: 400 }).length === 0);
    ok("a maximum size smaller than the face finds nothing",
      detectFaces(gray, { maxSize: 60 }).length === 0);

    // Regions, which is what the rest of the app actually consumes.
    const regions = facesToRegions(faces, gray.width, gray.height);
    ok("a face becomes exactly one region", regions.length === faces.length);
    const r = regions[0];
    if (r && f) {
      ok("and it is an ellipse, not a rectangle", r.shape === "ellipse", r.shape);
      ok("and it is enabled", r.enabled);
      ok("and it is named in words", r.label === "face", r.label);
      ok("and its geometry is normalised", r.rect.x > 0 && r.rect.x < 1 && r.rect.w < 1,
        JSON.stringify(r.rect));
      ok("and it covers more than the detector's tight crop",
        r.rect.w * gray.width > f.w, `${(r.rect.w * gray.width).toFixed(0)} vs ${f.w.toFixed(0)}`);
      ok("and it reaches further below the box than above it, for the chin",
        f.y - r.rect.y * gray.height < (r.rect.y + r.rect.h) * gray.height - (f.y + f.h));
      ok("and it stays inside the frame",
        r.rect.x >= 0 && r.rect.y >= 0 && r.rect.x + r.rect.w <= 1 && r.rect.y + r.rect.h <= 1);
    }
    const many = facesToRegions([...faces, ...faces], gray.width, gray.height);
    ok("two faces are numbered rather than both called 'face'",
      many[0]?.label === "face 1" && many[1]?.label === "face 2", `${many[0]?.label}/${many[1]?.label}`);
    ok("regions of a zero-sized image are refused",
      facesToRegions(faces, 0, 0).length === 0);
  }

  {
    // A harder frame: the face is small, off-centre and not straight on. The
    // assertion is deliberately weak — this is here to prove the detector does
    // not fall over or hallucinate on ordinary material, not that it is good.
    const { gray, img } = await load(faceBUrl);
    const faces = detectFaces(gray, { minSize: 24 });
    ok("a busy frame does not produce a crowd of false faces", faces.length <= 2,
      `found ${faces.length}`);
    show("a harder frame", img, faces, `${faces.length} face(s) — small and turned`);
  }

  // ── Tracking across frames ───────────────────────────────────────────────

  {
    const b = (x: number): Box => ({ x, y: 50, w: 60, h: 60, score: 5 });
    const walked = track([
      { t: 0.0, boxes: [b(100)] },
      { t: 0.5, boxes: [b(115)] },
      { t: 1.0, boxes: [b(130)] },
    ]);
    ok("a face walking across the frame is one track", walked.length === 1, String(walked.length));
    ok("and the track knows when it starts and ends",
      walked[0]?.from === 0 && walked[0]?.to === 1, `${walked[0]?.from}-${walked[0]?.to}`);

    const jumped = track([{ t: 0, boxes: [b(100)] }, { t: 0.5, boxes: [b(400)] }]);
    ok("two faces far apart are two tracks", jumped.length === 2, String(jumped.length));

    // The blink. One missed detection must not split a person in two, because
    // the frame where the blur drops out is the frame that gets screenshotted.
    const blinked = track([
      { t: 0.0, boxes: [b(100)] },
      { t: 0.5, boxes: [] },
      { t: 1.0, boxes: [b(105)] },
    ]);
    ok("a missed frame does not split a face in two", blinked.length === 1, String(blinked.length));

    const left = track([
      { t: 0.0, boxes: [b(100)] },
      { t: 3.0, boxes: [] },
      { t: 4.0, boxes: [b(100)] },
    ]);
    ok("but a long absence does close the track", left.length === 2, String(left.length));

    const two = track([
      { t: 0, boxes: [b(100), b(400)] },
      { t: 0.5, boxes: [b(110), b(405)] },
    ]);
    ok("two people are followed separately", two.length === 2, String(two.length));
    ok("and one detection cannot feed two tracks",
      two.every((t) => t.samples.length === 2), two.map((t) => t.samples.length).join(","));
    ok("nothing on screen is no tracks", track([{ t: 0, boxes: [] }]).length === 0);

    const u = unionAt(walked[0]!, 0, 1);
    ok("the burn-in box covers everywhere the face went",
      u !== null && u.x <= 100 && u.x + u.w >= 190, JSON.stringify(u));
    ok("an interval with no samples has no box", unionAt(walked[0]!, 5, 6) === null);
  }

  {
    ok("overlap of a box with itself is total",
      overlap({ x: 0, y: 0, w: 10, h: 10, score: 1 }, { x: 0, y: 0, w: 10, h: 10, score: 1 }) === 1);
    ok("overlap of boxes that miss is nothing",
      overlap({ x: 0, y: 0, w: 10, h: 10, score: 1 }, { x: 50, y: 0, w: 10, h: 10, score: 1 }) === 0);
    ok("touching edges do not count as overlapping",
      overlap({ x: 0, y: 0, w: 10, h: 10, score: 1 }, { x: 10, y: 0, w: 10, h: 10, score: 1 }) === 0);
  }

  // ── Sampling a video ─────────────────────────────────────────────────────

  {
    ok("a file with no duration is not sampled", sampleTimes(0).length === 0);
    ok("nor is a broken one", sampleTimes(NaN).length === 0 && sampleTimes(-5).length === 0);

    const ten = sampleTimes(10);
    ok("ten seconds at 2 Hz is twenty samples", ten.length === 20, String(ten.length));
    ok("and none of them is frame zero", ten[0]! > 0, String(ten[0]));
    ok("and none of them is past the end", ten[ten.length - 1]! < 10, String(ten[ten.length - 1]));
    ok("and they run forwards", ten.every((t, i) => i === 0 || t > ten[i - 1]!));

    // Half an hour at 2 Hz would be 3600 extractions. The cap drops the rate
    // instead of the coverage: the last sample must still be near the end.
    const long = sampleTimes(1800);
    ok("a long file is capped by count, not truncated", long.length === 240, String(long.length));
    ok("and still reaches the end of it", long[long.length - 1]! > 1790, String(long[long.length - 1]));

    ok("a very short file still gets one look", sampleTimes(0.2).length === 1, String(sampleTimes(0.2).length));
  }

  // ── Tracks into burn-in spans ────────────────────────────────────────────

  {
    const b = (x: number, y = 50, s = 60): Box => ({ x, y, w: s, h: s, score: 5 });
    const W = 640;
    const H = 360;

    const still = track([
      { t: 1.0, boxes: [b(100)] },
      { t: 1.5, boxes: [b(100)] },
      { t: 2.0, boxes: [b(100)] },
      { t: 2.5, boxes: [b(100)] },
    ]);
    const s1 = spansFor(still, W, H, 30);
    ok("a face that does not move is one span, not one per window",
      s1.spans.length === 1, String(s1.spans.length));
    ok("and it was not coarsened to get there", !s1.coarsened);
    const sp = s1.spans[0]!;
    ok("the span starts before the first detection", sp.from < 1.0, String(sp.from));
    ok("and ends after the last one", sp.to > 2.5, String(sp.to));
    ok("and covers more than the detector's own box",
      sp.x < 100 && sp.x + sp.w > 160, JSON.stringify(sp));
    ok("and its corners are whole pixels",
      Number.isInteger(sp.x) && Number.isInteger(sp.y) && Number.isInteger(sp.w) && Number.isInteger(sp.h),
      JSON.stringify(sp));
    ok("and it carries the same blur the still editor would use",
      sp.kind === FACE_DEFAULTS.kind && sp.amount === FACE_DEFAULTS.amount, `${sp.kind}/${sp.amount}`);

    const walked = track([
      { t: 0.0, boxes: [b(100)] },
      { t: 0.5, boxes: [b(130)] },
      { t: 1.0, boxes: [b(160)] },
      { t: 1.5, boxes: [b(190)] },
      { t: 2.0, boxes: [b(220)] },
      { t: 2.5, boxes: [b(250)] },
      { t: 3.0, boxes: [b(280)] },
    ]);
    const s2 = spansFor(walked, W, H, 30);
    ok("a face walking across the frame is cut into several boxes",
      s2.spans.length > 1, String(s2.spans.length));
    ok("and each one is far narrower than the whole walk",
      s2.spans.every((s) => s.w < 200), s2.spans.map((s) => s.w).join(","));
    ok("and together they cover the whole time it was there",
      s2.spans[0]!.from <= 0 && s2.spans[s2.spans.length - 1]!.to >= 3,
      `${s2.spans[0]?.from}-${s2.spans[s2.spans.length - 1]?.to}`);
    ok("and there is no unblurred gap between them",
      s2.spans.every((s, i) => i === 0 || s.from <= s2.spans[i - 1]!.to + 1e-6),
      s2.spans.map((s) => `${s.from.toFixed(2)}-${s.to.toFixed(2)}`).join(" "));

    // Over the ceiling the whole track collapses to one box — bluntly, and the
    // caller is told so, because the difference is visible in the export.
    const s3 = spansFor(walked, W, H, 30, { max: 1 });
    ok("too many spans collapses to one box per face", s3.spans.length === 1, String(s3.spans.length));
    ok("and says so", s3.coarsened);
    ok("and that one box covers everywhere the face went",
      s3.spans[0]!.x <= 100 && s3.spans[0]!.x + s3.spans[0]!.w >= 340, JSON.stringify(s3.spans[0]));

    // An overlay hanging off the frame is not an error in ffmpeg, it is a
    // silently shifted rectangle — which is worse than an error.
    const corner = track([{ t: 1, boxes: [b(0, 0)] }, { t: 1.5, boxes: [b(0, 0)] }]);
    const s4 = spansFor(corner, W, H, 30).spans[0]!;
    ok("a face against the top-left corner does not pad off the frame",
      s4.x === 0 && s4.y === 0, JSON.stringify(s4));
    const edge = track([{ t: 1, boxes: [b(W - 60, H - 60)] }, { t: 1.5, boxes: [b(W - 60, H - 60)] }]);
    const s5 = spansFor(edge, W, H, 30).spans[0]!;
    ok("nor against the bottom-right one",
      s5.x + s5.w <= W && s5.y + s5.h <= H, JSON.stringify(s5));

    ok("the hold is clamped to the start of the file",
      spansFor(track([{ t: 0, boxes: [b(100)] }]), W, H, 30).spans.every((s) => s.from >= 0));
    ok("and to the end of it",
      spansFor(track([{ t: 9.9, boxes: [b(100)] }]), W, H, 10).spans.every((s) => s.to <= 10));

    ok("no faces is no spans", spansFor([], W, H, 30).spans.length === 0);
    ok("and a frame of no size is refused", spansFor(still, 0, 0, 30).spans.length === 0);

    const both = spansFor(track([
      { t: 0, boxes: [b(60), b(400)] },
      { t: 0.5, boxes: [b(60), b(400)] },
    ]), W, H, 30);
    ok("two people get their own spans", both.spans.length === 2, String(both.spans.length));
  }

  // ── Detections added to an existing edit ─────────────────────────────────

  {
    const box = (x: number): Box => ({ x, y: 100, w: 80, h: 80, score: 6 });
    const fresh = newFaceRegions([], [box(100), box(400)], 800, 600);
    ok("both faces become regions on an empty edit", fresh.length === 2, String(fresh.length));
    ok("with distinct ids", fresh[0]!.id !== fresh[1]!.id, fresh.map((r) => r.id).join(","));

    // The point of the whole exercise: pressing the button twice must not stack
    // two blurs on one face.
    const again = newFaceRegions(fresh, [box(100), box(400)], 800, 600);
    ok("running it twice adds nothing the second time", again.length === 0, String(again.length));

    const mixed = newFaceRegions(fresh, [box(100), box(700)], 800, 600);
    ok("but a newly found face is still added", mixed.length === 1, String(mixed.length));
    ok("and it does not reuse an id already taken",
      !fresh.some((r) => r.id === mixed[0]!.id), mixed[0]!.id);

    const off = fresh.map((r) => ({ ...r, enabled: false }));
    ok("a switched-off region does not count as covering a face",
      newFaceRegions(off, [box(100)], 800, 600).length === 1);
  }

  ok("the defaults look for faces at least 32 px across", DEFAULTS.minSize === 32);

  const line = `faces: ${pass} passed, ${fail} failed`;
  console.log(fail === 0 ? `%c${line}` : `%c${line}`, `color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`);
  const banner = document.createElement("h2");
  banner.textContent = line;
  banner.style.cssText = `font:600 18px system-ui;color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`;
  document.body.prepend(banner);
}

void main();
