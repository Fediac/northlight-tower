'use strict';
/* Pixel Office — drawing: dynamic floor list, furniture, agents, lights, gallery, board.
   The world canvas holds the whole tower but only the floors the camera sees are drawn (it does not slow down as the floor count grows). */
(function (PO) {
const W = PO.W;
let ctx, world, IM, SC, AT, E, DK, AG;
const FX = [];
let steamT = 0;
const wideCache = {};
PO.galHits = [];
PO.hoverGalKey = null;

// monitor: relative to the top-left corner of the desk sprite (covers the top of the old small monitor)
const MON = { x:18, y:-9, w:44, h:28, ix:3, iy:3, iw:38, ih:22 };
PO.MON = MON;

/* settings (PO.settings.get is synchronous and cheap) */
const S = k => (PO.settings ? PO.settings.get(k) : undefined);
// test parameters (development only): ?hover=<n> ?hovdesk=<n> ?ping=1 ?holomark=1 ?sit=<px> ?chair=<px> ?sitclip=<px>
const TQ = new URLSearchParams(location.search);
PO.TEST = { ping:TQ.get('ping') === '1', holomark:TQ.get('holomark') === '1' };
// sitting measurements (px): how far down the character sinks, how far down the chair stands (relative to the default position),
// SIT_CLIP: how many px at the bottom of the standing frame are clipped (little clipping = hips/upper legs go down behind the backrest to the chair; much clipping = the torso is cut off above the chair and left "legless")
PO.SIT = TQ.get('sit') != null ? +TQ.get('sit') : 8;
PO.CHAIR_DY = TQ.get('chair') != null ? +TQ.get('chair') : 20;
PO.SIT_CLIP = TQ.get('sitclip') != null ? +TQ.get('sitclip') : 9;
// sofa/armchair sitting frame (sit_south): how many px below the furniture's baseline the soles of the feet are (?sofasit=<px> ?armsit=<px>)
PO.SOFA_SIT_DY = TQ.get('sofasit') != null ? +TQ.get('sofasit') : 1;
PO.ARM_SIT_DY = TQ.get('armsit') != null ? +TQ.get('armsit') : 2;

PO.initDraw = function () {
  world = document.createElement('canvas'); world.width = W; world.height = PO.H;
  ctx = world.getContext('2d'); ctx.imageSmoothingEnabled = false;
  PO.world = world; PO.ctx = ctx;
  IM = PO.IM; SC = PO.SC; AT = PO.AT; E = SC.elev; DK = SC.desk; AG = PO.AG;
  wideCache.far = wide(IM.far); wideCache.near = wide(IM.near);
  PO.rackLeds = scanLeds(IM.f_server_rack);
  // when the theme changes: sky strips, server LED positions and the outline cache are recomputed
  PO.onTheme.push(() => { wideCache.far = wide(IM.far); wideCache.near = wide(IM.near); PO.rackLeds = scanLeds(IM.f_server_rack); olCache.clear(); });
  // when a setting changes the world is redrawn at once (in a still scene too)
  if (PO.settings) PO.settings.onChange(() => { PO.needRender = true; PO.needBlit = true; });
  // test: ?force=0:delegating,3:done → forces the state of the n-th agent (development only)
  if (TQ.get('force')) setTimeout(() => TQ.get('force').split(',').forEach(kv => { const [i, st] = kv.split(':'), it = (PO.serverList || [])[+i]; if (it) { it.state = st; PO.needRender = true; } }), 900);
  // test: ?hover=<n> highlights the n-th worker, ?hovdesk=<n> the n-th desk as if hovered
  if (TQ.get('hover') != null) setTimeout(() => { const it = (PO.serverList || [])[+TQ.get('hover')]; if (it) { PO.hoverId = it.id; PO.hoverSrc = 'agent'; PO.needRender = true; } }, 1100);
  if (TQ.get('hovdesk') != null) setTimeout(() => {
    const p = (PO.PL.desk || [])[+TQ.get('hovdesk')];
    if (p) { PO.hoverDeskKey = p.key; PO.hoverId = p.owner || null; PO.hoverSrc = 'desk'; PO.needRender = true; }
  }, 1100);
};
// when the floor count changes, resize the world canvas (only if needed: resizing clears the canvas)
PO.resizeWorld = function () {
  if (world.height !== PO.H) { world.height = PO.H; ctx.imageSmoothingEnabled = false; }
};

function wide(img) {
  if (!img) return null;
  const c = document.createElement('canvas'); c.width = img.width * 2; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0); g.save(); g.translate(img.width * 2, 0); g.scale(-1, 1); g.drawImage(img, 0, 0); g.restore();
  return c;
}
function scanLeds(img) {
  if (!img) return [];
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data, out = [];
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const i = (y * img.width + x) * 4, r = d[i], gg = d[i + 1], b = d[i + 2], a = d[i + 3];
    if (a > 200) { const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b); if (mx > 170 && mx - mn > 90) out.push([x, y]); }
  }
  return out;
}

/* ------------------------------------------------------------------ drawing helpers */
const stateOf = PO.stateOf;
function drawCell(c, name, frame, x, y, clipAbove = null, ox = 0, oy = 0) {
  const img = IM['c_' + c], info = AT.chars[c];
  if (!img || !info) return false;
  const m = info.rows[name]; if (!m || !m.n) return false;
  const f = ((frame % m.n) + m.n) % m.n, CELL = AT.cell;
  const rows = clipAbove == null ? CELL : Math.max(1, info.anchor[1] - clipAbove);
  ctx.drawImage(img, f * CELL, m.row * CELL, CELL, rows, Math.round(x - info.anchor[0] + ox), Math.round(y - info.anchor[1] + oy), CELL, rows);
  return true;
}
const hasRow = (c, n) => { const i = AT.chars[c]; const m = i && i.rows[n]; return !!(m && m.n > 0); };
const DIRI = { south:0, east:1, north:2, west:3 };
function drawRot(c, dir, x, y, clipAbove = null, ox = 0, oy = 0) { return drawCell(c, 'rot', DIRI[dir] || 0, x, y, clipAbove, ox, oy); }
const furn = name => IM['f_' + name];
function drawFurn(name, x, y, sy = 0, sh = null, ox = 0, oy = 0) {
  const im = furn(name); if (!im) return;
  const h = sh == null ? im.height - sy : sh;
  ctx.drawImage(im, 0, sy, im.width, h, Math.round(x + ox), Math.round(y + sy + oy), im.width, h);
}
/* ------------------------------------------------------------------ highlight outline (on hover / selection)
   Offset copies of the sprite silhouette + source-in painting = outline canvas; cached per (image, frame, thickness, color). */
const olCache = new Map();
let imgSeq = 0;
function outlineSprite(img, sx, sy, sw, sh, w, color) {
  const key = (img.__oid || (img.__oid = ++imgSeq)) + ':' + sx + ',' + sy + ',' + sw + ',' + sh + ':' + w + ':' + color;
  let c = olCache.get(key);
  if (c) return c;
  if (olCache.size > 220) olCache.clear();
  c = document.createElement('canvas'); c.width = sw + w * 2; c.height = sh + w * 2;
  const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
  for (let dy = -w; dy <= w; dy++) for (let dx = -w; dx <= w; dx++) if (dx * dx + dy * dy <= w * w + 1) g.drawImage(img, sx, sy, sw, sh, w + dx, w + dy, sw, sh);
  g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
  olCache.set(key, c);
  return c;
}
// outline thickness: as zoom decreases it thickens a bit so the line does not vanish from afar (world pixels)
function olWidth() {
  const css = PO.cam ? PO.cam.s / (PO.dpr || 1) : 1;
  const base = PO.clamp(Math.round(S('hover.width') || 2), 1, 4);
  return PO.clamp(Math.max(base, Math.ceil(base * 1.1 / Math.max(css, 0.35))), 1, 5);
}
const accentBright = () => { const a = PO.settings && PO.settings.ACCENTS.find(x => x.id === PO.settings.accentId()); return a ? a.bright : '#9d87ff'; };
// highlight for this agent: selected (accent color, persistent, pulses) or hovered (hover.color); null if none
function agentHL(a) {
  const sel = a.id === PO.selectedId, hov = a.id === PO.hoverId;
  if (!sel && !(hov && S('hover.agent'))) return null;
  const T = PO.clock.t, pulse = sel ? 0.5 + 0.5 * Math.sin(T * 5) : 0.5;
  return { sel, color:sel ? accentBright() : PO.settings.hoverColor(), w:olWidth(), glow:(S('hover.glow') || 0) / 100, pulse };
}
// draw the outline canvas (called BEFORE the sprite: the outline is always behind). A selected agent also has a second, wider, pulsing ring.
function paintOutline(img, sx, sy, sw, sh, x, y, hl) {
  const g0 = ctx.globalAlpha;
  if (hl.sel) {
    const w2 = hl.w + 2;
    ctx.globalAlpha = g0 * (0.22 + 0.28 * hl.pulse);
    ctx.drawImage(outlineSprite(img, sx, sy, sw, sh, w2, hl.color), x - w2, y - w2);
  }
  ctx.globalAlpha = g0 * (hl.sel ? 0.75 + 0.25 * hl.pulse : 0.95);
  ctx.drawImage(outlineSprite(img, sx, sy, sw, sh, hl.w, hl.color), x - hl.w, y - hl.w);
  ctx.globalAlpha = g0;
}
function drawCellOL(c, name, frame, x, y, clipAbove, ox, oy, hl) {
  const img = IM['c_' + c], info = AT.chars[c], m = info && info.rows[name];
  if (img && m && m.n) {
    const f = ((frame % m.n) + m.n) % m.n, CELL = AT.cell, rows = clipAbove == null ? CELL : Math.max(1, info.anchor[1] - clipAbove);
    paintOutline(img, f * CELL, m.row * CELL, CELL, rows, Math.round(x - info.anchor[0] + ox), Math.round(y - info.anchor[1] + oy), hl);
  }
}
function drawFurnOL(name, x, y, sy, sh, hl) {
  const im = furn(name); if (!im) return;
  const h = sh == null ? im.height - sy : sh;
  paintOutline(im, 0, sy, im.width, h, Math.round(x), Math.round(y + sy), hl);
}
const shadow = (x, y, w, h, a) => PO.shadow(ctx, x, y, w, h, a);
const addGlow = (x, y, r, c, a, sy) => PO.addGlow(ctx, x, y, r, c, a, sy);
const drawText = (...a) => PO.drawText(ctx, ...a);
const rnd = PO.rnd;
const rgb = a => `rgb(${a[0]},${a[1]},${a[2]})`;
const rgbA = (a, al) => `rgba(${Math.round(a[0])},${Math.round(a[1])},${Math.round(a[2])},${al == null ? 1 : al})`;
function line(x0, y0, x1, y1, size, color) {         // thick pixel line
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  ctx.fillStyle = color;
  for (let i = 0; i <= n; i++) ctx.fillRect(Math.round(x0 + (x1 - x0) * i / n - size / 2), Math.round(y0 + (y1 - y0) * i / n - size / 2), size, size);
}

