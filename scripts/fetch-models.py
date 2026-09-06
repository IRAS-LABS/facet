#!/usr/bin/env python3
"""Download the auto-blur detection models into public/models and verify them.

Run with `py scripts/fetch-models.py` from the repo root. Every file is
pinned by URL *and* sha256, so a re-run is a no-op when the files match and a
loud failure when upstream changes something. Licences are fetched alongside
so the attribution ships with the binary.

Total on disk (2026-09-05): ~11.7 MB.

| file             | what                                  | source                                                     | licence     | bytes     |
| yolox-nano.onnx  | COCO detector (tv/laptop/cell phone…)  | Megvii YOLOX release 0.1.1rc0                              | Apache-2.0  | 3,659,407 |
| plates.onnx      | licence-plate detector, YOLOv9-t 384  | ankandrew/open-image-models (end2end = NMS inside)         | MIT         | 7,771,218 |
| yunet.onnx       | face detector, YuNet 2023mar 640x640  | opencv/opencv_zoo face_detection_yunet                     | MIT         |   232,589 |
"""
from __future__ import annotations
import hashlib, pathlib, sys, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "models"

FILES = [
    ("yolox-nano.onnx",
     "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx",
     "c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d"),
    ("LICENSE-yolox.txt",
     "https://raw.githubusercontent.com/Megvii-BaseDetection/YOLOX/main/LICENSE",
     None),
    ("plates.onnx",
     "https://github.com/ankandrew/open-image-models/releases/download/assets/yolo-v9-t-384-license-plates-end2end.onnx",
     "888397b96d761c89db40bc9c305838e8652660f5e282c2cadebbe8d2951a77a8"),
    ("LICENSE-plates.txt",
     "https://raw.githubusercontent.com/ankandrew/open-image-models/main/LICENSE",
     None),
    ("yunet.onnx",
     "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
     "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"),
    ("LICENSE-yunet.txt",
     "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/LICENSE",
     None),
]

def sha256(p: pathlib.Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    bad = 0
    total = 0
    for name, url, want in FILES:
        dst = OUT / name
        if dst.exists() and (want is None or sha256(dst) == want):
            print(f"ok       {name}  {dst.stat().st_size:>10,} B")
        else:
            print(f"fetch    {name}  <- {url}")
            req = urllib.request.Request(url, headers={"User-Agent": "facet-fetch-models/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r, dst.open("wb") as f:
                f.write(r.read())
            got = sha256(dst)
            if want is not None and got != want:
                print(f"MISMATCH {name}: expected {want} got {got}")
                bad += 1
                continue
            print(f"done     {name}  {dst.stat().st_size:>10,} B  sha256 {got}")
        total += dst.stat().st_size
    print(f"total {total:,} B in {OUT}")
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main())
