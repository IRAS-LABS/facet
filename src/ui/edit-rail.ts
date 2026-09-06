/**
 * The desktop editor's category bar, and the dropdown behind each category.
 *
 * What this replaces: the photo editor's side panel was one column that grew
 * every time a tool shipped — seven shape buttons, a face button, the layer
 * list, six sliders, a colour well, a toggle, undo, redo and a save button, all
 * stacked, all of it scrolled past to reach the bottom half. Nothing was
 * *findable*; it was findable-if-you-scroll, which is the same thing as
 * unfindable for anyone who has not already learnt the order. The complaint that
 * produced this file was exactly that: "one long editing thing that I have to
 * scroll through".
 *
 * So the tools move into nine dropdowns, one per catalogue group, and the rail
 * keeps only what is *about the picture in front of you* — the regions on it and
 * the settings of the one you have selected. A menu is a thing that comes to
 * your hand; a scrolling column is a thing you go to and hunt through.
 *
 * Three decisions worth writing down, because each one is a place a second
 * implementation would have drifted:
 *
 *  - **The catalogue is `@ui/phone/tools`, imported, not copied.** That file
 *    lives under `phone/` because the phone shell needed it first, but it is
 *    shared UI *data* — every tool the app has, with its label, its group, the
 *    file kinds it applies to and what it needs to run. A second list here would
 *    be a second list to forget to update, and the failure would be silent: a
 *    tool that exists on the phone and is simply missing on the desktop.
 *  - **The dropdown is `ContextMenu`, not a new popup.** It already does
 *    placement (through `popup-place`, which is the single copy of the
 *    keep-it-on-screen logic), dismissal on anything that moves the world
 *    underneath it, arrow-key navigation, and focus return. A fresh popup would
 *    have had to re-earn all four, and the two would have looked and behaved
 *    subtly differently for no reason a user could name.
 *  - **A category with nothing runnable behind it does not get a button.** This
 *    is the phone's own rule for its category bar and the reasoning carries: a
 *    disabled *tile* still teaches you the tool exists, but a disabled
 *    *category* is a button that opens a menu of greyed rows, which teaches
 *    nothing and costs a slot. Individual tools still grey rather than vanish,
 *    so the shape of a menu is stable and worth learning.
 */

import { IS_NATIVE } from "@core/explorer/tauri-fs";
import type { FileKind } from "@core/explorer/types";

import { ContextMenu, type RunnableCommand } from "./menu";
import { icon } from "./phone/icons";
import {
  GROUP_BAR,
  GROUP_ORDER,
  groupTools,
  type PhoneTool,
  type ToolGroup,
} from "./phone/tools";

// The rail's stylesheet is imported by the module that owns it rather than
// alongside the rest in `main.ts`. The two are one feature and neither is
// useful without the other; loading them from one place is how they stay that
// way when the rail is moved or dropped.
import "../styles/edit-rail.css";

/** What the host knows about one tool that the catalogue cannot. */
export interface RailStatus {
  /** False draws the row greyed, and clicking it says `why` instead of acting. */
  enabled: boolean;
  /**
   * Why it cannot run, or — when it can — what it will do. Shown as the row's
   * tooltip either way, so a greyed row always explains itself.
   */
  why: string;
  /** True when this row names the setting currently in force. */
  on: boolean;
}

export interface EditRailHost {
  /** The kind of file open right now. Drives the catalogue's own filtering. */
  kind(): FileKind;
  /**
   * Whether this surface wires this tool up at all, regardless of the state it
   * is in. Only the category bar asks — a tool that is routed but momentarily
   * unusable (no region selected, say) still keeps its category on screen.
   */
  routes(tool: PhoneTool): boolean;
  /** Runnable right now? See `RailStatus`. */
  status(tool: PhoneTool): RailStatus;
  run(tool: PhoneTool): void;
  /** One line of feedback, for a row that could not act. */
  say(message: string): void;
}

export class EditRail {
  private readonly bar: HTMLElement;
  private readonly menu: ContextMenu;
  private readonly buttons = new Map<ToolGroup, HTMLButtonElement>();

  /** The category whose menu is open, or null. */
  private shown: ToolGroup | null = null;
  /**
   * The category whose menu a press outside it has just dismissed.
   *
   * This exists so that a second click on the same button closes the menu
   * instead of closing and instantly reopening it — which looks like a button
   * that does nothing. It cannot be answered by asking the menu whether it is
   * open, because by the time the button's `click` fires the menu's own
   * outside-press handler has already closed it. See the constructor.
   */
  private dismissed: ToolGroup | null = null;

  constructor(private readonly host: EditRailHost) {
    this.bar = document.createElement("nav");
    this.bar.className = "erail";
    this.bar.setAttribute("aria-label", "Editing tools");

    // Registered *before* the `ContextMenu` below, and that order is
    // load-bearing: listeners on the same target in the same phase run in the
    // order they were added, so this one still sees `menu.isOpen === true` for
    // the press that is about to close it. Move `new ContextMenu()` above this
    // and the toggle-closed behaviour silently stops working.
    window.addEventListener(
      "pointerdown",
      (e) => {
        if (e.target instanceof Node && this.menu.element.contains(e.target)) return;
        this.dismissed = this.menu.isOpen ? this.shown : null;
        this.shown = null;
        this.paint();
      },
      true,
    );

    this.menu = new ContextMenu();
  }

