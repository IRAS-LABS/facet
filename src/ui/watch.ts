/**
 * The watch-folder surface (item 27).
 *
 * A panel rather than a drawer, and that is the opposite call from the batch
 * queue on purpose: a queue is something you glance at while you keep working,
 * a rule is something you sit down and write. It is also the one screen in
 * FACET where a mistake keeps costing after you close it — a rule pointed at
 * the wrong folder goes on firing all week — so every row says in words what it
 * will do, to what, and how many times it already has.
 *
 * "Run on what's already here" is a button rather than the default, because a
 * new rule silently adopting a folder is what stops four hundred old photos
 * from becoming four hundred jobs the moment you flip a switch.
 */

import type { FileKind } from "@core/explorer/types";
import {
  describe,
  describeFilter,
  type WatchAction,
  type WatchRule,
} from "@core/watch/rules";
import type { WatchService } from "@core/watch/watcher";

export interface WatchPanelHost {
  /** The folder the explorer is looking at, for "use this one". */
  currentFolder(): string;
  /** Say something in the status bar — how many files a manual run queued. */
  say(message: string): void;
}

type ActionKind = WatchAction["type"];

const KIND_CHOICES: ReadonlyArray<readonly [string, FileKind[]]> = [
  ["Any file", []],
  ["Images", ["image"]],
  ["Video", ["video"]],
  ["Audio", ["audio"]],
  ["Video and audio", ["video", "audio"]],
  ["Documents", ["document"]],
];

const ACTION_CHOICES: ReadonlyArray<readonly [ActionKind, string]> = [
  ["clean", "Strip metadata into a clean copy"],
  ["blur.faces", "Blur every face into a copy"],
  ["convert.audio", "Convert audio"],
  ["convert.video", "Convert video"],
  ["move", "Move to another folder"],
  ["rename", "Rename"],
];

const AUDIO_FORMATS = ["mp3", "m4a", "flac", "wav", "opus"];
const VIDEO_FORMATS = ["mp4", "mkv", "webm", "mov"];

export class WatchPanel {
  private readonly root = document.createElement("div");
  private readonly list = document.createElement("div");
  private readonly empty = document.createElement("p");
  private readonly status = document.createElement("p");
  private readonly form = document.createElement("form");

  private readonly folder = input("text", "C:/Users/you/Downloads");
  private readonly kinds = select();
  private readonly exts = input("text", "e.g. mov, avi — blank for any");
  private readonly contains = input("text", "blank for any name");
  private readonly minSize = input("number", "0");
  private readonly action = select();
  private readonly format = select();
  private readonly target = input("text", "");
  private readonly targetLabel = document.createElement("label");
  private readonly formatLabel = document.createElement("label");
  private readonly save = document.createElement("button");

  /** The rule being edited, or null when the form is adding a new one. */
  private editing: string | null = null;
  private off: (() => void) | null = null;

  constructor(
    private readonly watch: WatchService,
    private readonly host: WatchPanelHost,
  ) {
    this.root.className = "wf";
    this.root.hidden = true;

    const sheet = document.createElement("div");
    sheet.className = "wf-sheet";

    const head = document.createElement("div");
    head.className = "wf-head";
    const title = document.createElement("h2");
    title.className = "wf-title";
    title.textContent = "Watch folders";
    const blurb = document.createElement("p");
    blurb.className = "wf-blurb";
    blurb.textContent = "Rules that run themselves on files that land in a folder.";
    const close = document.createElement("button");
    close.className = "wf-x";
    close.type = "button";
    close.textContent = "✕";
    close.addEventListener("click", () => this.hide());
    head.append(title, blurb, close);

    this.list.className = "wf-list";
    this.empty.className = "wf-empty";
    this.empty.textContent = "No rules yet. Add one below.";
    this.status.className = "wf-status";

    this.buildForm();

    sheet.append(head, this.list, this.empty, this.form, this.status);
    this.root.append(sheet);
    // Clicking the dimmed area closes, the sheet itself does not.
    this.root.addEventListener("click", (e) => {
      if (e.target === this.root) this.hide();
    });
    document.body.append(this.root);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  show(): void {
    if (!this.root.hidden) return;
    this.root.hidden = false;
    if (!this.folder.value) this.folder.value = this.host.currentFolder();
    this.off = this.watch.onChange(() => this.paint());
    this.paint();
    this.folder.focus();
  }

  hide(): void {
    this.root.hidden = true;
    this.off?.();
    this.off = null;
  }

  toggle(): void {
    if (this.root.hidden) this.show();
    else this.hide();
  }

  /**
   * Point the form at the folder the explorer is showing, discarding whatever
   * was half-typed. Called by "Watch this folder…", where that is the entire
   * intent of the command.
   */
  useCurrentFolder(): void {
    this.resetForm();
    this.folder.value = this.host.currentFolder();
    this.folder.focus();
  }

  // ── The form ──────────────────────────────────────────────────────────────

  private buildForm(): void {
    this.form.className = "wf-form";

    for (const [label, kinds] of KIND_CHOICES) {
      this.kinds.append(option(JSON.stringify(kinds), label));
    }
    for (const [value, label] of ACTION_CHOICES) {
      this.action.append(option(value, label));
    }
    this.action.addEventListener("change", () => this.syncAction());

    const useHere = document.createElement("button");
    useHere.type = "button";
    useHere.className = "wf-btn wf-here";
    useHere.textContent = "This folder";
    useHere.title = "Use the folder the explorer is showing";
    useHere.addEventListener("click", () => {
      this.folder.value = this.host.currentFolder();
    });

    const folderRow = document.createElement("div");
    folderRow.className = "wf-folder-row";
    folderRow.append(this.folder, useHere);

    this.form.append(
      field("Watch this folder", folderRow),
      field("Applies to", this.kinds),
      field("Only these extensions", this.exts),
      field("Name contains", this.contains),
      field("Skip files under (KB)", this.minSize),
      field("Then", this.action),
    );

    this.formatLabel.className = "wf-field";
    this.formatLabel.append(labelText("Format"), this.format);
    this.targetLabel.className = "wf-field";
    this.targetLabel.append(labelText("Destination"), this.target);
    this.form.append(this.formatLabel, this.targetLabel);

    const actions = document.createElement("div");
    actions.className = "wf-actions";
    this.save.type = "submit";
    this.save.className = "wf-btn wf-primary";
    this.save.textContent = "Add rule";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "wf-btn";
    cancel.textContent = "Clear";
    cancel.addEventListener("click", () => this.resetForm());
    actions.append(this.save, cancel);
    this.form.append(actions);

    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.commit();
    });

