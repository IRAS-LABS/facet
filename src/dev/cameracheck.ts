/**
 * Checks the camera (item 28).
 *
 * The reason this file exists at all is that a camera is the one surface in
 * FACET that cannot be checked by opening a file, and the obvious conclusion —
 * "so it can only be checked by hand, with a webcam" — is wrong. A `<canvas>`
 * has `captureStream()`, which produces a real `MediaStreamTrack` carrying real
 * frames. Feed that back through a fake `CameraSource` and the entire surface
 * runs: preview, shutter, encode, recorder, save. On a machine with no camera,
 * with nothing stubbed inside the code under test.
 *
 * Six claims, and why each is worth a test rather than a look.
 *
 * **1. The look on screen and the look in the file are one string.** The
 * promise the whole filter feature rests on is that a CSS `filter` on the
 * preview and a canvas `ctx.filter` on the capture are the same declaration
 * interpreted by the same engine. One `filterOf` feeds both, so what is
 * asserted is that the string is right and that both consumers get *it* — a
 * second formatter written for the canvas is exactly the bug this prevents.
 *
 * **2. A neutral look must produce no filter at all.** Not `brightness(1)
 * contrast(1) saturate(1)`, which is a no-op that still forces a filter pass
 * over every frame of a 4K preview. The empty string is the difference between
 * a camera that idles and one that runs the fan.
 *
 * **3. The still is the sensor's size, not the preview's.** Asserted by giving
 * the fake camera a resolution that is nothing like the element's box and
 * checking the decoded PNG's pixel dimensions. This is the defect that hides
 * for months, because on the developer's maximised window the two numbers are
 * close enough that nobody looks.
 *
 * **4. Two captures in the same second must not collide.** `stampName` is
 * second-resolution, so a fast pair produces the same name — and the answer is
 * `overwrite: false` at the write, not a cleverer name. The check is that the
 * shell was *asked* not to overwrite, because that is the only part of it this
 * side of the boundary controls.
 *
 * **5. Closing releases the device.** A webcam light that stays on after the
 * window is shut is the worst bug a camera app can ship, and it is the default
 * behaviour: dropping a `MediaStream` reference stops nothing. Asserted on the
 * tracks, which record their own `readyState`.
 *
 * **6. A user's own look survives a reload.** Persistence through the same
 * backend shape the folder rules use, including the part that matters — a
 * half-written or hand-edited store must not throw, it must yield what it can.
 *
 * Dev-only. Loaded by /dev/cameracheck.html, which is not a build input.
 *
 *   http://localhost:8183/dev/cameracheck.html
 */

import "../styles/base.css";
import "../styles/camera.css";

import { themes } from "@core/theme/theme-engine";

import {
  allPresets,
  bestVideoMime,
  clock,
  coerceLook,
  extOf,
  extOfMime,
  filterOf,
  gridLines,
  memoryPresets,
  mimeOf,
  NEUTRAL,
  parsePresets,
  RANGE,
  sameLook,
  stampName,
  videoConstraints,
  withPreset,
  withoutPreset,
  writePresets,
  type Look,
} from "@core/capture/camera";
import { CameraView, type CameraPrefs, type CameraSource } from "@ui/camera-view";

/* Without this every `var(--fct-…)` resolves to nothing, and the surface draws
   with no borders, no button fills and an invisible record control — which
   looks like a styling bug in the camera and is not one. It matters more here
   than in most harnesses because this is a surface you check by looking. */
themes.init();

let pass = 0;
let fail = 0;

const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) {
    pass++;
    console.log("ok  ", name);
  } else {
    fail++;
    console.error("FAIL", name, detail);
  }
};

// ── A camera made of a canvas ───────────────────────────────────────────────

/**
 * A fake `getUserMedia`, backed by a canvas that is actually painting.
 *
 * It has to keep painting: `captureStream(fps)` emits frames on a clock only
 * for a canvas whose contents change, and a still one produces a stream that a
 * `<video>` element will never report a `videoWidth` for. So a moving bar is
 * drawn on an interval — the cheapest thing that counts as "the camera is
 * live".
 */
