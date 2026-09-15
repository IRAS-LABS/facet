/**
 * The audio dock — a bar, not a screen.
 *
 * Tapping a recording in the All tab used to hand it to the desktop player
 * panel, a full-screen surface built for a keyboard. But listening is not like
 * viewing: you play a voice note *while* continuing to scroll, so the player
 * belongs at the bottom edge with the list still live above it. The browser's
 * own `<audio controls>` does the actual playing — seek bar, position, pause,
 * all native and all free.
 *
 * z-index 39, one below the panel layer on purpose: the shell's back-button
 * handler closes any fixed body child at z≥40, and a dock that the back button
 * silently closes instead of leaving the tab would eat one press every time
 * music is playing. The ✕ is the way to close it; back keeps meaning back.
 *
 * **The rail is why this file grew.** The dock used to be the bar and nothing
 * else, and because `PhoneShell.open` sends every audio file here and returns,
 * the bar was the whole of what a sound file could do on a phone: play, and
 * pause. Eleven tools in the catalogue name audio -- Transcribe, Subtitles,
 * Denoise, Volume, Normalise, Mono, Trim, Speed, Join, Fade, Quality -- and
 * `phoneTool` in `main.ts` implements every one of them for audio. None of
 * them had a way in. Found by pressing the only other control on the bar, the
 * `⋮` at the end of the native `<audio controls>`, which offers Download and
 * Playback speed and belongs to the browser rather than to this app.
 *
 * So the same `EditRail` the viewer uses is mounted under the player, driven
 * by the same catalogue and running through the same `shell.runTool`. Nothing
 * about the tools is restated here; a tool added to the catalogue for audio
 * appears on this rail without this file being touched.
 */

import type { FileEntry, FileKind } from "@core/explorer/types";

import { EditRail, type RailStatus } from "../edit-rail";
import { settleDuration } from "../media";
import { appliesTo, type PhoneTool } from "./tools";
import { el } from "./dom";
import { iconBtn } from "./photos-tab";
import type { PhoneShell } from "./shell";

export class AudioDock {
  readonly el: HTMLElement;

  private nameEl: HTMLElement;
  private audio: HTMLAudioElement;
  private rail: EditRail;
  /** What is loaded, and so what the rail acts on. */
  private item: FileEntry | null = null;

  constructor(private readonly shell: PhoneShell) {
    this.nameEl = el("span.ph-dock-name");
    this.audio = el<"audio">("audio", { controls: true, preload: "metadata" });
    this.rail = new EditRail({
      kind: (): FileKind => this.item?.kind ?? "audio",
      /*
       * Every tool the catalogue lists for this kind has a case in `phoneTool`,
       * so the rail routes all of them -- but only the ones the catalogue does
       * list. `groupTools` deliberately returns inapplicable tools marked
       * rather than dropping them (its rule 3: a sheet that reshuffles per file
       * cannot be learned), which means `routes` is the *only* thing deciding
       * which category buttons exist. Returning a flat `true` put all nine on
       * screen over a voice recording: Light, Blur, Shape, Frame and Sign next
       * to a seven-second .weba, every one of them a menu of greyed rows.
       * Observed on a test phone, 2026-09-10.
       */
      routes: (t: PhoneTool): boolean =>
        this.item !== null && appliesTo(t, this.item.kind),
      status: (t: PhoneTool): RailStatus => {
        const item = this.item;
        if (!item) return { enabled: false, why: "Nothing is open", on: false };
        const ok = appliesTo(t, item.kind);
        return {
          enabled: ok,
          why: ok ? t.hint : `Not available for ${item.kind} files`,
          on: false,
        };
      },
      run: (t: PhoneTool): void => {
        const item = this.item;
        if (!item) return;
        // The panel a tool opens does its own playing. Two things making sound
        // at once is the same mistake the desktop's transcribe key already
        // avoids by closing the player first.
        this.audio.pause();
        if (!this.shell.runTool(item, t.id)) this.shell.flash("Not available for this file");
      },
      say: (m: string): void => this.shell.flash(m),
    });
    this.el = el("div.ph-dock", { hidden: true },
      el("div.ph-dock-row", {},
        this.nameEl,
        iconBtn("✕", "Close player", () => this.close()),
      ),
      this.audio,
      this.rail.element,
    );
    document.body.append(this.el);
  }

  async play(item: FileEntry): Promise<void> {
    this.item = item;
    this.nameEl.textContent = item.name;
    this.el.hidden = false;
    this.rail.refresh();
    this.reserve();
    try {
      this.audio.src = await this.shell.fs.fileUrl(item.path);
      // A streamed WebM carries no length in its header, so the native
      // transport reads it as `Infinity` and renders whatever it has buffered
      // -- `0:04 / 0:07` over a 57-second voice recording, observed on a test phone.
      // Not awaited: the scrubber can be wrong for a moment, but the play call
      // must not wait on a probe that ends in a two-second timeout.
      void settleDuration(this.audio);
      await this.audio.play();
    } catch {
      // Autoplay refused or the codec is not one the WebView carries. The
      // controls are still up with the file loaded, so the user's next tap on
      // the native play button is the retry.
    }
  }

  close(): void {
    this.rail.close();
    this.item = null;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.el.hidden = true;
    document.body.classList.remove("fct-docked");
    document.body.style.removeProperty("--fct-dock-h");
  }

  /**
   * Tell the scrolling body how tall the dock is.
   *
   * The dock is `position: fixed`, so it is outside every layout it covers --
   * and what it covers is the last row of whatever is behind it. Scroll a photo
   * grid to the end with music playing and the final row sits under the player
   * with no way to reach it. The height is measured rather than written down
   * because the dock grows with the file name and with the bottom safe area,
   * and a number typed into the stylesheet would be wrong on the first phone
   * that disagreed.
   */
  private reserve(): void {
    requestAnimationFrame(() => {
      if (this.el.hidden) return;
      document.body.style.setProperty("--fct-dock-h", `${Math.ceil(this.el.getBoundingClientRect().height)}px`);
      document.body.classList.add("fct-docked");
    });
  }

  dispose(): void {
    this.close();
    this.el.remove();
  }
}
