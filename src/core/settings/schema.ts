/**
 * What a setting *is* (item 33).
 *
 * Every configurable thing in FACET is declared here as data — id, group,
 * label, type, default — and never as a hand-built form control. That is the
 * whole point of the file: items 35, 36, 37 and 39–43 are each "a few more
 * declarations plus the code that reads them", not another settings screen. A
 * screen built by hand is a screen that drifts from what it configures.
 *
 * The declaration carries the words as well as the type. A setting whose help
 * text lives in the UI file cannot be searched from the store, and item 33 is
 * explicitly "everything configurable, one place, **searchable**".
 */

/** Everything a setting can hold. Deliberately small — see `coerce`. */
export type SettingValue = boolean | number | string;

interface Base<T extends SettingValue> {
  /** Stable, dotted, and never reused: `explorer.confirmDelete`. */
  id: string;
  /** The heading it appears under. Groups are ordered by `GROUPS`. */
  group: string;
  label: string;
  /**
   * What it does, in words, for the panel and for search. Optional only
   * because a handful of settings really are self-describing.
   */
  help?: string;
  /**
   * Words that should match in search but are not worth showing. "thumbnail"
   * on a setting labelled "Preview size" is the case this exists for.
   */
  keywords?: readonly string[];
  default: T;
  /**
   * Set when a change cannot take effect until the app restarts, so the panel
   * can say so rather than leaving the user to wonder why nothing happened.
   * Most settings should NOT need this — see the note on `live` in `store.ts`.
   */
  restart?: boolean;
}

export interface ToggleSetting extends Base<boolean> {
  kind: "toggle";
}

export interface NumberSetting extends Base<number> {
  kind: "number";
  min: number;
  max: number;
  step?: number;
  /** Shown after the field: "MB", "ms", "px". */
  unit?: string;
}

export interface ChoiceSetting extends Base<string> {
  kind: "choice";
  /** `[value, label]`, in the order they should appear. */
  choices: ReadonlyArray<readonly [string, string]>;
}

export interface TextSetting extends Base<string> {
  kind: "text";
  placeholder?: string;
}

export type Setting = ToggleSetting | NumberSetting | ChoiceSetting | TextSetting;

/**
 * Force a loaded value into something the setting can actually hold.
 *
 * This is the function that makes a hand-edited or half-written settings file
 * a non-event. The rule is the same in every branch: **anything that is not
 * clearly valid becomes the default.** Never throw, never propagate `null`,
 * and never hand a number field a string that will render as `NaN` and then be
 * written back on the next save, corrupting the file a second time.
 *
 * Numbers are clamped rather than rejected, because a value that is merely out
 * of range is a value the user meant — a preview budget of 9999 MB is someone
 * asking for "as much as you'll give me", and silently resetting it to the
 * default reads as the setting being broken.
 */
export function coerce(setting: Setting, raw: unknown): SettingValue {
  switch (setting.kind) {
    case "toggle":
      return typeof raw === "boolean" ? raw : setting.default;

    case "number": {
      // Number("") is 0 and Number(null) is 0, which would turn an empty field
      // into a real setting of zero. Only an actual finite number counts.
      if (typeof raw !== "number" || !Number.isFinite(raw)) return setting.default;
      const clamped = Math.min(setting.max, Math.max(setting.min, raw));
      // A step of 1 on a field that gets 2.5 from somewhere would otherwise
      // persist a fraction the spinner can never show.
      if (setting.step && setting.step > 0) {
        const steps = Math.round((clamped - setting.min) / setting.step);
        const snapped = setting.min + steps * setting.step;
        // Guard the float: 0.1-steps land on 0.30000000000000004 otherwise.
        const places = decimals(setting.step);
        return Math.min(setting.max, Number(snapped.toFixed(places)));
      }
      return clamped;
    }

    case "choice":
      // A choice that is no longer offered is the interesting case: it happens
      // whenever a build removes an option someone had selected. Falling back
      // to the default is the only safe answer — the alternative is a select
      // element with no matching option, which renders blank.
      return typeof raw === "string" && setting.choices.some(([v]) => v === raw)
        ? raw
        : setting.default;

    case "text":
      return typeof raw === "string" ? raw : setting.default;
  }
}

/** How many decimal places a step implies. `0.25` → 2. */
function decimals(step: number): number {
  const s = String(step);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

/**
 * Does this setting match a search box?
 *
 * Matches label, help, keywords and group, but **not** the id: ids are dotted
 * and internal, and letting them match means typing "e" surfaces every setting
 * whose id starts with `explorer.`, which is worse than useless.
 */
export function matches(setting: Setting, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const hay = [setting.label, setting.help ?? "", setting.group, ...(setting.keywords ?? [])]
    .join(" ")
    .toLowerCase();
  // Every word must appear somewhere, in any order: "preview size" should find
  // a setting labelled "Size of previews".
  return q.split(/\s+/).every((word) => hay.includes(word));
}
