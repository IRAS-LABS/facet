/**
 * Auto-blur, the orchestrator: one frame in, a list of labelled detections
 * out, and a second step that turns those into ordinary editable regions.
 *
 * Every category is a stage that may need a model (faces, plates, screens,
 * terminals), the OCR (terminals, cards, text), or neither (codes). Stages
 * share their work: the COCO pass feeds screens, terminals *and* the plate
 * stage's vehicle crops; the OCR runs once for every category that reads.
 * When the model runtime is unavailable, faces fall back to the cascade and
 * the model-only categories report themselves as skipped in `notes` — the
 * UI says so instead of silently finding nothing.
 */

import { newRegion, regionAt, type BlurRegion } from "@core/edit/blur";
import type { OcrPage } from "@core/ocr/page";
import { AUTO_CATEGORIES, CATEGORY_NAMES, type AutoBlurConfig, type AutoCategory } from "./autoblur-config";
import { detectCards } from "./cards";
import { detectCoco, screenKind } from "./coco";
import { detectCodes } from "./codes";
import { DEFAULTS, detectFaces, type Box } from "./detect";
import { iou, padDet, type Det } from "./onnx";
import type { OnnxRunner } from "./onnx-runner";
import { detectPlates } from "./plates";
import { detectTerminals, looksLikeScreenshot } from "./terminals";
import { textHitBoxes } from "./textrules";
import { detectFacesNet } from "./yunet";

export interface Detection {
  category: AutoCategory;
  /** "face", "plate", "screen", "phone", "terminal", "card", "code", "email"… */
  label: string;
  /** Source pixels, unpadded. */
  box: Det;
}

export interface DetectInput {
  rgba: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  mime?: string;
  /** Called at most once, only when a category that reads text is on. */
  ocr?: () => Promise<OcrPage | null>;
}

export interface DetectOptions {
  /** The model runner; null forces the no-model paths. */
  runner: OnnxRunner | null;
  config: AutoBlurConfig;
  signal?: AbortSignal;
  onProgress?: (fraction: number, message: string) => void;
}

export interface DetectResult {
  detections: Detection[];
  /** Per-category milliseconds, wall clock. */
  ms: Partial<Record<AutoCategory, number>>;
  /** Human-readable caveats: model unavailable, OCR failed, … */
  notes: string[];
  /** Which face path ran. */
  faceEngine: "yunet" | "cascade" | "none";
}

const wantsOcr = (c: AutoCategory): boolean => c === "terminals" || c === "cards" || c === "text";
const wantsCoco = (c: AutoCategory): boolean => c === "screens" || c === "terminals" || c === "plates";

function gray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8ClampedArray {
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (rgba[p]! * 77 + rgba[p + 1]! * 150 + rgba[p + 2]! * 29) >> 8;
  return g;
}

function bail(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("cancelled");
}

