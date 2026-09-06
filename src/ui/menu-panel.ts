/**
 * The context-menu builder (item 39).
 *
 * Two lists in one sheet, because they are two halves of one question. The top
 * half is the menu itself — which rows, in which order — and the bottom half is
 * the actions you wrote, which are just more rows the top half can name.
 *
 * The same rules as the column chooser it deliberately resembles: every click
 * writes, there is no OK button, and the thing being configured is visible
 * behind the sheet. Two differences the subject forced:
 *
 *  - **A row can name a command that is not available right now.** The menu is
 *    a preference over a list that changes with the selection, so a line that
 *    says `video.edit` is perfectly valid while you are looking at a
 *    spreadsheet. Such a row is drawn dimmed and still removable — hiding it
 *    would leave the user unable to delete something they can see the effect
 *    of.
 *  - **Actions are edited as text fields, saved on every keystroke.** Filling
 *    one in means going and finding the path of a program, which means closing
 *    this; an editor that discarded a half-typed action for being incomplete
 *    would be one nobody finished using. `problemWith` decides whether it is
 *    *offered*, not whether it is *kept*.
 */

import { commandIdFor, problemWith, TOKENS, type UserAction } from "@core/explorer/actions";
import {
  parseMenu,
  REST,
  restOfGroup,
  SEP,
  stringifyMenu,
  wildcardGroup,
} from "@core/explorer/menu";
import type { FileKind } from "@core/explorer/types";

/** Kinds offered as filters, in the order a person thinks of them. */
const KINDS: ReadonlyArray<readonly [FileKind, string]> = [
  ["image", "pictures"],
  ["video", "videos"],
  ["audio", "audio"],
  ["document", "documents"],
  ["tabular", "tables"],
  ["model3d", "3D"],
  ["archive", "archives"],
  ["code", "code"],
  ["folder", "folders"],
  ["binary", "everything else"],
];

export interface MenuPanelOptions {
  /** The stored line. */
  read(): string;
  /** Called on every change. */
  write(next: string): void;
  /** Back to the shipped menu. */
  reset(): void;
  /** Every command on offer for the current selection — titles come from here. */
  catalogue(): ReadonlyArray<{ id: string; title: string; group: string }>;
  /** The user's own actions. */
  actions(): readonly UserAction[];
  addAction(): UserAction;
  updateAction(id: string, patch: Partial<Omit<UserAction, "id">>): void;
  removeAction(id: string): void;
  moveAction(id: string, delta: number): void;
}

export class MenuPanel {
  private readonly root: HTMLElement;
  private readonly chosenEl = document.createElement("div");
  private readonly restEl = document.createElement("div");
  private readonly actionsEl = document.createElement("div");
  private opts: MenuPanelOptions | null = null;
  /** Which action row is expanded. Only one at a time — see `sync`. */
  private editing: string | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "mnu";
    this.root.hidden = true;

    const sheet = document.createElement("div");
    sheet.className = "mnu-sheet";

    const head = document.createElement("div");
    head.className = "mnu-head";
    const title = document.createElement("h2");
    title.className = "mnu-title";
    title.textContent = "Right-click menu";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "mnu-x";
    close.textContent = "✕";
    close.title = "Close";
    close.addEventListener("click", () => this.close());
    head.append(title, close);

    const blurb = document.createElement("p");
    blurb.className = "mnu-blurb";
    blurb.textContent =
      "What appears when you right-click a file, top to bottom. Anything that does not apply to what you clicked drops out on its own.";

    const body = document.createElement("div");
    body.className = "mnu-body";
    this.chosenEl.className = "mnu-list";

    const restHead = document.createElement("h3");
    restHead.className = "mnu-sub";
    restHead.textContent = "Add a row";
    this.restEl.className = "mnu-list mnu-rest";

