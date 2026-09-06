/**
 * What the right-click menu contains, and in what order (item 39).
 *
 * **There is no second command registry.** The menu is a line of ids over the
 * same `commands()` list the palette is built from, exactly as `PREF.columns` is
 * a line of field ids over `FIELDS`. That is the whole design: a module that
 * registers a command gets a palette entry, a rebindable shortcut and a menu
 * candidate at once, and it is impossible for a thing to be offered in one
 * place and missing from another because there is only one place it is written
 * down.
 *
 * The line is stored as text — `file.open,file.look,-,file.reveal,*` — because
 * that survives being read, hand-edited, and pasted into a settings backup, and
 * because the sentence "then everything else" is expressible as one character.
 *
 * Four rules, all of them about the menu still being usable after the list it
 * refers to has changed underneath it:
 *
 *  - **An id nothing offers drops out.** Most commands only exist for the right
 *    selection — `video.edit` is not there when you right-click a spreadsheet.
 *    So a menu line is a *preference*, matched against what is available right
 *    now, and never a promise about what will be on screen.
 *  - **`*` means everything else, in its own order, and `File*` means everything
 *    else in that group.** Someone who wants their own actions at the top and
 *    the rest of FACET underneath writes `act:a1,-,*` and never has to edit the
 *    line again when a new command ships. The group form exists because the
 *    palette holds every theme, every sort and every navigation command — a
 *    right-click ending in a bare `*` is forty rows deep and has "Theme: Nord"
 *    in it, which is the palette wearing a menu's clothes. The shipped line ends
 *    in `File*` instead: a file command that ships later still turns up, and
 *    nothing that has nothing to do with what you clicked ever does.
 *  - **Separators collapse.** Two ids either side of a `-` can both drop out for
 *    this selection, and a menu that opens with a rule floating above nothing is
 *    a bug the user would blame on their own editing.
 *  - **An empty result falls back to everything.** A right-click that opens a
 *    menu with no rows in it looks broken, and the user cannot tell it is their
 *    line that did it.
 */

/** The shape the menu needs. `Command` from `@ui/palette` satisfies it. */
export interface MenuCommand {
  id: string;
  title: string;
  hint?: string;
  group: string;
}

export type MenuEntry =
  | { kind: "item"; cmd: MenuCommand }
  | { kind: "sep" };

/** A rule between groups. */
export const SEP = "-";

/** Everything not named above. */
export const REST = "*";

/** `File*` — everything else in one group. */
export function restOfGroup(group: string): string {
  return `${group}${REST}`;
}

/**
 * The group a `Name*` token names, `""` for a bare `*`, or null if the id is not
 * a wildcard at all. No command id ends in `*`, so this cannot misread one.
 */
export function wildcardGroup(id: string): string | null {
  return id.endsWith(REST) ? id.slice(0, -1) : null;
}

/**
 * The shipped menu.
 *
 * Ordered by how often a hand reaches for it rather than by module: open, look,
 * your own actions, the two copies, then the things you do to a file, then the
 * escape hatches out to Windows. It ends in `File*` and not `*` — see the group
 * rule above — so a file command that ships later is reachable without editing
 * this line, and the eleven themes stay in the palette where they belong.
 */
export const DEFAULT_MENU = [
  "file.open",
  "file.look",
  SEP,
  // Actions the user wrote, right where a hand reaches. Nobody writes an action
  // in order to find it eleven rows down, and the separators around this
  // collapse on their own for the many people who never write one.
  restOfGroup("Yours"),
  SEP,
  "file.copyfiles",
  "file.copypath",
  "file.share",
  SEP,
  "file.meta",
  // Both editors are named, and at most one of them can ever be available for a
  // given file — which is exactly what "an id nothing offers drops out" is for.
  "video.edit",
  "audio.edit",
  "file.table",
  SEP,
  // Queue rows only exist when the selection qualifies for them, and "convert
  // these four" is a thing you want where your hand already is rather than in
  // the palette. Named as a group so a converter added later comes with it.
  restOfGroup("Batch"),
  SEP,
  "file.external",
  "file.reveal",
  SEP,
  restOfGroup("File"),
].join(",");

/** Split a stored line into ids. Blanks and duplicate ids dropped; `-` kept. */
export function parseMenu(line: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of line.split(",")) {
    const id = raw.trim();
    if (id === "") continue;
    if (id === SEP) {
      out.push(SEP);
      continue;
    }
    // A duplicated id is a hand-editing slip, and the second copy of a row does
    // nothing but make the menu longer.
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function stringifyMenu(ids: readonly string[]): string {
  return ids.join(",");
}

/**
 * Turn a stored line plus the commands available right now into rows to draw.
 *
 * Every rule above lives here rather than in the view, so the view has no
 * opinion about what a menu is and the rules can be tested without a DOM.
 */
export function buildMenu(line: string, available: readonly MenuCommand[]): MenuEntry[] {
  const byId = new Map(available.map((c) => [c.id, c]));
  const wanted = parseMenu(line);
  const named = new Set(
    wanted.filter((id) => id !== SEP && wildcardGroup(id) === null),
  );
  /** What a wildcard has already put on screen, so a later one does not repeat it. */
  const drawn = new Set<string>();

  const rows: MenuEntry[] = [];
  for (const id of wanted) {
    if (id === SEP) {
      rows.push({ kind: "sep" });
      continue;
    }
    const group = wildcardGroup(id);
    if (group !== null) {
      // In the order `commands()` produced them, which is already grouped by
      // module — re-sorting here would fight the ordering that list has already
      // been given some thought.
      for (const cmd of available) {
        if (named.has(cmd.id) || drawn.has(cmd.id)) continue;
        // `*` is the group form with an empty group, so one branch serves both.
        if (group !== "" && cmd.group.toLowerCase() !== group.toLowerCase()) continue;
        drawn.add(cmd.id);
        rows.push({ kind: "item", cmd });
      }
      continue;
    }
    const cmd = byId.get(id);
    if (cmd !== undefined) rows.push({ kind: "item", cmd });
  }

  const tidied = tidy(rows);
  if (tidied.some((r) => r.kind === "item")) return tidied;
  // Nothing survived — either the line names only commands this selection does
  // not offer, or it is empty. Show the lot rather than an empty box.
  return available.map((cmd) => ({ kind: "item", cmd }) as MenuEntry);
}

/** Drop leading, trailing and repeated separators. */
function tidy(rows: readonly MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const row of rows) {
    if (row.kind === "sep") {
      if (out.length === 0) continue;
      if (out[out.length - 1]?.kind === "sep") continue;
    }
    out.push(row);
  }
  while (out.length > 0 && out[out.length - 1]?.kind === "sep") out.pop();
  return out;
}
