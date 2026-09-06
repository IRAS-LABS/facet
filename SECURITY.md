# Security

## Trust model

Facet is a file manager. The Rust side deliberately exposes commands that read,
write, move and copy arbitrary paths the OS user can reach; there is no path
allow-list, because the user is expected to be able to open any folder. The
things that keep this safe are:

- Only the app's own webview can call those commands (Tauri IPC). The webview
  loads only bundled code; there is no remote content. A Content Security
  Policy in `src-tauri/tauri.conf.json` restricts scripts to the bundle.
- `run_program` (launch an external program) does nothing on Android. The
  command is still registered there, so that the front end has one code path,
  but the body is compiled out and the call returns an error.
- `run_program` takes an argument *vector* that the front end has already
  split, and spawns the program directly. There is no shell anywhere in the
  path, so a file named `holiday & rm.jpg` occupies one slot of `argv` and
  cannot become a second command. To keep that true, the program itself may not
  be a shell or a script host (`cmd`, `powershell`, `wscript`, a `.bat`, a
  `.ps1`, and so on) — those re-split their own arguments and would undo it.
- "Empty trash" refuses any path that is not a real file inside a
  `.facet-trash` folder. The path is resolved first, and it is the *resolved*
  path that gets deleted, so a symlink cannot be approved as one file and
  removed as another.
- Streamed media — video and audio — is served to the webview on Android by a
  loopback HTTP server (`src-tauri/src/media_server.rs`); images stay on
  Tauri's asset protocol. The server listens on `127.0.0.1` on a random
  ephemeral port and is fenced three ways:
  - a 256-bit per-launch token, read from the kernel CSPRNG and compared in
    constant time, in every URL;
  - a per-launch allow-list: it will only open a path that `media_url` actually
    handed out, so a token that leaked would buy the files the user already
    opened in FACET, not the whole device. That bounds a *leaked token* and
    nothing more: `media_url` mints a URL for whatever path it is asked for, so
    code running inside the webview is not held back by it;
  - a `Host` check (loopback only, which stops DNS rebinding) and a
    `Access-Control-Allow-Origin` that is echoed back only for the app's own
    webview origin, never `*`.

  The token is never logged.
- WebView remote debugging on Android is enabled only in debug builds.

## What is *not* defended

Being explicit, because a file manager's threat model is easy to overstate:

- **The webview is trusted.** Every Rust command is reachable from front-end
  code, and some of them read, write, delete and execute. If an attacker can
  run JavaScript in the webview they have the app, and no allow-list in the
  Rust layer changes that. What keeps them out is that the webview loads only
  bundled local code under `default-src 'self'` with `object-src 'none'`, no
  remote script origin and no `eval`.
- **User-configured actions run.** An action is a program the person using
  FACET chose to wire to a menu item. It runs with their privileges. FACET does
  not try to decide which programs someone may run on their own machine.
- **There is no sandbox around the files.** The app can reach everything the
  OS user can reach; that is what a file manager is.

Android needs `MANAGE_EXTERNAL_STORAGE` because it is a file manager and
gallery over the whole card, not just the media the system indexes.

## Reporting

Open a GitHub issue for anything that is not sensitive. For a vulnerability,
use GitHub's private vulnerability reporting on this repository.
