/**
 * Every shortcut FACET has (item 35).
 *
 * Importing this module registers them, exactly as `settings/registry.ts` does
 * for preferences: the import is what guarantees the declaration exists before
 * anything matches against it.
 *
 * **What is here is what the shell dispatches.** A key handled inside a surface
 * that owns the keyboard for as long as it is up — the player's J/K/L transport,
 * the hex inspector's arrows, the table's find field — is not listed, because
 * those are not shortcuts competing for a global chord; they are that surface's
 * controls, and rebinding them here would let you take the arrow keys away from
 * a grid. The rule for whether something belongs in this file: could it fire
 * while you are standing in a folder?
 */

import { KEY_ID } from "./ids";
import { keys, type KeyCommand } from "./map";

const CMDS: KeyCommand[] = [
  // ── Shell ─────────────────────────────────────────────────────────────────
  {
    id: KEY_ID.palette,
    label: "Command palette",
    group: "Shell",
    default: "Ctrl+K",
    scope: "always",
    keywords: ["command", "search", "run", "everything"],
  },
  {
    id: KEY_ID.settings,
    label: "Settings",
    group: "Shell",
    default: "Ctrl+,",
    scope: "always",
    keywords: ["preferences", "options", "configure"],
  },
  {
    id: KEY_ID.sidebar,
    label: "Show or hide the sidebar",
    group: "Shell",
    default: "Ctrl+B",
    scope: "always",
    keywords: ["tree", "folders", "places", "panel"],
  },
  {
    id: KEY_ID.shortcuts,
    label: "Keyboard shortcuts",
    group: "Shell",
    default: "Ctrl+Shift+K",
    scope: "always",
    keywords: ["keys", "bindings", "rebind", "map"],
  },

  // ── Explorer ──────────────────────────────────────────────────────────────
  {
    id: KEY_ID.address,
    label: "Edit the address",
    group: "Explorer",
    default: "Ctrl+L",
    scope: "explorer",
    keywords: ["path", "location", "go to", "type"],
  },
  {
    id: KEY_ID.back,
    label: "Go back",
    group: "Explorer",
    default: "Backspace",
    scope: "explorer",
    keywords: ["up", "parent", "previous"],
  },
  {
    id: KEY_ID.reload,
    label: "Reload this folder",
    group: "Explorer",
    default: "F5",
    scope: "explorer",
    keywords: ["refresh", "again"],
  },
  {
    id: KEY_ID.filter,
    label: "Filter this folder",
    group: "Explorer",
    default: "Ctrl+F",
    scope: "explorer",
    keywords: ["search", "find", "narrow", "only", "query"],
  },
  {
    id: KEY_ID.viewMode,
    label: "Switch between list and canvas",
    group: "Explorer",
    default: "Ctrl+Shift+V",
    scope: "explorer",
    keywords: ["layout", "grid", "details", "spatial"],
  },
  {
    id: KEY_ID.bigger,
    label: "Bigger cards",
    group: "Explorer",
    default: "+",
    alias: ["="],
    scope: "explorer",
    keywords: ["zoom", "in", "larger", "thumbnail"],
  },
  {
    id: KEY_ID.smaller,
    label: "Smaller cards",
    group: "Explorer",
    default: "-",
    scope: "explorer",
    keywords: ["zoom", "out", "tinier", "thumbnail"],
  },

  // ── Files ─────────────────────────────────────────────────────────────────
  {
    id: KEY_ID.open,
    label: "Open the selection",
    group: "Files",
    default: "Enter",
    scope: "explorer",
    keywords: ["launch", "enter", "view"],
  },
  {
    id: KEY_ID.quickLook,
    label: "Quick look",
    group: "Files",
    default: "Space",
    scope: "explorer",
    keywords: ["peek", "preview", "space"],
  },
  {
    id: KEY_ID.info,
    label: "Metadata",
    group: "Files",
    default: "I",
    scope: "explorer",
    keywords: ["exif", "tags", "properties", "inspect"],
  },
  {
    id: KEY_ID.copy,
    label: "Copy the paths",
    group: "Files",
    default: "Ctrl+C",
    scope: "explorer",
    keywords: ["clipboard", "path", "duplicate"],
  },
  {
    id: KEY_ID.share,
    label: "Share the selection",
    group: "Files",
    default: "Ctrl+Shift+S",
    scope: "explorer",
    keywords: ["send", "sheet", "export"],
  },
  {
    id: KEY_ID.edit,
    label: "Edit what I am looking at",
    group: "Files",
    default: "E",
    scope: "always",
    keywords: ["photo", "video", "audio", "editor"],
  },

  // ── Tools ─────────────────────────────────────────────────────────────────
  {
    id: KEY_ID.hex,
    label: "Hex and binary inspector",
    group: "Tools",
    default: "Ctrl+Shift+H",
    scope: "always",
    keywords: ["binary", "bytes", "dump", "raw"],
  },
  {
    id: KEY_ID.table,
    label: "Tabular data viewer",
    group: "Tools",
    default: "Ctrl+Shift+T",
    scope: "always",
    keywords: ["csv", "parquet", "spreadsheet", "rows"],
  },
  {
    id: KEY_ID.transcribe,
    label: "Transcribe what I am looking at",
    group: "Tools",
    // A bare letter, in the family of E for edit and I for info: it is a thing
    // you do to the file in front of you, not a mode you enter.
    default: "T",
    scope: "always",
    keywords: ["speech", "words", "subtitles", "speakers", "meeting", "dictation"],
  },
  {
    id: KEY_ID.subtitles,
    label: "Subtitles",
    group: "Tools",
    // Shift+T, next to transcription, because it is the second half of the same
    // job: T turns speech into words, Shift+T turns words into cues.
    default: "Shift+T",
    scope: "always",
    keywords: ["srt", "vtt", "captions", "cues", "burn in", "closed captions"],
  },
  {
    id: KEY_ID.ocr,
    label: "Read the text in this",
    group: "Tools",
    // R, in the same family of bare letters: E edits, I informs, T transcribes,
    // R reads. Transcription and OCR are the same verb aimed at different
    // senses, so they sit next to each other in the list as well as on the row.
    default: "R",
    scope: "always",
    keywords: ["ocr", "scan", "text", "recognise", "recognize", "searchable pdf", "tesseract"],
  },
  {
    id: KEY_ID.sign,
    label: "Sign or watermark this",
    group: "Tools",
    // Shift+S, beside the bare letters that open a document tool. Not plain S:
    // that is one slip away from a save, and a panel that opens over the file
    // you meant to write is the wrong kind of surprise.
    default: "Shift+S",
    scope: "always",
    keywords: ["sign", "signature", "initials", "watermark", "stamp", "draft", "confidential"],
  },
  {
    id: KEY_ID.batch,
    label: "The queue",
    group: "Tools",
    default: "Ctrl+Shift+B",
    scope: "always",
    keywords: ["batch", "jobs", "progress", "encode"],
  },
  {
    id: KEY_ID.watch,
    label: "Watch folders",
    group: "Tools",
    default: "Ctrl+Shift+W",
    scope: "always",
    keywords: ["rules", "automatic", "monitor"],
  },
];

export const ALL_KEYS = CMDS;

keys.register(...CMDS);
