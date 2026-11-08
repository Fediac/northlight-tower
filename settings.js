'use strict';
/* NorthLight Tower — settings store (storage + application). The UI of the settings window is written separately (PO.settingsUI).
   All modules READ values like PO.settings.get('hover.color'); when they change, PO.settings.onChange(fn) runs.
   Loaded first in <head>: the theme (Purple night / Black) and the accent are applied before the first paint. */
(function (PO) {
const KEY = 'po_settings_v1';
const DEFAULTS = {
  lang: 'en',                    // interface language: 'en' | 'tr' (read by i18n.js; the page reloads when it changes)
  theme: 'cyberpunk',           // WORLD theme (tower visuals): one of the ids in the THEMES list
  dark: 'night',                 // UI COLORS · background: 'night' (Purple night) | 'black' (Black) | 'tone' (the theme's own tone)
  accent: 'auto',                // UI COLORS · accent: 'auto' (follows the theme) | 'violet' | 'cyan' | 'pink' | 'emerald' | 'amber' | 'red' | 'copper'
  font: 1,                       // text size multiplier: 0.92 | 1 | 1.1
  hover: { agent:true, desk:true, color:'auto', width:2, glow:60 },   // color: 'auto' (follows the accent color) or '#rrggbb'; width 1..4; glow 0..100
  nameTags: true,                // name tags under the characters
  deskPlates: true,              // name plates in front of the desks
  breaks: true,                  // those who finished work go on a break now and then
  breakRate: 'normal',           // 'rare' | 'normal' | 'often'
  doneTick: true,                // green ✓ on the monitor of the one who finished
  beam: true,                    // teleport effect
  holo: true,                    // hologram notification when a task is done
  sound: false,                  // beep when waiting for approval / when a task is done
  gifs: true,                    // animated content plays in the gallery
  motion: true,                  // rain / city motion outside the window
  fps: 'smooth',                 // 'smooth' (~30 frames/s) | 'saver' (~15 frames/s)
  compact: false,                // side panel hidden
  asideW: 360,                   // side panel width (px, 300..720)
  perf: false,                   // measurement strip (#perf): world draw time, frame rate
};
const ACCENTS = [
  { id:'violet',  name:'Violet',     color:'#6d4df0', bright:'#9d87ff' },
  { id:'cyan',    name:'Cyber blue', color:'#1fb4c6', bright:'#3df2ff' },
  { id:'pink',    name:'Neon pink',  color:'#c928b4', bright:'#ff5cf0' },
  { id:'emerald', name:'Emerald',    color:'#22b878', bright:'#46ffb0' },
  { id:'amber',   name:'Amber',      color:'#e39a1e', bright:'#ffc44d' },
  { id:'red',     name:'Crimson',    color:'#d23a3a', bright:'#ff6b5e' },
  { id:'copper',  name:'Copper',     color:'#c0702c', bright:'#ffa65c' },
];
/* World themes. `accent`: the accent used when "Match theme" is selected; `sw`: the color strip on the settings card.
   The images of each theme are under assets/themes/<id>/ (missing files come from cyberpunk).
   name / desc are English source text; they are shown on screen with PO.t (the Turkish is in tr_core.js). */
const THEMES = [
  { id:'cyberpunk', name:'Cyberpunk tower',          desc:'Neon, rainy city.',                       accent:'violet',  sw:['#3df2ff', '#ff3df0', '#6d4df0'] },
  { id:'fener',     name:'Gothic lighthouse',        desc:'Stormy ocean, fog, keepers.',             accent:'emerald', sw:['#8fb7a8', '#e0c070', '#1c3a3f'] },
  { id:'buyucu',    name:'Wizard tower',             desc:'Stone tower, crystal balls, runes.',      accent:'violet',  sw:['#b58cff', '#6fe0c0', '#2a2050'] },
  { id:'uzay',      name:'Retro space station',      desc:'Bridge, stars, turbolift.',               accent:'cyan',    sw:['#5ad2ff', '#ff5a4d', '#1a2540'] },
  { id:'steampunk', name:'Steampunk clock tower',    desc:'Brass, gears, steam and airships.',       accent:'copper',  sw:['#d9a05b', '#8a5a2b', '#3a2a1c'] },
  { id:'noir',      name:'Noir detective agency',    desc:'1940s, blinds, red string.',              accent:'red',     sw:['#d8d8d0', '#ff4d3a', '#2a2a2e'] },
  { id:'samuray',   name:'Samurai castle',           desc:'Edo timber, sakura, shoji.',              accent:'pink',    sw:['#ff9ab8', '#c0392b', '#2b1c1c'] },
  { id:'siginak',   name:'Post-apocalyptic bunker',  desc:'Rusty metal, green CRT screens.',         accent:'amber',   sw:['#c8e05a', '#d9a21b', '#2a2c20'] },
  { id:'western',   name:'Wild West town',           desc:'Sheriff\'s office, saloon, desert sunset.', accent:'copper', sw:['#e8a050', '#a8542c', '#4a2c1c'] },
];
const ENUMS = { lang:['en', 'tr'], theme:THEMES.map(t => t.id), dark:['night', 'black', 'tone'], accent:['auto'].concat(ACCENTS.map(a => a.id)), fps:['smooth', 'saver'], breakRate:['rare', 'normal', 'often'] };
const clone = o => JSON.parse(JSON.stringify(o));
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
function merge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!over || typeof over !== 'object') return out;
  for (const k of Object.keys(base)) {
    if (!(k in over)) continue;
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], over[k]);
    else if (typeof over[k] === typeof base[k]) out[k] = over[k];
  }
  return out;
}
// if a broken / old record arrives, convert it to a safe value (so the theme does not break and the panel does not overflow)
function sanitize(s) {
  Object.keys(ENUMS).forEach(k => { if (!ENUMS[k].includes(s[k])) s[k] = DEFAULTS[k]; });
  s.font = isFinite(s.font) ? clampN(s.font, 0.8, 1.3) : 1;
  s.asideW = isFinite(s.asideW) ? Math.round(clampN(s.asideW, 300, 720)) : DEFAULTS.asideW;
  s.hover.width = isFinite(s.hover.width) ? Math.round(clampN(s.hover.width, 1, 4)) : DEFAULTS.hover.width;
  s.hover.glow = isFinite(s.hover.glow) ? Math.round(clampN(s.hover.glow, 0, 100)) : DEFAULTS.hover.glow;
  if (s.hover.color !== 'auto' && !/^#[0-9a-f]{6}$/i.test(String(s.hover.color))) s.hover.color = 'auto';
  return s;
}
function load() {
  let st = clone(DEFAULTS);
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) st = merge(DEFAULTS, JSON.parse(raw));
    else {                                     // migrate from the old individual keys
      if (localStorage.getItem('po_sound') === '1') st.sound = true;
      if (localStorage.getItem('po_compact') === '1') st.compact = true;
    }
  } catch (e) { /* defaults if there is no storage */ }
  return sanitize(st);
}
let stored = load();                           // persistent settings (written to localStorage)
let state = clone(stored);                     // effective settings = persistent + temporary overrides (URL parameters)
const overrides = {};                          // temporary overrides: path -> value (never saved)
// the ?set=… test parameter arrives via a persistent call while the page loads (settingsui.js); writes arriving until loading finishes are counted as temporary
let booting = /[?&]set=/.test(location.search);
document.addEventListener('DOMContentLoaded', () => { booting = false; });

