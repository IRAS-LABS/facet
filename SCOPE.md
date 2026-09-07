# FACET — scope

44 items, locked. Two independent binaries: Windows desktop and Android APK.
The phone is not a remote for the desktop; each stands alone.

**Desktop: 43 of 43 desktop items done.** Item 44 is Android-only. Item 19 stays
`[~]` until face blur is run on a real photo.

Status marks: `[x]` shipped and verified in the running .exe · `[~]` written but
not yet exercised end to end · `[ ]` not started.

---

## Foundations

- [x] **1 — Shell.** Rail, breadcrumbs, status bar, theme picker, window chrome.
- [x] **2 — 2D spatial canvas.** Cursor-anchored zoom, pinch, pan, grid culling,
      DOM recycling, 4 LOD tiers keyed off on-screen card width.
- [x] **3 — Real filesystem.** `src-tauri/src/fsx.rs` — one IPC hop per listing,
      not one per file. Paths normalised to forward slashes in Rust.
- [x] **7 — File explorer proper.** Navigation, selection, sort, hidden-file
      filtering, roots and home places.
- [x] **8 — Command palette.** Rebuilt per open so entries reflect the current
      folder and selection.
- [x] **14 — Universal quick-look.** Space toggles. Text pane or hex dump for
      anything the webview cannot decode.

## Viewing

- [x] **Previews for everything.** Text/code, PDF page one, Office documents as
      their own opening words, archives, RAW via the embedded JPEG, HEIC, video
      frames, album art, folder collages, folder contents listings.
- [x] **9 — Photo viewer.** Full-resolution canvas, CSS-scaled, so preview and
      export run identical code.
- [x] **10 — Video player.** J/K/L, 14 speed stops, A/B loop, layered scrubber.
- [x] **11 — Audio player.** Waveform from a peak scan, never WebAudio — a
      `MediaElementAudioSourceNode` on an `asset://` element plays silence with
      no exception to catch.
- [x] **13 — 3D viewer.** glTF/GLB/OBJ/STL/PLY, orbit, materials, wireframe.
      The format comes from the bytes, never the extension: a binary STL's
      80-byte header very often begins `solid`, which is also how a *text* STL
      begins, so trusting the name makes the ASCII parser find nothing and blame
      the file. `84 + 50n === size` settles it. Formats FACET cannot open —
      .blend, .fbx, .usd, .dae, .3mf — each get their own sentence naming the
      tool that owns them, because "empty scene" is a claim about the user's
      data while "I can't read this" is a claim about FACET, and only the second
      is true. One WebGL context for the app's life, contents swapped per file:
      browsers cap contexts near sixteen and silently kill the oldest, so a
      renderer per file blanks other tabs after a dozen models. Camera framing
      is derived from the bounding *sphere* — the only radius true from every
      angle — with near and far derived too, since a fixed near of 0.1 leaves a
      40,000-unit model tearing through itself. Zero-length normals, which the
      STL spec expressly permits and many exporters write, are recomputed from
      winding; otherwise the model lights as a flat silhouette. 73 assertions,
      five of them end-to-end through a real GPU.
- [x] **16 — Tabular data viewer.** CSV/TSV/XLSX/Parquet, virtualised, sortable,
      filterable. Big files must not be loaded whole. Ctrl+Shift+T, or on
      double-click for those extensions. Sorting and filtering both make a real
      streaming pass over the whole file with a progress bar and a cancel,
      keeping one column of keys and a list of row numbers — a grid that sorts
      only what is on screen looks like it works and answers the wrong
      question. Rows are fetched by number, not by range, so a sorted view's
      scattered reads get coalesced per backend: byte ranges for CSV, row
      groups for Parquet. 183 assertions — 128 in Node against duckdb,
      openpyxl and Python's csv, 55 in a real browser
      (`src/dev/tablecheck.ts`).
- [x] **17 — Hex and binary inspector.** Ctrl+Shift+H, or "hex" in the palette
      under Advanced — never on the main surface. Reads 64 KB windows as you
      scroll, so a 4 GB file opens instantly and bytes that have not arrived
      show as dashes, never as invented zeroes. Structure tree for JPEG, PNG,
      GIF, RIFF/WebP/WAV, MP4/HEIC, ZIP, gzip, PE, ELF and PDF, colour-matched
      into the dump. Every integer width in both byte orders at the cursor,
      plus a plausible date. Streaming search over hex or a quoted string.

## Editing

- [x] **15 — Photo editor.** Undo/redo over a region list, never pixels. Save a
      copy; the original is never touched.
- [x] **20 — Blur system.** 8 kinds × 7 placements, layered, per-region invert /
      feather / opacity / tint.
- [x] **12 — Video speed.** Playback 1/16×–16× in the player; export at ten
      stops from 0.25× to 60× in the editor. Audio is pitch-corrected with a
      chained `atempo` up to 4× and dropped above it, because a timelapse with
      the sound stretched over it is a shriek nobody wants.