    const actHead = document.createElement("h3");
    actHead.className = "mnu-sub";
    actHead.textContent = "Your own actions";
    const actBlurb = document.createElement("p");
    actBlurb.className = "mnu-blurb";
    actBlurb.textContent =
      "Run any program on what you have selected. These become ordinary commands — they show up in the menu above and in Ctrl+K.";
    this.actionsEl.className = "mnu-list";

    const add = document.createElement("button");
    add.type = "button";
    add.className = "mnu-add";
    add.textContent = "+ New action";
    add.addEventListener("click", () => {
      const made = this.opts?.addAction();
      if (made !== undefined) this.editing = made.id;
      this.sync();
    });

    body.append(
      this.chosenEl,
      restHead,
      this.restEl,
      actHead,
      actBlurb,
      this.actionsEl,
      add,
    );

    const foot = document.createElement("div");
    foot.className = "mnu-foot";
    const hint = document.createElement("span");
    hint.className = "mnu-hint";
    hint.textContent = "Saved as you go.";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "mnu-reset";
    reset.textContent = "↺ Shipped menu";
    reset.title = "Put the menu back the way it came. Your actions are kept.";
    reset.addEventListener("click", () => {
      this.opts?.reset();
      this.sync();
    });
    foot.append(hint, reset);

    sheet.append(head, blurb, body, foot);
    this.root.append(sheet);
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });
    document.body.appendChild(this.root);
  }

  get element(): HTMLElement {
    return this.root;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(opts: MenuPanelOptions): void {
    this.opts = opts;
    this.root.hidden = false;
    this.sync();
  }

  close(): void {
    this.root.hidden = true;
    this.opts = null;
    this.editing = null;
  }

  /** Redraw from the store. Public so the shell can call it after a change. */
  sync(): void {
    const o = this.opts;
    if (o === null) return;

    const ids = parseMenu(o.read());
    const catalogue = o.catalogue();
    const byId = new Map(catalogue.map((c) => [c.id, c]));
    const actions = o.actions();
    for (const a of actions) {
      // An action the current selection does not qualify for is still a row the
      // menu can name, so the builder has to know its title even when
      // `catalogue()` — which is filtered by selection — has left it out.
      const id = commandIdFor(a);
      if (!byId.has(id)) {
        byId.set(id, { id, title: a.label.trim() || "(unnamed action)", group: "Yours" });
      }
    }

    // ── the menu ──
    this.chosenEl.replaceChildren();
    ids.forEach((id, i) => {
      this.chosenEl.append(this.menuRow(id, i, ids, byId));
    });
    if (ids.length === 0) {
      const empty = document.createElement("p");
      empty.className = "mnu-none";
      empty.textContent = "Nothing chosen — the menu will show everything.";
      this.chosenEl.append(empty);
    }

    // ── what can be added ──
    this.restEl.replaceChildren();
    const already = new Set(ids);
    const addable = [...byId.values()].filter((c) => !already.has(c.id));
    for (const cmd of addable) {
      this.restEl.append(this.addRow(cmd.id, `${cmd.group} · ${cmd.title}`, ids));
    }
    this.restEl.append(this.addRow(SEP, "A dividing line", ids, true));
    // A group before the bare `*`, because a group is almost always what is
    // wanted: `*` on a right-click is the whole palette, themes and all.
    const groups: string[] = [];
    for (const c of byId.values()) if (!groups.includes(c.group)) groups.push(c.group);
    for (const group of groups) {
      const id = restOfGroup(group);
      if (already.has(id)) continue;
      this.restEl.append(this.addRow(id, `Everything else in ${group}`, ids));
    }
    if (!already.has(REST)) {
      this.restEl.append(
        this.addRow(REST, "Everything else, in its own order", ids),
      );
    }

    // ── your actions ──
    this.actionsEl.replaceChildren();
    for (const a of actions) this.actionsEl.append(this.actionRow(a, actions));
    if (actions.length === 0) {
      const none = document.createElement("p");
      none.className = "mnu-none";
      none.textContent = "None yet.";
      this.actionsEl.append(none);
    }
  }

  // ── internals ──

  private commit(ids: readonly string[]): void {
    this.opts?.write(stringifyMenu(ids));
    this.sync();
  }

  private menuRow(
    id: string,
    i: number,
    ids: readonly string[],
    byId: ReadonlyMap<string, { title: string; group: string }>,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "mnu-row";
    row.dataset["id"] = id;

    const name = document.createElement("span");
    name.className = "mnu-name";
    if (id === SEP) {
      row.dataset["sep"] = "true";
      name.textContent = "———";
    } else if (id === REST) {
      name.textContent = "Everything else";
      row.title = "Every command on offer that is not named above — the whole palette.";
    } else if (wildcardGroup(id) !== null) {
      name.textContent = `Everything else in ${wildcardGroup(id) ?? ""}`;
      row.title = "Anything in that group not named above, including commands added in a later version.";
    } else {
      const cmd = byId.get(id);
      if (cmd === undefined) {
        // Not on offer for what is selected right now — or a command that no
        // longer exists. Either way it is shown rather than quietly dropped, or
        // the line would be uneditable.
        row.dataset["off"] = "true";
        name.textContent = id;
        row.title = "Not offered for what is selected right now.";
      } else {
        name.textContent = cmd.title;
      }
    }
    row.append(name);

    row.append(
      this.tick("▲", "Move up", i > 0, () => {
        const next = [...ids];
        const [it] = next.splice(i, 1);
        if (it !== undefined) next.splice(i - 1, 0, it);
        this.commit(next);
      }),
      this.tick("▼", "Move down", i < ids.length - 1, () => {
        const next = [...ids];
        const [it] = next.splice(i, 1);
        if (it !== undefined) next.splice(i + 1, 0, it);
        this.commit(next);
      }),
      this.tick("✕", "Take out of the menu", true, () => {
        const next = [...ids];
        next.splice(i, 1);
        this.commit(next);
      }),
    );
    return row;
  }

  private addRow(
    id: string,
    label: string,
    ids: readonly string[],
    always = false,
  ): HTMLElement {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "mnu-addrow";
    row.dataset["id"] = id;
    row.textContent = label;
    if (always) row.dataset["sep"] = "true";
    row.addEventListener("click", () => this.commit([...ids, id]));
    return row;
  }

  private tick(glyph: string, title: string, live: boolean, run: () => void): HTMLElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mnu-tick";
    b.textContent = glyph;
    b.title = title;
    b.disabled = !live;
    if (live) b.addEventListener("click", run);
    return b;
  }

  private actionRow(a: UserAction, all: readonly UserAction[]): HTMLElement {
    const o = this.opts;
    const wrap = document.createElement("div");
    wrap.className = "mnu-act";
    wrap.dataset["id"] = a.id;

    const head = document.createElement("div");
    head.className = "mnu-row";

    const name = document.createElement("button");
    name.type = "button";
    name.className = "mnu-actname";
    name.textContent = a.label.trim() || "(unnamed)";
    const bad = problemWith(a);
    if (bad !== null) {
      head.dataset["off"] = "true";
      name.title = bad;
    }
    name.addEventListener("click", () => {
      this.editing = this.editing === a.id ? null : a.id;
      this.sync();
    });
    head.append(name);

    const i = all.indexOf(a);
    head.append(
      this.tick("▲", "Move up", i > 0, () => {
        o?.moveAction(a.id, -1);
        this.sync();
      }),
      this.tick("▼", "Move down", i < all.length - 1, () => {
        o?.moveAction(a.id, 1);
        this.sync();
      }),
      this.tick("✕", "Delete this action", true, () => {
        o?.removeAction(a.id);
        if (this.editing === a.id) this.editing = null;
        this.sync();
      }),
    );
    wrap.append(head);

    if (this.editing !== a.id) return wrap;

    const form = document.createElement("div");
    form.className = "mnu-form";

    form.append(
      this.field("Name", a.label, "What the menu row says", (v) => {
        o?.updateAction(a.id, { label: v });
        name.textContent = v.trim() || "(unnamed)";
      }),
      this.field("Program", a.program, "7z.exe  ·  C:/tools/thing.exe", (v) => {
        o?.updateAction(a.id, { program: v });
      }),
      // Redrawn on `change` rather than on every keystroke: the problem line
      // below reads the args, and redrawing from an `input` handler would put
      // the caret back at the end of the box on every character typed.
      this.field("Arguments", a.args, "a {stem}.zip {paths}", (v) => {
        o?.updateAction(a.id, { args: v });
      }, () => this.sync()),
    );

    const tokens = document.createElement("p");
    tokens.className = "mnu-tokens";
    tokens.textContent = TOKENS.map(([t, what]) => `{${t}} ${what}`).join("  ·  ");
    form.append(tokens);

    // Kinds
    const kinds = document.createElement("div");
    kinds.className = "mnu-kinds";
    const kindsLabel = document.createElement("span");
    kindsLabel.className = "mnu-flabel";
    kindsLabel.textContent = "Offer it for";
    kinds.append(kindsLabel);
    for (const [kind, label] of KINDS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mnu-kind";
      b.textContent = label;
      if (a.kinds.includes(kind)) b.dataset["on"] = "true";
      b.addEventListener("click", () => {
        const next = a.kinds.includes(kind)
          ? a.kinds.filter((k) => k !== kind)
          : [...a.kinds, kind];
        o?.updateAction(a.id, { kinds: next });
        this.sync();
      });
      kinds.append(b);
    }
    const anyNote = document.createElement("span");
    anyNote.className = "mnu-hint";
    anyNote.textContent = a.kinds.length === 0 ? "anything" : "";
    kinds.append(anyNote);
    form.append(kinds);

    // Each vs once
    const each = document.createElement("div");
    each.className = "mnu-kinds";
    const eachLabel = document.createElement("span");
    eachLabel.className = "mnu-flabel";
    eachLabel.textContent = "With several selected";
    each.append(eachLabel);
    for (const [on, label, why] of [
      [true, "run it once per file", "One process per file. {path} is that file."],
      [false, "run it once for all of them", "One process. {paths} is every file."],
    ] as ReadonlyArray<readonly [boolean, string, string]>) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mnu-kind";
      b.textContent = label;
      b.title = why;
      if (a.each === on) b.dataset["on"] = "true";
      b.addEventListener("click", () => {
        o?.updateAction(a.id, { each: on });
        this.sync();
      });
      each.append(b);
    }
    form.append(each);

    if (bad !== null) {
      const problem = document.createElement("p");
      problem.className = "mnu-problem";
      problem.textContent = bad;
      form.append(problem);
    } else {
      const ok = document.createElement("p");
      ok.className = "mnu-ok";
      ok.textContent = `Offered in the menu as “${a.label.trim()}”. Add it above to pin it to a position.`;
      form.append(ok);
    }

    wrap.append(form);
    return wrap;
  }

  private field(
    label: string,
    value: string,
    placeholder: string,
    write: (v: string) => void,
    settled?: () => void,
  ): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "mnu-field";
    const span = document.createElement("span");
    span.className = "mnu-flabel";
    span.textContent = label;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "mnu-input";
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    // On `input`, so the work is saved the moment it is typed — and the row is
    // never redrawn from an `input` handler, or the caret would jump to the end
    // on every character. Anything that needs a redraw does it in `change`.
    input.addEventListener("input", () => write(input.value));
    if (settled !== undefined) input.addEventListener("change", settled);
    // The shell's single-key shortcuts would otherwise fire while typing a path.
    input.addEventListener("keydown", (e) => e.stopPropagation());
    wrap.append(span, input);
    return wrap;
  }
}
