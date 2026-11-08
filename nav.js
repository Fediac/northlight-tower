'use strict';
/* Pixel Office — left sidebar: Claude Code chats, grouped by project folder (like the Claude Desktop sidebar).
   The list comes from the server page by page (/sessions/recent?offset&limit&q; search is on the server), grouping happens here (project field of the item).
   A clicked chat is added as a tab (pinned on the server, PO.addSession) or, if it is already open, that tab is switched to.
   On a wide screen (>= 900 px) it takes space to the left of the stage (the stage narrows; the canvas resizes with its own ResizeObserver, same path as the splitter);
   on a narrow screen it opens as an overlay above the stage. All texts via textContent. Tree: ARIA "tree" pattern (roving tabindex, ↑↓ ←→ Enter Esc). */
(function (PO) {
const $ = PO.$;
const PAGE = 200;            // chats requested from the server at once (the server's upper limit is also 200)
const SHOW = 5, MORE = 10;   // chats shown first per project / each press of "Show more" adds this many
const NARROW = 900;          // below this it is an overlay
const LS_OPEN = 'po_nav', LS_FOLD = 'po_nav_fold';
const st = { el:null, btn:null, add:null, input:null, tree:null, count:null, items:[], total:0, q:'', busy:false, err:'', loaded:false, at:0,
             seq:0, fold:{}, shown:{}, sig:'', key:null, deb:0 };
const OTHER = 'Diğer';          // group key of chats without a project (the saved open/closed state is kept under it: do not change it); the screen shows PO.t('Other')
const isNarrow = () => innerWidth < NARROW;
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* */ } };
const ago = t => (PO.agoTr ? PO.agoTr(t) : '');
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

function loadFold() {
  try { const o = JSON.parse(lsGet(LS_FOLD) || '{}'); if (o && typeof o === 'object' && !Array.isArray(o)) for (const k of Object.keys(o).slice(0, 300)) st.fold[k] = o[k] ? 1 : 0; } catch (e) { /* */ }
}
function saveFold() {
  const keys = Object.keys(st.fold);
  if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete st.fold[k];
  lsSet(LS_FOLD, JSON.stringify(st.fold));
}

/* ------------------------------------------------------------------ data */
function norm(it) { return { id:it.id, title:String(it.title || ''), project:String(it.project || ''), last:+it.last || 0, pinned:!!it.pinned }; }
const valid = it => it && typeof it.id === 'string' && /^[0-9a-f-]{36}$/.test(it.id);
// mode: 'reset' (from the start; search changed / first open) | 'more' (next page) | 'refresh' (refresh the first page, the loaded tail stays)
async function load(mode) {
  const my = ++st.seq;
  st.busy = true;
  if (mode === 'reset') { st.err = ''; render(); }
  const off = mode === 'more' ? st.items.length : 0;
  const lim = mode === 'refresh' ? Math.min(PAGE, Math.max(50, st.items.length)) : PAGE;
  const r = await PO.api.recent({ offset:off, limit:lim, q:st.q });
  if (my !== st.seq) return;                       // search changed / closed: do not write the old reply
  st.busy = false;
  if (!r || !r.ok) {
    if (mode !== 'refresh' || !st.items.length) { st.err = String((r && r.reason) || PO.t('Could not load the list')); if (mode === 'reset') st.items = []; }
    render(true); return;
  }
  const got = r.items.filter(valid).map(norm);
  if (mode === 'reset') st.items = got;
  else if (mode === 'more') { const have = new Set(st.items.map(x => x.id)); st.items = st.items.concat(got.filter(x => !have.has(x.id))); }
  else { const ids = new Set(got.map(x => x.id)); st.items = got.concat(st.items.slice(got.length).filter(x => !ids.has(x.id))); }
  st.total = Math.max(+r.total || 0, st.items.length);
  st.err = ''; st.loaded = true; st.at = Date.now();
  render(true);
}

