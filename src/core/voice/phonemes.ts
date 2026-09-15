/**
 * Words in, phonemes out.
 *
 * Kokoro does not read letters. It reads IPA, tokenised against a fixed vocab
 * that is part of the model, so something has to stand between the text and
 * the model and decide how every word is pronounced. That is this file.
 *
 * There are two phonemisers here and they are not equals.
 *
 * **espeak-ng**, in `espeak.ts`, does the work whenever the text is English.
 * It reads whole sentences, which is the entire point: it reduces the function
 * words, moves stress across a phrase, and is the front-end Kokoro's own
 * training data came from. This file's header used to argue against shipping
 * it, on the grounds that FACET is MIT and espeak-ng is GPL. That argument
 * lost, out loud, on the evidence of what it sounded like -- see `espeak.ts`
 * for the licence consequence, which is real and was accepted deliberately.
 *
 * **A dictionary and rules**, below, for everything else: the non-English
 * voices, and any machine where espeak fails to load. It is CMUdict converted
 * to IPA at build time, BSD-2-Clause, 812 kB compressed and shipped with the
 * app, plus a compact English letter-to-sound set for the words it does not
 * have. Every entry in it is individually correct, which is what made the
 * problem so hard to see: a row of individually correct pronunciations is not
 * a sentence, and a listener hears the difference immediately even though no
 * single word is wrong.
 *
 * The number normalisation in `normalise` runs either way. espeak can expand
 * numbers itself, but it has never been given FACET's list of abbreviations,
 * and that list is what keeps "et al." and "i.e." and "Fig. 3" from being read
 * as letters in a research paper.
 */

import { part } from "./pack";
import { phonemes as espeakPhonemes } from "./espeak";

/**
 * Kokoro's token vocabulary.
 *
 * This is not ours to choose: it is baked into the model's embedding table,
 * and a symbol in the wrong position produces confident nonsense rather than
 * an error. The order below is the model's own -- padding, then punctuation,
 * then Latin letters, then the IPA inventory.
 */
const PAD = "$";
const PUNCTUATION = ';:,.!?¡¿—…"«»“” ';
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const IPA =
  "ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'ᵻ";

const VOCAB: Map<string, number> = (() => {
  const symbols = [PAD, ...PUNCTUATION, ...LETTERS, ...IPA];
  const map = new Map<string, number>();
  symbols.forEach((s, i) => map.set(s, i));
  return map;
})();

/** The longest token sequence Kokoro accepts, minus the two boundary pads. */
export const MAX_TOKENS = 510;

/** Where the shipped dictionary lives. */
const DICT_URL = `${import.meta.env.BASE_URL}voice/cmudict-ipa.txt.gz`;

let dictOnce: Promise<Map<string, string>> | null = null;

/**
 * Load the pronunciation dictionary.
 *
 * Memoised, and failure is not fatal: an empty map means every word goes
 * through the rules, which is worse but still speaks. A voice that refuses to
 * start because a dictionary is missing would be the wrong failure.
 */
export function dictionary(): Promise<Map<string, string>> {
  dictOnce ??= (async () => {
    const map = new Map<string, string>();
    try {
      // An offline install can put the dictionary in the pack; otherwise it is
      // the copy that shipped with the app.
      const packed = await part("dict");
      const raw = packed ?? (await (await fetch(DICT_URL)).arrayBuffer());
      const text = await gunzip(raw);
      for (const line of text.split("\n")) {
        const tab = line.indexOf("\t");
        if (tab > 0) map.set(line.slice(0, tab), line.slice(tab + 1));
      }
    } catch {
      // Rules only.
    }
    return map;
  })();
  return dictOnce;
}

async function gunzip(buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buf);
  // Not compressed -- an offline install may have supplied plain text.
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return new TextDecoder().decode(bytes);

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

// ── Saying things that are not words ────────────────────────────────────────

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: [number, string][] = [
  [1e9, "billion"],
  [1e6, "million"],
  [1e3, "thousand"],
];

