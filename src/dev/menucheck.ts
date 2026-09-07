/**
 * Checks the right-click menu, the actions behind it, and the builder (item 39).
 *
 * Three claims are under test, and they are the three that would hurt if wrong.
 *
 * **1. The menu is a preference over a list that changes.** `commands()` is
 * rebuilt for every selection, so a stored line naming `video.edit` is perfectly
 * valid while a spreadsheet is selected — the row simply is not there. Every
 * consequence of that is here: ids that drop, separators that would be left
 * hanging, and a line whose ids all dropped, which must still open a menu
 * rather than an empty box.
 *
 * **2. An argument line never becomes a shell command.** `splitArgs` runs
 * first and `{tokens}` are substituted into the words it produced, so a file
 * called `a & b "quoted".jpg` occupies exactly one slot of argv no matter what
 * it contains. There is no shell downstream to re-split it — see `run_program`
 * in `src-tauri/src/fsx.rs` — but the property is asserted here anyway, because
 * the day someone "simplifies" this into a string is the day it matters.
 *
 * **3. A half-written action is kept but not offered.** Filling one in means
 * going to find the path of a program, which means closing the sheet. An editor
 * that threw the work away for being incomplete is one nobody finishes using;
 * an app that *offered* the incomplete thing would fail at the moment of use.
 *
 * Dev-only. Loaded by /dev/menucheck.html, which is not a build input.
 *
 *   http://localhost:8183/dev/menucheck.html
 */

import "../styles/base.css";
import "../styles/menu.css";

import {
  ActionsStore,
  appliesTo,
  buildArgs,
  commandIdFor,
  memoryActions,
  problemWith,
  splitArgs,
  TOKENS,
  type UserAction,
} from "@core/explorer/actions";
import {
  buildMenu,
  DEFAULT_MENU,
  parseMenu,
  REST,
  restOfGroup,
  stringifyMenu,
  type MenuCommand,
} from "@core/explorer/menu";
import type { FileEntry } from "@core/explorer/types";
import { ContextMenu } from "@ui/menu";
import { MenuPanel } from "@ui/menu-panel";

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

/** Off the screen, not merely `[hidden]` — a stylesheet's `display` outranks it. */
const gone = (el: Element | null): boolean =>
  el !== null && getComputedStyle(el).display === "none";

const cmd = (id: string, title = id, group = "File"): MenuCommand => ({ id, title, group });

/** What a menu built from `rows` reads as, top to bottom. */
const shape = (line: string, available: readonly MenuCommand[]): string =>
  buildMenu(line, available)
    .map((r) => (r.kind === "sep" ? "-" : r.cmd.id))
    .join(",");

const entry = (name: string, kind: FileEntry["kind"], path?: string): FileEntry => ({
  path: path ?? `C:/x/${name}`,
  name,
  kind,
  ext: name.includes(".") ? (name.split(".").pop() ?? "") : "",
});

const action = (over: Partial<UserAction> = {}): UserAction => ({
  id: "a1",
  label: "Zip it",
  program: "7z.exe",
  args: "a {stem}.zip {paths}",
  kinds: [],
  each: false,
  ...over,
});

