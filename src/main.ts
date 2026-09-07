/**
 * Facet — entry point.
 *
 * Wires the three foundations together: theme engine, explorer shell, spatial
 * canvas. Every later module (blur, video, audio, 3D, convert, capture …)
 * mounts into #stage and inherits all three for free.
 */

import "./styles/base.css";
import "./styles/canvas.css";
import "./styles/columns.css";
import "./styles/gallery.css";
import "./styles/list.css";
import "./styles/viewer.css";
import "./styles/media.css";
import "./styles/shell.css";
import "./styles/vedit.css";
import "./styles/aedit.css";
import "./styles/batch.css";
import "./styles/watch.css";
import "./styles/tree.css";
import "./styles/settings.css";
import "./styles/keys.css";
import "./styles/fields.css";
import "./styles/filter.css";
import "./styles/places.css";
import "./styles/menu.css";
import "./styles/dnd.css";
import "./styles/opens.css";
import "./styles/scene.css";
import "./styles/scene-edit.css";
import "./styles/camera.css";
import "./styles/recorder.css";
import "./styles/transcribe.css";
import "./styles/subtitles.css";
import "./styles/ocr.css";
import "./styles/phone.css";
import "./styles/phone-panels.css";
import "./styles/phone-viewer.css";
import "./styles/phone-prefs.css";
import "./styles/phone-editor.css";
import "./styles/sign.css";
import "./styles/sign-view.css";

import { themes } from "@core/theme/theme-engine";
import { MockFs } from "@core/explorer/mock-fs";
import { IS_NATIVE, TauriFs, probeMediaTools, type PhoneFs } from "@core/explorer/tauri-fs";
import { isPhone } from "@core/phone/env";
import { mark, markVia } from "@core/phone/mark";
import { PhoneShell } from "./ui/phone/shell";
import { fitPanels } from "./ui/phone/panel-fit";
import { AndroidFs, IS_ANDROID } from "@core/explorer/android-fs";
import {
  extOf,
  kindForExt,
  sortEntries,
  type FileEntry,
  type FileKind,
  type FsAdapter,
  type Place,
  type SortKey,
  type ViewConfig,
} from "@core/explorer/types";
import {
  MODES, modeGlyph, modeLabel, nextMode, parseMode, type ViewMode,
} from "@core/explorer/modes";
import { GROUPS, groupedOrder, parseGroup, type GroupKey } from "@core/explorer/grouping";
import { PreviewService } from "@core/explorer/preview";
import { apply as applyFilter, describe, parse as parseFilter, NO_FILTER, type Query } from "@core/explorer/filter";
import { RulesStore, MIN_CARD, MAX_CARD, type FolderRule } from "@core/explorer/rules";
import { PlacesStore, nameFor } from "@core/explorer/places";
import {
  ActionsStore, appliesTo, buildArgs, commandIdFor, type UserAction,
} from "@core/explorer/actions";
import {
  HANDLERS, handlerLabel, OpensStore, resolveOpen, type HandlerId,
} from "@core/explorer/opens";
// Importing the registry is what declares the settings; everything below reads
// them through `PREF` rather than through a string.
import { PREF } from "@core/settings/registry";
import { settings } from "@core/settings/store";
import "@core/keys/commands";
import { KEY_ID } from "@core/keys/ids";
import { keys } from "@core/keys/map";
import { browserPresets, type GridKind, type PhotoFormat } from "@core/capture/camera";
import { type Quality } from "@core/capture/recorder";
import { BatchQueue } from "@core/batch/queue";
import { registerRunners } from "@core/batch/runners";
import { autoBlurStore } from "@core/phone/autoblur-prefs";
import { WatchService } from "@core/watch/watcher";
import { all as savedEdits } from "@core/undo/store";
import {
  arm, begin, recall, remember,
  type OpenSurface, type SessionState,
} from "@core/undo/session";
import { BatchPanel } from "@ui/batch";
import { WatchPanel } from "@ui/watch";
import { CanvasView } from "@ui/canvas-view";
import { ColumnsView } from "@ui/columns-view";
import { GalleryView } from "@ui/gallery-view";
import { ListView } from "@ui/list-view";
import { MediaPlayer } from "@ui/media";
import { Inspector } from "@ui/inspector";
import { MetaPanel } from "@ui/metadata";
import { Palette, type Command } from "@ui/palette";
import { QuickLook, type QuickAction } from "@ui/quicklook";
import { SceneView } from "@ui/scene-view";
import { CameraView } from "@ui/camera-view";
import { RecorderView } from "@ui/recorder-view";
import { TranscribeView } from "@ui/transcribe-view";
import { SubtitleView, SUBTITLE_EXTS } from "@ui/subtitle-view";
import { OcrView, OCR_EXTS } from "@ui/ocr-view";
import { SignView, SIGN_EXTS } from "@ui/sign-view";
import { TableView } from "@ui/table";
import { VideoEditor, type JobDone, type JobProgress, type Media } from "@ui/vedit";
import { AudioEditor } from "@ui/aedit";
import { Viewer } from "@ui/viewer";
import { TreePanel, same } from "@ui/tree";
import { SettingsPanel } from "@ui/settings";
import { FieldsPanel } from "@ui/fields-panel";
import { PlacesPanel } from "@ui/places-panel";
import { ContextMenu } from "@ui/menu";
import { ViewMenu, type ViewMenuSection } from "@ui/view-menu";
import { acceptDrops, endDrag, useOsDrag, type DropEffect } from "@ui/dnd";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { MenuPanel } from "@ui/menu-panel";
import { OpensPanel } from "@ui/opens-panel";
import { FilterBar } from "@ui/filter-bar";
import { KeysPanel } from "@ui/keys";

/**
 * Real files natively, the mock in a plain browser tab.
 *
 * The mock is not dead weight — `npm run dev` in a browser is still the fastest
 * way to iterate on layout, and it must not blank out just because there is no
 * Rust process behind it.
 */
const native = IS_ANDROID ? new AndroidFs() : (IS_NATIVE ? new TauriFs() : null);
// Route timing marks through the native side, which is the only path that
// reaches `logcat` in a packaged build.
if (native) markVia((what) => { native.mark(what); });
// Does this build actually carry runnable ffmpeg binaries? Fire and forget:
// the answer lands well before anyone reaches an editor strip, and every reader
// of it treats "not yet known" the same as "no".
void probeMediaTools();
mark("module loaded");
const mock = new MockFs();
const fs: FsAdapter = native ?? mock;
// The same object, seen through the wider interface the phone needs. Both
// halves satisfy it, so the phone shell runs against either one.
const phoneFs: PhoneFs = native ?? mock;

/*
 * Item 9: dragging files out of FACET, into a browser, into Explorer, into a
 * chat window.
 *
 * Desktop only. Android has nowhere to drag *to* — an app owns its screen —
 * and a plain browser tab has no files to hand over. On both, nothing is
 * installed here and the views keep their ordinary HTML5 drag, which is what
 * makes dropping onto a folder inside FACET still work there.
 *
 * `mode: "copy"`, always, and deliberately. A "move" is carried out by whatever
 * program receives the drop, on its own terms, and a file removed that way
 * never passes through the Recycle Bin. So a drop into another application
 * hands it a copy and leaves the original exactly where the user left it.
 * Moving files *within* FACET is a different path entirely — `dropInto` below,
 * which renames and never deletes.
 *
 * The icon is fetched once and remembered. It is a file the backend writes to
 * the temp directory on demand, because the drag API wants a path and FACET's
 * icons live inside the executable.
 */
if (native !== null && !IS_ANDROID) {
  const desktop = native;
  let icon: Promise<string> | null = null;
  useOsDrag((paths) => {
    const ready = icon ?? (icon = desktop.dragIcon());
    void ready
      .then((path) =>
        // The callback is the only end-of-drag signal there is: `dragend` never
        // fires, because the HTML5 drag was cancelled to make room for this one.
        startDrag({ item: [...paths], icon: path, mode: "copy" }, () => endDrag()),
      )
      .catch(() => {
        icon = null;
        endDrag();
      });
  });
}

/**
 * The live view configuration.
 *
 * Seeded from the settings store rather than from literals, and written back
 * through it — see `applyPref`. Two copies of "should folders come first" would
 * be one copy too many: the palette command, the column header and the settings
 * panel all change the same thing, and only one of them can be the source of
 * truth. It is the store.
 */
const view: ViewConfig = {
  sort: settings.get<SortKey>(PREF.sort),
  ascending: settings.get<boolean>(PREF.ascending),
  group: parseGroup(settings.get<string>(PREF.group)),
  foldersFirst: settings.get<boolean>(PREF.foldersFirst),
  showHidden: settings.get<boolean>(PREF.showHidden),
  cardSize: settings.get<number>(PREF.cardSize),
  nameLines: settings.get<number>(PREF.nameLines),
  columns: settings.get<string>(PREF.columns),
  cardFields: settings.get<string>(PREF.cardFields),
};

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing shell node #${id}`);
  return node as T;
};

const rail = el("rail");
const topbar = el("topbar");
const stage = el("stage");
const status = el("status");

/**
 * What the disk reported, and what the sidebar shows after your edits (item 38).
 *
 * Two variables rather than one because `PlacesStore` is a diff: it needs the
 * raw discovery every time it resolves, and throwing that away would mean a
 * hidden place could never be listed as hidden — there would be nothing left to
 * name it. `discovered` is what the machine says; `places` is what you see.
 */
let discovered: Place[] = [];
let places: Place[] = [];
// A placeholder until boot() reads the platform's real home off `discovered`;
// never a real path baked into the source.
let cwd = /windows/i.test(navigator.userAgent) ? "C:/" : "/";
/**
 * The folder as it came off the disk, minus hidden files.
 *
 * Kept apart from `entries` because a filter has to be undoable without a
 * listing: typing into the box and deleting it again must show the folder back,
 * and a shell that filtered `entries` in place would have to re-read the disk
 * for every backspace.
 */
let listed: FileEntry[] = [];
/** What is on screen: `listed`, filtered, then sorted. */
let entries: FileEntry[] = [];
let selection: FileEntry[] = [];
const history: string[] = [];

/** Per-folder sort and filter memory, plus filters saved under a name (item 37). */
const rules = new RulesStore();
/** Your pins, hides, renames and order over what the disk reports (item 38). */
const userPlaces = new PlacesStore();
/** Programs you wired into the menu yourself (item 39). */
const userActions = new ActionsStore();
/** What opens what, where you have said something other than the default (item 40). */
const userOpens = new OpensStore();
/** The filter line in force for this folder. "" is the usual case. */
let filterText = "";
let query: Query = NO_FILTER;

// ── Surfaces ──────────────────────────────────────────────────────────────
//
// Every surface is built against the adapter rather than against Tauri
// directly, so the same viewer, player and quick-look run on Android the day
// the Kotlin adapter lands.

const fileUrl = (path: string): Promise<string> =>
  native ? native.fileUrl(path) : Promise.resolve(path);
const openExternal = (path: string): Promise<void> =>
  native ? native.openExternal(path) : Promise.resolve();

const viewer = new Viewer({
  fileUrl,
  writeFile: (path, bytes, overwrite) =>
    native
      ? native.writeFile(path, bytes, overwrite)
      : Promise.reject(new Error("saving needs the desktop app")),
  openExternal,
  // The Sign category on the editor's bar. `signView` is declared further down
  // in this file and this only runs on a click, by which time it exists.
  sign: (path, mode) => void signView.open(path, mode),
});

const player = new MediaPlayer({ fileUrl, openExternal });

/**
 * The 3D viewer (item 13). Built here and not lazily, because it holds the
 * app's single WebGL context — see the header of `@ui/scene-view` for why there
 * is exactly one of those and not one per file opened.
 */
const scene = new SceneView({
  fileUrl,
  openExternal,
  writeFile: (path, bytes, overwrite) =>
    native
      ? native.writeFile(path, bytes, overwrite)
      : Promise.reject(new Error("saving needs the desktop app")),
});

/**
 * The camera (item 28).
 *
 * `navigator.mediaDevices` is handed over rather than reached for, so the same
 * surface can be driven by a canvas in the test harness — a camera nobody can
 * test without a webcam plugged in is a camera that gets tested once.
 *
 * The device layer is standard web API in both builds: Tauri's webview is a
 * real browser and gets the real webcam, so unlike the video editor there is
 * nothing here to stub out in a plain tab. Only *saving* needs the desktop app,
 * for the same reason everything else does.
 */
const camera = new CameraView({
  source: {
    /*
     * `navigator.mediaDevices` is only defined in a secure context, and it is
     * absent rather than failing — so without this guard the first thing a user
     * with a misconfigured build sees is "Cannot read properties of undefined",
     * which names nothing they can do anything about. Both real builds qualify
     * (Chromium counts `tauri.localhost` and `127.0.0.1` as secure), so this is
     * the message nobody should ever see; it exists because the alternative is
     * a bug report with a stack trace in it.
     */
    devices: () =>
      navigator.mediaDevices?.enumerateDevices() ?? Promise.resolve([]),
    open: (c) =>
      navigator.mediaDevices
        ? navigator.mediaDevices.getUserMedia(c)
        : Promise.reject(new Error("this build cannot reach the camera — it is not running in a secure context")),
    onChange: (cb) => {
      navigator.mediaDevices?.addEventListener("devicechange", cb);
      return () => navigator.mediaDevices?.removeEventListener("devicechange", cb);
    },
  },
  // Read at the moment of saving, never cached: the preference wins if it is
  // set, and otherwise a capture lands in whatever folder you are looking at,
  // which is what someone who never opened the settings will expect.
  folder: () => settings.get<string>(PREF.cameraFolder).trim() || cwd,
  writeFile: (path, bytes, overwrite) =>
    native
      ? native.writeFile(path, bytes, overwrite)
      : Promise.reject(new Error("saving needs the desktop app")),
  refresh: () => void navigate(cwd, false),
  presets: browserPresets(),
  prefs: () => ({
    format: settings.get<string>(PREF.cameraFormat) as PhotoFormat,
    // Stored as a percentage because that is how people talk about JPEG
    // quality; `toBlob` wants 0–1.
    quality: settings.get<number>(PREF.cameraQuality) / 100,
    height: Number(settings.get<string>(PREF.cameraHeight)),
    mirror: settings.get<boolean>(PREF.cameraMirror),
    grid: settings.get<string>(PREF.cameraGrid) as GridKind,
    countdown: Number(settings.get<string>(PREF.cameraCountdown)),
    sound: settings.get<boolean>(PREF.cameraSound),
  }),
});

/**
 * The recorder (item 29).
 *
 * `appendFile` is handed over only on the desktop, and that is not a detail:
 * with it, a take is written to disk every few seconds and a crash costs the
 * last three; without it the whole recording sits in the webview until stop.
 * The surface reads which of the two it got and *says so on screen for the
 * whole recording*, because they are different promises about what a crash
 * costs and only one of them should read as safe.
 */
const recorder = new RecorderView({
  source: {
    display: (o) =>
      navigator.mediaDevices?.getDisplayMedia
        ? navigator.mediaDevices.getDisplayMedia(o)
        : Promise.reject(new Error("this build cannot capture the screen — it is not running in a secure context")),
    user: (c) =>
      navigator.mediaDevices
        ? navigator.mediaDevices.getUserMedia(c)
        : Promise.reject(new Error("this build cannot reach the microphone — it is not running in a secure context")),
    devices: () => navigator.mediaDevices?.enumerateDevices() ?? Promise.resolve([]),
    audioContext: () => new AudioContext(),
  },
  // Read once when a take starts, unlike the camera's: a recording that is
  // already being written cannot change where it is going halfway through.
  folder: () => settings.get<string>(PREF.recFolder).trim() || cwd,
  writeFile: (path, bytes, overwrite) =>
    native
      ? native.writeFile(path, bytes, overwrite)
      : Promise.reject(new Error("saving needs the desktop app")),
  ...(native ? { appendFile: (path: string, bytes: Uint8Array) => native.appendFile(path, bytes) } : {}),
  refresh: () => void navigate(cwd, false),
  platform: () => navigator.platform || navigator.userAgent,
  prefs: () => ({
    screen: settings.get<boolean>(PREF.recScreen),
    system: settings.get<boolean>(PREF.recSystem),
    mic: settings.get<boolean>(PREF.recMic),
    quality: settings.get<string>(PREF.recQuality) as Quality,
    countdown: Number(settings.get<string>(PREF.recCountdown)),
  }),
});

/**
 * Transcription (item 30).
 *
 * The one surface here that works fully in a plain browser tab as well as in
 * the desktop app: the models run in the WebView either way, and only *saving*
 * the transcript needs the native side. Nothing is uploaded — the audio is
 * decoded and listened to on this machine, which is the whole reason it is a
 * panel in a file explorer rather than a web service.
 */
const scribe = new TranscribeView({
  fileUrl,
  writeFile: (path, bytes, overwrite) =>
    native
      ? native.writeFile(path, bytes, overwrite)
      : Promise.reject(new Error("saving needs the desktop app")),
  refresh: () => void navigate(cwd, false),
  // Straight through to item 31 with the word timings intact. The transcript
  // panel closes: the two show the same recording, and leaving both up means
  // two videos and one pair of ears.
  onSubtitles: (path, segments) => {
    scribe.close();
    void subs.open(path, { segments });
  },
});

/**
 * The video editor (items 4 and 12). Native only, and not conditionally
 * stubbed: it is a front end for a child process, and there is no honest
 * browser fallback for "re-encode this file".
 */
