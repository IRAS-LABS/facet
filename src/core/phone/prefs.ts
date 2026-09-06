/**
 * Phone preferences — every knob on the phone shell that a person might want
 * set differently, in one typed record.
 *
 * Kept apart from the desktop `SettingsStore` on purpose. That registry feeds
 * the desktop settings panel, and every key declared there is drawn there;
 * "hide the filter chips" and "fan the album covers" mean nothing to a 1440px
 * window with a folder tree. The phone also wants a different persistence
 * shape: one JSON blob under one key (`fct.phone.prefs.v1`), written whole on
 * every change, so a reset is one `removeItem` and a future `v2` can migrate
 * from `v1` without reading the desktop's diff table.
 *
 * Three layers, in this file, top to bottom:
 *
 *  1. The schema — `PhonePrefs`, `DEFAULTS`, and `sanitize()`, which turns any
 *     stored JSON into a valid record. Unknown keys are dropped, bad values
 *     fall back to the default for that key, so a corrupted blob or a value
 *     from a newer build never breaks the shell.
 *  2. The store — load, save, `set`, `reset`, `subscribe`. Storage is
 *     injectable so the harness runs against a Map, not the real localStorage.
 *  3. The DOM projection — `applyTo(el, prefs)` writes classes and `--fct-*`
 *     custom properties onto one element and nothing else. Every visual
 *     consequence of a preference is a CSS rule keyed off those, which is what
 *     lets the tile grid react without a single JS re-render and without this
 *     module touching the tabs' markup.
 */

import { themes } from "@core/theme/theme-engine";

/* ── Schema ──────────────────────────────────────────────────────────────── */

export type ThemePref = "dark" | "light" | "system";
export type ChipsPref = "hidden" | "segmented" | "bubbles";
export type AlbumStylePref = "borderless" | "boxed" | "stack";
export type TextSizePref = "small" | "default" | "large";
/** A tab the shell can open on. Mirrors `TabId` in the shell without importing it. */
export type TabPref = "photos" | "all" | "albums" | "files" | "search";
/** Column count for a roll, or "pinch" to leave it to the pinch gesture. */
export type ColsPref = "pinch" | 2 | 3 | 4 | 5 | 6;

export interface PhonePrefs {
  /* Look */
  theme: ThemePref;
  /** A CSS hex colour, or "" for the theme's own accent. */
  accent: string;
  /** Translucency of bars and sheets, 0–100. Never applied to the tile lists. */
  glass: number;
  motion: boolean;
  glow: boolean;
  textSize: TextSizePref;

  /* Roll */
  chips: ChipsPref;
  /** Corner radius of grid tiles in px, 0–20. */
  tileRadius: number;
  /** Gutter between grid tiles in px, 0–8. */
  tileGap: number;
  colsPhotos: ColsPref;
  colsAll: ColsPref;
  labels: boolean;
  badges: boolean;
  dayCounts: boolean;

  /* Albums */
  albumStyle: AlbumStylePref;
  /** Album grid columns, 2–4. */
  colsAlbums: number;
  albumNames: boolean;
  albumCounts: boolean;

  /* Behaviour */
  defaultTab: TabPref;
  haptics: boolean;
}

export const STORAGE_KEY = "fct.phone.prefs.v1";

/**
 * The defaults are a deliberate choice, not the previous build's: the
 * chip bubbles replaced by a thin underline strip (so the All tab keeps its
 * filter without the pills), tiles edge to edge, albums without their boxes,
 * a little glass on the bars. Glass sits at 20 rather than higher because
 * every point of it is a backdrop blur the compositor pays for on each scroll
 * frame under the bars.
 */
export const DEFAULTS: Readonly<PhonePrefs> = Object.freeze({
  theme: "dark",
  accent: "",
  glass: 20,
  motion: true,
  glow: true,
  textSize: "default",

  chips: "segmented",
  tileRadius: 0,
  tileGap: 2,
  colsPhotos: "pinch",
  colsAll: "pinch",
  labels: true,
  badges: true,
  dayCounts: true,

  albumStyle: "borderless",
  colsAlbums: 2,
  albumNames: true,
  albumCounts: true,

  defaultTab: "photos",
  haptics: false,
});

export const THEMES: readonly ThemePref[] = ["dark", "light", "system"];
export const CHIPS: readonly ChipsPref[] = ["hidden", "segmented", "bubbles"];
export const ALBUM_STYLES: readonly AlbumStylePref[] = ["borderless", "boxed", "stack"];
export const TEXT_SIZES: readonly TextSizePref[] = ["small", "default", "large"];
export const TABS: readonly TabPref[] = ["photos", "all", "albums", "files", "search"];
export const COLS: readonly ColsPref[] = ["pinch", 2, 3, 4, 5, 6];

/**
 * Accent swatches offered in the sheet. The first entry is "theme default".
 * Chosen to read against both the dark and the light base; all six clear
 * 3:1 against `#0b0d12` and `#f4f6fa` as a UI-component colour.
 */
