# Changelog

Notable changes per release. Dates are the release date.

This project follows [semantic versioning](https://semver.org/) loosely: the
minor number moves when something visible changes, the patch number when
something is fixed.

## [Unreleased]

## [0.1.2] — 2026-09-07

### Added

- **Zoom, in Quick Look.** Pinch, double-tap, or hold ctrl and scroll. It goes
  to 8x and anchors on your fingers rather than jumping to the corner, so the
  paragraph you were reading stays where you left it. A PDF is the one preview
  that is drawn onto a canvas rather than laid out as text, so a stretched one
  goes coarse; its pages are re-rendered at the scale you stopped at instead,
  which is the "zoom in without lowering quality" part. The scale resets with
  each file.
- Quick Look goes full screen: tap the preview, or the ⤢ in its head. The name,
  the buttons and the action bar go away and the page, picture, PDF or video
  gets the whole display. Leave it with the chip in the corner, the same
  button, Esc, or the phone's back gesture.
- Rename a file from Quick Look. The pencil beside the name opens a field with
  the extension held out of it, so the `.html` cannot be typed away by
  accident, and the grid behind refreshes to the new name.
- Photo details now show the metadata the file is carrying, with coordinates
  called out as the warning they are.
- English OCR data now ships inside the app (2 MB), so reading text off a scan
  needs no network at all. The other nineteen languages still fetch once.
- **Push a sheet down to close it.** The Details sheet on the phone had one way
  out and it was a Close button in the top right corner of a bottom sheet --
  the furthest point on the screen from the thumb of the hand holding the
  phone. Drag it down instead, from the handle, the title row, or the top of
  the list. Rename closes the same way. The buttons have not gone anywhere.
- **Open with FACET.** FACET now appears in Android's Open-with and share
  sheets, which matters most for the formats nothing else on a phone will
  open: a `.dng`, a `.jxl`, a `.srt`, a file with no extension at all. One
  photo opens its whole folder so you can keep swiping; a selection of twelve
  opens as those twelve, in the order they were sent. A file with no path on
  this device -- a mail attachment, a Drive file -- is copied into the app's
  own cache and opened from there.

### Fixed

- **OCR and transcription could not work at all in a release build.** Both
  fetch a model the first time they are used, and the packaged app's content
  policy named no host they could fetch from -- so OCR stopped at "loading
  language traineddata" and transcription at its download, in every installed
  copy, with nothing on screen to say why. English OCR is now bundled instead
  of fetched, and the two hosts the remaining downloads use are named
  explicitly. They remain the only two addresses the app is permitted to
  contact, and neither is contacted unless you ask for a transcript or a
  language that was not shipped.

- Stripping metadata from a photo left it lying on its side. Phones store a
  picture in the sensor's own landscape frame and write one EXIF tag saying
  which way to turn it, so removing EXIF wholesale removed which way is up --
  and because the stripper deliberately does not re-encode the pixels, the
  damage was permanent and showed in every app, not just this one. That single
  tag is now written back, in a 36-byte block that carries nothing else: no
  make, no model, no time, no position. Files already stripped are not
  repaired by this; they need their orientation set again by hand.
- A rendered HTML page had its last inch hidden behind the action bar. The
  frame asked for `64vh` inside a grid row that was shorter than that, so it
  overflowed its own track. It now takes the height the row actually has.
- A long file name wrapped to three lines and pushed every button in Quick
  Look's head onto a second row, costing a fifth of a phone screen to say what
  the file was called. The name is one line that scrolls sideways.
- In the file grid, a long name's extension could be cut off the bottom of the
  tile — so a tile could not tell you what kind of file it held. The extension
  is now its own element that is not allowed to shrink.
- The Android System WebView runs in this process, so its own network traffic
  is attributed to the app. Safe Browsing and the WebView metrics uploader are
  both on by default and both reach Google; both are now switched off in the
  manifest. Nothing in the app was making the requests, but "no remote
  endpoint" was not the whole truth while the frame it draws in had two.
- The crash-recovery banner on the phone was as tall as a dialog for one line
  of text.
- A thumbnail the decoder refused painted a plain black square, which is
  indistinguishable from a photograph of a dark room. Nothing decodable was
  affected; the tile now falls back to the file's own icon and says what it
  is.
- A picture the background thumbnail worker could not decode came back
  indistinguishable from one it never answered about, so a failure four
  seconds in was logged as a ten-second timeout and the tile was blanked
  instead of being handed to the main thread, which could often decode it.
  The worker's reason now crosses the message boundary, and a worker that
  declines one image no longer costs that image its preview.

### Changed

- Quick Look's head and action bar are smaller on the phone, and the card fills
  the screen rather than floating in the middle of it.
- The social artwork under `assets/` is no longer tracked, so `git add -A`
  cannot sweep an unfinished caption into a release.
- `serve-capped.py` moved from the repository root into `scripts/`.


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

[Unreleased]: https://github.com/IRAS-LABS/facet/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/IRAS-LABS/facet/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/IRAS-LABS/facet/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/IRAS-LABS/facet/releases/tag/v0.1.0
