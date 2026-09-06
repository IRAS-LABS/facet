/**
 * Theme registry.
 *
 * Adding a theme is adding one entry here. Nothing else in the app changes —
 * no component, no CSS file, no build step. Ported palettes credit their
 * origin; all are used as colour values only.
 */

import type { Theme, ThemeMode, ThemeTokens } from "./tokens";

/** Required colours. Everything else has a sane derivation. */
interface Core {
  bg: string;
  surface: string;
  surfaceRaised: string;
  surfaceOverlay: string;
  border: string;
  borderStrong: string;
  text: string;
  textDim: string;
  textMuted: string;
  accent: string;
  accentHover: string;
  accentInk: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  selection: string;
  canvasBg?: string;
  canvasGrid?: string;
  cardBg?: string;
  cardBorder?: string;
  cardHover?: string;
  shadow?: string;
}

function build(
  id: string,
  name: string,
  mode: ThemeMode,
  core: Core,
  credit?: string,
): Theme {
  const tokens: ThemeTokens = {
    bg: core.bg,
    surface: core.surface,
    surfaceRaised: core.surfaceRaised,
    surfaceOverlay: core.surfaceOverlay,
    border: core.border,
    borderStrong: core.borderStrong,
    text: core.text,
    textDim: core.textDim,
    textMuted: core.textMuted,
    accent: core.accent,
    accentHover: core.accentHover,
    accentInk: core.accentInk,
    success: core.success,
    warning: core.warning,
    danger: core.danger,
    info: core.info,
    canvasBg: core.canvasBg ?? core.bg,
    canvasGrid: core.canvasGrid ?? core.border,
    cardBg: core.cardBg ?? core.surfaceRaised,
    cardBorder: core.cardBorder ?? core.border,
    cardHover: core.cardHover ?? core.surfaceOverlay,
    selection: core.selection,
    shadow:
      core.shadow ??
      (mode === "dark"
        ? "0 2px 8px rgba(0,0,0,.45), 0 8px 32px rgba(0,0,0,.35)"
        : "0 1px 3px rgba(16,24,40,.10), 0 8px 24px rgba(16,24,40,.08)"),
  };
  return credit === undefined
    ? { id, name, mode, tokens }
    : { id, name, mode, credit, tokens };
}

