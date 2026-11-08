"""Builds face portraits:  python tools/make_faces.py [--theme western] [--crop 24] [--scale 4] [--montage shots/yuzler.png]
If --theme is given: assets/themes/<theme>/atlas/ → assets/themes/<theme>/faces/ (only characters in the theme) and the
theme.json "files" list is updated; otherwise cyberpunk (assets/atlas → assets/faces).

Takes the SOUTH frame (first cell) in the "rot" row of assets/atlas/<character>.png, cuts out the head + shoulder part,
enlarges it with the NEAREST-NEIGHBOR method and writes a transparent PNG as assets/faces/<character>.png.
The character list comes from atlas.json (16 characters). The page side shows it with 'image-rendering: pixelated'.
"""
import argparse
import json
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ATLAS_DIR = os.path.join(ROOT, "assets", "atlas")
OUT_DIR = os.path.join(ROOT, "assets", "faces")


def face_of(char, cell, crop, scale):
    sheet = Image.open(os.path.join(ATLAS_DIR, char + ".png")).convert("RGBA")
    south = sheet.crop((0, 0, cell, cell))              # rot row, frame 0 = south
    bb = south.getbbox()
    if not bb:
        raise SystemExit("empty frame: " + char)
    left = cell // 2 - crop // 2                         # body is symmetric: horizontally the middle of the cell
    top = bb[1] - 1                                      # start 1 pixel above the top of the head
    face = Image.new("RGBA", (crop, crop), (0, 0, 0, 0))
    face.alpha_composite(south.crop((left, top, left + crop, top + crop)))
    return face.resize((crop * scale, crop * scale), Image.NEAREST)


def montage(faces, path, bg=(26, 20, 44, 255)):
    n = len(faces)
    if not n:
        return
    s = faces[0][1].width
    cols = 8
    rows = (n + cols - 1) // cols
    pad = 12
    sheet = Image.new("RGBA", (cols * (s + pad) + pad, rows * (s + pad + 14) + pad), bg)
    d = ImageDraw.Draw(sheet)
    for i, (name, im) in enumerate(faces):
        x = pad + (i % cols) * (s + pad)
        y = pad + (i // cols) * (s + pad + 14)
        sheet.alpha_composite(im, (x, y))
        d.text((x, y + s + 2), name, fill=(230, 220, 255, 255))
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    sheet.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--crop", type=int, default=24, help="crop edge in atlas pixels")
    ap.add_argument("--scale", type=int, default=4, help="magnification factor")
    ap.add_argument("--theme", default="", help="theme id (cyberpunk if empty)")
    ap.add_argument("--montage", default="", help="path of a montage PNG for review")
    a = ap.parse_args()
    global ATLAS_DIR, OUT_DIR
    if a.theme:
        tdir = os.path.join(ROOT, "assets", "themes", a.theme)
        ATLAS_DIR, OUT_DIR = os.path.join(tdir, "atlas"), os.path.join(tdir, "faces")
    with open(os.path.join(ATLAS_DIR, "atlas.json"), "r", encoding="utf-8") as f:
        meta = json.load(f)
    cell = int(meta.get("cell", 100))
    os.makedirs(OUT_DIR, exist_ok=True)
    faces = []
    for char in meta["chars"]:
        if not os.path.isfile(os.path.join(ATLAS_DIR, char + ".png")):
            print("skipped (no atlas):", char)
            continue
        im = face_of(char, cell, a.crop, a.scale)
        im.save(os.path.join(OUT_DIR, char + ".png"), optimize=True)
        faces.append((char, im))
        print("face:", char, im.size)
    if a.montage:
        montage(faces, a.montage)
        print("montaj:", a.montage)
    if a.theme:
        tp = os.path.join(ROOT, "assets", "themes", a.theme, "theme.json")
        with open(tp, "r", encoding="utf-8") as f:
            man = json.load(f)
        man["files"] = [x for x in man.get("files", []) if not x.startswith("faces/")] + ["faces/%s.png" % c for c, _ in faces]
        with open(tp, "w", encoding="utf-8") as f:
            json.dump(man, f, ensure_ascii=False, indent=1)
        print("theme.json updated:", len(faces), "faces")


if __name__ == "__main__":
    main()
