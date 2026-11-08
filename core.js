'use strict';
/* Pixel Office — core: constants, helpers, pixel font, asset loading.
   All files share a common PO namespace (classic scripts, loaded in order). */
(function (PO) {
const $ = s => document.querySelector(s);
PO.$ = $;
PO.W = 960; PO.H = 1280;

/* ---- states ---- */
// label: the English source name; the `tr` field (old name, for backward compatibility) gives the text to show in the selected language (PO.t(label))
const stDef = (c, label) => ({ c, label, get tr() { return PO.t(label); } });
const ST = {
  typing:     stDef('#46e0a0', 'Working'),          // user-visible name: with no tool info typing / reading / thinking are all "Working" (consistent with the summary counters)
  reading:    stDef('#5cc8ff', 'Working'),
  thinking:   stDef('#c9b8ff', 'Working'),
  delegating: stDef('#ffcf5c', 'Delegating'),
  waiting:    stDef('#ff4d6a', 'Waiting for approval'),
  done:       stDef('#8c86b8', 'Done'),
};
PO.ST = ST;
PO.stateOf = s => ST[s] || ST.thinking;

/* ---- small helpers ---- */
PO.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
PO.clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// shorten a sentence / title: does not cut mid-word (cuts at the last space, appends …). Cuts hard in long text without spaces (file path).
PO.clipWords = (s, n) => {
  s = String(s || '');
  if (s.length <= n) return s;
  let cut = s.slice(0, Math.max(1, n - 1));
  if (!/\s/.test(s.charAt(n - 1))) {                    // if the cut falls in the middle of a word, step back to the last space
    const i = cut.search(/\s\S*$/);
    if (i >= Math.floor(n * 0.3)) cut = cut.slice(0, i);
  }
  return cut.replace(/[\s,;:.\-–—]+$/, '') + '…';
};
PO.hash = s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
PO.rnd = (a, b) => a + Math.random() * (b - a);
// PO.up / PO.lower / PO.locale: i18n.js (upper/lower case by language)
PO.fmtT = ts => { const d = new Date(ts * 1000); return d.toTimeString().slice(0, 8); };
PO.fmtHM = ts => { const d = new Date(ts * 1000); return d.toTimeString().slice(0, 5); };
PO.dur = s => s < 60 ? PO.t('{s} s', { s:Math.round(s) }) : s < 3600 ? PO.t('{m} min {s} s', { m:Math.floor(s / 60), s:Math.round(s % 60) }) : PO.t('{h} h {m} min', { h:Math.floor(s / 3600), m:Math.floor((s % 3600) / 60) });
PO.shortLabel = info => { const l = String((info && info.label) || ''); if (info && info.sub) { const i = l.indexOf(' · '); return i >= 0 ? l.slice(i + 3) : l; } return l; };
PO.clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---- assets ---- */
PO.IM = {};
PO.imgCache = new Map();
const loadImg = src => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => { console.warn('could not load', src); res(null); }; i.src = src; });
const getJSON = u => fetch(u, { cache:'no-store' }).then(r => r.json());
PO.getJSON = getJSON;
PO.loadImg = loadImg;
// external/local images (gallery, agent outputs): loaded on first request, then served from cache
PO.getImg = src => {
  if (!src) return null;
  let e = PO.imgCache.get(src);
  if (!e) {
    e = { img:null, state:'loading' };
    PO.imgCache.set(src, e);
    const i = new Image();
    i.onload = () => { e.img = i; e.state = 'ok'; };
    i.onerror = () => { e.state = 'err'; };
    i.src = src;
  }
  return e.state === 'ok' ? e.img : null;
};

const STAFF = ['hacker', 'punk', 'bluehair', 'cyborg', 'knight', 'gasmask', 'mavi', 'gozluk', 'kedi', 'robot', 'bilim', 'sanatci', 'pilot', 'samuray'];
const BOSSES = ['mudur', 'mudire'];
PO.STAFF = STAFF; PO.BOSSES = BOSSES;
const FURN = ['desk_a', 'desk_b', 'chair_small', 'sofa_a', 'armchair', 'coffee_table', 'arcade', 'vape_stand', 'floor_lamp', 'plant_tall', 'server_rack', 'coffee_machine',
              'prop_mug', 'prop_ramen', 'prop_cactus', 'prop_headphones', 'exec_desk_clean', 'exec_chair', 'easel', 'reception_desk', 'trophy_case'];
