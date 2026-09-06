/**
 * What a row and a card are allowed to say about a file (item 36).
 *
 * One table, not two. "Which columns does the list show" and "what goes under
 * the name on a card" are the same question asked of the same file, and every
 * app that answers them in two places ends up able to show you a duration in
 * one view and not the other for no reason anybody can explain. A column here
 * is a field with a width; a card subtitle is a few fields joined with a dot.
 *
 * Each field says what it has to say about *this* file and returns "" when it
 * has nothing — a JPEG has no duration, a folder has no size worth printing.
 * That is what lets a card ask for three fields and print the two that came
 * back, instead of showing "· ·" over an empty run of separators.
 *
 * The chosen set is stored as a comma-separated list of ids, which is worth a
 * word because a JSON array would have been the obvious thing. Ids in a line
 * survive being read, hand-edited and pasted between machines by someone who
 * has never seen this file; a nested value in a settings backup does not, and
 * `parse` treats anything it does not recognise as absent rather than as an
 * error. A dropped field is a column you did not get. A thrown error is a file
 * explorer that will not start.
 */

import { formatSize, type FileEntry, type SortKey } from "./types";

export interface FieldDef {
  id: string;
  /** Column header, and the label in the chooser. */
  label: string;
  /** Clicking the header sorts by this. Null for fields nothing sorts on. */
  sort: SortKey | null;
  /** Column track width in px. Ignored on a card. */
  width: number;
  /** Numeric columns read better right-aligned against a ragged left edge. */
  align?: "right";
  /** One line about one file. "" when this field has nothing to say about it. */
  value(e: FileEntry): string;
}

/** Folders say so; everything else is named by the thing that opens it. */
export function kindLabel(e: FileEntry): string {
  if (e.kind === "folder") return "Folder";
  return e.ext === "" ? "File" : e.ext.toUpperCase();
}

/**
 * Short, sortable-looking, and 12-hour because that is how the clock on this
 * machine reads. Recent files keep their time; older ones give it up for a year,
 * which is the thing you actually need at that distance.
 */
