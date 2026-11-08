"""Packages the raw PixelLab outputs for the office.

- A single atlas PNG per character (assets/atlas/<name>.png) + a single JSON (assets/atlas/atlas.json)
- Crops the furniture to its content bounds (assets/f/<name>.png), writes the sizes to the JSON
Does not touch the raw folders (assets/<character>/Idle/...) and assets/furn/*.png.

The foot alignment (anchor) is measured for each character from the standing image facing south: PixelLab frames put the character
in the middle of the canvas, and as the canvas grows it expands from the edges. Centering in the cell keeps the anchor fixed.
"""
import glob
import json
import os
import sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
A = os.path.join(HERE, "assets")
# workers (14) + managers (2)
STAFF = ["hacker", "punk", "bluehair", "cyborg", "knight", "gasmask",
         "mavi", "gozluk", "kedi", "robot", "bilim", "sanatci", "pilot", "samuray"]
BOSSES = ["mudur", "mudire"]
CELL = 100                # each frame is centered in a 100x100 cell (the largest PixelLab canvas is 92)

# row name -> (animation folder, direction). For workers "kuzey" (north) = back to us (at the desk)
ROWS_STAFF = [("type_north", "type", "north"), ("rest_south", "rest", "south"), ("vape_east", "vape", "east"),
              ("wave_north", "wave", "north"), ("think_north", "think", "north")]
# managers sit BEHIND the desk, facing us (south): work / think / wave / coffee
ROWS_BOSS = [("sit_type", "type", "south"), ("sit_think", "think", "south"), ("sit_wave", "wave", "south"),
             ("sit_coffee", "coffee", "south")]


# couch/armchair sitting frame (single frame, south): _work/sitframes/<theme>/<character>/frame_000.png
# (made from the south rotation with PixelLab edit_image_pixen; not in the PixelLab zip, hence a separate folder)
SIT_ROW = "sit_south"


def sit_frames(theme, c, rot_south):
    """Returns the sitting frame on the raw rotation canvas, so that its foot base lands on the same row as the south rotation's."""
    p = os.path.join(HERE, "_work", "sitframes", theme, c, "frame_000.png")
    if not os.path.exists(p):
        return []
    im = Image.open(p).convert("RGBA")
    bb, rb = im.getbbox(), rot_south.getbbox()
    if not bb or not rb or im.size != rot_south.size:
        return []
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    out.paste(im, (0, rb[3] - bb[3]))           # copy onto an empty canvas (a negative shift is possible too)
    return [out]


def find_anim_dir(c, anim, dirn):
    base = os.path.join(A, c, "Idle", "animations")
    if not os.path.isdir(base):
        return None
    for d in sorted(os.listdir(base)):
        if d == anim or d.startswith(anim + "-"):
            p = os.path.join(base, d, dirn)
            if glob.glob(os.path.join(p, "*.png")):
                return p
    return None


def load_frames(path):
    return [Image.open(f).convert("RGBA") for f in sorted(glob.glob(os.path.join(path, "*.png")))]


