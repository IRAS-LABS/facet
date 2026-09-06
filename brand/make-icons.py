"""
FACET icon generator.

Renders every raster asset the desktop app and the APK need, from the same
polygon geometry as brand/facet-icon.svg. Pure Pillow, no SVG rasterizer, no
new dependency.

    py make-icons.py

Everything lands in brand/out/. Re-run after any colour or geometry change --
it is idempotent and overwrites in place.

The mark is option D from brand/make-options.py: the letter F cut out of dark
metal with a red bevel down its lit edges. Black, dark, a little red.
"""

from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).parent / "out"

# ---------------------------------------------------------------- geometry --
# Reference frame is 512x512, matching brand/facet-icon.svg. The mark is not
# authored centred -- it is centred by `_bbox` at render time, so the numbers
# below can stay readable as a letterform instead of being pre-compensated.
REF = 512

# The letter, as one closed outline: up the stem, along the top bar, down the
# angled cut, back in to the stem.
BODY = [(175, 86), (400, 86), (368, 164), (247, 164), (247, 426), (175, 426)]

# The middle arm, with the same cut angle as the top bar so the two agree.
ARM = [(247, 232), (352, 232), (322, 296), (247, 296)]

# Where the light lands. Two strokes only: the left edge of the stem and the
# angled cut. A bevel on every edge is a border, and a border is not a cut.
BEVEL_STEM = [(175, 86), (190, 86), (190, 426), (175, 426)]
BEVEL_CUT = [(400, 86), (368, 164), (383, 164), (415, 86)]

SOLIDS = [BODY, ARM]
ACCENTS = [BEVEL_STEM, BEVEL_CUT]

BG = (8, 9, 12, 255)          # #08090c -- the black it sits on
RED = (214, 40, 46)           # #d6282e
RED_HOT = (255, 92, 74)

# The letter's own colour, at the two ends of the size range. Dark charcoal is
# the approved look and it is what ships at 128px and up; below that it turns to
# mush against a black plate, so small icons lighten toward slate. Size-aware
# fills are ordinary icon practice -- Windows' own system icons do it -- and the
# alternative is a taskbar button you cannot find.
BODY_BIG = (44, 47, 57)
BODY_SMALL = (104, 110, 128)

CORNER = 112 / REF            # rounded-rect radius as a fraction of the side

# Fraction of the plate the mark spans, and the tighter figure used when the
# plate is a circle -- a letterform inscribed in a circle needs the corners.
FILL_SQUARE = 0.66
FILL_ROUND = 0.56


def _bbox(polys):
    xs = [p[0] for poly in polys for p in poly]
    ys = [p[1] for poly in polys for p in poly]
    return min(xs), min(ys), max(xs), max(ys)


MARK_BOX = _bbox(SOLIDS + ACCENTS)
MARK_W = MARK_BOX[2] - MARK_BOX[0]
MARK_H = MARK_BOX[3] - MARK_BOX[1]
MARK_CX = (MARK_BOX[0] + MARK_BOX[2]) / 2
MARK_CY = (MARK_BOX[1] + MARK_BOX[3]) / 2


def body_colour(size):
    """Charcoal when there is room for it, slate when there is not."""
    if size >= 128:
        return BODY_BIG
    if size <= 32:
        return BODY_SMALL
    t = (size - 32) / (128 - 32)
    return tuple(round(BODY_SMALL[i] + (BODY_BIG[i] - BODY_SMALL[i]) * t) for i in range(3))


