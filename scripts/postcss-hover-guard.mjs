/**
 * Put every `:hover` rule behind `@media (hover: hover)`.
 *
 * Why this is a build step and not 150 hand edits: on Android a tap leaves the
 * button it landed on in the `:hover` state until you touch something else. The
 * recorder's Pause button was the one that gave it away -- tap it, and it keeps
 * `--fct-card-hover` for as long as the panel is open, so it stops looking like
 * a button and starts looking like a word floating next to Stop. Every hover
 * rule in the app has the same problem; fixing them one by one would also mean
 * remembering the rule forever, and the next stylesheet would reintroduce it.
 *
 * `@media (hover: hover)` is the query that asks "can this pointer hover at
 * all", which is exactly the question. A mouse says yes, a finger says no, and
 * a laptop with a touchscreen says yes -- correctly, because there is a mouse.
 *
 * A rule whose selector list mixes hover and non-hover selectors is split, so
 * `.a:hover, .b { … }` keeps working for `.b` on a phone.
 */

import postcss from "postcss";

const GUARD = "(hover: hover)";

/** True for a rule already sitting inside a hover guard, so this is idempotent. */
function guarded(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "atrule" && p.name === "media" && p.params.includes("hover:")) return true;
  }
  return false;
}

/** Rules inside @keyframes are percentages, never selectors. */
function inKeyframes(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "atrule" && /keyframes$/.test(p.name)) return true;
  }
  return false;
}

const plugin = () => ({
  postcssPlugin: "facet-hover-guard",
  Rule(rule) {
    if (!rule.selector.includes(":hover")) return;
    if (guarded(rule) || inKeyframes(rule)) return;

    const hover = [];
    const plain = [];
    for (const sel of rule.selectors) (sel.includes(":hover") ? hover : plain).push(sel);
    if (hover.length === 0) return;

    // The non-hover half stays where it was, unguarded.
    if (plain.length > 0) {
      const rest = rule.cloneBefore();
      rest.selectors = plain;
    }

    const media = postcss.atRule({ name: "media", params: GUARD, source: rule.source });
    rule.replaceWith(media);
    rule.selectors = hover;
    media.append(rule);
  },
});
plugin.postcss = true;

export default plugin;
