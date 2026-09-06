/**
 * The right-click menu (item 39).
 *
 * FACET had no context menu at all before this, on purpose: everything is in
 * the palette, and a second half-populated menu would have been a place for
 * commands to go missing. It gets one now because the palette is a thing you
 * *go to* and a menu is a thing that comes to your hand, and because the item
 * asked for one you can build. What makes it safe to add is that it draws from
 * the same `commands()` list — see `@core/explorer/menu`.
 *
 * Behaviour worth writing down:
 *
 *  - **It is positioned, then clamped, then flipped.** A menu opened near the
 *    bottom of the window that simply overflows is one where the last three
 *    rows cannot be reached; opening upward is the only correct answer, and
 *    when it fits neither way it scrolls.
 *  - **It closes on anything that moves the world underneath it** — Escape,
 *    a click anywhere, a scroll, a resize, a window blur. A stale menu floating
 *    over a folder that has since been navigated away from would run its
 *    commands against the new one.
 *  - **Rows are buttons and the keyboard works.** Up/Down move, Enter runs,
 *    Escape closes and puts focus back where the menu was opened from, because
 *    a menu that eats the focus is one that breaks the next keystroke.
 *  - **It runs the command's own `run`.** There is no dispatch table here; a
 *    row *is* the command it came from.
 */

import { buildMenu, type MenuCommand, type MenuEntry } from "@core/explorer/menu";
import { placePopup } from "./popup-place";

/** A command that can actually be invoked — what the shell hands over. */
export interface RunnableCommand extends MenuCommand {
  run(): void | Promise<void>;
}

export interface MenuOptions {
  /** Where the pointer was, in client coordinates. */
  x: number;
  y: number;
  /** The stored line of ids. */
  line: string;
  /** Everything on offer for what is selected right now. */
  commands: readonly RunnableCommand[];
  /** Opens the builder. Adds the last row when supplied. */
  edit?(): void;
}

export class ContextMenu {
  private readonly root: HTMLElement;
  private rows: HTMLButtonElement[] = [];
  private active = -1;
  private returnFocus: HTMLElement | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "ctx";
    this.root.hidden = true;
    this.root.setAttribute("role", "menu");
    document.body.appendChild(this.root);

    // Capture phase, so a click on a row of the list underneath closes the menu
    // before that row's own handler changes the selection.
    window.addEventListener("pointerdown", (e) => {
      if (!this.isOpen) return;
      if (e.target instanceof Node && this.root.contains(e.target)) return;
      this.close();
    }, true);
    window.addEventListener("blur", () => this.close());
    window.addEventListener("resize", () => this.close());
    // Not `scroll` on window: the folder scrolls inside its own element, so the
    // event never reaches window without capture.
    window.addEventListener("scroll", () => this.close(), true);
    this.root.addEventListener("keydown", (e) => this.onKey(e));
  }

  get element(): HTMLElement {
    return this.root;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(opts: MenuOptions): void {
    const entries = buildMenu(opts.line, opts.commands);
    const byId = new Map(opts.commands.map((c) => [c.id, c]));

    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.root.replaceChildren();
    this.rows = [];
    this.active = -1;

    for (const entry of entries) {
      if (entry.kind === "sep") {
        const hr = document.createElement("div");
        hr.className = "ctx-sep";
        this.root.append(hr);
        continue;
      }
      const cmd = byId.get(entry.cmd.id);
      if (cmd === undefined) continue;
      this.root.append(this.row(cmd));
    }

    if (opts.edit !== undefined) {
      const hr = document.createElement("div");
      hr.className = "ctx-sep";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "ctx-row ctx-edit";
      edit.textContent = "Edit this menu…";
      edit.addEventListener("click", () => {
        this.close();
        opts.edit?.();
      });
      this.root.append(hr, edit);
      this.rows.push(edit);
    }

    this.root.hidden = false;
    placePopup(this.root, opts.x, opts.y);
    // Focus the container rather than the first row: arrowing down to the first
    // row is the expected way in, and a menu that arrives with something already
    // highlighted invites an Enter that runs the wrong thing.
    this.root.tabIndex = -1;
    this.root.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.root.replaceChildren();
    this.rows = [];
    this.active = -1;
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back !== null && back.isConnected) back.focus({ preventScroll: true });
  }

  // ── internals ──

  private row(cmd: RunnableCommand): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ctx-row";
    b.setAttribute("role", "menuitem");
    b.dataset["id"] = cmd.id;

    const title = document.createElement("span");
    title.className = "ctx-name";
    title.textContent = cmd.title;
    b.append(title);

    if (cmd.hint !== undefined && cmd.hint !== "") {
      const hint = document.createElement("span");
      hint.className = "ctx-hint";
      // The hint doubles as a shortcut column and as a path; a path is far too
      // long for a menu, so only the first clause is shown and the whole thing
      // is the tooltip.
      hint.textContent = cmd.hint.split("  ")[0] ?? "";
      b.title = cmd.hint;
      b.append(hint);
    }

    b.addEventListener("click", () => {
      // Closed before running: a command that opens its own sheet would
      // otherwise have to fight this for focus, and `close` restores focus to
      // wherever the menu was opened from.
      this.close();
      void cmd.run();
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
    this.active = ((this.active + dir) % n + n) % n;
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

export type { MenuEntry };
