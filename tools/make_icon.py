from PIL import Image, ImageDraw
import os
import sys
src = sys.argv[1] if len(sys.argv) > 1 else "goz_yazisiz_seffaf_6x.png"   # source: transparent eye logo PNG (pass the path as the first argument)
eye = Image.open(src).convert("RGBA")
print("eye", eye.size, eye.getbbox())
eye = eye.crop(eye.getbbox())
S = 512
bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(bg)
d.rounded_rectangle([8, 8, S - 9, S - 9], radius=96, fill=(14, 10, 38, 255), outline=(122, 92, 255, 255), width=10)
# thin neon underline
d.rounded_rectangle([40, S - 74, S - 41, S - 62], radius=6, fill=(61, 242, 255, 255))
k = min((S - 150) / eye.width, (S - 190) / eye.height)
e2 = eye.resize((max(1, int(eye.width * k)), max(1, int(eye.height * k))), Image.LANCZOS)
bg.alpha_composite(e2, ((S - e2.width) // 2, (S - 70 - e2.height) // 2 + 20))
os.makedirs("assets", exist_ok=True)
bg.save("assets/office_icon.png")
bg.save("assets/office.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("ok", os.path.getsize("assets/office.ico"))
