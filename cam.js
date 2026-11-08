'use strict';
/* Pixel Office — camera (pan / zoom / focus on a floor), mouse handling, screen-plane labels.
   The camera is smoothed on every screen frame (60 Hz); the world is drawn separately at a lower rate (see main.js). */
(function (PO) {
const W = PO.W;
const S = k => (PO.settings ? PO.settings.get(k) : undefined);
const accentBright = () => { const a = PO.settings && PO.settings.ACCENTS.find(x => x.id === PO.settings.accentId()); return a ? a.bright : '#9d87ff'; };
const cam = { s:1, cx:W / 2, cy:300, ts:1, tcx:W / 2, tcy:300, moved:false };
PO.cam = cam;
PO.view = { x0:0, y0:0, x1:W, y1:600, s:1 };
PO.camMoving = false;
PO.activeUntil = 0;                         // "user is active" until this moment: the draw rate is kept high
PO.touch = (ms = 1500) => { PO.activeUntil = Math.max(PO.activeUntil, performance.now() + ms); };
let cv, vctx, tip, dpr = 1, drag = null, cssW = 960, cssH = 540;

const sMin = () => Math.max(0.12, Math.min(cv.width / W, cv.height / PO.H));
const sMax = () => 7 * dpr;
// strip covered by the column of floor buttons at the top left (device pixels): camera targets should stay outside this strip.
// Measured only when the layout changes / when focusing (no DOM read per frame).
let floorsEl = null, leftPad = 0, padBottom = 0;
function refreshPad() {
  floorsEl = floorsEl || PO.$('#floors');
  const e = floorsEl;
  if (!e || !e.offsetWidth || !cv) { leftPad = padBottom = 0; return; }
  leftPad = Math.min((e.offsetLeft + e.offsetWidth + 8) * dpr, cv.width * 0.45);
  padBottom = (e.offsetTop + e.offsetHeight + 8) * dpr;
}
// box of the zoom bar inside the canvas (device pixels): so the floor plate does not end up under it in a narrow scene
let zoomBox = null;
function refreshZoomBox() {
  zoomBox = null;
  const z = document.getElementById('zoombar');
  if (!z || !cv) return;
  const r = z.getBoundingClientRect(), c = cv.getBoundingClientRect();
  if (!r.width) return;
  zoomBox = { x0:(r.left - c.left - 6) * dpr, x1:(r.right - c.left) * dpr, y0:(r.top - c.top) * dpr, y1:(r.bottom - c.top + 4) * dpr };
}
// leftward shift needed if the (wx, wy, ww, wh) world box overlaps the bar (world pixels); does not go under the column of floor buttons
PO.plateShift = function (wx, wy, ww, wh) {
  const zb = zoomBox; if (!zb || !cv) return 0;
  const s = cam.s, sx0 = (wx - viewLeft()) * s, sx1 = sx0 + ww * s, sy0 = (wy - viewTop()) * s, sy1 = sy0 + wh * s;
  if (sy1 < zb.y0 || sy0 > zb.y1 || sx1 <= zb.x0 || sx0 >= zb.x1) return 0;
  return Math.min((sx1 - zb.x0) / s, Math.max(0, (sx0 - leftPad) / s));
};
function clampCenter(o) {
  const s = o.s, sw = cv.width / s, sh = cv.height / s;
  const p = leftPad / s;
  if (sw >= W + p - 9) o.cx = W / 2 - p / 2;                    // the whole tower fits to the right of the button strip: center of the visible area
  else if (sw >= W) o.cx = W / 2;
  else o.cx = PO.clamp(o.cx, sw / 2 - p, W - sw / 2);
  o.cy = sh >= PO.H ? PO.H / 2 : PO.clamp(o.cy, sh / 2, PO.H - sh / 2);
}
function setTarget(cx, cy, s, instant) {
  cam.ts = PO.clamp(s, sMin(), sMax()); cam.tcx = cx; cam.tcy = cy;
  const t = { s:cam.ts, cx:cam.tcx, cy:cam.tcy }; clampCenter(t);
  cam.tcx = t.cx; cam.tcy = t.cy;
  if (instant) { cam.s = cam.ts; cam.cx = cam.tcx; cam.cy = cam.tcy; }
  PO.touch();
}
PO.setView = setTarget;
const fitW = () => cv.width / (W - 8);

PO.focusAll = instant => { cam.moved = true; setTarget(W / 2, PO.H / 2, sMin(), instant); };
const clampS = s => PO.clamp(s, sMin(), sMax());
PO.focusFloor = (f, instant) => {
  const fl = PO.FL[f]; if (!fl) return;
  refreshPad();
  const narrow = cssW < 640;
  const DW = (PO.SC && PO.SC.desk && PO.SC.desk.w) || 80;
  let s, x, y = fl.y0 + (narrow ? 170 : 150);
  if (narrow) {
    const ds = (fl.desks || []).slice(0, 4);
    if (ds.length) {                                         // the first 4 desks (including the leftmost) fully visible next to the floor buttons
      const x0 = Math.min(...ds.map(d => d.dx)) - DW / 2 - 12, x1 = Math.max(...ds.map(d => d.dx)) + DW / 2 + 14;
      s = clampS(Math.min((cv.width - leftPad) / (x1 - x0), cv.width / 340));
      x = x0 - leftPad / s + cv.width / s / 2;
    } else { s = cv.width / 500; x = fl.type === 'lobi' ? 470 : 360; x -= leftPad / clampS(s) / 2; }
  } else {
    s = fitW(); x = W / 2;
    // if in a short scene the first desk's monitor would end up under the button column: make room (the floor shrinks a bit, shifts right)
    const mTop = cv.height / 2 + (fl.y0 + 122 - y) * s;
    if (fl.desks && fl.desks.length && leftPad && mTop < padBottom) { s = clampS((cv.width - leftPad) / (W - 8)); x = W / 2 - leftPad / s / 2; }
  }
  setTarget(x, y, s, instant);
};
PO.focusAgent = a => {
  if (!a) return;
  cam.moved = true;
  refreshPad();
  const s = Math.min(Math.max(cam.ts, cv.width / 560), cv.width / 340);
  setTarget(a.x - leftPad / clampS(s) / 2, (a.foot || a.y) - 30, s);
  PO.reqFocusFloor = a.f;
};
PO.focusZone = (f, x, y, wWorld, instant) => { refreshPad(); const s = cv.width / wWorld; setTarget(x - leftPad / clampS(s) / 2, y, s, instant); };
PO.currentFloor = () => PO.floorOfY(cam.tcy);
PO.autoFrame = function (instant) {
  // find the busiest floor (else the first code floor)
  const st = PO.floorStats();
  let best = Math.max(0, PO.FL.findIndex(f => f.type === 'kod')), bv = -1;
  st.forEach((s, f) => { const v = s.total + s.wait * 2 - (PO.FL[f].type === 'lobi' ? 0.5 : 0); if (v > bv) { bv = v; best = f; } });
  PO.focusFloor(best, instant == null ? !cam.moved : instant);
};
// save / load the camera state across tabs
PO.camGet = () => ({ tcx:cam.tcx, tcy:cam.tcy, ts:cam.ts, moved:cam.moved });
PO.camSet = (c, instant) => { cam.moved = !!c.moved; setTarget(c.tcx, c.tcy, c.ts, instant); };

PO.initCam = function () {
  cv = PO.$('#cv'); vctx = cv.getContext('2d'); tip = PO.$('#tip');
  PO.fitCanvas();
  addEventListener('resize', () => PO.fitCanvas());
  if (window.ResizeObserver) {
    new ResizeObserver(() => PO.fitCanvas()).observe(cv);
    const fe = PO.$('#floors');                                      // when the floor buttons change (name hidden, floor added) update the left margin
    if (fe) new ResizeObserver(() => { const was = leftPad; refreshPad(); if (leftPad !== was) { if (!cam.moved && PO.FL) PO.focusFloor(PO.currentFloor(), true); else setTarget(cam.tcx, cam.tcy, cam.ts, false); PO.needBlit = true; } }).observe(fe);
  }
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    cam.moved = true;
    const r = cv.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      const f = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      const wx = viewLeft() + (e.clientX - r.left) * dpr / cam.s, wy = viewTop() + (e.clientY - r.top) * dpr / cam.s;
      const ns = PO.clamp(cam.ts * f, sMin(), sMax());
      const fx = (e.clientX - r.left) * dpr / cv.width, fy = (e.clientY - r.top) * dpr / cv.height;
      const nsw = cv.width / ns, nsh = cv.height / ns;
      setTarget(wx - fx * nsw + nsw / 2, wy - fy * nsh + nsh / 2, ns);
    } else {
      const k = 0.9 * dpr / cam.s * (e.deltaMode === 1 ? 16 : 1);
      setTarget(cam.tcx + (e.shiftKey ? e.deltaY * k : e.deltaX * k), cam.tcy + (e.shiftKey ? 0 : e.deltaY * k), cam.ts);
    }
  }, { passive:false });
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
    drag = { x:e.clientX, y:e.clientY, cx:cam.tcx, cy:cam.tcy, moved:false, id:e.pointerId };
    PO.touch();
  });
  cv.addEventListener('pointermove', e => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
      if (drag.moved) { cam.moved = true; setTarget(drag.cx - dx * dpr / cam.s, drag.cy - dy * dpr / cam.s, cam.ts, true); tip.style.display = 'none'; return; }
    }
    hover(e);
  });
  const up = e => {
    if (!drag) return;
    const was = drag; drag = null;
    if (was.moved) return;
    click(e);
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', () => { drag = null; });
  cv.addEventListener('pointerleave', () => { PO.hoverId = null; PO.hoverSrc = null; PO.hoverDeskKey = null; PO.hoverGalKey = null; tip.style.display = 'none'; cv.classList.remove('hand'); PO.needRender = true; });
  cv.addEventListener('dblclick', () => { cam.moved = true; PO.focusFloor(PO.currentFloor()); });
  // the ↑/↓ floor shortcut works only on the scene: in windows (settings, reader, chat, replies, enlarge) and in the side panel the arrow keys do their own job
  const OWN = '#settings, #reader, #chatview, #galleryview, #inboxpop, #lb, #side';
  const overlayOpen = () => {
    try { if (PO.settingsUI && PO.settingsUI.isOpen && PO.settingsUI.isOpen()) return true; } catch (x) { /* */ }
    try { if (PO.chat && PO.chat.isOpen && PO.chat.isOpen()) return true; } catch (x) { /* */ }
    try { if (PO.gallery && PO.gallery.isOpen && PO.gallery.isOpen()) return true; } catch (x) { /* */ }
    const r = document.getElementById('reader');
    if (r && !r.hidden) return true;
    const p = document.getElementById('inboxpop');                                // Replies list: the floor does not change even if focus stays on the button
    return !!(p && !p.hidden && getComputedStyle(p).display !== 'none');
  };
  addEventListener('keydown', e => {
    const t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'Escape' && !PO.lightboxOpen()) PO.select(null);
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.defaultPrevented || (t && (t.isContentEditable || (t.closest && t.closest(OWN)))) || overlayOpen() || PO.lightboxOpen()) return;
    const f = PO.clamp(PO.currentFloor() + (e.key === 'ArrowUp' ? -1 : 1), 0, PO.FL.length - 1);
    cam.moved = true; PO.focusFloor(f); e.preventDefault();
  });
};

