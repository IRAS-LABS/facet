/**
 * The tool catalogue, as data.
 *
 * One list, because the phone's problem was never that the tools were missing —
 * they were all there, behind glyph-only buttons whose meaning arrived in a
 * hover tooltip. A finger cannot hover. So every tool in this file carries a
 * `label`, the sheet renders that label under the icon, and there is no path by
 * which a tool reaches the screen as an unexplained symbol.
 *
 * Three rules hold this together, and breaking any of them puts the phone build
 * back where it started:
 *
 *  1. `label` is required and is never truncated to its first character. If a
 *     name does not fit in two lines at 78px, the name gets shorter — the
 *     label does not get hidden.
 *  2. `group` is required. Fifty-odd flat tiles is a wall, not a menu; the
 *     groups are what make it scannable, and they are ordered by how often a
 *     phone user actually reaches for them. Light comes first now: the app grew
 *     into a gallery, the errand people arrive with is "make this picture
 *     look right", and blur keeps its own dedicated button in the viewer, so
 *     putting it second costs it nothing.
 *  3. `kinds` is required. A tool that cannot act on the open file is drawn
 *     disabled rather than omitted, so the sheet's shape is stable and you
 *     learn where things are instead of hunting a list that reflows per file.
 */

import type { FileKind } from "@core/explorer/types";
import type { BlurKind, ShapeKind } from "@core/edit/blur";

export type ToolGroup =
  | "light"
  | "blur"
  | "shape"
  | "adjust"
  | "transform"
  | "sign"
  | "ai"
  | "export"
  | "info";

/** Heading text, in render order. */
export const GROUP_ORDER: ReadonlyArray<readonly [ToolGroup, string]> = [
  ["light", "Light & colour"],
  ["blur", "Blur & redact"],
  ["shape", "Blur shape"],
  ["adjust", "Adjust"],
  ["transform", "Transform"],
  ["sign", "Sign & stamp"],
  ["ai", "Automatic"],
  ["export", "Save & share"],
  ["info", "File"],
];

/** What a tool needs before it can run. Drives the disabled state and its reason. */
export type ToolNeed =
  /** Nothing beyond an open file. */
  | "none"
  /** The Tauri bridge — anything that touches disk or the OS. */
  | "native"
  /** The bundled ffmpeg. Video and audio work. */
  | "ffmpeg";

export interface PhoneTool {
  id: string;
  /** Shown under the icon. Never abbreviated away. Keep to ~14 characters. */
  label: string;
  icon: string;
  group: ToolGroup;
  /** `"any"` means every file the viewer can open. */
  kinds: readonly FileKind[] | "any";
  need: ToolNeed;
  /** One line, shown on long-press. The tooltip that touch never got. */
  hint: string;
}

const IMAGE: readonly FileKind[] = ["image"];
/** A picture or a PDF — anything you would put your name on. */
const SIGNABLE: readonly FileKind[] = ["image", "document"];
const AV: readonly FileKind[] = ["video", "audio"];
const VISUAL: readonly FileKind[] = ["image", "video"];
const VIDEO: readonly FileKind[] = ["video"];
const AUDIO: readonly FileKind[] = ["audio"];

/**
 * The eight blur kinds from `@core/edit/blur`.
 *
 * Typed against `BlurKind` rather than loose strings so that adding a ninth
 * kind to the engine and forgetting it here is a compile error, not a tool that
 * silently never appears on the phone.
 */
const BLUR_KINDS: ReadonlyArray<readonly [BlurKind, string, string, string]> = [
  ["gaussian", "Blur", "🌫", "Ordinary soft blur — what most people mean by blur"],
  ["pixelate", "Pixelate", "▦", "Big hard squares. Reads as deliberate censorship"],
  ["solid", "Black bar", "▬", "A flat fill. The redaction bar — no pixels survive"],
  ["mosaic", "Mosaic", "◈", "Pixelate on a diamond lattice. Softer, less clinical"],
  ["motion", "Motion", "≡", "Directional smear along an angle you set"],
  ["radial", "Spin", "◎", "Zoom or spin smear radiating from the centre"],
  ["frosted", "Frosted", "❄", "Blur plus fine noise — frosted glass, not out-of-focus"],
  ["box", "Box blur", "▢", "Cheap square-kernel blur. Harsher than gaussian"],
];

