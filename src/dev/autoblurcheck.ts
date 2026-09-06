/**
 * Harness for auto-blur: the pure pre/post-processing behind every detector
 * on synthetic tensors (letterbox, YOLOX / YuNet / plate decoding, NMS), the
 * rule-based categories (text rules, cards, terminals, QR finder search),
 * the settings store, detections → regions / layers, the settings sheet and
 * the editor's Auto-blur sheet — then the real models on the bundled test
 * pictures, drawn on the page so a screenshot is evidence.
 *
 * Runs in the dev server (`/autoblurcheck.html`) and rolls up into
 * allcheck.html under "autoblur".
 */

import "../styles/base.css";
import "../styles/phone.css";
import "../styles/phone-viewer.css";
import "../styles/phone-editor.css";
import "../styles/phone-prefs.css";

import { PhoneEditor, railFor, type EditorHost } from "@ui/phone/editor";
import { SettingsSheet } from "@ui/phone/settings-sheet";
import { PhonePrefsStore, type PrefsStorage } from "@core/phone/prefs";
import { AutoBlurStore, sanitize, STORAGE_KEY } from "@core/phone/autoblur-prefs";
import { AUTO_CATEGORIES, defaultConfig, enabledCategories } from "@core/vision/autoblur-config";
import {
  decodePlates, decodeYolox, decodeYunet, iou, letterbox, nms, unletterbox, yoloxRows, type Det,
} from "@core/vision/onnx";
import { luhn, matchSpans, textHitBoxes } from "@core/vision/textrules";
import { cardEvidence, detectCards } from "@core/vision/cards";
import { judgeTerminal, looksLikeScreenshot } from "@core/vision/terminals";
import { findQrBoxes } from "@core/vision/codes";
import { detectAll, detectionsToRegions, summarise, type Detection } from "@core/vision/autoblur";
import { autoSampleTimes, layersFromDetections, type FrameDetections } from "@core/vision/autoblur-video";
import { prepareInput } from "@core/vision/autoblur-image";
import { getRunner } from "@core/vision/onnx-runner";
import type { OcrPage, OcrWord } from "@core/ocr/page";
import { Tesseract } from "@core/ocr/engine";
import { TOOLS } from "@ui/phone/tools";
import { el } from "@ui/phone/dom";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
}
const near = (a: number, b: number, tol = 0.5): boolean => Math.abs(a - b) <= tol;

function mapStorage(): PrefsStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
}

function word(text: string, x: number, y: number, w: number, h: number, confidence = 90): OcrWord {
  return { text, box: { x, y, w, h }, confidence };
}
function pageOf(width: number, height: number, lines: OcrWord[][]): OcrPage {
  const ls = lines.map((words) => {
    const x0 = Math.min(...words.map((w) => w.box.x)), y0 = Math.min(...words.map((w) => w.box.y));
    const x1 = Math.max(...words.map((w) => w.box.x + w.box.w)), y1 = Math.max(...words.map((w) => w.box.y + w.box.h));
    return { words, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, confidence: 90 };
  });
  const x0 = Math.min(...ls.map((l) => l.box.x)), y0 = Math.min(...ls.map((l) => l.box.y));
  const x1 = Math.max(...ls.map((l) => l.box.x + l.box.w)), y1 = Math.max(...ls.map((l) => l.box.y + l.box.h));
  return { width, height, blocks: [{ lines: ls, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }], confidence: 90, angle: 0, language: "eng" };
}

// ── Pure tensor maths ──────────────────────────────────────────────────────

