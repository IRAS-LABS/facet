/**
 * The settings surface (item 33).
 *
 * One sheet, every preference, searchable. The controls are *generated from the
 * declarations* in `core/settings/registry.ts` — there is no hand-written form
 * here and there must never be one, because the moment a screen is hand-built
 * it starts to drift from the thing it configures. Items 35, 36, 37 and 39–43
 * are each a few more declarations plus their reader; none of them touch this
 * file.
 *
 * Two things this file does own, because they are presentation and not data:
 *
 * **Contributed rows.** Some configurable things are richer than a boolean, a
 * number or a string, and already persist themselves — the theme engine is the
 * clear case. Mirroring those into the settings store would give them two
 * sources of truth. Instead their owner hands the panel a row to render
 * (`addCustom`), so "everything configurable in one place" holds without the
 * store having to pretend a theme is a scalar.
 *
 * **Numbers get −/+ buttons, not a slider.** Asked for directly, and correctly:
 * a slider on a range of 90–420 moves 5 px per pixel of travel, so it can be
 * nudged but never *set*, and grabbing it on a touchscreen means covering the
 * number you are trying to read. The field takes a typed value; the buttons
 * take one step.
 */

import { matches, type Setting } from "@core/settings/schema";
import { settings as globalStore, type SettingsStore } from "@core/settings/store";
import type { SettingValue } from "@core/settings/schema";

/**
 * Reading and writing the settings *file* (item 42).
 *
 * Supplied by the app rather than reached for here, because the panel must
 * still work in a plain page with no filesystem behind it — that is how it is
 * tested — and because "where does a save land" is a question about the folder
 * the user is looking at, which the panel has no business knowing.
 */
export interface BackupFile {
  /** Where a save would go, given where the user currently is. */
  suggest(): string;
  /** Writes it. Returns the path actually used, which may be stepped. */
  save(path: string, text: string): Promise<string>;
  /** The file the user has pointed at, or null. */
  pick(): string | null;
  load(path: string): Promise<string>;
}

/** A row an owner renders itself. See the note above. */
export interface CustomRow {
  group: string;
  label: string;
  help?: string;
  keywords?: readonly string[];
  /** Built once when the panel first opens. */
  control(): HTMLElement;
  /**
   * Re-read the current state into the control, called whenever the
   * panel refreshes. Needed because the same thing can be changed from
   * elsewhere while the panel is open — the theme has a second picker in the
   * top bar — and a control showing a value that is no longer live is worse
   * than no control.
   */
  sync?(control: HTMLElement): void;
  /** Whether it differs from its own idea of default, for the changed dot. */
  changed?(): boolean;
  /** Put it back. Omit if it has no meaningful default. */
  reset?(): void;
}

interface Row {
  el: HTMLElement;
  group: string;
  /** Re-read the current value into the control. */
  sync(): void;
  /** Does this row match the search box? */
  hit(query: string): boolean;
}

export class SettingsPanel {
  private readonly root: HTMLElement;
  private readonly search = document.createElement("input");
  private readonly body = document.createElement("div");
  private readonly nav = document.createElement("div");
  private readonly backup = document.createElement("textarea");
  private readonly backupNote = document.createElement("p");

  private readonly rows: Row[] = [];
  private readonly sections = new Map<string, HTMLElement>();
  private readonly customs: CustomRow[] = [];
  private readonly actions = new Map<string, { label: string; run: () => void }[]>();
  private readonly fileButtons: HTMLElement[] = [];
  private files: BackupFile | undefined;
  private built = false;

