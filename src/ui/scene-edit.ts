/**
 * The 3D edit panel (item 6) — move, turn, size, material, and save-as.
 *
 * It owns the `Edit` record and the undo stack; it does not own the model, the
 * camera or the renderer, and it never touches a vertex buffer. Everything it
 * does is `applyPlacement` and `applyLook` from `@core/model3d/edit`, both of
 * which write transforms and material numbers and nothing else. That is the
 * same contract the photo editor keeps with its region list: the file as loaded
 * is always exactly one "Reset" away, and the whole edit is a few dozen bytes
 * that item 21's crash record can hold.
 *
 * Two things here are less obvious than they look.
 *
 * **The step of a number box is computed from the model.** A move box stepping
 * by 1 is useless for a 0.05-unit ring and useless for a 40,000-unit terrain, in
 * opposite directions — one arrow press either does nothing visible or throws
 * the model off screen. A tenth of the largest dimension is a step that means
 * roughly the same thing to a person whatever the file's units are.
 *
 * **A rebuild is how the panel refreshes.** Undo has to put nine numbers, four
 * sliders and three checkboxes back, and the version of that which walks a list
 * of stored references is the version that silently misses one after the next
 * control is added. Rebuilding is cheap here — nothing in this panel holds
 * state that is not in the `Edit`.
 */

import { Vector3, type Object3D } from "three";

import { dims } from "@core/model3d/scene";
import {
  applyLook,
  applyPlacement,
  clampScale,
  cloneEdit,
  encode,
  EXPORTS,
  exportKind,
  hasGeometry,
  isUntouched,
  NO_EDIT,
  outName,
  type Edit,
  type ExportFormat,
} from "@core/model3d/edit";

export interface SceneEditHost {
  /** The file's own contents — never the stand. Null when nothing is loaded. */
  model(): Object3D | null;
  /** The path of the file on screen, for naming the export. */
  path(): string | null;
  /** Ask for a frame. */
  redraw(): void;
  /** Put the model back on screen after a transform has moved it out of view. */
  reframe(): void;
  writeFile(path: string, bytes: Uint8Array, overwrite: boolean): Promise<string>;
}

/** How many undo steps to keep. Each is a handful of numbers. */
const UNDO_LIMIT = 60;

export class SceneEdit {
  readonly root: HTMLElement;
  private readonly body = document.createElement("div");
  private readonly footer = document.createElement("div");

  private edit: Edit = cloneEdit(NO_EDIT);
  private undoStack: Edit[] = [];
  private redoStack: Edit[] = [];

  /**
   * The model's own dimensions, as loaded. Drives two things: the step of the
   * move boxes (see the header) and the size the footer reports.
   */
  private measured = new Vector3(1, 1, 1);
  private format: ExportFormat = "glb";

