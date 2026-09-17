/**
 * Every setting FACET actually has (item 33).
 *
 * Importing this module registers them. Anything that wants to read a
 * preference imports `PREF` from here and calls `settings.get(PREF.x)` — the
 * import is what guarantees the declaration exists before the read, so there is
 * no ordering problem to remember and no init() to forget to call.
 *
 * **Nothing is declared here that nothing reads.** A settings screen full of
 * switches that do nothing is worse than a smaller one, because after the first
 * dead switch a user stops trusting the rest of them. When a new module lands,
 * it adds its settings here *and* its reader in the same change.
 *
 * Things with their own storage — the theme engine, the watch-folder list,
 * saved edits — are deliberately absent. They are richer than "a boolean, a
 * number or a string" and they already persist correctly; mirroring them into
 * this store would give every one of them two sources of truth that drift. The
 * panel shows them anyway, as contributed rows (see `SettingsPanel.addCustom`).
 */

import { DEFAULT_CARD, DEFAULT_COLUMNS } from "@core/explorer/fields";
import { DEFAULT_MENU } from "@core/explorer/menu";
// Aliased: `GROUPS` is already taken here by the settings panel's own
// section names, which are a different kind of group entirely.
import { GROUPS as GROUP_BYS } from "@core/explorer/grouping";
import { modeChoices } from "@core/explorer/modes";
import type { ChoiceSetting, NumberSetting, TextSetting, ToggleSetting } from "./schema";
import { settings } from "./store";

/**
 * The ids, as constants.
 *
 * Callers use `PREF.cardSize` rather than the string, so a typo is a build
 * error rather than a `settings: read of undeclared explorer.cardsize` warning
 * in a console nobody is watching.
 */
export const PREF = {
  uiScale: "appearance.uiScale",
  density: "appearance.density",
  font: "appearance.font",
  reduceMotion: "appearance.reduceMotion",
  skin: "appearance.skin",
  corners: "appearance.corners",
  outlines: "appearance.outlines",
  glow: "appearance.glow",
  backdrop: "appearance.backdrop",

  view: "explorer.view",
  sort: "explorer.sort",
  group: "explorer.group",
  ascending: "explorer.ascending",
  foldersFirst: "explorer.foldersFirst",
  showHidden: "explorer.showHidden",
  cardSize: "explorer.cardSize",
  nameLines: "explorer.nameLines",
  startFolder: "explorer.startFolder",
  restoreSession: "explorer.restoreSession",
  columns: "explorer.columns",
  cardFields: "explorer.cardFields",
  menu: "explorer.menu",
  rememberFolders: "explorer.rememberFolders",

  previews: "previews.enabled",
  folderPreviews: "previews.folders",
  previewLanes: "previews.lanes",
  previewCache: "previews.cache",
  previewTextLines: "previews.textLines",

  sceneToneMap: "scene.toneMap",
  sceneExposure: "scene.exposure",
  sceneBackground: "scene.background",
  sceneEnvironment: "scene.environment",
  sceneTurntableSpeed: "scene.turntableSpeed",
  scenePanelOpen: "scene.panelOpen",

  cameraFormat: "camera.format",
  cameraQuality: "camera.quality",
  cameraHeight: "camera.height",
  cameraMirror: "camera.mirror",
  cameraGrid: "camera.grid",
  cameraAspect: "camera.aspect",
  cameraCountdown: "camera.countdown",
  cameraSound: "camera.sound",
  cameraFolder: "camera.folder",

  recScreen: "recorder.screen",
  recSystem: "recorder.system",
  recMic: "recorder.mic",
  recQuality: "recorder.quality",
  recCountdown: "recorder.countdown",
  recFolder: "recorder.folder",

  scanLook: "scan.look",
  scanSearchable: "scan.searchable",
  scanFolder: "scan.folder",

  readEngine: "read.engine",
  readVoice: "read.voice",
  readSystemVoice: "read.systemVoice",
  readLang: "read.lang",
  readOnline: "read.online",
  readSpeed: "read.speed",
  readPitch: "read.pitch",
  readVolume: "read.volume",
  readHighlight: "read.highlight",
  readOnPage: "read.onPage",
  readFollow: "read.follow",
  readRepeat: "read.repeat",
  readAwake: "read.awake",
  readSkipHeaders: "read.skipHeaders",
  readSkipPageNumbers: "read.skipPageNumbers",
  readSkipCaptions: "read.skipCaptions",
  readSkipReferences: "read.skipReferences",
  readSkipFootnotes: "read.skipFootnotes",
  readSkipLineNumbers: "read.skipLineNumbers",
  readSkipEquations: "read.skipEquations",
  readSkipHeadings: "read.skipHeadings",

  batchLanes: "performance.batchLanes",
  watchInterval: "performance.watchInterval",
  tableBlocks: "performance.tableBlocks",
  undoKeep: "performance.undoKeep",
} as const;

/**
 * Group order in the panel. Declaration order decides it (see
 * `SettingsStore.groups`), so this array is really just documentation of the
 * order below — but it is exported because the panel's group nav wants it and
 * an explicit list is easier to reorder than a file.
 */
export const GROUPS = ["Appearance", "Explorer", "Previews", "3D viewer", "Camera", "Recorder", "Scanner", "Read aloud", "Performance"] as const;

// ── Appearance ──────────────────────────────────────────────────────────────

/*
 * `--fct-ui-scale` and `--fct-density` have been in base.css since the first
 * commit with nothing to write them: every font size is `calc(N * ui-scale)`
 * and every gap, radius, rail width and bar height is `calc(N * density)`. So
 * these two settings resize the entire shell, and they are two lines of reader.
 */