const vedit = new VideoEditor({
  fileUrl,
  probe: (path) =>
    native
      ? (native.probeMedia(path) as Promise<Media>)
      : Promise.reject(new Error("editing video needs the desktop app")),
  frameAt: async (path, at, width) =>
    native
      ? new Uint8Array(await native.frameAt(path, at, width))
      : Promise.reject(new Error("needs the desktop app")),
  runJob: (job) =>
    native ? native.runJob(job) : Promise.reject(new Error("needs the desktop app")),
  cancelJob: (id) => (native ? native.cancelJob(id) : Promise.resolve()),
  onProgress: (cb) => subscribe<JobProgress>("ffmpeg-progress", cb),
  onDone: (cb) => subscribe<JobDone>("ffmpeg-done", cb),
  refresh: () => void navigate(cwd, false),
});

/**
 * Bridge the async subscribe to the synchronous one the editor wants.
 *
 * The editor is built for the same shape on both platforms and should not have
 * to await a listener registration in its constructor. Events that arrive
 * before the listener is attached are lost, which is fine — the only events
 * here are progress ticks for a job this same process has not started yet.
 */
function subscribe<T>(name: string, cb: (p: T) => void): () => void {
  let off: (() => void) | null = null;
  let dead = false;
  if (native) {
    void native.onEvent<T>(name, cb).then((u) => {
      if (dead) u();
      else off = u;
    });
  }
  return () => {
    dead = true;
    off?.();
  };
}

/**
 * The audio editor (item 5). Declared after `subscribe` rather than beside the
 * video editor because it uses it — the video editor is hoisted past it by the
 * function declaration, and this one would not be.
 */
const aedit = new AudioEditor({
  fileUrl,
  probe: (path) =>
    native
      ? (native.probeMedia(path) as Promise<Media>)
      : Promise.reject(new Error("editing audio needs the desktop app")),
  peaks: (path, buckets) =>
    native ? native.peaks(path, buckets) : Promise.reject(new Error("needs the desktop app")),
  runAudioJob: (job) =>
    native ? native.runAudioJob(job) : Promise.reject(new Error("needs the desktop app")),
  cancelJob: (id) => (native ? native.cancelJob(id) : Promise.resolve()),
  // The same two events as video: one encoder, one progress channel, and the
  // editors filter by the job id they were given.
  onProgress: (cb) => subscribe<JobProgress>("ffmpeg-progress", cb),
  onDone: (cb) => subscribe<JobDone>("ffmpeg-done", cb),
  refresh: () => void navigate(cwd, false),
});

/**
 * Subtitles (item 31).
 *
 * Editing and exporting work anywhere; only burning in needs the encoder, and
 * the panel says so itself rather than being stubbed out — a sidecar `.srt` is
 * the better answer most of the time anyway, since it can be turned off and the
 * picture is untouched.
 */
const subs = new SubtitleView({
  fileUrl,
  writeFile: (path, bytes, overwrite) =>
    native
      ? native.writeFile(path, bytes, overwrite)
      : Promise.reject(new Error("saving needs the desktop app")),
  refresh: () => void navigate(cwd, false),
  ...(native
    ? {
        runJob: (job: unknown) => native.runJob(job),
        cancelJob: (id: number) => native.cancelJob(id),
        onProgress: (cb: (p: JobProgress) => void) => subscribe<JobProgress>("ffmpeg-progress", cb),
        onDone: (cb: (d: JobDone) => void) => subscribe<JobDone>("ffmpeg-done", cb),
      }
    : {}),
});

/**
 * Document OCR (item 32).
 *
 * Works with no encoder and no network beyond the one-off language pack, so
 * unlike the subtitle panel there is nothing to degrade: the only thing the
 * desktop build adds is somewhere to save the result.
 */
const ocr = new OcrView({
  fileUrl,
  writeFile: (path, bytes, overwrite) =>
    native
      ? native.writeFile(path, bytes, overwrite)
      : Promise.reject(new Error("saving needs the desktop app")),
  refresh: () => void navigate(cwd, false),
});

/**
 * Signing and watermarking (items 1-19 of the signature list).
 *
 * Constructed here rather than lazily because it owns the signature store, and
 * the store is what makes a signature drawn once usable for years. Building it
 * on first open would mean the first document of every session waits on
 * localStorage for no reason anyone would be able to name.
 */
const signView = new SignView({
  fileUrl,
  readAll: async (path, max) => new Uint8Array(await readHead(path, max)),
  writeFile: (path, bytes, overwrite) =>
    native
      ? native.writeFile(path, bytes, overwrite)
      : Promise.reject(new Error("saving needs the desktop app")),
  refresh: () => void navigate(cwd, false),
});

const readHead = (path: string, max: number): Promise<number[]> =>
  native ? native.readHead(path, max) : Promise.reject(new Error("needs the desktop app"));

/**
 * What a swipe or an arrow key inside the quick-look card walks through.
 *
 * Set by whoever opened the card rather than read from `entries`, for the same
 * reason `openWith` takes a `list`: the phone shell opens files it found by
 * scanning storage, and those are often not in the folder the explorer is
 * currently showing.
 */
let quickList: FileEntry[] = [];

const quickLook = new QuickLook({
  fileUrl,
  readHead,
  // The same native decoder the grid's thumbnails come from. Without it the
  // card falls back to a hex dump for every HEIC, raw and AVI on the phone.
  frameAt: async (path, at, width) =>
    native
      ? new Uint8Array(await native.frameAt(path, at, width))
      : Promise.reject(new Error("needs the installed app")),
  actions: (entry) => docActions(entry),
  // A phone opens a file to read it. The path and the byte count go behind the
  // "i" in the header, which is where the picture viewer already keeps them.
  factsFolded: () => isPhone(),
  // Walking the folder from inside the card. `entries` is the folder as it is
  // sorted and filtered on screen, so the order the swipe follows is the order
  // the person can see -- and folders are stepped over, because going "next"
  // into a directory and being shown one sentence about it is not what a page
  // turn means.
  neighbour: (entry, step) => {
    let i = quickList.findIndex((e) => e.path === entry.path);
    if (i < 0) return null;
    for (i += step; i >= 0 && i < quickList.length; i += step) {
      const e = quickList[i];
      if (e && e.kind !== "folder") return e;
    }
    return null;
  },
  // A move within the same folder, which on one volume is a rename and is
  // instant whatever the file weighs. The card has already trimmed the name
  // and kept the extension; all that is left is to do it and let the folder
  // underneath notice.
  rename: async (entry, name) => {
    if (!native) throw new Error("renaming needs the installed app");
    const dir = entry.path.slice(0, entry.path.lastIndexOf("/"));
    const res = await native.moveFile(entry.path, `${dir}/${name}`, false);
    // `copied` means it crossed volumes and the original is still sitting
    // there. Not possible for a rename in place, but the adapter can say it,
    // and reporting a rename when there are now two files would be a lie.
    if (res.copied) flash("Copied rather than renamed — the original is still there");
    void navigate(cwd, false);
    return res.path;
  },
});

const metaPanel = new MetaPanel({
  // Metadata reading wants the whole file, and `read_head` already clamps to the
  // file's real length — so a size of "however big it is" costs nothing extra.
  readAll: async (path, max) => new Uint8Array(await readHead(path, max)),
  writeFile: (path, bytes, overwrite) =>
    native
      ? native.writeFile(path, bytes, overwrite)
      : Promise.reject(new Error("saving needs the desktop app")),
  // A cleaned copy that does not appear until you press F5 reads as a failure.
  refresh: () => void navigate(cwd, false),
});

/**
 * The batch queue (item 26).
 *
 * One lane by default: ffmpeg saturates the CPU, so four encodes at once finish
 * later than four in sequence and make every progress bar meaningless. Item 43
 * exposes it anyway, because a queue that is waiting on a slow disk rather than
 * on the CPU is a real case and the honest default is not the only right answer.
 *
 * Runners are registered before `start()` because a queue restored from disk
 * would otherwise fail its first restored task with "no runner" through no
 * fault of its own.
 */
const queue = new BatchQueue({ lanes: settings.get<number>(PREF.batchLanes) });

registerRunners(queue, {
  readAll: async (path, max) => new Uint8Array(await readHead(path, max)),
  writeFile: (path, bytes, overwrite) =>
    native
      ? native.writeFile(path, bytes, overwrite)
      : Promise.reject(new Error("saving needs the desktop app")),
  runJob: (job) =>
    native ? native.runJob(job) : Promise.reject(new Error("needs the desktop app")),
  runAudioJob: (job) =>
    native ? native.runAudioJob(job) : Promise.reject(new Error("needs the desktop app")),
  moveFile: (from, to, overwrite) =>
    native
      ? native.moveFile(from, to, overwrite)
      : Promise.reject(new Error("moving files needs the desktop app")),
  cancelJob: (id) => (native ? native.cancelJob(id) : Promise.resolve()),
  onProgress: (cb) => subscribe<JobProgress>("ffmpeg-progress", cb),
  onDone: (cb) => subscribe<JobDone>("ffmpeg-done", cb),
});

const batchPanel = new BatchPanel(queue, {
  reveal: (path) => (native ? native.revealInShell(path) : Promise.resolve()),
  refresh: () => void navigate(cwd, false),
});

// Subscribed for the life of the app, separately from the drawer's own
// subscription: a file that lands while the drawer is shut still has to appear
// in the folder, and the status bar still has to count what is left.
queue.onChange(() => {
  batchPanel.tick();
  renderStatus(selection);
});
queue.start();

/**
 * Watch folders (item 27). Rules that feed the queue on their own.
 *
 * Polling rather than an OS watch, because the question is not when a file
 * appeared but when it stopped growing — see the note at the top of
 * `core/watch/watcher.ts`. Started only on the desktop: without a real
 * filesystem there is nothing to watch, and a browser tab quietly sweeping the
 * mock adapter every few seconds would be noise with no purpose.
 */
const watcher = new WatchService({
  list: (path) => fs.list(path),
  enqueue: (spec) => void queue.add(spec),
  interval: settings.get<number>(PREF.watchInterval) * 1000,
});

const watchPanel = new WatchPanel(watcher, {
  currentFolder: () => cwd,
  say: (message) => flash(message),
});

if (native) watcher.start();

/**
 * The folder tree.
 *
 * Mounted into `#app` rather than declared in the markup because it owns its
 * own root and its own grid area. It calls `navigate` and is told where the app
 * went by `reveal` — the arrow goes one way in each direction, so the tree can
 * never disagree with the address bar.
 */
const tree = new TreePanel({
  onDrop: (paths, to, effect) => void dropInto(paths, to, effect),
  list: (path) => fs.list(path),
  open: (path) => void navigate(path),
  places: () => places,
  editPlaces: () => openPlaces(),
  movePlace: (path, delta) => {
    const p = places.find((q) => q.path !== undefined && same(q.path, path));
    if (p === undefined) return;
    userPlaces.move(p.id, delta, places);
    refreshPlaces();
  },
});
document.getElementById("app")?.appendChild(tree.root);

/**
 * Card faces. Built here rather than inside the canvas because it needs the
 * filesystem, and the canvas is deliberately ignorant of where files come from.
 */
const previews = new PreviewService({
  fileUrl,
  readHead,
  // Left undefined without the native bridge rather than stubbed to a rejected
  // promise: the service checks for their presence to decide whether a format
  // is previewable at all, and a stub would make it try and fail on every file.
  ...(native
    ? {
        readRange: (path: string, offset: number, len: number) => native.readRange(path, offset, len),
        readTail: (path: string, len: number) => native.readTail(path, len),
      }
    : {}),
  list: (path) => fs.list(path),
});

/**
 * The hex inspector. Native only — it is built on windowed reads, and without
 * them the honest options are to load a whole disk image into a browser tab or
 * to lie about the bytes. Neither belongs in a tool people open when they have
 * stopped trusting what everything else told them.
 */
const inspector = new Inspector({
  readRange: (path, offset, len) =>
    native ? native.readRange(path, offset, len) : Promise.reject(new Error("needs the desktop app")),
  readHead,
  readTail: (path, len) =>
    native ? native.readTail(path, len) : Promise.reject(new Error("needs the desktop app")),
});

/**
 * The tabular viewer. Native only, and for the same reason as the inspector:
 * it is built on windowed reads. A spreadsheet in a browser tab would have to
 * be loaded whole, and "big files must not be loaded whole" is the entire
 * design of this screen.
 */
const table = new TableView({
  readRange: (path, offset, len) =>
    native ? native.readRange(path, offset, len) : Promise.reject(new Error("needs the desktop app")),
  readHead,
  readTail: (path, len) =>
    native ? native.readTail(path, len) : Promise.reject(new Error("needs the desktop app")),
});

/** True while any full-screen surface owns the keyboard. */
const surfaceOpen = (): boolean =>
  viewer.isOpen || player.isOpen || scene.isOpen || quickLook.isOpen || metaPanel.isOpen ||
  inspector.isOpen || table.isOpen || vedit.isOpen || aedit.isOpen || prefs.isOpen ||
  camera.isOpen || recorder.isOpen || scribe.isOpen || subs.isOpen || ocr.isOpen ||
  signView.isOpen();

/**
 * The same question, answered with a name and a file rather than a boolean.
 *
 * Order matters only in the impossible case of two being open at once, and the
 * order here is the order they stack: the editor wins, because it is the one
 * with unsaved work in it.
 */
function openSurface(): OpenSurface | null {
  const candidates: [OpenSurface["kind"], string | null][] = [
    ["vedit", vedit.openPath],
    ["aedit", aedit.openPath],
    ["viewer", viewer.openPath],
    ["player", player.openPath],
    ["scene", scene.openPath],
    ["table", table.openPath],
    ["inspector", inspector.openPath],
    ["meta", metaPanel.openPath],
    ["quicklook", quickLook.openPath],
  ];
  for (const [kind, path] of candidates) if (path) return { kind, path };
  return null;
}

/**
 * Which handlers could open this file at all (item 40).
 *
 * Availability is a different question from preference and is only answerable
 * here, in the shell: only this file knows that the table view is native-only
 * and takes some extensions and not others, that both editors are front ends
 * for a child process, and that in the browser preview almost none of it
 * exists. `resolveOpen` takes this list and falls down its layers until
 * something on it answers.
 *
 * A .csv and a .db are both "tabular" to the explorer and only one of them is a
 * grid, so the table view is asked what it can actually render rather than
 * being handed everything with that kind.
 */
function handlersFor(kind: FileKind, ext: string): HandlerId[] {
  const out: HandlerId[] = [];
  if (kind === "image") out.push("viewer");
  if (kind === "video" || kind === "audio") out.push("player");
  // Not `kind === "model3d"`: the explorer calls eleven extensions that, and the
  // viewer draws five. Asking the view itself is what keeps a .blend from
  // resolving to a handler that would only be able to apologise.
  if (SceneView.handles(ext)) out.push("scene");
  if (native && TableView.handles(ext)) out.push("table");
  if (native && kind === "video") out.push("vedit");
  if (native && kind === "audio") out.push("aedit");
  // The three that take anything at all: bytes are bytes, every file has some
  // metadata even if the answer is "none", and quick look falls back to a hex
  // peek of its own.
  if (native) out.push("inspector");
  out.push("meta", "quicklook");
  if (native) out.push("system");
  return out;
}

/**
 * The one place that decides what opening a file means. Every entry point —
 * double-click, Enter, the palette — goes through here, so a new module is
 * wired in once and is immediately reachable from all three.
 *
 * The `switch` this used to be is now `BUILT_IN` in `@core/explorer/opens`,
 * unchanged in substance: it was right about the common case and had nowhere to
 * be overridden from. `openWith` below is the half that actually opens things;
 * this half only decides which one to call.
 */
function openEntry(entry: FileEntry): void {
  if (entry.kind === "folder") {
    void navigate(entry.path);
    return;
  }
  const handler = resolveOpen(entry, userOpens, handlersFor(entry.kind, entry.ext));
  if (handler !== null) openWith(entry, handler);
}

/** Open a file a named way, once, whatever the associations say. */
/**
 * `list` is the set the panel can page through with the arrow keys. It defaults
 * to whatever the explorer is showing, which is right for every desktop call —
 * but the phone shell opens files it found by scanning storage, and those are
 * frequently not in the current folder at all. Passing the siblings it actually
 * has stops the audio player opening a track it then claims is the only one
 * there, or worse, cannot find.
 */
function openWith(entry: FileEntry, handler: HandlerId, list: FileEntry[] = entries): void {
  switch (handler) {
    case "viewer":
      void viewer.open(list, entry);
      return;
    case "player":
      void player.open(list, entry);
      return;
    case "scene":
      void scene.open(list, entry);
      return;
    case "table":
      void table.open(entry);
      return;
    case "vedit":
      void vedit.open(entry.path);
      return;
    case "aedit":
      void aedit.open(entry.path);
      return;
    case "inspector":
      void inspector.open(entry);
      return;
    case "meta":
      void metaPanel.show([entry]);
      return;
    case "quicklook":
      quickList = list;
      void quickLook.show(entry);
      return;
    case "system":
      // Handing it to Windows beats doing nothing: the file opens, just not in
      // FACET yet.
      if (native) void native.openExternal(entry.path);
      return;
  }
}

// ── The four ways to look at a folder (item 34) ───────────────────────────
//
// There were two — the canvas for fun, the list for work — and the shape of
// that pair is what let a third and a fourth be added without the shell
// noticing: everything above this line talks to `browser`, never to any of the
// classes. What the shell *did* have to stop doing is deciding which is which
// by hand. `"canvas" ? "canvas" : "list"` was written out in four places, and
// each was a place to forget; the modes are a list in `@core/explorer/modes`
// now and every one of those places asks it.