  constructor(private readonly host: SceneEditHost) {
    this.root = document.createElement("aside");
    this.root.className = "se";
    this.root.hidden = true;

    const head = document.createElement("header");
    head.className = "se-head";
    head.textContent = "Edit";

    this.body.className = "se-body";
    this.footer.className = "se-foot";

    this.root.append(head, this.body, this.footer);
    this.wireKeys();
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  toggle(): void {
    if (this.isOpen) this.root.hidden = true;
    else {
      this.root.hidden = false;
      this.build();
    }
  }

  close(): void {
    this.root.hidden = true;
  }

  /**
   * A new model arrived.
   *
   * The edit is dropped rather than carried over, because a rotation that made
   * sense for one part is meaningless for the next file, and silently applying
   * it would look like FACET had corrupted the model on load. The undo stack
   * goes with it for the same reason — undoing onto a different file's geometry
   * is not undo.
   */
  attach(size: Vector3): void {
    this.measured = size.clone();
    this.edit = cloneEdit(NO_EDIT);
    this.undoStack = [];
    this.redoStack = [];
    if (this.isOpen) this.build();
  }

  /** Nothing is loaded. Keeps the panel from writing to a disposed tree. */
  detach(): void {
    this.undoStack = [];
    this.redoStack = [];
    if (this.isOpen) this.build();
  }

  // ── The edit ────────────────────────────────────────────────────────────

  /**
   * Put the current edit on the model.
   *
   * Both halves every time, unconditionally. Applying only what changed means
   * tracking what changed, and the first time that bookkeeping is wrong the
   * model and the panel disagree about what the user is looking at — for a
   * dozen microseconds of saved work on a transform that is three vector sets.
   */
  private apply(): void {
    const model = this.host.model();
    if (!model) return;
    applyPlacement(model, this.edit.place);
    applyLook(model, this.edit.look);
    this.host.redraw();
    this.renderFooter();
  }

  /** Remember where we were, before a gesture — not during one. */
  private push(): void {
    this.undoStack.push(cloneEdit(this.edit));
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    // A new action forks the history; anything that was redoable is now a
    // branch nobody can reach, and keeping it would redo into a state that
    // never followed from what is on screen.
    this.redoStack = [];
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(cloneEdit(this.edit));
    this.edit = prev;
    this.apply();
    this.build();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(cloneEdit(this.edit));
    this.edit = next;
    this.apply();
    this.build();
  }

  private reset(): void {
    this.push();
    this.edit = cloneEdit(NO_EDIT);
    this.apply();
    this.build();
    this.host.reframe();
  }

  // ── Building ────────────────────────────────────────────────────────────

  private build(): void {
    this.body.textContent = "";
    if (!this.host.model()) {
      const empty = document.createElement("p");
      empty.className = "se-empty";
      empty.textContent = "Nothing loaded.";
      this.body.append(empty);
      this.renderFooter();
      return;
    }

    this.body.append(
      this.placeGroup(),
      this.lookGroup(),
      this.exportGroup(),
    );
    this.renderFooter();
  }

  private placeGroup(): HTMLElement {
    const g = group("Place");
    const p = this.edit.place;

    // A tenth of the model, so one arrow press is a visible nudge whatever the
    // file's units are. Rounded to something a person would type.
    const step = nice(Math.max(this.measured.x, this.measured.y, this.measured.z) / 10);

    g.append(this.triple("Move", ["x", "y", "z"], step, undefined, undefined,
      (axis) => p.move[axis],
      (axis, v) => { p.move[axis] = v; }));

    g.append(this.triple("Turn °", ["x", "y", "z"], 15, -3600, 3600,
      (axis) => p.turn[axis],
      (axis, v) => { p.turn[axis] = v; }));

    // No minimum on the box: a negative size is a mirror, and `clampScale`
    // keeps the sign. Marking it invalid would be telling the user the wrong
    // thing about what the app does.
    g.append(this.triple("Size ×", ["x", "y", "z"], 0.1, undefined, undefined,
      (axis) => p.size[axis],
      (axis, v) => {
        // The lock is what makes the size boxes usable: scaling one axis of a
        // printed part on its own is a distortion, and is almost never what
        // someone typing in a "make it bigger" box means.
        if (p.locked) { p.size.x = v; p.size.y = v; p.size.z = v; }
        else p.size[axis] = v;
      }));

    const lock = document.createElement("label");
    lock.className = "se-check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = p.locked;
    box.addEventListener("change", () => {
      this.push();
      p.locked = box.checked;
      this.build();
    });
    lock.append(box, text("Keep the proportions"));
    g.append(lock);

    const row = document.createElement("div");
    row.className = "se-row";
    row.append(
      this.action("Reset", "Put the model back exactly as the file has it", () => this.reset()),
      this.action("Frame", "Fit the model on screen again  (F)", () => this.host.reframe()),
    );
    g.append(row);
    return g;
  }

  private lookGroup(): HTMLElement {
    const g = group("Look");
    const l = this.edit.look;

    const on = document.createElement("label");
    on.className = "se-check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = l.on;
    box.addEventListener("change", () => {
      this.push();
      l.on = box.checked;
      this.apply();
      this.build();
    });
    on.append(box, text("Override the file's own material"));
    g.append(on);

    if (!l.on) {
      const note = document.createElement("p");
      note.className = "se-hint";
      // Said here rather than left implied, because the panel showing five dead
      // controls is the natural reading otherwise.
      note.textContent = "Off means the file's materials are untouched — and restored exactly if you turn this back off.";
      g.append(note);
      return g;
    }

    const colour = document.createElement("input");
    colour.type = "color";
    colour.className = "se-colour";
    colour.value = l.colour;
    colour.addEventListener("input", () => {
      l.colour = colour.value;
      this.apply();
    });
    colour.addEventListener("pointerdown", () => this.push());
    g.append(labelled("Colour", colour));

    const sliders: ReadonlyArray<readonly [string, "roughness" | "metalness" | "opacity"]> = [
      ["Roughness", "roughness"],
      ["Metalness", "metalness"],
      ["Opacity", "opacity"],
    ];
    for (const [label, key] of sliders) {
      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = "1";
      input.step = "0.01";
      input.value = String(l[key]);
      const out = document.createElement("output");
      out.textContent = l[key].toFixed(2);
      input.addEventListener("input", () => {
        l[key] = Number(input.value);
        out.textContent = Number(input.value).toFixed(2);
        this.apply();
      });
      // One undo entry per drag, not per pixel of slider travel.
      input.addEventListener("pointerdown", () => this.push());
      g.append(labelled(label, input, out));
    }

    const flat = document.createElement("label");
    flat.className = "se-check";
    const flatBox = document.createElement("input");
    flatBox.type = "checkbox";
    flatBox.checked = l.flat;
    flatBox.addEventListener("change", () => {
      this.push();
      l.flat = flatBox.checked;
      this.apply();
    });
    flat.append(flatBox, text("Faceted shading"));
    g.append(flat);
    return g;
  }

  private exportGroup(): HTMLElement {
    const g = group("Save as");

    const pick = document.createElement("select");
    pick.className = "se-pick";
    for (const k of EXPORTS) {
      const opt = document.createElement("option");
      opt.value = k.id;
      opt.textContent = k.label;
      pick.append(opt);
    }
    pick.value = this.format;
    pick.addEventListener("change", () => {
      this.format = pick.value as ExportFormat;
      this.build();
    });
    g.append(labelled("Format", pick));

    const kind = exportKind(this.format);
    if (kind.drops) {
      const warn = document.createElement("p");
      warn.className = "se-warn";
      // Before the save, never after. See `ExportKind.drops`.
      warn.textContent = `Loses ${kind.drops}.`;
      g.append(warn);
    }

    const path = this.host.path();
    if (path) {
      const name = document.createElement("p");
      name.className = "se-hint se-out";
      name.textContent = baseName(outName(path, this.format));
      name.title = outName(path, this.format);
      g.append(name);
    }

    const save = document.createElement("button");
    save.type = "button";
    save.className = "se-save";
    save.textContent = "Export a copy";
    save.addEventListener("click", () => void this.save(save));
    g.append(save);
    return g;
  }

  /**
   * Write the file.
   *
   * `overwrite: false` without exception. The export name is derived from the
   * source name, so the second export of the same model targets the same path,
   * and an export is the one thing in this viewer that Escape cannot undo —
   * `writeFile` picks a free name and tells us which, and that name goes on the
   * button so nobody has to guess where it went.
   */
  private async save(btn: HTMLButtonElement): Promise<void> {
    const model = this.host.model();
    const path = this.host.path();
    if (!model || !path) return;

    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      // An empty STL is 84 valid bytes that every program opens and shows
      // nothing — a file that looks like FACET wrote garbage.
      if (!hasGeometry(model)) throw new Error("nothing to export");
      const bytes = await encode(model, this.format);
      const written = await this.host.writeFile(outName(path, this.format), bytes, false);
      btn.textContent = `Saved  ${baseName(written)}`;
    } catch (err) {
      btn.textContent = `Failed: ${message(err).slice(0, 48)}`;
    } finally {
      btn.disabled = false;
      window.setTimeout(() => {
        // The button may have been rebuilt while the write was in flight.
        const live = this.body.querySelector(".se-save");
        if (live) live.textContent = was;
      }, 2600);
    }
  }

