/**
 * Checks the sidebar store and the panel that edits it (item 38).
 *
 * The claim under test is the one in the header of `places.ts`: **this is a diff
 * over what the disk reports, not a replacement for it.** Almost every assertion
 * below is a way of asking the same question — if the machine's list changes
 * underneath a saved preference, does the sidebar still tell the truth? A store
 * that got this wrong would not crash. It would quietly show a drive that was
 * unplugged in March, or quietly fail to show the stick you just pushed in, and
 * you would never be sure which of the two was happening.
 *
 * The other thing worth defending is that a place you *hid* is not a place you
 * destroyed. Pictures taken off the sidebar has to remain nameable, or the only
 * route back is deleting the preference file, which nobody will find.
 *
 * And the ordering constraint, which is a real constraint and not a preference:
 * the tree draws its "This PC" heading at the first row whose icon is `drive`,
 * so a folder that sorted below a drive would be filed under This PC. The store
 * therefore reorders within folders and within drives, never across.
 *
 * Dev-only. Loaded by /dev/placecheck.html, which is not a build input.
 *
 *   http://localhost:8183/dev/placecheck.html
 */

import "../styles/base.css";
import "../styles/tree.css";
import "../styles/places.css";

import {
  PlacesStore,
  idFor,
  memoryPlaces,
  nameFor,
  type PlacesBackend,
} from "@core/explorer/places";
import type { Place } from "@core/explorer/types";
import { PlacesPanel } from "@ui/places-panel";

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

/** Actually off the screen, not merely marked hidden — a stylesheet's `display`
 *  outranks `[hidden]`, so `.hidden` is not the question. */
const gone = (el: Element | null): boolean =>
  el !== null && getComputedStyle(el).display === "none";

/** What the machine reports on a typical Windows box, in adapter order. */
const discovered = (): Place[] => [
  { id: "home", name: "Home", icon: "home", path: "C:/Users/me", pinned: false },
  { id: "pics", name: "Pictures", icon: "image", path: "C:/Users/me/Pictures", pinned: false },
  { id: "vids", name: "Videos", icon: "video", path: "C:/Users/me/Videos", pinned: false },
  { id: "docs", name: "Documents", icon: "doc", path: "C:/Users/me/Documents", pinned: false },
  { id: "c", name: "C:", icon: "drive", path: "C:/", pinned: false },
  { id: "d", name: "D:", icon: "drive", path: "D:/", pinned: false },
];

const names = (list: readonly Place[]): string => list.map((p) => p.name).join(",");

/** A store on a fresh in-memory file. */
const fresh = (seed: string | null = null): { store: PlacesStore; back: PlacesBackend } => {
  const back = memoryPlaces(seed);
  return { store: new PlacesStore(back), back };
};

