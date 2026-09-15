/**
 * The look: skin, outlines, corners, glow, backdrop, written onto one element.
 *
 * Shared by the explorer and the pop-out windows, which read the same settings
 * (same origin, same storage) and would otherwise draw every pop-out in the
 * classic skin whatever the explorer is set to.
 *
 * `classic`, `full` and `none` are written as attributes anyway rather than
 * removed. An absent attribute and a default one look identical to CSS here,
 * and having the value on the element is worth a lot when someone sends a
 * screenshot of the DOM asking why their app looks like that.
 */

import { PREF } from "./registry";
import type { SettingsStore } from "./store";

export function applyLook(root: HTMLElement, settings: SettingsStore): void {
  root.dataset["skin"] = settings.get<string>(PREF.skin);
  root.dataset["outlines"] = settings.get<string>(PREF.outlines);
  root.dataset["backdrop"] = settings.get<string>(PREF.backdrop);
  root.style.setProperty("--fct-corner", String(settings.get<number>(PREF.corners)));

  /* Present only above zero, and skin.css explains why: its glow rules set
     `box-shadow` outright, and that sheet is imported last, so leaving them
     live at zero would quietly wipe the shadow every other stylesheet puts on a
     pressed button -- for everyone, including the majority who never turn this
     on. */
  const glow = settings.get<number>(PREF.glow);
  if (glow > 0) {
    root.dataset["glow"] = String(glow);
    root.style.setProperty("--fct-glow", String(glow));
  } else {
    delete root.dataset["glow"];
    root.style.setProperty("--fct-glow", "0");
  }
}