/** Run the requested categories over one frame. */
export async function detectAll(
  input: DetectInput,
  categories: readonly AutoCategory[],
  opts: DetectOptions,
): Promise<DetectResult> {
  const { rgba, width, height } = input;
  const cfg = opts.config;
  const cats = AUTO_CATEGORIES.filter((c) => categories.includes(c));
  const out: DetectResult = { detections: [], ms: {}, notes: [], faceEngine: "none" };
  if (cats.length === 0 || width <= 0 || height <= 0) return out;
  const progress = (f: number, m: string): void => opts.onProgress?.(f, m);
  const runner = opts.runner && (await opts.runner.available()) ? opts.runner : null;
  if (!runner && cats.some((c) => c !== "faces" && c !== "codes" && c !== "cards" && c !== "text")) {
    out.notes.push("detection models unavailable on this device — screens, terminals and plates skipped");
  }
  const steps = cats.length + (cats.some(wantsOcr) ? 1 : 0);
  let step = 0;
  const tick = (m: string): void => progress(Math.min(0.95, step++ / Math.max(1, steps)), m);
  let gr: Uint8ClampedArray | null = null;
  const grayOnce = (): Uint8ClampedArray => (gr ??= gray(rgba, width, height));

  // Shared COCO pass.
  let coco: Awaited<ReturnType<typeof detectCoco>> | null = null;
  if (runner && cats.some(wantsCoco)) {
    bail(opts.signal);
    tick("Looking for screens…");
    const t0 = performance.now();
    try {
      coco = await detectCoco(runner, rgba, width, height, {
        conf: Math.min(cfg.categories.screens.conf, cfg.categories.terminals.conf),
        phones: cfg.screensIncludePhones,
      });
    } catch (e) {
      out.notes.push(`screen detector failed: ${(e as Error).message}`);
    }
    out.ms.screens = performance.now() - t0;
  }

  // Shared OCR.
  let page: OcrPage | null = null;
  if (cats.some(wantsOcr)) {
    bail(opts.signal);
    tick("Reading text…");
    if (input.ocr) {
      try {
        page = await input.ocr();
      } catch (e) {
        out.notes.push(`text recognition failed: ${(e as Error).message}`);
      }
    } else out.notes.push("no text recogniser — terminals judged on darkness only, cards and text skipped");
  }

  for (const c of cats) {
    bail(opts.signal);
    const t0 = performance.now();
    const cc = cfg.categories[c];
    switch (c) {
      case "faces": {
        tick("Looking for faces…");
        let boxes: Det[] = [];
        if (runner && cfg.faceModel) {
          try {
            boxes = (await detectFacesNet(runner, rgba, width, height, { conf: cc.conf })).faces;
            out.faceEngine = "yunet";
          } catch (e) {
            out.notes.push(`face model failed (${(e as Error).message}); used the cascade`);
          }
        }
        if (out.faceEngine !== "yunet") {
          const found: Box[] = detectFaces({ width, height, data: grayOnce() }, { ...DEFAULTS, minSize: 24 });
          boxes = found.map((b) => ({ ...b, cls: 0 }));
          out.faceEngine = "cascade";
        }
        for (const b of boxes) if (Math.min(b.w, b.h) >= cc.minSize) out.detections.push({ category: c, label: "face", box: b });
        break;
      }
      case "screens": {
        if (!coco) break;
        for (const b of coco.screens) {
          if (b.score < cc.conf || Math.min(b.w, b.h) < cc.minSize) continue;
          out.detections.push({ category: c, label: screenKind(b.cls), box: b });
        }
        break;
      }
      case "terminals": {
        tick("Judging terminals…");
        const screens = coco ? coco.screens.filter((b) => b.score >= cc.conf && b.cls !== 67) : [];
        const shot = looksLikeScreenshot(width, height, input.mime);
        const judged = detectTerminals(grayOnce(), width, height, screens, page, { screenshot: shot });
        for (const j of judged) {
          if (!j.terminal || Math.min(j.box.w, j.box.h) < cc.minSize) continue;
          out.detections.push({ category: c, label: "terminal", box: { ...j.box, score: j.score } });
        }
        break;
      }
      case "plates": {
        if (!runner) break;
        tick("Looking for plates…");
        try {
          const r = await detectPlates(runner, rgba, width, height, { conf: cc.conf, vehicles: coco?.vehicles ?? [] });
          for (const b of r.plates) if (Math.min(b.w, b.h) >= cc.minSize) out.detections.push({ category: c, label: "plate", box: b });
        } catch (e) {
          out.notes.push(`plate detector failed: ${(e as Error).message}`);
        }
        break;
      }
      case "codes": {
        tick("Looking for codes…");
        const r = await detectCodes(rgba, width, height);
        for (const b of r.codes) {
          if (Math.min(b.w, b.h) < cc.minSize) continue;
          out.detections.push({ category: c, label: b.cls === 0 ? "code" : "barcode", box: b });
        }
        break;
      }
      case "cards": {
        if (!page) break;
        tick("Looking for cards…");
        for (const b of detectCards(page)) {
          if (b.score < cc.conf || Math.min(b.w, b.h) < cc.minSize) continue;
          out.detections.push({ category: c, label: "card", box: b });
        }
        break;
      }
      case "text": {
        if (!page) break;
        tick("Matching text…");
        for (const h of textHitBoxes(page, cfg.text)) {
          if (Math.min(h.det.w, h.det.h) < cc.minSize) continue;
          out.detections.push({ category: c, label: h.rule, box: h.det });
        }
        break;
      }
    }
    out.ms[c] = (out.ms[c] ?? 0) + (performance.now() - t0);
  }
  // A terminal is also a screen; when both are on, keep the terminal (its own
  // style) and drop the screen box it came from.
  if (cats.includes("terminals") && cats.includes("screens")) {
    const terms = out.detections.filter((d) => d.category === "terminals");
    out.detections = out.detections.filter((d) => d.category !== "screens" || !terms.some((t) => iou(t.box, d.box) > 0.7));
  }
  progress(1, "Done");
  return out;
}

