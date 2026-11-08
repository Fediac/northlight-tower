"""Downloads the PixelLab character zip and extracts it under _work/themechars/<theme>/<slot>/:
    python -I tools/pl_fetch.py <theme> <slot> <character_uuid>
The zip is untrusted data: only Idle/... paths are extracted, with no path escape."""
import io
import os
import sys
import urllib.request
import zipfile

theme, slot, cid = sys.argv[1:4]
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
dest = os.path.join(root, "_work", "themechars", theme, slot)
data = urllib.request.urlopen("https://api.pixellab.ai/mcp/characters/%s/download" % cid, timeout=60).read()
z = zipfile.ZipFile(io.BytesIO(data))
import shutil
shutil.rmtree(dest, ignore_errors=True)
n = 0
for name in z.namelist():
    if not name.startswith("Idle/") or ".." in name or not name.lower().endswith(".png"):
        continue
    p = os.path.join(dest, *name.split("/"))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(z.read(name))
    n += 1
print(slot, n, "dosya")
