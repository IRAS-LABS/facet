/**
 * Dragging files onto folders — the plumbing every view shares.
 *
 * ## Why the payload is a module variable and not `dataTransfer`
 *
 * It looks like the wrong choice until you try the other one. Two reasons, and
 * either would be enough on its own:
 *
 * 1. **`dataTransfer` is unreadable while the drag is in flight.** During
 *    `dragover` the browser puts the store in protected mode: you can see
 *    `types`, but `getData` returns "". So the one moment you actually need to
 *    know what is being dragged — deciding whether *this* folder may accept it,
 *    and painting the highlight — is the moment the API refuses to say. Every
 *    workaround for this is some flavour of "keep it on the side", which is
 *    what this is.
 *
 * 2. **The drag stops being an HTML5 drag.** Dragging a file out to another
 *    application needs a real OS drag, and once the source hands over to the
 *    platform there is no `dataTransfer` on our side to read at all. The paths
 *    have to live somewhere that survives that. They live here.
 *
 * The cost is that the payload is only meaningful for drags that started inside
 * Facet, which is exactly the set of drags this module claims to handle.
 *
 * ## Move or copy
 *
 * Ctrl copies, matching Explorer. Everything else moves — *except* across
 * volumes, where a move is a copy plus a delete, and the delete is of a file
 * the user still has. `move_file` on the Rust side refuses to do it and reports
 * `copied: true` instead; deciding it here as well means the UI says "copy"
 * before the drop rather than explaining it afterwards.
 */

export type DropEffect = "move" | "copy";

export interface Dragging {
  /** Absolute paths, in the order they were selected. */
  paths: readonly string[];
  /** The folder they came from. A move back into it is a no-op. */
  from: string;
}

let held: Dragging | null = null;

export function beginDrag(paths: readonly string[], from: string): void {
  held = { paths: [...paths], from };
}

export function endDrag(): void {
  held = null;
}

/**
 * Hand the gesture to the operating system (item 9).
 *
 * Installed by the shell rather than imported here. This module is shared with
 * the phone build, where there is no desktop to drag onto, and with a plain
 * browser tab, where there is no plugin to call — in both, nothing is
 * installed and the ordinary HTML5 drag stays exactly as it was.
 *
 * Returning nothing on purpose: once the OS has the gesture there is no
 * promise worth awaiting, because the drag outlives the call by however long
 * the user holds the button down.
 */
export type OsDragger = (paths: readonly string[]) => void;

let escalate: OsDragger | null = null;

export function useOsDrag(fn: OsDragger | null): void {
  escalate = fn;
}

export function osDrag(): OsDragger | null {
  return escalate;
}

export function dragging(): Dragging | null {
  return held;
}

/**
 * Same drive?
 *
 * Windows volumes are the drive letter; UNC shares are `\\server\share`. Any
 * other shape — a POSIX path, an Android storage root — reports the same empty
 * volume as every other, so those default to a move. That is the right answer
 * for a phone's internal storage and the wrong one for an SD card, which is
 * survivable: `move_file` finds out when `rename` fails, copies, and says
 * `copied: true` without removing anything.
 */
export function sameVolume(a: string, b: string): boolean {
  return volumeOf(a) === volumeOf(b);
}

function volumeOf(p: string): string {
  const drive = /^([a-zA-Z]):[\\/]/.exec(p);
  if (drive !== null) return drive[1]!.toLowerCase();
  const unc = /^[\\/]{2}([^\\/]+[\\/][^\\/]+)/.exec(p);
  if (unc !== null) return unc[1]!.toLowerCase().replace(/\\/g, "/");
  return "";
}

export function effectFor(copyKey: boolean, from: string, to: string): DropEffect {
  if (copyKey) return "copy";
  return sameVolume(from, to) ? "move" : "copy";
}

/** `parent` is `child`, or an ancestor of it. Slash-normalised, case-folded. */
export function contains(parent: string, child: string): boolean {
  const p = parent.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const c = child.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return c === p || c.startsWith(p + "/");
}

/**
 * May this drop happen at all?
 *
 * The refusals are the ones whose failure is destructive or absurd rather than
 * merely useless:
 *
 * - **A folder into itself, or into anything under it.** Left alone this copies
 *   a tree into its own subtree until the disk fills. Rust refuses too — this
 *   is here so the cursor says no before the mouse is released.
 * - **An item onto its own parent, when moving.** Not harmful, just nothing:
 *   the file is already there. A *copy* onto the same folder is allowed,
 *   because "duplicate this" is a real thing to want and lands as `name-2`.
 */