class FakeCamera {
  readonly canvas = document.createElement("canvas");
  private timer = 0;
  private frame = 0;
  /** Every stream handed out, so the test can ask whether they were stopped. */
  readonly issued: MediaStream[] = [];
  opened = 0;
  lastConstraints: MediaStreamConstraints | null = null;

  constructor(readonly width: number, readonly height: number) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.paint();
    this.timer = window.setInterval(() => this.paint(), 40);
  }

  private paint(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    // A flat mid-grey field with one moving stripe. Mid-grey rather than white
    // because assertion 1 reads a pixel back through a brightness filter, and
    // a saturated channel cannot get brighter — the test would pass on a
    // filter that did nothing.
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect((this.frame * 7) % this.width, 0, 12, this.height);
    this.frame++;
  }

  source(): CameraSource {
    return {
      devices: () =>
        Promise.resolve([
          fakeDevice("cam-a", "Front camera (fake)"),
          fakeDevice("cam-b", "Back camera (fake)"),
        ]),
      open: (constraints) => {
        this.opened++;
        this.lastConstraints = constraints;
        const stream = this.canvas.captureStream(30);
        this.issued.push(stream);
        return Promise.resolve(stream);
      },
    };
  }

  destroy(): void {
    window.clearInterval(this.timer);
  }
}

function fakeDevice(deviceId: string, label: string): MediaDeviceInfo {
  return {
    deviceId,
    kind: "videoinput",
    label,
    groupId: "g",
    toJSON() {
      return this;
    },
  } as MediaDeviceInfo;
}

/** What was written, in the order it was written. */
interface Written {
  path: string;
  bytes: Uint8Array;
  overwrite: boolean;
}

const PREFS: CameraPrefs = {
  format: "png",
  quality: 0.92,
  height: 1080,
  mirror: false,
  grid: "thirds",
  countdown: 0,
  sound: false,
};

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until a condition holds, or give up. Frames arrive when they arrive. */
async function until(cond: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await wait(50);
  }
  return cond();
}

/** Decode PNG/JPEG bytes far enough to learn their real pixel dimensions. */
function sizeOf(bytes: Uint8Array, mime: string): Promise<[number, number]> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve([img.naturalWidth, img.naturalHeight]);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("the capture did not decode as an image"));
    };
    img.src = url;
  });
}

// ── Pure checks ─────────────────────────────────────────────────────────────