const uiScale: NumberSetting = {
  kind: "number",
  id: PREF.uiScale,
  group: "Appearance",
  label: "Text size",
  help: "Scales every label, name and menu in the app. Does not touch the files themselves.",
  keywords: ["font", "zoom", "bigger", "smaller", "readable", "accessibility"],
  min: 0.8,
  max: 1.6,
  step: 0.05,
  unit: "×",
  default: 1,
};

const density: NumberSetting = {
  kind: "number",
  id: PREF.density,
  group: "Appearance",
  label: "Spacing",
  help: "Padding, gaps, corner radius and the height of the bars. Below 1 packs more on screen; above 1 is easier to hit with a finger.",
  keywords: ["density", "compact", "comfortable", "padding", "touch", "tight"],
  min: 0.8,
  max: 1.4,
  step: 0.05,
  unit: "×",
  default: 1,
};

const font: TextSetting = {
  kind: "text",
  id: PREF.font,
  group: "Appearance",
  label: "Interface font",
  help: "Any font installed on this machine. Leave blank for the system stack.",
  keywords: ["typeface", "family", "typography"],
  placeholder: "Segoe UI Variable Text",
  default: "",
};

const reduceMotion: ToggleSetting = {
  kind: "toggle",
  id: PREF.reduceMotion,
  group: "Appearance",
  label: "Reduce motion",
  help: "Turns off the panel slides, card transitions and zoom easing. Until you touch this, Windows' own reduced-motion setting decides; changing it here — either way — takes over.",
  keywords: ["animation", "transition", "accessibility", "vestibular"],
  default: false,
};

/*
 * The look, as opposed to the colours.
 *
 * A theme says what colour a panel is. These say whether it is a panel at all —
 * whether it has a fill, an outline, a corner, a glow. They are separate
 * settings rather than one list of presets because the combinations are the
 * point: the same palette drawn as frameless glass and as a square-cornered
 * console are two different applications, and nobody should have to pick a
 * palette they dislike to get the shape they want.
 *
 * All five are read by `applyAppearance()` in main.ts, which writes them onto
 * <html> as attributes and custom properties. skin.css does the rest.
 */

const skin: ChoiceSetting = {
  kind: "choice",
  id: PREF.skin,
  group: "Appearance",
  label: "Interface style",
  help: "Classic is filled panels with outlines. Glass makes them translucent and blurs what is behind. Edge removes the fills entirely, leaving hairlines and space. Neon darkens everything and lets the accent draw the structure.",
  keywords: ["skin", "look", "glass", "blur", "frosted", "neon", "flat", "futuristic", "boxes", "borderless"],
  choices: [
    ["classic", "Classic"],
    ["glass", "Glass"],
    ["edge", "Edge"],
    ["neon", "Neon"],
  ],
  default: "classic",
};

const corners: NumberSetting = {
  kind: "number",
  id: PREF.corners,
  group: "Appearance",
  label: "Corner roundness",
  help: "0 is square, 1 is the standard radius, 2 is as round as the control is tall. Separate from Spacing so a compact layout can still be soft, and a roomy one can still be sharp.",
  keywords: ["radius", "rounded", "square", "sharp", "pill", "shape"],
  min: 0,
  max: 2,
  step: 0.1,
  unit: "×",
  default: 1,
};

const outlines: ChoiceSetting = {
  kind: "choice",
  id: PREF.outlines,
  group: "Appearance",
  label: "Outlines",
  help: "How present the hairlines between regions are. Off removes every divider in the app at once — the keyboard focus ring is the one exception and always stays.",
  keywords: ["border", "divider", "lines", "hairline", "frame", "boxes", "clean"],
  choices: [
    ["full", "Full"],
    ["soft", "Soft"],
    ["none", "Off"],
  ],
  default: "full",
};

const glow: NumberSetting = {
  kind: "number",
  id: PREF.glow,
  group: "Appearance",
  label: "Accent glow",
  help: "How far the accent colour bleeds around whatever is live — the focused field, the pressed button, the selected tab. 0 is off and costs nothing.",
  keywords: ["bloom", "halo", "highlight", "neon", "shine"],
  min: 0,
  max: 1,
  step: 0.05,
  default: 0,
};

const backdrop: ChoiceSetting = {
  kind: "choice",
  id: PREF.backdrop,
  group: "Appearance",
  label: "Backdrop",
  help: "An ambient layer behind the whole app. It sits below everything and cannot be clicked, so it never gets in the way of anything. Pulse breathes slowly; Reduce motion stops it.",
  keywords: ["wallpaper", "background", "grid", "aurora", "ambient", "atmosphere"],
  choices: [
    ["none", "None"],
    ["grid", "Grid"],
    ["aurora", "Aurora"],
    ["pulse", "Pulse"],
  ],
  default: "none",
};

// ── Explorer ────────────────────────────────────────────────────────────────

const view: ChoiceSetting = {
  kind: "choice",
  id: PREF.view,
  group: "Explorer",
  label: "Open folders in",
  help: "Which view a new window starts in. Ctrl+Shift+V still cycles at any time, and a folder you have set a layout on keeps its own.",
  keywords: ["layout", "grid", "canvas", "details", "gallery", "columns"],
  // Generated, not typed out: the modes live in one list and this is one of the
  // four places that used to name them independently.
  choices: modeChoices(),
  default: "list",
};

const sort: ChoiceSetting = {
  kind: "choice",
  id: PREF.sort,
  group: "Explorer",
  label: "Sort by",
  keywords: ["order", "arrange", "column"],
  choices: [
    ["name", "Name"],
    ["size", "Size"],
    ["modified", "Date modified"],
    ["kind", "Kind"],
  ],
  default: "name",
};

