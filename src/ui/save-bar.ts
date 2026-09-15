/**
 * The end of every editor: a name, Save a copy, and Overwrite original.
 *
 * One component rather than one per screen, because the guarantee has to be
 * identical everywhere. See `@core/save` for the rules it enforces; this is
 * only their shape on screen.
 *
 * Three things are deliberate.
 *
 * **Copy is the primary button and overwrite is not.** The dangerous one is
 * styled as dangerous and sits to the right of the safe one, so the muscle
 * memory that develops is the harmless one.
 *
 * **Overwrite arms before it fires.** The first click changes it to "Sure?
 * Overwrite it" and it disarms itself after four seconds. The same pattern the
 * metadata panel already used, lifted out so it is not re-implemented with a
 * different timeout on the next screen.
 *
 * **The backup is announced, not assumed.** After an overwrite the status line
 * names the file the previous version was kept in, because a promise the user
 * cannot see is a promise they have to take on faith.
 */

import { baseName, overwriteWithBackup, writeFree, type SaveHost } from "@core/save";
import { el } from "./phone/dom";
import { icon } from "./phone/icons";

export interface SaveBarOpts {
  host: SaveHost;
  /** The file being edited. Overwrite targets this path. */
  path(): string;
  /** Produce the bytes to save. Thrown errors are shown, not swallowed. */
  bytes(): Promise<Uint8Array>;
  /** Told what happened, so the shell can refresh a listing. */
  done?(written: string): void;
  /** Progress and errors. Defaults to the bar's own status line. */
  say?(text: string, bad?: boolean): void;
  /** Label for the copy button. "Save a copy" unless a screen has a better word. */
  copyLabel?: string;
  /** Whether overwriting is offered at all — off for a new file with no original. */
  allowOverwrite?: boolean;
}

/** How long the armed overwrite stays armed. */
const ARM_MS = 4000;

export class SaveBar {
  readonly root = el("div.fct-savebar");
  readonly nameIn = el("input.fct-savebar-name") as HTMLInputElement;
  private readonly status = el("span.fct-savebar-status");
  private readonly copyBtn: HTMLButtonElement;
  private readonly overBtn: HTMLButtonElement;
  private armed = false;
  private timer = 0;
  private busy = false;

  constructor(private readonly opts: SaveBarOpts) {
    this.nameIn.placeholder = "new file name";
    this.nameIn.title = "The copy's name. The original keeps its own.";

    this.copyBtn = el("button.fct-savebar-btn.is-primary", {
      type: "button",
      title: "Writes a new file beside the original. The original is not touched.",
    }, icon("copy"), opts.copyLabel ?? "Save a copy") as HTMLButtonElement;
    this.copyBtn.addEventListener("click", () => void this.run("copy"));

    this.overBtn = el("button.fct-savebar-btn.is-danger", {
      type: "button",
      title: "Replaces the original. The previous version is kept beside it as “(original)”.",
    }, icon("save"), "Overwrite original") as HTMLButtonElement;
    this.overBtn.addEventListener("click", () => this.arm());

    this.root.append(this.status, el("div.fct-savebar-spacer"), this.nameIn, this.copyBtn);
    if (opts.allowOverwrite !== false) this.root.append(this.overBtn);
  }

  /** Put a name in the field — usually `suffixed(path, "-signed")`. */
  setName(name: string): void {
    this.nameIn.value = name;
  }

  /**
   * Show or hide the overwrite button for the file currently open.
   *
   * Some screens can only produce a different format from the one they opened
   * — the signing panel renders a JPEG page to PNG, because re-encoding a
   * user's scan to JPEG a second time throws away detail they did not agree to
   * lose. Writing those bytes back over `photo.jpg` would leave a PNG wearing a
   * JPEG's name, so the honest answer is that this particular file cannot be
   * overwritten, said out loud rather than by a button that fails.
   */
  allowOverwrite(on: boolean, why?: string): void {
    this.disarm();
    if (on) {
      if (!this.overBtn.isConnected) this.root.append(this.overBtn);
      this.overBtn.title = "Replaces the original. The previous version is kept beside it as “(original)”.";
      return;
    }
    this.overBtn.remove();
    if (why) this.nameIn.title = why;
  }

  say(text: string, bad = false): void {
    if (this.opts.say) {
      this.opts.say(text, bad);
      return;
    }
    this.status.textContent = text;
    this.status.classList.toggle("is-bad", bad && text.length > 0);
  }

  private disarm(): void {
    this.armed = false;
    window.clearTimeout(this.timer);
    this.overBtn.textContent = "";
    this.overBtn.append(icon("save"), "Overwrite original");
    this.overBtn.classList.remove("is-armed");
  }

  private arm(): void {
    if (this.busy) return;
    if (this.armed) {
      this.disarm();
      void this.run("overwrite");
      return;
    }
    this.armed = true;
    this.overBtn.textContent = "Sure? Overwrite it";
    this.overBtn.classList.add("is-armed");
    this.timer = window.setTimeout(() => this.disarm(), ARM_MS);
  }

  private async run(mode: "copy" | "overwrite"): Promise<void> {
    if (this.busy) return;
    const dir = this.opts.path().slice(0, Math.max(
      this.opts.path().lastIndexOf("/"),
      this.opts.path().lastIndexOf("\\"),
    ));
    const name = this.nameIn.value.trim();
    if (mode === "copy" && name.length === 0) {
      this.say("give the copy a name first", true);
      this.nameIn.focus();
      return;
    }

    this.busy = true;
    this.copyBtn.disabled = true;
    this.overBtn.disabled = true;
    this.say(mode === "copy" ? "writing…" : "backing up the original…");
    try {
      const bytes = await this.opts.bytes();
      if (bytes.length === 0) throw new Error("nothing was produced");
      if (mode === "copy") {
        const out = await writeFree(this.opts.host, `${dir}/${name}`, bytes);
        this.say(`saved ${baseName(out)}`);
        this.opts.done?.(out);
      } else {
        const r = await overwriteWithBackup(this.opts.host, this.opts.path(), bytes);
        this.say(`saved — previous version kept as ${baseName(r.backup)}`);
        this.opts.done?.(r.path);
      }
    } catch (err) {
      this.say(err instanceof Error ? err.message : String(err), true);
    } finally {
      this.busy = false;
      this.copyBtn.disabled = false;
      this.overBtn.disabled = false;
    }
  }
}