- [x] **4 — Video editor.** Press **E** on a clip, or `video.edit` in the
      palette; `video.join` on a multi-clip selection. Trim, split, cut a middle
      out, join, crop by dragging on the picture, rotate, mirror, speed, fade,
      mute, quality. The model is a list of spans to *keep*, so undo/redo is a
      stack of span lists and the source file is never touched — the export
      writes a new file beside it.

      Two things it does that most editors do not. It tells you the truth about
      lossless: a single trim with nothing else asked for runs `-c copy`,
      instant and byte-identical, and the button says so ("Export without
      re-encoding"); anything that forces a decode flips the label before you
      commit. And **Frame-exact** is a checkbox, not a hidden default, because
      the cost of cutting on the exact frame instead of the nearest keyframe is
      a full re-encode and that should be a choice.

      `src-tauri/src/ffmpeg.rs` owns the filter graph — the front end passes a
      typed `Job` and never assembles a command line, because a graph
      concatenated in TypeScript cannot be tested and the graph is where the
      bugs live. Order is load-bearing and asserted: crop before rotate, scale
      after it, `setpts` last, fades in output seconds. Output is staged as
      `<name>.facet-part` and renamed only on success, so a cancelled or crashed
      export never leaves a half-file wearing a real name. 22 Rust tests,
      including real encodes against a synthesised clip; 35 browser assertions
      driven through the DOM by tooltip.
- [x] **5 — Audio editor.** Press **E** on a recording, or `audio.edit` in the
      palette; `audio.join` on a multi-file selection. Trim, split, cut a middle
      out, join, gain in dB, EBU R128 normalise, fades, speed, mono fold, and an
      export in MP3 / M4A / Opus / FLAC / WAV at a chosen bitrate.

      It cuts with the *same* span model as the video editor — `src/core/edit/
      spans.ts`, extracted for this and shared by both — so trimming means the
      same thing in both places and undo is the previous list of kept spans in
      either. The lossless promise is the same and the label mirrors it, with one
      extra condition that only applies here: changing the container gives it up,
      because a copy into a new format is not a copy.

      The waveform is scanned in Rust (`peaks`, 8 kHz mono through a pipe) rather
      than by `decodeAudioData`, which is fine for a song and hopeless for a
      two-hour meeting recording. Cut parts stay drawn, dimmed, because "put that
      bit back" is the second thing anyone does. Gain previews through the
      player's volume so a level can be judged before a four-minute encode — and
      it says out loud that a boost above 0 dB cannot be previewed rather than
      quietly playing it flat.

      Filter order is load-bearing and asserted: `loudnorm` **before** the user's
      `volume` offset, or normalisation silently undoes the gain just asked for;
      speed next; fades last, because fades are timed in *output* seconds. A
      stream copy carries `-map 0`, so a "copy" cannot quietly drop the album
      art. 31 Rust tests including real encodes and a level cross-check against
      ffmpeg's own `volumedetect`; 46 browser assertions driven through the DOM.
- [x] **6 — 3D editing.** Transform, material tweaks, export. An **✎** panel in
      the 3D viewer (**E**) holding move/turn/size, a material override
      (colour, roughness, metalness, flat shading, opacity), unlimited-in-
      practice undo at 60 steps, and **Export a copy** to GLB, glTF, OBJ, STL or
      PLY. The edit is a record, not a mutation: nine numbers and a handful of
      material values in `src/core/model3d/edit.ts`, applied as transforms and
      material properties, so the file as loaded is always one **Reset** away and
      the whole edit is small enough for item 21's crash record to hold.

      The hard part was keeping the *screen* out of the *file*. The up-axis
      correction that stands a CAD part upright is a statement about the display,
      and it lives on a wrapper node the model hangs from — but that is not
      enough on its own, because `STLExporter`, `OBJExporter` and `PLYExporter`
      all write vertices through `matrixWorld`, which is absolute and walks the
      whole chain. Every export would have baked the correction in, and reopening
      such a file applies it a second time: a part that started upright arrives
      on its side, then upside down. `withoutAncestors()` detaches the model for
      the duration of the parse — synchronously, so no frame can be drawn with it
      missing — and glTF is exempt because it writes each node's own TRS and
      never looks up. Two smaller bugs in the same family: `PLYExporter` fires
      its callback from a `requestAnimationFrame` (so the return value is what
      to take, or the restore lands a frame late) and defaults to
      `binary_big_endian`, which half the tools in the wild read wrong.

      The same confusion had already reached the status line: the survey was
      taken after the model was mounted, and `Box3.setFromObject` updates world
      matrices *upwards*, so the "file's own dimensions" were the screen's and
      swapped whenever Z-up was toggled — 10 × 8.6 × 8 became 10 × 8 × 8.6 for
      the same file. Surveyed before mounting now, and asserted both ways. The
      panel footer reports what those dimensions *become* once scaled, which is
      the number someone sizing a part to print is editing toward; a negative
      size stays negative, because that is a mirror and clamping it into the
      positive range would answer a typed −1 with a collapsed sliver.

      128 browser assertions, including byte-level ones: an exported STL is
      parsed back and measured to prove the stand never reached it, the model is
      checked to be back on that stand afterwards, and the whole panel is driven
      end to end through the real toolbar button, number boxes, format picker
      and save button, with Ctrl+Z asserted from a real keystroke.
- [x] **18 — Noise filtering.** Strip traffic, honking and room tone out of a
      recording. A **Noise** group in the audio editor with one control and four
      presets — Room tone, Traffic, Voice, Strong — each a calibrated
      `afftdn`/`highpass` pair in `src-tauri/src/aedit.rs`, applied *before*
      `loudnorm` so the normaliser measures the cleaned signal rather than the
      noise it is about to remove.

      Calibrated against real material rather than guessed: room −5 dB,
      traffic −18, voice −24, strong −56, with speech losing under 1 dB on
      every rung but the last. `tn=1` — ffmpeg's "track noise" flag, which
      every recipe on the internet recommends — makes `afftdn` a near no-op in
      this build, and the ladder does not use it.

      Each preset says in a sentence what it is for, and Strong says out loud
      that it will take a quiet talker with it. Cleaning is a re-encode, so the
      export label gives up "no re-encode" the moment it is switched on and
      gets it back when it is switched off. 38 Rust tests, 53 browser
      assertions.
- [~] **19 — Face detection + automatic blur.** Stills and video, batchable.
      Written and asserted — `src/core/face/`, **Find faces** in the photo
      editor, **Blur faces** in the video editor, `faces.blur` as a batch runner
      over a selection, 91 browser assertions. Marked partial rather than done
      for one honest reason: it has never been run against a real photograph on
      this machine, only against fixtures. Needs one pass by hand before it can
      be called finished.

## Files and privacy

- [x] **21 — Metadata viewer.** Press **I**. Every tag, grouped and named, GPS
      called out separately, and a red banner that says in plain words what the
      file gives away. JPEG, TIFF and TIFF-based RAW, PNG, WebP. Reads a
      Samsung motion-photo trailer that no viewer shows and no EXIF tool
      reports. Coordinates copy to the clipboard and never open a map.
- [x] **22 — Metadata remover.** "Save a clean copy" writes `<name>-clean`
      beside the original; "Clean in place" arms first and fires on the second
      click. Works over a whole selection, and one failure does not stop the
      run. No re-encode — the entropy-coded scan comes out byte-identical.
- [x] **23 — Share.** Send the selection out through the OS share sheet — `↗` in
      the topbar, Ctrl+Shift+S, or the palette. `src-tauri/src/share.rs`.

      Two paths, because on Windows one of them is not enough. The sheet is a
      WinRT `DataTransferManager` reached through the Win32
      `IDataTransferManagerInterop` shim: there is no "share these files" call,
      you register a `DataRequested` handler and then ask for the flyout. It
      must run on the window's own thread and with the app's own HWND —
      `GetForWindow` returns access-denied for a window the process does not
      own — so the command hops to the main thread and waits on a channel. But
      its target list is UWP-only and can legitimately be empty, so the failure
      is surfaced rather than swallowed, and **Ctrl+C puts the files themselves
      on the clipboard** as `CF_HDROP` — what Explorer's own copy does, pasting
      as files into a folder, a mail draft or a chat box, with `Preferred
      DropEffect` set to *copy* so a paste can never silently move the
      originals. Ctrl+C yields to a real text selection, because taking it away
      from a highlighted path is an app fighting its OS. 3 assertions; the
      clipboard one reads back through the shell's own `DragQueryFileW` rather
      than through my encoder, with a non-ASCII path, since the bug that format
      invites is a wide/narrow mix-up that does not fail — it just pastes a file
      called "C".
- [x] **24 — Persistent undo.** Survives a restart. `src/core/undo/store.ts` —
      every change queues the whole undo stack to IndexedDB under the path of
      the file, debounced 500 ms and flushed whenever the window loses focus or
      is hidden — early, because IndexedDB cannot be written once teardown has
      started, so the debounce has to be empty before it begins. A
      restored edit carries the size and mtime it was drawn against; if the file
      has moved on, the work still comes back but the note says so in red
      instead of quietly compositing week-old regions onto a photo that has been
      replaced. Documents shed their oldest history at 4 MB and the store keeps
      the 40 most recent, so a long brush session degrades to a shorter history
      rather than to a failed write. 26 assertions across a real page reload
      (`src/dev/undocheck.ts`) — the claim is "survives a restart", and no
      in-process test can make it.
- [x] **25 — Crash recovery.** Reopen where it died, with unsaved edits intact.
      `src/core/undo/session.ts` records the folder, the selection and the open
      surface behind a 400 ms debounce, plus a flag set at boot and cleared on
      the way out — finding it still set on the next boot is the definition of
      "died". Position is restored silently either way, because reopening where
      you were is what a file manager does and announcing it would be noise;
      only unsaved edits get a bar, and it is offered, never applied. Dismiss
      leaves the work on disk. A folder that has since vanished falls back home,
      and selected paths that are no longer there are dropped rather than
      restored as ghosts.

      **localStorage, not IndexedDB, and that is the whole finding.** The record
      has to be writable at the instant the window is destroyed, and IndexedDB
      aborts there — with the record in IndexedDB every clean exit came back
      reading as a crash, and moving the write earlier did not help, because on
      a real teardown `pagehide` fires *before* `visibilitychange` and both are
      already too late. Item 24 makes the opposite call for the opposite reason:
      megabytes of brush history must not block a frame. 17 assertions across
      three real reloads (`src/dev/sessioncheck.ts`); the one that matters is
      phase four, where nothing is called at all and the teardown is the only
      event — the phase that failed for both earlier attempts.

## Automation

- [x] **26 — Batch queue.** Any operation over a selection, resumable, with
      progress. Ctrl+Shift+B, or `Queue:` in the palette over a selection —
      remove metadata from N pictures, convert N recordings to MP3, convert N
      videos to MP4. `src/core/batch/queue.ts` is the engine, `runners.ts` is
      what it can do, and adding an operation is registering a `kind`.

      The decision everything follows from: **a task is a description, not a
      closure.** A closure cannot be written to disk or picked up by the next
      launch, so a task is a plain serialisable record and a registry maps its
      `kind` to the function that runs it. That is the whole reason the queue
      survives a restart.

      What "resumable" honestly means: the *queue* resumes, not the encode.
      ffmpeg cannot restart four minutes into a file, so a task that was running
      when the app died comes back **queued** and the button says "run it again
      from the start" rather than implying a half-finished file is waiting. The
      partial is not orphaned silently either — the encoder stages to
      `.facet-part`, so a killed run leaves a partial and no output, and the row
      names it.

      One lane by default, because ffmpeg saturates the CPU and four encodes at
      once finish later than four in sequence while making every progress bar
      meaningless. One failure never stops the run. Progress is deliberately not
      persisted — it fires several times a second, and writing that to storage
      would make the encode slower than the encode. The drawer takes real width
      from the shell rather than parking on top of the right-hand column of
      files; a queue you cannot browse past is not a queue. 57 browser
      assertions, including a simulated crash mid-encode and the
      id-arrives-after-the-done-event race that works on a slow machine and
      hangs on a fast one.
- [x] **27 — Watch folders.** Per-folder rules that fire automatically on new
      files — convert, strip EXIF, move, rename. Ctrl+Shift+W, or "Watch this
      folder…" in the palette. A rule is a filter (kinds, extensions, name
      contains, minimum size) plus one action, and every row states in words
      what it will do and how many files it has already done.

      **It polls; it does not subscribe.** An OS watcher fires sooner but
      answers the wrong question. The question is not *when did this file
      appear* but **when did it stop changing** — a 4 GB video dropped into a
      folder appears the instant the copy starts, at zero bytes, and grows for
      two minutes. Handing ffmpeg a half-copied file produces a truncated
      output and a red row while the user's own copy still succeeds, so the
      evidence is gone by the time they look. A file therefore fires only once
      its size is unchanged across two consecutive sweeps. Polling answers that
      directly for one directory listing every four seconds, and adds no
      dependency.

      **A new rule fires on nothing.** Turning a rule on over a folder holding
      four hundred photos must not queue four hundred jobs, so the first sweep
      silently adopts the current contents as the baseline. "Run now" (▶) is
      there for when the backlog *is* what you meant.

      **Two independent loop guards**, because a rename rule whose output lands
      back in its own watched folder would rename its own output forever and
      fill the disk overnight: the filter refuses any name already carrying a
      FACET output suffix (`-clean`, `-converted`, `-blurred`, `-fixed`, and
      their stepped forms), and the watcher *claims* every output path at
      enqueue time into a set that survives a restart. Claims expire only once
      the file has actually turned up and later gone — pruning them by absence
      would throw every claim away on the next sweep, minutes before the file
      it names exists. That was a real bug the harness caught.

      **The move never deletes and never overwrites.** `fs::rename` fails
      across volumes on every platform, and the usual fix — copy, then delete
      the source — is a permanent delete performed by a background rule set up
      weeks ago. The cross-volume path copies and leaves the original alone,
      and the row says so. A taken destination steps to `-2`, `-3`; a rule can
      fire on forty files in a second and silently landing them on top of each
      other would destroy thirty-nine. Output names are chosen by the runner,
      not at enqueue time, because a name chosen an hour early is chosen
      against a folder that no longer exists. 82 browser assertions plus 5 Rust
      tests, covering adoption, a still-growing file, both loop guards
      end-to-end, an unplugged drive not stopping the other folders, and a
      restart.