  /** The bar itself. The panel that owns the rail puts this at the top of it. */
  get element(): HTMLElement {
    return this.bar;
  }

  /**
   * Rebuild the category buttons for the file kind now open.
   *
   * Cheap and idempotent — nine `groupTools` calls over a fifty-entry array —
   * so callers rebuild rather than reason about what changed.
   */
  refresh(): void {
    this.buttons.clear();
    this.bar.replaceChildren();
    for (const [group, heading] of GROUP_ORDER) {
      // See the third note in the file header: an empty category is a button
      // that leads nowhere useful.
      if (!this.entriesFor(group).some((e) => this.host.routes(e.tool))) continue;
      this.bar.append(this.button(group, heading));
    }
    this.paint();
  }

  /** Shut any open dropdown. Called when the editor closes under it. */
  close(): void {
    this.menu.close();
    this.shown = null;
    this.dismissed = null;
    this.paint();
  }

  // ── internals ───────────────────────────────────────────────────────────

  /**
   * Native and ffmpeg are the same fact on the desktop: both are the Tauri
   * build, and in a plain browser tab neither exists. Passing them separately
   * would be a distinction the shell cannot actually make here, and guessing
   * `true` in a browser tab would offer a Save that has nowhere to write.
   */
  private entriesFor(group: ToolGroup): Array<{ tool: PhoneTool; enabled: boolean; why: string }> {
    return groupTools(group, this.host.kind(), { native: IS_NATIVE, ffmpeg: IS_NATIVE });
  }

  private button(group: ToolGroup, heading: string): HTMLButtonElement {
    const [label, glyph] = GROUP_BAR[group];

    const b = document.createElement("button");
    b.type = "button";
    b.className = "erail-cat";
    // The chip text is four characters wide; the full heading is what a screen
    // reader and a hover both get, so the short form is never the only name.
    b.title = heading;
    b.setAttribute("aria-label", heading);
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");

    const glyphBox = document.createElement("span");
    glyphBox.className = "erail-cat-icon";
    glyphBox.setAttribute("aria-hidden", "true");
    glyphBox.append(icon(glyph));

    const text = document.createElement("span");
    text.className = "erail-cat-label";
    text.setAttribute("aria-hidden", "true");
    text.textContent = label;

    b.append(glyphBox, text);
    b.addEventListener("click", () => {
      const again = this.dismissed === group;
      this.dismissed = null;
      if (again) {
        this.paint();
        return;
      }
      this.openGroup(group, heading, b);
    });

    this.buttons.set(group, b);
    return b;
  }

  private openGroup(group: ToolGroup, heading: string, anchor: HTMLElement): void {
    const commands: RunnableCommand[] = [];
    const off = new Set<string>();

    for (const { tool, enabled, why } of this.entriesFor(group)) {
      // The catalogue's verdict wins when it is "no": it knows about file kinds
      // and about builds without ffmpeg, and the host has no better answer for
      // either. Only when the catalogue says yes is the host asked whether this
      // particular surface actually wires the tool up.
      const state: RailStatus = enabled
        ? this.host.status(tool)
        : { enabled: false, why, on: false };
      if (!state.enabled) off.add(tool.id);

      // Two clauses separated by a double space: `ContextMenu` shows the first
      // in the right-hand column and puts the whole string on `title`. So the
      // column stays a narrow word — "in use", "unavailable" — and the sentence
      // that explains it is one hover away instead of stretching the menu.
      const flag = state.enabled ? (state.on ? "in use" : "") : "unavailable";
      commands.push({
        id: tool.id,
        title: tool.label,
        group: heading,
        hint: `${flag}  ${state.why}`,
        run: state.enabled
          ? (): void => this.host.run(tool)
          : (): void => this.host.say(`${tool.label} — ${state.why}`),
      });
    }

    const box = anchor.getBoundingClientRect();
    // `line` is every id in catalogue order, so `buildMenu` reproduces that
    // order exactly rather than dropping anything or falling back.
    this.menu.open({
      x: Math.round(box.left),
      y: Math.round(box.bottom + 4),
      line: commands.map((c) => c.id).join(","),
      commands,
    });
    this.shown = group;
    this.paint();

    // After `open`, because that is when the rows exist. `ContextMenu` has no
    // disabled state of its own — every row it draws is a live command — so the
    // greying is applied here over the ids it stamped on each row. The rows stay
    // clickable on purpose: a click on one says why it cannot run, which is
    // strictly more than an inert row tells you.
    for (const row of this.menu.element.querySelectorAll<HTMLElement>(".ctx-row")) {
      const id = row.dataset["id"];
      if (id !== undefined && off.has(id)) {
        row.dataset["off"] = "true";
        row.setAttribute("aria-disabled", "true");
      }
    }
  }

  private paint(): void {
    for (const [group, b] of this.buttons) {
      const on = this.shown === group;
      b.setAttribute("aria-expanded", String(on));
      if (on) b.dataset["on"] = "true";
      else delete b.dataset["on"];
    }
  }
}
