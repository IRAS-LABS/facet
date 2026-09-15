/**
 * Harness for pop-out windows (`src/pip/pip-app.ts`).
 *
 * The page is driven for real — real pictures, a real recorded clip, a real
 * sound, the explorer's own quick look and table grid — with a fake window
 * behind `PipBridge` that writes down every call. So "does the pin button
 * unpin", "does Escape close a picture", "does closing the table close the
 * window" are all answered in a browser tab, without twelve always-on-top
 * windows landing on anyone's screen.
 *
 * Runs in the dev server (`/dev/pipcheck.html`) and rolls up into allcheck.html
 * under "pip".
 */

import "../styles/base.css";
import "../styles/shell.css";
import "../styles/skin.css";
import "../styles/pip.css";
import "../styles/scene.css";

import { themes } from "@core/theme/theme-engine";
import {
  clampOpacity, clock, mountPip, routeFor,
  type PipBridge, type PipHandle, type PipInfo, type PipOpts, type ResizeDir,
} from "../pip/pip-app";

themes.init();

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
}
const near = (a: number, b: number, tol = 0.01): boolean => Math.abs(a - b) <= tol;
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await tick(25);
  }
  return cond();
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A 200×100 PNG: a gradient, so a broken decode would not look like success. */
async function pngBlob(): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = 200;
  c.height = 100;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 200, 0);
  grad.addColorStop(0, "#7c5cff");
  grad.addColorStop(1, "#22d3ee");
  g.fillStyle = grad;
  g.fillRect(0, 0, 200, 100);
  return await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"));
}

/** One second of 440 Hz, as a 16-bit mono WAV. Its duration is finite, so seeking can be checked. */
function wavBlob(seconds = 1, rate = 8000): Blob {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), true);
  return new Blob([buf], { type: "audio/wav" });
}

/** Just under a second of 320×180 video, recorded from a canvas. Null where recording is unavailable. */
async function webmBlob(): Promise<Blob | null> {
  if (typeof MediaRecorder === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = 320;
  c.height = 180;
  const g = c.getContext("2d")!;
  const stream = c.captureStream(30);
  const mime = ["video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) return null;
  const rec = new MediaRecorder(stream, { mimeType: mime });
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  const done = new Promise<void>((r) => { rec.onstop = () => r(); });
  rec.start(100);
  const t0 = performance.now();
  // Painted on a timer, not animation frames: a harness in a background
  // iframe gets no frames, and a canvas that never repaints records nothing.
  while (performance.now() - t0 < 800) {
    const f = (performance.now() - t0) / 800;
    g.fillStyle = `hsl(${Math.round(f * 360)} 70% 50%)`;
    g.fillRect(0, 0, 320, 180);
    g.fillStyle = "#fff";
    g.fillRect(Math.round(f * 280), 70, 40, 40);
    await tick(33);
  }
  rec.stop();
  await done;
  for (const t of stream.getTracks()) t.stop();
  return parts.length ? new Blob(parts, { type: "video/webm" }) : null;
}

const enc = new TextEncoder();
const TEXT = enc.encode("Pop-out quick look\nline two\n");
const CSV = enc.encode("name,count,colour\nalpha,1,red\nbravo,2,green\ncharlie,3,blue\n");

// ── The fake window ─────────────────────────────────────────────────────────

interface Calls {
  close: number;
  drag: number;
  reveal: number;
  resize: ResizeDir[];
  onTop: boolean[];
  ready: (number | null)[];
  external: string[];
}

interface FakeFile {
  url?: string;
  bytes?: Uint8Array;
}

function fakeBridge(info: PipInfo | null, files: Map<string, FakeFile>): { bridge: PipBridge; calls: Calls } {
  const calls: Calls = { close: 0, drag: 0, reveal: 0, resize: [], onTop: [], ready: [], external: [] };
  const bytesOf = (p: string): Uint8Array => files.get(p)?.bytes ?? new Uint8Array();
  const bridge: PipBridge = {
    info: async () => info,
    ready: (a) => { calls.ready.push(a); },
    close: () => { calls.close++; },
    startDrag: () => { calls.drag++; },
    startResize: (d) => { calls.resize.push(d); },
    setOnTop: (v) => { calls.onTop.push(v); },
    reveal: () => { calls.reveal++; },
    fileUrl: async (p) => {
      const f = files.get(p);
      if (f?.url) return f.url;
      return URL.createObjectURL(new Blob([(f?.bytes ?? new Uint8Array()) as BlobPart]));
    },
    openExternal: async (p) => { calls.external.push(p); },
    readHead: async (p, max) => Array.from(bytesOf(p).subarray(0, max)),
    readRange: async (p, o, l) => Array.from(bytesOf(p).subarray(o, o + l)),
    readTail: async (p, l) => {
      const b = bytesOf(p);
      return [Array.from(b.subarray(Math.max(0, b.length - l))), b.length];
    },
    writeFile: async (p) => p,
  };
  return { bridge, calls };
}

const OPTS: PipOpts = { mute: false, loop: false, paused: false, start: null, opacity: null };

function infoFor(path: string, opts: Partial<PipOpts> = {}, size?: number): PipInfo {
  const name = path.split("/").pop()!;
  return { id: 1, path, name, opts: { ...OPTS, ...opts }, aspect: null, ...(size === undefined ? {} : { size }) };
}

const host = document.getElementById("pip")!;

async function mount(info: PipInfo | null, files: Map<string, FakeFile>): Promise<{ h: PipHandle; calls: Calls }> {
  const { bridge, calls } = fakeBridge(info, files);
  const h = await mountPip(host, bridge);
  return { h, calls };
}

function key(k: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
}

function pointer(el: Element, type: string, x: number, y: number, buttons = 1): void {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons, pointerId: 1 }));
}

