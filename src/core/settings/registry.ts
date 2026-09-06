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

  cameraFormat: "camera.format",
  cameraQuality: "camera.quality",
  cameraHeight: "camera.height",
  cameraMirror: "camera.mirror",
  cameraGrid: "camera.grid",
  cameraCountdown: "camera.countdown",
  cameraSound: "camera.sound",
  cameraFolder: "camera.folder",

  recScreen: "recorder.screen",
  recSystem: "recorder.system",
  recMic: "recorder.mic",
  recQuality: "recorder.quality",
  recCountdown: "recorder.countdown",
  recFolder: "recorder.folder",

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
export const GROUPS = ["Appearance", "Explorer", "Previews", "Camera", "Recorder", "Performance"] as const;

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
  cameraFormat,
  cameraQuality,
  cameraHeight,
  cameraMirror,
  cameraGrid,
  cameraCountdown,
  cameraSound,
  cameraFolder,
  recScreen,
  recSystem,
  recMic,
  recQuality,
  recCountdown,
  recFolder,
  batchLanes,
  watchInterval,
  tableBlocks,
  undoKeep,
];

settings.register(...ALL_SETTINGS);
