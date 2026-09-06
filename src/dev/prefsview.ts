/**
 * The real settings panel, with the real declarations, in a plain page.
 *
 * `setcheck.ts` proves the panel *behaves*; this proves it *reads*. Every
 * assertion in the harness passes just as happily against a sheet where the
 * help text wraps into a wall, a group is empty, or a number field is four
 * pixels wide — none of which is something a `===` can notice.
 *
 * Uses a throwaway store so opening this page never touches real preferences,
 * but the declarations are the shipped ones: this is exactly what the app's
 * ctrl+, shows.
 *
 *   http://localhost:8183/prefsview.html
 */

import "../styles/base.css";
import "../styles/settings.css";

import { ALL_SETTINGS } from "@core/settings/registry";
import { memoryBackend, SettingsStore } from "@core/settings/store";
import { SettingsPanel } from "@ui/settings";

const store = new SettingsStore(memoryBackend());
store.register(...ALL_SETTINGS);

const panel = new SettingsPanel(store);

// Stands in for the theme row the app contributes, so the seam is visible here
// too — a group whose only row is a contributed one would otherwise look empty.
panel.addCustom({
  group: "Appearance",
  label: "Theme",
  help: "Contributed by the theme engine, which keeps its own list.",
  keywords: ["colour", "dark", "mocha", "palette"],
  control: () => {
    const sel = document.createElement("select");
    sel.className = "prefs-select";
    for (const name of ["Midnight", "Mocha", "Ash", "Ember"]) {
      const o = document.createElement("option");
      o.textContent = name;
      sel.append(o);
    }
    return sel;
  },
});

panel.open();

// A couple of values off their defaults, so the changed dot and the ↺ button
// are on screen rather than something you have to click to ever see.
store.set("explorer.cardSize", 240);
store.set("appearance.density", 1.15);
