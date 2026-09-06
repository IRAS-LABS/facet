/**
 * The file-associations sheet (item 40).
 *
 * Two lists again, and again because they are two halves of one question — but
 * the halves are not the ones you would guess. The top half is **by kind**,
 * which is the answer for almost everybody: "open pictures in the viewer" is one
 * decision that covers eleven extensions. The bottom half is **by extension**,
 * which exists for the case the kind cannot express: a `.json` is code and a
 * `.log` is code, and somebody who is reading forty JSON files today wants the
 * table view for one of those and not the other.
 *
 * Extensions are listed last and start empty on purpose. A settings screen that
 * opens on a list of two hundred extensions is a settings screen nobody finishes
 * reading, and the honest shape of this preference is "a few exceptions to a few
 * rules". Rows arrive by using the app — the right-click menu's **Always open
 * .json with…** puts one here — and the sheet offers the extensions in the
 * folder you are standing in, because that is where the thought comes from.
 *
 * Same house rules as the column chooser, the places editor and the menu
 * builder: every click writes, there is no OK button, and what you are
 * configuring is visible behind the sheet.
 */

import {
  builtInFor,
  HANDLERS,
  handlerLabel,
  normalizeExt,
  type Choice,
  type HandlerId,
} from "@core/explorer/opens";
import type { FileKind } from "@core/explorer/types";

/**
 * The kinds that can be opened, in the order the explorer thinks about them.
 * `folder` is absent: walking into a folder is not a handler choice.
 */
const KINDS: ReadonlyArray<readonly [Exclude<FileKind, "folder">, string]> = [
  ["image", "Pictures"],
  ["video", "Video"],
  ["audio", "Audio"],
  ["tabular", "Tables"],
  ["document", "Documents"],
  ["code", "Code and text"],
  ["archive", "Archives"],
  ["model3d", "3D models"],
  ["binary", "Everything else"],
];

export interface OpensPanelOptions {
  /** The handler set for a kind, or undefined where the built-in stands. */
  forKind(kind: FileKind): HandlerId | undefined;
  setKind(kind: FileKind, handler: HandlerId | null): void;
  /** Every extension the user has pinned. */
  extensions(): ReadonlyArray<readonly [string, HandlerId]>;
  setExt(ext: string, handler: HandlerId | null): void;
  /** Back to the shipped associations. */
  reset(): void;
  /**
   * Which handlers can take a file of this kind and extension at all. The sheet
   * asks so it can grey out a choice that could never run rather than letting
   * somebody pick it and wonder why nothing happened.
   */
  availableFor(kind: FileKind, ext: string): readonly HandlerId[];
  /**
   * Extensions present in the folder on screen, each with the kind the explorer
   * gives it. The kind rides along because a row that says `.jpg` has to be able
   * to say what a .jpg does *today*, and that answer comes from the kind — ask
   * on the extension alone and every picture looks like an unknown blob.
   */
  nearby(): ReadonlyArray<readonly [string, FileKind]>;
  /** What would actually happen to a file of this kind and extension today. */
  explain(kind: FileKind, ext: string): Choice & { actual: HandlerId | null };
}

export class OpensPanel {
  private readonly root: HTMLElement;
  private readonly kindsEl = document.createElement("div");
  private readonly extsEl = document.createElement("div");
  private readonly addEl = document.createElement("div");
  private opts: OpensPanelOptions | null = null;
  /** Which extension row is expanded. Only one at a time. */
  private open_: string | null = null;
  /**
   * The extension the sheet was opened *about*, when it is not pinned yet.
   *
   * It gets a row of its own — showing what it does today, with nothing written
   * down — because arriving from "Always open .jpg with…" and finding no .jpg
   * anywhere is the sheet ignoring the question it was asked. Picking a chip on
   * that row is what turns it into a real exception; closing the sheet without
   * picking leaves the file on disk exactly as it was.
   */
  private pending: string | null = null;
  /** Extension → the kind the explorer gives it, for the folder on screen. */
  private kinds = new Map<string, FileKind>();

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "opn";
    this.root.hidden = true;

    const sheet = document.createElement("div");
    sheet.className = "opn-sheet";

    const head = document.createElement("div");
    head.className = "opn-head";
    const title = document.createElement("h2");
    title.className = "opn-title";
    title.textContent = "What opens what";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "opn-x";
    close.textContent = "✕";
    close.title = "Close";
    close.addEventListener("click", () => this.close());
    head.append(title, close);

