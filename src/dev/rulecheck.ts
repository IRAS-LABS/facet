/**
 * Checks the filter language, the per-folder memory and the filter box (item 37).
 *
 * The interesting failures here are all failures of *trust*. A filter that
 * silently drops a rule it did not understand shows you too many files and you
 * never know. A filter that throws on a typo stops the folder loading. A
 * per-folder memory that writes to the wrong key gives one folder another
 * folder's sort order, which looks like the app scrambling itself. And a filter
 * that follows you into the next folder makes a full folder look empty — the
 * single most alarming thing a file manager can do. Every one of those is
 * asserted below, because none of them announce themselves.
 *
 * Dev-only. Loaded by /dev/rulecheck.html, which is not a build input.
 *
 *   http://localhost:8183/dev/rulecheck.html
 */

import "../styles/base.css";
import "../styles/filter.css";

import {
  apply, describe, matches, parse, tokenize, when, NO_FILTER, PRESETS,
} from "@core/explorer/filter";
import { keyOf, memoryRules, RulesStore } from "@core/explorer/rules";
import { extOf, kindForExt, type FileEntry } from "@core/explorer/types";
import { FilterBar } from "@ui/filter-bar";

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

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A fixed moment, so a date filter asserts the same thing every day. */
const NOW = new Date(2026, 6, 15, 14, 30).getTime(); // 15 July 2026, 2:30 pm
const DAY = 86_400_000;

function entry(name: string, over: Partial<FileEntry> = {}): FileEntry {
  const ext = extOf(name);
  return {
    path: `C:/f/${name}`,
    name,
    ext,
    kind: kindForExt(ext),
    size: 1024,
    modified: NOW - DAY,
    ...over,
  };
}

const FOLDER: FileEntry = {
  path: "C:/f/Camera",
  name: "Camera",
  ext: "",
  kind: "folder",
  modified: NOW - 3 * DAY,
};

const FILES: FileEntry[] = [
  FOLDER,
  entry("holiday.jpg", { size: 3.2 * 1024 * 1024, width: 4000, height: 3000 }),
  entry("holiday-2.png", { size: 800 * 1024 }),
  entry("render.mp4", { size: 180 * 1024 * 1024, duration: 92, modified: NOW - 60_000 }),
  entry("notes.txt", { size: 4096, modified: NOW - 400 * DAY }),
  entry("budget.xlsx", { size: 22 * 1024 }),
  entry("secret.txt", { size: 12, hidden: true }),
];

const names = (list: FileEntry[]): string => list.map((e) => e.name).join(",");