/**
 * Grouping is a second axis, not a fifth sort key — a folder grouped by type is
 * still sorted by name inside each type. Its choices are generated from the same
 * list the View menu draws from, for the reason `view` above gives: this used to
 * be the kind of thing that got typed out twice and then disagreed.
 */
const group: ChoiceSetting = {
  kind: "choice",
  id: PREF.group,
  group: "Explorer",
  label: "Group by",
  help: "Splits a folder under headings. A folder you have grouped from the View menu keeps its own.",
  keywords: ["headings", "sections", "arrange", "organise", "organize", "bucket"],
  choices: GROUP_BYS.map((g) => [g.id, g.label] as [string, string]),
  default: "none",
};

const ascending: ToggleSetting = {
  kind: "toggle",
  id: PREF.ascending,
  group: "Explorer",
  label: "Sort ascending",
  help: "Off puts the newest, largest or last-alphabetically first.",
  keywords: ["order", "reverse", "descending"],
  default: true,
};

const foldersFirst: ToggleSetting = {
  kind: "toggle",
  id: PREF.foldersFirst,
  group: "Explorer",
  label: "Keep folders first",
  help: "Off mixes folders in with files under whichever sort is active.",
  keywords: ["directories", "group", "order"],
  default: true,
};

const showHidden: ToggleSetting = {
  kind: "toggle",
  id: PREF.showHidden,
  group: "Explorer",
  label: "Show hidden files",
  help: "Dotfiles, and anything Windows marks hidden or system.",
  keywords: ["dotfiles", "system", "invisible"],
  default: false,
};

const cardSize: NumberSetting = {
  kind: "number",
  id: PREF.cardSize,
  group: "Explorer",
  label: "Card size",
  help: "How wide a file card is before zooming. The height follows the picture.",
  keywords: ["thumbnail", "tile", "grid", "zoom", "big", "small"],
  min: 90,
  max: 420,
  step: 10,
  unit: "px",
  default: 190,
};

const nameLines: NumberSetting = {
  kind: "number",
  id: PREF.nameLines,
  group: "Explorer",
  label: "Lines for a file name",
  // The reason this is a setting at all, kept short enough to read in the panel.
  help: "One line cuts most real names off exactly where they start to differ from each other. The card grows to fit rather than the name shrinking.",
  keywords: ["filename", "wrap", "truncate", "ellipsis", "long"],
  min: 1,
  max: 6,
  step: 1,
  unit: "lines",
  default: 2,
};

const startFolder: TextSetting = {
  kind: "text",
  id: PREF.startFolder,
  group: "Explorer",
  label: "Start in",
  help: "Leave blank to open wherever you were last.",
  keywords: ["home", "default", "launch", "startup", "path"],
  placeholder: "C:/Users/you/Pictures",
  default: "",
};

const restoreSession: ToggleSetting = {
  kind: "toggle",
  id: PREF.restoreSession,
  group: "Explorer",
  label: "Offer to restore the last session",
  help: "After a crash or a forced quit, offer to reopen the folder and the files that were open.",
  keywords: ["crash", "recovery", "reopen", "resume"],
  default: true,
};

/*
 * Item 36. Both are stored as a plain line of ids, and both carry a **Choose…**
 * button that opens the picker — the line is the value and the picker is a nicer
 * way to write it, in the same spirit as item 42 showing the backup JSON rather
 * than hiding it behind a wizard. Anything unrecognised in the line is treated
 * as absent, so a field this build has dropped costs you that column and not the
 * whole list.
 */

const columns: TextSetting = {
  kind: "text",
  id: PREF.columns,
  group: "Explorer",
  label: "Columns in the details list",
  help: "In the order they appear. Name always shows.",
  keywords: ["column", "fields", "details", "list", "show", "size", "date", "kind"],
  placeholder: DEFAULT_COLUMNS,
  default: DEFAULT_COLUMNS,
};

const cardFields: TextSetting = {
  kind: "text",
  id: PREF.cardFields,
  group: "Explorer",
  label: "What a card says under the name",
  help: "Anything a file has no answer for drops out, so one list suits a video and a text file.",
  keywords: ["card", "canvas", "tile", "subtitle", "metadata", "fields"],
  placeholder: DEFAULT_CARD,
  default: DEFAULT_CARD,
};

/*
 * Item 39. Same shape as the two above, for the same reasons — a line of ids
 * over the one command registry, with a **Choose…** button that is a nicer way
 * to write it than a text box. `-` is a dividing line and `File*` is "everything
 * else in that group", which is what keeps the shipped default from hiding a
 * command that ships after it without dragging the entire palette — every theme
 * included — into a right-click. See `@core/explorer/menu`.
 */
const menu: TextSetting = {
  kind: "text",
  id: PREF.menu,
  group: "Explorer",
  label: "Right-click menu",
  help: "Command ids, top to bottom. `-` is a dividing line, `File*` is everything else in that group, and a bare `*` is the whole palette. Anything that does not apply to what you clicked drops out.",
  keywords: ["context", "right click", "menu", "actions", "custom", "program", "open with"],
  placeholder: DEFAULT_MENU,
  default: DEFAULT_MENU,
};

/*
 * Item 37. A folder that has been sorted or filtered remembers it; every other
 * folder uses the settings above. That is the same defaults-plus-diff shape the
 * settings store itself has, one level down — which is why sorting a folder
 * does not rewrite "Sort by" for the whole app.
 *
 * It is a setting because the behaviour is genuinely divisive: to somebody who
 * expects one global order, an explorer that opens Downloads newest-first and
 * Documents by name reads as the app changing its mind on its own.
 */
