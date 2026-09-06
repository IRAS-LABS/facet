/**
 * The ways to look at a folder (item 34).
 *
 * There were two, and both of them were spelled out by hand wherever they were
 * needed: `settings.get(PREF.view) === "canvas" ? "canvas" : "list"` appeared in
 * the shell, in the folder rules, in the topbar and in the settings registry,
 * each one a place that would have to be found and edited to add a third. That
 * is the same mistake the context menu nearly made with a second command
 * registry, so the modes are data here and every one of those places asks.
 *
 * The order below is the order they appear in the topbar, and it is not
 * arbitrary: it runs from the most information per file to the least, which is
 * also roughly from work to play. Somebody scanning left to right is choosing
 * how much they want to read.
 *
 * `parse` is deliberately total. A mode arrives from a settings file, a
 * per-folder rule and a URL, none of which this build wrote, and a folder that
 * refuses to open because its saved layout says `"grid"` from a build that
 * called it that would be an unopenable folder with no way to fix it from
 * inside the app.
 */

export type ViewMode = "list" | "gallery" | "columns" | "canvas";

export interface Mode {
  readonly id: ViewMode;
  /** What the mode is called, everywhere it is named. */
  readonly label: string;
  /** The topbar button. One glyph, no text — the label is the tooltip. */
  readonly glyph: string;
  /** One sentence, for the tooltip and the settings help. */
  readonly blurb: string;
}

export const MODES: readonly Mode[] = [
  {
    id: "list",
    label: "Details list",
    glyph: "☰",
    blurb: "One row per file, real columns, and one big preview of what you pick.",
  },
  {
    id: "gallery",
    label: "Gallery",
    glyph: "▩",
    blurb: "Big thumbnails in a grid, for folders you look at rather than read.",
  },
  {
    id: "columns",
    label: "Columns",
    glyph: "▥",
    blurb: "One column per folder, walking left to right into the tree.",
  },
  {
    id: "canvas",
    label: "Spatial canvas",
    glyph: "▦",
    blurb: "Files at fixed positions in an endless plane. Zooming in is previewing.",
  },
];

const BY_ID = new Map<string, Mode>(MODES.map((m) => [m.id, m]));

/** Whether a string is a mode this build knows how to draw. */
export function isMode(v: unknown): v is ViewMode {
  return typeof v === "string" && BY_ID.has(v);
}

/**
 * A mode from anywhere — a settings file, a folder rule, a saved session.
 * Anything unrecognised becomes the fallback rather than an error.
 */
export function parseMode(v: unknown, fallback: ViewMode = "list"): ViewMode {
  return isMode(v) ? v : fallback;
}

export function modeLabel(id: ViewMode): string {
  return BY_ID.get(id)?.label ?? id;
}

export function modeGlyph(id: ViewMode): string {
  return BY_ID.get(id)?.glyph ?? "☰";
}

export function modeBlurb(id: ViewMode): string {
  return BY_ID.get(id)?.blurb ?? "";
}

/**
 * The next mode round the ring, which is what one key can mean when there are
 * four. Ctrl+Shift+V used to be a toggle between two and is now a cycle; an
 * unknown mode enters the ring at the start rather than sticking.
 */
export function nextMode(id: ViewMode): ViewMode {
  const i = MODES.findIndex((m) => m.id === id);
  return MODES[(i + 1) % MODES.length]!.id;
}

/** The pairs the settings registry offers, generated rather than repeated. */
export function modeChoices(): Array<[string, string]> {
  return MODES.map((m) => [m.id, m.label] as [string, string]);
}
