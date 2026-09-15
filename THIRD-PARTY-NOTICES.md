# Third-party notices

## Bundled models (`public/models/`, fetched by `scripts/fetch-models.py`)

| Model | Use | License |
| --- | --- | --- |
| YOLOX-Nano (Megvii) | screens / objects for auto-blur | Apache-2.0 (`LICENSE-yolox.txt`) |
| Licence-plate detector (ankandrew) | plates for auto-blur | MIT (`LICENSE-plates.txt`) |
| YuNet (Shiqi Yu) | faces for auto-blur | MIT (`LICENSE-yunet.txt`) |

`src/core/vision/lbpcascade_frontalface_improved.xml` is the OpenCV LBP cascade
(KU Leuven, BSD-style license; header kept intact).

## Bundled OCR data (`public/tessdata/`, fetched by the same script)

| Data | Use | License |
| --- | --- | --- |
| `eng.traineddata` (tesseract-ocr/tessdata_fast) | English OCR | Apache-2.0 (`LICENSE-tessdata.txt`) |

It is bundled rather than fetched at runtime, so OCR works with the network
off and nothing about the page being read leaves the device.

## Bundled pronunciation dictionary (`public/voice/`)

| Data | Use | License |
| --- | --- | --- |
| `cmudict-ipa.txt.gz` (CMU Pronouncing Dictionary, converted to IPA) | read-aloud pronunciation | BSD-2-Clause (`LICENSE-cmudict.txt`) |

126,052 words, 812 kB compressed, vendored in the repository rather than
fetched, for the same reason as the OCR data. It is the fallback path now that
espeak-ng does the English — it still carries the non-English voices and any
machine where the WebAssembly will not load.

Worth recording plainly: this file was on the ship list of no build until
2026-09-14. Every released installer and APK before that date shipped without
it, the app's fetch for it 404'd, the failure was swallowed by design, and
read-aloud guessed every word by letter-to-sound rule.

## Read-aloud speech model (downloaded on request, not bundled)

| Model | Use | License |
| --- | --- | --- |
| Kokoro-82M v1.0 ONNX (`onnx-community/Kokoro-82M-v1.0-ONNX`) | the natural read-aloud voices | Apache-2.0 |

Not in the repository and not in any build. It is an 88 MB download from
`huggingface.co` that happens only when somebody presses the button that says
so, plus 523 kB for each of the 54 voices they choose. Nothing is sent with the
request but the request. Without it read-aloud uses the operating system's own
voices, which need no download at all.

## 3D decoders (`public/decoders/`)

Copied unmodified from `node_modules/three/examples/jsm/libs/`, not fetched at
runtime, for the same offline reason as the OCR data. The 3D viewer loads
them only when a glTF file actually uses the compression they decode.

| Files | Use | License |
| --- | --- | --- |
| `draco/draco_wasm_wrapper.js`, `draco/draco_decoder.wasm` (Google Draco) | Draco-compressed glTF meshes | Apache-2.0 |
| `basis/basis_transcoder.js`, `basis/basis_transcoder.wasm` (Binomial Basis Universal) | KTX2 / Basis textures | Apache-2.0 |

The meshoptimizer decoder (Arseny Kapoulkine, MIT) is not a separate file: it is
bundled into the app from `three/examples/jsm/libs/meshopt_decoder.module.js`.

## FFmpeg

FACET runs FFmpeg as a separate program (it is never linked into FACET), so
FACET itself stays MIT-licensed. The FFmpeg binaries shipped alongside it are
GPL builds, because video export encodes H.264 with libx264.