/** A whole number as words. */
export function sayNumber(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n < 0) return `minus ${sayNumber(-n)}`;
  if (n < 20) return ONES[n] as string;
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)] as string;
    const r = n % 10;
    return r ? `${t}-${ONES[r]}` : t;
  }
  if (n < 1000) {
    const h = `${ONES[Math.floor(n / 100)]} hundred`;
    const r = n % 100;
    return r ? `${h} and ${sayNumber(r)}` : h;
  }
  for (const [scale, name] of SCALES) {
    if (n >= scale) {
      const head = `${sayNumber(Math.floor(n / scale))} ${name}`;
      const r = n % scale;
      return r ? `${head} ${sayNumber(r)}` : head;
    }
  }
  return String(n);
}

/**
 * A year, said the way people say years.
 *
 * "1984" is "nineteen eighty-four", not "one thousand nine hundred and
 * eighty-four". A paper is full of years and getting this wrong is the single
 * most noticeable normalisation error there is.
 */
function sayYear(n: number): string {
  if (n < 1100 || n > 2099) return sayNumber(n);
  const hi = Math.floor(n / 100);
  const lo = n % 100;
  if (lo === 0) return `${sayNumber(hi)} hundred`;
  if (n >= 2000 && n < 2010) return sayNumber(n);
  if (lo < 10) return `${sayNumber(hi)} oh ${sayNumber(lo)}`;
  return `${sayNumber(hi)} ${sayNumber(lo)}`;
}

const SYMBOLS: Record<string, string> = {
  "%": " percent ",
  "&": " and ",
  "@": " at ",
  "+": " plus ",
  "=": " equals ",
  "°": " degrees ",
  "©": " copyright ",
  "™": " trademark ",
  "±": " plus or minus ",
  "×": " times ",
  "÷": " divided by ",
  "≤": " less than or equal to ",
  "≥": " greater than or equal to ",
  "≈": " approximately ",
  "≠": " not equal to ",
};

const MONEY: Record<string, string> = { $: "dollars", "£": "pounds", "€": "euros", "¥": "yen" };

/**
 * Abbreviations, said the way a person reading aloud would say them.
 *
 * Without this, "e.g." reaches the letter-to-sound rules as the letters `e`
 * and `g` with a stop between them and comes out as a noise. The same goes for
 * every one of these, and a research paper is made of them.
 *
 * Only expanded where the written form is unambiguous. "St." is left alone
 * because it is Saint as often as Street and guessing wrong is worse than
 * saying the letters. "a.m."/"p.m." are spelled as letters on purpose -- that
 * is how they are said.
 *
 * The key is matched case-insensitively with the trailing stop optional, so
 * "Fig 3" and "Fig. 3" both work. The value replaces the stop as well, which
 * is correct here: this runs on text that has already been split into
 * sentences, so no boundary depends on the stop surviving.
 */
const SPOKEN: Record<string, string> = {
  "e.g": "for example",
  "i.e": "that is",
  "etc": "et cetera",
  "et al": "and others",
  "cf": "compare",
  "viz": "namely",
  "vs": "versus",
  "ibid": "ibid",
  "fig": "figure",
  "figs": "figures",
  "eq": "equation",
  "eqs": "equations",
  "sec": "section",
  "secs": "sections",
  "ch": "chapter",
  "chap": "chapter",
  "tab": "table",
  "ref": "reference",
  "refs": "references",
  "vol": "volume",
  "vols": "volumes",
  "pp": "pages",
  "ed": "editor",
  "eds": "editors",
  "approx": "approximately",
  "dept": "department",
  "univ": "university",
  "dr": "Doctor",
  "prof": "Professor",
  "mr": "Mister",
  "mrs": "Missus",
  "jr": "Junior",
  "sr": "Senior",
};

/**
 * Words whose stopless form is safe to expand.
 *
 * Everything else in the list needs its full stop before it is touched, and
 * the reason is names. "Ed", "Tab" and "Ch" are words and names as well as
 * abbreviations, and reading somebody's name as "editor" is a worse error than
 * leaving an abbreviation unexpanded. These six are the ones that genuinely
 * appear without a stop in papers ("see Fig 3", "Smith et al 2019").
 */
const NO_STOP_NEEDED = new Set(["fig", "figs", "eq", "eqs", "et al", "vs"]);

