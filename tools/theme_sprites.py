"""Shared tools for theme images (fit the PixelLab output to the game's exact size).

Each theme's furniture must be assets/themes/<theme>/f/<name>.png, with EXACTLY the same pixel size as in cyberpunk
(layout, collision and alignment are written against these sizes). This file:

  python tools/theme_sprites.py spec               -> tools/theme_sprites.json (sizes + generation canvas) and _work/theme_refs/*.png (reference)
  python tools/theme_sprites.py fit <theme> <name> <downloaded.png>
                                                   -> crops, shrinks if needed, aligns bottom-center and saves at the exact size
  python tools/theme_sprites.py check <theme>       -> which pieces exist / are missing in that theme, are the sizes right

The PixelLab generation canvas must be a multiple of four and at least 32 px; the reference (style_image) is the cyberpunk piece placed on that canvas from the bottom-center.
"""
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BASE_F = os.path.join(ROOT, "assets", "f")
SPEC = os.path.join(HERE, "theme_sprites.json")
REFS = os.path.join(ROOT, "_work", "theme_refs")

# (name, role) — role: the FUNCTION of the piece (the same whatever the theme). anchor: bottom (bottom-center) | top (top-center, wall decoration)
ITEMS = [
    ("desk_b", "work desk seen from the front-three-quarter, flat top surface for a monitor, drawer block on the right side", "bottom"),
    ("chair_small", "small swivel office chair seen from behind, seat and backrest", "bottom"),
    ("exec_desk_clean", "large wide executive boss desk, front panel with a name plaque in the middle, empty clean tabletop", "bottom"),
    ("exec_chair", "tall high-back boss chair seen from behind", "bottom"),
    ("sofa_a", "three-seat sofa seen from the front, wide", "bottom"),
    ("armchair", "single armchair seen from the front", "bottom"),
    ("coffee_table", "low coffee table, wide and short", "bottom"),
    ("arcade", "upright arcade-style game cabinet with a glowing screen, tall and narrow", "bottom"),
    ("vape_stand", "tall narrow standing station where workers take a smoke or fresh-air break, small ash tray or rail on top", "bottom"),
    ("floor_lamp", "very thin tall standing floor lamp with a glowing top", "bottom"),
    ("plant_tall", "tall leafy potted plant in a pot", "bottom"),
    ("server_rack", "tall narrow cabinet full of blinking indicator lights or small glowing devices", "bottom"),
    ("coffee_machine", "drink dispenser machine for hot beverages, tall narrow", "bottom"),
    ("easel", "painter's easel with a canvas and a paint palette", "bottom"),
    ("reception_desk", "front reception counter desk, wide, front panel visible", "bottom"),
    ("trophy_case", "tall glass display cabinet with trophies and curios", "bottom"),
    ("shelf_unit", "tall bookshelf with books and small objects on several shelves", "bottom"),
    ("whiteboard", "standing planning board on wheels or legs with notes and a diagram", "bottom"),
    ("printer", "small office machine that prints paper, on a stand", "bottom"),
    ("boxes", "small stack of storage crates or boxes", "bottom"),
    ("poster_robot", "framed wall poster / picture, portrait orientation", "top"),
    ("poster_synth", "framed wall poster / picture, portrait orientation, different artwork", "top"),
    ("vending", "tall snack and drink vending machine, front view", "bottom"),
    ("water_cooler", "drinking water dispenser, tall narrow", "bottom"),
    ("bench", "long low bench, wide", "bottom"),
    ("balcony_railing", "wide balcony railing section, see-through, to be tiled horizontally", "bottom"),
    ("prop_mug", "small cup with a hot drink, tiny desk prop", "bottom"),
    ("prop_ramen", "small bowl of food with steam, tiny desk prop", "bottom"),
    ("prop_cactus", "tiny potted plant, tiny desk prop", "bottom"),
    ("prop_headphones", "tiny desk prop: headphones or a small gadget lying on the desk", "bottom"),
]


def ceil4(v):
    return (v + 3) // 4 * 4


def canvas_for(w, h):
    return max(32, ceil4(w)), max(32, ceil4(h))


def build_spec():
    os.makedirs(REFS, exist_ok=True)
    out = []
    for name, role, anchor in ITEMS:
        im = Image.open(os.path.join(BASE_F, name + ".png")).convert("RGBA")
        cw, ch = canvas_for(im.width, im.height)
        ref = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        ref.alpha_composite(im, ((cw - im.width) // 2, ch - im.height if anchor == "bottom" else 0))
        ref.save(os.path.join(REFS, name + ".png"))
        out.append({"name": name, "w": im.width, "h": im.height, "canvas": [cw, ch], "anchor": anchor, "role": role})
    with open(SPEC, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print("spec written:", len(out), "parts ->", SPEC)


def load_spec():
    with open(SPEC, encoding="utf-8") as fh:
        return {s["name"]: s for s in json.load(fh)}


def fit(theme, name, src):
    spec = load_spec()[name]
    W, H = spec["w"], spec["h"]
    im = Image.open(src).convert("RGBA")
    bb = im.getchannel("A").point(lambda a: 255 if a > 40 else 0).getbbox()
    if not bb:
        raise SystemExit("empty image: " + src)
    im = im.crop(bb)
    if im.width > W or im.height > H:                      # if it overflowed, shrink proportionally (nearest neighbor: so the pixel art is not spoiled)
        k = min(W / im.width, H / im.height)
        im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.NEAREST)
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    x = (W - im.width) // 2
    y = H - im.height if spec["anchor"] == "bottom" else 0
    out.alpha_composite(im, (x, y))
    d = os.path.join(ROOT, "assets", "themes", theme, "f")
    os.makedirs(d, exist_ok=True)
    out.save(os.path.join(d, name + ".png"))
    print("tamam", theme, name, "kaynak", (bb[2] - bb[0], bb[3] - bb[1]), "->", (W, H))


def check(theme):
    spec = load_spec()
    d = os.path.join(ROOT, "assets", "themes", theme, "f")
    miss, bad = [], []
    for name, s in spec.items():
        p = os.path.join(d, name + ".png")
        if not os.path.exists(p):
            miss.append(name)
        elif Image.open(p).size != (s["w"], s["h"]):
            bad.append((name, Image.open(p).size, (s["w"], s["h"])))
    print(theme, "missing:", miss or "none", "| wrong size:", bad or "none", "| present:", len(spec) - len(miss))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "spec":
        build_spec()
    elif cmd == "fit":
        fit(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == "check":
        check(sys.argv[2])
    else:
        print(__doc__)
