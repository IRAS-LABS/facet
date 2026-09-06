/**
 * The metadata panel — what a file says about you, and the button that removes
 * it.
 *
 * `@core/meta/exif` does the byte work; this is the surface that makes it a
 * feature. Two things it deliberately does *not* do:
 *
 * It never opens a map. Coordinates copy to the clipboard instead, because a
 * privacy tool that hands your house to a mapping service the moment you look
 * at it has missed the point.
 *
 * It never quietly overwrites. "Save a clean copy" is the primary action and
 * writes `<name>-clean.<ext>` beside the original; cleaning in place exists,
 * but it arms on the first click and only fires on the second, because there is
 * no undo for a file you replaced.
 */

import { formatSize, type FileEntry } from "@core/explorer/types";
import { readMetadata, strip, type Metadata, type MetaGroup } from "@core/meta/exif";

export interface MetaHost {
  /** The whole file. Metadata is not all at the front — see the note below. */
  readAll(path: string, max: number): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array, overwrite: boolean): Promise<string>;
  /** Called after files are written so the folder shows them. */
  refresh(): void;
}

/**
 * Read whole or not at all.
 *
 * EXIF sits near the front of a JPEG, so a head read would usually do — but a
 * PNG's text chunks can follow the image data, and a Samsung motion-photo
 * trailer lives *past* the end of the picture entirely. Reading a prefix would
 * mean reporting "nothing to see here" about a file with three seconds of video
 * hidden in its tail. The cap only exists because the bytes cross an IPC
 * boundary; anything over it is declined out loud rather than half-read.
 */
const MAX_BYTES = 96 * 1024 * 1024;

/**
 * Tag names that mean "this is about a person, a place or a device".
 *
 * Matched against the names `exif.ts` actually emits — a pattern here that
 * matches nothing is a warning that silently never fires, which is worse than
 * no warning at all because the panel looks like it checked.
 */
const FLAGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Appended data$/, "It has data hidden after the image ends"],
  [/serial/i, "It carries your camera's serial number"],
  [/^Camera (make|model)$/, "It names the camera it was taken on"],
  [/^Lens/, "It names the lens"],
  [/^Software$/, "It names the software that last wrote it"],
  [/^(Taken|Digitised|Date\/time)$/, "It records the exact second it was taken"],
  [/^Time zone/, "It records your time zone, which is a third of the way to where you were"],
  [/^Image unique ID$/, "It carries a per-photo identifier that can be matched across copies"],
  [/^(Artist|Camera owner|Copyright|Description)$/, "It carries an author or description field"],
  [/maker note/i, "It carries a vendor maker-note block"],
];

export class MetaPanel {
  private readonly root = document.createElement("div");
  private readonly card = document.createElement("div");
  private readonly heading = document.createElement("h3");
  private readonly sub = document.createElement("p");
  private readonly body = document.createElement("div");
  private readonly foot = document.createElement("div");
  private readonly status = document.createElement("p");

  /** Guards against a slow read painting into a panel that moved on. */
  private token = 0;
  private targets: FileEntry[] = [];

