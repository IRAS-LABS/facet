/**
 * The sidebar editor (item 38).
 *
 * Same shape as the column chooser in `fields-panel.ts`, and deliberately: this
 * is another ordered list of things, and a second way of editing an ordered list
 * would be a second set of habits to learn. Order is moved with the same ▲▼, a
 * row is dropped with the same ✕, and every click writes immediately — the
 * sidebar is on screen behind the sheet, so changing it is something you watch
 * happen rather than something you approve in advance.
 *
 * The one thing this has that the column chooser does not is a **Hidden**
 * section. A column you remove can always be added back from a list of every
 * column there is; a *place* you remove might be one the machine reported —
 * Pictures, a drive — and if hiding it just took it off screen there would be no
 * way back short of clearing the whole file. So a hidden discovered place stays
 * listed here, greyed, with one button to put it back.
 *
 * Renaming is a text field rather than a dialog, for the reason `filter-bar.ts`
 * spells out: `prompt()` returns null on WebView2, so anything that asked for a
 * name that way would silently never rename.
 */

import type { Place } from "@core/explorer/types";

export interface PlacesPanelOptions {
  /** The sidebar as it stands, resolved. Re-read after every change. */
  current(): Place[];
  /** Discovered places that are currently hidden. */
  hidden(): Place[];
  /** Where the explorer is, for the "Add the folder I am in" button. */
  cwd(): string;
  /** True when that folder is already a row — the button says so instead. */
  has(path: string): boolean;
  pin(path: string): void;
  remove(id: string): void;
  restore(id: string): void;
  rename(id: string, name: string): void;
  move(id: string, delta: number): void;
  reset(): void;
}

export class PlacesPanel {
  private readonly root: HTMLElement;
  private readonly listEl = document.createElement("div");
  private readonly hiddenWrap = document.createElement("div");
  private readonly hiddenEl = document.createElement("div");
  private readonly addBtn = document.createElement("button");
  private opts: PlacesPanelOptions | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "plcs";
    this.root.hidden = true;

    const sheet = document.createElement("div");
    sheet.className = "plcs-sheet";

    const head = document.createElement("div");
    head.className = "plcs-head";
    const title = document.createElement("h2");
    title.className = "plcs-title";
    title.textContent = "Places";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "plcs-x";
    close.textContent = "✕";
    close.title = "Close";
    close.addEventListener("click", () => this.close());
    head.append(title, close);

    const blurb = document.createElement("p");
    blurb.className = "plcs-blurb";
    blurb.textContent =
      "What the sidebar shows, and in what order. Drives stay together at the bottom under This PC.";

    const body = document.createElement("div");
    body.className = "plcs-body";
    this.listEl.className = "plcs-list";

    this.addBtn.type = "button";
    this.addBtn.className = "plcs-add";
    this.addBtn.addEventListener("click", () => {
      const o = this.opts;
      if (o === null) return;
      o.pin(o.cwd());
      this.sync();
    });

    const hiddenLabel = document.createElement("h3");
    hiddenLabel.className = "plcs-group";
    hiddenLabel.textContent = "Hidden";
    this.hiddenEl.className = "plcs-hidden";
    this.hiddenWrap.className = "plcs-hidden-wrap";
    this.hiddenWrap.append(hiddenLabel, this.hiddenEl);

    body.append(this.listEl, this.addBtn, this.hiddenWrap);

    const foot = document.createElement("div");
    foot.className = "plcs-foot";
    const hint = document.createElement("p");
    hint.className = "plcs-hint";
    hint.textContent = "The sidebar changes behind this window as you edit it.";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "plcs-reset";
    back.textContent = "Put it back";
    back.title = "Forget every pin, rename and reorder";
    back.addEventListener("click", () => {
      this.opts?.reset();
      this.sync();
    });
    foot.append(hint, back);

    sheet.append(head, blurb, body, foot);
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

  open(opts: PlacesPanelOptions): void {
    this.opts = opts;
    this.sync();
    this.root.hidden = false;
    this.root.querySelector<HTMLElement>(".plcs-name")?.focus();
  }

  close(): void {
    this.root.hidden = true;
  }

  /** Redraw from the host. Public so the shell can call it after a pin. */
  sync(): void {
    const o = this.opts;
    if (o === null) return;

    const current = o.current();
    const drives = current.filter((p) => p.icon === "drive");
    const folders = current.filter((p) => p.icon !== "drive");

    this.listEl.replaceChildren();
    folders.forEach((p, i) => this.listEl.appendChild(this.row(p, i, folders.length)));
    if (drives.length > 0) {
      const head = document.createElement("h3");
      head.className = "plcs-group";
      head.textContent = "This PC";
      this.listEl.appendChild(head);
      drives.forEach((p, i) => this.listEl.appendChild(this.row(p, i, drives.length)));
    }

    const here = o.cwd();
    const already = o.has(here);
    this.addBtn.disabled = already || here.trim() === "";
    this.addBtn.textContent = already
      ? `${here} is already here`
      : `+ Add the folder I am in — ${here}`;

    const hidden = o.hidden();
    this.hiddenWrap.hidden = hidden.length === 0;
    this.hiddenEl.replaceChildren();
    for (const p of hidden) {
      const row = document.createElement("div");
      row.className = "plcs-row";
      row.dataset["place"] = p.id;
      const label = document.createElement("span");
      label.className = "plcs-gone";
      label.textContent = p.name;
      label.title = p.path ?? p.id;
      const put = document.createElement("button");
      put.type = "button";
      put.className = "plcs-put";
      put.textContent = "Put back";
      put.addEventListener("click", () => {
        o.restore(p.id);
        this.sync();
      });
      row.append(label, put);
      this.hiddenEl.append(row);
    }
  }

  // ── contents ──────────────────────────────────────────────────────────────

  private row(p: Place, i: number, of: number): HTMLElement {
    const o = this.opts!;
    const el = document.createElement("div");
    el.className = "plcs-row";
    el.dataset["place"] = p.id;

    const name = document.createElement("input");
    name.type = "text";
    name.className = "plcs-name";
    name.value = p.name;
    name.spellcheck = false;
    name.title = p.path ?? p.id;
    // On change rather than on input: renaming redraws the sidebar, and doing
    // that per keystroke would take the caret out of the field being typed in.
    name.addEventListener("change", () => {
      o.rename(p.id, name.value);
      this.sync();
    });
    name.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") name.blur();
    });

    const up = this.tick("▲", "Move up", i > 0, () => {
      o.move(p.id, -1);
      this.sync();
    });
    const down = this.tick("▼", "Move down", i < of - 1, () => {
      o.move(p.id, 1);
      this.sync();
    });

    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "plcs-drop";
    drop.textContent = "✕";
    drop.title = `Take ${p.name} out of the sidebar`;
    drop.addEventListener("click", () => {
      o.remove(p.id);
      this.sync();
    });

    el.append(name, up, down, drop);
    return el;
  }

  private tick(glyph: string, title: string, live: boolean, run: () => void): HTMLElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "plcs-move";
    b.textContent = glyph;
    b.title = title;
    b.disabled = !live;
    if (live) b.addEventListener("click", run);
    return b;
  }
}