function tensorTests(): void {
  // letterbox: a 100×50 red picture into 64×64, top-left, grey fill below.
  const w = 100, h = 50;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = 255; rgba[i * 4 + 3] = 255; }
  const lb = letterbox(rgba, w, h, 64);
  ok("letterbox ratio fits the long edge", near(lb.ratio, 0.64, 1e-6), String(lb.ratio));
  ok("letterbox covers 64×32", lb.scaledW === 64 && lb.scaledH === 32, `${lb.scaledW}x${lb.scaledH}`);
  ok("letterbox keeps red in R", lb.data[0] === 255 && lb.data[64 * 64] === 0, `${lb.data[0]},${lb.data[64 * 64]}`);
  ok("letterbox fills the rest with 114", lb.data[63 * 64] === 114, String(lb.data[63 * 64]));
  const bgr = letterbox(rgba, w, h, 64, { order: "bgr", scale: 1 / 255 });
  ok("bgr + scale puts 1.0 in the third plane", near(bgr.data[2 * 64 * 64]!, 1, 1e-6) && bgr.data[0] === 0);
  const back = unletterbox({ x: 32, y: 16, w: 32, h: 16, score: 1, cls: 0 }, lb.ratio, w, h);
  ok("unletterbox maps back to source pixels", near(back.x, 50) && near(back.y, 25) && near(back.w, 50) && near(back.h, 25), JSON.stringify(back));

  // NMS.
  const a: Det = { x: 0, y: 0, w: 100, h: 100, score: 0.9, cls: 62 };
  const b: Det = { x: 5, y: 5, w: 100, h: 100, score: 0.8, cls: 63 };
  const c: Det = { x: 300, y: 300, w: 50, h: 50, score: 0.7, cls: 62 };
  ok("iou of near-identical boxes is high", iou(a, b) > 0.8, String(iou(a, b)));
  ok("nms drops the overlapping weaker box", nms([a, b, c]).length === 2);
  ok("nms per class keeps a tv and a laptop apart", nms([a, b, c], 0.45, true).length === 3);

  // YOLOX: one tv at grid (5,5) of stride 8, a weaker duplicate, and a cup.
  const size = 416, nc = 80, stride = 5 + nc;
  const rows = yoloxRows(size);
  ok("YOLOX emits 3549 rows at 416", rows === 3549, String(rows));
  const out = new Float32Array(rows * stride);
  const put = (row: number, cx: number, cy: number, lw: number, lh: number, obj: number, cls: number, p: number): void => {
    const o = row * stride;
    out[o] = cx; out[o + 1] = cy; out[o + 2] = lw; out[o + 3] = lh; out[o + 4] = obj; out[o + 5 + cls] = p;
  };
  put(5 * 52 + 5, 0.5, 0.5, Math.log(10), Math.log(5), 0.9, 62, 0.9);
  put(5 * 52 + 6, 0.4, 0.5, Math.log(10), Math.log(5), 0.8, 62, 0.8);
  put(2704 + 3 * 26 + 3, 0.5, 0.5, Math.log(2), Math.log(2), 0.9, 41, 0.9);
  const dets = decodeYolox(out, size, nc, 0.3);
  ok("YOLOX decode finds two objects after NMS", dets.length === 2, String(dets.length));
  const tv = dets.find((d) => d.cls === 62);
  ok("the tv box is where the grid says", !!tv && near(tv.x, 4) && near(tv.y, 24) && near(tv.w, 80) && near(tv.h, 40), JSON.stringify(tv));
  ok("score is objectness × class", !!tv && near(tv.score, 0.81, 1e-6), String(tv?.score));
  const only = decodeYolox(out, size, nc, 0.3, 0.45, new Set([62]));
  ok("a class filter drops the cup", only.length === 1 && only[0]!.cls === 62, String(only.length));

  // YuNet: one face at stride 32, grid (3,4).
  const n32 = 640 / 32;
  const cls = new Float32Array(n32 * n32), obj = new Float32Array(n32 * n32), bbox = new Float32Array(n32 * n32 * 4);
  const i = 4 * n32 + 3;
  cls[i] = 0.81; obj[i] = 1;
  bbox[i * 4] = 0.5; bbox[i * 4 + 1] = 0.5; bbox[i * 4 + 2] = Math.log(2); bbox[i * 4 + 3] = Math.log(2);
  const faces = decodeYunet({ 32: { cls, obj, bbox } }, 640);
  ok("YuNet decode finds the one face", faces.length === 1, String(faces.length));
  const f = faces[0];
  ok("the face is centred on its cell", !!f && near(f.x, 80) && near(f.y, 112) && near(f.w, 64) && near(f.h, 64), JSON.stringify(f));
  ok("score is √(cls × obj)", !!f && near(f.score, 0.9, 1e-6), String(f?.score));
  ok("below the floor is nothing", decodeYunet({ 32: { cls, obj, bbox } }, 640, 0.95).length === 0);

  // Plates: end2end rows.
  const plates = decodePlates(new Float32Array([0, 10, 20, 110, 60, 0, 0.9, 0, 0, 0, 0, 0, 0, 0.1]));
  ok("plate decode keeps the confident row", plates.length === 1, String(plates.length));
  ok("as x/y/w/h", !!plates[0] && plates[0].x === 10 && plates[0].w === 100 && plates[0].h === 40, JSON.stringify(plates[0]));
}

// ── Rule-based categories ──────────────────────────────────────────────────