/**
 * The seven region shapes.
 *
 * `full` is listed first and named "Blur everything" rather than "Full". It is
 * the one-tap answer to "blur all of it", which is a thing people want far more
 * often than they want to draw a polygon, and burying it seventh under a
 * geometric name is how it stayed unfindable.
 */
const BLUR_SHAPES: ReadonlyArray<readonly [ShapeKind, string, string, string]> = [
  ["full", "Blur all", "⬛", "The entire picture. Then punch holes in it if you like"],
  ["brush", "Brush", "🖌", "Paint the mask with a finger. Variable width"],
  ["rect", "Box", "▭", "Corner-handled rectangle. Round the corners if you want"],
  ["ellipse", "Oval", "⬭", "An ellipse in the same handles as the box"],
  ["polygon", "Lasso", "⬡", "Tap to place points around an arbitrary shape"],
  ["linear", "Band", "▤", "A band across the frame — tilt-shift"],
  ["radial", "Spotlight", "◉", "A circle of sharpness in a blurred frame, or the reverse"],
];

function blurTools(): PhoneTool[] {
  return BLUR_KINDS.map(([id, label, icon, hint]) => ({
    id: `blur.kind.${id}`,
    label,
    icon,
    group: "blur" as const,
    kinds: VISUAL,
    need: "none" as const,
    hint,
  }));
}

function shapeTools(): PhoneTool[] {
  return BLUR_SHAPES.map(([id, label, icon, hint]) => ({
    id: `blur.shape.${id}`,
    label,
    icon,
    group: "shape" as const,
    kinds: VISUAL,
    need: "none" as const,
    hint,
  }));
}

