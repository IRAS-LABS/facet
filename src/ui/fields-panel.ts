/**
 * The column and card-detail chooser (item 36).
 *
 * The setting itself is a line of ids — `name,kind,size,modified` — and that is
 * genuinely the right thing to store: it survives being read, hand-edited and
 * pasted between machines. It is not the right thing to *ask a person for*, so
 * the settings row keeps the text box and grows a **Choose…** button that opens
 * this.
 *
 * Two decisions worth writing down:
 *
 *  - **It edits the setting on every click, not on an OK button.** The folder is
 *    still behind the sheet and it re-lays-out as you go, so adding a column is
 *    a thing you *see* rather than a thing you predict. That is also why there
 *    is no Cancel: everything here is one click to undo, and a modal that can
 *    throw away six changes at once needs a confirmation nobody wants.
 *  - **Order is edited where the order lives.** The chosen fields are a list you
 *    move things up and down inside, not eight checkboxes with a separate
 *    ordering control somewhere else — in a details list the order *is* half the
 *    configuration.
 *
 * Name is offered like anything else, but when the caller says it is required
 * the row has no remove button. A file explorer that has stopped printing file
 * names is not a configuration anybody chose; see `parse` in
 * `@core/explorer/fields`, which puts it back if a hand-edited file drops it.
 */

import { FIELDS, parse, stringify, type FieldDef } from "@core/explorer/fields";

export interface FieldsPanelOptions {
  /** Sheet title — "Columns" or "Card details". */
  title: string;
  /** One line under the title saying what the list is for. */
  blurb: string;
  /** Name cannot be removed. True for the details list, false for a card. */
  requireName?: boolean;
  /** Current value. */
  read(): string;
  /** Called on every change, with the new comma-separated line. */
  write(next: string): void;
  /** Back to the shipped default. */
  reset(): void;
}

export class FieldsPanel {
  private readonly root: HTMLElement;
  private readonly titleEl = document.createElement("h2");
  private readonly blurbEl = document.createElement("p");
  private readonly chosenEl = document.createElement("div");
  private readonly restEl = document.createElement("div");
  private opts: FieldsPanelOptions | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "flds";
    this.root.hidden = true;

    const sheet = document.createElement("div");
    sheet.className = "flds-sheet";

    const head = document.createElement("div");
    head.className = "flds-head";
    this.titleEl.className = "flds-title";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "flds-x";
    close.textContent = "✕";
    close.title = "Close";
    close.addEventListener("click", () => this.close());

    head.append(this.titleEl, close);

    this.blurbEl.className = "flds-blurb";

    const body = document.createElement("div");
    body.className = "flds-body";
    this.chosenEl.className = "flds-chosen";

    const restLabel = document.createElement("h3");
    restLabel.className = "flds-group";
    restLabel.textContent = "Add";
    this.restEl.className = "flds-rest";

    body.append(this.chosenEl, restLabel, this.restEl);

    const foot = document.createElement("div");
    foot.className = "flds-foot";

    const hint = document.createElement("p");
    hint.className = "flds-hint";
    hint.textContent = "Changes show behind this window as you make them.";

    const back = document.createElement("button");
    back.type = "button";
    back.className = "flds-reset";
    back.textContent = "Put it back";
    back.addEventListener("click", () => {
      this.opts?.reset();
      this.sync();
    });

    foot.append(hint, back);
    sheet.append(head, this.blurbEl, body, foot);
    this.root.append(sheet);
    document.body.appendChild(this.root);

    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.close();
      }
    });
  }

  get element(): HTMLElement {
    return this.root;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Open on one setting. The same panel serves both — they are the same list. */
  open(opts: FieldsPanelOptions): void {
    this.opts = opts;
    this.titleEl.textContent = opts.title;
    this.blurbEl.textContent = opts.blurb;
    this.sync();
    this.root.hidden = false;
    this.root.querySelector<HTMLElement>("button")?.focus();
  }

  close(): void {
    this.root.hidden = true;
  }

  // ── contents ──────────────────────────────────────────────────────────────

  private chosen(): FieldDef[] {
    const o = this.opts;
    if (o === null) return [];
    return parse(o.read(), { requireName: o.requireName === true });
  }

  private commit(fields: readonly FieldDef[]): void {
    this.opts?.write(stringify(fields));
    this.sync();
  }

  private sync(): void {
    const o = this.opts;
    if (o === null) return;
    const chosen = this.chosen();
    const taken = new Set(chosen.map((f) => f.id));

    this.chosenEl.replaceChildren();
    chosen.forEach((f, i) => {
      this.chosenEl.appendChild(this.row(f, chosen, i, o.requireName === true));
    });

    this.restEl.replaceChildren();
    const rest = FIELDS.filter((f) => !taken.has(f.id));
    if (rest.length === 0) {
      const done = document.createElement("p");
      done.className = "flds-none";
      done.textContent = "Everything is already showing.";
      this.restEl.appendChild(done);
      return;
    }
    for (const f of rest) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "flds-add";
      b.dataset["field"] = f.id;
      b.textContent = `+ ${f.label}`;
      b.addEventListener("click", () => this.commit([...chosen, f]));
      this.restEl.appendChild(b);
    }
  }

  private row(f: FieldDef, chosen: FieldDef[], i: number, lockName: boolean): HTMLElement {
    const el = document.createElement("div");
    el.className = "flds-row";
    el.dataset["field"] = f.id;

    const label = document.createElement("span");
    label.className = "flds-label";
    label.textContent = f.label;

    const up = this.tick("▲", "Move up", i > 0, () => this.swap(chosen, i, i - 1));
    const down = this.tick("▼", "Move down", i < chosen.length - 1, () => this.swap(chosen, i, i + 1));

    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "flds-drop";
    drop.textContent = "✕";
    if (lockName && f.id === "name") {
      // Reserved rather than removed, so the row does not jump a control's width
      // narrower than every other row in the list.
      drop.hidden = true;
      drop.title = "The name always shows";
    } else {
      drop.title = `Remove ${f.label}`;
      drop.addEventListener("click", () => this.commit(chosen.filter((_, n) => n !== i)));
    }

    el.append(label, up, down, drop);
    return el;
  }

  private tick(glyph: string, title: string, live: boolean, run: () => void): HTMLElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "flds-move";
    b.textContent = glyph;
    b.title = title;
    b.disabled = !live;
    if (live) b.addEventListener("click", run);
    return b;
  }

  private swap(chosen: FieldDef[], a: number, b: number): void {
    const next = [...chosen];
    const hold = next[a]!;
    next[a] = next[b]!;
    next[b] = hold;
    this.commit(next);
  }
}
