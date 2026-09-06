# Contributing

- Run `npm run typecheck` and `cd src-tauri && cargo check` before opening a PR.
- Keep personal data out of the tree: no test photos of real people, no
  absolute paths from your machine, no signed binaries. `.gitignore` already
  covers the usual suspects; `scripts/fixtures.ps1` stages local test files
  from a folder you point it at.
- Deletions in the app must go through `.facet-trash` and, on desktop, the OS
  Recycle Bin. Never add a code path that unlinks user files directly.