const listeners = new Set();
function save() { try { localStorage.setItem(KEY, JSON.stringify(stored)); } catch (e) { /* */ } }
function getPath(o, path) { return String(path).split('.').reduce((a, k) => (a == null ? undefined : a[k]), o); }
function setPath(o, path, v) { const ks = String(path).split('.'); let a = o; for (let i = 0; i < ks.length - 1; i++) a = a[ks[i]]; a[ks[ks.length - 1]] = v; }

// accent: if 'auto', the color suggested by the theme
function accentId() {
  if (state.accent !== 'auto') return state.accent;
  const t = THEMES.find(x => x.id === state.theme) || THEMES[0];
  return t.accent;
}
function hoverColor() {
  const c = state.hover.color;
  if (c && c !== 'auto' && /^#[0-9a-f]{6}$/i.test(c)) return c;
  return (ACCENTS.find(a => a.id === accentId()) || ACCENTS[0]).bright;
}
function apply() {
  const r = document.documentElement;
  if (r.dataset.dark !== state.dark) r.dataset.dark = state.dark;
  if (r.dataset.accent !== accentId()) r.dataset.accent = accentId();
  if (r.dataset.theme !== state.theme) r.dataset.theme = state.theme;
  r.style.setProperty('--hover', hoverColor());
  r.style.setProperty('--fs', Math.round(13 * state.font * 10) / 10 + 'px');
  r.style.setProperty('--fs-s', Math.round(11.5 * state.font * 10) / 10 + 'px');
  r.style.setProperty('--fs-l', Math.round(15 * state.font * 10) / 10 + 'px');
  r.style.setProperty('--aside-w', state.asideW + 'px');
  r.classList.toggle('compact', !!state.compact);           // <html> class: works even when the body does not exist yet (first paint)
  document.body && document.body.classList.toggle('compact', !!state.compact);
}
function emit(path) { apply(); listeners.forEach(fn => { try { fn(path, getPath(state, path), state); } catch (e) { console.error(e); } }); }

PO.settings = {
  defaults: DEFAULTS,
  ACCENTS,
  THEMES,
  accentId,
  get: path => getPath(state, path),
  all: () => state,
  // opts.temp: temporary change (test parameters like ?dark=black): written only to the effective state, does NOT enter the persistent setting and the store
  set(path, value, opts) {
    const temp = !!(opts && opts.temp) || booting;
    const def = getPath(DEFAULTS, path);
    if (def !== undefined && typeof def !== typeof value) { console.warn('setting type mismatch:', path, value); return; }
    if (temp) {
      if (getPath(state, path) === value) return;
      try { setPath(state, path, value); } catch (e) { console.warn('could not write setting:', path); return; }
      overrides[path] = value;
      sanitize(state);
      emit(path);
      return;
    }
    delete overrides[path];                                    // the user changed it deliberately: the temporary value now replaces the persistent decision
    if (getPath(stored, path) === value && getPath(state, path) === value) return;
    try { setPath(stored, path, value); setPath(state, path, value); } catch (e) { console.warn('could not write setting:', path); return; }
    sanitize(stored); sanitize(state);
    save();
    emit(path);
  },
  reset() { stored = clone(DEFAULTS); state = clone(DEFAULTS); Object.keys(overrides).forEach(k => delete overrides[k]); save(); emit('*'); },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  hoverColor,
  apply,
};
apply();
document.addEventListener('DOMContentLoaded', apply);
// if a second window in the same browser changes the setting, this window adapts too
window.addEventListener('storage', e => {
  if (e.key !== KEY) return;
  stored = load(); state = clone(stored);
  Object.keys(overrides).forEach(k => { try { setPath(state, k, overrides[k]); } catch (x) { /* */ } });
  sanitize(state); emit('*');
});
})(window.PO = window.PO || {});