## Capture

- [x] **28 — Camera.** "Camera" in the palette. Every camera the machine has in
      one picker — the complaint about the snapshot app was that it only ever
      used one of them — a resolution picker, JPEG/PNG/WebP with a quality
      slider, a self timer, a grid (thirds, golden, centre, square), mirror, and
      a clip recorder with a running clock.

      Looks are the point. Eight built in (Natural, Vivid, Warm, Cool, Mono,
      Noir, Faded, Negative) plus eight live sliders — brightness, contrast,
      colour, warmth, tint, mono, negative, blur — and any combination can be
      named and kept, which is the "create my own filters" ask. A look is a CSS
      `filter` string and nothing else, because CSS `filter` and canvas
      `ctx.filter` are the same engine reading the same string: the preview
      *is* the render path, so what is on screen is what lands in the file. The
      cost of that promise is honest — vignette, grain and sharpen are not in
      `filter`, so they are not offered here rather than being offered and
      quietly wrong. Generated strings are validated by assigning them to a
      real element and seeing whether the property survives, so the browser
      itself is the authority on what parses.

      Stills are taken at sensor resolution, not at preview size — the preview
      is `object-fit: contain` and letterboxed, and cropping someone's photo to
      the shape of their window is not a trade-off worth making. Clips are
      recorded off the *canvas*, so the look and the mirror reach the file
      instead of being a preview-only lie.

      The draw loop deliberately does **not** use `requestAnimationFrame`. rAF
      is compositor-driven and throttles to about 1 Hz the moment a window is
      minimised, occluded or backgrounded — and a camera is exactly the app you
      start recording with and then look away from. The harness caught this by
      asserting a byte floor on a one-second clip rather than "a file
      appeared": it came out at 618 bytes, one frozen frame. It now runs on
      `setInterval` against `captureStream(0)` + `requestFrame()`, so frames
      are pushed on a clock the compositor cannot stop, with a fallback to
      `captureStream(FPS)` if the engine will not hand back a pushable track. A
      recording that yields zero bytes says so on the status line instead of
      failing silently, which is otherwise indistinguishable from a save that
      worked until you open the folder.

      Failures are translated: permission denied, no camera, and camera busy
      each get a sentence naming what to do, and a build with no secure context
      says that rather than throwing. Every track is stopped on close — a
      camera light left on is a privacy bug.

      8 settings, keys for shutter / record / mirror / looks / grid (guarded so
      the preset name box does not fire the shutter), and 66 assertions driven
      against a fake camera so the suite needs no webcam
      (`src/dev/cameracheck.ts`).
