/**
 * The readable part of an HTML page.
 *
 * A saved web page is mostly not the article. It is a navigation bar, a cookie
 * notice, a sidebar of related links, a comment thread, a footer of legal text
 * and, somewhere in the middle, the thing the user actually wants read to them.
 * Reading it start to finish gives four minutes of menu items before the first
 * sentence, which is the HTML version of the running-header problem.
 *
 * The approach is the one that survives contact with real pages: find the
 * container with the most prose in it, and read that. Density beats tag names,
 * because half the web wraps its article in an unlabelled `div` and the other
 * half puts three `<article>` elements on the page for the sidebar teasers.
 * Tag names are used to *exclude* -- `nav`, `aside` and `footer` are never
 * content -- which is the direction they are reliable in.
 *
 * Nothing here is fetched. The document comes from a local file the user
 * opened, parsed in an inert document, and no script in it ever runs.
 */

import type { BlockKind, RawBlock } from "./doc";

/** Elements that are never the article, whatever they contain. */
const DROP = new Set([
  "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object",
  "embed", "audio", "video", "form", "button", "select", "textarea", "input",
  "nav", "aside", "menu", "dialog",
]);

/** Elements that end a block of text. */
const BLOCKS = new Set([
  "p", "div", "section", "article", "blockquote", "pre", "li", "dd", "dt",
  "h1", "h2", "h3", "h4", "h5", "h6", "figcaption", "td", "th", "tr", "caption",
  "header", "footer", "main", "ul", "ol", "dl", "table", "hr", "br",
]);

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** Class and id fragments that mark page furniture on essentially every site. */
const FURNITURE =
  /(^|[-_ ])(nav|navbar|menu|sidebar|side-bar|footer|header|banner|advert|ads?|promo|cookie|consent|popup|modal|breadcrumb|share|social|related|recommend|newsletter|subscribe|comment|disqus|pagination|pager|skip-link|screen-reader|sr-only|visually-hidden)([-_ ]|$)/i;

/** A container needs at least this much text to be considered the article. */
const MIN_ARTICLE = 200;

const tag = (el: Element): string => el.tagName.toLowerCase();

/** Is this element furniture by its role, class or id? */
function isFurniture(el: Element): boolean {
  if (DROP.has(tag(el))) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  if (el.hasAttribute("hidden")) return true;

  const role = el.getAttribute("role") ?? "";
  if (/^(navigation|banner|contentinfo|complementary|search|menu|menubar|dialog|alert)$/i.test(role)) {
    return true;
  }

  // `header` and `footer` are furniture at the page level but legitimate
  // inside an article, where they hold the byline and the citation.
  const name = tag(el);
  if (name === "header" || name === "footer") {
    return !el.closest("article");
  }

  const mark = `${el.className && typeof el.className === "string" ? el.className : ""} ${el.id}`;
  return FURNITURE.test(mark);
}

/** Visible text length of an element, ignoring anything already excluded. */
function weight(el: Element): number {
  let n = 0;
  for (const node of el.childNodes) {
    if (node.nodeType === 3) {
      n += (node.textContent ?? "").trim().length;
    } else if (node.nodeType === 1) {
      const child = node as Element;
      if (!isFurniture(child)) n += weight(child);
    }
  }
  return n;
}

/**
 * Pick the element most likely to be the article.
 *
 * `<main>` and `<article>` are tried first and accepted only if they are
 * actually substantial, because an empty `<main>` wrapping a client-rendered
 * page is common enough to matter. Otherwise every container is scored on how
 * much prose it holds relative to how deep it is, and the best one wins -- the
 * depth term is what stops `<body>` from always winning by containing
 * everything.
 */
function article(doc: Document): Element {
  for (const sel of ["main", "article", "[role=main]"]) {
    const el = doc.querySelector(sel);
    if (el && !isFurniture(el) && weight(el) >= MIN_ARTICLE) return el;
  }

  const body: Element = doc.body ?? doc.documentElement;
  let best: Element = body;
  let bestScore = 0;

  const walk = (el: Element, depth: number): void => {
    if (depth > 12) return;
    for (const child of el.children) {
      if (isFurniture(child)) continue;
      const w = weight(child);
      if (w < MIN_ARTICLE) continue;
      // Deeper is better at the same weight: it means the text is not diluted
      // by whatever else the ancestor was holding.
      const score = w * (1 + depth * 0.08);
      if (score > bestScore) {
        bestScore = score;
        best = child;
      }
      walk(child, depth + 1);
    }
  };

  walk(body, 0);
  return best;
}

/** Gather text into blocks, cutting at block-level elements. */
function collect(root: Element): RawBlock[] {
  const out: RawBlock[] = [];
  let buffer = "";
  let kind: BlockKind = "body";

  const flush = (): void => {
    const clean = buffer.replace(/\s+/g, " ").trim();
    if (clean) out.push({ text: clean, kind });
    buffer = "";
    kind = "body";
  };

  const walk = (el: Element): void => {
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        buffer += node.textContent ?? "";
        continue;
      }
      if (node.nodeType !== 1) continue;

      const child = node as Element;
      if (isFurniture(child)) continue;

      const name = tag(child);
      const breaks = BLOCKS.has(name);
      if (breaks) flush();

      if (HEADINGS.has(name)) {
        walk(child);
        const clean = buffer.replace(/\s+/g, " ").trim();
        if (clean) out.push({ text: clean, kind: "heading" });
        buffer = "";
        continue;
      }

      if (name === "figcaption" || name === "caption") {
        walk(child);
        const clean = buffer.replace(/\s+/g, " ").trim();
        if (clean) out.push({ text: clean, kind: "caption" });
        buffer = "";
        continue;
      }

      // Alt text is the only description a listener gets of a picture, and a
      // page that bothered to write one meant it to be read.
      if (name === "img") {
        const alt = (child.getAttribute("alt") ?? "").trim();
        if (alt) {
          flush();
          out.push({ text: alt, kind: "caption" });
        }
        continue;
      }

      walk(child);
      if (breaks) flush();
    }
  };

  walk(root);
  flush();
  return out;
}

/**
 * Turn an HTML document into readable blocks.
 *
 * Takes the source text rather than a live `Document` so that the page is
 * parsed inert: `DOMParser` runs no script, loads no subresource and fires no
 * event. A local HTML file is still untrusted input, and this is the only
 * parse path that treats it that way.
 */
export function htmlBlocks(source: string): RawBlock[] {
  const doc = new DOMParser().parseFromString(source, "text/html");
  const blocks = collect(article(doc));

  // A page whose article detection found nothing worth reading falls back to
  // the whole body: better to read some navigation than to read nothing and
  // leave the user wondering whether the file was empty.
  if (blocks.length === 0 && doc.body) return collect(doc.body);
  return blocks;
}

/** The page's own title, for the reader to show. */
export function htmlTitle(source: string): string {
  const doc = new DOMParser().parseFromString(source, "text/html");
  return (doc.title || "").trim();
}