const rememberFolders: ToggleSetting = {
  kind: "toggle",
  id: PREF.rememberFolders,
  group: "Explorer",
  label: "Remember each folder's sort and filter",
  help: "A folder you have sorted or filtered opens that way next time. Off uses the settings above everywhere.",
  keywords: ["per-folder", "memory", "sort", "filter", "remember", "layout"],
  default: true,
};

// ── Previews ────────────────────────────────────────────────────────────────

const previews: ToggleSetting = {
  kind: "toggle",
  id: PREF.previews,
  group: "Previews",
  label: "Show previews",
  help: "Off falls back to the kind glyph everywhere. Worth trying on a slow network drive.",
  keywords: ["thumbnail", "picture", "cover", "art", "off"],
  default: true,
};

const folderPreviews: ToggleSetting = {
  kind: "toggle",
  id: PREF.folderPreviews,
  group: "Previews",
  label: "Preview folders too",
  help: "A folder shows what is inside it. This costs one extra listing per folder card, which is noticeable over SMB.",
  keywords: ["directory", "tiles", "contents", "network"],
  default: true,
};

const previewLanes: NumberSetting = {
  kind: "number",
  id: PREF.previewLanes,
  group: "Previews",
  label: "Previews at once",
  help: "How many files may be decoded in parallel. Higher fills a folder faster and competes with everything else for the disk.",
  keywords: ["concurrency", "parallel", "speed", "performance", "lanes"],
  min: 1,
  max: 12,
  step: 1,
  default: 4,
};

const previewCache: NumberSetting = {
  kind: "number",
  id: PREF.previewCache,
  group: "Previews",
  label: "Previews kept in memory",
  help: "Beyond this the oldest are dropped and re-made if you scroll back.",
  keywords: ["cache", "memory", "ram", "budget"],
  min: 100,
  max: 5000,
  step: 100,
  unit: "files",
  default: 800,
};

const previewTextLines: NumberSetting = {
  kind: "number",
  id: PREF.previewTextLines,
  group: "Previews",
  label: "Lines on a text preview",
  help: "How much of a script, a log or a config file shows on its card.",
  keywords: ["code", "source", "head", "snippet"],
  min: 4,
  max: 40,
  step: 1,
  unit: "lines",
  default: 14,
};

// ── 3D viewer ───────────────────────────────────────────────────────────────

/*
 * The 3D viewer's side panel writes these back as they are changed, so the next
 * model opens looking the way the last one was left. Only the choices that are
 * about *how someone likes to look at models* are here. The per-model ones —
 * which way is up, the camera angle, which animation clip — belong to one file
 * and would be wrong for the next, so they are deliberately not remembered.
 *
 * The panel's open state is remembered too, but only for a roomy window: in a
 * small pop-out the panel covers the model, so it always starts closed there
 * whatever this says.
 */

const sceneToneMap: ChoiceSetting = {
  kind: "choice",
  id: PREF.sceneToneMap,
  group: "3D viewer",
  label: "Tone mapping",
  help: "How bright highlights are squeezed into what a screen can show. Neutral keeps a model's colours closest to what its author picked; ACES and AgX look more like film; None shows the raw values and clips.",
  keywords: ["3d", "model", "tone", "aces", "agx", "neutral", "hdr", "colour", "color"],
  choices: [
    ["neutral", "Neutral"],
    ["aces", "ACES filmic"],
    ["agx", "AgX"],
    ["none", "None"],
  ],
  default: "neutral",
};

const sceneExposure: NumberSetting = {
  kind: "number",
  id: PREF.sceneExposure,
  group: "3D viewer",
  label: "Exposure",
  help: "Overall brightness of the 3D view, applied before tone mapping.",
  keywords: ["3d", "model", "bright", "dark", "exposure"],
  min: 0.2,
  max: 3,
  step: 0.05,
  unit: "×",
  default: 1,
};

const sceneBackground: ChoiceSetting = {
  kind: "choice",
  id: PREF.sceneBackground,
  group: "3D viewer",
  label: "Background",
  help: "What sits behind a model. Environment shows the soft studio room the lighting comes from.",
  keywords: ["3d", "model", "background", "backdrop", "black", "grey", "gray", "gradient", "studio"],
  choices: [
    ["theme", "Match the theme"],
    ["gradient", "Gradient"],
    ["black", "Black"],
    ["studio", "Studio grey"],
    ["environment", "Environment"],
  ],
  default: "theme",
};

const sceneEnvironment: ToggleSetting = {
  kind: "toggle",
  id: PREF.sceneEnvironment,
  group: "3D viewer",
  label: "Environment lighting",
  help: "Lights models from a soft studio room as well as the lamps, so metal and glossy paint reflect something instead of looking black.",
  keywords: ["3d", "model", "ibl", "environment", "reflection", "pbr", "lighting"],
  default: true,
};

const sceneTurntableSpeed: NumberSetting = {
  kind: "number",
  id: PREF.sceneTurntableSpeed,
  group: "3D viewer",
  label: "Turntable speed",
  help: "How fast a model spins when the turntable is on.",
  keywords: ["3d", "model", "turntable", "spin", "rotate", "orbit"],
  min: 0.5,
  max: 30,
  step: 0.5,
  unit: "rpm",
  default: 4,
};

const scenePanelOpen: ToggleSetting = {
  kind: "toggle",
  id: PREF.scenePanelOpen,
  group: "3D viewer",
  label: "Open the side panel",
  help: "Start the 3D viewer with its controls panel showing. Small windows always start with it closed.",
  keywords: ["3d", "model", "panel", "sidebar", "controls"],
  default: false,
};

// ── Performance ─────────────────────────────────────────────────────────────
//
// The preview budgets above are half of item 43 and live under Previews,
// because that is where someone looking for them will look. What is left is
// the work that happens while you are doing something else: encodes, folder
// sweeps, and the two caches that trade memory for not re-reading a file.

