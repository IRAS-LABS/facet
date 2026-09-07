/**
 * Checks the settings store against the promises it makes (item 33).
 *
 * The interesting assertions here are all about the file being wrong. A
 * settings store is trivial when the input is good, and the whole reason this
 * one is written the way it is — coerce everything, store only the diff, never
 * throw — is the day the file is truncated, hand-edited, or written by a build
 * that offered a choice this one has dropped. Those are the cases below.
 *
 * Dev-only. Loaded by /dev/setcheck.html, which is not a build input.
 *
 *   http://localhost:8183/dev/setcheck.html
 */

import "../styles/base.css";
import "../styles/settings.css";

import {
  coerce,
  matches,
  type ChoiceSetting,
  type NumberSetting,
  type Setting,
  type TextSetting,
  type ToggleSetting,
} from "@core/settings/schema";
import { ALL_SETTINGS, GROUPS, PREF } from "@core/settings/registry";
import { memoryBackend, settings, SettingsStore } from "@core/settings/store";
import { SettingsPanel } from "@ui/settings";

let pass = 0;
let fail = 0;

const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) {
    pass++;
    console.log("ok  ", name);
  } else {
    fail++;
    console.log("FAIL", name, " ", detail);
  }
};

/** Let a click's promise chain finish before asserting on what it did. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Actually off the screen, not merely marked hidden. See the note at its use. */
const gone = (el: HTMLElement | null): boolean =>
  el !== null && getComputedStyle(el).display === "none";

const TOGGLE: ToggleSetting = {
  kind: "toggle",
  id: "t.flag",
  group: "T",
  label: "A flag",
  help: "Turns the thing on",
  default: false,
};

const NUM: NumberSetting = {
  kind: "number",
  id: "t.size",
  group: "T",
  label: "Preview size",
  keywords: ["thumbnail"],
  default: 200,
  min: 50,
  max: 400,
  step: 10,
  unit: "px",
};

const CHOICE: ChoiceSetting = {
  kind: "choice",
  id: "t.mode",
  group: "U",
  label: "Mode",
  default: "grid",
  choices: [
    ["grid", "Grid"],
    ["list", "List"],
  ],
};

const TEXT: TextSetting = {
  kind: "text",
  id: "t.name",
  group: "U",
  label: "Name",
  default: "",
};

const ALL: Setting[] = [TOGGLE, NUM, CHOICE, TEXT];

function fresh(json: string | null = null): SettingsStore {
  const s = new SettingsStore(memoryBackend(json));
  s.register(...ALL);
  return s;
}