function btn(root: HTMLElement, cls: string): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>(`.${cls}`);
}

/** A wheel notch over the middle of an element. Returns whether it was taken. */
function wheel(el: Element, deltaY: number, ctrlKey = false): boolean {
  const r = el.getBoundingClientRect();
  const e = new WheelEvent("wheel", {
    bubbles: true, cancelable: true, deltaY, ctrlKey,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
  });
  el.dispatchEvent(e);
  return e.defaultPrevented;
}

/** The scale a `transform: scale()` is currently at, 1 when there is none. */
function scaleOf(el: Element): number {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return 1;
  const m = /matrix\(([^,]+),/.exec(t);
  return m ? Number(m[1]) : 1;
}

function skipped(name: string, why: string): void {
  console.log(`skip ${name} — ${why}`);
}

// ── Pure parts ──────────────────────────────────────────────────────────────

function pure(): void {
  ok("route: png is a picture", routeFor("a.png") === "image");
  ok("route: upper-case MP4 is a clip", routeFor("B.MP4") === "video");
  ok("route: flac is a sound", routeFor("c.flac") === "audio");
  ok("route: glb is a scene", routeFor("d.glb") === "scene");
  ok("route: stl is a scene", routeFor("part.stl") === "scene");
  ok("route: csv is a table", routeFor("e.csv") === "table");
  ok("route: pdf goes to quick look", routeFor("f.pdf") === "doc");
  ok("route: txt goes to quick look", routeFor("g.txt") === "doc");
  ok("route: no extension goes to quick look", routeFor("Makefile") === "doc");

  ok("opacity: floor is 20%", clampOpacity(0) === 0.2);
  ok("opacity: ceiling is solid", clampOpacity(5) === 1);
  ok("opacity: nonsense is solid", clampOpacity(Number.NaN) === 1);
  ok("opacity: rounds to a percent", clampOpacity(0.456) === 0.46);

  ok("clock: zero", clock(0) === "0:00");
  ok("clock: minutes", clock(65) === "1:05");
  ok("clock: hours", clock(3661) === "1:01:01");
  ok("clock: unknown length", clock(Number.POSITIVE_INFINITY) === "0:00" && clock(-3) === "0:00");
}

// ── Nothing to show ─────────────────────────────────────────────────────────

async function empty(): Promise<void> {
  const { h, calls } = await mount(null, new Map());
  ok("empty: says so", h.root.dataset["state"] === "empty" && /nothing to show/.test(h.root.textContent ?? ""));
  ok("empty: no route", h.route === null);
  await tick(1600);
  ok("empty: closes its own window", calls.close === 1, `close=${calls.close}`);
  h.dispose();
}

// ── A picture: the chrome, every button, every key ──────────────────────────

async function picture(png: Blob): Promise<void> {
  const url = URL.createObjectURL(png);
  const files = new Map<string, FakeFile>([["/pics/wide.png", { url }]]);
  const { h, calls } = await mount(infoFor("/pics/wide.png"), files);
  const r = h.root;

  ok("picture: routed", h.route === "image" && r.dataset["route"] === "image");
  ok("picture: loads", await until(() => r.dataset["state"] === "ready"));
  ok("picture: reports its shape", near(calls.ready[0] ?? 0, 2), `ready=${calls.ready.join(",")}`);
  ok("focus: the pane takes the keys", document.activeElement === r);
  ok("picture: title is the name", r.querySelector(".pip-title")?.textContent === "wide.png" && document.title.startsWith("wide.png"));

  const buttons = Array.from(r.querySelectorAll<HTMLButtonElement>("button"));
  ok("picture: five bar buttons", r.querySelectorAll(".pip-bar button").length === 5, String(buttons.length));
  ok("every button has a tooltip and a name",
    buttons.every((b) => b.title.trim() && b.getAttribute("aria-label")?.trim() && b.type === "button"),
    buttons.filter((b) => !b.title || !b.getAttribute("aria-label")).map((b) => b.className).join(" "));
  ok("names drop the shortcut hint", btn(r, "pip-close")?.getAttribute("aria-label") === "Close");

  // Pin
  const pin = btn(r, "pip-pin")!;
  ok("pin: starts pressed", pin.getAttribute("aria-pressed") === "true" && h.onTop);
  pin.click();
  ok("pin button: unpins", calls.onTop.at(-1) === false && pin.getAttribute("aria-pressed") === "false" && !h.onTop);
  key("t");
  ok("T: pins again", calls.onTop.at(-1) === true && pin.getAttribute("aria-pressed") === "true");

  // Fade
  const fade = btn(r, "pip-fade")!;
  const cssOpacity = (): string => document.documentElement.style.getPropertyValue("--pip-opacity");
  ok("fade: starts solid", h.opacity === 1 && cssOpacity() === "1");
  fade.click();
  ok("fade button: steps down", h.opacity === 0.8 && cssOpacity() === "0.8" && r.dataset["faded"] === "true");
  ok("fade button: tooltip shows the level", /80%/.test(fade.title), fade.title);
  fade.click(); fade.click(); fade.click();
  ok("fade button: bottoms at 20%", h.opacity === 0.2);
  fade.click();
  ok("fade button: wraps back to solid", h.opacity === 1 && r.dataset["faded"] === "false");
  key("[");
  ok("[: fainter", h.opacity === 0.9);
  key("]");
  ok("]: stronger", h.opacity === 1);
  key("]");
  ok("]: stops at solid", h.opacity === 1);
  window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, cancelable: true }));
  ok("Ctrl+wheel down: fainter", h.opacity === 0.9);
  window.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true }));
  ok("Ctrl+wheel up: stronger", h.opacity === 1);
  window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true }));
  ok("plain wheel: leaves opacity alone", h.opacity === 1);

  // Reveal, open elsewhere, close
  btn(r, "pip-reveal")!.click();
  ok("reveal button: asks for the explorer", calls.reveal === 1);
  btn(r, "pip-ext")!.click();
  ok("open-externally button: passes the path", calls.external[0] === "/pics/wide.png");
  btn(r, "pip-close")!.click();
  ok("close button: closes", calls.close === 1);
  key("Escape");
  ok("Escape: closes a picture", calls.close === 2);
  key("w", { ctrlKey: true });
  ok("Ctrl+W: closes", calls.close === 3);
  key("t", { ctrlKey: true });
  ok("Ctrl+T: not the pin", calls.onTop.length === 2);

  // A button press is never the start of a drag.
  const before = calls.drag;
  pointer(pin, "pointerdown", 10, 10);
  pointer(pin, "pointermove", 60, 10);
  pointer(pin, "pointerup", 60, 10, 0);
  ok("button press: never drags", calls.drag === before);

  // Edges
  const edges = Array.from(r.querySelectorAll<HTMLElement>(".pip-edge"));
  ok("edges: all eight", edges.length === 8);
  for (const e of edges) pointer(e, "pointerdown", 0, 0);
  const want: ResizeDir[] = ["North", "South", "East", "West", "NorthEast", "NorthWest", "SouthEast", "SouthWest"];
  ok("edges: each resizes its own way", want.every((d) => calls.resize.includes(d)) && calls.resize.length === 8, calls.resize.join(","));
  const right = new PointerEvent("pointerdown", { bubbles: true, button: 2, buttons: 2 });
  edges[0]!.dispatchEvent(right);
  ok("edges: right button does nothing", calls.resize.length === 8);

  // Drag from the bar and from the picture
  const bar = r.querySelector(".pip-bar")!;
  pointer(bar, "pointerdown", 100, 10);
  pointer(bar, "pointermove", 102, 11);
  ok("bar: a wobble is not a drag", calls.drag === before);
  pointer(bar, "pointermove", 120, 10);
  ok("bar: a real move drags the window", calls.drag === before + 1);
  pointer(bar, "pointerup", 120, 10, 0);
  const stage = r.querySelector(".pip-stage")!;
  pointer(stage, "pointerdown", 50, 50);
  pointer(stage, "pointermove", 80, 80);
  ok("picture: drags the window too", calls.drag === before + 2);
  pointer(stage, "pointerup", 80, 80, 0);
  pointer(stage, "pointermove", 90, 90, 0);
  ok("picture: a hover after release is not a drag", calls.drag === before + 2);

  // Idle
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: 5, clientY: 5 }));
  ok("idle: movement shows the chrome", r.dataset["idle"] === "false");
  document.documentElement.dispatchEvent(new PointerEvent("pointerleave"));
  ok("idle: leaving the window hides it", r.dataset["idle"] === "true");
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: 5, clientY: 5 }));
  ok("idle: hides after resting", await until(() => r.dataset["idle"] === "true", 2600));

  h.dispose();
  ok("dispose: removes the pane and the fade", !r.isConnected && cssOpacity() === "");
  key("Escape");
  ok("dispose: keys are let go", calls.close === 3);
  URL.revokeObjectURL(url);
}

