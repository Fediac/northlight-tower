"""Draws the office's fixed shell: wall, floor, windows, door, glass wall + balcony, sign, rug.

Outputs:
  assets/bg/shell.png    - fixed architecture (window/glass areas are TRANSPARENT, the dynamic sky shows behind)
  assets/bg/glassfx.png  - glass reflection lines (drawn on top)
  scene.json             - layout used by JS (desks, seats, points)
  _work/preview_shell.png - combined preview for checking (sky + shell + furniture)
"""
import json
import math
import os
import random

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
A = os.path.join(HERE, "assets")
W, H = 960, 540
WALL_BOTTOM = 180     # line where the floor starts
SLAB_TOP = 528        # where the floor's cross-section thickness starts
CEIL = 16

random.seed(7)
np.random.seed(7)


def C(h, a=255):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


# ---- palette ----
INK = C("#0b0a1c")
WALL_A = C("#1d1a46")
WALL_B = C("#242058")
WALL_SEAM = C("#13112d")
WALL_HI = C("#2e2a6b")
DADO = C("#18153a")
DADO_LINE = C("#100e29")
CYAN = C("#3df2ff")
CYAN_D = C("#19a9bd")
MAGENTA = C("#ff3df0")
MAGENTA_D = C("#b3269f")
AMBER = C("#ffb23d")
GREEN = C("#46e0a0")
FLOOR_A = C("#1b1844")
FLOOR_B = C("#201c4e")
FLOOR_SEAM = C("#13112f")
FLOOR_HI = C("#2a2663")

# ---- font ----
with open(os.path.join(HERE, "font5x7.json"), encoding="utf-8") as f:
    FONT = json.load(f)


def text_width(t, scale=1):
    return max(0, len(t) * 6 * scale - scale)


# Turkish accented capital letters: base letter + mark dots (same as core.js MARKS)
MARKS = {"İ": ("I", [(2, -2)]), "Ş": ("S", [(2, 7)]), "Ç": ("C", [(2, 7)]), "Ğ": ("G", [(1, -2), (3, -2), (2, -1)]),
         "Ü": ("U", [(1, -2), (3, -2)]), "Ö": ("O", [(1, -2), (3, -2)])}


def draw_text(d, x, y, t, color, scale=1):
    cx = x
    for ch in t.upper():
        g = FONT.get(ch)
        if ch in MARKS:
            g = FONT.get(MARKS[ch][0])
            for (mx, my) in MARKS[ch][1]:
                d.rectangle([cx + mx * scale, y + my * scale, cx + mx * scale + scale - 1, y + my * scale + scale - 1], fill=color)
        if g:
            for ry, row in enumerate(g):
                for rx, bit in enumerate(row):
                    if bit == "1":
                        d.rectangle([cx + rx * scale, y + ry * scale, cx + rx * scale + scale - 1, y + ry * scale + scale - 1], fill=color)
        cx += 6 * scale


def glow(im, cx, cy, rx, ry, color, strength=0.5, clip=None):
    """Soft colored light halo (like additive blending)."""
    w, h = im.size
    x0, x1 = max(0, int(cx - rx)), min(w, int(cx + rx) + 1)
    y0, y1 = max(0, int(cy - ry)), min(h, int(cy + ry) + 1)
    if x1 <= x0 or y1 <= y0:
        return
    xs = (np.arange(x0, x1) - cx) / rx
    ys = (np.arange(y0, y1) - cy) / ry
    dist = np.sqrt(xs[None, :] ** 2 + ys[:, None] ** 2)
    a = np.clip(1 - dist, 0, 1) ** 2 * strength
    if clip is not None:   # clip = (x0,y0,x1,y1)
        mask = np.zeros_like(a)
        cx0, cy0, cx1, cy1 = clip
        mask[max(0, cy0 - y0):max(0, cy1 - y0), max(0, cx0 - x0):max(0, cx1 - x0)] = 1
        a = a * mask
    region = np.array(im.crop((x0, y0, x1, y1))).astype(np.float32)
    col = np.array(color[:3], dtype=np.float32)
    # screen blend: the light is added on top of the color underneath
    vis = region[..., 3:4] > 0
    region[..., :3] = np.where(vis, region[..., :3] + (255 - region[..., :3]) * a[..., None] * (col / 255.0), region[..., :3])
    im.paste(Image.fromarray(np.clip(region, 0, 255).astype(np.uint8), "RGBA"), (x0, y0))