/** What the shell needs from a folder view. All four classes satisfy it. */
interface FolderView {
  setConfig(cfg: ViewConfig): void;
  setEntries(entries: FileEntry[]): void;
  selectPaths(paths: readonly string[]): void;
  refresh(path: string): void;
  destroy(): void;
}

let mode: ViewMode = parseMode(settings.get<string>(PREF.view));

/** Shared by both views — the same folder, the same rules for opening it. */
const shared = {
  onOpen: openEntry,
  onSelect(sel: FileEntry[]) {
    selection = sel;
    renderStatus(sel);
    note();
  },
  onWantPreview(entry: FileEntry) {
    void previews.want(entry).then((preview) => {
      entry.preview = preview;
      browser.refresh(entry.path);
    });
  },
  /*
   * Item 39. The view has already put the selection right before calling this,
   * so there is nothing to do here but open the menu where the pointer is —
   * which is also why both views can share one handler.
   */
  onMenu(_entry: FileEntry | null, x: number, y: number) {
    openContextMenu(x, y);
  },
  /*
   * Asked at the moment a drag starts and again when a drop lands, rather than
   * handed over once: a view outlives any one folder, and a source folder read
   * from a value captured at construction would name wherever the app opened.
   */
  folder: () => cwd,
  onDrop: (paths: readonly string[], to: string, effect: DropEffect) =>
    void dropInto(paths, to, effect),
};

function buildView(): FolderView {
  stage.dataset["view"] = mode;
  switch (mode) {
    case "canvas":
      return new CanvasView(stage, view, shared);
    case "gallery":
      return new GalleryView(stage, view, { ...shared, onResize: setCardSize });
    case "columns":
      return new ColumnsView(stage, view, {
        ...shared,
        onWantFullPreview: shared.onWantPreview,
        onResize: setCardSize,
        // The view walks sideways out of the folder the shell is standing in,
        // so it has to ask where that is rather than assume it was told.
        cwd: () => cwd,
        // Shaped exactly like the current folder — same hidden-file rule, same
        // sort, same filter. A column that ordered itself differently from the
        // one beside it would be unreadable, and none of that logic belongs in
        // a view.
        onList: async (path) => {
          const listing = await fs.list(path);
          const shown = view.showHidden
            ? listing.entries
            : listing.entries.filter((e) => e.hidden !== true);
          return sortEntries(applyFilter(shown, query), view);
        },
      });
    default:
      return new ListView(stage, view, {
        ...shared,
        // Same service either way. The two hooks exist so the *list* can decide
        // which files are worth a decode from a row and which wait until they are
        // the one thing on screen; the shell does not need that distinction.
        onWantFullPreview: shared.onWantPreview,
        onSort: sortBy,
      });
  }
}

let browser: FolderView = buildView();

/**
 * Swap the view, keeping the selection and dropping the scroll position — a
 * pixel offset carried from a canvas to a list would mean nothing, whereas
 * losing what you had highlighted while changing how you look at it is plainly
 * wrong.
 */
/** Swap the view without painting. Navigation paints once, afterwards. */
function rebuildView(): void {
  browser.destroy();
  browser = buildView();
}

function mountView(): void {
  const keep = selection.map((e) => e.path);
  rebuildView();
  browser.setEntries(entries);
  if (keep.length > 0) browser.selectPaths(keep);
}

// ── Per-folder rules (item 37) ────────────────────────────────────────────

function remembering(): boolean {
  return settings.get<boolean>(PREF.rememberFolders);
}

/**
 * Resolve how *this* folder is to be shown.
 *
 * The settings are the default and the folder's rule is the override, which is
 * the same defaults-plus-diff shape the settings store itself has one level up.
 * That is what keeps sorting one folder from rewriting "Sort by" for the whole
 * app — and what makes turning the memory off restore the global answer
 * everywhere without having to erase anything.
 */
function applyFolderRule(path: string, keepFilter = false): void {
  const rule: FolderRule | undefined = remembering() ? rules.get(path) : undefined;
  view.sort = rule?.sort ?? settings.get<SortKey>(PREF.sort);
  view.ascending = rule?.ascending ?? settings.get<boolean>(PREF.ascending);
  // Every one of these is `rule ?? setting`, and that repetition is the point:
  // it is the single place where "this folder" beats "the app", and a field
  // added to `FolderRule` that is not added here is a View menu entry that
  // saves and then does nothing on the way back in.
  view.group = parseGroup(rule?.group, parseGroup(settings.get<string>(PREF.group)));
  view.cardSize = rule?.cardSize ?? settings.get<number>(PREF.cardSize);
  view.foldersFirst = rule?.foldersFirst ?? settings.get<boolean>(PREF.foldersFirst);
  // `keepFilter` is for re-resolving the folder you are already standing in —
  // a sort change, or F5. Clearing what somebody had typed because they pressed
  // refresh would be its own small betrayal, and it is the only way a filter
  // survives at all when per-folder memory is switched off.
  if (!keepFilter) loadFilter(rule?.filter ?? "");

  // Both parsed rather than trusted: the rule comes off disk, and a folder
  // saved as `"grid"` by some future build must not be a folder that cannot be
  // opened by this one.
  const fallback = parseMode(settings.get<string>(PREF.view));
  const wanted = parseMode(rule?.mode, fallback);
  if (wanted !== mode) {
    mode = wanted;
    // Rebuilt, not mounted: `entries` still holds the folder being left, and
    // painting it into the new view would flash the old folder in the new
    // layout for one frame before the real listing arrives.
    rebuildView();
  }
  browser.setConfig(view);
}

/** Put a filter in force without recording it — a restore, not a change. */
function loadFilter(text: string): void {
  filterText = text;
  query = parseFilter(text);
  filterBar.set(text);
}

/** A filter the user typed or picked: applied, remembered, repainted. */
function setFilter(text: string): void {
  if (text === filterText) return;
  filterText = text;
  query = parseFilter(text);
  // Harmless when the box was the caller, and necessary when it was not: the
  // palette, a saved filter and "clear the filter" all come through here.
  filterBar.set(text);
  if (remembering()) rules.set(cwd, { filter: text });
  reflow();
}

/**
 * Built once and moved back into the top bar on every redraw, rather than
 * rebuilt with it: `renderTopbar` runs on a theme change and on a rebind, and a
 * filter box that was replaced would lose the caret and the menu underneath it.
 */
const filterBar = new FilterBar({
  onChange: setFilter,
  saved: () => rules.all(),
  onSave: (name, q) => {
    rules.save(name, q);
    flash(`Saved "${name}"`);
  },
  onRemove: (name) => rules.remove(name),
});

/*
 * Everything below writes the *setting* and lets `applyPref` do the work.
 *
 * It would be shorter to mutate `view` here and push the value into the store
 * afterwards, and it would be wrong: the settings panel writes the store
 * directly, so a second path that skips it means the two disagree the moment
 * both are used. One writer, one reducer.
 *
 * Item 37 adds a second writer on purpose, and it is worth being explicit about
 * why: when per-folder memory is on, changing the sort or the layout is not a
 * statement about the app, it is a statement about *this folder*. Sending it to
 * the settings store would make sorting Downloads by date re-sort every folder
 * you own. So those writes go to the rules store instead, and `applyFolderRule`
 * is the single reducer that turns settings-plus-rule into `view`.
 */

function setMode(next: ViewMode): void {
  if (remembering()) {
    rules.set(cwd, { mode: next });
    if (next !== mode) {
      mode = next;
      mountView();
      renderTopbar();
      // The order itself can change with the layout -- see `orderEntries`.
      reflow();
    }
    return;
  }
  settings.set(PREF.view, next);
}

/**
 * The rest of the View menu, all one shape.
 *
 * `remembering()` decides who the write is *about*, exactly as it does for the
 * sort and the layout above: with per-folder memory on, choosing large icons in
 * Screenshots is a statement about Screenshots, and sending it to the settings
 * store would resize every folder you own. With it off there is nowhere to put a
 * per-folder answer, so the global setting is the only honest target.
 *
 * There is no save step anywhere in here. `rules.set` persists on the way
 * through and `settings.set` does the same, so the state on screen and the state
 * on disk are never more than one function call apart — which is what "it
 * automatically just saves" has to mean if it is to be believed.
 */
function setGroup(next: GroupKey): void {
  if (remembering()) {
    rules.set(cwd, { group: next });
    view.group = next;
    browser.setConfig(view);
    reflow();
    return;
  }
  settings.set(PREF.group, next);
}

/** Icon size. The View menu offers named steps; this stores what they resolve to. */
function setFolderCardSize(px: number): void {
  // Clamped here as well as in `rules.sanitize`, because the store clamps what
  // it *writes* and this assigns what is *drawn*. Without it, Ctrl+= past the
  // ceiling would keep growing the cards on screen while the disk held 420, and
  // the next visit to the folder would silently shrink them back.
  const size = Math.min(MAX_CARD, Math.max(MIN_CARD, Math.round(px)));
  if (remembering()) {
    rules.set(cwd, { cardSize: size });
    view.cardSize = size;
    browser.setConfig(view);
    return;
  }
  setCardSize(size);
}

function setFoldersFirst(on: boolean): void {
  if (remembering()) {
    rules.set(cwd, { foldersFirst: on });
    view.foldersFirst = on;
    browser.setConfig(view);
    reflow();
    return;
  }
  settings.set(PREF.foldersFirst, on);
}

/**
 * Hidden files are the one axis that is not per-folder.
 *
 * `showHidden` is applied by the adapter on the way in rather than by the view,
 * so honouring it per folder would mean re-listing on every navigation to find
 * out whether this folder wanted them — and, worse, the tree and the palette
 * would still be showing the other answer. It stays global, and the View menu
 * says so by putting it under a divider with the other app-wide switches.
 */
function setShowHidden(on: boolean): void {
  settings.set(PREF.showHidden, on);
}

/**
 * Sort by a column. Clicking the column already sorted reverses it, which is
 * what every file manager does and therefore what fingers expect.
 */
function sortBy(key: SortKey): void {
  const ascending = view.sort === key ? !view.ascending : true;
  if (remembering()) {
    rules.set(cwd, { sort: key, ascending });
    view.sort = key;
    view.ascending = ascending;
    browser.setConfig(view);
    reflow();
    return;
  }
  settings.set(PREF.sort, key);
  settings.set(PREF.ascending, ascending);
}

/**
 * A settings change, applied to the running app.
 *
 * This is the whole of "live by default": every reader that cannot simply call
 * `settings.get()` at the moment it needs the value is updated from here. The
 * cost of a change is deliberately proportionate — a card-size change repaints
 * the cards, a hidden-files change costs a listing, and nothing costs a
 * restart.
 */
function applyPref(id: string): void {
  switch (id) {
    case PREF.view: {
      const next = parseMode(settings.get<string>(PREF.view));
      if (next === mode) return;
      mode = next;
      mountView();
      renderTopbar();
      reflow();
      return;
    }
    // Both go through the resolver rather than straight into `view`: with
    // per-folder memory on, a folder that has been sorted keeps its own order,
    // and changing the default is a change to every folder that has *not*.
    case PREF.sort:
    case PREF.ascending:
    case PREF.group:
    case PREF.cardSize:
    case PREF.foldersFirst:
    // Turning the memory off has to take effect where you are standing, not on
    // the next navigation — otherwise the switch looks broken.
    case PREF.rememberFolders:
      applyFolderRule(cwd, true);
      reflow();
      return;
    case PREF.nameLines:
      view.nameLines = settings.get<number>(PREF.nameLines);
      browser.setConfig(view);
      return;
    case PREF.columns:
      view.columns = settings.get<string>(PREF.columns);
      browser.setConfig(view);
      return;
    case PREF.cardFields:
      view.cardFields = settings.get<string>(PREF.cardFields);
      browser.setConfig(view);
      return;
    case PREF.showHidden:
      view.showHidden = settings.get<boolean>(PREF.showHidden);
      // The hidden entries were filtered out of `entries` on the way in, so
      // this one genuinely needs the folder again rather than a re-sort.
      void navigate(cwd, false);
      return;
    case PREF.previews:
    case PREF.folderPreviews:
    case PREF.previewTextLines:
      // The preview service reads its own settings per file; what is stale is
      // the answers it already cached under the old ones.
      previews.reset();
      browser.setEntries(entries);
      return;
    case PREF.uiScale:
    case PREF.density:
    case PREF.font:
    case PREF.reduceMotion:
      applyAppearance();
      return;
    case PREF.batchLanes:
      // Widening starts more work immediately; narrowing lets what is already
      // running finish, because killing a half-written encode to honour a
      // slider is the wrong trade.
      queue.setLanes(settings.get<number>(PREF.batchLanes));
      return;
    case PREF.watchInterval:
      // Declared in seconds because that is the unit someone thinks in;
      // the watcher wants milliseconds.
      watcher.setInterval(settings.get<number>(PREF.watchInterval) * 1000);
      return;
    default:
      // Read at the point of use — the preview lanes and cache size, the table
      // block cache, the undo document count — or not read by the shell at all.
      return;
  }
}

/**
 * The four appearance settings, written onto <html>.
 *
 * base.css has expressed every font size as `calc(N * --fct-ui-scale)` and
 * every gap, radius and bar height as `calc(N * --fct-density)` since the first
 * commit, with nothing to write them. So this function is the entire
 * implementation of "resize the whole interface", and it costs two property
 * writes rather than a re-render.
 */
function applyAppearance(): void {
  const root = document.documentElement.style;
  root.setProperty("--fct-ui-scale", String(settings.get<number>(PREF.uiScale)));
  root.setProperty("--fct-density", String(settings.get<number>(PREF.density)));

  const font = settings.get<string>(PREF.font).trim();
  // A blank box means "whatever the system gives me", not "no font" — so the
  // property is removed rather than set to empty, letting base.css win.
  if (font === "") root.removeProperty("--fct-font-ui");
  else root.setProperty("--fct-font-ui", `${font}, "Segoe UI", system-ui, sans-serif`);

  /* Three states out of a two-state control, using the store's own diff
     semantics: on → reduced, explicitly off → full (overriding a system
     preference, which someone who turned it off here plainly meant), never
     touched → no attribute at all, and the `prefers-reduced-motion` rule in
     settings.css decides. Writing "full" unconditionally would silently ignore
     the OS setting of everyone who has never opened this panel. */
  const motion = document.documentElement.dataset;
  if (settings.get<boolean>(PREF.reduceMotion)) motion["motion"] = "reduced";
  else if (settings.isSet(PREF.reduceMotion)) motion["motion"] = "full";
  else delete motion["motion"];
}

// ── Navigation ────────────────────────────────────────────────────────────

async function navigate(path: string, push = true): Promise<void> {
  if (push && path !== cwd) history.push(cwd);
  const prev = cwd;
  cwd = path;
  let listing;
  try {
    listing = await fs.list(path);
  } catch (e) {
    // A permission-denied or vanished folder must not strand the shell on a
    // path it can never leave — go back to where we were and say why.
    cwd = prev;
    if (push) history.pop();
    status.textContent = `${path} — ${String(e)}`;
    return;
  }
  listed = view.showHidden
    ? listing.entries
    : listing.entries.filter((e) => e.hidden !== true);
  // Before the sort, because it is what decides the sort: a folder you left
  // newest-first opens newest-first (item 37). Arriving somewhere new starts
  // with that folder's own filter and no other; a reload of where you already
  // are keeps what is in the box.
  applyFolderRule(path, prev === path);
  entries = orderEntries();
  // Generated frames and cover art hold real memory, and none of it is worth
  // anything once you have left the folder.
  previews.reset();
  browser.setEntries(entries);
  renderTopbar();
  renderRail();
  renderStatus([]);
  // Not awaited: the tree opening itself down to a deep path may take several
  // listings, and the files are already on screen. Making navigation wait for
  // the sidebar to catch up would put a disk read between the click and the
  // folder appearing.
  void tree.reveal(cwd);
  note();
}

/**
 * Re-read this folder, and the sidebar with it.
 *
 * `navigate(cwd, false)` alone is enough for the grid, which fetches every
 * time. The tree does not: it caches each listing it has opened, which is the
 * whole reason it can be left open on a deep path without hammering the disk.
 * The cost is that a folder created by something else while FACET was running
 * would never appear in the sidebar — so F5, which is the key people press
 * precisely when they suspect that, has to clear it.
 */
function reload(): void {
  void navigate(cwd, false);
  void tree.refresh();
}

/**
 * Record where the shell is, so the next run can open here.
 *
 * Called on every navigation and every selection change. Cheap: the write is
 * debounced inside the session module, and paths are all it stores.
 */
function note(): void {
  remember({
    folder: cwd,
    selected: selection.map((e) => e.path),
    surface: openSurface(),
  });
}

/**
 * Open a file named by path rather than by entry.
 *
 * Everything the session record holds is a string, because entries go stale the
 * moment the folder is listed again. Getting from one to the other means going
 * to the folder and looking — which is also how the file having been moved or
 * deleted in the meantime gets noticed instead of silently doing nothing.
 */
async function openPath(path: string): Promise<void> {
  const i = path.lastIndexOf("/");
  const folder = i > 2 ? path.slice(0, i) : path;
  if (folder !== cwd) await navigate(folder);
  const entry = entries.find((e) => e.path === path);
  if (entry) openEntry(entry);
  else status.textContent = `${path} — not there any more`;
}

