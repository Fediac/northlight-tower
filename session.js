'use strict';
/* Pixel Office — sessions: every Claude chat is a separate building, tabs on top; the number of floors grows by itself as the work grows. */
(function (PO) {
const $ = PO.$, esc = PO.esc;
const clipW = (s, n) => (PO.clipWords || PO.clip)(s, n);          // tab title: do not cut in the middle of a word
PO.sessions = [];            // [{id, title, project, infos, main, work, wait, rest, started}]
PO.activeSid = null;
PO.allList = [];
const camStore = new Map();  // session -> camera state (where you left off when you return to the tab)
const closedTabs = new Map(); // tabs closed by hand: session -> last activity at the time of closing (s)
const selStore = new Map();  // session -> selected worker id (so the card comes back open when you return to the tab)
const TYPES = ['mudur', 'kod', 'tasarim', 'galeri', 'lobi'];
const count = (arr, t) => arr.filter(x => x === t).length;
const sameOrder = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const layoutFromCounts = c => ['mudur', ...Array(c.kod).fill('kod'), ...Array(c.tasarim).fill('tasarim'), ...Array(c.galeri).fill('galeri'), 'lobi'];
let tabsEl, lastTabSig = '', shrinkSince = 0, savedSid = null;
let pendingAdd = null;       // chat added with "+", expected to arrive from the server: { id, until }
const isPinned = sid => (PO.pinnedSids || []).includes(sid);
try { savedSid = localStorage.getItem('po_sid') || null; } catch (e) { /* */ }

/* ------------------------------------------------------------------ grouping */
function group(all) {
  const m = new Map();
  for (const a of all) {
    const sid = a.session || a.id;
    let g = m.get(sid);
    if (!g) { g = { id:sid, infos:[], main:null, title:'', project:'', work:0, wait:0, rest:0, started:0 }; m.set(sid, g); }
    g.infos.push(a);
    if (!a.sub) g.main = a;
  }
  const out = [...m.values()];
  const now = PO.serverTime || Date.now() / 1000;
  out.forEach(g => {
    g.last = Math.max(0, ...g.infos.map(x => x.idle_for != null ? now - x.idle_for : 0));        // the chat's last activity (s); closing a tab is undone by it
    const mn = g.main, first = g.infos[0];
    g.title = mn ? mn.label : (first.project || String(g.id).slice(0, 8));
    g.project = mn ? mn.project : first.project || '';
    g.started = mn ? (mn.started || 0) : Math.min(...g.infos.map(x => x.started || 0));
    g.infos.forEach(a => { if (a.state === 'done') g.rest++; else if (a.state === 'waiting') g.wait++; else g.work++; });
  });
  out.sort((p, q) => (p.started - q.started) || (p.id < q.id ? -1 : 1));       // fixed order: the tabs should not swap places
  return out;
}

/* ------------------------------------------------------------------ building (floor list) */
function rebuild(order) {
  const old = PO.FL || [];
  const cf = old.length ? PO.floorOfY(PO.cam.tcy) : -1;
  const key = cf >= 0 && old[cf] ? old[cf].key : null, off = key ? PO.cam.tcy - old[cf].y0 : 0;
  PO.buildTower(order);
  PO.resizeWorld();
  PO.resetAgents();
  PO.buildFloorChips();
  if (key) { const nf = PO.FL.find(f => f.key === key); if (nf) PO.camSet({ tcx:PO.cam.tcx, tcy:nf.y0 + off, ts:PO.cam.ts, moved:PO.cam.moved }, true); }
  PO.needRender = true;
}
// grow immediately, shrink only after 25 s of calm (so the floor count does not flicker). true: the building was rebuilt
function ensureTower(want, force) {
  const cur = PO.order || [];
  if (!force && sameOrder(cur, want)) { shrinkSince = 0; return false; }
  if (!force) {
    const grow = TYPES.some(t => count(want, t) > count(cur, t));
    if (!grow) {
      const now = performance.now();
      if (!shrinkSince) shrinkSince = now;
      if (now - shrinkSince < 25000) return false;
    } else {
      want = layoutFromCounts(Object.fromEntries(TYPES.map(t => [t, Math.max(count(cur, t), count(want, t))])));     // existing floors should not disappear while growing
      if (sameOrder(cur, want)) return false;
    }
  }
  shrinkSince = 0;
  rebuild(want);
  return true;
}
PO.ensureTower = ensureTower;
PO.rebuildTower = rebuild;

function applyActive(g, force) {
  const infos = g ? g.infos : [];
  PO.computeGallery(infos);
  const rebuilt = ensureTower(PO.layoutFor(infos, PO.galItems.length), force);
  PO.towerTitle = g ? { title:g.title, project:g.project && g.project !== g.title ? g.project : '' } : { title:PO.t('Empty office'), project:'' };
  PO.baseTitle = g ? 'NorthLight Tower — ' + g.title : PO.t('NorthLight Tower — Pixel Office');
  const wantTitle = PO.titleFor ? PO.titleFor() : PO.baseTitle;                                         // "(?)": Claude has a question awaiting an answer (panel.js PO.titleFor)
  if (PO.asks && PO.asks.refresh) PO.asks.refresh();                                                   // chat changed: the "OTHER CHAT" label on the cards should be updated
  if (document.title !== wantTitle && !document.title.startsWith('⚠')) document.title = wantTitle;       // do not rewrite the same value on every poll
  PO.applyInfos(infos, { instant:rebuilt });
  PO.panelUpdate(infos);
  PO.updateFloorChips();
  return rebuilt;
}

/* ------------------------------------------------------------------ state coming from the server / demo mode */
// an error in one module (chat, replies…) should not stop the shell and the state flow
const warned = new Set();
function safe(fn, name) { try { fn(); } catch (e) { if (!warned.has(name)) { warned.add(name); console.error('[' + name + ']', e); } } }
PO.gone = [];                // those removed from the office (can be brought back): [{id, session, nick, char, label, role, kind_tr, project, sub, at}]
PO.onState = function (all, gone) {
  if (PO.localizeInfo) { (all || []).forEach(x => PO.localizeInfo(x)); (gone || []).forEach(x => PO.localizeInfo(x)); }       // worker names in English mode (nick, kind_tr)
  PO.allList = all;
  PO.gone = gone || [];
  safe(() => PO.checkAlerts(all), 'checkAlerts');
  safe(() => PO.inbox && PO.inbox.update(all), 'inbox.update');
  PO.sessions = group(all).filter(g => {
    // tab closed by hand: comes back when the chat has new activity or is waiting for approval (no permanent removal)
    const at = closedTabs.get(g.id);
    if (at == null) return true;
    if (g.wait || g.last > at + 1) { closedTabs.delete(g.id); return true; }
    return false;
  });
  if (pendingAdd) {                       // chat added with "+" arrived from the server: switch to that tab
    if (PO.sessions.some(x => x.id === pendingAdd.id)) { const sid = pendingAdd.id; pendingAdd = null; PO.switchSession(sid); return; }       // switchSession also updates the chat list
    if (Date.now() > pendingAdd.until) { pendingAdd = null; PO.ui.toast(PO.t("Chat was added to the tower but isn't showing yet; check the tabs in a few seconds."), { kind:'info', ms:5000 }); }
  }
  let g = PO.sessions.find(x => x.id === PO.activeSid) || null;
  if (!g) {
    // no active session or it disappeared: open the saved one, otherwise the one waiting for approval, otherwise the first
    const pick = PO.sessions.find(x => x.id === savedSid) || PO.sessions.find(x => x.wait) || PO.sessions[0] || null;
    if (pick || PO.activeSid || !PO.FL) { PO.switchSession(pick ? pick.id : null); return; }
  }
  applyActive(g, false);
  updateTabs(false);
  safe(() => PO.chat && PO.chat.update(), 'chat.update');
};

PO.switchSession = function (sid) {
  if (PO.activeSid && PO.activeSid !== sid) { camStore.set(PO.activeSid, PO.camGet()); selStore.set(PO.activeSid, PO.selectedId || null); }
  PO.activeSid = sid;
  // fake chat ids in demo mode are not saved permanently: when leaving demo mode the previous real chat should come back
  if (sid && !PO.demo) { savedSid = sid; try { localStorage.setItem('po_sid', sid); } catch (e) { /* */ } }
  PO.select(null);
  const g = PO.sessions.find(x => x.id === sid) || null;
  applyActive(g, true);
  const c = sid ? camStore.get(sid) : null;
  if (c) PO.camSet(c, true); else { PO.cam.moved = false; PO.autoFrame(true); }
  const sel = sid ? selStore.get(sid) : null;
  if (sel && g && g.infos.some(x => x.id === sel)) PO.select(sel, false);            // if the selected worker is still in the office, it comes back together with its card
  PO.needRender = true;
  updateTabs(true);
  safe(() => PO.chat && PO.chat.update(), 'chat.update');         // building changed: the open chat list should show the new building's team
};

/* ------------------------------------------------------------------ tab bar */
// number of unread replies (Replies box; 0 if the module is missing/errors)
function unreadIn(sid) { try { return (PO.inbox && PO.inbox.unreadInSession && +PO.inbox.unreadInSession(sid)) || 0; } catch (e) { return 0; } }
let pressing = false;     // do not rebuild while the mouse is pressed on a tab: the click should not be cut short
function updateTabs(scroll) {
  if (!tabsEl) return;
  // signature: refresh only when visible things change (so the tab bar does not flicker and the scroll position is not disturbed); the unread count is also in the signature
  const sig = PO.sessions.map(g => [g.id, g.title, g.project, g.infos.length, g.work, g.wait, g.rest, unreadIn(g.id), isPinned(g.id) ? 1 : 0].join(',')).join(';') + '|' + PO.activeSid;
  if (!scroll && sig === lastTabSig) return;
  if (!scroll && pressing) return;                 // after the held click ends it is refreshed at the next poll (the signature was not saved)
  lastTabSig = sig;
  const multi = PO.sessions.length > 1;
  $('#tabprev').disabled = !multi; $('#tabnext').disabled = !multi;
  if (!PO.sessions.length) { if (tabsEl.firstChild) tabsEl.textContent = ''; return; }       // in the empty state there is no text in the tab bar (the only message is in the panel)
  const keep = tabsEl.scrollLeft;
  const ae = document.activeElement, fsid = ae && ae.dataset && ae.dataset.sid && tabsEl.contains(ae) ? ae.dataset.sid : null;      // a focused tab should stay focused when it is rebuilt
  tabsEl.innerHTML = PO.sessions.map(g => {
    const on = g.id === PO.activeSid, un = unreadIn(g.id);
    const cls = 'tab' + (on ? ' on' : '') + (g.wait ? ' alert' : '');
    const dot = g.wait ? 'w' : g.work ? 'k' : 'r';
    const sub = g.project && g.project !== g.title ? g.project : '';
    const st = [g.work ? PO.t('{n} working', { n:g.work }) : '', g.wait ? PO.t('{n} waiting for approval', { n:g.wait }) : '', g.rest ? PO.t('{n} done', { n:g.rest }) : ''].filter(Boolean).join(' · ') + (un ? `${g.work || g.wait || g.rest ? ' · ' : ''}${PO.tn(un, '{n} unread reply', '{n} unread replies')}` : '');
    const waitTip = PO.tn(g.wait, '{n} worker waiting for approval', '{n} workers waiting for approval'), unTip = PO.tn(un, '{n} unread reply', '{n} unread replies');
    const pin = isPinned(g.id) ? '\n' + PO.t('Pinned: closes only with ×') : '';
    return `<button class="${cls}" role="tab" aria-selected="${on}" data-sid="${esc(g.id)}" title="${esc(g.title)}${sub ? '\n' + esc(sub) : ''}${st ? '\n' + st : ''}${pin}"><i class="sd ${dot}"></i><span class="tt"><b>${esc(clipW(g.title, 34))}</b>${sub ? '<small>' + esc(clipW(sub, 38)) + '</small>' : ''}</span><span class="tc">${g.wait ? `<em class="w" data-tip="${waitTip}" data-tip-pos="end" aria-label="${waitTip}">! ${g.wait}</em>` : ''}${un ? `<em class="u" data-tip="${unTip}" data-tip-pos="end" aria-label="${unTip}">✓ ${un}</em>` : ''}</span><span class="tx" role="button" tabindex="0" aria-label="${PO.t('Close tab')}" title="${PO.t('Close tab')}">×</span></button>`;
  }).join('');
  tabsEl.scrollLeft = keep;
  if (fsid) { const nb = [...tabsEl.children].find(b => b.dataset.sid === fsid); if (nb) nb.focus({ preventScroll:true }); }
  // make the active tab visible: scroll ONLY the tab bar (scrollIntoView could scroll the whole page sideways)
  if (scroll) {
    const on = tabsEl.querySelector('.tab.on');
    if (on) { const a = on.getBoundingClientRect(), b = tabsEl.getBoundingClientRect(); if (a.left < b.left) tabsEl.scrollLeft -= (b.left - a.left + 8); else if (a.right > b.right) tabsEl.scrollLeft += (a.right - b.right + 8); }
  }
}
PO.updateTabs = () => updateTabs(false);        // can be called when inbox read/unread changes; does nothing if the signature is the same
function step(d) {
  const arr = PO.sessions; if (arr.length < 2) return;
  const i = Math.max(0, arr.findIndex(g => g.id === PO.activeSid));
  PO.switchSession(arr[(i + d + arr.length) % arr.length].id);
}
PO.stepSession = step;

/* ------------------------------------------------------------------ "+" add chat: list of saved chats
   The selected chat is pinned on the server (stays in the tower even if inactive; closes only with the × on the tab). All texts via textContent. */
const pick = { el:null, btn:null, input:null, list:null, items:[], busy:false, seq:0 };
function agoTr(t) {
  const s = Math.max(0, PO.nowSec() - (t || 0));
  if (s < 45) return PO.t('just now');
  if (s < 3600) return PO.t('{n} min ago', { n:Math.round(s / 60) });
  if (s < 86400) return PO.t('{n} h ago', { n:Math.floor(s / 3600) });
  if (s < 30 * 86400) { const d = Math.floor(s / 86400); return PO.tn(d, '{n} day ago', '{n} days ago'); }
  return new Date(t * 1000).toLocaleDateString(PO.locale(), { day:'numeric', month:'long', year:'numeric' });
}
const fold = s => PO.lower(String(s || ''));
function pickNote(text) {
  pick.list.textContent = '';
  const p = document.createElement('p'); p.className = 'tp-n'; p.textContent = text;
  pick.list.appendChild(p);
}
function pickRender() {
  if (!pick.el || pick.el.hidden || pick.busy) return;
  const q = fold(pick.input.value.trim());
  const open = new Set(PO.sessions.map(g => g.id)), pins = new Set(PO.pinnedSids || []);
  const rows = pick.items.filter(it => !q || fold(it.title).includes(q) || fold(it.project).includes(q));
  if (!pick.items.length) { pickNote(PO.t('No saved chats found.')); return; }
  if (!rows.length) { pickNote(PO.t('No chats match your search.')); return; }
  const ae = document.activeElement, fsid = ae && pick.list.contains(ae) ? ae.dataset.sid : null, top = pick.list.scrollTop;    // focus and scroll should stay in place on refresh
  pick.list.textContent = '';
  for (const it of rows) {
    const isOpen = open.has(it.id), isPin = pins.has(it.id) || !!it.pinned;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tp-i'; b.dataset.sid = it.id;
    if (isOpen) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); }
    const when = new Date((it.last || 0) * 1000).toLocaleString(PO.locale(), { dateStyle:'medium', timeStyle:'short' });
    b.title = it.title + (it.project && it.project !== it.title ? '\n' + it.project : '') + '\n' + PO.t('Last activity: {when}', { when }) + (isOpen ? '\n' + PO.t('Already open') : '');
    const tt = document.createElement('span'); tt.className = 'tp-tt';
    const t1 = document.createElement('b'); t1.textContent = it.title || PO.t('Untitled chat');
    const t2 = document.createElement('small'); t2.textContent = [it.project && it.project !== it.title ? it.project : '', agoTr(it.last)].filter(Boolean).join(' · ');
    tt.append(t1, t2);
    const bd = document.createElement('span'); bd.className = 'tp-b';
    if (isPin) { const e = document.createElement('em'); e.className = 'pin'; e.textContent = PO.t('pinned'); bd.appendChild(e); }
    if (isOpen) { const e = document.createElement('em'); e.className = 'open'; e.textContent = PO.t('open'); bd.appendChild(e); }
    b.append(tt, bd);
    b.setAttribute('aria-label', (it.title || PO.t('Untitled chat')) + (it.project && it.project !== it.title ? ', ' + it.project : '') + ', ' + agoTr(it.last) + (isPin ? ', ' + PO.t('pinned chat') : '') + (isOpen ? ', ' + PO.t('already open') : ''));
    pick.list.appendChild(b);
  }
  pick.list.scrollTop = top;
  if (fsid) {
    const nb = [...pick.list.children].find(x => x.dataset.sid === fsid);
    if (nb && !nb.disabled) nb.focus({ preventScroll:true }); else pick.input.focus({ preventScroll:true });
  }
}
async function pickLoad() {
  const my = ++pick.seq;
  pick.busy = true; pickNote(PO.t('Loading chats…'));
  const r = await PO.api.recent();
  if (my !== pick.seq) return;                 // list closed and opened again: do not write the old reply
  pick.busy = false;
  if (!r || !r.ok) { pick.items = []; pickNote(String((r && r.reason) || PO.t('Could not load the list'))); return; }
  pick.items = r.items.filter(it => it && typeof it.id === 'string').map(it => ({ id:it.id, title:String(it.title || ''), project:String(it.project || ''), last:+it.last || 0, pinned:!!it.pinned }));
  pickRender();
}
function pickOpen() {
  if (!pick.el) return;
  pick.el.hidden = false; pick.btn.setAttribute('aria-expanded', 'true');
  pick.input.value = '';
  pick.input.focus({ preventScroll:true });
  pickLoad();
}
function pickClose(refocus) {
  if (!pick.el || pick.el.hidden) return;
  pick.seq++; pick.busy = false;
  pick.el.hidden = true; pick.btn.setAttribute('aria-expanded', 'false');
  if (refocus) pick.btn.focus({ preventScroll:true });
}
// Add a saved chat to the tower as a tab (pinned on the server) and switch to that tab when it arrives; if it is already open, only switch to that tab.
// The sidebar (nav.js) and the old "+" list use this. true: added / switched
async function addSession(sid, title) {
  if (!sid) return false;
  if (PO.sessions.some(g => g.id === sid)) { if (sid !== PO.activeSid) PO.switchSession(sid); return true; }
  closedTabs.delete(sid);                      // if it was closed earlier with ×, it should show again
  const r = await PO.api.pin(sid);
  if (!PO.ui.report(r, PO.t('Could not add the chat'))) return false;
  if (!(PO.pinnedSids || []).includes(sid)) PO.pinnedSids = (PO.pinnedSids || []).concat([sid]);
  pendingAdd = { id:sid, until:Date.now() + 15000 };
  PO.ui.toast(PO.t('Adding chat to the tower: {title}', { title:clipW(title || PO.t('Untitled chat'), 40) }), { kind:'ok', ms:2400 });
  PO.pollNow();
  return true;
}
PO.addSession = addSession;
PO.agoTr = agoTr;
async function pickChoose(sid) {
  const it = pick.items.find(x => x.id === sid);
  if (!it || PO.sessions.some(g => g.id === sid)) return;
  pickClose(true);
  addSession(sid, it.title);
}
function initPicker() {
  pick.btn = $('#tabadd'); pick.el = $('#tabpick');
  if (!pick.btn || !pick.el) return;
  const head = document.createElement('div'); head.className = 'tp-h';
  const h = document.createElement('b'); h.id = 'tabpick-h'; h.textContent = PO.t('Saved chats');
  pick.input = document.createElement('input');
  pick.input.type = 'search'; pick.input.placeholder = PO.t('Search by title or project…'); pick.input.autocomplete = 'off'; pick.input.spellcheck = false;
  pick.input.setAttribute('aria-label', PO.t('Search chats')); pick.input.setAttribute('aria-controls', 'tabpick-l');
  head.append(h, pick.input);
  pick.list = document.createElement('div'); pick.list.className = 'tp-l'; pick.list.id = 'tabpick-l';
  pick.list.setAttribute('role', 'group'); pick.list.setAttribute('aria-label', PO.t('Chats')); pick.list.setAttribute('aria-live', 'polite');
  pick.el.setAttribute('aria-labelledby', 'tabpick-h'); pick.el.removeAttribute('aria-label');
  pick.el.append(head, pick.list);
  // "+" now opens the sidebar (focuses the search box); if the sidebar could not load, the old dropdown list works as a fallback
  pick.btn.addEventListener('click', () => {
    if (PO.nav && PO.nav.ready) { pickClose(false); PO.nav.toggleFromAdd(); return; }
    if (pick.el.hidden) pickOpen(); else pickClose(true);
  });
  pick.input.addEventListener('input', pickRender);
  pick.list.addEventListener('click', e => { const b = e.target.closest('.tp-i'); if (b && !b.disabled) pickChoose(b.dataset.sid); });
  const enabled = () => [...pick.list.querySelectorAll('.tp-i:not(:disabled)')];
  pick.el.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pickClose(true); return; }
    const arr = enabled(), i = arr.indexOf(document.activeElement);
    if (e.target === pick.input) {
      if (e.key === 'ArrowDown' && arr.length) { e.preventDefault(); arr[0].focus(); }
      else if (e.key === 'Enter' && arr.length) { e.preventDefault(); pickChoose(arr[0].dataset.sid); }
      return;
    }
    if (i < 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); (arr[i + 1] || arr[i]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (i === 0) pick.input.focus(); else arr[i - 1].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); arr[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); arr[arr.length - 1].focus(); }
  });
  // closes when clicking outside or when focus leaves the list
  addEventListener('pointerdown', e => { if (!pick.el.hidden && !pick.el.contains(e.target) && !pick.btn.contains(e.target)) pickClose(false); }, true);
  pick.el.addEventListener('focusout', e => { const to = e.relatedTarget; if (to && !pick.el.contains(to) && to !== pick.btn) pickClose(false); });
  setInterval(() => { if (!pick.el.hidden) pickRender(); }, 5000);      // the "open" labels and "… ago" times should stay current (focus is not disturbed while typing: it is outside the list)
}