  constructor(private readonly host: MetaHost) {
    this.root.className = "mp";
    this.root.hidden = true;
    this.card.className = "mp-card";
    this.heading.className = "mp-title";
    this.sub.className = "mp-sub";
    this.body.className = "mp-body";
    this.foot.className = "mp-foot";
    this.status.className = "mp-status";
    this.foot.append(this.status);
    this.card.append(this.heading, this.sub, this.body, this.foot);
    this.root.append(this.card);
    document.body.appendChild(this.root);

    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /**
   * What this surface is showing, for the session record. The panel can be
   * looking at a whole selection; the first file is what its title says.
   */
  get openPath(): string | null {
    return this.isOpen ? (this.targets[0]?.path ?? null) : null;
  }

  close(): void {
    this.root.hidden = true;
    this.body.replaceChildren();
    this.token++;
  }

  toggle(selection: FileEntry[]): void {
    if (this.isOpen) {
      this.close();
      return;
    }
    void this.show(selection);
  }

  async show(selection: FileEntry[]): Promise<void> {
    const files = selection.filter((e) => e.kind !== "folder");
    const first = files[0];
    if (!first) return;

    this.targets = files;
    const mine = ++this.token;
    this.root.hidden = false;
    this.heading.textContent = first.name;
    this.sub.textContent =
      files.length > 1
        ? `${files.length} files selected — reading the first, cleaning applies to all ${files.length}`
        : first.path;
    this.body.replaceChildren(note("Reading…"));
    this.foot.replaceChildren(this.status);
    this.status.textContent = "";

    const size = first.size ?? 0;
    if (size > MAX_BYTES) {
      this.body.replaceChildren(
        note(
          `${formatSize(size)} — too large to read whole, and metadata is not all at the front. ` +
            `Reading part of it would mean reporting "nothing here" about a file that may hide a lot.`,
        ),
      );
      return;
    }

    let meta: Metadata;
    let bytes: Uint8Array;
    try {
      bytes = await this.host.readAll(first.path, size || MAX_BYTES);
      if (mine !== this.token) return;
      meta = readMetadata(bytes);
    } catch (e) {
      if (mine !== this.token) return;
      this.body.replaceChildren(note(`Could not read this file — ${String(e)}`));
      return;
    }

    this.paint(first, meta, bytes.length);
  }

  // ── Painting ──────────────────────────────────────────────────────────────

  private paint(entry: FileEntry, meta: Metadata, read: number): void {
    if (meta.format === "") {
      this.body.replaceChildren(
        note(
          `No metadata FACET can read. Supported containers are JPEG, TIFF and ` +
            `TIFF-based RAW, PNG and WebP — a .${entry.ext} either carries none or ` +
            `keeps it somewhere this does not parse yet.`,
        ),
      );
      return;
    }

    const parts: HTMLElement[] = [];
    const tags = meta.groups.flatMap((g) => g.tags);

    if (meta.sensitive) parts.push(this.banner(meta, tags.map((t) => t.name)));
    if (meta.gps) parts.push(this.gps(meta.gps.lat, meta.gps.lon, meta.gps.alt));

    if (tags.length === 0) {
      parts.push(note("Clean already — this file carries no metadata worth showing."));
    }
    for (const g of meta.groups) parts.push(group(g));

    this.body.replaceChildren(...parts);
    this.sub.textContent =
      `${meta.format.toUpperCase()} · ${formatSize(read)} read · ` +
      `${tags.length} field${tags.length === 1 ? "" : "s"}` +
      (this.targets.length > 1 ? ` · ${this.targets.length} files selected` : "");

    this.buildActions(meta);
  }

  /** The red box. Named reasons, not a generic warning — vague alarms get ignored. */
  private banner(meta: Metadata, names: string[]): HTMLElement {
    const box = document.createElement("div");
    box.className = "mp-alert";
    const h = document.createElement("strong");
    h.textContent = "This file says things about you.";
    const ul = document.createElement("ul");
    const said = new Set<string>();
    if (meta.gps) said.add("It records where it was taken");
    for (const n of names) {
      for (const [re, why] of FLAGS) if (re.test(n)) said.add(why);
    }
    for (const line of said) {
      const li = document.createElement("li");
      li.textContent = line;
      ul.append(li);
    }
    box.append(h, ul);
    return box;
  }

  private gps(lat: number, lon: number, alt?: number): HTMLElement {
    const box = document.createElement("div");
    box.className = "mp-gps";

    const label = document.createElement("div");
    label.className = "mp-gps-label";
    label.textContent = "Where this was taken";

    const value = document.createElement("div");
    value.className = "mp-gps-value";
    const plain = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    value.textContent = plain + (alt !== undefined ? `  ·  ${Math.round(alt)} m` : "");

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "mp-btn";
    copy.textContent = "Copy coordinates";
    // Copy, never open. Handing the coordinates to a map provider to look at
    // them would leak exactly the thing this panel exists to warn you about.
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(plain);
      copy.textContent = "Copied";
      window.setTimeout(() => { copy.textContent = "Copy coordinates"; }, 1600);
    });