# =====================================================================
#  LAYOUT
# =====================================================================
DESK_W, DESK_H = 80, 57
ROW_Y = (290, 440)
DESK_X = (100, 220, 340, 460)

SCENE = {
    "W": W, "H": H, "wallBottom": WALL_BOTTOM, "slabTop": SLAB_TOP,
    "door": {"x": 38, "y": 186},
    "desks": [{"x": x, "y": y} for y in ROW_Y for x in DESK_X],
    "desk": {"w": DESK_W, "h": DESK_H, "screen": [27, 2, 27, 15],
             "charDX": 40, "charTop": 17, "chairX": 30, "chairY": 43, "clip": 60},
    "glass": {"x0": 640, "x1": 948, "doorX0": 764, "doorX1": 812, "floorY0": 132, "floorY1": 172},
    "sofa": {"x": 740, "y": 296, "seats": [-26, 0, 26]},
    "armchairs": [{"x": 650, "y": 362}, {"x": 830, "y": 362}],
    "table": {"x": 740, "y": 360},
    "arcade": {"x": 906, "y": 300},
    "lamps": [{"x": 684, "y": 292}, {"x": 796, "y": 292}],
    "vape": {"x": 926, "y": 174},
    "balconySpots": [{"x": 742, "y": 162}, {"x": 846, "y": 158}, {"x": 878, "y": 166}, {"x": 906, "y": 159}],
    "wallItems": [],
}

# furniture against the wall (y = the line where they touch the floor); (name, x center, y bottom)
WALL_ITEMS = [
    ("plant_tall", 92, 204),
    ("whiteboard", 176, 208),
    ("shelf_unit", 262, 202),
    ("printer", 350, 203),
    ("boxes", 398, 203),
    ("server_rack", 470, 203),
    ("vending", 540, 203),
    ("coffee_machine", 584, 203),
    ("water_cooler", 618, 203),
    ("plant_tall", 656, 206),
]
# decorations hung on the wall (no shadow): (name, x center, y bottom)
WALL_DECOR = [
    ("poster_synth", 82, 96),
    ("poster_robot", 286, 96),
    ("poster_synth", 500, 98),
    ("poster_robot", 548, 98),
]


