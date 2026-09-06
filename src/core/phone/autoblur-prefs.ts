/**
 * Auto-blur settings — the `AutoBlurConfig` from `@core/vision/autoblur-config`
 * persisted under one key, `fct.autoblur.v1`, the same way the phone prefs
 * are: one JSON blob, sanitised on the way in and out, storage injectable so
 * the harness runs against a Map.
 *
 * Used on the phone (settings sheet, the editor's Auto-blur sheet, the video
 * workspace) and on the desktop viewer alike; the store is UI-free.
 */

import type { BlurKind } from "@core/edit/blur";
import {
  AUTO_CATEGORIES,
  AUTO_DEFAULTS,
  defaultConfig,
  type AutoBlurConfig,
  type AutoCategory,
  type CategoryConfig,
} from "@core/vision/autoblur-config";
import type { PrefsStorage } from "./prefs";

export const STORAGE_KEY = "fct.autoblur.v1";

export const BLUR_KINDS: readonly BlurKind[] = ["gaussian", "box", "pixelate", "mosaic", "motion", "radial", "frosted", "solid"];

function oneOf<T>(list: readonly T[], v: unknown, fallback: T): T {
  return (list as readonly unknown[]).includes(v) ? (v as T) : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function num(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}
function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function category(raw: unknown, d: CategoryConfig): CategoryConfig {
  const r = obj(raw);
  return {
    on: bool(r["on"], d.on),
    kind: oneOf(BLUR_KINDS, r["kind"], d.kind),
    amount: num(r["amount"], 0.005, 0.5, d.amount),
    pad: num(r["pad"], 0, 1, d.pad),
    minSize: Math.round(num(r["minSize"], 0, 4096, d.minSize)),
    conf: num(r["conf"], 0.05, 0.95, d.conf),
  };
}

/** Any value in, a valid config out. */
export function sanitize(raw: unknown): AutoBlurConfig {
  const r = obj(raw);
  const d = AUTO_DEFAULTS;
  const cats = obj(r["categories"]);
  const categories = {} as Record<AutoCategory, CategoryConfig>;
  for (const c of AUTO_CATEGORIES) categories[c] = category(cats[c], d.categories[c]);
  const text = obj(r["text"]);
  const video = obj(r["video"]);
  const keywords = Array.isArray(text["keywords"])
    ? (text["keywords"] as unknown[]).filter((k): k is string => typeof k === "string").map((k) => k.trim()).filter(Boolean).slice(0, 64)
    : [...d.text.keywords];
  return {
    categories,
    screensIncludePhones: bool(r["screensIncludePhones"], d.screensIncludePhones),
    faceModel: bool(r["faceModel"], d.faceModel),
    text: {
      emails: bool(text["emails"], d.text.emails),
      phones: bool(text["phones"], d.text.phones),
      urls: bool(text["urls"], d.text.urls),
      cardNumbers: bool(text["cardNumbers"], d.text.cardNumbers),
      keywords,
    },
    video: {
      wholeClip: bool(video["wholeClip"], d.video.wholeClip),
      fps: num(video["fps"], 0.5, 4, d.video.fps),
    },
  };
}

export type AutoBlurListener = (config: AutoBlurConfig) => void;

export class AutoBlurStore {
  private config: AutoBlurConfig;
  private listeners = new Set<AutoBlurListener>();

  constructor(private readonly storage: PrefsStorage | null = defaultStorage()) {
    this.config = sanitize(this.read());
  }

  get(): AutoBlurConfig { return this.config; }

  get dirty(): boolean {
    return JSON.stringify(this.config) !== JSON.stringify(defaultConfig());
  }

  /** Replace the whole config (sanitised). */
  set(next: AutoBlurConfig): void {
    const clean = sanitize(next);
    if (JSON.stringify(clean) === JSON.stringify(this.config)) return;
    this.config = clean;
    this.write();
    this.emit();
  }

  /** Patch one category. */
  setCategory(c: AutoCategory, patch: Partial<CategoryConfig>): void {
    const next = defaultConfig();
    Object.assign(next, structuredClone(this.config));
    next.categories[c] = { ...next.categories[c], ...patch };
    this.set(next);
  }

  /** Patch the top-level knobs. */
  patch(p: Partial<Pick<AutoBlurConfig, "screensIncludePhones" | "faceModel">> & { text?: Partial<AutoBlurConfig["text"]>; video?: Partial<AutoBlurConfig["video"]> }): void {
    const next = structuredClone(this.config);
    if (p.screensIncludePhones !== undefined) next.screensIncludePhones = p.screensIncludePhones;
    if (p.faceModel !== undefined) next.faceModel = p.faceModel;
    if (p.text) next.text = { ...next.text, ...p.text };
    if (p.video) next.video = { ...next.video, ...p.video };
    this.set(next);
  }

  reset(): void {
    this.config = defaultConfig();
    try { this.storage?.removeItem(STORAGE_KEY); } catch { /* in-memory still wins */ }
    this.emit();
  }

  subscribe(fn: AutoBlurListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.config);
  }

  private read(): unknown {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      return null;
    }
  }

  private write(): void {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.config)); } catch { /* see reset */ }
  }
}

function defaultStorage(): PrefsStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let shared: AutoBlurStore | null = null;

/** The app's one store, backed by localStorage. */
export function autoBlurStore(): AutoBlurStore {
  if (!shared) shared = new AutoBlurStore();
  return shared;
}

// ── The per-run pick ─────────────────────────────────────────────────────────

/**
 * Which categories the Auto-blur sheet had ticked last time, shared by the
 * photo and video editors. Separate from the config above on purpose: Settings
 * says what each detector *does* when it runs; this is only "which ones, this
 * time". Empty on first use -- nothing is pre-ticked -- and remembered after
 * that, so the second picture starts where the first one ended.
 */
export const AUTO_PICK_KEY = "fct.autoblur.pick.v1";

export function loadAutoPick(storage: PrefsStorage | null = defaultStorage()): Set<AutoCategory> {
  try {
    const raw = storage?.getItem(AUTO_PICK_KEY);
    if (!raw) return new Set();
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((c): c is AutoCategory => (AUTO_CATEGORIES as readonly string[]).includes(String(c))));
  } catch {
    return new Set();
  }
}

export function saveAutoPick(pick: ReadonlySet<AutoCategory>, storage: PrefsStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(AUTO_PICK_KEY, JSON.stringify([...pick]));
  } catch { /* private mode, quota: the sheet still works for this run */ }
}