function ruleTests(): void {
  const rules = { emails: true, phones: true, urls: true, cardNumbers: true, keywords: ["secret"] };
  ok("luhn accepts a valid number", luhn("4111 1111 1111 1111"));
  ok("luhn rejects a bad one", !luhn("4111 1111 1111 1112"));
  ok("luhn wants 13–19 digits", !luhn("123456"));
  const spans = matchSpans("mail bob@example.com or +1 (555) 123-4567, see www.example.org, card 4111 1111 1111 1111, SECRET plan", rules);
  const kinds = new Set(spans.map((s) => s.rule));
  ok("email rule matches", kinds.has("email"), [...kinds].join(","));
  ok("phone rule matches", kinds.has("phone"));
  ok("url rule matches", kinds.has("url"));
  ok("card rule matches only with Luhn", kinds.has("card") && matchSpans("card 4111 1111 1111 1112", rules).every((s) => s.rule !== "card"));
  ok("keywords match case-insensitively", kinds.has("keyword"));
  ok("rules off match nothing", matchSpans("bob@example.com", { ...rules, emails: false, keywords: [] }).length === 0);

  // Cards: six words in two lines making a 1.6:1 block, plus a far-off word.
  const card = pageOf(1000, 1000, [
    [word("JOHN", 100, 100, 120, 40), word("Q", 230, 100, 40, 40), word("PUBLIC", 280, 100, 180, 40)],
    [word("4111", 100, 170, 100, 40), word("1111", 210, 170, 100, 40), word("1111", 320, 170, 100, 40), word("1111", 430, 170, 70, 40)],
    [word("VALID", 100, 240, 120, 40), word("THRU", 230, 240, 100, 40), word("12/29", 340, 240, 100, 40)],
    [word("lonely", 900, 900, 60, 20)],
  ]);
  const cards = detectCards(card);
  ok("a block of words shaped like a card is a card", cards.length === 1, String(cards.length));
  ok("and the box hugs the words", !!cards[0] && near(cards[0].x, 100) && near(cards[0].w, 400) && near(cards[0].h, 180), JSON.stringify(cards[0]));
  // A poster: six words in two lines, card-shaped, no card evidence. The office picture's diploma and poster.
  const poster = pageOf(1000, 1000, [
    [word("SUMMER", 100, 100, 160, 40), word("MUSIC", 280, 100, 140, 40), word("FESTIVAL", 440, 100, 200, 40)],
    [word("Live", 100, 170, 90, 40), word("at", 200, 170, 40, 40), word("the", 250, 170, 70, 40), word("park", 330, 170, 100, 40)],
  ]);
  ok("a poster-shaped block of ordinary words is not a card", detectCards(poster).length === 0, String(detectCards(poster).length));
  const idCard = pageOf(1000, 1000, [
    [word("DRIVER", 100, 100, 140, 40), word("LICENSE", 260, 100, 160, 40)],
    [word("DOB", 100, 170, 80, 40), word("04/12/1990", 200, 170, 200, 40)],
    [word("NO", 100, 240, 60, 40), word("D1234567", 180, 240, 160, 40)],
  ]);
  ok("an ID with a licence number and DOB is a card", detectCards(idCard).length === 1, String(detectCards(idCard).length));
  ok("card evidence: Luhn number scores 1", cardEvidence([word("4111", 0, 0, 10, 10), word("1111", 0, 0, 10, 10), word("1111", 0, 0, 10, 10), word("1111", 0, 0, 10, 10)]).score === 1);
  ok("card evidence: plain prose scores 0", cardEvidence([word("Live", 0, 0, 10, 10), word("at", 0, 0, 10, 10), word("the", 0, 0, 10, 10), word("park", 0, 0, 10, 10)]).score === 0);
  ok("a single line is not a card", detectCards(pageOf(1000, 1000, [[word("a", 0, 0, 100, 40), word("b", 120, 0, 100, 40), word("c", 240, 0, 100, 40), word("d", 360, 0, 100, 40)]])).length === 0);

  // Terminals: a dark box with monospaced words vs a light one with ragged words.
  const W = 400, H = 300;
  const gray = new Uint8ClampedArray(W * H).fill(230);
  for (let y = 20; y < 220; y++) for (let x = 20; x < 380; x++) gray[y * W + x] = 20;
  const box: Det = { x: 20, y: 20, w: 360, h: 200, score: 0.8, cls: 62 };
  const mono = pageOf(W, H, [
    [word("user@host", 30, 30, 90, 12), word("~/src", 130, 30, 50, 12), word("git", 190, 30, 30, 12), word("status", 230, 30, 60, 12)],
    [word("modified:", 30, 50, 90, 12), word("src/main.ts", 130, 50, 110, 12), word("x", 250, 50, 10, 12), word("npm", 270, 50, 30, 12)],
  ]);
  const t = judgeTerminal(gray, W, H, box, mono);
  ok("dark + monospaced is a terminal", t.terminal, `score ${t.score.toFixed(2)} dark ${t.dark.toFixed(2)} cv ${t.pitchCv}`);
  const light = new Uint8ClampedArray(W * H).fill(230);
  const prop = pageOf(W, H, [
    [word("Dear", 30, 30, 30, 12), word("customer,", 70, 30, 100, 12), word("we", 180, 30, 12, 12), word("thank", 200, 30, 62, 12)],
    [word("you", 30, 50, 22, 12), word("for", 60, 50, 18, 12), word("your", 90, 50, 44, 12), word("interest", 140, 50, 100, 12)],
  ]);
  const p = judgeTerminal(light, W, H, box, prop);
  ok("light + proportional is not", !p.terminal, `score ${p.score.toFixed(2)}`);
  const dOnly = judgeTerminal(gray, W, H, box, null);
  ok("without OCR, very dark still counts", dOnly.terminal && dOnly.pitchCv === null, `score ${dOnly.score.toFixed(2)}`);
  ok("a phone screenshot size is a screenshot", looksLikeScreenshot(1080, 2400));
  ok("a camera size is not", !looksLikeScreenshot(4032, 3024, "image/jpeg"));
  ok("an odd-sized PNG that is screen-shaped is", looksLikeScreenshot(1600, 1000, "image/png"));
  ok("but not as a JPEG", !looksLikeScreenshot(1600, 1000, "image/jpeg"));

  // QR: three finder patterns on a synthetic symbol.
  const q = qrCanvas(25, 8, 40);
  const boxes = findQrBoxes(q.rgba, q.width, q.height);
  ok("a synthetic QR is found by its finders", boxes.length === 1, String(boxes.length));
  const qb = boxes[0];
  ok("and the box covers the symbol", !!qb && qb.x <= 40 && qb.y <= 40 && qb.x + qb.w >= 40 + 25 * 8 - 1 && qb.y + qb.h >= 40 + 25 * 8 - 1, JSON.stringify(qb));
  const blank = new Uint8ClampedArray(200 * 200 * 4).fill(255);
  ok("a blank picture has no code", findQrBoxes(blank, 200, 200).length === 0);
}

