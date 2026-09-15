/**
 * Pronunciation by espeak-ng, compiled to WebAssembly.
 *
 * The dictionary in `phonemes.ts` gets individual words right and sentences
 * wrong, and the difference is what a listener hears. English is not spoken as
 * a row of dictionary entries: "the", "to", "of", "a", "than" all lose their
 * vowel in running speech, stress moves around a phrase, and a number has to
 * be turned into words before any of that can happen. A per-word lookup cannot
 * do any of it, because it never sees two words at once. The result was
 * described by the owner as "someone that speaks slow or not smooth or some
 * foreign student that doesn't know English", which is an accurate description
 * of citation forms read out in a line.
 *
 * espeak-ng does the whole sentence. It is also what Kokoro was trained
 * against -- the model's reference front-end, misaki, falls back to espeak-ng,
 * and the official JS inference (`kokoro-js`) uses this exact package -- so its
 * output is the distribution the model's weights expect. That is worth more
 * here than any property of the phonemes considered on their own.
 *
 * ## Licence -- this matters and is not a detail
 *
 * The `phonemizer` npm package declares Apache-2.0. What it actually contains,
 * compiled into the bundle, is espeak-ng, which is **GPL-3.0**. The npm
 * metadata understates that; the obligation is real regardless of what the
 * registry says. FACET already ships GPL ffmpeg with a written offer of
 * source, so the mechanism exists and this is not a new kind of obligation --
 * but it does mean the distributed binaries are GPL-3.0 and the source offer
 * has to cover espeak-ng too. This was put to the owner in those words and
 * accepted.
 *
 * ## What it costs
 *
 * 2.6 MB, loaded by dynamic import so it is a separate chunk that never
 * touches the startup path -- nothing is paid until something is read aloud.
 * The WebAssembly and its data are embedded in that chunk as base64, so
 * **nothing is fetched at runtime**: no network, no separate worker file, no
 * request to anyone. On a privacy tool that is the only acceptable shape.
 *
 * English only. The package filters espeak's voice list down to `en-*`, so the
 * Spanish, French, Hindi, Italian, Japanese, Portuguese and Chinese Kokoro
 * voices fall back to the dictionary path exactly as they did before.
 */

/** Text between punctuation, and the punctuation itself, in order. */
const SPLIT = /([;:,.!?¡¿—…"«»“”])/;

type Phonemize = (text: string, language?: string) => Promise<string[]>;

let once: Promise<Phonemize | null> | null = null;

/**
 * Load espeak-ng, once.
 *
 * A failure here is not fatal and is not retried on every sentence: the
 * dictionary path is still there and still speaks, and a reader that stops
 * dead because a phonemiser would not load is a worse outcome than a reader
 * that sounds like it did last week.
 */
function load(): Promise<Phonemize | null> {
  once ??= import("phonemizer")
    .then((m) => m.phonemize as Phonemize)
    .catch(() => null);
  return once;
}

/** Is there any chance of espeak phonemes for this language tag? */
export const speaks = (lang: string): boolean => /^en\b/i.test(lang);

/**
 * The espeak voice for a BCP-47 tag, or null if it has none.
 *
 * These are the full voice identifiers, `gmw/en-US` and `gmw/en`, and not the
 * language tags `en-us` and `en-gb` that the obvious reading of the API
 * suggests. That is not tidiness. Asking for `en-gb` while the American voice
 * is already loaded **silently does nothing** -- espeak keeps the voice it
 * has, reports no error, and returns American phonemes for a British voice.
 * The identifiers switch in both directions, every time. Measured:
 *
 *     en-us then en-gb  ->  wˈɔːɾɚ   wˈɔːɾɚ    (switch ignored)
 *     gmw/en-US then gmw/en -> wˈɔːɾɚ  wˈɔːtə   (switch honoured)
 *
 * Only the two English variants Kokoro has voices for are mapped. Anything
 * else English-ish is given the American voice rather than refused, because a
 * near-enough accent is a far smaller error than falling back to per-word
 * lookup.
 */
export function identifier(lang: string): string | null {
  if (!speaks(lang)) return null;
  return /^en-gb/i.test(lang) ? "gmw/en" : "gmw/en-US";
}

/**
 * Phonemise one piece of text. Null means "not available, use the dictionary".
 *
 * Punctuation is split out and put back rather than handed to espeak, for the
 * reason that espeak does not return it: it uses the marks to decide phrasing
 * and then reports only sounds. Kokoro wants them in the token stream -- they
 * are in its vocabulary and they are how it places pauses and final
 * intonation -- so each stretch between marks is phonemised on its own and the
 * marks are stitched back into the same positions. This is what `kokoro-js`
 * does, and the small loss of prosody across a comma is the price of having
 * the comma at all.
 */
export async function phonemes(text: string, lang: string): Promise<string | null> {
  const id = identifier(lang);
  if (!id) return null;
  const phonemize = await load();
  if (!phonemize) return null;

  const parts = text.split(SPLIT);
  const out: string[] = [];

  for (const part of parts) {
    if (!part) continue;
    if (SPLIT.test(part) && part.length === 1) {
      // Punctuation: onto the end of what came before, the way it is written.
      if (out.length > 0) out[out.length - 1] += part;
      else out.push(part);
      continue;
    }
    if (!/\S/.test(part)) continue;
    try {
      const said = (await phonemize(part, id)).join(" ").trim();
      if (said) out.push(said);
    } catch {
      // One unpronounceable stretch should not lose the whole sentence.
    }
  }

  const joined = out.join(" ").trim();
  return joined ? fix(joined, id) : null;
}

/**
 * The corrections Kokoro's own front-end makes to espeak's output.
 *
 * These are not improvements to espeak. They are the differences between what
 * espeak emits and what the model was trained on, copied from `kokoro-js` so
 * that the tokens reaching the model are the ones its weights were fitted
 * against. Anything here that looks arbitrary is arbitrary in exactly the way
 * the training data was.
 */
function fix(ipa: string, id: string): string {
  let s = ipa
    .replace(/ʲ/g, "j")
    .replace(/r/g, "ɹ")
    .replace(/x/g, "k")
    .replace(/ɬ/g, "l")
    // "twohundred" comes out welded together; the model expects the break.
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, " ")
    // A trailing plural "z" hangs off as its own word before a stop.
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, "z");
  // "ninety" is the one number espeak and the training data disagree about.
  if (id === "gmw/en-US") s = s.replace(/(?<=nˈaɪn)ti(?!ː)/g, "di");
  return s.replace(/\s{2,}/g, " ").trim();
}