function goUp(): void {
  const i = cwd.lastIndexOf("/");
  if (i > 2) void navigate(cwd.slice(0, i));
}

function goBack(): void {
  const prev = history.pop();
  if (prev !== undefined) void navigate(prev, false);
}

// ── Chrome ────────────────────────────────────────────────────────────────

const ICONS: Record<string, string> = {
  home: "⌂", image: "▦", video: "▶", audio: "◍", doc: "▤",
  clock: "◷", sparkle: "✦",
  // Without this the drives fell through to the "•" fallback and the bottom of
  // the rail was three identical dots.
  drive: "▭",
};

/**
 * The rail: places you chose, and nothing the machine merely found.
 *
 * Discovered drives are skipped. They were never a decision anybody made — the
 * adapter reports every mounted volume and the rail listed all of them, so the
 * bottom of a narrow column was a run of identical squares that also appear,
 * named and grouped under "This PC", in the tree three inches to the right. One
 * of those two lists is a considered sidebar and the other is a duplicate that
 * grows every time a USB stick is plugged in.
 *
 * `pinned` is what makes this a filter on *provenance* rather than on drives.
 * A drive you pinned deliberately is a decision and stays; the ones the machine
 * volunteered do not. Without that distinction the pin button would silently do
 * nothing for a whole class of target, which is the worst thing a button can do.
 */
// Wired once, on the rail itself rather than on the buttons: `renderRail`
// replaces every button whenever the places change, and a drag in flight over
// a button rebuilt underneath it would land on an element with no handlers.
acceptDrops(rail, {
  folderAt: (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>(".rail-btn");
    return btn?.dataset["path"] ?? null;
  },
  mark: (path) => {
    for (const btn of rail.querySelectorAll<HTMLElement>(".rail-btn")) {
      if (path !== null && btn.dataset["path"] === path) btn.dataset["drop"] = "1";
      else delete btn.dataset["drop"];
    }
  },
  run: (paths, to, effect) => void dropInto(paths, to, effect),
});

function renderRail(): void {
  rail.replaceChildren();
  for (const place of places) {
    if (place.icon === "drive" && place.pinned !== true) continue;
    const btn = document.createElement("button");
    btn.className = "rail-btn";
    btn.type = "button";
    // The full name stays on `title` and `aria-label` — the visible label is
    // clipped to fit, and "Down…" on its own is not an accessible name.
    btn.title = place.name;
    btn.setAttribute("aria-label", place.name);

    const icon = document.createElement("span");
    icon.className = "rail-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = ICONS[place.icon] ?? "•";

    const label = document.createElement("span");
    label.className = "rail-label";
    label.textContent = railLabel(place);

    btn.append(icon, label);

    if (place.path !== undefined) btn.dataset["path"] = place.path;
    if (place.path !== undefined && place.path === cwd) {
      btn.setAttribute("aria-current", "true");
    }
    btn.addEventListener("click", () => {
      if (place.path !== undefined) void navigate(place.path);
    });
    rail.appendChild(btn);
  }
}

/**
 * What to print under a rail icon.
 *
 * Drives get their letter rather than their volume name: "C:" identifies the
 * thing and "Local Disk" does not, and at rail width only about eight
 * characters survive anyway.
 */
function railLabel(place: { name: string; icon: string; path?: string }): string {
  if (place.icon === "drive") {
    const letter = /^([A-Za-z]:)/.exec(place.name) ?? /^([A-Za-z]:)/.exec(place.path ?? "");
    if (letter?.[1]) return letter[1].toUpperCase();
  }
  // First word only. "Downloads" fits; "My Received Files" does not, and a
  // label that wraps to three lines makes the rail taller than the window.
  const word = place.name.trim().split(/[\s/\\]+/)[0] ?? place.name;
  return word.length > 9 ? `${word.slice(0, 8)}…` : word;
}

/**
 * Re-resolve the sidebar and redraw everything that draws it (item 38).
 *
 * One function because there are three of them — the rail, the tree and the
 * palette's go-to list — and a pin that appeared in two of the three would be a
 * bug found weeks later by someone wondering why Ctrl+K cannot see a folder that
 * is plainly on screen. The tree rebuild is `void`-ed rather than awaited: the
 * caller is a button handler, and the rail should not wait on a disk that is
 * enumerating a slow network drive.
 */
function refreshPlaces(): void {
  places = userPlaces.resolve(discovered);
  renderRail();
  void tree.build();
  if (placesPanel.isOpen) placesPanel.sync();
}

/**
 * The address input, kept at module scope so Ctrl+L can reach it from the
 * global key handler no matter what has focus.
 */
let addressInput: HTMLInputElement | null = null;

/** Show the path as an editable, selectable string and put the caret in it. */
function editAddress(): void {
  const input = addressInput;
  if (!input) return;
  input.value = cwd;
  input.hidden = false;
  input.focus();
  input.select();
  topbar.dataset["editing"] = "true";
}

function stopEditingAddress(): void {
  if (!addressInput) return;
  addressInput.hidden = true;
  delete topbar.dataset["editing"];
}

// ── The View menu (items 4 and 5) ─────────────────────────────────────────

/**
 * The sort keys, named once.
 *
 * There were three copies of this list — the settings registry, the palette and
 * `rules.sanitize` — and adding a fourth for the View menu is how a list like
 * this ends up disagreeing with itself. The palette lower-cases these because
 * its titles read "Sort by date modified"; the menu uses them as written.
 */
const SORT_LABELS: ReadonlyArray<readonly [SortKey, string]> = [
  ["name", "Name"],
  ["size", "Size"],
  ["modified", "Date modified"],
  ["kind", "Kind"],
];

/**
 * Named icon sizes, the way Explorer offers them.
 *
 * A number field is the honest control for a continuous value and it is still
 * there in Settings, but nobody opens a menu wanting "212 px" — they want the
 * next size up. The steps land inside `MIN_CARD`/`MAX_CARD` so every one of them
 * survives the clamp unchanged, and the tick goes on whichever step is nearest
 * rather than on an exact match, so a size set with the keys or the slider still
 * shows the menu where it is.
 */
const ICON_SIZES: ReadonlyArray<readonly [number, string]> = [
  [420, "Extra large icons"],
  [300, "Large icons"],
  [190, "Medium icons"],
  [130, "Small icons"],
  [90, "Tiny icons"],
];

function nearestIconSize(px: number): number {
  let best = ICON_SIZES[0]![0];
  for (const [size] of ICON_SIZES) {
    if (Math.abs(size - px) < Math.abs(best - px)) best = size;
  }
  return best;
}

const viewMenu = new ViewMenu();

/**
 * What the menu says right now.
 *
 * Rebuilt on every open rather than held and patched, because every row of it
 * reports state that four other things can change — the keys, the palette, the
 * Settings panel and simply walking into a folder that remembers its own answer.
 * A menu built once would be a fifth opinion about the sort order.
 */
function viewMenuSections(): ViewMenuSection[] {
  const out: ViewMenuSection[] = [
    {
      title: "Layout",
      items: MODES.map((m) => ({
        label: m.label,
        kind: "radio" as const,
        on: m.id === mode,
        hint: m.glyph,
        run: () => setMode(m.id),
      })),
    },
  ];

  // The details list draws rows, not cards, so `cardSize` means nothing in it.
  // Explorer greys the sizes out there; leaving the section out entirely says
  // the same thing without a block of dead rows to read past.
  if (mode !== "list") {
    const near = nearestIconSize(view.cardSize);
    out.push({
      title: "Icon size",
      items: ICON_SIZES.map(([px, label]) => ({
        label,
        kind: "radio" as const,
        on: px === near,
        run: () => setFolderCardSize(px),
      })),
    });
  }

  out.push({
    title: "Sort by",
    items: [
      ...SORT_LABELS.map(([key, label]) => ({
        label,
        kind: "radio" as const,
        on: view.sort === key,
        // `sortBy` reverses when you pick the key that is already current, which
        // is what a column header does. Here that would make the sort rows into
        // direction toggles by a side door, so the direction gets its own two
        // rows below and these ask for the key they name.
        run: () => {
          if (view.sort !== key) sortBy(key);
        },
      })),
      {
        label: "Ascending",
        kind: "radio" as const,
        on: view.ascending,
        run: () => {
          if (!view.ascending) sortBy(view.sort);
        },
      },
      {
        label: "Descending",
        kind: "radio" as const,
        on: !view.ascending,
        run: () => {
          if (view.ascending) sortBy(view.sort);
        },
      },
    ],
  });

  // Same reason `orderEntries` skips it: the canvas and the columns have
  // nowhere to draw a heading, so offering the choice there would be a menu
  // entry that ticks and does nothing.
  if (mode === "list" || mode === "gallery") {
    out.push({
      title: "Group by",
      items: GROUPS.map((g) => ({
        label: g.label,
        kind: "radio" as const,
        on: view.group === g.id,
        run: () => setGroup(g.id),
      })),
    });
  }

  out.push({
    items: [
      {
        label: "Folders first",
        kind: "check" as const,
        on: view.foldersFirst,
        run: () => setFoldersFirst(!view.foldersFirst),
      },
      {
        // No per-folder answer for this one — see `setShowHidden`. The hint is
        // there so the one row that behaves differently says so rather than
        // quietly surprising you two folders later.
        label: "Hidden files",
        kind: "check" as const,
        on: settings.get<boolean>(PREF.showHidden),
        hint: remembering() ? "all folders" : "",
        run: () => setShowHidden(!settings.get<boolean>(PREF.showHidden)),
      },
    ],
  });

  if (remembering()) {
    out.push({
      items: [
        {
          label: "Forget this folder's view",
          kind: "plain" as const,
          run: () => {
            rules.forget(cwd);
            applyFolderRule(cwd, true);
            const next = parseMode(settings.get<string>(PREF.view));
            if (next !== mode) {
              mode = next;
              mountView();
            }
            browser.setConfig(view);
            reflow();
            renderTopbar();
          },
        },
      ],
    });
  }

  return out;
}

/**
 * The topbar's View button.
 *
 * It wears the current mode's glyph rather than a fixed icon, so the bar still
 * answers "which layout am I in" without being read — which is the one thing
 * the four buttons did well and the only thing lost by collapsing them.
 */
function viewButton(): HTMLButtonElement {
  const b = button(modeGlyph(mode), keyTip(`View — ${modeLabel(mode)}`, KEY_ID.viewMode), () => {
    // A toggle, not an opener. The menu leaves a press on its own anchor alone
    // precisely so this can be the one place that decides.
    if (viewMenu.isOpen) viewMenu.close();
    else viewMenu.openUnder(b, viewMenuSections());
  });
  b.setAttribute("aria-haspopup", "menu");
  return b;
}

function renderTopbar(): void {
  /*
   * The row is rebuilt wholesale on every mode, history or path change, and on
   * a phone it is wider than the screen and scrolled sideways. Rebuilding
   * resets that scroll, so changing view mode threw you back to the start of
   * the bar and you had to swipe across again to change it a second time.
   * Nothing else remembers this, because on a desktop the row always fits.
   */
  const scrolled = topbar.scrollLeft;
  topbar.replaceChildren();

  const back = button("‹", "Back", goBack);
  back.disabled = history.length === 0;
  const up = button("↑", "Up one level", goUp);

  /*
   * The path lives in one strip that is two things at once: a row of clickable
   * crumbs, and — one click on the strip, or Ctrl+L — a plain text field
   * holding the whole path. Crumbs alone cannot be copied, cannot be read when
   * they overflow, and cannot be typed into, which is no good when the path is
   * forty characters deep inside OneDrive.
   */
  const addr = document.createElement("div");
  addr.className = "addr";

  const crumbs = document.createElement("nav");
  crumbs.className = "crumbs";
  crumbs.title = cwd;
  const parts = cwd.split("/").filter(Boolean);
  parts.forEach((part, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "/";
      crumbs.appendChild(sep);
    }
    const target = parts.slice(0, i + 1).join("/");
    if (i === parts.length - 1) {
      const b = document.createElement("b");
      b.textContent = part;
      crumbs.appendChild(b);
    } else {
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = part;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        void navigate(target);
      });
      crumbs.appendChild(a);
    }
  });

  const input = document.createElement("input");
  input.className = "addr-input";
  input.type = "text";
  input.spellcheck = false;
  input.hidden = true;
  input.title = "Full path — edit and press enter to go there";
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const target = input.value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
      stopEditingAddress();
      if (target !== "" && target !== cwd) void navigate(target);
    } else if (e.key === "Escape") {
      e.preventDefault();
      stopEditingAddress();
    }
  });
  // Leaving the field is a cancel, not a commit. Navigating somewhere because
  // focus moved would be a genuinely nasty surprise.
  input.addEventListener("blur", stopEditingAddress);
  addressInput = input;

  // Clicks that land on the strip rather than on a crumb open the editor —
  // the same place Windows and every browser put it.
  addr.addEventListener("click", (e) => {
    if (e.target === addr || e.target === crumbs) editAddress();
  });

  addr.append(crumbs, input);

  topbar.append(
    back,
    up,
    addr,
    // Beside the path, which is where Explorer, Finder and every browser put
    // the box that narrows what you are looking at.
    filterBar.root,
    button("⧉", "Copy this path", () => void navigator.clipboard.writeText(cwd)),
    // Only on desktop, and always enabled: it explains itself when nothing is
    // selected rather than sitting there greyed out with no reason given.
    ...(native
      ? [button("↗", keyTip("Share the selection", KEY_ID.share), shareSelection)]
      : []),
    button("⌕", keyTip("Commands", KEY_ID.palette), () => palette.open()),
    button("⚙", keyTip("Settings", KEY_ID.settings), () => prefs.open()),
    themePicker(),
    // One View button, where there used to be one button per mode.
    //
    // Four glyphs in a row showed the layouts and nothing else — not the sort,
    // not the grouping, not the icon size, all of which were only reachable
    // through Settings or the palette. The menu holds every one of them, and it
    // costs three fewer controls in a bar that has to survive a 420px-wide
    // window. The current mode's own glyph stays on the button, so what the
    // four buttons actually told you at a glance is still told.
    viewButton(),
    // Only the canvas has anything to fit.
    ...(mode === "canvas" ? [button("⤢", "Fit to view", fitAll)] : []),
  );

  // After the children exist, so the browser has a scrollWidth to clamp to.
  topbar.scrollLeft = scrolled;
}

function fitAll(): void {
  browser.setEntries(entries);
}

/**
 * A label's shortcut, read from the keymap rather than typed into the string.
 *
 * Item 35 made every chord editable, which makes every hard-coded "ctrl+K" in
 * a tooltip a lie waiting to happen. `extra` is the rest of the hint — the
 * palette's right-hand column often says what a command is *for* as well as
 * which key runs it — and an unbound command simply loses the chord half.
 */
function keyHint(id: string, extra = ""): string {
  const chord = keys.chord(id);
  if (chord === "") return extra;
  return extra === "" ? chord : `${chord}  ·  ${extra}`;
}

/** The same thing as a tooltip suffix: "Settings  (Ctrl+,)". */
function keyTip(title: string, id: string): string {
  const chord = keys.chord(id);
  return chord === "" ? title : `${title}  (${chord})`;
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "btn";
  b.type = "button";
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function themePicker(): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.className = "btn";
  sel.title = "Theme";
  for (const t of themes.all) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = themes.isFavourite(t.id) ? `★ ${t.name}` : t.name;
    sel.appendChild(opt);
  }
  sel.value = themes.active.id;
  // The topbar is rebuilt as well, because there are now two of these — this
  // one and the row in the settings panel — and the one that did not change is
  // still showing the old theme's name.
  sel.addEventListener("change", () => {
    themes.apply(sel.value);
    renderTopbar();
  });
  return sel;
}

function renderStatus(selection: FileEntry[]): void {
  const folders = entries.filter((e) => e.kind === "folder").length;
  const files = entries.length - folders;
  const bytes = entries.reduce((n, e) => n + (e.size ?? 0), 0);
  const parts = [
    `${folders} folders · ${files} files`,
    humanBytes(bytes),
  ];
  // Zoom is a canvas fact. In the list it would be a number that never moves.
  if (browser instanceof CanvasView) {
    parts.push(`zoom ${Math.round(browser.viewport.scale * 100)}%`);
  }
  if (selection.length > 0) parts.push(`${selection.length} selected`);
  // A queue running behind a closed drawer has to say so somewhere, or work
  // carries on in a window nobody knows is open.
  const queued = queue.pending();
  if (queued > 0) parts.push(`⧗ ${queued} queued · ${Math.round(queue.overall() * 100)}%`);

  status.replaceChildren();
  const counts = document.createElement("span");
  counts.className = "status-counts";
  counts.textContent = parts.join("    ");

  /*
   * A filtered folder has to say so, and has to say what was left out. Without
   * this, a folder showing four of its nine hundred files looks exactly like a
   * folder with four files in it — which is how people conclude that a file
   * manager has lost their work.
   */
  let filterNote: HTMLElement | null = null;
  if (!query.empty) {
    filterNote = document.createElement("span");
    filterNote.className = "status-filter";
    filterNote.textContent = `⌕ ${entries.length} of ${listed.length}  ·  ${describe(query)}`;
    filterNote.title = "Filtering. Esc in the filter box clears it.";
  }

  /*
   * The full path of whatever is selected, or of the folder itself. Long paths
   * are the normal case here, not the exception, so this is the one place that
   * never abbreviates: it wraps, it can be selected with the mouse, and one
   * click copies it.
   */
  const one = selection.length === 1 ? selection[0] : undefined;
  const path = document.createElement("button");
  path.type = "button";
  path.className = "status-path";
  path.textContent = one ? one.path : cwd;
  path.title = "Click to copy";
  path.addEventListener("click", () => {
    void navigator.clipboard.writeText(path.textContent ?? "").then(() => {
      const was = path.textContent;
      path.dataset["copied"] = "true";
      path.textContent = "copied";
      setTimeout(() => {
        path.textContent = was;
        delete path.dataset["copied"];
      }, 900);
    });
  });

  if (filterNote) status.append(counts, filterNote, path);
  else status.append(counts, path);
}

