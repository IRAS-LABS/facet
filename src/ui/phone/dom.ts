/**
 * Two small helpers the phone shell uses everywhere.
 *
 * Not a framework and not a general utility layer — this is four screens of
 * mostly-static markup, and pulling in a renderer to build them would cost more
 * bytes than the screens do. What it buys is that a tile is one call instead of
 * six lines of `createElement`/`className`/`append`, which is the difference
 * between the tab files reading as layout and reading as DOM plumbing.
 */

type Kids = Array<Node | string | null | undefined>;

/**
 * `el("button.ph-tab", { ariaSelected: "true" }, icon, label)`.
 *
 * The tag string takes `tag.class.class` because nearly every element here is a
 * div with classes and nothing else.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  spec: string,
  attrs?: Record<string, string | number | boolean | null | undefined>,
  ...kids: Kids
): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = spec.split(".");
  const node = document.createElement(tag || "div");
  if (classes.length > 0) node.className = classes.join(" ");

  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "text") node.textContent = String(v);
    else if (k === "html") node.innerHTML = String(v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }

  for (const kid of kids) {
    if (kid === null || kid === undefined) continue;
    node.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return node as HTMLElementTagNameMap[K];
}

/** Replace a container's children in one shot. */
export function fill(parent: Element, ...kids: Kids): void {
  parent.replaceChildren(...kids.filter((k): k is Node | string => k !== null && k !== undefined));
}

/** `1536000` → `"1.5 MB"`. Decimal units, because that is what file managers show. */
export function bytes(n: number | undefined): string {
  if (n === undefined) return "";
  if (n < 1000) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Short relative date for a list row: "14:32", "Tue", "14 Mar". */
export function shortDate(ms: number | undefined, now = Date.now()): string {
  if (ms === undefined) return "";
  const d = new Date(ms);
  const days = Math.floor((now - ms) / 86_400_000);
  if (days < 1 && new Date(now).getDate() === d.getDate()) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  if (d.getFullYear() === new Date(now).getFullYear()) {
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * The filename strip along the bottom of a tile.
 *
 * Only for the files a gallery does not identify by looking at them. A
 * photograph is its own label -- Samsung's own gallery captions nothing, and
 * it is right not to -- but a document, a song, an archive or a font is a
 * page, a cover or a card that says almost nothing about *which* one it is,
 * and every file manager ever written puts the name under it.
 *
 * Returns null for pictures and video so the caller can append unconditionally.
 */
export function tileCaption(kind: string, name: string): HTMLElement | null {
  if (kind === "image" || kind === "video") return null;
  const cap = el("span.ph-cell-cap", { "aria-hidden": true });
  const dot = name.lastIndexOf(".");
  // `.tar.gz` is one extension to a person and two to `lastIndexOf`, and a
  // trailing dot-something fourteen characters long is a name, not a suffix.
  const hasExt = dot > 0 && name.length - dot <= 12;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : "";
  const cut = stem.length > CAP_SPLIT ? Math.ceil(stem.length / 2) : 0;
  cap.append(
    el("span.ph-cell-cap-h", { text: stem.slice(0, cut) }),
    el(
      "span.ph-cell-cap-l",
      {},
      el("span.ph-cell-cap-t", { text: stem.slice(cut) }),
      el("span.ph-cell-cap-x", { text: ext }),
    ),
  );
  return cap;
}

/**
 * How long a stem has to be before it is split across two lines.
 *
 * This number decides nothing about correctness -- it only picks one line or
 * two. Whether the text *fits* is measured by the browser, because only the
 * browser knows the tile width, the font and the display density. Counting
 * characters here is what put `one-building-then-the-coun……` on a tile with
 * its `.html` sliced off the bottom: thirty-eight characters is under two
 * lines on paper and over two lines on a phone.
 *
 * The extension is a separate element that is not allowed to shrink, so it
 * survives every width, every font size and every name length. A file grid
 * that hides what kind of file a tile holds has failed at its one job.
 */
const CAP_SPLIT = 18;