export function when(ms: number | undefined): string {
  if (ms === undefined) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const month = d.toLocaleString(undefined, { month: "short" });
  const day = String(d.getDate()).padStart(2, "0");
  const thisYear = new Date().getFullYear();
  if (d.getFullYear() !== thisYear) return `${month} ${day}  ${d.getFullYear()}`;
  const h24 = d.getHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${month} ${day}  ${h}:${m}${h24 < 12 ? "am" : "pm"}`;
}

function clock(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/**
 * Every field there is.
 *
 * Order here is the order they are offered in the chooser and the order a row
 * lays them out in — see `parse`. Name is first because a row that does not
 * start with the file's name is not a row anyone can scan.
 */
export const FIELDS: readonly FieldDef[] = [
  {
    id: "name",
    label: "Name",
    sort: "name",
    width: 0, // the flexible track; see `template`
    value: (e) => e.name,
  },
  {
    id: "kind",
    label: "Kind",
    sort: "kind",
    width: 74,
    value: (e) => kindLabel(e),
  },
  {
    id: "size",
    label: "Size",
    sort: "size",
    width: 88,
    align: "right",
    // A folder's "size" is the sum of everything inside it, which costs a walk
    // of the whole subtree. Printing 0 instead would be a lie told cheaply.
    value: (e) => (e.kind === "folder" ? "" : formatSize(e.size ?? 0)),
  },
  {
    id: "modified",
    label: "Modified",
    sort: "modified",
    width: 148,
    value: (e) => when(e.modified),
  },
  {
    id: "ext",
    label: "Type",
    sort: null,
    width: 62,
    // Deliberately alongside Kind rather than instead of it: "Picture" is what
    // you filter by, "HEIC" is why the thing will not open on someone's laptop.
    value: (e) => (e.ext === "" ? "" : e.ext.toUpperCase()),
  },
  {
    id: "dimensions",
    label: "Dimensions",
    sort: null,
    width: 106,
    align: "right",
    value: (e) => (e.width !== undefined && e.height !== undefined ? `${e.width} × ${e.height}` : ""),
  },
  {
    id: "duration",
    label: "Length",
    sort: null,
    width: 84,
    align: "right",
    value: (e) => (e.duration !== undefined && e.duration > 0 ? clock(e.duration) : ""),
  },
  {
    id: "where",
    label: "Where",
    sort: null,
    width: 200,
    // Pointless in a plain folder listing and the only column that matters in a
    // search result, which is why it is offered rather than assumed.
    value: (e) => {
      const cut = Math.max(e.path.lastIndexOf("\\"), e.path.lastIndexOf("/"));
      return cut <= 0 ? "" : e.path.slice(0, cut);
    },
  },
];

export const FIELD_IDS: readonly string[] = FIELDS.map((f) => f.id);

/** What the list shows out of the box — Windows Explorer's four, in its order. */
export const DEFAULT_COLUMNS = "name,kind,size,modified";

/**
 * What a card says under the name out of the box.
 *
 * Length first because it is the fact you are looking for when it exists at
 * all, and every field that has nothing to say drops out — so a video reads
 * "2:31 · MP4 · 48.2 MB" and a text file reads "TXT · 4 KB" from one list.
 */
export const DEFAULT_CARD = "duration,ext,size";

export function field(id: string): FieldDef | undefined {
  return FIELDS.find((f) => f.id === id);
}

/**
 * Read a stored list back into fields.
 *
 * Unknown ids are dropped, duplicates are dropped, and the whole thing falls
 * back when it is empty. `requireName` is what keeps a nameless list from being
 * reachable at all: the chooser refuses to unpick Name, but a hand-edited file
 * can still say `size,modified`, and a file explorer that has stopped printing
 * file names is not a configuration anybody chose.
 */
export function parse(
  text: string | undefined,
  opts: { requireName?: boolean; fallback?: string } = {},
): FieldDef[] {
  const wanted = (text ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  const seen = new Set<string>();
  const out: FieldDef[] = [];
  for (const id of wanted) {
    if (seen.has(id)) continue;
    const f = field(id);
    if (!f) continue;
    seen.add(id);
    out.push(f);
  }
  // Emptiness is decided before Name is put back, and the order matters: a line
  // of nothing but ids this build has never heard of would otherwise become a
  // list with a single Name column in it — which is not the default, is not what
  // was asked for, and looks exactly like the app losing its columns.
  if (out.length === 0) {
    return parse(opts.fallback ?? DEFAULT_COLUMNS, { requireName: opts.requireName === true });
  }
  if (opts.requireName === true && !seen.has("name")) out.unshift(FIELDS[0]!);
  return out;
}

/** Back to a stored line. */
export function stringify(fields: readonly FieldDef[]): string {
  return fields.map((f) => f.id).join(",");
}

/**
 * The grid track list for a set of columns, icon column included.
 *
 * Name takes the slack because it is the one column whose content has no
 * natural width; the rest are sized to the widest thing they can hold. If Name
 * has been moved out of first place its track still stretches — a column that
 * eats the remainder in the middle of a row is odd-looking, and being able to
 * do it is the price of letting the order be chosen at all.
 */
export function template(fields: readonly FieldDef[]): string {
  return ["26px", ...fields.map((f) => (f.id === "name" ? "minmax(0, 1fr)" : `${f.width}px`))].join(" ");
}

/**
 * The line under a card's name.
 *
 * Falls back to the kind when every chosen field came back empty, because a
 * folder has no size, no extension and no length, and a blank strip under the
 * name reads as a rendering bug rather than as an absence of facts.
 */
export function subtitle(e: FileEntry, fields: readonly FieldDef[]): string {
  const parts = fields.map((f) => f.value(e)).filter((s) => s !== "");
  return parts.length > 0 ? parts.join(" · ") : kindLabel(e);
}

/**
 * Everything one file can answer, for a view with room to print it.
 *
 * Deliberately *not* the chosen columns. A preview pane is showing one file with
 * space to spare, so it prints everything that file can say; the columns are a
 * choice about what fits across a row. It lives here rather than in the list,
 * which wrote it first, because the columns view grew a pane of its own and two
 * copies of this would drift into writing a date one way on the left of the
 * window and another way on the right.
 */
export function facts(e: FileEntry): Array<[string, string]> {
  const out: Array<[string, string]> = [["Kind", kindLabel(e)]];
  if (e.kind !== "folder") out.push(["Size", formatSize(e.size ?? 0)]);
  if (e.width !== undefined && e.height !== undefined) {
    out.push(["Dimensions", `${e.width} × ${e.height}`]);
  }
  if (e.duration !== undefined) {
    const m = Math.floor(e.duration / 60);
    const s = String(Math.round(e.duration % 60)).padStart(2, "0");
    out.push(["Length", `${m}:${s}`]);
  }
  const t = when(e.modified);
  if (t !== "") out.push(["Modified", t]);
  return out;
}
