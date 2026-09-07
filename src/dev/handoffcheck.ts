/**
 * "Open with FACET" — the path from another app's intent to an open file.
 *
 * Until this landed FACET was absent from every Open-with list on the phone:
 * the manifest declared no VIEW filter, so the one app on the device that can
 * render a `.dng`, a `.jxl`, a `.srt` or an extensionless blob was the one app
 * you could not choose to open them with. The filters are only half of it,
 * though — an intent arrives as a `content://` URI and the whole of FACET below
 * the frontend takes absolute paths, so `OpenBridge.kt` resolves one to the
 * other and `openwith.rs` drains the queue.
 *
 * What is checked here is the last stretch, which is the part with judgement in
 * it: `@core/phone/handoff` deciding *what to open and what to swipe*.
 *
 *  - One file opens its whole folder, because a viewer you cannot swipe out of
 *    is a dead end — that is the whole reason a gallery is a gallery.
 *  - A shared selection is its own sibling set. Listing the first file's folder
 *    would silently drop the other eleven photos the user picked.
 *  - A file the listing cannot see still opens. A mail attachment lives in the
 *    app's own cache; refusing to show it because its neighbours could not be
 *    counted would fail the exact case the copy-in fallback exists for.
 *  - Nothing that is not a path gets through. An empty string resolves to the
 *    current directory, and "open the whole volume" is not what a tap meant.
 *
 * Dev-only. Loaded by /dev/handoffcheck.html, which is not one of the build's
 * inputs.
 */

import "../styles/base.css";

