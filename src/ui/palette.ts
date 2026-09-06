/**
 * Command palette.
 *
 * Ctrl+K. This is the seam that keeps FACET from growing a toolbar per module:
 * anything a module can do registers a command here, and the top bar stays the
 * six controls people use with a mouse. Forty-odd modules with visible buttons
 * each would be unusable; forty-odd modules behind one search field is a
 * feature, not a compromise.
 *
 * Commands are supplied by a callback rather than a fixed list because most of
 * them depend on right now — which folder, what is selected, which themes are
 * installed. Rebuilding on open costs nothing and means a command can never be
 * stale.
 */

export interface Command {
  id: string;
  title: string;
  /** Right-hand column: a shortcut, a path, whatever disambiguates. */
  hint?: string;
  /** Groups the list; also matched against, so "theme" finds every theme. */
  group: string;
  run(): void | Promise<void>;
}

interface Scored {
  cmd: Command;
  score: number;
  /** Indices in the title that matched, for highlighting. */
  hits: number[];
}

export class Palette {
  private readonly root: HTMLElement;
  private readonly input = document.createElement("input");
  private readonly list = document.createElement("div");

  private commands: Command[] = [];
  private shown: Scored[] = [];
  private active = 0;

  constructor(private readonly source: () => Command[]) {
    this.root = document.createElement("div");
    this.root.className = "pal";
    this.root.hidden = true;

    const box = document.createElement("div");
    box.className = "pal-box";
    this.input.className = "pal-input";
    this.input.type = "text";
    this.input.placeholder = "Type a command, a folder, a theme…";
    this.input.spellcheck = false;
    this.list.className = "pal-list";
    box.append(this.input, this.list);
    this.root.append(box);
    document.body.appendChild(this.root);

    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });
    this.input.addEventListener("input", () => {
      this.active = 0;
      this.render();
    });
    this.input.addEventListener("keydown", (e) => this.onKey(e));
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.commands = this.source();
    this.root.hidden = false;
    this.input.value = "";
    this.active = 0;
    this.render();
    this.input.focus();
  }

  close(): void {
    this.root.hidden = true;
    this.input.blur();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  // ── Keys ──────────────────────────────────────────────────────────────────

  private onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        this.close();
        break;
      case "ArrowDown":
        e.preventDefault();
        this.move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        this.move(-1);
        break;
      case "Enter": {
        e.preventDefault();
        const pick = this.shown[this.active];
        if (!pick) return;
        // Closed before running, so a command that opens its own surface does
        // not have to fight the palette for focus.
        this.close();
        void pick.cmd.run();
        break;
      }
      default:
        break;
    }
  }

  private move(dir: number): void {
    if (this.shown.length === 0) return;
    this.active = (this.active + dir + this.shown.length) % this.shown.length;
    this.render();
    this.list.children[this.active]?.scrollIntoView({ block: "nearest" });
  }

  // ── Matching ──────────────────────────────────────────────────────────────

  private render(): void {
    const q = this.input.value.trim();
    this.shown =
      q === ""
        ? this.commands.slice(0, 60).map((cmd) => ({ cmd, score: 0, hits: [] }))
        : this.commands
            .map((cmd) => score(cmd, q))
            .filter((s): s is Scored => s !== null)
            .sort((a, b) => b.score - a.score)
            .slice(0, 60);

    this.list.replaceChildren();
    if (this.shown.length === 0) {
      const empty = document.createElement("p");
      empty.className = "pal-empty";
      empty.textContent = "Nothing matches.";
      this.list.append(empty);
      return;
    }

    this.shown.forEach((s, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "pal-row";
      if (i === this.active) row.dataset["on"] = "true";

      const group = document.createElement("span");
      group.className = "pal-group";
      group.textContent = s.cmd.group;

      const title = document.createElement("span");
      title.className = "pal-name";
      title.append(...highlight(s.cmd.title, s.hits));

      row.append(group, title);
      if (s.cmd.hint !== undefined) {
        const hint = document.createElement("span");
        hint.className = "pal-hint";
        hint.textContent = s.cmd.hint;
        row.append(hint);
      }

      // Pointerdown rather than click: the input still has focus, and a click
      // would blur it first and close the palette out from under the press.
      row.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this.close();
        void s.cmd.run();
      });
      // pointermove, not pointerenter. Re-rendering the list under a stationary
      // cursor fires enter on whatever row lands beneath it, which silently
      // stole the highlight from the top match every time the query changed —
      // so typing and pressing enter ran whichever command the mouse happened
      // to be parked on. Only real movement is a real hover.
      row.addEventListener("pointermove", () => {
        if (this.active === i) return;
        this.active = i;
        for (const el of this.list.children) (el as HTMLElement).dataset["on"] = "false";
        row.dataset["on"] = "true";
      });
      this.list.append(row);
    });
  }
}

/**
 * Subsequence match, scored so that the *reason* a thing matched shows through
 * in the ordering: consecutive letters beat scattered ones, and a hit at a word
 * boundary beats a hit in the middle of a word. That is why "od" finds "Open
 * Downloads" above "Reload folder" even though both contain an o and a d.
 *
 * Returns null when the query is not a subsequence at all, so the caller can
 * filter and rank in one pass.
 */
function score(cmd: Command, query: string): Scored | null {
  const hay = `${cmd.title} ${cmd.group} ${cmd.hint ?? ""}`.toLowerCase();
  const title = cmd.title.toLowerCase();
  const q = query.toLowerCase();

  const hits: number[] = [];
  let at = 0;
  let total = 0;
  let run = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = title.indexOf(ch, at);
    if (i === -1) {
      // Falls back to the whole haystack so typing a group name ("theme") or a
      // path fragment still finds the command, just ranked below title matches.
      if (!isSubsequence(q, hay)) return null;
      return { cmd, score: 1, hits: [] };
    }
    hits.push(i);
    const boundary = i === 0 || /[\s/\\_-]/.test(title[i - 1] ?? " ");
    run = i === at ? run + 1 : 0;
    total += 10 + run * 6 + (boundary ? 8 : 0);
    at = i + 1;
  }
  // Shorter titles win ties: "Fit" should outrank "Fit all to view" for "fit".
  return { cmd, score: total * 100 - title.length, hits };
}

function isSubsequence(q: string, hay: string): boolean {
  let at = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = hay.indexOf(ch, at);
    if (i === -1) return false;
    at = i + 1;
  }
  return true;
}

function highlight(title: string, hits: number[]): Node[] {
  if (hits.length === 0) return [document.createTextNode(title)];
  const out: Node[] = [];
  let at = 0;
  for (const i of hits) {
    if (i > at) out.push(document.createTextNode(title.slice(at, i)));
    const b = document.createElement("b");
    b.textContent = title[i] ?? "";
    out.push(b);
    at = i + 1;
  }
  if (at < title.length) out.push(document.createTextNode(title.slice(at)));
  return out;
}