function groups() {
  const m = new Map();
  for (const it of st.items) {                     // items in order of last activity: the project order also follows its newest chat
    const k = it.project || OTHER;
    let g = m.get(k); if (!g) { g = { name:k, label:k === OTHER ? PO.t('Other') : k, items:[] }; m.set(k, g); }
    g.items.push(it);
  }
  return [...m.values()];
}
function isOpenGroup(g, i) {
  if (st.q) return true;                           // while searching, all matching projects are open
  const f = st.fold[g.name];
  if (f != null) return !!f;
  return i < 3 || g.items.some(x => x.id === PO.activeSid);
}

/* ------------------------------------------------------------------ drawing */
function sigOf(open) {
  return [st.busy ? 1 : 0, st.err, st.q, st.total, PO.activeSid || '', [...open].join(','), JSON.stringify(st.fold), JSON.stringify(st.shown),
    st.items.map(it => it.id + '\u0001' + it.title + '\u0001' + it.project + '\u0001' + ago(it.last) + '\u0001' + (it.pinned ? 1 : 0)).join('\u0002')].join('|');
}
function note(text) { const p = mk('p', 'nv-n', text); p.setAttribute('role', 'none'); return p; }
function render(force) {
  if (!st.el || st.el.hidden) return;
  const open = new Set((PO.sessions || []).map(g => g.id));
  const sig = sigOf(open);
  if (!force && sig === st.sig) return;
  st.sig = sig;
  const ae = document.activeElement, inTree = ae && st.tree.contains(ae);
  const key = inTree ? ae.dataset.key : st.key, top = st.tree.scrollTop;
  st.tree.textContent = '';
  st.count.textContent = st.loaded ? (st.q ? PO.tn(st.total, '{n} result', '{n} results') : String(st.total)) : '';
  if (!st.items.length) {
    st.tree.appendChild(note(st.busy ? PO.t('Loading chats…') : st.err ? st.err : st.q ? PO.t('No chats match your search.') : PO.t('No saved Code chats found.')));
    if (inTree) st.input.focus({ preventScroll:true });
    return;
  }
  const pins = new Set(PO.pinnedSids || []);
  const gs = groups();
  gs.forEach((g, gi) => {
    const exp = isOpenGroup(g, gi);
    const node = mk('div', 'nv-g'); node.setAttribute('role', 'treeitem'); node.setAttribute('aria-level', '1');
    node.setAttribute('aria-expanded', String(exp)); node.setAttribute('aria-setsize', String(gs.length)); node.setAttribute('aria-posinset', String(gi + 1));
    node.dataset.key = 'p:' + g.name; node.dataset.proj = g.name; node.tabIndex = -1;
    node.setAttribute('aria-label', PO.tn(g.items.length, '{name}, {n} chat', '{name}, {n} chats', { name:g.label }));
    const head = mk('div', 'nv-ph');
    head.append(mk('i', 'nv-ar', exp ? '▾' : '▸'), mk('span', 'nv-pn', g.label), mk('small', 'nv-pc', String(g.items.length)));
    head.title = g.label;
    node.appendChild(head);
    if (exp) {
      const list = mk('div', 'nv-gl'); list.setAttribute('role', 'group');
      const lim = st.q ? g.items.length : Math.max(SHOW, st.shown[g.name] || SHOW);
      const rows = g.items.slice(0, lim);
      rows.forEach((it, i) => {
        const isOpen = open.has(it.id), on = it.id === PO.activeSid, pin = pins.has(it.id) || it.pinned;
        const r = mk('div', 'nv-i' + (isOpen ? ' open' : '') + (on ? ' on' : ''));
        r.setAttribute('role', 'treeitem'); r.setAttribute('aria-level', '2'); r.setAttribute('aria-selected', String(on));
        r.setAttribute('aria-setsize', String(g.items.length)); r.setAttribute('aria-posinset', String(i + 1));
        r.dataset.key = 's:' + it.id; r.dataset.sid = it.id; r.tabIndex = -1;
        const t = it.title || PO.t('Untitled chat'), when = ago(it.last);
        r.append(mk('i', 'nv-dot'), mk('span', 'nv-t', t), mk('small', 'nv-d', when));
        if (pin && !isOpen) r.appendChild(mk('em', 'nv-pin', PO.t('pinned')));
        const full = new Date(it.last * 1000).toLocaleString(PO.locale(), { dateStyle:'medium', timeStyle:'short' });
        r.title = t + '\n' + g.label + '\n' + PO.t('Last activity: {when}', { when:full }) + '\n' + (on ? PO.t('Currently open tab') : isOpen ? PO.t('Tab is open: click to switch') : PO.t('Click to add to the tower as a tab'));
        r.setAttribute('aria-label', t + ', ' + when + (on ? ', ' + PO.t('open tab (currently shown)') : isOpen ? ', ' + PO.t('tab is open') : '') + (pin ? ', ' + PO.t('pinned chat') : ''));
        list.appendChild(r);
      });
      if (!st.q && g.items.length > SHOW) {
        const more = g.items.length > lim;
        const m = mk('div', 'nv-more', more ? PO.t('Show more ({n})', { n:g.items.length - lim }) : PO.t('Show fewer chats'));
        m.setAttribute('role', 'treeitem'); m.setAttribute('aria-level', '2'); m.tabIndex = -1;
        m.dataset.key = 'm:' + g.name; m.dataset.proj = g.name; m.dataset.act = more ? 'more' : 'less';
        list.appendChild(m);
      }
      node.appendChild(list);
    }
    st.tree.appendChild(node);
  });
  const left = st.total - st.items.length;
  if (left > 0 || (st.busy && st.loaded)) {
    const b = mk('div', 'nv-load', st.busy ? PO.t('Loading…') : PO.t('Load older chats ({n} left)', { n:left }));
    b.setAttribute('role', 'treeitem'); b.setAttribute('aria-level', '1'); b.tabIndex = -1; b.dataset.key = 'L'; b.dataset.act = 'load';
    st.tree.appendChild(b);
  }
  st.tree.scrollTop = top;
  rove(key, inTree);
}
const items = () => [...st.tree.querySelectorAll('[role="treeitem"]')];
// roving tabindex: only one item in the tree takes Tab focus (the last focused one, or the active chat, or the first item)
function rove(key, focus) {
  const arr = items(); if (!arr.length) return;
  let cur = key ? arr.find(x => x.dataset.key === key) : null;
  if (!cur) cur = arr.find(x => x.classList.contains('on')) || arr[0];
  arr.forEach(x => { x.tabIndex = x === cur ? 0 : -1; });
  st.key = cur.dataset.key;
  if (focus) cur.focus({ preventScroll:true });
}
function focusItem(el) { if (!el) return; rove(el.dataset.key, true); el.scrollIntoView({ block:'nearest' }); }