/** Everything that is not a blur kind or a blur shape. */
const REST: readonly PhoneTool[] = [
  // ── Light & colour ───────────────────────────────────────
  // Images only. The same curve over a video is an ffmpeg filter graph and a
  // re-encode, which is a different job with a different progress bar; listing
  // these as video tools would promise something the export path cannot do.
  {
    id: "light.exposure", label: "Exposure", icon: "sun", group: "light", kinds: IMAGE,
    need: "none", hint: "Stops, up or down. The photographic one — it multiplies the light",
  },
  {
    id: "light.brightness", label: "Brightness", icon: "brightness", group: "light", kinds: IMAGE,
    need: "none", hint: "A flat lift or drop across the whole picture",
  },
  {
    id: "light.contrast", label: "Contrast", icon: "contrast", group: "light", kinds: IMAGE,
    need: "none", hint: "Push the darks down and the brights up together",
  },
  {
    id: "light.saturation", label: "Saturation", icon: "saturate", group: "light", kinds: IMAGE,
    need: "none", hint: "All the way down is black and white",
  },
  {
    id: "light.warmth", label: "Warmth", icon: "warmth", group: "light", kinds: IMAGE,
    need: "none", hint: "Amber one way, blue the other. Fixes indoor light",
  },
  {
    id: "light.highlights", label: "Highlights", icon: "highlights", group: "light", kinds: IMAGE,
    need: "none", hint: "Pull back a blown sky without touching the rest",
  },
  {
    id: "light.shadows", label: "Shadows", icon: "shadows", group: "light", kinds: IMAGE,
    need: "none", hint: "Open up a face that fell into shadow",
  },
  {
    id: "light.sharpen", label: "Sharpen", icon: "sharpen", group: "light", kinds: IMAGE,
    need: "none", hint: "Crisp the edges. A little goes a long way",
  },
  {
    id: "light.vignette", label: "Vignette", icon: "vignette", group: "light", kinds: IMAGE,
    need: "none", hint: "Darken the corners to pull the eye inward",
  },
  {
    id: "light.reset", label: "Reset light", icon: "undo", group: "light", kinds: IMAGE,
    need: "none", hint: "Put every light and colour control back to neutral",
  },

  // ── Blur, the operations rather than the styles ───────────────────────
  {
    id: "blur.invert", label: "Invert", icon: "◐", group: "blur", kinds: VISUAL,
    need: "none", hint: "Protect this region and blur everything else instead",
  },
  {
    id: "blur.layers", label: "Layers", icon: "≣", group: "blur", kinds: VISUAL,
    need: "none", hint: "Every region you have added, reorderable and nameable",
  },
  {
    id: "blur.clear", label: "Clear all", icon: "✕", group: "blur", kinds: VISUAL,
    need: "none", hint: "Remove every blur region from this picture",
  },

  // ── Blur, on video: a region that lives on the timeline ───────────────
  {
    id: "blur.video.add", label: "Blur here", icon: "plus", group: "blur", kinds: VIDEO,
    need: "none", hint: "Draw a blur on this frame that stays on from this moment",
  },
  {
    id: "blur.video.track", label: "Follow", icon: "zap", group: "blur", kinds: VIDEO,
    need: "none", hint: "Let the blur follow the thing it covers through the rest of the clip",
  },
  {
    id: "blur.video.layers", label: "Layers", icon: "layers", group: "blur", kinds: VIDEO,
    need: "none", hint: "Every blur on this clip, with when it starts and ends",
  },

  // ── Adjust ────────────────────────────────────────────────────────────
  {
    id: "adj.brush", label: "Brush size", icon: "●", group: "adjust", kinds: VISUAL,
    need: "none", hint: "How wide the brush paints — down to an eye, up to a torso",
  },
  {
    id: "adj.amount", label: "Strength", icon: "◑", group: "adjust", kinds: VISUAL,
    need: "none", hint: "How heavy the blur is",
  },
  {
    id: "adj.feather", label: "Feather", icon: "◌", group: "adjust", kinds: VISUAL,
    need: "none", hint: "Edge softness. Zero gives the hard cut a redaction wants",
  },
  {
    id: "adj.opacity", label: "Opacity", icon: "◍", group: "adjust", kinds: VISUAL,
    need: "none", hint: "Dial the whole region back to a haze",
  },
  {
    id: "adj.corners", label: "Corners", icon: "⌜", group: "adjust", kinds: VISUAL,
    need: "none", hint: "Round the corners of a box region",
  },
  {
    id: "adj.angle", label: "Angle", icon: "∠", group: "adjust", kinds: VISUAL,
    need: "none", hint: "Direction for motion, spin and band regions",
  },
  {
    id: "adj.color", label: "Tint", icon: "◨", group: "adjust", kinds: VISUAL,
    need: "none", hint: "Colour laid over the blurred pixels, or the fill for a bar",
  },
  {
    id: "adj.fade", label: "Fade", icon: "◭", group: "adjust", kinds: AV,
    need: "ffmpeg", hint: "Ease the start and the end in and out",
  },
  {
    id: "adj.mute", label: "Mute", icon: "🔇", group: "adjust", kinds: VIDEO,
    need: "ffmpeg", hint: "Drop the audio track from the export",
  },
  {
    id: "adj.gain", label: "Volume", icon: "🔊", group: "adjust", kinds: AUDIO,
    need: "ffmpeg", hint: "Raise or lower the level, in decibels",
  },
  {
    id: "adj.normal", label: "Normalise", icon: "▁▄█", group: "adjust", kinds: AUDIO,
    need: "ffmpeg", hint: "Even out a recording that swings between quiet and loud",
  },
  {
    id: "adj.mono", label: "Mono", icon: "◉", group: "adjust", kinds: AUDIO,
    need: "ffmpeg", hint: "Fold two channels into one. Halves the size of a voice note",
  },

  // ── Transform ─────────────────────────────────────────────────────────
  {
    id: "tf.rotate", label: "Rotate", icon: "⟳", group: "transform", kinds: IMAGE,
    need: "none", hint: "Quarter turns, clockwise",
  },
  {
    id: "tf.flip", label: "Flip", icon: "⇋", group: "transform", kinds: IMAGE,
    need: "none", hint: "Mirror horizontally",
  },
  {
    id: "tf.crop", label: "Crop", icon: "⛶", group: "transform", kinds: IMAGE,
    need: "none", hint: "Trim to a region, with the usual aspect presets",
  },
  {
    id: "tf.resize", label: "Resize", icon: "⤢", group: "transform", kinds: IMAGE,
    need: "none", hint: "Scale to a pixel size or a percentage",
  },
  {
    id: "tf.trim", label: "Trim", icon: "✂", group: "transform", kinds: AV,
    need: "ffmpeg", hint: "Cut the start and end off a clip",
  },
  {
    id: "tf.speed", label: "Speed", icon: "⏩", group: "transform", kinds: AV,
    need: "ffmpeg", hint: "Export from 1/16× to 16×",
  },
  {
    id: "tf.fps", label: "Frame rate", icon: "◷", group: "transform", kinds: VIDEO,
    need: "ffmpeg", hint: "Re-time to 24, 30, 60 — or leave the source rate alone",
  },
  {
    id: "tf.join", label: "Join", icon: "⧉", group: "transform", kinds: AV,
    need: "ffmpeg", hint: "Stitch several clips into one, in the order you pick",
  },

  // ── Sign & stamp ──────────────────────────────────────────────────────
  // Two tiles rather than one, because they are two errands. You sign a
  // contract someone sent you; you stamp DRAFT on something you wrote. A single
  // "Sign" tile would hide the second job behind the first.
  {
    id: "sign.doc", label: "Sign", icon: "✍", group: "sign", kinds: SIGNABLE,
    need: "none", hint: "Draw a signature with your finger and place it on the page",
  },
  {
    id: "sign.mark", label: "Watermark", icon: "◫", group: "sign", kinds: SIGNABLE,
    need: "none", hint: "DRAFT, CONFIDENTIAL or your own art, tiled or once",
  },
  // Filed under Sign rather than under Blur: both live in the signing panel,
  // because both are "put a box on this page and then save a copy", and a
  // document you are redacting is usually a document you are about to send.
  {
    id: "sign.redact", label: "Black out", icon: "■", group: "sign", kinds: SIGNABLE,
    need: "none", hint: "Cover an area and destroy the text underneath it",
  },
  {
    id: "sign.crop", label: "Crop page", icon: "⛶", group: "sign", kinds: SIGNABLE,
    need: "none", hint: "Trim the margins off a page or off every page",
  },

  // ── Automatic ─────────────────────────────────────────────────────────
  {
    id: "ai.faces", label: "Blur faces", icon: "☺", group: "ai", kinds: VISUAL,
    need: "none", hint: "Find every face and blur it. Stills and video",
  },
  // The auto-blur family. Each is one detector; `ai.auto` runs every category
  // the user has switched on in Settings › Auto-blur. All of them land in the
  // Blur panel as ordinary editable regions (or layers, on video).
  {
    id: "ai.plates", label: "Blur plates", icon: "rect-shape", group: "ai", kinds: VISUAL,
    need: "none", hint: "Find every number plate and blur it. Stills and video",
  },
  {
    id: "ai.screens", label: "Blur screens", icon: "monitor", group: "ai", kinds: VISUAL,
    need: "none", hint: "Monitors, laptops and phones — every screen in the picture",
  },
  {
    id: "ai.terminals", label: "Terminals", icon: "code", group: "ai", kinds: VISUAL,
    need: "none", hint: "Only screens showing a terminal or code: dark, monospaced text",
  },
  {
    id: "ai.cards", label: "Blur cards", icon: "file-text", group: "ai", kinds: IMAGE,
    need: "none", hint: "Cards, IDs and documents — dense printed text in a card shape",
  },
  {
    id: "ai.codes", label: "Blur codes", icon: "grid", group: "ai", kinds: VISUAL,
    need: "none", hint: "QR codes and barcodes",
  },
  {
    id: "ai.text", label: "Blur text", icon: "type", group: "ai", kinds: IMAGE,
    need: "none", hint: "Emails, phone numbers, links, card numbers and your own keywords",
  },
  {
    id: "ai.auto", label: "Auto-blur", icon: "sparkles", group: "ai", kinds: VISUAL,
    need: "none", hint: "Everything sensitive at once — every category you switched on in Settings",
  },
  {
    // A document too, not just a picture. The hint underneath has always said
    // "a scan, photo or PDF" and the runner has always opened the reader for
    // whatever it was given -- only this list disagreed, and it is the one the
    // sheet reads to decide what to grey out.
    id: "ai.ocr", label: "Read text", icon: "🔤", group: "ai", kinds: SIGNABLE,
    need: "none", hint: "Pull searchable text out of a scan or a photo",
  },
  {
    id: "ai.transcribe", label: "Transcribe", icon: "🗣", group: "ai", kinds: AV,
    need: "ffmpeg", hint: "Speech to text, on device",
  },
  {
    id: "ai.subtitles", label: "Subtitles", icon: "💬", group: "ai", kinds: AV,
    need: "ffmpeg", hint: "Generate, edit, burn in or export as a sidecar",
  },
  {
    id: "ai.burn", label: "Burn subs", icon: "🎬", group: "ai", kinds: VIDEO,
    need: "ffmpeg", hint: "Write the subtitles into the picture so any player shows them",
  },
  {
    id: "ai.denoise", label: "Denoise", icon: "🎚", group: "ai", kinds: AV,
    need: "ffmpeg", hint: "Strip traffic, honking and room tone out of a recording",
  },

  // ── Save & share ──────────────────────────────────────────────────────
  {
    id: "out.save", label: "Save copy", icon: "💾", group: "export", kinds: "any",
    need: "native", hint: "Write the edit as a new file. The original is never touched",
  },
  {
    id: "out.share", label: "Share", icon: "↗", group: "export", kinds: "any",
    need: "native", hint: "Send it out through the Android share sheet",
  },
  {
    id: "out.clean", label: "Clean copy", icon: "🧹", group: "export", kinds: "any",
    need: "native", hint: "Save with every metadata tag stripped, GPS included",
  },
  {
    id: "out.convert", label: "Convert", icon: "⇄", group: "export", kinds: "any",
    need: "ffmpeg", hint: "Change format, codec or quality",
  },
  {
    id: "out.frame", label: "Save frame", icon: "❐", group: "export", kinds: VIDEO,
    need: "ffmpeg", hint: "Write the frame you are looking at out as a picture",
  },
  {
    id: "out.quality", label: "Quality", icon: "◈", group: "export", kinds: AV,
    need: "ffmpeg", hint: "Smaller file or better picture — the trade, on one slider",
  },
  {
    id: "out.batch", label: "Add to batch", icon: "▶", group: "export", kinds: "any",
    need: "native", hint: "Queue this operation over a whole selection",
  },

  // ── File ──────────────────────────────────────────────────────────────
  {
    id: "info.meta", label: "Details", icon: "ⓘ", group: "info", kinds: "any",
    need: "none", hint: "Every tag, grouped and named. GPS on a map",
  },
  {
    id: "info.hex", label: "Hex", icon: "⬢", group: "info", kinds: "any",
    need: "native", hint: "The bytes, for when nothing else will tell you",
  },
  {
    // "History" was the label here and "Undo" on the chip that actually
    // renders it (editor.ts, the More strip), which does exactly one step
    // back. Named for what it does.
    id: "info.undo", label: "Undo", icon: "↺", group: "info", kinds: "any",
    need: "none", hint: "Step back one edit",
  },
  {
    id: "info.redo", label: "Redo", icon: "↻", group: "info", kinds: "any",
    need: "none", hint: "Put back the edit you just undid",
  },
  {
    id: "info.rename", label: "Rename", icon: "✎", group: "info", kinds: "any",
    need: "native", hint: "Change the file name",
  },
  {
    // Not "Open with" on the phone: it opens FACET's own file-association
    // panel, which picks which of FACET's viewers owns an extension. Android
    // apps are not on offer -- `AndroidFs.runProgram` rejects outright -- and
    // a phone user reads "Open with" as the system share-to-app sheet.
    id: "info.openwith", label: "Opens in", icon: "⌥", group: "info", kinds: "any",
    need: "native", hint: "Choose which of FACET's viewers handles this file type",
  },
  {
    id: "info.watch", label: "Watch folder", icon: "◎", group: "info", kinds: "any",
    need: "native", hint: "Run this same edit on anything new that lands in the folder",
  },
  {
    id: "info.delete", label: "Delete", icon: "🗑", group: "info", kinds: "any",
    need: "native", hint: "Move to the trash. Recoverable",
  },
];