  private renderFooter(): void {
    const bits: string[] = [];
    if (!isUntouched(this.edit)) bits.push("edited");
    if (this.undoStack.length) bits.push(`${this.undoStack.length} undo`);
    if (!bits.length) bits.push("unchanged");
    /*
     * The size the model would be *after* the edit, which is not the size the
     * status line reports. That line is deliberately about the file as it sits
     * on disk and it stays that way — but someone scaling a part to print it is
     * editing toward a number, and it would be a poor tool that made them work
     * it out with a calculator. `clampScale` for the same reason the transform
     * uses it: a typed 0 is not a size, and the magnitude is what a dimension
     * means whichever way a mirrored axis faces.
     */
    const s = this.edit.place.size;
    bits.push(
      dims(
        new Vector3(
          this.measured.x * Math.abs(clampScale(s.x)),
          this.measured.y * Math.abs(clampScale(s.y)),
          this.measured.z * Math.abs(clampScale(s.z)),
        ),
      ),
    );
    this.footer.textContent = bits.join("  ·  ");
  }

  // ── Controls ────────────────────────────────────────────────────────────

  /** A labelled row of three number boxes, one per axis. */
  private triple(
    label: string,
    axes: ReadonlyArray<"x" | "y" | "z">,
    step: number,
    min: number | undefined,
    max: number | undefined,
    get: (axis: "x" | "y" | "z") => number,
    set: (axis: "x" | "y" | "z", v: number) => void,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "se-triple";
    const name = document.createElement("span");
    name.className = "se-label";
    name.textContent = label;
    row.append(name);

    for (const axis of axes) {
      const input = document.createElement("input");
      input.type = "number";
      input.className = "se-num";
      input.step = String(step);
      if (min !== undefined) input.min = String(min);
      if (max !== undefined) input.max = String(max);
      input.value = trim(get(axis));
      input.title = `${label} ${axis.toUpperCase()}`;
      input.setAttribute("aria-label", `${label} ${axis.toUpperCase()}`);

      // `change` and not `input`: a number box fires `input` on every keystroke,
      // and a half-typed "-" or "1e" is not a number anyone meant to apply.
      input.addEventListener("change", () => {
        const v = Number(input.value);
        if (!Number.isFinite(v)) {
          input.value = trim(get(axis));
          return;
        }
        this.push();
        set(axis, v);
        this.apply();
        this.build();
      });
      row.append(input);
    }
    return row;
  }

