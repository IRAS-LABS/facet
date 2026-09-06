/**
 * Dev harness for Android compatibility, storage adapters, and safety gates (item 44 / Android port).
 *
 * Asserts that:
 * - AndroidFs returns structured platform roots when desktop invocation is absent.
 * - Platform security gates (runProgram, revealInShell) fail safely with clear messages on mobile.
 * - Content URIs and standard mobile paths map to correct domain kinds.
 */

import { AndroidFs, IS_ANDROID } from "@core/explorer/android-fs";
import { kindForExt } from "@core/explorer/types";

let pass = 0;
let fail = 0;

function ok(title: string, condition: boolean, extra?: string) {
  if (condition) {
    pass++;
    console.log(`[OK] ${title}`);
  } else {
    fail++;
    console.error(`[FAIL] ${title} ${extra ? `(${extra})` : ""}`);
  }
}

async function run() {
  console.log("Starting Android harness checks...");

  const fs = new AndroidFs();

  // Test 1: Fallback storage roots
  const roots = await fs.roots();
  ok("Android roots return structured storage locations", Array.isArray(roots) && roots.length > 0);
  ok("DCIM camera folder root exists in Android places", roots.some((r) => r.id === "dcim" || r.path?.includes("DCIM")));
  ok("Downloads folder root exists in Android places", roots.some((r) => r.id === "downloads" || r.path?.includes("Download")));

  // Test 2: Forbidden child process execution on Android
  let runProgError = "";
  try {
    await fs.runProgram("ls", ["-la"]);
  } catch (err) {
    runProgError = String(err);
  }
  ok("runProgram is safely refused on Android", runProgError.includes("disabled on Android"));

  // Test 3: Reveal in shell unsupported on Android
  let revealError = "";
  try {
    await fs.revealInShell("/sdcard/DCIM/photo.jpg");
  } catch (err) {
    revealError = String(err);
  }
  ok("revealInShell gives a clear unsupported error", revealError.includes("not supported on Android"));

  // Test 4: Content URI & mobile extension kind mappings
  ok("IS_ANDROID helper boolean is defined", typeof IS_ANDROID === "boolean");
  ok("JPG photo maps to image kind", kindForExt("jpg") === "image");
  ok("MP4 clip maps to video kind", kindForExt("mp4") === "video");
  ok("M4A recording maps to audio kind", kindForExt("m4a") === "audio");
  ok("PDF scan maps to document kind", kindForExt("pdf") === "document");

  // Output summary in format expected by allcheck.html
  const msg = `android: ${pass} passed, ${fail} failed`;
  console.log(msg);
  document.title = `${pass} passed, ${fail} failed`;
  const el = document.createElement("div");
  el.id = "summary";
  el.textContent = msg;
  document.body.append(el);
}

run().catch((err) => {
  console.error("Android harness crashed:", err);
});