- [x] **29 — Recorder.** "Record" in the palette. Screen, system sound and
      microphone in any combination, as a floating card that shrinks out of its
      own shot once it starts. Clock, live level meter with a falling peak hold,
      pause and resume, a countdown before it begins, a size ledger with a
      bytes-per-second rate so a long meeting can be judged before it fills the
      disk, and a quality picker. Android's screen-off recording is parked with
      the rest of Android — it needs a foreground service (see 44).

      Two sounds are summed through WebAudio into one track before recording,
      because `MediaRecorder` keeps the first audio track it is handed and drops
      the rest without a word: handing it a system track and a mic track means
      losing whichever the engine happened to order second — half of a
      conversation, discovered at playback. The analyser is tapped off that same
      graph, so the meter cannot disagree with the file. Audio-only takes still
      open a screen share and throw the picture away, because
      `getDisplayMedia({video: false})` is refused by every engine.

      Takes stream to disk as they record, in WebM (or Ogg) because those can be
      appended to mid-recording and MP4 cannot — its index is only written at
      the end, so a crashed MP4 is not a short file, it is no file. The backend
      renames on collision and every append goes to the path the create came
      *back* with, or the tail of the take extends someone else's recording. A
      failed write does not stop the take: it falls back to memory, says so, and
      writes the backlog when the disk returns.

      Four bugs the harness caught that a visual check could not. A suspended
      `AudioContext` produces no samples at all rather than quiet ones, so the
      encoder waits forever for audio and the take is a zero-byte file while the
      clock runs and the card says "Recording" — now detected, with a warning
      that lives in the ledger for the whole take rather than on a status line
      that is overwritten a moment later. `resume()` on a context the autoplay
      policy will not start does not reject, it never settles, so awaiting it
      hung the recorder between "Start" and recording — now raced against a
      400 ms timer. `MediaRecorder` had no `onerror` at all. And its timeslice
      is not a clock: a take carrying a picture *and* a summed audio track sat
      at zero `dataavailable` events after 4.6 s with a 3 s timeslice, then
      produced a full chunk the instant `requestData()` was called by hand — so
      chunking is now driven on our own interval, the same lesson as
      `requestAnimationFrame` in 28.

      102 assertions against a fake screen, fake microphones and a fake disk, so
      the suite needs no capture hardware (`src/dev/reccheck.ts`). The disk
      claims are asserted on a screen-only take on purpose: the autoplay policy
      refuses to start an `AudioContext` for a document that has only ever been
      clicked synthetically, so a mixed take cannot produce bytes in a headless
      harness. A real mixed take started by a real finger is on the manual list.
- [x] **30 — Transcription.** **T** on any recording or video, or "Transcribe"
      in the palette and the right-click menu. Words with timestamps, who said
      what, a searchable transcript that plays from any line, speaker names the
      user can change, and a `.txt` written beside the recording. Everything
      runs in the WebView — Whisper, pyannote segmentation and a wespeaker
      embedding model through transformers.js — so no audio leaves the machine
      and there is no account, no key and no upload. WebGPU when the machine has
      it, WASM when it does not, and the panel *says which* before you start,
      because "two minutes" and "an hour" are different decisions.

      Three models rather than one, because "what was said" and "who said it"
      are genuinely different questions and only the third answers the one that
      matters across a long meeting. The first design stitched per-window
      speaker labels by overlap and was replaced outright, not tuned: in a
      five-second overlap where only one person is talking, the other speaker
      has *zero* overlap evidence and must be given a new name. The harness
      caught it as five speakers in a two-person conversation. Speakers are now
      clustered by voice — agglomerative, average linkage over cosine similarity
      of embeddings — which does not consider time at all, so somebody silent
      for ten minutes is still recognised when they speak again. Average linkage
      rather than nearest-neighbour, which chains two different voices together,
      or furthest, which splits one person over a single bad three-word region.
      A known head count beats the threshold in both directions, because a
      person who was in the room knows something no model does.

      The recording is windowed here rather than by transformers.js: its own
      chunking wants the whole file as one `Float32Array` — half a gigabyte for
      two hours — and makes a progress bar impossible. Windows are 30 s because
      that is exactly what Whisper's encoder holds and anything longer is
      silently truncated, with a 5 s overlap and midpoint ownership of the
      shared seconds, so a sentence that straddles a seam is kept once by
      whichever window owns its middle. Judging by start alone loses a sentence
      that begins just before a seam and runs past it — the later window judges
      it too early to be its own, and nobody keeps it. A tail under two seconds
      is folded back into its predecessor rather than given a window of its own,
      because Whisper answers near-silence by inventing a sentence.

      97 assertions (`src/dev/scribecheck.ts`), none of which load a model. The
      fixture is one word per second named for its second, so the right answer
      for a 90-second recording is checkable by eye, and the panel is driven
      through an injected stub engine. Three real bugs came out of it: a rename
      finished twice — once on Enter, once on the blur Enter causes — and threw;
      a machine with no GPU was told nothing when the file's length could not be
      read, which is exactly when the warning matters; and the harness itself
      was reading a closed panel's lines and calling a partial transcript
      finished. Never run against a real recording on this machine — first use
      downloads the models, and that is on the manual list.