function pure(): void {
  // ── 1 and 2. The filter string ────────────────────────────────────────────

  ok("a neutral look produces no filter at all, not a no-op one",
    filterOf(NEUTRAL) === "", JSON.stringify(filterOf(NEUTRAL)));

  const bright: Look = { ...NEUTRAL, brightness: 1.4 };
  ok("one moved slider produces one function",
    filterOf(bright) === "brightness(1.4)", filterOf(bright));

  const many: Look = { ...NEUTRAL, contrast: 1.2, saturation: 0.5, mono: 1, blur: 3 };
  ok("several are joined in a fixed order, because filter order changes the result",
    filterOf(many) === "contrast(1.2) saturate(0.5) grayscale(1) blur(3px)", filterOf(many));

  ok("the units the CSS filter grammar demands are attached — deg and px",
    filterOf({ ...NEUTRAL, tint: 30 }) === "hue-rotate(30deg)" &&
      filterOf({ ...NEUTRAL, blur: 2 }).endsWith("px)"),
    `${filterOf({ ...NEUTRAL, tint: 30 })} / ${filterOf({ ...NEUTRAL, blur: 2 })}`);

  /* A filter string is fed straight into a CSS declaration and into
     `ctx.filter`. Both are parsers, and both discard the whole declaration on
     one bad token — so a look carrying 1.0000000000000002 from a slider must
     not serialise as that. */
  ok("values are rounded before they reach a parser",
    filterOf({ ...NEUTRAL, brightness: 1.0000000000000002 }) === "",
    filterOf({ ...NEUTRAL, brightness: 1.0000000000000002 }));

  /* The browser is the authority on whether the string parses at all, and it
     will say so: assigning an invalid filter to a style leaves the property
     empty. Asserting against a hand-written expectation only proves the string
     matches what I expected; this proves it is a filter. */
  const probe = document.createElement("div");
  const full: Look = {
    brightness: 1.3, contrast: 0.8, saturation: 1.5, warmth: 0.4,
    tint: -25, mono: 0.3, negative: 0.2, blur: 1.5,
  };
  probe.style.filter = filterOf(full);
  ok("…and every one of the eight controls together is a filter the browser accepts",
    probe.style.filter !== "", filterOf(full));

  // ── Looks, clamping and equality ─────────────────────────────────────────

  ok("a look read back from nothing is the neutral one",
    sameLook(coerceLook(undefined), NEUTRAL));
  ok("…and a half-written one keeps what it can and defaults the rest",
    coerceLook({ brightness: 1.5, contrast: "nonsense" }).brightness === 1.5 &&
      coerceLook({ brightness: 1.5, contrast: "nonsense" }).contrast === NEUTRAL.contrast);
  ok("…and a value beyond the slider is clamped to it, not thrown away",
    coerceLook({ blur: 9999 }).blur === RANGE.blur[1],
    String(coerceLook({ blur: 9999 }).blur));

  // ── Presets ──────────────────────────────────────────────────────────────

  const store = memoryPresets();
  ok("the shipped looks are there before anything has been saved",
    allPresets(store).length >= 8 && allPresets(store)[0]!.name === "Natural");

  let list = withPreset(allPresets(store), "Kitchen", { ...NEUTRAL, warmth: 0.5 });
  store.write(writePresets(list));
  ok("a saved look survives a reload",
    allPresets(memoryPresets(store.read())).some((p) => p.name === "Kitchen"));
  ok("…and only the user's own are written, never the built-ins",
    parsePresets(store.read() ?? "").length === 1,
    store.read() ?? "");

  list = withPreset(allPresets(store), "kitchen", { ...NEUTRAL, warmth: 0.9 });
  ok("saving under a name that already exists replaces it rather than adding a twin",
    list.filter((p) => p.name.toLowerCase() === "kitchen").length === 1);

  ok("removing one leaves the rest",
    !withoutPreset(list, "Kitchen").some((p) => p.name.toLowerCase() === "kitchen"));

  /* The store is a text file a user can open, so it will eventually be a text
     file a user has broken. Every one of these must yield a list, not an
     exception — a camera that will not start because a preset file has a stray
     brace is a camera that has lost its own photos to the user. */
  for (const junk of ["", "{", "null", "[]", '{"a":1}', "[1,2,3]", '[{"name":"x"}]']) {
    ok(`a preset store of ${JSON.stringify(junk)} yields a list rather than throwing`,
      Array.isArray(parsePresets(junk)));
  }

  // ── Grids ────────────────────────────────────────────────────────────────

  ok("no grid means no lines", gridLines("none", 1.78).length === 0);
  ok("the rule of thirds is four lines", gridLines("thirds", 1.78).length === 4);
  ok("…drawn at the thirds",
    gridLines("thirds", 1.78).some((l) => Math.abs(l.x1 - 1 / 3) < 1e-9));
  ok("every guide is expressed in fractions, so it scales with the stage",
    gridLines("golden", 1.78).every((l) =>
      [l.x1, l.y1, l.x2, l.y2].every((v) => v >= 0 && v <= 1)));
  /* The square guide is the only one that has to know the shape of the frame,
     and it turns through ninety degrees on the way past square: on a landscape
     preview a square crop is bounded by two *vertical* lines and on a portrait
     one by two horizontal. So the check is on the geometry rather than on the
     line count — the gap between the pair, as a fraction, must be exactly the
     short side over the long one, which is what makes the region square. */
  const wide = gridLines("square", 16 / 9);
  const tall = gridLines("square", 9 / 16);
  ok("a square crop in a landscape frame is bounded by two vertical lines",
    wide.length === 2 && wide.every((l) => l.x1 === l.x2));
  ok("…and in a portrait frame by two horizontal ones, because the crop turns with the frame",
    tall.length === 2 && tall.every((l) => l.y1 === l.y2));
  ok("…and the region they bound really is square at either aspect",
    Math.abs(Math.abs(wide[1]!.x1 - wide[0]!.x1) - 9 / 16) < 1e-6 &&
      Math.abs(Math.abs(tall[1]!.y1 - tall[0]!.y1) - 9 / 16) < 1e-6,
    `${Math.abs(wide[1]!.x1 - wide[0]!.x1)} / ${Math.abs(tall[1]!.y1 - tall[0]!.y1)}`);
  ok("…and an already-square frame needs no guide at all",
    gridLines("square", 1).length === 0);

  // ── Names and formats ────────────────────────────────────────────────────

  ok("a photo is named for the moment it was taken, sortable and unambiguous",
    stampName(new Date(2026, 7, 16, 20, 15, 30), "jpg") === "facet-2026-08-16-201530.jpg",
    stampName(new Date(2026, 7, 16, 20, 15, 30), "jpg"));
  ok("…with a zero-padded stamp, so the names sort the way they read",
    stampName(new Date(2026, 0, 2, 3, 4, 5), "png") === "facet-2026-01-02-030405.png",
    stampName(new Date(2026, 0, 2, 3, 4, 5), "png"));
  ok("the extension is the one people have, not the one the MIME type spells",
    extOf("jpeg") === "jpg" && mimeOf("jpeg") === "image/jpeg");

  ok("the clock reads as a clock",
    clock(0) === "0:00" && clock(65) === "1:05" && clock(59.9) === "0:59",
    `${clock(0)} ${clock(65)} ${clock(59.9)}`);
  // An hour is where a recording timer stops being minutes: "60:00" is a number
  // to work out, "1:00:00" is a time to read.
  ok("…and grows an hours field rather than counting past sixty minutes",
    clock(3600) === "1:00:00" && clock(3725) === "1:02:05",
    `${clock(3600)} ${clock(3725)}`);

  ok("a resolution is asked for, never demanded — an exact height fails on a camera that lacks it",
    JSON.stringify(videoConstraints(null, 1080)).includes("ideal") &&
      !JSON.stringify(videoConstraints(null, 1080)).includes('"height":{"exact"'),
    JSON.stringify(videoConstraints(null, 1080)));
  ok("…but a chosen camera is exact, because 'roughly that camera' is not a thing",
    JSON.stringify(videoConstraints("cam-b", 720)).includes('"deviceId":{"exact":"cam-b"}'),
    JSON.stringify(videoConstraints("cam-b", 720)));

  ok("the best container this browser can record is chosen, not assumed",
    bestVideoMime((m) => m.includes("vp9")) !== null &&
      bestVideoMime((m) => m.includes("vp9"))!.includes("vp9"));
  ok("…and a browser that can record nothing says so rather than producing a broken file",
    bestVideoMime(() => false) === null);
  ok("the extension follows the container that was actually used",
    extOfMime("video/webm;codecs=vp9,opus") === "webm" && extOfMime("video/mp4") === "mp4");
}

