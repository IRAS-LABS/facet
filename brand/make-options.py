"""
FACET logo options -- dark, black, a little red.

Eight concepts, each rendered as a standalone 512px PNG plus one contact sheet
that shows every option beside a 48px copy of itself. The small copy is not
decoration: this icon has to survive on a taskbar, and a mark that only works at
512 is a mark that does not work.

    py make-options.py

Everything lands in brand/options/. Idempotent -- overwrites in place. Pure
Pillow, same as make-icons.py, no new dependency.
"""

from pathlib import Path
import math

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).parent / "options"
SIZE = 512
SS = 4  # supersample factor; every mark is drawn at 4x and shrunk down

# ------------------------------------------------------------------ palette --
INK = (8, 9, 12)          # the black everything sits on
COAL = (22, 24, 30)       # lit black
SLATE = (44, 47, 57)      # edge-lit black
RED = (214, 40, 46)       # the red
RED_HOT = (255, 92, 74)   # its highlight
RED_DEEP = (128, 18, 26)  # its shadow
BONE = (232, 234, 240)


def canvas(bg=INK):
    """A supersampled square to draw into, with its draw handle."""
    img = Image.new("RGBA", (SIZE * SS, SIZE * SS), bg + (255,))
    return img, ImageDraw.Draw(img, "RGBA")


def finish(img):
    return img.resize((SIZE, SIZE), Image.LANCZOS)


def rounded_mask(size, radius_frac=0.22):
    """App-icon squircle-ish mask, so no option ships as a bare square."""
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * radius_frac), fill=255
    )
    return m


def hexagon(cx, cy, r, rot=0.0):
    """Pointy-top hexagon unless rotated. Angles from -90 so vertex 0 is up."""
    return [
        (
            cx + r * math.cos(math.radians(-90 + rot + 60 * i)),
            cy + r * math.sin(math.radians(-90 + rot + 60 * i)),
        )
        for i in range(6)
    ]


def glow(img, box, colour, blur, alpha=255):
    """Additive-ish glow: paint on a layer, blur it, composite it back."""
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse(box, fill=colour + (alpha,))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    return Image.alpha_composite(img, layer)


# ------------------------------------------------------------------ options --

def opt_a_cut_facet():
    """A -- Cut Facet. The hex mark in blacks, one blade catching red light."""
    img, d = canvas()
    c = SIZE * SS / 2
    outer = hexagon(c, c, SIZE * SS * 0.40)
    inner = hexagon(c, c, SIZE * SS * 0.175, rot=30)
    shades = [COAL, SLATE, (32, 34, 42), RED, (28, 30, 38), (16, 18, 23)]
    for i in range(6):
        j = (i + 1) % 6
        d.polygon([outer[i], outer[j], inner[j], inner[i]], fill=shades[i] + (255,))
    # The red blade gets a hot inner edge so it reads as a lit surface rather
    # than a flat red panel -- that edge is the whole illusion of a facet.
    d.line([inner[3], inner[4]], fill=RED_HOT + (255,), width=int(6 * SS))
    d.polygon(inner, fill=INK + (255,))
    d.polygon(inner, outline=(60, 64, 76, 255), width=int(2.5 * SS))
    return finish(img)


def opt_b_red_rift():
    """B -- Red Rift. Solid black, one hard red cleave. Reads at any size."""
    img, d = canvas()
    n = SIZE * SS
    # A slanted slot with a bright core, widening as it falls -- a crack, not a
    # stripe. The asymmetry is what stops it reading as a "no entry" sign.
    top, bot = n * 0.10, n * 0.90
    d.polygon(
        [(n * 0.58, top), (n * 0.66, top), (n * 0.44, bot), (n * 0.32, bot)],
        fill=RED_DEEP + (255,),
    )
    d.polygon(
        [(n * 0.605, top), (n * 0.635, top), (n * 0.415, bot), (n * 0.365, bot)],
        fill=RED + (255,),
    )
    d.polygon(
        [(n * 0.615, top), (n * 0.625, top), (n * 0.40, bot), (n * 0.385, bot)],
        fill=RED_HOT + (255,),
    )
    img = glow(img, [n * 0.30, n * 0.28, n * 0.72, n * 0.72], RED, n * 0.05, 70)
    return finish(img)


def opt_c_ember_hex():
    """C -- Ember Hex. Black hexagon outline, red burning inside it."""
    img, d = canvas()
    c = SIZE * SS / 2
    img = glow(img, [c - SIZE * SS * 0.24, c - SIZE * SS * 0.24,
                     c + SIZE * SS * 0.24, c + SIZE * SS * 0.24],
               RED_DEEP, SIZE * SS * 0.06, 190)
    d = ImageDraw.Draw(img, "RGBA")
    d.polygon(hexagon(c, c, SIZE * SS * 0.20), fill=RED + (255,))
    d.polygon(hexagon(c, c, SIZE * SS * 0.115), fill=RED_HOT + (255,))
    d.polygon(hexagon(c, c, SIZE * SS * 0.40), outline=BONE + (36,), width=int(3 * SS))
    d.polygon(hexagon(c, c, SIZE * SS * 0.335), outline=SLATE + (255,), width=int(9 * SS))
    return finish(img)