PO.DESK_PROPS = ['prop_mug', 'prop_ramen', 'prop_cactus', 'prop_headphones', 'prop_ramen', 'prop_mug', 'prop_headphones', 'prop_cactus'];
// floor names (shown on the sign and in the floor selector). English source; the translated form is written to the screen with PO.t.
const FLOORS_EN = { mudur:'Management', kod:'Code & Research', tasarim:'Design Studio', galeri:'Gallery', lobi:'Lobby & Lounge' };
const FLOORS_SHORT_EN = { mudur:'Management', kod:'Code', tasarim:'Design', galeri:'Gallery', lobi:'Lobby' };
/* floor names of the themes: theme.json carries the original Turkish ones; the English source names are here (the Turkish ones are in tr_core.js).
   A theme not listed here uses the names in theme.json. */
const THEME_FLOORS_EN = {
  buyucu:    { names:{ mudur:'Archmage Council', kod:'Alchemy & Spellcraft', tasarim:'Divination Gallery', galeri:'Crystal Gallery', lobi:'Inn & Tavern' },
               short:{ mudur:'Council', kod:'Alchemy', tasarim:'Divination', galeri:'Crystal', lobi:'Inn' } },
  fener:     { names:{ mudur:'Head Keeper\'s Room', kod:'Radio Room', tasarim:'Archive & Lab', galeri:'Sea Gallery', lobi:'Rocky Pier & Hearth' },
               short:{ mudur:'Keeper', kod:'Radio', tasarim:'Archive', galeri:'Gallery', lobi:'Pier' } },
  noir:      { names:{ mudur:'Chief Inspector\'s Office', kod:'Intel & Typing Pool', tasarim:'Darkroom', galeri:'Evidence Gallery', lobi:'Jazz Club' },
               short:{ mudur:'Inspector', kod:'Intel', tasarim:'Darkroom', galeri:'Evidence', lobi:'Jazz' } },
  samuray:   { names:{ mudur:'Shogun\'s Chamber', kod:'Strategy & Scroll Hall', tasarim:'Ukiyo-e & Calligraphy Gallery', galeri:'Woodblock Print Gallery', lobi:'Sakura Garden & Tea House' },
               short:{ mudur:'Shogun', kod:'Strategy', tasarim:'Ukiyo-e', galeri:'Gallery', lobi:'Garden' } },
  siginak:   { names:{ mudur:'Commander\'s Room', kod:'Terminal & Generator Floor', tasarim:'CRT Screen Gallery', galeri:'Archive Gallery', lobi:'Jukebox & Lounge' },
               short:{ mudur:'Commander', kod:'Terminal', tasarim:'Screens', galeri:'Archive', lobi:'Lounge' } },
  steampunk: { names:{ mudur:'Chief Engineer\'s Room', kod:'Gears & Engineering Floor', tasarim:'Invention Hall', galeri:'Steam Gallery', lobi:'Airship Terrace & Lobby' },
               short:{ mudur:'Engineer', kod:'Gears', tasarim:'Inventions', galeri:'Gallery', lobi:'Terrace' } },
  uzay:      { names:{ mudur:'Captain\'s Bridge', kod:'Engineering & Reactor Deck', tasarim:'Bio-Lab & Holodeck', galeri:'Holo Gallery', lobi:'Observation Deck' },
               short:{ mudur:'Bridge', kod:'Reactor', tasarim:'Bio-Lab', galeri:'Holo', lobi:'Observation' } },
  western:   { names:{ mudur:'Sheriff\'s Office', kod:'Telegraph & Map Room', tasarim:'Posters & Workshop', galeri:'Saloon Gallery', lobi:'Saloon & Lounge' },
               short:{ mudur:'Sheriff', kod:'Telegraph', tasarim:'Workshop', galeri:'Gallery', lobi:'Saloon' } },
};
const trMap = o => { const r = {}; Object.keys(o).forEach(k => { r[k] = PO.t(o[k]); }); return r; };
PO.FLOOR_NAME = trMap(FLOORS_EN);
PO.FLOOR_SHORT = trMap(FLOORS_SHORT_EN);

/* ---- world theme ----
   Each theme lives under assets/themes/<id>/: theme.json (colors, names, particles, `files`: the list of images specific to that theme)
   + bg/ and f/ folders (the SAME file names and pixel sizes as cyberpunk). A file not in the list comes from cyberpunk,
   so a missing piece does not break the tower. The layout (scene.json) is the same in all themes. */