// ── Camera ──────────────────────────────────────────────────────────────────

/*
 * These eight are what the camera surface reads at the moment it opens, and
 * what its own bar writes back to for the session. Two of them deserve a word.
 *
 * The height is what is *asked* for, not what is got: it goes into the
 * constraints as `ideal`, so a camera that cannot do 1080 gives its nearest and
 * the status line reports what actually arrived. Asking with `exact` instead
 * would turn "I would like it sharp" into "fail if you cannot", which is the
 * wrong answer for a setting most people will never open.
 *
 * The folder is a plain text box rather than a picker because the picker lives
 * in the shell and this is the core; an empty value means the folder currently
 * open, which is what someone who never touches this setting will expect.
 */

const cameraFormat: ChoiceSetting = {
  kind: "choice",
  id: PREF.cameraFormat,
  group: "Camera",
  label: "Save photos as",
  help: "JPEG is small and universal. PNG is lossless and several times bigger. WebP is smaller than JPEG at the same quality but fewer other programs read it.",
  keywords: ["camera", "photo", "jpeg", "jpg", "png", "webp", "format"],
  choices: [
    ["jpeg", "JPEG"],
    ["png", "PNG (lossless)"],
    ["webp", "WebP"],
  ],
  default: "jpeg",
};

const cameraQuality: NumberSetting = {
  kind: "number",
  id: PREF.cameraQuality,
  group: "Camera",
  label: "Photo quality",
  help: "For JPEG and WebP. 92 is close to indistinguishable from the original; below about 70 the sky and skin start to band. PNG ignores this — it is lossless either way.",
  keywords: ["camera", "quality", "compression", "jpeg", "webp"],
  min: 40,
  max: 100,
  step: 1,
  unit: "%",
  default: 92,
};

const cameraHeight: ChoiceSetting = {
  kind: "choice",
  id: PREF.cameraHeight,
  group: "Camera",
  label: "Ask the camera for",
  help: "A request, not a demand: the camera gives the nearest size it has and the status line says what that turned out to be.",
  keywords: ["camera", "resolution", "1080", "4k", "size"],
  choices: [
    ["2160", "2160p (4K)"],
    ["1440", "1440p"],
    ["1080", "1080p"],
    ["720", "720p"],
    ["480", "480p"],
  ],
  default: "1080",
};

const cameraMirror: ToggleSetting = {
  kind: "toggle",
  id: PREF.cameraMirror,
  group: "Camera",
  label: "Mirror the picture",
  help: "How a front camera feels natural to frame with. FACET mirrors the saved file too, so what you framed is what you get — turn it off and text in the shot will read the right way round.",
  keywords: ["camera", "mirror", "flip", "selfie", "front"],
  default: false,
};

const cameraGrid: ChoiceSetting = {
  kind: "choice",
  id: PREF.cameraGrid,
  group: "Camera",
  label: "Framing guides",
  help: "Drawn over the preview only — never onto the photo.",
  keywords: ["camera", "grid", "thirds", "golden", "guides", "composition"],
  choices: [
    ["none", "None"],
    ["thirds", "Rule of thirds"],
    ["golden", "Golden ratio"],
    ["square", "Square crop"],
    ["cross", "Centre cross"],
  ],
  default: "none",
};

const cameraAspect: ChoiceSetting = {
  kind: "choice",
  id: PREF.cameraAspect,
  group: "Camera",
  label: "Shape",
  help: "Crops the preview and the file together, so what you framed is what you get. Full uses the whole screen; the named shapes turn with the device, so 4:3 is a tall 3:4 when you hold it upright.",
  keywords: ["camera", "aspect", "ratio", "shape", "square", "crop", "4:3", "16:9"],
  choices: [
    ["full", "Full"],
    ["4:3", "4:3"],
    ["1:1", "Square"],
    ["16:9", "16:9"],
  ],
  default: "full",
};

const cameraCountdown: ChoiceSetting = {
  kind: "choice",
  id: PREF.cameraCountdown,
  group: "Camera",
  label: "Self-timer",
  help: "Counts down on screen after the shutter. Pressing the shutter again during the count cancels it.",
  keywords: ["camera", "timer", "countdown", "delay", "selfie"],
  choices: [
    ["0", "Off"],
    ["3", "3 seconds"],
    ["5", "5 seconds"],
    ["10", "10 seconds"],
  ],
  default: "0",
};

const cameraSound: ToggleSetting = {
  kind: "toggle",
  id: PREF.cameraSound,
  group: "Camera",
  label: "Record sound with clips",
  help: "Off means the microphone is never opened at all, not that the sound is dropped afterwards — nothing is listening.",
  keywords: ["camera", "sound", "audio", "microphone", "mic", "video"],
  default: true,
};

const cameraFolder: TextSetting = {
  kind: "text",
  id: PREF.cameraFolder,
  group: "Camera",
  label: "Save captures to",
  help: "Leave empty to save into whichever folder is open. Photos are never overwritten — a second one in the same second becomes “(2)”.",
  keywords: ["camera", "folder", "save", "photos", "destination"],
  placeholder: "The folder that is open",
  default: "",
};

/*
 * Recorder (item 29).
 *
 * These are the *starting* state of the three switches, not a lock: the panel
 * has all three on it and changing one there changes it for that take. What is
 * stored is what the panel opens on, which for most people is the same
 * arrangement every time — a meeting is screen plus both sounds, a voice note
 * is the microphone alone.
 *
 * There is deliberately no "remember which microphone". Device ids are not
 * stable across a reboot or a re-plug on Windows, so a stored one is a value
 * that silently stops matching anything, and the failure it produces — the
 * recorder opening the wrong microphone, or none — is exactly the failure
 * nobody notices until they play the file back. The picker lists what is
 * actually there, every time.
 */