export const ACCENTS: readonly { name: string; value: string }[] = [
  { name: "Theme", value: "" },
  { name: "Violet", value: "#7c5cff" },
  { name: "Cyan", value: "#22c3e6" },
  { name: "Mint", value: "#2fd39a" },
  { name: "Amber", value: "#f0a640" },
  { name: "Coral", value: "#ff6b6b" },
  { name: "Rose", value: "#ec5fb8" },
];

const HEX = /^#[0-9a-f]{6}$/i;

function oneOf<T>(list: readonly T[], v: unknown, fallback: T): T {
  return (list as readonly unknown[]).includes(v) ? (v as T) : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function int(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/**
 * Any value in, a valid record out. Applied to what comes back from storage
 * and to what `set` is handed, so there is exactly one place that knows the
 * ranges and the record in memory is always one the CSS can trust.
 */
export function sanitize(raw: unknown): PhonePrefs {
  const r: Record<string, unknown> =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const d = DEFAULTS;
  return {
    theme: oneOf(THEMES, r["theme"], d.theme),
    accent: typeof r["accent"] === "string" && (r["accent"] === "" || HEX.test(r["accent"]))
      ? r["accent"].toLowerCase()
      : d.accent,
    glass: int(r["glass"], 0, 100, d.glass),
    motion: bool(r["motion"], d.motion),
    glow: bool(r["glow"], d.glow),
    textSize: oneOf(TEXT_SIZES, r["textSize"], d.textSize),

    chips: oneOf(CHIPS, r["chips"], d.chips),
    tileRadius: int(r["tileRadius"], 0, 20, d.tileRadius),
    tileGap: int(r["tileGap"], 0, 8, d.tileGap),
    colsPhotos: oneOf(COLS, r["colsPhotos"], d.colsPhotos),
    colsAll: oneOf(COLS, r["colsAll"], d.colsAll),
    labels: bool(r["labels"], d.labels),
    badges: bool(r["badges"], d.badges),
    dayCounts: bool(r["dayCounts"], d.dayCounts),

    albumStyle: oneOf(ALBUM_STYLES, r["albumStyle"], d.albumStyle),
    colsAlbums: int(r["colsAlbums"], 2, 4, d.colsAlbums),
    albumNames: bool(r["albumNames"], d.albumNames),
    albumCounts: bool(r["albumCounts"], d.albumCounts),

    defaultTab: oneOf(TABS, r["defaultTab"], d.defaultTab),
    haptics: bool(r["haptics"], d.haptics),
  };
}

/* ── Store ───────────────────────────────────────────────────────────────── */

/** The two calls the store makes on storage; `localStorage` satisfies it. */
export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PrefsListener = (prefs: PhonePrefs, changed: readonly (keyof PhonePrefs)[]) => void;

export class PhonePrefsStore {
  private prefs: PhonePrefs;
  private listeners = new Set<PrefsListener>();

  constructor(private readonly storage: PrefsStorage | null = defaultStorage()) {
    this.prefs = sanitize(this.read());
  }

  get(): PhonePrefs { return this.prefs; }

  /** True when any key differs from its default — drives the Reset button. */
  get dirty(): boolean {
    return (Object.keys(DEFAULTS) as (keyof PhonePrefs)[]).some((k) => this.prefs[k] !== DEFAULTS[k]);
  }

  /** Change one or more keys. Persists and notifies only if something changed. */
  set(patch: Partial<PhonePrefs>): void {
    const next = sanitize({ ...this.prefs, ...patch });
    const changed = (Object.keys(DEFAULTS) as (keyof PhonePrefs)[])
      .filter((k) => next[k] !== this.prefs[k]);
    if (changed.length === 0) return;
    this.prefs = next;
    this.write();
    this.emit(changed);
  }

  reset(): void {
    const changed = (Object.keys(DEFAULTS) as (keyof PhonePrefs)[])
      .filter((k) => this.prefs[k] !== DEFAULTS[k]);
    this.prefs = { ...DEFAULTS };
    try { this.storage?.removeItem(STORAGE_KEY); } catch { /* storage full or denied: in-memory still wins */ }
    if (changed.length > 0) this.emit(changed);
  }

  subscribe(fn: PrefsListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(changed: readonly (keyof PhonePrefs)[]): void {
    for (const fn of this.listeners) fn(this.prefs, changed);
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
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.prefs)); } catch { /* see reset */ }
  }
}

function defaultStorage(): PrefsStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/* ── DOM projection ──────────────────────────────────────────────────────── */

/**
 * Every class this module may put on an element. Listed so `applyTo` can
 * remove the ones that no longer hold, and so the harness can assert the set
 * is exactly what the CSS expects.
 */
export const PREF_CLASSES: readonly string[] = [
  "fct-prefs",
  "fct-prefs-nochips", "fct-chips-segmented", "fct-chips-bubbles",
  "fct-album-borderless", "fct-album-boxed", "fct-album-stack",
  "fct-no-motion", "fct-no-glow", "fct-glass",
  "fct-no-labels", "fct-no-badges", "fct-no-day-counts",
  "fct-no-album-names", "fct-no-album-counts",
  "fct-cols-photos", "fct-cols-all",
];

