"""Builds a themed character atlas:  python tools/build_theme_chars.py <theme> [character ...] [--raw FOLDER]

Raw PixelLab output (the PixelLab "download" zip, extracted) is expected in this layout:
    _work/themechars/<theme>/<character>/Idle/rotations/*.png
    _work/themechars/<theme>/<character>/Idle/animations/<anim>/<direction>/frame_NNN.png
<character> = the slot name in cyberpunk (hacker, punk, ... mudur, mudire). Output:
    assets/themes/<theme>/atlas/<character>.png   (SAME row layout as the cyberpunk atlas, 100x100 cells)
    assets/themes/<theme>/atlas/atlas.json       (only characters that exist in this theme)
and adds the atlas/ files to the "files" list of assets/themes/<theme>/theme.json.

The foot anchor is kept EXACTLY the same as its cyberpunk counterpart: the themed character's foot is measured, all frames are
shifted vertically by 1-2 pixels if needed so the foot line sits on the cyberpunk anchor (sitting/walking alignment must not break).
The height (h) is measured from the themed sprite (a hat/helmet affects the bubble height).
"""
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import build_assets as B   # noqa: E402  (CELL, STAFF, BOSSES, ROWS_*, load_frames, centered)

import glob  # noqa: E402


def find_anim_dir(raw, anim, dirn):
    base = os.path.join(raw, "Idle", "animations")
    if not os.path.isdir(base):
        return None
    for d in sorted(os.listdir(base)):
        if d == anim or d.startswith(anim + "-"):
            p = os.path.join(base, d, dirn)
            if glob.glob(os.path.join(p, "*.png")):
                return p
    return None


def measure(raw):
    im = Image.open(os.path.join(raw, "Idle", "rotations", "south.png")).convert("RGBA")
    bb = im.getbbox()
    feet_rel = bb[3] - im.height / 2
    top_rel = im.height / 2 - bb[1]
    return {"canvas": im.width, "ay": int(round(B.CELL / 2 + feet_rel)), "h": int(round(feet_rel + top_rel))}


def build_char(theme, c, raw, base_meta):
    boss = c in B.BOSSES
    rows = []
    rot = [Image.open(os.path.join(raw, "Idle", "rotations", d + ".png")).convert("RGBA") for d in ("south", "east", "north", "west")]
    rows.append(("rot", rot))
    for d in ("south", "east", "north", "west"):
        p = find_anim_dir(raw, "walk", d)
        rows.append(("walk_" + d, B.load_frames(p) if p else []))
    for name, anim, d in (B.ROWS_BOSS if boss else B.ROWS_STAFF):
        p = find_anim_dir(raw, anim, d)
        rows.append((name, B.load_frames(p) if p else []))
    sit = B.sit_frames(theme, c, rot[0])                      # couch/armchair sitting frame (if any)
    if sit:
        rows.append((B.SIT_ROW, sit))
    for i, (name, frames) in enumerate(rows):                 # PixelLab sometimes prepends the reference frame: drop the extra
        want = base_meta["chars"][c]["rows"].get(name, {}).get("n")
        if want and len(frames) == want + 1:
            rows[i] = (name, frames[1:])
    cols = max(len(fr) for _, fr in rows)
    cell = B.CELL
    atlas = Image.new("RGBA", (cell * cols, cell * len(rows)), (0, 0, 0, 0))
    meas = measure(raw)
    base = base_meta["chars"][c]
    dy = base["anchor"][1] - meas["ay"]                      # fits the foot onto the cyberpunk anchor
    m = {}
    for ri, (name, frames) in enumerate(rows):
        for ci, im in enumerate(frames):
            atlas.alpha_composite(B.centered(im), (ci * cell, ri * cell + dy))
        m[name] = {"row": ri, "n": len(frames)}
    # no pixels must be left beyond the row boundary (dy shift): the part outside the cell is cut off
    clean = Image.new("RGBA", atlas.size, (0, 0, 0, 0))
    for ri in range(len(rows)):
        clean.alpha_composite(atlas.crop((0, ri * cell, atlas.width, (ri + 1) * cell)), (0, ri * cell))
    out = os.path.join(ROOT, "assets", "themes", theme, "atlas")
    os.makedirs(out, exist_ok=True)
    clean.save(os.path.join(out, c + ".png"), optimize=True)
    info = {"canvas": meas["canvas"], "anchor": list(base["anchor"]), "h": meas["h"], "rows": m, "boss": boss}
    miss = [k for k, v in m.items() if not v["n"]]
    same = all(m[k]["n"] == base["rows"].get(k, {}).get("n") for k in m)
    print(c, clean.size, "ayak", info["anchor"], "kayma", dy, "boy", info["h"], "(cyber", base["h"], ")",
          "missing:", miss or "-", "frame counts match cyberpunk" if same else "FRAME COUNTS DIFFER")
    return info


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    raw_root = os.path.join(ROOT, "_work", "themechars")
    if "--raw" in sys.argv:
        raw_root = sys.argv[sys.argv.index("--raw") + 1]
        args = [a for a in args if a != raw_root]
    if not args:
        raise SystemExit(__doc__)
    theme, only = args[0], args[1:]
    with open(os.path.join(ROOT, "assets", "atlas", "atlas.json"), "r", encoding="utf-8") as f:
        base_meta = json.load(f)
    out_dir = os.path.join(ROOT, "assets", "themes", theme, "atlas")
    mp = os.path.join(out_dir, "atlas.json")
    meta = {"cell": base_meta["cell"], "chars": {}}
    if os.path.exists(mp):
        with open(mp, "r", encoding="utf-8") as f:
            meta["chars"] = json.load(f).get("chars", {})
    for c in (only or (B.STAFF + B.BOSSES)):
        raw = os.path.join(raw_root, theme, c)
        if not os.path.isdir(os.path.join(raw, "Idle", "rotations")):
            print("atlandi (ham dosya yok):", c)
            continue
        meta["chars"][c] = build_char(theme, c, raw, base_meta)
    os.makedirs(out_dir, exist_ok=True)
    with open(mp, "w", encoding="utf-8") as f:
        json.dump(meta, f)
    # update the "files" list of theme.json
    tp = os.path.join(ROOT, "assets", "themes", theme, "theme.json")
    with open(tp, "r", encoding="utf-8") as f:
        man = json.load(f)
    files = [x for x in man.get("files", []) if not x.startswith("atlas/")]
    files += ["atlas/atlas.json"] + ["atlas/%s.png" % c for c in sorted(meta["chars"])]
    man["files"] = files
    with open(tp, "w", encoding="utf-8") as f:
        json.dump(man, f, ensure_ascii=False, indent=1)
    print("theme.json updated:", len(meta["chars"]), "characters")


if __name__ == "__main__":
    main()