/* ------------------------------------------------------------------ actions */
function toggleGroup(name, want) {
  const gs = groups(), i = gs.findIndex(g => g.name === name); if (i < 0 || st.q) return;
  const cur = isOpenGroup(gs[i], i), next = want == null ? !cur : want;
  if (next === cur) return;
  st.fold[name] = next ? 1 : 0; saveFold();
  render(true);
}
async function choose(sid) {
  const it = st.items.find(x => x.id === sid); if (!it) return;
  if (isNarrow()) setOpen(false, { save:false });     // overlay: closes on selection (so the stage is visible)
  await PO.addSession(sid, it.title);
  render();
}
function activate(el) {
  if (!el) return;
  if (el.classList.contains('nv-g')) return toggleGroup(el.dataset.proj);
  if (el.dataset.sid) return choose(el.dataset.sid);
  if (el.dataset.act === 'more') { st.shown[el.dataset.proj] = Math.max(SHOW, st.shown[el.dataset.proj] || SHOW) + MORE; render(true); return; }
  if (el.dataset.act === 'less') { delete st.shown[el.dataset.proj]; st.key = 'p:' + el.dataset.proj; render(true); focusItem(items().find(x => x.dataset.key === st.key)); return; }
  if (el.dataset.act === 'load' && !st.busy) load('more');
}