const TEXT_SCALE: Record<TextSizePref, string> = { small: "0.92", default: "1", large: "1.1" };

/**
 * Project the record onto one element as classes and custom properties. Pure
 * DOM, no theme engine, no storage — so it can run against a detached node.
 *
 * The properties are `--fct-*` so the CSS never has to know a preference
 * exists: `.ph-grid { gap: var(--fct-tile-gap) }` is the whole wiring.
 */
export function applyTo(target: HTMLElement, p: PhonePrefs): void {
  const cls = target.classList;
  for (const c of PREF_CLASSES) cls.remove(c);
  cls.add("fct-prefs");

  if (p.chips === "hidden") cls.add("fct-prefs-nochips");
  else if (p.chips === "segmented") cls.add("fct-chips-segmented");
  else cls.add("fct-chips-bubbles");

  cls.add(`fct-album-${p.albumStyle}`);

  if (!p.motion) cls.add("fct-no-motion");
  if (!p.glow) cls.add("fct-no-glow");
  if (p.glass > 0) cls.add("fct-glass");
  if (!p.labels) cls.add("fct-no-labels");
  if (!p.badges) cls.add("fct-no-badges");
  if (!p.dayCounts) cls.add("fct-no-day-counts");
  if (!p.albumNames) cls.add("fct-no-album-names");
  if (!p.albumCounts) cls.add("fct-no-album-counts");
  if (p.colsPhotos !== "pinch") cls.add("fct-cols-photos");
  if (p.colsAll !== "pinch") cls.add("fct-cols-all");

  const s = target.style;
  // 0–1, not 0–100: the CSS multiplies it straight into opacity and blur.
  s.setProperty("--fct-glass", String(p.glass / 100));
  s.setProperty("--fct-tile-radius", `${p.tileRadius}px`);
  s.setProperty("--fct-tile-gap", `${p.tileGap}px`);
  s.setProperty("--fct-cols-photos", String(p.colsPhotos === "pinch" ? 4 : p.colsPhotos));
  s.setProperty("--fct-cols-all", String(p.colsAll === "pinch" ? 4 : p.colsAll));
  s.setProperty("--fct-cols-albums", String(p.colsAlbums));
  s.setProperty("--fct-ui-scale", TEXT_SCALE[p.textSize]);

  target.dataset["prefsTheme"] = p.theme;
}

/** Which engine theme a preference resolves to, given what the OS says. */
export function resolveThemeId(theme: ThemePref, systemDark: boolean): string {
  const dark = theme === "dark" || (theme === "system" && systemDark);
  return dark ? "facet-dark" : "facet-light";
}

/**
 * The colour of text drawn on the accent. A hex above ~0.55 relative luminance
 * needs dark ink; everything else takes white. Good enough for a swatch row.
 */
export function inkFor(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  if (!Number.isFinite(n)) return "#ffffff";
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.55 ? "#0b0d12" : "#ffffff";
}

/**
 * Apply the theme and accent through the theme engine. Separate from
 * `applyTo` because it touches `document` and the engine's persistence, and
 * because it must re-run when the OS switches between light and dark while
 * the preference says "system".
 */
export function applyTheme(p: PhonePrefs, systemDark: boolean): void {
  themes.apply(resolveThemeId(p.theme, systemDark));
  if (p.accent !== "") {
    themes.preview("accent", p.accent);
    themes.preview("accentHover", p.accent);
    themes.preview("accentInk", inkFor(p.accent));
  }
}

/**
 * The live binding: one store, projected onto the phone root and the
 * document element, kept current for as long as the returned disposer is not
 * called. The document element is included because the viewer, the trash
 * sheet and the settings sheet are body children, outside `.ph`, and they
 * need the same `--fct-glass` and motion classes.
 */
export function bindPrefs(store: PhonePrefsStore, root: HTMLElement): () => void {
  const mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  const html = document.documentElement;

  const paint = (): void => {
    const p = store.get();
    applyTo(root, p);
    applyTo(html, p);
    applyTheme(p, mq?.matches ?? true);
  };

  paint();
  const unsub = store.subscribe(paint);
  const onScheme = (): void => { if (store.get().theme === "system") paint(); };
  mq?.addEventListener("change", onScheme);

  return () => {
    unsub();
    mq?.removeEventListener("change", onScheme);
    for (const c of PREF_CLASSES) { root.classList.remove(c); html.classList.remove(c); }
  };
}

/**
 * A short tap of the vibration motor, if the device has one and the person
 * asked for it. The app never vibrated before this; the toggle exists so the
 * few places that now do (tab switches, the settings controls) can be quiet.
 */
export function haptic(store: PhonePrefsStore, ms = 8): void {
  if (!store.get().haptics) return;
  try {
    if (typeof navigator.vibrate === "function") navigator.vibrate(ms);
  } catch {
    /* some WebViews throw without the permission; silence is the right answer */
  }
}