const recScreen: ToggleSetting = {
  kind: "toggle",
  id: PREF.recScreen,
  group: "Recorder",
  label: "Record the screen",
  help: "Off makes it a sound recorder — no picture is captured and no screen picker appears.",
  keywords: ["recorder", "screen", "capture", "video", "screencast", "record"],
  default: true,
};

const recSystem: ToggleSetting = {
  kind: "toggle",
  id: PREF.recSystem,
  group: "Recorder",
  label: "Record what the machine is playing",
  help: "The other side of a call, the video you are narrating over. Windows can share a screen's or a tab's sound; macOS only a tab's, and the recorder says so rather than recording silence.",
  keywords: ["recorder", "system", "sound", "audio", "speakers", "desktop", "loopback"],
  default: true,
};

const recMic: ToggleSetting = {
  kind: "toggle",
  id: PREF.recMic,
  group: "Recorder",
  label: "Record the microphone",
  help: "With the setting above on, the two are summed into one track before recording — a recording cannot carry two separate sound tracks, and handing it two loses one.",
  keywords: ["recorder", "microphone", "mic", "voice", "audio"],
  default: true,
};

const recQuality: ChoiceSetting = {
  kind: "choice",
  id: PREF.recQuality,
  group: "Recorder",
  label: "Quality",
  help: "Scales with the size of what is being captured, because a screen recording is judged on whether the text in it can still be read. Sound is Opus either way and barely differs.",
  keywords: ["recorder", "quality", "bitrate", "size", "compression"],
  choices: [
    ["high", "High — keep screen text sharp"],
    ["balanced", "Balanced"],
    ["small", "Small — long recordings"],
  ],
  default: "balanced",
};

const recCountdown: ChoiceSetting = {
  kind: "choice",
  id: PREF.recCountdown,
  group: "Recorder",
  label: "Wait before starting",
  help: "Time to get to the window you meant to record. The countdown runs after the screen picker, not before, so it is not spent staring at a dialog.",
  keywords: ["recorder", "countdown", "delay", "timer", "wait"],
  choices: [
    ["0", "Start immediately"],
    ["3", "3 seconds"],
    ["5", "5 seconds"],
    ["10", "10 seconds"],
  ],
  default: "3",
};

const recFolder: TextSetting = {
  kind: "text",
  id: PREF.recFolder,
  group: "Recorder",
  label: "Save recordings to",
  help: "Leave empty to save into whichever folder is open. A recording is written while it is being made, so this is read once at the start of a take and not again.",
  keywords: ["recorder", "folder", "save", "destination", "recordings"],
  placeholder: "The folder that is open",
  default: "",
};

/*
 * Scanner.
 *
 * Only the three answers that are the same every time. Everything else about a
 * scan -- where the corners are, which way up the page is -- is a property of
 * that page and belongs on the page, not in a preferences panel.
 */

const scanLook: ChoiceSetting = {
  kind: "choice",
  id: PREF.scanLook,
  group: "Scanner",
  label: "How a scanned page looks",
  help: "Colour whitens the paper and keeps the ink's colour, so a signature stays blue. Black & white is the smallest and the least forgiving.",
  keywords: ["scan", "scanner", "document", "look", "whiten", "mono", "threshold"],
  choices: [
    ["photo", "Photo — leave it alone"],
    ["colour", "Colour"],
    ["grey", "Greyscale"],
    ["mono", "Black & white"],
  ],
  default: "colour",
};

const scanSearchable: ToggleSetting = {
  kind: "toggle",
  id: PREF.scanSearchable,
  group: "Scanner",
  label: "Make scanned PDFs searchable",
  help: "Reads the text and puts it invisibly under the picture, so you can search the PDF. Slower, and the first scan downloads a language model.",
  keywords: ["scan", "ocr", "searchable", "pdf", "text", "read"],
  default: false,
};

const scanFolder: TextSetting = {
  kind: "text",
  id: PREF.scanFolder,
  group: "Scanner",
  label: "Save scans to",
  help: "Leave empty to save into whichever folder is open. Scans are never overwritten.",
  keywords: ["scan", "folder", "save", "pdf", "destination"],
  placeholder: "The folder that is open",
  default: "",
};

// ── Read aloud ──────────────────────────────────────────────────────

/*
 * The voice, the speed and what gets skipped are settings rather than panel
 * state because they are the same on every document. Someone who reads at
 * 1.6× reads everything at 1.6×, and re-choosing it on each paper is the kind
 * of small friction that stops a feature being used at all.
 *
 * The skip switches are the exception worth explaining: they are defaults, and
 * the reader lets them be overridden for the document in front of you without
 * writing that back here. A paper whose captions you do want read should not
 * change what happens on the next one.
 */

const readEngine: ChoiceSetting = {
  kind: "choice",
  id: PREF.readEngine,
  group: "Read aloud",
  label: "Voice engine",
  help: "The system voices are already on this machine and speak instantly. The natural voices sound far better and need a one-off download of about 88 MB, which you are asked about before it happens.",
  keywords: ["tts", "speech", "kokoro", "narration", "speak"],
  choices: [
    ["system", "System voices"],
    ["kokoro", "Natural voices (downloaded)"],
  ],
  default: "system",
};

const readVoice: TextSetting = {
  kind: "text",
  id: PREF.readVoice,
  group: "Read aloud",
  label: "Natural voice",
  help: "Which of the natural voices to read in. Picked from the list in the reader rather than typed here.",
  keywords: ["voice", "kokoro", "accent", "speaker"],
  placeholder: "af_heart",
  default: "af_heart",
};