# =====================================================================
#  SHELL
# =====================================================================
def draw_floor(im):
    d = ImageDraw.Draw(im)
    tw, th = 40, 20
    for ty in range(WALL_BOTTOM, SLAB_TOP, th):
        for tx in range(12, 948, tw):
            alt = ((tx // tw) + (ty // th)) % 2
            d.rectangle([tx, ty, tx + tw - 1, min(ty + th - 1, SLAB_TOP - 1)], fill=FLOOR_B if alt else FLOOR_A)
            d.line([(tx, ty), (tx + tw - 1, ty)], fill=FLOOR_HI)          # top edge highlight
            d.line([(tx, ty), (tx, min(ty + th - 1, SLAB_TOP - 1))], fill=FLOOR_SEAM)
    # fixed noise
    arr = np.array(im).astype(np.int16)
    region = arr[WALL_BOTTOM:SLAB_TOP, 12:948]
    noise = np.random.randint(-3, 4, size=region.shape[:2])
    region[..., :3] += noise[..., None]
    # depth: a bit bright at the top, dark at the bottom
    gy = np.linspace(1.10, 0.72, region.shape[0])[:, None, None]
    region[..., :3] = (region[..., :3] * gy)
    arr[WALL_BOTTOM:SLAB_TOP, 12:948] = region
    im.paste(Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA"))


def draw_work_carpet(im):
    d = ImageDraw.Draw(im)
    x0, y0, x1, y1 = 28, 222, 508, 506
    arr = np.array(im).astype(np.int16)
    sub = arr[y0:y1, x0:x1]
    sub[..., 0] = sub[..., 0] * 0.86
    sub[..., 1] = sub[..., 1] * 0.86
    sub[..., 2] = sub[..., 2] * 0.96 + 4
    arr[y0:y1, x0:x1] = sub
    im.paste(Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA"))
    d = ImageDraw.Draw(im)
    edge = (61, 242, 255, 120)
    d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=edge)
    d.rectangle([x0 + 2, y0 + 2, x1 - 3, y1 - 3], outline=(61, 242, 255, 50))
    # corner marks
    for (cx, cy) in ((x0, y0), (x1 - 1, y0), (x0, y1 - 1), (x1 - 1, y1 - 1)):
        d.rectangle([cx - 2, cy - 2, cx + 2, cy + 2], fill=CYAN)


def draw_lounge_rug(im):
    d = ImageDraw.Draw(im)
    x0, y0, x1, y1 = 596, 262, 886, 410
    d.rectangle([x0, y0, x1, y1], fill=C("#3a1d63"))
    d.rectangle([x0 + 3, y0 + 3, x1 - 3, y1 - 3], outline=MAGENTA)
    d.rectangle([x0 + 6, y0 + 6, x1 - 6, y1 - 6], outline=C("#6a2f9e"))
    # diamond pattern
    for yy in range(y0 + 12, y1 - 10, 12):
        for xx in range(x0 + 12, x1 - 10, 24):
            off = 12 if ((yy - y0) // 12) % 2 else 0
            cx, cy = xx + off, yy
            if cx < x1 - 12:
                d.polygon([(cx, cy - 3), (cx + 4, cy), (cx, cy + 3), (cx - 4, cy)], fill=C("#4f2a82"))
    glow(im, (x0 + x1) // 2, (y0 + y1) // 2, 180, 90, MAGENTA, 0.10, clip=(x0, y0, x1, y1))


def draw_wall(im):
    d = ImageDraw.Draw(im)
    # left/right side wall
    for (sx0, sx1) in ((0, 12), (948, 960)):
        d.rectangle([sx0, 0, sx1 - 1, H - 1], fill=C("#0f0d26"))
        d.line([(sx0 + (11 if sx0 == 0 else 0), CEIL), (sx0 + (11 if sx0 == 0 else 0), SLAB_TOP)], fill=CYAN_D)
    # main wall (the window section will be cut out afterwards)
    d.rectangle([12, CEIL, 947, WALL_BOTTOM - 1], fill=WALL_A)
    for px in range(12, 948, 56):
        d.rectangle([px, CEIL, px + 27, WALL_BOTTOM - 1], fill=WALL_B)
        d.line([(px, CEIL), (px, WALL_BOTTOM - 1)], fill=WALL_SEAM)
        d.line([(px + 1, CEIL), (px + 1, 110)], fill=WALL_HI)
    # lower band (dado)
    d.rectangle([12, 112, 947, WALL_BOTTOM - 1], fill=DADO)
    for yy in range(118, WALL_BOTTOM, 10):
        d.line([(12, yy), (947, yy)], fill=DADO_LINE)
    # dado top neon line
    d.rectangle([12, 110, 947, 111], fill=CYAN)
    d.line([(12, 112), (947, 112)], fill=CYAN_D)
    # ceiling strip
    d.rectangle([12, 0, 947, CEIL - 1], fill=C("#0c0a22"))
    d.line([(12, CEIL - 1), (947, CEIL - 1)], fill=C("#201c4e"))
    for lx in range(36, 940, 72):
        d.rectangle([lx, 5, lx + 18, 7], fill=C("#bfefff"))
        d.rectangle([lx - 1, 8, lx + 19, 8], fill=C("#3b6c8a"))
    # junction of floor and wall (baseboard) + neon
    d.rectangle([12, WALL_BOTTOM - 4, 947, WALL_BOTTOM - 1], fill=C("#0e0c26"))
    d.line([(12, WALL_BOTTOM - 1), (947, WALL_BOTTOM - 1)], fill=MAGENTA_D)
    d.line([(12, WALL_BOTTOM), (947, WALL_BOTTOM)], fill=C("#0a081c"))


def punch(im, box):
    ImageDraw.Draw(im).rectangle(box, fill=(0, 0, 0, 0))


def draw_window(im, x0, y0, x1, y1):
    """Window in the solid wall: the frame is drawn, the glass stays TRANSPARENT."""
    d = ImageDraw.Draw(im)
    d.rectangle([x0 - 5, y0 - 5, x1 + 4, y1 + 4], fill=INK)
    d.rectangle([x0 - 4, y0 - 4, x1 + 3, y1 + 3], outline=MAGENTA_D)
    punch(im, (x0, y0, x1 - 1, y1 - 1))
    d = ImageDraw.Draw(im)
    mx = (x0 + x1) // 2
    d.rectangle([mx - 2, y0, mx + 1, y1 - 1], fill=INK)
    my = y0 + (y1 - y0) * 3 // 5
    d.rectangle([x0, my - 1, x1 - 1, my], fill=INK)
    # sill
    d.rectangle([x0 - 9, y1 + 5, x1 + 8, y1 + 9], fill=C("#38336f"))
    d.line([(x0 - 9, y1 + 5), (x1 + 8, y1 + 5)], fill=C("#5a53a8"))
    d.rectangle([x0 - 9, y1 + 10, x1 + 8, y1 + 10], fill=C("#0a081c"))
    return (x0, y0, x1, y1)


def draw_door(im, x0, y0, x1, y1):
    d = ImageDraw.Draw(im)
    d.rectangle([x0 - 4, y0 - 12, x1 + 3, y1], fill=INK)
    d.rectangle([x0 - 3, y0 - 11, x1 + 2, y0 - 2], fill=C("#171433"))
    d.line([(x0 - 3, y0 - 2), (x1 + 2, y0 - 2)], fill=CYAN)
    tw = text_width("ENTRY")
    draw_text(d, (x0 + x1) // 2 - tw // 2, y0 - 10, "ENTRY", CYAN)
    # two sliding panels
    d.rectangle([x0, y0, x1 - 1, y1 - 1], fill=C("#2a2f54"))
    mid = (x0 + x1) // 2
    d.rectangle([mid - 1, y0, mid, y1 - 1], fill=CYAN)           # lit gap in the middle
    for yy in range(y0 + 8, y1, 12):
        d.line([(x0 + 1, yy), (mid - 3, yy)], fill=C("#1d213f"))
        d.line([(mid + 2, yy), (x1 - 2, yy)], fill=C("#1d213f"))
    d.rectangle([x0, y0, x0 + 1, y1 - 1], fill=C("#3b4172"))
    d.rectangle([x1 - 2, y0, x1 - 1, y1 - 1], fill=C("#3b4172"))
    # status light
    d.rectangle([x1 + 4, y0 + 4, x1 + 6, y0 + 8], fill=INK)
    d.rectangle([x1 + 5, y0 + 5, x1 + 5, y0 + 7], fill=GREEN)


def draw_glass_wall(im):
    """Glass wall opening to the balcony + balcony floor (sky transparent)."""
    g = SCENE["glass"]
    gx0, gx1 = g["x0"], g["x1"]
    d = ImageDraw.Draw(im)
    top = CEIL
    # frame base
    d.rectangle([gx0, top, gx1 - 1, WALL_BOTTOM - 1], fill=INK)
    # glass area (transparent)
    punch(im, (gx0 + 6, top + 8, gx1 - 7, WALL_BOTTOM - 9))
    d = ImageDraw.Draw(im)
    # top beam
    d.rectangle([gx0, top, gx1 - 1, top + 7], fill=C("#14112e"))
    d.line([(gx0, top + 8), (gx1 - 1, top + 8)], fill=CYAN)
    # bottom beam
    d.rectangle([gx0, WALL_BOTTOM - 8, gx1 - 1, WALL_BOTTOM - 1], fill=C("#14112e"))
    d.line([(gx0, WALL_BOTTOM - 9), (gx1 - 1, WALL_BOTTOM - 9)], fill=MAGENTA_D)
    # posts
    for mx in (gx0, 700, g["doorX0"] - 3, g["doorX1"] - 3, 876, gx1 - 6):
        d.rectangle([mx, top, mx + 5, WALL_BOTTOM - 1], fill=INK)
        d.line([(mx + 1, top + 9), (mx + 1, WALL_BOTTOM - 10)], fill=C("#2b2766"))
    # open the door gap (indoor-balcony passage): remove the bottom beam
    ImageDraw.Draw(im).rectangle([g["doorX0"] + 3, WALL_BOTTOM - 8, g["doorX1"] - 4, WALL_BOTTOM - 1], fill=(0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # door threshold (thin line on the floor)
    d.line([(g["doorX0"] + 3, WALL_BOTTOM), (g["doorX1"] - 4, WALL_BOTTOM)], fill=CYAN_D)
    # sign above the door: BALKON
    sx0, sx1 = g["doorX0"] + 6, g["doorX1"] - 7
    d.rectangle([sx0, top + 10, sx1, top + 21], fill=C("#1a1038"))
    d.rectangle([sx0, top + 10, sx1, top + 21], outline=MAGENTA)
    tw = text_width("DECK")
    draw_text(d, (sx0 + sx1) // 2 - tw // 2 + 1, top + 12, "DECK", MAGENTA)

    # ---- balcony floor (grate) ----
    fy0, fy1 = g["floorY0"], g["floorY1"] + 8
    x0, x1 = gx0 + 6, gx1 - 6
    d.rectangle([x0, fy0, x1 - 1, fy1 - 1], fill=C("#161528"))
    for yy in range(fy0, fy1, 4):
        d.line([(x0, yy), (x1 - 1, yy)], fill=C("#23233f"))
        d.line([(x0, yy + 1), (x1 - 1, yy + 1)], fill=C("#0e0d1d"))
    for xx in range(x0, x1, 12):
        d.line([(xx, fy0), (xx, fy1 - 1)], fill=C("#1c1b34"))
    # lit strip on the front edge
    d.line([(x0, fy1 - 1), (x1 - 1, fy1 - 1)], fill=CYAN_D)
    # wall behind the railing (short parapet behind the balcony floor)
    d.rectangle([x0, fy0 - 2, x1 - 1, fy0 - 1], fill=C("#0a091a"))


def draw_railing(im):
    p = os.path.join(A, "f", "balcony_railing.png")
    if not os.path.exists(p):
        return
    rail = Image.open(p).convert("RGBA")
    # make the glass semi-transparent (light blue fill)
    arr = np.array(rail).astype(np.int16)
    light = (arr[..., 0] > 170) & (arr[..., 1] > 200) & (arr[..., 2] > 215) & (arr[..., 3] > 0)
    arr[light, 3] = 70
    rail = Image.fromarray(arr.astype(np.uint8), "RGBA")
    g = SCENE["glass"]
    x = g["x0"] + 6
    y_base = g["floorY0"] + 2        # bottom line of the railing
    step = rail.width - 6
    while x < g["x1"] - 6:
        im.alpha_composite(rail, (x, y_base - rail.height))
        x += step


def paste_item(im, name, cx, by, alpha=1.0):
    p = os.path.join(A, "f", name + ".png")
    if not os.path.exists(p):
        return None
    s = Image.open(p).convert("RGBA")
    im.alpha_composite(s, (int(cx - s.width // 2), int(by - s.height)))
    return s


def shadow(im, cx, by, w, h=5, a=90):
    sh = Image.new("RGBA", im.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse([cx - w // 2, by - h // 2, cx + w // 2, by + h // 2], fill=(0, 0, 0, a))
    im.alpha_composite(sh)


def draw_signs(im):
    d = ImageDraw.Draw(im)
    # AJAN OFISI sign (above the board)
    t = "AGENT OFFICE"
    tw = text_width(t, 2)
    sx = 392 - tw // 2
    d.rectangle([sx - 6, 22, sx + tw + 5, 41], fill=C("#120d2c"))
    d.rectangle([sx - 6, 22, sx + tw + 5, 41], outline=CYAN)
    draw_text(d, sx, 25, t, CYAN, 2)
    glow(im, 392, 32, 90, 26, CYAN, 0.30, clip=(12, CEIL, 640, 110))
    # DINLENME KOSESI tiny sign (above the vending machine)
    t2 = "COFFEE & SNACKS"
    tw2 = text_width(t2)
    d.rectangle([520, 124, 520 + tw2 + 7, 134], fill=C("#120d2c"))
    d.rectangle([520, 124, 520 + tw2 + 7, 134], outline=MAGENTA)
    draw_text(d, 524, 127, t2, MAGENTA)
    glow(im, 520 + (tw2 + 8) // 2, 129, 70, 14, MAGENTA, 0.28, clip=(12, CEIL, 640, 112))


def draw_board(im, x0, y0, x1, y1):
    """Wall board: frame + dark screen. The content is drawn dynamically by JS."""
    d = ImageDraw.Draw(im)
    d.rectangle([x0 - 4, y0 - 4, x1 + 3, y1 + 3], fill=INK)
    d.rectangle([x0 - 3, y0 - 3, x1 + 2, y1 + 2], outline=C("#39336f"))
    d.rectangle([x0, y0, x1 - 1, y1 - 1], fill=C("#070612"))
    glow(im, (x0 + x1) // 2, (y0 + y1) // 2, 110, 60, CYAN, 0.10, clip=(12, CEIL, 640, 112))
    # bottom LED
    d.rectangle([(x0 + x1) // 2 - 6, y1 + 5, (x0 + x1) // 2 + 6, y1 + 6], fill=CYAN)


BOARD = (322, 47, 462, 108)   # x0,y0,x1,y1 (screen area)
WINDOWS = [(120, 40, 236, 132)]


def build_shell():
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw_floor(im)
    draw_wall(im)
    draw_work_carpet(im)
    draw_lounge_rug(im)
    holes = []
    for w in WINDOWS:
        holes.append(draw_window(im, *w))
    draw_door(im, 16, 96, 60, 180 - 1 - 0)
    draw_glass_wall(im)
    draw_railing(im)
    draw_signs(im)
    draw_board(im, *BOARD)
    for (name, cx, by) in WALL_DECOR:
        paste_item(im, name, cx, by)
    # balcony bench (in front of the railing, behind the glass wall)
    paste_item(im, "bench", 694, 152)
    # furniture beside the wall
    for (name, cx, by) in WALL_ITEMS:
        f = os.path.join(A, "f", name + ".png")
        if os.path.exists(f):
            w = Image.open(f).width
            shadow(im, cx, by, w + 6)
            paste_item(im, name, cx, by)
    # front cross-section (floor thickness)
    d = ImageDraw.Draw(im)
    d.rectangle([0, SLAB_TOP, W - 1, H - 1], fill=C("#0a081c"))
    d.line([(0, SLAB_TOP), (W - 1, SLAB_TOP)], fill=MAGENTA)
    d.line([(0, SLAB_TOP + 1), (W - 1, SLAB_TOP + 1)], fill=MAGENTA_D)
    for xx in range(0, W, 32):
        d.line([(xx, SLAB_TOP + 4), (xx, H - 1)], fill=C("#13112d"))
    # light leaks: on the floor below the window
    for lx in range(36, 940, 72):
        glow(im, lx + 9, 20, 36, 92, (190, 235, 255), 0.085, clip=(12, CEIL, 948, 112))
    glow(im, 178, 215, 120, 40, CYAN, 0.16, clip=(12, WALL_BOTTOM, 640, SLAB_TOP))
    glow(im, 800, 215, 200, 40, MAGENTA, 0.10, clip=(12, WALL_BOTTOM, 948, SLAB_TOP))
    return im, holes


def build_glassfx(holes):
    """Diagonal reflection lines on the window and glass wall."""
    fx = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(fx)
    g = SCENE["glass"]
    boxes = list(holes) + [(g["x0"] + 6, CEIL + 9, g["x1"] - 7, WALL_BOTTOM - 10)]
    for (x0, y0, x1, y1) in boxes:
        for off in range(-(y1 - y0), (x1 - x0), 38):
            d.line([(x0 + off, y1), (x0 + off + (y1 - y0), y0)], fill=(255, 255, 255, 14), width=5)
            d.line([(x0 + off + 9, y1), (x0 + off + 9 + (y1 - y0), y0)], fill=(255, 255, 255, 9), width=2)
    # stay only inside the box
    mask = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(mask)
    for (x0, y0, x1, y1) in boxes:
        md.rectangle([x0, y0, x1 - 1, y1 - 1], fill=255)
    fx.putalpha(Image.fromarray(np.minimum(np.array(fx.getchannel("A")), np.array(mask)).astype(np.uint8)))
    return fx


def sky_preview():
    """For checking: combines the far + near silhouette and puts it behind the windows."""
    far = Image.open(os.path.join(A, "bg", "skyline_far.png")).convert("RGBA")
    near = Image.open(os.path.join(A, "bg", "skyline_near_keyed.png")).convert("RGBA") \
        if os.path.exists(os.path.join(A, "bg", "skyline_near_keyed.png")) else None
    sky = Image.new("RGBA", (W, H), (10, 8, 30, 255))
    x = 0
    flip = False
    while x < W:
        t = far.transpose(Image.FLIP_LEFT_RIGHT) if flip else far
        sky.alpha_composite(t, (x, 4))
        x += far.width
        flip = not flip
    if near is not None:
        x = 0
        flip = False
        while x < W:
            t = near.transpose(Image.FLIP_LEFT_RIGHT) if flip else near
            sky.alpha_composite(t, (x, 4 + far.height - near.height + 20))
            x += near.width
            flip = not flip
    return sky


def key_near():
    p = os.path.join(A, "bg", "skyline_near.png")
    im = Image.open(p).convert("RGBA")
    px = im.load()
    w, h = im.size
    sky_cols = {(71, 89, 116), (5, 4, 6)}
    seen = set()
    stack = [(x, 0) for x in range(w)]
    while stack:
        x, y = stack.pop()
        if (x, y) in seen or x < 0 or y < 0 or x >= w or y >= h:
            continue
        r, g, b, a = px[x, y]
        if (r, g, b) not in sky_cols:
            continue
        seen.add((x, y))
        px[x, y] = (0, 0, 0, 0)
        stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    im.save(os.path.join(A, "bg", "skyline_near_keyed.png"))


def main():
    key_near()
    shell, holes = build_shell()
    os.makedirs(os.path.join(A, "bg"), exist_ok=True)
    shell.save(os.path.join(A, "bg", "shell.png"), optimize=True)
    fx = build_glassfx(holes)
    fx.save(os.path.join(A, "bg", "glassfx.png"), optimize=True)
    SCENE["board"] = {"x0": BOARD[0], "y0": BOARD[1], "x1": BOARD[2], "y1": BOARD[3]}
    SCENE["windows"] = [list(w) for w in WINDOWS]
    SCENE["wallItems"] = [{"name": n, "x": x, "y": y} for (n, x, y) in WALL_ITEMS]
    with open(os.path.join(HERE, "scene.json"), "w", encoding="utf-8") as f:
        json.dump(SCENE, f, ensure_ascii=False, indent=1)
    # preview
    os.makedirs(os.path.join(HERE, "_work"), exist_ok=True)
    prev = sky_preview()
    prev.alpha_composite(shell)
    prev.alpha_composite(fx)
    prev.save(os.path.join(HERE, "_work", "preview_shell.png"))
    print("tamam", shell.size)


if __name__ == "__main__":
    main()
