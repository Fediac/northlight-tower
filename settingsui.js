'use strict';
/* NorthLight Tower — Settings drawer (opens from the right). Class prefix: set-.
   Contract: PO.settingsUI.open() / close() / toggle() / isOpen(). #settingsBtn and #settings wire themselves up.
   A change is applied INSTANTLY (PO.settings.set); while the drawer is open the tower stays visible and mouse events pass to the tower,
   so you can try the color / highlight live while hovering.
   Test parameters: ?settings=1 (opens open) · ?set=dark:black,accent:pink,hover.color:ff00aa (writes a setting; for trying only). */
(function (PO) {
const S = PO.settings;
const byId = id => document.getElementById(id);
const openBtn = byId('settingsBtn');
let root = byId('settings');
if (!root) { root = document.createElement('div'); root.id = 'settings'; document.body.appendChild(root); }
const q = new URLSearchParams(location.search);

/* ---- ?set=path:value,... (for trying) — allows existing keys and values of the same type ---- */
(q.get('set') || '').split(',').forEach(p => {
  const i = p.indexOf(':'); if (i < 1 || !S) return;
  const k = p.slice(0, i).trim(); let v = p.slice(i + 1).trim();
  const cur = S.get(k); if (cur === undefined || (cur && typeof cur === 'object')) return;
  if (v === 'true') v = true; else if (v === 'false') v = false;
  else if (/color$/.test(k) && /^[0-9a-f]{6}$/i.test(v)) v = '#' + v.toLowerCase();
  else if (/^-?\d+(\.\d+)?$/.test(v)) v = +v;
  if (typeof v === typeof cur) S.set(k, v);
});

/* ---- small helpers ---- */
function mk(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
const same = (a, b) => (typeof a === 'number' && typeof b === 'number') ? Math.abs(a - b) < 0.001 : a === b;
const toast = (m, kind) => { if (PO.ui && PO.ui.toast) PO.ui.toast(m, { kind: kind || 'info' }); };
const syncs = [];          // those refreshed on every change
const extSyncs = [];       // those that can change outside the settings (demo office, full screen, measurement strip): also refreshed periodically while open
function beep() {          // small confirmation beep when "Sound" is turned on
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const c = new AC(), o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.05; o.connect(g); g.connect(c.destination); o.start();
    setTimeout(() => { try { o.stop(); c.close(); } catch (e) { /* */ } }, 140);
  } catch (e) { /* skip silently if there is no sound */ }
}

/* ---- skeleton ---- */
root.removeAttribute('hidden');
root.setAttribute('role', 'dialog');
root.setAttribute('aria-modal', 'false');
root.setAttribute('aria-labelledby', 'set-title');
root.tabIndex = -1;
root.inert = true;
const head = mk('div', 'set-head');
const T = PO.t;
const title = mk('h2', '', T('Settings')); title.id = 'set-title';
const xBtn = mk('button', 'set-x', '×'); xBtn.type = 'button'; xBtn.setAttribute('aria-label', T('Close settings')); xBtn.title = T('Close (Esc)');
head.append(title, xBtn);
const body = mk('div', 'set-body');
root.append(head, body);
// while the drawer is open, the side panel under it and its divider are inert so Tab focus does not go to invisible rows (removed on close)
// if the chat (wide Messages) is open, the side panel is already under it: when settings close it must stay inert (the chat clears it itself when it closes)
const setSideInert = on => { const keep = on || !!(PO.chat && PO.chat.isOpen && PO.chat.isOpen()); ['side', 'splitter'].forEach(id => { const el = byId(id); if (el && el.inert !== keep) el.inert = keep; }); };
const scrim = mk('div', 'set-scrim'); scrim.setAttribute('aria-hidden', 'true');
document.body.appendChild(scrim);

function section(name, id, open) {       // collapsible section (.fold, the state is remembered in po_folds)
  const s = mk('section', 'fold set-sec'); s.dataset.fold = 'set-' + id; if (open) s.setAttribute('open', '');
  const h = mk('button', 'fold-h', name); h.type = 'button'; s.appendChild(h);
  const fb = mk('div', 'fold-b'), inner = mk('div'), card = mk('div', 'set-card');
  inner.appendChild(card); fb.appendChild(inner); s.appendChild(fb);
  body.appendChild(s);
  return card;
}
const setA = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };   // write only when it changes (no needless DOM mutation)
const setT = (el, v) => { if (el.textContent !== v) el.textContent = v; };
function labelBlock(name, desc) {
  const lab = mk('div', 'set-lab'); lab.appendChild(mk('b', '', name));
  const d = mk('small', '', desc || ''); d.hidden = !desc; lab.appendChild(d);
  return lab;
}
const dimWhen = (row, fn) => { if (fn) syncs.push(() => row.classList.toggle('set-dim', !!fn())); };
const showWhen = (row, fn) => { syncs.push(() => { const h = !fn(); if (row.hidden !== h) row.hidden = h; }); };

/* ---- controls ---- */
function segment(label, opts, get, set) {
  const box = mk('div', 'set-seg'); box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', label);
  const btns = opts.map(([v, t]) => {
    const b = mk('button', '', t); b.type = 'button'; b.setAttribute('role', 'radio');
    b.addEventListener('click', () => set(v));
    box.appendChild(b); return b;
  });
  box.addEventListener('keydown', e => {
    const dx = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dx) return;
    const i = btns.indexOf(document.activeElement); if (i < 0) return;
    const n = (i + dx + btns.length) % btns.length;
    e.preventDefault(); set(opts[n][0]); btns[n].focus();
  });
  const sync = () => {
    const cur = get(); let any = false;
    btns.forEach((b, i) => { const on = same(cur, opts[i][0]); any = any || on; setA(b, 'aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
    if (!any) btns[0].tabIndex = 0;
  };
  syncs.push(sync);
  return box;
}
function segRow(card, name, key, opts, desc, off) {
  const row = mk('div', 'set-row');
  row.append(labelBlock(name, desc), segment(name, opts, () => S.get(key), v => S.set(key, v)));
  card.appendChild(row); dimWhen(row, off); return row;
}
function switchRow(card, name, desc, get, set, o) {
  o = o || {};
  const row = mk('button', 'set-row set-switch'); row.type = 'button'; row.setAttribute('role', 'switch');
  const track = mk('span', 'set-track'); track.appendChild(mk('i'));
  row.append(labelBlock(name, desc), track);
  row.addEventListener('click', () => set(!get()));
  const sync = () => { setA(row, 'aria-checked', get() ? 'true' : 'false'); };
  syncs.push(sync); if (o.ext) extSyncs.push(sync);
  card.appendChild(row); dimWhen(row, o.off); return row;
}
function sliderRow(card, name, key, desc, off) {
  const row = mk('div', 'set-row');
  const wrap = mk('div', 'set-slider');
  const inp = mk('input'); inp.type = 'range'; inp.min = '0'; inp.max = '100'; inp.step = '5'; inp.setAttribute('aria-label', name);
  const out = mk('output', '', '');
  inp.addEventListener('input', () => { S.set(key, +inp.value); out.textContent = inp.value; });
  wrap.append(inp, out);
  row.append(labelBlock(name, desc), wrap);
  syncs.push(() => { const v = S.get(key); if (document.activeElement !== inp && inp.value !== String(v)) inp.value = v; setT(out, String(v)); });
  card.appendChild(row); dimWhen(row, off); return row;
}
// color swatches: items = [{ v, name, bg?, auto? }]; "Custom…" color picker with custom: { get, set }
function swatchRow(card, name, items, get, set, custom, desc) {
  const row = mk('div', 'set-row set-stack');
  const top = mk('div', 'set-sw-top'); top.appendChild(mk('b', '', name));
  const val = mk('span', 'set-sw-val'); top.appendChild(val);
  const grp = mk('div', 'set-swatches'); grp.setAttribute('role', 'radiogroup'); grp.setAttribute('aria-label', name);
  const btns = items.map(it => {
    const b = mk('button', 'set-sw'); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-label', it.name); b.title = it.name;
    if (it.auto) { b.classList.add('set-sw-auto'); b.textContent = 'A'; } else b.style.background = it.bg;
    b.addEventListener('click', () => set(it.v));
    grp.appendChild(b); return b;
  });
  let cLab = null, cInp = null;
  if (custom) {
    cLab = mk('label', 'set-sw set-sw-custom'); cLab.title = T('Custom color…');
    cInp = mk('input'); cInp.type = 'color'; cInp.setAttribute('aria-label', T('Pick a custom color'));
    let raf = 0;
    cInp.addEventListener('input', () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; custom.set(cInp.value.toLowerCase()); }); });
    cInp.addEventListener('change', () => custom.set(cInp.value.toLowerCase()));
    cLab.appendChild(cInp); grp.appendChild(cLab);
  }
  // roving tabindex (same as Theme / Text size): a single Tab stop, arrows move between the swatches and select; "Custom…" only gets focus
  const stops = cInp ? btns.concat([cInp]) : btns;
  grp.addEventListener('keydown', e => {
    const dx = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dx) return;
    const i = stops.indexOf(document.activeElement); if (i < 0) return;
    const n = (i + dx + stops.length) % stops.length;
    e.preventDefault(); if (n < items.length) set(items[n].v); stops[n].focus();
  });
  row.appendChild(top); if (desc) row.appendChild(mk('small', 'set-sw-desc', desc)); row.appendChild(grp);
  syncs.push(() => {
    const cur = get(); let hit = -1;
    items.forEach((it, i) => { const on = same(String(cur).toLowerCase(), String(it.v).toLowerCase()); if (on) hit = i; setA(btns[i], 'aria-checked', on ? 'true' : 'false'); });
    const isCustom = !!cLab && hit < 0 && /^#[0-9a-f]{6}$/i.test(cur);
    btns.forEach((b, i) => { b.tabIndex = (i === hit || (hit < 0 && !isCustom && i === 0)) ? 0 : -1; });
    if (cInp) cInp.tabIndex = isCustom ? 0 : -1;
    if (cLab) {
      setA(cLab, 'aria-checked', isCustom ? 'true' : 'false');
      cLab.style.background = isCustom ? cur : '';
      if (document.activeElement !== cInp) cInp.value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : (S.hoverColor ? S.hoverColor() : '#ffffff');
      setT(val, hit >= 0 ? items[hit].name : (isCustom ? T('Custom {color}', { color:cur.toLowerCase() }) : ''));
    } else setT(val, hit >= 0 ? items[hit].name : '');
  });
  card.appendChild(row); return row;
}
function buttonRow(card, name, desc, text, onClick) {
  const row = mk('div', 'set-row');
  const b = mk('button', 'set-btn', text); b.type = 'button'; b.addEventListener('click', onClick);
  row.append(labelBlock(name, desc), b); card.appendChild(row);
  return { row, btn: b };
}