    box.append(label, value, copy);
    return box;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  private buildActions(meta: Metadata): void {
    this.foot.replaceChildren();

    if (!meta.strippable) {
      this.status.textContent = "Nothing to remove in this format.";
      this.foot.append(this.status);
      return;
    }

    const n = this.targets.length;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "mp-btn mp-btn-primary";
    copy.textContent = n > 1 ? `Save ${n} clean copies` : "Save a clean copy";
    copy.title = "Writes <name>-clean next to the original. The original is untouched.";
    copy.addEventListener("click", () => void this.run("copy", copy));

    // Armed rather than immediate: there is no undo for a replaced file, and
    // this is one click away from a destination folder full of originals.
    const place = document.createElement("button");
    place.type = "button";
    place.className = "mp-btn mp-btn-danger";
    const rest = n > 1 ? `Replace ${n} originals` : "Clean in place";
    place.textContent = rest;
    place.title = "Overwrites the original. No undo.";
    let armed = false;
    place.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        place.textContent = n > 1 ? `Sure? Replace all ${n}` : "Sure? Overwrite it";
        place.classList.add("is-armed");
        window.setTimeout(() => {
          if (!armed) return;
          armed = false;
          place.textContent = rest;
          place.classList.remove("is-armed");
        }, 4000);
        return;
      }
      armed = false;
      place.textContent = rest;
      place.classList.remove("is-armed");
      void this.run("inplace", place);
    });

    this.foot.append(copy, place, this.status);
  }

  /**
   * One failure does not stop the run. A batch that aborts on the third of forty
   * files leaves you with no idea which of the other thirty-seven were done, so
   * everything is attempted and the failures are listed at the end.
   */
  private async run(mode: "copy" | "inplace", btn: HTMLButtonElement): Promise<void> {
    const files = this.targets;
    for (const b of this.foot.querySelectorAll("button")) b.disabled = true;

    let done = 0;
    let saved = 0;
    const skipped: string[] = [];
    const failed: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i] as FileEntry;
      this.status.textContent = `${i + 1} of ${files.length} — ${f.name}`;
      try {
        if ((f.size ?? 0) > MAX_BYTES) {
          skipped.push(`${f.name} (too large)`);
          continue;
        }
        const bytes = await this.host.readAll(f.path, f.size ?? MAX_BYTES);
        const r = strip(bytes);
        if (!r) {
          skipped.push(`${f.name} (format not strippable)`);
          continue;
        }
        if (mode === "inplace") await this.host.writeFile(f.path, r.bytes, true);
        else await this.writeCopy(f.path, r.bytes);
        saved += r.saved;
        done++;
      } catch (e) {
        failed.push(`${f.name}: ${String(e).slice(0, 70)}`);
      }
    }

    const bits = [`${done} cleaned`];
    if (saved > 0) bits.push(`${formatSize(saved)} of metadata removed`);
    if (skipped.length) bits.push(`${skipped.length} skipped`);
    if (failed.length) bits.push(`${failed.length} failed`);
    this.status.textContent = bits.join(" · ");

    if (failed.length || skipped.length) {
      const list = document.createElement("ul");
      list.className = "mp-fails";
      for (const line of [...failed, ...skipped]) {
        const li = document.createElement("li");
        li.textContent = line;
        list.append(li);
      }
      this.foot.append(list);
    }

    for (const b of this.foot.querySelectorAll("button")) b.disabled = false;
    btn.blur();
    this.host.refresh();
  }

  /**
   * `<name>-clean.<ext>`, stepping to `-clean-2` rather than overwriting. Losing
   * the first cleaned copy to the second would be a silent data loss inside the
   * one action whose entire promise is that it does not touch what exists.
   */
  private async writeCopy(path: string, bytes: Uint8Array): Promise<string> {
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    const hasExt = dot > slash;
    const stem = hasExt ? path.slice(0, dot) : path;
    const ext = hasExt ? path.slice(dot) : "";
    for (let n = 1; n <= 20; n++) {
      const candidate = n === 1 ? `${stem}-clean${ext}` : `${stem}-clean-${n}${ext}`;
      try {
        return await this.host.writeFile(candidate, bytes, false);
      } catch (e) {
        if (!String(e).includes("already exists")) throw e;
      }
    }
    throw new Error("20 cleaned copies already exist beside this file");
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function note(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "mp-note";
  p.textContent = text;
  return p;
}

function group(g: MetaGroup): HTMLElement {
  const box = document.createElement("section");
  box.className = "mp-group";
  const h = document.createElement("h4");
  h.textContent = g.name;
  const dl = document.createElement("dl");
  for (const t of g.tags) {
    const dt = document.createElement("dt");
    dt.textContent = t.name;
    // The numeric id on hover rather than on screen: it is the thing you need
    // exactly once, when a value looks wrong and you want to look it up.
    if (t.id !== undefined) dt.title = `0x${t.id.toString(16).padStart(4, "0")}`;
    const dd = document.createElement("dd");
    dd.textContent = t.value;
    dl.append(dt, dd);
  }
  box.append(h, dl);
  return box;
}