**Source for the shipped builds.** FFmpeg source: <https://ffmpeg.org/download.html>
(git: <https://git.ffmpeg.org/ffmpeg.git>). If you received a FACET build and
want the exact FFmpeg source and build configuration for the binaries in it,
open an issue on this repository and it will be provided, as the GPL requires.

### Android

The Android app execs `ffmpeg` / `ffprobe` binaries placed in
`src-tauri/android-binaries/<abi>/libffmpeg.so` and `libffprobe.so`. They are
not in this repository. The builds used so far were FFmpeg 7.1.1 configured
with `--enable-gpl --enable-libx264 --enable-libmp3lame --enable-libopus
--enable-libvorbis --enable-libass`, which makes those binaries GPL-2.0-or-later.
If you redistribute an APK containing such binaries you must comply with the
GPL for them (offer the corresponding source and build configuration). An
LGPL-only build (drop `--enable-gpl` and `--enable-libx264`) avoids that
obligation at the cost of H.264 encoding.

### Windows

The Windows installer built by `scripts/build-desktop.ps1` puts `ffmpeg.exe`,
`ffprobe.exe` and their DLLs in `<install dir>\ffmpeg\`. They are the unmodified
win64 `gpl-shared` build of FFmpeg 8.1 from
<https://github.com/BtbN/FFmpeg-Builds> (build scripts and configuration are
published there), GPL-3.0-or-later. They are not in this repository. The folder
also holds FFmpeg's `LICENSE-ffmpeg.txt` and a `BUILD-INFO.txt` recording the
exact archive URL, its SHA-256 and `ffmpeg -version`. Build with `-NoFfmpeg` to
leave them out.

When that folder is missing (a plain `tauri build`, or `cargo run`), `ffmpeg` /
`ffprobe` are taken from `PATH`.

## npm dependencies

| Package | License |
| --- | --- |
| @tauri-apps/api, @tauri-apps/cli | MIT / Apache-2.0 |
| @crabnebula/tauri-plugin-drag | MIT / Apache-2.0 |
| @huggingface/transformers | Apache-2.0 |
| onnxruntime-web | MIT |
| tesseract.js | Apache-2.0 |
| pdf-lib | MIT |
| pdfjs-dist | Apache-2.0 |
| three | MIT |
| libheif-js | LGPL-3.0 (used unmodified, dynamically loaded) |
| phonemizer | **GPL-3.0** — see below; the npm metadata says Apache-2.0 and is wrong |

## espeak-ng, and what it does to the license of a built app

Read-aloud turns text into phonemes before the voice model sees it, and the
thing that does that is espeak-ng, compiled to WebAssembly and distributed on
npm as `phonemizer`.

**That package's metadata declares Apache-2.0. Its `LICENSE` file is the Apache
2.0 text. Both are wrong about what is inside it:** the bundle is espeak-ng
compiled by Emscripten, and espeak-ng is **GPL-3.0-or-later**. A registry field
does not relicense somebody else's code, so the obligation is the GPL's
regardless of what npm shows.

This is not the same situation as FFmpeg. FFmpeg is *run* as a separate
program, which is why FACET itself stays MIT despite shipping GPL FFmpeg
binaries beside it. espeak-ng is **compiled into the frontend bundle** and
loaded into the same process. A built FACET — the Windows installer, the APK —
is therefore a combined work and is distributed under the **GPL-3.0**, not the
MIT license.

What that means in practice:

- **This repository stays MIT.** FACET's own source is MIT, which is
  GPL-compatible, and espeak-ng is not in the repository — it arrives from npm
  at `npm install` time.
- **A binary you distribute is GPL-3.0.** If you hand someone a built FACET you
  owe them the corresponding source of the whole combined work under GPL-3.0.
  That is satisfied by this repository plus `package-lock.json`, which pins the
  exact `phonemizer` version, and by the source offer below.
- **Source for espeak-ng:** <https://github.com/espeak-ng/espeak-ng>. Source for
  the WebAssembly build: <https://github.com/diffusionstudio/phonemizer>. If you
  received a FACET build and want the exact corresponding source, open an issue
  on this repository and it will be provided, as the GPL requires.
- **App stores are a separate question.** GPL-3.0 and the major app stores'
  terms are a long-running argument that this project does not need to have.
  FACET is distributed as a GitHub release, where it does not arise.

To build without any of this, delete the `phonemizer` dependency. Read-aloud
falls back to the bundled CMUdict and its letter-to-sound rules automatically —
it keeps working and it sounds noticeably worse, which is the trade that was
made here deliberately.

## Rust crates

tauri, serde, serde_json, wry, jni, trash, windows / windows-collections,
tauri-plugin-drag, tauri-plugin-single-instance — all MIT and/or Apache-2.0. Run `cargo license` in
`src-tauri/` for the full transitive list.