function main(): void {
  // ── 1. tokenizing ───────────────────────────────────────────────────────
  {
    ok("plain words split on spaces", tokenize("a b c").join("|") === "a|b|c");
    ok("runs of whitespace collapse", tokenize("  a \t b  ").join("|") === "a|b");
    ok("nothing is nothing", tokenize("").length === 0);
    ok("quotes keep a phrase whole",
      tokenize('"annual report" pdf').join("|") === "annual report|pdf");
    ok("a quote in the middle still groups",
      tokenize('name:"my file"').join("|") === "name:my file");
    // An unclosed quote is what you have every time you are halfway through
    // typing one. It must not swallow the box.
    ok("an unclosed quote takes the rest as one token",
      tokenize('a "b c').join("|") === "a|b c");
  }

  // ── 2. what a token becomes ─────────────────────────────────────────────
  {
    ok("an empty filter is empty", parse("", NOW).empty);
    ok("undefined is empty", parse(undefined, NOW).empty);
    ok("whitespace is empty", parse("   ", NOW).empty);
    ok("NO_FILTER is empty", NO_FILTER.empty && NO_FILTER.rules.length === 0);

    const q = parse("holiday", NOW);
    ok("a bare word is one rule", q.rules.length === 1 && !q.empty);
    ok("a bare word matches the name", matches(FILES[1]!, q));
    ok("a bare word is case-insensitive", matches(entry("HOLIDAY.JPG"), q));
    ok("a bare word does not match everything", !matches(FILES[4]!, q));

    ok("two words both have to match",
      names(apply(FILES, parse("holiday 2", NOW))) === "holiday-2.png");

    ok("name: is the explicit form",
      names(apply(FILES, parse("name:budget", NOW))) === "budget.xlsx");

    // kinds
    ok("kind: picks a kind",
      names(apply(FILES, parse("kind:image", NOW))) === "holiday.jpg,holiday-2.png");
    ok("kind: takes the word people actually use",
      names(apply(FILES, parse("kind:photo", NOW))) === "holiday.jpg,holiday-2.png");
    ok("kind: takes a list",
      names(apply(FILES, parse("kind:video,folder", NOW))) === "Camera,render.mp4");
    ok("kind:3d resolves", parse("kind:3d", NOW).rules[0]!.label === "kind is model3d");

    // extensions
    ok("ext: matches the extension",
      names(apply(FILES, parse("ext:txt", NOW))) === "notes.txt,secret.txt");
    ok("ext: ignores a leading dot",
      names(apply(FILES, parse("ext:.txt", NOW))) === "notes.txt,secret.txt");
    ok("ext: takes a list",
      names(apply(FILES, parse("ext:jpg,png", NOW))) === "holiday.jpg,holiday-2.png");
    ok("type: is the same thing", parse("type:png", NOW).rules[0]!.label === "type is PNG");

    // sizes
    ok("size:> compares", names(apply(FILES, parse("size:>100mb", NOW))) === "render.mp4");
    ok("size:< compares the other way",
      names(apply(FILES, parse("size:<1kb", NOW))) === "secret.txt");
    ok("a bare size means at least",
      names(apply(FILES, parse("size:100mb", NOW))) === "render.mp4");
    ok("units are binary", parse("size:>1k", NOW).rules[0]!.label === "size > 1.0 KB");
    ok("a fraction works", parse("size:>1.5mb", NOW).rules[0]!.label === "size > 1.5 MB");
    ok("size:<= includes the boundary",
      matches(entry("x.bin", { size: 1024 }), parse("size:<=1kb", NOW)));
    // The one that would quietly make folders disappear while you look for a
    // large video, taking the folder you were about to open with them.
    ok("a size filter never keeps a folder", !matches(FOLDER, parse("size:>1b", NOW)));

    // dates
    ok("modified:today is since midnight",
      names(apply(FILES, parse("modified:today", NOW))) === "render.mp4");
    ok("after: is the same thing", parse("after:today", NOW).rules.length === 1);
    ok("before: excludes what after: includes",
      apply(FILES, parse("before:today", NOW)).every((e) => e.name !== "render.mp4"));
    ok("7d reaches back a week",
      names(apply(FILES, parse("modified:7d", NOW))).includes("holiday.jpg"));
    ok("an ISO date parses", when("2026-01-01", NOW) === new Date(2026, 0, 1).getTime());
    ok("a year-month parses", when("2026-03", NOW) === new Date(2026, 2, 1).getTime());
    ok("yesterday is midnight yesterday",
      when("yesterday", NOW) === new Date(2026, 6, 14).getTime());
    ok("today is midnight today", when("today", NOW) === new Date(2026, 6, 15).getTime());
    ok("a date that is not a date is not a date", when("banana", NOW) === null);
    ok("before an old date finds the old file",
      names(apply(FILES, parse("before:2026-01-01", NOW))) === "notes.txt");

    // is:
    ok("is:folder keeps only folders", names(apply(FILES, parse("is:folder", NOW))) === "Camera");
    ok("is:file drops the folder", !apply(FILES, parse("is:file", NOW)).includes(FOLDER));
    ok("is:hidden finds the hidden one",
      names(apply(FILES, parse("is:hidden", NOW))) === "secret.txt");
    ok("is: also takes a kind", names(apply(FILES, parse("is:video", NOW))) === "render.mp4");

    // negation
    ok("- turns a rule around",
      !apply(FILES, parse("-kind:image", NOW)).some((e) => e.kind === "image"));
    ok("! does the same", !apply(FILES, parse("!is:folder", NOW)).includes(FOLDER));
    ok("a negated label says so", parse("-kind:image", NOW).rules[0]!.label === "not kind is image");
    ok("- on a bare word excludes by name",
      !names(apply(FILES, parse("-holiday", NOW))).includes("holiday"));
    ok("a lone - is not a rule", parse("-", NOW).empty);

    // combinations
    ok("rules are ANDed",
      names(apply(FILES, parse("kind:image size:>1mb", NOW))) === "holiday.jpg");
    ok("a word and a rule combine",
      names(apply(FILES, parse("holiday ext:png", NOW))) === "holiday-2.png");
  }

  // ── 3. nothing is ever rejected ─────────────────────────────────────────
  //
  // Every one of these is something a person types by accident, and the whole
  // contract is that they narrow by name instead of failing.
  {
    const junkKey = parse("foo:bar", NOW);
    ok("an unknown key becomes name text", junkKey.rules.length === 1);
    ok("...matching the whole token", matches(entry("xfoo:barx"), junkKey));
    ok("a junk size becomes name text",
      parse("size:banana", NOW).rules[0]!.label === 'name has "size:banana"');
    ok("a junk date becomes name text",
      parse("after:soon", NOW).rules[0]!.label === 'name has "after:soon"');
    ok("an unknown kind becomes name text",
      parse("kind:hologram", NOW).rules[0]!.label === 'name has "kind:hologram"');
    ok("an unknown is: becomes name text",
      parse("is:sideways", NOW).rules[0]!.label === 'name has "is:sideways"');
    ok("a key with no value becomes name text",
      parse("kind:", NOW).rules[0]!.label === 'name has "kind:"');
    // The one that matters most in practice: a Windows path pasted into the box.
    const pasted = parse("C:/Users/me", NOW);
    ok("a pasted path is treated as text", pasted.rules.length === 1);
    ok("...and matches a name containing it", matches(entry("C:/Users/me"), pasted));
    ok("nothing throws on anything", (() => {
      for (const junk of ["::::", '"', "-:", "size:>", "kind:,,,", "\\", "🙂", "a:b:c"]) {
        try {
          apply(FILES, parse(junk, NOW));
        } catch {
          return false;
        }
      }
      return true;
    })());
  }

  // ── 4. saying what it is doing ──────────────────────────────────────────
  {
    ok("describe says nothing about nothing", describe(parse("", NOW)) === "");
    ok("describe names one rule", describe(parse("kind:image", NOW)) === "kind is image");
    ok("describe joins two",
      describe(parse("kind:image size:>1mb", NOW)) === "kind is image · size > 1.0 MB");
    ok("describe quotes a word", describe(parse("holiday", NOW)) === 'name has "holiday"');
    ok("apply on an empty query returns the same array", apply(FILES, NO_FILTER) === FILES);
    ok("every ready-made filter parses to at least one rule",
      PRESETS.every((p) => parse(p.query, NOW).rules.length > 0),
      PRESETS.map((p) => p.query).join(" "));
    ok("no ready-made filter is secretly plain text",
      PRESETS.every((p) => !parse(p.query, NOW).rules.some((r) => r.label.startsWith("name has"))),
      PRESETS.map((p) => `${p.name}=${describe(parse(p.query, NOW))}`).join(" | "));
  }

  // ── 5. the per-folder memory ────────────────────────────────────────────
  {
    const store = new RulesStore(memoryRules());
    ok("an unvisited folder has no rule", store.get("C:/a") === undefined);

    store.set("C:/a", { sort: "modified", ascending: false });
    ok("a sort is remembered", store.get("C:/a")?.sort === "modified");
    ok("...with its direction", store.get("C:/a")?.ascending === false);

    // The reason `set` takes a patch: two different callers own two different
    // halves of one rule and must not erase each other.
    store.set("C:/a", { filter: "kind:image" });
    ok("a filter merges rather than replacing", store.get("C:/a")?.sort === "modified");
    ok("...and is itself stored", store.get("C:/a")?.filter === "kind:image");

    store.set("C:/a", { filter: "" });
    ok("an empty filter is removed, not stored", store.get("C:/a")?.filter === undefined);
    ok("...leaving the sort alone", store.get("C:/a")?.sort === "modified");

    ok("another folder is untouched", store.get("C:/b") === undefined);
    ok("the count is folders, not fields", store.count() === 1);

    store.forget("C:/a");
    ok("forget removes it", store.get("C:/a") === undefined && store.count() === 0);

    // Case folding, which is the difference between one memory and two.
    ok("a windows path folds case", keyOf("C:/Users/Me") === keyOf("c:/users/me"));
    ok("a trailing slash is not a different folder", keyOf("C:/Users/") === keyOf("C:/Users"));
    ok("backslashes are the same folder", keyOf("C:\\Users") === keyOf("C:/Users"));
    ok("a non-windows path keeps its case", keyOf("/storage/DCIM") !== keyOf("/storage/dcim"));
    store.set("C:/Users/Me", { sort: "size" });
    ok("...so the same folder typed differently finds its rule",
      store.get("c:/users/me/")?.sort === "size");

    // Persistence.
    const backend = memoryRules();
    const a = new RulesStore(backend);
    a.set("C:/x", { sort: "kind", ascending: true, filter: "ext:png" });
    a.save("Big videos", "kind:video size:>1gb");
    const b = new RulesStore(memoryRules(backend.read()));
    ok("a rule survives a reload", b.get("C:/x")?.sort === "kind");
    ok("...with its filter", b.get("C:/x")?.filter === "ext:png");
    ok("a saved filter survives a reload", b.all()[0]?.query === "kind:video size:>1gb");

    // Tolerance, in the same spirit as the settings store: a mangled file costs
    // you your remembered sort orders, never the app.
    for (const junk of ["", "{", "null", "[]", '{"version":9}', '{"version":1}', '{"version":1,"folders":3}']) {
      const s = new RulesStore(memoryRules(junk));
      ok(`garbage (${junk || "empty"}) is survivable`, s.count() === 0 && s.all().length === 0);
    }
    const bad = new RulesStore(memoryRules(
      '{"version":1,"folders":{"C:/y":{"sort":"colour","ascending":"yes","mode":"hologram"}},"order":["C:/y"],"saved":[{"name":"","query":"x"}]}',
    ));
    ok("a sort this build cannot do is dropped", bad.get("C:/y") === undefined);
    ok("a nameless saved filter is dropped", bad.all().length === 0);

    // The cap. Uncapped, this file grows for as long as the app is used.
    const many = new RulesStore(memoryRules());
    for (let i = 0; i < 450; i++) many.set(`C:/f${i}`, { sort: "size" });
    ok("the folder memory is capped", many.count() === 400, String(many.count()));
    ok("the oldest went first", many.get("C:/f0") === undefined);
    ok("the newest is still there", many.get("C:/f449")?.sort === "size");

    // Saved filters by name.
    const named = new RulesStore(memoryRules());
    named.save("Photos", "kind:image");
    named.save("Photos", "kind:image size:>1mb");
    ok("saving the same name replaces it", named.all().length === 1);
    ok("...with the new query", named.all()[0]?.query === "kind:image size:>1mb");
    named.save("  ", "kind:image");
    ok("a blank name saves nothing", named.all().length === 1);
    named.save("Empty", "   ");
    ok("a blank query saves nothing", named.all().length === 1);
    named.remove("photos");
    ok("removing ignores case", named.all().length === 0);
  }

  // ── 6. the box ──────────────────────────────────────────────────────────
  //
  // Everything above is a pure function. This is the part that has a caret in
  // it, and the part where a debounce can quietly eat the last keystroke.
  void (async () => {
    const seen: string[] = [];
    const saved = [{ name: "Photos", query: "kind:image" }];
    const removed: string[] = [];
    const bar = new FilterBar({
      onChange: (t) => seen.push(t),
      saved: () => saved,
      onSave: (name, q) => saved.push({ name, query: q }),
      onRemove: (name) => removed.push(name),
    });
    document.body.appendChild(bar.root);

    const type = (text: string): void => {
      bar.input.value = text;
      bar.input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const key = (k: string): void => {
      bar.input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    };

    ok("the box starts inactive", bar.root.dataset["active"] === "false");
    ok("the clear button starts reserved, not gone",
      getComputedStyle(bar.root.querySelector(".flt-clear")!).visibility === "hidden");

    type("k");
    type("ki");
    type("kind:image");
    ok("typing does not announce immediately", seen.length === 0, seen.join("|"));
    ok("...but the box already says it is active", bar.root.dataset["active"] === "true");
    await wait(220);
    ok("a burst of typing announces once", seen.length === 1, seen.join("|"));
    ok("...with the last thing typed", seen[0] === "kind:image");

    type("kind:video");
    key("Enter");
    ok("enter does not wait", seen.length === 2 && seen[1] === "kind:video");
    await wait(220);
    ok("...and the timer does not fire again after it", seen.length === 2);

    key("Escape");
    ok("escape clears the box", bar.input.value === "");
    ok("...and says so", seen.length === 3 && seen[2] === "");

    bar.set("size:>1gb");
    await wait(220);
    ok("set() is silent", seen.length === 3, seen.join("|"));
    ok("...but visible", bar.input.value === "size:>1gb");
    ok("...and marks the box active", bar.root.dataset["active"] === "true");

    // The menu.
    bar.openMenu();
    const menu = bar.root.querySelector(".flt-menu");
    ok("the menu opens", menu !== null);
    const picks = [...bar.root.querySelectorAll<HTMLElement>(".flt-pick")];
    ok("every ready-made filter is offered", picks.length === PRESETS.length + saved.length,
      String(picks.length));
    ok("a saved filter comes first", picks[0]?.dataset["query"] === "kind:image");
    ok("the query is shown beside the name, which is how the syntax is learned",
      picks[0]?.querySelector("code")?.textContent === "kind:image");

    const pictures = picks.find((p) => p.textContent?.startsWith("Pictures"));
    pictures?.click();
    ok("picking a filter puts it in the box", bar.input.value === "kind:image");
    ok("...and announces it at once", seen[seen.length - 1] === "kind:image");
    ok("...and closes the menu", bar.root.querySelector(".flt-menu") === null);

    // Saving. `prompt()` returns null in the desktop webview, so this has to be
    // a field in the menu — and it has to actually save.
    bar.set("kind:video size:>1gb");
    bar.openMenu();
    const nameField = bar.root.querySelector<HTMLInputElement>(".flt-name")!;
    nameField.value = "Big videos";
    bar.root.querySelector<HTMLFormElement>(".flt-save")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    ok("saving records the name", saved.length === 2 && saved[1]?.name === "Big videos");
    ok("...and the query that was in the box", saved[1]?.query === "kind:video size:>1gb");
    ok("the menu redraws with it", bar.root.querySelectorAll(".flt-pick").length === PRESETS.length + 2);

    bar.root.querySelector<HTMLButtonElement>(".flt-drop")!.click();
    ok("dropping a saved filter asks for it to be forgotten", removed[0] === "Photos");

    bar.closeMenu();
    ok("the menu closes", bar.root.querySelector(".flt-menu") === null);

    // A filter box that let a bare letter reach the shell would open the hex
    // inspector while you typed the word "hex".
    let escaped = false;
    document.addEventListener("keydown", () => { escaped = true; });
    key("h");
    ok("keys typed in the box do not reach the shell", !escaped);

    bar.destroy();

    const line = `rule: ${pass} passed, ${fail} failed`;
    console.log(`%c${line}`, `color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`);
    const banner = document.createElement("h2");
    banner.textContent = line;
    banner.style.cssText = `font:600 18px system-ui;color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`;
    document.body.prepend(banner);
  })();
}

main();