async function main(): Promise<void> {
  // ── 1 — the two helpers ───────────────────────────────────────────────────
  {
    ok("an id is derived from the path, so pinning twice is once",
      idFor("C:/Users/me/Work") === idFor("C:/Users/me/Work"));
    ok("…and case and slashes do not make a second pin",
      idFor("C:/Users/me/Work") === idFor("c:\\users\\me\\work"));
    ok("different folders get different ids",
      idFor("C:/a") !== idFor("C:/b"));
    ok("an id is namespaced, so it can never collide with a discovered one",
      idFor("C:/a").startsWith("user:"));

    ok("a name is the last segment", nameFor("C:/Users/me/Work") === "Work");
    ok("…with a trailing slash trimmed", nameFor("C:/Users/me/Work/") === "Work");
    ok("…and backslashes read the same", nameFor("C:\\Users\\me\\Work") === "Work");
    // A drive root has no last segment, and a row with an empty name is a row
    // you cannot see or click.
    ok("a drive root falls back to the whole path", nameFor("C:/") === "C:");
    ok("…and so does a bare drive letter", nameFor("C:") === "C:");
    ok("a one-segment path is its own name", nameFor("Downloads") === "Downloads");
  }

  // ── 2 — an untouched store is the disk, verbatim ──────────────────────────
  {
    const { store } = fresh();
    const got = store.resolve(discovered());
    ok("nothing saved means the machine's list, unchanged",
      names(got) === "Home,Pictures,Videos,Documents,C:,D:", names(got));
    ok("…and nothing is reported as changed", store.touched() === false);
    ok("an empty discovery gives an empty sidebar", store.resolve([]).length === 0);
    ok("resolve does not mutate what it was handed", (() => {
      const src = discovered();
      store.resolve(src);
      return names(src) === "Home,Pictures,Videos,Documents,C:,D:";
    })());
  }

  // ── 3 — pinning ───────────────────────────────────────────────────────────
  {
    const { store } = fresh();
    store.pin("C:/Work/Renders");
    const got = store.resolve(discovered());
    ok("a pin appears", got.some((p) => p.name === "Renders"));
    ok("…named after its folder", got.find((p) => p.name === "Renders")?.path === "C:/Work/Renders");
    ok("…marked as yours", got.find((p) => p.name === "Renders")?.pinned === true);
    // Above the drives, because it is a folder. This is the constraint the whole
    // ordering scheme exists to hold.
    ok("…and above This PC, because a folder is not a drive",
      got.findIndex((p) => p.name === "Renders") < got.findIndex((p) => p.icon === "drive"));
    ok("the store now says it has been touched", store.touched() === true);

    store.pin("C:/Work/Renders");
    ok("pinning the same folder twice leaves one row",
      store.resolve(discovered()).filter((p) => p.name === "Renders").length === 1);
    store.pin("c:\\work\\renders\\");
    ok("…and neither does the same folder spelled differently",
      store.resolve(discovered()).filter((p) => p.path === "C:/Work/Renders").length === 1);

    store.pin("C:/Users/me/Pictures");
    const dup = store.resolve(discovered());
    ok("pinning a folder the machine already reports does not double it",
      dup.filter((p) => p.path === "C:/Users/me/Pictures").length === 1);
    ok("…and the discovered one wins, so it keeps its icon",
      dup.find((p) => p.path === "C:/Users/me/Pictures")?.icon === "image");

    store.pin("C:/Work/Shots", "  Best shots  ");
    ok("a supplied name is used, trimmed",
      store.resolve(discovered()).some((p) => p.name === "Best shots"));
    store.pin("C:/Work/Blank", "   ");
    ok("a supplied name of only spaces falls back to the folder's",
      store.resolve(discovered()).some((p) => p.name === "Blank"));
  }

  // ── 4 — removing, hiding, and getting it back ─────────────────────────────
  {
    const { store } = fresh();
    store.remove("pics");
    ok("a discovered place can be taken out",
      !store.resolve(discovered()).some((p) => p.id === "pics"));
    ok("…and it is remembered as hidden, so it can be named",
      store.hiddenIds().includes("pics"));
    ok("…the rest of the sidebar is untouched",
      names(store.resolve(discovered())) === "Home,Videos,Documents,C:,D:");

    store.restore("pics");
    ok("putting it back puts it back",
      store.resolve(discovered()).some((p) => p.id === "pics"));
    ok("…and it goes back where it was, not to the end",
      names(store.resolve(discovered())) === "Home,Pictures,Videos,Documents,C:,D:");
    ok("…and nothing is left in the hidden list", store.hiddenIds().length === 0);

    store.pin("C:/Work/Temp");
    const id = idFor("C:/Work/Temp");
    store.remove(id);
    ok("removing your own pin deletes it",
      !store.resolve(discovered()).some((p) => p.id === id));
    ok("…rather than filing it as hidden, which would be a row you cannot see",
      !store.hiddenIds().includes(id));

    // The reason `pin` un-hides: the button says "put this in the sidebar", and
    // that is one outcome whether or not the machine reports the folder.
    store.remove("vids");
    store.pin("C:/Users/me/Videos");
    ok("pinning a folder you had hidden un-hides it",
      store.resolve(discovered()).some((p) => p.id === "vids"));
    ok("…without also leaving a duplicate pin",
      store.resolve(discovered()).filter((p) => p.path === "C:/Users/me/Videos").length === 1);

    store.remove("nope-not-a-place");
    ok("removing something that does not exist is quiet",
      store.resolve(discovered()).length > 0);
    store.restore("also-not-a-place");
    ok("restoring something that was never hidden is quiet",
      store.resolve(discovered()).length > 0);
  }

  // ── 5 — renaming ──────────────────────────────────────────────────────────
  {
    const { store } = fresh();
    store.rename("pics", "Photos");
    ok("a discovered place can be renamed",
      store.resolve(discovered()).find((p) => p.id === "pics")?.name === "Photos");
    ok("…and keeps its path and icon", (() => {
      const p = store.resolve(discovered()).find((q) => q.id === "pics");
      return p?.path === "C:/Users/me/Pictures" && p.icon === "image";
    })());
    ok("…and its position", names(store.resolve(discovered())).startsWith("Home,Photos,"));

    store.rename("pics", "   ");
    ok("renaming to nothing puts the machine's own name back",
      store.resolve(discovered()).find((p) => p.id === "pics")?.name === "Pictures");

    store.rename("c", "  Windows  ");
    ok("a name is trimmed on the way in",
      store.resolve(discovered()).find((p) => p.id === "c")?.name === "Windows");

    store.pin("C:/Work/Renders");
    store.rename(idFor("C:/Work/Renders"), "Output");
    ok("your own pins rename too",
      store.resolve(discovered()).some((p) => p.name === "Output"));

    // A rename is attached to the id, so removing the row and putting it back
    // must not resurrect a name you had already dropped.
    store.remove("c");
    store.restore("c");
    ok("a removed row forgets the name you gave it",
      store.resolve(discovered()).find((p) => p.id === "c")?.name === "C:");
  }

  // ── 6 — order, and the line the drives sit behind ─────────────────────────
  {
    const { store } = fresh();
    let cur = store.resolve(discovered());
    store.move("docs", -1, cur);
    cur = store.resolve(discovered());
    ok("a place moves up one", names(cur) === "Home,Pictures,Documents,Videos,C:,D:", names(cur));

    store.move("docs", -1, cur);
    cur = store.resolve(discovered());
    ok("…and again", names(cur) === "Home,Documents,Pictures,Videos,C:,D:", names(cur));

    store.move("docs", 1, cur);
    cur = store.resolve(discovered());
    ok("and back down", names(cur) === "Home,Pictures,Documents,Videos,C:,D:", names(cur));

    const before = names(cur);
    store.move("home", -1, cur);
    ok("moving the top row up does nothing", names(store.resolve(discovered())) === before);
    store.move("d", 1, cur);
    ok("moving the last drive down does nothing", names(store.resolve(discovered())) === before);
    store.move("ghost", -1, cur);
    ok("moving something that is not there does nothing",
      names(store.resolve(discovered())) === before);
    store.move("docs", 0, cur);
    ok("a move of nowhere does nothing", names(store.resolve(discovered())) === before);

    // The constraint. `Videos` is last among the folders; one more step down
    // must not take it under the This PC heading.
    cur = store.resolve(discovered());
    store.move("vids", 1, cur);
    cur = store.resolve(discovered());
    ok("a folder cannot be moved below the drives", names(cur) === before, names(cur));
    ok("…and the drives are still last",
      cur.findIndex((p) => p.icon === "drive") === cur.length - 2);

    store.move("d", -1, cur);
    cur = store.resolve(discovered());
    ok("drives reorder among themselves", names(cur).endsWith("D:,C:"), names(cur));
    store.move("c", -1, cur);
    cur = store.resolve(discovered());
    ok("…and a drive cannot climb above the folders", names(cur).endsWith("C:,D:"), names(cur));
    ok("…nor out of This PC", cur[0]?.icon === "home");
  }

  // ── 7 — the disk changing underneath a saved order ────────────────────────
  //
  // This is the block the file exists for. Everything here is the machine's list
  // moving while the preference file stays still.
  {
    const { store } = fresh();
    let cur = store.resolve(discovered());
    store.move("docs", -2, cur);
    ok("(setup) Documents is second", names(store.resolve(discovered())).startsWith("Home,Documents"));

    // A stick appears. It was never ordered, so it takes its arrival position —
    // after everything that was, and among the drives.
    const withStick = [
      ...discovered(),
      { id: "e", name: "E:", icon: "drive", path: "E:/", pinned: false },
    ];
    cur = store.resolve(withStick);
    ok("a newly mounted drive shows up", cur.some((p) => p.id === "e"));
    ok("…at the bottom, with the drives", cur[cur.length - 1]?.id === "e");
    ok("…without disturbing the order you set",
      names(cur).startsWith("Home,Documents,Pictures,Videos"), names(cur));

    // It is pulled out again. The saved order still mentions it.
    cur = store.resolve(discovered());
    ok("unplugging it takes it off the sidebar", !cur.some((p) => p.id === "e"));
    ok("…and leaves the rest as it was",
      names(cur) === "Home,Documents,Pictures,Videos,C:,D:", names(cur));

    // A folder the machine no longer reports at all — a profile renamed, a
    // network share gone. The order must not stall on the gap.
    const thin: Place[] = [
      { id: "home", name: "Home", icon: "home", path: "C:/Users/me", pinned: false },
      { id: "c", name: "C:", icon: "drive", path: "C:/", pinned: false },
    ];
    ok("a much shorter list still resolves", names(store.resolve(thin)) === "Home,C:");

    // And the whole thing coming back.
    ok("…and the full list comes back exactly as it was",
      names(store.resolve(discovered())) === "Home,Documents,Pictures,Videos,C:,D:");

    // A pin whose folder is gone stays a row: the store cannot tell "deleted"
    // from "the drive is not plugged in", and silently dropping it would lose a
    // pin every time a USB disk was unmounted.
    store.pin("E:/Archive");
    ok("a pin on a folder the machine cannot see is still listed",
      store.resolve(discovered()).some((p) => p.name === "Archive"));
  }

  // ── 8 — what survives being written and read back ─────────────────────────
  {
    const { store, back } = fresh();
    store.pin("C:/Work/Renders", "Output");
    store.remove("vids");
    store.rename("pics", "Photos");
    store.move("docs", -1, store.resolve(discovered()));
    const first = names(store.resolve(discovered()));

    const again = new PlacesStore(memoryPlaces(back.read()));
    ok("everything comes back after a reload",
      names(again.resolve(discovered())) === first, `${first} vs ${names(again.resolve(discovered()))}`);
    ok("…including the hidden list", again.hiddenIds().includes("vids"));
    ok("…and it still says it has been touched", again.touched() === true);

    store.reset();
    ok("reset goes back to the machine's list",
      names(store.resolve(discovered())) === "Home,Pictures,Videos,Documents,C:,D:");
    ok("…and says so", store.touched() === false);
    ok("…and the reset is written, not just in memory",
      names(new PlacesStore(memoryPlaces(back.read())).resolve(discovered())) ===
        "Home,Pictures,Videos,Documents,C:,D:");
  }

  // ── 9 — a preference file is data from disk, and may be anything ──────────
  //
  // Same rule as `rules.ts`: nothing in here may throw. A hand-edited or
  // half-written file must cost you your pins, not your file explorer.
  {
    const junk = [
      "",
      "   ",
      "null",
      "[]",
      "42",
      '"a string"',
      "{",
      "{}",
      '{"version":99,"pinned":[]}',
      '{"version":1}',
      '{"version":1,"pinned":null,"hidden":null,"order":null,"named":null}',
      '{"version":1,"pinned":"not an array","hidden":7,"order":{},"named":[]}',
      '{"version":1,"pinned":[null,3,"x",{}],"hidden":[null,1,""],"order":[null,""],"named":{"a":null,"b":"  "}}',
      '{"version":1,"pinned":[{"path":"C:/Ok"}]}',
      '{"version":1,"pinned":[{"id":"","name":"","path":"C:/Ok","icon":""}]}',
    ];
    let threw = "";
    for (const text of junk) {
      try {
        const s = new PlacesStore(memoryPlaces(text));
        s.resolve(discovered());
        s.hiddenIds();
        s.touched();
        s.pin("C:/After");
        s.move("home", 1, s.resolve(discovered()));
        s.rename("home", "x");
        s.remove("home");
        s.reset();
      } catch (err) {
        threw = `${text} → ${String(err)}`;
      }
      ok(`garbage survives: ${text.slice(0, 34) || "(empty)"}`, threw === "", threw);
    }

    // Salvage, where salvage is possible.
    const saved = new PlacesStore(memoryPlaces('{"version":1,"pinned":[{"path":"C:/Ok"}]}'));
    const got = saved.resolve(discovered());
    ok("a pin with only a path is repaired rather than dropped",
      got.some((p) => p.path === "C:/Ok" && p.name === "Ok"));
    ok("…and gets a real id", got.find((p) => p.path === "C:/Ok")?.id === idFor("C:/Ok"));
    ok("…and an icon, so it draws something",
      (got.find((p) => p.path === "C:/Ok")?.icon ?? "") !== "");

    // But a pin with no path is a button that goes nowhere. There is nothing to
    // repair it into, so it goes.
    const dead = new PlacesStore(memoryPlaces('{"version":1,"pinned":[{"id":"user:x","name":"Ghost"}]}'));
    ok("a pin with no path is dropped, not turned into a dead row",
      !dead.resolve(discovered()).some((p) => p.name === "Ghost"));

    // A file from a future build.
    const future = new PlacesStore(memoryPlaces('{"version":2,"pinned":[{"path":"C:/X","name":"X"}]}'));
    ok("a file from a newer version is ignored rather than half-read",
      names(future.resolve(discovered())) === "Home,Pictures,Videos,Documents,C:,D:");

    // A backend that throws on both ends — the state a locked-down browser puts
    // localStorage into. The sidebar still works, it just cannot remember.
    const hostile: PlacesBackend = {
      read: () => { throw new Error("denied"); },
      write: () => { throw new Error("denied"); },
    };
    let survived = true;
    try {
      const s = new PlacesStore(hostile);
      s.pin("C:/Work");
      ok("a store with no storage still shows the pin for this run",
        s.resolve(discovered()).some((p) => p.name === "Work"));
    } catch {
      survived = false;
    }
    ok("a backend that throws does not take the sidebar with it", survived);
  }

  // ── 10 — the cap ──────────────────────────────────────────────────────────
  {
    const { store } = fresh();
    for (let i = 0; i < 140; i++) store.pin(`C:/P${i}`);
    const got = store.resolve(discovered());
    const mine = got.filter((p) => p.pinned);
    ok("pins are capped", mine.length === 100, String(mine.length));
    ok("…and it is the oldest that goes, not the newest that is refused",
      mine.some((p) => p.name === "P139") && !mine.some((p) => p.name === "P0"));
  }

  // ── 11 — the panel ────────────────────────────────────────────────────────
  {
    const store = new PlacesStore(memoryPlaces());
    let current = store.resolve(discovered());
    let flashes = 0;
    const redraw = (): void => {
      current = store.resolve(discovered());
      flashes++;
    };
    let where = "C:/Users/me/Downloads";

    const panel = new PlacesPanel();
    ok("the panel starts closed", panel.isOpen === false);
    ok("…and closed means off the screen, not merely marked hidden",
      gone(panel.element));

    panel.open({
      current: () => current,
      hidden: () => {
        const out = new Set(store.hiddenIds());
        return discovered().filter((p) => out.has(p.id));
      },
      cwd: () => where,
      has: (path) => store.has(path, current),
      pin: (path) => { store.pin(path); redraw(); },
      remove: (id) => { store.remove(id); redraw(); },
      restore: (id) => { store.restore(id); redraw(); },
      rename: (id, name) => { store.rename(id, name); redraw(); },
      move: (id, delta) => { store.move(id, delta, current); redraw(); },
      reset: () => { store.reset(); redraw(); },
    });

    const rows = (): HTMLElement[] => [...panel.element.querySelectorAll<HTMLElement>(".plcs-list .plcs-row")];
    const labels = (): string =>
      rows().map((r) => r.querySelector<HTMLInputElement>(".plcs-name")?.value ?? "").join(",");
    const click = (el: Element | null | undefined): void => {
      (el as HTMLElement | undefined)?.click();
    };

    ok("open means visible", panel.isOpen === true && !gone(panel.element));
    ok("every place is a row", rows().length === 6, String(rows().length));
    ok("…in the order the sidebar has them",
      labels() === "Home,Pictures,Videos,Documents,C:,D:", labels());
    ok("the drives are under their own heading", (() => {
      const heads = [...panel.element.querySelectorAll(".plcs-list .plcs-group")];
      return heads.length === 1 && heads[0]?.textContent === "This PC";
    })());
    ok("there is nothing in the hidden section yet",
      gone(panel.element.querySelector(".plcs-hidden-wrap")));

    // The add button reads the folder you are in.
    const add = panel.element.querySelector<HTMLButtonElement>(".plcs-add")!;
    ok("the add button names the folder you are in", add.textContent?.includes("Downloads") === true);
    ok("…and is live", add.disabled === false);
    click(add);
    ok("pressing it pins that folder", labels().includes("Downloads"), labels());
    ok("…and the panel redrew itself", flashes === 1);
    ok("…and the button now says it is already there",
      panel.element.querySelector<HTMLButtonElement>(".plcs-add")?.disabled === true);
    ok("…and says which folder that is",
      panel.element.querySelector(".plcs-add")?.textContent?.includes("Downloads") === true);

    where = "C:/Users/me/Pictures";
    panel.sync();
    ok("a discovered folder also counts as already there",
      panel.element.querySelector<HTMLButtonElement>(".plcs-add")?.disabled === true);
    where = "C:/Work";
    panel.sync();
    ok("…and a folder that is not counts as not",
      panel.element.querySelector<HTMLButtonElement>(".plcs-add")?.disabled === false);

    // Moving.
    const rowFor = (name: string): HTMLElement | undefined =>
      rows().find((r) => r.querySelector<HTMLInputElement>(".plcs-name")?.value === name);
    click(rowFor("Documents")?.querySelectorAll(".plcs-move")[0]);
    ok("▲ moves a row up", labels().startsWith("Home,Pictures,Documents,Videos"), labels());
    click(rowFor("Documents")?.querySelectorAll(".plcs-move")[1]);
    ok("▼ moves it back", labels().startsWith("Home,Pictures,Videos,Documents"), labels());

    const first = rows()[0]!;
    ok("the top row's ▲ is disabled rather than missing",
      (first.querySelectorAll(".plcs-move")[0] as HTMLButtonElement).disabled === true);
    ok("…and it is still on the screen, so the column does not shift",
      !gone(first.querySelectorAll(".plcs-move")[0]!));
    const lastFolder = rowFor("Downloads") ?? rows()[3]!;
    ok("the last folder's ▼ is disabled, because the drives are not below it",
      (lastFolder.querySelectorAll(".plcs-move")[1] as HTMLButtonElement).disabled === true);

    // Renaming.
    const pics = rowFor("Pictures")!.querySelector<HTMLInputElement>(".plcs-name")!;
    pics.value = "Photos";
    pics.dispatchEvent(new Event("change", { bubbles: true }));
    ok("typing a new name and leaving the field renames it", labels().includes("Photos"), labels());
    ok("…in the store, not just on the screen",
      store.resolve(discovered()).some((p) => p.name === "Photos"));
    const photos = rowFor("Photos")!.querySelector<HTMLInputElement>(".plcs-name")!;
    photos.value = "";
    photos.dispatchEvent(new Event("change", { bubbles: true }));
    ok("clearing it puts the original back", labels().includes("Pictures"), labels());

    // Keys typed into a name must not reach the shell. The panel sits over a
    // file explorer where every letter is a shortcut.
    let escaped = 0;
    const spy = (): void => { escaped++; };
    document.addEventListener("keydown", spy);
    const box = rowFor("Pictures")!.querySelector<HTMLInputElement>(".plcs-name")!;
    for (const k of ["a", "n", "Delete", "F2"]) {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    }
    document.removeEventListener("keydown", spy);
    ok("typing a name does not fire the shell's shortcuts", escaped === 0, String(escaped));

    // Removing, and the hidden section.
    click(rowFor("Videos")?.querySelector(".plcs-drop"));
    ok("✕ takes a row out", !labels().includes("Videos"), labels());
    ok("…and it turns up under Hidden",
      !gone(panel.element.querySelector(".plcs-hidden-wrap")));
    ok("…by name, so you can tell which one it was",
      panel.element.querySelector(".plcs-hidden .plcs-gone")?.textContent === "Videos");
    click(panel.element.querySelector(".plcs-put"));
    ok("Put back puts it back", labels().includes("Videos"), labels());
    ok("…and the Hidden section goes away again",
      gone(panel.element.querySelector(".plcs-hidden-wrap")));

    // A pin removed is gone, not hidden — there is nothing to put back.
    click(rowFor("Downloads")?.querySelector(".plcs-drop"));
    ok("removing your own pin does not file it under Hidden",
      gone(panel.element.querySelector(".plcs-hidden-wrap")));

    // Reset.
    click(panel.element.querySelector(".plcs-reset"));
    ok("Put it back restores the machine's list",
      labels() === "Home,Pictures,Videos,Documents,C:,D:", labels());
    ok("…and the store agrees", store.touched() === false);

    // Closing.
    panel.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    ok("Escape closes it", panel.isOpen === false && gone(panel.element));
    click(panel.element.querySelector(".plcs-x"));
    ok("closing a closed panel is quiet", panel.isOpen === false);

    panel.close();
    panel.element.remove();
  }

  const line = `place: ${pass} passed, ${fail} failed`;
  console.log(`%c${line}`, `color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`);
  const banner = document.createElement("h2");
  banner.textContent = line;
  banner.style.cssText = `font:600 18px system-ui;color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`;
  document.body.prepend(banner);
}

void main();
