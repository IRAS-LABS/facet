# Changelog

Notable changes per release. Dates are the release date.

This project follows [semantic versioning](https://semver.org/) loosely: the
minor number moves when something visible changes, the patch number when
something is fixed.

## [Unreleased]

## [0.1.1] — 2026-09-06

### Fixed

- The tab-switch timing mark went straight to `console.log` instead of through
  `perf()`, so it was the one `[fct-perf]` line that never reached the native
  sink — meaning it did not show up in `adb logcat` on a release build, which
  is exactly the problem the mark helper exists to solve.
- Android 14's "Select photos" partial grant read as no access at all.
  `READ_MEDIA_VISUAL_USER_SELECTED` was tested for but never declared in the
  manifest, and Android reports an undeclared permission as denied — so the
  app told you it could see nothing while showing you the photos you had
  picked. 0.1.0 has this bug; this release is the fix reaching a phone.
- `.jpe`, `.jfif`, `.apng` and `.avifs` files had no thumbnail. They are JPEG,
  JPEG, PNG and AVIF under other names, and the viewer always opened them —
  only the preview cache's extension list had not kept up.
- The Table view described itself as reading SQLite, which nothing in this
  repository does, and did not mention Excel, which it does.

### Changed

- The dev test harnesses moved from the repository root into `dev/`. Thirty-
  eight HTML pages sitting beside `README.md` made the project look like a
  pile of loose files to anyone who opened it. Nothing about them changed:
  each page still loads its module by root-absolute path, the build's single
  input is still `index.html`, and the URL is now
  `http://localhost:8183/dev/allcheck.html`.

### Added

- CI: type-check and bundle on Linux, `cargo check` on Windows (the target
  that actually has the WinRT share sheet, CF_HDROP clipboard and
  `DoDragDrop` code paths).
- Issue and pull-request templates.
- README: how to sideload the APK, how to verify its signing certificate, what
  the upgrade signature mismatch costs, and why the app asks for each Android
  permission — including all-files access.
- README: one table of every file format, what opens it, and what is
  recognised but deliberately not read.

## [0.1.0] — 2026-09-06

First public release. Windows desktop app and Android APK from one codebase.

Everything runs on the device: no account, no sign-in, no telemetry, no
network calls. Transcription, OCR and face detection are models bundled into
the app, not services it calls.

### Browsing

Spatial canvas with cursor-anchored zoom and DOM recycling, file explorer with
drives and home places, four layout presets remembered per folder, a command
palette, tabs, split view, bookmarks, and a phone shell with Photos, Albums,
Search and Files.

### Editing

Video trimming and export, audio editing with noise filtering, image editing,
blur and black-box redaction, batch operations, metadata viewing and stripping,
format conversion, and screen/audio recording.

### Reading

On-device transcription (Whisper), OCR, PDF handling, hex and text viewing,
and 3D model preview.

### Known gaps

- **Automatic face blur** is implemented and asserted against fixtures, but has
  never been run against a real photograph. The manual brush and the black-box
  redaction are what has actually been used. `SCOPE.md` says the same.
- **Android home-screen widgets** are not started.
- The Windows installer is **not code-signed**, so SmartScreen warns on first
  run.
- Video work on the desktop needs `ffmpeg` and `ffprobe` on `PATH`. The APK
  bundles FFmpeg and needs nothing.

[Unreleased]: https://github.com/IRAS-LABS/facet/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/IRAS-LABS/facet/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/IRAS-LABS/facet/releases/tag/v0.1.0
