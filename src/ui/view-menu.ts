/**
 * The View menu — Explorer's View tab, in one dropdown.
 *
 * Not built on `ContextMenu`, and the reason is structural rather than stylistic.
 * That menu draws a flat list of commands from a stored line of ids, because the
 * whole point of it is that the user decides what is in it. This one is a fixed
 * set of *choices about state*: four layouts of which exactly one is current,
 * five icon sizes of which exactly one is current, a sort key, a sort direction,
 * a grouping, and two switches. Its rows are radio buttons and checkboxes, and
 * every one of them has to show what it currently is — which is a different
 * widget with a different contract, however similar it looks.
 *
 * What it shares is the placement, which lives in `popup-place.ts` so there is
 * one copy of the logic that keeps a menu on screen.
 *
 * The menu closes and stays closed after a choice, rather than staying open for
 * a second one. That was tried the other way first: a menu that stays open while
 * the folder behind it re-groups and re-sorts under a heading you cannot see is
 * disorienting, and the cost of reopening it is one click.
 */

import { placePopup } from "./popup-place";

/** A row that reports state. `radio` draws a dot, `check` draws a tick. */
export type ItemKind = "radio" | "check" | "plain";

export interface ViewMenuItem {
  label: string;
  kind: ItemKind;
  /** Whether the dot or the tick is drawn. Ignored for `plain`. */
  on?: boolean;
  /** Right-hand column: a shortcut, a value, a unit. */
  hint?: string;
  run(): void;
}

export interface ViewMenuSection {
  /** Drawn as a small heading above the rows. Omit for an unlabelled block. */
  title?: string;
  items: ViewMenuItem[];
}

export class ViewMenu {
  private readonly root: HTMLElement;
  private rows: HTMLButtonElement[] = [];
  private active = -1;
  private returnFocus: HTMLElement | null = null;
  /** The button that opened it, so a second click on that button can close it. */
  private anchor: HTMLElement | null = null;

  constructor() {
    this.root = document.createElement("div");
    // Borrows `.ctx` for the frame and the row look, and adds `.vmenu` for the
    // parts that are its own. Two menus that look different from each other for
    // no reason are two menus you have to learn.
    this.root.className = "ctx vmenu";
    this.root.hidden = true;
    this.root.setAttribute("role", "menu");
    document.body.appendChild(this.root);

    // Capture phase, so a click on whatever is underneath closes this first —
    // see the same note in `ContextMenu`.
    window.addEventListener(
      "pointerdown",
      (e) => {
        if (!this.isOpen) return;
        if (e.target instanceof Node && this.root.contains(e.target)) return;
        // A press on the opening button is left alone so that its own click
        // handler sees the menu still open and closes it. Closing here instead
        // would close and immediately reopen, and the button would look dead.
        if (this.anchor !== null && e.target instanceof Node && this.anchor.contains(e.target)) {
          return;
        }
        this.close();
      },
      true,
    );
    window.addEventListener("blur", () => this.close());
    window.addEventListener("resize", () => this.close());
    window.addEventListener("scroll", () => this.close(), true);
    this.root.addEventListener("keydown", (e) => this.onKey(e));
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Open below-left of `anchor`, which is the button that opened it. */
  openUnder(anchor: HTMLElement, sections: readonly ViewMenuSection[]): void {
    const box = anchor.getBoundingClientRect();
    this.open(box.left, box.bottom + 4, sections);
    this.anchor = anchor;
  }

  open(x: number, y: number, sections: readonly ViewMenuSection[]): void {
    this.anchor = null;
    this.returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.root.replaceChildren();
    this.rows = [];
    this.active = -1;

    sections.forEach((section, i) => {
      if (i > 0) {
        const hr = document.createElement("div");
        hr.className = "ctx-sep";
        this.root.append(hr);
      }
      if (section.title !== undefined) {
        const h = document.createElement("div");
        h.className = "vmenu-head";
        h.textContent = section.title;
        this.root.append(h);
      }
      for (const item of section.items) this.root.append(this.row(item));
    });

    // Unhidden before placing: `placePopup` measures, and a hidden element
    // measures zero.
    this.root.hidden = false;
    placePopup(this.root, x, y);
    this.root.tabIndex = -1;
    this.root.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.root.replaceChildren();
    this.rows = [];
    this.active = -1;
    this.anchor = null;
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back !== null && back.isConnected) back.focus({ preventScroll: true });
  }

  // ── internals ──

  private row(item: ViewMenuItem): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ctx-row vmenu-row";
    b.setAttribute(
      "role",
      item.kind === "radio"
        ? "menuitemradio"
        : item.kind === "check"
          ? "menuitemcheckbox"
          : "menuitem",
    );
    if (item.kind !== "plain") {
      // The state goes on `aria-checked` as well as in the glyph: a screen
      // reader gets nothing at all from a "●" in a span.
      b.setAttribute("aria-checked", item.on === true ? "true" : "false");
    }

    const mark = document.createElement("span");
    mark.className = "vmenu-mark";
    mark.setAttribute("aria-hidden", "true");
    // A fixed-width column even when empty, so the labels line up whether or not
    // anything in the section is currently chosen.
    mark.textContent = item.on !== true ? "" : item.kind === "radio" ? "●" : "✓";

    const name = document.createElement("span");
    name.className = "ctx-name";
    name.textContent = item.label;

    b.append(mark, name);

    if (item.hint !== undefined && item.hint !== "") {
      const hint = document.createElement("span");
      hint.className = "ctx-hint";
      hint.textContent = item.hint;
      b.append(hint);
    }

    b.addEventListener("click", () => {
      this.close();
      item.run();
    });
    b.addEventListener("pointerenter", () => {
      this.active = this.rows.indexOf(b);
      this.paint();
    });

    this.rows.push(b);
    return b;
  }

  private onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        this.close();
        break;
      case "ArrowDown":
        e.preventDefault();
        this.move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        this.move(-1);
        break;
      case "Home":
        e.preventDefault();
        this.active = -1;
        this.move(1);
        break;
      case "End":
        e.preventDefault();
        this.active = this.rows.length;
        this.move(-1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        this.rows[this.active]?.click();
        break;
      default:
        break;
    }
  }

  private move(dir: number): void {
    if (this.rows.length === 0) return;
    const n = this.rows.length;
    this.active = (((this.active + dir) % n) + n) % n;
    this.paint();
    this.rows[this.active]?.scrollIntoView({ block: "nearest" });
  }

  private paint(): void {
    this.rows.forEach((r, i) => {
      if (i === this.active) r.dataset["on"] = "true";
      else delete r.dataset["on"];
    });
  }
}