/* ------------------------------------------------------------------ open / close */
function syncBtns(on) {
  st.btn.setAttribute('aria-expanded', String(on)); st.btn.classList.toggle('on', on);
  if (st.add) st.add.setAttribute('aria-expanded', String(on));
}
// o: { save (save the preference, default true), focus:'search'|'tree', refocus (focus on close) }
function setOpen(on, o) {
  o = o || {};
  if (!st.el || on === !st.el.hidden) { if (on && o.focus) focusIn(o.focus); return; }
  st.el.hidden = !on; syncBtns(on);
  document.body.classList.toggle('nav-open', on);
  if (o.save !== false) { st.touched = true; lsSet(LS_OPEN, on ? '1' : '0'); }
  if (on) {
    st.sig = '';
    if (!st.loaded || st.err) load('reset'); else { render(true); if (Date.now() - st.at > 10000) load('refresh'); }
    if (o.focus) focusIn(o.focus);
  } else {
    st.seq++; st.busy = false;
    if (o.refocus) o.refocus.focus({ preventScroll:true });
  }
}
function focusIn(where) {
  if (where === 'search') { st.input.focus({ preventScroll:true }); st.input.select(); return; }
  const arr = items(); const cur = arr.find(x => x.tabIndex === 0) || arr[0];
  if (cur) focusItem(cur); else st.input.focus({ preventScroll:true });
}