const readSystemVoice: TextSetting = {
  kind: "text",
  id: PREF.readSystemVoice,
  group: "Read aloud",
  label: "System voice",
  help: "Which of this machine own voices to read in. The list differs between Windows and Android, so an empty value means whichever one the system treats as default.",
  keywords: ["voice", "system", "windows", "android", "speaker"],
  placeholder: "The system default",
  default: "",
};

const readLang: TextSetting = {
  kind: "text",
  id: PREF.readLang,
  group: "Read aloud",
  label: "Voice language",
  help: "Which language's voices the reader offers. A phone's speech engine lists a few hundred voices across about a hundred languages, and scrolling past ninety-nine of them to reach your own is not a choice, it is an obstacle. Empty means this device's own language.",
  keywords: ["language", "locale", "english", "filter", "voice"],
  placeholder: "This device's language",
  default: "",
};

const readOnline: ToggleSetting = {
  kind: "toggle",
  id: PREF.readOnline,
  group: "Read aloud",
  label: "Offer voices that need the internet",
  help: "Off. Most of the voices a phone advertises are not on the phone: they send the sentence to a server and play back the reply. A document read aloud would then be a document uploaded, which is not what this app is for. Turn this on only if you want those voices in the list.",
  keywords: ["network", "online", "cloud", "offline", "privacy", "voice"],
  default: false,
};

const readSpeed: NumberSetting = {
  kind: "number",
  id: PREF.readSpeed,
  group: "Read aloud",
  label: "Speed",
  help: "How fast to read. The natural voices are generated at this speed rather than played faster, so raising it does not raise the pitch. Anything from a quarter speed to five times is allowed, and the reader takes a typed value as readily as the slider -- past about three the system voices start slurring, but that is the engine's limit to find rather than the reader's to impose.",
  keywords: ["rate", "fast", "slow", "wpm", "tempo"],
  min: 0.25,
  max: 5,
  step: 0.05,
  unit: "\u00d7",
  default: 1,
};

const readPitch: NumberSetting = {
  kind: "number",
  id: PREF.readPitch,
  group: "Read aloud",
  label: "Pitch",
  help: "Only the system voices take a pitch directly. On the natural voices it shifts the speed with it, so it is best left alone there.",
  keywords: ["tone", "higher", "lower", "voice"],
  min: 0.5,
  max: 2,
  step: 0.05,
  unit: "\u00d7",
  default: 1,
};

const readVolume: NumberSetting = {
  kind: "number",
  id: PREF.readVolume,
  group: "Read aloud",
  label: "Volume",
  help: "Relative to the system volume, which still has the last word.",
  keywords: ["loud", "quiet", "sound"],
  min: 0,
  max: 1,
  step: 0.05,
  default: 1,
};

const readOnPage: ChoiceSetting = {
  kind: "choice",
  id: PREF.readOnPage,
  group: "Read aloud",
  label: "Follow along on",
  help: "The page shows the document exactly as it looks -- the real figures, columns and equations -- with the spoken sentence lit up on it. The rebuilt text is one plain column, which is easier on a phone and is the only option for a file that has no pages, such as a text or web file.",
  keywords: ["page", "layout", "original", "pdf", "scan", "text", "reflow"],
  choices: [
    ["page", "The page itself, where there is one"],
    ["text", "The rebuilt text"],
  ],
  default: "page",
};

const readHighlight: ChoiceSetting = {
  kind: "choice",
  id: PREF.readHighlight,
  group: "Read aloud",
  label: "Highlight",
  help: "What to mark as it is spoken. Word-level highlighting is estimated on the natural voices rather than reported, so it can drift slightly on a long sentence.",
  keywords: ["follow", "karaoke", "mark", "colour"],
  choices: [
    ["both", "Sentence and word"],
    ["sentence", "Sentence only"],
    ["word", "Word only"],
    ["none", "Nothing"],
  ],
  default: "both",
};

const readFollow: ToggleSetting = {
  kind: "toggle",
  id: PREF.readFollow,
  group: "Read aloud",
  label: "Scroll to keep up",
  help: "Keeps the sentence being spoken on screen. Suspended while you are scrolling by hand, and resumed when you stop.",
  keywords: ["autoscroll", "follow", "scroll"],
  default: true,
};

const readRepeat: ToggleSetting = {
  kind: "toggle",
  id: PREF.readRepeat,
  group: "Read aloud",
  label: "Start again at the end",
  help: "Goes back to the top instead of stopping.",
  keywords: ["repeat", "loop", "again"],
  default: false,
};

const readAwake: ToggleSetting = {
  kind: "toggle",
  id: PREF.readAwake,
  group: "Read aloud",
  label: "Keep reading with the screen off",
  help: "On a phone, keeps playing when the screen locks and puts the controls on the lock screen. Costs a little more battery.",
  keywords: ["background", "lock", "screen", "phone", "battery"],
  default: true,
};

const readSkipHeaders: ToggleSetting = {
  kind: "toggle",
  id: PREF.readSkipHeaders,
  group: "Read aloud",
  label: "Skip running heads and footers",
  help: "The title repeated at the top of every page, the journal name along the bottom. Found by repetition across pages, so a heading that appears once is never mistaken for one.",
  keywords: ["header", "footer", "running", "repeat", "paper"],
  default: true,
};

const readSkipPageNumbers: ToggleSetting = {
  kind: "toggle",
  id: PREF.readSkipPageNumbers,
  group: "Read aloud",
  label: "Skip page numbers",
  help: "A bare number in the margin, top or bottom.",
  keywords: ["page", "number", "folio"],
  default: true,
};

