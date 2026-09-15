/**
 * The Kokoro voice list.
 *
 * Ported from the voice the owner's own console has always used, so that the
 * app and the console sound like the same thing rather than two unrelated
 * products. `af_heart` is the default there and is the default here.
 *
 * The identifiers are Kokoro's, not ours, and their shape carries meaning: the
 * first letter is the language, the second is the gender, and the rest is the
 * name. Decoding that here is what lets the picker group 54 voices into
 * something a person can navigate, without a hand-written table that falls out
 * of date the moment the model ships another voice.
 */

/** Every voice in the Kokoro v1.0 pack. */
export const KOKORO_VOICES: readonly string[] = [
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore",
  "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
  "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
  "ef_dora", "em_alex", "em_santa", "ff_siwis",
  "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "if_sara", "im_nicola",
  "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo",
  "pf_dora", "pm_alex", "pm_santa",
  "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi",
  "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
];

/** The one the owner's own assistant has always used. */
export const DEFAULT_VOICE = "af_heart";

const LANGUAGES: Record<string, string> = {
  a: "American",
  b: "British",
  e: "Spanish",
  f: "French",
  h: "Hindi",
  i: "Italian",
  j: "Japanese",
  p: "Portuguese",
  z: "Chinese",
};

/**
 * The language tag each Kokoro prefix speaks.
 *
 * Needed by the phonemiser, which has to know which pronunciation rules to
 * apply, and by the picker so a voice can be matched against the document's
 * own language when one is known.
 */
const TAGS: Record<string, string> = {
  a: "en-US",
  b: "en-GB",
  e: "es-ES",
  f: "fr-FR",
  h: "hi-IN",
  i: "it-IT",
  j: "ja-JP",
  p: "pt-BR",
  z: "zh-CN",
};

const GENDERS: Record<string, string> = { f: "female", m: "male" };

/** What the picker shows for one voice. */
export interface VoiceInfo {
  /** Engine-specific identifier. */
  id: string;
  /** "Heart" -- what the user picks by. */
  name: string;
  /** "American female" -- the grouping line under it. */
  detail: string;
  /** BCP-47, for grouping and for matching the document. */
  lang: string;
  gender: string;
  /** Which engine can speak it. */
  engine: "system" | "kokoro";
  /**
   * Speaks without a network.
   *
   * Android's engine list is mostly voices that are not on the phone at all:
   * Google ships a few hundred "-network" ids that POST the sentence to a
   * server and play back what comes home. That is the opposite of what this
   * reader promises -- a document read aloud is a document sent somewhere --
   * and it is also why the picker had four hundred entries. Offline voices
   * are the only ones the list shows unless somebody asks for the rest.
   */
  offline: boolean;
}

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Decode a Kokoro id into something a person can read. */
export function kokoroInfo(id: string): VoiceInfo {
  const lang = LANGUAGES[id[0] ?? ""] ?? "";
  const gender = GENDERS[id[1] ?? ""] ?? "";
  const name = titleCase(id.slice(3).replace(/_/g, " "));

  return {
    id,
    name: name || id,
    detail: [lang, gender].filter(Boolean).join(" "),
    lang: TAGS[id[0] ?? ""] ?? "en-US",
    gender,
    engine: "kokoro",
    // The model is on disk before a single one of these can speak.
    offline: true,
  };
}

/** Every Kokoro voice, decoded. */
export function kokoroVoices(): VoiceInfo[] {
  return KOKORO_VOICES.map(kokoroInfo);
}

/** The BCP-47 tag a Kokoro voice speaks. */
export const kokoroLang = (id: string): string => TAGS[id[0] ?? ""] ?? "en-US";

/**
 * Group voices for the picker (item 23).
 *
 * Grouped by language, then sorted female-first within each group and by name
 * after that. Female-first is not a judgement about voices -- it puts the
 * default, `af_heart`, at the top of the first group, so the list opens on the
 * voice most people will keep.
 */