const BASE_TH = {
  id:'cyberpunk', name:'Cyberpunk tower', files:[],
  floorNames:Object.assign({}, FLOORS_EN),
  floorShort:Object.assign({}, FLOORS_SHORT_EN),
  acc:{},                                                   // floor accent colors: { kod:[r,g,b], ... } (scene.json if empty)
  backdrop:{ top:'#05040f', bottom:'#14103a', star:'#cfe8ff' },
  roof:{ top:'#05040f', bottom:'#2a1650', star:'#cfe8ff', mast:'#1b1744', blink:'#ff4d6a', blinkGlow:'#ff3355',
         signBg:'#04122a', signEdge:'#3df2ff', signHi:'rgba(61,242,255,.35)', signGlow:'#3df2ff', t0:'#ff3df0', t1:'#c9fbff', t2:'#7f9ad0' },
  base:{ fill:'#070515', line:'#7a5cff', dash:'#17123a' },
  sky:{ fill:'#0a0820', tint:'rgba(12,8,40,.22)', particle:{ kind:'rain', color:'rgba(160,220,255,.32)', size:1 },
        vehicles:{ colors:['#ffd27a', '#7af0ff', '#ff7ae8'], w:2, h:1 } },
  fx:{ beam:'#7ff6ff', beamGlow:'#5af0ff', vapor:'#9af6ff', vaporMask:'#ff9af0', steam:'#e4f8ff' },
  glow:{ lamp:'#ff3df0', sofa:'#ff3df0', vape:'#3df2ff', arcade:'#4aa8ff', door:'#3df2ff', desk:'#7a5cff', rack:'#46e0a0', rackLed:'#14112b' },
  gallery:{ badge:'#ff3df0', hover:'#ff3df0', glow:'#ff3df0', holo:[45, 255, 200], holoLine:[80, 255, 210], bg:'#070612', holoBg:'#031512' },
  board:{ bg:'#060a14', title:'#3df2ff', ticker:'#46e0a0', tickerBg:'#0c1a2c', line:'#17405a' },
  elev:{ leaf:'#2a2f54', line:'#1d213f', edge:'#3b4172', inner:['#fff4cf', '#e9cf93', '#a98348'], glow:'#ffe3a0' },
  mon:{ outline:'#05040e', frame:'#242949', hi:'#353b69', lo:'#14172e', stand:'#1b1e3a', foot:'#272b50', off:'#2a2650', bezel:true },
  lid:{ outline:'#0b0a1c', body:'#2c2f4a', hi:'#3a3e60', base:'#1a1c32' },
};
PO.BASE_TH = BASE_TH;
PO.TH = JSON.parse(JSON.stringify(BASE_TH));
PO.themeId = 'cyberpunk'; PO.themeVersion = 0;
PO.onTheme = [];                                           // functions to call when the theme changes (draw.js caches, floor names…)
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(base, over) {
  const out = JSON.parse(JSON.stringify(base));
  if (!isObj(over)) return out;
  for (const k of Object.keys(over)) out[k] = isObj(out[k]) && isObj(over[k]) ? deepMerge(out[k], over[k]) : over[k];
  return out;
}
const EXTRA_FURN = ['monitor', 'exec_device'];            // parts used only if the theme has them (drawn procedurally in cyberpunk)
PO.themeUrl = (th, rel) => (th.files && th.files.includes(rel)) ? `assets/themes/${th.id}/${rel}` : `assets/${rel}`;
async function fetchTheme(id) {
  let man = {};
  try { man = await getJSON(`assets/themes/${id}/theme.json`); } catch (e) { if (id !== 'cyberpunk') console.warn('could not load theme manifest:', id); }
  const th = deepMerge(BASE_TH, man); th.id = id;
  if (!Array.isArray(th.files)) th.files = [];
  return th;
}
let themeSeq = 0;
// loads the theme; switches in ONE step once the images are ready (the old theme stays visible while loading)
PO.switchTheme = async function (id) {
  const my = ++themeSeq;
  const th = await fetchTheme(id);
  if (my !== themeSeq) return false;
  const jobs = [['far', 'bg/skyline_far.png'], ['near', 'bg/skyline_near_keyed.png']];
  Object.keys(PO.SC.types).forEach(t => { jobs.push(['fl_' + t, `bg/floor_${t}.png`]); jobs.push(['fg_' + t, `bg/floor_${t}_glass.png`]); });
  FURN.forEach(f => jobs.push(['f_' + f, `f/${f}.png`]));
  EXTRA_FURN.forEach(f => { if (th.files.includes(`f/${f}.png`)) jobs.push(['f_' + f, `f/${f}.png`]); });
  // themed characters: assets/themes/<id>/atlas/{atlas.json,<character>.png}; a missing character comes from the cyberpunk atlas
  let atp = null;
  if (th.files.includes('atlas/atlas.json')) { try { atp = await getJSON(`assets/themes/${id}/atlas/atlas.json`); } catch (e) { console.warn('could not read theme atlas:', id); } }
  if (my !== themeSeq) return false;
  if (atp && (atp.cell !== PO.AT_BASE.cell || !isObj(atp.chars))) atp = null;
  const themed = [];
  if (atp) Object.keys(PO.AT_BASE.chars).forEach(c => { if (atp.chars[c] && th.files.includes(`atlas/${c}.png`)) { themed.push(c); jobs.push(['c_' + c, `atlas/${c}.png`]); } });
  const out = {};
  await Promise.all(jobs.map(async ([k, rel]) => { out[k] = await loadImg(PO.themeUrl(th, rel)); }));
  if (my !== themeSeq) return false;
  Object.keys(PO.AT_BASE.chars).forEach(c => {              // first cyberpunk, then the themed characters that can be loaded on top
    const ok = themed.includes(c) && out['c_' + c];
    const info = ok ? Object.assign({}, atp.chars[c], { anchor: PO.AT_BASE.chars[c].anchor, boss: PO.AT_BASE.chars[c].boss }) : PO.AT_BASE.chars[c];
    PO.AT.chars[c] = info;
    out['c_' + c] = ok ? out['c_' + c] : PO.IM_BASE['c_' + c];
  });
  EXTRA_FURN.forEach(f => { if (!(('f_' + f) in out)) out['f_' + f] = null; });
  Object.assign(PO.IM, out);
  PO.TH = th; PO.themeId = id; PO.themeVersion++;
  const en = THEME_FLOORS_EN[id];
  Object.assign(PO.FLOOR_NAME, trMap(Object.assign({}, BASE_TH.floorNames, th.floorNames, en && en.names)));
  Object.assign(PO.FLOOR_SHORT, trMap(Object.assign({}, BASE_TH.floorShort, th.floorShort, en && en.short)));
  PO.onTheme.forEach(fn => { try { fn(th); } catch (e) { console.error('[theme]', e); } });
  PO.needRender = true; PO.needBlit = true;
  return true;
};
// refreshes floor names / accent colors for the selected theme (floor buttons and signs)
PO.applyThemeToFloors = function () {
  if (!PO.FL) return;
  const th = PO.TH, cnt = {};
  PO.FL.forEach(fl => { cnt[fl.type] = (cnt[fl.type] || 0) + 1; });
  PO.FL.forEach(fl => {
    const sfx = cnt[fl.type] > 1 ? ' ' + fl.k : '';
    fl.name = (PO.FLOOR_NAME[fl.type] || fl.spec.name) + sfx;
    fl.short = (PO.FLOOR_SHORT[fl.type] || fl.spec.name) + sfx;
    fl.acc = th.acc[fl.type] || fl.spec.acc;
  });
  if (PO.buildFloorChips) PO.buildFloorChips();
};