/** A QR-shaped symbol: three finders, timing rows, pseudo-random data, on white. */
function qrCanvas(modules: number, mod: number, margin: number): { rgba: Uint8ClampedArray; width: number; height: number } {
  const side = modules * mod + margin * 2;
  const c = document.createElement("canvas");
  c.width = side; c.height = side;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = "#000";
  const dark = (mx: number, my: number): void => { ctx.fillRect(margin + mx * mod, margin + my * mod, mod, mod); };
  const finder = (ox: number, oy: number): void => {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const ring = x === 0 || y === 0 || x === 6 || y === 6;
      const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
      if (ring || core) dark(ox + x, oy + y);
    }
  };
  finder(0, 0); finder(modules - 7, 0); finder(0, modules - 7);
  let seed = 7;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < modules; y++) for (let x = 0; x < modules; x++) {
    const inFinder = (x < 8 && y < 8) || (x >= modules - 8 && y < 8) || (x < 8 && y >= modules - 8);
    if (inFinder) continue;
    if (y === 6 || x === 6) { if ((x + y) % 2 === 0) dark(x, y); continue; }
    if (rnd() < 0.45) dark(x, y);
  }
  return { rgba: ctx.getImageData(0, 0, side, side).data, width: side, height: side };
}

// ── Store, regions, layers ─────────────────────────────────────────────────