PO.fitCanvas = function () {
  if (!cv) return;
  dpr = window.devicePixelRatio || 1; PO.dpr = dpr;
  cssW = cv.clientWidth || 960; cssH = cv.clientHeight || 540;
  const w = Math.max(240, Math.round(cssW * dpr)), h = Math.max(200, Math.round(cssH * dpr));
  refreshPad(); refreshZoomBox();
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; refreshPad(); refreshZoomBox(); setTarget(cam.tcx, cam.tcy, Math.max(cam.ts, sMin()), false); clampCenter(cam); PO.needBlit = true; }
};
const viewLeft = () => cam.cx - cv.width / cam.s / 2;
const viewTop = () => cam.cy - cv.height / cam.s / 2;
PO.toWorld = (clientX, clientY) => {
  const r = cv.getBoundingClientRect();
  return { x:viewLeft() + (clientX - r.left) * dpr / cam.s, y:viewTop() + (clientY - r.top) * dpr / cam.s, rx:clientX - r.left, ry:clientY - r.top };
};
PO.toScreen = (wx, wy) => ({ x:(wx - viewLeft()) * cam.s, y:(wy - viewTop()) * cam.s });   // device pixels

// Turkish genitive suffix (used only in Turkish mode): Hayalet → Hayalet'in, Müdür → Müdür'ün, Defne → Defne'nin, Neko → Neko'nun
function gen(name) {
  name = String(name || '').trim(); if (!name) return '';
  const last = name.slice(-1);
  if (/\d/.test(last)) return name + "'" + ({ 0:'ın', 1:'in', 2:'nin', 3:'ün', 4:'ün', 5:'in', 6:'nın', 7:'nin', 8:'in', 9:'un' }[last]);
  const low = PO.lower(name), V = 'aeıioöuü';
  let v = 'e'; for (let i = low.length - 1; i >= 0; i--) if (V.includes(low[i])) { v = low[i]; break; }
  const suf = 'aı'.includes(v) ? 'ın' : 'ei'.includes(v) ? 'in' : 'ou'.includes(v) ? 'un' : 'öü'.includes(v) ? 'ün' : 'in';
  return name + "'" + (V.includes(low.slice(-1)) ? 'n' : '') + suf;
}
PO.genitive = n => (PO.lang === 'tr' ? gen(n) : String(n || '').trim() + "'s");     // English: Ghost's
const tipRow = (av, title, l2, l3) => `<div style="display:flex;gap:8px;align-items:center">${av}<div style="min-width:0"><b>${PO.esc(title)}</b>${l2 ? `<small style="display:block">${PO.esc(l2)}</small>` : ''}${l3 ? `<small style="display:block">${PO.esc(l3)}</small>` : ''}</div></div>`;
// desk owner's status: At desk / On a break / On the way / Working …
const stateLabel = s => PO.t({ waiting:'Waiting for approval', done:'Done', delegating:'Delegating' }[s] || 'Working');
function deskStatus(a) {
  const info = a.info;
  if (a.desk && a.place !== a.desk) return a.breakMode ? PO.t('On a break') : PO.t('Heading to the desk');
  if (info.state === 'waiting') return PO.t('Waiting for approval');
  if (info.state === 'done') return PO.t('Done, at the desk');
  return PO.friendly ? PO.friendly(info) : stateLabel(info.state);
}
// if the tooltip content has not changed, innerHTML is not rebuilt (so the face image is not reloaded at every mouse move); only the position is updated
let tipHtml = '';
function setTip(html) {
  tip.style.display = 'block';
  if (html !== tipHtml) { tip.innerHTML = html; tipHtml = html; }
}
function hover(e) {
  const p = PO.toWorld(e.clientX, e.clientY);
  const a = PO.hitAgent(p.x, p.y);
  const d = a ? null : PO.hitDesk(p.x, p.y);
  const g = a || d ? null : PO.hitGallery(p.x, p.y);
  const prev = PO.hoverId + '|' + PO.hoverDeskKey;
  PO.hoverId = a ? a.id : d && d.ownerId ? d.ownerId : null;
  PO.hoverSrc = a ? 'agent' : d ? 'desk' : null;
  PO.hoverDeskKey = d ? d.place.key : null;
  if (prev !== PO.hoverId + '|' + PO.hoverDeskKey) PO.needRender = true;           // the highlight shows immediately even in a still scene
  PO.hoverGalKey = g ? g.key : null;
  cv.classList.toggle('hand', !!a || !!g || !!(d && d.ownerId));
  if (a) {
    const i = a.info;
    setTip(tipRow(PO.avatar(i, 32), PO.nameLine(i), i.role || '', PO.friendly(i)));
  } else if (d) {
    const ow = d.ownerId ? PO.AG.get(d.ownerId) : null;
    if (ow) setTip(tipRow(PO.avatar(ow.info, 32), PO.t("{name}'s desk", { name:PO.lang === 'tr' ? gen(PO.nickOf(ow.info)) : PO.nickOf(ow.info) }), deskStatus(ow), ow.info.role || ''));
    else setTip(tipRow('', PO.t('Empty desk'), PO.t('A newly arrived worker sits here'), ''));
  } else if (g) {
    const it = g.it;
    setTip(`<b>${PO.esc(it.art.label || PO.t('Image'))}${it.anim ? ' · ' + PO.esc(PO.t('animated')) : ''}</b><small>${PO.esc(PO.t('{nick} · click to enlarge', { nick:PO.nickOf(it.agent) }))}</small>`);
  } else tip.style.display = 'none';
  if (tip.style.display === 'block') { tip.style.left = Math.min(p.rx + 14, cssW - 250) + 'px'; tip.style.top = Math.min(p.ry + 14, cssH - 80) + 'px'; }
  PO.touch(400);
}
function click(e) {
  const p = PO.toWorld(e.clientX, e.clientY);
  const a = PO.hitAgent(p.x, p.y);
  if (a) { PO.select(a.id === PO.selectedId ? null : a.id, false); return; }
  const d = PO.hitDesk(p.x, p.y);
  if (d) {
    if (!d.ownerId) { PO.select(null); return; }
    const off = d.ownerId === PO.selectedId;
    PO.select(off ? null : d.ownerId, false);                                       // desk → select its owner
    const own = PO.AG.get(d.ownerId);
    if (!off && own && own.desk && own.place !== own.desk) {                        // the owner is not at their desk: the camera shows the desk, the agent's location is marked
      PO.pingId = own.id; PO.pingUntil = PO.clock.t + 6; PO.needRender = true;
      const pl = d.place, cx = pl.dx != null ? pl.dx : pl.deskX, cy = (pl.dy != null ? pl.dy : pl.deskY) - 24;
      cam.moved = true;
      refreshPad();
      const zs = Math.max(cam.ts, cv.width / 340);
      PO.setView(cx - leftPad / clampS(zs) / 2, cy, zs);
    }
    return;
  }
  const g = PO.hitGallery(p.x, p.y);
  if (g) { PO.openGallery(g.it); return; }
  PO.select(null);
}

