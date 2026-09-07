/**
 * Exercises the metadata panel against real photographs in a real browser.
 *
 * `exif.ts` is already tested byte-for-byte in Node; this covers the half that
 * test cannot see — whether the panel actually paints, whether the alert fires
 * on a file that deserves it, and whether the button that says it will clean a
 * file produces bytes that are in fact clean. Wiring is where "written" and
 * "works" usually part company, so it gets its own harness.
 *
 * Dev-only. Loaded by /dev/metacheck.html, which is not one of the build's inputs,
 * so none of this reaches the binary.
 *
 * It needs three real files — a photo with EXIF, any other JPEG, any PNG —
 * staged where the dev server can serve them. They are deliberately not
 * committed, because they are somebody's photographs:
 *
 *   .\scripts\fixtures.ps1            # stage
 *   .\scripts\fixtures.ps1 -Clean     # recycle afterwards
 *
 * They land in `fixtures/`, not `public/`. `public/` is copied wholesale into
 * `dist/` and `dist/` is baked into the binary, so a photograph left staged
 * there ends up inside a shipped artifact — which is exactly what happened on
 * 2026-08-16. `vite.config.ts` serves `fixtures/` over HTTP in dev only.
 *
 * Then open http://localhost:8183/dev/metacheck.html — the page title becomes the
 * score and the panel is left open on a.jpg to be looked at.
 */

import "../styles/base.css";
import "../styles/shell.css";

import { MetaPanel } from "@ui/metadata";
import { fixtureBytes, guarded } from "./fixture";
import { readMetadata } from "@core/meta/exif";
import { themes } from "@core/theme/theme-engine";
import type { FileEntry } from "@core/explorer/types";

// Without this every colour token is undefined, and a panel whose borders and
// alert ground silently vanish looks fine to an assertion and wrong to a person.
themes.init();

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const written = new Map<string, Uint8Array>();

const bytesOf = (path: string): Promise<Uint8Array> => fixtureBytes("/_metacheck/" + path);

const panel = new MetaPanel({
  readAll: (path) => bytesOf(path),
  writeFile: async (path, bytes, overwrite) => {
    if (!overwrite && written.has(path)) throw new Error(`${path}: already exists`);
    written.set(path, bytes);
    return path;
  },
  refresh: () => {},
});

const entry = (name: string, size: number, kind: FileEntry["kind"]): FileEntry => ({
  name,
  path: name,
  kind,
  ext: name.split(".").pop() ?? "",
  size,
  modified: 0,
  hidden: false,
});

const q = (sel: string): HTMLElement | null => document.querySelector(sel);
const text = (sel: string): string => q(sel)?.textContent ?? "";