function storeTests(): void {
  const d = sanitize(undefined);
  ok("sanitize(garbage) is the defaults", JSON.stringify(d) === JSON.stringify(defaultConfig()));
  const clamped = sanitize({ categories: { plates: { amount: 9, pad: -1, kind: "nope", minSize: 3.7 } }, video: { fps: 99 }, text: { keywords: ["a", 3, " b "] } });
  ok("amount clamps to 0.5", clamped.categories.plates.amount === 0.5, String(clamped.categories.plates.amount));
  ok("pad clamps to 0", clamped.categories.plates.pad === 0);
  ok("unknown kind falls back", clamped.categories.plates.kind === "pixelate", clamped.categories.plates.kind);
  ok("minSize rounds", clamped.categories.plates.minSize === 4);
  ok("fps clamps to 4", clamped.video.fps === 4);
  ok("keywords keep strings, trimmed", JSON.stringify(clamped.text.keywords) === JSON.stringify(["a", "b"]), JSON.stringify(clamped.text.keywords));

  const storage = mapStorage();
  const s1 = new AutoBlurStore(storage);
  ok("a fresh store is clean", !s1.dirty);
  let pings = 0;
  const off = s1.subscribe(() => pings++);
  s1.setCategory("plates", { kind: "solid", on: false });
  s1.patch({ video: { wholeClip: false }, text: { keywords: ["acme"] } });
  ok("changes notify", pings === 2, String(pings));
  ok("and make it dirty", s1.dirty);
  ok("written under fct.autoblur.v1", storage.getItem(STORAGE_KEY) !== null);
  const s2 = new AutoBlurStore(storage);
  ok("a second store reads the same", s2.get().categories.plates.kind === "solid" && !s2.get().categories.plates.on && !s2.get().video.wholeClip && s2.get().text.keywords[0] === "acme");
  ok("enabledCategories drops the one switched off", !enabledCategories(s2.get()).includes("plates") && enabledCategories(s2.get()).includes("screens"));
  off();
  s1.reset();
  ok("reset clears storage", storage.getItem(STORAGE_KEY) === null && !s1.dirty);

  // detections → regions
  const cfg = defaultConfig();
  const dets: Detection[] = [
    { category: "screens", label: "screen", box: { x: 100, y: 100, w: 400, h: 300, score: 0.9, cls: 62 } },
    { category: "screens", label: "screen", box: { x: 700, y: 100, w: 400, h: 300, score: 0.8, cls: 62 } },
    { category: "plates", label: "plate", box: { x: 500, y: 600, w: 120, h: 40, score: 0.7, cls: 0 } },
  ];
  const regions = detectionsToRegions(dets, 1200, 800, cfg);
  ok("one region per detection", regions.length === 3, String(regions.length));
  ok("ids are category-numbered", regions.map((r) => r.id).join(",") === "screens-1,screens-2,plates-1", regions.map((r) => r.id).join(","));
  ok("labels number only repeats", regions.map((r) => r.label).join(",") === "screen 1,screen 2,plate", regions.map((r) => r.label).join(","));
  ok("style comes from the category", regions[0]!.kind === "pixelate" && regions[0]!.amount === cfg.categories.screens.amount);
  const r0 = regions[0]!.rect;
  ok("padding grew the box", r0.x < 100 / 1200 && r0.w > 400 / 1200, JSON.stringify(r0));
  const again = detectionsToRegions(dets, 1200, 800, cfg, regions);
  ok("a second run over the same picture adds nothing", again.length === 0, String(again.length));
  const disabled = regions.map((r) => ({ ...r, enabled: false }));
  const third = detectionsToRegions(dets, 1200, 800, cfg, disabled);
  ok("unless the old ones are switched off — with fresh ids", third.length === 3 && third[0]!.id === "screens-3", third.map((r) => r.id).join(","));
  ok("summarise reads well", summarise(dets) === "1 plate, 2 screens", summarise(dets));

  // sample times and layers: five monitors for sixty seconds.
  const times = autoSampleTimes(60, 2);
  ok("60 s at 2 fps is 121 samples, first 0, last 60", times.length === 121 && times[0] === 0 && times[120] === 60, String(times.length));
  ok("the cap holds for long clips", autoSampleTimes(3600, 4).length === 240);
  const monitors = [0, 1, 2, 3, 4].map((i) => ({ x: 20 + i * 120, y: 100, w: 100, h: 70, score: 0.9, cls: 62 }));
  const frames: FrameDetections[] = times.map((t) => ({
    t, width: 640, height: 360,
    detections: monitors.map((box, i) => ({ category: "screens" as const, label: "screen", box: { ...box, x: box.x + Math.sin(t + i) * 4 } })),
  }));
  const layers = layersFromDetections(frames, 60, cfg);
  ok("five monitors become five layers", layers.length === 5, String(layers.length));
  ok("each held for the whole clip", layers.every((l) => l.wholeClip && l.from <= 0.01 && l.to >= 59.9), layers.map((l) => `${l.from}-${l.to}`).join(" "));
  ok("named screen 1…5, source auto", layers.map((l) => l.name).join(",") === "screen 1,screen 2,screen 3,screen 4,screen 5" && layers.every((l) => l.source === "auto"), layers.map((l) => l.name).join(","));
  ok("keyframes are normalised", layers.every((l) => l.keys.every((k) => k.rect.x >= 0 && k.rect.x + k.rect.w <= 1.001)));
  const short = layersFromDetections(frames, 60, { ...cfg, video: { ...cfg.video, wholeClip: false } });
  ok("without whole-clip they still span first to last sighting", short.length === 5 && short.every((l) => !l.wholeClip && l.to - l.from >= 59));
  const blink: FrameDetections[] = [
    { t: 0, width: 640, height: 360, detections: [{ category: "plates", label: "plate", box: { x: 10, y: 10, w: 60, h: 20, score: 0.8, cls: 0 } }] },
    { t: 0.5, width: 640, height: 360, detections: [] },
    { t: 1, width: 640, height: 360, detections: [] },
    { t: 30, width: 640, height: 360, detections: [{ category: "plates", label: "plate", box: { x: 10, y: 10, w: 60, h: 20, score: 0.8, cls: 0 } }] },
  ];
  ok("a long gap splits into two tracks", layersFromDetections(blink, 60, short.length ? { ...cfg, video: { ...cfg.video, wholeClip: false } } : cfg).length === 2);
}