def opt_d_f_cut():
    """D -- F-Cut. The letter, carved. A wordmark that shrinks to a favicon."""
    img, d = canvas()
    n = SIZE * SS
    # Built as polygons rather than typed, so it needs no font on any machine
    # and keeps the same angled cut on both arms.
    stem_l, stem_r = n * 0.30, n * 0.44
    top, bot = n * 0.20, n * 0.80
    d.polygon([(stem_l, top), (n * 0.76, top), (n * 0.70, n * 0.325),
               (stem_r, n * 0.325), (stem_r, bot), (stem_l, bot)],
              fill=SLATE + (255,))
    d.polygon([(stem_r, n * 0.44), (n * 0.665, n * 0.44), (n * 0.615, n * 0.555),
               (stem_r, n * 0.555)], fill=SLATE + (255,))
    # The cut: a red bevel down the left of every stroke, as if lit from there.
    d.polygon([(stem_l, top), (stem_l + n * 0.028, top),
               (stem_l + n * 0.028, bot), (stem_l, bot)], fill=RED + (255,))
    d.polygon([(n * 0.76, top), (n * 0.70, n * 0.325), (n * 0.727, n * 0.325),
               (n * 0.787, top)], fill=RED + (255,))
    return finish(img)


def opt_e_prism_split():
    """E -- Prism Split. Black ground, light entering and fanning out red."""
    img, d = canvas()
    n = SIZE * SS
    apex = (n * 0.30, n * 0.50)
    d.line([(n * 0.06, n * 0.50), apex], fill=BONE + (200,), width=int(5 * SS))
    fan = [(RED_DEEP, -26), (RED, -13), (RED_HOT, 0), (RED, 13), (RED_DEEP, 26)]
    for colour, deg in fan:
        far = (n * 0.94, n * 0.50 + math.tan(math.radians(deg)) * n * 0.64)
        d.line([apex, far], fill=colour + (255,), width=int(9 * SS))
    d.polygon(hexagon(n * 0.34, n * 0.50, n * 0.155, rot=30),
              fill=COAL + (255,), outline=SLATE + (255,), width=int(4 * SS))
    return finish(img)


def opt_f_aperture():
    """F -- Aperture. Six black blades, red light through the gaps."""
    img, d = canvas()
    c = SIZE * SS / 2
    img = glow(img, [c - SIZE * SS * 0.30, c - SIZE * SS * 0.30,
                     c + SIZE * SS * 0.30, c + SIZE * SS * 0.30],
               RED, SIZE * SS * 0.045, 210)
    d = ImageDraw.Draw(img, "RGBA")
    # A real iris: each blade is a straight-edged quad running from the outer
    # ring to a chord that stops short of centre, and the six chords leave the
    # hexagonal opening. Drawn straight-edged on purpose -- the first attempt
    # bowed the outer edge outward and the whole thing read as a flower.
    outer = SIZE * SS * 0.46
    hole = hexagon(c, c, SIZE * SS * 0.13, rot=30)
    ring = hexagon(c, c, outer, rot=30)
    for i in range(6):
        j = (i + 1) % 6
        d.polygon([ring[i], ring[j], hole[j], hole[i]],
                  fill=(COAL if i % 2 else SLATE) + (255,))
        # The seam between blades is where the light gets through.
        d.line([ring[j], hole[j]], fill=RED_DEEP + (255,), width=int(3.5 * SS))
    d.polygon(hole, fill=RED + (255,))
    d.polygon(hexagon(c, c, SIZE * SS * 0.065, rot=30), fill=RED_HOT + (255,))
    return finish(img)


def opt_g_obsidian():
    """G -- Obsidian. A cut stone: greyscale planes, one red edge."""
    img, d = canvas()
    c = SIZE * SS / 2
    n = SIZE * SS
    # A brilliant cut seen from above the girdle: a wide flat top, six pavilion
    # facets falling to a point well below it. The girdle has to sit high and
    # the point low, or the facets are too shallow to read as depth at all --
    # which is exactly how the first pass came out.
    girdle = hexagon(c, n * 0.42, n * 0.38, rot=30)
    table = hexagon(c, n * 0.42, n * 0.205, rot=30)
    tip = (c, n * 0.93)
    pavilion = [(24, 26, 33), (37, 40, 49), (54, 58, 70),
                (46, 49, 60), (30, 32, 40), (18, 20, 26)]
    crown = [(58, 62, 75), (48, 51, 62), (70, 75, 90),
             (62, 66, 80), (44, 47, 57), (52, 56, 67)]
    for i in range(6):
        j = (i + 1) % 6
        d.polygon([girdle[i], girdle[j], tip], fill=pavilion[i] + (255,))
    for i in range(6):
        j = (i + 1) % 6
        d.polygon([girdle[i], girdle[j], table[j], table[i]], fill=crown[i] + (255,))
    d.polygon(table, fill=(86, 92, 110, 255))
    # One edge takes the light. A stone with red on every edge is a logo; a
    # stone with red on one edge is a stone.
    d.line([girdle[3], tip], fill=RED + (255,), width=int(7 * SS))
    d.line([girdle[3], girdle[4]], fill=RED_HOT + (255,), width=int(6 * SS))
    d.line([girdle[3], table[3]], fill=RED_DEEP + (255,), width=int(4 * SS))
    return finish(img)


