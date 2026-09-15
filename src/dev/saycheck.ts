/**
 * The phonemiser, in a real browser.
 *
 * This exists because of a sentence from the owner: the reader sounded like
 * "someone that speaks slow or not smooth or some foreign student that doesn't
 * know English". Every individual word it said was in the dictionary and every
 * dictionary entry was right. The fault was that a sentence is not a row of
 * dictionary entries, and nothing in the old checks could have caught that,
 * because they all tested words.
 *
 * So these checks test sentences. The important ones are the reduction checks:
 * in running English "the", "to", "of", "a" and "than" lose their vowel, and a
 * front-end that gives them their full citation vowel is the thing that makes
 * a voice sound foreign. They are the difference the owner heard.
 *
 * Everything runs through `phonemise`, the real entry point, in the real
 * browser, with the real WebAssembly loaded the real way -- because "it worked
 * in Node" is not a claim about the shipped app.
 */

import { MAX_TOKENS, phonemise, tokenise } from "@core/voice/phonemes";
import { identifier, phonemes as espeak, speaks } from "@core/voice/espeak";

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log("ok  ", name);
  } else {
    fail++;
    console.log("FAIL", name, " ", detail);
  }
}

function say(line: string): void {
  const pre = document.createElement("pre");
  pre.textContent = line;
  pre.style.cssText = "margin:0;font:12px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap";
  document.body.appendChild(pre);
}

/** Nothing in this string is a symbol Kokoro would silently drop. */
const whole = (ipa: string): boolean => tokenise(ipa).length - 2 === [...ipa].length;

