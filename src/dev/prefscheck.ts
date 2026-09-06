/**
 * Harness for the phone preferences: schema defaults, persistence round-trip,
 * the DOM projection (classes and `--fct-*` variables), reset, and the
 * settings sheet's contract with the shell's back handler.
 *
 * Runs in the dev server like the others (`/prefscheck.html`), and rolls up
 * into allcheck.html under "prefs".
 */

import "../styles/base.css";
import "../styles/phone.css";
import "../styles/phone-prefs.css";

import {
  ACCENTS, DEFAULTS, PREF_CLASSES, STORAGE_KEY,
  PhonePrefsStore, applyTo, inkFor, resolveThemeId, sanitize,
  type PhonePrefs, type PrefsStorage,
} from "@core/phone/prefs";
import { SettingsSheet } from "@ui/phone/settings-sheet";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
}

/** A Map behind the storage interface, so nothing here touches localStorage. */
function memStorage(): PrefsStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

const KEYS = Object.keys(DEFAULTS) as (keyof PhonePrefs)[];

function main(): void {
  // ── Schema ────────────────────────────────────────────────────────────
  {
    ok("the storage key is the one the brief names", STORAGE_KEY === "fct.phone.prefs.v1");
    ok("there are twenty settings", KEYS.length === 20, String(KEYS.length));
    ok("the chip bubbles are not the default", DEFAULTS.chips !== "bubbles");
    ok("albums are not boxed by default", DEFAULTS.albumStyle === "borderless");
    ok("tiles are edge to edge by default", DEFAULTS.tileRadius === 0 && DEFAULTS.tileGap === 2);
    ok("translucency defaults modest", DEFAULTS.glass > 0 && DEFAULTS.glass <= 30);
    ok("motion is on and haptics are off by default", DEFAULTS.motion && !DEFAULTS.haptics);
    ok("columns follow the pinch by default", DEFAULTS.colsPhotos === "pinch" && DEFAULTS.colsAll === "pinch");
    ok("the app opens on Photos by default", DEFAULTS.defaultTab === "photos");

    const junk = sanitize({
      theme: "neon", accent: "red", glass: 400, motion: "yes", chips: 3,
      tileRadius: -5, tileGap: 99.7, colsPhotos: 9, colsAlbums: 1,
      albumStyle: "pile", defaultTab: "settings", extra: true,
    });
    ok("unknown choices fall back to defaults",
      junk.theme === DEFAULTS.theme && junk.chips === DEFAULTS.chips &&
      junk.albumStyle === DEFAULTS.albumStyle && junk.defaultTab === DEFAULTS.defaultTab);
    ok("numbers clamp to their range", junk.glass === 100 && junk.tileRadius === 0 && junk.tileGap === 8 && junk.colsAlbums === 2);
    ok("a non-hex accent is rejected", junk.accent === "");
    ok("a non-boolean is rejected", junk.motion === DEFAULTS.motion);
    ok("an out-of-list column count falls back", junk.colsPhotos === "pinch");
    ok("unknown keys are dropped", !("extra" in junk));
    ok("garbage in yields the defaults", JSON.stringify(sanitize("nope")) === JSON.stringify(DEFAULTS));
    ok("a hex accent is kept and lower-cased", sanitize({ accent: "#ABCDEF" }).accent === "#abcdef");
  }

  // ── Store: persistence round-trip ────────────────────────────────────
  {
    const storage = memStorage();
    const a = new PhonePrefsStore(storage);
    ok("a fresh store reads as the defaults", JSON.stringify(a.get()) === JSON.stringify(DEFAULTS));
    ok("and is not dirty", !a.dirty);
    ok("nothing is written until something changes", storage.map.size === 0);

    let calls = 0;
    let lastChanged: readonly (keyof PhonePrefs)[] = [];
    const unsub = a.subscribe((_p, changed) => { calls++; lastChanged = changed; });

    a.set({ glass: 45, chips: "bubbles" });
    ok("set persists the whole record under the key", storage.map.has(STORAGE_KEY));
    ok("set notifies once with the changed keys",
      calls === 1 && lastChanged.length === 2 && lastChanged.includes("glass") && lastChanged.includes("chips"));
    ok("set makes the store dirty", a.dirty);

    a.set({ glass: 45 });
    ok("a no-op set does not notify or write again", calls === 1);

    a.set({ glass: 4000 });
    ok("set sanitizes: an out-of-range value clamps", a.get().glass === 100 && calls === 2);

    const b = new PhonePrefsStore(storage);
    ok("a second store over the same storage reads the values back",
      b.get().glass === 100 && b.get().chips === "bubbles");
    ok("and the rest stay default", b.get().motion === DEFAULTS.motion && b.get().albumStyle === DEFAULTS.albumStyle);

    storage.map.set(STORAGE_KEY, "{not json");
    const c = new PhonePrefsStore(storage);
    ok("a corrupt blob loads as the defaults", JSON.stringify(c.get()) === JSON.stringify(DEFAULTS));

    // Reset.
    a.reset();
    ok("reset removes the key from storage", !storage.map.has(STORAGE_KEY));
    ok("reset returns the record to the defaults", JSON.stringify(a.get()) === JSON.stringify(DEFAULTS) && !a.dirty);
    ok("reset notifies with the keys that changed", calls === 3 && lastChanged.includes("glass") && lastChanged.includes("chips"));
    a.reset();
    ok("a reset of a clean store is silent", calls === 3);

    unsub();
    a.set({ motion: false });
    ok("unsubscribe stops notifications", calls === 3);

    const quiet = new PhonePrefsStore(null);
    quiet.set({ glass: 0 });
    ok("a store with no storage still works in memory", quiet.get().glass === 0);
  }

  // ── DOM projection ────────────────────────────────────────────────────
  {
    const root = document.createElement("div");
    root.className = "ph other-class";
    applyTo(root, DEFAULTS);
    const cls = root.classList;
    ok("apply marks the root", cls.contains("fct-prefs"));
    ok("apply keeps unrelated classes", cls.contains("ph") && cls.contains("other-class"));
    ok("defaults: the segmented chip class is set and the others are not",
      cls.contains("fct-chips-segmented") && !cls.contains("fct-prefs-nochips") && !cls.contains("fct-chips-bubbles"));
    ok("defaults: albums borderless", cls.contains("fct-album-borderless") && !cls.contains("fct-album-boxed"));
    ok("defaults: glass on, motion on, glow on",
      cls.contains("fct-glass") && !cls.contains("fct-no-motion") && !cls.contains("fct-no-glow"));
    ok("defaults: no fixed column classes", !cls.contains("fct-cols-photos") && !cls.contains("fct-cols-all"));
    ok("--fct-glass is written as 0–1", root.style.getPropertyValue("--fct-glass") === "0.2");
    ok("--fct-tile-radius and gap carry px units",
      root.style.getPropertyValue("--fct-tile-radius") === "0px" && root.style.getPropertyValue("--fct-tile-gap") === "2px");
    ok("--fct-cols-albums is written", root.style.getPropertyValue("--fct-cols-albums") === "2");
    ok("--fct-ui-scale is 1 at the default text size", root.style.getPropertyValue("--fct-ui-scale") === "1");
    ok("the theme preference is stamped as data", root.dataset["prefsTheme"] === "dark");

    const flipped = sanitize({
      chips: "hidden", albumStyle: "stack", motion: false, glow: false, glass: 0,
      labels: false, badges: false, dayCounts: false, albumNames: false, albumCounts: false,
      colsPhotos: 3, colsAll: 6, colsAlbums: 4, tileRadius: 12, tileGap: 6, textSize: "large",
    });
    applyTo(root, flipped);
    ok("re-apply removes the classes that no longer hold",
      !cls.contains("fct-chips-segmented") && !cls.contains("fct-album-borderless") && !cls.contains("fct-glass"));
    ok("hidden chips → fct-prefs-nochips", cls.contains("fct-prefs-nochips"));
    ok("stack albums → fct-album-stack", cls.contains("fct-album-stack"));
    ok("motion and glow off → their no- classes", cls.contains("fct-no-motion") && cls.contains("fct-no-glow"));
    ok("every hide toggle has a class",
      ["fct-no-labels", "fct-no-badges", "fct-no-day-counts", "fct-no-album-names", "fct-no-album-counts"].every((c) => cls.contains(c)));
    ok("fixed columns set the opt-in classes and the counts",
      cls.contains("fct-cols-photos") && cls.contains("fct-cols-all") &&
      root.style.getPropertyValue("--fct-cols-photos") === "3" && root.style.getPropertyValue("--fct-cols-all") === "6");
    ok("radius, gap, album columns and text scale follow",
      root.style.getPropertyValue("--fct-tile-radius") === "12px" && root.style.getPropertyValue("--fct-tile-gap") === "6px" &&
      root.style.getPropertyValue("--fct-cols-albums") === "4" && root.style.getPropertyValue("--fct-ui-scale") === "1.1");
    ok("zero glass drops the glass class but still writes the variable",
      !cls.contains("fct-glass") && root.style.getPropertyValue("--fct-glass") === "0");

    const stray = Array.from(cls).filter((c) => c.startsWith("fct-") && !PREF_CLASSES.includes(c));
    ok("every fct- class the projection writes is in PREF_CLASSES", stray.length === 0, stray.join(" "));

    ok("theme resolves dark/light/system", resolveThemeId("dark", false) === "facet-dark" &&
      resolveThemeId("light", true) === "facet-light" &&
      resolveThemeId("system", true) === "facet-dark" && resolveThemeId("system", false) === "facet-light");
    ok("ink is white on a dark accent and dark on a pale one", inkFor("#7c5cff") === "#ffffff" && inkFor("#f0e040") === "#0b0d12");
    ok("every offered accent is a hex or the theme default", ACCENTS.every((a) => a.value === "" || /^#[0-9a-f]{6}$/.test(a.value)));
  }

  // ── The CSS actually keys off the classes ─────────────────────────────
  {
    const ph = document.createElement("div");
    ph.className = "ph";
    const chips = document.createElement("div");
    chips.className = "ph-chips";
    const grid = document.createElement("div");
    grid.className = "ph-grid";
    const cap = document.createElement("span");
    cap.className = "ph-cell-cap";
    ph.append(chips, grid, cap);
    document.body.append(ph);

    applyTo(ph, sanitize({ chips: "hidden", labels: false, tileGap: 6 }));
    ok("hidden chips are display:none through CSS alone", getComputedStyle(chips).display === "none");
    ok("labels off hides the caption", getComputedStyle(cap).display === "none");
    ok("the grid gap follows --fct-tile-gap", getComputedStyle(grid).columnGap === "6px");

    applyTo(ph, sanitize({ chips: "segmented" }));
    ok("segmented chips are shown again", getComputedStyle(chips).display !== "none");

    ph.dataset["tab"] = "all";
    applyTo(ph, sanitize({ colsAll: 6 }));
    const cols = getComputedStyle(grid).gridTemplateColumns.split(" ").length;
    ok("a fixed All column count reaches the grid", cols === 6, String(cols));
    ph.dataset["tab"] = "photos";
    const cols2 = getComputedStyle(grid).gridTemplateColumns.split(" ").length;
    ok("and does not leak into the Photos tab", cols2 === 4, String(cols2));
    ph.remove();
  }

  // ── Settings sheet ────────────────────────────────────────────────────
  {
    const storage = memStorage();
    const store = new PhonePrefsStore(storage);
    const sheet = new SettingsSheet(store);

    ok("the sheet is a hidden body child until opened", sheet.el.parentElement === document.body && sheet.el.hidden);
    ok("the sheet is hidden through display:none", getComputedStyle(sheet.el).display === "none");

    sheet.open();
    ok("open shows the sheet and takes focus", !sheet.el.hidden && document.activeElement === sheet.el);
    const cs = getComputedStyle(sheet.el);
    ok("the sheet is fixed at z-index 40, the back handler's contract", cs.position === "fixed" && cs.zIndex === "40");

    // The Auto-blur section (`.ph-set-auto`) writes to its own store and is
    // counted by autoblurcheck; these counts cover the prefs store alone.
    const outsideAuto = <T extends Element>(list: NodeListOf<T>): T[] => Array.from(list).filter((n) => !n.closest(".ph-set-auto"));
    const switches = outsideAuto(sheet.el.querySelectorAll<HTMLButtonElement>('[role="switch"]'));
    const groups = outsideAuto(sheet.el.querySelectorAll('[role="group"]'));
    const ranges = outsideAuto(sheet.el.querySelectorAll<HTMLInputElement>('input[type="range"]'));
    ok("eight switches, one per boolean", switches.length === 8, String(switches.length));
    ok("nine choice groups: theme, accent, text, chips, two column pickers, album style, album columns, open-on",
      groups.length === 9, String(groups.length));
    ok("three sliders: translucency, corners, gap", ranges.length === 3, String(ranges.length));

    const controls = sheet.el.querySelectorAll<HTMLElement>("button, input, label.ph-set-swatch");
    let small = 0;
    for (const c of controls) {
      const r = c.getBoundingClientRect();
      if (r.height > 0 && (r.height < 32 || r.width < 32)) small++;
    }
    ok("every control is at least 32px on both axes (switches) and most are 44+", small === 0, `${small} small`);
    const seg = sheet.el.querySelector<HTMLElement>(".ph-set-seg");
    ok("a segment is at least 44px tall", (seg?.getBoundingClientRect().height ?? 0) >= 44);
    ok("nothing scrolls sideways", sheet.el.scrollWidth <= sheet.el.clientWidth &&
      (sheet.el.querySelector<HTMLElement>(".ph-set-body")?.scrollWidth ?? 0) <= (sheet.el.querySelector<HTMLElement>(".ph-set-body")?.clientWidth ?? 0));

    const reset = sheet.el.querySelector<HTMLButtonElement>(".ph-set-reset");
    ok("Reset is disabled while everything is default", reset?.disabled === true);

    const motionSwitch = Array.from(switches).find((s) => s.getAttribute("aria-label") === "Motion");
    ok("the Motion switch reads on", motionSwitch?.getAttribute("aria-checked") === "true");
    motionSwitch?.click();
    ok("tapping it writes the store", store.get().motion === false);
    ok("and the switch reflects the new value", motionSwitch?.getAttribute("aria-checked") === "false");
    ok("and the value is persisted", storage.map.has(STORAGE_KEY) && (storage.map.get(STORAGE_KEY) ?? "").includes('"motion":false'));
    ok("Reset becomes enabled", reset?.disabled === false);

    const glass = Array.from(ranges).find((r) => r.getAttribute("aria-label") === "Translucency");
    if (glass) { glass.value = "60"; glass.dispatchEvent(new Event("input")); }
    ok("dragging the translucency slider writes the store live", store.get().glass === 60);

    const bubbles = Array.from(sheet.el.querySelectorAll<HTMLButtonElement>(".ph-set-seg"))
      .find((b) => b.textContent?.trim() === "Bubbles");
    bubbles?.click();
    ok("a segment tap writes its value", store.get().chips === "bubbles");
    ok("and the segment reads pressed", bubbles?.getAttribute("aria-pressed") === "true");

    const cyan = sheet.el.querySelector<HTMLButtonElement>('.ph-set-swatch[aria-label="Cyan"]');
    cyan?.click();
    ok("a swatch tap sets the accent", store.get().accent === "#22c3e6");
    ok("and rings the swatch", cyan?.getAttribute("aria-pressed") === "true");

    reset?.click();
    ok("Reset returns every value to default", JSON.stringify(store.get()) === JSON.stringify(DEFAULTS));
    ok("and the controls follow", motionSwitch?.getAttribute("aria-checked") === "true" &&
      bubbles?.getAttribute("aria-pressed") === "false" && glass?.value === "20");

    // The back-handler contract: Escape at the sheet closes it synchronously.
    sheet.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    ok("Escape closes the sheet", sheet.el.hidden);
    ok("closed, the sheet reads display:none", getComputedStyle(sheet.el).display === "none");

    sheet.open();
    store.set({ haptics: true });
    const haptics = Array.from(switches).find((s) => s.getAttribute("aria-label") === "Haptics");
    ok("a change made elsewhere while open shows in the sheet", haptics?.getAttribute("aria-checked") === "true");
    sheet.dispose();
    ok("dispose removes the sheet from the body", sheet.el.parentElement === null);
  }

  const line = `prefs: ${pass} passed, ${fail} failed`;
  console.log(`%c${line}`, `color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`);
  const banner = document.createElement("h2");
  banner.textContent = line;
  banner.style.cssText = `font:600 18px system-ui;color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`;
  document.body.prepend(banner);
}

main();
