"""NorthLight Tower: a 4-floor cross-section building. Draws the fixed shell (wall, floor, window, elevator frame, sign, rug, wall items).

Floors (top to bottom): 0 MANAGEMENT, 1 CODE & RESEARCH, 2 DESIGN, 3 LOBBY & REST.
Everything dynamic (desks, screens, seats, elevator doors, agents) is drawn in JS.

Outputs:
  assets/bg/tower_shell.png    fixed architecture (window/glass areas are TRANSPARENT)
  assets/bg/tower_glassfx.png  glass reflection lines
  scene.json                   layout used by JS (floor info, desk/seat/waypoints)
  _work/preview_tower.png      combined preview for checking
"""
import json
import os
import random

import numpy as np
from PIL import Image, ImageDraw

import compose_shell as cs   # shared drawing helpers (font, light, colors)

HERE = os.path.dirname(os.path.abspath(__file__))
A = os.path.join(HERE, "assets")
W = 960
TOP = 56
FH = 300
BOT = 24
CEIL = 14
WB = 112                          # local: line where the wall meets the floor
FLOOR_END = 286                   # local: end of the floor (below it is the slab thickness)
LANE = 260                        # local: main walking lane
ELEV_X0, ELEV_X1 = 884, 936       # elevator door
ELEV_DOOR_TOP = 36                # local

C = cs.C
random.seed(11)
np.random.seed(11)

THEMES = {
    "gold":    dict(wA="#251c3c", wB="#2e2348", dado="#1c1531", acc=(255, 196, 77), accd=(176, 130, 40), fA="#241b3e", fB="#2b2148", hi="#3d2f66"),
    "cyan":    dict(wA="#14214b", wB="#1b2b5e", dado="#101b3b", acc=(61, 242, 255), accd=(25, 169, 189), fA="#172046", fB="#1d2852", hi="#2a3b78"),
    "magenta": dict(wA="#2b1549", wB="#361b5a", dado="#200f39", acc=(255, 61, 240), accd=(179, 38, 159), fA="#241a47", fB="#2b2052", hi="#3d2c78"),
    "violet":  dict(wA="#1d1a46", wB="#242058", dado="#18153a", acc=(122, 92, 255), accd=(80, 60, 190), fA="#1b1844", fB="#201c4e", hi="#2e2a6b"),
    "emerald": dict(wA="#12283a", wB="#183247", dado="#0e1f2e", acc=(70, 255, 170), accd=(36, 170, 110), fA="#12263d", fB="#172e48", hi="#244a63"),
}

def hx(h, a=255):
    return C(h, a)


def rgba(t, a=255):
    return (t[0], t[1], t[2], a)


# ----------------------------------------------------------------- basic pieces
def punch(im, box):
    ImageDraw.Draw(im).rectangle(box, fill=(0, 0, 0, 0))


