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
 */

import { el } from "./dom";
import { iconBtn } from "./photos-tab";
import type { PhoneShell } from "./shell";

export class AudioDock {
  readonly el: HTMLElement;

  private nameEl: HTMLElement;
  private audio: HTMLAudioElement;

  constructor(private readonly shell: PhoneShell) {
    this.nameEl = el("span.ph-dock-name");
    this.audio = el<"audio">("audio", { controls: true, preload: "metadata" });
    this.el = el("div.ph-dock", { hidden: true },
      el("div.ph-dock-row", {},
        this.nameEl,
        iconBtn("✕", "Close player", () => this.close()),
      ),
      this.audio,
    );
    document.body.append(this.el);
  }

  async play(item: { name: string; path: string }): Promise<void> {
    this.nameEl.textContent = item.name;
    this.el.hidden = false;
    try {
      this.audio.src = await this.shell.fs.fileUrl(item.path);
      await this.audio.play();
    } catch {
      // Autoplay refused or the codec is not one the WebView carries. The
      // controls are still up with the file loaded, so the user's next tap on
      // the native play button is the retry.
    }
  }

  close(): void {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.el.hidden = true;
  }

  dispose(): void {
    this.close();
    this.el.remove();
  }
}