async function main(): Promise<void> {
  // ── 1. Splitting a command line ───────────────────────────────────────────
  {
    ok("empty line is no arguments", splitArgs("").length === 0);
    ok("whitespace only is no arguments", splitArgs("   \t ").length === 0);
    ok("plain words split", splitArgs("a b c").join("|") === "a|b|c");
    ok("runs of spaces collapse", splitArgs("a    b").join("|") === "a|b");
    ok("tabs separate too", splitArgs("a\tb").join("|") === "a|b");
    ok("quotes group", splitArgs('"a b" c').join("|") === "a b|c");
    ok("quotes are removed", splitArgs('"a"').join("|") === "a");
    ok("a quote mid-word groups the rest",
      splitArgs('--out="a b"').join("|") === "--out=a b");
    ok("an empty quoted argument survives", splitArgs('a "" b').join("|") === "a||b");
    ok("an unterminated quote takes the rest of the line",
      splitArgs('a "b c').join("|") === "a|b c");
    // Backslash is the path separator on the platform this ships on, not an
    // escape; treating it as one would break every Windows path typed here.
    ok("backslash is literal", splitArgs("C:\\Users\\me").join("|") === "C:\\Users\\me");
    ok("leading and trailing space do not make empty arguments",
      splitArgs("  a b  ").join("|") === "a|b");
  }

  // ── 2. Tokens ─────────────────────────────────────────────────────────────
  {
    const ctx = { path: "C:/pics/holiday.jpeg", paths: ["C:/pics/holiday.jpeg"], folder: "C:/pics" };
    const one = (args: string): string => buildArgs(action({ args }), ctx).join("|");

    ok("{path} is the whole path", one("{path}") === "C:/pics/holiday.jpeg");
    ok("{name} is the file name", one("{name}") === "holiday.jpeg");
    ok("{stem} drops the extension", one("{stem}") === "holiday");
    ok("{ext} is the extension with no dot", one("{ext}") === "jpeg");
    ok("{dir} is the containing folder", one("{dir}") === "C:/pics");
    ok("{folder} is the folder on screen", one("{folder}") === "C:/pics");
    ok("tokens compose inside a word", one("{dir}/out/{stem}.png") === "C:/pics/out/holiday.png");
    ok("a word with no token is passed through", one("-y") === "-y");
    ok("an unknown token is left alone rather than deleted",
      one("{nope}") === "{nope}");

    const noExt = { path: "C:/x/README", paths: ["C:/x/README"], folder: "C:/x" };
    ok("{ext} on a file with no extension is empty, not a lost argument",
      buildArgs(action({ args: "-o {ext} -q" }), noExt).join("|") === "-o||-q");
    ok("{stem} of an extensionless file is the whole name",
      buildArgs(action({ args: "{stem}" }), noExt).join("|") === "README");
    // A dotfile is not an extension — `.gitignore` has stem `.gitignore`.
    const dot = { path: "C:/x/.gitignore", paths: ["C:/x/.gitignore"], folder: "C:/x" };
    ok("a dotfile is all stem and no extension",
      buildArgs(action({ args: "{stem}|{ext}" }), dot).join("|") === ".gitignore|");

    // No file at all — a folder-wide action.
    const bare = { paths: [] as string[], folder: "C:/pics" };
    ok("with no file, {path} is empty and {folder} still works",
      buildArgs(action({ args: "{path} {folder}" }), bare).join("|") === "|C:/pics");
  }

  // ── 3. {paths} — the one token that is not a string ───────────────────────
  {
    const many = {
      paths: ["C:/a/one.jpg", "C:/a/two.jpg", "C:/a/three.jpg"],
      folder: "C:/a",
    };
    ok("{paths} becomes one argument per file",
      buildArgs(action({ args: "a out.zip {paths}" }), many).join("|") ===
        "a|out.zip|C:/a/one.jpg|C:/a/two.jpg|C:/a/three.jpg");
    ok("{paths} embedded in a word repeats the word",
      buildArgs(action({ args: "--file={paths}" }), many).join("|") ===
        "--file=C:/a/one.jpg|--file=C:/a/two.jpg|--file=C:/a/three.jpg");
    ok("other tokens in a {paths} word belong to that copy",
      buildArgs(action({ args: "{stem}-{paths}" }), many).join("|") ===
        "one-C:/a/one.jpg|two-C:/a/two.jpg|three-C:/a/three.jpg");
    ok("{paths} with nothing selected produces no argument at all",
      buildArgs(action({ args: "a out.zip {paths}" }), { paths: [], folder: "C:/a" }).join("|") ===
        "a|out.zip");
  }

  // ── 4. A filename cannot become a second command ──────────────────────────
  {
    // The whole safety claim, stated as the test that would fail if anyone
    // rewrote this to build a string and split it again.
    const nasty = 'C:/x/a & b "quoted" | rm -rf.jpg';
    const args = buildArgs(action({ args: "-i {path} -o out.png" }), {
      path: nasty,
      paths: [nasty],
      folder: "C:/x",
    });
    ok("a filename full of shell metacharacters is exactly one argument",
      args.length === 4 && args[1] === nasty, args.join(" ¦ "));
    ok("…including when it holds a space", args[1]?.includes(" ") === true);
    ok("…and a quote", args[1]?.includes('"') === true);

    const newline = "C:/x/two\nlines.jpg";
    const nl = buildArgs(action({ args: "{path}" }), {
      path: newline, paths: [newline], folder: "C:/x",
    });
    ok("a newline in a filename does not split it", nl.length === 1 && nl[0] === newline);

    // And the same for a path arriving through {paths}.
    const both = buildArgs(action({ args: "{paths}" }), {
      paths: [nasty, newline], folder: "C:/x",
    });
    ok("{paths} keeps one slot per file however nasty they are",
      both.length === 2 && both[0] === nasty && both[1] === newline);
  }

  // ── 5. What refuses to be offered ─────────────────────────────────────────
  {
    ok("a complete action has no problem", problemWith(action()) === null);
    ok("no name is a problem", problemWith(action({ label: "  " })) !== null);
    ok("no program is a problem", problemWith(action({ program: "" })) !== null);
    ok("an empty argument line is fine — some programs take none",
      problemWith(action({ args: "" })) === null);

    const typo = problemWith(action({ args: "{filename}" }));
    ok("a mistyped token is caught", typo !== null);
    ok("…and the message names it", typo?.includes("{filename}") === true, typo ?? "");
    ok("…and lists the real ones",
      typo?.includes("{stem}") === true && typo?.includes("{paths}") === true);

    const two = problemWith(action({ args: "{nope} {alsonope} {path}" }));
    ok("two mistyped tokens are both named",
      two?.includes("{nope}") === true && two?.includes("{alsonope}") === true);
    // Only up to "Try …" — the tail of the message lists every real token, so
    // {path} is in there by design.
    ok("…and a real token beside them is not complained about",
      two?.split("Try ")[0]?.includes("{path}") === false, two ?? "");

    // Every documented token has to actually pass the checker, or the help text
    // under the box would be telling people to type something it rejects.
    for (const [t] of TOKENS) {
      ok(`{${t}} is accepted`, problemWith(action({ args: `{${t}}` })) === null);
    }
  }

  // ── 6. Which selection an action is offered for ───────────────────────────
  {
    const pics = [entry("a.jpg", "image"), entry("b.png", "image")];
    const mixed = [entry("a.jpg", "image"), entry("c.mp4", "video")];

    ok("no kinds means anything", appliesTo(action({ kinds: [] }), mixed));
    ok("nothing selected means nothing offered", !appliesTo(action({ kinds: [] }), []));
    ok("a matching kind is offered", appliesTo(action({ kinds: ["image"] }), pics));
    // Every file has to qualify: an action that ran on two of the three things
    // you had highlighted would be a surprise, and the row says nothing about
    // which two.
    ok("a mixed selection is not offered a kind-specific action",
      !appliesTo(action({ kinds: ["image"] }), mixed));
    ok("two kinds cover a mixed selection",
      appliesTo(action({ kinds: ["image", "video"] }), mixed));
    ok("folders are a kind like any other",
      appliesTo(action({ kinds: ["folder"] }), [entry("Docs", "folder")]));
  }

  // ── 7. The menu line ──────────────────────────────────────────────────────
  {
    ok("blank entries are dropped", parseMenu("a,,b").join("|") === "a|b");
    ok("whitespace is trimmed", parseMenu(" a , b ").join("|") === "a|b");
    ok("a duplicate id is dropped", parseMenu("a,b,a").join("|") === "a|b");
    ok("separators are not deduplicated", parseMenu("a,-,b,-,c").join("|") === "a|-|b|-|c");
    ok("an empty line is no ids", parseMenu("").length === 0);
    ok("a round trip is the line back", stringifyMenu(parseMenu("a,-,b")) === "a,-,b");
    ok("the shipped line parses", parseMenu(DEFAULT_MENU).length > 5);
    // Ends in the *group* form, not a bare `*`. A right-click that ended in `*`
    // is the whole palette — forty rows with eleven themes in it — which is the
    // thing this menu exists instead of.
    ok("…and ends in everything-else-in-File, so a file command shipped later is reachable",
      parseMenu(DEFAULT_MENU).at(-1) === restOfGroup("File"));
    ok("…and never names the bare wildcard",
      !parseMenu(DEFAULT_MENU).includes(REST));
    ok("…and makes room for the user's own actions near the top",
      parseMenu(DEFAULT_MENU).indexOf(restOfGroup("Yours")) === 3);
    ok("…and carries the queue, which is about the files you clicked",
      parseMenu(DEFAULT_MENU).includes(restOfGroup("Batch")));
    // Three groups and no more: the palette's Go, View, Sort, Appearance and
    // eleven themes have no business on a right-click.
    ok("…and names no other group",
      parseMenu(DEFAULT_MENU).filter((id) => id.endsWith(REST)).length === 3);
  }

  // ── 8. Building a menu against what is available ──────────────────────────
  {
    const have = [cmd("file.open"), cmd("file.look"), cmd("file.reveal"), cmd("view.filter", "Filter", "View")];

    ok("ids come out in the order asked for",
      shape("file.reveal,file.open", have) === "file.reveal,file.open");
    ok("an id nothing offers drops out",
      shape("file.open,video.edit,file.look", have) === "file.open,file.look");
    ok("a separator survives between two live rows",
      shape("file.open,-,file.look", have) === "file.open,-,file.look");
    // The four tidying rules, each the thing that would otherwise look like a
    // bug the user caused by editing the line.
    ok("a separator left hanging by a dropped id collapses",
      shape("file.open,-,video.edit,-,file.look", have) === "file.open,-,file.look");
    ok("a leading separator is dropped", shape("-,file.open", have) === "file.open");
    ok("a trailing separator is dropped", shape("file.open,-", have) === "file.open");
    ok("two separators in a row become one",
      shape("file.open,-,-,file.look", have) === "file.open,-,file.look");
    ok("a separator with nothing but dead ids around it disappears entirely",
      shape("video.edit,-,audio.edit", have) === "file.open,file.look,file.reveal,view.filter");

    ok("* is everything not named above",
      shape("file.reveal,-,*", have) === "file.reveal,-,file.open,file.look,view.filter");
    ok("* alone is the whole list in its own order",
      shape("*", have) === "file.open,file.look,file.reveal,view.filter");
    ok("* named twice does not repeat the list",
      shape("*,*", have) === "file.open,file.look,file.reveal,view.filter");
    ok("an id named after * is not drawn twice",
      shape("*,file.open", have) === "file.look,file.reveal,view.filter,file.open");

    // The empty-menu rules. A right-click that opens nothing looks broken and
    // the user cannot tell it was their own line that did it.
    ok("a line naming nothing available falls back to everything",
      shape("nope.one,nope.two", have) === "file.open,file.look,file.reveal,view.filter");
    ok("an empty line falls back to everything",
      shape("", have) === "file.open,file.look,file.reveal,view.filter");
    ok("a line of only separators falls back to everything",
      shape("-,-,-", have) === "file.open,file.look,file.reveal,view.filter");
    ok("nothing available is an empty menu, not a crash",
      shape("file.open,*", []) === "");
    // The group form. Without it the shipped menu is the whole palette: the live
    // app offers 43 commands on a right-click, eleven of them themes.
    ok("a group wildcard draws only that group",
      shape("View*", have) === "view.filter");
    ok("…and skips what is named above it",
      shape("file.look,File*", have) === "file.look,file.open,file.reveal");
    ok("…and a group nothing is in draws nothing, so its separators collapse",
      shape("file.open,-,Yours*", have) === "file.open");
    ok("two group wildcards do not repeat a command",
      shape("File*,File*", have) === "file.open,file.look,file.reveal");
    ok("a group wildcard then * covers the rest without repeating",
      shape("File*,*", have) === "file.open,file.look,file.reveal,view.filter");
    ok("* then a group wildcard adds nothing new",
      shape("*,File*", have) === "file.open,file.look,file.reveal,view.filter");
    ok("the group name is matched however it is cased",
      shape("file*", have) === "file.open,file.look,file.reveal");
    ok("a group that does not exist is not a crash — it falls back",
      shape("Nope*", have) === "file.open,file.look,file.reveal,view.filter");

    ok("the shipped line against a real-looking list produces rows",
      buildMenu(DEFAULT_MENU, have).filter((r) => r.kind === "item").length === 3);
    ok("…and none of them are from another group",
      buildMenu(DEFAULT_MENU, have)
        .every((r) => r.kind === "sep" || r.cmd.group === "File"));
  }

  // ── 9. The store ──────────────────────────────────────────────────────────
  {
    const back = memoryActions();
    const store = new ActionsStore(back);

    ok("a fresh store is empty", store.all().length === 0);
    ok("…and untouched", store.touched() === false);

    const a = store.add({ label: "Zip", program: "7z.exe", args: "a {stem}.zip {paths}" });
    ok("adding returns the action", a.label === "Zip");
    ok("…and it is in the list", store.all().length === 1);
    ok("…and touched says so", store.touched() === true);
    ok("…and the command id is derived from the id", commandIdFor(a) === `act:${a.id}`);

    const b = store.add();
    ok("a second action gets a different id", b.id !== a.id);
    ok("a blank action starts with {path}, which is what most of them want",
      b.args === "{path}");
    ok("a blank action is kept", store.all().length === 2);
    ok("…but not offered", store.runnable().length === 1);

    store.update(b.id, { label: "Open in Krita", program: "krita.exe" });
    ok("filling it in offers it", store.runnable().length === 2);
    ok("update writes the field", store.get(b.id)?.label === "Open in Krita");
    store.update("nosuch", { label: "x" });
    ok("updating an action that is not there is quiet", store.all().length === 2);

    store.move(b.id, -1);
    ok("moving up reorders", store.all()[0]?.id === b.id);
    store.move(b.id, -1);
    ok("moving past the top does nothing", store.all()[0]?.id === b.id);
    store.move(b.id, 1);
    ok("moving down reorders back", store.all()[0]?.id === a.id);
    store.move(a.id, 5);
    ok("moving past the end does nothing", store.all()[0]?.id === a.id);

    // Round trip.
    const reread = new ActionsStore(memoryActions(back.read()));
    ok("it survives a reload", reread.all().length === 2);
    ok("…with the fields intact",
      reread.get(a.id)?.args === "a {stem}.zip {paths}");
    ok("…and the order", reread.all()[0]?.id === a.id);

    // An id is never reused, because the menu line is a line of ids: a new
    // action inheriting a deleted one's id would silently take its place.
    const gonezo = store.all()[1]?.id ?? "";
    store.remove(gonezo);
    const c = store.add({ label: "Third" });
    ok("removing takes it out", store.all().length === 2);
    ok("a new action does not reuse a deleted id", c.id !== gonezo);

    store.remove("nosuch");
    ok("removing something that is not there is quiet", store.all().length === 2);

    store.reset();
    ok("reset empties it", store.all().length === 0 && store.touched() === false);
    ok("…and persists", new ActionsStore(memoryActions(back.read())).all().length === 0);
  }

  // ── 10. A hand-edited file ────────────────────────────────────────────────
  {
    const junk = [
      "", "   ", "null", "[]", "{}", "not json at all", "[1,2,3]", '"a string"',
      '{"version":1}',
      '{"version":1,"actions":null}',
      '{"version":1,"actions":"nope"}',
      '{"version":1,"actions":[null,3,"x"]}',
      '{"version":2,"actions":[{"id":"a1","label":"x","program":"y"}]}',
      '{"actions":[{"id":"a1","label":"x","program":"y"}]}',
      '{"version":1,"actions":[{"label":"no id"}]}',
    ];
    let survived = 0;
    for (const text of junk) {
      const s = new ActionsStore(memoryActions(text));
      if (s.all().length === 0) survived++;
    }
    ok("fifteen shapes of broken file all read as no actions", survived === junk.length,
      `${survived}/${junk.length}`);

    // Salvage: an action with an id and nothing else is kept, because the id is
    // what the menu line refers to and throwing it away would edit that line.
    const thin = new ActionsStore(memoryActions('{"version":1,"actions":[{"id":"a7"}]}'));
    ok("an action with only an id is kept", thin.all().length === 1);
    ok("…with sane blanks", thin.get("a7")?.label === "" && thin.get("a7")?.args === "");
    ok("…but is not offered", thin.runnable().length === 0);
    ok("…and a new action does not collide with it", thin.add().id !== "a7");

    const dupes = new ActionsStore(
      memoryActions('{"version":1,"actions":[{"id":"a1","label":"one"},{"id":"a1","label":"two"}]}'),
    );
    ok("a duplicated id keeps the first only", dupes.all().length === 1);
    ok("…the first", dupes.get("a1")?.label === "one");

    const each = new ActionsStore(
      memoryActions('{"version":1,"actions":[{"id":"a1","each":false},{"id":"a2"}]}'),
    );
    ok("each: false survives", each.get("a1")?.each === false);
    ok("a missing `each` defaults to per-file, which is the safer read",
      each.get("a2")?.each === true);

    const kinds = new ActionsStore(
      memoryActions('{"version":1,"actions":[{"id":"a1","kinds":["image",7,null,"video"]}]}'),
    );
    ok("junk inside kinds is filtered out",
      kinds.get("a1")?.kinds.join(",") === "image,video");

    // A backend that throws on both ends.
    const angry: { read(): string | null; write(t: string): void } = {
      read: () => { throw new Error("no"); },
      write: () => { throw new Error("no"); },
    };
    const brave = new ActionsStore(angry);
    ok("a backend that throws on read is an empty store, not a crash",
      brave.all().length === 0);
    brave.add({ label: "x", program: "y" });
    ok("…and a write that throws still applies for this run",
      brave.all().length === 1);
  }

  // ── 11. The menu on screen ────────────────────────────────────────────────
  {
    const menu = new ContextMenu();
    let ran = "";
    const runnable = [
      { ...cmd("file.open", "Open"), run: () => { ran = "open"; } },
      { ...cmd("file.look", "Quick look"), hint: "Space", run: () => { ran = "look"; } },
      { ...cmd("file.reveal", "Show in File Explorer"), run: () => { ran = "reveal"; } },
    ];

    ok("it starts closed", menu.isOpen === false && gone(menu.element));

    menu.open({ x: 40, y: 40, line: "file.open,-,file.look", commands: runnable });
    ok("opening shows it", menu.isOpen === true && !gone(menu.element));
    ok("it drew the rows asked for",
      menu.element.querySelectorAll(".ctx-row").length === 2);
    ok("…and the separator between them",
      menu.element.querySelectorAll(".ctx-sep").length === 1);
    ok("a row says what the command says",
      menu.element.querySelector(".ctx-name")?.textContent === "Open");
    ok("a hint is drawn when there is one",
      menu.element.querySelectorAll(".ctx-hint").length === 1);

    // Position. The exact numbers are the browser's; what is asserted is that
    // it is on screen, because a menu opened near an edge that simply overflows
    // has rows nobody can click.
    const box = menu.element.getBoundingClientRect();
    ok("it is placed at the pointer", Math.abs(box.left - 40) < 2, `${box.left}`);
    menu.close();

    menu.open({ x: window.innerWidth - 4, y: window.innerHeight - 4, line: "*", commands: runnable });
    const corner = menu.element.getBoundingClientRect();
    ok("opened in the bottom-right corner it stays inside the window",
      corner.right <= window.innerWidth + 1 && corner.bottom <= window.innerHeight + 1,
      `${corner.right}x${corner.bottom} in ${window.innerWidth}x${window.innerHeight}`);
    ok("…and is still fully drawn", corner.width > 0 && corner.height > 0);
    menu.close();

    // Keyboard.
    menu.open({ x: 40, y: 40, line: "*", commands: runnable });
    const press = (key: string): void => {
      menu.element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    };
    const lit = (i: number): boolean =>
      menu.element.querySelectorAll<HTMLElement>(".ctx-row")[i]?.dataset["on"] === "true";

    ok("nothing is highlighted on open — Enter must not run a command you did not pick",
      menu.element.querySelector('[data-on="true"]') === null);
    press("ArrowDown");
    ok("Down highlights the first row", lit(0));
    press("ArrowDown");
    press("ArrowDown");
    ok("Down again reaches the third", lit(2));
    press("ArrowDown");
    ok("…and wraps to the top", lit(0));
    press("ArrowUp");
    ok("Up wraps the other way", lit(2));
    press("Home");
    ok("Home goes to the first", lit(0));
    press("End");
    ok("End goes to the last", lit(2));
    press("Enter");
    ok("Enter runs the highlighted command", ran === "reveal", ran);
    ok("…and closes the menu", menu.isOpen === false);

    menu.open({ x: 40, y: 40, line: "*", commands: runnable });
    press("Escape");
    ok("Escape closes without running anything", menu.isOpen === false && ran === "reveal");

    // Clicking.
    ran = "";
    menu.open({ x: 40, y: 40, line: "file.look", commands: runnable });
    (menu.element.querySelector(".ctx-row") as HTMLElement | null)?.click();
    ok("clicking a row runs it", ran === "look");
    ok("…and closes", menu.isOpen === false);

    // Closing on the world moving. A menu left floating over a folder that has
    // been navigated away from would run its commands against the new one.
    menu.open({ x: 40, y: 40, line: "*", commands: runnable });
    window.dispatchEvent(new Event("resize"));
    ok("a resize closes it", menu.isOpen === false);
    menu.open({ x: 40, y: 40, line: "*", commands: runnable });
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    ok("a click outside closes it", menu.isOpen === false);
    menu.open({ x: 40, y: 40, line: "*", commands: runnable });
    document.dispatchEvent(new Event("scroll", { bubbles: true }));
    ok("a scroll closes it", menu.isOpen === false);

    // The last row.
    let edited = 0;
    menu.open({ x: 40, y: 40, line: "file.open", commands: runnable, edit: () => { edited++; } });
    ok("the edit row is offered when the shell supplies one",
      menu.element.querySelector(".ctx-edit") !== null);
    (menu.element.querySelector(".ctx-edit") as HTMLElement | null)?.click();
    ok("…and opens the builder", edited === 1);
    menu.open({ x: 40, y: 40, line: "file.open", commands: runnable });
    ok("…and is absent when it does not",
      menu.element.querySelector(".ctx-edit") === null);
    menu.close();
    ok("closing a closed menu is quiet", menu.isOpen === false);
    menu.element.remove();
  }

  // ── 12. The builder ───────────────────────────────────────────────────────
  {
    const store = new ActionsStore(memoryActions());
    let line = "file.open,-,file.look";
    const panel = new MenuPanel();
    const catalogue = [cmd("file.open", "Open"), cmd("file.look", "Quick look"), cmd("file.reveal", "Show in File Explorer")];

    panel.open({
      read: () => line,
      write: (next) => { line = next; },
      reset: () => { line = DEFAULT_MENU; },
      catalogue: () => catalogue,
      actions: () => store.all(),
      addAction: () => store.add(),
      updateAction: (id, patch) => store.update(id, patch),
      removeAction: (id) => store.remove(id),
      moveAction: (id, delta) => store.move(id, delta),
    });

    const rows = (): string =>
      [...panel.element.querySelectorAll(".mnu-list > .mnu-row .mnu-name")]
        .map((n) => n.textContent)
        .join(",");
    const click = (el: Element | null | undefined): void => {
      (el as HTMLElement | null)?.click();
    };
    const rowFor = (text: string): HTMLElement | null =>
      [...panel.element.querySelectorAll<HTMLElement>(".mnu-row")].find(
        (r) => r.querySelector(".mnu-name")?.textContent === text,
      ) ?? null;
    const head = (): HTMLElement | null =>
      panel.element.querySelector<HTMLElement>(".mnu-act .mnu-row");

    ok("the builder opens", panel.isOpen === true && !gone(panel.element));
    ok("it lists the line, by title", rows() === "Open,———,Quick look");
    ok("what is not in the line can be added",
      [...panel.element.querySelectorAll(".mnu-addrow")].some((b) =>
        b.textContent?.includes("Show in File Explorer")));
    ok("…and what is in it cannot be added twice",
      ![...panel.element.querySelectorAll(".mnu-addrow")].some((b) =>
        b.textContent?.includes("· Open")));

    click([...panel.element.querySelectorAll(".mnu-addrow")].find((b) =>
      b.textContent?.includes("Show in File Explorer")));
    ok("adding appends to the line", line === "file.open,-,file.look,file.reveal", line);
    ok("…and the list redrew", rows() === "Open,———,Quick look,Show in File Explorer");

    click(rowFor("Show in File Explorer")?.querySelectorAll(".mnu-tick")[0]);
    ok("▲ moves it up", line === "file.open,-,file.reveal,file.look", line);
    click(rowFor("Show in File Explorer")?.querySelectorAll(".mnu-tick")[1]);
    ok("▼ moves it back", line === "file.open,-,file.look,file.reveal", line);
    click(rowFor("Open")?.querySelectorAll(".mnu-tick")[0]);
    ok("▲ on the top row does nothing", line === "file.open,-,file.look,file.reveal");
    click(rowFor("Open")?.querySelectorAll(".mnu-tick")[2]);
    ok("✕ takes it out", line === "-,file.look,file.reveal", line);

    click([...panel.element.querySelectorAll(".mnu-addrow")].find((b) =>
      b.textContent === "A dividing line"));
    ok("a dividing line can be added", line === "-,file.look,file.reveal,-", line);
    const addable = (text: string): Element | undefined =>
      [...panel.element.querySelectorAll(".mnu-addrow")].find(
        (b) => b.textContent === text,
      );

    // One row per group in the catalogue — here that is File and nothing else.
    ok("a group can be added", addable("Everything else in File") !== undefined);
    click(addable("Everything else in File"));
    ok("…and lands as the group token", line.endsWith(",File*"), line);
    ok("…and reads as a group, not as an id",
      rowFor("Everything else in File") !== null);
    ok("…and is not offered twice", addable("Everything else in File") === undefined);

    click(addable("Everything else, in its own order"));
    ok("so can the bare wildcard", line.endsWith(`,${REST}`), line);
    ok("…and once it is there it is not offered again",
      addable("Everything else, in its own order") === undefined);

    // A row naming a command the current selection does not offer is still
    // shown and still removable — hiding it would make the line uneditable.
    line = "file.open,video.edit";
    panel.sync();
    ok("a row for an unavailable command is still drawn",
      rowFor("video.edit") !== null);
    ok("…and marked as such",
      rowFor("video.edit")?.dataset["off"] === "true");
    click(rowFor("video.edit")?.querySelectorAll(".mnu-tick")[2]);
    ok("…and can be taken out", line === "file.open", line);

    click(panel.element.querySelector(".mnu-reset"));
    ok("reset restores the shipped menu", line === DEFAULT_MENU);

    // ── actions ──
    ok("no actions yet", panel.element.querySelectorAll(".mnu-act").length === 0);
    click(panel.element.querySelector(".mnu-add"));
    ok("+ New action adds one", store.all().length === 1);
    ok("…and draws it", panel.element.querySelectorAll(".mnu-act").length === 1);
    ok("…already expanded, because a blank row is nothing to look at",
      panel.element.querySelector(".mnu-form") !== null);
    ok("…and flagged incomplete", head()?.dataset["off"] === "true");
    ok("…with a problem line saying why",
      panel.element.querySelector(".mnu-problem") !== null);

    const id = store.all()[0]?.id ?? "";
    const type = (label: string, value: string): void => {
      const field = [...panel.element.querySelectorAll<HTMLElement>(".mnu-field")].find(
        (f) => f.querySelector(".mnu-flabel")?.textContent === label,
      );
      const input = field?.querySelector("input");
      if (input === null || input === undefined) return;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };

    type("Name", "Zip it");
    ok("typing a name saves it on the keystroke", store.get(id)?.label === "Zip it");
    type("Program", "7z.exe");
    ok("typing a program saves it", store.get(id)?.program === "7z.exe");
    ok("…and now it is offered", store.runnable().length === 1);

    type("Arguments", "a {stem}.zip {paths}");
    ok("typing arguments saves them", store.get(id)?.args === "a {stem}.zip {paths}");

    // The kind chips.
    const chip = (text: string): HTMLElement | null =>
      [...panel.element.querySelectorAll<HTMLElement>(".mnu-kind")].find(
        (b) => b.textContent === text,
      ) ?? null;
    ok("no kind is chosen to start with", store.get(id)?.kinds.length === 0);
    click(chip("pictures"));
    ok("a chip sets the kind", store.get(id)?.kinds.join(",") === "image");
    ok("…and shows as on", chip("pictures")?.dataset["on"] === "true");
    click(chip("videos"));
    ok("a second chip adds to it", store.get(id)?.kinds.join(",") === "image,video");
    click(chip("pictures"));
    ok("clicking again takes it off", store.get(id)?.kinds.join(",") === "video");

    ok("per-file is the default",
      chip("run it once per file")?.dataset["on"] === "true");
    click(chip("run it once for all of them"));
    ok("…and can be switched", store.get(id)?.each === false);

    // The problem line is gone now that it is complete.
    panel.sync();
    ok("a complete action no longer shows a problem",
      panel.element.querySelector(".mnu-problem") === null);
    ok("…and says where it turns up", panel.element.querySelector(".mnu-ok") !== null);
    ok("…and its row is no longer flagged", head()?.dataset["off"] === undefined);

    // An action is a menu candidate like anything else, even though the
    // catalogue this panel was handed does not know about it.
    ok("the action can be added to the menu",
      [...panel.element.querySelectorAll(".mnu-addrow")].some((b) =>
        b.textContent?.includes("Zip it")));

    // Ordering and deleting actions.
    click(panel.element.querySelector(".mnu-add"));
    ok("a second action", store.all().length === 2);
    const acts = (): string => store.all().map((a) => a.label || "?").join(",");
    ok("appended at the end", acts() === "Zip it,?");
    click(panel.element.querySelectorAll(".mnu-act")[1]?.querySelectorAll(".mnu-tick")[0]);
    ok("▲ reorders actions", acts() === "?,Zip it");
    click(panel.element.querySelectorAll(".mnu-act")[0]?.querySelectorAll(".mnu-tick")[2]);
    ok("✕ deletes one", store.all().length === 1 && acts() === "Zip it");

    // Expanding. Deleting the row that was open closed the form with it, which
    // is the state to start from here.
    ok("deleting the open row closed its form",
      panel.element.querySelector(".mnu-form") === null);
    click(panel.element.querySelector(".mnu-actname"));
    ok("clicking the name opens the form",
      panel.element.querySelector(".mnu-form") !== null);
    click(panel.element.querySelector(".mnu-actname"));
    ok("…and clicking it again collapses it",
      panel.element.querySelector(".mnu-form") === null);

    panel.close();
    ok("closing hides it", panel.isOpen === false && gone(panel.element));
    panel.sync();
    ok("syncing a closed panel is quiet", panel.isOpen === false);
    panel.element.remove();
  }

  const line = `menu: ${pass} passed, ${fail} failed`;
  console.log(`%c${line}`, `color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`);
  const banner = document.createElement("h2");
  banner.textContent = line;
  banner.style.cssText = `font:600 18px system-ui;color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`;
  document.body.prepend(banner);
}

void main();