PO.initSessions = function () {
  tabsEl = $('#tabs');
  initPicker();
  // close the tab: switch to a neighbor (if active), the tab is hidden; the click should not select the tab
  const closeTab = (b, viaKey) => {
    const sid = b.dataset.sid, i = PO.sessions.findIndex(x => x.id === sid), g = PO.sessions[i];
    if (!g) return;
    closedTabs.set(sid, g.last);
    if (pendingAdd && pendingAdd.id === sid) pendingAdd = null;
    if (isPinned(sid)) {                     // chat added with "+": remove the pin (otherwise it would stay in the tower even when inactive)
      PO.pinnedSids = PO.pinnedSids.filter(x => x !== sid);
      PO.api.unpin(sid).then(r => { if (!r || !r.ok) PO.ui.toast(PO.t('Could not unpin: {reason}', { reason:(r && r.reason) || PO.t('unknown problem') }), { kind:'bad' }); });
    }
    const rest = PO.sessions.filter(x => x.id !== sid);
    PO.sessions = rest; lastTabSig = '';
    if (sid === PO.activeSid) PO.switchSession(rest.length ? rest[Math.min(i, rest.length - 1)].id : null);
    else updateTabs(false);
    if (viaKey) { const nb = tabsEl.querySelector('.tab.on .tx') || tabsEl.querySelector('.tx'); if (nb) nb.focus({ preventScroll:true }); }      // when closed with the keyboard, focus should stay in the tab bar
  };
  tabsEl.addEventListener('click', e => {
    const x = e.target.closest('.tx');
    if (x) { e.stopPropagation(); e.preventDefault(); closeTab(x.closest('.tab'), false); return; }
    const b = e.target.closest('.tab'); if (b && b.dataset.sid !== PO.activeSid) PO.switchSession(b.dataset.sid);
  });
  tabsEl.addEventListener('keydown', e => {
    const x = e.target.closest && e.target.closest('.tx');
    if (x && (e.key === 'Enter' || e.key === ' ')) { e.stopPropagation(); e.preventDefault(); closeTab(x.closest('.tab'), true); }
  });
  tabsEl.addEventListener('pointerdown', () => { pressing = true; setTimeout(() => { pressing = false; }, 3000); });       // at most 3 s: if the release event is missed, the tabs should not stay stuck
  const release = () => { if (pressing) { pressing = false; setTimeout(() => updateTabs(false), 0); } };      // after the click (click) is handled, do the pending refresh
  addEventListener('pointerup', release); addEventListener('pointercancel', release); addEventListener('blur', release);
  $('#tabprev').onclick = () => step(-1);
  $('#tabnext').onclick = () => step(1);
  setInterval(() => updateTabs(false), 1000);            // the unread badge should stay current even if no state arrives (does nothing if the signature is the same)
  tabsEl.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { tabsEl.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive:false });
  addEventListener('keydown', e => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (PO.lightboxOpen && PO.lightboxOpen()) return;
    if (e.ctrlKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { step(e.key === 'ArrowLeft' ? -1 : 1); e.preventDefault(); }
    else if (e.altKey && !e.ctrlKey && /^[1-9]$/.test(e.key)) { const g = PO.sessions[+e.key - 1]; if (g) { PO.switchSession(g.id); e.preventDefault(); } }
  });
};
})(window.PO = window.PO || {});
