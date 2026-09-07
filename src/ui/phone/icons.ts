/**
 * The phone shell's icon set — inline SVG, stroke-drawn, `currentColor`.
 *
 * This replaces ~120 text glyphs that were doing the job before. Two problems
 * drove the change, both visible on the first screenshot: emoji (🌫 🗑 💾…)
 * render full-colour and cartoon-sized in the Android WebView, shouting next
 * to 11px monochrome labels; and the Unicode geometry family (● ◌ ◑ ◐ ◉ ◎ ○)
 * is seven unrelated meanings drawn as one indistinguishable circle at 19px.
 * The desktop tree (`src/ui/tree.ts`) already made the argument for SVG +
 * `currentColor` — the icon dims with its row, brightens on press, goes accent
 * when armed, all for free, in every theme.
 *
 * Drawing style: 24×24 viewBox, 2px round stroke, no fill unless the icon's
 * meaning *is* a filled area (the black-bar redaction, the filled star). Every
 * icon is inner-SVG markup; the shared attributes live on the root element so
 * children inherit them.
 *
 * `icon(name)` is the whole API. Unknown names fall back to a text span so a
 * missed rename degrades to the old behaviour instead of a blank button —
 * which also lets call sites pass legacy glyphs during the transition.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

const ICONS: Record<string, string> = {
  // ── Phone editor chrome ─────────────────────────────────────────────────
  "compare": '<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>',
  "history": '<path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 9 8 9"/><polyline points="12 7 12 12 16 14"/>',
  "straighten": '<path d="M3 15l18-6"/><path d="M6 14l-.7 2.1M10 12.7l-.7 2.1M14 11.4l-.7 2.1M18 10l-.7 2.1"/>',
  "flip-v": '<path d="M4 12h16"/><path d="M8 8l4-5 4 5z"/><path d="M8 16l4 5 4-5z"/>',
  "ratio": '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 12h18M12 5v14" stroke-dasharray="2 2"/>',
  "pen": '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  "more": '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  "frame": '<rect x="3" y="3" width="18" height="18" rx="1"/><rect x="7" y="7" width="10" height="10"/>',
  // ── Navigation & chrome ──────────────────────────────────────────────────
  "arrow-left": '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  "chevron-left": '<polyline points="15 18 9 12 15 6"/>',
  "chevron-right": '<polyline points="9 18 15 12 9 6"/>',
  "x": '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  "check": '<polyline points="20 6 9 17 4 12"/>',
  "menu": '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  "select": '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  // The star is stroke-only until `.phv-starred` fills it via CSS.
  "star": '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  "search": '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',

  // ── Tabs & file kinds ────────────────────────────────────────────────────
  "image": '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  "grid": '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  "albums": '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  "folder": '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  "download": '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  "file-text": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  "file": '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>',
  "play": '<polygon points="6 3 20 12 6 21 6 3"/>',
  "pause": '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  "music": '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  "package": '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  "archive": '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
  "table": '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="3" x2="9" y2="21"/>',
  "box": '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
  "code": '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',

  // ── Viewer actions ───────────────────────────────────────────────────────
  "share": '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
  "edit": '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  "trash": '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  "info": '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  "save": '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',

  // ── Blur styles ──────────────────────────────────────────────────────────
  "blur": '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
  "pixelate": '<rect x="3" y="3" width="6" height="6"/><rect x="15" y="3" width="6" height="6"/><rect x="9" y="9" width="6" height="6"/><rect x="3" y="15" width="6" height="6"/><rect x="15" y="15" width="6" height="6"/>',
  "bar": '<rect x="2" y="9" width="20" height="6" rx="1" fill="currentColor" stroke="none"/>',
  "mosaic": '<path d="M12 3l3.5 3.5L12 10 8.5 6.5z"/><path d="M12 14l3.5 3.5L12 21l-3.5-3.5z"/><path d="M3 12l3.5-3.5L10 12l-3.5 3.5z"/><path d="M14 12l3.5-3.5L21 12l-3.5 3.5z"/>',
  "motion": '<path d="M9.59 4.59A2 2 0 1 1 11 8H2"/><path d="M17.73 7.73A2.5 2.5 0 1 1 19.5 12H2"/><path d="M12.59 19.41A2 2 0 1 0 14 16H2"/>',
  "spin": '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/>',
  "frost": '<line x1="12" y1="2" x2="12" y2="22"/><line x1="3.3" y1="7" x2="20.7" y2="17"/><line x1="20.7" y1="7" x2="3.3" y2="17"/>',
  "box-blur": '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="8" y="8" width="8" height="8" stroke-dasharray="2 2"/>',

  // ── Blur shapes ──────────────────────────────────────────────────────────
  "fill-all": '<rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" fill-opacity="0.25"/><rect x="3" y="3" width="18" height="18" rx="2"/>',
  "brush": '<path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L14 13l-4 1 1-4z"/><path d="M9.5 14.5c-2.2.3-3.5 1.7-4 4.2-.2 1.2-1 2-2.5 2.3 1.6 1.6 6.6 2 8.5-.5 1-1.4.8-3.6-.5-4.8z"/>',
  "rect-shape": '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  "oval": '<ellipse cx="12" cy="12" rx="9" ry="6"/>',
  "lasso": '<ellipse cx="12" cy="9" rx="8" ry="5"/><path d="M5.5 12.5c-1 2.5 0 5 2.5 6"/><circle cx="9" cy="20" r="1.6"/>',
  "band": '<rect x="3" y="9" width="18" height="6"/><line x1="3" y1="4" x2="21" y2="4" stroke-dasharray="2 3"/><line x1="3" y1="20" x2="21" y2="20" stroke-dasharray="2 3"/>',
  "spotlight": '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor" fill-opacity="0.35"/>',

  // ── Editor tools ─────────────────────────────────────────────────────────
  "invert": '<circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 0 20z" fill="currentColor" stroke="none"/>',
  "layers": '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  "clear": '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  "dot": '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="10" stroke-dasharray="3 3"/>',
  "gauge": '<path d="M12 3a9 9 0 0 1 9 9"/><path d="M3 12a9 9 0 0 1 2.64-6.36"/><line x1="12" y1="12" x2="16" y2="8"/><path d="M4 17a9 9 0 0 0 16 0"/>',
  "feather": '<path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/>',
  "opacity": '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/><path d="M12 3.5v17a8 8 0 0 0 5.66-13.66z" fill="currentColor" stroke="none" fill-opacity="0.45"/>',
  "corners": '<path d="M4 20v-7a9 9 0 0 1 9-9h7"/>',
  "angle": '<line x1="4" y1="20" x2="20" y2="20"/><line x1="4" y1="20" x2="15" y2="6"/><path d="M11 20a7.5 7.5 0 0 0-2.8-5.4"/>',
  "tint": '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" fill="currentColor" fill-opacity="0.4"/>',
  "fade": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 21L21 3v18z" fill="currentColor" stroke="none" fill-opacity="0.4"/>',
  "mute": '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>',
  "volume": '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  "normalise": '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  "mono": '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>',
  "rotate": '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  "flip": '<path d="M4 7l5 5-5 5z" fill="currentColor" stroke="none"/><path d="M20 7l-5 5 5 5z"/><line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="3 3"/>',
  "crop": '<path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"/><path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"/>',
  "resize": '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  "scissors": '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="9.88" x2="12" y2="13.76"/>',
  "speed": '<polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/>',
  "clock": '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  "join": '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  "face": '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
  "ocr": '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  "mic": '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
  "subtitles": '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  "film": '<rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>',
  "sliders": '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  "sparkles": '<path d="M12 3l1.8 4.8 4.8 1.8-4.8 1.8L12 16.2l-1.8-4.8-4.8-1.8 4.8-1.8z"/><path d="M19 14l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z"/>',
  "convert": '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  "camera": '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  "quality": '<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>',
  "batch": '<line x1="11" y1="12" x2="3" y2="12"/><line x1="16" y1="6" x2="3" y2="6"/><line x1="11" y1="18" x2="3" y2="18"/><line x1="18" y1="9" x2="18" y2="15"/><line x1="15" y1="12" x2="21" y2="12"/>',
  "hex": '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
  "undo": '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
  "redo": '<polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>',
  "rename": '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  "open-with": '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  "eye": '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  "eye-off": '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',

  // ── Signing & stamping ───────────────────────────────────────────────────
  // A written flourish over its ruled line: the one shape that reads as
  // "signature" and not as "pen", which `edit` already owns.
  "signature": '<path d="M3 15c2.5 0 3-6 4.5-6S9 16 10.5 16 13 5 15 5s1.5 8 3 8c1 0 1.5-1.5 2.5-1.5"/><line x1="3" y1="20" x2="21" y2="20"/>',
  // Overlapping diagonal rules inside a page — a stamp laid across content.
  "watermark": '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="6" y1="15" x2="15" y2="6"/><line x1="10" y1="18" x2="18" y2="10"/>',
  "guides": '<line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21" stroke-dasharray="2 3"/><line x1="15" y1="3" x2="15" y2="21" stroke-dasharray="2 3"/>',
  "plus": '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  "minus": '<line x1="5" y1="12" x2="19" y2="12"/>',
  "copy": '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',

  // ── Light & colour ───────────────────────────────────────────
  // The two half-filled circles (contrast, shadows) are the only icons in the
  // set that fill a shape: they are describing which half of the tone range
  // moves, and an outline cannot say that. The fill is set on the child so it
  // overrides the stroke-only defaults on the root.
  // ── Settings sheet ───────────────────────────────────────────────────────
  "settings": '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  "moon": '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  "monitor": '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  "palette": '<circle cx="12" cy="12" r="10"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="7" r="1.2"/><circle cx="16" cy="10" r="1.2"/><path d="M12 22a3 3 0 0 0 0-6h-1a2 2 0 0 1 0-4"/>',
  "droplet": '<path d="M12 2.7l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
  "columns": '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>',
  "square": '<rect x="3" y="3" width="18" height="18" rx="2"/>',
  "square-sharp": '<rect x="3" y="3" width="18" height="18"/>',
  "stack": '<path d="M6 8h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><path d="M7 6.5h10"/><path d="M9 4h6"/>',
  "type": '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  "zap": '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  "vibrate": '<rect x="8" y="3" width="8" height="18" rx="2"/><path d="M4 8v8M20 8v8"/>',
  "tag": '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  "home": '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  "rotate-ccw": '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  "glow": '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="2 3"/>',

  "sun": '<circle cx="12" cy="12" r="4"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
  "brightness": '<circle cx="12" cy="12" r="5"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/>',
  "contrast": '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none"/>',
  "saturate": '<path d="M12 2.7l5.3 5.3a7.5 7.5 0 1 1-10.6 0z"/>',
  "warmth": '<path d="M14 14.76V4a2 2 0 0 0-4 0v10.76a4 4 0 1 0 4 0z"/>',
  "highlights": '<circle cx="12" cy="9" r="3.5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="5.2" y1="4.2" x2="6.6" y2="5.6"/><line x1="18.8" y1="4.2" x2="17.4" y2="5.6"/><line x1="3" y1="20" x2="21" y2="20"/>',
  "shadows": '<circle cx="12" cy="12" r="9"/><path d="M3.5 15a9 9 0 0 0 17 0z" fill="currentColor" stroke="none"/>',
  "sharpen": '<polyline points="3 20 12 4 21 20"/><line x1="7.5" y1="14" x2="16.5" y2="14"/>',
  "vignette": '<rect x="2.5" y="4" width="19" height="16" rx="7"/><circle cx="12" cy="12" r="3"/>',
};

/**
 * Legacy glyph → icon name. Data files (`tools.ts` above all) still carry the
 * old glyph in their `icon` field; this maps each to its drawing so the
 * catalogue did not need 59 edits. Ambiguous glyphs (▶ ✕ ▤ …) resolve to
 * whatever the *tool sheet* means by them — the other surfaces pass names
 * directly or override by tool id below.
 */