// ── Detections → regions ─────────────────────────────────────────────────────

/** How much of a detection may sit under an enabled region before it is "already done". */
const COVERED = 0.5;

/** A region's bounding box in source pixels. */
function boxOf(r: BlurRegion, width: number, height: number): Det {
  return { x: r.rect.x * width, y: r.rect.y * height, w: r.rect.w * width, h: r.rect.h * height, score: 0, cls: 0 };
}

/**
 * Detections as fresh regions to add. Faces get an ellipse, everything else a
 * rectangle; each carries its category's style and padding from `config`.
 * Detections already under an enabled region are skipped so pressing the
 * button twice does not stack two blurs. Ids are `<category>-N`, unique
 * against `existing`.
 */
export function detectionsToRegions(
  dets: readonly Detection[],
  width: number,
  height: number,
  config: AutoBlurConfig,
  existing: readonly BlurRegion[] = [],
): BlurRegion[] {
  const live = existing.filter((r) => r.enabled);
  const taken = new Set(existing.map((r) => r.id));
  const counts = new Map<string, number>();
  const seq = new Map<AutoCategory, number>();
  for (const r of existing) {
    const m = /^([a-z]+)-(\d+)$/.exec(r.id);
    if (m && AUTO_CATEGORIES.includes(m[1] as AutoCategory)) {
      const c = m[1] as AutoCategory;
      seq.set(c, Math.max(seq.get(c) ?? 0, Number(m[2])));
    }
  }
  const out: BlurRegion[] = [];
  for (const d of dets) {
    const cc = config.categories[d.category];
    const centre = { x: (d.box.x + d.box.w / 2) / width, y: (d.box.y + d.box.h / 2) / height };
    if (regionAt(live, centre)) continue;
    if (live.some((r) => iou(boxOf(r, width, height), d.box) > COVERED)) continue;
    let n = (seq.get(d.category) ?? 0) + 1;
    let id = `${d.category}-${n}`;
    while (taken.has(id)) id = `${d.category}-${++n}`;
    seq.set(d.category, n);
    taken.add(id);
    const shape = d.category === "faces" ? "ellipse" : "rect";
    const r = newRegion(shape, id);
    const pad = d.category === "faces" ? { ...d.box, y: d.box.y - d.box.h * 0.05, h: d.box.h * 1.15 } : d.box;
    const p = padDet(pad, cc.pad, width, height);
    r.rect = { x: p.x / width, y: p.y / height, w: p.w / width, h: p.h / height };
    r.kind = cc.kind;
    r.amount = cc.amount;
    r.feather = d.category === "faces" ? 0.02 : 0.005;
    const k = (counts.get(d.label) ?? 0) + 1;
    counts.set(d.label, k);
    r.label = d.label;
    out.push(r);
  }
  // Number labels only when a label repeats: "plate", but "screen 1", "screen 2".
  const seen = new Map<string, number>();
  for (const r of out) {
    const total = counts.get(r.label) ?? 1;
    if (total > 1) {
      const k = (seen.get(r.label) ?? 0) + 1;
      seen.set(r.label, k);
      r.label = `${r.label} ${k}`;
    }
  }
  return out;
}

/** "3 screens, 1 plate" for a toast. */
export function summarise(dets: readonly Detection[]): string {
  if (dets.length === 0) return "nothing found";
  const by = new Map<AutoCategory, number>();
  for (const d of dets) by.set(d.category, (by.get(d.category) ?? 0) + 1);
  return AUTO_CATEGORIES.filter((c) => by.has(c))
    .map((c) => {
      const n = by.get(c)!;
      const name = CATEGORY_NAMES[c];
      return c === "text" ? `${n} text ${n === 1 ? "match" : "matches"}` : `${n} ${n === 1 ? name.one : name.many}`;
    })
    .join(", ");
}
