/**
 * Checks the folder tree (the sidebar half of item 38).
 *
 * A tree over a real disk is mostly a set of promises about what it will *not*
 * do: it will not read a folder nobody opened, it will not fall over on the
 * first permission error, it will not go stale when you navigate some other
 * way. None of those are visible by looking at it — a tree that eagerly reads
 * `C:\` looks identical to one that does not, right up until it is pointed at a
 * real drive and hangs. So they are counted here: the fake filesystem records
 * every listing it is asked for, and the assertions are as much about that
 * count as about the rows.
 *
 * Dev-only. Loaded by /treecheck.html, which is not a build input.
 *
 *   http://localhost:8183/treecheck.html
 */

import "../styles/base.css";
import "../styles/tree.css";

import type { DirListing, FileEntry, Place } from "@core/explorer/types";
import { TreePanel, isInside, same } from "@ui/tree";

let pass = 0;
let fail = 0;

const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { pass++; console.log("ok  ", name); }
  else { fail++; console.log("FAIL", name, " ", detail); }
};

const tick = (n = 0): Promise<void> => new Promise((r) => setTimeout(r, n));

function fakeStore(): Pick<Storage, "getItem" | "setItem"> & { raw(): string | null } {
  let value: string | null = null;
  return {
    getItem: () => value,
    setItem: (_k: string, v: string) => { value = v; },
    raw: () => value,
  };
}

function entry(path: string, name: string, kind: FileEntry["kind"], hidden = false): FileEntry {
  return {
    path,
    name,
    kind,
    size: 0,
    modified: 0,
    ...(hidden ? { hidden: true } : {}),
  } as FileEntry;
}

/**
 * A disk with a permission wall in it, because every real one has several and
 * the interesting question is what the sidebar does when it hits one.
 */
function fakeFs(): {
  list(path: string): Promise<DirListing>;
  reads: string[];
} {
  const tree: Record<string, FileEntry[]> = {
    "C:/Users/me": [
      entry("C:/Users/me/Pictures", "Pictures", "folder"),
      entry("C:/Users/me/Documents", "Documents", "folder"),
      entry("C:/Users/me/.cache", ".cache", "folder", true),
      entry("C:/Users/me/notes.txt", "notes.txt", "document"),
    ],
    "C:/Users/me/Pictures": [
      entry("C:/Users/me/Pictures/Trip 10", "Trip 10", "folder"),
      entry("C:/Users/me/Pictures/Trip 2", "Trip 2", "folder"),
      entry("C:/Users/me/Pictures/shot.jpg", "shot.jpg", "image"),
    ],
    "C:/Users/me/Pictures/Trip 2": [
      entry("C:/Users/me/Pictures/Trip 2/raw", "raw", "folder"),
    ],
    "C:/Users/me/Pictures/Trip 2/raw": [],
    "C:/Users/me/Pictures/Trip 10": [],
    "C:/Users/me/Documents": [],
    "C:/": [
      entry("C:/Users", "Users", "folder"),
      entry("C:/System Volume Information", "System Volume Information", "folder"),
    ],
    "C:/Users": [entry("C:/Users/me", "me", "folder")],
  };
  const reads: string[] = [];
  return {
    reads,
    async list(path: string): Promise<DirListing> {
      reads.push(path);
      if (path === "C:/System Volume Information") {
        throw new Error("Access is denied. (os error 5)");
      }
      const entries = tree[path];
      if (!entries) throw new Error(`no such folder: ${path}`);
      return { path, entries };
    },
  };
}

const PLACES: Place[] = [
  { id: "home", name: "Home", icon: "home", path: "C:/Users/me", pinned: true },
  { id: "pics", name: "Pictures", icon: "image", path: "C:/Users/me/Pictures", pinned: true },
  { id: "smart", name: "Recent", icon: "clock", pinned: true },
  { id: "drive-c", name: "C:", icon: "drive", path: "C:/", pinned: true },
];