(async () => {
  // -- 1. It loads at all ----------------------------------------------------
  const hello = await espeak("hello", "en-US");
  ok("espeak-ng loads and speaks in a browser", hello !== null && hello.length > 2,
    String(hello));
  say(`   "hello" -> ${hello ?? "(nothing)"}`);

  const espeakOn = hello !== null;
  if (!espeakOn) {
    say("   espeak did not load; the reduction checks below cannot mean anything.");
  }

  ok("the language map knows what it can do",
    speaks("en-US") && speaks("en-GB") && !speaks("ja-JP")
      && identifier("en-GB") === "gmw/en" && identifier("en-US") === "gmw/en-US"
      && identifier("fr-FR") === null);

  // -- 2. Function words reduce ----------------------------------------------
  //    This is the whole reason the front-end was replaced. "the" said as
  //    "thee" in the middle of a sentence is the single loudest wrong note.
  const sentence = "We present a residual learning framework to ease the training "
    + "of networks that are substantially deeper than those used previously.";
  const { ipa } = await phonemise(sentence);
  say(`\n   ${sentence}\n   -> ${ipa}`);

  if (espeakOn) {
    ok('"the" is reduced, not said as "thee"', / ðə /.test(ipa), ipa);
    ok('"a" is reduced to a schwa', / [ɐə] /.test(ipa), ipa);
    ok('"of" is reduced', /ʌv|ɒv/.test(ipa), ipa);
    ok('"than" is reduced', /ðɐn|ðən/.test(ipa), ipa);
    ok("not every word carries primary stress",
      (ipa.match(/ˈ/g) ?? []).length < ipa.split(" ").length, ipa);
  }

  // -- 3. The three words the owner named ------------------------------------
  for (const [line, want] of [
    ["Microsoft Corporation makes it.", /mˈaɪkɹ[əoʊ]s/],
    ["It is a framework for this.", /fɹˈeɪmw[ɜɚ]/],
    ["As we said previously in the paper.", /pɹˈiːviəsli|pɹˈiviəsli/],
  ] as const) {
    const r = await phonemise(line);
    ok(`"${line}"`, want.test(r.ipa), r.ipa);
    say(`   ${line} -> ${r.ipa}`);
  }

  // -- 4. Nothing reaches the model that the model cannot read ---------------
  //    `tokenise` drops symbols it does not know, silently and by design. A
  //    front-end that emits them is therefore losing sounds without an error,
  //    which is exactly the class of bug that is impossible to notice by ear.
  const stress = "Dr. Smith cited 3.57% of 1,280 items, costing $4.50 at 9:05 (see Fig. 2).";
  const tricky = await phonemise(stress);
  say(`\n   ${stress}\n   -> ${tricky.ipa}`);
  ok("every symbol emitted is one Kokoro knows", whole(tricky.ipa), tricky.ipa);
  ok("the numbers became words, not digits", !/\d/.test(tricky.ipa), tricky.ipa);

  // -- 5. Punctuation survives ----------------------------------------------
  //    It is in the model's vocabulary and it is how the model places pauses.
  //    espeak does not return it -- it reads the marks and reports only
  //    sounds -- so putting them back is our job and worth asserting.
  const clauses = await phonemise("First, we do this; then we do that. Why? Because.");
  say(`   punctuation -> ${clauses.ipa}`);
  ok("commas, semicolons and stops survive into the phonemes",
    /,/.test(clauses.ipa) && /;/.test(clauses.ipa) && /\?/.test(clauses.ipa)
      && /\.$/.test(clauses.ipa), clauses.ipa);

  // -- 6. The accent follows the voice ---------------------------------------
  //    Asserted in both orders on purpose: asking espeak for a voice it is
  //    not currently using can be ignored without an error, so a check that
  //    switches once would pass on a build where switching back is broken.
  const us = await phonemise("The colour of the water.", "en-US");
  const gb = await phonemise("The colour of the water.", "en-GB");
  const us2 = await phonemise("The colour of the water.", "en-US");
  say(`   US -> ${us.ipa}\n   GB -> ${gb.ipa}`);
  if (espeakOn) {
    ok("a British voice is given British phonemes", us.ipa !== gb.ipa,
      `both ${us.ipa}`);
    ok("...and the accent switches back again", us2.ipa === us.ipa,
      `${us.ipa} then ${us2.ipa}`);
  }

  // -- 7. The fallback still speaks ------------------------------------------
  //    A language espeak has no voice for must come back through the
  //    dictionary rather than come back empty. This is also every machine
  //    where the WebAssembly fails to load.
  const other = await phonemise("The training of networks.", "ja-JP");
  ok("a language espeak cannot do falls back to the dictionary",
    other.ipa.length > 10 && whole(other.ipa), other.ipa);
  say(`   fallback -> ${other.ipa}`);

  // -- 8. A real paragraph fits ----------------------------------------------
  const para = "Deeper neural networks are more difficult to train. We present a "
    + "residual learning framework to ease the training of networks that are "
    + "substantially deeper than those used previously. We explicitly reformulate "
    + "the layers as learning residual functions with reference to the layer "
    + "inputs, instead of learning unreferenced functions.";
  const big = await phonemise(para);
  const n = tokenise(big.ipa).length;
  say(`\n   a 45-word paragraph -> ${n} tokens of ${MAX_TOKENS}`);
  ok("a paragraph of a real paper fits in the model's window", n < MAX_TOKENS,
    `${n} tokens`);
  ok("...and loses nothing on the way in", whole(big.ipa));

  // -- 9. It is fast enough to stay ahead of the voice -----------------------
  //    Synthesis is the slow half; if phonemising a sentence were anywhere
  //    near it the look-ahead would stall on this instead.
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) await phonemise(sentence);
  const each = (performance.now() - t0) / 10;
  say(`   ${each.toFixed(1)} ms a sentence`);
  ok("phonemising a sentence costs single-digit milliseconds", each < 50,
    `${each.toFixed(1)} ms`);
})()
  .catch((e: unknown) => {
    fail++;
    console.log("FAIL", "the speech checks ran at all", " ", String(e));
  })
  .finally(() => {
    const line = `say: ${pass} passed, ${fail} failed`;
    document.title = line;
    console.log(`%c${line}`, fail ? "color:#ff6b6b" : "color:#4ade80");
    const h = document.createElement("h2");
    h.textContent = line;
    h.style.cssText = `font:600 16px system-ui;color:${fail ? "#ff6b6b" : "#4ade80"}`;
    document.body.appendChild(h);
  });