import {
  baseOf,
  cleanPaths,
  dirOf,
  entryFromPath,
  normPath,
  resolveHandoff,
  type ListDir,
} from "@core/phone/handoff";
import type { FileEntry } from "@core/explorer/types";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}   ${detail}`); }
};

/** A listing built from paths, shaped the way `TauriFs.list` returns one. */
function fakeFs(tree: Record<string, string[]>): { list: ListDir; calls: string[] } {
  const calls: string[] = [];
  const list: ListDir = async (dir) => {
    calls.push(dir);
    const names = tree[dir];
    if (names === undefined) throw new Error(`no such directory: ${dir}`);
    return {
      entries: names.map((n) => {
        const e = entryFromPath(`${dir}/${n}`);
        return { ...e, size: 1234, modified: 1_700_000_000_000 } as FileEntry;
      }),
    };
  };
  return { list, calls };
}

const DCIM = "/storage/emulated/0/DCIM/Camera";
const DOWN = "/storage/emulated/0/Download";

async function main(): Promise<void> {
  // ---------------------------------------------------------------- paths --
  {
    ok("a path is normalised to forward slashes",
      normPath("C:\\Users\\x\\a.png") === "C:/Users/x/a.png", normPath("C:\\Users\\x\\a.png"));
    ok("doubled separators collapse",
      normPath("/storage//emulated///0/a.png") === "/storage/emulated/0/a.png");
    ok("a trailing slash is dropped", normPath("/a/b/") === "/a/b");
    ok("but the root itself survives", normPath("/") === "/");

    ok("the folder of a file is its folder", dirOf(`${DCIM}/a.jpg`) === DCIM, dirOf(`${DCIM}/a.jpg`));
    ok("a file at the root has the root as its folder", dirOf("/a.jpg") === "/");
    ok("a bare name has no folder", dirOf("a.jpg") === "");
    ok("the name of a file is its last segment", baseOf(`${DCIM}/a b.jpg`) === "a b.jpg");

    ok("blanks and duplicates are dropped, order kept",
      JSON.stringify(cleanPaths(["/b.png", "", "  ", "/a.png", "/b.png", "/b.png/"]))
        === JSON.stringify(["/b.png", "/a.png"]),
      JSON.stringify(cleanPaths(["/b.png", "", "  ", "/a.png", "/b.png", "/b.png/"])));
    ok("and so is the root, which is not a file to open",
      cleanPaths(["/", "//"]).length === 0, JSON.stringify(cleanPaths(["/", "//"])));
  }

  // ------------------------------------------------------ a path with no fs --
  {
    const e = entryFromPath(`${DCIM}/holiday.HEIC`);
    ok("a synthesised entry keeps the path", e.path === `${DCIM}/holiday.HEIC`);
    ok("and takes its name from the last segment", e.name === "holiday.HEIC");
    ok("and lowercases the extension", e.ext === "heic", e.ext);
    ok("and works the kind out from it", e.kind === "image", e.kind);
    ok("and promises no size it does not have", e.size === undefined);
  }

  // --------------------------------------------------------- nothing to do --
  {
    const { list, calls } = fakeFs({});
    ok("an empty hand-off is null", (await resolveHandoff([], list)) === null);
    ok("so is one made entirely of rubbish",
      (await resolveHandoff(["", "   ", "/"], list)) === null);
    ok("and neither one touched the filesystem", calls.length === 0, String(calls.length));
  }

  // ------------------------------------------------------ one file, one album --
  {
    const { list, calls } = fakeFs({
      [DCIM]: ["a.jpg", "b.jpg", "c.jpg", "clip.mp4"],
    });
    const got = await resolveHandoff([`${DCIM}/b.jpg`], list);
    ok("a single file resolves", got !== null);
    ok("to the file that was actually tapped", got?.entry.path === `${DCIM}/b.jpg`, got?.entry.path);
    ok("resolved against the real listing, so it has a size",
      got?.entry.size === 1234, String(got?.entry.size));
    ok("and it can be swiped through the whole folder",
      got?.siblings.length === 4, String(got?.siblings.length));
    ok("which took exactly one listing",
      calls.length === 1 && calls[0] === DCIM, JSON.stringify(calls));
  }

  // ------------------------------------------- one file the listing cannot see --
  {
    // The copy-in case: a mail attachment lives under the app's own cache,
    // where a directory listing has no business succeeding.
    const cache = "/data/user/0/com.iraslabs.facet/cache/opened";
    const { list } = fakeFs({});
    const got = await resolveHandoff([`${cache}/invoice.pdf`], list);
    ok("a file in an unlistable folder still opens", got?.entry.path === `${cache}/invoice.pdf`,
      String(got?.entry.path));
    ok("as a document", got?.entry.kind === "document", String(got?.entry.kind));
    ok("with no siblings, rather than not at all", got?.siblings.length === 0);
  }

  // ------------------------------------------ one file that vanished in transit --
  {
    const { list } = fakeFs({ [DCIM]: ["a.jpg", "c.jpg"] });
    const got = await resolveHandoff([`${DCIM}/b.jpg`], list);
    ok("a file no longer in its folder still opens", got?.entry.path === `${DCIM}/b.jpg`);
    ok("and does not pretend the neighbours are its siblings",
      got?.siblings.length === 0, String(got?.siblings.length));
  }

  // ------------------------------------------------------- a shared selection --
  {
    const { list, calls } = fakeFs({
      [DCIM]: ["a.jpg", "b.jpg", "c.jpg", "d.jpg"],
    });
    const picked = [`${DCIM}/c.jpg`, `${DCIM}/a.jpg`, `${DCIM}/d.jpg`];
    const got = await resolveHandoff(picked, list);
    ok("a selection opens the first thing shared", got?.entry.path === `${DCIM}/c.jpg`,
      String(got?.entry.path));
    ok("the selection is the sibling set, not the folder",
      got?.siblings.length === 3, String(got?.siblings.length));
    ok("in the order it was shared",
      JSON.stringify(got?.siblings.map((s) => s.name)) === JSON.stringify(["c.jpg", "a.jpg", "d.jpg"]),
      JSON.stringify(got?.siblings.map((s) => s.name)));
    ok("and every one of them was resolved for real",
      got?.siblings.every((s) => s.size === 1234) === true);
    ok("one listing served all three, since they share a folder",
      calls.length === 1, JSON.stringify(calls));
  }

  // ------------------------------------------ a selection spanning two folders --
  {
    const { list, calls } = fakeFs({
      [DCIM]: ["a.jpg"],
      [DOWN]: ["report.pdf"],
    });
    const got = await resolveHandoff([`${DOWN}/report.pdf`, `${DCIM}/a.jpg`], list);
    ok("a selection from two folders keeps both",
      got?.siblings.length === 2, String(got?.siblings.length));
    ok("each resolved against its own folder",
      got?.siblings.every((s) => s.size === 1234) === true,
      JSON.stringify(got?.siblings.map((s) => s.size)));
    ok("which took one listing per folder and no more",
      calls.length === 2, JSON.stringify(calls));
  }

  // ----------------------------------- a selection where one member is missing --
  {
    const { list } = fakeFs({ [DCIM]: ["a.jpg"] });
    const got = await resolveHandoff([`${DCIM}/a.jpg`, `${DCIM}/gone.jpg`], list);
    ok("a member the listing lacks is not silently dropped",
      got?.siblings.length === 2, String(got?.siblings.length));
    ok("it is carried as a path-only entry",
      got?.siblings[1]?.path === `${DCIM}/gone.jpg` && got?.siblings[1]?.size === undefined,
      JSON.stringify(got?.siblings[1]));
  }

  // ------------------------------------------- folders are never swipe targets --
  {
    // A listing contains directories; the viewer's sibling strip must not.
    const list: ListDir = async () => ({
      entries: [
        { path: `${DCIM}/sub`, name: "sub", kind: "folder", ext: "" },
        { path: `${DCIM}/a.jpg`, name: "a.jpg", kind: "image", ext: "jpg" },
      ] as FileEntry[],
    });
    const got = await resolveHandoff([`${DCIM}/a.jpg`], list);
    ok("a folder in the listing is not a sibling",
      got?.siblings.length === 1 && got?.siblings[0]?.name === "a.jpg",
      JSON.stringify(got?.siblings.map((s) => s.name)));
  }

  // ------------------------------------------------ a path in the wrong dialect --
  {
    // Another app can hand over a path with a doubled separator in it; the
    // entry it names is still plainly the same file.
    const { list } = fakeFs({ [DCIM]: ["a.jpg"] });
    const got = await resolveHandoff([`${DCIM}//a.jpg`], list);
    ok("a doubled separator still matches its entry",
      got?.entry.size === 1234, JSON.stringify(got?.entry));
  }

  const line = `handoff: ${pass} passed, ${fail} failed`;
  console.log(`%c${line}`, `color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`);
  const banner = document.createElement("h2");
  banner.textContent = line;
  banner.style.cssText = `font:600 18px system-ui;color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`;
  document.body.prepend(banner);
  document.title = line;
}

void main().catch((e: unknown) => {
  const line = `handoff: ${pass} passed, ${fail + 1} FAILED — threw: ${String(e)}`;
  document.title = line;
  console.log(line);
  console.error(e);
});
