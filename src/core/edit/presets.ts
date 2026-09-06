/**
 * Filter presets: named looks built from the light-and-colour controls.
 *
 * A preset is nothing but a set of slider positions, which is what keeps it
 * honest — every look here can be reproduced or dialled back by hand, and the
 * intensity slider is a plain scale on those positions. No LUT files, no
 * second render path: `applyAdjust` draws the preview, the export and the
 * thumbnail strip alike.
 *
 * Kept in `core/edit` so the desktop can offer the same ten by name.
 */

import { noAdjust, type Adjust } from "./color";

export interface Preset {
  id: string;
  label: string;
  /** The slider positions at full intensity. Unlisted fields stay at zero. */
  look: Partial<Adjust>;
}

export const PRESETS: readonly Preset[] = [
  { id: "vivid", label: "Vivid", look: { vibrance: 0.55, contrast: 0.14, saturation: 0.1 } },
  { id: "warm", label: "Warm", look: { warmth: 0.4, brightness: 0.05, vibrance: 0.15 } },
  { id: "cool", label: "Cool", look: { warmth: -0.4, tint: -0.08, contrast: 0.06 } },
  { id: "mono", label: "Mono", look: { saturation: -1, contrast: 0.08 } },
  { id: "noir", label: "Noir", look: { saturation: -1, contrast: 0.4, shadows: -0.2, vignette: 0.45 } },
  { id: "fade", label: "Fade", look: { fade: 0.55, contrast: -0.12, saturation: -0.15 } },
  { id: "film", label: "Film", look: { warmth: 0.18, fade: 0.25, contrast: 0.12, vignette: 0.22, saturation: -0.08 } },
  { id: "punch", label: "Punch", look: { contrast: 0.32, vibrance: 0.4, sharpness: 0.2, shadows: 0.1 } },
  { id: "soft", label: "Soft", look: { contrast: -0.22, brightness: 0.08, highlights: -0.15, warmth: 0.08 } },
  { id: "matte", label: "Matte", look: { fade: 0.38, shadows: 0.22, highlights: -0.12, saturation: -0.1 } },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/**
 * The adjustments a preset contributes at a given strength, 0…1.
 *
 * Linear in intensity. Perceptually that is not quite right for contrast, but
 * a preset slider that behaves differently per field is one nobody can
 * predict, and 50% meaning "half of every slider" is at least a rule.
 */
export function presetAdjust(preset: Preset, intensity: number): Adjust {
  const out = noAdjust();
  const k = Math.max(0, Math.min(1, intensity));
  for (const key of Object.keys(preset.look) as (keyof Adjust)[]) {
    out[key] = (preset.look[key] ?? 0) * k;
  }
  return out;
}

/**
 * Manual adjustments plus a preset, as the one `Adjust` the renderer takes.
 *
 * Added, then clamped to the slider range. Adding rather than replacing is
 * what lets someone pick "Warm" and then still open the shadows a little
 * without the preset vanishing the moment they touch a slider.
 */
export function combineAdjust(manual: Adjust, preset: Preset | undefined, intensity: number): Adjust {
  if (!preset || intensity <= 0) return { ...manual };
  const add = presetAdjust(preset, intensity);
  const out = { ...manual };
  for (const key of Object.keys(out) as (keyof Adjust)[]) {
    const v = out[key] + add[key];
    const lo = key === "sharpness" || key === "vignette" || key === "fade" ? 0 : -1;
    out[key] = v < lo ? lo : v > 1 ? 1 : v;
  }
  return out;
}