/** The whole catalogue, in group order. */
export const TOOLS: readonly PhoneTool[] = [...blurTools(), ...shapeTools(), ...REST];

/** Does this tool apply to a file of this kind? */
export function appliesTo(tool: PhoneTool, kind: FileKind): boolean {
  return tool.kinds === "any" || tool.kinds.includes(kind);
}

/**
 * Tools for one group, with the ones that cannot act on `kind` marked.
 *
 * Returns them rather than filtering them out — see rule 3 in the file header.
 * A sheet whose contents reshuffle per file is one you cannot build muscle
 * memory against, and muscle memory is the entire point of putting Blur in the
 * same place every time.
 */
export function groupTools(
  group: ToolGroup,
  kind: FileKind,
  have: { native: boolean; ffmpeg: boolean },
): Array<{ tool: PhoneTool; enabled: boolean; why: string }> {
  return TOOLS.filter((t) => t.group === group).map((tool) => {
    if (!appliesTo(tool, kind)) {
      return { tool, enabled: false, why: `Not available for ${kind} files` };
    }
    if (tool.need === "native" && !have.native) {
      return { tool, enabled: false, why: "Needs the app, not a browser tab" };
    }
    if (tool.need === "ffmpeg" && !have.ffmpeg) {
      return { tool, enabled: false, why: "Media tools are unavailable on this build" };
    }
    return { tool, enabled: true, why: tool.hint };
  });
}

/** How many tools the catalogue actually offers. Used by the sheet's subtitle. */
export const TOOL_COUNT = TOOLS.length;

/**
 * How each group appears in the editor's category bar: a short label and an
 * icon name (item 2).
 *
 * Short on purpose, and shorter than the headings in `GROUP_ORDER`. A chip is
 * about four characters wide before it starts eating the one next to it, so
 * "Blur & redact" becomes "Blur" and "Transform" becomes "Frame" — which is
 * also the more honest word for what that group does, since it is crop, rotate,
 * flip and resize and not a general transform.
 *
 * `Record<ToolGroup, ...>` rather than a partial map, so adding a group to the
 * union without giving it a chip is a compile error rather than a blank button
 * in the bar.
 */
export const GROUP_BAR: Readonly<Record<ToolGroup, readonly [string, string]>> = {
  light: ["Light", "sun"],
  blur: ["Blur", "blur"],
  shape: ["Shape", "rect-shape"],
  adjust: ["Tune", "sliders"],
  transform: ["Frame", "crop"],
  sign: ["Sign", "signature"],
  ai: ["Auto", "sparkles"],
  export: ["Share", "share"],
  info: ["File", "info"],
};
