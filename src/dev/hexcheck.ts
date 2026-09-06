/**
 * Exercises the hex inspector in a real browser.
 *
 * `structure.ts` is already checked in Node against real files and against an
 * independent walker written in Python. What neither of those can see is the
 * half that people actually use: whether the rows paint, whether a click on the
 * tree lands on the right byte, whether the search finds a pattern that
 * straddles a read boundary, and — the one that matters most — whether the
 * thing genuinely reads windows rather than quietly swallowing the file.
 *
 * Dev-only. Loaded by /hexcheck.html, which is not one of the build's inputs,
 * so none of this reaches the binary.
 *
 * It needs one real JPEG staged where the dev server can serve it. It is
 * deliberately not committed, because it is somebody's photograph:
 *
 *   .\scripts\fixtures.ps1            # stage
 *   .\scripts\fixtures.ps1 -Clean     # recycle afterwards
 *
 * It lands in `fixtures/`, not `public/` — `public/` is copied into `dist/`
 * and `dist/` is baked into the binary, so anything staged there ships. See
 * the facet-fixtures plugin in `vite.config.ts`.
 *
 * Nothing here may assume which photograph it got. An earlier version searched
 * for "JFIF" and failed the day a Lumix original was staged: a camera JPEG
 * opens ff d8 ff e1 — SOI then an Exif APP1 — and has no JFIF marker at all.
 *
 * Then open http://localhost:8183/hexcheck.html — the page title becomes the
 * score and the inspector is left open to be looked at.
 */

import "../styles/base.css";
import "../styles/shell.css";

import { Inspector } from "@ui/inspector";
import { themes } from "@core/theme/theme-engine";
import type { FileEntry } from "@core/explorer/types";

