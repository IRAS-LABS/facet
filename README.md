<div align="center">

<img src="brand/out/android/play-store-512.png" alt="" width="104">

### Facet

**All-in-one file explorer and media studio.**<br>
Desktop and Android, fully on-device.

[![Download](https://img.shields.io/github/v/release/IRAS-LABS/facet?label=download&color=15a34a)](https://github.com/IRAS-LABS/facet/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-15a34a)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Android-15a34a)

</div>

Browse your files, then edit what you find without leaving. Cut a video, clean
up a recording, blur the faces out of a photo, pull the text off a scan, get a
transcript of a meeting, strip the GPS out of a picture before you send it —
all in the window you were already looking at.

Everything happens on your machine. There is no account, no sign-in, no
telemetry, and **nothing you open is ever uploaded** — no file, no picture, no
audio, no text. Transcription, OCR and face detection are models that run
inside the app, not services it calls.

One model is not in the download, and it is the one place Facet reaches the
internet on purpose. **Transcription** fetches its Whisper model from the
Hugging Face hub the first time you pick a quality (80 MB, 150 MB or 500 MB),
then keeps it and works with the radio off from then on. Everything else is
already inside: face and plate detection, and **OCR in English**. OCR in one of
the other nineteen languages fetches that language once (about 2 MB, from
jsDelivr) and then caches it too.

Those two hosts are the entire list — they are the only ones the app is even
allowed to contact — and neither is touched unless you ask for a transcript or
a language Facet did not ship with. If a first-run download is not acceptable
to you, transcription is the one feature to leave alone.

It is one codebase: Windows desktop and an Android app with a phone-shaped
interface, not a remote control for the desktop. Built with
[Tauri v2](https://tauri.app) — Rust and a little Kotlin underneath, plain
TypeScript on top.

## Download

| | | |
| --- | --- | --- |
| **Windows 10/11 (x64)** | [`Facet_0.1.5_x64-setup.exe`](https://github.com/IRAS-LABS/facet/releases/latest/download/Facet_0.1.5_x64-setup.exe) | 26 MB — run it, it installs like any other app |
| **Android 7.0+ (arm64)** | [`facet-0.1.5-universal-release.apk`](https://github.com/IRAS-LABS/facet/releases/latest/download/facet-0.1.5-universal-release.apk) | 51 MB — your phone will ask you to allow the install once |

The Windows installer is not code-signed, so SmartScreen will say "Windows
protected your PC" — **More info**, then **Run anyway**. On desktop, put
`ffmpeg` and `ffprobe` on your `PATH` for the video and audio features;
everything else works without them. On Android, FFmpeg is already inside the
APK.

`universal` in the APK's name is the Gradle output directory, not the
contents: it holds one ABI, `arm64-v8a`. See
[Installing the APK](#installing-the-apk-on-android) for what that covers.

Prefer to build it yourself? See [Build from source](#build-from-source).

### Installing the APK on Android

There is no Play Store listing — sideload it.

1. Download `facet-0.1.5-universal-release.apk` onto the phone.
2. Open it. Android asks permission to install from this source; grant it, and
   revoke it afterwards if you prefer.
3. Launch Facet. It asks for storage on first run — see
   [Android permissions](#android-permissions-and-why) for what it wants and
   why.

Requires **Android 7.0 (API 24) or newer** on an **arm64** phone, which is
every Android phone sold for years. There is no 32-bit or x86 build.

### Verify what you downloaded

The APK is signed with the project key. Check the *certificate*, rather than
trusting the file or wherever you got it:

```
apksigner verify --print-certs facet-0.1.5-universal-release.apk
```

```
Signer #1 certificate DN: CN=Facet, OU=IRAS Labs, O=IRAS Labs, C=US
Signer #1 certificate SHA-256 digest: 9758cfbb55512376bdf8c8e373de860afef23e33ed1a7e3bb1b0bb5bc0bfa286
```

On Windows that command is `apksigner.bat`; a bare `apksigner` does not exist
there. The certificate digest is the part that matters and it does not change
between releases — an APK signed with any other key did not come from this
project, whoever handed it to you.

File hashes do change every release. For 0.1.5:

```
d0d6f85d74876071df48e534bc0eb50a4f195fb1e6e67efc7eb644f511175a50  facet-0.1.5-universal-release.apk
0572ee15149a4e4f8e2ef212f79bc3f9ef86ae2ff2847764751652e725fd6308  Facet_0.1.5_x64-setup.exe
```

Both are published as
[`SHA256SUMS.txt`](https://github.com/IRAS-LABS/facet/releases/latest/download/SHA256SUMS.txt)
on the release, so `sha256sum -c SHA256SUMS.txt` checks them together.

### Upgrading

An APK you built yourself is signed with a different key than the release, so
Android refuses to install either one over the other
(`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). Uninstall first:

```
adb uninstall com.iraslabs.facet
```

Uninstalling clears app storage, so export your settings beforehand if you want
to keep them. Release-to-release upgrades install straight over the top and
keep everything.

## Everything it does

Every item below is implemented and exercised by the test harnesses in this
repository. `SCOPE.md` is the same list with the design notes and the reasoning
behind each decision, and it is where anything unfinished is marked as such.
Two things are: automatic face blur is written and asserted but has never been
run against a real photograph, and Android home-screen widgets are not started.

### Browsing

- **Spatial canvas** — cursor-anchored zoom, pinch, pan, with grid culling, DOM
  recycling and four detail tiers keyed off how wide a card is on screen.
- **File explorer** — navigation, selection, sorting, hidden-file filtering,
  drive roots and home places.
- **Layout presets** — grid, list, columns and gallery, remembered per folder.
- **Command palette** — rebuilt every time it opens, so entries match the folder
  and selection you actually have.
- **Universal quick-look** — Space on anything. Text pane or hex dump for
  whatever the webview cannot decode.
- **Previews for everything** — text and code, PDF first page, Office documents
  shown as their own opening words, archives, RAW via the embedded JPEG, HEIC,
  video frames, album art, folder collages, folder content listings.
- **Recycle-bin semantics** — deleting moves into a `.facet-trash` folder;
  "Empty trash" hands files to the OS Recycle Bin on Windows.
- **Share** — the OS share sheet on both platforms, plus Ctrl+C putting the
  files themselves on the Windows clipboard (`CF_HDROP`, paste-as-copy), and
  drag-out to other apps on desktop.

### Photos

- **Photo viewer** — full-resolution canvas, CSS-scaled, so what you preview and
  what you export run the same code.
- **Photo editor** — crop, rotate, tone and colour, with undo/redo over a list
  of regions rather than pixels. Saves a copy; the original is never touched.
- **Blur and redaction** — 8 blur kinds × 7 placements, layered, each region with
  its own invert, feather, opacity and tint.
- **Automatic blur** — faces, licence plates and screens found by ONNX models
  running on-device (YuNet, a YOLOv9 plate detector, YOLOX-Nano), on stills and
  video, runnable over a whole selection at once. Asserted against fixtures
  only; it has not yet had a pass against a real photograph.
- **Signatures** — draw or place one on a document.
- **Metadata viewer** — every tag, grouped and named, GPS called out on its own,
  and a plain-words banner saying what the file gives away. JPEG, TIFF and
  TIFF-based RAW, PNG, WebP. Reads the Samsung motion-photo trailer that no
  other viewer shows. Coordinates copy to the clipboard and never open a map.
- **Metadata remover** — writes `<name>-clean` beside the original, or cleans in
  place after a confirm. Works across a selection, and no re-encode: the
  entropy-coded scan comes out byte-identical.

### Video

- **Player** — J/K/L, 14 speed stops, A/B loop, layered scrubber.
- **Editor** — trim, split, cut a middle out, join, crop by dragging on the
  picture, rotate, mirror, speed, fade, mute, quality. The model is a list of
  spans to *keep*, so undo is a stack of span lists and the source file is never
  touched.
- **Honest lossless** — a single trim with nothing else asked for runs `-c copy`
  and is byte-identical, and the button says so. Anything that forces a decode
  changes the label before you commit.
- **Frame-exact cutting** — a checkbox, not a hidden default, because cutting on
  the exact frame instead of the nearest keyframe costs a full re-encode.
- **Speed** — 1/16× to 16× in the player; export at ten stops from 0.25× to 60×,
  with pitch-corrected audio up to 4×.
- **Face blur over video**, from the same detectors as stills.
- **Staged output** — exports write `<name>.facet-part` and rename only on
  success, so a cancelled or crashed export never leaves a half-file wearing a
  real name.

### Audio

- **Player** — waveform drawn from a peak scan done in Rust, so a two-hour
  meeting recording opens as fast as a song.
- **Editor** — trim, split, cut a middle out, join, gain in dB, EBU R128
  normalise, fades, speed, mono fold. Same span model as the video editor, so
  trimming means the same thing in both.
- **Export** — MP3, M4A, Opus, FLAC or WAV at a chosen bitrate.
- **Noise filtering** — four calibrated presets (Room tone, Traffic, Voice,
  Strong) that strip traffic, honking and room tone, applied before the
  normaliser so it measures the cleaned signal.
- **Cut parts stay drawn**, dimmed, because putting a bit back is the second
  thing anyone does.

### 3D

- **Viewer** — glTF, GLB, OBJ, STL and PLY, with orbit, materials and wireframe.
  Format is read from the bytes, never the extension.
- **Editor** — move, turn, size, and a material override (colour, roughness,
  metalness, flat shading, opacity), with 60 undo steps.
- **Export a copy** — GLB, glTF, OBJ, STL or PLY, with the on-screen up-axis
  correction deliberately kept *out* of the written file.

### Documents and data

- **Tabular viewer** — CSV, TSV, XLSX and Parquet, virtualised, sortable and
  filterable. Sorting and filtering make a real streaming pass over the whole
  file with a progress bar and a cancel, so the answer is about the file and not
  about the visible rows.
- **Hex and binary inspector** — 64 KB windows as you scroll, so a 4 GB file
  opens instantly. Structure trees for JPEG, PNG, GIF, RIFF/WebP/WAV, MP4/HEIC,
  ZIP, gzip, PE, ELF and PDF, colour-matched into the dump; every integer width
  in both byte orders at the cursor; streaming search over hex or a string.
- **OCR** — searchable text out of scans and photos, via Tesseract bundled into
  the app. Column and reading-order analysis, per-word confidence, click or
  marquee selection off the picture, and export as a searchable PDF.

### Speech

- **Transcription** — words with timestamps, who said what, a searchable
  transcript that plays from any line, editable speaker names, and a `.txt`
  written beside the recording. Whisper, pyannote segmentation and a wespeaker
  embedding model, all running in the app — no audio leaves the machine, no
  account, no key. WebGPU when the machine has it, WASM when it does not, and
  the panel says which before you start.
- **Speaker clustering by voice**, not by time, so somebody silent for ten
  minutes is still recognised when they speak again.
- **Subtitles** — generate, edit, burn in, or export as a `.srt`/`.vtt` sidecar.
  Reads both SubRip and WebVTT. Balanced line wrapping, and the invariant that
  every word said appears once, in order, while it is being said.

### Capture

- **Camera** — every camera the machine has in one picker, resolution picker,
  JPEG/PNG/WebP with a quality slider, self timer, grid overlays (thirds,
  golden, centre, square), mirror, and a clip recorder with a running clock.
- **Looks** — eight built in (Natural, Vivid, Warm, Cool, Mono, Noir, Faded,
  Negative) plus eight live sliders, and any combination can be named and kept.
  Stills are taken at sensor resolution, not preview size; clips are recorded
  off the canvas, so the look reaches the file.
- **Recorder** — screen, system sound and microphone in any combination, as a
  floating card that shrinks out of its own shot. Clock, live level meter with
  falling peak hold, pause/resume, countdown, quality picker, and a size ledger
  with a bytes-per-second rate so a long meeting can be judged before it fills
  the disk. Takes stream to disk as they record.

### Automation

- **Batch queue** — any operation over a selection, with progress, resumable
  across a restart because a task is a serialisable description rather than a
  closure. One failure never stops the run.
- **Watch folders** — per-folder rules that fire on new files: convert, strip
  EXIF, move, rename. A file fires only once its size is unchanged across two
  sweeps, so a still-copying 4 GB video is never handed to ffmpeg half-written.
  Two independent loop guards, and the move never deletes and never overwrites.

### Making it yours

- **11 themes** on a 23-token contract, plus user themes as a base and a patch.
- **Settings** — one searchable surface, everything live, nothing needing a
  restart. Only non-default values are stored, so defaults can still improve.
- **Fully rebindable keyboard map.**
- **Column and card configuration** — choose what a card and a row show.
- **Saved sort and filter rules**, per folder.
- **User-defined sidebar and places**, reorderable.
- **Context menu builder** — your own actions.
- **File associations** — what Facet opens with what, internally.
- **Startup and session** — what opens on launch, restore last session.
- **Import/export settings** as one portable file.
- **Performance controls** — cache sizes, preview budgets, decode lanes.
- **Persistent undo** that survives a restart, and **crash recovery** that
  reopens where it died with unsaved edits offered back, never silently applied.

### Android

The Android app is its own build of the same codebase with a phone-shaped
interface — it is not a remote control for the desktop.

- **Photos roll** — virtualised, day-grouped over the whole card, opening onto
  14,000 files in well under a second.
- **Albums, favourites, search and a files tab.**
- **Photo and video editing on the phone**, including the blur and redaction
  tools, automatic face/plate/screen blur, metadata viewing and removal.
- **Trash sheet**, audio dock, and the OS share sheet.

## File formats

Every extension Facet recognises, and what it actually does with each. Anything
not listed still appears in the file list, previews as text if it turns out to
be textual, and opens in the hex inspector or in whatever your OS uses.

Two things are worth knowing before reading the tables. Pictures and video are
decoded by the system webview, so that column is a platform capability, not a
bundled codec. Editing video and audio is FFmpeg, which is inside the APK on
Android but has to be on your `PATH` on the desktop.

### Pictures

| | |
| --- | --- |
| **View, edit, redact, export** | `jpg` `jpeg` `jpe` `jfif` `png` `apng` `gif` `webp` `avif` `avifs` `bmp` `ico` `svg` |
| **View, metadata, EXIF removal** | `heic` `heif` `heics` — decoded in-app |
| **RAW — view, metadata, EXIF removal** | `dng` `cr2` `nef` `arw` `raf` `orf` `rw2` `srw` `pef` `3fr` |
| **Recognised, no decoder** | `jxl` `cr3` `tif` `tiff` `psd` `ai` |

RAW files are shown from the full-size JPEG the camera already embedded for its
own screen, rather than by demosaicing the sensor data. It is the picture the
photographer saw, it costs a read instead of a decode, and it is why a folder
of raws scrolls at the same speed as a folder of JPEGs.

### Video

| | |
| --- | --- |
| **Play, trim, speed, blur, re-encode** | `mp4` `mkv` `mov` `webm` `avi` `m4v` `wmv` `flv` `f4v` `mts` `m2ts` `3gp` `3g2` `mpg` `mpeg` `m2v` `ogv` `vob` `divx` `insv` |
| **Thumbnail from a decoded frame** | `mp4` `webm` `m4v` `mov` `ogv` — the rest show the kind glyph until opened |

### Audio

`mp3` `wav` `flac` `aac` `ogg` `opus` `m4a` `wma` `aiff` `alac` `amr` `mid` —
play, trim, gain, noise and voice filtering, transcription, cover art.

### 3D

| | |
| --- | --- |
| **Orbit, inspect, export** | `glb` `gltf` `obj` `stl` `ply` |
| **Recognised, refused with a reason** | `fbx` `blend` `usd` `usdz` `dae` `3mf` |

The second row is deliberate rather than unfinished: `.blend` is a Blender
session and not a mesh, FBX is Autodesk's format, and USD needs a runtime
larger than the rest of Facet put together. Facet says which one applies
instead of showing an empty scene.

### Tables and data

| | |
| --- | --- |
| **Table view — sortable, virtualised** | `csv` `tsv` `tab` `xlsx` `xlsm` `parquet` `pq` |
| **Classified as data, previewed as text** | `json` `jsonl` `ndjson` |
| **Classified as data, handed to the OS** | `xls` `ods` `db` `sqlite` `duckdb` |

Parquet is read one row group at a time off the footer, so a multi-gigabyte
file opens as fast as a small one.

### Documents

`pdf` `docx` `doc` `odt` `rtf` `txt` `md` `epub` `pptx` `ppt`

PDFs render their first page as the preview and can be OCR'd. Office files are
zips, so a document with no saved thumbnail still previews as its own opening
words. Opening a document for real hands it to your OS — Facet is not a word
processor.

### Archives

`zip` `7z` `rar` `tar` `gz` `bz2` `xz` `zst` `iso`

Zip-family containers list their contents in the preview panel without being
extracted: `zip` `docx` `xlsx` `pptx` `odt` `ods` `odp` `epub` `apk` `jar`
`ipa` `vsix`. The rest are recognised and handed to your OS.

### Subtitles

`srt` and `vtt` are parsed and written — transcription and burn-in both target
them. `ass` previews as text but is not parsed.

### Text and code

Previewed as their own first lines, syntax-agnostic:

`txt` `md` `markdown` `rst` `log` `csv` `tsv` `json` `jsonl` `ndjson` `xml`
`yaml` `yml` `toml` `ini` `cfg` `conf` `env` `properties` `ts` `tsx` `js` `jsx`
`mjs` `cjs` `rs` `py` `rb` `go` `java` `kt` `kts` `c` `h` `cpp` `hpp` `cc` `cs`
`swift` `php` `sh` `bash` `zsh` `ps1` `psm1` `bat` `cmd` `sql` `css` `scss`
`less` `html` `htm` `vue` `svelte` `lua` `r` `m` `pl` `diff` `patch`
`gitignore` `dockerfile` `makefile` `gradle` `srt` `vtt` `ass` `cube` `obj`
`mtl` `ply` `gcode`

A file with no extension, or one Facet has never heard of, gets one cheap read
to decide whether it is text before falling back to the hex inspector.

### Byte-level structure trees

The inspector maps regions rather than just dumping bytes for `jpeg`, `png`,
`gif`, `riff` (WebP and WAV), and ISO-BMFF (`mp4`, `mov`, `m4a`, `heic`).

### Anything else

Every file, of every type, can be renamed, moved, batch-processed, opened in
the hex inspector, inspected for metadata, and handed to the default
application. Nothing is hidden because Facet does not understand
it.

## Build from source

### What you need

These are the versions this was last built and tested with. Nearby versions
should be fine; these are the ones that are known to work.

| | tested with |
| --- | --- |
| Node | 24.18.0 (npm 12) |
| Rust | 1.96.1 |
| Python | 3.12 (invoked as `py` on Windows) |
| ffmpeg / ffprobe on `PATH` | 8.1.2 (Gyan full build) — desktop only |
| JDK | 17 (Temurin) — Android only |
| Android SDK / NDK | compileSdk 36, NDK 27.2.12479018 — Android only |

### Desktop (Windows)

```powershell
npm install
py scripts/fetch-models.py     # ~12 MB of ONNX detectors, sha256-pinned
npx tauri build
```

The installer lands in
`src-tauri/target/release/bundle/nsis/Facet_<version>_x64-setup.exe`, and the
bare executable beside it in `src-tauri/target/release/facet.exe`.

For development instead: `npx tauri dev` runs the app against a live frontend,
and `npm run dev` serves the frontend alone on `http://127.0.0.1:8183`.

`ffmpeg` and `ffprobe` must be on `PATH` — the desktop build execs whatever is
there rather than bundling its own. Video editing, audio editing, noise
filtering, subtitle burn-in and recording all go through them. Note that the
Gyan full build has no HEIF muxer, so it cannot *write* HEIC.

### Android

```powershell
npm install
py scripts/fetch-models.py
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17..."
npx tauri android build --apk --target aarch64
```

The APK lands in
`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk`.

`scripts/build-apk.ps1 -Release` does the same thing and is the better choice on
Windows: it works around the Tauri CLI's symlink step, which needs
`SeCreateSymbolicLinkPrivilege` and fails on an ordinary account with Developer
Mode off — after a completely successful compile, which is what makes it
confusing. It also strips build paths out of the binary (see below). With
Developer Mode on, either command works.

#### FFmpeg for Android

Android has no system ffmpeg, so the app execs binaries it carries itself, from
`src-tauri/android-binaries/<abi>/libffmpeg.so` and `libffprobe.so`. **They are
not in this repository** — they are GPL, and a repository that ships them stops
being an MIT repository.

The APK builds and installs without them (26 MB instead of 49 MB); video
editing, audio editing, noise filtering, subtitle burn-in and format conversion
then fail at runtime. Everything else works.

To get them, cross-compile FFmpeg for `aarch64-linux-android` with the NDK and
copy the two static executables in, renamed to `libffmpeg.so` and
`libffprobe.so` — the `.so` name is what lets Android place them in the native
library directory, the only place under an app's private storage that Android 10
and later still permits execution from. This is the exact configuration the
binaries in the published release were built with, FFmpeg 7.1.1 against NDK
r27c:

```
--target-os=android --arch=aarch64 --cpu=armv8-a --enable-cross-compile
--cc=<ndk>/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang
--enable-static --disable-shared --enable-pic
--enable-gpl --enable-libx264 --enable-libmp3lame --enable-libopus
--enable-libvorbis --enable-libass --enable-pthreads --enable-neon
--disable-doc --disable-debug --disable-symver --disable-vulkan
--disable-v4l2-m2m --disable-vaapi --disable-vdpau --disable-xlib
--disable-sdl2 --disable-libxcb --disable-indev=android_camera
```

Dropping `--enable-gpl --enable-libx264` gives an LGPL build and avoids the GPL
obligation, at the cost of H.264 encoding.

### Signing

Release APKs come out unsigned. Sign them with your own key:

```powershell
zipalign -f -p 4 app-universal-release-unsigned.apk facet.apk
apksigner sign --ks my-release.jks facet.apk
apksigner verify -v facet.apk
```

On Windows the command is `apksigner.bat`; a bare `apksigner` does not exist
there. Never publish an APK signed with the Android debug key — that key is on
every developer's machine, so anyone could forge an update to your app.

### Before you hand a binary to anyone

A Rust binary records, for every possible panic, the source file it came from --
as an absolute path on the machine that built it. `strip` does not remove them;
they are string data, not symbols. So a release build made with no precautions
tells whoever runs `strings` on it your account name and how your disk is laid
out. (Cargo's `trim-paths` profile key is meant for this and is not stable as of
1.96, so the fix goes through `RUSTFLAGS`.) `scripts/build-apk.ps1` already does
this. For a desktop release, do the same first:

```powershell
$env:RUSTFLAGS = "--remap-path-prefix=$env:USERPROFILE\.cargo=/cargo " +
                 "--remap-path-prefix=$PWD=/facet"
npx tauri build
```

Check the result before publishing it -- `strings` on the binary, grep for your
username, expect nothing.

FFmpeg has the same problem for a different reason: it bakes its entire
`./configure` line into the library and prints it on `-version`, build paths and
all. Either configure it from a neutral prefix, or check the shipped `.so`
afterwards the same way.

## Dev harness pages

The `dev/*check.html` pages are self-contained test harnesses for individual
subsystems, served by `npm run dev`. Open
[`http://localhost:8183/dev/allcheck.html`](http://localhost:8183/dev/allcheck.html)
to run them all in sequence. They are dev-server only: the build's single
input is `index.html`, so nothing in `dev/` reaches a release artifact.

Some of them read real photographs and spreadsheets over HTTP, because a
decoder tested only on bytes it generated itself proves nothing but its own
self-consistency. Those files are **not** in the repository — they would be
somebody's actual photographs — so `scripts/fixtures.ps1` stages them from a
folder you point `FACET_FIXTURE_SRC` at. Run it with no arguments and it
lists exactly which files it wants. A harness whose fixture is missing says
so and names the script; nothing fails silently, and nothing else in the
repository depends on them.

## Android permissions, and why

The APK declares these. Android prompts for the sensitive ones rather than
granting them silently, and refusing a prompt disables that feature instead of
breaking the app.

| Permission | Why |
| --- | --- |
| `MANAGE_EXTERNAL_STORAGE` | **All-files access.** Facet is a file manager, so it browses and edits across the whole card, not the sandbox folder Android would otherwise hand it. This is the broadest storage permission Android has, and it is worth refusing in any app that cannot justify it. Refuse it here and the photos, albums and audio tabs still work through the media permissions below — the files tab does not. |
| `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `READ_MEDIA_AUDIO` | the photos roll, albums and the audio dock, on Android 13 and newer |
| `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE` | the same thing on Android 12 and older, where the per-type media permissions do not exist |
| `CAMERA` | the in-app capture screen, and nothing else |
| `RECORD_AUDIO` | voice recording and live transcription |
| `MODIFY_AUDIO_SETTINGS` | audio routing while recording and during playback |
| `INTERNET` | the **loopback** server that hands video to the app's own player, and the first-run model downloads for Transcribe and OCR |

`INTERNET` is the one to be suspicious of in an app that claims to be offline,
so here is the whole of it. Android's video player takes a URL, so Facet serves
the file to itself over `127.0.0.1` — that is what the permission is mostly
for. Beyond that there are exactly two remote hosts, both of them model
registries, both of them reached only when you use the feature that needs one:

| host | what for | when |
|---|---|---|
| `huggingface.co` | the Whisper speech model, and the two speaker models if speaker labelling is on | first time you transcribe at a given quality |
| `cdn.jsdelivr.net` | Tesseract `.traineddata` for one language | first time you OCR in that language |

Nothing is sent to either one but the request for the file. Your audio and your
pictures stay on the device — the model comes to them.

Check all of that the way you would check any such claim: watch its traffic, or
grep the source for a hostname. Those two are what you will find.

One thing that claim does *not* cover on its own, and which a packet capture
would have caught us on: the Android System WebView runs inside this process,
so anything **it** fetches is billed to Facet's UID. Two of its defaults go to
Google without the app asking — Safe Browsing, which pulls a URL list and
checks navigations, and the WebView metrics client, which uploads usage stats.
Both are switched off in the manifest (`EnableSafeBrowsing` false,
`MetricsOptOut` true), because “no remote endpoint in the app” is worth
nothing if the frame it draws in is talking to someone.

Camera and microphone are declared `required="false"`, so Facet installs on
hardware that lacks them and hides those features instead of refusing to run.

## Contributing

`CONTRIBUTING.md` covers how to run the harnesses and what a change is expected
to come with. `SCOPE.md` is the design record — if you want to know *why*
something works the way it does before changing it, that is where the reasoning
is written down.

## Security

See `SECURITY.md` for the trust model and how to report a problem.

## License

MIT — see `LICENSE`. Third-party components and their licenses are listed
in `THIRD-PARTY-NOTICES.md`.

One thing worth reading before you redistribute a build: the Android FFmpeg
binaries are GPL. They are not in this repository, so the source is MIT and
stays MIT — but an APK you ship with those binaries inside it carries the
GPL's terms, not the MIT license's.