- [x] **31 — Subtitles.** Generate, edit, burn in or export as sidecar. Shift+T,
      or from the transcript panel's **Subtitles** button, or on a `.srt` in the
      file list — which opens against the film beside it, language suffix and
      all, because a sidecar on its own is a list of times against nothing.

      A transcript and a subtitle track are different documents. A transcript's
      unit is the paragraph; a subtitle's is *as much as a person takes in
      before it goes away* — about two lines of 42 characters, held between one
      and seven seconds, at seventeen characters a second. Those four numbers
      are the whole craft, they are all arithmetic, and so the model
      (`src/core/speech/subtitles.ts`) imports nothing but the transcript types
      and can be checked exhaustively without a model or an encoder.

      The invariant is narrow and absolute: **every word said appears, once, in
      order, while it is being said.** Its failure mode is silent — the track
      plays, the timings look right, and one sentence in a hundred is missing —
      so it is asserted over the whole fixture rather than spot-checked. Lines
      are wrapped balanced rather than filled (exact-k DP over squared distance
      from the mean, with a bonus for breaking at punctuation worth about nine
      characters of imbalance): a filled wrap leaves one word alone on the
      second line, which is legal, within budget, and looks like a bug. Only a
      cue's *end* moves when it is given room to breathe — pulling a start
      earlier shows words before they are spoken.

      One tolerant parser reads both SubRip and WebVTT, since they differ in a
      header, a decimal separator and positioning syntax nobody hand-writes;
      blocks with no `-->` are skipped, which disposes of WEBVTT, NOTE and
      STYLE in a single rule. Speaker labels are judged over the *file*, not the
      line — "Note: the tape runs out" has the same shape as "Ada: morning", so
      a name is a name when it recurs, or is `Speaker N`, or is in capitals. A
      name that appears exactly once stays text, on the grounds that the
      alternative puts a stranger's name on the transcript.

      Burn-in goes through ffmpeg's `subtitles=` filter, which sits inside a
      filtergraph where `:` separates arguments, `,` ends the filter and `\`
      escapes — a Windows path is all three at once. Rather than write an
      escaper, Rust stages the text as an ASCII `sub-<hash>.srt` under
      `%TEMP%/facet-subtitles` and runs ffmpeg *with that as its working
      directory*, so the argument is a bare filename with nothing to escape.
      The filter goes after crop/rotate/scale, so text is never distorted, and
      before `setpts`, so cues ride along with a timelapse. Sizes are given in
      per-cent of picture height on both sides — libass scales against a
      `PlayResY` of 288 — and the live overlay is measured the same way against
      a stage that takes the video's own aspect ratio, so the preview and the
      burn agree. Burning in forces a re-encode, so `copyable()` excludes it,
      and it always writes `name (subtitled).mp4` beside the original: text
      becoming pixels is the one subtitle operation that cannot be undone.

      174 assertions (`src/dev/subcheck.ts`) — 119 on the model, 55 driving the
      panel through a stubbed host. The harness earned its keep immediately: it
      caught the "Note:" mis-reading and a mis-tuned punctuation bonus, and four
      of its own nine early failures were bugs in the fixtures rather than the
      code. Never run through ffmpeg on a real video on this machine — the
      burn-in path is on the manual list.
- [x] **32 — Document OCR.** Searchable text out of scans and photos.
      Tesseract through `tesseract.js`, all of it bundled — a `?url` import
      copies the self-contained SIMD-LSTM core into the build so the packaged
      app serves its own WASM. The one thing not bundled is language data, ~2 MB
      per language fetched once and cached in IndexedDB by tesseract.js itself,
      and the picker says so where a language is chosen. Tesseract rather than
      one of the transformer models already installed for transcription because
      TrOCR and Florence-2 read a *line* — they need a pre-cropped strip and
      have no idea where the lines are. Finding them is the layout analysis
      Tesseract has and they do not, and a document-capable vision model that
      does both is 500 MB to a gigabyte against Tesseract's ~4 MB.

      The engine (`engine.ts`) does the I/O and holds no opinions; every
      judgement about what a result *means* lives in `page.ts`, where it can be
      checked against hand-built rectangles without a WASM binary in the loop.
      Pages under 1400 px on the short side are bicubically upscaled by a whole
      number — Tesseract wants roughly 300 dpi, and a 1.7× resample rings on the
      sharp edges of text in a way 2× does not — then every box is divided back
      down, so the overlay lines up with the picture the user is looking at
      rather than an intermediate they never saw. `rotateAuto` is on because a
      page fed in sideways returns *nothing*, which is the failure nobody can
      diagnose; `problems()` says afterwards that it had to be turned.

      Reading order is the part that matters. Blocks are grouped into columns
      when a vertical gutter wider than 4% of the page separates them, and a
      block spanning more than 70% of the width is treated as a divider — a
      headline or a rule — that bands the page, so a magazine reads
      top-column-column-strip-column-column instead of left-to-right across the
      fold. Paragraphs break where a line gap exceeds 1.5× the median line pitch
      of the block, which is scale-free and needs no font metrics. A trailing
      hyphen rejoins only when the next line starts lower-case, so `self-` +
      `employed` becomes one word and `Anglo-` + `Saxon` stays two.

      Confidence is carried per word, not averaged away: below 75% a word is
      drawn with a dotted underline the user can toggle, and a page averaging
      under 70% gets a strip saying so before they trust it. Words are
      click-selectable off the picture — click for a word, drag a marquee for a
      block — with a 0.4%-of-page threshold separating the two. Cancelling kills
      the worker outright, since the WASM call does not yield; three seconds to
      restart is the price of a stop button that actually stops the fan.
      Searchable PDFs come out of Tesseract one page at a time and are joined
      with pdf-lib's `copyPages` (lazily imported, so a session that never asks
      never downloads it) rather than by gluing bytes, which produces a file
      that opens in exactly the readers lenient about it.

      164 assertions (`src/dev/ocrcheck.ts`) — 101 on the model, 63 driving the
      panel through a stubbed engine and host. Fixtures are hand-built
      rectangles rather than real scans on purpose: a scan would be testing
      Tesseract, which is not the part that can be wrong here, and a rectangle
      can be placed one pixel either side of every threshold, which no real page
      obliges by doing. Six wrong assumptions were caught by reading the source
      before running it — a headline 200 px too narrow to band the page, a "30 px
      gutter" that was actually 282, a stub confidence sitting exactly on the
      wrong side of the 70% line. The clipboard is stubbed, because an earlier
      check in this project overwrote what someone had copied. Never run against
      a real scan on this machine — first use downloads the language data — so
      that is on the manual list.

## Configurability

- [x] **Theme system.** 11 themes, 23-token contract, user themes as base +
      sparse patch.
- [x] **33 — Settings surface.** Everything configurable, one place, searchable.
      ⚙ in the topbar, `settings` in the palette, Ctrl+, anywhere.

      Settings are *declared as data* in `src/core/settings/registry.ts` — id,
      group, label, help, keywords, range, unit, default — and the panel is
      generated from that list. Nothing about a new setting is a screen: it is a
      declaration plus a reader, which is the only reason items 41, 42 and 43
      below cost what they did.

      Four decisions that carry the rest:

      - **Only non-default values are stored.** The file is a diff, so a default
        someone never chose can still be improved in a later build, and toggling
        a switch on and off again does not pin today's answer forever.
      - **Nothing throws.** `coerce` clamps, snaps to step, and falls back; a
        truncated file, a hand-edit, or a choice this build has dropped costs
        that one value and nothing else.
      - **One writer, one reducer.** Every call site writes the *setting*;
        `applyPref` in `main.ts` is the only thing that acts on a change. Two
        copies of "should folders come first" is how they drift.
      - **Live by default.** Nothing here asks for a restart.

      `--fct-ui-scale` and `--fct-density` had been in base.css since the first
      commit with nothing to write them, so Text size and Spacing resize the
      entire shell for two property writes. Reduce motion is deliberately
      three-state: untouched means Windows decides, and touching it either way
      takes over. Things with their own storage — themes, watch rules, saved
      edits — appear as contributed rows rather than being mirrored into this
      store, because two sources of truth drift.

      149 assertions, plus `/prefsview.html`, a page that renders the real
      registry. That page caught two bugs no assertion could: `[hidden]` loses
      to any `display` rule, so the whole backup block and every filtered-out
      search row were visible while the tests — which read the `.hidden`
      *property* — passed. Regression assertions now read computed `display`.
- [x] **34 — Layout presets.** Grid, list, columns, gallery; per-folder memory.
      **List landed early** — the tile grid was the wrong shape to read a folder
      in, so `src/ui/list-view.ts` + `src/styles/list.css` ship a virtualised
      details list with a live preview pane beside it, a draggable divider, and
      full paths that select and copy. Sortable headers, keyboard range
      selection, and a 22px thumbnail only for the kinds where a thumbnail
      distinguishes anything. Ctrl+Shift+V, the topbar toggle, or `view.mode`
      switches; the choice persists. 25 assertions — one of which caught the
      virtualiser mounting all 40,000 rows because a grid's implicit row is
      `auto`.

      **The other three then landed together**, and the first thing they needed
      was for the shell to stop naming the modes by hand.
      `settings.get(PREF.view) === "canvas" ? "canvas" : "list"` was written out
      in four places — the shell, the folder rules, the topbar and the settings
      registry — and each was a place to forget. `src/core/explorer/modes.ts`
      is now the list: id, label, glyph, one-line blurb. The topbar buttons, the
      palette commands, the settings dropdown and the Ctrl+Shift+V ring are all
      generated from it, so a fifth mode is a fifth entry.

      `parseMode` is deliberately total, and that is not defensive
      programming for its own sake: the per-folder rule store is *older* than
      two of these modes, the file is small and hand-editable on purpose, and a
      folder whose saved layout said `"grid"` from some other build had to open
      in something rather than not open at all.

      **Gallery** (`src/ui/gallery-view.ts`) is the list's opposite on purpose:
      virtualised by *row* rather than by item, every mounted tile asks for a
      picture — unlike the list, where only images and video are worth a decode
      — and zoom is stepped, never a drag-slider, because a drag-slider was
      tried first and rejected as the wrong feel for a grid. Tile geometry is arithmetic shared with the CSS through custom
      properties, and the stylesheet carries a warning that nothing in it may
      change a tile's outer size.

      **Columns** (`src/ui/columns-view.ts`) answers the question neither of the
      others does — *where am I* — by putting the walk on screen: one column per
      folder, a chevron on the rows that have something to the right, and a peek
      pane for a file. It never touches the filesystem: `onList(path)` hands
      back entries shaped exactly like the current folder's, so no column can
      sort differently from the one beside it. Every column is virtualised
      separately, because stepping into `node_modules` by accident should cost a
      screenful. And every listing carries a token, so the answer to a folder
      you have already clicked away from is dropped rather than painted — the
      one real race in the view, and the hardest thing here to notice by hand.

      **Per-folder memory** turned out to be already working — `setMode` writes
      `rules.set(cwd, {mode})` and `applyFolderRule` reads it back — so it was
      verified rather than rebuilt: Home set to columns, Exports set to gallery,
      and each one restored on the way back. What did have to change was
      `rules.ts`, which named the two modes itself and would have silently
      dropped a folder saved as `gallery`.

      57 assertions in `/dev/modecheck.html`, including the late-listing race and
      both virtualisers, plus a live pass over all four modes in the running
      app. One thing the harness could not have caught and the screenshot did:
      a thumbnail that fails to load leaves the browser's broken-image icon in
      the tile, which reads as a corrupt file rather than a missing picture.
      Both new views now fall back to the kind glyph on `error`.
- [x] **35 — Keyboard map.** Fully rebindable.
      Twenty commands declared as data in `src/core/keys/commands.ts` — id,
      label, group, the chord it ships with, scope — and the shell no longer
      asks "was that ctrl and K". It asks `keys.match(e)` what the user pressed
      and switches on the id that comes back. That inversion is the whole
      feature: rebinding becomes a value in a map instead of an edit to a
      handler, and `src/ui/keys.ts` generates the editor from the declarations
      the way the settings panel is generated from the registry. Ctrl+Shift+K,
      `shortcuts` in the palette, or Settings → Appearance → Keyboard.

      Four decisions carry it. **One function names a key event** — `chordOf` is
      used both to capture a binding and to match a live press, so a layout that
      reports `!` for shift-and-1 captures and matches identically; a keymap that
      normalises differently in those two places binds keys you can then never
      press. **Only the diff is stored**, so a default that is later improved
      still reaches anyone who never rebound it, and a chord for a command this
      build no longer has survives a downgrade instead of being wiped.
      **Conflicts are shown, never resolved** — passing through a collision is
      how a rearrangement is done, so binding is never refused, but both rows
      name the other command and say which one wins. **Esc cancels rather than
      binds**, because it is the key someone presses to get out of a control they
      opened by accident; anyone who genuinely wants it can take it with ⌫.

      Capture runs on the capture phase on `window`, or the chords worth
      rebinding — Ctrl+K, Ctrl+, — would open their own panel instead of being
      recorded. Every hint in the palette and every tooltip in the topbar now
      reads its chord from the map, so a rebind is reflected everywhere the app
      names a key rather than in the one place it was pressed.

      103 assertions in `/dev/keycheck.html`, and verified in the running app:
      rebind the palette to Ctrl+J and Ctrl+J opens it while Ctrl+K stops doing
      anything; "Put every shortcut back" empties the file and Ctrl+K works
      again.
- [x] **36 — Column and metadata config.** Choose what a card and a row show.
      **One field table, not two.** "Which columns does the details list show"
      and "what goes under the name on a card" are the same question asked of the
      same file, and every app that answers them in two places ends up able to
      show a duration in one view and not the other for no reason anybody can
      explain. `core/explorer/fields.ts` declares eight fields — name, kind,
      size, modified, type, dimensions, length, where — each with a label, a
      width, a sort key where one exists, and a `value(entry)`. A column is a
      field with a width; a card subtitle is a few fields joined with " · ".
      Both views read the same functions, so a date is written the same way in
      both, and the pane's fact list shares them too.
      **A field returns "" when it has nothing to say.** A JPEG has no duration,
      a folder has no size worth printing — a folder's real size costs a walk of
      the whole subtree, and printing 0 is a lie told cheaply. That is what lets
      one card list suit a video and a text file: `duration,ext,size` reads
      "2:31 · MP4 · 46 MB" on one and "TXT · 4.0 KB" on the other, instead of a
      run of empty separators.
      **Stored as a readable line of ids** — `name,kind,size,modified` — not as
      JSON. A line survives being read, hand-edited and pasted between machines
      by someone who has never seen the file, and `parse` treats anything it
      does not recognise as absent rather than as an error: a dropped field is a
      column you did not get, a thrown error is a file explorer that will not
      start. A line of nothing but ids this build has never heard of falls back
      to the default rather than becoming a name-only list, and a hand-edited
      column list with no name in it gets one put back in front.
      **The line is the value; Choose… is the nicer way to write it.** Both
      settings rows keep their text box and grow a button onto one small panel
      that adds, removes and reorders — order is edited where the order lives,
      because in a details list the order *is* half the configuration. It writes
      on every click rather than behind an OK button: the folder is still behind
      the sheet and repaints as you go, so adding a column is something you see
      rather than something you predict.
      91 assertions in `/dev/fieldcheck.html`, and verified in the running app on a
      real folder: adding **Where** from the chooser grew the header, the tracks
      and every row at once, removing **Kind** shrank them, and on the canvas
      adding **Dimensions** turned a card's line into
      "1:13:52 · MP4 · 189 MB · 3840 × 2160".
      One real bug came out of that live pass and is now a regression test: the
      shell keeps one `ViewConfig` and mutates it, so the view compared
      `cfg.columns` with itself, repainted the header, and left the rows beneath
      it holding the old cells. The change is decided from the resolved field
      list instead.
- [x] **37 — Sort and filter rules.** Saved, per-folder.
      **A filter is a line you type, not a form you fill in** —
      `report kind:image size:>2mb after:2026-01-01`. Same reasoning as item
      36's field ids: a line survives being read, saved under a name,
      hand-edited, pasted to somebody else and stored per folder, and none of
      that is true of a nested object behind a dialog. It also means the filter
      box and a saved filter are the same thing, so there is nothing to keep in
      step. `kind:` `ext:`/`type:` `size:` (`>` `<` `>=` `<=` `=`, and bare
      means at least) `after:`/`since:`/`modified:` `before:`/`until:` `is:`
      `name:`, comma lists everywhere, `"quoted phrases"`, and `-`/`!` in front
      to negate. Rules are ANDed, because that is what narrowing means: every
      word you add takes files away. There is no OR, because nobody would
      remember the syntax for it.
      **Nothing is rejected and nothing throws.** `foo:bar`, `size:banana`, a
      stray `C:/Users` pasted from the address bar — each becomes plain text
      matched against the name, never an error. Every alternative ends with a
      file explorer refusing to filter until you have typed something it
      approves of, which is worse than showing you too many files. `kind:photo`
      works as well as `kind:image`; nobody types the name of a union member.
      **Per-folder memory is a diff, one level down.** The settings store holds
      the default, the rules store holds the override for one folder, and
      `applyFolderRule` is the single place that resolves the two into the view
      — so sorting one folder by size cannot rewrite "Sort by" for the whole
      app. Turning the memory off (Settings → Explorer) puts every write back on
      the global default, and "Forget them all" empties the folder memory while
      leaving your saved filters alone. Capped at 400 folders, evicting the
      least recently *changed*, because a map keyed by every folder ever opened
      only ever grows.
      **A filter never follows you into the next folder.** Arriving somewhere
      starts from that folder's own rule or from nothing; only a reload of where
      you already are keeps what is in the box. An explorer that smears the
      filter you typed across the folder you land in makes a full folder look
      empty, which is the most alarming thing a file manager can do. The raw
      listing is kept beside the filtered one, so clearing the box is instant
      and never touches the disk.
      Ctrl+F, a menu of eight ready-made filters that drop their query text into
      the box where it can be edited — which is the only way anybody learns a
      syntax they were not taught — saving under a name from an inline field
      (`prompt()` returns null on WebView2, so a dialog would silently never
      save), palette entries for the box, for clearing it and for each saved
      filter, and a status line reading "⌕ 6 of 40 · kind is image · size >
      1.0 MB" so the filter always says what it is doing.
      130 assertions in `/dev/rulecheck.html`, and verified in the running app:
      typing `kind:image size:>1mb` cut 40 entries to 6 live, walking into
      Exports arrived with an empty box, sorting Exports by size was still there
      on the way back while the folder above kept its own filter, clearing a
      filter dropped that folder's rule rather than storing an empty one, and
      "Forget them all" emptied the folder memory but kept the saved filter.
- [x] **38 — Sidebar and places.** User-defined, reorderable.
      **The folder tree landed early**, because FACET was not reading as a file
      explorer without it: a pane of cards tells you what is in *this* folder and
      never where this folder sits, and the icon rail was never that — a set of
      destinations is not a map. `src/ui/tree.ts` + `src/styles/tree.css` take
      the shape of the an earlier explorer of ours explorer pane — one column, text
      chevrons, 12px of indent per level, hover as the only row decoration — and
      change three things, each forced by this being a disk rather than a
      database table: children load only when a node is opened, everything
      starts closed, and files are left out. `C:\` has hundreds of thousands of
      folders under it and the eager version would hang on first paint.

      The chevron and the name are separate controls: the arrow unfolds a folder
      so you can look inside it without leaving the folder you are in, the name
      takes you there. A folder opened and found empty of folders loses its
      arrow, the way Explorer does. Drives sit under a "This PC" heading. Icons
      are drawn as SVG, not typed — U+1F5C0 has no glyph in Segoe UI and the
      first version was a column of tofu.

      The tree is a *view* of navigation, not a driver of it: everything that
      moves the app calls `reveal()`, which walks down by string prefix from the
      closest matching root and opens the levels as it goes. A tree that only
      tracked its own clicks would go stale the first time the address bar was
      used, and a stale map is worse than none. An unreadable folder — System
      Volume Information, another user's profile, a dropped network drive — says
      so on its own row and the rest of the sidebar carries on. Width and
      collapse persist; `--fct-tree-w` on `:root` is the single source of the
      layout truth, so nothing else has to be told the sidebar changed size.
      Ctrl+B toggles it. 50 assertions.

      **The other half — which folders are in the sidebar at all — is a diff,
      not a list.** This is the decision the rest of `src/core/explorer/places.ts`
      follows from. The adapter discovers what exists on this machine, and that
      list is not stable: a stick appears, a network drive drops, a profile is
      renamed. A store that saved the whole sidebar would show a drive that was
      unplugged in March and would never show the one you just pushed in, and
      there is no merging step that fixes that afterwards. So what is written is
      only what you *changed* — folders you pinned, discovered ones you hid,
      names you gave them, and the order — and everything else is whatever the
      machine says today. Same shape as the per-folder rules in item 37, for the
      same reason: a preference file should record decisions, not state.

      The order is stored the same way, as a *partial* one. Ids you have moved
      rank first, in your order; anything unlisted keeps the position it arrived
      in, after them. So pinning a folder does not renumber the sidebar, and a
      drive the machine has never reported before still appears rather than being
      dropped for being unknown.

      One hard constraint the ordering has to respect: the tree draws its "This
      PC" heading at the first row whose icon is `drive`, so a folder sorted
      below a drive would be filed under This PC — which nobody asked for.
      Reordering therefore happens *within* your folders and *within* the drives,
      never across. `resolve` splits on that line and sorts each side.

      Three things that would otherwise have shipped as quiet failures:

      - **Hiding is not deleting.** A discovered place you remove stays listed,
        greyed, under **Hidden**, with one button to put it back. Without that
        the only route back from taking Pictures off the sidebar is finding and
        deleting the preference file.
      - **A pin removed is deleted; a discovered place removed is hidden.** One
        verb, two storage shapes, because from the outside they are the same act.
        Filing your own pin as "hidden" would leave a row you could never clear.
      - **Pinning un-hides.** The hidden list is keyed by id and the pin button
        has only a path, so the store keeps what the machine last reported in
        order to tell that `pics` and `C:/Users/me/Pictures` are the same row.
        Without it, pinning a folder you had hidden did nothing at all — caught
        by the harness, which is the only reason it is not in the binary.

      Editing happens in `src/ui/places-panel.ts`, deliberately the same sheet as
      the column chooser: same ▲▼ to move, same ✕ to drop, every click written
      immediately. The sidebar is on screen behind it, so changing it is
      something you watch happen rather than something you approve in advance.
      Renaming is a field rather than a dialog for item 37's reason — `prompt()`
      returns null on WebView2, so a dialog would silently never rename. Reached
      from ⋯ in the tree header, from **Places** under Explorer in Settings, and
      from the palette; **Alt+Up/Down** on a top-level tree row moves it without
      opening anything, and keeps focus on the row so it can be held down.

      129 assertions, most of them the machine's list changing underneath a saved
      preference: a stick mounting and unmounting, a much shorter list, the full
      list coming back, and fifteen shapes of corrupt file. Verified live: the
      panel, tree and rail move together, the pin survives a reload, and the
      saved file is `{pinned, hidden, order, named}` with nothing else in it.
- [x] **39 — Context menu builder.** User-defined actions.
      **There is no second command registry.** The menu is a line of ids over the
      same `commands()` list the palette is built from, exactly as `PREF.columns`
      is a line of field ids over `FIELDS` — so a module that registers a command
      gets a palette entry, a rebindable shortcut and a menu candidate in one go,
      and a thing cannot be offered in one place and missing from another. A
      user's own action is not a special case either: `ActionsStore` yields
      synthetic commands with id `act:<id>` and group **Yours**, pushed into
      `commands()` beside everything else, which is why the right-click menu,
      Ctrl+K and the shortcut editor all pick it up without any of them knowing
      that user actions exist.

      The line is text — `file.open,file.look,-,file.reveal,File*` — because that
      survives being read, hand-edited and pasted into an item 42 backup, and
      because "then everything else" is one character. Four rules in
      `@core/explorer/menu`, all of them about the menu still working after the
      list it names has changed underneath it: an id nothing offers **drops out**
      (a menu line is a preference, never a promise); separators **collapse**, so
      a rule never floats above nothing; an empty result **falls back to
      everything**, because a menu with no rows reads as broken rather than as
      your own editing; and `File*` is **everything else in that group**.

      That last rule is the one the running app taught me. The default first
      ended in a bare `*`, and a right-click drew forty-three rows — every sort,
      every navigation command and all eleven themes, "Theme: Nord" and all. That
      is the palette wearing a menu's clothes. The shipped line ends in `File*`
      instead, so a file command that ships in a later version still turns up
      without anyone editing their line, and nothing unrelated to what you
      clicked ever does. A bare `*` is still available for whoever wants it; the
      builder just offers the groups above it, because a group is nearly always
      what was meant.

      **No shell, ever.** `splitArgs` cuts the argument line into argv in TS,
      `{path} {paths} {stem} {dir}` are substituted *after* that split, and Rust
      spawns the program directly with the resulting vector. So a file called
      `a & del *.jpg.png` is one argument with an ampersand in it, and there is
      no interpreter anywhere on the path that could read it as anything else.

      Editing is `src/ui/menu-panel.ts`, the same sheet as the column chooser and
      the places editor: ▲▼ to move, ✕ to drop, every click written, no OK
      button. Two differences the subject forced — a row may name a command that
      is *not available right now* (perfectly valid: `video.edit` while you are
      looking at a spreadsheet), so it is drawn dimmed rather than hidden, or you
      could never delete something whose effect you can see; and an action is
      saved on every keystroke, because filling one in means leaving to find a
      program's path and an editor that discarded a half-typed action would be
      one nobody finished using. `problemWith` decides whether an action is
      *offered*, not whether it is *kept*.

      208 assertions. Verified live: right-click opens at the pointer and does
      not shrink a multi-selection (2 selected → 2 after); **Shift+F10** opens it
      beside the focused row, on screen; the builder opens from its last row,
      draws the line, and **+ New action** yields a form that reports "Give it a
      name" until it is filled in and then "Offered in the menu as …"; the store
      writes `{version, actions}` and nothing else.
- [x] **40 — File associations.** What FACET opens with what, internally.
      Three layers, most specific first: an **extension** beats a **kind** beats
      what FACET **shipped** believing. That order is the whole feature — pinning
      `.json` to the table view must not move the rest of your code, and later
      deciding all code opens in the inspector must not quietly eat the `.json`
      you pinned first. Both are asserted directly.

      **Availability is a separate question, asked afterwards.** `resolveOpen`
      takes the preference *and* the list of handlers that can actually run here,
      and falls down the layers until something on that list answers — extension,
      then kind, then the built-in, then Windows, then anything at all. A
      preference is matched against reality rather than trusted over it, which is
      why the browser preview (no video editor, no hex inspector, no Windows)
      still opens every file with something, and why a `.psd` pinned to a handler
      that a later build drops does not become a file that opens nothing.

      **Handing it to Windows is an ordinary handler**, not a branch beside the
      resolver. That is what lets somebody say *always do that* for one extension
      without the resolver growing a special case — and it is also the last resort
      before the alphabet, because opening an unknown file in the metadata panel
      merely because `m` sorts before `s` is a worse answer arrived at by accident.

      Reached three ways, all the same store: right-click a file → **Always open
      .jpg with…** (with `now: picture viewer` in the hint), the **Open with**
      group in Ctrl+K for a one-off that changes nothing, and Settings → Explorer
      → *What opens what*. The sheet asks `handlersFor` and `resolveOpen` — the
      same two the double-click asks — so it cannot disagree with what actually
      happens; a handler that cannot take this kind is shown greyed rather than
      hidden, because knowing the video editor exists and cannot take a `.txt`
      beats a list that changes length on every row.

      Extensions start empty and stay a list of *decisions*: choosing what a kind
      already shipped as clears the row instead of storing it, and arriving from
      "Always open .jpg with…" raises a **provisional** row — showing what a .jpg
      does today, with nothing written to disk — that becomes real only when a
      chip is picked. The first live run caught the gap this fixes: the sheet
      opened on the general list and left `.jpg` as one of twelve buttons under
      "Add an extension", which is the sheet ignoring the question it was asked.

      146 assertions: the shipped table, extension normalisation (`.JPG`, `..jpg`
      and ` jpg ` are one key), the three layers, matching against availability
      including the browser-preview case, what it writes and reads back, fifteen
      shapes of hand-edited file (one bad line costs one line, never the file),
      and the sheet driven through the DOM. Verified live: the right-click row
      lands on a provisional `.jpg`, picking **Metadata** writes
      `{"version":1,"byExt":{"jpg":"meta"},"byKind":{}}`, double-clicking the
      picture then opens the metadata panel instead of the viewer, and ↺ puts it
      all back.
- [x] **41 — Startup and session.** What opens on launch, restore last session.
      **Start in** takes a path, blank meaning "wherever I was last"; **Offer to
      restore the last session** governs the crash-recovery prompt item 25
      already wrote. Neither is a new screen — the first is a text declaration
      read by the launch path, the second a toggle read by the prompt.

      The one piece of real work is that a path typed by hand is a bad way to
      choose a folder in a file explorer, so the row carries a **Use this
      folder** action that writes the folder you are standing in. `addAction`
      lets the app hang a verb off a declared row without the registry knowing
      anything about the app.
- [x] **42 — Import/export settings.** One file, portable between machines.
      Backup… opens a block with the JSON in a text area — copy it into a
      message, paste one back, and **Apply** validates before it changes
      anything. Beside it, **Save a file** and **Load a file**.

      **The explorer is the file picker.** Save writes
      `facet-settings.json` into the folder you are in and steps the name rather
      than overwriting; Load reads whichever file is *selected*, and says
      "Select a settings file" instead of guessing when nothing is. So there is
      no file dialog, no new Tauri plugin, and the panel still works in a plain
      browser tab — it is handed a disk (`useFiles`) rather than reaching for
      one, which is also how it is tested. A file that will not read, is not
      JSON, or is not ours says so and changes nothing.
- [x] **43 — Performance controls.** Cache sizes, preview budgets, decode lanes.
      The preview budgets — previews on/off, folder previews, lanes, cache size,
      text lines — live under **Previews**, where someone looking for them will
      look. **Performance** holds the work that happens while you are doing
      something else: encodes at once, how often watched folders are swept,
      table blocks kept in memory, and how many files keep a saved undo history.

      Every one of the four has a live reader, and two of them needed the reader
      built: `BatchQueue.setLanes` widens on the spot and narrows *without*
      killing anything already running, and `WatchService.setInterval` re-arms a
      running sweep timer and clamps whatever it is given to a second, because
      the declared minimum does not constrain a hand-edited file and a
      zero-millisecond sweep is a busy loop over somebody's disk. The other two
      are read at the point of use, so they need no reducer at all.

      No setting is declared here that nothing reads. After the first dead
      switch a user stops trusting the rest of them.

## Android

- [ ] **44 — Widgets.** Parked with the rest of Android until desktop is done.

---

## Extras already shipped, outside the 44

- **Brand.** `brand/make-icons.py` generates all 44 raster assets from one
  master. Re-run after any geometry or colour change; it is idempotent.

## External tools the build expects

- **ffmpeg / ffprobe 8.1.2** (Gyan full build, on PATH). Covers items 4, 5, 12,
  18, 29, 31. Note: this build has **no HEIF muxer**, so it cannot *write* HEIC.