/**
 * Say something in the status bar, briefly.
 *
 * Deliberately not a toast floating over the canvas: the status bar is already
 * where this shell answers questions about the selection, and an action taken on
 * the selection reporting somewhere else would be a second place to look.
 */
let flashTimer: ReturnType<typeof setTimeout> | null = null;
function flash(message: string): void {
  if (flashTimer !== null) clearTimeout(flashTimer);
  status.replaceChildren();
  const span = document.createElement("span");
  span.className = "status-counts";
  span.textContent = message;
  status.append(span);
  flashTimer = setTimeout(() => {
    flashTimer = null;
    renderStatus(selection);
  }, 2600);
}

/** `dir` + `name`, with exactly one separator however `dir` was written. */
function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${name}`;
}

/**
 * A drag landed on a folder (item 6).
 *
 * **Nothing here deletes anything.** A move is `rename`, which either succeeds
 * whole or does not happen; a move the OS refuses — across drives, always —
 * comes back from `move_file` as a copy with `copied: true` and the original
 * still sitting where it was. That is reported rather than tidied up, because
 * the alternative is this function removing a file the user can still see, and
 * a drag that half-worked is recoverable while a drag that deleted is not.
 *
 * One at a time rather than in parallel. A dozen concurrent renames across a
 * spinning disk finish later than a dozen in sequence, and a failure partway
 * through a parallel batch leaves you unable to say which ones landed.
 */
async function dropInto(
  paths: readonly string[],
  to: string,
  effect: DropEffect,
): Promise<void> {
  if (native === null) {
    flash("Moving files needs the desktop app");
    return;
  }
  let done = 0;
  let kept = 0;
  let failed = 0;
  let why = "";

  for (const from of paths) {
    const dest = joinPath(to, baseName(from));
    try {
      const result =
        effect === "copy"
          ? await native.copyFile(from, dest)
          : await native.moveFile(from, dest);
      done++;
      // A move that had to become a copy. Worth saying out loud: the user is
      // about to look at two copies and wonder which one is real.
      if (effect === "move" && result.copied) kept++;
    } catch (err) {
      failed++;
      if (why === "") why = err instanceof Error ? err.message : String(err);
    }
  }

  await navigate(cwd, false);
  void tree.refresh();

  const noun = done === 1 ? "item" : "items";
  if (failed > 0 && done === 0) flash(why === "" ? "Nothing moved" : why);
  else if (failed > 0) {
    flash(`${effect === "copy" ? "Copied" : "Moved"} ${done} ${noun}, ${failed} failed — ${why}`);
  } else if (kept > 0) {
    flash(`Copied ${done} ${noun} to another drive — originals kept`);
  } else {
    flash(`${effect === "copy" ? "Copied" : "Moved"} ${done} ${noun} to ${baseName(to)}`);
  }
}

/**
 * Put the selected files on the clipboard — the files, not their paths.
 *
 * This is the half of "share" that reaches everything: Explorer, a mail draft,
 * a chat box, a file dialog. It is bound to Ctrl+C because that is what it is
 * everywhere else, and a file manager where Ctrl+C copies the *name* of the
 * file you picked is a file manager that lied about being one.
 */
function copySelection(): void {
  if (!native || selection.length === 0) return;
  const paths = selection.map((e) => e.path);
  void native
    .copyFiles(paths)
    .then(() => {
      flash(
        paths.length === 1
          ? `${selection[0]?.name ?? "1 file"} copied — paste it anywhere`
          : `${paths.length} items copied — paste them anywhere`,
      );
    })
    .catch((e: unknown) => { flash(`Could not copy — ${String(e)}`); });
}

/**
 * Hand the selection to the OS share sheet.
 *
 * The failure path matters more than the success one here. The sheet is a UWP
 * surface and there is no guarantee anything has registered as a target, so the
 * message on failure names the alternative rather than just reporting an error
 * code at someone who wanted to send a photo.
 */
/**
 * Concatenate several clips into one file.
 *
 * In the order they are sorted on screen, which is the order the person
 * selecting them was looking at — asking again in a dialog would be asking
 * them to repeat themselves.
 *
 * This is not a re-encode-free operation and does not pretend to be: joining
 * files that were encoded differently requires decoding them to a common
 * format, and the concat *demuxer* trick that avoids it silently produces a
 * broken file the moment two inputs disagree about resolution or frame rate.
 */
/**
 * The join job in flight, if any.
 *
 * A join runs from the file list rather than from inside the editor, so nothing
 * is on screen to own its progress — it reports through the status bar instead.
 * Only one at a time: a second join started while the first is encoding would
 * have the two of them fighting for the same status line, and the batch queue
 * (item 26) is where concurrent work is going to belong.
 */
let joining: number | null = null;

subscribe<JobProgress>("ffmpeg-progress", (p) => {
  if (p.id === joining) flash(`Joining — ${Math.round(Math.max(0, p.fraction) * 100)}%`);
});
subscribe<JobDone>("ffmpeg-done", (d) => {
  if (d.id !== joining) return;
  joining = null;
  if (d.ok) {
    flash(`Joined — ${d.output.split("/").pop() ?? ""}`);
    void navigate(cwd, false);
  } else {
    flash(`Join failed — ${d.error}`);
  }
});

/** The selected file if it is a video, otherwise nothing. */
function videoInSelection(): string | null {
  const one = selection[0];
  return selection.length === 1 && one?.kind === "video" ? one.path : null;
}

/**
 * Is this path audio?
 *
 * By extension, because the caller has a path and not a listing entry — the
 * player is opened with a string and the editor has to be chosen from that
 * alone. The same table the file grid classifies with, so the two never
 * disagree about what a `.m4a` is.
 */
const isAudioPath = (path: string): boolean => kindForExt(extOf(path)) === "audio";

/** The same, for audio. */
function audioInSelection(): string | null {
  const one = selection[0];
  return selection.length === 1 && one?.kind === "audio" ? one.path : null;
}

/**
 * What **T** would transcribe: whatever is playing, or the one selected file
 * that has a soundtrack.
 *
 * Video counts as much as audio — a recorded call is an `.mp4` far more often
 * than it is a `.wav`, and the audio is decoded out of it either way.
 */
function speechInSelection(): string | null {
  if (player.isOpen && player.openPath) return player.openPath;
  const one = selection[0];
  if (selection.length !== 1 || !one) return null;
  return one.kind === "audio" || one.kind === "video" ? one.path : null;
}

/**
 * What **Shift+T** would open: a subtitle file, or something to subtitle.
 *
 * A `.srt` counts, and so does the video or recording it would sit against —
 * the panel handles both, and which one is selected is an accident of what the
 * user happened to click on.
 */
function subtitleInSelection(): string | null {
  const one = selection[0];
  if (selection.length === 1 && one && SUBTITLE_EXTS.includes(extOf(one.name))) return one.path;
  return speechInSelection();
}

/**
 * What **R** would read: the one picture or PDF that is selected.
 *
 * Deliberately not "the file being previewed" as well. OCR takes seconds and
 * warms the machine up, and a key that starts it on whatever happened to be
 * under the cursor is a key people learn not to press.
 */
function ocrInSelection(): string | null {
  const one = selection[0];
  if (selection.length !== 1 || !one) return null;
  return OCR_EXTS.includes(extOf(one.name)) ? one.path : null;
}

/**
 * What **Shift+S** would sign: the one document or picture that is selected.
 *
 * Deliberately the selection and not what is being previewed, for the same
 * reason as OCR: a key that opens a full-screen editor on whatever happened to
 * be under the cursor is a key you learn to avoid.
 */
function signInSelection(): string | null {
  const one = selection[0];
  if (selection.length !== 1 || !one) return null;
  return SIGN_EXTS.includes(extOf(one.name)) ? one.path : null;
}

/**
 * Open the subtitle panel on whatever was chosen.
 *
 * The interesting case is a sidecar picked on its own. A `.srt` without its
 * film is a list of times against nothing, so the film is looked for in the
 * folder that is already listed — by name, allowing the language suffix that
 * every player expects (`talk.en.srt` belongs to `talk.mp4`). Finding it is
 * cheap and the alternative is asking the user to go and select the pair.
 */
async function openSubtitles(path: string): Promise<void> {
  player.close();
  if (!SUBTITLE_EXTS.includes(extOf(path))) {
    await subs.open(path);
    return;
  }

  const name = path.split(/[\\/]/).pop() ?? path;
  // `talk.en.srt` → `talk`, `talk.srt` → `talk`.
  const stem = name.replace(/\.[^.]+$/, "").replace(/\.[a-z]{2,3}(-[A-Za-z]{2,4})?$/, "");
  const film = listed.find(
    (f) =>
      (f.kind === "video" || f.kind === "audio") &&
      f.name.replace(/\.[^.]+$/, "").toLowerCase() === stem.toLowerCase(),
  );

  let text = "";
  if (native) {
    try {
      const bytes = new Uint8Array(await native.readHead(path, 8_000_000));
      text = new TextDecoder().decode(bytes);
    } catch {
      flash(`${name} could not be read.`);
      return;
    }
  }
  await subs.open(film ? film.path : path, { text });
}

/**
 * Join recordings end to end.
 *
 * Deliberately separate from `joinClips` rather than a branch inside it: the
 * video join builds a `Job` and this builds an `AudioJob`, and the two go to
 * different commands. Sharing the function would mean one that decides which
 * encoder it is halfway down its own body.
 */
function joinAudio(files: FileEntry[]): void {
  if (!native || files.length < 2) return;
  const first = files[0];
  if (!first) return;
  const dir = first.path.slice(0, first.path.lastIndexOf("/"));
  const out = `${dir}/joined-${files.length}-tracks.m4a`;
  flash(`Joining ${files.length} recordings → ${out.split("/").pop() ?? ""}…`);
  void native
    .runAudioJob({ inputs: files.map((f) => f.path), output: out })
    .then((id) => { joining = id; })
    .catch((e: unknown) => flash(`Could not start the join — ${String(e)}`));
}

function joinClips(clips: FileEntry[]): void {
  if (!native || clips.length < 2) return;
  const first = clips[0];
  if (!first) return;
  const dir = first.path.slice(0, first.path.lastIndexOf("/"));
  const out = `${dir}/joined-${clips.length}-clips.mp4`;
  flash(`Joining ${clips.length} clips → ${out.split("/").pop() ?? ""}…`);
  void native
    .runJob({ inputs: clips.map((c) => c.path), output: out })
    .then((id) => { joining = id; })
    .catch((e: unknown) => flash(`Could not start the join — ${String(e)}`));
}

function shareSelection(): void {
  if (!native) return;
  if (selection.length === 0) {
    flash("Select something to share first");
    return;
  }
  void native
    .shareFiles(selection.map((e) => e.path))
    .catch((e: unknown) => { flash(`Share sheet unavailable (${String(e)}) — ctrl+C copies the files instead`); });
}

function humanBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

// ── Command palette ───────────────────────────────────────────────────────

/**
 * Rebuilt on every open. Half of these depend on where you are and what is
 * selected, and a stale command that acts on the previous folder is worse than
 * no command at all.
 */
function commands(): Command[] {
  const out: Command[] = [];
  const one = selection[0];

  for (const place of places) {
    if (place.path === undefined) continue;
    const target = place.path;
    out.push({
      id: `go:${place.id}`,
      title: `Go to ${place.name}`,
      hint: target,
      group: "Go",
      run: () => void navigate(target),
    });
  }

  out.push(
    { id: "nav.up", title: "Go up one level", hint: "↑", group: "Go", run: goUp },
    { id: "nav.back", title: "Go back", hint: keyHint(KEY_ID.back), group: "Go", run: goBack },
    { id: "nav.reload", title: "Reload this folder", hint: keyHint(KEY_ID.reload), group: "Go", run: reload },
  );

  // Item 38. One entry, not two: the palette shows whichever of pin/unpin is the
  // thing you can currently do, because a list offering both for the same folder
  // makes you read them to find out which one is live.
  {
    const here = places.find((p) => p.path !== undefined && userPlaces.has(cwd, [p]));
    out.push(
      here === undefined
        ? {
            id: "place.pin",
            title: `Pin ${nameFor(cwd)} to the sidebar`,
            hint: cwd,
            group: "Go",
            run: () => {
              userPlaces.pin(cwd);
              refreshPlaces();
              flash(`Pinned ${nameFor(cwd)}`);
            },
          }
        : {
            id: "place.unpin",
            title: `Take ${here.name} out of the sidebar`,
            hint: cwd,
            group: "Go",
            run: () => {
              userPlaces.remove(here.id);
              refreshPlaces();
              flash(`Removed ${here.name}`);
            },
          },
    );
    out.push({
      id: "place.edit",
      title: "Edit the sidebar…",
      group: "Go",
      run: openPlaces,
    });
  }

  if (one) {
    out.push(
      { id: "file.open", title: `Open ${one.name}`, hint: keyHint(KEY_ID.open), group: "File", run: () => openEntry(one) },
      { id: "file.look", title: `Quick look at ${one.name}`, hint: keyHint(KEY_ID.quickLook), group: "File", run: () => void quickLook.show(one) },
    );
    /*
     * Open with (item 40).
     *
     * One command per handler that can take this file, each opening it that way
     * *once* — the persistent decision lives in the sheet below. They are their
     * own group so `Open with*` can be added to the right-click menu by anyone
     * who wants the whole row of them inline, and so they read as one block in
     * Ctrl+K; there are no submenus in this menu and adding one for this would
     * be a whole new interaction for nine rows.
     *
     * The handler that would run anyway is skipped, because "Open" is already
     * the row above and offering the same act twice under two names is how a
     * menu stops being read.
     */
    if (one.kind !== "folder") {
      const usable = handlersFor(one.kind, one.ext);
      const already = resolveOpen(one, userOpens, usable);
      for (const h of HANDLERS) {
        if (h.id === already || !usable.includes(h.id)) continue;
        out.push({
          id: `open:${h.id}`,
          title: `Open with ${h.label.toLowerCase()}`,
          hint: h.blurb,
          group: "Open with",
          run: () => openWith(one, h.id),
        });
      }
      // The decision, as opposed to the one-off. Named after the extension
      // because that is the scope it actually sets, and in group File so the
      // shipped menu's `File*` reaches it without anyone editing their line.
      out.push({
        id: "file.openwith",
        title: one.ext === "" ? "Choose what opens files like this…" : `Always open .${one.ext} with…`,
        hint: already === null ? "" : `now: ${handlerLabel(already).toLowerCase()}`,
        group: "File",
        run: () => openAssociations(one.ext),
      });
    }
    // Phrased as the question people actually have. "EXIF" is the format's
    // name, not the thing anyone wants to know.
    out.push({
      id: "file.meta",
      title:
        selection.length > 1
          ? `What ${selection.length} files say about you`
          : `What ${one.name} says about you`,
      hint: keyHint(KEY_ID.info, "metadata, GPS, remove"),
      group: "File",
      run: () => void metaPanel.show(selection),
    });
    if (native) {
      // Offered for every file, not only for the ones that open here by
      // double-click: a tab-delimited `.txt` or an extensionless export is a
      // table, and the person looking at it knows that better than the
      // extension does.
      out.push({
        id: "file.table",
        title: `Open ${one.name} as a table`,
        hint: keyHint(KEY_ID.table, "csv, tsv, xlsx, parquet"),
        group: "File",
        run: () => void table.open(one),
      });
      // Deliberately in its own group and phrased for someone who already knows
      // what they want. It is not a thing to stumble into.
      out.push({
        id: "file.hex",
        title: `Inspect the bytes of ${one.name}`,
        hint: keyHint(KEY_ID.hex, "hex, structure, search"),
        group: "Advanced",
        run: () => void inspector.open(one),
      });
      if (one.kind === "video") {
        out.push({
          id: "video.edit",
          title: `Edit ${one.name}`,
          hint: keyHint(KEY_ID.edit, "trim, cut, crop, rotate, speed"),
          group: "File",
          run: () => void vedit.open(one.path),
        });
        const clips = selection.filter((e) => e.kind === "video");
        if (clips.length > 1) {
          out.push({
            id: "video.join",
            title: `Join ${clips.length} clips into one`,
            hint: "in the order they are sorted here",
            group: "File",
            run: () => void joinClips(clips),
          });
        }
      }
      // Offered for both, and worded for what the user has rather than for the
      // model: "transcribe" is what you want done to a meeting recording
      // whether it arrived as an .m4a or as an .mp4 of the call.
      if (one.kind === "audio" || one.kind === "video") {
        out.push({
          id: "file.transcribe",
          title: `Transcribe ${one.name}`,
          hint: keyHint(KEY_ID.transcribe, "words, timestamps, who said what"),
          group: "File",
          run: () => void scribe.open(one.path),
        });
        out.push({
          id: "file.subtitles",
          title: `Subtitles for ${one.name}`,
          hint: keyHint(KEY_ID.subtitles, "write, fix, export .srt, burn in"),
          group: "File",
          run: () => void openSubtitles(one.path),
        });
      }
      // Pictures and PDFs, which is nearly everything a scan arrives as.
      if (OCR_EXTS.includes(extOf(one.name))) {
        out.push({
          id: "file.ocr",
          title: `Read the text in ${one.name}`,
          hint: keyHint(KEY_ID.ocr, "OCR — copy the text, or save a searchable PDF"),
          group: "File",
          run: () => {
            viewer.close();
            void ocr.open(one.path);
          },
        });
      }
      // Anything you would put your name on: a contract, a form, a photo of a
      // form. Same test as OCR because it is the same set of files.
      if (SIGN_EXTS.includes(extOf(one.name))) {
        out.push({
          id: "file.sign",
          title: `Sign ${one.name}`,
          hint: keyHint(KEY_ID.sign, "signature, initials, watermark"),
          group: "File",
          run: () => {
            viewer.close();
            void signView.open(one.path);
          },
        });
        // Separate rows rather than a note under Sign: someone blacking out an
        // address is not thinking about signatures, and a command palette is
        // searched by the word you have in mind.
        out.push({
          id: "file.redact",
          title: `Black out part of ${one.name}`,
          hint: "cover an area and destroy the text underneath it",
          group: "File",
          run: () => {
            viewer.close();
            void signView.open(one.path, "redact");
          },
        });
        out.push({
          id: "file.crop",
          title: `Crop ${one.name}`,
          hint: "trim the margins off a page or off every page",
          group: "File",
          run: () => {
            viewer.close();
            void signView.open(one.path, "crop");
          },
        });
      }
      // A sidecar picked on its own opens against the film beside it.
      if (SUBTITLE_EXTS.includes(extOf(one.name))) {
        out.push({
          id: "file.subtitles.edit",
          title: `Edit ${one.name}`,
          hint: keyHint(KEY_ID.subtitles, "timings, wording, line breaks"),
          group: "File",
          run: () => void openSubtitles(one.path),
        });
      }
      if (one.kind === "audio") {
        out.push({
          id: "audio.edit",
          title: `Edit ${one.name}`,
          hint: keyHint(KEY_ID.edit, "trim, level, normalise, fades, speed"),
          group: "File",
          run: () => void aedit.open(one.path),
        });
        const tracks = selection.filter((e) => e.kind === "audio");
        if (tracks.length > 1) {
          out.push({
            id: "audio.join",
            title: `Join ${tracks.length} recordings into one`,
            hint: "in the order they are sorted here",
            group: "File",
            run: () => void joinAudio(tracks),
          });
        }
      }
      // Both, and adjacent, because which one is right depends entirely on
      // where it is going and the person choosing already knows.
      out.push(
        {
          id: "file.share",
          title: selection.length > 1 ? `Share ${selection.length} items` : `Share ${one.name}`,
          hint: keyHint(KEY_ID.share, "mail, phone, nearby"),
          group: "File",
          run: shareSelection,
        },
        {
          id: "file.copyfiles",
          title: selection.length > 1 ? `Copy ${selection.length} items` : `Copy ${one.name}`,
          hint: keyHint(KEY_ID.copy, "the files, to paste anywhere"),
          group: "File",
          run: copySelection,
        },
      );
      // ── Batch (item 26) ───────────────────────────────────────────────
      //
      // Offered for a single file too. "Convert forty" and "convert one" are
      // the same operation, and a queue that only appears above some threshold
      // is a rule to remember rather than a tool to reach for.
      {
        const pics = selection.filter((e) => e.kind === "image");
        if (pics.length > 0) {
          out.push({
            id: "batch.clean",
            title: `Queue: remove metadata from ${countOf(pics, "picture")}`,
            hint: "writes -clean copies · originals untouched",
            group: "Batch",
            run: () => {
              queue.addMany("meta.clean", pics.map((p) => p.path), (path) => ({
                title: `Clean ${baseName(path)}`,
                params: { mode: "copy" },
              }));
              batchPanel.show();
            },
          });
          out.push({
            id: "batch.auto",
            title: `Queue: auto-blur ${countOf(pics, "picture")}`,
            hint: "faces, plates, screens, codes… every category switched on in Auto-blur · writes -blurred copies",
            group: "Batch",
            run: () => {
              const config = autoBlurStore().get();
              queue.addMany("auto.blur", pics.map((p) => p.path), (path) => ({
                title: `Auto-blur ${baseName(path)}`,
                params: { config },
              }));
              batchPanel.show();
            },
          });
          out.push({
            id: "batch.faces",
            title: `Queue: blur faces in ${countOf(pics, "picture")}`,
            hint: "writes -blurred copies · nothing written where no face is found",
            group: "Batch",
            run: () => {
              queue.addMany("faces.blur", pics.map((p) => p.path), (path) => ({
                title: `Blur faces in ${baseName(path)}`,
                params: {},
              }));
              batchPanel.show();
            },
          });
        }
        const tracks = selection.filter((e) => e.kind === "audio");
        if (tracks.length > 0) {
          out.push({
            id: "batch.audio",
            title: `Queue: convert ${countOf(tracks, "recording")} to MP3`,
            hint: "192 kbps · beside the originals",
            group: "Batch",
            run: () => {
              queue.addMany("audio.convert", tracks.map((t) => t.path), (path) => ({
                title: `MP3 ${baseName(path)}`,
                params: { format: "mp3", bitrate: 192 },
              }));
              batchPanel.show();
            },
          });
        }
        const clips = selection.filter((e) => e.kind === "video");
        if (clips.length > 0) {
          out.push({
            id: "batch.video",
            title: `Queue: convert ${countOf(clips, "video")} to MP4`,
            hint: "H.264 · beside the originals",
            group: "Batch",
            run: () => {
              queue.addMany("video.convert", clips.map((c) => c.path), (path) => ({
                title: `MP4 ${baseName(path)}`,
                params: { format: "mp4", quality: 20 },
              }));
              batchPanel.show();
            },
          });
        }
      }
      /*
       * Your own actions (item 39).
       *
       * Registered here rather than in a registry of their own, which is the
       * whole point of the design: an action becomes an ordinary command, so
       * the right-click menu, Ctrl+K and the shortcut editor all pick it up
       * without any of them knowing that user actions exist.
       *
       * Only the runnable ones, and only where they apply — a half-typed action
       * that appeared in the palette and then failed on a missing program would
       * be a worse answer than not being offered yet.
       */
      for (const action of userActions.runnable()) {
        if (!appliesTo(action, selection)) continue;
        out.push({
          id: commandIdFor(action),
          title: action.label,
          hint: `${action.program}${selection.length > 1 && action.each ? ` · ${selection.length} times` : ""}`,
          group: "Yours",
          run: () => void runAction(action),
        });
      }
      out.push(
        { id: "file.external", title: "Open in the default app", group: "File", run: () => void native.openExternal(one.path) },
        { id: "file.reveal", title: "Show in File Explorer", group: "File", run: () => void native.revealInShell(one.path) },
        { id: "file.copypath", title: "Copy path", hint: one.path, group: "File", run: () => void navigator.clipboard.writeText(one.path) },
      );
    }
  }

  for (const [key, name] of SORT_LABELS) {
    // Lower-cased because the title reads "Sort by date modified" — the table
    // is written for the menu, which uses the labels as they stand.
    const label = name.toLowerCase();
    const cmd: Command = {
      id: `sort:${key}`,
      title: `Sort by ${label}`,
      group: "View",
      // Same function the list's column headers call, so the header arrow and
      // the palette's "current ↑" can never disagree about the sort.
      run: () => sortBy(key),
    };
    // Assigned rather than passed as `undefined`: exactOptionalPropertyTypes
    // makes an explicit undefined a different type from an absent key.
    if (view.sort === key) cmd.hint = view.ascending ? "current ↑" : "current ↓";
    out.push(cmd);
  }

  out.push(
    // One command per mode rather than one that toggles: the palette is where
    // you go when you know what you want, and "switch to the next layout" is
    // not something anybody wants. The key is still the cycle.
    ...MODES.filter((m) => m.id !== mode).map((m): Command => ({
      id: `view.mode.${m.id}`,
      title: `Switch to ${m.label.toLowerCase()}`,
      hint: m.blurb,
      group: "View",
      run: () => setMode(m.id),
    })),
    {
      id: "view.hidden",
      title: view.showHidden ? "Hide hidden files" : "Show hidden files",
      group: "View",
      run: () => settings.set(PREF.showHidden, !view.showHidden),
    },
    {
      id: "view.filter",
      title: "Filter this folder",
      hint: keyHint(KEY_ID.filter, "kind:image  size:>2mb  modified:today"),
      group: "View",
      run: () => filterBar.focus(),
    },
    {
      id: "view.tree",
      title: tree.visible ? "Hide the folder tree" : "Show the folder tree",
      hint: keyHint(KEY_ID.sidebar),
      group: "View",
      run: () => { tree.toggle(); void tree.reveal(cwd); },
    },
    {
      id: "view.foldersfirst",
      title: view.foldersFirst ? "Mix folders in with files" : "Keep folders first",
      group: "View",
      run: () => settings.set(PREF.foldersFirst, !view.foldersFirst),
    },
    // Only when there is one to clear — the palette is rebuilt on every open, so
    // a command that would do nothing simply is not offered.
    ...(query.empty
      ? []
      : ([{
          id: "view.filter.clear",
          title: "Clear the filter",
          hint: `${entries.length} of ${listed.length} showing`,
          group: "View",
          run: () => setFilter(""),
        }] satisfies Command[])),
    // Saved filters are reachable from the palette as well as from the box's
    // own menu: a saved filter is a thing you go and get, and this is where
    // everything else in FACET is gone and got.
    ...rules.all().map((f): Command => ({
      id: `filter:${f.name}`,
      title: `Filter: ${f.name}`,
      hint: f.query,
      group: "View",
      run: () => setFilter(f.query),
    })),
    // Card geometry means something wherever there are cards — the canvas, the
    // gallery, and the columns, which take their width from the same number.
    // Offering "bigger cards" while looking at a list is a command that appears
    // to do nothing, so the list does not get it.
    ...(mode !== "list"
      ? ([
          { id: "view.bigger", title: "Bigger cards", hint: keyHint(KEY_ID.bigger), group: "View", run: () => setFolderCardSize(view.cardSize + 30) },
          { id: "view.smaller", title: "Smaller cards", hint: keyHint(KEY_ID.smaller), group: "View", run: () => setFolderCardSize(view.cardSize - 30) },
          // Fitting is a canvas idea: it is the only view with a viewport
          // that can be anywhere. A grid is always already fitted.
          ...(mode === "canvas"
            ? [{ id: "view.fit", title: "Fit everything to the view", group: "View", run: fitAll }]
            : []),
          {
            id: "view.namelines",
            title: "Show more of each file name",
            hint: `${view.nameLines} line${view.nameLines === 1 ? "" : "s"}`,
            group: "View",
            // Cycles rather than toggles, because how much name you need depends
            // on the folder — one line for Documents, four for a camera roll.
            run: () => settings.set(PREF.nameLines, (view.nameLines % 4) + 1),
          },
        ] satisfies Command[])
      : []),
    {
      // Not conditional on there being anything in it: "is it still going?" is
      // exactly the moment you want this, and an empty queue answers that too.
      id: "batch.show",
      title: queue.pending() > 0 ? `Show the queue (${queue.pending()} to go)` : "Show the queue",
      hint: keyHint(KEY_ID.batch),
      group: "Batch",
      run: () => batchPanel.toggle(),
    },
    {
      id: "watch.rules",
      title: watchCount() > 0 ? `Watch folders (${watchCount()} running)` : "Watch folders",
      hint: keyHint(KEY_ID.watch),
      group: "Batch",
      run: () => watchPanel.toggle(),
    },
    {
      // Offered from wherever you are, because the folder you are looking at is
      // almost always the one you want watched — that is why you noticed.
      id: "watch.here",
      title: "Watch this folder…",
      hint: baseName(cwd),
      group: "Batch",
      run: () => {
        watchPanel.show();
        watchPanel.useCurrentFolder();
      },
    },
    {
      // Findable by "webcam" and "photo" as well as by its own name, because
      // a camera inside a file explorer is the last thing anyone will guess is
      // in here.
      id: "camera.open",
      title: "Camera",
      // The hint is part of what the palette searches, so the words someone
      // would actually type go in it rather than into a keywords field the
      // Command type does not have.
      hint: "webcam — take a photo, record a clip",
      group: "Batch",
      run: () => void camera.open(),
    },
    {
      id: "recorder.open",
      title: "Record",
      // "Screen capture", "screen recorder" and "voice memo" are all things
      // someone would type looking for this, and none of them is its name.
      hint: "screen capture, system sound, microphone — meetings and voice memos",
      group: "Batch",
      run: () => void recorder.open(),
    },
    {
      id: "scribe.open",
      title: "Transcribe",
      // "Subtitles", "captions" and "minutes" are all what somebody is after
      // when they come looking for this, and none of them is its name.
      hint: "speech to text — words, timestamps, who said what",
      group: "Batch",
      run: () => {
        const heard = speechInSelection();
        if (heard) void scribe.open(heard);
        else flash("Select a recording or a video first.");
      },
    },
    {
      id: "subs.open",
      title: "Subtitles",
      hint: keyHint(KEY_ID.subtitles, "write, fix, export .srt or .vtt, burn in"),
      group: "Batch",
      run: () => {
        const target = subtitleInSelection();
        if (target) void openSubtitles(target);
        else flash("Select a video, a recording, or a .srt first.");
      },
    },
    {
      id: "ocr.open",
      title: "Read the text in this",
      hint: keyHint(KEY_ID.ocr, "OCR a scan, photo or PDF; searchable PDF out"),
      group: "Batch",
      run: () => {
        const seen = ocrInSelection();
        if (seen) {
          viewer.close();
          void ocr.open(seen);
        } else flash("Select a picture or a PDF first.");
      },
    },
    {
      id: "sign.open",
      title: "Sign or watermark this",
      hint: keyHint(KEY_ID.sign, "place a signature, stamp DRAFT across every page"),
      group: "Batch",
      run: () => {
        const doc = signInSelection();
        if (doc) {
          viewer.close();
          void signView.open(doc);
        } else flash("Select a PDF or a picture first.");
      },
    },
    {
      id: "prefs.open",
      title: "Settings",
      hint: keyHint(KEY_ID.settings),
      group: "View",
      run: () => prefs.open(),
    },
    {
      id: "menu.edit",
      title: "Edit the right-click menu…",
      hint: "and write your own actions",
      group: "View",
      run: openMenuBuilder,
    },
    {
      // Findable by the words people reach for — "shortcut", "hotkey", "rebind"
      // — rather than only by the one this app happens to print on the row.
      id: "keys.open",
      title: "Keyboard shortcuts",
      hint: keyHint(KEY_ID.shortcuts, "rebind anything"),
      group: "View",
      run: () => keysPanel.open(),
    },
    {
      // Reachable without a file selected, which is the case where you already
      // know what you want to change and do not want to go and find one.
      id: "view.opens",
      title: "What opens what…",
      hint: "file associations, by kind and extension",
      group: "View",
      run: () => openAssociations(),
    },
    { id: "view.address", title: "Edit the path", hint: keyHint(KEY_ID.address), group: "Go", run: editAddress },
    { id: "view.copycwd", title: "Copy this folder's path", hint: cwd, group: "Go", run: () => void navigator.clipboard.writeText(cwd) },
  );

  for (const t of themes.all) {
    out.push({
      id: `theme:${t.id}`,
      title: `Theme: ${t.name}`,
      hint: t.id === themes.active.id ? "current" : t.mode,
      group: "Theme",
      run: () => { themes.apply(t.id); renderTopbar(); },
    });
  }

  return out;
}

/** Enabled watch rules. Paused ones are not "running" and should not count. */
function watchCount(): number {
  return watcher.rules().filter((r) => r.enabled).length;
}

/** "3 pictures" / "1 picture" — the count and the noun agreeing, in one place. */
function countOf(items: readonly FileEntry[], noun: string): string {
  return `${items.length} ${noun}${items.length === 1 ? "" : "s"}`;
}

function baseName(path: string): string {
  // The trailing slash matters now that drop targets get named in messages:
  // `C:/` would otherwise have no name at all.
  const clean = path.replace(/\/+$/, "");
  const name = clean.slice(clean.lastIndexOf("/") + 1);
  return name === "" ? clean : name;
}

const palette = new Palette(commands);

// ── Settings ──────────────────────────────────────────────────────────────

const prefs = new SettingsPanel(settings);

/*
 * The theme is a contributed row rather than a setting.
 *
 * It looks like a plain choice, and it is not: the list changes as you author
 * themes, and the theme engine already persists the active id, the favourites
 * and the user-authored palettes. Declaring it as a `choice` would mean a
 * snapshot of the options taken at import time and a second copy of the active
 * id — so a theme created this session would be missing from the list, and
 * whichever store was read last would win on the next launch. The panel shows
 * it; the theme engine owns it.
 */
prefs.addCustom({
  group: "Appearance",
  label: "Theme",
  help: "Ported palettes and anything you have authored. ★ marks a favourite.",
  keywords: ["colour", "color", "dark", "light", "mocha", "palette", "skin"],
  control: () => {
    const sel = themePicker();
    sel.className = "prefs-select";
    return sel;
  },
  sync: (el) => {
    (el as HTMLSelectElement).value = themes.active.id;
  },
});

/*
 * Startup (item 41). Typing a path into a box is the worst way to choose a
 * folder and the only way a text setting offers, so the row gets the answer
 * the app already knows. Clearing it is the ↺ arrow, which is why there is no
 * second button for "go back to wherever I was".
 */
prefs.addAction(PREF.startFolder, "Use this folder", () => {
  settings.set(PREF.startFolder, cwd);
});

/*
 * Columns and card details (item 36).
 *
 * The stored value is a line of field ids and stays that way — it is readable,
 * hand-editable and survives a settings backup. What it is not is a decent way
 * to *ask* for the answer, so both rows keep the box and grow a Choose… button
 * onto the one panel that edits either of them. Settings stays open behind it:
 * unlike the shortcut editor this is a two-click errand you come straight back
 * from, and the folder repainting underneath is the point.
 */
const fieldsPanel = new FieldsPanel();

prefs.addAction(PREF.columns, "Choose…", () => {
  fieldsPanel.open({
    title: "Columns",
    blurb: "What the details list shows, left to right.",
    requireName: true,
    read: () => settings.get<string>(PREF.columns),
    write: (next) => settings.set(PREF.columns, next),
    reset: () => settings.reset(PREF.columns),
  });
});

prefs.addAction(PREF.cardFields, "Choose…", () => {
  fieldsPanel.open({
    title: "Card details",
    blurb: "What a card says under the name. Anything a file has no answer for drops out.",
    read: () => settings.get<string>(PREF.cardFields),
    write: (next) => settings.set(PREF.cardFields, next),
    reset: () => settings.reset(PREF.cardFields),
  });
});

/**
 * The sidebar editor (item 38).
 *
 * A custom row rather than a declared setting, because what it edits is not a
 * value: it is a list of folders that only exists relative to what this machine
 * reports today. There is nothing to put in the schema and nothing sensible for
 * a backup file to carry across to another PC.
 *
 * Every verb re-resolves and redraws through `refreshPlaces`, so the sidebar
 * behind the sheet moves as you edit it. That is the whole design of the panel —
 * see the note at the top of `places-panel.ts`.
 */
const placesPanel = new PlacesPanel();

function openPlaces(): void {
  placesPanel.open({
    current: () => places,
    hidden: () => {
      const gone = new Set(userPlaces.hiddenIds());
      return discovered.filter((p) => gone.has(p.id));
    },
    cwd: () => cwd,
    has: (path) => userPlaces.has(path, places),
    pin: (path) => {
      userPlaces.pin(path);
      refreshPlaces();
      flash(`Pinned ${nameFor(path)}`);
    },
    remove: (id) => {
      userPlaces.remove(id);
      refreshPlaces();
    },
    restore: (id) => {
      userPlaces.restore(id);
      refreshPlaces();
    },
    rename: (id, name) => {
      userPlaces.rename(id, name);
      refreshPlaces();
    },
    move: (id, delta) => {
      userPlaces.move(id, delta, places);
      refreshPlaces();
    },
    reset: () => {
      userPlaces.reset();
      refreshPlaces();
      flash("Sidebar put back");
    },
  });
}

prefs.addCustom({
  group: "Explorer",
  label: "Places",
  help: "Which folders the sidebar lists, what they are called and in what order.",
  keywords: ["sidebar", "pin", "shortcut", "quick access", "favourites", "favorites", "rail"],
  control: () => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "prefs-btn";
    b.textContent = "Edit…";
    b.addEventListener("click", openPlaces);
    return b;
  },
  changed: () => userPlaces.touched(),
  reset: () => {
    userPlaces.reset();
    refreshPlaces();
  },
});

/**
 * The right-click menu and the actions behind it (item 39).
 *
 * `ContextMenu` is handed the same `commands()` the palette gets and a line of
 * ids saying which of them to draw, so there is nothing here that decides what
 * a menu contains — that is `@core/explorer/menu`, and it is tested without a
 * DOM. All this function does is say where.
 */
const ctxMenu = new ContextMenu();
const menuPanel = new MenuPanel();

function openContextMenu(x: number, y: number): void {
  ctxMenu.open({
    x,
    y,
    line: settings.get<string>(PREF.menu),
    commands: commands(),
    edit: openMenuBuilder,
  });
}

/**
 * Run a user action.
 *
 * The two shapes are genuinely different operations and the action says which:
 * `each` spawns one process per file — a converter — and the other spawns one
 * process holding the whole selection — an archiver. Guessing from the argument
 * line would be wrong half the time, and wrong here means forty windows.
 *
 * Failures are reported per run rather than swallowed, because the failure that
 * actually happens is a mistyped program name and it happens on the first file.
 */
async function runAction(action: UserAction): Promise<void> {
  if (native === null) {
    flash("Running another program needs the desktop app");
    return;
  }
  const paths = selection.map((e) => e.path);
  if (paths.length === 0) return;

  const runs: Array<{ path?: string; paths: readonly string[] }> = action.each
    ? paths.map((p) => ({ path: p, paths: [p] }))
    : [{ paths }];

  let failed = "";
  for (const run of runs) {
    const args = buildArgs(action, { ...run, folder: cwd });
    try {
      await native.runProgram(action.program, args, cwd);
    } catch (err) {
      failed = String(err);
      // One bad program name would otherwise produce forty identical toasts.
      break;
    }
  }
  flash(
    failed !== ""
      ? `${action.label}: ${failed}`
      : `${action.label} · ${runs.length === 1 ? "started" : `${runs.length} started`}`,
  );
}

function openMenuBuilder(): void {
  menuPanel.open({
    read: () => settings.get<string>(PREF.menu),
    write: (next) => settings.set(PREF.menu, next),
    reset: () => settings.reset(PREF.menu),
    // What the *palette* would show right now. The panel adds the user's own
    // actions on top, because those have to be listable even when the current
    // selection does not qualify for them.
    catalogue: () => commands().map((c) => ({ id: c.id, title: c.title, group: c.group })),
    actions: () => userActions.all(),
    addAction: () => userActions.add(),
    updateAction: (id, patch) => userActions.update(id, patch),
    removeAction: (id) => {
      userActions.remove(id);
      // The menu line may still name it. Left alone deliberately: `buildMenu`
      // drops ids nothing offers, and stripping it here would silently edit a
      // line the user wrote if they delete an action and undo by re-adding it.
    },
    moveAction: (id, delta) => userActions.move(id, delta),
  });
}

prefs.addAction(PREF.menu, "Choose…", openMenuBuilder);

/*
 * Item 40 — the associations sheet.
 *
 * `availableFor` and `explain` both go through the same `handlersFor` and
 * `resolveOpen` the double-click uses, which is the point of having written
 * them: the sheet cannot disagree with what actually happens, because it is
 * asking the thing that happens.
 */
const opensPanel = new OpensPanel();

function openAssociations(focusExt?: string): void {
  opensPanel.open(
    {
      forKind: (kind) => userOpens.forKind(kind),
      setKind: (kind, handler) => userOpens.setKind(kind, handler),
      extensions: () => userOpens.extensions(),
      setExt: (ext, handler) => userOpens.setExt(ext, handler),
      reset: () => userOpens.reset(),
      availableFor: (kind, ext) => handlersFor(kind, ext),
      // The folder on screen, because that is where the thought "not this one"
      // comes from. Each extension carries the kind the explorer gave it, so the
      // sheet can say what a .jpg does today without guessing.
      nearby: () =>
        entries
          .filter((e) => e.kind !== "folder" && e.ext !== "")
          .map((e) => [e.ext, e.kind] as const),
      explain: (kind, ext) => ({
        ...userOpens.choose({ kind, ext }),
        actual: resolveOpen({ kind, ext }, userOpens, handlersFor(kind, ext)),
      }),
    },
    focusExt,
  );
}

prefs.addCustom({
  group: "Explorer",
  label: "What opens what",
  help: "Which part of FACET opens a file when you double-click it — and the exceptions, by extension.",
  keywords: ["association", "default", "open with", "handler", "double click", "extension", "file type"],
  control: () => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "prefs-btn";
    b.textContent = "Choose…";
    b.addEventListener("click", () => openAssociations());
    return b;
  },
  changed: () => userOpens.touched(),
  reset: () => userOpens.reset(),
});

/*
 * Item 37's escape hatch. Per-folder memory accumulates silently and there has
 * to be a way to take it all back without hunting for the folders it happened
 * in — and it says how many it forgot, because a button that clears something
 * invisible should prove it did.
 */
prefs.addAction(PREF.rememberFolders, "Forget them all", () => {
  const n = rules.count();
  rules.forgetAll();
  applyFolderRule(cwd);
  reflow();
  flash(n === 0 ? "Nothing was remembered" : `Forgot ${n} folder${n === 1 ? "" : "s"}`);
});

/*
 * The settings file (item 42).
 *
 * Only when there is a real filesystem under us. In a browser tab the backup
 * box stays copy-and-paste, which is not a degraded mode — it is how the
 * settings move between machines when one of them is a phone.
 *
 * There is no file dialog here on purpose. The explorer *is* the file picker:
 * a save lands in the folder on screen and a load reads the file that is
 * selected, so both ends of "portable between machines" are done with the
 * window the user is already looking at.
 */
if (native) {
  const io = native;
  prefs.useFiles({
    suggest: () => `${cwd}/facet-settings.json`,
    // `overwrite: false`, so a second save writes `facet-settings-2.json`
    // rather than quietly replacing the export taken before a change.
    save: (path, text) => io.writeFile(path, new TextEncoder().encode(text), false),
    pick: () => {
      const one = selection.length === 1 ? selection[0] : undefined;
      return one !== undefined && one.kind !== "folder" ? one.path : null;
    },
    load: async (path) => {
      // 1 MB is far more than any settings file, and clamps a mis-selected
      // 4 GB video to something the JSON parser can refuse quickly.
      const bytes = await io.readHead(path, 1_048_576);
      return new TextDecoder().decode(new Uint8Array(bytes));
    },
  });
}

/** Live application. One subscription, one reducer — see `applyPref`. */
settings.onAny((id) => applyPref(id));

// ── Shortcuts (item 35) ───────────────────────────────────────────────────

const keysPanel = new KeysPanel(keys);

/*
 * The keyboard is a contributed row for the same reason the theme is: it is a
 * map of twenty commands with its own file and its own conflict rules, not a
 * scalar, and mirroring it into the settings store would give it two sources of
 * truth. The row is here so "everything configurable, one place" still holds —
 * you find shortcuts by opening Settings and reading, not by knowing they have
 * their own panel.
 */
prefs.addCustom({
  group: "Appearance",
  label: "Keyboard",
  help: "Every shortcut in the app, rebindable.",
  keywords: ["keys", "shortcut", "binding", "rebind", "hotkey", "accelerator"],
  control: () => {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "prefs-btn";
    open.textContent = "Edit shortcuts…";
    open.addEventListener("click", () => {
      // Rather than stacking sheets: two dimmed layers deep is where a settings
      // surface starts to feel like a maze, and the shortcut editor is a place
      // you go to work, not a detour.
      prefs.close();
      keysPanel.open();
    });
    return open;
  },
  changed: () => keys.changed,
  reset: () => { keys.resetAll(); },
});

keys.onChange(() => {
  // Every label that quotes a shortcut asks the keymap for it (`keyHint`), so
  // the top bar has to be redrawn when one changes. A tooltip that still says
  // Ctrl+K after Ctrl+K was given away is worse than no tooltip: it is the app
  // being confidently wrong about itself.
  renderTopbar();
});

function setCardSize(px: number): void {
  // No clamping here any more: the declared min and max are the clamp, and
  // `coerce` applies them. A second set of bounds in this file is a second set
  // to forget to update.
  settings.set(PREF.cardSize, px);
}

/**
 * Re-filter, re-sort and repaint without a filesystem round-trip.
 *
 * Always from `listed` rather than from `entries`, which is the difference
 * between a filter you can take back and one that eats the folder a keystroke
 * at a time.
 */
/**
 * Filter, sort, then group — in that order, and grouping last on purpose.
 *
 * Grouping reorders the array rather than only labelling it, because every view
 * indexes into the array the shell hands it: the list's virtualiser, the
 * keyboard cursor and shift-range selection all speak in indices, and a drawing
 * order that disagreed with those indices would make a shift-click select files
 * that are nowhere near the two rows you clicked. The sort still decides the
 * order *inside* each group — see `grouping.ts`.
 */
function orderEntries(): FileEntry[] {
  const sorted = sortEntries(applyFilter(listed, query), view);
  // Only where the headings can actually be drawn. The canvas puts files at
  // remembered positions and the columns walk a tree, so neither has anywhere
  // to put a heading -- and grouping that reordered the array without saying so
  // would be a folder that shuffles itself when you switch layout.
  if (mode !== "list" && mode !== "gallery") return sorted;
  return groupedOrder(sorted, view.group, !view.ascending);
}

function reflow(): void {
  entries = orderEntries();
  browser.setEntries(entries);
  renderStatus(selection);
}

// ── Crash recovery ────────────────────────────────────────────────────────

/**
 * What to say after a run that did not get to say goodbye.
 *
 * Deliberately not shown for a clean exit, and not shown after a crash either
 * unless there is something to *do* — a bar that announces a crash and offers
 * nothing is a scare with no remedy attached. The folder is already back by the
 * time this runs; it comes back silently, because reopening where you were is
 * what a file manager does and not an event worth a banner.
 *
 * Nothing here restores anything on its own. The `alive` flag is a heuristic
 * and a machine that lost power mid-write can leave it either way, so it is
 * only ever allowed to decide whether to ask.
 *
 * `replaced` is the same abrupt ending with a known cause -- the app was
 * installed over while it was running. Nothing crashed, so nothing here says
 * so, and with no unsaved edits there is nothing to say at all: offering to
 * reopen the last file after a deliberate update is noise, and the folder is
 * already back.
 */
async function offerRecovery(prior: SessionState, replaced: boolean): Promise<void> {
  const edits = await savedEdits();
  const surface = prior.surface;
  if (edits.length === 0 && (!surface || replaced)) return;

  const bar = document.createElement("div");
  bar.className = "recover";
  // The desktop bar is one row tucked beside the sidebar and above the status
  // bar, neither of which the phone shell has. Same markup, different layout --
  // see `.recover-phone` in phone.css.
  if (isPhone()) bar.classList.add("recover-phone");

  const text = document.createElement("span");
  text.className = "recover-text";
  const how = replaced ? "FACET was updated." : "FACET closed unexpectedly.";
  text.textContent =
    edits.length > 0
      ? `${how} ${edits.length} file${edits.length === 1 ? " has" : "s have"} unsaved edits.`
      : how;
  bar.appendChild(text);

  const act = (label: string, run: () => void): void => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "recover-act";
    b.textContent = label;
    b.addEventListener("click", run);
    bar.appendChild(b);
  };

  // The most recent edit first, since that is the one that was on screen. The
  // rest are still on disk and come back the moment their file is opened; this
  // button is a shortcut, not the mechanism.
  const first = edits[0];
  if (first) {
    act(`Reopen ${first.key.slice(first.key.lastIndexOf("/") + 1)}`, () => {
      bar.remove();
      void openPath(first.key);
    });
  }
  if (surface && surface.path !== first?.key) {
    act(`Reopen ${surface.path.slice(surface.path.lastIndexOf("/") + 1)}`, () => {
      bar.remove();
      void openPath(surface.path);
    });
  }

  const close = document.createElement("button");
  close.type = "button";
  close.className = "recover-close";
  close.title = "Dismiss";
  close.textContent = "✕";
  // Dismiss hides the note and nothing else. The saved edits stay exactly where
  // they are — throwing work away is never a side effect of closing a message.
  close.addEventListener("click", () => bar.remove());
  bar.appendChild(close);

  document.body.appendChild(bar);
}

/**
 * Stand the desktop shell down and put the phone one up.
 *
 * `openPanel` is the whole bridge back: the phone shell handles pictures and
 * video itself and hands everything else to the same `openWith` the desktop
 * uses, so a spreadsheet opened from the Files tab lands in the real table
 * viewer rather than in a second, worse one written for small screens.
 */
function mountPhone(home: string): void {
  document.body.classList.add("fct-phone");
  const phone = new PhoneShell({
    // The mock in a browser tab, exactly as the desktop shell does it. Without
    // this the phone UI could only ever be looked at on a phone, which is why
    // its layout bugs kept reaching the user instead of a screenshot.
    fs: phoneFs,
    home,
    native: native !== null,
    openPanel: (entry, panel, siblings) =>
      openWith(entry, panel as HandlerId, siblings.length > 0 ? [...siblings] : [entry]),
    runTool: phoneTool,
  });
  phone.mount(document.body);
  // The eighteen panels the phone shell delegates to were written for a mouse.
  // This gives their glyph buttons words and their controls a thumb's worth of
  // height; `phone-panels.css` does the layout half.
  fitPanels();
}

/**
 * The other half of the bridge: a tool tile on the phone, to the panel that
 * does the work.
 *
 * Every one of these already exists and is already tested. What the phone build
 * adds is a labelled tile that reaches it — before this, the fifty-odd tools in
 * the app were reachable on a phone only through a right-click menu that a
 * finger cannot open and a command palette that needs a keyboard.
 *
 * Routing is by tool, not by panel, because several tools land in the same
 * place: trim, speed, frame rate, mute, fade and quality are all the video
 * editor, opened on the same file. The panel is where the parameters live; the
 * tile is how you say which one you came for.
 *
 * Returns false for anything with no home, and the caller explains the tool
 * instead of doing nothing.
 */
/**
 * Delete on the phone: a move into `.facet-trash`, never an unlink.
 *
 * Same contract as the picture viewer's delete, and deliberately the same
 * mechanism -- a rename onto the same volume, so it is instant whatever the
 * file weighs, and the file is still there to be put back.
 */
async function trashOne(entry: FileEntry): Promise<void> {
  if (!native) {
    flash("Deleting needs the installed app");
    return;
  }
  const dir = entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/")));
  try {
    await native.moveFile(entry.path, `${dir}/.facet-trash/${entry.name}`, false);
  } catch (e) {
    flash(`Couldn't move it to the trash — ${String(e)}`);
    return;
  }
  quickLook.close();
  flash(`Moved ${entry.name} to trash`);
}

