"""NorthLight Tower — theme compiler.

  python compose_theme.py western        (single theme)       python compose_theme.py all
  python compose_theme.py western --preview               (stacks the floor strips and writes _work/theme_preview_western.png)

For each theme, with EXACTLY the same layout and sizes as cyberpunk (compose_tower.py constants), it produces:
  assets/themes/<id>/bg/floor_<type>.png  + floor_<type>_glass.png   (960x300 floor strips)
  assets/themes/<id>/f/monitor.png       (46x32, a 38x22 hole in the middle: the screen is drawn by code)
  assets/themes/<id>/f/exec_device.png   (30x16, a 24x13 hole in the middle: the device on the manager's desk)
  assets/themes/<id>/theme.json          (colors, names, sky, `files` list)
Furniture (assets/themes/<id>/f/*.png) is generated with PixelLab (tools/theme_sprites.py); a missing piece comes from cyberpunk.
Window openings and desk/frame positions are the same as scene.json: scene.json is NOT TOUCHED.
"""
import json
import os
import random
import sys

import numpy as np
from PIL import Image, ImageDraw

import compose_shell as cs
import compose_tower as ct
import theme_defs as TD

HERE = os.path.dirname(os.path.abspath(__file__))
A = os.path.join(HERE, "assets")
W, FH, CEIL, WB, FLOOR_END = ct.W, ct.FH, ct.CEIL, ct.WB, ct.FLOOR_END
hx = cs.C


def rgba(t, a=255):
    return (t[0], t[1], t[2], a)


def mix(c1, c2, k):
    """mixes two '#rrggbb' colors (k=0 → c1, 1 → c2)"""
    a, b = cs.C(c1), cs.C(c2)
    return tuple(int(a[i] + (b[i] - a[i]) * k) for i in range(3)) + (255,)


class Ctx:
    """Drawing context for a single theme (fixed randomness: the same image on every run)."""

    def __init__(self, th):
        self.th = th
        self.id = th["id"]
        self.rng = random.Random(hash(th["id"]) & 0xffff)
        self.fdir = os.path.join(A, "themes", self.id, "f")

    def sprite_path(self, name):
        p = os.path.join(self.fdir, name + ".png")
        return p if os.path.exists(p) else os.path.join(A, "f", name + ".png")


def punch(im, box):
    ImageDraw.Draw(im).rectangle(box, fill=(0, 0, 0, 0))


