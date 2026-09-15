/**
 * Save, or save a copy — one answer for every editor in the app.
 *
 * Every editor here had grown its own ending. The signing panel wrote a copy
 * and only a copy; the metadata panel offered both but implemented the "both"
 * itself; the scanner named its output and hoped. So the same question — *does
 * this replace my file or sit beside it?* — got a different answer, a different
 * button and a different amount of warning depending on which screen you were
 * on, which is exactly the kind of thing that makes a tool feel untrustworthy
 * even when every individual screen is correct.
 *
 * Two rules decide everything below.
 *
 * **A copy is the default, always.** Nobody opens a file intending to lose it.
 * The copy is written beside the original with a suffix, numbered if that name
 * is taken, and the original is not touched at all.
 *
 * **An overwrite keeps a backup.** Not a confirmation dialog instead of a
 * backup — both. `deed.pdf` becomes `deed.pdf` with the new content and
 * `deed (original).pdf` with the old, because the one thing worse than a
 * destructive save is a destructive save that was technically consented to at
 * 1 am. The backup is written *first*: if it cannot be written, the overwrite
 * does not happen, and the message says so.
 */

/** The little the save path needs from a filesystem. */
export interface SaveHost {
  readAll(path: string, max: number): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array, overwrite?: boolean): Promise<string>;
}

/** How many numbered variants to try before giving up on a free name. */
const TRIES = 40;

/** 512 MB. Only a ceiling for reading the original back to keep as a backup. */
const BACKUP_MAX = 512 * 1024 * 1024;

/** `/a/b/deed.pdf` → `{ dir: "/a/b", stem: "deed", ext: ".pdf" }`. */
export function splitPath(path: string): { dir: string; stem: string; ext: string } {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  // A leading dot is a hidden file, not an extension: `.gitignore` has stem
  // `.gitignore` and no extension, and splitting it the other way would write
  // the copy as `(1).gitignore`.
  const hasExt = dot > 0;
  return { dir, stem: hasExt ? name.slice(0, dot) : name, ext: hasExt ? name.slice(dot) : "" };
}

/**
 * Write to the first free name of the form `stem`, `stem (2)`, `stem (3)`…
 *
 * The numbering is in brackets and not with a dash because a dash is what the
 * *suffixes* use (`-signed`, `-clean`), and `deed-signed-2.pdf` reads as a
 * different kind of file rather than as the second attempt at the same one.
 *
 * Relies on `writeFile(_, _, false)` failing when the path is taken, which is
 * what the Rust side does — it checks and refuses rather than clobbering. That
 * makes this a claim on the name, not a look-then-write with a gap in between.
 */
export async function writeFree(
  // Only `writeFile`, so a panel that never reads a file back — the camera, the
  // recorder, the scanner — can claim a free name without having to pretend it
  // is a full {@link SaveHost}.
  host: Pick<SaveHost, "writeFile">,
  path: string,
  bytes: Uint8Array,
): Promise<string> {
  const { dir, stem, ext } = splitPath(path);
  const at = (n: number): string =>
    `${dir ? `${dir}/` : ""}${n === 1 ? stem : `${stem} (${n})`}${ext}`;
  let last = "";
  for (let n = 1; n <= TRIES; n++) {
    try {
      return await host.writeFile(at(n), bytes, false);
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`could not find a free name beside the original (${last})`);
}

/** What an overwrite did, so the status line can name the backup. */
export interface Overwritten {
  /** The file that now holds the new bytes — the original path. */
  path: string;
  /** Where the previous content was kept. */
  backup: string;
}

/**
 * Replace a file, keeping its previous content beside it.
 *
 * The order is load-old, write-backup, write-new, and it is not negotiable: a
 * backup written after the overwrite is a copy of the new file wearing the
 * word "original", which is worse than no backup because it looks like one.
 */
export async function overwriteWithBackup(
  host: SaveHost,
  path: string,
  bytes: Uint8Array,
): Promise<Overwritten> {
  const { dir, stem, ext } = splitPath(path);
  const previous = await host.readAll(path, BACKUP_MAX);
  const backup = await writeFree(
    host,
    `${dir ? `${dir}/` : ""}${stem} (original)${ext}`,
    previous,
  );
  const out = await host.writeFile(path, bytes, true);
  return { path: out, backup };
}

/** `deed.pdf` + `-signed` → `deed-signed.pdf`. The name a copy is offered as. */
export function suffixed(path: string, suffix: string, ext?: string): string {
  const { dir, stem, ext: own } = splitPath(path);
  const tail = ext === undefined ? own : ext ? `.${ext.replace(/^\./, "")}` : "";
  return `${dir ? `${dir}/` : ""}${stem}${suffix}${tail}`;
}

/** Just the file name, for a status line. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