async function openedFaded(png: Blob): Promise<void> {
  const url = URL.createObjectURL(png);
  const { h } = await mount(infoFor("/pics/faint.png", { opacity: 0.05 }), new Map([["/pics/faint.png", { url }]]));
  ok("opened faded: clamped to the floor", h.opacity === 0.2);
  h.dispose();
  URL.revokeObjectURL(url);
}

async function brokenPicture(): Promise<void> {
  const files = new Map<string, FakeFile>([["/pics/not-really.png", { bytes: TEXT }]]);
  const { h, calls } = await mount(infoFor("/pics/not-really.png", {}, TEXT.length), files);
  ok("broken picture: falls back to quick look", await until(() => h.route === "doc" && !!document.querySelector("body > .ql.pip-adopted:not([hidden])")));
  ok("broken picture: no window reshape", calls.ready.length === 0);
  h.dispose();
  ok("broken picture: quick look removed with it", !document.querySelector(".ql.pip-adopted"));
}

// ── A clip ──────────────────────────────────────────────────────────────────

async function clip(webm: Blob | null): Promise<void> {
  if (!webm) {
    ok("clip: recorded a fixture", false, "MediaRecorder unavailable");
    return;
  }
  const url = URL.createObjectURL(webm);
  const { h, calls } = await mount(infoFor("/clips/c.webm", { mute: true }), new Map([["/clips/c.webm", { url }]]));
  const r = h.root;
  const v = h.media as HTMLVideoElement | null;
  ok("clip: routed", h.route === "video" && v instanceof HTMLVideoElement);
  ok("clip: loads", await until(() => r.dataset["state"] === "ready"));
  ok("clip: reports 16:9", near(calls.ready[0] ?? 0, 320 / 180), String(calls.ready[0]));
  ok("clip: honours --mute", v!.muted && btn(r, "pip-mute")?.getAttribute("aria-pressed") === "true");
  ok("clip: plays on its own", await until(() => !v!.paused && r.dataset["playing"] === "true"));
  ok("clip: transport buttons", ["pip-play", "pip-mute", "pip-loop", "pip-fillbtn"].every((c) => btn(r, c)));
  ok("clip: seek bar is a slider", r.querySelector(".pip-seek")?.getAttribute("role") === "slider");

  const play = btn(r, "pip-play")!;
  play.click();
  ok("play button: pauses", await until(() => v!.paused && play.getAttribute("aria-pressed") === "false"));
  play.click();
  ok("play button: plays", await until(() => !v!.paused));
  key(" ");
  ok("Space: pauses", await until(() => v!.paused));
  key("k");
  ok("K: plays", await until(() => !v!.paused));

  const stage = r.querySelector(".pip-stage")!;
  pointer(stage, "pointerdown", 40, 40);
  pointer(stage, "pointerup", 40, 40, 0);
  ok("click on the picture: pauses", await until(() => v!.paused));
  pointer(stage, "pointerdown", 40, 40);
  pointer(stage, "pointermove", 90, 40);
  pointer(stage, "pointerup", 90, 40, 0);
  ok("drag on the picture: moves, does not play", calls.drag === 1 && v!.paused);
  h.toggle();
  ok("handle toggle: plays", await until(() => !v!.paused));

  btn(r, "pip-mute")!.click();
  ok("mute button: unmutes", !v!.muted && btn(r, "pip-mute")?.getAttribute("aria-pressed") === "false");
  key("m");
  ok("M: mutes", v!.muted);
  btn(r, "pip-loop")!.click();
  ok("loop button: loops", v!.loop && btn(r, "pip-loop")?.getAttribute("aria-pressed") === "true");
  key("l");
  ok("L: stops looping", !v!.loop);

  btn(r, "pip-fillbtn")!.click();
  ok("fill button: covers the window", r.dataset["fill"] === "true" && btn(r, "pip-fillbtn")?.getAttribute("aria-pressed") === "true");
  ok("fill: the picture is cropped, not squashed", getComputedStyle(v!).objectFit === "cover");
  key("f");
  ok("F: back to fitting", r.dataset["fill"] === "false" && getComputedStyle(v!).objectFit === "contain");
  v!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  ok("double-click: fills", r.dataset["fill"] === "true");

  const t0 = v!.currentTime;
  key("ArrowLeft");
  ok("←: never before the start", v!.currentTime >= 0 && v!.currentTime <= t0 + 0.05);

  ok("clip: time is shown", /\d:\d\d \/ \d:\d\d/.test(r.querySelector(".pip-time")?.textContent ?? ""));
  key("Escape");
  ok("Escape: closes a clip", calls.close === 1);
  h.dispose();
  ok("clip: decoder let go", v!.paused && !v!.getAttribute("src"));
  URL.revokeObjectURL(url);
}