PO.loadAssets = async function () {
  const [SC, AT, FONT, NAMES] = await Promise.all([getJSON('scene.json'), getJSON('assets/atlas/atlas.json'), getJSON('font5x7.json'), getJSON('assets/names.json')]);
  PO.SC = SC; PO.AT = AT; PO.FONT = FONT; PO.NAMES = NAMES;
  PO.STAFF = STAFF.filter(c => AT.chars[c] && !AT.chars[c].boss);          // those whose atlas is ready
  PO.BOSSES = BOSSES.map(c => (AT.chars[c] ? c : null));
  const jobs = [];
  Object.keys(AT.chars).forEach(c => jobs.push(['c_' + c, `assets/atlas/${c}.png`]));
  await Promise.all(jobs.map(async ([k, s]) => { PO.IM[k] = await loadImg(s); }));
  PO.AT_BASE = { cell: AT.cell, chars: Object.assign({}, AT.chars) };      // cyberpunk characters: fall back here if the themed atlas is missing/fails to load
  PO.IM_BASE = {}; Object.keys(AT.chars).forEach(c => { PO.IM_BASE['c_' + c] = PO.IM['c_' + c]; });
  const want = (PO.settings && PO.settings.get('theme')) || 'cyberpunk';
  if (!(await PO.switchTheme(want)) || !PO.IM.fl_kod) await PO.switchTheme('cyberpunk');   // cyberpunk if the selected theme cannot be opened
  if (PO.settings) PO.settings.onChange(path => {
    if (path !== 'theme' && path !== '*') return;
    const id = PO.settings.get('theme');
    if (id === PO.themeId) return;
    PO.switchTheme(id).then(ok => { if (ok) PO.applyThemeToFloors(); });
  });
};