/** Longest key first, so "et al" is tried before anything it contains. */
const byLength = (a: string, b: string): number => b.length - a.length;
const escaped = (k: string): string => k.replace(/\./g, "\\.");

/**
 * Two expressions rather than one, because the trailing stop is optional for
 * some keys and required for the rest. The trailing lookahead stops "sec" from
 * eating the start of "second";
 * the lookbehind stops it matching inside a word or straight after another
 * stop.
 */
const SPOKEN_LOOSE = new RegExp(
  `(?<![\\p{L}.])(${[...NO_STOP_NEEDED].sort(byLength).map(escaped).join("|")})\\.?(?![\\p{L}])`,
  "giu",
);

const SPOKEN_STRICT = new RegExp(
  `(?<![\\p{L}.])(${Object.keys(SPOKEN).filter((k) => !NO_STOP_NEEDED.has(k)).sort(byLength).map(escaped).join("|")})\\.(?![\\p{L}])`,
  "giu",
);

/**
 * Rewrite text into something that can be looked up word by word.
 *
 * Runs before phonemisation and is where "50%", "$1.2m", "2019", "Fig. 3" and
 * "1,024" become things a dictionary has entries for. Order matters: money
 * before numbers, because the number rule would eat the amount first.
 */
export function normalise(input: string): string {
  let t = input;

  // Abbreviations first, while the stops are still attached to them: the
  // decimal rule below would otherwise have to tell "e.g." from "3.5".
  const spoken = (_: string, key: string): string => SPOKEN[key.toLowerCase()] ?? key;
  t = t.replace(SPOKEN_LOOSE, spoken).replace(SPOKEN_STRICT, spoken);

  // Money: "$4.50" -> "four dollars fifty", "$3" -> "three dollars".
  t = t.replace(/([$£€¥])\s?(\d[\d,]*)(?:\.(\d{1,2}))?/g, (_, sign: string, whole: string, cents?: string) => {
    const unit = MONEY[sign] ?? "";
    const head = sayNumber(Number(whole.replace(/,/g, "")));
    return cents ? `${head} ${unit} ${sayNumber(Number(cents.padEnd(2, "0")))}` : `${head} ${unit}`;
  });

  // Ranges written with an en dash: "pp. 10-24".
  t = t.replace(/(\d)\s?[–—-]\s?(\d)/g, "$1 to $2");

  // Ordinals.
  t = t.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_, n: string) => sayOrdinal(Number(n)));

  // Times of day, before the decimal rule can claim the colon.
  t = t.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h: string, m: string) =>
    m === "00" ? `${sayNumber(Number(h))} o'clock` : `${sayNumber(Number(h))} ${Number(m) < 10 ? "oh " : ""}${sayNumber(Number(m))}`);

  // Decimals: "0.05" -> "zero point zero five".
  t = t.replace(/\b(\d+)\.(\d+)\b/g, (_, whole: string, frac: string) => {
    const digits = [...frac].map((d) => ONES[Number(d)]).join(" ");
    return `${sayNumber(Number(whole))} point ${digits}`;
  });

  // Years, then everything else numeric.
  t = t.replace(/\b(1[1-9]\d{2}|20\d{2})\b/g, (_, y: string) => sayYear(Number(y)));
  t = t.replace(/\b\d[\d,]*\b/g, (m) => sayNumber(Number(m.replace(/,/g, ""))));

  for (const [sym, word] of Object.entries(SYMBOLS)) t = t.split(sym).join(word);

  return t.replace(/\s{2,}/g, " ").trim();
}