export function canDrop(drag: Dragging, to: string, effect: DropEffect): boolean {
  if (drag.paths.length === 0) return false;
  for (const path of drag.paths) {
    if (contains(path, to)) return false;
  }
  if (effect === "move" && contains(drag.from, to) && contains(to, drag.from)) return false;
  return true;
}

export interface DropTarget {
  /**
   * Which folder the pointer is over, or null where nothing accepts a drop.
   *
   * Returning the containing folder for empty space is what makes "drop into
   * the background of the folder you are looking at" work, and each view
   * decides for itself whether it has such a background.
   */
  folderAt(e: DragEvent): string | null;
  /** Paint the hover state; `null` clears it. Called only when it changes. */
  mark(path: string | null): void;
  run(paths: readonly string[], to: string, effect: DropEffect): void;
}

/**
 * Wire a container up as a drop surface.
 *
 * One listener set on the container rather than per row: rows are mounted and
 * unmounted by the virtualiser as you scroll, and a drag that hovers over a row
 * built halfway through the gesture would otherwise arrive on an element with
 * no handlers.
 *
 * Returns the teardown, so a view that is destroyed does not leave the document
 * listening on its behalf.
 */
export function acceptDrops(node: HTMLElement, target: DropTarget): () => void {
  let marked: string | null = null;

  const paint = (path: string | null): void => {
    if (path === marked) return;
    marked = path;
    target.mark(path);
  };

  const over = (e: DragEvent): void => {
    const drag = dragging();
    if (drag === null) return;
    const to = target.folderAt(e);
    const effect = to === null ? "move" : effectFor(e.ctrlKey || e.metaKey, drag.from, to);
    if (to === null || !canDrop(drag, to, effect)) {
      paint(null);
      // Not prevented, so the drop is refused and the cursor says so.
      if (e.dataTransfer !== null) e.dataTransfer.dropEffect = "none";
      return;
    }
    e.preventDefault();
    if (e.dataTransfer !== null) e.dataTransfer.dropEffect = effect;
    paint(to);
  };

  const leave = (e: DragEvent): void => {
    // `dragleave` fires on every crossing between children too. Only the one
    // that actually leaves the container counts, and `relatedTarget` is how you
    // tell — it is what the pointer moved *to*.
    const to = e.relatedTarget;
    if (to instanceof Node && node.contains(to)) return;
    paint(null);
  };

  const drop = (e: DragEvent): void => {
    const drag = dragging();
    paint(null);
    if (drag === null) return;
    const to = target.folderAt(e);
    if (to === null) return;
    const effect = effectFor(e.ctrlKey || e.metaKey, drag.from, to);
    if (!canDrop(drag, to, effect)) return;
    e.preventDefault();
    e.stopPropagation();
    target.run(drag.paths, to, effect);
  };

  node.addEventListener("dragover", over);
  node.addEventListener("dragenter", over);
  node.addEventListener("dragleave", leave);
  node.addEventListener("drop", drop);

  return () => {
    node.removeEventListener("dragover", over);
    node.removeEventListener("dragenter", over);
    node.removeEventListener("dragleave", leave);
    node.removeEventListener("drop", drop);
  };
}

/**
 * The little card that follows the cursor.
 *
 * Built rather than borrowed from the row under the pointer: dragging eleven
 * files should not look like dragging the one you happened to grab. It has to
 * be in the document when `setDragImage` is called and gone immediately after,
 * which is what the `requestAnimationFrame` is for — removing it synchronously
 * beats the browser to the snapshot and leaves no image at all.
 */
export function dragGhost(e: DragEvent, label: string, count: number): void {
  if (e.dataTransfer === null) return;
  const card = document.createElement("div");
  card.className = "dnd-ghost";
  const name = document.createElement("span");
  name.className = "dnd-ghost-name";
  name.textContent = label;
  card.appendChild(name);
  if (count > 1) {
    const badge = document.createElement("span");
    badge.className = "dnd-ghost-count";
    badge.textContent = String(count);
    card.appendChild(badge);
  }
  document.body.appendChild(card);
  e.dataTransfer.setDragImage(card, 12, 12);
  requestAnimationFrame(() => card.remove());
}
