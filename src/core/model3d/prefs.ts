/**
 * The 3D viewer's remembered preferences (item A19), as one typed value.
 *
 * The settings store speaks in ids and loosely typed values, which is right for
 * a panel that lists eighty of them and wrong for a viewer that wants six. So
 * this is the translation, in both directions, and nothing else: the viewer
 * reads a `ScenePrefs` when it opens and writes back one field at a time as the
 * side panel changes.
 *
 * Its own module, and handed a store rather than reaching for the app's, so the
 * harness can round-trip it through a memory backend and prove that what the
 * panel writes is what the next session reads — including that a value the
 * store would not accept (a tone map from a newer build, say) comes back as the
 * default rather than as a string the renderer has no case for.
 *
 * DOM-free and three-free.
 */

import { PREF } from "@core/settings/registry";
import type { SettingsStore } from "@core/settings/store";

export type ToneMapName = "neutral" | "aces" | "agx" | "none";
export type BackgroundName = "theme" | "gradient" | "black" | "studio" | "environment";

export const TONE_MAPS: readonly ToneMapName[] = ["neutral", "aces", "agx", "none"];
export const BACKGROUNDS: readonly BackgroundName[] = ["theme", "gradient", "black", "studio", "environment"];

export interface ScenePrefs {
  toneMap: ToneMapName;
  exposure: number;
  background: BackgroundName;
  environment: boolean;
  /** Turns per minute. */
  turntableSpeed: number;
  panelOpen: boolean;
}

const IDS: Readonly<Record<keyof ScenePrefs, string>> = {
  toneMap: PREF.sceneToneMap,
  exposure: PREF.sceneExposure,
  background: PREF.sceneBackground,
  environment: PREF.sceneEnvironment,
  turntableSpeed: PREF.sceneTurntableSpeed,
  panelOpen: PREF.scenePanelOpen,
};

export function readScenePrefs(store: SettingsStore): ScenePrefs {
  const toneMap = store.get<string>(IDS.toneMap);
  const background = store.get<string>(IDS.background);
  const exposure = store.get<number>(IDS.exposure);
  const speed = store.get<number>(IDS.turntableSpeed);
  return {
    // The store already refuses a choice it does not list; checking again here
    // is for a store with nothing registered, where every read is undefined.
    toneMap: (TONE_MAPS as readonly string[]).includes(toneMap) ? (toneMap as ToneMapName) : "neutral",
    exposure: Number.isFinite(exposure) ? exposure : 1,
    background: (BACKGROUNDS as readonly string[]).includes(background) ? (background as BackgroundName) : "theme",
    environment: store.get<boolean>(IDS.environment) !== false,
    turntableSpeed: Number.isFinite(speed) ? speed : 4,
    panelOpen: store.get<boolean>(IDS.panelOpen) === true,
  };
}

/** Write one preference back. The store coerces, clamps and persists. */
export function writeScenePref<K extends keyof ScenePrefs>(store: SettingsStore, key: K, value: ScenePrefs[K]): void {
  store.set(IDS[key], value);
}