const readSkipCaptions: ToggleSetting = {
  kind: "toggle",
  id: PREF.readSkipCaptions,
  group: "Read aloud",
  label: "Skip figure and table captions",
  help: "Off by default: a caption often carries the finding, and hearing it read is usually what was wanted.",
  keywords: ["figure", "table", "caption", "chart"],
  default: false,
};

const readSkipReferences: ToggleSetting = {
  kind: "toggle",
  id: PREF.readSkipReferences,
  group: "Read aloud",
  label: "Skip the reference list",
  help: "Everything after the References or Bibliography heading, up to any appendix. Forty minutes of author names and years is rarely what anyone wanted.",
  keywords: ["bibliography", "citation", "works cited", "references"],
  default: true,
};

const readSkipFootnotes: ToggleSetting = {
  kind: "toggle",
  id: PREF.readSkipFootnotes,
  group: "Read aloud",
  label: "Skip footnotes",
  help: "Off by default. A footnote in the middle of an argument is sometimes the argument.",
  keywords: ["footnote", "endnote", "note"],
  default: false,
};

const readSkipLineNumbers: ToggleSetting = {
  kind: "toggle",
  id: PREF.readSkipLineNumbers,
  group: "Read aloud",
  label: "Skip line numbers",
  help: "The column of numbers down the margin of a manuscript under review.",
  keywords: ["line", "number", "margin", "manuscript", "preprint"],
  default: true,
};

const readSkipEquations: ToggleSetting = {
  kind: "toggle",
  id: PREF.readSkipEquations,
  group: "Read aloud",
  label: "Say \u201cequation\u201d rather than reading the symbols",
  help: "A displayed formula read character by character is noise. This replaces it with the single word, so you still know one was there.",
  keywords: ["equation", "formula", "maths", "math", "symbols"],
  default: true,
};

const readSkipHeadings: ToggleSetting = {
  kind: "toggle",
  id: PREF.readSkipHeadings,
  group: "Read aloud",
  label: "Skip section headings",
  help: "Off by default: headings are how you keep your place in a long paper by ear.",
  keywords: ["heading", "section", "title"],
  default: false,
};

const batchLanes: NumberSetting = {
  kind: "number",
  id: PREF.batchLanes,
  group: "Performance",
  label: "Encodes at once",
  help: "One is usually fastest: ffmpeg already uses every core, so four at a time finish later than four in a row and make every progress bar meaningless. Raise it if your queue is mostly waiting on a slow disk. Lowering it never cancels anything already running.",
  keywords: ["batch", "queue", "parallel", "concurrency", "ffmpeg", "lanes"],
  min: 1,
  max: 8,
  step: 1,
  default: 1,
};

const watchInterval: NumberSetting = {
  kind: "number",
  id: PREF.watchInterval,
  group: "Performance",
  label: "Check watched folders every",
  help: "A file has to look the same size across two checks before a rule fires, so this is also how long a finished copy waits before anything happens to it.",
  keywords: ["watch", "poll", "sweep", "folder", "rules", "network"],
  min: 2,
  max: 120,
  step: 1,
  unit: "sec",
  default: 4,
};

const tableBlocks: NumberSetting = {
  kind: "number",
  id: PREF.tableBlocks,
  group: "Performance",
  label: "Table blocks kept in memory",
  help: "Rows already fetched from a big CSV or Parquet file. More means scrolling back is instant; fewer means a 4 GB table costs less to browse.",
  keywords: ["csv", "parquet", "spreadsheet", "cache", "rows", "memory"],
  min: 20,
  max: 2000,
  step: 20,
  default: 200,
};

const undoKeep: NumberSetting = {
  kind: "number",
  id: PREF.undoKeep,
  group: "Performance",
  label: "Files with a saved edit history",
  help: "Undo survives a restart for this many recently edited files; beyond it the oldest are forgotten. It never affects the files themselves.",
  keywords: ["undo", "history", "recovery", "restart", "edits"],
  min: 5,
  max: 300,
  step: 5,
  unit: "files",
  default: 40,
};

/** Everything above, in panel order. */
export const ALL_SETTINGS = [
  skin,
  outlines,
  corners,
  glow,
  backdrop,
  uiScale,
  density,
  font,
  reduceMotion,
  view,
  sort,
  group,
  ascending,
  foldersFirst,
  showHidden,
  cardSize,
  nameLines,
  startFolder,
  restoreSession,
  columns,
  cardFields,
  menu,
  rememberFolders,
  previews,
  folderPreviews,
  previewLanes,
  previewCache,
  previewTextLines,
  sceneToneMap,
  sceneExposure,
  sceneBackground,
  sceneEnvironment,
  sceneTurntableSpeed,
  scenePanelOpen,
  cameraFormat,
  cameraQuality,
  cameraHeight,
  cameraMirror,
  cameraGrid,
  cameraAspect,
  cameraCountdown,
  cameraSound,
  cameraFolder,
  recScreen,
  recSystem,
  recMic,
  recQuality,
  recCountdown,
  recFolder,
  scanLook,
  scanSearchable,
  scanFolder,
  readEngine,
  readVoice,
  readSystemVoice,
  readLang,
  readOnline,
  readSpeed,
  readPitch,
  readVolume,
  readHighlight,
  readOnPage,
  readFollow,
  readRepeat,
  readAwake,
  readSkipHeaders,
  readSkipPageNumbers,
  readSkipCaptions,
  readSkipReferences,
  readSkipFootnotes,
  readSkipLineNumbers,
  readSkipEquations,
  readSkipHeadings,
  batchLanes,
  watchInterval,
  tableBlocks,
  undoKeep,
];

settings.register(...ALL_SETTINGS);