/**
 * The buttons under a document on the phone.
 *
 * Only on the phone: on the desktop the same commands are a keystroke, a
 * right-click and a palette entry away, and the quick-look card is a peek
 * rather than the way a file opens. Here it is the whole surface -- a PDF
 * arrived with a close button and nothing else, which is what "I don't see any
 * edit options I don't see any sign options" is describing.
 *
 * Four, not five: every one of them does something for the file it is shown
 * on. A greyed-out row of five is worse than a working row of four.
 */
function docActions(entry: FileEntry): QuickAction[] {
  if (!isPhone()) return [];
  const act = (glyph: string, label: string, run: () => void): QuickAction =>
    ({ glyph, label, run });
  const tool = (id: string) => () => {
    if (!phoneTool(entry, id)) flash("Not available for this file");
  };

  const out: QuickAction[] = [act("↗", "Share", tool("out.share"))];
  // Sign, watermark, black-out and crop are one panel, entered at four doors.
  if (SIGN_EXTS.includes(entry.ext)) {
    out.push(act("✍", "Sign", tool("sign.doc")));
    out.push(act("■", "Redact", tool("sign.redact")));
    out.push(act("⛶", "Crop", tool("sign.crop")));
  }
  if (entry.ext === "pdf") out.push(act("🔤", "Text", tool("ai.ocr")));
  out.push(act("🗑", "Delete", tool("info.delete")));
  return out;
}