// ── UI: settings sheet and the editor's sheet ──────────────────────────────

function mockHost(): EditorHost & { said: string[]; ran: string[] } {
  const m = {
    native: true, ffmpeg: true, said: [] as string[], ran: [] as string[],
    leave() {}, runTool(id: string) { m.ran.push(id); return true; }, say(t: string) { m.said.push(t); },
    async save() { return "/pics/a-facet.jpg"; }, async share() {},
  };
  return m;
}

async function uiTests(): Promise<void> {
  const prefs = new PhonePrefsStore(mapStorage());
  const auto = new AutoBlurStore(mapStorage());
  const sheet = new SettingsSheet(prefs, auto);
  sheet.open();
  const text = sheet.el.textContent ?? "";
  ok("settings sheet has an Auto-blur section", text.includes("Auto-blur"));
  for (const c of AUTO_CATEGORIES) ok(`…with a row for ${c}`, text.includes(sanitizeTitle(c)), sanitizeTitle(c));
  ok("…phones-as-screens, face model, whole clip, looks per second", ["Phones count as screens", "Face model", "whole clip", "looks per second"].every((s) => text.toLowerCase().includes(s.toLowerCase())));
  ok("…text rules and keywords", sheet.el.querySelector("input.ph-set-input") !== null && text.includes("Text: emails") && text.includes("Text: card numbers"));
  const toggles = sheet.el.querySelectorAll<HTMLElement>("[role=switch], input[type=checkbox]");
  ok("there are toggles to flip", toggles.length >= AUTO_CATEGORIES.length, String(toggles.length));
  sheet.close();
  sheet.el.remove();

  // The editor: Blur panel → Auto-blur chip → sheet with a chip per category.
  localStorage.removeItem("fct.autoblur.pick.v1");
  const host = mockHost();
  const editor = new PhoneEditor(host);
  const canvas = el<"canvas">("canvas");
  const mount = el("div.phv.phe", { style: "position:fixed;top:0;left:0;width:360px;height:780px;" }, el("div.phv-stage", {}, canvas), editor.top, editor.el);
  document.body.append(mount);
  editor.top.hidden = false; editor.el.hidden = false;
  const pic = document.createElement("canvas"); pic.width = 600; pic.height = 400;
  pic.getContext("2d")!.fillRect(0, 0, 600, 400);
  editor.begin(await createImageBitmap(pic), canvas, "image", "office.jpg");
  await new Promise((r) => requestAnimationFrame(r));
  editor.open("blur");
  const chip = (id: string): HTMLButtonElement | null => editor.el.querySelector<HTMLButtonElement>(`.phe-strip [data-tool="${id}"]`);
  ok("Blur panel shows an Auto-blur chip", chip("ai.auto") !== null);
  chip("ai.auto")?.click();
  ok("the sheet has Go and Everything", chip("ai.auto.go") !== null && chip("ai.auto.all") !== null);
  const picks = AUTO_CATEGORIES.filter((c) => chip(`ai.pick.${c}`) !== null);
  ok("and a chip per category", picks.length === AUTO_CATEGORIES.length, picks.join(","));
  const before = chip("ai.auto.go")?.querySelector(".phe-chip-value")?.textContent;
  ok("nothing is pre-ticked on first use", before === "0" && chip("ai.auto.go")?.disabled === true, String(before));
  const platesChip = chip("ai.pick.plates");
  const goChip = chip("ai.auto.go");
  editor.el.querySelector<HTMLElement>(".phe-strip")!.scrollLeft = 120;
  platesChip?.click();
  const after = chip("ai.auto.go")?.querySelector(".phe-chip-value")?.textContent;
  ok("ticking a category changes the count on Go", before !== after, `${before} → ${after}`);
  ok("a tick updates the chips in place (no rebuild)", chip("ai.pick.plates") === platesChip && chip("ai.auto.go") === goChip);
  ok("and the tick shows on the chip", platesChip?.getAttribute("aria-pressed") === "true");
  ok("the pick is remembered", localStorage.getItem("fct.autoblur.pick.v1") === JSON.stringify(["plates"]), localStorage.getItem("fct.autoblur.pick.v1") ?? "null");
  chip("ai.auto.all")?.click();
  ok("Everything ticks them all", chip("ai.auto.go")?.querySelector(".phe-chip-value")?.textContent === String(AUTO_CATEGORIES.length), chip("ai.auto.go")?.querySelector(".phe-chip-value")?.textContent);
  chip("ai.auto.all")?.click();
  ok("Everything again clears them all", chip("ai.auto.go")?.querySelector(".phe-chip-value")?.textContent === "0");
  localStorage.removeItem("fct.autoblur.pick.v1");
  ok("ai.auto is in the catalogue and lives on the blur rail", TOOLS.some((t) => t.id === "ai.auto") && railFor("ai.auto") === "blur", railFor("ai.auto"));
  for (const id of ["ai.plates", "ai.screens", "ai.terminals", "ai.cards", "ai.codes", "ai.text"]) {
    ok(`${id} is in the catalogue and lives on the auto rail`, TOOLS.some((t) => t.id === id) && railFor(id) === "auto", railFor(id) ?? "none");
  }
  mount.remove();
}
function sanitizeTitle(c: string): string {
  return { faces: "Faces", plates: "Licence plates", screens: "Screens", terminals: "Terminals", cards: "Cards", codes: "QR", text: "Text by rule" }[c] ?? c;
}