// ── A sound ─────────────────────────────────────────────────────────────────

async function sound(): Promise<void> {
  const url = URL.createObjectURL(wavBlob());
  const { h, calls } = await mount(infoFor("/music/tone.wav", { paused: true, start: 0.25, loop: true }), new Map([["/music/tone.wav", { url }]]));
  const r = h.root;
  const a = h.media as HTMLAudioElement | null;
  ok("sound: routed", h.route === "audio" && a instanceof HTMLAudioElement);
  ok("sound: asks for a strip, not a slab", calls.ready[0] === 3.2);
  ok("sound: name on the card", r.querySelector(".pip-audio-name")?.textContent === "tone.wav");
  ok("sound: loads", await until(() => r.dataset["state"] === "ready"));
  ok("sound: honours --start", near(a!.currentTime, 0.25, 0.05), String(a!.currentTime));
  ok("sound: honours --paused", a!.paused);
  ok("sound: honours --loop", a!.loop && btn(r, "pip-loop")?.getAttribute("aria-pressed") === "true");
  ok("sound: transport stays up when idle", (() => {
    r.dataset["idle"] = "true";
    return getComputedStyle(r.querySelector(".pip-controls")!).opacity === "1";
  })());
  ok("sound: five equaliser bars", r.querySelectorAll(".pip-audio-glyph > i").length === 5);

  const seek = r.querySelector<HTMLElement>(".pip-seek")!;
  const box = seek.getBoundingClientRect();
  pointer(seek, "pointerdown", box.left + box.width * 0.5, box.top + 2);
  ok("seek bar: jumps to where it is pressed", near(a!.currentTime, 0.5, 0.08), String(a!.currentTime));
  ok("seek bar: press is not a drag", calls.drag === 0);
  pointer(seek, "pointermove", box.left + box.width * 0.75, box.top + 2);
  ok("seek bar: follows the pointer", near(a!.currentTime, 0.75, 0.08), String(a!.currentTime));
  pointer(seek, "pointerup", box.left + box.width * 0.75, box.top + 2, 0);
  pointer(seek, "pointermove", box.left + box.width * 0.1, box.top + 2, 0);
  ok("seek bar: lets go on release", near(a!.currentTime, 0.75, 0.08));
  ok("seek bar: value for screen readers", seek.getAttribute("aria-valuenow") === "75", String(seek.getAttribute("aria-valuenow")));

  key("ArrowLeft");
  ok("←: five seconds back, stops at 0", a!.currentTime === 0);
  key("ArrowRight");
  ok("→: stops at the end", near(a!.currentTime, a!.duration, 0.01));
  key("f");
  ok("F: nothing to fill on a sound", r.dataset["fill"] !== "true");
  key("Escape");
  ok("Escape: closes a sound", calls.close === 1);
  h.dispose();
  URL.revokeObjectURL(url);
}

