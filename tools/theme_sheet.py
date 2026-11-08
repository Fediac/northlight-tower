"""Lays out a theme's 30 pieces + sky layers on one contact sheet: python tools/theme_sheet.py <theme> [output.png]"""
import json, os, sys
from PIL import Image, ImageDraw
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
t = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "_work", "sheet_%s.png" % t)
spec = json.load(open(os.path.join(ROOT, "tools", "theme_sprites.json"), encoding="utf-8"))
Z = 3
sheet = Image.new("RGBA", (1500, 1000), (58, 58, 78, 255))
d = ImageDraw.Draw(sheet)
x = y = 6; rowh = 0
for s in spec:
    im = Image.open(os.path.join(ROOT, "assets", "themes", t, "f", s["name"] + ".png")).convert("RGBA")
    im = im.resize((im.width * Z, im.height * Z), Image.NEAREST)
    if x + im.width > 1490:
        x = 6; y += rowh + 14; rowh = 0
    sheet.alpha_composite(im, (x, y)); d.text((x, y + im.height + 1), s["name"], fill=(255, 255, 255, 255))
    x += max(im.width, 60) + 8; rowh = max(rowh, im.height)
y += rowh + 20
for fn in ("skyline_far.png", "skyline_near_keyed.png"):
    p = os.path.join(ROOT, "assets", "themes", t, "bg", fn)
    if os.path.exists(p):
        im = Image.open(p).convert("RGBA"); bg = Image.new("RGBA", im.size, (200, 60, 200, 255)); bg.alpha_composite(im)
        sheet.alpha_composite(bg.resize((im.width * 2, im.height * 2), Image.NEAREST), (6 if fn.startswith("skyline_far") else 820, y))
sheet.crop((0, 0, 1500, y + 410)).save(out)
print(out)