def centered(im):
    cell = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    cell.alpha_composite(im, ((CELL - im.width) // 2, (CELL - im.height) // 2))
    return cell


def measure(c):
    """From the standing image facing south: (canvas, foot anchor in the cell, height)."""
    im = Image.open(os.path.join(A, c, "Idle", "rotations", "south.png")).convert("RGBA")
    bb = im.getbbox()
    feet_rel = bb[3] - im.height / 2          # position of the feet relative to the canvas center
    top_rel = im.height / 2 - bb[1]           # top of the head (up from the center)
    ax = CELL // 2
    ay = int(round(CELL / 2 + feet_rel))
    return {"canvas": im.width, "anchor": [ax, ay], "h": int(round(feet_rel + top_rel))}


def build_characters(names):
    out_dir = os.path.join(A, "atlas")
    os.makedirs(out_dir, exist_ok=True)
    meta = {"cell": CELL, "chars": {}}
    mp = os.path.join(out_dir, "atlas.json")
    if os.path.exists(mp):                      # keep the old ones in a partial run
        try:
            with open(mp, "r", encoding="utf-8") as f:
                old = json.load(f)
            if old.get("cell") == CELL:
                meta["chars"] = old.get("chars", {})
        except Exception:
            pass
    for c in names:
        if not os.path.isdir(os.path.join(A, c, "Idle", "rotations")):
            print("atlandi (ham dosya yok):", c)
            continue
        boss = c in BOSSES
        rows = []   # (name, [frames])
        rot = [Image.open(os.path.join(A, c, "Idle", "rotations", d + ".png")).convert("RGBA")
               for d in ("south", "east", "north", "west")]
        rows.append(("rot", rot))
        for d in ("south", "east", "north", "west"):
            p = find_anim_dir(c, "walk", d)
            rows.append(("walk_" + d, load_frames(p) if p else []))
        for name, anim, d in (ROWS_BOSS if boss else ROWS_STAFF):
            p = find_anim_dir(c, anim, d)
            rows.append((name, load_frames(p) if p else []))
        sit = sit_frames("cyberpunk", c, rot[0])
        if sit:
            rows.append((SIT_ROW, sit))
        cols = max(len(fr) for _, fr in rows)
        atlas = Image.new("RGBA", (CELL * cols, CELL * len(rows)), (0, 0, 0, 0))
        m = {}
        for ri, (name, frames) in enumerate(rows):
            for ci, im in enumerate(frames):
                atlas.alpha_composite(centered(im), (ci * CELL, ri * CELL))
            m[name] = {"row": ri, "n": len(frames)}
        atlas.save(os.path.join(out_dir, c + ".png"), optimize=True)
        info = measure(c)
        info["rows"] = m
        info["boss"] = boss
        meta["chars"][c] = info
        miss = [k for k, v in m.items() if not v["n"]]
        print(c, atlas.size, "ayak", info["anchor"], "boy", info["h"], "eksik:", miss or "-")
    with open(os.path.join(out_dir, "atlas.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f)


FURN = ["desk_a", "chair_small", "sofa_a", "armchair", "coffee_table", "coffee_machine", "vending",
        "plant_tall", "arcade", "server_rack", "wall_display", "vape_stand", "balcony_railing",
        "shelf_unit", "water_cooler", "floor_lamp", "poster_synth", "poster_robot", "whiteboard", "printer",
        "bench", "boxes", "prop_mug", "prop_ramen", "prop_cactus", "prop_headphones",
        "exec_desk", "exec_chair", "easel", "reception_desk", "trophy_case"]


def clean_exec_desk(c):
    """Remove the monitor from the manager's desk: the manager faces us from behind the desk, their face must not stay behind the monitor.
    The tabletop surface (y>=24) is horizontally flat, so we copy the neighboring column onto the columns the monitor covers."""
    px = c.load()
    w, h = c.size
    x0, x1 = 33, 113
    for x in range(x0, x1 + 1):
        for y in range(0, 24):
            px[x, y] = (0, 0, 0, 0)
    srcx = 31
    for x in range(x0, x1 + 1):
        for y in range(22, 31):
            px[x, y] = px[srcx, y]
    # the lamp (left) and mug (right) stayed in their own columns; not touched
    return c


def build_furniture():
    out_dir = os.path.join(A, "f")
    os.makedirs(out_dir, exist_ok=True)
    meta = {}
    for n in FURN:
        p = os.path.join(A, "furn", n + ".png")
        if not os.path.exists(p):
            continue
        try:
            im = Image.open(p).convert("RGBA")
        except Exception:
            print("atlandi (bozuk dosya):", n)
            continue
        bb = im.getbbox()
        if not bb:
            continue
        c = im.crop(bb)
        c.save(os.path.join(out_dir, n + ".png"), optimize=True)
        meta[n] = {"w": c.width, "h": c.height}
        if n == "exec_desk":
            cc = clean_exec_desk(c.copy())
            bb2 = cc.getbbox()
            cc = cc.crop(bb2)
            cc.save(os.path.join(out_dir, "exec_desk_clean.png"), optimize=True)
            meta["exec_desk_clean"] = {"w": cc.width, "h": cc.height, "dy": bb2[1]}
    with open(os.path.join(out_dir, "furn.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f)
    print("mobilya:", {k: (v["w"], v["h"]) for k, v in meta.items()})


if __name__ == "__main__":
    only = sys.argv[1:]
    build_characters(only or (STAFF + BOSSES))
    if not only:
        build_furniture()
