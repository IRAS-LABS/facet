/**
 * One pop-out window: one file, drawn edge to edge, with the controls kept out
 * of the way until the pointer comes looking for them.
 *
 * The window itself belongs to Rust (`src-tauri/src/pip.rs`) — it was built
 * there, placed there, and only Rust can make another. This page asks what it
 * is showing, draws it, reports the picture's shape so the window can hug it,
 * and otherwise only moves, pins, fades or closes its own window.
 *
 * **What draws what.** Pictures, clips and sound get a renderer of their own
 * here, because the explorer's viewer and player are editing surfaces: a blur
 * rail and a transport with fourteen buttons do not fit in 480×270, and a
 * pop-out is for watching, not editing. Everything else reuses the explorer's
 * own full-window surfaces as they are — the 3D scene, the table grid, and
 * quick look for PDFs, text, code and anything unknown — so a pop-out can show
 * every file the explorer can, on the day the explorer learns a new one.
 *
 * Everything outside this file comes through `PipBridge`, which is what lets
 * `dev/pipcheck.html` drive the real page in a plain browser tab with a fake
 * window behind it.
 */

import { extOf, kindForExt, type FileEntry } from "@core/explorer/types";
import { QuickLook } from "@ui/quicklook";
import { SceneView } from "@ui/scene-view";
import { TableView } from "@ui/table";

export interface PipOpts {
  mute: boolean;
  loop: boolean;
  paused: boolean;
  start: number | null;
  opacity: number | null;
}

/** What `pip_info` answers. */
export interface PipInfo {
  id: number;
  path: string;
  name: string;
  opts: PipOpts;
  aspect: number | null;
  /** Bytes on disk, when known. */
  size?: number | null;
}

export type ResizeDir =
  | "North" | "South" | "East" | "West"
  | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

export interface PipBridge {
  info(): Promise<PipInfo | null>;
  /** The picture's width over height, once known. */
  ready(aspect: number | null): void;
  close(): void;
  startDrag(): void;
  startResize(dir: ResizeDir): void;
  setOnTop(onTop: boolean): void;
  /** Raise the explorer on this file. */
  reveal(): void;
  fileUrl(path: string): Promise<string>;
  openExternal(path: string): Promise<void>;
  readHead(path: string, max: number): Promise<number[]>;
  readRange(path: string, offset: number, len: number): Promise<number[]>;
  readTail(path: string, len: number): Promise<[number[], number]>;
  writeFile(path: string, bytes: Uint8Array, overwrite: boolean): Promise<string>;
  frameAt?(path: string, at: number, width: number): Promise<Uint8Array>;
}

export type Route = "image" | "video" | "audio" | "scene" | "table" | "doc";

const WEB_IMAGE = new Set([
  "jpg", "jpeg", "jpe", "jfif", "png", "apng", "gif", "webp", "avif", "avifs", "bmp", "svg", "ico",
]);
const WEB_VIDEO = new Set(["mp4", "webm", "m4v", "mov", "mkv"]);
const WEB_AUDIO = new Set(["mp3", "wav", "flac", "ogg", "opus", "m4a", "aac", "weba"]);

/** The shape a sound gets: a wide strip, not a 16:9 slab of nothing. */
const AUDIO_ASPECT = 3.2;

/** How long the controls stay after the pointer stops. */
const IDLE_MS = 1800;

const OPACITY_MIN = 0.2;
const OPACITY_STEP = 0.1;

/** Which renderer a file name gets. Pure, so the harness can ask it directly. */
export function routeFor(name: string): Route {
  const ext = extOf(name);
  if (WEB_IMAGE.has(ext)) return "image";
  if (WEB_VIDEO.has(ext)) return "video";
  if (WEB_AUDIO.has(ext)) return "audio";
  if (SceneView.handles(ext)) return "scene";
  if (TableView.handles(ext)) return "table";
  return "doc";
}

export function clampOpacity(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.round(Math.min(1, Math.max(OPACITY_MIN, v)) * 100) / 100;
}