  constructor(private readonly store: SettingsStore = globalStore) {
    this.root = document.createElement("div");
    this.root.className = "prefs";
    this.root.hidden = true;

    const sheet = document.createElement("div");
    sheet.className = "prefs-sheet";

    // ── head ──
    const head = document.createElement("div");
    head.className = "prefs-head";

    const title = document.createElement("h2");
    title.className = "prefs-title";
    title.textContent = "Settings";

    this.search.className = "prefs-search";
    this.search.type = "search";
    this.search.placeholder = "Search every setting…";
    this.search.spellcheck = false;
    this.search.setAttribute("aria-label", "Search settings");
    this.search.addEventListener("input", () => this.filter());

    const close = document.createElement("button");
    close.type = "button";
    close.className = "prefs-x";
    close.textContent = "✕";
    close.title = "Close settings";
    close.addEventListener("click", () => this.close());

    head.append(title, this.search, close);

    // ── body ──
    this.nav.className = "prefs-nav";
    this.body.className = "prefs-body";

    const middle = document.createElement("div");
    middle.className = "prefs-middle";
    middle.append(this.nav, this.body);

    // ── foot ──
    const foot = document.createElement("div");
    foot.className = "prefs-foot";

    const resetAll = document.createElement("button");
    resetAll.type = "button";
    resetAll.className = "prefs-btn prefs-danger";
    resetAll.textContent = "Reset everything";
    resetAll.addEventListener("click", () => {
      this.store.resetAll();
      for (const c of this.customs) c.reset?.();
      this.syncAll();
    });

    const backupToggle = document.createElement("button");
    backupToggle.type = "button";
    backupToggle.className = "prefs-btn";
    backupToggle.textContent = "Backup…";
    backupToggle.addEventListener("click", () => {
      const showing = backupWrap.hidden;
      backupWrap.hidden = !showing;
      if (showing) {
        this.backup.value = this.store.export();
        this.backupNote.textContent = this.files
          ? `Save writes ${this.files.suggest()}. Load reads whichever file is selected in the explorer.`
          : "Copy this somewhere, or paste one in and apply it.";
        this.backup.focus();
        this.backup.select();
      }
    });

    foot.append(backupToggle, resetAll);

    /*
     * Import/export is a text box rather than a file dialog on purpose. It is
     * the same on the desktop and on Android, it needs no permission and no
     * bridge, and — the actual reason — the thing being moved is a few hundred
     * bytes of JSON that a person can read. A file picker can be added on top of
     * this later without changing the store; a store that only spoke to a file
     * picker could not have been used from the harness at all.
     */
    const backupWrap = document.createElement("div");
    backupWrap.className = "prefs-backup";
    backupWrap.hidden = true;

    this.backup.className = "prefs-json";
    this.backup.spellcheck = false;
    this.backup.rows = 6;
    this.backupNote.className = "prefs-note";

    const backupRow = document.createElement("div");
    backupRow.className = "prefs-backup-row";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "prefs-btn";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      this.backup.value = this.store.export();
      this.backup.select();
      void navigator.clipboard?.writeText(this.backup.value).then(
        () => { this.backupNote.textContent = "Copied."; },
        // Clipboard permission can be refused; the text is selected either way,
        // so ctrl+C still works and saying so beats a silent nothing.
        () => { this.backupNote.textContent = "Selected — press ctrl+C."; },
      );
    });

    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "prefs-btn";
    apply.textContent = "Apply";
    apply.addEventListener("click", () => {
      const r = this.store.import(this.backup.value);
      this.backupNote.textContent = r.ok
        ? `Applied ${r.applied} setting${r.applied === 1 ? "" : "s"}` +
          (r.skipped > 0 ? `, kept ${r.skipped} this build does not know about.` : ".")
        : "That is not a settings file — nothing was changed.";
      this.syncAll();
    });

    /*
     * The file half of item 42, added only when the app has given the panel a
     * way to reach a disk. It saves into the folder you are standing in and
     * loads whatever you have selected, rather than opening a file dialog: the
     * explorer is already the file picker, and a second one inside it would be
     * a worse copy of the window it is sitting on top of.
     */
    const save = document.createElement("button");
    save.type = "button";
    save.className = "prefs-btn prefs-file";
    save.textContent = "Save a file";
    save.addEventListener("click", () => {
      const io = this.files;
      if (!io) return;
      const target = io.suggest();
      void io.save(target, this.store.export()).then(
        (written) => { this.backupNote.textContent = `Saved to ${written}`; },
        (err: unknown) => { this.backupNote.textContent = `Could not save: ${String(err)}`; },
      );
    });

    const load = document.createElement("button");
    load.type = "button";
    load.className = "prefs-btn prefs-file";
    load.textContent = "Load a file";
    load.addEventListener("click", () => {
      const io = this.files;
      if (!io) return;
      const from = io.pick();
      if (from === null) {
        // Naming the missing step beats a disabled button with no explanation.
        this.backupNote.textContent =
          "Select a settings file in the explorer first, then come back here.";
        return;
      }
      void io.load(from).then(
        (text) => {
          this.backup.value = text;
          const r = this.store.import(text);
          this.backupNote.textContent = r.ok
            ? `Loaded ${r.applied} setting${r.applied === 1 ? "" : "s"} from ${from}`
            : `${from} is not a settings file — nothing was changed.`;
          this.syncAll();
        },
        (err: unknown) => { this.backupNote.textContent = `Could not read it: ${String(err)}`; },
      );
    });

    this.fileButtons.push(save, load);
    for (const b of this.fileButtons) b.hidden = true;

    backupRow.append(copy, apply, save, load);
    backupWrap.append(this.backup, backupRow, this.backupNote);

    sheet.append(head, middle, backupWrap, foot);
    this.root.append(sheet);
    document.body.appendChild(this.root);

    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });

    // A setting can also be changed from the palette or a keyboard shortcut
    // while the sheet is open. Keeping the controls in step is what makes the
    // panel a view of the settings rather than a second copy of them.
    this.store.onAny(() => {
      if (!this.root.hidden) this.syncAll();
    });
  }

  /**
   * Contribute a row. Must be called before the first `open()` — rows are built
   * once, and an owner that has not loaded by the time the user opens settings
   * has not loaded at all.
   */
  addCustom(row: CustomRow): void {
    this.customs.push(row);
  }

  /**
   * Hang an extra button off a declared row — "use the folder I am in" next to
   * a path field, and anything item 35 or 39 wants later.
   *
   * Here rather than in the declaration because the useful actions all need
   * something the registry cannot see: the current folder, the selection, the
   * live theme. The declaration stays data; the app supplies the verb.
   */
  addAction(id: string, label: string, run: () => void): void {
    const list = this.actions.get(id) ?? [];
    list.push({ label, run });
    this.actions.set(id, list);
  }

  /** Give the panel a disk. Without one the backup box is copy-and-paste only. */
  useFiles(io: BackupFile): void {
    this.files = io;
    for (const b of this.fileButtons) b.hidden = false;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    if (!this.built) this.build();
    this.root.hidden = false;
    this.search.value = "";
    this.filter();
    this.syncAll();
    this.search.focus();
  }

  close(): void {
    this.root.hidden = true;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** The sheet, for tests that want to look inside without a real window. */
  get element(): HTMLElement {
    return this.root;
  }

  // ── building ──────────────────────────────────────────────────────────────

  private build(): void {
    this.built = true;

    const order = this.store.groups();
    for (const c of this.customs) if (!order.includes(c.group)) order.push(c.group);

    for (const group of order) {
      const section = document.createElement("section");
      section.className = "prefs-section";
      section.dataset["group"] = group;

      const header = document.createElement("div");
      header.className = "prefs-section-head";

      const h = document.createElement("h3");
      h.className = "prefs-group";
      h.textContent = group;
      h.id = `prefs-g-${slug(group)}`;

      // Per-group reset, next to the group it resets. A single "reset
      // everything" is too blunt to use: having spent an hour on the previews
      // you should be able to put the explorer back without losing them.
      const wipe = document.createElement("button");
      wipe.type = "button";
      wipe.className = "prefs-wipe";
      wipe.textContent = "Reset group";
      wipe.addEventListener("click", () => {
        this.store.resetGroup(group);
        for (const c of this.customs) if (c.group === group) c.reset?.();
        this.syncAll();
      });

      header.append(h, wipe);
      section.append(header);
      this.body.append(section);
      this.sections.set(group, section);

      const link = document.createElement("button");
      link.type = "button";
      link.className = "prefs-navlink";
      link.textContent = group;
      link.addEventListener("click", () => {
        section.scrollIntoView({ block: "start", behavior: "smooth" });
      });
      this.nav.append(link);
    }

    for (const def of this.store.all()) {
      const row = this.buildRow(def);
      this.rows.push(row);
      this.sections.get(def.group)?.append(row.el);
    }
    for (const c of this.customs) {
      const row = this.buildCustom(c);
      this.rows.push(row);
      this.sections.get(c.group)?.append(row.el);
    }
  }

  /** The label / help / changed-dot / reset scaffold every row shares. */
  private shell(
    label: string,
    help: string | undefined,
    control: HTMLElement,
    onReset: (() => void) | undefined,
  ): { el: HTMLElement; mark(changed: boolean): void } {
    const el = document.createElement("div");
    el.className = "prefs-row";

    const text = document.createElement("div");
    text.className = "prefs-text";

    const name = document.createElement("label");
    name.className = "prefs-label";
    name.textContent = label;

    text.append(name);
    if (help !== undefined && help !== "") {
      const p = document.createElement("p");
      p.className = "prefs-help";
      p.textContent = help;
      text.append(p);
    }

    const right = document.createElement("div");
    right.className = "prefs-control";
    right.append(control);

    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "prefs-undo";
    undo.textContent = "↺";
    undo.title = "Back to the default";
    undo.hidden = true;
    if (onReset) undo.addEventListener("click", onReset);
    right.append(undo);

    /* Tie the label to whatever control this turned out to be. `for` needs an
       id, and generating one per setting is noise, so the label wraps focus
       instead — clicking it focuses the control the same way. */
    name.addEventListener("click", () => {
      const focusable = control.matches("input, select, button")
        ? control
        : control.querySelector<HTMLElement>("input, select, button");
      focusable?.focus();
    });

    el.append(text, right);
    return {
      el,
      mark: (changed) => {
        el.dataset["changed"] = changed ? "true" : "false";
        undo.hidden = !changed || !onReset;
      },
    };
  }

  private buildRow(def: Setting): Row {
    const { control, sync } = this.control(def);
    const { el, mark } = this.shell(def.label, def.help, control, () => {
      this.store.reset(def.id);
      this.syncAll();
    });
    // Between the control and the undo arrow, so the arrow stays the rightmost
    // thing in every row.
    const slot = el.querySelector(".prefs-control");
    const undo = el.querySelector(".prefs-undo");
    for (const a of this.actions.get(def.id) ?? []) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "prefs-btn prefs-action";
      b.textContent = a.label;
      b.addEventListener("click", () => {
        a.run();
        this.syncAll();
      });
      slot?.insertBefore(b, undo);
    }
    if (def.restart === true) {
      const flag = document.createElement("span");
      flag.className = "prefs-restart";
      flag.textContent = "needs a restart";
      el.querySelector(".prefs-text")?.append(flag);
    }
    return {
      el,
      group: def.group,
      sync: () => {
        sync();
        mark(this.store.isSet(def.id));
      },
      hit: (q) => matches(def, q),
    };
  }

  private buildCustom(c: CustomRow): Row {
    const control = c.control();
    const { el, mark } = this.shell(
      c.label,
      c.help,
      control,
      c.reset
        ? () => {
            c.reset?.();
            this.syncAll();
          }
        : undefined,
    );
    const hay = [c.label, c.help ?? "", c.group, ...(c.keywords ?? [])].join(" ").toLowerCase();
    return {
      el,
      group: c.group,
      sync: () => {
        c.sync?.(control);
        mark(c.changed?.() ?? false);
      },
      hit: (q) => {
        const t = q.trim().toLowerCase();
        return t === "" || t.split(/\s+/).every((w) => hay.includes(w));
      },
    };
  }

  /** One control per kind. The only place a `kind` is switched on. */
  private control(def: Setting): { control: HTMLElement; sync: () => void } {
    switch (def.kind) {
      case "toggle": {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "prefs-toggle";
        b.setAttribute("role", "switch");
        b.addEventListener("click", () => {
          this.store.set(def.id, !this.store.get<boolean>(def.id));
          this.syncAll();
        });
        return {
          control: b,
          sync: () => {
            const on = this.store.get<boolean>(def.id);
            b.setAttribute("aria-checked", String(on));
            b.dataset["on"] = String(on);
            b.textContent = on ? "On" : "Off";
          },
        };
      }

      case "number": {
        const wrap = document.createElement("div");
        wrap.className = "prefs-num";

        const step = def.step ?? 1;
        const nudge = (dir: number): void => {
          this.store.set(def.id, this.store.get<number>(def.id) + dir * step);
          this.syncAll();
        };

        const minus = stepper("−", `−${step}`, () => nudge(-1));
        const plus = stepper("+", `+${step}`, () => nudge(1));

        const input = document.createElement("input");
        input.type = "number";
        input.className = "prefs-field";
        input.min = String(def.min);
        input.max = String(def.max);
        input.step = String(step);
        // `change`, not `input`: typing "190" passes through "1" and "19", and
        // committing those would clamp the field to the minimum under the
        // user's fingers and leave them typing into a value they never chose.
        input.addEventListener("change", () => {
          const n = Number(input.value);
          // An empty or unparseable field is someone mid-edit, not a request
          // for zero — put the real value back rather than storing NaN.
          if (input.value.trim() === "" || !Number.isFinite(n)) this.syncAll();
          else {
            this.store.set(def.id, n);
            this.syncAll();
          }
        });

        // The unit belongs to the number, so it sits against the field rather
        // than after the + button. Rendered even when there is no unit, so the
        // fields of every number row line up in one column.
        const unit = document.createElement("span");
        unit.className = "prefs-unit";
        unit.textContent = def.unit ?? "";
        wrap.append(minus, input, unit, plus);

        return {
          control: wrap,
          sync: () => {
            const v = this.store.get<number>(def.id);
            // Never overwrite a field being typed into.
            if (document.activeElement !== input) input.value = String(v);
            minus.disabled = v <= def.min;
            plus.disabled = v >= def.max;
          },
        };
      }

      case "choice": {
        const sel = document.createElement("select");
        sel.className = "prefs-select";
        for (const [value, label] of def.choices) {
          const opt = document.createElement("option");
          opt.value = value;
          opt.textContent = label;
          sel.append(opt);
        }
        sel.addEventListener("change", () => {
          this.store.set(def.id, sel.value);
          this.syncAll();
        });
        return {
          control: sel,
          sync: () => {
            sel.value = this.store.get<string>(def.id);
          },
        };
      }

      case "text": {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "prefs-field prefs-text-field";
        if (def.placeholder !== undefined) input.placeholder = def.placeholder;
        // Live, unlike the number field: a half-typed string is a valid string,
        // and watching the font change as you type it is the point.
        input.addEventListener("input", () => {
          this.store.set(def.id, input.value);
          this.syncAll();
        });
        return {
          control: input,
          sync: () => {
            if (document.activeElement !== input) input.value = this.store.get<string>(def.id);
          },
        };
      }
    }
  }

  // ── live state ────────────────────────────────────────────────────────────

  private syncAll(): void {
    for (const r of this.rows) r.sync();
  }

  private filter(): void {
    const q = this.search.value;
    const live = new Map<string, number>();
    for (const r of this.rows) {
      const on = r.hit(q);
      r.el.hidden = !on;
      if (on) live.set(r.group, (live.get(r.group) ?? 0) + 1);
    }
    // A heading with nothing under it reads as "this group has no settings",
    // which is a lie the search box would be telling.
    for (const [group, section] of this.sections) section.hidden = !live.has(group);
    for (const link of this.nav.children) {
      const el = link as HTMLButtonElement;
      el.hidden = !live.has(el.textContent ?? "");
    }

    const total = [...live.values()].reduce((a, b) => a + b, 0);
    this.empty(total === 0 && q.trim() !== "");
  }

  private empty(show: boolean): void {
    let node = this.body.querySelector<HTMLElement>(".prefs-empty");
    if (!show) {
      node?.remove();
      return;
    }
    if (!node) {
      node = document.createElement("p");
      node.className = "prefs-empty";
      node.textContent = "Nothing matches. Settings are searched by name, description and group.";
      this.body.append(node);
    }
  }
}

function stepper(glyph: string, title: string, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "prefs-step";
  b.textContent = glyph;
  b.title = title;
  b.addEventListener("click", run);
  return b;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Re-exported so callers do not need two imports to write one setting. */
export type { SettingValue };
