/**
 * Checks the field table, and the two views that read it (item 36).
 *
 * The claim this harness exists to defend is that there is **one** table. A
 * column in the details list and a fact under a card's name are the same field
 * asked of the same file, and the failure this prevents is the one every file
 * manager eventually has: a duration that shows in one view and not the other
 * for no reason anybody can explain. So the value functions are tested once and
 * both views are then tested to be reading them.
 *
 * The second theme is that a stored line of ids is *data from a file*. It gets
 * hand-edited, pasted between machines, and written by a build that had a field
 * this one has dropped. `parse` may never throw and may never hand back a
 * column list with no name in it — a file explorer that has stopped printing
 * file names is not a configuration anybody chose.
 *
 * Dev-only. Loaded by /dev/fieldcheck.html, which is not a build input.
 *
 *   http://localhost:8183/dev/fieldcheck.html
 */

import "../styles/base.css";
import "../styles/list.css";
import "../styles/fields.css";

import {
  DEFAULT_CARD,
  DEFAULT_COLUMNS,
  FIELDS,
  FIELD_IDS,
  field,
  kindLabel,
  parse,
  stringify,
  subtitle,
  template,
  when,
} from "@core/explorer/fields";
import type { FileEntry, ViewConfig } from "@core/explorer/types";
import { ALL_SETTINGS, PREF } from "@core/settings/registry";
import { FieldsPanel } from "@ui/fields-panel";
import { ListView } from "@ui/list-view";

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

const ids = (text: string): string => stringify(parse(text));

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Mid-January so the month name is short and the year is not this one. */
const OLD = new Date(2019, 0, 15, 14, 5).getTime();
const NOW = new Date(new Date().getFullYear(), 5, 2, 9, 7).getTime();

const video: FileEntry = {
  path: "C:\\Users\\me\\Videos\\trip.mp4",
  name: "trip.mp4",
  kind: "video",
  ext: "mp4",
  size: 48_234_496,
  modified: NOW,
  duration: 151,
  width: 1920,
  height: 1080,
};

const text: FileEntry = {
  path: "C:\\Users\\me\\notes.txt",
  name: "notes.txt",
  kind: "document",
  ext: "txt",
  size: 4096,
  modified: OLD,
};

const folder: FileEntry = {
  path: "C:\\Users\\me\\Pictures",
  name: "Pictures",
  kind: "folder",
  ext: "",
  modified: NOW,
};

const noExt: FileEntry = {
  path: "C:\\Users\\me\\LICENSE",
  name: "LICENSE",
  kind: "document",
  ext: "",
  size: 1024,
  modified: NOW,
};

/** A long clip, to prove the hour rolls over rather than reading "151:00". */
const long: FileEntry = { ...video, path: "C:\\a\\long.mkv", name: "long.mkv", duration: 3725 };

const cfg: ViewConfig = {
  sort: "name",
  ascending: true,
  group: "none",
  foldersFirst: true,
  showHidden: false,
  cardSize: 190,
  nameLines: 2,
  columns: DEFAULT_COLUMNS,
  cardFields: DEFAULT_CARD,
};

const value = (id: string, e: FileEntry): string => field(id)?.value(e) ?? "\u2205";