export const THEMES: readonly Theme[] = [
  build("facet-dark", "Facet Dark", "dark", {
    bg: "#0b0d12", surface: "#12151d", surfaceRaised: "#1a1e29", surfaceOverlay: "#222739",
    border: "#232838", borderStrong: "#39405a",
    text: "#e8ecf5", textDim: "#8b93a7", textMuted: "#5c6478",
    accent: "#7c5cff", accentHover: "#9478ff", accentInk: "#ffffff",
    success: "#3ddc97", warning: "#f6c177", danger: "#ff6b81", info: "#22d3ee",
    canvasBg: "#080a0e", canvasGrid: "#161a24", selection: "rgba(124,92,255,.22)",
  }),

  build("facet-light", "Facet Light", "light", {
    bg: "#f7f8fb", surface: "#ffffff", surfaceRaised: "#ffffff", surfaceOverlay: "#ffffff",
    border: "#e3e7ef", borderStrong: "#c3cad8",
    text: "#151925", textDim: "#5b6478", textMuted: "#8d94a5",
    accent: "#6644ee", accentHover: "#5334dd", accentInk: "#ffffff",
    success: "#0f9d63", warning: "#c67c14", danger: "#d63a52", info: "#0b8fa8",
    canvasBg: "#eef1f6", canvasGrid: "#dde2ec", selection: "rgba(102,68,238,.16)",
  }),

  build("mocha", "Catppuccin Mocha", "dark", {
    bg: "#1e1e2e", surface: "#181825", surfaceRaised: "#313244", surfaceOverlay: "#45475a",
    border: "#313244", borderStrong: "#585b70",
    text: "#cdd6f4", textDim: "#a6adc8", textMuted: "#6c7086",
    accent: "#cba6f7", accentHover: "#dab8ff", accentInk: "#1e1e2e",
    success: "#a6e3a1", warning: "#f9e2af", danger: "#f38ba8", info: "#89dceb",
    canvasBg: "#11111b", canvasGrid: "#1e1e2e", selection: "rgba(203,166,247,.22)",
  }, "Catppuccin"),

  build("latte", "Catppuccin Latte", "light", {
    bg: "#eff1f5", surface: "#e6e9ef", surfaceRaised: "#ffffff", surfaceOverlay: "#ffffff",
    border: "#ccd0da", borderStrong: "#acb0be",
    text: "#4c4f69", textDim: "#6c6f85", textMuted: "#9ca0b0",
    accent: "#8839ef", accentHover: "#7326d3", accentInk: "#ffffff",
    success: "#40a02b", warning: "#df8e1d", danger: "#d20f39", info: "#209fb5",
    canvasBg: "#dce0e8", canvasGrid: "#ccd0da", selection: "rgba(136,57,239,.16)",
  }, "Catppuccin"),

  build("nord", "Nord", "dark", {
    bg: "#2e3440", surface: "#3b4252", surfaceRaised: "#434c5e", surfaceOverlay: "#4c566a",
    border: "#434c5e", borderStrong: "#616e88",
    text: "#eceff4", textDim: "#d8dee9", textMuted: "#7b88a1",
    accent: "#88c0d0", accentHover: "#8fbcbb", accentInk: "#2e3440",
    success: "#a3be8c", warning: "#ebcb8b", danger: "#bf616a", info: "#81a1c1",
    canvasBg: "#272c36", canvasGrid: "#3b4252", selection: "rgba(136,192,208,.22)",
  }, "Arctic Ice Studio"),

  build("dracula", "Dracula", "dark", {
    bg: "#282a36", surface: "#21222c", surfaceRaised: "#343746", surfaceOverlay: "#44475a",
    border: "#44475a", borderStrong: "#6272a4",
    text: "#f8f8f2", textDim: "#bfc7d5", textMuted: "#6272a4",
    accent: "#bd93f9", accentHover: "#d0aeff", accentInk: "#282a36",
    success: "#50fa7b", warning: "#f1fa8c", danger: "#ff5555", info: "#8be9fd",
    canvasBg: "#1e1f29", canvasGrid: "#2f3240", selection: "rgba(189,147,249,.24)",
  }, "Dracula Theme"),

  build("tokyo-night", "Tokyo Night", "dark", {
    bg: "#1a1b26", surface: "#16161e", surfaceRaised: "#242637", surfaceOverlay: "#292e42",
    border: "#292e42", borderStrong: "#3d59a1",
    text: "#c0caf5", textDim: "#a9b1d6", textMuted: "#565f89",
    accent: "#7aa2f7", accentHover: "#9ab8ff", accentInk: "#16161e",
    success: "#9ece6a", warning: "#e0af68", danger: "#f7768e", info: "#7dcfff",
    canvasBg: "#13141c", canvasGrid: "#1f2233", selection: "rgba(122,162,247,.22)",
  }, "enkia"),

  build("gruvbox", "Gruvbox Dark", "dark", {
    bg: "#282828", surface: "#1d2021", surfaceRaised: "#3c3836", surfaceOverlay: "#504945",
    border: "#3c3836", borderStrong: "#665c54",
    text: "#ebdbb2", textDim: "#d5c4a1", textMuted: "#928374",
    accent: "#fe8019", accentHover: "#ff9642", accentInk: "#282828",
    success: "#b8bb26", warning: "#fabd2f", danger: "#fb4934", info: "#8ec07c",
    canvasBg: "#1d2021", canvasGrid: "#32302f", selection: "rgba(254,128,25,.20)",
  }, "morhetz"),

  build("rose-pine", "Rosé Pine", "dark", {
    bg: "#191724", surface: "#1f1d2e", surfaceRaised: "#26233a", surfaceOverlay: "#2f2b45",
    border: "#26233a", borderStrong: "#524f67",
    text: "#e0def4", textDim: "#908caa", textMuted: "#6e6a86",
    accent: "#c4a7e7", accentHover: "#d6bdf5", accentInk: "#191724",
    success: "#9ccfd8", warning: "#f6c177", danger: "#eb6f92", info: "#31748f",
    canvasBg: "#14121f", canvasGrid: "#211f2e", selection: "rgba(196,167,231,.22)",
  }, "Rosé Pine"),

  build("oled", "OLED Black", "dark", {
    bg: "#000000", surface: "#070709", surfaceRaised: "#101014", surfaceOverlay: "#17171d",
    border: "#1b1b22", borderStrong: "#33333f",
    text: "#f0f2f8", textDim: "#9298a8", textMuted: "#5e6372",
    accent: "#22d3ee", accentHover: "#5ce1f5", accentInk: "#000000",
    success: "#3ddc97", warning: "#f6c177", danger: "#ff6b81", info: "#7c5cff",
    canvasBg: "#000000", canvasGrid: "#111116", selection: "rgba(34,211,238,.20)",
  }),

  build("contrast", "High Contrast", "dark", {
    bg: "#000000", surface: "#0a0a0a", surfaceRaised: "#161616", surfaceOverlay: "#1f1f1f",
    border: "#ffffff", borderStrong: "#ffffff",
    text: "#ffffff", textDim: "#e6e6e6", textMuted: "#b8b8b8",
    accent: "#ffdd00", accentHover: "#ffe94d", accentInk: "#000000",
    success: "#00ff88", warning: "#ffdd00", danger: "#ff4444", info: "#00ddff",
    canvasBg: "#000000", canvasGrid: "#2a2a2a", selection: "rgba(255,221,0,.30)",
    shadow: "0 0 0 1px #ffffff",
  }),
];

export const DEFAULT_THEME_ID = "facet-dark";

export function themeById(id: string): Theme | undefined {
  return THEMES.find((t) => t.id === id);
}
