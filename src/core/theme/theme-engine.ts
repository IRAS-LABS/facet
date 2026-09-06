/**
 * Theme engine.
 *
 * Applies a theme by writing CSS custom properties onto <html>. That is the
 * whole mechanism — no component subscribes, nothing re-renders, and a switch
 * is O(number of tokens) regardless of how much is on screen.
 *
 * Also owns: persistence, favourites, and user-authored themes (a base theme
 * plus a sparse patch, so a user theme survives us editing the base).
 */

import {
  cssVar,
  TOKEN_KEYS,
  type Theme,
  type ThemeTokens,
} from "./tokens";
import { DEFAULT_THEME_ID, THEMES, themeById } from "./themes";

const LS_ACTIVE = "facet.theme.active";
const LS_FAVOURITES = "facet.theme.favourites";
const LS_CUSTOM = "facet.theme.custom";

/** A user theme: a base theme id plus only the tokens they changed. */
export interface CustomTheme {
  id: string;
  name: string;
  baseId: string;
  patch: Partial<ThemeTokens>;
}

type Listener = (theme: Theme) => void;

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    // Corrupt or unavailable storage must never stop the app from painting.
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — non-fatal */
  }
}

class ThemeEngine {
  #custom: CustomTheme[] = readJSON<CustomTheme[]>(LS_CUSTOM, []);
  #favourites: string[] = readJSON<string[]>(LS_FAVOURITES, [DEFAULT_THEME_ID]);
  #activeId = DEFAULT_THEME_ID;
  #listeners = new Set<Listener>();

  /** Built-ins plus resolved user themes, in menu order. */
  get all(): Theme[] {
    return [...THEMES, ...this.#custom.map((c) => this.#resolve(c))];
  }

  get active(): Theme {
    return this.byId(this.#activeId) ?? this.byId(DEFAULT_THEME_ID) ?? THEMES[0]!;
  }

  get favourites(): readonly string[] {
    return this.#favourites;
  }

  byId(id: string): Theme | undefined {
    const built = themeById(id);
    if (built) return built;
    const custom = this.#custom.find((c) => c.id === id);
    return custom ? this.#resolve(custom) : undefined;
  }

  #resolve(c: CustomTheme): Theme {
    const base = themeById(c.baseId) ?? THEMES[0]!;
    return {
      id: c.id,
      name: c.name,
      mode: base.mode,
      tokens: { ...base.tokens, ...c.patch },
    };
  }

  /** Read the stored choice and paint. Call once, before first frame. */
  init(): Theme {
    const stored = localStorage.getItem(LS_ACTIVE);
    this.apply(stored !== null && this.byId(stored) ? stored : DEFAULT_THEME_ID);
    return this.active;
  }

  apply(id: string): void {
    const theme = this.byId(id);
    if (!theme) return;
    this.#activeId = theme.id;

    const root = document.documentElement;
    const style = root.style;
    for (const key of TOKEN_KEYS) {
      style.setProperty(cssVar(key), theme.tokens[key]);
    }
    // Native scrollbars, selection highlight and form controls follow this.
    style.setProperty("color-scheme", theme.mode);
    root.dataset["theme"] = theme.id;
    root.dataset["mode"] = theme.mode;

    try {
      localStorage.setItem(LS_ACTIVE, theme.id);
    } catch {
      /* non-fatal */
    }
    for (const fn of this.#listeners) fn(theme);
  }

  /** Live-edit a single token without committing a theme. Used by the editor. */
  preview(token: keyof ThemeTokens, value: string): void {
    document.documentElement.style.setProperty(cssVar(token), value);
  }

  /** Discard any previews and repaint the committed theme. */
  revert(): void {
    this.apply(this.#activeId);
  }

  isFavourite(id: string): boolean {
    return this.#favourites.includes(id);
  }

  toggleFavourite(id: string): boolean {
    const i = this.#favourites.indexOf(id);
    if (i === -1) this.#favourites.push(id);
    else this.#favourites.splice(i, 1);
    writeJSON(LS_FAVOURITES, this.#favourites);
    return this.isFavourite(id);
  }

  saveCustom(theme: CustomTheme): void {
    const i = this.#custom.findIndex((c) => c.id === theme.id);
    if (i === -1) this.#custom.push(theme);
    else this.#custom[i] = theme;
    writeJSON(LS_CUSTOM, this.#custom);
    if (this.#activeId === theme.id) this.apply(theme.id);
  }

  /** Removes a user theme. Built-ins are not removable. */
  removeCustom(id: string): void {
    this.#custom = this.#custom.filter((c) => c.id !== id);
    writeJSON(LS_CUSTOM, this.#custom);
    this.#favourites = this.#favourites.filter((f) => f !== id);
    writeJSON(LS_FAVOURITES, this.#favourites);
    if (this.#activeId === id) this.apply(DEFAULT_THEME_ID);
  }

  onChange(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
}

export const themes = new ThemeEngine();