/* ------------------------------------------------------------------ setup */
function build() {
  const el = st.el;
  el.setAttribute('aria-labelledby', 'nav-h');
  const head = mk('div', 'nv-h');
  const h = mk('h2', '', PO.t('Code chats')); h.id = 'nav-h';
  st.count = mk('small', 'nv-c'); st.count.setAttribute('aria-live', 'polite');
  const x = mk('button', 'nv-x', '×'); x.type = 'button'; x.setAttribute('aria-label', PO.t('Close sidebar')); x.title = PO.t('Close (Esc)');
  head.append(h, st.count, x);
  st.input = mk('input'); st.input.type = 'search'; st.input.placeholder = PO.t('Search by title or project…'); st.input.autocomplete = 'off'; st.input.spellcheck = false;
  st.input.maxLength = 100; st.input.setAttribute('aria-label', PO.t('Search chats')); st.input.setAttribute('aria-controls', 'nav-tree');
  const sw = mk('div', 'nv-s'); sw.appendChild(st.input);
  st.tree = mk('div', 'nv-tree'); st.tree.id = 'nav-tree'; st.tree.setAttribute('role', 'tree'); st.tree.setAttribute('aria-label', PO.t('Code chats'));
  el.append(head, sw, st.tree);

  x.addEventListener('click', () => setOpen(false, { refocus:st.btn }));
  st.input.addEventListener('input', () => {
    clearTimeout(st.deb);
    st.deb = setTimeout(() => { const v = st.input.value.trim(); if (v === st.q) return; st.q = v; st.key = null; load('reset'); }, 250);
  });
  st.input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') { const arr = items(); if (arr.length) { e.preventDefault(); focusItem(e.key === 'Enter' ? (arr.find(x => x.dataset.sid) || arr[0]) : arr[0]); } }
    else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (st.input.value) { st.input.value = ''; clearTimeout(st.deb); if (st.q) { st.q = ''; load('reset'); } }
      else setOpen(false, { refocus:st.btn });
    }
  });
  st.tree.addEventListener('click', e => {
    const t = e.target.closest('[role="treeitem"]'); if (!t || !st.tree.contains(t)) return;
    if (t.classList.contains('nv-g') && !e.target.closest('.nv-ph')) return;     // empty area of the project box
    focusItem(t); activate(t);
  });
  st.tree.addEventListener('focusin', e => { const t = e.target.closest && e.target.closest('[role="treeitem"]'); if (t && t.dataset.key !== st.key) rove(t.dataset.key, false); });
  st.tree.addEventListener('keydown', e => {
    const arr = items(), cur = document.activeElement, i = arr.indexOf(cur);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false, { refocus:st.btn }); return; }
    if (i < 0) return;
    const parent = cur.parentElement && cur.parentElement.closest('.nv-g');
    let next = null;
    switch (e.key) {
      case 'ArrowDown': next = arr[i + 1] || cur; break;
      case 'ArrowUp': if (i === 0) { e.preventDefault(); st.input.focus(); return; } next = arr[i - 1]; break;
      case 'Home': next = arr[0]; break;
      case 'End': next = arr[arr.length - 1]; break;
      case 'ArrowRight':
        if (cur.classList.contains('nv-g')) { if (cur.getAttribute('aria-expanded') === 'false') { e.preventDefault(); toggleGroup(cur.dataset.proj, true); return; } next = arr[i + 1]; }
        break;
      case 'ArrowLeft':
        if (cur.classList.contains('nv-g')) { if (cur.getAttribute('aria-expanded') === 'true') { e.preventDefault(); toggleGroup(cur.dataset.proj, false); return; } }
        else if (parent) next = parent;
        break;
      case 'Enter': case ' ': e.preventDefault(); activate(cur); return;
      default: return;
    }
    e.preventDefault();
    if (next) focusItem(next);
  });

  st.btn.addEventListener('click', () => setOpen(st.el.hidden, { focus:st.el.hidden ? 'tree' : null, refocus:st.btn }));
  // overlay on a narrow screen: closes when clicking outside (the preference does not change)
  addEventListener('pointerdown', e => {
    if (st.el.hidden || !isNarrow()) return;
    if (st.el.contains(e.target) || st.btn.contains(e.target) || (st.add && st.add.contains(e.target))) return;
    setOpen(false, { save:false });
  }, true);
  setInterval(() => { if (!st.el.hidden) render(); }, 1500);           // "open" markers, active tab, "… ago" times (nothing to do if the signature is the same)
  setInterval(() => { if (!st.el.hidden && !st.busy && st.loaded && document.visibilityState === 'visible') load('refresh'); }, 30000);
}

function init() {
  st.el = $('#nav'); st.btn = $('#navBtn'); st.add = $('#tabadd');
  if (!st.el || !st.btn || !PO.api || !PO.addSession) return;
  loadFold();
  build();
  if (st.add) { st.add.setAttribute('aria-controls', 'nav'); st.add.removeAttribute('aria-haspopup'); st.add.dataset.tip = PO.t('Search earlier Claude Code chats in the sidebar and add them to the tower'); }
  PO.nav = {
    ready:true,
    open:o => setOpen(true, o),
    close:() => setOpen(false),
    toggleFromAdd:() => setOpen(true, { focus:'search' }),
  };
  // last state: on a wide screen the remembered open/closed state (first time: open); on a narrow screen the overlay always starts closed
  // (if the page opens narrow and then widens right away — hidden tab, window layout — it opens on the first widening anyway; if the user changed it by hand it is left alone)
  syncBtns(false);
  if (lsGet(LS_OPEN) === '0') return;
  const first = () => {
    if (isNarrow()) return;
    removeEventListener('resize', first);
    if (st.el.hidden && !st.touched) setOpen(true, { save:false });
  };
  addEventListener('resize', first);
  first();
}
try { init(); } catch (e) { console.error('[sidebar]', e); }
})(window.PO = window.PO || {});