function phoneTool(entry: FileEntry, tool: string): boolean {
  const path = entry.path;
  const isVideo = entry.kind === "video";
  const isAudio = entry.kind === "audio";

  /** Trim, speed, mute, fade, quality: the same editor, chosen by the file. */
  const timeline = (): boolean => {
    if (isVideo) { void vedit.open(path, tool === "blur.video" || tool.startsWith("blur.video.") ? "blur" : "cut"); return true; }
    if (isAudio) { void aedit.open(path); return true; }
    return false;
  };

  switch (tool) {
    // All four tiles land in the same panel — a document you want to both sign
    // and stamp should not cost two round trips — but each enters at its own
    // door, because arriving at a list of signatures after tapping "Watermark"
    // is how a feature ends up reported as missing.
    case "sign.doc":
    case "sign.mark":
    case "sign.redact":
    case "sign.crop":
      if (entry.kind !== "image" && !/\.pdf$/i.test(path)) return false;
      viewer.close();
      // The same panel either way, opened onto the job that was asked for:
      // tapping "Black out" and arriving at a list of signatures is how a
      // feature ends up reported as missing.
      void signView.open(
        path,
        tool === "sign.redact" ? "redact"
          : tool === "sign.crop" ? "crop"
            : tool === "sign.mark" ? "mark" : "sign",
      );
      return true;

    case "ai.ocr":
      viewer.close();
      void ocr.open(path);
      return true;

    case "ai.transcribe":
      if (!isVideo && !isAudio) return false;
      void scribe.open(path);
      return true;

    case "ai.subtitles":
    case "ai.burn":
      if (!isVideo && !isAudio) return false;
      void openSubtitles(path);
      return true;

    case "ai.denoise":
    case "adj.gain":
    case "adj.normal":
    case "adj.mono":
      if (!isAudio) return false;
      void aedit.open(path);
      return true;

    // A video's Blur button. Burned-in blur for a clip is the video editor's
    // job, not the still editor's — the still editor holds one decoded frame.
    case "blur.video":
    case "blur.video.add":
    case "blur.video.track":
    case "blur.video.layers":
    case "tf.trim":
    case "tf.speed":
    case "tf.fps":
    case "tf.join":
    case "adj.fade":
    case "adj.mute":
    case "out.quality":
    case "out.frame":
    case "out.convert":
      return timeline();

    case "out.clean":
      // The batch runner rather than a one-off: it is the same code either way,
      // and going through the queue means the result is visible and cancellable
      // instead of happening silently somewhere.
      queue.addMany("meta.clean", [path], (p) => ({ title: `Clean ${baseName(p)}` }));
      batchPanel.show();
      return true;

    case "out.batch":
      batchPanel.show();
      return true;

    case "out.share":
      if (!native) return false;
      void native.shareFiles([path]).catch((e: unknown) => {
        flash(`Share sheet unavailable (${String(e)})`);
      });
      return true;

    case "info.delete":
      void trashOne(entry);
      return true;

    case "info.meta":
      void metaPanel.show([entry]);
      return true;

    case "info.hex":
      void inspector.open(entry);
      return true;

    case "info.openwith":
      openAssociations();
      return true;

    case "info.watch":
      watchPanel.show();
      return true;

    default:
      return false;
  }
}