export function clock(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** The handle a test holds. The native page ignores it. */
export interface PipHandle {
  readonly route: Route | null;
  readonly root: HTMLElement;
  readonly media: HTMLMediaElement | null;
  readonly opacity: number;
  readonly onTop: boolean;
  /** Play or pause, as a click on the picture does. */
  toggle(): void;
  dispose(): void;
}

const svg = (d: string): string =>
  `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICON = {
  pin: svg('<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>'),
  fade: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>'),
  reveal: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  external: svg('<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  play: svg('<path d="M7 4l13 8-13 8z" fill="currentColor"/>'),
  pause: svg('<path d="M7 4h4v16H7zM13 4h4v16h-4z" fill="currentColor"/>'),
  sound: svg('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9a4 4 0 0 1 0 6"/>'),
  muted: svg('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/>'),
  loop: svg('<path d="M4 12a6 6 0 0 1 6-6h9"/><path d="M16 3l3 3-3 3"/><path d="M20 12a6 6 0 0 1-6 6H5"/><path d="M8 21l-3-3 3-3"/>'),
  fill: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  grip: svg('<circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="15" cy="6" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="18" r="1" fill="currentColor"/><circle cx="15" cy="18" r="1" fill="currentColor"/>'),
};

function button(icon: string, label: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `pip-btn ${cls}`.trim();
  b.innerHTML = icon;
  b.title = label;
  b.setAttribute("aria-label", label.replace(/\s+\(.*\)$/, ""));
  // Never the start of a window drag, and never a focus ring left on a
  // borderless window after a click.
  b.addEventListener("pointerdown", (e) => e.stopPropagation());
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
    b.blur();
  });
  return b;
}

export async function mountPip(host: HTMLElement, bridge: PipBridge): Promise<PipHandle> {
  const root = document.createElement("div");
  root.className = "pip";
  root.tabIndex = -1;
  host.append(root);

  const stage = document.createElement("div");
  stage.className = "pip-stage";
  root.append(stage);

  let route: Route | null = null;
  let media: HTMLMediaElement | null = null;
  let opacity = 1;
  let onTop = true;
  let disposed = false;
  let toggleMedia = (): void => {};
  /**
   * An adopted surface's first refusal on a key, the way the explorer's own
   * key handler gives it: the grid binds arrows and Escape, quick look binds
   * Escape. True when the surface took it.
   */
  let surfaceKey = (_e: KeyboardEvent): boolean => false;
  /** Cover the window instead of fitting inside it. Video only. */
  const toggleFill = (): void => {
    const on = root.dataset["fill"] !== "true";
    root.dataset["fill"] = String(on);
    root.querySelector(".pip-fillbtn")?.setAttribute("aria-pressed", String(on));
  };
  const cleanups: (() => void)[] = [];
  const listen = <K extends keyof WindowEventMap>(
    type: K,
    fn: (e: WindowEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void => {
    window.addEventListener(type, fn, opts);
    cleanups.push(() => window.removeEventListener(type, fn, opts));
  };

  const handle: PipHandle = {
    get route() { return route; },
    root,
    get media() { return media; },
    get opacity() { return opacity; },
    get onTop() { return onTop; },
    toggle: () => toggleMedia(),
    dispose() {
      disposed = true;
      for (const c of cleanups.splice(0)) c();
      document.documentElement.style.removeProperty("--pip-opacity");
      root.remove();
    },
  };

  const info = await bridge.info();
  if (!info) {
    root.dataset["state"] = "empty";
    const note = document.createElement("div");
    note.className = "pip-note";
    note.textContent = "This pop-out has nothing to show.";
    stage.append(note);
    const t = setTimeout(() => bridge.close(), 1500);
    cleanups.push(() => clearTimeout(t));
    return handle;
  }

  document.title = `${info.name} — FACET`;
  const ext = extOf(info.name);
  const entry: FileEntry = { path: info.path, name: info.name, kind: kindForExt(ext), ext };
  if (typeof info.size === "number") entry.size = info.size;
  route = routeFor(info.name);
  root.dataset["route"] = route;

  // ── Opacity ───────────────────────────────────────────────────────────────
  const setOpacity = (v: number): void => {
    opacity = clampOpacity(v);
    // On the document, not the pane: an adopted surface is not inside it.
    document.documentElement.style.setProperty("--pip-opacity", String(opacity));
    root.dataset["faded"] = String(opacity < 1);
    // Ctrl-wheel only reaches the fade where nothing under it wanted to zoom:
    // over a document or a model that gesture is now the document's.
    const wheel = route === "image" || route === "video" || route === "audio" ? ", or Ctrl+wheel" : "";
    fadeBtn.title = `Fade — ${Math.round(opacity * 100)}%  ([ and ]${wheel})`;
  };

  // ── Chrome ────────────────────────────────────────────────────────────────
  const bar = document.createElement("div");
  bar.className = "pip-bar";
  const title = document.createElement("div");
  title.className = "pip-title";
  title.textContent = info.name;
  title.title = info.name;

  const pinBtn = button(ICON.pin, "Keep on top  (T)", () => setPinned(!onTop), "pip-pin");
  const fadeBtn = button(ICON.fade, "Fade", () => {
    // Steps down, and back to solid from the faintest.
    setOpacity(opacity <= OPACITY_MIN + 0.001 ? 1 : opacity - 0.2);
  }, "pip-fade");
  const revealBtn = button(ICON.reveal, "Show in FACET", () => bridge.reveal(), "pip-reveal");
  const extBtn = button(ICON.external, "Open in the default app", () => void bridge.openExternal(info.path), "pip-ext");
  const closeBtn = button(ICON.close, "Close  (Esc)", () => bridge.close(), "pip-close");

  const grip = document.createElement("div");
  grip.className = "pip-grip";
  grip.innerHTML = ICON.grip;
  grip.title = "Drag to move";

  bar.append(grip, title, pinBtn, fadeBtn, revealBtn, extBtn, closeBtn);
  root.append(bar);

  const setPinned = (v: boolean): void => {
    onTop = v;
    pinBtn.setAttribute("aria-pressed", String(v));
    bridge.setOnTop(v);
  };
  pinBtn.setAttribute("aria-pressed", "true");

  // Resize handles on every edge and corner. A borderless window has no frame
  // for the operating system to grab.
  const DIRS: ResizeDir[] = ["North", "South", "East", "West", "NorthEast", "NorthWest", "SouthEast", "SouthWest"];
  for (const dir of DIRS) {
    const h = document.createElement("div");
    h.className = `pip-edge pip-edge-${dir.toLowerCase()}`;
    h.dataset["dir"] = dir;
    h.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      bridge.startResize(dir);
    });
    root.append(h);
  }

  // Controls show while the pointer moves and fade once it rests.
  let idle = 0;
  const wake = (): void => {
    root.dataset["idle"] = "false";
    clearTimeout(idle);
    idle = window.setTimeout(() => {
      // Not while the pointer is resting on the controls themselves.
      if (!root.querySelector(".pip-bar:hover, .pip-controls:hover")) root.dataset["idle"] = "true";
    }, IDLE_MS);
  };
  // On the window: over an adopted surface the pane lets the pointer through.
  listen("pointermove", wake);
  const leave = (): void => {
    clearTimeout(idle);
    root.dataset["idle"] = "true";
  };
  document.documentElement.addEventListener("pointerleave", leave);
  cleanups.push(() => document.documentElement.removeEventListener("pointerleave", leave));
  cleanups.push(() => clearTimeout(idle));
  wake();

  // Drag the window from the bar, or from the picture itself. A press that
  // does not move is a click and stays one.
  const dragFrom = (el: HTMLElement, onClick?: () => void): void => {
    let down: { x: number; y: number } | null = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener("pointermove", (e) => {
      if (!down || (e.buttons & 1) === 0) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) {
        down = null;
        bridge.startDrag();
      }
    });
    el.addEventListener("pointerup", () => {
      if (down && onClick) onClick();
      down = null;
    });
  };
  dragFrom(bar);

  // ── Renderers ─────────────────────────────────────────────────────────────
  const url = (): Promise<string> => bridge.fileUrl(info.path);

  /** Lets go of the decoder, so a pop-out that fell back holds no stream. */
  let release = (): void => {};

  const fallBackToDoc = (): void => {
    stage.replaceChildren();
    media = null;
    route = "doc";
    root.dataset["route"] = "doc";
    void showDoc();
  };

  const wireMedia = (el: HTMLMediaElement, controls: HTMLElement): void => {
    media = el;
    release = () => {
      el.pause();
      el.removeAttribute("src");
      el.load();
    };
    el.muted = info.opts.mute;
    el.loop = info.opts.loop;
    el.preload = "auto";

    const playBtn = button(ICON.play, "Play / pause  (Space)", () => toggle(), "pip-play");
    const muteBtn = button(info.opts.mute ? ICON.muted : ICON.sound, "Mute  (M)", () => setMuted(!el.muted), "pip-mute");
    const loopBtn = button(ICON.loop, "Loop  (L)", () => setLoop(!el.loop), "pip-loop");
    const time = document.createElement("div");
    time.className = "pip-time";
    const seek = document.createElement("div");
    seek.className = "pip-seek";
    const played = document.createElement("i");
    const bufd = document.createElement("i");
    bufd.className = "pip-buf";
    seek.append(bufd, played);
    seek.setAttribute("role", "slider");
    seek.setAttribute("aria-label", "Position");
    seek.title = "Seek";

    const toggle = (): void => {
      if (el.paused) void el.play().catch(() => {});
      else el.pause();
    };
    const setMuted = (v: boolean): void => {
      el.muted = v;
      muteBtn.innerHTML = v ? ICON.muted : ICON.sound;
      muteBtn.setAttribute("aria-pressed", String(v));
    };
    const setLoop = (v: boolean): void => {
      el.loop = v;
      loopBtn.setAttribute("aria-pressed", String(v));
    };
    setMuted(el.muted);
    setLoop(el.loop);

    const paint = (): void => {
      const d = el.duration;
      const f = Number.isFinite(d) && d > 0 ? el.currentTime / d : 0;
      played.style.width = `${(f * 100).toFixed(3)}%`;
      if (el.buffered.length && Number.isFinite(d) && d > 0) {
        bufd.style.width = `${((el.buffered.end(el.buffered.length - 1) / d) * 100).toFixed(2)}%`;
      }
      time.textContent = `${clock(el.currentTime)} / ${clock(d)}`;
      seek.setAttribute("aria-valuenow", String(Math.round(f * 100)));
      playBtn.innerHTML = el.paused ? ICON.play : ICON.pause;
      playBtn.setAttribute("aria-pressed", String(!el.paused));
      root.dataset["playing"] = String(!el.paused);
    };
    for (const ev of ["timeupdate", "play", "pause", "progress", "durationchange", "loadedmetadata", "ended"]) {
      el.addEventListener(ev, paint);
    }

    const seekTo = (clientX: number): void => {
      const r = seek.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
      if (Number.isFinite(el.duration)) el.currentTime = f * el.duration;
      paint();
    };
    seek.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      seek.setPointerCapture?.(e.pointerId);
      seekTo(e.clientX);
      const move = (m: PointerEvent): void => seekTo(m.clientX);
      const up = (): void => {
        seek.removeEventListener("pointermove", move);
        seek.removeEventListener("pointerup", up);
      };
      seek.addEventListener("pointermove", move);
      seek.addEventListener("pointerup", up);
    });

    const row = document.createElement("div");
    row.className = "pip-row";
    row.append(playBtn, time, loopBtn, muteBtn);
    controls.className = "pip-controls";
    controls.append(seek, row);
    controls.addEventListener("pointerdown", (e) => e.stopPropagation());

    let started = false;
    el.addEventListener("loadedmetadata", () => {
      if (!started && info.opts.start !== null && Number.isFinite(el.duration)) {
        el.currentTime = Math.min(info.opts.start, Math.max(0, el.duration - 0.05));
      }
      started = true;
      if (!info.opts.paused) {
        void el.play().catch(() => {
          // Sound that is not allowed to start on its own: start silent and
          // say so, rather than sitting on a black frame.
          setMuted(true);
          void el.play().catch(() => {});
        });
      }
    });

    listen("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === " " || k === "k") { e.preventDefault(); toggle(); }
      else if (k === "m") setMuted(!el.muted);
      else if (k === "l") setLoop(!el.loop);
      else if (e.key === "ArrowLeft") { el.currentTime = Math.max(0, el.currentTime - 5); paint(); }
      else if (e.key === "ArrowRight") {
        if (Number.isFinite(el.duration)) el.currentTime = Math.min(el.duration, el.currentTime + 5);
        paint();
      }
      else return;
      wake();
    });

    cleanups.push(release);
    toggleMedia = toggle;
    paint();
  };

  const showImage = async (): Promise<void> => {
    const img = document.createElement("img");
    img.className = "pip-img";
    img.alt = info.name;
    img.draggable = false;
    stage.append(img);
    dragFrom(stage);
    img.addEventListener("load", () => {
      root.dataset["state"] = "ready";
      bridge.ready(img.naturalWidth > 0 ? img.naturalWidth / img.naturalHeight : null);
    }, { once: true });
    img.addEventListener("error", fallBackToDoc, { once: true });
    img.src = await url();
  };

  const showVideo = async (): Promise<void> => {
    const v = document.createElement("video");
    v.className = "pip-video";
    v.playsInline = true;
    v.disablePictureInPicture = false;
    const controls = document.createElement("div");
    stage.append(v);
    root.append(controls);
    wireMedia(v, controls);
    dragFrom(stage, () => toggleMedia());
    const fillBtn = button(ICON.fill, "Fill the window  (F, or double-click)", () => toggleFill(), "pip-fillbtn");
    controls.querySelector(".pip-row")?.append(fillBtn);
    v.addEventListener("dblclick", () => {
      // Its two clicks were already a pause and a play, so playback ends
      // where it started.
      toggleFill();
    });
    v.addEventListener("loadedmetadata", () => {
      root.dataset["state"] = "ready";
      bridge.ready(v.videoWidth > 0 ? v.videoWidth / v.videoHeight : null);
    }, { once: true });
    v.addEventListener("error", () => {
      release();
      controls.remove();
      fallBackToDoc();
    }, { once: true });
    v.src = await url();
  };

  const showAudio = async (): Promise<void> => {
    const a = document.createElement("audio");
    const card = document.createElement("div");
    card.className = "pip-audio";
    const glyph = document.createElement("div");
    glyph.className = "pip-audio-glyph";
    for (let i = 0; i < 5; i++) glyph.append(document.createElement("i"));
    const name = document.createElement("div");
    name.className = "pip-audio-name";
    name.textContent = info.name;
    card.append(glyph, name);
    stage.append(card, a);
    const controls = document.createElement("div");
    root.append(controls);
    wireMedia(a, controls);
    dragFrom(stage, () => toggleMedia());
    a.addEventListener("loadedmetadata", () => {
      root.dataset["state"] = "ready";
    }, { once: true });
    a.addEventListener("error", () => {
      root.dataset["state"] = "error";
      name.textContent = `${info.name} — this sound cannot be played here`;
    }, { once: true });
    bridge.ready(AUDIO_ASPECT);
    a.src = await url();
  };

  /**
   * Put one of the explorer's own surfaces in this window, and close the
   * window when that surface is closed — its ✕ and its Escape mean the same
   * here as they do in the explorer: "put this file away".
   */
  const adopt = (build: () => { isOpen: boolean }): void => {
    const before = new Set(Array.from(document.body.children));
    const view = build();
    const added = Array.from(document.body.children).filter((c) => !before.has(c));
    for (const el of added) el.classList.add("pip-adopted");
    let seen = false;
    const watch = new MutationObserver(() => {
      if (view.isOpen) seen = true;
      else if (seen) bridge.close();
    });
    for (const el of added) watch.observe(el, { attributes: true, attributeFilter: ["hidden"] });
    cleanups.push(() => {
      watch.disconnect();
      for (const el of added) el.remove();
    });
    root.dataset["state"] = "ready";
  };

  const showDoc = async (): Promise<void> => {
    let ql: QuickLook | null = null;
    adopt(() => {
      ql = new QuickLook({
        fileUrl: (p) => bridge.fileUrl(p),
        readHead: (p, max) => bridge.readHead(p, max),
        ...(bridge.frameAt ? { frameAt: (p: string, at: number, w: number) => bridge.frameAt!(p, at, w) } : {}),
        // A pop-out is small and is there to show the file: the details block
        // would take most of it. ⓘ still opens them.
        factsFolded: () => true,
      });
      return ql;
    });
    surfaceKey = (e) => {
      const view = ql as QuickLook | null;
      if (e.key !== "Escape" || !view?.isOpen) return false;
      // Full screen unwinds first; the next press puts the file away.
      view.escape();
      return true;
    };
    await (ql as QuickLook | null)?.show(entry);
  };

  const showScene = async (): Promise<void> => {
    let sv: SceneView | null = null;
    adopt(() => {
      sv = new SceneView({
        fileUrl: (p) => bridge.fileUrl(p),
        openExternal: (p) => bridge.openExternal(p),
        writeFile: (p, b, o) => bridge.writeFile(p, b, o),
      });
      return sv;
    });
    cleanups.push(() => (sv as SceneView | null)?.destroy());
    await (sv as SceneView | null)?.open([entry], entry);
  };

  const showTable = async (): Promise<void> => {
    let tv: TableView | null = null;
    adopt(() => {
      tv = new TableView({
        readRange: (p, o, l) => bridge.readRange(p, o, l),
        readHead: (p, m) => bridge.readHead(p, m),
        readTail: (p, l) => bridge.readTail(p, l),
      });
      return tv;
    });
    surfaceKey = (e) => (tv as TableView | null)?.key(e) ?? false;
    await (tv as TableView | null)?.open(entry);
  };

  // ── Window keys ───────────────────────────────────────────────────────────
  listen("keydown", (e) => {
    if (disposed) return;
    if (surfaceKey(e)) { e.preventDefault(); return; }
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "w") { e.preventDefault(); bridge.close(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Escape belongs to an adopted surface first; it closes this window
    // through the observer above when the surface lets go.
    if (e.key === "Escape" && (route === "image" || route === "video" || route === "audio")) {
      bridge.close();
    } else if (k === "t" && !isTyping(e)) setPinned(!onTop);
    else if (e.key === "[" && !isTyping(e)) setOpacity(opacity - OPACITY_STEP);
    else if (e.key === "]" && !isTyping(e)) setOpacity(opacity + OPACITY_STEP);
    else if (k === "f" && route === "video") toggleFill();
    else return;
    wake();
  });
  listen("wheel", (e) => {
    if (!e.ctrlKey) return;
    // An adopted surface gets it first. Ctrl-wheel is the only zoom a mouse
    // has, so over a document or a model it means "bigger" -- and a pop-out
    // that faded itself out while the reader was trying to zoom in read as
    // both gestures being broken at once. The surface calls `preventDefault`
    // when it took the gesture; anywhere it did not -- the bar, a picture, a
    // video -- this is still the fade.
    if (e.defaultPrevented) return;
    e.preventDefault();
    setOpacity(opacity + (e.deltaY < 0 ? OPACITY_STEP : -OPACITY_STEP));
  }, { passive: false });

  setOpacity(info.opts.opacity ?? 1);

  switch (route) {
    case "image": await showImage(); break;
    case "video": await showVideo(); break;
    case "audio": await showAudio(); break;
    case "scene": await showScene(); break;
    case "table": await showTable(); break;
    case "doc": await showDoc(); break;
  }
  root.focus({ preventScroll: true });
  return handle;
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
}