def opt_h_look_inside():
    """H -- Look Inside. A black slot with a red hex iris: the file explorer."""
    img, d = canvas()
    n = SIZE * SS
    c = n / 2
    d.rounded_rectangle([n * 0.10, n * 0.30, n * 0.90, n * 0.70],
                        radius=n * 0.20, fill=COAL + (255,))
    d.rounded_rectangle([n * 0.10, n * 0.30, n * 0.90, n * 0.70],
                        radius=n * 0.20, outline=SLATE + (255,), width=int(6 * SS))
    img = glow(img, [c - n * 0.18, c - n * 0.18, c + n * 0.18, c + n * 0.18],
               RED, n * 0.05, 150)
    d = ImageDraw.Draw(img, "RGBA")
    d.polygon(hexagon(c, c, n * 0.155, rot=30), fill=RED + (255,))
    d.polygon(hexagon(c, c, n * 0.075, rot=30), fill=INK + (255,))
    d.polygon(hexagon(c - n * 0.05, c - n * 0.05, n * 0.03, rot=30),
              fill=RED_HOT + (255,))
    return finish(img)


OPTIONS = [
    ("A", "Cut Facet", "the hex mark, one blade lit red", opt_a_cut_facet),
    ("B", "Red Rift", "black, split by a single red cleave", opt_b_red_rift),
    ("C", "Ember Hex", "outline in black, burning inside", opt_c_ember_hex),
    ("D", "F-Cut", "the letter, bevelled in red", opt_d_f_cut),
    ("E", "Prism Split", "white light in, red spectrum out", opt_e_prism_split),
    ("F", "Aperture", "six blades, red light between them", opt_f_aperture),
    ("G", "Obsidian", "a cut stone, one edge catching", opt_g_obsidian),
    ("H", "Look Inside", "a slot with a red iris", opt_h_look_inside),
]


# ------------------------------------------------------------- contact sheet --

def font(px, bold=False):
    """A real UI font if Windows has one, else Pillow's default."""
    for name in (["seguisb.ttf", "segoeuib.ttf"] if bold else ["segoeui.ttf"]):
        try:
            return ImageFont.truetype(name, px)
        except OSError:
            continue
    return ImageFont.load_default()


def sheet(rendered):
    cols, rows = 4, 2
    cell_w, cell_h = 300, 380
    pad = 36
    w = pad * 2 + cols * cell_w
    h = pad * 2 + rows * cell_h + 70
    img = Image.new("RGB", (w, h), (13, 14, 18))
    d = ImageDraw.Draw(img)

    d.text((pad, pad - 6), "FACET — logo options", font=font(30, True), fill=(238, 240, 246))
    d.text((pad, pad + 30), "each shown at 224px and at 48px, the size it lives at on a taskbar",
           font=font(16), fill=(132, 138, 152))

    mask224 = rounded_mask(224)
    mask48 = rounded_mask(48)

    for i, (letter, name, blurb, png) in enumerate(rendered):
        cx = pad + (i % cols) * cell_w
        cy = pad + 70 + (i // cols) * cell_h

        big = png.resize((224, 224), Image.LANCZOS).convert("RGB")
        img.paste(big, (cx, cy), mask224)
        small = png.resize((48, 48), Image.LANCZOS).convert("RGB")
        img.paste(small, (cx + 234, cy + 176), mask48)

        d.text((cx, cy + 240), f"{letter}   {name}", font=font(22, True), fill=(238, 240, 246))
        d.text((cx, cy + 270), blurb, font=font(15), fill=(132, 138, 152))
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rendered = []
    for letter, name, blurb, fn in OPTIONS:
        png = fn()
        slug = name.lower().replace(" ", "-")
        path = OUT / f"facet-{letter}-{slug}.png"
        png.save(path)
        print(f"  {letter}  {name:<12} -> {path.name}")
        rendered.append((letter, name, blurb, png))

    sheet_path = OUT / "facet-logo-options.png"
    sheet(rendered).save(sheet_path)
    print(f"\ncontact sheet -> {sheet_path}")


if __name__ == "__main__":
    main()