function mount(): {
  panel: TreePanel;
  fs: ReturnType<typeof fakeFs>;
  store: ReturnType<typeof fakeStore>;
  opened: string[];
} {
  const fs = fakeFs();
  const store = fakeStore();
  const opened: string[] = [];
  const panel = new TreePanel(
    {
      list: (p) => fs.list(p),
      open: (p) => { opened.push(p); },
      places: () => PLACES,
    },
    store,
  );
  document.body.replaceChildren(panel.root);
  return { panel, fs, store, opened };
}

const rows = (panel: TreePanel): HTMLElement[] =>
  [...panel.root.querySelectorAll<HTMLElement>(".tree-name")];

const labels = (panel: TreePanel): string[] =>
  rows(panel).map((r) => r.querySelector(".tree-label")?.textContent ?? "");

const rowFor = (panel: TreePanel, path: string): HTMLElement | undefined =>
  rows(panel).find((r) => r.dataset["path"] === path);

const twistFor = (panel: TreePanel, path: string): HTMLButtonElement | null =>
  rowFor(panel, path)?.parentElement?.querySelector<HTMLButtonElement>(".tree-twist") ?? null;

async function run(): Promise<void> {
  // ── Path arithmetic ─────────────────────────────────────────────────────
  //
  // Everything the tree does hangs off these two functions, and both have a
  // trap in them: a separator that comes back the wrong way from one API and
  // the right way from another, and a sibling whose name starts with the same
  // letters as its neighbour.
  ok("a backslash and a slash are the same path", same("C:\\Users\\x", "C:/Users/x"));
  ok("case does not matter on Windows", same("C:/USERS/X", "c:/users/x"));
  ok("a trailing slash does not matter", same("C:/Users/x/", "C:/Users/x"));
  ok("a folder is inside its parent", isInside("C:/Users/x/Pictures", "C:/Users/x"));
  ok("a folder is inside its grandparent", isInside("C:/Users/x/Pictures/Trip", "C:/Users"));
  ok("a folder is not inside itself", !isInside("C:/Users/x", "C:/Users/x"));
  // The one that bites: a plain startsWith would call these nested.
  ok("a sibling that shares a prefix is not inside",
    !isInside("C:/Users/me2", "C:/Users/me"));
  ok("the drive root contains everything", isInside("C:/Users", "C:/"));

  // ── First paint ─────────────────────────────────────────────────────────
  {
    const { panel, fs } = mount();
    await panel.build();
    ok("every place gets a row", labels(panel).join(",") === "Home,Pictures,C:",
      labels(panel).join(","));
    // A smart place has no path; putting it in the tree would give a row that
    // cannot be expanded and cannot be listed.
    ok("smart places are left out", !labels(panel).includes("Recent"));
    // The whole design in one assertion: hundreds of thousands of folders sit
    // under C:\ and not one of them has been touched.
    ok("nothing is read until something is opened", fs.reads.length === 0,
      fs.reads.join(","));
    ok("nothing starts expanded",
      rows(panel).every((r) => r.getAttribute("aria-expanded") === "false"));
    ok("drives are under a heading of their own",
      panel.root.querySelector(".tree-group")?.textContent === "This PC");
    // Not a cosmetic check. U+1F5C0 has no glyph in Segoe UI, so the first
    // version of this rendered a column of tofu boxes on this very machine.
    ok("icons are drawn, not typed",
      panel.root.querySelectorAll(".tree-icon svg path").length === rows(panel).length);
  }

  // ── Opening ─────────────────────────────────────────────────────────────
  {
    const { panel, fs, opened } = mount();
    await panel.build();

    twistFor(panel, "C:/Users/me")?.click();
    await tick();
    ok("the arrow reads one folder", fs.reads.length === 1, fs.reads.join(","));
    // The distinction the whole tree turns on: the arrow looks, the name goes.
    ok("the arrow does not navigate", opened.length === 0, opened.join(","));
    ok("children appear", labels(panel).includes("Documents"));
    ok("files stay out of the tree", !labels(panel).includes("notes.txt"));
    ok("hidden folders stay out", !labels(panel).includes(".cache"));
    ok("names sort naturally, not by ASCII",
      labels(panel).indexOf("Documents") < labels(panel).indexOf("Pictures"));

    rowFor(panel, "C:/Users/me/Documents")?.click();
    await tick();
    ok("the name navigates", opened.at(-1) === "C:/Users/me/Documents", opened.join(","));
    ok("and marks itself current",
      rowFor(panel, "C:/Users/me/Documents")?.parentElement?.getAttribute("aria-current")
        === "true");
    // Explorer drops the arrow once it knows there is nothing behind it; a
    // chevron that opens onto nothing is a small lie told on every row.
    ok("a folder with no folders inside loses its arrow",
      twistFor(panel, "C:/Users/me/Documents")?.textContent === "");

    const before = fs.reads.length;
    twistFor(panel, "C:/Users/me")?.click();
    await tick();
    twistFor(panel, "C:/Users/me")?.click();
    await tick();
    ok("closing and reopening does not re-read the disk", fs.reads.length === before,
      fs.reads.slice(before).join(","));
  }

  // ── Reveal ──────────────────────────────────────────────────────────────
  {
    const { panel, fs } = mount();
    await panel.build();
    await panel.reveal("C:/Users/me/Pictures/Trip 2/raw");
    ok("reveal opens every level down to the folder",
      labels(panel).includes("Trip 2") && labels(panel).includes("raw"),
      labels(panel).join(","));
    ok("and highlights the one you are in",
      rowFor(panel, "C:/Users/me/Pictures/Trip 2/raw")
        ?.parentElement?.getAttribute("aria-current") === "true");
    // Two roots contain this path — Home and Pictures. Starting from the
    // longest match is what keeps the walk from re-listing the whole profile.
    ok("it starts from the closest root, not the first one",
      !fs.reads.includes("C:/Users/me"), fs.reads.join(","));

    // A path off the side of the map is not an error: a network share the user
    // typed into the address bar is exactly this, and the tree should simply
    // have nothing to highlight.
    await panel.reveal("\\\\nas\\media");
    ok("a path under no root just clears the highlight",
      panel.root.querySelector('[aria-current="true"]') === null);
    ok("and the tree is still standing", labels(panel).length > 0);

    // The reveal walk normalises as it goes, so the separator Windows hands
    // back does not have to match the one the places were built with.
    await panel.reveal("C:\\Users\\me\\Pictures");
    ok("reveal accepts backslashes",
      rowFor(panel, "C:/Users/me/Pictures")
        ?.parentElement?.getAttribute("aria-current") === "true");
  }

  // ── Folders that refuse ─────────────────────────────────────────────────
  {
    const { panel } = mount();
    await panel.build();
    twistFor(panel, "C:/")?.click();
    await tick();
    twistFor(panel, "C:/System Volume Information")?.click();
    await tick(1);
    const row = rowFor(panel, "C:/System Volume Information")?.parentElement;
    ok("an unreadable folder says so on its own row", row?.dataset["error"] === "1");
    ok("with the reason on the tooltip",
      (rowFor(panel, "C:/System Volume Information")?.title ?? "").includes("Access is denied"));
    // The point of catching it: one denied folder must not take the sidebar
    // with it, and Windows has several of these on every disk.
    ok("the rest of the tree carries on", labels(panel).includes("Users"));
    ok("and it can still be navigated past",
      rowFor(panel, "C:/Users") !== undefined);
  }

  // ── Refresh ─────────────────────────────────────────────────────────────
  {
    const { panel, fs } = mount();
    await panel.build();
    await panel.reveal("C:/Users/me/Pictures/Trip 2");
    const before = fs.reads.length;
    await panel.refresh();
    ok("refresh re-reads the disk", fs.reads.length > before);
    // A refresh that collapsed everything would be indistinguishable from a
    // crash to anyone three folders deep.
    ok("and leaves open what was open", labels(panel).includes("Trip 2"),
      labels(panel).join(","));
  }

  // ── Size and collapse ───────────────────────────────────────────────────
  {
    const { panel, store } = mount();
    await panel.build();
    ok("the pane starts visible", panel.visible);
    ok("and owns the layout width",
      document.documentElement.style.getPropertyValue("--fct-tree-w") === "240px",
      document.documentElement.style.getPropertyValue("--fct-tree-w"));

    panel.toggle();
    ok("collapsing hides it", !panel.visible && panel.root.hidden);
    // Zero rather than "hidden" so the grid gives the column's space back
    // instead of leaving a gap where the tree used to be.
    ok("and gives the column back",
      document.documentElement.style.getPropertyValue("--fct-tree-w") === "0px");
    ok("the state is written down", (store.raw() ?? "").includes('"collapsed":true'),
      String(store.raw()));

    panel.toggle();
    ok("and toggles back", panel.visible && !panel.root.hidden);

    const saved = fakeStore();
    saved.setItem("facet.tree.v1", JSON.stringify({ width: 9999, collapsed: true }));
    const restored = new TreePanel(
      { list: async () => ({ path: "", entries: [] }), open: () => {}, places: () => [] },
      saved,
    );
    ok("a saved collapse is restored", !restored.visible);
    // Someone else's monitor, a corrupt file, a bad migration: a width from
    // outside the rail must not be able to push the files off the screen.
    ok("an absurd saved width is clamped",
      document.documentElement.style.getPropertyValue("--fct-tree-w") === "0px");
    restored.toggle();
    ok("to the maximum, not to the file",
      document.documentElement.style.getPropertyValue("--fct-tree-w") === "480px",
      document.documentElement.style.getPropertyValue("--fct-tree-w"));

    const corrupt = fakeStore();
    corrupt.setItem("facet.tree.v1", "{not json");
    const fresh = new TreePanel(
      { list: async () => ({ path: "", entries: [] }), open: () => {}, places: () => [] },
      corrupt,
    );
    ok("corrupt settings fall back to the default, not to a blank app", fresh.visible);
  }

  // ── Keyboard ────────────────────────────────────────────────────────────
  {
    const { panel } = mount();
    await panel.build();
    const home = rowFor(panel, "C:/Users/me");
    home?.focus();
    home?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await tick(1);
    ok("Right opens a folder", labels(panel).includes("Pictures"));
    // The re-render throws the DOM away; without carrying focus across it the
    // next arrow key would go to the document and nothing would move.
    ok("and focus survives the re-render",
      (document.activeElement as HTMLElement | null)?.dataset["path"] === "C:/Users/me",
      (document.activeElement as HTMLElement | null)?.dataset["path"] ?? "none");

    document.activeElement instanceof HTMLElement &&
      document.activeElement.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    ok("Down steps to the next row",
      (document.activeElement as HTMLElement | null)?.dataset["path"]
        === "C:/Users/me/Documents",
      (document.activeElement as HTMLElement | null)?.dataset["path"] ?? "none");

    rowFor(panel, "C:/Users/me")?.focus();
    document.activeElement instanceof HTMLElement &&
      document.activeElement.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
    await tick(1);
    ok("Left closes it again", !labels(panel).includes("Pictures") ||
      labels(panel).filter((l) => l === "Pictures").length === 1,
      labels(panel).join(","));
  }

  console.log(`tree: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);

  const out = document.createElement("pre");
  out.style.cssText = "position:fixed;right:12px;top:12px;font:13px monospace;color:#e8ecf5";
  out.textContent = `tree: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`;
  document.body.appendChild(out);
}

void run().catch((e: unknown) => {
  console.error(`tree harness threw: ${String(e)}`);
});
