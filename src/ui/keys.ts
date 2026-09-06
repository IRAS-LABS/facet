/**
 * The shortcut editor (item 35).
 *
 * Generated from `core/keys/commands.ts` the same way the settings panel is
 * generated from the settings registry, and for the same reason: a new shortcut
 * should cost a declaration, not a screen. Ctrl+Shift+K, `shortcuts` in the
 * palette, or the Keyboard row in Settings.
 *
 * The interesting decisions are all about capture:
 *
 *  - **The next key you press is the binding, whatever it is.** Ctrl+K opens the
 *    palette everywhere in this app; while capturing it has to mean "bind
 *    Ctrl+K", so the listener runs on the capture phase and stops the event
 *    dead. Anything less and the shortcuts worth rebinding are the ones you
 *    cannot rebind.
 *  - **Esc cancels, it does not bind.** It is the one key a user will press to
 *    get out of a control they opened by accident, and binding it silently is a
 *    trap. Anyone who genuinely wants Esc can still take it: the row says so.
 *  - **Unbinding is its own button.** A chord and "no chord" are different
 *    answers, and there is no key you can press to mean the second one.
 *  - **Conflicts are shown, never resolved.** Binding is never refused — going
 *    through an intermediate collision is how a rearrangement is done — but
 *    both rows name the other command, and the one that never fires says so.
 */

import { keys as globalKeys, chordOf, type KeyCommand, type KeyMap } from "@core/keys/map";

interface Row {
  el: HTMLElement;
  cmd: KeyCommand;
  sync(): void;
}

export class KeysPanel {
  private readonly root: HTMLElement;
  private readonly search = document.createElement("input");
  private readonly body = document.createElement("div");
  private readonly rows: Row[] = [];
  private readonly sections = new Map<string, HTMLElement>();
  private built = false;

  /** The row currently listening for a key, if any. */
  private capturing: string | null = null;
  private release: (() => void) | null = null;