/* ---- content (SPEC §6, Turkish labels verbatim) ---- */
const ACC = (S && S.ACCENTS) || [];
const accOf = id => ACC.find(a => a.id === id);

// Theme (world visuals): the setting with the tower, furniture, sky and characters
const THEMES = (S && S.THEMES) || [];
// Language (at the very top): saved when selected and the page reloads. The options are written in their own languages (not translated).
let card = section(T('Language'), 'dil', true);
{
  const row = mk('div', 'set-row');
  const setLang = v => {
    if (v === S.get('lang') && v === PO.lang) return;
    S.set('lang', v);
    try { sessionStorage.setItem('po_open_settings', '1'); } catch (e) { /* */ }
    const u = new URL(location.href); u.searchParams.delete('lang');            // the ?lang= test parameter should not override the new selection
    location.replace(u.href);
  };
  row.append(labelBlock(T('Interface language'), T('The page reloads to apply it.')), segment(T('Language'), [['en', 'English'], ['tr', 'Türkçe']], () => PO.lang, setLang));
  card.appendChild(row);
}
card = section(T('Theme'), 'tema', true);
(function themeGrid() {
  const row = mk('div', 'set-row set-stack');
  const top = mk('div', 'set-sw-top'); top.appendChild(mk('b', '', T('Tower theme'))); const val = mk('span', 'set-sw-val'); top.appendChild(val);
  row.appendChild(top); row.appendChild(mk('small', 'set-sw-desc', T('How the tower, the furniture, the view outside and the floor names look.')));
  const grid = mk('div', 'set-themes'); grid.setAttribute('role', 'radiogroup'); grid.setAttribute('aria-label', T('Tower theme'));
  const btns = THEMES.map(t => {
    const b = mk('button', 'set-theme'); b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.theme = t.id;
    const strip = mk('span', 'set-theme-sw'); t.sw.forEach(c => { const i = mk('i'); i.style.background = c; strip.appendChild(i); });
    b.append(strip, mk('b', '', T(t.name)), mk('small', '', T(t.desc)));
    b.addEventListener('click', () => S.set('theme', t.id));
    grid.appendChild(b); return b;
  });
  grid.addEventListener('keydown', e => {
    const dx = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dx) return;
    const i = btns.indexOf(document.activeElement); if (i < 0) return;
    const n = (i + dx + btns.length) % btns.length;
    e.preventDefault(); S.set('theme', THEMES[n].id); btns[n].focus();
  });
  row.appendChild(grid); card.appendChild(row);
  syncs.push(() => {
    const cur = S.get('theme');
    btns.forEach((b, i) => { const on = THEMES[i].id === cur; setA(b, 'aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
    const t = THEMES.find(x => x.id === cur); setT(val, t ? T(t.name) : '');
  });
})();

// UI colors (the colors of the interface: background + accent)
card = section(T('UI colors'), 'temarengi', true);
segRow(card, T('Background'), 'dark', [['night', T('Purple night')], ['black', T('Black')], ['tone', T('Theme tone')]], T('Background color of panels and windows. "Theme tone" takes the color of the tower theme you picked.'));
swatchRow(card, T('Accent color'),
  [{ v: 'auto', name: T('Match theme'), auto: true }].concat(ACC.map(a => ({ v: a.id, name: T(a.name), bg: 'linear-gradient(135deg, ' + a.color + ', ' + a.bright + ')' }))),
  () => S.get('accent'), v => S.set('accent', v), null, T('Color of buttons and highlights. With "A" selected it follows the tower theme automatically.'));

// Appearance (texts and labels)
card = section(T('Appearance'), 'gorunum', false);
segRow(card, T('Text size'), 'font', [[0.92, T('Small')], [1, T('Normal')], [1.1, T('Large')]], T('Size of the text in the interface.'));
switchRow(card, T('Name tags'), T('Workers\' names show above their heads.'), () => S.get('nameTags'), v => S.set('nameTags', v));
switchRow(card, T('Desk nameplates'), T('The owner\'s name is shown on the front of each desk.'), () => S.get('deskPlates'), v => S.set('deskPlates', v));

// Hover highlight
card = section(T('Hover highlight'), 'hover');
const noHover = () => !S.get('hover.agent') && !S.get('hover.desk');
switchRow(card, T('Outline around workers'), T('Draws an outline around a worker on hover or when selected.'), () => S.get('hover.agent'), v => S.set('hover.agent', v));
switchRow(card, T('Outline around desks'), T('Draws an outline around a desk on hover or when selected.'), () => S.get('hover.desk'), v => S.set('hover.desk', v));
const hoverItems = [{ v: 'auto', name: T('Automatic (follows accent)'), auto: true }];
[['cyan', 'Cyber blue'], ['pink', 'Neon pink'], ['emerald', 'Emerald'], ['amber', 'Amber']].forEach(([id, nm]) => {
  const a = accOf(id); if (a) hoverItems.push({ v: a.bright, name: T(nm), bg: a.bright });
});
hoverItems.push({ v: '#ffffff', name: T('White'), bg: '#ffffff' });
dimWhen(swatchRow(card, T('Outline color'), hoverItems, () => S.get('hover.color'), v => S.set('hover.color', v), { set: v => S.set('hover.color', v) }, T('The color of the outline; pick any color with the last circle.')), noHover);
segRow(card, T('Outline thickness'), 'hover.width', [[1, T('Thin')], [2, T('Normal')], [3, T('Thick')]], T('How thick the outline is.'), noHover);
sliderRow(card, T('Glow'), 'hover.glow', T('The glow around the outline.'), noHover);
card.parentNode.appendChild(mk('p', 'set-note', T('Hover over a worker or a desk to try the color live.')));

// Workers
card = section(T('Workers'), 'calisanlar');
switchRow(card, T('Idle workers take a break now and then'), T('They get up from their desks and walk around the office.'), () => S.get('breaks'), v => S.set('breaks', v));
showWhen(segRow(card, T('Break frequency'), 'breakRate', [['rare', T('Rarely')], ['normal', T('Normal')], ['often', T('Often')]], T('How often breaks happen.')), () => S.get('breaks'));
switchRow(card, T('Show ✓ on the monitor when done'), T('A check mark appears on the screen of a worker who has finished.'), () => S.get('doneTick'), v => S.set('doneTick', v));
switchRow(card, T('Teleport effect'), T('A light effect plays when workers arrive and leave.'), () => S.get('beam'), v => S.set('beam', v));

// Notifications
card = section(T('Notifications'), 'bildirim');
switchRow(card, T('Show a hologram when a task is done'), T('A short summary appears on screen when a worker finishes.'), () => S.get('holo'), v => S.set('holo', v));
switchRow(card, T('Sound'), T('Plays a short beep while waiting for approval and when a task is done.'), () => S.get('sound'), v => { S.set('sound', v); if (v) beep(); });

// Window
card = section(T('Window'), 'pencere');
let pinOn = false;
const pin = buttonRow(card, T('Keep window on top'), T('Keeps the tower above other windows. Windows only.'), T('Keep on top'), async () => {
  pin.btn.disabled = true;
  let r = null;
  try { r = await PO.api.window('toggle'); } catch (e) { r = null; }
  pin.btn.disabled = false;
  if (r && r.ok) { pinOn = !!r.top; paintPin(); toast(pinOn ? T('The window now stays on top.') : T('The window is no longer kept on top.'), 'ok'); }
  else toast(T((r && r.reason) || 'Could not change the window.'), 'bad');
});
function paintPin() { pin.btn.textContent = pinOn ? T('Stop keeping on top') : T('Keep on top'); pin.btn.classList.toggle('on', pinOn); }
switchRow(card, T('Compact view'), T('Hides the side panel, for watching side by side with Claude.'), () => S.get('compact'), v => S.set('compact', v));
switchRow(card, T('Full screen'), T('Opens the tower to fill the whole screen.'), () => !!document.fullscreenElement, v => {
  const done = () => setTimeout(syncExt, 60);
  if (!v) { if (document.fullscreenElement) document.exitFullscreen().then(done, done); return; }
  try { document.documentElement.requestFullscreen().then(done, () => toast(T('Could not open full screen.'), 'bad')); } catch (e) { toast(T('Could not open full screen.'), 'bad'); }
}, { ext: true });
document.addEventListener('fullscreenchange', () => syncExt());

// Advanced (performance + developer settings)
card = section(T('Advanced'), 'gelismis');
segRow(card, T('Frame rate'), 'fps', [['smooth', T('Smooth')], ['saver', T('Saver')]], T('Saver is easier on your computer.'));
switchRow(card, T('Animated gallery'), T('GIFs and videos play.'), () => S.get('gifs'), v => S.set('gifs', v));
switchRow(card, T('Rain and city motion'), T('Rain, traffic and stars move outside the windows.'), () => S.get('motion'), v => S.set('motion', v));
switchRow(card, T('Demo office (fake workers)'), T('Shows fake workers instead of real ones.'), () => !!PO.demo, v => {
  try {
    if (v && PO.startDemo) PO.startDemo();
    else if (!v && PO.stopDemo) PO.stopDemo();
    else toast(T('The demo office is not available right now.'), 'bad');
  } catch (e) { toast(T('Could not switch the demo office.'), 'bad'); }
  syncExt();
}, { ext: true });
{
  const row = mk('div', 'set-row');
  const btn = mk('button', 'set-btn', T('Try approval')); btn.type = 'button';
  btn.addEventListener('click', () => {
    try { toast(PO.testApproval && PO.testApproval() ? T('A fake worker will wait 30 s for approval.') : T('The approval test is not available right now.')); }
    catch (e) { toast(T('Could not start the approval test.'), 'bad'); }
    syncExt();
  });
  row.append(labelBlock(T('Approval test'), T('Tries the "waiting for approval" alert without opening Claude (turns on the demo office).')), btn);
  card.append(row);
}
// measurement strip: live if the shell defined the `perf` setting; otherwise the page reloads with ?perf=1
const perfLive = () => !!(S.defaults && ('perf' in S.defaults));
switchRow(card, T('Performance strip'), T('Shows drawing time and frame rate.'), () => perfLive() ? !!S.get('perf') : !!byId('perf'), v => {
  if (perfLive()) { S.set('perf', v); return; }
  const u = new URL(location.href);
  if (v) u.searchParams.set('perf', '1'); else u.searchParams.delete('perf');
  if (PO.demo) u.searchParams.set('demo', '1');
  u.searchParams.set('settings', '1');
  toast(T('Reloading the page…'));
  setTimeout(() => location.assign(u.href), 300);
}, { ext: true });
// reset: two-step confirmation
{
  const row = mk('div', 'set-row');
  const ctl = mk('div', 'set-confirm');
  const b1 = mk('button', 'set-btn bad', T('Reset')); b1.type = 'button';
  const b2 = mk('button', 'set-btn bad on', T('Yes, reset')); b2.type = 'button';
  const b3 = mk('button', 'set-btn', T('Cancel')); b3.type = 'button';
  ctl.append(b1, b2, b3);
  const lab = labelBlock(T('Reset settings'), T('All settings go back to their defaults.'));
  let timer = 0;
  const ask = on => { clearTimeout(timer); b1.hidden = on; b2.hidden = !on; b3.hidden = !on; lab.querySelector('small').textContent = on ? T('Are you sure? All your settings go back to their defaults.') : T('All settings go back to their defaults.'); if (on) timer = setTimeout(() => ask(false), 6000); };
  ask(false);
  b1.addEventListener('click', () => { ask(true); b3.focus(); });
  b3.addEventListener('click', () => { ask(false); b1.focus(); });
  b2.addEventListener('click', () => {
    ask(false); S.reset();
    if (S.get('lang') !== PO.lang) { try { sessionStorage.setItem('po_open_settings', '1'); } catch (e) { /* */ } location.reload(); return; }   // the language also went back to the default: reload
    toast(T('Settings were reset.'), 'ok'); b1.focus();
  });
  row.append(lab, ctl); card.appendChild(row);
}
// shortcuts (read-only)
{
  const keys = mk('dl', 'set-keys');
  const add = (kbds, text) => {
    const wrap = mk('div'); const dt = mk('dt');
    kbds.forEach(k => dt.appendChild(k === '+' || k === '/' ? mk('span', 'set-plus', k) : mk('kbd', '', k)));
    wrap.append(dt, mk('dd', '', text)); keys.appendChild(wrap);
  };
  add(['Ctrl', '+', '←', '/', '→'], T('Switch chat'));
  add(['↑', '/', '↓'], T('Change floor'));
  add(['Esc'], T('Close window'));
  add([T('Wheel')], T('Scroll floors'));
  add(['Ctrl', '+', T('Wheel')], T('Zoom in / out'));
  const kw = mk('div', 'set-keys-wrap'); kw.appendChild(mk('h4', 'set-keys-h', T('Shortcuts'))); kw.appendChild(keys);
  card.parentNode.appendChild(kw);
}
// Important note (after Advanced): questions that cannot be approved from the tower and the bypass warning
card = section(T('Important note'), 'onemli', false);
{
  const NOTE_EN = 'Folder trust (Trust this workspace) and some permission prompts cannot be approved from this app; answer them in Claude. To work without prompts you can run Claude Code in bypass permissions mode, but be careful: in this mode Claude can write files and run commands without asking. We accept no responsibility.';
  const row = mk('div', 'set-row set-stack');
  row.appendChild(mk('p', '', T(NOTE_EN)));
  if (PO.lang === 'tr') row.appendChild(mk('small', 'set-sw-desc', NOTE_EN));          // in the Turkish view the English version also sits below it (as before)
  card.appendChild(row);
}
body.appendChild(mk('p', 'set-foot', T('Settings are stored on this computer.')));
if (PO.ui && PO.ui.initFolds) PO.ui.initFolds(body);

/* ---- syncing ---- */
function syncAll() { syncs.forEach(f => { try { f(); } catch (e) { console.error(e); } }); }
function syncExt() { extSyncs.forEach(f => { try { f(); } catch (e) { /* */ } }); }
let rafSync = 0, extTimer = 0;
S.onChange(path => {
  if (path === 'compact' || path === '*') setTimeout(() => { if (PO.fitCanvas) PO.fitCanvas(); }, 30);   // when the side panel is hidden, the drawing area is measured again
  if (rafSync || !isOpen) return;                 // no refresh while closed (it is synced on opening anyway); a single frame for frequent changes like dragging the splitter
  rafSync = requestAnimationFrame(() => { rafSync = 0; syncAll(); });
});
syncAll();

/* ---- open / close ---- */
let isOpen = false, lastFocus = null;
function open() {
  if (isOpen) return;
  isOpen = true; lastFocus = document.activeElement;
  syncAll();
  root.inert = false; setSideInert(true); root.classList.add('set-open'); scrim.classList.add('set-open');
  if (openBtn) openBtn.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => { try { root.focus({ preventScroll: true }); } catch (e) { /* */ } });
  clearInterval(extTimer); extTimer = setInterval(syncExt, 700);
}
function close(restoreFocus) {
  if (!isOpen) return;
  isOpen = false;
  clearInterval(extTimer);
  const hadFocus = root.contains(document.activeElement);
  root.classList.remove('set-open'); scrim.classList.remove('set-open');
  root.inert = true; setSideInert(false);
  if (openBtn) openBtn.setAttribute('aria-expanded', 'false');
  if (restoreFocus !== false && hadFocus) { const t = (lastFocus && document.contains(lastFocus) && !root.contains(lastFocus)) ? lastFocus : openBtn; if (t && t.focus) t.focus({ preventScroll: true }); }
}
xBtn.addEventListener('click', () => close(true));
if (openBtn) { openBtn.setAttribute('aria-controls', 'settings'); openBtn.setAttribute('aria-expanded', 'false'); openBtn.addEventListener('click', () => PO.settingsUI.toggle()); }
// Esc closes (leave it to the lightbox / reader if they are open on top)
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !isOpen || e.defaultPrevented) return;
  if (PO.lightboxOpen && PO.lightboxOpen()) return;
  const rd = byId('reader'); if (rd && !rd.hidden) return;
  e.stopImmediatePropagation(); e.preventDefault(); close(true);
}, true);
// a click outside closes — but clicking the tower (#stage) does not close: to try the outline color / selection live
document.addEventListener('pointerdown', e => {
  if (!isOpen || !(e.target instanceof Element)) return;
  if (e.target.closest('#settings, #stage, #settingsBtn, #toasts, #lb, #reader')) return;
  close(false);
}, true);

PO.settingsUI = {
  open, close: () => close(true), toggle() { isOpen ? close(true) : open(); }, isOpen: () => isOpen,
};
let reopen = false;                                // the settings should come open on the page that reloads when the language changes
try { reopen = sessionStorage.getItem('po_open_settings') === '1'; sessionStorage.removeItem('po_open_settings'); } catch (e) { /* */ }
if (q.get('settings') === '1' || reopen) open();
})(window.PO = window.PO || {});