async function main(): Promise<void> {
  // ── Coercion ──
  {
    ok("a boolean survives", coerce(TOGGLE, true) === true);
    ok("a string where a boolean belongs falls back", coerce(TOGGLE, "true") === false);
    ok("null falls back", coerce(TOGGLE, null) === false);
    ok("undefined falls back", coerce(TOGGLE, undefined) === false);

    ok("a number in range survives", coerce(NUM, 200) === 200);
    ok("above the max clamps rather than resets", coerce(NUM, 9999) === 400);
    ok("below the min clamps", coerce(NUM, -5) === 50);
    // The empty-field case: Number("") is 0, which would be a real setting of
    // zero if the guard were `Number(raw)` instead of a typeof check.
    ok("an empty string is not zero", coerce(NUM, "") === 200);
    ok("a numeric string is not a number", coerce(NUM, "300") === 200);
    ok("NaN falls back", coerce(NUM, NaN) === 200);
    ok("Infinity falls back", coerce(NUM, Infinity) === 200);
    ok("an off-step value snaps", coerce(NUM, 143) === 140, String(coerce(NUM, 143)));
    ok("snapping never escapes the max", coerce(NUM, 399) === 400, String(coerce(NUM, 399)));

    ok("an offered choice survives", coerce(CHOICE, "list") === "list");
    // The case that happens for real: a build removes an option someone had.
    ok("a choice that no longer exists falls back", coerce(CHOICE, "columns") === "grid");
    ok("a number where a choice belongs falls back", coerce(CHOICE, 3) === "grid");

    ok("text survives", coerce(TEXT, "hello") === "hello");
    ok("empty text is a real value", coerce(TEXT, "") === "");
    ok("a number where text belongs falls back", coerce(TEXT, 7) === "");
  }

  // ── Step snapping with fractions ──
  {
    const frac: NumberSetting = { ...NUM, id: "t.frac", min: 0, max: 1, step: 0.1, default: 0.5 };
    // 0.30000000000000004 is what naive arithmetic gives here.
    ok("a fractional step does not leak float noise", coerce(frac, 0.31) === 0.3, String(coerce(frac, 0.31)));
    ok("a fractional step still clamps", coerce(frac, 2) === 1);
  }

  // ── Defaults and the diff ──
  {
    const s = fresh();
    ok("an untouched setting reads its default", s.get("t.size") === 200);
    ok("and reports itself unset", !s.isSet("t.size"));
    ok("an undeclared read is undefined rather than a throw", s.get("t.nope") === undefined);

    s.set("t.size", 300);
    ok("a set value reads back", s.get("t.size") === 300);
    ok("and reports itself set", s.isSet("t.size"));
    ok("the export holds only what changed", s.export().includes("t.size"), s.export());
    ok("and nothing that did not", !s.export().includes("t.mode"));

    // The reason the store is a diff at all: setting a value back to the
    // default must forget it, not pin it.
    s.set("t.size", 200);
    ok("setting the default back forgets it", !s.isSet("t.size"));
    ok("and it leaves the export", !s.export().includes("t.size"), s.export());
  }

  // ── A changed default reaches someone who never chose ──
  {
    const backend = memoryBackend();
    const a = new SettingsStore(backend);
    a.register({ ...NUM });
    a.set("t.mode", "list"); // undeclared here; kept verbatim
    a.set("t.size", 300);

    // A later build ships a bigger default. The user who changed it keeps 300;
    // a setting they never touched would follow the new default.
    const b = new SettingsStore(memoryBackend(a.export()));
    b.register({ ...NUM, default: 250 });
    ok("a chosen value survives a default change", b.get("t.size") === 300);

    const c = new SettingsStore(memoryBackend('{"version":1,"values":{}}'));
    c.register({ ...NUM, default: 250 });
    ok("an unchosen value follows the new default", c.get("t.size") === 250);
  }

  // ── A broken file ──
  {
    ok("a missing file gives defaults", fresh(null).get("t.size") === 200);
    ok("an empty file gives defaults", fresh("").get("t.size") === 200);
    ok("a truncated file gives defaults", fresh('{"version":1,"valu').get("t.size") === 200);
    ok("a JSON array gives defaults", fresh("[1,2,3]").get("t.size") === 200);
    ok("a bare string gives defaults", fresh('"hello"').get("t.size") === 200);
    ok("null gives defaults", fresh("null").get("t.size") === 200);
    ok("a wrong version is ignored", fresh('{"version":9,"values":{"t.size":300}}').get("t.size") === 200);
    ok("values as an array is ignored", fresh('{"version":1,"values":[1]}').get("t.size") === 200);

    // Each value is coerced on its own, so one bad entry does not cost the rest.
    const mixed = fresh('{"version":1,"values":{"t.size":"big","t.mode":"list"}}');
    ok("one bad value does not poison the file", mixed.get("t.mode") === "list");
    ok("and the bad one is the default", mixed.get("t.size") === 200);

    // The reason a store may not throw: it runs before the window exists.
    let threw = false;
    try {
      fresh("{{{{").get("t.flag");
    } catch {
      threw = true;
    }
    ok("nothing throws on the worst input", !threw);
  }

  // ── Values that arrive before their declaration ──
  {
    // Modules register as they load, so the file is nearly always read before
    // every setting is known. A value must not be lost in that window.
    const s = new SettingsStore(memoryBackend('{"version":1,"values":{"t.size":300,"t.mode":"list"}}'));
    s.register({ ...NUM });
    ok("a value declared later is not lost", s.get("t.size") === 300);
    s.register({ ...CHOICE });
    ok("a value declared later still coerces", s.get("t.mode") === "list");
    ok("and it is still in the export", s.export().includes("t.mode"));

    // Same window, but the stored value is invalid for the type that arrives.
    const bad = new SettingsStore(memoryBackend('{"version":1,"values":{"t.mode":"columns"}}'));
    bad.register({ ...CHOICE });
    ok("a late declaration re-coerces a bad value", bad.get("t.mode") === "grid");
    ok("and drops it from the export", !bad.export().includes("t.mode"), bad.export());
  }

  // ── Listeners ──
  {
    const s = fresh();
    const seen: string[] = [];
    const offOne = s.on("t.size", (id, v) => seen.push(`${id}=${v}`));
    const anySeen: string[] = [];
    const offAny = s.onAny((id) => anySeen.push(id));

    s.set("t.size", 300);
    ok("a change reaches its listener", seen.length === 1 && seen[0] === "t.size=300", seen.join(","));
    ok("and the catch-all", anySeen.length === 1);

    // A no-op write must not fire: listeners are allowed to be expensive.
    s.set("t.size", 300);
    ok("writing the same value fires nothing", seen.length === 1, String(seen.length));

    s.set("t.mode", "list");
    ok("another setting does not reach the first listener", seen.length === 1);
    ok("but does reach the catch-all", anySeen.length === 2);

    offOne();
    offAny();
    s.set("t.size", 250);
    ok("unsubscribing works", seen.length === 1 && anySeen.length === 2);
  }

  // ── Reset ──
  {
    const s = fresh();
    s.set("t.size", 300);
    s.set("t.flag", true);
    s.set("t.mode", "list");

    const fired: string[] = [];
    s.onAny((id) => fired.push(id));

    s.reset("t.size");
    ok("reset returns the default", s.get("t.size") === 200);
    ok("and announces it", fired.includes("t.size"));

    // Resetting something already at its default must be silent, or a "reset
    // all" would fire once per declared setting.
    const before = fired.length;
    s.reset("t.size");
    ok("resetting an unset value announces nothing", fired.length === before);

    s.resetGroup("T");
    ok("a group reset clears the group", s.get("t.flag") === false);
    ok("and leaves other groups alone", s.get("t.mode") === "list");

    s.resetAll();
    ok("reset all clears everything", s.get("t.mode") === "grid");
    ok("and the export is empty", !s.export().includes("t."), s.export());
  }

  // ── Export and import (item 42's seam) ──
  {
    const s = fresh();
    s.set("t.size", 300);
    s.set("t.mode", "list");
    const doc = s.export();

    const t = fresh();
    const res = t.import(doc);
    ok("an import applies", res.ok && res.applied === 2, JSON.stringify(res));
    ok("and the values are there", t.get("t.size") === 300 && t.get("t.mode") === "list");

    // Two exports of the same settings must be byte-identical or they cannot
    // be diffed or kept in version control.
    ok("export is stable", t.export() === doc, `${t.export()}\n${doc}`);

    const junk = fresh();
    junk.set("t.size", 300);
    const bad = junk.import("not json");
    ok("a junk import is refused", !bad.ok);
    ok("and changes nothing", junk.get("t.size") === 300);

    // A file from a newer build. Its unknown ids must survive the round trip,
    // or importing on an older build and exporting again silently deletes them.
    const newer = fresh();
    const r2 = newer.import('{"version":1,"values":{"t.size":300,"future.thing":true}}');
    ok("an unknown id is counted as skipped", r2.skipped === 1, JSON.stringify(r2));
    ok("and survives a round trip", newer.export().includes("future.thing"), newer.export());

    // An import must announce what moved, and only what moved.
    const live = fresh();
    live.set("t.size", 300);
    const moved: string[] = [];
    live.onAny((id) => moved.push(id));
    live.import('{"version":1,"values":{"t.size":300,"t.flag":true}}');
    ok("an import announces what changed", moved.includes("t.flag"));
    ok("and stays quiet about what did not", !moved.includes("t.size"), moved.join(","));

    // Importing a document that drops a setting must reset it, not leave it.
    const dropped = fresh();
    dropped.set("t.mode", "list");
    dropped.import('{"version":1,"values":{}}');
    ok("an import that omits a setting resets it", dropped.get("t.mode") === "grid");
  }

  // ── Search ──
  {
    ok("an empty query matches everything", matches(NUM, ""));
    ok("whitespace matches everything", matches(NUM, "   "));
    ok("a label word matches", matches(NUM, "preview"));
    ok("case does not matter", matches(NUM, "PREVIEW"));
    ok("a keyword matches", matches(NUM, "thumbnail"));
    ok("the group matches", matches(CHOICE, "U"));
    ok("help text matches", matches(TOGGLE, "turns"));
    // Word order should not matter — "preview size" and "size preview" are the
    // same intent, and a substring match on the whole query would fail one.
    ok("words match in any order", matches(NUM, "size preview"));
    ok("every word must appear", !matches(NUM, "preview banana"));
    // Ids are dotted and internal: matching them means "t" surfaces everything.
    ok("the id does not match", !matches(NUM, "t.size"));
    ok("an unrelated word does not match", !matches(NUM, "banana"));
  }

  // ── Duplicate declarations ──
  {
    const s = fresh();
    s.register({ ...NUM, default: 999 });
    ok("a duplicate declaration keeps the first", s.get("t.size") === 200);
    ok("and there is still one of it", s.all().filter((x) => x.id === "t.size").length === 1);
  }

  // ── Groups ──
  {
    const s = fresh();
    ok("groups come back in declaration order", s.groups().join(",") === "T,U", s.groups().join(","));
    ok("all() holds every declaration", s.all().length === 4, String(s.all().length));
  }

  // ── Persistence ──
  {
    const backend = memoryBackend();
    const a = new SettingsStore(backend);
    a.register(...ALL);
    a.set("t.size", 300);

    const b = new SettingsStore(backend);
    b.register(...ALL);
    ok("a value survives a reload", b.get("t.size") === 300);

    // A backend that cannot write must not stop the run.
    const dead: { read(): string | null; write(t: string): void } = {
      read: () => null,
      write: () => {
        throw new Error("quota");
      },
    };
    let threw = false;
    try {
      const c = new SettingsStore(dead);
      c.register({ ...NUM });
      c.set("t.size", 300);
      ok("a failed write still applies in memory", c.get("t.size") === 300);
    } catch {
      threw = true;
    }
    ok("a backend that throws is not fatal", !threw);
  }

  // ── The panel ──
  //
  // Driven through the DOM rather than through its methods, because every
  // interesting failure here is one where the control and the store disagree,
  // and calling `store.set` in a test would be testing the store again.
  {
    const s = fresh();
    const panel = new SettingsPanel(s);
    let actionRuns = 0;
    panel.addAction("t.name", "Use this folder", () => {
      actionRuns++;
      s.set("t.name", "C:/Users/me/Pictures");
    });
    let customSyncs = 0;
    const extra = document.createElement("select");
    panel.addCustom({
      group: "U",
      label: "Palette",
      keywords: ["colour"],
      control: () => extra,
      changed: () => extra.value === "x",
      sync: () => { customSyncs++; },
    });
    panel.open();

    const root = panel.element;
    const rows = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(".prefs-row")];
    const rowFor = (label: string): HTMLElement => {
      const found = rows().find((r) => r.querySelector(".prefs-label")?.textContent === label);
      if (!found) throw new Error(`no row labelled ${label}`);
      return found;
    };
    const q = <T extends HTMLElement>(row: HTMLElement, sel: string): T => {
      const el = row.querySelector<T>(sel);
      if (!el) throw new Error(`no ${sel} in row`);
      return el;
    };

    ok("a row per declared setting, plus the contributed one", rows().length === 5, String(rows().length));
    ok("a contributed row is rendered too", rowFor("Palette").contains(extra));
    ok("and it is synced on open", customSyncs > 0);
    // `.hidden` is a property; whether it hides anything is a stylesheet
    // question, and a `display` declaration silently outranks it. Asserted on
    // the computed style for that reason — the property form of this check
    // passed for a build where the backup box was permanently on screen.
    ok("the backup box starts out of the way",
      gone(root.querySelector<HTMLElement>(".prefs-backup")));

    // Toggle
    const flag = q<HTMLButtonElement>(rowFor("A flag"), ".prefs-toggle");
    ok("a toggle shows its value", flag.textContent === "Off" && flag.dataset["on"] === "false");
    flag.click();
    ok("clicking it writes the store", s.get("t.flag") === true);
    ok("and the control catches up", flag.textContent === "On");
    ok("and the row is marked as changed", rowFor("A flag").dataset["changed"] === "true");

    // Per-setting reset
    const undo = q<HTMLButtonElement>(rowFor("A flag"), ".prefs-undo");
    ok("the reset arrow appears once changed", !undo.hidden);
    undo.click();
    ok("and putting it back clears the setting", !s.isSet("t.flag"));
    ok("and hides itself again", q<HTMLButtonElement>(rowFor("A flag"), ".prefs-undo").hidden);

    // Number: the −/+ buttons the user asked for instead of a slider.
    const sizeRow = rowFor("Preview size");
    const [minus, plus] = [...sizeRow.querySelectorAll<HTMLButtonElement>(".prefs-step")];
    const field = q<HTMLInputElement>(sizeRow, ".prefs-field");
    ok("a number shows its value", field.value === "200");
    plus?.click();
    ok("plus moves one step", s.get("t.size") === 210 && field.value === "210", field.value);
    minus?.click();
    minus?.click();
    ok("minus moves one step back", s.get("t.size") === 190, String(s.get("t.size")));

    // Typing a value out of range must clamp rather than be refused, and the
    // field must show what was actually stored — not what was typed.
    field.value = "9999";
    field.dispatchEvent(new Event("change"));
    ok("a typed value above the max clamps", s.get("t.size") === 400, String(s.get("t.size")));
    ok("and the field shows the stored value", field.value === "400", field.value);
    ok("the plus button disables at the max", plus?.disabled === true);

    // A half-typed field is someone mid-edit, not a request for zero.
    field.value = "";
    field.dispatchEvent(new Event("change"));
    ok("an emptied field is not stored as zero", s.get("t.size") === 400);
    ok("and the value comes back", field.value === "400", field.value);

    // Choice
    const mode = q<HTMLSelectElement>(rowFor("Mode"), ".prefs-select");
    ok("a choice shows its value", mode.value === "grid");
    mode.value = "list";
    mode.dispatchEvent(new Event("change"));
    ok("choosing writes the store", s.get("t.mode") === "list");

    // Group reset — the point of it being per-group is that it leaves the rest.
    const groupU = root.querySelector<HTMLElement>('.prefs-section[data-group="U"]');
    groupU?.querySelector<HTMLButtonElement>(".prefs-wipe")?.click();
    ok("a group reset clears its group", s.get("t.mode") === "grid");
    ok("and leaves the other group alone", s.get("t.size") === 400);

    // Search
    const search = root.querySelector<HTMLInputElement>(".prefs-search");
    const type = (text: string): void => {
      if (!search) throw new Error("no search box");
      search.value = text;
      search.dispatchEvent(new Event("input"));
    };
    const visible = (): string[] =>
      rows().filter((r) => !r.hidden).map((r) => r.querySelector(".prefs-label")?.textContent ?? "");

    type("thumbnail");
    ok("search matches a keyword", visible().join(",") === "Preview size", visible().join(","));
    ok("and a filtered-out row really leaves the screen", gone(rowFor("Mode")));
    ok("and hides the empty group", groupU?.hidden === true);
    ok("and the empty group really leaves too", gone(groupU));
    type("colour");
    ok("a contributed row is searchable", visible().join(",") === "Palette", visible().join(","));
    type("banana");
    ok("nothing matching says so", root.querySelector(".prefs-empty") !== null);
    type("");
    ok("clearing the box brings everything back", visible().length === 5);
    ok("and the group comes back", groupU?.hidden === false);

    // A contributed action (item 41's "use this folder").
    const nameRow = rowFor("Name");
    const action = q<HTMLButtonElement>(nameRow, ".prefs-action");
    ok("a contributed action renders on its row", action.textContent === "Use this folder");
    ok("and the undo arrow stays rightmost",
      nameRow.querySelector(".prefs-control")?.lastElementChild?.className === "prefs-undo");
    action.click();
    ok("clicking it runs and writes", actionRuns === 1 && s.get("t.name") === "C:/Users/me/Pictures");
    ok("and the field catches up",
      q<HTMLInputElement>(nameRow, ".prefs-field").value === "C:/Users/me/Pictures");
    q<HTMLButtonElement>(nameRow, ".prefs-undo").click();

    // Backup box — the in-app half of item 42.
    s.set("t.size", 300);
    const buttons = [...root.querySelectorAll<HTMLButtonElement>(".prefs-foot .prefs-btn")];
    buttons.find((b) => b.textContent === "Backup…")?.click();
    const json = root.querySelector<HTMLTextAreaElement>(".prefs-json");
    ok("opening backup fills the box with the current settings",
      (json?.value ?? "").includes("t.size"), json?.value ?? "");
    if (json) json.value = '{"version":1,"values":{"t.size":250}}';
    [...root.querySelectorAll<HTMLButtonElement>(".prefs-backup .prefs-btn")]
      .find((b) => b.textContent === "Apply")?.click();
    ok("applying a pasted backup writes the store", s.get("t.size") === 250, String(s.get("t.size")));
    ok("and the controls catch up", field.value === "250", field.value);

    // Reset everything, including the contributed rows.
    root.querySelector<HTMLButtonElement>(".prefs-danger")?.click();
    ok("reset everything empties the store", !s.isSet("t.size"));

    panel.close();
    ok("close hides the sheet", root.hidden);
    // Built once: reopening must not double the rows.
    panel.open();
    ok("reopening does not rebuild the rows", rows().length === 5, String(rows().length));
    panel.close();
    root.remove();
  }

  // ── The settings file (item 42) ──
  //
  // Against a fake disk rather than a real one: what is worth asserting is that
  // the panel asks for the right path, refuses to guess when nothing is
  // selected, and applies what comes back — none of which needs a filesystem,
  // and all of which a filesystem would make slower and flakier to check.
  {
    const s = fresh();
    const panel = new SettingsPanel(s);
    const disk = new Map<string, string>();
    let picked: string | null = null;
    panel.useFiles({
      suggest: () => "C:/Users/me/facet-settings.json",
      save: (path, text) => {
        // Stands in for `overwrite: false` stepping the name.
        const taken = disk.has(path);
        const real = taken ? path.replace(".json", "-2.json") : path;
        disk.set(real, text);
        return Promise.resolve(real);
      },
      pick: () => picked,
      load: (path) => {
        const text = disk.get(path);
        return text === undefined ? Promise.reject(new Error("no such file")) : Promise.resolve(text);
      },
    });
    panel.open();

    const root = panel.element;
    const btn = (label: string): HTMLButtonElement => {
      const b = [...root.querySelectorAll<HTMLButtonElement>(".prefs-btn")]
        .find((x) => x.textContent === label);
      if (!b) throw new Error(`no ${label} button`);
      return b;
    };
    const note = (): string => root.querySelector(".prefs-note")?.textContent ?? "";

    ok("the file buttons appear once there is a disk", !btn("Save a file").hidden);

    s.set("t.size", 120);
    btn("Backup…").click();
    btn("Save a file").click();
    await settle();
    ok("save writes where it said it would", disk.has("C:/Users/me/facet-settings.json"));
    ok("and says where", note().includes("facet-settings.json"), note());

    btn("Save a file").click();
    await settle();
    ok("a second save does not overwrite the first", disk.has("C:/Users/me/facet-settings-2.json"));

    // Nothing selected: it must say what to do, not fail silently or guess.
    btn("Load a file").click();
    await settle();
    ok("load with nothing selected explains itself", note().includes("Select a settings file"), note());

    s.set("t.size", 400);
    picked = "C:/Users/me/facet-settings.json";
    btn("Load a file").click();
    await settle();
    ok("loading applies the file", s.get("t.size") === 120, String(s.get("t.size")));
    ok("and the control catches up",
      root.querySelector<HTMLInputElement>(".prefs-field")?.value === "120");

    picked = "C:/Users/me/gone.json";
    btn("Load a file").click();
    await settle();
    ok("a file that will not read says so and changes nothing",
      note().startsWith("Could not read it") && s.get("t.size") === 120, note());

    disk.set("C:/Users/me/junk.json", "not json at all");
    picked = "C:/Users/me/junk.json";
    btn("Load a file").click();
    await settle();
    ok("and neither does a file that is not ours",
      note().includes("not a settings file") && s.get("t.size") === 120, note());

    panel.close();
    root.remove();
  }

  // ── The real registry ──
  //
  // Everything above is checked against a fixture, which is the only way to
  // check the awkward cases. But the fixture cannot catch a typo in the actual
  // declarations — a default outside its own range, two settings sharing an id,
  // a step a default does not sit on. Those show up as a control that snaps to
  // a different number the first time it is touched, which reads as the app
  // having its own opinion about what you just typed.
  {
    const declared = new Set<string>();
    let dupe = "";
    let offRange = "";
    let offStep = "";
    for (const def of ALL_SETTINGS) {
      if (declared.has(def.id)) dupe = def.id;
      declared.add(def.id);
      if (def.kind !== "number") continue;
      if (def.default < def.min || def.default > def.max) offRange = def.id;
      // Snapping is relative to the minimum, not to zero — see `coerce`.
      const steps = (def.default - def.min) / (def.step ?? 1);
      if (Math.abs(steps - Math.round(steps)) > 1e-9) offStep = def.id;
    }
    ok("no id is declared twice", dupe === "" && declared.size === ALL_SETTINGS.length, dupe);
    ok("every number default is inside its own range", offRange === "", offRange);
    ok("and lands on its own step", offStep === "", offStep);

    ok("every id is registered", ALL_SETTINGS.every((d) => settings.definition(d.id) !== undefined));
    ok("and reads back as its default",
      ALL_SETTINGS.every((d) => settings.get(d.id) === d.default || settings.isSet(d.id)));

    ok("the group list matches what was declared",
      settings.groups().join("|") === GROUPS.join("|"),
      settings.groups().join("|"));

    // Item 43. Each of these four has a live reader, and the point of asserting
    // it here is that the reader is the reason the setting is allowed to exist.
    const perf = [PREF.batchLanes, PREF.watchInterval, PREF.tableBlocks, PREF.undoKeep];
    ok("the performance settings exist",
      perf.every((id) => settings.definition(id)?.group === "Performance"));
    ok("encodes at once defaults to one", settings.get<number>(PREF.batchLanes) === 1);
    ok("the sweep period is in seconds, not milliseconds",
      settings.definition(PREF.watchInterval)?.kind === "number" &&
        (settings.definition(PREF.watchInterval) as NumberSetting).unit === "sec");
    ok("and cannot be set fast enough to spin a disk",
      (settings.definition(PREF.watchInterval) as NumberSetting).min >= 2);
  }

  const line = `settings: ${pass} passed, ${fail} failed`;
  console.log(`%c${line}`, `color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`);
  const banner = document.createElement("h2");
  banner.textContent = line;
  banner.style.cssText = `font:600 18px system-ui;color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`;
  document.body.prepend(banner);
}

void main();