def paste(c, im, name, cx, by, shade=True):
    p = c.sprite_path(name)
    if not os.path.exists(p):
        print("yok:", name)
        return None
    s = Image.open(p).convert("RGBA")
    if shade:
        cs.shadow(im, cx, by, s.width + 6)
    im.alpha_composite(s, (int(cx - s.width // 2), int(by - s.height)))
    return s


# ------------------------------------------------------------------------------------------------ wall textures
def tex_wall(c, im, y0):
    w = c.th["wall"]
    rng = c.rng
    d = ImageDraw.Draw(im)
    X0, X1, Y0, Y1 = 12, 947, y0 + CEIL, y0 + WB - 1
    wA, wB, seam, hi = hx(w["wA"]), hx(w["wB"]), hx(w["seam"]), hx(w["hi"])
    st = w["style"]
    if st == "planks":                                              # vertical plank
        bw = 14
        for i, bx in enumerate(range(X0, X1 + 1, bw)):
            col = mix(w["wA"], w["wB"], 0.0 if (i * 5 + i // 4) % 3 else 1.0)
            if (i % 7) == 3:
                col = mix(w["wA"], w["seam"], 0.25)
            d.rectangle([bx, Y0, min(bx + bw - 1, X1), Y1], fill=col)
            d.line([(bx, Y0), (bx, Y1)], fill=seam)
            d.line([(bx + 1, Y0), (bx + 1, Y1 - 24)], fill=hi)
            for _ in range(rng.randint(1, 3)):                      # wood grain
                gx = bx + rng.randint(3, bw - 3)
                gy = rng.randint(Y0 + 4, Y1 - 34)
                d.line([(gx, gy), (gx, gy + rng.randint(5, 12))], fill=seam)
            if rng.random() < 0.35:                                 # knot
                kx, ky = bx + rng.randint(4, bw - 5), rng.randint(Y0 + 10, Y1 - 40)
                d.ellipse([kx, ky, kx + 2, ky + 3], fill=seam)
            for ny in (Y0 + 8, Y1 - 28):                            # nail
                d.point((bx + bw // 2, ny), fill=hi)
    elif st in ("stone", "brick"):
        rh = 14 if st == "stone" else 7
        bwset = (24, 28, 32, 40) if st == "stone" else (14,)
        for r, ry in enumerate(range(Y0, Y1 + 1, rh)):
            x = X0 - (rng.randint(0, 20) if st == "stone" else (7 if r % 2 else 0))
            while x < X1:
                bw = rng.choice(bwset)
                col = mix(w["wA"], w["wB"], rng.random())
                col = tuple(int(max(0, min(255, v + rng.randint(-5, 5)))) for v in col[:3]) + (255,)
                d.rectangle([max(x, X0), ry, min(x + bw - 1, X1), min(ry + rh - 1, Y1)], fill=col)
                d.line([(max(x, X0), ry), (min(x + bw - 1, X1), ry)], fill=hi)
                d.line([(x, ry), (x, min(ry + rh - 1, Y1))], fill=seam)
                d.line([(max(x, X0), min(ry + rh - 1, Y1)), (min(x + bw - 1, X1), min(ry + rh - 1, Y1))], fill=seam)
                x += bw
    elif st == "stripes":                                           # wallpaper stripes + motif
        for i, bx in enumerate(range(X0, X1 + 1, 10)):
            d.rectangle([bx, Y0, min(bx + 9, X1), Y1], fill=wB if i % 2 else wA)
            d.line([(bx, Y0), (bx, Y1)], fill=seam)
        for gy in range(Y0 + 8, Y1 - 24, 22):
            for gx in range(X0 + 10, X1, 40):
                d.polygon([(gx, gy - 3), (gx + 3, gy), (gx, gy + 3), (gx - 3, gy)], fill=hi)
    elif st == "shoji":                                             # paper panel + wooden lattice
        d.rectangle([X0, Y0, X1, Y1], fill=wB)
        for bx in range(X0, X1, 112):
            for k in range(0, 112, 28):                             # vertical lattice
                if bx + k < X1:
                    d.rectangle([bx + k, Y0, bx + k + 1, Y1], fill=seam)
            for ky in (Y0 + (Y1 - Y0) // 3, Y0 + 2 * (Y1 - Y0) // 3):
                d.rectangle([bx, ky, min(bx + 111, X1), ky + 1], fill=seam)
            d.rectangle([bx, Y0, bx + 3, Y1], fill=seam)            # thick post
            d.line([(bx + 4, Y0), (bx + 4, Y1)], fill=hi)
        for _ in range(260):                                        # paper fiber
            px, py = rng.randint(X0, X1), rng.randint(Y0, Y1 - 24)
            d.point((px, py), fill=hi)
    else:                                                           # plates: riveted panel
        for i, px in enumerate(range(X0, X1 + 1, 56)):
            d.rectangle([px, Y0, min(px + 55, X1), Y1], fill=wA if i % 2 else wB)
            d.line([(px, Y0), (px, Y1)], fill=seam)
            d.line([(px + 1, Y0), (px + 1, Y1 - 24)], fill=hi)
            for rv in (Y0 + 5, Y1 - 28):
                for rx in (px + 5, px + 50):
                    d.rectangle([rx, rv, rx + 1, rv + 1], fill=hi)
        for ry in (Y0 + 28, Y0 + 56):
            d.line([(X0, ry), (X1, ry)], fill=seam)


def tex_floor(c, im, y0):
    f = c.th["floor"]
    rng = c.rng
    d = ImageDraw.Draw(im)
    X0, X1, Y0, Y1 = 12, 947, y0 + WB + 1, y0 + FLOOR_END - 1
    fA, fB, seam, hi = f["fA"], f["fB"], hx(f["seam"]), hx(f["hi"])
    st = f["style"]
    if st == "planks":                                              # horizontal plank
        rh = 10
        for r, ry in enumerate(range(Y0, Y1 + 1, rh)):
            x = X0 - rng.randint(0, 60)
            while x < X1:
                bw = rng.randint(70, 130)
                col = mix(fA, fB, rng.random())
                d.rectangle([max(x, X0), ry, min(x + bw - 1, X1), min(ry + rh - 1, Y1)], fill=col)
                d.line([(max(x, X0), ry), (min(x + bw - 1, X1), ry)], fill=hi)
                d.line([(x, ry), (x, min(ry + rh - 1, Y1))], fill=seam)
                if rng.random() < 0.5:
                    gy = ry + rng.randint(3, 7)
                    gx = x + rng.randint(6, bw - 24)
                    d.line([(gx, gy), (gx + rng.randint(8, 20), gy)], fill=mix(fA, f["seam"], 0.45))
                x += bw
            d.line([(X0, min(ry + rh - 1, Y1)), (X1, min(ry + rh - 1, Y1))], fill=seam)
    elif st == "flagstone":
        rh = 20
        for r, ry in enumerate(range(Y0, Y1 + 1, rh)):
            x = X0 - rng.randint(0, 40)
            while x < X1:
                bw = rng.randint(34, 70)
                col = mix(fA, fB, rng.random())
                if x + bw - 1 < X0:
                    x += bw
                    continue
                d.rectangle([max(x, X0), ry, min(x + bw - 1, X1), min(ry + rh - 1, Y1)], fill=col)
                d.line([(max(x, X0), ry), (min(x + bw - 1, X1), ry)], fill=hi)
                d.line([(x, ry), (x, min(ry + rh - 1, Y1))], fill=seam)
                x += bw
            d.line([(X0, min(ry + rh - 1, Y1)), (X1, min(ry + rh - 1, Y1))], fill=seam)
    elif st == "checker":
        for ty in range(Y0, Y1 + 1, 20):
            for tx in range(X0, X1 + 1, 20):
                alt = ((tx // 20) + ((ty - y0) // 20)) % 2
                d.rectangle([tx, ty, min(tx + 19, X1), min(ty + 19, Y1)], fill=hx(fB if alt else fA))
                d.line([(tx, ty), (min(tx + 19, X1), ty)], fill=hi)
                d.line([(tx, ty), (tx, min(ty + 19, Y1))], fill=seam)
    elif st == "grate":                                             # steel / brass plate
        for ty in range(Y0, Y1 + 1, 20):
            for tx in range(X0, X1 + 1, 20):
                alt = ((tx // 20) + ((ty - y0) // 20)) % 2
                d.rectangle([tx, ty, min(tx + 19, X1), min(ty + 19, Y1)], fill=hx(fB if alt else fA))
                d.rectangle([tx, ty, min(tx + 19, X1), min(ty + 19, Y1)], outline=seam)
                d.line([(tx + 1, ty + 1), (min(tx + 18, X1), ty + 1)], fill=hi)
                for bx, by in ((tx + 2, ty + 2), (tx + 17, ty + 2), (tx + 2, ty + 17), (tx + 17, ty + 17)):
                    d.point((bx, by), fill=hi)
                if alt:
                    for gy in range(ty + 6, ty + 15, 3):
                        d.line([(tx + 5, gy), (tx + 14, gy)], fill=seam)
    elif st == "tatami":
        for my, ry in enumerate(range(Y0, Y1 + 1, 40)):
            for mx, rx in enumerate(range(X0, X1 + 1, 80)):
                vertical = (mx + my) % 2
                col = mix(fA, fB, ((mx * 3 + my) % 4) / 3.0)
                bw, bh = (40, 80) if vertical else (80, 40)
                d.rectangle([rx, ry, min(rx + 79, X1), min(ry + 39, Y1)], fill=col)
                d.rectangle([rx, ry, min(rx + 79, X1), min(ry + 39, Y1)], outline=seam)
                d.line([(rx + 1, ry + 1), (min(rx + 78, X1), ry + 1)], fill=hi)
                step = 3
                if vertical:
                    for gx in range(rx + 3, min(rx + 77, X1), step):
                        d.line([(gx, ry + 3), (gx, min(ry + 37, Y1))], fill=mix(f["fA"], f["seam"], 0.22))
                else:
                    for gy in range(ry + 4, min(ry + 37, Y1), step):
                        d.line([(rx + 3, gy), (min(rx + 76, X1), gy)], fill=mix(f["fA"], f["seam"], 0.22))
    else:                                                           # tiles 40x20
        for ty in range(Y0, Y1 + 1, 20):
            for tx in range(X0, X1 + 1, 40):
                alt = ((tx // 40) + ((ty - y0) // 20)) % 2
                d.rectangle([tx, ty, min(tx + 39, X1), min(ty + 19, Y1)], fill=hx(fB if alt else fA))
                d.line([(tx, ty), (min(tx + 39, X1), ty)], fill=hi)
                d.line([(tx, ty), (tx, min(ty + 19, Y1))], fill=seam)
    # depth shadow + fine noise (same as cyberpunk)
    arr = np.array(im).astype(np.int16)
    fy0, fy1 = y0 + WB + 1, y0 + FLOOR_END
    reg = arr[fy0:fy1, 12:948]
    noise = np.random.RandomState(7).randint(-3, 4, size=reg.shape[:2])
    reg[..., :3] += noise[..., None]
    gy = np.linspace(1.10, 0.78, reg.shape[0])[:, None, None]
    reg[..., :3] = reg[..., :3] * gy
    arr[fy0:fy1, 12:948] = reg
    im.paste(Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA"))


def draw_lamp(c, im, cx, y0):
    cl = c.th["ceil"]
    d = ImageDraw.Draw(im)
    col, dark = hx(cl["lamp_color"]), hx(cl["line"])
    st = cl["lamp"]
    top = y0 + 4
    if st == "panel":
        d.rectangle([cx - 9, y0 + 5, cx + 9, y0 + 7], fill=col)
    elif st == "lantern":
        d.line([(cx, y0), (cx, top)], fill=dark)
        d.rectangle([cx - 3, top, cx + 3, top + 1], fill=dark)
        d.rectangle([cx - 3, top + 2, cx + 3, top + 9], fill=col)
        d.rectangle([cx - 3, top + 2, cx + 3, top + 9], outline=dark)
        d.line([(cx, top + 2), (cx, top + 9)], fill=dark)
        d.rectangle([cx - 4, top + 10, cx + 4, top + 10], fill=dark)
    elif st == "bulb":
        d.line([(cx, y0), (cx, y0 + 5)], fill=dark)
        d.rectangle([cx - 1, y0 + 5, cx + 1, y0 + 6], fill=dark)
        d.ellipse([cx - 3, y0 + 6, cx + 3, y0 + 12], fill=col)
        d.point((cx - 1, y0 + 8), fill=hx("#ffffff"))
    elif st == "paper":
        d.line([(cx, y0), (cx, top)], fill=dark)
        d.ellipse([cx - 6, top, cx + 6, top + 10], fill=col)
        d.ellipse([cx - 6, top, cx + 6, top + 10], outline=dark)
        for rx in (-3, 0, 3):
            d.line([(cx + rx, top + 1), (cx + rx, top + 9)], fill=mix(cl["lamp_color"], cl["line"], 0.45))
        d.rectangle([cx - 3, top - 1, cx + 3, top], fill=dark)
    elif st == "caged":
        d.line([(cx, y0), (cx, y0 + 4)], fill=dark)
        d.rectangle([cx - 5, y0 + 5, cx + 5, y0 + 10], outline=hx("#6a705a"))
        d.rectangle([cx - 2, y0 + 6, cx + 2, y0 + 9], fill=col)
        d.line([(cx, y0 + 5), (cx, y0 + 10)], fill=hx("#6a705a"))
    elif st == "crystal":
        d.line([(cx, y0), (cx, y0 + 3)], fill=dark)
        d.polygon([(cx, y0 + 3), (cx + 4, y0 + 8), (cx, y0 + 14), (cx - 4, y0 + 8)], fill=col)
        d.line([(cx, y0 + 4), (cx - 2, y0 + 8)], fill=hx("#ffffff"))


def floor_shell(c, im, f):
    th = c.th
    y0 = f["y0"]
    acc = th["acc"][f["kind"]]
    accd = tuple(int(v * 0.62) for v in acc)
    d = ImageDraw.Draw(im)
    sd = th["side"]
    d.rectangle([0, y0, 11, y0 + FH - 1], fill=hx(sd["color"]))
    d.rectangle([948, y0, 959, y0 + FH - 1], fill=hx(sd["color"]))
    d.line([(11, y0 + CEIL), (11, y0 + FH - 14)], fill=hx(sd["line"], 170))
    d.line([(948, y0 + CEIL), (948, y0 + FH - 14)], fill=hx(sd["line"], 170))
    tex_wall(c, im, y0)
    d = ImageDraw.Draw(im)
    dd = th["dado"]
    d.rectangle([12, y0 + WB - 22, 947, y0 + WB - 1], fill=hx(dd["color"]))
    for px in range(12, 948, 40):                                   # wainscot panels
        d.rectangle([px + 3, y0 + WB - 19, px + 36, y0 + WB - 6], outline=hx(dd["line"]))
        d.line([(px + 4, y0 + WB - 18), (px + 35, y0 + WB - 18)], fill=mix(dd["color"], "#ffffff", 0.10))
    d.rectangle([12, y0 + WB - 24, 947, y0 + WB - 23], fill=hx(dd["trim"]))
    d.line([(12, y0 + WB - 22), (947, y0 + WB - 22)], fill=rgba(acc, 200))
    cl = th["ceil"]
    d.rectangle([12, y0, 947, y0 + CEIL - 1], fill=hx(cl["color"]))
    d.line([(12, y0 + CEIL - 1), (947, y0 + CEIL - 1)], fill=hx(cl["line"]))
    for bx in range(12, 948, 120):                                  # ceiling beam
        d.rectangle([bx, y0, bx + 3, y0 + CEIL - 2], fill=hx(cl["line"]))
    for lx in range(36, 940, 72):
        draw_lamp(c, im, lx + 9, y0)
    d = ImageDraw.Draw(im)
    d.rectangle([12, y0 + WB - 4, 947, y0 + WB - 1], fill=mix(dd["color"], "#000000", 0.4))
    d.line([(12, y0 + WB), (947, y0 + WB)], fill=mix(dd["line"], "#000000", 0.4))
    tex_floor(c, im, y0)
    d = ImageDraw.Draw(im)
    # thickness of the slab between floors
    slab = mix(sd["color"], "#000000", 0.25)
    d.rectangle([0, y0 + FLOOR_END, W - 1, y0 + FH - 1], fill=slab)
    d.line([(0, y0 + FLOOR_END), (W - 1, y0 + FLOOR_END)], fill=rgba(acc))
    d.line([(0, y0 + FLOOR_END + 1), (W - 1, y0 + FLOOR_END + 1)], fill=rgba(accd))
    for xx in range(0, W, 32):
        d.line([(xx, y0 + FLOOR_END + 5), (xx, y0 + FH - 1)], fill=mix(sd["color"], "#ffffff", 0.07))
    gcol = cl["glow"]
    for lx in range(36, 940, 72):
        cs.glow(im, lx + 9, y0 + CEIL + 4, 30, 70, gcol, 0.07, clip=(12, y0 + CEIL, 948, y0 + WB))
    cs.glow(im, 480, y0 + 150, 420, 50, acc, 0.06, clip=(12, y0 + WB, 948, y0 + FLOOR_END))


def elevator(c, im, f):
    y0 = f["y0"]
    e = c.th["elev"]
    acc = c.th["acc"][f["kind"]]
    d = ImageDraw.Draw(im)
    x0, x1 = ct.ELEV_X0, ct.ELEV_X1
    dy0, dy1 = y0 + ct.ELEV_DOOR_TOP, y0 + WB
    body, top, door = hx(e["body"]), hx(e["top"]), hx(e["door"])
    d.rectangle([x0 - 8, y0 + CEIL, x1 + 7, y0 + WB - 1], fill=mix(e["body"], "#ffffff", 0.05))
    d.rectangle([x0 - 4, dy0 - 14, x1 + 3, dy1], fill=body)
    d.rectangle([x0 - 3, dy0 - 13, x1 + 2, dy0 - 3], fill=top)
    d.line([(x0 - 3, dy0 - 3), (x1 + 2, dy0 - 3)], fill=rgba(acc))
    d.rectangle([x0, dy0, x1 - 1, dy1 - 1], fill=door)
    mid = (x0 + x1) // 2
    d.rectangle([x0 - 4, y0 + FLOOR_END, x1 + 3, y0 + FH - 1], fill=mix(e["body"], "#000000", 0.4))
    for cx in (x0 + 8, mid, x1 - 8):
        d.line([(cx, y0 + FLOOR_END), (cx, y0 + FH - 1)], fill=hx(e["pole"]))


def window(c, im, x0, y0, x1, y1):
    wd = c.th["window"]
    d = ImageDraw.Draw(im)
    frame, trim = hx(wd["frame"]), hx(wd["trim"])
    d.rectangle([x0 - 5, y0 - 5, x1 + 4, y1 + 4], fill=frame)
    d.rectangle([x0 - 4, y0 - 4, x1 + 3, y1 + 3], outline=trim)
    punch(im, (x0, y0, x1 - 1, y1 - 1))
    d = ImageDraw.Draw(im)
    mx = (x0 + x1) // 2
    st = wd["mullion"]
    r = wd.get("radius", 0)
    if r:                                                           # rounded corner (capsule window)
        for k in range(r):
            inset = r - int(round((r * r - (r - k) ** 2) ** 0.5)) if k < r else 0
            for (xa, xb, yy) in ((x0, x0 + inset, y0 + k), (x1 - 1 - inset, x1 - 1, y0 + k), (x0, x0 + inset, y1 - 1 - k), (x1 - 1 - inset, x1 - 1, y1 - 1 - k)):
                if inset > 0:
                    d.rectangle([xa, yy, xb, yy], fill=frame)
    if st == "cross":
        d.rectangle([mx - 2, y0, mx + 1, y1 - 1], fill=frame)
        my = y0 + (y1 - y0) * 3 // 5
        d.rectangle([x0, my - 1, x1 - 1, my], fill=frame)
    elif st == "arch":                                              # pointed arch: fill at the top corners + center mullion
        h = min(16, (y1 - y0) // 2)
        for k in range(h):
            inset = int((x1 - x0) / 2 * (1 - ((k + 1) / h) ** 0.55)) if k < h else 0
            inset = min(inset, (x1 - x0) // 2 - 3)
            d.rectangle([x0, y0 + k, x0 + max(0, inset), y0 + k], fill=frame)
            d.rectangle([x1 - 1 - max(0, inset), y0 + k, x1 - 1, y0 + k], fill=frame)
        d.rectangle([mx - 1, y0, mx, y1 - 1], fill=frame)
        my = y0 + (y1 - y0) * 3 // 5
        d.rectangle([x0, my - 1, x1 - 1, my], fill=frame)
    elif st == "blinds":                                            # blinds: horizontal slats
        for sy in range(y0 + 1, y1 - 1, 5):
            d.rectangle([x0, sy, x1 - 1, sy + 1], fill=frame[:3] + (232,))
        d.rectangle([x0, y0, x1 - 1, y0 + 1], fill=frame)
    elif st == "grid":                                              # shoji lattice
        for gx in range(x0 + 40, x1, 40):
            d.rectangle([gx - 1, y0, gx, y1 - 1], fill=frame)
        d.rectangle([x0, (y0 + y1) // 2 - 1, x1 - 1, (y0 + y1) // 2], fill=frame)
    d.rectangle([x0 - 9, y1 + 5, x1 + 8, y1 + 8], fill=hx(wd["sill"]))
    d.line([(x0 - 9, y1 + 5), (x1 + 8, y1 + 5)], fill=hx(wd["sill_hi"]))
    return (x0, y0, x1, y1)


def door(c, im, x0, y0, x1, y1, label, acc):
    ld, e = c.th["lobby_door"], c.th["elev"]
    d = ImageDraw.Draw(im)
    d.rectangle([x0 - 4, y0 - 15, x1 + 3, y1], fill=hx(e["body"]))
    d.rectangle([x0 - 3, y0 - 14, x1 + 2, y0 - 2], fill=hx(e["top"]))
    d.line([(x0 - 3, y0 - 2), (x1 + 2, y0 - 2)], fill=rgba(acc))
    tw = cs.text_width(label)
    cs.draw_text(d, (x0 + x1) // 2 - tw // 2, y0 - 10, label, rgba(acc))
    d.rectangle([x0, y0, x1 - 1, y1 - 1], fill=hx(ld["body"]))
    mid = (x0 + x1) // 2
    d.rectangle([mid - 1, y0, mid, y1 - 1], fill=hx(ld["edge"]))
    for yy in range(y0 + 8, y1, 12):
        d.line([(x0 + 1, yy), (mid - 3, yy)], fill=hx(ld["line"]))
        d.line([(mid + 2, yy), (x1 - 2, yy)], fill=hx(ld["line"]))
    d.rectangle([x0, y0, x0 + 1, y1 - 1], fill=mix(ld["body"], "#ffffff", 0.18))
    d.rectangle([x1 - 2, y0, x1 - 1, y1 - 1], fill=mix(ld["body"], "#ffffff", 0.18))


def glass_wall(c, im, f, gx0, gx1, door_x0, door_x1):
    y0 = f["y0"]
    g = c.th["glass"]
    acc = c.th["acc"][f["kind"]]
    d = ImageDraw.Draw(im)
    top, base = y0 + CEIL, y0 + WB
    frame, line = hx(g["frame"]), hx(g["line"])
    d.rectangle([gx0, top, gx1 - 1, base - 1], fill=frame)
    punch(im, (gx0 + 6, top + 8, gx1 - 7, base - 9))
    d = ImageDraw.Draw(im)
    d.rectangle([gx0, top, gx1 - 1, top + 7], fill=hx(g["base"]))
    d.line([(gx0, top + 8), (gx1 - 1, top + 8)], fill=rgba(acc))
    d.rectangle([gx0, base - 8, gx1 - 1, base - 1], fill=hx(g["base"]))
    d.line([(gx0, base - 9), (gx1 - 1, base - 9)], fill=rgba(tuple(int(v * 0.7) for v in acc)))
    step = (gx1 - gx0) // 3
    for mx in (gx0, gx0 + step, door_x0 - 3, door_x1 - 3, gx1 - 6):
        d.rectangle([mx, top, mx + 5, base - 1], fill=frame)
        d.line([(mx + 1, top + 9), (mx + 1, base - 10)], fill=line)
    ImageDraw.Draw(im).rectangle([door_x0 + 3, base - 8, door_x1 - 4, base - 1], fill=(0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.line([(door_x0 + 3, base), (door_x1 - 4, base)], fill=rgba(tuple(int(v * 0.7) for v in acc)))
    fy0, fy1 = y0 + 80, base - 1                                    # balcony floor
    x0, x1 = gx0 + 6, gx1 - 6
    d.rectangle([x0, fy0, x1 - 1, fy1], fill=hx(g["floor"]))
    for yy in range(fy0, fy1, 4):
        d.line([(x0, yy), (x1 - 1, yy)], fill=hx(g["floor_line"]))
        d.line([(x0, yy + 1), (x1 - 1, yy + 1)], fill=hx(g["floor_dark"]))
    for xx in range(x0, x1, 12):
        d.line([(xx, fy0), (xx, fy1)], fill=mix(g["floor"], "#ffffff", 0.05))
    d.rectangle([x0, fy0 - 2, x1 - 1, fy0 - 1], fill=hx(g["floor_dark"]))
    rp = c.sprite_path("balcony_railing")                           # railing (as is if themed, otherwise transparent like the cyberpunk glass)
    if os.path.exists(rp):
        rail = Image.open(rp).convert("RGBA")
        if rp.startswith(c.fdir) is False:
            arr = np.array(rail).astype(np.int16)
            light = (arr[..., 0] > 170) & (arr[..., 1] > 200) & (arr[..., 2] > 215) & (arr[..., 3] > 0)
            arr[light, 3] = 70
            rail = Image.fromarray(arr.astype(np.uint8), "RGBA")
        x = x0
        while x < x1:
            im.alpha_composite(rail, (x, fy0 + 2 - rail.height))
            x += rail.width - 6


def gallery_frames(c, im, f, xs, w, h, ytop):
    fr = c.th["frame"]
    y0 = f["y0"]
    d = ImageDraw.Draw(im)
    dark, mid, light, inner = hx(fr["dark"]), hx(fr["mid"]), hx(fr["light"]), hx(fr["inner"])
    st = fr["style"]
    out = []
    for fx in xs:
        x0, y_0, x1, y_1 = fx - 3, y0 + ytop - 3, fx + w + 2, y0 + ytop + h + 2
        d.rectangle([x0, y_0, x1, y_1], fill=dark)                  # outer line
        d.rectangle([x0 + 1, y_0 + 1, x1 - 1, y_1 - 1], fill=mid)   # body
        d.line([(x0 + 1, y_0 + 1), (x1 - 1, y_0 + 1)], fill=light)  # top/left highlight
        d.line([(x0 + 1, y_0 + 1), (x0 + 1, y_1 - 1)], fill=light)
        d.line([(x0 + 1, y_1 - 1), (x1 - 1, y_1 - 1)], fill=dark)   # bottom/right shadow
        d.line([(x1 - 1, y_0 + 1), (x1 - 1, y_1 - 1)], fill=dark)
        d.rectangle([fx, y0 + ytop, fx + w - 1, y0 + ytop + h - 1], fill=inner)
        if st in ("gold", "brass", "wood", "lacquer"):
            for (sx, sy) in ((x0 + 1, y_0 + 1), (x1 - 2, y_0 + 1), (x0 + 1, y_1 - 2), (x1 - 2, y_1 - 2)):
                d.rectangle([sx, sy, sx + 1, sy + 1], fill=light)   # corner studs
        if st in ("gold", "lacquer"):
            d.rectangle([fx - 1, y0 + ytop - 1, fx + w, y0 + ytop + h], outline=light)
        if st == "iron":
            for (sx, sy) in ((x0 + 1, y_0 + 1), (x1 - 2, y_0 + 1), (x0 + 1, y_1 - 2), (x1 - 2, y_1 - 2), ((x0 + x1) // 2, y_0 + 1), ((x0 + x1) // 2, y_1 - 2)):
                d.point((sx, sy), fill=light)
        if st == "hull":
            d.rectangle([x0 + 1, y_1 - 2, x0 + 3, y_1 - 2], fill=hx("#ffaa3c"))
            d.rectangle([x1 - 4, y_1 - 2, x1 - 2, y_1 - 2], fill=hx("#5ad2ff"))
        if st == "stone":
            for k in range(6):
                d.point((x0 + 2 + (k * 17) % (x1 - x0 - 3), y_0 + 1 + (k % 2)), fill=dark)
        out.append({"x": fx, "y": y0 + ytop, "w": w, "h": h})
    return out


def podium(c, im, cx, by, acc):
    p = c.th["podium"]
    d = ImageDraw.Draw(im)
    cs.shadow(im, cx, by + 1, 64, 6, 110)
    x0, x1 = cx - 26, cx + 25
    d.rectangle([x0, by - 18, x1, by - 1], fill=hx(p["body"]))
    d.rectangle([x0, by - 18, x1, by - 14], fill=hx(p["top"]))
    d.line([(x0, by - 18), (x1, by - 18)], fill=hx(p["edge"]))
    d.line([(x0, by - 1), (x1, by - 1)], fill=hx(p["edge"], 150))
    d.rectangle([x0, by - 18, x0 + 1, by - 1], fill=hx(p["dark"]))
    d.rectangle([x1 - 1, by - 18, x1, by - 1], fill=hx(p["dark"]))
    d.rectangle([cx - 6, by - 10, cx + 5, by - 8], fill=rgba(p["glow"], 220))
    cs.glow(im, cx, by - 19, 26, 8, p["glow"], 0.35)


def carpet(c, im, x0, y0, x1, y1, acc):
    z = c.th["zone"]
    ov = Image.new("RGBA", im.size, (0, 0, 0, 0))
    ImageDraw.Draw(ov).rectangle([x0, y0, x1, y1], fill=tuple(z["fill"]))
    im.alpha_composite(ov)
    d = ImageDraw.Draw(im)
    line = hx(z["line"])
    st = z["style"]
    if st == "hazard":                                              # yellow-black warning stripe frame
        for xx in range(x0, x1 + 1, 8):
            for (yy) in (y0, y1 - 2):
                d.rectangle([xx, yy, min(xx + 3, x1), yy + 2], fill=line)
        for yy in range(y0, y1 + 1, 8):
            for xx in (x0, x1 - 2):
                d.rectangle([xx, yy, xx + 2, min(yy + 3, y1)], fill=line)
        return
    d.rectangle([x0, y0, x1, y1], outline=rgba(line[:3], 150))
    for (cx, cy, sx, sy) in ((x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)):
        d.line([(cx, cy), (cx + 10 * sx, cy)], fill=line)
        d.line([(cx, cy), (cx, cy + 10 * sy)], fill=line)
    if st == "rug":                                                 # rug: inner frame + fringe
        d.rectangle([x0 + 3, y0 + 3, x1 - 3, y1 - 3], outline=rgba(line[:3], 90))


def rug(c, im, x0, y0, x1, y1, key):
    base, edge, inner, dot = c.th["rugs"][key]
    ct.rug(im, x0, y0, x1, y1, base, hx(edge, 200), inner, dot)


# ------------------------------------------------------------------------------------------------ floor strips
def new_strip(c, kind):
    im = Image.new("RGBA", (W, FH), (0, 0, 0, 0))
    f = {"kind": kind, "y0": 0, "i": 0}
    floor_shell(c, im, f)
    elevator(c, im, f)
    return im, f


def strip_mudur(c):
    im, f = new_strip(c, "mudur")
    acc = c.th["acc"]["mudur"]
    holes = [window(c, im, 250, 34, 410, 80), window(c, im, 600, 34, 760, 80)]
    dx = ct.OFFICE["deskX"]
    rug(c, im, dx - 130, 150, dx + 130, 262, "office")
    for (name, cx, by) in (("shelf_unit", 50, 128), ("coffee_machine", 116, 128), ("trophy_case", 176, 130), ("plant_tall", 478, 132)):
        paste(c, im, name, cx, by)
    for k in (-44, 44):
        paste(c, im, "chair_small", dx + k, 244)
    rug(c, im, 560, 150, 770, 258, "lounge")
    paste(c, im, "sofa_a", 660, 176)
    paste(c, im, "coffee_table", 660, 234)
    paste(c, im, "floor_lamp", 584, 184)
    paste(c, im, "floor_lamp", 736, 184)
    paste(c, im, "plant_tall", 826, 132)
    paste(c, im, "trophy_case", 794, 130)
    return im, holes


def strip_kod(c):
    im, f = new_strip(c, "kod")
    acc = c.th["acc"]["kod"]
    holes = [window(c, im, 130, 34, 290, 80), window(c, im, 560, 34, 720, 80)]
    carpet(c, im, 30, 124, 846, 236, acc)
    for (name, cx, by) in (("plant_tall", 40, 132), ("whiteboard", 372, 128), ("shelf_unit", 470, 128),
                           ("server_rack", 744, 128), ("server_rack", 776, 128), ("printer", 822, 128), ("boxes", 854, 130)):
        paste(c, im, name, cx, by)
    paste(c, im, "poster_robot", 330, 88, shade=False)
    paste(c, im, "poster_synth", 640, 90, shade=False)
    return im, holes


def strip_tasarim(c):
    im, f = new_strip(c, "tasarim")
    acc = c.th["acc"]["tasarim"]
    holes = [window(c, im, 700, 34, 820, 80)]
    carpet(c, im, 30, 124, 846, 236, acc)
    gallery_frames(c, im, f, ct.DESIGN_FRAMES_X, 96, 45, 36)
    for (name, cx, by) in (("plant_tall", 36, 132), ("shelf_unit", 654, 128), ("easel", 856, 178), ("plant_tall", 826, 132)):
        paste(c, im, name, cx, by)
    return im, holes


def strip_galeri(c):
    im, f = new_strip(c, "galeri")
    acc = c.th["acc"]["galeri"]
    d = ImageDraw.Draw(im)
    frames = gallery_frames(c, im, f, ct.GALLERY_WALL_X, 100, 50, 34)
    for fr in frames:                                               # spotlight above the frame
        cx = fr["x"] + fr["w"] // 2
        d.rectangle([cx - 14, 24, cx + 13, 27], fill=hx(c.th["frame"]["dark"]))
        d.rectangle([cx - 12, 25, cx + 11, 26], fill=rgba(acc, 200))
        cs.glow(im, cx, 56, 56, 40, (255, 255, 235), 0.10, clip=(fr["x"] - 8, 28, fr["x"] + fr["w"] + 8, 92))
    rug(c, im, 50, 150, 860, 252, "gallery")
    for p in ct.GALLERY_PODIUMS:
        podium(c, im, p["x"], p["y"], acc)
    for (name, cx, by) in (("plant_tall", 34, 134), ("plant_tall", 858, 134), ("bench", 330, 262), ("bench", 600, 262)):
        paste(c, im, name, cx, by, shade=(name != "bench"))
    return im, []


def strip_lobi(c):
    im, f = new_strip(c, "lobi")
    acc = c.th["acc"]["lobi"]
    door(c, im, 26, 36, 72, WB, c.th["sign"]["label"], acc)
    rx0, ry0, rx1, ry1 = ct.LOBBY["rug"]
    rug(c, im, rx0, ry0, rx1, ry1, "lobby")
    cs.glow(im, (rx0 + rx1) // 2, (ry0 + ry1) // 2, 190, 80, c.th["acc"]["lobi"], 0.08, clip=(rx0, ry0, rx1, ry1))
    holes = [window(c, im, 424, 34, 536, 80)]
    for (name, cx, by) in (("vending", 262, 130), ("coffee_machine", 306, 128), ("water_cooler", 338, 128), ("plant_tall", 376, 132)):
        paste(c, im, name, cx, by)
    paste(c, im, "poster_synth", 592, 90, shade=False)
    paste(c, im, "poster_robot", 644, 90, shade=False)
    glass_wall(c, im, f, 700, 868, 770, 818)
    holes.append((706, 22, 862, WB - 9))
    paste(c, im, "bench", 735, WB - 2, shade=False)
    paste(c, im, "reception_desk", ct.LOBBY["reception"]["x"], ct.LOBBY["reception"]["y"])
    return im, holes


BUILDERS = {"mudur": strip_mudur, "kod": strip_kod, "tasarim": strip_tasarim, "galeri": strip_galeri, "lobi": strip_lobi}


# ------------------------------------------------------------------------------------------------ monitor and device frames
def _deco(d, st, m, box, out, hi, lo, stud, rng):
    """theme decoration on the frame ring. box = (w, h) outer size."""
    w, h = box
    if st == "wood":
        for yy in (2, 3, h - 5, h - 4):
            d.line([(3, yy), (w - 4, yy)], fill=lo)
        for (sx, sy) in ((2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)):
            d.point((sx, sy), fill=stud)
    elif st == "brass":
        for sx in range(6, w - 5, 8):
            d.point((sx, 2), fill=stud)
            d.point((sx, h - 3), fill=stud)
        d.rectangle([1, h // 2 - 2, 2, h // 2 + 2], fill=lo)
        d.rectangle([w - 3, h // 2 - 2, w - 2, h // 2 + 2], fill=lo)
    elif st == "stone":
        for _ in range(26):
            px, py = rng.randint(1, w - 2), rng.randint(1, h - 2)
            if px < 4 or px > w - 5 or py < 4 or py > h - 5:
                d.point((px, py), fill=rng.choice((hi, lo)))
        for (sx, sy) in ((w // 2, 2), (w // 2, h - 3), (2, h // 2), (w - 3, h // 2)):
            d.point((sx, sy), fill=stud)
    elif st == "hull":
        for k, col in enumerate((stud, hi, stud)):
            d.point((5 + k * 3, 2), fill=col)
        d.line([(w - 12, h - 3), (w - 4, h - 3)], fill=stud)
        d.line([(3, h - 3), (10, h - 3)], fill=lo)
    elif st == "rust":
        for _ in range(30):
            d.point((rng.randint(1, w - 2), rng.randint(1, h - 2)), fill=rng.choice((lo, stud, hi)))
        for (sx, sy) in ((2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)):
            d.rectangle([sx, sy, sx + 1, sy + 1], fill=stud)
    elif st == "lacquer":
        d.rectangle([1, 1, w - 2, h - 2], outline=hi)
        for (sx, sy) in ((2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)):
            d.point((sx, sy), fill=stud)
    elif st == "bakelite":
        d.rectangle([w - 9, h - 4, w - 8, h - 3], fill=stud)
        d.rectangle([w - 5, h - 4, w - 4, h - 3], fill=stud)
        d.line([(3, 2), (w - 4, 2)], fill=hi)


def make_monitor(c):
    m = c.th["mon"]
    rng = random.Random(5)
    im = Image.new("RGBA", (46, 32), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    out, ring, hi, lo, stud = hx(m["outline"]), hx(m["ring"]), hx(m["hi"]), hx(m["lo"]), hx(m["stud"])
    d.rectangle([0, 0, 45, 29], fill=out)
    d.rectangle([1, 1, 44, 28], fill=ring)
    d.line([(1, 1), (44, 1)], fill=hi)
    d.line([(1, 1), (1, 28)], fill=hi)
    d.line([(1, 28), (44, 28)], fill=lo)
    d.line([(44, 1), (44, 28)], fill=lo)
    _deco(d, m["style"], m, (46, 30), out, hi, lo, stud, rng)
    d.rectangle([3, 3, 42, 26], fill=out)                           # dark bevel around the screen
    d.rectangle([4, 4, 41, 25], fill=(0, 0, 0, 0))                  # screen hole 38x22
    d.rectangle([21, 27, 24, 27], fill=hx(m["led"]))                # power light
    d.rectangle([19, 29, 26, 31], fill=hx(m["stand"]))              # neck
    d.line([(19, 29), (26, 29)], fill=out)
    d.rectangle([14, 31, 31, 31], fill=hx(m["foot"]))               # foot
    return im


def make_device(c):
    """device cover on the manager's desk: 30x16, a 20x9 screen hole in the middle (5,3) — the status mark (✓ / logo) is drawn inside the hole"""
    m = c.th["mon"]
    lid = c.th["th"]["lid"]
    im = Image.new("RGBA", (30, 16), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    out, body, hi, base = hx(lid["outline"]), hx(lid["body"]), hx(lid["hi"]), hx(lid["base"])
    d.rectangle([2, 0, 27, 14], fill=out)
    d.rectangle([3, 1, 26, 13], fill=body)
    d.line([(3, 1), (26, 1)], fill=hi)
    d.line([(3, 1), (3, 13)], fill=hi)
    for (sx, sy) in ((4, 2), (25, 2), (4, 12), (25, 12)):           # corner studs
        d.point((sx, sy), fill=hx(m["stud"]))
    d.rectangle([4, 2, 25, 12], outline=out)                        # dark bevel around the screen
    d.rectangle([5, 3, 24, 11], fill=(0, 0, 0, 0))                  # screen hole 20x9
    d.rectangle([0, 14, 29, 15], fill=base)                         # base
    d.line([(0, 14), (29, 14)], fill=hi)
    return im


# ------------------------------------------------------------------------------------------------ output
def sky_layers(c):
    out = {}
    for nm, fn in (("far", "skyline_far.png"), ("near", "skyline_near_keyed.png")):
        p = os.path.join(A, "themes", c.id, "bg", fn)
        if not os.path.exists(p):
            p = os.path.join(A, "bg", fn)
        out[nm] = Image.open(p).convert("RGBA")
    return out


def write_manifest(c):
    th = c.th
    files = []
    base = os.path.join(A, "themes", c.id)
    for sub in ("bg", "f", "atlas", "faces"):                  # atlas/ and faces/ = themed characters (tools/build_theme_chars.py)
        d = os.path.join(base, sub)
        if os.path.isdir(d):
            files += ["%s/%s" % (sub, n) for n in sorted(os.listdir(d)) if n.lower().endswith((".png", ".json"))]
    man = {"id": th["id"], "name": th["name"], "files": files,
           "floorNames": th["floor_names"], "floorShort": th["floor_short"],
           "acc": {k: list(v) for k, v in th["acc"].items()}}
    man.update(th["th"])
    with open(os.path.join(base, "theme.json"), "w", encoding="utf-8") as fh:
        json.dump(man, fh, ensure_ascii=False, indent=1)
    return len(files)


def build(tid, preview=False):
    th = TD.THEMES[tid]
    c = Ctx(th)
    out = os.path.join(A, "themes", tid, "bg")
    fout = os.path.join(A, "themes", tid, "f")
    os.makedirs(out, exist_ok=True)
    os.makedirs(fout, exist_ok=True)
    strips = {}
    for kind, fn in BUILDERS.items():
        im, holes = fn(c)
        im.save(os.path.join(out, "floor_%s.png" % kind), optimize=True)
        ct.glassfx_strip(holes).save(os.path.join(out, "floor_%s_glass.png" % kind), optimize=True)
        strips[kind] = im
    make_monitor(c).save(os.path.join(fout, "monitor.png"))
    make_device(c).save(os.path.join(fout, "exec_device.png"))
    n = write_manifest(c)
    if preview:
        sky = sky_layers(c)
        order = ct.DEFAULT_ORDER
        prev = Image.new("RGBA", (W, ct.TOP + len(order) * FH + ct.BOT), (10, 8, 30, 255))
        for i, kind in enumerate(order):
            y = ct.TOP + i * FH
            for layer, oy in ((sky["far"], 0), (sky["near"], 34)):
                x, flip = 0, False
                while x < W:
                    t = layer.transpose(Image.FLIP_LEFT_RIGHT) if flip else layer
                    prev.alpha_composite(t.crop((0, 0, t.width, min(t.height, FH - oy))), (x, y + oy))
                    x += layer.width
                    flip = not flip
            prev.alpha_composite(strips[kind], (0, y))
            prev.alpha_composite(Image.open(os.path.join(out, "floor_%s_glass.png" % kind)), (0, y))
        os.makedirs(os.path.join(HERE, "_work"), exist_ok=True)
        prev.save(os.path.join(HERE, "_work", "theme_preview_%s.png" % tid))
    print("tamam", tid, "| dosya:", n)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    pv = "--preview" in sys.argv
    ids = TD.ORDER if (not args or args[0] == "all") else args
    for t in ids:
        build(t, pv)