// ── Real models on the bundled pictures ────────────────────────────────────

async function load(name: string): Promise<ImageBitmap | null> {
  try {
    const r = await fetch(`/_autoblurcheck/${name}`);
    if (!r.ok) return null;
    return await createImageBitmap(await r.blob());
  } catch {
    return null;
  }
}

function show(title: string, bmp: ImageBitmap, input: { width: number; height: number; canvas: HTMLCanvasElement }, dets: Detection[], ms: number): void {
  const c = document.createElement("canvas");
  const k = Math.min(1, 480 / input.width);
  c.width = Math.round(input.width * k); c.height = Math.round(input.height * k);
  const ctx = c.getContext("2d")!;
  ctx.drawImage(input.canvas, 0, 0, c.width, c.height);
  ctx.lineWidth = 3; ctx.font = "bold 14px system-ui";
  for (const d of dets) {
    ctx.strokeStyle = d.category === "faces" ? "#ff3b30" : d.category === "plates" ? "#ffcc00" : d.category === "screens" ? "#34c759" : "#5ac8fa";
    ctx.strokeRect(d.box.x * k, d.box.y * k, d.box.w * k, d.box.h * k);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(`${d.label} ${(d.box.score * 100).toFixed(0)}`, d.box.x * k + 3, d.box.y * k + 15);
  }
  const cap = el("div", { style: "font:13px system-ui;color:#ddd;margin:8px 0 2px" }, `${title} — ${bmp.width}×${bmp.height}: ${summarise(dets)} in ${Math.round(ms)} ms`);
  document.body.append(cap, c);
}

