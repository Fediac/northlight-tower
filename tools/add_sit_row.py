"""Adds or refreshes the couch/armchair sitting row (sit_south, 1 frame) in an existing character atlas:
    python tools/add_sit_row.py <theme|cyberpunk> [character ...]
Source: _work/sitframes/<theme>/<character>/frame_000.png (the same 68px canvas as the raw rotation).
Does NOT TOUCH the other rows: a 100px row is appended below the atlas PNG (redrawn if it exists),
{"sit_south": {"row": r, "n": 1}} is written to atlas.json. Alignment is the same as build_assets/build_theme_chars
(foot base on the same row as the south rotation's; in a theme, a dy shift to the cyberpunk anchor).
In a full rebuild (build_assets.py / build_theme_chars.py) the row is added automatically anyway."""
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import build_assets as B   # noqa: E402


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    theme, only = sys.argv[1], sys.argv[2:]
    cyber = theme == "cyberpunk"
    adir = os.path.join(ROOT, "assets", "atlas") if cyber else os.path.join(ROOT, "assets", "themes", theme, "atlas")
    mp = os.path.join(adir, "atlas.json")
    with open(mp, "r", encoding="utf-8") as f:
        meta = json.load(f)
    with open(os.path.join(ROOT, "assets", "atlas", "atlas.json"), "r", encoding="utf-8") as f:
        base = json.load(f)
    cell = meta["cell"]
    done = []
    for c in (only or B.STAFF):
        info = meta["chars"].get(c)
        raw = os.path.join(ROOT, "assets", c) if cyber else os.path.join(ROOT, "_work", "themechars", theme, c)
        rp = os.path.join(raw, "Idle", "rotations", "south.png")
        if not info or not os.path.exists(rp):
            print("atlandi (atlas/ham yok):", c)
            continue
        rot = Image.open(rp).convert("RGBA")
        sit = B.sit_frames(theme, c, rot)
        if not sit:
            print("atlandi (oturma karesi yok):", c)
            continue
        if cyber:
            dy = 0
        else:                                   # same as build_theme_chars.measure + dy
            bb = rot.getbbox()
            ay = int(round(cell / 2 + (bb[3] - rot.height / 2)))
            dy = base["chars"][c]["anchor"][1] - ay
        ap = os.path.join(adir, c + ".png")
        at = Image.open(ap).convert("RGBA")
        rows = info["rows"]
        if B.SIT_ROW in rows:
            r = rows[B.SIT_ROW]["row"]
        else:
            r = at.height // cell
        H = max(at.height, (r + 1) * cell)
        out = Image.new("RGBA", (at.width, H), (0, 0, 0, 0))
        out.paste(at, (0, 0))
        out.paste(Image.new("RGBA", (at.width, cell), (0, 0, 0, 0)), (0, r * cell))   # clear the row
        tile = Image.new("RGBA", (cell, cell * 3), (0, 0, 0, 0))
        tile.alpha_composite(B.centered(sit[0]), (0, cell + dy))
        out.alpha_composite(tile.crop((0, cell, cell, 2 * cell)), (0, r * cell))      # overflow outside the cell is cut off
        # check: is the foot base of the sitting frame the same as the atlas rot/south frame's
        rb = out.crop((0, rows["rot"]["row"] * cell, cell, rows["rot"]["row"] * cell + cell)).getbbox()
        sb = out.crop((0, r * cell, cell, r * cell + cell)).getbbox()
        out.save(ap, optimize=True)
        rows[B.SIT_ROW] = {"row": r, "n": 1}
        done.append(c)
        print(c, out.size, "satir", r, "ayak rot/oturma", rb[3], sb[3], "OK" if rb[3] == sb[3] else "FARK")
    with open(mp, "w", encoding="utf-8") as f:
        json.dump(meta, f)
    print(theme, "oturma satiri:", len(done), "karakter")


if __name__ == "__main__":
    main()