  private action(label: string, tip: string, run: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "se-act";
    b.textContent = label;
    b.title = tip;
    b.addEventListener("click", run);
    return b;
  }

  /**
   * Undo and redo, and only those.
   *
   * The viewer's own shortcuts skip anything with a modifier, so Ctrl+Z reaches
   * here uncontested. Capture phase and gated on the panel being open, matching
   * every other surface in the app.
   */
  private wireKeys(): void {
    window.addEventListener("keydown", (e) => {
      if (!this.isOpen) return;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) this.redo();
      else this.undo();
    }, true);
  }
}

// ── Module helpers ────────────────────────────────────────────────────────

function group(title: string): HTMLElement {
  const g = document.createElement("section");
  g.className = "se-group";
  const h = document.createElement("h3");
  h.className = "se-title";
  h.textContent = title;
  g.append(h);
  return g;
}

function labelled(label: string, control: HTMLElement, out?: HTMLElement): HTMLElement {
  const row = document.createElement("label");
  row.className = "se-field";
  const name = document.createElement("span");
  name.className = "se-label";
  name.textContent = label;
  row.append(name, control);
  if (out) row.append(out);
  return row;
}

function text(s: string): HTMLElement {
  const span = document.createElement("span");
  span.textContent = s;
  return span;
}

/**
 * A step a person would recognise: 0.001, 0.01, 0.1, 1, 10 …
 *
 * The raw tenth of a bounding box is a number like 3.7194, and a box that steps
 * by that produces values nobody can read or type back in.
 */
function nice(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.pow(10, Math.round(Math.log10(v)));
}

/** Four decimals at most, and no trailing zeroes. */
function trim(v: number): string {
  return String(Math.round(v * 1e4) / 1e4);
}

function baseName(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return sep >= 0 ? path.slice(sep + 1) : path;
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error.";
}