    const blurb = document.createElement("p");
    blurb.className = "opn-blurb";
    blurb.textContent =
      "Which part of FACET opens a file when you double-click it. An extension below beats the kind above it, and either can be handed back to Windows.";

    const body = document.createElement("div");
    body.className = "opn-body";

    const kindHead = document.createElement("h3");
    kindHead.className = "opn-sub";
    kindHead.textContent = "By kind";
    this.kindsEl.className = "opn-list";

    const extHead = document.createElement("h3");
    extHead.className = "opn-sub";
    extHead.textContent = "Exceptions by extension";
    const extBlurb = document.createElement("p");
    extBlurb.className = "opn-blurb";
    extBlurb.textContent =
      "For when one extension does not want what the rest of its kind wants — .json in the table view while the rest of your code opens in the inspector.";
    this.extsEl.className = "opn-list";

    const addHead = document.createElement("h3");
    addHead.className = "opn-sub";
    addHead.textContent = "Add an extension";
    this.addEl.className = "opn-list opn-add";

    body.append(
      kindHead,
      this.kindsEl,
      extHead,
      extBlurb,
      this.extsEl,
      addHead,
      this.addEl,
    );

    const foot = document.createElement("div");
    foot.className = "opn-foot";
    const hint = document.createElement("span");
    hint.className = "opn-hint";
    hint.textContent = "Saved as you go.";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "opn-reset";
    reset.textContent = "↺ Shipped associations";
    reset.title = "Put every kind and extension back the way FACET shipped it.";
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

  /**
   * `focusExt` opens with that extension's row already expanded — the route in
   * from "Always open .json with…", which would otherwise drop you at the top of
   * a sheet and make you find the row you just asked about.
   */
  open(opts: OpensPanelOptions, focusExt?: string): void {
    this.opts = opts;
    this.root.hidden = false;
    const ext = focusExt === undefined ? "" : normalizeExt(focusExt);
    this.open_ = ext === "" ? null : ext;
    this.pending = this.open_;
    this.sync();
  }

  close(): void {
    this.root.hidden = true;
    this.opts = null;
    this.open_ = null;
    this.pending = null;
  }