/* ------------------------------------------------------------------ camera smoothing + visible area */
PO.camStep = function (dt) {
  const k = 1 - Math.exp(-dt * 10);
  const s0 = cam.s, x0 = cam.cx, y0 = cam.cy;
  cam.s += (cam.ts - cam.s) * k; cam.cx += (cam.tcx - cam.cx) * k; cam.cy += (cam.tcy - cam.cy) * k;
  if (Math.abs(cam.ts - cam.s) < 0.002) cam.s = cam.ts;
  if (Math.abs(cam.tcx - cam.cx) < 0.05) cam.cx = cam.tcx;
  if (Math.abs(cam.tcy - cam.cy) < 0.05) cam.cy = cam.tcy;
  clampCenter(cam);
  PO.camMoving = cam.s !== s0 || cam.cx !== x0 || cam.cy !== y0 || cam.s !== cam.ts || cam.cx !== cam.tcx || cam.cy !== cam.tcy;
  const sw = cv.width / cam.s, sh = cv.height / cam.s;
  PO.view = { x0:cam.cx - sw / 2, y0:cam.cy - sh / 2, x1:cam.cx + sw / 2, y1:cam.cy + sh / 2, s:cam.s };
};

/* ------------------------------------------------------------------ drawing: world → visible canvas */
PO.blit = function (list) {
  const s = cam.s, sw = cv.width / s, sh = cv.height / s;
  const left = cam.cx - sw / 2, top = cam.cy - sh / 2;
  drawBackdrop(left, top, s);
  const H = PO.H;
  const x0 = Math.max(0, left), y0 = Math.max(0, top), x1 = Math.min(W, left + sw), y1 = Math.min(H, top + sh);
  vctx.imageSmoothingEnabled = s < 1;
  // fast filter while moving, quality filter once stopped
  if (s < 1) vctx.imageSmoothingQuality = (PO.camMoving || performance.now() < PO.activeUntil) ? 'low' : 'high';
  if (x1 > x0 && y1 > y0) vctx.drawImage(PO.world, x0, y0, x1 - x0, y1 - y0, Math.round((x0 - left) * s), Math.round((y0 - top) * s), Math.round((x1 - x0) * s), Math.round((y1 - y0) * s));
  drawTags(list);
};