async function run(): Promise<void> {
  // ── A phone photo: the case the whole feature exists for ──────────────────
  const a = entry("a.jpg", 5113772, "image");
  await panel.show([a]);

  ok("panel is open", panel.isOpen);
  ok("title is the file name", text(".mp-title") === "a.jpg", text(".mp-title"));
  ok("format and field count in the subtitle", /JPEG · .* · \d+ fields/.test(text(".mp-sub")), text(".mp-sub"));

  const groups = document.querySelectorAll(".mp-group");
  ok("groups rendered", groups.length > 0, `${groups.length}`);
  const rows = document.querySelectorAll(".mp-group dd");
  ok("tag rows rendered", rows.length >= 8, `${rows.length} rows`);

  const raw = await bytesOf("a.jpg");
  const meta = readMetadata(raw);
  ok("alert shown iff the file is sensitive", !!q(".mp-alert") === meta.sensitive, `sensitive=${meta.sensitive}`);
  if (meta.sensitive) {
    ok("alert names at least one concrete reason", (q(".mp-alert")?.querySelectorAll("li").length ?? 0) > 0);
    // A pattern that matches none of the names `exif.ts` emits is a warning
    // that never fires. This file has a timestamp, so that reason must appear.
    const dated = meta.groups.some((g) => g.tags.some((t) => /^(Taken|Date\/time)$/.test(t.name)));
    if (dated) ok("the timestamp reason actually fires", text(".mp-alert").includes("exact second"));
  }
  ok("GPS block shown iff coordinates exist", !!q(".mp-gps") === !!meta.gps, `gps=${JSON.stringify(meta.gps)}`);

  // The Samsung trailer must be visible to a person, not just to the parser.
  const hasTrailer = meta.groups.some((g) => g.tags.some((t) => t.name === "Appended data"));
  if (hasTrailer) {
    ok("appended data is on screen", text(".mp-body").includes("Appended data"));
    ok("alert calls out the hidden data", text(".mp-alert").toLowerCase().includes("hidden"));
  }

  ok("clean-copy button offered", text(".mp-btn-primary").includes("clean copy"), text(".mp-btn-primary"));
  ok("in-place button offered", !!q(".mp-btn-danger"));

  // ── The destructive button must not be one click ──────────────────────────
  const danger = q(".mp-btn-danger") as HTMLButtonElement;
  danger.click();
  ok("first click only arms", danger.classList.contains("is-armed") && written.size === 0, `${written.size} written`);
  danger.click();
  await settle();
  ok("second click writes in place", written.has("a.jpg"));
  written.clear();

  // ── The copy is genuinely clean, and the original is untouched ────────────
  await panel.show([a]);
  (q(".mp-btn-primary") as HTMLButtonElement).click();
  await settle();

  ok("copy is named -clean", written.has("a-clean.jpg"), [...written.keys()].join(","));
  const clean = written.get("a-clean.jpg");
  if (clean) {
    const after = readMetadata(clean);
    const left = after.groups.flatMap((g) => g.tags);
    console.log("survives the strip: " + (left.map((t) => t.name).join(", ") || "nothing"));
    // Dimensions and colour depth come from the frame header, not from a
    // metadata block — they survive because the picture would not decode
    // without them, and they say nothing about you. Nothing that identifies
    // anything may survive, which is what the flag means.
    ok("nothing identifying survives the copy", !after.sensitive, left.map((t) => t.name).join(", "));
    ok("no GPS survives the copy", after.gps === undefined);

    // Orientation is the deliberate exception. It describes the file, not the
    // photographer: a phone stores its pictures in the sensor's landscape frame
    // and writes a tag saying which way to turn them, so a strip that takes the
    // tag leaves a portrait photo on its side in every viewer that ever opens
    // it -- and the pixels are not re-encoded to fix that, by design.
    const wasTurned = readMetadata(raw).groups
      .flatMap((g) => g.tags)
      .find((t) => t.name === "Orientation");
    if (wasTurned) {
      const stillTurned = left.find((t) => t.name === "Orientation");
      ok(
        "orientation survives the copy",
        stillTurned?.value === wasTurned.value,
        `${wasTurned.value} -> ${stillTurned?.value ?? "gone"}`,
      );
    }
    ok("copy is smaller than the original", clean.length < raw.length, `${raw.length} → ${clean.length}`);
    ok("copy still decodes as an image", await decodes(clean, "image/jpeg"));
  }
  ok("original was not rewritten", !written.has("a.jpg"));

  // A second run must not clobber the first copy.
  (q(".mp-btn-primary") as HTMLButtonElement).click();
  await settle();
  ok("a second copy steps to -clean-2", written.has("a-clean-2.jpg"), [...written.keys()].join(","));
  written.clear();

  // ── Batch: one action over a multi-file selection ─────────────────────────
  const b = entry("b.jpg", 730493, "image");
  const c = entry("c.png", 155122, "image");
  await panel.show([a, b, c]);
  ok("batch is announced in the subtitle", text(".mp-sub").includes("3 files"), text(".mp-sub"));
  ok("button counts the selection", text(".mp-btn-primary").includes("3"), text(".mp-btn-primary"));
  (q(".mp-btn-primary") as HTMLButtonElement).click();
  await settle(2500);
  ok("all three were written", written.size === 3, [...written.keys()].join(", "));
  ok("the png went through too", written.has("c-clean.png"));
  ok("status reports the run", /3 cleaned/.test(text(".mp-status")), text(".mp-status"));
  const png = written.get("c-clean.png");
  if (png) ok("cleaned png still decodes", await decodes(png, "image/png"));

  // ── Folders and unknown formats are declined, not mis-reported ────────────
  written.clear();
  await panel.show([entry("nope.bin", 12, "binary")]);
  ok("an unreadable file says so", text(".mp-body").includes("No metadata FACET can read"), text(".mp-body").slice(0, 60));
  ok("no clean button on an unreadable file", !q(".mp-btn-primary"));

  panel.close();
  ok("closes", !panel.isOpen);

  console.log(`META-CHECK: ${pass} passed, ${fail} failed`);
  document.title = `${pass} passed, ${fail} failed`;

  // Left open on the phone photo so the page is also a look at the thing —
  // assertions cannot tell you that a panel is unreadable.
  await panel.show([a]);
}

/** Let the panel's async work finish before asserting on the DOM it paints. */
function settle(ms = 900): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

/** An independent decoder's opinion: the browser's own image pipeline. */
async function decodes(bytes: Uint8Array, type: string): Promise<boolean> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  try {
    const img = new Image();
    const done = new Promise<boolean>((res) => {
      img.onload = () => res(img.naturalWidth > 0);
      img.onerror = () => res(false);
    });
    img.src = url;
    return await done;
  } finally {
    URL.revokeObjectURL(url);
  }
}

guarded("meta", run);