def paste(im, name, cx, by, shade=True, alpha=None):
    p = os.path.join(A, "f", name + ".png")
    if not os.path.exists(p):
        print("yok:", name)
        return None
    s = Image.open(p).convert("RGBA")
    if shade:
        cs.shadow(im, cx, by, s.width + 6)
    if alpha is not None:
        a = np.array(s).astype(np.float32)
        a[..., 3] *= alpha
        s = Image.fromarray(a.astype(np.uint8), "RGBA")
    im.alpha_composite(s, (int(cx - s.width // 2), int(by - s.height)))
    return s


def plate(im, cx, y, text, color, scale=1, bg="#120d2c"):
    d = ImageDraw.Draw(im)
    tw = cs.text_width(text, scale)
    x0, x1 = cx - tw // 2 - 5, cx + tw // 2 + 4
    d.rectangle([x0, y, x1, y + 7 * scale + 5], fill=hx(bg))
    d.rectangle([x0, y, x1, y + 7 * scale + 5], outline=rgba(color))
    cs.draw_text(d, cx - tw // 2, y + 3, text, rgba(color), scale)
    cs.glow(im, cx, y + 4 + 3 * scale, tw // 2 + 26, 14 + 4 * scale, color, 0.22)


def window(im, x0, y0, x1, y1, acc):
    d = ImageDraw.Draw(im)
    d.rectangle([x0 - 5, y0 - 5, x1 + 4, y1 + 4], fill=cs.INK)
    d.rectangle([x0 - 4, y0 - 4, x1 + 3, y1 + 3], outline=rgba(acc, 200))
    punch(im, (x0, y0, x1 - 1, y1 - 1))
    d = ImageDraw.Draw(im)
    mx = (x0 + x1) // 2
    d.rectangle([mx - 2, y0, mx + 1, y1 - 1], fill=cs.INK)
    my = y0 + (y1 - y0) * 3 // 5
    d.rectangle([x0, my - 1, x1 - 1, my], fill=cs.INK)
    d.rectangle([x0 - 9, y1 + 5, x1 + 8, y1 + 8], fill=C("#38336f"))
    d.line([(x0 - 9, y1 + 5), (x1 + 8, y1 + 5)], fill=C("#5a53a8"))
    return (x0, y0, x1, y1)


def carpet(im, x0, y0, x1, y1, acc, fill=(8, 6, 26, 70)):
    """Work rug: dark base + thin neon frame + corner marks."""
    ov = Image.new("RGBA", im.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(ov)
    od.rectangle([x0, y0, x1, y1], fill=fill)
    im.alpha_composite(ov)
    d = ImageDraw.Draw(im)
    d.rectangle([x0, y0, x1, y1], outline=rgba(acc, 150))
    for (cx, cy, sx, sy) in ((x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)):
        d.line([(cx, cy), (cx + 10 * sx, cy)], fill=rgba(acc))
        d.line([(cx, cy), (cx, cy + 10 * sy)], fill=rgba(acc))


def rug(im, x0, y0, x1, y1, base, edge, inner, dot):
    d = ImageDraw.Draw(im)
    d.rectangle([x0, y0, x1, y1], fill=C(base))
    d.rectangle([x0 + 3, y0 + 3, x1 - 3, y1 - 3], outline=edge)
    d.rectangle([x0 + 6, y0 + 6, x1 - 6, y1 - 6], outline=C(inner))
    for yy in range(y0 + 12, y1 - 10, 12):
        for xx in range(x0 + 12, x1 - 10, 24):
            off = 12 if ((yy - y0) // 12) % 2 else 0
            cx, cy = xx + off, yy
            if cx < x1 - 12:
                d.polygon([(cx, cy - 3), (cx + 4, cy), (cx, cy + 3), (cx - 4, cy)], fill=C(dot))


# ----------------------------------------------------------------- floor shell
def floor_shell(im, f):
    th = THEMES[f["theme"]]
    y0 = f["y0"]
    acc, accd = th["acc"], th["accd"]
    d = ImageDraw.Draw(im)
    # side walls
    d.rectangle([0, y0, 11, y0 + FH - 1], fill=C("#0f0d26"))
    d.rectangle([948, y0, 959, y0 + FH - 1], fill=C("#0f0d26"))
    d.line([(11, y0 + CEIL), (11, y0 + FH - 14)], fill=rgba(accd))
    d.line([(948, y0 + CEIL), (948, y0 + FH - 14)], fill=rgba(accd))
    # back wall
    d.rectangle([12, y0 + CEIL, 947, y0 + WB - 1], fill=hx(th["wA"]))
    for px in range(12, 948, 56):
        d.rectangle([px, y0 + CEIL, px + 27, y0 + WB - 1], fill=hx(th["wB"]))
        d.line([(px, y0 + CEIL), (px, y0 + WB - 1)], fill=cs.WALL_SEAM)
        d.line([(px + 1, y0 + CEIL), (px + 1, y0 + WB - 24)], fill=hx(th["hi"]))
    # lower band + neon
    d.rectangle([12, y0 + WB - 22, 947, y0 + WB - 1], fill=hx(th["dado"]))
    for yy in range(y0 + WB - 18, y0 + WB, 8):
        d.line([(12, yy), (947, yy)], fill=cs.DADO_LINE)
    d.rectangle([12, y0 + WB - 24, 947, y0 + WB - 23], fill=rgba(acc))
    # ceiling
    d.rectangle([12, y0, 947, y0 + CEIL - 1], fill=C("#0c0a22"))
    d.line([(12, y0 + CEIL - 1), (947, y0 + CEIL - 1)], fill=C("#201c4e"))
    for lx in range(36, 940, 72):
        d.rectangle([lx, y0 + 5, lx + 18, y0 + 7], fill=C("#bfefff"))
    # baseboard
    d.rectangle([12, y0 + WB - 4, 947, y0 + WB - 1], fill=C("#0e0c26"))
    d.line([(12, y0 + WB), (947, y0 + WB)], fill=C("#0a081c"))
    # floor
    tw, thh = 40, 20
    for ty in range(y0 + WB + 1, y0 + FLOOR_END, thh):
        for tx in range(12, 948, tw):
            alt = ((tx // tw) + ((ty - y0) // thh)) % 2
            d.rectangle([tx, ty, tx + tw - 1, min(ty + thh - 1, y0 + FLOOR_END - 1)], fill=hx(th["fB"] if alt else th["fA"]))
            d.line([(tx, ty), (tx + tw - 1, ty)], fill=hx(th["hi"]))
            d.line([(tx, ty), (tx, min(ty + thh - 1, y0 + FLOOR_END - 1))], fill=cs.FLOOR_SEAM)
    # depth shadow + noise on the floor
    arr = np.array(im).astype(np.int16)
    fy0, fy1 = y0 + WB + 1, y0 + FLOOR_END
    reg = arr[fy0:fy1, 12:948]
    noise = np.random.randint(-3, 4, size=reg.shape[:2])
    reg[..., :3] += noise[..., None]
    gy = np.linspace(1.10, 0.78, reg.shape[0])[:, None, None]
    reg[..., :3] = reg[..., :3] * gy
    arr[fy0:fy1, 12:948] = reg
    im.paste(Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA"))
    d = ImageDraw.Draw(im)
    # slab (between floors) thickness
    d.rectangle([0, y0 + FLOOR_END, W - 1, y0 + FH - 1], fill=C("#0a081c"))
    d.line([(0, y0 + FLOOR_END), (W - 1, y0 + FLOOR_END)], fill=rgba(acc))
    d.line([(0, y0 + FLOOR_END + 1), (W - 1, y0 + FLOOR_END + 1)], fill=rgba(accd))
    for xx in range(0, W, 32):
        d.line([(xx, y0 + FLOOR_END + 5), (xx, y0 + FH - 1)], fill=C("#13112d"))
    # ceiling light beams
    for lx in range(36, 940, 72):
        cs.glow(im, lx + 9, y0 + CEIL + 4, 30, 70, (190, 235, 255), 0.07, clip=(12, y0 + CEIL, 948, y0 + WB))
    cs.glow(im, 480, y0 + 150, 420, 50, acc, 0.07, clip=(12, y0 + WB, 948, y0 + FLOOR_END))


def elevator(im, f):
    """Elevator frame + shaft. The door leaves and inner light are drawn in JS (they open and close)."""
    y0 = f["y0"]
    th = THEMES[f["theme"]]
    d = ImageDraw.Draw(im)
    x0, x1 = ELEV_X0, ELEV_X1
    dy0, dy1 = y0 + ELEV_DOOR_TOP, y0 + WB
    d.rectangle([x0 - 8, y0 + CEIL, x1 + 7, y0 + WB - 1], fill=C("#0c0b1f"))
    d.rectangle([x0 - 4, dy0 - 14, x1 + 3, dy1], fill=cs.INK)
    d.rectangle([x0 - 3, dy0 - 13, x1 + 2, dy0 - 3], fill=C("#171433"))
    d.line([(x0 - 3, dy0 - 3), (x1 + 2, dy0 - 3)], fill=rgba(th["acc"]))
    d.rectangle([x0, dy0, x1 - 1, dy1 - 1], fill=C("#0a0916"))
    mid = (x0 + x1) // 2
    # shaft through the slab (cable)
    d.rectangle([x0 - 4, y0 + FLOOR_END, x1 + 3, y0 + FH - 1], fill=C("#07061a"))
    for cx in (x0 + 8, mid, x1 - 8):
        d.line([(cx, y0 + FLOOR_END), (cx, y0 + FH - 1)], fill=C("#2a2f54"))


def door(im, x0, y0, x1, y1, label="ENTRY", acc=(61, 242, 255)):
    d = ImageDraw.Draw(im)
    d.rectangle([x0 - 4, y0 - 15, x1 + 3, y1], fill=cs.INK)                 # sign is 3 px tall so the İ / Ş marks fit
    d.rectangle([x0 - 3, y0 - 14, x1 + 2, y0 - 2], fill=C("#171433"))
    d.line([(x0 - 3, y0 - 2), (x1 + 2, y0 - 2)], fill=rgba(acc))
    tw = cs.text_width(label)
    cs.draw_text(d, (x0 + x1) // 2 - tw // 2, y0 - 10, label, rgba(acc))
    d.rectangle([x0, y0, x1 - 1, y1 - 1], fill=C("#2a2f54"))
    mid = (x0 + x1) // 2
    d.rectangle([mid - 1, y0, mid, y1 - 1], fill=rgba(acc))
    for yy in range(y0 + 8, y1, 12):
        d.line([(x0 + 1, yy), (mid - 3, yy)], fill=C("#1d213f"))
        d.line([(mid + 2, yy), (x1 - 2, yy)], fill=C("#1d213f"))
    d.rectangle([x0, y0, x0 + 1, y1 - 1], fill=C("#3b4172"))
    d.rectangle([x1 - 2, y0, x1 - 1, y1 - 1], fill=C("#3b4172"))


def glass_wall(im, f, gx0, gx1, door_x0, door_x1):
    """Glass wall facing the balcony (transparent glass area) + balcony floor."""
    y0 = f["y0"]
    th = THEMES[f["theme"]]
    d = ImageDraw.Draw(im)
    top, base = y0 + CEIL, y0 + WB
    d.rectangle([gx0, top, gx1 - 1, base - 1], fill=cs.INK)
    punch(im, (gx0 + 6, top + 8, gx1 - 7, base - 9))
    d = ImageDraw.Draw(im)
    d.rectangle([gx0, top, gx1 - 1, top + 7], fill=C("#14112e"))
    d.line([(gx0, top + 8), (gx1 - 1, top + 8)], fill=rgba(th["acc"]))
    d.rectangle([gx0, base - 8, gx1 - 1, base - 1], fill=C("#14112e"))
    d.line([(gx0, base - 9), (gx1 - 1, base - 9)], fill=cs.MAGENTA_D)
    step = (gx1 - gx0) // 3
    for mx in (gx0, gx0 + step, door_x0 - 3, door_x1 - 3, gx1 - 6):
        d.rectangle([mx, top, mx + 5, base - 1], fill=cs.INK)
        d.line([(mx + 1, top + 9), (mx + 1, base - 10)], fill=C("#2b2766"))
    ImageDraw.Draw(im).rectangle([door_x0 + 3, base - 8, door_x1 - 4, base - 1], fill=(0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.line([(door_x0 + 3, base), (door_x1 - 4, base)], fill=rgba(th["accd"]))
    # balcony floor (grate): behind the wall
    fy0, fy1 = y0 + 80, base - 1
    x0, x1 = gx0 + 6, gx1 - 6
    d.rectangle([x0, fy0, x1 - 1, fy1], fill=C("#161528"))
    for yy in range(fy0, fy1, 4):
        d.line([(x0, yy), (x1 - 1, yy)], fill=C("#23233f"))
        d.line([(x0, yy + 1), (x1 - 1, yy + 1)], fill=C("#0e0d1d"))
    for xx in range(x0, x1, 12):
        d.line([(xx, fy0), (xx, fy1)], fill=C("#1c1b34"))
    d.rectangle([x0, fy0 - 2, x1 - 1, fy0 - 1], fill=C("#0a091a"))
    # railing
    rp = os.path.join(A, "f", "balcony_railing.png")
    if os.path.exists(rp):
        rail = Image.open(rp).convert("RGBA")
        arr = np.array(rail).astype(np.int16)
        light = (arr[..., 0] > 170) & (arr[..., 1] > 200) & (arr[..., 2] > 215) & (arr[..., 3] > 0)
        arr[light, 3] = 70
        rail = Image.fromarray(arr.astype(np.uint8), "RGBA")
        x = x0
        while x < x1:
            im.alpha_composite(rail, (x, fy0 + 2 - rail.height))
            x += rail.width - 6


def gallery_frames(im, f, th, xs, w=95, h=45, ytop=36):
    y0 = f["y0"]
    d = ImageDraw.Draw(im)
    out = []
    for fx in xs:
        d.rectangle([fx - 3, y0 + ytop - 3, fx + w + 2, y0 + ytop + h + 2], fill=cs.INK)
        d.rectangle([fx - 2, y0 + ytop - 2, fx + w + 1, y0 + ytop + h + 1], outline=rgba(th["accd"]))
        d.rectangle([fx, y0 + ytop, fx + w - 1, y0 + ytop + h - 1], fill=C("#070612"))
        out.append({"x": fx, "y": y0 + ytop, "w": w, "h": h})
    return out


# ----------------------------------------------------------------- floor types (each a separate 960x300 strip)
TYPES = {
    "mudur":   {"theme": "gold",    "name": "MANAGEMENT"},
    "kod":     {"theme": "cyan",    "name": "CODE & RESEARCH"},
    "tasarim": {"theme": "magenta", "name": "DESIGN STUDIO"},
    "galeri":  {"theme": "emerald", "name": "GALLERY"},
    "lobi":    {"theme": "violet",  "name": "LOBBY & LOUNGE"},
}
DEFAULT_ORDER = ["mudur", "kod", "tasarim", "galeri", "lobi"]

DESK_XS = [90 + 100 * i for i in range(8)]
DESK_YB = 188                      # local: bottom line of the desk
OFFICE = {"deskX": 330, "deskY": 208, "sideX": 430}
DESIGN_FRAMES_X = [70 + 106 * i for i in range(5)]          # design floor: the last 5 works
GALLERY_WALL_X = [28 + 106 * i for i in range(8)]            # gallery floor: 8 frames on the wall
GALLERY_PODIUMS = [{"x": 110 + 140 * i, "y": 214} for i in range(6)]   # gallery floor: 6 holo podiums on the floor
LOBBY = {
    "sofa": {"x": 490, "y": 176, "seats": [-26, 0, 26]},
    "table": {"x": 490, "y": 238},
    "armchairs": [{"x": 396, "y": 240}, {"x": 584, "y": 240}],
    "lamps": [{"x": 438, "y": 182}, {"x": 542, "y": 182}],
    "arcade": {"x": 672, "y": 202},
    "vape": {"x": 846, "y": 106},
    "balconySpots": [{"x": 736, "y": 100}, {"x": 800, "y": 102}, {"x": 824, "y": 96}, {"x": 842, "y": 100}],
    "balconyDoor": [794, 122],
    "door": [49, 126],
    "reception": {"x": 168, "y": 176},
    "frontLane": 198,
    "sideX": 420,
    "rug": [338, 148, 642, 256],
    "board": {"x0": 100, "y0": 34, "x1": 226, "y1": 82},
}


def new_strip(kind):
    theme = TYPES[kind]["theme"]
    im = Image.new("RGBA", (W, FH), (0, 0, 0, 0))
    f = {"theme": theme, "y0": 0, "i": 0}
    floor_shell(im, f)
    elevator(im, f)
    return im, f, THEMES[theme]


def strip_mudur():
    im, f, th = new_strip("mudur")
    acc = th["acc"]
    holes = [window(im, 250, 34, 410, 80, acc), window(im, 600, 34, 760, 80, acc)]
    dx = OFFICE["deskX"]
    rug(im, dx - 130, 150, dx + 130, 262, "#3a2a1c", rgba(acc, 200), "#6a4a24", "#4a3520")
    for (name, cx, by) in (("shelf_unit", 50, 128), ("coffee_machine", 116, 128), ("trophy_case", 176, 130), ("plant_tall", 478, 132)):
        paste(im, name, cx, by)
    for k in (-44, 44):                                     # visitor chairs
        paste(im, "chair_small", dx + k, 244)
    # rest corner (decoration): rug, couch, side table, lamps
    rug(im, 560, 150, 770, 258, "#2a1f4a", rgba(acc, 160), "#4a3a7a", "#3a2c63")
    paste(im, "sofa_a", 660, 176)
    paste(im, "coffee_table", 660, 234)
    paste(im, "floor_lamp", 584, 184)
    paste(im, "floor_lamp", 736, 184)
    paste(im, "plant_tall", 826, 132)
    paste(im, "trophy_case", 794, 130)
    return im, holes, {}


def strip_kod():
    im, f, th = new_strip("kod")
    acc = th["acc"]
    holes = [window(im, 130, 34, 290, 80, acc), window(im, 560, 34, 720, 80, acc)]
    carpet(im, 30, 124, 846, 236, acc)
    for (name, cx, by) in (("plant_tall", 40, 132), ("whiteboard", 372, 128), ("shelf_unit", 470, 128),
                           ("server_rack", 744, 128), ("server_rack", 776, 128), ("printer", 822, 128), ("boxes", 854, 130)):
        paste(im, name, cx, by)
    paste(im, "poster_robot", 330, 88, shade=False)
    paste(im, "poster_synth", 640, 90, shade=False)
    return im, holes, {}


def strip_tasarim():
    im, f, th = new_strip("tasarim")
    acc = th["acc"]
    holes = [window(im, 700, 34, 820, 80, acc)]
    carpet(im, 30, 124, 846, 236, acc)
    frames = gallery_frames(im, f, th, DESIGN_FRAMES_X, w=96, h=45, ytop=36)
    for (name, cx, by) in (("plant_tall", 36, 132), ("shelf_unit", 654, 128), ("easel", 856, 178), ("plant_tall", 826, 132)):
        paste(im, name, cx, by)
    return im, holes, {"gallery": frames, "easel": {"x": 856, "y": 178}}


def podium(im, cx, by, acc):
    """Holo podium: box body + neon edge. The holo frame on top is drawn by JS."""
    d = ImageDraw.Draw(im)
    cs.shadow(im, cx, by + 1, 64, 6, 110)
    x0, x1 = cx - 26, cx + 25
    d.rectangle([x0, by - 18, x1, by - 1], fill=C("#1b1936"))
    d.rectangle([x0, by - 18, x1, by - 14], fill=C("#2c2a58"))
    d.line([(x0, by - 18), (x1, by - 18)], fill=rgba(acc))
    d.line([(x0, by - 1), (x1, by - 1)], fill=rgba(acc, 150))
    d.rectangle([x0, by - 18, x0 + 1, by - 1], fill=C("#13122b"))
    d.rectangle([x1 - 1, by - 18, x1, by - 1], fill=C("#13122b"))
    d.rectangle([cx - 6, by - 10, cx + 5, by - 8], fill=rgba(acc, 220))
    cs.glow(im, cx, by - 19, 26, 8, acc, 0.35)


def strip_galeri():
    im, f, th = new_strip("galeri")
    acc = th["acc"]
    d = ImageDraw.Draw(im)
    frames = gallery_frames(im, f, th, GALLERY_WALL_X, w=100, h=50, ytop=34)
    for fr in frames:                                         # spotlight above the frame
        cx = fr["x"] + fr["w"] // 2
        d.rectangle([cx - 14, 24, cx + 13, 27], fill=cs.INK)
        d.rectangle([cx - 12, 25, cx + 11, 26], fill=rgba(acc, 200))
        cs.glow(im, cx, 56, 56, 40, (255, 255, 235), 0.10, clip=(fr["x"] - 8, 28, fr["x"] + fr["w"] + 8, 92))
    # long dark rug on the floor + podiums
    rug(im, 50, 150, 860, 252, "#0f2c2a", rgba(acc, 170), "#1d4a44", "#15403a")
    for p in GALLERY_PODIUMS:
        podium(im, p["x"], p["y"], acc)
    for (name, cx, by) in (("plant_tall", 34, 134), ("plant_tall", 858, 134), ("bench", 330, 262), ("bench", 600, 262)):
        paste(im, name, cx, by, shade=(name != "bench"))
    return im, [], {"wall": frames, "podiums": GALLERY_PODIUMS}


def strip_lobi():
    im, f, th = new_strip("lobi")
    acc = th["acc"]
    door(im, 26, 36, 72, WB, "ENTRY", acc)
    rx0, ry0, rx1, ry1 = LOBBY["rug"]
    rug(im, rx0, ry0, rx1, ry1, "#3a1d63", cs.MAGENTA, "#6a2f9e", "#4f2a82")
    cs.glow(im, (rx0 + rx1) // 2, (ry0 + ry1) // 2, 190, 80, cs.MAGENTA, 0.10, clip=(rx0, ry0, rx1, ry1))
    holes = [window(im, 424, 34, 536, 80, acc)]
    for (name, cx, by) in (("vending", 262, 130), ("coffee_machine", 306, 128), ("water_cooler", 338, 128), ("plant_tall", 376, 132)):
        paste(im, name, cx, by)
    paste(im, "poster_synth", 592, 90, shade=False)
    paste(im, "poster_robot", 644, 90, shade=False)
    glass_wall(im, f, 700, 868, 770, 818)
    holes.append((706, 22, 862, WB - 9))
    paste(im, "bench", 735, WB - 2, shade=False)
    paste(im, "reception_desk", LOBBY["reception"]["x"], LOBBY["reception"]["y"])
    return im, holes, {}


BUILDERS = {"mudur": strip_mudur, "kod": strip_kod, "tasarim": strip_tasarim, "galeri": strip_galeri, "lobi": strip_lobi}


def glassfx_strip(holes):
    fx = Image.new("RGBA", (W, FH), (0, 0, 0, 0))
    d = ImageDraw.Draw(fx)
    mask = Image.new("L", (W, FH), 0)
    md = ImageDraw.Draw(mask)
    for (x0, y0, x1, y1) in holes:
        for off in range(-(y1 - y0), (x1 - x0), 38):
            d.line([(x0 + off, y1), (x0 + off + (y1 - y0), y0)], fill=(255, 255, 255, 14), width=5)
            d.line([(x0 + off + 9, y1), (x0 + off + 9 + (y1 - y0), y0)], fill=(255, 255, 255, 9), width=2)
        md.rectangle([x0, y0, x1 - 1, y1 - 1], fill=255)
    fx.putalpha(Image.fromarray(np.minimum(np.array(fx.getchannel("A")), np.array(mask)).astype(np.uint8)))
    return fx


def main():
    cs.key_near()
    out = os.path.join(A, "bg")
    os.makedirs(out, exist_ok=True)
    S = {"W": W, "top": TOP, "fh": FH, "bot": BOT, "ceil": CEIL, "wb": WB, "floorEnd": FLOOR_END, "lane": LANE,
         "elev": {"x0": ELEV_X0, "x1": ELEV_X1, "cx": (ELEV_X0 + ELEV_X1) // 2, "doorTop": ELEV_DOOR_TOP, "inY": 122, "frontY": 160},
         "desk": {"w": 80, "h": 57, "screen": [27, 2, 27, 15], "chairX": 30, "chairY": 43},
         "types": {}}
    strips = {}
    for kind, build in BUILDERS.items():
        im, holes, extra = build()
        im.save(os.path.join(out, "floor_%s.png" % kind), optimize=True)
        glassfx_strip(holes).save(os.path.join(out, "floor_%s_glass.png" % kind), optimize=True)
        strips[kind] = im
        T = {"name": TYPES[kind]["name"], "theme": TYPES[kind]["theme"], "acc": list(THEMES[TYPES[kind]["theme"]]["acc"]),
             "windows": [list(h) for h in holes]}
        T.update(extra)
        if kind in ("kod", "tasarim"):
            T["desks"] = [{"x": x, "y": DESK_YB} for x in DESK_XS]
        if kind == "mudur":
            T["office"] = dict(OFFICE)
            T["ambient"] = {"coffee": [116]}
        if kind == "kod":
            T["ambient"] = {"racks": [744, 776]}
        if kind == "lobi":
            T.update({k: v for k, v in LOBBY.items()})
            T["ambient"] = {"coffee": [306]}
        S["types"][kind] = T
    with open(os.path.join(HERE, "scene.json"), "w", encoding="utf-8") as fh:
        json.dump(S, fh, ensure_ascii=False, indent=1)
    # preview: stack in the default order + sky behind the windows
    os.makedirs(os.path.join(HERE, "_work"), exist_ok=True)
    far = Image.open(os.path.join(out, "skyline_far.png")).convert("RGBA")
    near = Image.open(os.path.join(out, "skyline_near_keyed.png")).convert("RGBA")
    n = len(DEFAULT_ORDER)
    prev = Image.new("RGBA", (W, TOP + n * FH + BOT), (10, 8, 30, 255))
    for i, kind in enumerate(DEFAULT_ORDER):
        y = TOP + i * FH
        for layer, oy in ((far, 0), (near, 34)):
            x = 0
            flip = False
            while x < W:
                t = layer.transpose(Image.FLIP_LEFT_RIGHT) if flip else layer
                prev.alpha_composite(t.crop((0, 0, t.width, min(t.height, FH - oy))), (x, y + oy))
                x += layer.width
                flip = not flip
        prev.alpha_composite(strips[kind], (0, y))
        prev.alpha_composite(Image.open(os.path.join(out, "floor_%s_glass.png" % kind)), (0, y))
    prev.save(os.path.join(HERE, "_work", "preview_tower.png"))
    print("tamam", {k: v.size for k, v in strips.items()})


if __name__ == "__main__":
    main()