/* ------------------------------------------------------------------ around the tower: the night city */
const bgStars = Array.from({ length:90 }, (_, i) => ({ x:(i * 97) % 1000, y:(i * 53) % 700, p:i * 0.7 }));
let bgGrad = null, bgGradH = 0;
PO.onTheme.push(() => { bgGrad = null; });
function drawBackdrop(left, top, s) {
  if (!bgGrad || bgGradH !== cv.height) { bgGrad = vctx.createLinearGradient(0, 0, 0, cv.height); bgGrad.addColorStop(0, PO.TH.backdrop.top); bgGrad.addColorStop(1, PO.TH.backdrop.bottom); bgGradH = cv.height; }
  vctx.fillStyle = bgGrad; vctx.fillRect(0, 0, cv.width, cv.height);
  // draw only if the sides of the tower view are empty
  if (left >= 0 && left + cv.width / s <= W) return;
  const T = PO.skyT || 0;                               // if "movements outside the window" is off, the stars do not twinkle
  vctx.fillStyle = PO.TH.backdrop.star;
  for (const st of bgStars) {
    const sx = ((st.x * 3) % (cv.width + 40)), sy = (st.y % (cv.height * 0.6));
    vctx.globalAlpha = 0.25 + 0.25 * Math.sin(T * 1.3 + st.p);
    vctx.fillRect(Math.round(sx), Math.round(sy), Math.max(1, Math.round(dpr)), Math.max(1, Math.round(dpr)));
  }
  vctx.globalAlpha = 1;
  const near = PO.IM.near;
  if (near) {
    vctx.imageSmoothingEnabled = false;
    const tileW = near.width * s, bottom = (PO.H - top) * s, h = near.height * s;
    const x0 = Math.floor((-left * s) / tileW) - 3;
    vctx.globalAlpha = 0.55;
    for (let i = x0; i < x0 + Math.ceil(cv.width / tileW) + 8; i++) {
      const dx = Math.round(i * tileW);          // fixed like the tower (does not scroll)
      vctx.drawImage(near, dx, Math.round(bottom - h + 24 * s), Math.round(tileW) + 1, Math.round(h));
    }
    vctx.globalAlpha = 1;
  }
}