// ── Adopted surfaces ────────────────────────────────────────────────────────

async function document_(): Promise<void> {
  const files = new Map<string, FakeFile>([["/notes/readme.txt", { bytes: TEXT }]]);
  const { h, calls } = await mount(infoFor("/notes/readme.txt", {}, TEXT.length), files);
  const ql = (): HTMLElement | null => document.querySelector<HTMLElement>("body > .ql.pip-adopted");
  ok("text: routed to quick look", h.route === "doc" && h.root.dataset["route"] === "doc");
  ok("text: quick look is up", await until(() => !!ql() && !ql()!.hidden));
  ok("text: shows the file", await until(() => /Pop-out quick look/.test(ql()?.textContent ?? "")));
  // A real 360×220 pop-out showed two lines of text under a details block.
  const facts = (): HTMLElement | null => ql()!.querySelector<HTMLElement>(".ql-facts");
  ok("text: details start folded, so the file gets the room", facts()?.hidden === true);
  const info = ql()!.querySelector<HTMLButtonElement>('.ql-icon[aria-label="File details"]');
  info?.click();
  ok("text: ⓘ still opens the details", facts()?.hidden === false && info?.getAttribute("aria-pressed") === "true");
  info?.click();
  ok("text: …and folds them again", facts()?.hidden === true);
  ok("text: the pop-out bar floats above it", Number(getComputedStyle(host).zIndex) > Number(getComputedStyle(ql()!).zIndex || 0));
  ok("text: pill has no title", getComputedStyle(h.root.querySelector(".pip-title")!).display === "none");
  ok("text: pane lets clicks through", getComputedStyle(h.root).pointerEvents === "none");
  ok("text: pill buttons still clickable", getComputedStyle(h.root.querySelector(".pip-bar")!).pointerEvents === "auto");
  key("]");
  key("[");
  ok("text: fade reaches quick look too", await until(() => getComputedStyle(ql()!).opacity === "0.9"), getComputedStyle(ql()!).opacity);
  key("t");
  ok("text: T still pins", calls.onTop.at(-1) === false);
  key("Escape");
  ok("text: Escape puts it away and closes the window", await until(() => calls.close === 1), `close=${calls.close}`);
  h.dispose();
  ok("text: quick look removed", !ql());

  const second = await mount(infoFor("/notes/readme.txt", {}, TEXT.length), files);
  await until(() => !!ql() && !ql()!.hidden);
  ql()!.querySelector<HTMLButtonElement>(".ql-close")?.click();
  ok("text: quick look's own ✕ closes the window", await until(() => second.calls.close === 1));
  second.h.dispose();
}