export function grouped(voices: readonly VoiceInfo[]): { label: string; voices: VoiceInfo[] }[] {
  const by = new Map<string, VoiceInfo[]>();

  for (const v of voices) {
    const label = languageName(v.lang);
    const list = by.get(label) ?? [];
    list.push(v);
    by.set(label, list);
  }

  const order = (v: VoiceInfo): number => (v.gender === "female" ? 0 : v.gender === "male" ? 1 : 2);

  return [...by]
    .map(([label, list]) => ({
      label,
      voices: list.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label));
}

/**
 * The languages Android's speech engines offer that a WebView's `Intl` data
 * often does not name.
 *
 * Not a translation table and not trying to be one: `Intl.DisplayNames`
 * answers in the reader's own language and is right about almost everything.
 * These are the gaps, in English, because an English name is a better answer
 * than a two-letter code nobody can read.
 */
const EXTRA: Readonly<Record<string, string>> = {
  as: "Assamese",
  bn: "Bangla",
  brx: "Bodo",
  bs: "Bosnian",
  ceb: "Cebuano",
  cy: "Welsh",
  doi: "Dogri",
  gu: "Gujarati",
  jv: "Javanese",
  kn: "Kannada",
  kok: "Konkani",
  ks: "Kashmiri",
  mai: "Maithili",
  ml: "Malayalam",
  mni: "Manipuri",
  mr: "Marathi",
  ne: "Nepali",
  or: "Odia",
  pa: "Punjabi",
  sa: "Sanskrit",
  sat: "Santali",
  sd: "Sindhi",
  si: "Sinhala",
  su: "Sundanese",
  ta: "Tamil",
  te: "Telugu",
  ur: "Urdu",
};

/** English first, then everything else alphabetically. */
const rank = (label: string): number => (label.startsWith("English") ? 0 : 1);

/**
 * A readable name for a BCP-47 tag.
 *
 * `Intl.DisplayNames` knows every tag a system voice might carry, which is far
 * more than the nine Kokoro speaks, and it answers in the user's own language.
 * It is missing on nothing FACET runs on, but the fallback returns the tag
 * itself rather than throwing, because a picker that crashes on an unusual
 * system voice is worse than one showing "fy-NL".
 */
export function languageName(tag: string): string {
  try {
    const base = tag.split("-")[0] ?? tag;
    const names = new Intl.DisplayNames(undefined, { type: "language" });
    // `of()` answers with the tag itself for a language its ICU data does not
    // carry, and an Android WebView's data is smaller than a desktop
    // browser's -- which is how a voice list came to offer "As", "Brx", "Bs"
    // and "Cy" as though they were words.
    const known = names.of(base);
    const name = known && known.toLowerCase() !== base.toLowerCase() ? known : (EXTRA[base] ?? base);
    const region = tag.split("-")[1];
    if (region && region.length === 2) {
      const regions = new Intl.DisplayNames(undefined, { type: "region" });
      return `${titleCase(name)} (${regions.of(region.toUpperCase()) ?? region})`;
    }
    return titleCase(name);
  } catch {
    return tag;
  }
}

/**
 * The languages a set of voices covers, in the order the picker shows them.
 *
 * Same ordering rule as `grouped` -- English first, then alphabetical -- so
 * the language dropdown and the voice dropdown agree with each other.
 */
export function languages(voices: readonly VoiceInfo[]): { tag: string; label: string }[] {
  const by = new Map<string, string>();
  for (const v of voices) {
    const base = (v.lang.split("-")[0] ?? v.lang).toLowerCase();
    if (!by.has(base)) by.set(base, languageName(base));
  }
  return [...by]
    .map(([tag, label]) => ({ tag, label }))
    .sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label));
}

/** The base language of a tag: "en" for "en-GB", "en-us-x-iob-local" and "en". */
export const baseLang = (tag: string): string => (tag.split("-")[0] ?? tag).toLowerCase();