# ------------------------------------------------------------------ render --
def _supersample(size):
    """Keep the working bitmap under ~4k a side so large icons stay cheap."""
    return max(1, min(8, 4096 // max(size, 1)))


def render(size, mode):
    """
    mode:
      flat        rounded-rect plate + mark               (Windows, web, legacy)
      round       same, masked to a circle                (ic_launcher_round)
      adaptive    mark alone on transparency, inside Android's 66/108 safe zone
      mono        white silhouette, same framing          (themed icons)
      plate       background layer only, no mark          (adaptive background)
    """
    ss = _supersample(size)
    S = size * ss
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if mode in ("flat", "round", "plate"):
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=CORNER * S, fill=BG)

    if mode == "plate":
        return _finish(img, size, ss, mode)

    # How much of the plate the mark may occupy. Android's adaptive icons crop
    # to an unknown shape, so the mark stays inside the 66/108 safe zone there.
    if mode in ("adaptive", "mono"):
        span = S * 66 / 108
    elif mode == "round":
        span = S * FILL_ROUND
    else:
        span = S * FILL_SQUARE

    scale = span / max(MARK_W, MARK_H)

    def px(p):
        return ((p[0] - MARK_CX) * scale + S / 2,
                (p[1] - MARK_CY) * scale + S / 2)

    if mode == "mono":
        # One white silhouette: body, arm and bevels are the same shape once
        # colour is gone, and drawing them separately leaves seams.
        for poly in SOLIDS + ACCENTS:
            d.polygon([px(p) for p in poly], fill=(255, 255, 255, 255))
        return _finish(img, size, ss, mode)

    fill = body_colour(size) + (255,)
    for poly in SOLIDS:
        d.polygon([px(p) for p in poly], fill=fill)

    # The red goes on last so it sits on top of the letter rather than beside
    # it -- the bevel is meant to read as an edge of the same object.
    for poly in ACCENTS:
        d.polygon([px(p) for p in poly], fill=RED + (255,))

    # A hot pixel at the top of the stem, where the two lit edges would meet.
    # Skipped on small icons, where it is one indistinct bright dot.
    if size >= 64:
        top = [px(BEVEL_STEM[0]), px(BEVEL_STEM[1])]
        d.line([top[0], (top[1][0], top[1][1] + span * 0.06)],
               fill=RED_HOT + (255,), width=max(1, int(scale * 6)))

    return _finish(img, size, ss, mode)


def _finish(img, size, ss, mode):
    if mode == "round":
        S = img.size[0]
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, S - 1, S - 1], fill=255)
        img.putalpha(mask)
    if ss > 1:
        img = img.resize((size, size), Image.LANCZOS)
    return img


def save(img, *parts):
    p = OUT.joinpath(*parts)
    p.parent.mkdir(parents=True, exist_ok=True)
    img.save(p)
    return p


# ------------------------------------------------------------------ targets --
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}

written = []

# --- Windows / Tauri desktop ------------------------------------------------
for s in [16, 24, 32, 48, 64, 128, 256, 512, 1024]:
    written.append(save(render(s, "flat"), "windows", f"facet-{s}.png"))

# The .ico carries each size rendered at that size, not one bitmap downscaled --
# that is the whole point of the size-aware fill above, and Pillow's `sizes=`
# would throw it away by resampling a single 256 for every entry.
ico_frames = [render(s, "flat") for s in ICO_SIZES]
ico_frames[-1].save(OUT / "windows" / "facet.ico", append_images=ico_frames[:-1],
                    sizes=[(s, s) for s in ICO_SIZES])
written.append(OUT / "windows" / "facet.ico")

# Tauri looks for these exact filenames under src-tauri/icons/.
for s, name in [(32, "32x32.png"), (128, "128x128.png"),
                (256, "128x128@2x.png"), (512, "icon.png")]:
    written.append(save(render(s, "flat"), "tauri", name))
ico_frames[-1].save(OUT / "tauri" / "icon.ico", append_images=ico_frames[:-1],
                    sizes=[(s, s) for s in ICO_SIZES])
written.append(OUT / "tauri" / "icon.ico")

# --- Android ----------------------------------------------------------------
for name, mult in DENSITIES.items():
    adaptive = int(108 * mult)      # adaptive layers are always 108dp
    legacy = int(48 * mult)         # pre-Oreo launcher icons are 48dp
    folder = f"mipmap-{name}"
    written.append(save(render(adaptive, "adaptive"), "android", folder,
                        "ic_launcher_foreground.png"))
    written.append(save(render(adaptive, "plate"), "android", folder,
                        "ic_launcher_background.png"))
    written.append(save(render(adaptive, "mono"), "android", folder,
                        "ic_launcher_monochrome.png"))
    written.append(save(render(legacy, "flat"), "android", folder,
                        "ic_launcher.png"))
    written.append(save(render(legacy, "round"), "android", folder,
                        "ic_launcher_round.png"))

# Play Store listing art is a flat 512.
written.append(save(render(512, "flat"), "android", "play-store-512.png"))

# --- Web / PWA / favicon ----------------------------------------------------
for s in [192, 512]:
    written.append(save(render(s, "flat"), "web", f"icon-{s}.png"))
fav = [render(s, "flat") for s in (16, 32, 48)]
fav[-1].save(OUT / "web" / "favicon.ico", append_images=fav[:-1],
             sizes=[(16, 16), (32, 32), (48, 48)])
written.append(OUT / "web" / "favicon.ico")

total = sum(p.stat().st_size for p in written)
print(f"{len(written)} files, {total/1024:.1f} KB total -> {OUT}")
for p in written:
    print(f"  {p.relative_to(OUT)}  ({p.stat().st_size:,} B)")
