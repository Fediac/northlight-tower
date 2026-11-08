import os
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'core.js')
s = open(p, encoding='utf-8').read()

a = s.index("async function decodeAnim(src) {")
b = s.index("function domAnim(e, src) {")
new = '''let decodedBytes = 0;                                    // çözülmüş GIF karelerinin toplam belleği (üst sınır: tek GIF 48 MB, toplam 400 MB)
async function decodeAnim(e, src) {
  const r = await fetch(src);
  if (!r.ok) throw new Error('http ' + r.status);
  const blob = await r.blob();
  const dec = new ImageDecoder({ data:await blob.arrayBuffer(), type:blob.type || 'image/gif' });
  let reserved = 0;
  try {
    await dec.tracks.ready;
    const n = dec.tracks.selectedTrack.frameCount;
    const first = await dec.decode({ frameIndex:0 });
    const w = first.image.displayWidth, h = first.image.displayHeight, bytes = n * w * h * 4;
    if (!n || n > 600 || bytes > 48e6 || decodedBytes + bytes > 400e6) { first.image.close(); throw new Error('çok büyük'); }
    decodedBytes += bytes; reserved = bytes;
    const frames = [], durs = [];
    for (let i = 0; i < n; i++) {
      const res = i === 0 ? first : await dec.decode({ frameIndex:i });
      durs.push(Math.max(20, (res.image.duration || 100000) / 1000));
      frames.push(await createImageBitmap(res.image));
      res.image.close();
    }
    if (MEDIA.get(src) !== e) { frames.forEach(f => f.close()); decodedBytes -= bytes; reserved = 0; throw new Error('bırakıldı'); }
    e.bytes = bytes; reserved = 0;
    return { frames, durs, w, h };
  } catch (err) {
    if (reserved) decodedBytes -= reserved;
    throw err;
  } finally { dec.close(); }
}
'''
s = s[:a] + new + s[b:]
s = s.replace("        decodeAnim(src).then(d => {", "        decodeAnim(e, src).then(d => {")
s = s.replace("    if (e.frames) e.frames.forEach(b => { try { b.close(); } catch (x) { /* */ } });", "    if (e.frames) { e.frames.forEach(b => { try { b.close(); } catch (x) { /* */ } }); decodedBytes -= e.bytes || 0; }")
open(p, 'w', encoding='utf-8').write(s)
print('ok')