function sayOrdinal(n: number): string {
  const base = sayNumber(n);
  const irregular: Record<string, string> = {
    one: "first", two: "second", three: "third", five: "fifth", eight: "eighth",
    nine: "ninth", twelve: "twelfth",
  };
  const last = base.split(/[\s-]/).pop() as string;
  const swapped = irregular[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return base.slice(0, base.length - last.length) + swapped;
}

// ── Letters to sound ────────────────────────────────────────────────────────

/**
 * Letter-to-sound rules, for words with no dictionary entry.
 *
 * Each rule is `[left context, target letters, right context, phonemes]`, and
 * they are tried longest-target first at every position, so "tion" wins over
 * "ti" and "t". Contexts are regular expressions anchored against the text
 * either side, with `#` standing for a word boundary.
 *
 * This is an old technique and the reason it is used here is that it degrades
 * gracefully: an unknown word gets a plausible pronunciation rather than a
 * crash or a silence, and every additional rule improves it without risking
 * the words that were already right.
 */
type Rule = [RegExp | null, string, RegExp | null, string];

const CONSONANT = "[bcdfghjklmnpqrstvwxyz]";

const RULES: Rule[] = [
  // Endings that dominate technical English.
  [null, "tion", null, "ʃən"],
  [null, "sion", null, "ʒən"],
  [null, "cial", null, "ʃəl"],
  [null, "tial", null, "ʃəl"],
  [null, "ough", new RegExp("^t"), "ɒ"],
  [null, "ough", null, "ʌ f"],
  [null, "augh", null, "ɑf"],
  [null, "eigh", null, "eɪ"],
  [null, "ight", null, "aɪt"],
  [null, "tch", null, "ʧ"],
  [null, "dge", null, "ʤ"],
  [null, "que", new RegExp("^$"), "k"],
  [null, "ing", new RegExp("^$"), "ɪŋ"],
  [null, "ness", new RegExp("^$"), "nəs"],
  [null, "ment", new RegExp("^$"), "mənt"],
  [null, "able", new RegExp("^$"), "əbəl"],
  [null, "ible", new RegExp("^$"), "əbəl"],
  [null, "ance", new RegExp("^$"), "əns"],
  [null, "ence", new RegExp("^$"), "əns"],
  [null, "ary", new RegExp("^$"), "ɛri"],
  [null, "ory", new RegExp("^$"), "ɔri"],
  [null, "ous", new RegExp("^$"), "əs"],
  [null, "ure", new RegExp("^$"), "əɹ"],
  [null, "que", null, "k"],

  // Digraphs.
  [null, "sch", null, "sk"],
  [null, "sh", null, "ʃ"],
  [null, "ch", null, "ʧ"],
  [null, "ph", null, "f"],
  [null, "th", null, "θ"],
  [null, "wh", null, "w"],
  [null, "wr", null, "ɹ"],
  [null, "ck", null, "k"],
  [null, "ng", new RegExp("^$"), "ŋ"],
  [null, "qu", null, "kw"],
  [null, "gh", null, ""],
  [null, "kn", new RegExp(""), "n"],
  [null, "ps", new RegExp(""), "s"],

  // Vowel teams.
  [null, "ee", null, "i"],
  [null, "ea", null, "i"],
  [null, "ie", null, "i"],
  [null, "ei", null, "i"],
  [null, "oo", null, "u"],
  [null, "ou", null, "aʊ"],
  [null, "ow", new RegExp("^$"), "oʊ"],
  [null, "ow", null, "aʊ"],
  [null, "oi", null, "ɔɪ"],
  [null, "oy", null, "ɔɪ"],
  [null, "au", null, "ɔ"],
  [null, "aw", null, "ɔ"],
  [null, "ai", null, "eɪ"],
  [null, "ay", null, "eɪ"],
  [null, "oa", null, "oʊ"],
  [null, "ue", null, "u"],
  [null, "ui", null, "u"],

  // R-coloured vowels.
  [null, "ar", new RegExp(`^(?:$|${CONSONANT})`), "ɑɹ"],
  [null, "er", new RegExp(`^(?:$|${CONSONANT})`), "ɚ"],
  [null, "ir", new RegExp(`^(?:$|${CONSONANT})`), "ɜɹ"],
  [null, "ur", new RegExp(`^(?:$|${CONSONANT})`), "ɜɹ"],
  [null, "or", new RegExp(`^(?:$|${CONSONANT})`), "ɔɹ"],

  // Magic e: a single vowel, one consonant, then a final e.
  [null, "a", new RegExp(`^${CONSONANT}e$`), "eɪ"],
  [null, "i", new RegExp(`^${CONSONANT}e$`), "aɪ"],
  [null, "o", new RegExp(`^${CONSONANT}e$`), "oʊ"],
  [null, "u", new RegExp(`^${CONSONANT}e$`), "ju"],
  [null, "e", new RegExp(`^${CONSONANT}e$`), "i"],

  // Soft c and g before a front vowel.
  [null, "c", new RegExp("^[eiy]"), "s"],
  [null, "g", new RegExp("^[eiy]"), "ʤ"],

  // A silent final e, but not in a one-syllable word that needs it.
  [new RegExp(`${CONSONANT}$`), "e", new RegExp("^$"), ""],

  // Single letters.
  [null, "a", null, "æ"],
  [null, "b", null, "b"],
  [null, "c", null, "k"],
  [null, "d", null, "d"],
  [null, "e", null, "ɛ"],
  [null, "f", null, "f"],
  [null, "g", null, "ɡ"],
  [null, "h", null, "h"],
  [null, "i", null, "ɪ"],
  [null, "j", null, "ʤ"],
  [null, "k", null, "k"],
  [null, "l", null, "l"],
  [null, "m", null, "m"],
  [null, "n", null, "n"],
  [null, "o", null, "ɑ"],
  [null, "p", null, "p"],
  [null, "q", null, "k"],
  [null, "r", null, "ɹ"],
  [null, "s", null, "s"],
  [null, "t", null, "t"],
  [null, "u", null, "ʌ"],
  [null, "v", null, "v"],
  [null, "w", null, "w"],
  [null, "x", null, "ks"],
  [null, "y", new RegExp("^$"), "i"],
  [null, "y", null, "j"],
  [null, "z", null, "z"],
];

/** Rules grouped by their first letter, longest target first. */
const BY_LETTER = (() => {
  const map = new Map<string, Rule[]>();
  for (const rule of RULES) {
    const key = rule[1][0] as string;
    const list = map.get(key) ?? [];
    list.push(rule);
    map.set(key, list);
  }
  for (const list of map.values()) list.sort((a, b) => b[1].length - a[1].length);
  return map;
})();

/** Pronounce a word nothing knows, one rule at a time. */
export function byRule(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z']/g, "");
  if (!w) return "";

  let out = "";
  let i = 0;

  while (i < w.length) {
    const candidates = BY_LETTER.get(w[i] as string) ?? [];
    let matched = false;

    for (const [left, target, right, sound] of candidates) {
      if (!w.startsWith(target, i)) continue;
      if (left && !left.test(w.slice(0, i))) continue;
      if (right && !right.test(w.slice(i + target.length))) continue;
      out += sound;
      i += target.length;
      matched = true;
      break;
    }

    if (!matched) i++;
  }

  // Everything by rule is unstressed otherwise, which sounds robotic. Putting
  // primary stress on the first vowel is right more often than not in English
  // and is never as wrong as a completely flat word.
  const vowel = out.search(/[ɑɐɒæɔəɛɜɚɪɨiʊʌueɔo]/);
  if (vowel >= 0 && !out.includes("ˈ")) out = `${out.slice(0, vowel)}ˈ${out.slice(vowel)}`;

  return out;
}

/**
 * Spell an acronym out, letter by letter.
 *
 * "NASA" is a word, "NLP" is three letters, and the difference is whether it
 * contains a vowel that lets it be said. That test is wrong sometimes ("SQL"
 * has a vowel and is usually spelled out) but it is right far more often than
 * either blanket rule.
 */
const LETTER_SOUNDS: Record<string, string> = {
  a: "ˈeɪ", b: "ˈbi", c: "ˈsi", d: "ˈdi", e: "ˈi",
  f: "ˈɛf", g: "ˈʤi", h: "ˈeɪʧ", i: "ˈaɪ",
  j: "ˈʤeɪ", k: "ˈkeɪ", l: "ˈɛl", m: "ˈɛm",
  n: "ˈɛn", o: "ˈoʊ", p: "ˈpi", q: "ˈkju", r: "ˈɑɹ",
  s: "ˈɛs", t: "ˈti", u: "ˈju", v: "ˈvi",
  w: "ˈdʌ bəl ju", x: "ˈɛks", y: "ˈwaɪ", z: "ˈzi",
};

const spellOut = (word: string): string =>
  [...word.toLowerCase()].map((c) => LETTER_SOUNDS[c] ?? "").filter(Boolean).join(" ");

/** Is this an acronym that should be spelled rather than said? */
function isSpelled(word: string): boolean {
  if (word.length < 2 || word.length > 6) return false;
  if (word !== word.toUpperCase()) return false;
  if (!/^[A-Z]+$/.test(word)) return false;
  // No vowel at all, or a shape people say letter by letter anyway.
  return !/[AEIOU]/.test(word) || word.length <= 3;
}

/** How a word's pronunciation was decided. Shown when the reader is asked. */
export type Origin = "dictionary" | "rule" | "spelled";

export interface Phonemised {
  ipa: string;
  origin: Origin;
}

/** Pronounce one word. */
export function word(raw: string, dict: Map<string, string>): Phonemised {
  const bare = raw.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
  if (!bare) return { ipa: "", origin: "rule" };

  if (isSpelled(bare)) return { ipa: spellOut(bare), origin: "spelled" };

  const key = bare.toLowerCase();
  const hit = dict.get(key);
  if (hit) return { ipa: hit, origin: "dictionary" };

  // A plural or a past tense whose stem is in the dictionary: "encoders" from
  // "encoder". Worth trying before the rules, which would do a worse job.
  for (const [suffix, extra] of [["s", "z"], ["es", "ɪz"], ["ed", "d"], ["ing", "ɪŋ"]] as const) {
    if (!key.endsWith(suffix)) continue;
    const stem = dict.get(key.slice(0, -suffix.length));
    if (stem) return { ipa: stem + extra, origin: "dictionary" };
  }

  return { ipa: byRule(bare), origin: "rule" };
}

/**
 * Turn a sentence into phonemes.
 *
 * espeak-ng first, for English. It fails soft -- a null answer means it is not
 * on this build or would not load -- and the dictionary below picks up
 * unchanged, so there is no machine on which the reader goes silent because a
 * phonemiser is missing.
 *
 * Punctuation is kept either way, because it is in the model's vocabulary and
 * it is what the model uses to place pauses and to shape intonation. Dropping
 * it makes every sentence come out as one flat breath.
 *
 * `unknown` lists the words the dictionary had to guess at by rule, which the
 * reader can report. espeak guesses at nothing -- it has letter-to-sound rules
 * of its own and no notion of a word it does not know -- so on the espeak path
 * the list is empty, and that is the truth rather than a gap.
 */
export async function phonemise(
  text: string,
  lang = "en-US",
): Promise<{ ipa: string; unknown: string[] }> {
  const clean = normalise(text);

  const said = await espeakPhonemes(clean, lang);
  if (said) return { ipa: said, unknown: [] };

  const dict = await dictionary();
  const unknown: string[] = [];
  const out: string[] = [];

  for (const token of clean.match(/[\p{L}\p{N}']+|[^\s\p{L}\p{N}]/gu) ?? []) {
    if (/^[\p{L}\p{N}']/u.test(token)) {
      const said = word(token, dict);
      if (said.origin === "rule") unknown.push(token);
      if (said.ipa) out.push(said.ipa);
    } else if (PUNCTUATION.includes(token)) {
      // Attach punctuation to the word before it, the way it is written.
      if (out.length > 0) out[out.length - 1] += token;
      else out.push(token);
    }
  }

  return { ipa: out.join(" "), unknown };
}

/**
 * Tokenise phonemes for the model.
 *
 * Symbols the vocabulary does not contain are dropped rather than substituted:
 * a wrong token is a wrong sound, and silence in its place is the smaller
 * error. The sequence is wrapped in the padding token at both ends, which is
 * what the model expects to mark the start and end of an utterance.
 */
export function tokenise(ipa: string): number[] {
  const out: number[] = [0];
  for (const ch of ipa) {
    const id = VOCAB.get(ch);
    if (id !== undefined) out.push(id);
    if (out.length >= MAX_TOKENS) break;
  }
  out.push(0);
  return out;
}

/** Exposed for the check harness. */
export const vocabSize = (): number => VOCAB.size;