// Without this every colour token is undefined and the whole surface renders as
// unstyled text — which every assertion below would still happily pass.
themes.init();

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}   ${detail}`); }
};

/** Every byte the inspector asked for, so the windowing claim can be checked. */
let served = 0;
let calls = 0;

let real = new Uint8Array();

/**
 * A file that does not exist.
 *
 * Four gigabytes of it, generated a window at a time. Nothing can accidentally
 * load this one, which is the point: if the inspector opens it, it is reading
 * windows. It is also the only way to reach the size where a browser starts
 * clamping the scroll spacer.
 */
const HUGE = 4 * 1024 * 1024 * 1024;
const synth = (offset: number, len: number): number[] => {
  const out = new Array<number>(len);
  for (let i = 0; i < len; i++) out[i] = (offset + i) & 0xff;
  return out;
};

let usingSynth = false;

const inspector = new Inspector({
  readRange: async (_path, offset, len) => {
    calls++;
    served += len;
    return usingSynth ? synth(offset, len) : [...real.subarray(offset, offset + len)];
  },
  readHead: async (_path, max) => {
    calls++;
    served += Math.min(max, usingSynth ? HUGE : real.length);
    return usingSynth ? synth(0, Math.min(max, 1 << 20)) : [...real.subarray(0, max)];
  },
  readTail: async (_path, len) => {
    calls++;
    served += len;
    const size = usingSynth ? HUGE : real.length;
    const at = Math.max(0, size - len);
    return [usingSynth ? synth(at, len) : [...real.subarray(at)], at];
  },
});

const entry = (name: string, size: number): FileEntry => ({
  name, path: name, kind: "image", ext: name.split(".").pop() ?? "",
  size, modified: 0, hidden: false,
});

const q = <T extends Element>(sel: string): T | null => document.querySelector(sel);
const all = (sel: string): Element[] => [...document.querySelectorAll(sel)];
const text = (sel: string): string => q(sel)?.textContent ?? "";
const settle = (ms = 250): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

async function run(): Promise<void> {
  real = new Uint8Array(await (await fetch("/_hexcheck/a.jpg")).arrayBuffer());
  const a = entry("a.jpg", real.length);

  // ── A real JPEG ───────────────────────────────────────────────────────────
  await inspector.open(a);
  await settle();

  ok("opens", inspector.isOpen);
  ok("title names the file and the format", /a\.jpg.*JPEG/.test(text(".hx-title")), text(".hx-title"));

  const rows = all(".hx-row");
  ok("rows painted", rows.length > 10, `${rows.length} rows`);
  ok("first row is offset zero", rows[0]?.querySelector(".hx-off")?.textContent === "00000000",
    rows[0]?.querySelector(".hx-off")?.textContent ?? "");

  // The bytes on screen must be the bytes in the file. This is the assertion
  // the whole surface exists to earn.
  const firstCells = [...(rows[0]?.querySelectorAll(".hx-hex i") ?? [])].map((n) => n.textContent);
  const expect = [...real.subarray(0, 16)].map((v) => v.toString(16).padStart(2, "0"));
  ok("the hex on screen is the file's own bytes", firstCells.join(" ") === expect.join(" "),
    `${firstCells.slice(0, 4).join(" ")} vs ${expect.slice(0, 4).join(" ")}`);

  const asciiCells = [...(rows[0]?.querySelectorAll(".hx-asc i") ?? [])].map((n) => n.textContent);
  ok("unprintable bytes show as a dot, not as a gap", asciiCells[0] === "·", asciiCells.join(""));

  // ── The structure tree ────────────────────────────────────────────────────
  const nodes = all(".hx-node");
  ok("structure tree populated", nodes.length >= 3, `${nodes.length} nodes`);
  ok("the first node is the start-of-image marker", text(".hx-node .hx-node-name").includes("SOI"),
    text(".hx-node .hx-node-name"));
  ok("every node shows its offset", nodes.every((n) => /^0x[0-9a-f]+$/.test(n.querySelector(".hx-node-at")?.textContent ?? "")));
  ok("the scan is named", nodes.some((n) => n.textContent?.includes("Entropy-coded scan")));

  // Clicking a region must land on its first byte, not near it.
  const scan = nodes.find((n) => n.textContent?.includes("Entropy-coded scan")) as HTMLElement;
  const scanAt = Number.parseInt(scan.querySelector(".hx-node-at")?.textContent?.slice(2) ?? "0", 16);
  scan.click();
  await settle();
  ok("clicking a region moves the cursor to its first byte",
    text(".hx-values dd").startsWith(`${scanAt}  ·`), text(".hx-values dd"));
  ok("and scrolls it into view",
    all(".hx-row").some((r) => Number.parseInt(r.querySelector(".hx-off")?.textContent ?? "", 16) === scanAt - (scanAt % 16)));
  ok("the readout says which region the cursor is in",
    [...document.querySelectorAll(".hx-values dd")].some((d) => d.textContent?.includes("Entropy-coded scan")));

  // ── The readout ───────────────────────────────────────────────────────────
  (q(".hx-input") as HTMLInputElement).value = "0";
  (q(".hx-input") as HTMLInputElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  const dds = [...document.querySelectorAll(".hx-values dd")].map((d) => d.textContent ?? "");
  const dts = [...document.querySelectorAll(".hx-values dt")].map((d) => d.textContent ?? "");
  const readout = (label: string): string => dds[dts.indexOf(label)] ?? "";
  ok("u8 is right", readout("u8 / i8").startsWith(`${real[0]} `), readout("u8 / i8"));
  ok("u16 is offered in both byte orders",
    readout("u16 LE / BE") === `${(real[1] as number) * 256 + (real[0] as number)} / ${(real[0] as number) * 256 + (real[1] as number)}`,
    readout("u16 LE / BE"));
  ok("binary is padded to eight digits", /^[01]{8}$/.test(readout("binary")), readout("binary"));

  // ── Search ────────────────────────────────────────────────────────────────
  const find = all(".hx-input")[1] as HTMLInputElement;
  const enter = (shift = false): void => {
    find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: shift, bubbles: true }));
  };

  // A pattern that exists exactly once, deep in the file, and is not aligned to
  // any read boundary — which is where a windowed search goes wrong.
  const needleAt = Math.floor(real.length * 0.6);
  const needle = real.subarray(needleAt, needleAt + 6);
  find.value = [...needle].map((v) => v.toString(16).padStart(2, "0")).join(" ");
  enter();
  await settle(600);
  ok("hex search finds a match", /Match at 0x[0-9a-f]+/.test(text(".hx-note")), text(".hx-note"));
  const found = Number.parseInt((/Match at 0x([0-9a-f]+)/.exec(text(".hx-note")) ?? ["", "0"])[1] as string, 16);
  ok("and the match really is that pattern",
    [...needle].every((v, i) => real[found + i] === v), `${found} vs ${needleAt}`);

  /* The needle is read out of the file rather than written in here. The
     obvious thing is to search for "JFIF", and that is what this did until a
     Lumix original was staged as the sample: a camera JPEG opens ff d8 ff e1
     — SOI then an Exif APP1 — and carries no JFIF marker anywhere. The
     assertion failed while the feature it tests worked perfectly, which is
     the least useful kind of red there is. Any ASCII run the file actually
     contains proves the same thing: that a quoted needle is matched as text
     instead of being parsed as hex digits. */
  const ascii = (v: number | undefined): boolean => v !== undefined && v >= 0x41 && v <= 0x7a;
  let textAt = -1;
  for (let i = 0; i < real.length - 4 && textAt < 0; i++) {
    if ([0, 1, 2, 3].every((k) => ascii(real[i + k]))) textAt = i;
  }
  const word = String.fromCharCode(...real.subarray(textAt, textAt + 4));

  find.value = `"${word}"`;
  (q(".hx-input") as HTMLInputElement).value = "0";
  (q(".hx-input") as HTMLInputElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  enter();
  await settle(600);
  const hit = Number.parseInt((/Match at 0x([0-9a-f]+)/.exec(text(".hx-note")) ?? ["", "-1"])[1] as string, 16);
  ok("a quoted string searches as text",
    hit >= 0 && String.fromCharCode(...real.subarray(hit, hit + 4)) === word,
    `looking for ${word}: ${text(".hx-note")}`);

  find.value = "de ad be ef de ad be ef de ad be ef";
  enter();
  await settle(900);
  ok("a pattern that is not there says so", text(".hx-note").includes("No further match"), text(".hx-note"));

  // ── Windowing: the claim the whole design rests on ────────────────────────
  served = 0;
  calls = 0;
  usingSynth = true;
  await inspector.open(entry("huge.bin", HUGE));
  await settle(400);

  ok("a four-gigabyte file opens", inspector.isOpen && all(".hx-row").length > 10);
  ok("without reading four gigabytes", served < 8 * 1024 * 1024, `${(served / 1048576).toFixed(1)} MB read`);
  ok("in a handful of reads", calls < 12, `${calls} calls`);

  // The generated bytes are `offset & 0xff`, so a row's contents prove which
  // part of the file is actually on screen — a virtual scroll that lies about
  // its position would show the wrong ones.
  const rowOf = (r: Element): number => Number.parseInt(r.querySelector(".hx-off")?.textContent ?? "", 16);
  const check = (): boolean => all(".hx-row").every((r) => {
    const base = rowOf(r);
    return [...r.querySelectorAll(".hx-hex i")].every((c, i) =>
      c.textContent === "--" || c.textContent === ((base + i) & 0xff).toString(16).padStart(2, "0"));
  });
  ok("the bytes on screen match the offsets on screen", check());

  const scroll = q(".hx-scroll") as HTMLElement;
  scroll.scrollTop = scroll.scrollHeight;
  scroll.dispatchEvent(new Event("scroll"));
  await settle(400);
  const last = rowOf(all(".hx-row").slice(-1)[0] as Element);
  // The browser clamps a tall element's height, so a spacer sized one pixel per
  // row would run out of scrollbar long before it ran out of file. Reaching the
  // final row is the assertion that the proportional fallback works.
  ok("scrolling to the bottom reaches the end of the file", HUGE - last < 4096, `last row 0x${last.toString(16)}`);
  ok("and the bytes down there are right too", check());
  ok("still without reading the file", served < 16 * 1024 * 1024, `${(served / 1048576).toFixed(1)} MB read`);

  // ── Bytes that have not arrived are not drawn as zeroes ───────────────────
  // `open()` paints before a single byte has arrived, and the cache was just
  // cleared — so every cell on screen at this instant is a byte nobody has.
  // They must all be dashes. A dump that fills an unknown byte with 00 is
  // worse than a blank screen, because you would believe it.
  usingSynth = false;
  const opening = inspector.open(a);
  const immediate = all(".hx-row").flatMap((r) => [...r.querySelectorAll(".hx-hex i")].map((c) => c.textContent));
  ok("something is on screen before any byte has arrived", immediate.length > 0, `${immediate.length} cells`);
  ok("and every one of those bytes is a dash, not a zero",
    immediate.every((c) => c === "--"), immediate.slice(0, 8).join(" "));
  await opening;

  await settle();
  inspector.close();
  ok("closes", !inspector.isOpen);

  console.log(`HEX-CHECK: ${pass} passed, ${fail} failed`);
  document.title = `${pass} passed, ${fail} failed`;

  // Left open on the real file, because no assertion can tell you that a hex
  // dump is unreadable.
  await inspector.open(a);
}

void run();