async function main(): Promise<void> {
  // ── 1 — the table itself ──────────────────────────────────────────────────
  {
    ok("field ids are unique", new Set(FIELD_IDS).size === FIELDS.length);
    ok("name is first, because a row that does not start with the name is not scannable",
      FIELDS[0]?.id === "name");
    ok("name is the flexible track", FIELDS[0]?.width === 0);
    ok("every other field has a real width",
      FIELDS.slice(1).every((f) => f.width > 0), FIELDS.map((f) => f.width).join(","));
    ok("every field has a label", FIELDS.every((f) => f.label.trim() !== ""));
    ok("the sortable fields name real sort keys",
      FIELDS.every((f) => f.sort === null || ["name", "size", "modified", "kind"].includes(f.sort)));
    ok("only numeric fields are right-aligned",
      FIELDS.filter((f) => f.align === "right").map((f) => f.id).join(",") ===
        "size,dimensions,duration");
    ok("field() finds by id and misses cleanly",
      field("size")?.label === "Size" && field("nope") === undefined);
  }

  // ── 2 — what a field says about a file ────────────────────────────────────
  {
    ok("a folder is a Folder", kindLabel(folder) === "Folder");
    ok("a file is named by what opens it", kindLabel(video) === "MP4");
    ok("an extensionless file is a File", kindLabel(noExt) === "File");

    ok("size prints for a file", value("size", text) !== "");
    // The alternative is printing 0, which is a lie told cheaply — a folder's
    // real size costs a walk of the whole subtree.
    ok("a folder has no size rather than a size of zero", value("size", folder) === "");

    ok("length is m:ss", value("duration", video) === "2:31", value("duration", video));
    ok("and rolls over to h:mm:ss", value("duration", long) === "1:02:05", value("duration", long));
    ok("a text file has no length", value("duration", text) === "");
    ok("dimensions read W × H", value("dimensions", video) === "1920 × 1080");
    ok("a text file has no dimensions", value("dimensions", text) === "");
    ok("type is the extension, upper-cased", value("ext", video) === "MP4");
    ok("an extensionless file has no type", value("ext", noExt) === "");
    ok("where is the parent folder", value("where", text) === "C:\\Users\\me");

    ok("this year keeps its time", /am|pm/.test(value("modified", video)), value("modified", video));
    ok("an older file gives the time up for the year",
      value("modified", text).endsWith("2019"), value("modified", text));
    ok("a missing timestamp is blank, not Invalid Date", when(undefined) === "");
    ok("a nonsense timestamp is blank too", when(Number.NaN) === "");
    // This year, or the clock is dropped for the year and there is no hour to
    // check — which is the behaviour asserted two lines above.
    const YEAR = new Date().getFullYear();
    ok("midnight is 12am, not 0am",
      when(new Date(YEAR, 0, 1, 0, 30).getTime()).includes("12:30am"),
      when(new Date(YEAR, 0, 1, 0, 30).getTime()));
    ok("noon is 12pm, not 0pm",
      when(new Date(YEAR, 5, 1, 12, 30).getTime()).includes("12:30pm"),
      when(new Date(YEAR, 5, 1, 12, 30).getTime()));
  }

  // ── 3 — reading a stored line ─────────────────────────────────────────────
  {
    ok("a plain list round trips", ids("name,size") === "name,size");
    ok("order is kept as written, not as declared", ids("size,name") === "size,name");
    ok("spaces are tolerated", ids(" name , size ") === "name,size");
    // Written by a newer build, or by hand. Dropping it is a column you did not
    // get; throwing is a file explorer that will not start.
    ok("an unknown id is dropped, not thrown", ids("name,colour,size") === "name,size");
    ok("a duplicate is dropped", ids("name,size,size") === "name,size");
    ok("an empty line falls back", ids("") === DEFAULT_COLUMNS);
    ok("undefined falls back", stringify(parse(undefined)) === DEFAULT_COLUMNS);
    ok("a line of only junk falls back", ids("a,b,c") === DEFAULT_COLUMNS);
    ok("commas alone fall back", ids(",,,") === DEFAULT_COLUMNS);
    ok("a caller can choose its own fallback",
      stringify(parse("", { fallback: DEFAULT_CARD })) === DEFAULT_CARD);

    ok("a nameless column list gets its name back",
      stringify(parse("size,modified", { requireName: true })) === "name,size,modified");
    ok("and it goes in front", parse("size", { requireName: true })[0]?.id === "name");
    ok("a name already present is not doubled",
      stringify(parse("size,name", { requireName: true })) === "size,name");
    // A card is not a row: it has no name column to be missing.
    ok("a card list is left alone", ids("duration") === "duration");
    ok("the fallback obeys requireName too",
      parse("junk", { requireName: true, fallback: "size" }).map((f) => f.id).join(",") ===
        "name,size");
  }

  // ── 4 — the grid track list ───────────────────────────────────────────────
  {
    const t = template(parse("name,size"));
    ok("the icon column comes first", t.startsWith("26px "), t);
    ok("name takes the slack", t.includes("minmax(0, 1fr)"), t);
    ok("a fixed column is its declared width", t.endsWith("88px"), t);
    ok("the whole default set lays out as declared",
      template(parse(DEFAULT_COLUMNS)) === "26px minmax(0, 1fr) 74px 88px 148px",
      template(parse(DEFAULT_COLUMNS)));
    ok("a column moved out of first place still takes the slack",
      template(parse("size,name")) === "26px 88px minmax(0, 1fr)",
      template(parse("size,name")));
  }

  // ── 5 — the line under a card's name ──────────────────────────────────────
  {
    const card = parse(DEFAULT_CARD);
    ok("a video says its length, type and size",
      subtitle(video, card) === "2:31 · MP4 · 46 MB", subtitle(video, card));
    // The whole reason a field returns "" rather than a placeholder: one list
    // suits a video and a text file without either reading as broken.
    ok("a text file drops the fields it cannot answer",
      subtitle(text, card) === "TXT · 4.0 KB", subtitle(text, card));
    ok("nothing shows a run of empty separators",
      !subtitle(text, card).includes("· ·") && !subtitle(text, card).startsWith("·"));
    ok("a folder answers none of them and says what it is",
      subtitle(folder, card) === "Folder", subtitle(folder, card));
    ok("an empty field list falls back to the kind", subtitle(video, []) === "MP4");
  }

  // ── 6 — the details list reads the table ──────────────────────────────────
  {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-10000px;width:1200px;height:600px;";
    document.body.appendChild(host);

    const sorts: string[] = [];
    const list = new ListView(host, cfg, {
      onOpen: () => {},
      onSelect: () => {},
      onSort: (k) => sorts.push(k),
    });
    list.setEntries([video, text, folder]);
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const heads = (): string[] =>
      Array.from(host.querySelectorAll(".lv-th")).map((h) => (h.textContent ?? "").replace(/[▲▼]/g, "").trim());
    const rowFields = (): string[] =>
      Array.from(host.querySelectorAll(".lv-row"))[0]
        ? Array.from(host.querySelectorAll<HTMLElement>(".lv-row")[0]!.querySelectorAll(".lv-c"))
            .map((c) => (c as HTMLElement).dataset["field"] ?? "?")
        : [];

    ok("the default header is the four Explorer columns",
      heads().join(",") === "Name,Kind,Size,Modified", heads().join(","));
    ok("a row has one cell per column", rowFields().join(",") === "name,kind,size,modified",
      rowFields().join(","));
    ok("the tracks come from the same list",
      host.querySelector<HTMLElement>(".lv")?.style.getPropertyValue("--lv-cols") ===
        template(parse(DEFAULT_COLUMNS)),
      host.querySelector<HTMLElement>(".lv")?.style.getPropertyValue("--lv-cols") ?? "unset");

    const firstRow = host.querySelector<HTMLElement>(".lv-row")!;
    const cellText = (id: string): string =>
      firstRow.querySelector<HTMLElement>(`.lv-c[data-field="${id}"]`)?.textContent ?? "\u2205";
    ok("a cell prints what the field says",
      cellText("size") === value("size", video) && cellText("kind") === "MP4",
      `${cellText("size")} / ${cellText("kind")}`);

    // The point of the whole exercise.
    list.setConfig({ ...cfg, columns: "name,duration,where" });
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    ok("choosing columns changes the header",
      heads().join(",") === "Name,Length,Where", heads().join(","));
    ok("and changes the cells", rowFields().join(",") === "name,duration,where",
      rowFields().join(","));
    ok("and the tracks follow",
      host.querySelector<HTMLElement>(".lv")?.style.getPropertyValue("--lv-cols") ===
        template(parse("name,duration,where")));
    ok("a column the list has never shown before still prints",
      host.querySelector<HTMLElement>('.lv-c[data-field="duration"]')?.textContent === "2:31",
      host.querySelector<HTMLElement>('.lv-c[data-field="duration"]')?.textContent ?? "none");

    ok("a numeric column is right-aligned",
      host.querySelector<HTMLElement>('.lv-c[data-field="duration"]')?.dataset["align"] === "right");
    ok("a header over an unsortable field does not take a click",
      Array.from(host.querySelectorAll<HTMLButtonElement>(".lv-th"))
        .filter((b) => b.disabled).length === 2,
      String(Array.from(host.querySelectorAll<HTMLButtonElement>(".lv-th")).filter((b) => b.disabled).length));
    Array.from(host.querySelectorAll<HTMLButtonElement>(".lv-th"))[0]!.click();
    ok("a header over a sortable one still does", sorts.join(",") === "name", sorts.join(","));

    // The shell keeps one ViewConfig and mutates it, so the object handed to
    // setConfig is the object the view already has. A before/after comparison of
    // its properties therefore compares a value with itself — which shipped, and
    // repainted the header over rows that still had the old cells in them.
    const shared: ViewConfig = { ...cfg, columns: "name,kind" };
    list.setConfig(shared);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    shared.columns = "name,size,where";
    list.setConfig(shared);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    ok("a config mutated in place still repaints the rows",
      rowFields().join(",") === "name,size,where", rowFields().join(","));
    ok("and the header agrees with them",
      heads().join(",") === "Name,Size,Where", heads().join(","));

    // Whatever the file says, the list has a name column.
    list.setConfig({ ...cfg, columns: "size" });
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    ok("a hand-edited nameless column list still shows names",
      heads()[0] === "Name", heads().join(","));

    list.destroy();
    host.remove();
  }

  // ── 7 — the chooser ───────────────────────────────────────────────────────
  {
    let stored = DEFAULT_COLUMNS;
    const panel = new FieldsPanel();
    const openIt = (): void =>
      panel.open({
        title: "Columns",
        blurb: "b",
        requireName: true,
        read: () => stored,
        write: (next) => { stored = next; },
        reset: () => { stored = DEFAULT_COLUMNS; },
      });
    openIt();

    const el = panel.element;
    const rows = (): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>(".flds-row"));
    const rowIds = (): string => rows().map((r) => r.dataset["field"]).join(",");
    const adds = (): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>(".flds-add"));
    const btn = (row: HTMLElement, cls: string): HTMLButtonElement =>
      row.querySelector<HTMLButtonElement>(`.${cls}`)!;

    ok("the chooser opens", panel.isOpen && !gone(el));
    ok("it lists the chosen columns in order", rowIds() === DEFAULT_COLUMNS, rowIds());
    ok("and offers the rest", adds().length === FIELDS.length - 4, String(adds().length));

    adds()[0]!.click();
    ok("adding a field writes it to the end", stored === `${DEFAULT_COLUMNS},ext`, stored);
    ok("and the list redraws", rowIds() === stored, rowIds());
    ok("an added field leaves the Add row", adds().length === FIELDS.length - 5);

    rows()[4]!.querySelector<HTMLButtonElement>(".flds-move")!.click(); // ▲ on ext
    ok("a field moves up", stored === "name,kind,size,ext,modified", stored);

    Array.from(rows()[3]!.querySelectorAll<HTMLButtonElement>(".flds-move"))[1]!.click(); // ▼ on ext
    ok("and back down", stored === DEFAULT_COLUMNS + ",ext", stored);

    btn(rows()[4]!, "flds-drop").click();
    ok("a field is removed", stored === DEFAULT_COLUMNS, stored);
    ok("and comes back to the Add row", adds().length === FIELDS.length - 4);

    ok("the first row cannot move up", btn(rows()[0]!, "flds-move").disabled);
    ok("the last row cannot move down",
      Array.from(rows()[3]!.querySelectorAll<HTMLButtonElement>(".flds-move"))[1]!.disabled);
    // Reserved, not removed — one row must not be narrower than the others.
    ok("name has no remove button", btn(rows()[0]!, "flds-drop").hidden);
    ok("but its space is kept",
      getComputedStyle(btn(rows()[0]!, "flds-drop")).visibility === "hidden" &&
        !gone(btn(rows()[0]!, "flds-drop")));
    ok("every other row has one", rows().slice(1).every((r) => !btn(r, "flds-drop").hidden));

    btn(rows()[1]!, "flds-drop").click();
    ok("removing works", stored === "name,size,modified", stored);
    el.querySelector<HTMLButtonElement>(".flds-reset")!.click();
    ok("put it back restores the default", stored === DEFAULT_COLUMNS, stored);

    // A card list has no name to protect, so nothing is locked.
    panel.open({
      title: "Card details",
      blurb: "b",
      read: () => DEFAULT_CARD,
      write: () => {},
      reset: () => {},
    });
    ok("a card list locks nothing", rows().every((r) => !btn(r, "flds-drop").hidden), rowIds());
    ok("and shows the card fields", rowIds() === DEFAULT_CARD, rowIds());

    panel.close();
    ok("closing hides it", !panel.isOpen && gone(el));
    el.remove();
  }

  // ── 8 — the settings that carry it ────────────────────────────────────────
  {
    const decl = (id: string) => ALL_SETTINGS.find((s) => s.id === id);
    ok("both settings are registered",
      decl(PREF.columns) !== undefined && decl(PREF.cardFields) !== undefined);
    ok("they are text, because the value is a readable line",
      decl(PREF.columns)?.kind === "text" && decl(PREF.cardFields)?.kind === "text");
    ok("they sit with the rest of the explorer",
      decl(PREF.columns)?.group === "Explorer" && decl(PREF.cardFields)?.group === "Explorer");
    // The default in the registry and the default in the table are the same
    // string, or "reset" hands back something the list has never shown.
    ok("the shipped defaults are the table's defaults",
      decl(PREF.columns)?.default === DEFAULT_COLUMNS &&
        decl(PREF.cardFields)?.default === DEFAULT_CARD);
    ok("every id in both defaults is a real field",
      [...DEFAULT_COLUMNS.split(","), ...DEFAULT_CARD.split(",")].every((id) => field(id) !== undefined));
  }

  const line = `field: ${pass} passed, ${fail} failed`;
  console.log(`%c${line}`, `color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`);
  const banner = document.createElement("h2");
  banner.textContent = line;
  banner.style.cssText = `font:600 18px system-ui;color:${fail === 0 ? "#3ddc84" : "#ff6b6b"}`;
  document.body.prepend(banner);
}

void main();