  constructor(private readonly map: KeyMap = globalKeys) {
    this.root = document.createElement("div");
    this.root.className = "keys";
    this.root.hidden = true;

    const sheet = document.createElement("div");
    sheet.className = "keys-sheet";

    const head = document.createElement("div");
    head.className = "keys-head";

    const title = document.createElement("h2");
    title.className = "keys-title";
    title.textContent = "Keyboard";

    this.search.className = "keys-search";
    this.search.type = "search";
    this.search.placeholder = "Search shortcuts…";
    this.search.spellcheck = false;
    this.search.setAttribute("aria-label", "Search shortcuts");
    this.search.addEventListener("input", () => this.filter());

    const close = document.createElement("button");
    close.type = "button";
    close.className = "keys-x";
    close.textContent = "✕";
    close.title = "Close";
    close.addEventListener("click", () => this.close());

    head.append(title, this.search, close);

    this.body.className = "keys-body";

    const foot = document.createElement("div");
    foot.className = "keys-foot";

    const hint = document.createElement("p");
    hint.className = "keys-hint";
    hint.textContent =
      "Click a shortcut, then press the keys you want. Esc cancels rather than binding — take it with the ⌫ button if you really want it.";

    const wipe = document.createElement("button");
    wipe.type = "button";
    wipe.className = "keys-wipe";
    wipe.textContent = "Put every shortcut back";
    wipe.addEventListener("click", () => {
      this.map.resetAll();
      this.sync();
    });

    foot.append(hint, wipe);
    sheet.append(head, this.body, foot);
    this.root.append(sheet);
    document.body.appendChild(this.root);

    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });

    // Esc closes the panel — but only when nothing is capturing, or the key that
    // cancels a capture would also throw away the panel it happened in.
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.capturing === null) {
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

  open(): void {
    if (!this.built) this.build();
    this.sync();
    this.root.hidden = false;
    this.search.value = "";
    this.filter();
    this.search.focus();
  }

  close(): void {
    this.stopCapture();
    this.root.hidden = true;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  // ── building ──────────────────────────────────────────────────────────────

  private build(): void {
    this.built = true;
    for (const group of this.map.groups()) {
      const section = document.createElement("section");
      section.className = "keys-section";

      const h = document.createElement("h3");
      h.className = "keys-group";
      h.textContent = group;
      section.appendChild(h);

      this.sections.set(group, section);
      this.body.appendChild(section);
    }
    for (const cmd of this.map.all()) {
      const row = this.buildRow(cmd);
      this.rows.push(row);
      this.sections.get(cmd.group)?.appendChild(row.el);
    }
  }

  private buildRow(cmd: KeyCommand): Row {
    const el = document.createElement("div");
    el.className = "keys-row";
    el.dataset["id"] = cmd.id;

    const text = document.createElement("div");
    text.className = "keys-text";

    const label = document.createElement("span");
    label.className = "keys-label";
    label.textContent = cmd.label;

    const note = document.createElement("p");
    note.className = "keys-note";

    text.append(label, note);

    const control = document.createElement("div");
    control.className = "keys-control";

    const chord = document.createElement("button");
    chord.type = "button";
    chord.className = "keys-chord";
    chord.addEventListener("click", () => this.startCapture(cmd.id, chord));

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "keys-clear";
    clear.textContent = "⌫";
    clear.title = "No shortcut for this";
    clear.addEventListener("click", () => {
      this.map.bind(cmd.id, "");
      this.sync();
    });

    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "keys-undo";
    undo.textContent = "↺";
    undo.title = `Back to ${cmd.default === "" ? "no shortcut" : cmd.default}`;
    undo.addEventListener("click", () => {
      this.map.reset(cmd.id);
      this.sync();
    });

    control.append(chord, clear, undo);
    el.append(text, control);

    const sync = (): void => {
      const now = this.map.chord(cmd.id);
      const changed = this.map.isSet(cmd.id);
      chord.textContent = this.capturing === cmd.id ? "Press a key…" : now === "" ? "—" : now;
      chord.classList.toggle("is-capturing", this.capturing === cmd.id);
      chord.classList.toggle("is-empty", now === "");
      el.classList.toggle("is-changed", changed);
      undo.hidden = !changed;

      // The scope, said in the row rather than in a legend, because "why did my
      // shortcut not work while the photo was up" is asked one row at a time.
      const scope =
        cmd.scope === "always"
          ? "Works everywhere, including over a photo or a video."
          : "Works while you are in a folder.";
      const clash = now === "" ? [] : this.map.conflicts(now, cmd.id);
      if (clash.length > 0) {
        // Which of the two actually fires is decided by declaration order, and
        // saying so is more use than a warning triangle: it tells the user
        // whether this row is the one that has stopped working.
        const first = this.map.all().find((c) => clash.includes(c) || c.id === cmd.id);
        const wins = first?.id === cmd.id;
        note.textContent = `${scope} Same keys as ${clash.map((c) => c.label).join(", ")} — ${
          wins ? "this one wins" : "that one wins, so this does nothing"
        }.`;
        el.classList.add("is-clash");
      } else {
        note.textContent = scope;
        el.classList.remove("is-clash");
      }
    };

    return { el, cmd, sync };
  }

  // ── capture ───────────────────────────────────────────────────────────────

  private startCapture(id: string, button: HTMLElement): void {
    this.stopCapture();
    this.capturing = id;
    this.sync();
    button.focus();

    const onKey = (e: KeyboardEvent): void => {
      const chord = chordOf(e);
      // A modifier on its own is not a binding — the user is still on their way
      // to one, and every chord starts with one of these held down.
      if (chord === "") return;
      e.preventDefault();
      e.stopPropagation();
      if (chord === "Esc") {
        this.stopCapture();
        this.sync();
        return;
      }
      this.map.bind(id, chord);
      this.stopCapture();
      this.sync();
    };

    // Capture phase, on the window: the whole point is to intercept chords the
    // app itself binds, and by the bubble phase the palette has already opened.
    window.addEventListener("keydown", onKey, true);
    this.release = (): void => { window.removeEventListener("keydown", onKey, true); };
  }

  private stopCapture(): void {
    this.capturing = null;
    this.release?.();
    this.release = null;
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  sync(): void {
    for (const row of this.rows) row.sync();
  }

  private filter(): void {
    const q = this.search.value.trim().toLowerCase();
    for (const row of this.rows) {
      const hay = [
        row.cmd.label,
        row.cmd.group,
        ...(row.cmd.keywords ?? []),
        // The chord itself is searchable, so "ctrl+shift" answers "what have I
        // put on that hand shape" — which is the question when rebinding.
        this.map.chord(row.cmd.id),
      ]
        .join(" ")
        .toLowerCase();
      row.el.hidden = q !== "" && !hay.includes(q);
    }
    for (const [group, section] of this.sections) {
      const rows = this.rows.filter((r) => r.cmd.group === group);
      section.hidden = rows.length > 0 && rows.every((r) => r.el.hidden);
    }
  }
}