/* ------------------------------------------------------------------ sky: only behind the window gaps */
const rain = Array.from({ length:70 }, () => ({ x:rnd(0, 940), y:rnd(0, 98), v:rnd(130, 220), l:rnd(3, 6) }));
const cars = Array.from({ length:6 }, (_, i) => ({ x:rnd(0, 940), y:rnd(24, 80), v:rnd(10, 38) * (i % 2 ? 1 : -1), c:['#ffd27a', '#7af0ff', '#ff7ae8'][i % 3] }));
const stars = Array.from({ length:50 }, () => ({ x:rnd(0, W), y:rnd(0, 52), p:rnd(0, 6) }));
let skyT = 0;                                     // advances only when "movements outside the window" is on
PO.skyT = 0;
function stepSky(dt) {
  if (S('motion') === false) return;              // off: rain, traffic, city drift and star twinkling stop (stay static)
  skyT += dt; PO.skyT = skyT;
  for (const c of cars) { c.x += c.v * dt; if (c.x > 960) c.x = -20; if (c.x < -20) c.x = 960; }
  const kind = PO.TH.sky.particle.kind;           // by theme: rain · fall (sakura/ash, drifts down) · rise (spark/firefly, rises) · dust (windblown dust) · none
  for (const d of rain) {
    if (kind === 'rain') { d.y += d.v * dt; d.x -= d.v * 0.18 * dt; if (d.y > 98) { d.y = rnd(-20, 0); d.x = rnd(0, 980); } }
    else if (kind === 'fall') { d.y += d.v * 0.2 * dt; d.x += Math.sin(skyT * 1.3 + d.l * 7) * 14 * dt; if (d.y > 98) { d.y = rnd(-20, 0); d.x = rnd(0, 980); } }
    else if (kind === 'rise') { d.y -= d.v * 0.16 * dt; d.x += Math.sin(skyT + d.l * 5) * 8 * dt; if (d.y < -4) { d.y = rnd(96, 112); d.x = rnd(0, 980); } }
    else if (kind === 'dust') { d.x += d.v * 0.6 * dt; d.y += Math.sin(skyT * 0.8 + d.l) * 3 * dt; if (d.x > 990) { d.x = rnd(-30, 0); d.y = rnd(0, 98); } }
  }
}
function drawWindowsSky(fl) {
  const wins = fl.spec.windows;
  if (!wins || !wins.length) return;
  const T = skyT, y0 = fl.y0, SK = PO.TH.sky, P = SK.particle, V = SK.vehicles;
  ctx.save(); ctx.beginPath();
  wins.forEach(w => ctx.rect(w[0], y0 + w[1], w[2] - w[0], w[3] - w[1]));
  ctx.clip();
  ctx.fillStyle = SK.fill;
  wins.forEach(w => ctx.fillRect(w[0], y0 + w[1], w[2] - w[0], w[3] - w[1]));
  if (wideCache.far) { const ox = -((T * 3 + fl.i * 90) % wideCache.far.width); for (let k = 0; k < 3; k++) ctx.drawImage(wideCache.far, Math.round(ox + k * wideCache.far.width), y0); }
  if (wideCache.near) { const ox = -((T * 8 + fl.i * 140) % wideCache.near.width); for (let k = 0; k < 3; k++) ctx.drawImage(wideCache.near, Math.round(ox + k * wideCache.near.width), y0 + 34); }
  ctx.fillStyle = SK.tint; wins.forEach(w => ctx.fillRect(w[0], y0 + w[1], w[2] - w[0], w[3] - w[1]));
  if (V.colors && V.colors.length) for (const c of cars) {
    ctx.fillStyle = V.colors[cars.indexOf(c) % V.colors.length]; ctx.fillRect(Math.round(c.x), y0 + Math.round(c.y), V.w, V.h);
    ctx.globalAlpha = 0.4; ctx.fillRect(Math.round(c.x - Math.sign(c.v) * 3), y0 + Math.round(c.y), V.w + 1, V.h); ctx.globalAlpha = 1;
  }
  if (P.kind !== 'none') {
    ctx.fillStyle = P.color;
    for (const d of rain) {
      const px = Math.round(12 + (((d.x + fl.i * 211) % 936) + 936) % 936), py = y0 + SC.ceil + Math.round(d.y);
      if (P.kind === 'rain') ctx.fillRect(px, py, 1, Math.round(d.l));
      else ctx.fillRect(px, py, P.size || 1, P.size || 1);
    }
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ roof + sign, floor */
function drawRoof() {
  const T = skyT, top = SC.top, R = PO.TH.roof;
  const g = ctx.createLinearGradient(0, 0, 0, top); g.addColorStop(0, R.top); g.addColorStop(1, R.bottom);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, top);
  for (const s of stars) { ctx.globalAlpha = 0.35 + 0.35 * Math.sin(T * 1.6 + s.p); ctx.fillStyle = R.star; ctx.fillRect(Math.round(s.x), Math.round(s.y), 1, 1); }
  ctx.globalAlpha = 1;
  ctx.fillStyle = R.mast;
  [[120, 22], [840, 18]].forEach(([x, h], i) => {
    ctx.fillRect(x, top - h, 2, h);
    if (Math.floor(T * 1.2 + i * 0.5) % 2) { ctx.fillStyle = R.blink; ctx.fillRect(x - 1, top - h - 2, 4, 3); addGlow(x + 1, top - h - 1, 12, R.blinkGlow, 0.55); ctx.fillStyle = R.mast; }
  });
  // sign: NORTHLIGHT TOWER + this chat's title + project
  const ti = PO.towerTitle || { title:PO.t('EMPTY OFFICE'), project:'' };
  const t1 = PO.clip(PO.up(ti.title || ''), 42), t0 = 'NORTHLIGHT TOWER', t2 = ti.project ? PO.clip(PO.up(ti.project), 48) : '';
  const sw = Math.min(700, Math.max(PO.textW(t1, 2) + 34, PO.textW(t0) + 34, t2 ? PO.textW(t2) + 34 : 0, 250)), sh = t2 ? 42 : 34;
  const sx = Math.round((W - sw) / 2), sy = t2 ? 7 : 12;
  addGlow(W / 2, sy + sh / 2, sw / 2 + 20, R.signGlow, 0.16, 0.5);
  ctx.fillStyle = R.signBg; ctx.fillRect(sx, sy, sw, sh);
  ctx.fillStyle = R.signEdge; ctx.fillRect(sx, sy, sw, 1); ctx.fillRect(sx, sy + sh - 1, sw, 1); ctx.fillRect(sx, sy, 1, sh); ctx.fillRect(sx + sw - 1, sy, 1, sh);
  ctx.fillStyle = R.signHi; ctx.fillRect(sx + 2, sy + 2, sw - 4, 1);
  drawText(t0, W / 2, sy + 5, R.t0, 1, 'center');
  drawText(t1, W / 2, sy + 15, R.t1, 2, 'center');
  if (t2) drawText(t2, W / 2, sy + 32, R.t2, 1, 'center');
}
function drawBase() {
  const y = PO.H - SC.bot, B = PO.TH.base;
  ctx.fillStyle = B.fill; ctx.fillRect(0, y, W, SC.bot);
  const lb = PO.lobby ? rgb(PO.lobby.acc) : B.line;
  ctx.fillStyle = lb; ctx.fillRect(0, y, W, 1);
  ctx.globalAlpha = 0.35; ctx.fillStyle = B.line; ctx.fillRect(0, y + 1, W, 1); ctx.globalAlpha = 1;
  for (let x = 30; x < W; x += 120) { ctx.fillStyle = B.dash; ctx.fillRect(x, y + 8, 60, 2); }
}

/* ------------------------------------------------------------------ floor sign + elevator */
const PLATE_X = 160;                 // floor title is 120 world pixels in from the left edge: so it does not end up under the column of floor buttons
function drawPlate(fl) {
  const acc = rgb(fl.acc), y = fl.y0 + 3;
  const text = PO.t('FLOOR {n}', { n:fl.num }) + '  ' + PO.up(fl.name);
  const w = PO.textW(text) + 13;
  const px = PLATE_X - Math.round(PO.plateShift ? PO.plateShift(PLATE_X, y - 1, w, 10) : 0);   // so it does not end up under the zoom bar in a narrow scene
  ctx.fillStyle = 'rgba(5,4,18,.92)'; ctx.fillRect(px, y - 1, w, 10);
  ctx.fillStyle = acc; ctx.fillRect(px, y - 1, 2, 10);
  drawText(text, px + 6, y + 1, acc);
}
function leaf(x, y, w, h) {
  if (w <= 0) return;
  const L = PO.TH.elev;
  ctx.fillStyle = L.leaf; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = L.line; for (let yy = y + 8; yy < y + h; yy += 12) ctx.fillRect(x + 1, yy, Math.max(0, w - 2), 1);
  ctx.fillStyle = L.edge; ctx.fillRect(x, y, 2, h); ctx.fillRect(x + w - 2, y, 2, h);
}
function drawElevator(fl) {
  const f = fl.i, w = E.x1 - E.x0, dy0 = E.doorTop, h = SC.wb - dy0;
  const d = PO.doors[f], y = fl.y0 + dy0, x = E.x0, open = d.open;
  const acc = rgb(fl.acc), EL = PO.TH.elev;
  if (open > 0.03) {
    const g = ctx.createLinearGradient(0, y, 0, y + h); g.addColorStop(0, EL.inner[0]); g.addColorStop(0.6, EL.inner[1]); g.addColorStop(1, EL.inner[2]);
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(70,45,15,.30)'; ctx.fillRect(x, y, 5, h); ctx.fillRect(x + w - 5, y, 5, h);
    ctx.fillStyle = 'rgba(90,60,20,.22)'; for (let yy = y + 14; yy < y + h - 8; yy += 14) ctx.fillRect(x + 5, yy, w - 10, 1);
    ctx.fillStyle = '#8c7442'; ctx.fillRect(x + 5, y + h - 36, w - 10, 3);
    ctx.fillStyle = '#c9b074'; ctx.fillRect(x + 5, y + h - 36, w - 10, 1);
    ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fillRect(x + 8, y, w - 16, 2);
    ctx.fillStyle = 'rgba(90,60,20,.45)'; ctx.fillRect(x, y + h - 3, w, 3);
    ctx.fillStyle = '#3a2a10'; ctx.fillRect(x + (w >> 1) - 7, y + 5, 14, 7);
    ctx.fillStyle = acc; ctx.fillRect(x + (w >> 1) - 5, y + 7, 10, 3);
  }
  const lw = open > 0.9 ? 3 : Math.round((w / 2) * (1 - open));
  leaf(x, y, lw, h); leaf(x + w - lw, y, lw, h);
  ctx.fillStyle = acc;
  if (lw > 0) { ctx.fillRect(x + lw - 1, y, 1, h); ctx.fillRect(x + w - lw, y, 1, h); }
  // floor indicator above the door
  ctx.fillStyle = '#05040e'; ctx.fillRect(x + (w >> 1) - 13, fl.y0 + 18, 26, 13);
  ctx.fillStyle = acc; ctx.fillRect(x + (w >> 1) - 13, fl.y0 + 18, 26, 1); ctx.fillRect(x + (w >> 1) - 13, fl.y0 + 30, 26, 1);
  drawText(String(fl.num), x + (w >> 1), fl.y0 + 21, acc, 1, 'center');
  if (open > 0.2) addGlow(E.cx, fl.y0 + SC.wb + 12, 44, EL.glow, 0.30 * open, 0.45);
  const fl2 = PO.doorFlash[f];
  if (fl2 > 0) addGlow(E.cx, fl.y0 + 70, 40, acc, fl2 * 0.5, 1.6);
}

/* ------------------------------------------------------------------ screens */
function drawCheck(x, y, w, h) {
  const T = PO.clock.t;
  ctx.fillStyle = '#021611'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = 'rgba(70,255,170,.08)';
  for (let gx = x + 4; gx < x + w; gx += 6) ctx.fillRect(gx, y, 1, h);
  for (let gy = y + 3; gy < y + h; gy += 6) ctx.fillRect(x, gy, w, 1);
  const p = 0.72 + 0.28 * Math.sin(T * 2.4);
  const cx = x + (w >> 1), cy = y + (h >> 1);
  const a = [cx - 9, cy], b = [cx - 3, cy + 6], c = [cx + 10, cy - 7];
  ctx.globalAlpha = 0.9;
  line(a[0], a[1], b[0], b[1], 7, '#0a5c3e'); line(b[0], b[1], c[0], c[1], 7, '#0a5c3e');      // dark outline
  ctx.globalAlpha = 1;
  line(a[0], a[1], b[0], b[1], 5, '#26e08c'); line(b[0], b[1], c[0], c[1], 5, '#26e08c');
  line(a[0], a[1], b[0], b[1], 3, '#6dffb6'); line(b[0], b[1], c[0], c[1], 3, '#6dffb6');
  line(a[0], a[1] - 1, b[0], b[1] - 1, 1, '#e6fff2'); line(b[0], b[1] - 1, c[0], c[1] - 1, 1, '#e6fff2');
  const sc = (T * 14) % (h + 14) - 7; ctx.fillStyle = 'rgba(160,255,210,.16)'; ctx.fillRect(x, Math.round(y + sc), w, 2);
  addGlow(cx, cy, 30, '#2dff9a', 0.42 * p, 0.7);
}
function drawScreen(x, y, w, h, state, seed, on) {
  const T = PO.clock.t, hash = PO.hash;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = '#04070f'; ctx.fillRect(x, y, w, h);
  if (!on) {
    const px = x + 2 + Math.abs(((T * 6) % ((w - 5) * 2)) - (w - 5)), py = y + 2 + Math.abs(((T * 4) % ((h - 5) * 2)) - (h - 5));
    ctx.fillStyle = '#1b3a55'; ctx.fillRect(Math.round(px), Math.round(py), 2, 2);
  } else if (state === 'done') {
    drawCheck(x, y, w, h);
  } else if (state === 'typing' || state === 'reading') {
    const speed = state === 'typing' ? 10 : 3.5;
    const base = Math.floor(T * speed);
    const colors = state === 'typing' ? ['#46e0a0', '#3df2ff', '#c9ffe9', '#ffd27a'] : ['#cfd6ff', '#9db0ff', '#e8ecff'];
    const lines = Math.floor((h - 4) / 2);
    for (let i = 0; i < lines; i++) {
      const ln = base - i, hv = hash(seed + ':' + ln);
      const wd = 4 + (hv % (w - 8)), ind = (hv >> 8) % 3 === 0 ? 3 : 0;
      ctx.fillStyle = colors[(hv >> 4) % colors.length];
      ctx.fillRect(x + 2 + ind, y + h - 3 - i * 2, Math.min(wd, w - 4 - ind), 1);
    }
    if (state === 'typing' && Math.floor(T * 2.5) % 2) { ctx.fillStyle = '#fff'; ctx.fillRect(x + 2, y + h - 3, 1, 1); }
    if (state === 'reading') { ctx.fillStyle = 'rgba(92,200,255,.22)'; ctx.fillRect(x, y + ((T * 5) % h), w, 2); }
  } else if (state === 'thinking') {
    for (let i = 0; i < 3; i++) { const on2 = Math.floor(T * 3) % 3 === i; ctx.fillStyle = on2 ? '#e3d8ff' : '#5b4a9a'; ctx.fillRect(x + (w >> 1) - 5 + i * 4, y + (h >> 1) - 1, 2, 2); }
  } else if (state === 'delegating') {
    ctx.fillStyle = '#ffcf5c';
    const cx = x + (w >> 1), cy = y + 5;
    ctx.fillRect(cx - 2, cy, 4, 3);
    ctx.fillRect(x + 6, y + h - 7, 4, 3); ctx.fillRect(x + w - 10, y + h - 7, 4, 3);
    ctx.fillStyle = '#7a6420'; ctx.fillRect(cx - 1, cy + 3, 1, 4); ctx.fillRect(x + 8, y + h - 9, cx - x - 8, 1);
    const p = (T * 1.4) % 1; ctx.fillStyle = '#fff'; ctx.fillRect(Math.round(cx - 1 + (x + 7 - cx) * p), Math.round(cy + 3 + (y + h - 8 - cy - 3) * p), 1, 1);
  } else if (state === 'waiting') {
    const blink = Math.floor(T * 3) % 2;
    ctx.fillStyle = blink ? '#5a0f20' : '#2b0710'; ctx.fillRect(x, y, w, h);
    drawText('!', x + (w >> 1), y + (h >> 1) - 3, blink ? '#fff' : '#ff4d6a', 1, 'center');
  }
  if (state !== 'done') { ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(x + 4, y, 2, h); ctx.fillRect(x + 10, y, 1, h); }
  ctx.restore();
}
// large monitor: frame glowing in the state color + screen
function drawMonitor(x0, y0, state, seed, on) {
  const M = MON, mx = x0 + M.x, my = y0 + M.y, K = PO.TH.mon;
  const c = on ? stateOf(state).c : K.off;
  const neon = on && state === 'done' ? '#2dff9a' : c;
  const bz = IM.f_monitor;
  if (bz) {                                                                                           // themed monitor: first the screen, then the frame with a hole in the middle (46x32, hole 38x22 @ 4,4)
    drawScreen(mx + M.ix, my + M.iy, M.iw, M.ih, state, seed, on);
    ctx.drawImage(bz, mx - 1, my - 1);
    ctx.globalAlpha = on ? 0.55 : 0.25; ctx.fillStyle = neon;                                          // state color on the inner edge of the screen
    ctx.fillRect(mx + M.ix, my + M.iy, M.iw, 1); ctx.fillRect(mx + M.ix, my + M.iy + M.ih - 1, M.iw, 1); ctx.fillRect(mx + M.ix, my + M.iy, 1, M.ih); ctx.fillRect(mx + M.ix + M.iw - 1, my + M.iy, 1, M.ih);
    ctx.globalAlpha = 1;
    if (on) addGlow(mx + (M.w >> 1), my + (M.h >> 1) + 4, 40, neon, state === 'waiting' ? 0.20 + 0.12 * Math.sin(PO.clock.t * 8) : 0.15, 0.6);
    return;
  }
  ctx.fillStyle = K.stand; ctx.fillRect(mx + 18, my + M.h, 8, 3);                                  // neck
  ctx.fillStyle = K.foot; ctx.fillRect(mx + 13, my + M.h + 2, 18, 1);                              // foot
  ctx.fillStyle = K.outline; ctx.fillRect(mx - 1, my - 1, M.w + 2, M.h + 2);                       // outer line
  ctx.fillStyle = K.frame; ctx.fillRect(mx, my, M.w, M.h);                                          // frame
  ctx.fillStyle = K.hi; ctx.fillRect(mx, my, M.w, 1); ctx.fillRect(mx, my, 1, M.h);
  ctx.fillStyle = K.lo; ctx.fillRect(mx, my + M.h - 1, M.w, 1); ctx.fillRect(mx + M.w - 1, my, 1, M.h);
  ctx.globalAlpha = on ? 0.85 : 0.5; ctx.fillStyle = neon;                                          // neon inner border
  ctx.fillRect(mx + 2, my + 2, M.w - 4, 1); ctx.fillRect(mx + 2, my + M.h - 3, M.w - 4, 1); ctx.fillRect(mx + 2, my + 2, 1, M.h - 4); ctx.fillRect(mx + M.w - 3, my + 2, 1, M.h - 4);
  ctx.globalAlpha = 1;
  ctx.fillStyle = neon; ctx.fillRect(mx + (M.w >> 1) - 1, my + M.h - 2, 3, 1);                     // power light
  drawScreen(mx + M.ix, my + M.iy, M.iw, M.ih, state, seed, on);
  if (on) addGlow(mx + (M.w >> 1), my + (M.h >> 1) + 4, 40, neon, state === 'waiting' ? 0.20 + 0.12 * Math.sin(PO.clock.t * 8) : 0.15, 0.6);
}

/* ------------------------------------------------------------------ lobby board */
function drawBoard(fl, list) {
  const b = fl.board, T = PO.clock.t, clip = PO.clip, shortLabel = PO.shortLabel;
  const x0 = b.x0, y0 = b.y0, w = b.x1 - b.x0, h = b.y1 - b.y0;
  ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
  const BD = PO.TH.board;
  ctx.fillStyle = BD.bg; ctx.fillRect(x0, y0, w, h);
  const cnt = { work:0, wait:0, rest:0 };
  list.forEach(a => { if (a.state === 'done') cnt.rest++; else if (a.state === 'waiting') cnt.wait++; else cnt.work++; });
  drawText(PO.t('TEAM'), x0 + 4, y0 + 5, BD.title);
  [['#46e0a0', cnt.work], ['#ff4d6a', cnt.wait], ['#8c86b8', cnt.rest]].forEach(([c, v], i) => {
    const bx = x0 + 62 + i * 21;
    ctx.fillStyle = c; ctx.fillRect(bx, y0 + 5, 5, 5);
    drawText(String(v), bx + 8, y0 + 4, '#d8e6ff');
  });
  ctx.fillStyle = BD.line; ctx.fillRect(x0 + 3, y0 + 13, w - 6, 1);
  if (!list.length) drawText(PO.t('NO WORKERS'), x0 + w / 2, y0 + 24, '#4b5d86', 1, 'center');
  // 4 workers (2 rows): the third row overlapped the scrolling text strip below; totals are in the header
  list.slice(0, 4).forEach((a, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = x0 + 4 + col * 60, y = y0 + 17 + row * 9;
    ctx.fillStyle = stateOf(a.state).c; ctx.fillRect(x, y, 4, 5);
    if (a.state === 'waiting' && Math.floor(T * 3) % 2) { ctx.fillStyle = '#fff'; ctx.fillRect(x + 1, y + 1, 2, 3); }
    drawText(clip((PO.nickOf && PO.nickOf(a.info || a)) || shortLabel(a.info || a), 8), x + 7, y, a.state === 'done' ? '#7f88b5' : '#d8e6ff');   // short name (the chat title was left half at 8 letters)
  });
  const last = PO.latestEvents(6);
  const txt = last.length ? last.map(e => `${e.who}: ${e.x}`).join('   +   ') : PO.t('WAITING FOR ACTIVITY');
  const tw = PO.textW(txt) + 60;
  const off = -((T * 22) % tw);
  ctx.fillStyle = BD.tickerBg; ctx.fillRect(x0, y0 + h - 10, w, 10);
  for (let k = 0; k < 3; k++) drawText(txt, x0 + off + k * tw + 4, y0 + h - 8, BD.ticker);
  ctx.restore();
  ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.fillRect(x0 + 20, y0, 6, h); ctx.fillRect(x0 + 34, y0, 2, h);
}

/* ------------------------------------------------------------------ gallery: design floor frames, gallery floor wall + hologram pedestals */
function fitRect(iw, ih, bw, bh) {
  const s = Math.min(bw / iw, bh / ih);
  return { w:Math.max(1, Math.round(iw * s)), h:Math.max(1, Math.round(ih * s)) };
}
let galSig = '', galLay = null;
function galleryLayout() {
  const items = PO.galItems || [];
  const sig = PO.towerVersion + '|' + items.map(i => i.key).join(',');
  if (sig === galSig && galLay) return galLay;
  galSig = sig;
  const lay = { tasarim:{}, galeri:{} };
  PO.floorsOf('tasarim').forEach((fl, k) => { lay.tasarim[fl.i] = items.slice(k * 5, k * 5 + 5); });
  PO.floorsOf('galeri').forEach((fl, k) => {
    const part = items.slice(k * PO.ART_PER_GALLERY, (k + 1) * PO.ART_PER_GALLERY);
    const anim = part.filter(i => i.anim), still = part.filter(i => !i.anim);
    const rest = still.concat(anim.slice(6));
    lay.galeri[fl.i] = { wall:rest.slice(0, 8), pod:anim.slice(0, 6).concat(rest.slice(8)).slice(0, 6) };
  });
  galLay = lay;
  return lay;
}
// if "Animated gallery" is off, GIF/video stops on the first frame (the first frame is copied to the canvas once)
const stills = new WeakMap();
function mediaEl(m, it) {
  const host = m._host;
  if (!(it && it.anim) || S('gifs') !== false) { if (host && host.paused && host.play) host.play().catch(() => { /* */ }); return m.el; }
  if (m.frames && m.frames[0]) return m.frames[0];
  let c = stills.get(m);
  if (!c) { c = document.createElement('canvas'); c.width = m.w; c.height = m.h; try { c.getContext('2d').drawImage(m._el || m.el, 0, 0); } catch (e) { return m.el; } stills.set(m, c); }
  if (host && !host.paused && host.pause) host.pause();
  return c;
}
function paintArt(fr, it, key, empty, holo) {
  const T = PO.clock.t;
  ctx.save(); ctx.beginPath(); ctx.rect(fr.x, fr.y, fr.w, fr.h); ctx.clip();
  const GL = PO.TH.gallery;
  ctx.fillStyle = holo ? GL.holoBg : GL.bg; ctx.fillRect(fr.x, fr.y, fr.w, fr.h);
  if (it) {
    const m = PO.getMedia(it.art);
    if (m) {
      const r = fitRect(m.w, m.h, fr.w - 4, fr.h - 4);
      ctx.imageSmoothingEnabled = m.w > r.w * 2;
      ctx.drawImage(mediaEl(m, it), Math.round(fr.x + (fr.w - r.w) / 2), Math.round(fr.y + (fr.h - r.h) / 2), r.w, r.h);
      ctx.imageSmoothingEnabled = false;
      if (!holo) { ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fillRect(fr.x + 6, fr.y, 3, fr.h); }
    } else drawText(PO.mediaErr(it.art) ? PO.t('MISSING') : '...', fr.x + fr.w / 2, fr.y + fr.h / 2 - 3, PO.mediaErr(it.art) ? '#7a3a55' : '#6b5a9a', 1, 'center');
  } else drawText(empty, fr.x + fr.w / 2, fr.y + fr.h / 2 - 3, holo ? '#14564a' : '#33295a', 1, 'center');
  if (holo) {                                                    // scan lines + flicker
    ctx.fillStyle = 'rgba(80,255,200,.10)'; for (let yy = fr.y + ((T * 12) % 3); yy < fr.y + fr.h; yy += 3) ctx.fillRect(fr.x, Math.round(yy), fr.w, 1);
    ctx.fillStyle = 'rgba(160,255,230,.20)'; ctx.fillRect(fr.x, fr.y + ((T * 30) % (fr.h + 8)) - 4, fr.w, 2);
  }
  ctx.restore();
  if (it && it.anim) {                                           // badge for playing content
    const tx = it.art.kind === 'vid' ? 'VID' : 'GIF';
    ctx.fillStyle = 'rgba(5,4,18,.88)'; ctx.fillRect(fr.x + fr.w - 20, fr.y + 2, 18, 9);
    ctx.fillStyle = GL.badge; ctx.fillRect(fr.x + fr.w - 20, fr.y + 2, 1, 9);
    drawText(tx, fr.x + fr.w - 11, fr.y + 4, '#ffd6fa', 1, 'center');
  }
  if (PO.hoverGalKey === key) { ctx.strokeStyle = GL.hover; ctx.lineWidth = 1; ctx.strokeRect(fr.x - 1.5, fr.y - 1.5, fr.w + 3, fr.h + 3); }
  if (it) {
    PO.galHits.push({ x:fr.x, y:fr.y, w:fr.w, h:fr.h, it, key });
    addGlow(fr.x + fr.w / 2, fr.y + fr.h + 6, holo ? 36 : 40, holo ? rgbA(GL.holo) : GL.glow, (holo ? 0.18 : 0.10) + 0.04 * Math.sin(T * 2 + fr.x), 0.3);
  }
}
function drawDesignFrames(fl) {
  const items = galleryLayout().tasarim[fl.i] || [];
  fl.gallery.forEach((fr, i) => paintArt(fr, items[i], 't' + fl.i + ':' + i, PO.t('GALLERY'), false));
}
function drawGalleryFloor(fl) {
  const lay = galleryLayout().galeri[fl.i] || { wall:[], pod:[] };
  fl.wall.forEach((fr, i) => paintArt(fr, lay.wall[i], 'g' + fl.i + ':w' + i, PO.t('EMPTY'), false));
  const T = PO.clock.t, GL = PO.TH.gallery;
  fl.podiums.forEach((p, i) => {
    const it = lay.pod[i], fw = 76, fh = 58, fx = Math.round(p.x - fw / 2), fy = Math.round(p.y - 86 - Math.sin(T * 1.6 + i) * 1.2);
    // light beam: from the pedestal to the frame
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createLinearGradient(0, fy + fh, 0, p.y - 4); g.addColorStop(0, rgbA(GL.holo, .20)); g.addColorStop(1, rgbA(GL.holo, .02));
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(fx + 8, fy + fh); ctx.lineTo(fx + fw - 8, fy + fh); ctx.lineTo(p.x + 22, p.y - 4); ctx.lineTo(p.x - 22, p.y - 4); ctx.closePath(); ctx.fill();
    ctx.restore();
    paintArt({ x:fx, y:fy, w:fw, h:fh }, it, 'g' + fl.i + ':p' + i, '', true);
    ctx.strokeStyle = it ? rgbA(GL.holoLine, .9) : rgbA(GL.holoLine.map(v => v * 0.5), .6); ctx.lineWidth = 1; ctx.strokeRect(fx - 0.5, fy - 0.5, fw + 1, fh + 1);
    ctx.fillStyle = rgbA(GL.holoLine, .9); ctx.fillRect(fx - 2, fy - 2, 5, 1); ctx.fillRect(fx - 2, fy - 2, 1, 5); ctx.fillRect(fx + fw - 3, fy - 2, 5, 1); ctx.fillRect(fx + fw + 1, fy - 2, 1, 5);
    ctx.fillRect(fx - 2, fy + fh + 1, 5, 1); ctx.fillRect(fx - 2, fy + fh - 3, 1, 5); ctx.fillRect(fx + fw - 3, fy + fh + 1, 5, 1); ctx.fillRect(fx + fw + 1, fy + fh - 3, 1, 5);
  });
}
PO.hitGallery = function (wx, wy) {
  const g = PO.galHits;
  for (let i = g.length - 1; i >= 0; i--) { const h = g[i]; if (wx >= h.x - 3 && wx <= h.x + h.w + 3 && wy >= h.y - 3 && wy <= h.y + h.h + 3) return h; }
  return null;
};

/* ------------------------------------------------------------------ ambience: LEDs, steam */
function drawAmbient(fl, dt) {
  const T = PO.clock.t, amb = fl.spec.ambient || {};
  const rk = IM.f_server_rack;
  if (rk && amb.racks) amb.racks.forEach(x => {
    const rx = x - rk.width / 2, ry = fl.y0 + 128 - rk.height;
    ctx.fillStyle = PO.TH.glow.rackLed;
    for (const [lx, ly] of PO.rackLeds) { const ph = (lx * 7 + ly * 13) % 11; if (Math.floor(T * 3 + ph) % 4 === 0) ctx.fillRect(rx + lx, ry + ly, 1, 1); }
    addGlow(x, fl.y0 + 94, 22, PO.TH.glow.rack, 0.10);
  });
}
function spawnSteam(dt, f0, f1) {
  steamT -= dt;
  if (steamT > 0) return;
  steamT = rnd(0.25, 0.5);
  for (let f = f0; f <= f1; f++) {
    const fl = PO.FL[f], amb = fl.spec.ambient || {};
    (amb.coffee || []).forEach(x => { if (Math.random() < 0.7) FX.push({ k:'steam', x:x + rnd(-3, 3), y:fl.y0 + 128 - 44, vx:rnd(-2, 2), vy:rnd(-12, -7), life:0, max:rnd(1.4, 2.2), r:1, c:PO.TH.fx.steam }); });
  }
}
PO.fxBeam = (x, y) => { if (S('beam') === false) return; FX.push({ k:'beam', x, y, life:0, max:0.7 }); };

/* ------------------------------------------------------------------ agent drawing */
function alphaOf(a) {
  const fl = PO.FL[a.f] || PO.lobby;
  let al = 1;
  if (Math.abs(a.x - E.cx) < 3 && a.y < fl.y0 + E.frontY) al = Math.min(al, PO.clamp((a.y - (fl.y0 + E.inY) - 2) / 22, 0, 1));
  const dn = PO.doorNode;
  if (dn && a.f === PO.lobbyIdx) {
    const dd = Math.hypot(a.x - dn.x, a.y - dn.y);
    if (dd < 26) al = Math.min(al, PO.clamp(dd / 26 + 0.05, 0, 1));
  }
  if (a.tele > 0) al = Math.min(al, 1 - (a.tele / 0.5) * 0.9);        // teleport: appears at the new place
  return al;
}
/* ------------------------------------------------------------------ desk highlight + name plate */
// desk highlight: if its owner is selected (persistent, accent color) or the desk/owner is hovered (hover.color; depends on the setting)
function deskHL(ow, key) {
  const oid = ow ? ow.id : null;
  const sel = !!oid && oid === PO.selectedId;
  const hov = (!!oid && oid === PO.hoverId) || (!!key && PO.hoverDeskKey === key);
  if (!sel && !(hov && S('hover.desk'))) return null;
  const T = PO.clock.t;
  return { sel, empty:!oid, color:sel ? accentBright() : PO.settings.hoverColor(), glow:(S('hover.glow') || 0) / 100, pulse:sel ? 0.5 + 0.5 * Math.sin(T * 5) : 0.5 };
}
function drawDeskGlow(cx, by, hl) {
  if (hl.glow > 0) addGlow(cx, by - 18, 74, hl.color, hl.glow * (hl.empty ? 0.16 : 0.26) * (0.8 + 0.4 * hl.pulse), 0.62);
}
// thin neon frame with corner marks + glow (additive rings)
function drawDeskFrame(bx, by, bw, bh, hl) {
  const lw = Math.max(1, Math.min(3, olWidth() - (olWidth() > 2 ? 1 : 0)));
  const k = hl.empty ? 0.55 : 1, pulse = hl.sel ? 0.7 + 0.3 * hl.pulse : 1;
  ctx.save();
  if (hl.glow > 0) {
    ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = hl.color;
    for (let i = 4; i >= 1; i--) { ctx.globalAlpha = hl.glow * 0.09 * k * pulse; ctx.lineWidth = i * 2; ctx.strokeRect(bx - i + 0.5, by - i + 0.5, bw + i * 2 - 1, bh + i * 2 - 1); }
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.fillStyle = hl.color;
  ctx.globalAlpha = 0.55 * k * pulse;                                         // thin full frame
  ctx.fillRect(bx, by, bw, 1); ctx.fillRect(bx, by + bh - 1, bw, 1); ctx.fillRect(bx, by, 1, bh); ctx.fillRect(bx + bw - 1, by, 1, bh);
  ctx.globalAlpha = 0.95 * k * pulse;                                         // corner marks
  const L = Math.min(9, bw >> 2, bh >> 2);
  [[bx, by, 1, 1], [bx + bw, by, -1, 1], [bx, by + bh, 1, -1], [bx + bw, by + bh, -1, -1]].forEach(([x, y, sx, sy]) => {
    ctx.fillRect(sx > 0 ? x : x - L, sy > 0 ? y : y - lw, L, lw);
    ctx.fillRect(sx > 0 ? x : x - lw, sy > 0 ? y : y - L, lw, L);
  });
  ctx.restore();
}

// small 3x5 pixel font: for the desk plate (the 5x7 font does not fit on the plate). Turkish marks are shown with a single pixel above/below.
const MINI = {
  A:'010101111101101', B:'110101110101110', C:'011100100100011', D:'110101101101110', E:'111100110100111', F:'111100110100100', G:'011100101101011',
  H:'101101111101101', I:'111010010010111', J:'001001001101010', K:'101101110101101', L:'100100100100111', M:'101111111101101', N:'111101101101101',
  O:'010101101101010', P:'110101110100100', Q:'010101101111011', R:'110101110101101', S:'011100010001110', T:'111010010010010', U:'101101101101111',
  V:'101101101101010', W:'101101111111101', X:'101101010101101', Y:'101101010010010', Z:'111001010100111',
  0:'111101101101111', 1:'010110010010111', 2:'110001010100111', 3:'110001010001110', 4:'101101111001001', 5:'111100110001110', 6:'011100111101111',
  7:'111001010010010', 8:'111101111101111', 9:'111101111001110', '-':'000000111000000', '.':'000000000000010', '!':'010010010000010', '?':'110001010000010',
};
const MINI_MARK = { 'İ':['I', 'd1'], 'Ö':['O', 'd02'], 'Ü':['U', 'd02'], 'Ğ':['G', 'd02'], 'Ş':['S', 'c1'], 'Ç':['C', 'c1'] };
// text: text converted to upper case; (x, y) = TOP-LEFT of the glyph row (the mark row is one above). Width: 4 px per letter. Returns: the width.
function drawMini(text, x, y, color) {
  ctx.fillStyle = color;
  let cx = x;
  for (const ch of text) {
    if (ch === ' ') { cx += 2; continue; }
    const mk = MINI_MARK[ch], g = MINI[mk ? mk[0] : ch];
    if (!g) { cx += 4; continue; }
    for (let i = 0; i < 15; i++) if (g[i] === '1') ctx.fillRect(cx + (i % 3), y + Math.floor(i / 3), 1, 1);
    if (mk) {
      const t = mk[1];
      if (t === 'd1') ctx.fillRect(cx + 1, y - 2, 1, 1);
      else if (t === 'd02') { ctx.fillRect(cx, y - 2, 1, 1); ctx.fillRect(cx + 2, y - 2, 1, 1); }
      else if (t === 'c1') ctx.fillRect(cx + 1, y + 5, 1, 1);
    }
    cx += 4;
  }
  return cx - x - 1;
}
const miniW = t => { let w = 0; for (const ch of t) w += ch === ' ' ? 2 : 4; return Math.max(0, w - 1); };
// short name for the desk plate (≤ 7 letters; "Hayalet 2" → "HAYALE2")
const plateMemo = new Map();
function plateName(info) {
  const raw = String((info && (info.nick || PO.shortLabel(info))) || ''), hit = plateMemo.get(raw);
  if (hit != null) return hit;
  const out = plateName0(info);
  if (plateMemo.size > 200) plateMemo.clear();
  plateMemo.set(raw, out);
  return out;
}
function plateName0(info) {
  let n = PO.up(String((info && (info.nick || PO.shortLabel(info))) || '')).trim();
  const m = n.match(/^(.*?)\s*(\d+)$/);
  if (m && m[1]) { const room = Math.max(1, 7 - m[2].length); n = m[1].slice(0, room).trim() + m[2]; }
  else if (n.length > 7) n = n.slice(0, 7);
  return n;
}
// manager plate: only the name (the chat title is in the name tag); the name is derived from the character even if it does not come from the server
function bossPlate(a) {
  if (PO.lang !== 'tr') return 'BOSS';                                       // English: a single word that fits on the plate (MANAGER does not fit)
  const n = String((a.info && a.info.nick) || '').trim();
  if (/^m[uü]d[uüiİ]re?$/i.test(n)) return PO.up(n);
  return a.char === 'mudire' ? 'MÜDİRE' : 'MÜDÜR';
}
// plate: on the front face of the desk (above the drawer block), dark background + accent color line. x, y: top-left of the plate
function drawDeskPlate(x, y, info) {
  const t = plateName(info); if (!t) return;
  const w = Math.min(31, miniW(t) + 5), h = 9, px = Math.round(x + 29 - w);       // aligned to the right edge (the side the head does not cover)
  ctx.fillStyle = 'rgba(8,6,24,.92)'; ctx.fillRect(px, y, w, h);
  ctx.fillStyle = accentBright(); ctx.fillRect(px, y + h - 1, w, 1); ctx.fillRect(px, y, 1, h);
  drawMini(t, px + 3, y + 2, '#e8e4ff');
}

function hlGlow(hl, x, y) {
  if (hl.glow > 0) addGlow(x, y, 30, hl.color, hl.glow * (0.32 + 0.16 * hl.pulse), 1.15);
}
// sitting at the desk: seen from behind. The "type_north" frames in the atlas are STANDING frames; so:
//  1) the character is seated PO.SIT px lower (the head sinks to the desk edge), the bottom PO.SIT_CLIP px (legs) are clipped; hips/torso go down behind the chair
//  2) the chair (PO.CHAIR_DY px lower) is drawn in FRONT of the character: the backrest covers the torso, shoulders + head stay above the backrest, elbows are visible at the sides
function drawSeated(a, hl, st, ph) {
  const T = PO.clock.t, p = a.place, dx = p.dx, dy = p.dy;
  const SIT = PO.SIT, sy = dy + 16 + SIT;
  const cx0 = dx - DK.w / 2 + DK.chairX, cy0 = dy - DK.h + DK.chairY + PO.CHAIR_DY;
  const cell = (name, fr, clip, oy) => { if (hl) drawCellOL(a.char, name, fr, dx, sy, clip, 0, oy || 0, hl); drawCell(a.char, name, fr, dx, sy, clip, 0, oy || 0); };
  shadow(dx, cy0 + 27, 32, 6, 0.4);
  if (hl) hlGlow(hl, dx, sy - 22);
  if (st === 'done') {
    // task finished: waits idle at the desk; now and then shrugs and thinks
    const cyc = (T + ph) % 9;
    if (cyc < 1.5 && hasRow(a.char, 'think_north')) cell('think_north', Math.floor(cyc * 4), PO.SIT_CLIP);
    else cell('rot', 2, PO.SIT_CLIP, Math.floor(T * 0.8 + ph) % 2 ? 0 : -1);
  } else {
    const moveY = (st === 'reading' ? ((Math.floor(T * 1.6) % 2) ? 0 : -1) : 0);
    if (st === 'waiting' && hasRow(a.char, 'wave_north')) cell('wave_north', Math.floor(T * 6), PO.SIT_CLIP);
    else if (st === 'thinking' && hasRow(a.char, 'think_north')) cell('think_north', Math.floor(T * 3), PO.SIT_CLIP);
    else if (st === 'thinking') cell('rot', 2, PO.SIT_CLIP, moveY);
    else cell('type_north', Math.floor(T * (st === 'typing' ? 9 : st === 'delegating' ? 4 : 2.2)), PO.SIT_CLIP, moveY);
  }
  if (hl) drawFurnOL('chair_small', cx0, cy0, 0, null, hl);
  drawFurn('chair_small', cx0, cy0);
  a.headTop = sy - (AT.chars[a.char] || { h:47 }).h - 4;
  a.footBase = cy0 + 29;
}

function drawAgent(a) {
  if (a.hidden) return;
  const T = PO.clock.t, L = PO.lobby;
  const info = AT.chars[a.char] || { h:47 };
  const moving = a.path.length > 0;
  const kind = moving ? 'walk' : (a.place ? a.place.kind : 'idle');
  const al = alphaOf(a);
  const hl = agentHL(a);
  ctx.globalAlpha = al;
  // sprite drawing: if highlighted, the outline first (always behind), then the sprite
  const cell = (name, fr, x, y, clip, ox, oy) => { if (hl) drawCellOL(a.char, name, fr, x, y, clip, ox || 0, oy || 0, hl); return drawCell(a.char, name, fr, x, y, clip, ox || 0, oy || 0); };
  let headY = a.y - info.h - 4, footY = a.y;
  if (kind === 'walk') {
    shadow(a.x, a.y + 1);
    if (hl) hlGlow(hl, a.x, a.y - 22);
    cell('walk_' + a.dir, Math.floor(a.walkT * 10), a.x, a.y);
  } else if (kind === 'desk') {
    const ph = (PO.hash(a.id) % 97) / 10;
    drawSeated(a, hl, a.dispState || a.state, ph);
    headY = a.headTop; footY = a.footBase;
  } else if (kind === 'office') {
    const o = a.place, st = a.dispState || a.state;
    const row = st === 'waiting' ? 'sit_wave' : st === 'thinking' ? 'sit_think' : st === 'done' ? 'sit_coffee' : 'sit_type';
    const fr = Math.floor(T * (st === 'typing' ? 8 : st === 'done' ? 2.2 : st === 'waiting' ? 6 : 3));
    if (hl) hlGlow(hl, o.x, o.y + PO.SEAT_DY - 24);
    cell(row, fr, o.x, o.y + PO.SEAT_DY, null) || cell('rot', 0, o.x, o.y + PO.SEAT_DY, null);
    headY = o.y + PO.SEAT_DY - info.h - 4; footY = o.deskY;
  } else if ((kind === 'sofa' || kind === 'arm') && L) {
    const p = a.place;
    const bx = kind === 'sofa' ? L.sofa.x : p.ax, by = kind === 'sofa' ? L.sofa.y : p.ay;
    const name = kind === 'sofa' ? 'sofa_a' : 'armchair';
    const im = furn(name);
    const seatY = kind === 'sofa' ? 19 : 21;
    if (hl) hlGlow(hl, p.x, by - 12);
    if (hasRow(a.char, 'sit_south')) {
      // real sitting frame (atlas "sit_south"): hips on the seat, knees in front, feet on the floor in front of the furniture.
      // The front face of the furniture is not drawn over it (it would cover the legs); on an armchair only the two armrests come to the front.
      const fy = by + (kind === 'sofa' ? PO.SOFA_SIT_DY : PO.ARM_SIT_DY);
      cell('sit_south', 0, p.x, fy);
      if (kind === 'arm' && im) {
        const aw = Math.round(im.width * 0.22), ay0 = seatY - 10, h = im.height - ay0;
        const x0 = Math.round(bx - im.width / 2), y0 = Math.round(by - im.height + ay0);
        ctx.drawImage(im, 0, ay0, aw, h, x0, y0, aw, h);
        ctx.drawImage(im, im.width - aw, ay0, aw, h, x0 + im.width - aw, y0, aw, h);
      }
      headY = fy - info.h - 4 + 2;
    } else {
      cell('rest_south', Math.floor(T * 3 + a.x), p.x, by + (kind === 'sofa' ? 1 : 7), 13);
      if (im) drawFurn(name, bx - im.width / 2, by - im.height, seatY, im.height - seatY);
      headY = by + (kind === 'sofa' ? 1 : 7) - info.h - 4 + 6;
    }
    footY = by;
  } else if (kind === 'arcade') {
    shadow(a.x, a.y + 1);
    if (hl) hlGlow(hl, a.x, a.y - 22);
    cell('type_north', Math.floor(T * 7), a.x, a.y);
  } else if (kind === 'balcony') {
    shadow(a.x, a.y + 1);
    if (hl) hlGlow(hl, a.x, a.y - 22);
    const fr = Math.floor(T * 3.2 + a.x * 0.05);
    cell('vape_east', fr, a.x, a.y);
    if (fr % 8 >= 5 && Math.random() < 0.5) FX.push({ k:'vapor', x:a.x + 9, y:a.y - 36, vx:rnd(8, 18), vy:rnd(-9, -3), life:0, max:rnd(1.6, 2.6), r:rnd(2, 3), c:a.char === 'gasmask' ? PO.TH.fx.vaporMask : PO.TH.fx.vapor });
  } else {
    shadow(a.x, a.y + 1);
    if (hl) hlGlow(hl, a.x, a.y - 22);
    const bob = Math.floor(T * 1.2 + a.x) % 2 ? 0 : -1;
    const face = a.place && a.place.face ? a.place.face : a.dir;
    cell('rot', DIRI[face] || 0, a.x, a.y, null, 0, bob);
  }
  ctx.globalAlpha = 1;
  a.head = { x:a.x, y:headY }; a.foot = footY;
  a.hit = { x0:a.x - 14, y0:headY - 2, x1:a.x + 14, y1:footY + 4 };
}

/* ------------------------------------------------------------------ bubbles */
function bubble(x, y, text, color, alert, alpha) {
  const w = Math.max(11, PO.textW(text) + 7), h = 11;
  const bx = Math.round(x - w / 2), by = Math.round(y - h);
  if (alpha != null) ctx.globalAlpha = alpha;
  if (alert) addGlow(x, by + 5, 22, '#ff3355', 0.6);
  ctx.fillStyle = '#0b0820'; ctx.fillRect(bx - 1, by - 1, w + 2, h + 2);
  ctx.fillStyle = alert ? '#ff4d6a' : '#f4f1ff'; ctx.fillRect(bx, by, w, h);
  ctx.fillStyle = color; ctx.fillRect(bx, by + h - 2, w, 2);
  ctx.fillStyle = '#0b0820'; ctx.fillRect(x - 2, by + h + 1, 5, 2); ctx.fillRect(x - 1, by + h + 3, 3, 1);
  ctx.fillStyle = alert ? '#ff4d6a' : '#f4f1ff'; ctx.fillRect(x - 1, by + h, 3, 2);
  drawText(text, bx + w / 2, by + 2, alert ? '#fff' : '#1b1340', 1, 'center');
  if (alpha != null) ctx.globalAlpha = 1;
}
function drawBubbles(list, f0, f1) {
  const T = PO.clock.t;
  for (const a of list) {
    // desk owner on a break: a faint "ON BREAK" above the desk (so it is clear whose desk it is). The floor check uses the DESK's floor, not the owner's:
    // even if the owner is on another floor (on the sofa in the lobby) the bubble is drawn if the desk's floor is visible.
    if (a.desk && a.breakMode && a.place !== a.desk && a.desk.f >= f0 && a.desk.f <= f1 && S('deskPlates') !== false) {
      const d = a.desk;
      bubble(d.dx, d.dy - DK.h + MON.y - 3, PO.t('ON BREAK'), '#8c86b8', false, 0.62);
    }
    if (a.hidden || a.f < f0 || a.f > f1) continue;
    if (a.path.length) continue;
    const st = a.state, col = stateOf(st).c, kind = a.place ? a.place.kind : 'idle';
    let sym = null, bx = Math.round(a.x), by = Math.round(a.head ? a.head.y : a.y - 52) - 4;
    if (kind === 'desk') {
      by = a.place.dy - DK.h + MON.y - 3; bx = a.place.dx + 24;
      if (st === 'waiting') sym = Math.floor(T * 2.5) % 2 ? '!' : '?';
      else if (st === 'delegating') sym = '>>';
      else if (st === 'thinking') sym = '.'.repeat(1 + Math.floor(T * 2) % 3);
    } else if (kind === 'office') {
      by = a.place.deskY - 74; bx = a.place.deskX + 34;
      if (st === 'waiting') sym = Math.floor(T * 2.5) % 2 ? '!' : '?';
      else if (st === 'delegating') { sym = PO.t('ASSIGNING TASKS..'); bx = a.place.deskX + 8; by = a.place.deskY - 92; }   // when the main agent is assigning tasks
      else if (st === 'thinking') sym = '.'.repeat(1 + Math.floor(T * 2) % 3);
    } else if (kind === 'sofa' || kind === 'arm') {
      sym = Math.floor(T / 1.6) % 2 ? 'Z' : 'ZZ';
    } else if (kind === 'stand' && st !== 'done') {
      sym = '...';
    }
    if (sym) bubble(bx, by, sym, col, st === 'waiting');
  }
}

/* ------------------------------------------------------------------ location marker (when the desk owner is not at their desk) */
// when a desk is selected / the desk or a row in the list is hovered, and the owner is elsewhere: a pulsing ring + arrow where they are
const away = a => !!(a.desk && a.place !== a.desk && !a.leaving);
function computePings(list) {
  const out = [], T = PO.clock.t;
  for (const a of list) {
    if (a.hidden && !a.ride) continue;
    if (!away(a)) continue;
    let color = null;
    if (PO.TEST.ping) color = accentBright();
    else if (a.id === PO.pingId && T < PO.pingUntil) color = accentBright();
    else if (a.id === PO.hoverId && PO.hoverSrc !== 'agent' && S('hover.desk')) color = PO.settings.hoverColor();
    if (color) out.push({ a, color });
  }
  PO.pings = out;
}
function drawPings(f0, f1) {
  const T = PO.clock.t;
  for (const pg of PO.pings || []) {
    const a = pg.a;
    if (a.hidden || a.f < f0 || a.f > f1) continue;
    const fy = (a.foot != null ? a.foot : a.y) + 1, hy = a.head ? a.head.y : a.y - 50;
    ctx.save();
    for (let i = 0; i < 2; i++) {                                             // two expanding rings
      const k = ((T * 0.9) + i * 0.5) % 1;
      ctx.globalAlpha = (1 - k) * 0.9; ctx.strokeStyle = pg.color; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(Math.round(a.x), Math.round(fy), 9 + k * 20, 3.5 + k * 8, 0, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const by = Math.round(hy - 9 + Math.sin(T * 6) * 1.5), bx = Math.round(a.x);        // downward-facing triangle
    ctx.fillStyle = '#0b0820'; ctx.fillRect(bx - 5, by - 1, 11, 2); ctx.fillRect(bx - 4, by + 1, 9, 2); ctx.fillRect(bx - 3, by + 3, 7, 2); ctx.fillRect(bx - 2, by + 5, 5, 2); ctx.fillRect(bx - 1, by + 7, 3, 2);
    ctx.fillStyle = pg.color; ctx.fillRect(bx - 4, by, 9, 1); ctx.fillRect(bx - 3, by + 1, 7, 1); ctx.fillRect(bx - 2, by + 2, 5, 1); ctx.fillRect(bx - 1, by + 3, 3, 1); ctx.fillRect(bx, by + 4, 1, 1);
    ctx.restore();
    addGlow(a.x, fy - 4, 26, pg.color, 0.22, 0.5);
  }
}

/* ------------------------------------------------------------------ "unread reply" hologram at the manager's desk */
function holoMarkOn(id) {
  if (PO.TEST.holomark) return true;
  try { return !!(PO.inbox && PO.inbox.unreadFor && PO.inbox.unreadFor(id) > 0); } catch (e) { return false; }
}
function drawHoloMark(deskX, deskY) {
  const T = PO.clock.t, bob = Math.sin(T * 2.3) * 1.5, pulse = 0.68 + 0.32 * Math.sin(T * 5.2), scan = Math.floor(T * 14);
  const cx = deskX - 28, baseY = deskY - 49, topY = Math.round(baseY - 44 + bob);     // rises from the desk to the left of the laptop (so it does not cover the manager's face)
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (let yy = 0; yy < 34; yy++) {                                                   // scanned light cone (widens upward from the emitter)
    if ((yy + scan) % 3 === 0) continue;
    const k = yy / 34, w = 6 + 16 * k;
    ctx.globalAlpha = 0.20 * (1 - k * 0.7) * pulse; ctx.fillStyle = '#3df2ff';
    ctx.fillRect(Math.round(cx - w / 2), baseY - yy, Math.round(w), 1);
  }
  ctx.globalAlpha = 0.85 * pulse; ctx.fillStyle = '#3df2ff'; ctx.fillRect(cx - 7, baseY, 15, 1); ctx.fillRect(cx - 5, baseY + 1, 11, 1);   // emitter ring
  // floating check mark (✓): two arms at 45°, with scan lines
  const pts = [];
  for (let i = 0; i <= 5; i++) pts.push([cx - 10 + i, topY + 9 + i]);
  for (let i = 0; i <= 10; i++) pts.push([cx - 4 + i, topY + 14 - i]);
  [[1, '#3df2ff', 0.55], [0, '#eaffff', 0.95]].forEach(([grow, col, al]) => {
    ctx.fillStyle = col; ctx.globalAlpha = al * pulse;
    pts.forEach(([px, py]) => {
      if (!grow && (py + scan) % 4 === 0) return;
      if (grow) ctx.fillRect(px - 1, py - 1, 5, 3); else ctx.fillRect(px, py, 3, 1);
    });
  });
  ctx.restore();
  addGlow(cx, topY + 8, 24, '#3df2ff', 0.34 * pulse, 0.9);
}

/* ------------------------------------------------------------------ main drawing */
PO.SEAT_DY = 14;
PO.render = function (dt, list) {
  const T = PO.clock.t, FL = PO.FL, PL = PO.PL, n = FL.length, FH = SC.fh;
  const v = PO.view || { y0:0, y1:PO.H };
  const M = 160;                                   // margin so new floors are ready in the drawing if the camera moves fast
  const f0 = PO.clamp(Math.floor((v.y0 - M - SC.top) / FH), 0, n - 1), f1 = PO.clamp(Math.floor((v.y1 + M - SC.top) / FH), 0, n - 1);
  const roof = v.y0 - M < SC.top, base = v.y1 + M > SC.top + n * FH;
  const cy0 = roof ? 0 : SC.top + f0 * FH, cy1 = base ? PO.H : SC.top + (f1 + 1) * FH;
  ctx.clearRect(0, cy0, W, cy1 - cy0);
  PO.galHits.length = 0;
  PO.drawn = { f0, f1, y0:cy0, y1:cy1 };
  stepSky(dt);
  computePings(list);
  if (roof) drawRoof();
  for (let f = f0; f <= f1; f++) {
    const fl = FL[f];
    drawWindowsSky(fl);
    const strip = IM['fl_' + fl.type];
    if (strip) ctx.drawImage(strip, 0, fl.y0);
    drawPlate(fl);
    drawElevator(fl);
    if (fl.type === 'lobi') drawBoard(fl, list);
    else if (fl.type === 'tasarim') drawDesignFrames(fl);
    else if (fl.type === 'galeri') drawGalleryFloor(fl);
    drawAmbient(fl, dt);
  }
  if (base) drawBase();
  spawnSteam(dt, f0, f1);
  const vis = f => f >= f0 && f <= f1;
  // floor lights: under the desks
  PL.desk.forEach(p => {
    if (!vis(p.f)) return;
    const ow = p.owner ? AG.get(p.owner) : null;
    const seated = ow && ow.place === p;
    const c = seated ? stateOf(ow.state).c : PO.TH.glow.desk;
    addGlow(p.dx, p.dy + 12, 46, c, seated ? (ow.state === 'waiting' ? 0.28 + 0.2 * Math.sin(T * 8) : 0.16) : 0.05, 0.35);
  });
  const L = PO.lobby;
  if (L && vis(L.i)) addGlow(L.sofa.x, L.sofa.y + 10, 90, PO.TH.glow.sofa, 0.16, 0.4);
  const items = [];
  // desks
  const plates = S('deskPlates') !== false;
  PL.desk.forEach(p => {
    if (!vis(p.f)) return;
    items.push({ y:p.dy, d:() => {
      const x0 = p.dx - DK.w / 2, y0 = p.dy - DK.h;
      const ow = p.owner ? AG.get(p.owner) : null;
      const dhl = deskHL(ow, p.key);
      if (dhl) drawDeskGlow(p.dx, p.dy, dhl);
      drawFurn(furn('desk_b') ? 'desk_b' : 'desk_a', x0, y0);
      const pn = PO.DESK_PROPS[p.i % PO.DESK_PROPS.length], pr = furn(pn);
      if (pr) drawFurn(pn, x0 + 67 - pr.width / 2, y0 + 29 - pr.height);
      const st = ow ? (ow.dispState || ow.state) : null;     // the screen shows the owner's state (the ✓ stays even on a break)
      drawMonitor(x0, y0, st || 'done', p.f + ':' + p.i + ':' + (ow ? ow.id : ''), !!ow && !(st === 'done' && S('doneTick') === false));
      if (plates && ow) drawDeskPlate(x0 + 49, y0 + 33, ow.info);
      if (dhl) drawDeskFrame(p.dx - DK.w / 2 - 3, y0 + MON.y - 3, DK.w + 6, DK.h - MON.y + 5, dhl);
    } });
  });
  // manager offices: chair (behind) + desk (in front)
  PL.office.forEach(o => {
    if (!vis(o.f)) return;
    const ch = furn('exec_chair'), dk = furn('exec_desk_clean');
    items.push({ y:o.y - 1, d:() => {
      if (!ch) return;
      const bossA = o.who ? AG.get(o.who) : null, hl = bossA && bossA.place === o ? agentHL(bossA) : null;
      if (hl) drawFurnOL('exec_chair', o.deskX - ch.width / 2, o.y + 8 - ch.height, 0, null, hl);
      drawFurn('exec_chair', o.deskX - ch.width / 2, o.y + 8 - ch.height);
    } });
    items.push({ y:o.deskY, d:() => {
      if (!dk) return;
      const act = o.who ? AG.get(o.who) : null;
      const live = act && act.place === o;
      const done = live && act.state === 'done';
      const tick = done && S('doneTick') !== false;               // if doneTick is off, a dimmed screen instead of the ✓ when the task is done
      const c = live ? (done && !tick ? '#4a4670' : stateOf(act.state).c) : PO.TH.glow.desk;
      const dhl = deskHL(o.owner ? AG.get(o.owner) : null, o.key);
      if (dhl) drawDeskGlow(o.deskX, o.deskY, dhl);
      addGlow(o.deskX, o.deskY + 10, 70, c, live ? (act.state === 'waiting' ? 0.30 + 0.2 * Math.sin(T * 8) : 0.18) : 0.06, 0.3);
      shadow(o.deskX, o.deskY + 2, dk.width + 10, 7, 0.3);
      drawFurn('exec_desk_clean', o.deskX - dk.width / 2, o.deskY - dk.height);
      // laptop lid (covers the manager's chest): the logo glows in the state color, green ✓ when the task is done
      const lx = o.deskX - 12, ly = o.deskY - 48 - 12;
      const LD = PO.TH.lid, dev = IM.f_exec_device;
      if (dev) { ctx.fillStyle = '#05060c'; ctx.fillRect(lx, ly, 24, 13); }                    // themed device: first the dark screen, the mark, then the frame with a hole in the middle (30x16, hole 20x9 @ 5,3)
      else {
        ctx.fillStyle = LD.outline; ctx.fillRect(lx - 1, ly - 1, 26, 15);
        ctx.fillStyle = LD.body; ctx.fillRect(lx, ly, 24, 13);
        ctx.fillStyle = LD.hi; ctx.fillRect(lx, ly, 24, 1);
      }
      if (tick) { line(lx + 8, ly + 6, lx + 11, ly + 9, 2, '#2dff9a'); line(lx + 11, ly + 9, lx + 17, ly + 3, 2, '#2dff9a'); }
      else { ctx.fillStyle = c; ctx.fillRect(lx + 10, ly + 5, 4, 3); ctx.fillRect(lx + 11, ly + 4, 2, 5); }
      if (live) addGlow(o.deskX, ly + 6, 16, tick ? '#2dff9a' : c, done && !tick ? 0.12 : 0.4);
      if (dev) ctx.drawImage(dev, lx - 3, ly - 1);
      else { ctx.fillStyle = LD.base; ctx.fillRect(lx - 3, ly + 13, 30, 2); }
      // name plate: on the desk's ready-made gold plaque (sprite x 60..85, y 40..46)
      if (plates && act) {
        const t = bossPlate(act), tw = miniW(t), px = o.deskX - dk.width / 2 + 72.5 - tw / 2, py = o.deskY - dk.height + 41;
        drawMini(t, Math.round(px), py + 2, '#3a2108');             // text 1 row lower: so the dots of Ü / Ö / İ do not overlap the plaque's bright top edge
      }
      // if there is an unread reply, a pulsing cyan "✓" hologram above the laptop
      if (act && holoMarkOn(act.id)) drawHoloMark(o.deskX, o.deskY);
      if (dhl) drawDeskFrame(o.deskX - dk.width / 2 - 3, o.deskY - dk.height - 14, dk.width + 6, dk.height + 18, dhl);
    } });
  });
  // lobby
  if (L && vis(L.i)) {
    items.push({ y:L.sofa.y, d:() => { const im = furn('sofa_a'); drawFurn('sofa_a', L.sofa.x - im.width / 2, L.sofa.y - im.height); shadow(L.sofa.x, L.sofa.y + 2, 96, 6, 0.3); } });
    items.push({ y:L.table.y, d:() => { const im = furn('coffee_table'); shadow(L.table.x, L.table.y + 1, 50, 5, 0.3); drawFurn('coffee_table', L.table.x - im.width / 2, L.table.y - im.height); } });
    L.armchairs.forEach(c => items.push({ y:c.y, d:() => { const im = furn('armchair'); shadow(c.x, c.y + 1, 40, 5, 0.3); drawFurn('armchair', c.x - im.width / 2, c.y - im.height); } }));
    items.push({ y:L.arcade.y, d:() => {
      const im = furn('arcade'); shadow(L.arcade.x, L.arcade.y + 1, 32, 5, 0.3);
      drawFurn('arcade', L.arcade.x - im.width / 2, L.arcade.y - im.height);
      const pl = PL.arcade[0] && PL.arcade[0].who ? AG.get(PL.arcade[0].who) : null;
      if (pl && pl.place === PL.arcade[0]) addGlow(L.arcade.x, L.arcade.y - 34, 20, PO.TH.glow.arcade, 0.4 + 0.25 * Math.sin(T * 12));
    } });
    L.lamps.forEach(l => items.push({ y:l.y, d:() => { const im = furn('floor_lamp'); drawFurn('floor_lamp', l.x - im.width / 2, l.y - im.height); addGlow(l.x, l.y - 44, 26, PO.TH.glow.lamp, 0.35); } }));
    items.push({ y:L.vape.y, d:() => { const im = furn('vape_stand'); shadow(L.vape.x, L.vape.y + 1, 22, 4, 0.4); drawFurn('vape_stand', L.vape.x - im.width / 2, L.vape.y - im.height); addGlow(L.vape.x, L.vape.y - 42, 14, PO.TH.glow.vape, 0.45); } });
  }
  // agents
  for (const a of list) {
    if (a.hidden || !vis(a.f)) continue;
    const sy = (a.place && a.place.kind === 'desk' && !a.path.length) ? a.place.dy + 16 : (a.place && a.place.kind === 'office' && !a.path.length) ? a.place.y : a.y;
    items.push({ y:sy, d:() => drawAgent(a) });
  }
  items.sort((p, q) => p.y - q.y).forEach(i => i.d());
  drawPings(f0, f1);
  // particles + teleport columns
  for (let i = FX.length - 1; i >= 0; i--) {
    const f = FX[i]; f.life += dt;
    if (f.life > f.max) { FX.splice(i, 1); continue; }
    if (f.y < cy0 - 90 || f.y > cy1 + 10) continue;
    const k = f.life / f.max;
    if (f.k === 'beam') {
      const h = 78, w = 16 * (1 - k * 0.5), al = 1 - k;
      ctx.globalAlpha = al * 0.5; ctx.fillStyle = PO.TH.fx.beam;
      for (let yy = 0; yy < h; yy += 2) { const ww = w * (0.5 + 0.5 * Math.abs(Math.sin(yy * 0.4 + T * 28))); ctx.fillRect(Math.round(f.x - ww / 2), Math.round(f.y - yy), Math.round(ww), 1); }
      ctx.globalAlpha = al * 0.95; ctx.fillStyle = '#ffffff'; ctx.fillRect(Math.round(f.x - 1), Math.round(f.y - h * (1 - k * 0.4)), 2, Math.round(h * (1 - k * 0.4)));
      ctx.globalAlpha = 1;
      addGlow(f.x, f.y - 30, 34, PO.TH.fx.beamGlow, al * 0.5, 1.6);
      continue;
    }
    f.x += f.vx * dt; f.y += f.vy * dt; f.vx *= 0.985; f.vy -= 2 * dt;
    const r = f.r + k * 4;
    ctx.globalAlpha = (1 - k) * 0.55; ctx.fillStyle = f.c;
    ctx.beginPath(); ctx.arc(Math.round(f.x), Math.round(f.y), r, 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
  }
  for (let f = f0; f <= f1; f++) { const g = IM['fg_' + FL[f].type]; if (g) ctx.drawImage(g, 0, FL[f].y0); }
  if (L && vis(L.i) && PO.doorFlash[L.i] > 0) addGlow(L.door[0], L.y0 + 70, 40, PO.TH.glow.door, PO.doorFlash[L.i] * 0.6, 1.6);
  drawBubbles(list, f0, f1);
};
// desk hit (including the monitor): { place, ownerId } or null. Including the office desks (owner is the manager).
PO.hitDesk = function (wx, wy) {
  const dr = PO.drawn; if (!dr) return null;
  const inFloor = f => f >= dr.f0 && f <= dr.f1;
  for (const p of PO.PL.desk) {
    if (!inFloor(p.f)) continue;
    if (wx >= p.dx - DK.w / 2 && wx <= p.dx + DK.w / 2 && wy >= p.dy - DK.h + MON.y - 1 && wy <= p.dy) return { place:p, ownerId:p.owner || null };
  }
  const dk = furn('exec_desk_clean');
  if (dk) for (const o of PO.PL.office) {
    if (!inFloor(o.f)) continue;
    if (wx >= o.deskX - dk.width / 2 && wx <= o.deskX + dk.width / 2 && wy >= o.deskY - dk.height - 14 && wy <= o.deskY) return { place:o, ownerId:o.owner || null };
  }
  return null;
};
PO.hitAgent = function (wx, wy) {
  const arr = [...AG.values()].filter(a => !a.hidden && !a.leaving && a.hit && wx >= a.hit.x0 && wx <= a.hit.x1 && wy >= a.hit.y0 && wy <= a.hit.y1);
  arr.sort((a, b) => b.y - a.y);
  return arr[0] || null;
};
})(window.PO = window.PO || {});
