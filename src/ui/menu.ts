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
 *  - **It closes when the user moves the world underneath it** — Escape, a
 *    click anywhere outside, a scroll they asked for, a resize, a real window
 *    blur. A stale menu floating over a folder that has since been navigated
 *    away from would run its commands against the new one. What it does *not*
 *    close on is the page reflowing by itself; see `closeLater` and
 *    `INPUT_MS` for why that distinction is the whole difference between a
 *    menu you can use and one that flickers away.
 *  - **Rows are buttons and the keyboard works.** Up/Down move, Enter runs,
 *    Escape closes and puts focus back where the menu was opened from, because
 *    a menu that eats the focus is one that breaks the next keystroke.
 *  - **It runs the command's own `run`.** There is no dispatch table here; a
 *    row *is* the command it came from.
 */

import { buildMenu, type MenuCommand, type MenuEntry } from "@core/explorer/menu";
import { placePopup } from "./popup-place";

/**
 * How long after opening the menu ignores ambient scroll and resize events.
 *
 * Long enough to cover the frame the menu appears in and the focus change that
 * follows it; far shorter than the gap between opening a menu and deciding to
 * scroll away from it.
 */
const SETTLE_MS = 350;

/**
 * How recently the user must have done something for a scroll to count as
 * theirs.
 *
 * Every deliberate scroll is preceded by a wheel, a key, or a finger — within
 * a few milliseconds of it. A scroll with no input behind it came from the
 * page: a preview image finishing its load and reflowing the pane, a row
 * being brought into view by the selection the right-click itself made, the
 * WebView settling after the popup appeared. Those are not the world moving
 * out from under the menu, and closing on them is why the menu "disappears if
 * you look at it".
 */
const INPUT_MS = 300;

/** A command that can actually be invoked — what the shell hands over. */
export interface RunnableCommand extends MenuCommand {
  run(): void | Promise<void>;
}

export interface MenuOptions {
  /** Where the pointer was, in client coordinates. */
  x: number;
  y: number;
  /** Top edge of the opener. When it is low on screen the menu opens over it. */
  above?: number;
  /** The stored line of ids. */
  line: string;
  /** Everything on offer for what is selected right now. */
  commands: readonly RunnableCommand[];
  /** Opens the builder. Adds a row to the footer when supplied. */
  edit?(): void;
  /**
   * Hands over to the operating system's own menu for the selection. Adds
   * "Show more options" as the very last row when supplied.
   *
   * Last, and worded exactly as Windows 11 words it, because that is where the
   * hand already goes: anyone who has used Explorer since 2021 knows the full
   * menu with every program's entries in it is one row below the short one.
   * The shell only supplies this on Windows, and only when something is
   * selected — on empty space there is no item for Windows to describe.
   */
  more?: { hint: string; run(): void };
}

export class ContextMenu {
  private readonly root: HTMLElement;
  private rows: HTMLButtonElement[] = [];
  private active = -1;
  private returnFocus: HTMLElement | null = null;
  /** When the menu last opened, for {@link closeLater}. */
  private openedAt = 0;
  /** When the user last did something, for {@link closeLater}. */
  private lastInput = 0;

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
    // `document.hasFocus()` because a window blur is also how the page reacts
    // to focus moving to a plugin surface or the native title bar on Windows,
    // and closing the menu the user just opened because the WebView shuffled
    // focus internally is the "it disappears if I look at it" complaint.
    window.addEventListener("blur", () => {
      if (!document.hasFocus()) this.closeLater();
    });
    window.addEventListener("resize", () => this.closeLater());
    // Capture, passive, and always on: the cost is a clock read per event and
    // it is the only way to tell a scroll the user asked for from one the page
    // performed on its own.
    const touched = (): void => {
      this.lastInput = Date.now();
    };
    for (const kind of ["wheel", "keydown", "pointerdown", "touchstart"] as const) {
      window.addEventListener(kind, touched, { capture: true, passive: true });
    }
    // Not `scroll` on window: the folder scrolls inside its own element, so the
    // event never reaches window without capture. A scroll *inside* the menu is
    // the menu's own overflow being used and must not close it.
    window.addEventListener("scroll", (e) => {
      if (e.target instanceof Node && this.root.contains(e.target)) return;
      if (Date.now() - this.lastInput > INPUT_MS) return;
      this.closeLater();
    }, true);
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

    // The footer: rows about the menu rather than about the files. One
    // separator for both, so a menu offering both does not draw two lines.
    if (opts.edit !== undefined || opts.more !== undefined) {
      const hr = document.createElement("div");
      hr.className = "ctx-sep";
      this.root.append(hr);
    }
    if (opts.edit !== undefined) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "ctx-row ctx-edit";
      edit.textContent = "Edit this menu…";
      edit.addEventListener("click", () => {
        this.close();
        opts.edit?.();
      });
      this.root.append(edit);
      this.rows.push(edit);
    }
    if (opts.more !== undefined) {
      const more = opts.more;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ctx-row ctx-more";
      b.setAttribute("role", "menuitem");
      const name = document.createElement("span");
      name.className = "ctx-name";
      name.textContent = "Show more options";
      const hint = document.createElement("span");
      hint.className = "ctx-hint";
      hint.textContent = more.hint;
      b.append(name, hint);
      b.addEventListener("click", () => {
        // Closed first, and without waiting: the Windows menu is a native
        // popup drawn over the page, and this one still being on screen
        // underneath it reads as two menus open at once.
        this.close();
        more.run();
      });
      b.addEventListener("pointerenter", () => {
        this.active = this.rows.indexOf(b);
        this.paint();
      });
      this.root.append(b);
      this.rows.push(b);
    }

    this.root.hidden = false;
    this.openedAt = Date.now();
    placePopup(this.root, opts.x, opts.y, opts.above === undefined ? {} : { above: opts.above });
    // Focus the container rather than the first row: arrowing down to the first
    // row is the expected way in, and a menu that arrives with something already
    // highlighted invites an Enter that runs the wrong thing.
    this.root.tabIndex = -1;
    this.root.focus({ preventScroll: true });
  }

  /**
   * Close, unless the menu only just opened.
   *
   * Opening a popup is itself a layout change: focusing it, or the scrollbar
   * that appears next to it, or the on-screen keyboard retracting on Android,
   * all fire `scroll` or `resize` in the same frame as the menu appearing. Each
   * of those used to close it instantly, which read as a right-click that did
   * nothing at all — press, flicker, gone — and is the reason this grace window
   * exists. A deliberate scroll or resize is nowhere near this fast.
   *
   * Only the *ambient* triggers come through here. Escape and a pointer press
   * outside are the user saying "close", and are obeyed immediately however
   * soon they arrive.
   */
  private closeLater(): void {
    if (!this.isOpen) return;
    if (Date.now() - this.openedAt < SETTLE_MS) return;
    this.close();
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

  /**
   * Every key the menu understands is stopped here as well as defaulted.
   *
   * Without the `stopPropagation` these bubble to the shell's own key handler
   * while the menu is open: Down moves the menu's highlight *and* the folder's
   * cursor, the folder scrolls the new cursor into view, and that scroll shut
   * the menu. Arrowing to the second row and having the menu vanish is the
   * same complaint from the keyboard side.
   */
  private onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case "Escape":
        this.close();
        break;
      case "ArrowDown":
        this.move(1);
        break;
      case "ArrowUp":
        this.move(-1);
        break;
      case "Home":
        this.active = -1;
        this.move(1);
        break;
      case "End":
        this.active = this.rows.length;
        this.move(-1);
        break;
      case "Enter":
      case " ":
        this.rows[this.active]?.click();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
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