// ── Live checks, against a canvas pretending to be a camera ─────────────────

async function live(): Promise<void> {
  const fake = new FakeCamera(1280, 720);
  const written: Written[] = [];
  let refreshed = 0;
  const store = memoryPresets();

  const view = new CameraView({
    source: fake.source(),
    folder: () => "C:/fake/Pictures",
    writeFile: (path, bytes, overwrite) => {
      written.push({ path, bytes, overwrite });
      // The real shell renames rather than clobbering, and reports the name it
      // chose. Modelled here so the surface is tested against what it is
      // actually given back, not against the name it asked for.
      const taken = written.filter((w) => w.path === path).length;
      const final = taken > 1 ? path.replace(/(\.\w+)$/, ` (${taken})$1`) : path;
      return Promise.resolve(final);
    },
    refresh: () => {
      refreshed++;
    },
    presets: store,
    prefs: () => ({ ...PREFS }),
  });

  try {
    await view.open();
    ok("the camera opens", view.isOpen);

    const video = document.querySelector<HTMLVideoElement>(".cam-video");
    ok("there is a live preview", video !== null);
    const ready = await until(() => (video?.videoWidth ?? 0) > 0);
    ok("…and it is receiving frames from the device", ready, `videoWidth ${video?.videoWidth}`);

    ok("the camera list is filled from the device layer, with real labels",
      document.querySelectorAll(".cam-sel option[value='cam-a']").length === 1);
    ok("…and the list is offered only when there is a choice to make",
      document.querySelector<HTMLSelectElement>(".cam-sel")?.disabled === false);
    /* Filling a `<select>` is not the same as selecting something in it. Left
       to the browser this landed on selectedIndex -1 and drew as an empty box
       — a control whose entire job is to say which camera you are looking
       through, saying nothing. */
    const which = document.querySelector<HTMLSelectElement>(".cam-sel");
    ok("…and one of them is actually selected, so the bar says which camera this is",
      which !== null && which.selectedIndex >= 0 && which.value !== "",
      `selectedIndex ${which?.selectedIndex}`);

    /* Assertion 1's other half. The preview element must be carrying the same
       string the capture path will hand to the canvas — not an equivalent one,
       the same one, from the same function. */
    const panelBtn = [...document.querySelectorAll<HTMLButtonElement>(".cam-btn")]
      .find((b) => b.textContent?.includes("Look"));
    panelBtn?.click();
    const slider = document.querySelector<HTMLInputElement>(".cam-row input[type='range']");
    ok("the look panel opens with a control for every adjustment",
      document.querySelectorAll(".cam-row").length === 8,
      String(document.querySelectorAll(".cam-row").length));
    if (slider) {
      slider.value = "1.5";
      slider.dispatchEvent(new Event("input"));
    }
    ok("moving a slider changes the preview immediately, not on release",
      video?.style.filter === filterOf({ ...NEUTRAL, brightness: 1.5 }),
      video?.style.filter ?? "");

    // ── 3. The still is the sensor's size ──────────────────────────────────

    const shutter = document.querySelector<HTMLButtonElement>(".cam-shutter");
    shutter?.click();
    const shot = await until(() => written.length > 0);
    ok("the shutter writes a file", shot, `${written.length} written`);

    if (written[0]) {
      const [w, h] = await sizeOf(written[0].bytes, "image/png");
      ok("the photo is the camera's own resolution, not the size of the preview on screen",
        w === 1280 && h === 720, `${w} × ${h} — the preview element is ${video?.clientWidth} wide`);
      ok("…and it is named for the moment it was taken, in the chosen folder",
        /^C:\/fake\/Pictures\/facet-\d{4}-\d{2}-\d{2}-\d{6}\.png$/.test(written[0].path),
        written[0].path);
      ok("…and the folder behind is told to reload, so it appears without an F5",
        refreshed > 0);

      /* Assertion 1, closed. The filter was applied to the preview; here it is
         proved to have reached the pixels. A mid-grey field at brightness 1.5
         is a lighter grey — and at 1.0 it is not, which is the control that
         makes this mean something. */
      const url = URL.createObjectURL(new Blob([written[0].bytes as BlobPart], { type: "image/png" }));
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("no decode"));
        img.src = url;
      });
      const probe = document.createElement("canvas");
      probe.width = img.naturalWidth;
      probe.height = img.naturalHeight;
      probe.getContext("2d")?.drawImage(img, 0, 0);
      // Sampled a long way from the moving stripe, which is the only part of
      // the field that is not flat.
      const px = probe.getContext("2d")?.getImageData(probe.width - 40, probe.height - 40, 1, 1).data;
      URL.revokeObjectURL(url);
      ok("the look on screen is the look in the file — the same filter string reached the pixels",
        px !== undefined && px[0]! > 0x90,
        `sampled ${px?.[0]} from a 0x80 field at brightness 1.5`);
    }

    // ── 4. Two in the same second ──────────────────────────────────────────

    shutter?.click();
    await until(() => written.length > 1);
    ok("a second photo in the same second is still written",
      written.length > 1, `${written.length}`);
    ok("…and it is written with overwrite refused, which is what stops it landing on the first",
      written.every((w) => w.overwrite === false));

    // ── Keeping a look ─────────────────────────────────────────────────────

    const nameBox = document.querySelector<HTMLInputElement>(".cam-name");
    if (nameBox) {
      nameBox.value = "Kitchen light";
      document.querySelector<HTMLButtonElement>(".cam-keep")?.click();
    }
    ok("a look can be named and kept",
      (store.read() ?? "").includes("Kitchen light"), store.read() ?? "");
    ok("…and it appears alongside the shipped ones",
      [...document.querySelectorAll(".cam-preset")].some((b) => b.textContent === "Kitchen light"));

    // ── Recording ──────────────────────────────────────────────────────────

    const before = written.length;
    const rec = document.querySelector<HTMLButtonElement>(".cam-rec");
    rec?.click();
    await until(() => rec?.classList.contains("cam-on") === true, 1500);
    ok("recording starts", rec?.classList.contains("cam-on") === true);
    ok("…and says how long it has been going",
      document.querySelector<HTMLElement>(".cam-time")?.hidden === false);
    await wait(1200);
    rec?.click();
    const saved = await until(() => written.length > before, 6000);
    ok("stopping writes a clip", saved, `${written.length - before} written`);
    if (written.length > before) {
      const clip = written[written.length - 1]!;
      ok("…named with the container it was actually recorded in",
        /\.(webm|mp4)$/.test(clip.path), clip.path);
      /* Not just "a file appeared" — a file with a second of frames in it.
         This is the assertion that caught the draw loop running on
         `requestAnimationFrame`: rAF is throttled to about once a second
         whenever the window is not being painted, which is a headless browser
         always and a minimised window in real life, so the clip came out empty.
         A byte floor is a crude frame counter, but it is the one that fails
         when the frames stop arriving. */
      ok("…and a second of recording put a second of frames in it, not one frozen one",
        clip.bytes.length > 4000, `${clip.bytes.length} bytes`);
    }
    ok("the timer is put away once recording stops",
      document.querySelector<HTMLElement>(".cam-time")?.hidden === true);

    // ── Grids ──────────────────────────────────────────────────────────────

    ok("the framing guides are drawn over the preview",
      document.querySelectorAll(".cam-guides line").length === 4,
      String(document.querySelectorAll(".cam-guides line").length));

    // ── 5. Closing releases the device ─────────────────────────────────────

    const tracks = fake.issued.flatMap((s) => s.getTracks());
    ok("the device was live while the camera was open",
      tracks.some((t) => t.readyState === "live"));
    view.close();
    ok("the camera closes", !view.isOpen);
    ok("…and every track is stopped, so the webcam light goes out",
      fake.issued.flatMap((s) => s.getTracks()).every((t) => t.readyState === "ended"),
      fake.issued.flatMap((s) => s.getTracks()).map((t) => t.readyState).join(","));
  } finally {
    view.close();
    fake.destroy();
  }
}

async function main(): Promise<void> {
  pure();
  try {
    await live();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    // `captureStream` and `MediaRecorder` are the two things a browser can
    // legitimately lack here. Anything else is a real defect.
    if (/captureStream|MediaRecorder|not a function/i.test(why)) {
      console.warn("live camera skipped — this browser cannot fake a camera:", why);
    } else {
      ok("the live camera did not throw", false, why);
    }
  }

  const line = `camera: ${pass} passed, ${fail} failed`;
  console.log(`%c${line}`, `color:${fail ? "#ff6b6b" : "#3ddc84"}`);
  document.title = line;
}

void main();