const GLYPH_TO_NAME: Record<string, string> = {
  "🌫": "blur", "▦": "pixelate", "▬": "bar", "◈": "mosaic", "≡": "motion",
  "◎": "spin", "❄": "frost", "▢": "box-blur",
  "⬛": "fill-all", "🖌": "brush", "▭": "rect-shape", "⬭": "oval",
  "⬡": "lasso", "▤": "band", "◉": "spotlight",
  "◐": "invert", "≣": "layers", "✕": "clear", "●": "dot", "◑": "gauge",
  "◌": "feather", "◍": "opacity", "⌜": "corners", "∠": "angle", "◨": "tint",
  "◭": "fade", "🔇": "mute", "🔊": "volume", "▁▄█": "normalise",
  "⟳": "rotate", "⇋": "flip", "⛶": "crop", "⤢": "resize", "✂": "scissors",
  "⏩": "speed", "◷": "clock", "⧉": "join", "☺": "face", "🔤": "ocr",
  "🗣": "mic", "💬": "subtitles", "🎬": "film", "🎚": "sliders", "💾": "save",
  "↗": "share", "🧹": "sparkles", "⇄": "convert", "❐": "camera",
  "▶": "play", "⏸": "pause", "ⓘ": "info", "⬢": "hex", "↺": "undo", "↻": "redo",
  "✎": "rename", "⌥": "open-with", "🗑": "trash",
  // Quick Look's action bar. "■" is the black bar a redaction leaves
  // behind, which is what `bar` already draws.
  "✍": "signature", "✍️": "signature", "■": "bar",
  "←": "arrow-left", "‹": "chevron-left", "›": "chevron-right",
  "☆": "star", "★": "star", "☰": "select", "⌕": "search", "⊞": "grid",
  "✓": "check", "↓": "download", "▩": "table", "‹›": "code",
};

/**
 * Tool-id overrides, for the glyphs that mean two things inside the catalogue
 * itself. `◉` is Spotlight *and* Mono; `◈` is Mosaic *and* Quality; `◎` is
 * Spin *and* Watch folder. The glyph map carries the blur meaning; these carry
 * the other one.
 */
const TOOL_TO_NAME: Record<string, string> = {
  "adj.mono": "mono",
  "out.quality": "quality",
  "lib.watch": "eye",
  "meta.hex": "hex",
  "meta.details": "info",
  "out.batch": "batch",
};

/**
 * Build an icon element. `key` is an icon name, a legacy glyph, or anything a
 * data file put in its `icon` field; `toolId` disambiguates catalogue
 * collisions. Falls back to a text span for anything unknown, so the worst
 * case is exactly what the app shipped with.
 */
export function icon(key: string, toolId?: string): Element {
  const name =
    (toolId !== undefined ? TOOL_TO_NAME[toolId] : undefined) ??
    (key in ICONS ? key : GLYPH_TO_NAME[key]);
  const markup = name !== undefined ? ICONS[name] : undefined;
  if (markup === undefined) {
    const span = document.createElement("span");
    span.textContent = key;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("fct-icon");
  svg.innerHTML = markup;
  return svg;
}
