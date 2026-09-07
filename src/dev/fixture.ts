/**
 * The one thing three harnesses need before they can say anything useful:
 * the fixture files, actually present.
 *
 * `metacheck`, `hexcheck` and `tablecheck` all run against real photographs and
 * real spreadsheets, which are deliberately not committed (they are somebody's
 * files) and are staged by `scripts/fixtures.ps1` into `fixtures/`. When they
 * have not been staged, the dev server answers the fetch with a 404 page — and
 * every one of those harnesses used to take the HTML body, wrap it in a
 * `Uint8Array`, and then fail in some baffling way further down, or hang.
 *
 * Worse, in `dev/allcheck.html` that was not merely confusing, it was three
 * whole minutes of dead wait: the runner watches for a line matching
 * `/(\d+) passed/`, a harness that dies before printing one never produces such
 * a line, and so each of the three burned its full 60-second deadline and
 * reported `TIMED OUT` — a phrase that points at a hang rather than at the
 * missing files that actually caused it.
 *
 * So: check the response, and when it is missing, fail immediately with a title
 * that both matches the runner's pattern and says what to do about it.
 */

/** Fetch one staged fixture, refusing anything that is not really the file. */
export async function fixtureBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  let r: Response;
  try {
    r = await fetch(url);
  } catch (e) {
    throw new MissingFixture(url, String(e));
  }
  if (!r.ok) throw new MissingFixture(url, `HTTP ${r.status}`);
  // A dev server that 200s an index page for an unknown path would otherwise
  // hand back HTML that every check below treats as image bytes.
  const type = r.headers.get("content-type") ?? "";
  if (/^text\/html/i.test(type)) throw new MissingFixture(url, `served ${type}`);
  return new Uint8Array(await r.arrayBuffer());
}

export class MissingFixture extends Error {
  constructor(readonly url: string, readonly why: string) {
    super(`${url}: ${why}`);
    this.name = "MissingFixture";
  }
}

/**
 * Report a harness that could not start, in the runner's own vocabulary.
 *
 * The title has to carry a number for `allcheck` to notice it at all, so this
 * scores it honestly as one failure rather than leaving the cell blank: nothing
 * passed, one thing is wrong, and the one thing is named.
 */
export function fixturesMissing(prefix: string, e: unknown): void {
  const detail = e instanceof MissingFixture ? ` (${e.message})` : ` (${String(e)})`;
  const line = `${prefix}: 0 passed, 1 FAILED — fixtures not staged, run scripts/fixtures.ps1${detail}`;
  document.title = line;
  console.log(line);
  const p = document.createElement("pre");
  p.style.cssText = "padding:16px;font:13px/1.6 ui-monospace,monospace;white-space:pre-wrap";
  p.textContent =
    `${line}\n\n` +
    `These checks run against real files that are not in the repository.\n` +
    `Stage them first:\n\n` +
    `    .\\scripts\\fixtures.ps1\n` +
    `    .\\scripts\\fixtures.ps1 -Clean     # recycle them afterwards\n`;
  document.body.prepend(p);
}

/** Run a harness, turning a missing fixture into a fast, legible failure. */
export function guarded(prefix: string, run: () => Promise<void>): void {
  void run().catch((e: unknown) => {
    if (e instanceof MissingFixture) { fixturesMissing(prefix, e); return; }
    const line = `${prefix}: 0 passed, 1 FAILED — threw: ${String(e)}`;
    document.title = line;
    console.log(line);
    console.error(e);
  });
}
