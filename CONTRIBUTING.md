# Contributing

- Run `npm run typecheck` and `cd src-tauri && cargo check` before opening a PR.
- Run the harnesses. `npm run dev`, then open
  [`http://localhost:8183/dev/allcheck.html`](http://localhost:8183/dev/allcheck.html),
  which runs every `dev/*check.html` page in its own iframe, one at a time, and
  adds up the score. A single subsystem is faster to iterate on directly —
  `http://localhost:8183/dev/hexcheck.html` and so on. These pages are
  dev-server only; the build's single input is `index.html`, so nothing in
  `dev/` ships.
- Keep personal data out of the tree: no test photos of real people, no
  absolute paths from your machine, no signed binaries. `.gitignore` already
  covers the usual suspects; `scripts/fixtures.ps1` stages local test files
  from a folder you point it at.
- Deletions in the app must go through `.facet-trash` and, on desktop, the OS
  Recycle Bin. Never add a code path that unlinks user files directly.
