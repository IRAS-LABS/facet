/**
 * The filter box and its menu (item 37).
 *
 * One text field, live, plus a menu of ready-made and saved filters. The field
 * is the whole feature: everything the menu offers is a query string that lands
 * in the box where you can then edit it, which is the only way anybody ever
 * learns a syntax they were not taught.
 *
 * Changes are announced on a short delay. That is not a general nervousness
 * about input events — it is that every change re-lays-out the folder, and a
 * canvas holding forty thousand cards cannot do that between keystrokes. The
 * delay is short enough to read as instant and long enough that typing a word
 * costs one relayout instead of six. Enter and the menu skip it: those are
 * decisions, not typing.
 */

import { PRESETS } from "@core/explorer/filter";
import type { SavedFilter } from "@core/explorer/rules";

export interface FilterBarOptions {
  /** Fired when the query changes, after the settle delay. */
  onChange(text: string): void;
  /** The saved filters to offer. Read on every menu open, never cached. */
  saved(): SavedFilter[];
  onSave(name: string, query: string): void;
  onRemove(name: string): void;
}

/** ms. Long enough to swallow a burst of typing, short enough to feel live. */
const SETTLE = 120;

export class FilterBar {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  #menu: HTMLElement | null = null;
  #timer: number | null = null;
  #last = "";

  constructor(private readonly opts: FilterBarOptions) {
    this.root = document.createElement("div");
    this.root.className = "flt";

    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "flt-input";
    this.input.spellcheck = false;
    this.input.placeholder = "Filter";
    this.input.title =
      "Filter this folder. Words match the name; kind:image ext:png size:>2mb " +
      "modified:today before:2026-01-01 is:folder. A - in front means 'not'.";

    this.input.addEventListener("input", () => this.#schedule());
    this.input.addEventListener("keydown", (e) => {
      // Stopped here rather than in the shell: the global handler treats bare
      // letters as shortcuts, and a filter box that opens the hex inspector
      // when you type an H is not a filter box.
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        if (this.#menu) this.closeMenu();
        else if (this.input.value !== "") this.set("", true);
        else this.input.blur();
      } else if (e.key === "Enter") {
        e.preventDefault();
        this.#flush();
      }
    });

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "flt-clear";
    clear.textContent = "✕";
    clear.title = "Clear the filter";
    clear.addEventListener("click", () => {
      this.set("", true);
      this.input.focus();
    });

    const menu = document.createElement("button");
    menu.type = "button";
    menu.className = "flt-menu-btn";
    menu.textContent = "▾";
    menu.title = "Saved and ready-made filters";
    menu.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.#menu) this.closeMenu();
      else this.openMenu();
    });

    this.root.append(this.input, clear, menu);
    this.#sync();
  }

  /** What is in the box right now, whether or not it has been announced. */
  value(): string {
    return this.input.value;
  }

  /**
   * Put a query in the box.
   *
   * Silent by default, because the caller that uses it most is the shell
   * restoring a folder's remembered filter — and announcing that would send the
   * shell a change it just made, which is how a restore turns into a save.
   */
  set(text: string, announce = false): void {
    this.input.value = text;
    this.#sync();
    if (announce) this.#flush();
    else this.#last = text;
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  openMenu(): void {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "flt-menu";

    const section = (title: string): void => {
      const h = document.createElement("div");
      h.className = "flt-menu-h";
      h.textContent = title;
      menu.appendChild(h);
    };

    const pick = (label: string, query: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "flt-pick";
      b.dataset["query"] = query;
      const name = document.createElement("span");
      name.textContent = label;
      const q = document.createElement("code");
      q.textContent = query;
      b.append(name, q);
      b.addEventListener("click", () => {
        this.set(query, true);
        this.closeMenu();
        this.input.focus();
      });
      return b;
    };

    const saved = this.opts.saved();
    if (saved.length > 0) {
      section("Saved");
      for (const f of saved) {
        const row = document.createElement("div");
        row.className = "flt-row";
        const drop = document.createElement("button");
        drop.type = "button";
        drop.className = "flt-drop";
        drop.textContent = "✕";
        drop.title = `Forget "${f.name}"`;
        drop.addEventListener("click", (e) => {
          e.stopPropagation();
          this.opts.onRemove(f.name);
          // Reopened rather than surgically edited: the menu is cheap, and a
          // list that removes its own rows is a list with two ideas of what is
          // in it.
          this.openMenu();
        });
        row.append(pick(f.name, f.query), drop);
        menu.appendChild(row);
      }
    }

    section("Ready-made");
    for (const p of PRESETS) menu.appendChild(pick(p.name, p.query));

    // Saving lives in the menu rather than behind a dialog because `prompt()`
    // does not exist in the desktop webview — it returns null on WebView2, so a
    // build that asked for a name that way would silently never save one.
    const save = document.createElement("form");
    save.className = "flt-save";
    const name = document.createElement("input");
    name.type = "text";
    name.className = "flt-name";
    name.placeholder = "Save this filter as…";
    name.spellcheck = false;
    const go = document.createElement("button");
    go.type = "submit";
    go.className = "flt-save-btn";
    go.textContent = "Save";
    save.append(name, go);
    save.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = this.input.value.trim();
      if (name.value.trim() === "" || text === "") return;
      this.opts.onSave(name.value, text);
      this.openMenu();
    });
    save.addEventListener("keydown", (e) => e.stopPropagation());
    menu.appendChild(save);

    this.root.appendChild(menu);
    this.#menu = menu;
    // Deferred so the click that opened the menu is not the click that closes
    // it. Capture, so a click anywhere — including inside another panel that
    // stops propagation — still shuts it.
    setTimeout(() => document.addEventListener("mousedown", this.#away, true), 0);
  }

  closeMenu(): void {
    if (!this.#menu) return;
    this.#menu.remove();
    this.#menu = null;
    document.removeEventListener("mousedown", this.#away, true);
  }

  destroy(): void {
    this.closeMenu();
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.root.remove();
  }

  // ── internals ──

  #away = (e: MouseEvent): void => {
    if (!this.root.contains(e.target as Node)) this.closeMenu();
  };

  #schedule(): void {
    this.#sync();
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => this.#flush(), SETTLE);
  }

  #flush(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const text = this.input.value;
    // Guarded because the settle timer and Enter can both arrive for one edit,
    // and re-filtering a folder twice for the same string is a wasted relayout.
    if (text === this.#last) return;
    this.#last = text;
    this.opts.onChange(text);
  }

  /** The box says whether it is doing anything, so an active filter is visible. */
  #sync(): void {
    this.root.dataset["active"] = this.input.value.trim() === "" ? "false" : "true";
  }
}