async function table(): Promise<void> {
  const files = new Map<string, FakeFile>([["/data/counts.csv", { bytes: CSV }]]);
  const { h, calls } = await mount(infoFor("/data/counts.csv", {}, CSV.length), files);
  const tbl = (): HTMLElement | null => document.querySelector<HTMLElement>("body > .tbl.pip-adopted");
  ok("table: routed", h.route === "table");
  ok("table: grid is up", await until(() => !!tbl() && !tbl()!.hidden));
  ok("table: reads the rows (needs the size)", await until(() => /charlie/.test(tbl()?.textContent ?? "")), (tbl()?.textContent ?? "").slice(0, 120));
  key("ArrowDown");
  ok("table: arrows go to the grid, not the window", calls.close === 0);
  key("Escape");
  ok("table: Escape closes the grid and the window", await until(() => calls.close === 1), `close=${calls.close}`);
  h.dispose();
  ok("table: grid removed", !tbl());

  const second = await mount(infoFor("/data/counts.csv", {}, CSV.length), files);
  await until(() => !!tbl() && !tbl()!.hidden);
  const closeBtn = Array.from(tbl()!.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Close");
  closeBtn?.click();
  ok("table: its Close button closes the window", !!closeBtn && await until(() => second.calls.close === 1));
  second.h.dispose();
}

/** The smallest honest STL: one triangle, in the ASCII form of the format. */
const STL = new TextEncoder().encode(
  [
    "solid t",
    "facet normal 0 0 1",
    " outer loop",
    "  vertex 0 0 0",
    "  vertex 10 0 0",
    "  vertex 0 10 0",
    " endloop",
    "endfacet",
    "endsolid t",
  ].join("\n"),
);

/**
 * Zoom and pan inside a pop-out.
 *
 * Asked for on 2026-09-14: "I need to be able to zoom in and out and move
 * around in either a PDF or STL file in the picture in picture", and then
 * "expanding and contracting the pip ... the margins are so weird".
 *
 * Three things were wrong and each has a check here, because each was
 * invisible to the route test that was the only pop-out coverage a document
 * or a model had:
 *
 *  - The window took ctrl-wheel for its own fade. That is the only zoom a
 *    mouse has, so zooming a PDF faded the window instead.
 *  - A zoomed page could only be moved by scrolling, and a pop-out is exactly
 *    where a scrollbar is hardest to hit.
 *  - A PDF was rasterised at the width the card happened to be when it opened
 *    and never again, so resizing the window left the pages the wrong size in
 *    the middle of it.
 */
async function zoomAndPan(): Promise<void> {
  const paper = "/dev/papers/resnet.pdf";
  const have = await fetch(paper, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
  if (!have) {
    skipped("pdf: zoom, pan and resize in a pop-out", paper + " is not on this machine");
  } else {
    const files = new Map<string, FakeFile>([["/papers/resnet.pdf", { url: paper }]]);
    const { h } = await mount(infoFor("/papers/resnet.pdf"), files);
    const ql = (): HTMLElement | null => document.querySelector<HTMLElement>("body > .ql.pip-adopted");
    const scroller = (): HTMLElement => ql()!.querySelector<HTMLElement>(".ql-body")!;
    const layer = (): HTMLElement => ql()!.querySelector<HTMLElement>(".ql-zoom")!;
    const page = (): HTMLCanvasElement | null => ql()!.querySelector<HTMLCanvasElement>("canvas.ql-page");
    const fade = (): string => getComputedStyle(document.documentElement).getPropertyValue("--pip-opacity").trim();
    const solid = (): boolean => fade() === "" || fade() === "1";

    ok("pdf: routed to quick look", h.route === "doc");
    ok("pdf: a page is drawn", await until(() => !!page(), 15000));

    ok("pdf: ctrl-wheel is taken by the page", wheel(scroller(), -300, true));
    ok("pdf: ctrl-wheel zooms in", await until(() => scaleOf(layer()) > 1.05), "scale=" + scaleOf(layer()));
    ok("pdf: ...and the window does not fade instead", solid(), "opacity=" + fade());

    const big = scaleOf(layer());
    wheel(scroller(), 300, true);
    ok("pdf: ctrl-wheel the other way zooms out", await until(() => scaleOf(layer()) < big - 0.05), "scale=" + scaleOf(layer()));

    // Back in, far enough that there is somewhere to pan to.
    wheel(scroller(), -600, true);
    await until(() => scroller().scrollWidth > scroller().clientWidth + 8);
    const b = scroller();
    b.scrollLeft = 40;
    b.scrollTop = 40;
    const r = b.getBoundingClientRect();
    const at = (type: string, dx: number, dy: number, buttons = 1): void => {
      b.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: "mouse", pointerId: 7, button: 0, buttons,
        clientX: r.left + r.width / 2 + dx, clientY: r.top + r.height / 2 + dy,
      }));
    };
    at("pointerdown", 0, 0);
    at("pointermove", -30, -25);
    at("pointerup", -30, -25, 0);
    ok("pdf: dragging with a mouse moves the zoomed page", b.scrollLeft > 60 && b.scrollTop > 55,
      "left=" + b.scrollLeft + " top=" + b.scrollTop);

    // Back to life size before the resize is measured: the zoom layer carries
    // a `transform: scale()`, so a bounding box while it is up is the zoom's
    // answer, not the layout's. The page's own CSS width is what rasterising
    // at a new width actually changes, and it is not scaled by anything.
    wheel(scroller(), 900, true);
    await until(() => scaleOf(layer()) <= 1.01);
    const drawnAt = (): number => Number.parseFloat(page()?.style.width ?? "0");
    await until(() => drawnAt() > 0);

    // Narrow the card the way dragging the window's edge would, and let the
    // debounce run out.
    const card = ql()!.querySelector<HTMLElement>(".ql-card")!;
    const wide = drawnAt();
    card.style.width = "420px";
    ok("pdf: the page is redrawn narrower when the window comes in",
      await until(() => drawnAt() > 0 && drawnAt() < wide - 20, 8000),
      "was " + Math.round(wide) + " now " + Math.round(drawnAt()));
    ok("pdf: and fits, rather than being squeezed by max-width",
      drawnAt() <= scroller().clientWidth + 1,
      "page " + Math.round(drawnAt()) + " in " + scroller().clientWidth);

    const narrow = drawnAt();
    card.style.width = "";
    ok("pdf: and redrawn wider when it goes back out",
      await until(() => drawnAt() > narrow + 20, 8000),
      "was " + Math.round(narrow) + " now " + Math.round(drawnAt()));

    h.dispose();
  }

  const files = new Map<string, FakeFile>([["/models/part.stl", { bytes: STL }]]);
  const { h } = await mount(infoFor("/models/part.stl", {}, STL.length), files);
  const sv = (): HTMLElement | null => document.querySelector<HTMLElement>("body > .sv.pip-adopted");
  const canvas = (): HTMLCanvasElement | null => sv()?.querySelector<HTMLCanvasElement>("canvas.sv-canvas") ?? null;
  ok("stl: routed to the 3D viewer", h.route === "scene");
  ok("stl: the viewer is up", await until(() => !!sv() && !sv()!.hidden, 15000));
  const c = await until(() => !!canvas(), 15000) ? canvas() : null;
  ok("stl: it has a canvas", !!c);
  if (c) {
    // The pane the pop-out draws its own chrome on covers the whole window. If
    // it were taking presses, every orbit and every scroll-zoom would land on
    // it instead of on the model -- which is the whole reason it is
    // `pointer-events: none` for an adopted surface.
    const r = c.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    ok("stl: a press in the middle lands on the model, not the pop-out's pane",
      hit === c || !!(hit instanceof Element && hit.closest(".sv")),
      hit instanceof Element ? hit.className : "nothing");
    ok("stl: the wheel is taken by the viewer, so the window does not fade", wheel(c, -240));
    const left = getComputedStyle(document.documentElement).getPropertyValue("--pip-opacity").trim();
    ok("stl: ...confirmed, still solid", left === "" || left === "1", "opacity=" + left);
  }
  h.dispose();
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  pure();
  const png = await pngBlob();
  const webm = await webmBlob();
  await empty();
  await picture(png);
  await openedFaded(png);
  await brokenPicture();
  await clip(webm);
  await sound();
  await document_();
  await table();
  await zoomAndPan();
}

run()
  .catch((e: unknown) => ok("harness ran to the end", false, e instanceof Error ? `${e.message}\n${e.stack}` : String(e)))
  .finally(() => {
    const line = `pip: ${pass} passed, ${fail} failed`;
    document.title = line;
    console.log(`%c${line}`, `color:${fail ? "#ff5d5d" : "#3ddc84"}`);
  });
