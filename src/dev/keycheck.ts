/**
 * Checks the keyboard map and its editor against their promises (item 35).
 *
 * Most of what is asserted here is about the ways a *rebindable* keymap can be
 * worse than a fixed one, because that is the only interesting failure: a fixed
 * shortcut either works or it does not, and you find out in a second. A
 * rebindable one can capture a chord under one name and match it under another,
 * so the user binds a key they can then never press; it can write a whole map
 * to disk so a better default never reaches anyone; it can silently steal a
 * shortcut from the command that already had it. None of those announce
 * themselves. They are all below.
 *
 * Dev-only. Loaded by /dev/keycheck.html, which is not a build input.
 *
 *   http://localhost:8183/dev/keycheck.html
 */

import "../styles/base.css";
import "../styles/keys.css";

import { chordOf, KeyMap, memoryKeys, type KeyCommand } from "@core/keys/map";
import { ALL_KEYS } from "@core/keys/commands";
import { KEY_ID } from "@core/keys/ids";
import { KeysPanel } from "@ui/keys";

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

/** Actually off the screen, not merely marked hidden — see the note at its use. */
const gone = (el: Element | null): boolean =>
  el !== null && getComputedStyle(el).display === "none";

/** A key event as the browser would report it. */
const press = (key: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent =>
  new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods });

// A small fixture table. Deliberately not the real one: these assertions are
// about the machinery, and they must not start failing the day somebody moves
// the queue off Ctrl+Shift+B.
const FIXTURE: KeyCommand[] = [
  { id: "t.palette", label: "Palette", group: "Shell", default: "Ctrl+K", scope: "always" },
  { id: "t.settings", label: "Settings", group: "Shell", default: "Ctrl+,", scope: "always" },
  { id: "t.back", label: "Back", group: "Nav", default: "Backspace", scope: "explorer" },
  { id: "t.look", label: "Quick look", group: "Nav", default: "Space", scope: "explorer" },
  { id: "t.bigger", label: "Bigger", group: "Nav", default: "+", alias: ["="], scope: "explorer" },
  { id: "t.none", label: "Unbound by default", group: "Nav", default: "", scope: "explorer" },
];

const build = (seed: string | null = null): KeyMap => {
  const map = new KeyMap(memoryKeys(seed));
  map.register(...FIXTURE);
  return map;
};