/* ---- gallery media: still image / animated GIF-WEBP / video. Gives {el,w,h} if ready to draw, else null ---- */
let mediaHost = null;
const MEDIA = new Map();
function host() {
  if (!mediaHost) {
    mediaHost = document.createElement('div');
    mediaHost.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:.02;pointer-events:none;z-index:-1';
    document.body.appendChild(mediaHost);
  }
  return mediaHost;
}
PO.mediaErr = art => { const e = art && MEDIA.get(art.src); return !!(e && e.err); };
PO.isAnim = art => !!art && (art.kind === 'vid' || !!art.anim || /\.(gif)(\?|$)/i.test(String(art.src || '')));
// GIF/WEBP frames are decoded once with the browser's decoder (ImageDecoder) and their durations read; the frame is chosen by the time elapsed in drawing.
// (The <img> animation in the DOM advances only if it is painted on screen; this path does not depend on painting.) <img> fallback if there is no decoder.
let decodedBytes = 0;                                    // total memory of decoded GIF frames (limit: 48 MB per GIF, 400 MB total)
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
    if (!n || n > 600 || bytes > 48e6 || decodedBytes + bytes > 400e6) { first.image.close(); throw new Error('too large'); }
    decodedBytes += bytes; reserved = bytes;
    const frames = [], durs = [];
    for (let i = 0; i < n; i++) {
      const res = i === 0 ? first : await dec.decode({ frameIndex:i });
      durs.push(Math.max(20, (res.image.duration || 100000) / 1000));
      frames.push(await createImageBitmap(res.image));
      res.image.close();
    }
    if (MEDIA.get(src) !== e) { frames.forEach(f => f.close()); decodedBytes -= bytes; reserved = 0; throw new Error('released'); }
    e.bytes = bytes; reserved = 0;
    return { frames, durs, w, h };
  } catch (err) {
    if (reserved) decodedBytes -= reserved;
    throw err;
  } finally { dec.close(); }
}
function domAnim(e, src) {
  const i = new Image(); i.decoding = 'async';
  i.onload = () => { e._el = i; e.w = i.naturalWidth; e.h = i.naturalHeight; e.ok = e.w > 0; };
  i.onerror = () => { e.err = true; };
  host().appendChild(i);
  i.src = src;
}
PO.getMedia = function (art) {
  if (!art || !art.src) return null;
  const src = art.src;
  let e = MEDIA.get(src);
  if (!e) {
    const kind = art.kind === 'vid' ? 'vid' : PO.isAnim(art) ? 'anim' : 'img';
    e = {
      kind, _el:null, frames:null, durs:null, total:0, t0:0, w:0, h:0, ok:false, err:false, used:0,
      get el() {
        if (!this.frames) return this._el;
        const t = (performance.now() - this.t0) % this.total;
        let a = 0;
        for (let i = 0; i < this.frames.length; i++) { a += this.durs[i]; if (t < a) return this.frames[i]; }
        return this.frames[0];
      },
    };
    MEDIA.set(src, e);
    if (kind === 'vid') {
      const v = document.createElement('video');
      v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true; v.preload = 'auto';
      v.addEventListener('loadeddata', () => { e._el = v; e.w = v.videoWidth; e.h = v.videoHeight; e.ok = v.videoWidth > 0; });
      v.addEventListener('error', () => { e.err = true; });
      v.src = src; host().appendChild(v); v.play().catch(() => { /* user interaction may be required */ });
      e._host = v;
    } else if (kind === 'anim') {
      if (window.ImageDecoder) {
        decodeAnim(e, src).then(d => { e.frames = d.frames; e.durs = d.durs; e.total = d.durs.reduce((p, q) => p + q, 0); e.t0 = performance.now(); e.w = d.w; e.h = d.h; e.ok = true; })
          .catch(() => { if (MEDIA.get(src) === e) domAnim(e, src); });
      } else domAnim(e, src);
    } else {
      const i = new Image(); i.decoding = 'async';
      i.onload = () => { e._el = i; e.w = i.naturalWidth; e.h = i.naturalHeight; e.ok = e.w > 0; };
      i.onerror = () => { e.err = true; };
      i.src = src;
    }
  }
  e.used = performance.now();
  return e.ok ? e : null;
};
setInterval(() => {                                      // release animated media that has not been drawn for 20 s (memory + CPU)
  const now = performance.now();
  for (const [src, e] of MEDIA) {
    if (e.kind === 'img' || now - e.used < 20000) continue;
    if (e.frames) { e.frames.forEach(b => { try { b.close(); } catch (x) { /* */ } }); decodedBytes -= e.bytes || 0; }
    const el = e._host || e._el;
    if (el && el.parentNode) el.parentNode.removeChild(el);
    if (e.kind === 'vid' && el) { el.removeAttribute('src'); el.load(); }
    MEDIA.delete(src);
  }
}, 8000);