    this.syncAction();
  }

  /** Only the fields the chosen action actually uses are on screen. */
  private syncAction(): void {
    const kind = this.action.value as ActionKind;
    const wantsFormat = kind === "convert.audio" || kind === "convert.video";
    this.formatLabel.hidden = !wantsFormat;
    this.targetLabel.hidden = !(kind === "move" || kind === "rename");

    if (wantsFormat) {
      const formats = kind === "convert.audio" ? AUDIO_FORMATS : VIDEO_FORMATS;
      if (this.format.dataset["for"] !== kind) {
        this.format.textContent = "";
        for (const f of formats) this.format.append(option(f, f));
        this.format.dataset["for"] = kind;
      }
    }
    if (kind === "move") {
      this.target.placeholder = "C:/Users/you/Pictures/Sorted";
      this.targetLabel.replaceChild(labelText("Move to"), this.targetLabel.firstChild!);
    } else if (kind === "rename") {
      this.target.placeholder = "{yyyy}-{mm}-{dd} {name}.{ext}";
      this.targetLabel.replaceChild(
        labelText("Name pattern — {name} {ext} {yyyy} {mm} {dd} {n}"),
        this.targetLabel.firstChild!,
      );
    }
  }

  private commit(): void {
    const folder = this.folder.value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (!folder) {
      this.say("Give it a folder to watch.");
      return;
    }
    const action = this.readAction();
    if (!action) return;

    const patch = {
      folder,
      enabled: true,
      kinds: JSON.parse(this.kinds.value) as FileKind[],
      exts: this.exts.value
        .split(/[,\s]+/)
        .map((e) => e.trim().replace(/^\./, "").toLowerCase())
        .filter(Boolean),
      contains: this.contains.value.trim(),
      minSize: Math.max(0, Number(this.minSize.value) || 0) * 1024,
      action,
    };

    if (this.editing) {
      this.watch.updateRule(this.editing, patch);
      this.say("Rule updated.");
    } else {
      this.watch.addRule(patch);
      // Said every time a rule is created, because it is the one behaviour
      // people are surprised by and it is easier to explain here than to
      // explain afterwards.
      this.say("Rule added. Files already in that folder are left alone — use “Run now” for those.");
    }
    this.resetForm();
  }

  private readAction(): WatchAction | null {
    const kind = this.action.value as ActionKind;
    switch (kind) {
      case "clean":
        return { type: "clean" };
      case "blur.faces":
        // No amount picked here on purpose: FACE_DEFAULTS is tuned and the
        // panel has no preview to judge a number against. Tuning belongs in
        // the viewer, where you can see what 0.05 looks like on a face.
        return { type: "blur.faces" };
      case "convert.audio":
        return { type: "convert.audio", format: this.format.value, bitrate: 192 };
      case "convert.video":
        return { type: "convert.video", format: this.format.value, quality: 20 };
      case "move": {
        const to = this.target.value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
        if (!to) {
          this.say("Where should it move them to?");
          return null;
        }
        return { type: "move", to };
      }
      case "rename": {
        const pattern = this.target.value.trim();
        if (!pattern) {
          this.say("Give it a name pattern.");
          return null;
        }
        return { type: "rename", pattern };
      }
    }
  }

  private resetForm(): void {
    this.editing = null;
    this.save.textContent = "Add rule";
    this.exts.value = "";
    this.contains.value = "";
    this.minSize.value = "";
    this.target.value = "";
    this.action.value = "clean";
    this.kinds.selectedIndex = 0;
    this.syncAction();
  }

  private load(rule: WatchRule): void {
    this.editing = rule.id;
    this.save.textContent = "Save changes";
    this.folder.value = rule.folder;
    this.kinds.value = JSON.stringify(rule.kinds);
    if (!this.kinds.value || this.kinds.selectedIndex < 0) this.kinds.selectedIndex = 0;
    this.exts.value = rule.exts.join(", ");
    this.contains.value = rule.contains;
    this.minSize.value = rule.minSize > 0 ? String(Math.round(rule.minSize / 1024)) : "";
    this.action.value = rule.action.type;
    this.syncAction();
    if (rule.action.type === "convert.audio" || rule.action.type === "convert.video") {
      this.format.value = rule.action.format;
    } else if (rule.action.type === "move") {
      this.target.value = rule.action.to;
    } else if (rule.action.type === "rename") {
      this.target.value = rule.action.pattern;
    }
    this.folder.focus();
  }

  // ── The list ──────────────────────────────────────────────────────────────

  private paint(): void {
    const rules = this.watch.rules();
    this.empty.hidden = rules.length > 0;
    this.list.textContent = "";
    for (const rule of rules) this.list.append(this.row(rule));

    if (this.watch.lastError) {
      this.status.textContent = `Last sweep: ${this.watch.lastError}`;
      this.status.dataset["bad"] = "1";
    } else if (rules.length > 0) {
      const n = this.watch.watched().length;
      this.status.textContent = `Watching ${n} folder${n === 1 ? "" : "s"}, checked every few seconds.`;
      delete this.status.dataset["bad"];
    } else {
      this.status.textContent = "";
      delete this.status.dataset["bad"];
    }
  }

  private row(rule: WatchRule): HTMLElement {
    const row = document.createElement("div");
    row.className = "wf-row";
    row.dataset["on"] = rule.enabled ? "1" : "0";

    const on = document.createElement("input");
    on.type = "checkbox";
    on.className = "wf-on";
    on.checked = rule.enabled;
    on.title = rule.enabled ? "Running" : "Paused";
    on.addEventListener("change", () => this.watch.updateRule(rule.id, { enabled: on.checked }));

    const body = document.createElement("div");
    body.className = "wf-body";
    const line = document.createElement("div");
    line.className = "wf-line";
    line.textContent = `${describeFilter(rule)} → ${describe(rule)}`;
    const where = document.createElement("div");
    where.className = "wf-where";
    where.textContent = rule.folder;
    where.title = rule.folder;
    const count = document.createElement("div");
    count.className = "wf-count";
    // Zero is worth saying out loud. "Has this thing ever done anything?" is
    // the first question about any rule that runs while you are not looking.
    count.textContent =
      rule.fired > 0
        ? `${rule.fired} file${rule.fired === 1 ? "" : "s"} so far`
        : "nothing yet";
    body.append(line, where, count);

    const buttons = document.createElement("div");
    buttons.className = "wf-row-actions";
    buttons.append(
      iconButton("▶", "Run it now on the files already in that folder", () => {
        void this.watch.applyNow(rule.id).then((n) => {
          this.say(n > 0 ? `Queued ${n} file${n === 1 ? "" : "s"}.` : "Nothing there matches.");
        });
      }),
      iconButton("✎", "Edit this rule", () => this.load(rule)),
      iconButton("🗑", "Remove this rule", () => this.watch.removeRule(rule.id)),
    );

    row.append(on, body, buttons);
    return row;
  }

  private say(message: string): void {
    this.status.textContent = message;
    delete this.status.dataset["bad"];
    this.host.say(message);
  }
}

// ── Small DOM helpers ───────────────────────────────────────────────────────

function input(type: string, placeholder: string): HTMLInputElement {
  const el = document.createElement("input");
  el.type = type;
  el.className = "wf-input";
  el.placeholder = placeholder;
  return el;
}

function select(): HTMLSelectElement {
  const el = document.createElement("select");
  el.className = "wf-input";
  return el;
}

function option(value: string, label: string): HTMLOptionElement {
  const el = document.createElement("option");
  el.value = value;
  el.textContent = label;
  return el;
}

function labelText(text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "wf-label";
  el.textContent = text;
  return el;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const el = document.createElement("label");
  el.className = "wf-field";
  el.append(labelText(label), control);
  return el;
}

function iconButton(glyph: string, title: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "wf-icon";
  el.textContent = glyph;
  el.title = title;
  el.addEventListener("click", onClick);
  return el;
}