/* ------------------------------------------------------------------ screen plane: name labels + alert badges */
// small check mark (✓) — not in the font, drawn pixel by pixel. (x, y): top-left, size 5x4 * fs
function tickMark(x, y, fs, color) {
  vctx.fillStyle = color;
  [[0, 2], [1, 3], [2, 2], [3, 1], [4, 0]].forEach(([px, py]) => vctx.fillRect(x + px * fs, y + py * fs, fs, fs));
}
// single line: text (+ optional ✓). Returns: the drawn width
function tagText(text, x, y, color, fs, tick) {
  PO.drawText(vctx, text, x, y, color, fs);
  let w = PO.textW(text, fs);
  if (tick) { tickMark(x + w + 3 * fs, y + 1 * fs, fs, color); w += 3 * fs + 5 * fs; }
  return w;
}
const tagWidth = (text, fs, tick) => PO.textW(text, fs) + (tick ? 8 * fs : 0);
function clipWords(t, n) {
  t = String(t || '').trim(); n = Math.max(4, n);
  if (t.length <= n) return t;
  let c = t.slice(0, n - 1); const sp = c.lastIndexOf(' ');
  if (sp >= Math.floor(n * 0.5)) c = c.slice(0, sp);
  return c.replace(/[\s.,;:\-]+$/, '') + '…';
}
function tagLines(a, css, extra) {
  const i = a.info, nick = PO.nickOf(i) || PO.shortLabel(i);
  const lim = css < 1.1 ? 12 : 20;
  // manager: only the name from afar; when zoomed in "name · chat title" (the title is cut at a word boundary, not left half like "PIXE..")
  const ttl = a.boss && css >= 1.1 && PO.shortLabel(i) && PO.shortLabel(i) !== nick ? PO.shortLabel(i) : '';
  const l1 = a.boss ? PO.clip(nick, 14) + (ttl ? ' · ' + clipWords(ttl, 30 - Math.min(nick.length, 14) - 3) : '') : PO.clip(nick, lim);
  let l2 = '', tick = false, c2 = null;
  if (extra) {                                              // when zoomed in / hovered, second line: task title or what they are doing
    if (i.state === 'done') { if (!a.boss) { l2 = PO.t('Done'); tick = true; c2 = '#7fd9a8'; } }
    else if (a.boss) l2 = PO.clip(PO.friendly(i), 26);
    else l2 = PO.clip(i.role || PO.friendly(i), 28);
  }
  return { l1, l2, tick, c2 };
}
function drawTags(list) {
  const s = cam.s, T = PO.clock.t;
  const css = s / dpr;                                   // how many CSS pixels per 1 world pixel
  const fs = Math.max(1, Math.round(dpr * (css >= 2.6 ? 2 : 1)));
  const tagsOn = S('nameTags') !== false, acc = accentBright();
  const tags = [], dr = PO.drawn;
  const shown = a => !dr || (a.f >= dr.f0 && a.f <= dr.f1);       // the head/foot position of someone on a floor that is not drawn is stale: the label must not hang in the air
  for (const a of list) {
    if (a.hidden || !a.head || !shown(a)) continue;
    const focus = a.id === PO.selectedId || a.id === PO.hoverId;
    if (!tagsOn && !focus) continue;                     // "Name tags" is off: only the selected / hovered one
    const important = a.state !== 'done' || focus || a.boss;
    if (css < 0.7 && !important) continue;
    const foot = PO.toScreen(a.x, (a.foot || a.y) + (a.place && a.place.kind === 'desk' ? 3 : a.boss ? 5 : 6));
    if (foot.x < -60 || foot.x > cv.width + 60 || foot.y < -20 || foot.y > cv.height + 40) continue;
    const L = tagLines(a, css, css >= 1.8 || focus);
    tags.push({ a, x:foot.x, y:foot.y, L, col:PO.stateOf(a.state).c });
  }
  tags.sort((p, q) => p.y - q.y || p.x - q.x);
  const placed = [], row = 13 * fs;
  for (const t of tags) {
    const L = t.L, w = Math.max(tagWidth(L.l1, fs, false), L.l2 ? tagWidth(L.l2, fs, L.tick) : 0) + 7 * fs;
    const hh = L.l2 ? row + 9 * fs : row;
    let bx = Math.round(PO.clamp(t.x - w / 2, 2, cv.width - w - 2)), by = Math.round(t.y);
    for (let k = 0; k < 6; k++) {
      const hit = placed.find(p => bx < p.x + p.w + 2 && bx + w + 2 > p.x && by < p.y + p.h && by + hh > p.y);
      if (!hit) break;
      by = hit.y + hit.h + 1;
    }
    placed.push({ x:bx, y:by, w, h:hh });
    const a = t.a, sub = a.info.sub, boss = a.boss;
    vctx.fillStyle = boss ? 'rgba(52,34,6,.9)' : sub ? 'rgba(6,50,66,.88)' : 'rgba(8,6,28,.86)';
    vctx.fillRect(bx, by, w, hh);
    vctx.fillStyle = t.col; vctx.fillRect(bx, by, 2 * fs, hh);
    if (boss) { vctx.fillStyle = '#ffc44d'; vctx.fillRect(bx, by, w, 1); }
    tagText(L.l1, bx + 4 * fs, by + 3 * fs, boss ? '#ffe3a0' : sub ? '#8ff0ff' : '#ffffff', fs, false);
    if (L.l2) tagText(L.l2, bx + 4 * fs, by + row - 1 * fs, L.c2 || '#b7b0e6', fs, L.tick);
    if (a.id === PO.selectedId) { vctx.strokeStyle = acc; vctx.lineWidth = Math.max(1, dpr); vctx.strokeRect(bx - 0.5, by - 0.5, w + 1, hh + 1); }
  }
  // from afar (tower view) those waiting for approval: red badge above the head
  if (css < 1.4) {
    for (const a of list) {
      if (a.hidden || !a.head || a.state !== 'waiting' || !shown(a)) continue;
      const p = PO.toScreen(a.x, a.head.y - 3);
      if (p.x < -20 || p.x > cv.width + 20 || p.y < -20 || p.y > cv.height + 20) continue;
      const r = Math.max(5, 6 * dpr) * (1 + 0.15 * Math.sin(T * 7));
      vctx.fillStyle = '#ff4d6a'; vctx.beginPath(); vctx.arc(p.x, p.y, r, 0, 7); vctx.fill();
      vctx.strokeStyle = '#fff'; vctx.lineWidth = Math.max(1, dpr); vctx.stroke();
      PO.drawText(vctx, '!', p.x, p.y - 3 * fs, '#fff', fs, 'center');
    }
  }
  drawEdgePings(fs, css);
}
// if the position marker is off screen: at the edge, a triangle facing the agent + their name (to find the desk owner)
function drawEdgePings(fs, css) {
  const T = PO.clock.t, m = 22 * dpr;
  for (const pg of PO.pings || []) {
    const a = pg.a;
    const p = PO.toScreen(a.x, a.y - 30);
    if (p.x >= 0 && p.x <= cv.width && p.y >= 0 && p.y <= cv.height) continue;
    const cx = cv.width / 2, cy = cv.height / 2, dx = p.x - cx, dy = p.y - cy;
    const k = Math.min((cv.width / 2 - m) / Math.max(1e-3, Math.abs(dx)), (cv.height / 2 - m) / Math.max(1e-3, Math.abs(dy)));
    const ex = cx + dx * k, ey = cy + dy * k, ang = Math.atan2(dy, dx), pulse = 1 + 0.18 * Math.sin(T * 7), r = 9 * dpr * pulse;
    vctx.save(); vctx.translate(ex, ey); vctx.rotate(ang);
    vctx.fillStyle = 'rgba(8,6,28,.92)'; vctx.beginPath(); vctx.moveTo(r + 3 * dpr, 0); vctx.lineTo(-r * 0.8 - 2 * dpr, r * 0.95 + 2 * dpr); vctx.lineTo(-r * 0.8 - 2 * dpr, -r * 0.95 - 2 * dpr); vctx.closePath(); vctx.fill();
    vctx.fillStyle = pg.color; vctx.beginPath(); vctx.moveTo(r, 0); vctx.lineTo(-r * 0.8, r * 0.9); vctx.lineTo(-r * 0.8, -r * 0.9); vctx.closePath(); vctx.fill();
    vctx.restore();
    const label = PO.clip(PO.nickOf(a.info), 12), w = PO.textW(label, fs) + 7 * fs, hh = 12 * fs;
    const lx = PO.clamp(ex - w / 2, 2, cv.width - w - 2);
    const ly = PO.clamp(ey + (Math.abs(Math.sin(ang)) > 0.7 ? -Math.sign(dy) * (r + hh + 4 * dpr) : -hh / 2), 2, cv.height - hh - 2);
    vctx.fillStyle = 'rgba(8,6,28,.9)'; vctx.fillRect(Math.round(lx), Math.round(ly), w, hh);
    vctx.fillStyle = pg.color; vctx.fillRect(Math.round(lx), Math.round(ly), 2 * fs, hh);
    PO.drawText(vctx, label, Math.round(lx) + 4 * fs, Math.round(ly) + 3 * fs, '#ffffff', fs);
  }
}
})(window.PO = window.PO || {});