function main(): void {
  // ── One function names a key ───────────────────────────────────────────────
  //
  // `chordOf` is used by the capture and by the match. If it ever disagreed
  // with itself the bug would look like "the shortcut I set does nothing",
  // which is indistinguishable from a dozen other bugs, so it is pinned here.
  {
    ok("a letter is upper-cased", chordOf(press("k")) === "K", chordOf(press("k")));
    ok("ctrl and a letter", chordOf(press("k", { ctrlKey: true })) === "Ctrl+K");
    ok("meta folds into ctrl", chordOf(press("k", { metaKey: true })) === "Ctrl+K");
    ok("modifier order is fixed",
      chordOf(press("h", { ctrlKey: true, shiftKey: true })) === "Ctrl+Shift+H",
      chordOf(press("h", { ctrlKey: true, shiftKey: true })));

    // Holding shift is not a chord; the editor must not record it as one, or
    // clicking a row and reaching for Ctrl+Shift+H binds "Shift" instead.
    ok("a modifier alone is not a chord",
      ["Control", "Shift", "Alt", "Meta", "OS"].every((k) => chordOf(press(k)) === ""));

    // Shift and `1` reports "!" — "Shift+!" is a chord nobody can type twice.
    ok("shift already in the key is not repeated",
      chordOf(press("!", { shiftKey: true })) === "!",
      chordOf(press("!", { shiftKey: true })));
    ok("but shift on a letter is kept",
      chordOf(press("S", { shiftKey: true })) === "Shift+S");

    ok("space has a name", chordOf(press(" ")) === "Space");
    ok("escape is short", chordOf(press("Escape")) === "Esc");
    ok("arrows are short", chordOf(press("ArrowUp")) === "Up");
    ok("a function key is left alone", chordOf(press("F5")) === "F5");
    ok("delete is short", chordOf(press("Delete", { ctrlKey: true })) === "Ctrl+Del");
  }

  // ── Nothing is stored that was not changed ─────────────────────────────────
  {
    const backend = memoryKeys();
    const map = new KeyMap(backend);
    map.register(...FIXTURE);

    ok("nothing is changed to begin with", !map.changed);
    ok("and nothing has been written", backend.read() === null);

    map.bind("t.palette", "Ctrl+P");
    ok("a rebind takes", map.chord("t.palette") === "Ctrl+P");
    ok("and is marked as set", map.isSet("t.palette"));
    ok("while its neighbour is not", !map.isSet("t.settings"));

    const written = JSON.parse(backend.read() ?? "{}") as { version: number; keys: Record<string, string> };
    ok("the file is a diff, not a map",
      Object.keys(written.keys).length === 1 && written.keys["t.palette"] === "Ctrl+P",
      JSON.stringify(written.keys));
    ok("and is versioned", written.version === 1);

    // The point of the diff: binding back to what it shipped with drops the
    // override, so a default that is later improved still reaches this user.
    map.bind("t.palette", "Ctrl+K");
    ok("binding back to the default clears the override", !map.isSet("t.palette"));
    ok("and empties the file",
      Object.keys((JSON.parse(backend.read() ?? "{}") as { keys: Record<string, string> }).keys).length === 0,
      backend.read() ?? "");
    ok("nothing reads as changed again", !map.changed);
  }

  // ── Unbinding is not the same as resetting ─────────────────────────────────
  {
    const map = build();
    map.bind("t.look", "");
    ok("an unbound command has no chord", map.chord("t.look") === "");
    ok("and counts as changed", map.isSet("t.look"));
    ok("and no longer fires", map.match(press(" ")) === null);
    map.reset("t.look");
    ok("reset puts it back", map.chord("t.look") === "Space");
    ok("and it fires again", map.match(press(" ")) === "t.look");

    map.bind("t.palette", "Ctrl+P");
    map.bind("t.back", "Ctrl+Left");
    map.resetAll();
    ok("resetAll clears every override", !map.changed);
    ok("and the defaults are all back",
      map.chord("t.palette") === "Ctrl+K" && map.chord("t.back") === "Backspace");
  }

  // ── A broken or stale file costs the rebinds and nothing else ──────────────
  {
    ok("truncated JSON does not throw", build("{\"version\":1,\"keys\":{").chord("t.palette") === "Ctrl+K");
    ok("a wrong shape does not throw", build("[1,2,3]").chord("t.palette") === "Ctrl+K");
    ok("an empty file does not throw", build("").chord("t.palette") === "Ctrl+K");
    ok("a non-string chord is ignored",
      build("{\"version\":1,\"keys\":{\"t.palette\":42}}").chord("t.palette") === "Ctrl+K");

    // A chord for a command this build no longer has must survive a round trip,
    // or downgrading once quietly wipes the rebinds of anything newer.
    const stale = memoryKeys('{"version":1,"keys":{"t.gone":"Ctrl+G","t.back":"Ctrl+Left"}}');
    const map = new KeyMap(stale);
    map.register(...FIXTURE);
    ok("a rebind from the file applies", map.chord("t.back") === "Ctrl+Left");
    map.bind("t.palette", "Ctrl+P");
    ok("and an unknown command's chord is kept, not dropped",
      (JSON.parse(stale.read() ?? "{}") as { keys: Record<string, string> }).keys["t.gone"] === "Ctrl+G",
      stale.read() ?? "");
  }

  // ── What a keypress runs ───────────────────────────────────────────────────
  {
    const map = build();
    ok("a default chord matches", map.match(press("k", { ctrlKey: true })) === "t.palette");
    ok("an unrelated key matches nothing", map.match(press("q")) === null);
    ok("a modifier alone matches nothing", map.match(press("Shift", { shiftKey: true })) === null);
    ok("a command declared with no default has no chord", map.chord("t.none") === "");
    ok("and no key run through the map ever reaches it",
      ["a", "z", " ", "Enter", "Backspace", "F5", "="].every((k) => map.match(press(k)) !== "t.none"));

    // Scope. A surface owns the keyboard, so Backspace must not walk the folder
    // out from under a photo — but Ctrl+K still has to get you out of it.
    ok("an explorer command fires in the explorer",
      map.match(press("Backspace"), { surface: false }) === "t.back");
    ok("and not over a surface",
      map.match(press("Backspace"), { surface: true }) === null);
    ok("while an always command fires over one",
      map.match(press("k", { ctrlKey: true }), { surface: true }) === "t.palette");

    // Typing. A bare letter is a filename, a modified chord is a command.
    ok("a bare key does nothing while typing",
      map.match(press(" "), { typing: true }) === null);
    ok("but a ctrl chord still works",
      map.match(press("k", { ctrlKey: true }), { typing: true }) === "t.palette");
    const alt = build();
    alt.bind("t.settings", "Alt+S");
    ok("and so does an alt chord",
      alt.match(press("s", { altKey: true }), { typing: true }) === "t.settings");

    // Aliases exist for `+` living on the `=` key, and they end the moment the
    // user answers the question themselves.
    ok("an alias fires the command", map.match(press("=")) === "t.bigger");
    ok("as does the chord proper", map.match(press("+", { shiftKey: true })) === "t.bigger");
    map.bind("t.bigger", "Ctrl+Up");
    ok("a rebind drops the alias", map.match(press("=")) === null);
    ok("and takes the new chord", map.match(press("ArrowUp", { ctrlKey: true })) === "t.bigger");
    map.reset("t.bigger");
    ok("resetting brings the alias back", map.match(press("=")) === "t.bigger");
  }

  // ── Conflicts are shown, not resolved ──────────────────────────────────────
  {
    const map = build();
    ok("a free chord conflicts with nothing", map.conflicts("Ctrl+J", "t.back").length === 0);
    ok("an unbound chord conflicts with nothing", map.conflicts("", "t.back").length === 0);

    // Binding is never refused: going through a collision is how a swap is done.
    map.bind("t.back", "Ctrl+K");
    ok("binding onto a taken chord is allowed", map.chord("t.back") === "Ctrl+K");
    ok("and the collision is reported",
      map.conflicts("Ctrl+K", "t.back").map((c) => c.id).join() === "t.palette",
      map.conflicts("Ctrl+K", "t.back").map((c) => c.id).join());
    ok("from both sides",
      map.conflicts("Ctrl+K", "t.palette").map((c) => c.id).join() === "t.back");
    ok("declaration order decides which one fires",
      map.match(press("k", { ctrlKey: true })) === "t.palette");

    // Two explorer commands share a keyboard, so they collide with each other.
    map.bind("t.look", "Backspace");
    ok("two explorer commands on one chord collide",
      map.conflicts("Backspace", "t.look").map((c) => c.id).join() === "",
      map.conflicts("Backspace", "t.look").map((c) => c.id).join());
    map.reset("t.back");
    map.bind("t.look", "Backspace");
    ok("…once they are actually on it",
      map.conflicts("Backspace", "t.look").map((c) => c.id).join() === "t.back");
    ok("a command never conflicts with itself",
      map.conflicts("Backspace", "t.back").every((c) => c.id !== "t.back"));
  }

  // ── Listeners ──────────────────────────────────────────────────────────────
  {
    const map = build();
    let calls = 0;
    map.onChange(() => { calls++; });
    map.bind("t.palette", "Ctrl+P");
    ok("a rebind announces itself", calls === 1, String(calls));
    map.reset("t.palette");
    ok("so does a reset", calls === 2, String(calls));
    map.reset("t.palette");
    ok("a no-op reset stays quiet", calls === 2, String(calls));

    map.onChange(() => { throw new Error("nope"); });
    map.bind("t.back", "Ctrl+Left");
    ok("a listener that throws does not stop the rebind", map.chord("t.back") === "Ctrl+Left");
  }

  // ── The editor ─────────────────────────────────────────────────────────────
  {
    const map = build();
    const panel = new KeysPanel(map);
    ok("it starts closed", !panel.isOpen);
    panel.open();
    ok("and opens", panel.isOpen);

    const rows = [...panel.element.querySelectorAll<HTMLElement>(".keys-row")];
    ok("every command gets a row", rows.length === FIXTURE.length, String(rows.length));
    ok("grouped as declared",
      [...panel.element.querySelectorAll(".keys-group")].map((h) => h.textContent).join("|") ===
        "Shell|Nav");

    const row = (id: string): HTMLElement =>
      panel.element.querySelector<HTMLElement>(`.keys-row[data-id="${id}"]`) as HTMLElement;
    const chordOfRow = (id: string): string =>
      row(id).querySelector<HTMLElement>(".keys-chord")?.textContent ?? "";

    ok("a row shows its chord", chordOfRow("t.palette") === "Ctrl+K", chordOfRow("t.palette"));
    ok("an unbound row shows a dash", chordOfRow("t.none") === "—", chordOfRow("t.none"));
    ok("the scope is said in the row",
      (row("t.back").querySelector(".keys-note")?.textContent ?? "").includes("in a folder"));

    // The undo control is *reserved*, not removed: the row must not shuffle
    // sideways the first time a value changes under the pointer.
    const undo = row("t.palette").querySelector<HTMLElement>(".keys-undo") as HTMLElement;
    ok("the undo slot holds its place while unchanged",
      getComputedStyle(undo).display === "block" && getComputedStyle(undo).visibility === "hidden",
      `${getComputedStyle(undo).display}/${getComputedStyle(undo).visibility}`);

    // Capture. Clicking the chord and pressing keys is the whole feature, and
    // the listener is on the capture phase so it beats the app's own Ctrl+K.
    row("t.palette").querySelector<HTMLElement>(".keys-chord")?.click();
    ok("clicking says it is listening", chordOfRow("t.palette") === "Press a key…", chordOfRow("t.palette"));
    window.dispatchEvent(press("j", { ctrlKey: true }));
    ok("the next key becomes the binding", map.chord("t.palette") === "Ctrl+J", map.chord("t.palette"));
    ok("and the row shows it", chordOfRow("t.palette") === "Ctrl+J");
    ok("the changed dot is on the row", row("t.palette").classList.contains("is-changed"));
    ok("and the undo control has appeared", getComputedStyle(undo).visibility === "visible");

    // A modifier on its own is a user on their way to a chord, not a binding.
    row("t.settings").querySelector<HTMLElement>(".keys-chord")?.click();
    window.dispatchEvent(press("Control", { ctrlKey: true }));
    ok("a modifier alone does not end the capture",
      chordOfRow("t.settings") === "Press a key…", chordOfRow("t.settings"));
    window.dispatchEvent(press("Escape"));
    ok("escape cancels rather than binding", map.chord("t.settings") === "Ctrl+,");
    ok("and the row goes back to its chord", chordOfRow("t.settings") === "Ctrl+,");

    // Unbinding is its own button because there is no key you can press to
    // mean "none of them".
    row("t.settings").querySelector<HTMLElement>(".keys-clear")?.click();
    ok("the clear button unbinds", map.chord("t.settings") === "");
    ok("and the row says so", chordOfRow("t.settings") === "—");
    row("t.settings").querySelector<HTMLElement>(".keys-undo")?.click();
    ok("and undo puts it back", map.chord("t.settings") === "Ctrl+,");

    // A collision is stated in words, not with a warning triangle: the useful
    // fact is *which* of the two has stopped working.
    row("t.look").querySelector<HTMLElement>(".keys-chord")?.click();
    window.dispatchEvent(press("Backspace"));
    ok("a collision is called out", row("t.look").classList.contains("is-clash"));
    ok("by name, and says who wins",
      (row("t.look").querySelector(".keys-note")?.textContent ?? "").includes("that one wins"),
      row("t.look").querySelector(".keys-note")?.textContent ?? "");
    ok("and the other row hears about it too", row("t.back").classList.contains("is-clash"));

    // Search. `[hidden]` loses to any `display` a stylesheet hands out, so this
    // asserts the computed value — the settings panel shipped a whole afternoon
    // of dead filtering because the property was true and the row was visible.
    const search = panel.element.querySelector<HTMLInputElement>(".keys-search") as HTMLInputElement;
    search.value = "quick";
    search.dispatchEvent(new Event("input"));
    ok("search keeps the match", !gone(row("t.look")));
    ok("and takes the rest off the screen", gone(row("t.palette")), "the row is still displayed");
    ok("and empties the group with it",
      gone(panel.element.querySelector(".keys-section")), "the Shell heading is still there");

    // The chord itself is searchable: "what have I put on that hand shape" is
    // the actual question when rearranging.
    search.value = "ctrl+j";
    search.dispatchEvent(new Event("input"));
    ok("a chord is searchable", !gone(row("t.palette")) && gone(row("t.look")));

    search.value = "";
    search.dispatchEvent(new Event("input"));
    ok("clearing search brings everything back",
      rows.every((r) => !gone(r)));

    panel.element.querySelector<HTMLElement>(".keys-wipe")?.click();
    ok("the footer button puts every shortcut back", !map.changed);
    ok("and the rows redraw", chordOfRow("t.palette") === "Ctrl+K");

    panel.close();
    ok("it closes", !panel.isOpen);
    ok("and is off the screen", gone(panel.element));
    panel.element.remove();
  }

  // ── The real command table ─────────────────────────────────────────────────
  //
  // Same doctrine as the settings registry: nothing is declared that nothing
  // reads. What is asserted here is only what can be checked from data — that
  // the ids are unique, that every id the shell switches on is declared, and
  // that no two commands ship colliding out of the box.
  {
    const ids = ALL_KEYS.map((c) => c.id);
    ok("no command is declared twice", new Set(ids).size === ids.length);
    ok("every id the shell uses is declared",
      Object.values(KEY_ID).every((id) => ids.includes(id)),
      Object.values(KEY_ID).filter((id) => !ids.includes(id)).join());
    ok("and every declaration has an id the shell knows",
      ids.every((id) => (Object.values(KEY_ID) as string[]).includes(id)),
      ids.filter((id) => !(Object.values(KEY_ID) as string[]).includes(id)).join());
    ok("every command has a default", ALL_KEYS.every((c) => c.default !== ""));
    ok("every command has a group and a label",
      ALL_KEYS.every((c) => c.group !== "" && c.label !== ""));
    ok("every scope is one of the two",
      ALL_KEYS.every((c) => c.scope === "always" || c.scope === "explorer"));

    // Nothing ships colliding. A user may create a collision — that is their
    // business — but finding one in the box means two commands were written
    // months apart by someone who did not know about the other.
    const real = new KeyMap(memoryKeys());
    real.register(...ALL_KEYS);
    const clashes = ALL_KEYS
      .filter((c) => real.conflicts(c.default, c.id).length > 0)
      .map((c) => `${c.id}=${c.default}`);
    ok("nothing ships on top of anything else", clashes.length === 0, clashes.join(" "));

    // An alias must not be somebody else's shortcut either — it fires silently.
    const taken = new Set(ALL_KEYS.map((c) => c.default));
    ok("no alias sits on another command's chord",
      ALL_KEYS.every((c) => (c.alias ?? []).every((a) => !taken.has(a))));
  }

  const line = `keys: ${pass} passed, ${fail} failed`;
  console.log(`%c${line}`, `color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`);
  const banner = document.createElement("h2");
  banner.textContent = line;
  banner.style.cssText = `font:600 18px system-ui;color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`;
  document.body.prepend(banner);
}

main();