  sync(): void {
    const o = this.opts;
    if (o === null) return;

    // ── by kind ──
    this.kindsEl.replaceChildren();
    for (const [kind, label] of KINDS) {
      this.kindsEl.append(this.kindRow(kind, label, o));
    }

    // The folder on screen, read once so the rows below and the add buttons
    // agree about what kind each extension is.
    this.kinds = new Map();
    for (const [ext, kind] of o.nearby()) {
      const e = normalizeExt(ext);
      if (e !== "" && !this.kinds.has(e)) this.kinds.set(e, kind);
    }

    // ── by extension ──
    this.extsEl.replaceChildren();
    const pinned = o.extensions();
    const already = new Set(pinned.map(([ext]) => ext));
    for (const [ext, handler] of pinned) {
      this.extsEl.append(this.extRow(ext, handler, o, true));
    }
    // The one the sheet was opened about, if it is not on the list yet. Last,
    // because it is the newcomer and not yet one of the decisions above it.
    const pending = this.pending !== null && !already.has(this.pending) ? this.pending : null;
    if (pending !== null) {
      const kind = this.kindOf(pending);
      const today = o.explain(kind, pending).actual ?? builtInFor(kind);
      this.extsEl.append(this.extRow(pending, today, o, false));
    }
    if (pinned.length === 0 && pending === null) {
      const none = document.createElement("p");
      none.className = "opn-none";
      none.textContent = "None — every extension follows its kind.";
      this.extsEl.append(none);
    }

    // ── what can be added ──
    this.addEl.replaceChildren();
    const nearby = [...this.kinds.keys()]
      .filter((e) => !already.has(e) && e !== pending)
      .sort();
    for (const ext of nearby) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opn-addrow";
      b.dataset["ext"] = ext;
      b.textContent = `.${ext}`;
      b.addEventListener("click", () => {
        // Raised as a pending row rather than written straight to disk: the
        // list is a place to make an exception, not an exception in itself, and
        // clicking `.jpg` to see what it does should not be a decision.
        this.pending = ext;
        this.open_ = ext;
        this.sync();
      });
      this.addEl.append(b);
    }
    if (nearby.length === 0) {
      const none = document.createElement("p");
      none.className = "opn-none";
      none.textContent =
        "Nothing new in this folder. Open a folder with the files in it, or use “Always open …with” from the right-click menu.";
      this.addEl.append(none);
    }
  }

  // ── internals ──

  private kindRow(
    kind: Exclude<FileKind, "folder">,
    label: string,
    o: OpensPanelOptions,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "opn-row";
    row.dataset["kind"] = kind;

    const name = document.createElement("span");
    name.className = "opn-name";
    name.textContent = label;
    row.append(name);

    const chosen = o.forKind(kind);
    const available = o.availableFor(kind, "");
    row.append(
      this.picker(chosen ?? builtInFor(kind), available, (id) => {
        // Choosing what it already shipped as clears the override rather than
        // storing it, so the file on disk stays a list of decisions and never
        // fills up with rows that say "leave it alone".
        o.setKind(kind, id === builtInFor(kind) ? null : id);
        this.sync();
      }),
    );

    const note = document.createElement("span");
    note.className = "opn-note";
    note.textContent = chosen === undefined ? "" : "changed";
    row.append(note);
    return row;
  }

  /**
   * One extension's row. `pinned` false means it is the row the sheet was opened
   * about and nothing is written down for it yet: same chips, same layout, but
   * the sentence underneath says what happens rather than what was decided, and
   * there is nothing to remove.
   */
  private extRow(
    ext: string,
    handler: HandlerId,
    o: OpensPanelOptions,
    pinned: boolean,
  ): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "opn-ext";
    wrap.dataset["ext"] = ext;
    if (!pinned) wrap.dataset["pending"] = "true";

    const row = document.createElement("div");
    row.className = "opn-row";

    const name = document.createElement("span");
    name.className = "opn-name";
    name.textContent = `.${ext}`;
    row.append(name);

    // Asked with the kind the explorer gives this extension in the folder on
    // screen. A pinned extension that is nowhere nearby has no kind to offer, so
    // `binary` stands in for "no kind opinion" and the answer rests on the
    // extension alone.
    const kind = this.kindOf(ext);
    row.append(
      this.picker(handler, o.availableFor(kind, ext), (id) => {
        o.setExt(ext, id);
        this.pending = null;
        this.open_ = ext;
        this.sync();
      }),
    );

    if (pinned) {
      row.append(
        this.tick("✕", "Stop treating this extension specially", () => {
          o.setExt(ext, null);
          if (this.open_ === ext) this.open_ = null;
          this.pending = null;
          this.sync();
        }),
      );
    }
    wrap.append(row);

    if (this.open_ === ext) {
      const why = document.createElement("p");
      why.className = "opn-why";
      why.textContent = pinned
        ? `Every .${ext} opens in ${handlerLabel(handler)}, whatever kind FACET thinks it is.`
        : `A .${ext} opens in ${handlerLabel(handler)} today, along with the rest of its kind. Pick another to make .${ext} an exception.`;
      wrap.append(why);
    }
    return wrap;
  }

  /** The kind the explorer gives this extension, or `binary` where nothing knows. */
  private kindOf(ext: string): Exclude<FileKind, "folder"> {
    const k = this.kinds.get(ext);
    return k === undefined || k === "folder" ? "binary" : k;
  }

  /**
   * The handler chooser.
   *
   * A row of chips rather than a `<select>`: nine options with a sentence each
   * is a thing to read once and then recognise, and a native dropdown on
   * WebView2 renders in the OS's colours in the middle of a themed sheet.
   */
  private picker(
    current: HandlerId,
    available: readonly HandlerId[],
    pick: (id: HandlerId) => void,
  ): HTMLElement {
    const can = new Set(available);
    const wrap = document.createElement("div");
    wrap.className = "opn-picker";
    for (const h of HANDLERS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opn-chip";
      b.dataset["handler"] = h.id;
      b.textContent = h.label;
      b.title = h.blurb;
      if (h.id === current) b.dataset["on"] = "true";
      if (!can.has(h.id)) {
        // Offered but not pickable: knowing the video editor exists and cannot
        // take a .txt is more useful than a list that changes length per row.
        b.dataset["off"] = "true";
        b.disabled = true;
        b.title = `${h.blurb} — cannot open this kind of file.`;
      } else {
        b.addEventListener("click", () => pick(h.id));
      }
      wrap.append(b);
    }
    return wrap;
  }

  private tick(glyph: string, title: string, run: () => void): HTMLElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opn-tick";
    b.textContent = glyph;
    b.title = title;
    b.addEventListener("click", run);
    return b;
  }
}