/* ---- pixel font (5x7, with Turkish accents) ---- */
const glyphCache = new Map();
const MARKS = { 'İ':['I', [[2, -2]]], 'Ş':['S', [[2, 7]]], 'Ç':['C', [[2, 7]]], 'Ğ':['G', [[1, -2], [3, -2], [2, -1]]], 'Ü':['U', [[1, -2], [3, -2]]], 'Ö':['O', [[1, -2], [3, -2]]] };
function glyph(ch, color, scale) {
  const key = ch + color + scale;
  let g = glyphCache.get(key);
  if (g) return g;
  let base = ch, marks = [];
  if (MARKS[ch]) { base = MARKS[ch][0]; marks = MARKS[ch][1]; }
  const rows = PO.FONT[base] || PO.FONT['?'];
  const c = document.createElement('canvas'); c.width = 6 * scale; c.height = 11 * scale;
  const g2 = c.getContext('2d'); g2.fillStyle = color;
  rows.forEach((row, ry) => { for (let rx = 0; rx < 5; rx++) if (row[rx] === '1') g2.fillRect(rx * scale, (ry + 2) * scale, scale, scale); });
  marks.forEach(([mx, my]) => g2.fillRect(mx * scale, (my + 2) * scale, scale, scale));
  glyphCache.set(key, c);
  return c;
}
const norm = t => PO.up(t).replace(/[—–]/g, '-').replace(/…/g, '..').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
PO.textW = (t, scale = 1) => Math.max(0, norm(t).length * 6 * scale - scale);
PO.drawText = function (c, text, x, y, color = '#fff', scale = 1, align = 'left') {
  text = norm(text);
  let cx = Math.round(align === 'center' ? x - (text.length * 6 * scale - scale) / 2 : align === 'right' ? x - (text.length * 6 * scale - scale) : x);
  y = Math.round(y);
  for (const ch of text) {
    if (ch !== ' ') c.drawImage(glyph(ch, color, scale), cx, y - 2 * scale);
    cx += 6 * scale;
  }
};

/* ---- light (glow) ---- */
const glowCache = new Map();
function glowSprite(color, r) {
  const k = color + r; let c = glowCache.get(k); if (c) return c;
  c = document.createElement('canvas'); c.width = c.height = r * 2;
  const g = c.getContext('2d'); const gr = g.createRadialGradient(r, r, 0, r, r, r);
  gr.addColorStop(0, color); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, r * 2, r * 2);
  glowCache.set(k, c); return c;
}
PO.addGlow = function (ctx, x, y, r, color, a = 0.5, sy = 1) {
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = a;
  ctx.translate(x, y); ctx.scale(1, sy);
  ctx.drawImage(glowSprite(color, r), -r, -r);
  ctx.restore();
};
PO.shadow = function (ctx, x, y, w = 18, h = 5, a = 0.35) {
  ctx.fillStyle = `rgba(0,0,0,${a})`;
  ctx.beginPath(); ctx.ellipse(Math.round(x), Math.round(y), w / 2, h / 2, 0, 0, 7); ctx.fill();
};
})(window.PO = window.PO || {});