/**
 * Run `cb` when the main thread has nothing better to do.
 *
 * `requestIdleCallback` is not in every WebView, and the fallback matters more
 * than usual here: without it the caller silently never runs, and on a phone
 * that means the desktop shell never navigates and every panel opened from the
 * Files tab gets an unlisted one. The timeout is the guarantee that a busy
 * start-up cannot postpone it forever.
 */
function whenIdle(cb: () => void): void {
  const ric = (window as unknown as {
    requestIdleCallback?: (fn: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (typeof ric === "function") ric(cb, { timeout: 3000 });
  else window.setTimeout(cb, 300);
}

// ── Boot ──────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  mark("boot");
  themes.init();
  // Before the first listing, so the shell is never painted at one size and
  // then jumped to another the moment the settings are read.
  applyAppearance();
  discovered = await fs.roots();
  places = userPlaces.resolve(discovered);
  // The tree is built inside warm(), immediately before the navigate that needs
  // it. Building it here as well was a second full render for nothing, and on a
  // phone it was work done ahead of first paint that the phone shell never
  // reads -- it has no tree.
  // Start wherever the platform says home is rather than a path baked into the
  // source — the shell must not assume this machine's username. Read off
  // `discovered`, not `places`: taking home out of the sidebar is a statement
  // about the sidebar, not an instruction to start somewhere else.
  cwd = discovered.find((p) => p.id === "home")?.path ?? cwd;

  // Read before anything writes, or the "still running" flag being asked about
  // is the one this run has just set.
  const prior = settings.get<boolean>(PREF.restoreSession) ? recall() : null;
  // Immediately after that read and before anything else: `arm` is what installs
  // the window's lifecycle handlers, and until they exist the app can be
  // switched away from without leaving any trace of having been. On the phone
  // the rest of this boot runs behind a storage scan, so "until they exist" was
  // long enough for the OS to kill a backgrounded app and for the next launch to
  // call that a crash.
  arm();
  // "Start in" beats the last folder when it is set, because someone who typed
  // a path into that box is saying where they want to begin — that is the whole
  // content of the setting. Blank falls back to the last folder, then to home.
  const pinned = settings.get<string>(PREF.startFolder).trim();
  const home = cwd;
  // `home` stays the platform's home folder, which is what the fallback below
  // navigates to — a typo in the "Start in" box must not leave the shell
  // retrying the same unreadable path and giving up.
  const want = pinned !== "" ? pinned : (prior?.state.folder ?? home);

  // ── The phone shell ─────────────────────────────────────────────────────
  //
  // Mounted over the desktop shell rather than instead of it. The desktop shell
  // still boots — it owns the eighteen panels the phone delegates to, and those
  // are constructed at module scope — but `#app` is hidden and `.ph` takes the
  // screen. Doing it this way rather than branching at the top of `boot` means
  // there is exactly one boot path to keep working, and a panel opened from the
  // phone gets a shell that has already navigated, listed and built its tree.
  //
  // What that shell must NOT do is make the phone wait for it. `tree.build()`
  // walks the roots and `navigate()` lists the home folder into the desktop
  // table — and on a phone every pixel of that output is hidden by `mountPhone`
  // a moment later. It is not a cheap invisible step either: against ten
  // thousand files it is the whole cold-start delay, and what it looks like from
  // outside is the app opening to a bare "Name / Kind / Size / Modified" table
  // that sits there for ten seconds before the gallery appears. So on a phone
  // the gallery goes up first and the desktop shell warms up behind it.
  const onPhone = isPhone();

  const warm = async (): Promise<void> => {
    // Before the first navigate, so the tree has its roots to reveal into.
    await tree.build();
    await navigate(want, false);
    // navigate() puts `cwd` back when a folder has vanished or turned unreadable,
    // which after a restart is an ordinary thing for a saved path to have done.
    if (cwd !== want) await navigate(home, false);
    if (prior) browser.selectPaths(prior.state.selected);
    // The lifecycle was taken over up at `arm()`, before any of this ran. What
    // is left here is the position record, which needs a folder and so could not
    // be written until there was one.
    begin(cwd);
  };

  if (onPhone) {
    mark("mountPhone");
    mountPhone(home);
    mark("mountPhone done");
    // Deferred rather than merely un-awaited: the phone's own storage scan is
    // starting in this same tick, and the two of them racing for the disk is
    // how the visible half ends up slower than it was before. Idle time is
    // exactly the budget this work deserves — nobody is looking at its output.
    whenIdle(() => { void warm(); });
  } else {
    await warm();
  }

  if (prior?.crashed || prior?.replaced) void offerRecovery(prior.state, prior.replaced);

  // Surfaces open and close from a dozen places — buttons, keys, the palette,
  // the canvas itself. Rather than instrument every one of them, the record is
  // taken after any input has had a frame to do its work. The write behind it
  // is debounced, so all but one in a burst costs a function call.
  for (const ev of ["keyup", "pointerup"] as const) {
    window.addEventListener(ev, () => { requestAnimationFrame(note); }, true);
  }

  window.addEventListener("keydown", (e) => {
    // Item 35. Nothing below asks "was that ctrl and K"; it asks the keymap what
    // the user just pressed, and the keymap answers with a command id. That is
    // what makes every one of these rebindable — and it is why the ids live in
    // their own module, so a `case` here cannot silently stop matching.
    const typing =
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLSelectElement ||
      e.target instanceof HTMLTextAreaElement;

    /*
     * The menu key and Shift+F10 (item 39).
     *
     * Not routed through the keymap: these two are not a FACET shortcut anybody
     * would want to rebind, they are the platform's own way of saying "the
     * context menu, for whatever has focus", and a right-click menu that could
     * only be opened with a mouse would be one nobody using a keyboard could
     * reach. Opened next to the focused row rather than at 0,0 — a menu in the
     * corner of the screen is not about the thing you are on.
     */
    if (!typing && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
      e.preventDefault();
      const at = document.querySelector('[aria-selected="true"]')?.getBoundingClientRect();
      openContextMenu(at ? at.left + 24 : 80, at ? at.bottom - 4 : 80);
      return;
    }

    // The keymap decides scope; the shell still decides what a command *does*
    // with the thing that is open, which is a different question.
    const cmd = keys.match(e, { surface: surfaceOpen(), typing });

    switch (cmd) {
      // Works over a surface: getting *out* of somewhere matters as much as
      // getting in, and "I noticed something while looking at a file" is the
      // usual reason for wanting settings or a tool.
      case KEY_ID.palette:
        e.preventDefault();
        palette.toggle();
        return;
      case KEY_ID.settings:
        e.preventDefault();
        prefs.toggle();
        return;
      case KEY_ID.shortcuts:
        e.preventDefault();
        keysPanel.toggle();
        return;
      case KEY_ID.address:
        e.preventDefault();
        editAddress();
        return;
      case KEY_ID.hex:
        e.preventDefault();
        inspector.toggle(selection[0]);
        return;
      case KEY_ID.table:
        e.preventDefault();
        table.toggle(selection[0]);
        return;
      case KEY_ID.share:
        e.preventDefault();
        shareSelection();
        return;
      case KEY_ID.filter:
        e.preventDefault();
        filterBar.focus();
        return;
      case KEY_ID.viewMode:
        e.preventDefault();
        // A toggle when there were two, a ring now there are four. Pressing it
        // repeatedly still gets you back where you started, which is the
        // property that made it safe to press in the first place.
        setMode(nextMode(mode));
        return;
      // Not scoped to the explorer — checking on a running batch is exactly the
      // thing you do while an editor is up in front of it.
      case KEY_ID.watch:
        e.preventDefault();
        watchPanel.toggle();
        return;
      case KEY_ID.batch:
        e.preventDefault();
        batchPanel.toggle();
        return;
      case KEY_ID.sidebar:
        e.preventDefault();
        tree.toggle();
        void tree.reveal(cwd);
        return;
      default:
        break;
    }

    if (palette.isOpen) return;

    /*
     * "Transcribe what I am looking at" (item 30).
     *
     * Handled here rather than in the switch above because, like E, it needs
     * to know what is open: pressing T while a recording is playing should
     * transcribe *that*, not whatever happens to be selected behind it. The
     * player is closed first — the panel has its own playback, and two things
     * making sound at once is nobody's idea of a transcript.
     */
    if (cmd === KEY_ID.transcribe) {
      const heard = speechInSelection();
      if (heard) {
        e.preventDefault();
        player.close();
        void scribe.open(heard);
        return;
      }
    }

    // The same gesture one key over, for the other half of the job (item 31).
    if (cmd === KEY_ID.subtitles) {
      const target = subtitleInSelection();
      if (target) {
        e.preventDefault();
        void openSubtitles(target);
        return;
      }
    }

    // And the same verb aimed at a page rather than at a recording (item 32).
    if (cmd === KEY_ID.ocr) {
      const seen = ocrInSelection();
      if (seen) {
        e.preventDefault();
        viewer.close();
        void ocr.open(seen);
        return;
      }
    }

    // Signing is the same shape of gesture as OCR, one key over: both open a
    // full-screen panel on a page and both refuse to guess which page.
    if (cmd === KEY_ID.sign) {
      const doc = signInSelection();
      if (doc) {
        e.preventDefault();
        viewer.close();
        void signView.open(doc);
        return;
      }
    }

    // "Edit what I am looking at" is one command over three kinds of file, so
    // the file answers "which editor", not the surface that happens to be up.
    // The photo viewer binds the same key itself, which is the point: E means
    // edit everywhere rather than a different gesture per medium.
    if (cmd === KEY_ID.edit) {
      const open = player.isOpen ? player.openPath : null;
      const clip = open ? (isAudioPath(open) ? null : open) : !surfaceOpen() ? videoInSelection() : null;
      if (clip) {
        e.preventDefault();
        player.close();
        void vedit.open(clip);
        return;
      }
      const track = open && isAudioPath(open) ? open : !surfaceOpen() ? audioInSelection() : null;
      if (track) {
        e.preventDefault();
        player.close();
        void aedit.open(track);
        return;
      }
    }
    // Each surface owns the keyboard while it is up, including Backspace and
    // Space — the player would otherwise navigate the folder out from under a
    // video every time you paused it.
    if (surfaceOpen()) {
      // The inspector binds letters, arrows and Enter, so it gets first refusal
      // on every key rather than a list of exceptions maintained in two places.
      if (inspector.key(e)) { e.preventDefault(); return; }
      // Same arrangement for the grid, which binds arrows, Home/End and "/".
      if (table.key(e)) { e.preventDefault(); return; }
      // `escape`, not `close`: full screen is a state inside the card and it
      // unwinds first, so one press gives the chrome back and the next puts
      // the file away.
      if (e.key === "Escape" && quickLook.isOpen) quickLook.escape();
      if (e.key === " " && quickLook.isOpen) { e.preventDefault(); quickLook.close(); }
      if (metaPanel.isOpen && (e.key === "Escape" || e.key.toLowerCase() === "i")) {
        e.preventDefault();
        metaPanel.close();
      }
      return;
    }
    if (typing) return;

    switch (cmd) {
      case KEY_ID.copy:
        // Unless there is text highlighted — the status bar's path is selectable
        // on purpose, and taking Ctrl+C away from a highlighted string is the
        // kind of override that makes an app feel like it is fighting the OS.
        if ((window.getSelection()?.toString() ?? "") !== "") return;
        e.preventDefault();
        copySelection();
        return;
      case KEY_ID.back:
        e.preventDefault();
        goBack();
        return;
      case KEY_ID.quickLook:
        e.preventDefault();
        quickLook.toggle(selection[0] ?? null);
        return;
      case KEY_ID.open: {
        const one = selection[0];
        if (one) { e.preventDefault(); openEntry(one); }
        return;
      }
      case KEY_ID.info:
        e.preventDefault();
        metaPanel.toggle(selection);
        return;
      case KEY_ID.reload:
        e.preventDefault();
        reload();
        return;
      case KEY_ID.bigger:
        setFolderCardSize(view.cardSize + 30);
        return;
      case KEY_ID.smaller:
        setFolderCardSize(view.cardSize - 30);
        return;
      default:
        return;
    }
  });
}

void boot();
