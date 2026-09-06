# Third-party notices

## Bundled models (`public/models/`, fetched by `scripts/fetch-models.py`)

| Model | Use | License |
| --- | --- | --- |
| YOLOX-Nano (Megvii) | screens / objects for auto-blur | Apache-2.0 (`LICENSE-yolox.txt`) |
| Licence-plate detector (ankandrew) | plates for auto-blur | MIT (`LICENSE-plates.txt`) |
| YuNet (Shiqi Yu) | faces for auto-blur | MIT (`LICENSE-yunet.txt`) |

`src/core/vision/lbpcascade_frontalface_improved.xml` is the OpenCV LBP cascade
(KU Leuven, BSD-style license; header kept intact).

## FFmpeg (Android)

The Android app execs `ffmpeg` / `ffprobe` binaries placed in
`src-tauri/android-binaries/<abi>/libffmpeg.so` and `libffprobe.so`. They are
not in this repository. The builds used so far were FFmpeg 7.1.1 configured
with `--enable-gpl --enable-libx264 --enable-libmp3lame --enable-libopus
--enable-libvorbis --enable-libass`, which makes those binaries GPL-2.0-or-later.
If you redistribute an APK containing such binaries you must comply with the
GPL for them (offer the corresponding source and build configuration). An
LGPL-only build (drop `--enable-gpl` and `--enable-libx264`) avoids that
obligation at the cost of H.264 encoding.

On desktop, `ffmpeg` / `ffprobe` are taken from `PATH`.

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

## Rust crates

tauri, serde, serde_json, wry, jni, trash, windows / windows-collections,
tauri-plugin-drag — all MIT and/or Apache-2.0. Run `cargo license` in
`src-tauri/` for the full transitive list.
