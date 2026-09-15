/**
 * The theme contract.
 *
 * Every colour in Facet comes from here. No component may hardcode a hex
 * value — if something needs a colour that is not a token, the token list is
 * what changes, not the component. That is what makes "many many themes"
 * cost nothing per theme.
 *
 * Tokens are emitted as CSS custom properties (`--fct-bg`, `--fct-accent`, …)
 * so CSS consumes them directly and a theme switch is one attribute write with
 * no re-render.
 */

export interface ThemeTokens {
  /** Page ground. The furthest-back surface. */
  bg: string;
  /** Panels, rails, bars. */
  surface: string;
  /** Cards and controls sitting on a surface. */
  surfaceRaised: string;
  /** Menus, popovers, dialogs. */
  surfaceOverlay: string;

  /** Hairlines and dividers. */
  border: string;
  /** Emphasised borders — focus rings, active edges. */
  borderStrong: string;

  /** Primary reading colour. */
  text: string;
  /** Secondary copy, labels. */
  textDim: string;
  /** Disabled, placeholders, timestamps. */
  textMuted: string;

  /** Brand / interactive colour. */
  accent: string;
  /** Accent under pointer. */
  accentHover: string;
  /** Text drawn on top of accent fills. */
  accentInk: string;

  success: string;
  warning: string;
  danger: string;
  info: string;

  /** The 2D spatial canvas ground — usually a touch darker than `bg`. */
  canvasBg: string;
  /** Canvas grid ruling. Expected to be low-contrast. */
  canvasGrid: string;
  /** File card body. */
  cardBg: string;
  cardBorder: string;
  cardHover: string;
  /** Selection wash. Should carry alpha. */
  selection: string;

  /** Full CSS box-shadow value for raised elements. */
  shadow: string;
}

export type ThemeMode = "dark" | "light";

export interface Theme {
  /** Stable id. Used in storage and in `data-theme`. Never rename in place. */
  id: string;
  name: string;
  /** Drives `color-scheme`, so native scrollbars and form controls match. */
  mode: ThemeMode;
  /** Attribution for ported palettes. */
  credit?: string;
  tokens: ThemeTokens;
}

/**
 * The name of the property a theme *writes*.
 *
 * Not the same as the one stylesheets *read*. A theme is written onto the
 * element's inline style, and inline style beats every selector, so as long as
 * the two names were the same no stylesheet could ever adjust a themed colour
 * -- which is exactly what a skin has to do to turn opaque panels into glass.
 * The theme writes `--fct-surface-raw`; base.css says `--fct-surface` is that
 * raw value; and skin.css, being a stylesheet like any other, can now say
 * otherwise. Nothing else changes: the 38 stylesheets still read `--fct-*`.
 */
export function cssVarRaw(token: keyof ThemeTokens): string {
  return `${cssVar(token)}-raw`;
}

/** The CSS custom-property name stylesheets read for a token. */
export function cssVar(token: keyof ThemeTokens): string {
  // camelCase -> kebab-case, namespaced to avoid collisions with anything
  // a future embedded module might define.
  return `--fct-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

export const TOKEN_KEYS = [
  "bg", "surface", "surfaceRaised", "surfaceOverlay",
  "border", "borderStrong",
  "text", "textDim", "textMuted",
  "accent", "accentHover", "accentInk",
  "success", "warning", "danger", "info",
  "canvasBg", "canvasGrid", "cardBg", "cardBorder", "cardHover", "selection",
  "shadow",
] as const satisfies readonly (keyof ThemeTokens)[];