async function modelTests(): Promise<void> {
  const runner = getRunner();
  const up = await runner.available();
  ok("the ONNX worker starts", up, "worker or wasm unavailable");
  if (!up) return;
  const cfg = defaultConfig();
  const runOn = async (name: string, cats: Parameters<typeof detectAll>[1], ocr = false): Promise<{ dets: Detection[]; ms: number; engine: string; notes: string[] } | null> => {
    const bmp = await load(name);
    if (!bmp) { ok(`${name} is served by the dev server`, false, "fetch failed (fixtures/_autoblurcheck missing?)"); return null; }
    const input = prepareInput(bmp, bmp.width, bmp.height, ocr ? { ocr: null } : {});
    const t0 = performance.now();
    const r = await detectAll(input, cats, { runner, config: cfg });
    const ms = performance.now() - t0;
    show(name, bmp, input, r.detections, ms);
    bmp.close();
    return { dets: r.detections, ms, engine: r.faceEngine, notes: r.notes };
  };

  const office = await runOn("autoblur-office.jpg", ["screens"]);
  if (office) {
    const screens = office.dets.filter((d) => d.category === "screens");
    ok("office picture: at least three screens found", screens.length >= 3, `${screens.length} (${office.notes.join("; ")})`);
    console.log(`autoblur: office screens=${screens.length} ms=${Math.round(office.ms)} yolox=${Math.round(runner.stats.last.yolox ?? -1)}ms load=${Math.round(runner.stats.load.yolox ?? -1)}ms`);
  }
  const car = await runOn("autoblur-car.jpg", ["plates"]);
  if (car) {
    const plates = car.dets.filter((d) => d.category === "plates");
    ok("car picture: a licence plate found", plates.length >= 1, `${plates.length} (${car.notes.join("; ")})`);
    console.log(`autoblur: car plates=${plates.length} ms=${Math.round(car.ms)} plates-model=${Math.round(runner.stats.last.plates ?? -1)}ms`);
  }
  for (const name of ["face-a.jpg", "face-b.jpg"]) {
    const r = await runOn(name, ["faces"]);
    if (!r) continue;
    const faces = r.dets.filter((d) => d.category === "faces");
    ok(`${name}: a face found by YuNet`, faces.length >= 1 && r.engine === "yunet", `${faces.length} via ${r.engine} (${r.notes.join("; ")})`);
    console.log(`autoblur: ${name} faces=${faces.length} ms=${Math.round(r.ms)} yunet=${Math.round(runner.stats.last.yunet ?? -1)}ms`);
  }
  const all = await runOn("autoblur-office.jpg", ["faces", "plates", "screens", "codes"]);
  if (all) ok("all model categories run together in one pass", all.notes.every((n) => !/failed/.test(n)), all.notes.join("; "));
  if (all) {
    for (const d of all.dets) console.log(`autoblur: office/all ${d.category} ${d.label} ${(d.box.score * 100).toFixed(0)} @ ${Math.round(d.box.x)},${Math.round(d.box.y)} ${Math.round(d.box.w)}x${Math.round(d.box.h)}`);
    const big = all.dets.filter((d) => d.box.w * d.box.h > 0.5 * 1024 * 768);
    ok("no single office detection covers more than half the picture", big.length === 0, big.map((d) => `${d.label} ${Math.round(d.box.w)}x${Math.round(d.box.h)}`).join(", "));
  }
  // The phone run: all seven categories with the real OCR engine. This is
  // what "Everything → Go" does on the device, so whatever it over-blurs
  // there must show up here too.
  const bmp7 = await load("autoblur-office.jpg");
  if (bmp7) {
    const ocr = new Tesseract();
    const input = prepareInput(bmp7, bmp7.width, bmp7.height, { ocr, mime: "image/jpeg" });
    const page = input.ocr ? await input.ocr() : null;
    if (page) {
      const words = page.blocks.flatMap((b) => b.lines.flatMap((l) => l.words));
      console.log(`autoblur: office OCR words=${words.length} lines=${page.blocks.reduce((n, b) => n + b.lines.length, 0)}`);
      for (const h of textHitBoxes(page, cfg.text)) console.log(`autoblur: office/text-hit ${h.rule} "${h.text}" @ ${Math.round(h.det.x)},${Math.round(h.det.y)} ${Math.round(h.det.w)}x${Math.round(h.det.h)}`);
    }
    const t0 = performance.now();
    const r = await detectAll(input, [...AUTO_CATEGORIES], { runner, config: cfg });
    const ms = performance.now() - t0;
    show("office, everything + OCR", bmp7, input, r.detections, ms);
    for (const d of r.detections) console.log(`autoblur: office/7 ${d.category} ${d.label} ${(d.box.score * 100).toFixed(0)} @ ${Math.round(d.box.x)},${Math.round(d.box.y)} ${Math.round(d.box.w)}x${Math.round(d.box.h)}`);
    const extra = r.detections.filter((d) => d.category !== "screens" && d.category !== "faces");
    ok("office picture with everything on: only the screens are found", extra.length === 0, extra.map((d) => `${d.category}/${d.label} ${Math.round(d.box.w)}x${Math.round(d.box.h)}`).join(", "));
    const big = r.detections.filter((d) => d.box.w * d.box.h > 0.5 * bmp7.width * bmp7.height);
    ok("office picture with everything on: nothing covers half the picture", big.length === 0, big.map((d) => `${d.category} ${Math.round(d.box.w)}x${Math.round(d.box.h)}`).join(", "));
    bmp7.close();
    await ocr.close();
  }
  console.log(`autoblur: runner threads=${runner.stats.threads}`);
}

async function main(): Promise<void> {
  document.body.style.background = "#111";
  tensorTests();
  ruleTests();
  storeTests();
  await uiTests();
  await modelTests();
  const line = `autoblur: ${pass} passed, ${fail} failed`;
  console.log(line);
  document.title = line;
  document.body.prepend(el("h2", { style: `font:16px system-ui;color:${fail ? "#ff6b6b" : "#7bd88f"};margin:8px` }, line));
}

void main();
