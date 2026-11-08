'use strict';
/* NorthLight Tower — the "Gallery" screen (like a phone's gallery).
   ALL images, GIFs and videos produced in the past stay here: also those of workers who are done, removed from the office or dropped from the records.
   Clicking one in the grid enlarges it; ← → keys (or the buttons) move to the others. On the right the name of the worker who produced it shows and
   a command can be written to that worker (e.g. "slow down the animation"): if they were removed from the office, they are called back first.
   Data: GET /gallery (the persistent gallery on the server; each image has worker info and status: live | gone | away). In demo mode it is built from PO.allList.
   Contract: PO.gallery.open(k?) / close() / isOpen()  ·  Container #galleryview, header button #galleryBtn.
   Test: ?gallery=1 comes up open, ?gal=<n> enlarges the n-th image. Class prefix gal-. */
(function (PO) {
const esc = s => PO.esc(s);
const $ = (s, r) => (r || document).querySelector(s);
const TYPES = [['all', 'All'], ['img', 'Images'], ['anim', 'Animations'], ['vid', 'Videos']];
const QUICK = ['Revise this: ', 'Make one more version', 'Make it simpler'];

let root = $('#galleryview'), btn = $('#galleryBtn');
if (!root) { root = document.createElement('div'); root.id = 'galleryview'; root.hidden = true; document.body.appendChild(root); }
const R = {};
let items = [], shown = [], isOpen = false, sig = '', timer = 0, filter = 'all', who = '', query = '', viewK = null, sending = false, loaded = false;
let scope = 'active', lastSid = null, tabWatch = 0;       // scope: 'active' (open tab) | 'all' | chat id (including closed tabs)
const drafts = new Map();
const returnFocus = { el: null };

/* ---------------------------------------------------------------- helpers */
const kindOf = it => it.kind === 'vid' ? 'vid' : (it.anim || PO.isAnim(it)) ? 'anim' : 'img';
const typeName = it => PO.t({ vid: 'Video', anim: 'Animation', img: 'Image' }[kindOf(it)]);
function dayLabel(t) {
  const d = new Date(t * 1000), n = new Date();
  const k = x => x.getFullYear() * 400 + x.getMonth() * 32 + x.getDate();
  if (k(d) === k(n)) return PO.t('Today');
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (k(d) === k(y)) return PO.t('Yesterday');
  const diff = (n - d) / 86400000;
  if (diff < 6) return d.toLocaleDateString(PO.locale(), { weekday: 'long' });
  return d.toLocaleDateString(PO.locale(), d.getFullYear() !== n.getFullYear() ? { day: 'numeric', month: 'long', year: 'numeric' } : { day: 'numeric', month: 'long' });
}
const dayKey = t => { const d = new Date(t * 1000); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
const hm = t => PO.fmtHM ? PO.fmtHM(t) : '';
function statusOf(it) {
  const a = it.agent || {};
  if (it.status === 'gone') return { txt: PO.t('Left the office'), cls: 'gone' };
  if (it.status === 'away') return { txt: PO.t('Not in records'), cls: 'away' };
  const stTxt = { waiting: 'Waiting for approval', done: 'Done', delegating: 'Delegating' }[a.state] || 'Working';
  return { txt: PO.stateOf ? PO.t(stTxt) : PO.t('In the office'), cls: a.state === 'waiting' ? 'wait' : a.state === 'done' ? 'done' : 'work' };
}
function mk(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

/* ---------------------------------------------------------------- chat scope (tab) */
const sidOf = i => (i.agent || {}).session || '';
function inScope(i) {
  if (scope === 'all') return true;
  if (scope === 'active') return !PO.activeSid || sidOf(i) === PO.activeSid;
  return sidOf(i) === scope;
}
function sessions() {                                  // all chats that have images in the gallery (including those whose tab is closed)
  const m = new Map();
  items.forEach(i => {
    const sid = sidOf(i); if (!sid) return;
    let g = m.get(sid);
    if (!g) { g = { id: sid, title: '', project: '', n: 0, t: 0 }; m.set(sid, g); }
    g.n++; g.t = Math.max(g.t, i.t);
    const a = i.agent || {};
    if (a.stitle && !g.title) g.title = a.stitle;
    if (a.project && !g.project) g.project = a.project;
  });
  (PO.sessions || []).forEach(x => { const g = m.get(x.id); if (g && x.title) { g.title = x.title; if (x.project) g.project = x.project; } });   // current title of the open tab
  return [...m.values()].sort((p, q) => q.t - p.t);
}
function scopeTitle() {
  if (scope === 'all') return PO.t('All chats');
  const sid = scope === 'active' ? PO.activeSid : scope;
  const g = sessions().find(x => x.id === sid);
  const t = (g && g.title) || ((PO.sessions || []).find(x => x.id === sid) || {}).title || '';
  return t || (scope === 'active' ? PO.t('This chat') : PO.t('Chat'));
}
function fillSess() {
  if (!R.sess) return;
  const list = sessions();
  const act = (PO.sessions || []).find(x => x.id === PO.activeSid);
  const lab = g => esc(PO.clip(g.title || PO.t('Untitled chat'), 34) + (g.project ? ' · ' + g.project : '') + ' (' + g.n + ')');
  const opts = [`<option value="active">${esc(PO.t('This chat'))}${act ? ': ' + esc(PO.clip(act.title || '', 28)) : ''}</option>`, `<option value="all">${esc(PO.t('All chats'))}</option>`];
  if (list.length) opts.push('<option disabled>──────────</option>');
  list.forEach(g => opts.push(`<option value="${esc(g.id)}">${g.id === PO.activeSid ? '● ' : ''}${lab(g)}</option>`));
  const html = opts.join('');
  if (R.sess._h !== html) { R.sess._h = html; R.sess.innerHTML = html; }
  if (scope !== 'active' && scope !== 'all' && !list.some(g => g.id === scope)) scope = 'active';
  R.sess.value = scope;
}

/* ---------------------------------------------------------------- data */
function demoItems() {
  const out = [];
  (PO.allList || []).forEach(info => (info.artifacts || []).forEach(a => {
    out.push({ k: info.id + '|' + a.id, id: a.id, kind: a.kind, anim: !!a.anim, src: a.src, label: a.label, t: a.t, status: 'live', can: true, can_main: false,
      agent: { id: info.id, session: info.session, nick: info.nick, char: info.char, role: info.role, kind_tr: info.kind_tr, label: info.label, project: info.project, sub: info.sub, state: info.state } });
  }));
  out.sort((p, q) => q.t - p.t);
  out.forEach((it, i) => { if (i % 7 === 3) { it.status = 'gone'; delete it.agent.state; } else if (i % 9 === 5) { it.status = 'away'; it.can = false; delete it.agent.state; } });   // demo mode only: to try out the states
  return out;
}
async function fetchItems() {
  if (PO.demo) return demoItems();
  try {
    const r = await fetch('/gallery', { cache: 'no-store' });
    const j = await r.json();
    if (j && j.ok && PO.localizeInfo) j.items.forEach(i => i.agent && PO.localizeInfo(i.agent));       // worker names (nick, kind_tr) in English mode
    return j && j.ok ? j.items : null;
  } catch (e) { return null; }
}
const sigOf = list => list.map(i => i.k + i.src + i.status + (i.can ? 1 : 0) + (i.agent && (i.agent.nick + (i.agent.state || '')))).join('|');
async function refresh(force) {
  const list = await fetchItems();
  if (!list) { if (!loaded) { loaded = true; render(); } return; }
  loaded = true;
  const s = sigOf(list);
  if (s === sig && !force) return;
  sig = s; items = list;
  fillSess(); fillWho();
  render();
}

/* ---------------------------------------------------------------- skeleton */
function build() {
  root.innerHTML = '';
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', PO.t('Gallery'));
  const head = mk('div', 'gal-head');
  head.innerHTML = `<div class="gal-title"><b>${PO.t('Gallery')}</b><small class="gal-count" aria-live="polite"></small></div>
    <div class="gal-filters" role="tablist" aria-label="${PO.t('Type')}">${TYPES.map(([v, t]) => `<button type="button" role="tab" data-f="${v}">${PO.t(t)}</button>`).join('')}</div>
    <select class="gal-sess" aria-label="${PO.t('Chat')}"></select>
    <label class="gal-sw"><input class="gal-search" type="search" placeholder="${PO.t('Search: worker or image name')}" aria-label="${PO.t('Search')}"></label>
    <select class="gal-who" aria-label="${PO.t('Worker')}"></select>
    <button type="button" class="gal-x" aria-label="${PO.t('Close gallery')}" title="${PO.t('Close (Esc)')}">×</button>`;
  const body = mk('div', 'gal-body');
  const empty = mk('div', 'gal-empty');
  const viewer = mk('div', 'gal-viewer'); viewer.hidden = true;
  viewer.innerHTML = `<div class="gal-stage">
      <button type="button" class="gal-nav gal-prev" aria-label="${PO.t('Previous')}" title="${PO.t('Previous (←)')}">‹</button>
      <div class="gal-media"></div>
      <button type="button" class="gal-nav gal-next" aria-label="${PO.t('Next')}" title="${PO.t('Next (→)')}">›</button>
      <span class="gal-pos"></span>
      <button type="button" class="gal-back" aria-label="${PO.t('Back to gallery')}" title="${PO.t('Back to gallery (Esc)')}">${PO.t('‹ Gallery')}</button>
    </div>
    <aside class="gal-info" aria-label="${PO.t('Image info')}">
      <div class="gal-who-card"></div>
      <dl class="gal-meta"></dl>
      <div class="gal-cmd">
        <label for="gal-ta">${PO.t('Give this worker a command')}</label>
        <div class="gal-chips">${QUICK.map(q => PO.t(q)).map(q => `<button type="button" data-q="${esc(q)}">${esc(q.trim().replace(/:$/, ''))}</button>`).join('')}</div>
        <textarea id="gal-ta" rows="3" maxlength="1800" placeholder="${PO.t('E.g. make the colors warmer, slow the animation down…')}"></textarea>
        <p class="gal-hint" aria-live="polite"></p>
        <div class="gal-actions"><button type="button" class="gal-send">${PO.t('Send')}</button><button type="button" class="gal-main" hidden data-tip="${PO.t("Sends the command to the chat's manager instead of the worker; try this if the worker can't be reached.")}">${PO.t('Send to manager')}</button><button type="button" class="gal-open">${PO.t('Open in new tab')}</button></div>
      </div>
    </aside>`;
  root.append(head, body, empty, viewer);
  R.head = head; R.body = body; R.empty = empty; R.viewer = viewer;
  R.count = $('.gal-count', head); R.search = $('.gal-search', head); R.who = $('.gal-who', head); R.sess = $('.gal-sess', head);
  R.media = $('.gal-media', viewer); R.pos = $('.gal-pos', viewer); R.card = $('.gal-who-card', viewer); R.meta = $('.gal-meta', viewer);
  R.ta = $('.gal-ta', viewer) || $('#gal-ta', viewer); R.hint = $('.gal-hint', viewer); R.send = $('.gal-send', viewer);
  R.prev = $('.gal-prev', viewer); R.next = $('.gal-next', viewer);

  $('.gal-x', head).onclick = () => close();
  $('.gal-back', viewer).onclick = () => closeViewer();
  head.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { filter = b.dataset.f; render(); });
  R.search.addEventListener('input', () => { query = PO.lower(R.search.value.trim()); render(); });
  R.who.addEventListener('change', () => { who = R.who.value; render(); });
  R.sess.addEventListener('change', () => { scope = R.sess.value; who = ''; closeViewer(true); fillWho(); render(); });
  R.main = $('.gal-main', viewer); R.main.onclick = () => doSend(true);
  body.addEventListener('click', e => { const t = e.target.closest('.gal-tile'); if (t) openViewer(t.dataset.k); });
  R.prev.onclick = () => step(-1); R.next.onclick = () => step(1);
  viewer.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { R.ta.value = b.dataset.q; R.ta.focus(); R.ta.setSelectionRange(R.ta.value.length, R.ta.value.length); store(); });
  R.ta.addEventListener('input', store);
  R.ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); } });
  R.send.onclick = doSend;
  $('.gal-open', viewer).onclick = () => { const it = cur(); if (it) window.open(it.src, '_blank', 'noopener'); };
}
function fillWho() {
  if (!R.who) return;
  const seen = new Map();
  items.filter(inScope).forEach(i => { const a = i.agent || {}; if (!seen.has(a.id)) seen.set(a.id, { id: a.id, nick: a.nick || a.label || PO.t('Worker'), n: 0 }); seen.get(a.id).n++; });
  const opts = ['<option value="">' + esc(PO.t('All workers')) + '</option>'].concat([...seen.values()].sort((p, q) => q.n - p.n).map(w => `<option value="${esc(w.id)}">${esc(w.nick)} (${w.n})</option>`));
  const html = opts.join('');
  if (R.who._h !== html) { R.who._h = html; R.who.innerHTML = html; }
  if (who && !seen.has(who)) who = '';
  R.who.value = who;
}

/* ---------------------------------------------------------------- grid */
function applyFilters() {
  return items.filter(i => {
    if (!inScope(i)) return false;
    if (filter !== 'all' && kindOf(i) !== filter) return false;
    if (who && (i.agent || {}).id !== who) return false;
    if (query) { const a = i.agent || {}; const hay = PO.lower((i.label || '') + ' ' + (a.nick || '') + ' ' + (a.role || '') + ' ' + (a.project || '')); if (!hay.includes(query)) return false; }
    return true;
  });
}
function tileHTML(it) {
  const a = it.agent || {}, kd = kindOf(it);
  const media = kd === 'vid'
    ? `<video muted playsinline preload="metadata" src="${esc(it.src)}#t=0.1" tabindex="-1"></video><span class="gal-play">▶</span>`
    : `<img src="${esc(it.src)}" alt="" loading="lazy" decoding="async">`;
  const st = statusOf(it);
  return `<button type="button" class="gal-tile" data-k="${esc(it.k)}" data-st="${st.cls}" aria-label="${esc((it.label || PO.t('Image')) + ' · ' + (a.nick || ''))}" title="${esc(it.label || '')}">
    <span class="gal-th">${media}</span>${kd !== 'img' ? `<i class="gal-badge">${kd === 'vid' ? 'VID' : 'GIF'}</i>` : ''}
    <span class="gal-by">${PO.avatar ? PO.avatar(a, 18) : ''}<em>${esc(a.nick || '')}</em></span></button>`;
}
function render() {
  if (!R.body) return;
  shown = applyFilters();
  R.head.querySelectorAll('[data-f]').forEach(b => { const on = b.dataset.f === filter; b.setAttribute('aria-selected', on ? 'true' : 'false'); b.classList.toggle('on', on); });
  const scoped = items.filter(inScope).length;
  R.count.textContent = loaded ? scopeTitle() + ' · ' + (shown.length === scoped ? PO.tn(scoped, '{n} item', '{n} items') : PO.t('{shown} / {n} items', { shown: shown.length, n: scoped })) : '';
  const top = R.body.scrollTop;
  if (!shown.length) {
    R.body.innerHTML = ''; R.empty.hidden = false;
    R.empty.innerHTML = !loaded ? '<p>' + esc(PO.t('Loading…')) + '</p>' : scoped
      ? '<p><b>' + esc(PO.t('No images match this filter.')) + '</b></p><p>' + esc(PO.t('Change the type or the search.')) + '</p>'
      : items.length
        ? '<p><b>' + esc(PO.t('No images in this chat yet.')) + '</b></p><p>' + esc(PO.t('You can switch to another tab or open {link}.', { link: '\u0001' })).replace('\u0001', '<button type="button" class="gal-all">' + esc(PO.t('the gallery of all chats')) + '</button>') + '</p>'
        : '<p><b>' + esc(PO.t('No images yet.')) + '</b></p><p>' + esc(PO.t('Images, animations and videos made by workers collect here; they stay even if the worker finishes, leaves the office or its tab is closed.')) + '</p>';
    const ab = R.empty.querySelector('.gal-all'); if (ab) ab.onclick = () => { scope = 'all'; fillSess(); fillWho(); render(); };
  } else {
    R.empty.hidden = true;
    const out = []; let last = '';
    shown.forEach(it => {
      const dk = dayKey(it.t);
      if (dk !== last) { if (last) out.push('</div></section>'); out.push(`<section class="gal-day"><h3>${esc(dayLabel(it.t))}</h3><div class="gal-grid">`); last = dk; }
      out.push(tileHTML(it));
    });
    out.push('</div></section>');
    R.body.innerHTML = out.join('');
    R.body.querySelectorAll('.gal-th img').forEach(im => {
      const fix = () => { if (im.naturalWidth && im.naturalWidth <= 512 && im.naturalHeight <= 512) im.classList.add('px'); };
      if (im.complete) fix(); else im.addEventListener('load', fix, { once: true });
      im.addEventListener('error', () => { const th = im.closest('.gal-th'); th.dataset.bad = PO.t('Could not open file'); th.classList.add('bad'); }, { once: true });
    });
    R.body.scrollTop = top;
  }
  if (viewK) { const i = shown.findIndex(x => x.k === viewK); if (i < 0) closeViewer(true); else paintViewer(); }
}

/* ---------------------------------------------------------------- enlarge */
const cur = () => shown.find(x => x.k === viewK) || null;
function openViewer(k) {
  const it = shown.find(x => x.k === k) || items.find(x => x.k === k);
  if (!it) return;
  if (!shown.includes(it)) { filter = 'all'; who = ''; query = ''; if (R.search) R.search.value = ''; render(); }
  viewK = k; R.viewer.hidden = false; R.head.classList.add('under'); R.body.classList.add('under');
  paintViewer(true);
}
function closeViewer(silent) {
  if (!viewK && R.viewer.hidden) return;
  viewK = null; R.viewer.hidden = true; R.head.classList.remove('under'); R.body.classList.remove('under');
  R.media.innerHTML = '';
  if (!silent) { const t = R.body.querySelector('.gal-tile[data-last="1"]'); if (t) t.focus({ preventScroll: true }); }
}
function step(d) {
  const i = shown.findIndex(x => x.k === viewK), n = i + d;
  if (i < 0 || n < 0 || n >= shown.length) return;
  viewK = shown[n].k; paintViewer(true);
}
function store() { if (viewK) drafts.set(viewK.split('|')[0], R.ta.value); }
function paintViewer(newItem) {
  const it = cur(); if (!it) return;
  const i = shown.indexOf(it), a = it.agent || {}, kd = kindOf(it), st = statusOf(it);
  if (newItem || R.media._k !== it.k) {
    R.media._k = it.k;
    R.media.innerHTML = kd === 'vid' ? `<video controls loop autoplay muted playsinline src="${esc(it.src)}"></video>` : `<img src="${esc(it.src)}" alt="${esc(it.label || '')}">`;
    const im = R.media.querySelector('img');
    if (im) im.addEventListener('load', () => {
      const nw = im.naturalWidth, nh = im.naturalHeight, box = R.media.getBoundingClientRect();
      if (nw && nw <= 520 && nh <= 520 && box.width > 0) {                       // small pixel art: scales up by an integer multiple, stays sharp
        const k = Math.max(1, Math.floor(Math.min((box.width - 24) / nw, (box.height - 24) / nh)));
        im.style.width = nw * k + 'px'; im.style.height = nh * k + 'px'; im.classList.add('px');
      } else im.classList.add('smooth');
    }, { once: true });
    R.body.querySelectorAll('.gal-tile[data-last]').forEach(t => t.removeAttribute('data-last'));
    const tile = R.body.querySelector('.gal-tile[data-k="' + (window.CSS && CSS.escape ? CSS.escape(it.k) : it.k) + '"]');
    if (tile) { tile.dataset.last = '1'; keepInView(tile); }
    const d = drafts.get(a.id); R.ta.value = d || '';
  }
  R.pos.textContent = (i + 1) + ' / ' + shown.length;
  R.prev.disabled = i <= 0; R.next.disabled = i >= shown.length - 1;
  R.card.innerHTML = `${PO.avatar ? PO.avatar(a, 46) : ''}<div><b>${esc(a.nick || a.label || PO.t('Worker'))}</b><small>${esc((a.sub ? (a.kind_tr ? a.kind_tr + ' · ' : '') : PO.t('Manager') + ' · ') + (a.role || a.label || ''))}</small><span class="gal-chip ${st.cls}">${esc(st.txt)}</span></div>`;
  R.meta.innerHTML = `<div><dt>${PO.t('File')}</dt><dd>${esc(it.label || '—')}</dd></div><div><dt>${PO.t('Type')}</dt><dd>${typeName(it)}</dd></div><div><dt>${PO.t('Time')}</dt><dd>${esc(dayLabel(it.t))} ${esc(hm(it.t))}</dd></div>${a.project ? `<div><dt>${PO.t('Project')}</dt><dd>${esc(a.project)}</dd></div>` : ''}`;
  paintCmd(it);
}
function keepInView(tile) {                        // scrolls only the grid container, not the page (no scrollIntoView)
  const b = R.body, tr = tile.getBoundingClientRect(), br = b.getBoundingClientRect();
  if (tr.top < br.top) b.scrollTop -= br.top - tr.top + 8; else if (tr.bottom > br.bottom) b.scrollTop += tr.bottom - br.bottom + 8;
}
function route(it) {                               // who the command goes to: the worker / the manager / nobody
  if (it.can) return 'agent';
  if (it.can_main) return 'main';
  return PO.demo && it.status !== 'away' ? 'agent' : 'none';
}
function paintCmd(it) {
  const a = it.agent || {}, r = route(it);
  let hint = '', dis = false;
  if (r === 'agent') {
    if (it.status === 'gone') hint = PO.t('Left the office; when you send, they are called back to the office first.');
    else if (it.status === 'live' && a.state === 'done') hint = PO.t('Finished their work; your message wakes them up again (uses quota like a normal message).');
    else if (it.status === 'away') hint = PO.t('A former worker whose tab was closed. If this Claude chat is still open the command gets through; if not, try the "Send to manager" button.');
    else hint = PO.t('Your command goes to this worker.');
  } else if (r === 'main') hint = PO.t('This worker cannot be reached right now; the command goes to the manager (with the image and worker name).');
  else { hint = PO.t('Commands cannot be sent right now: the Pixel Office plugin is not connected to this Claude chat.'); dis = true; }
  if (R.hint._t !== hint) { R.hint._t = hint; R.hint.textContent = hint; }
  const mainOk = !!it.can_main && a.id !== a.session;
  if (R.main.hidden === mainOk) R.main.hidden = !mainOk;
  R.main.disabled = sending;
  R.ta.disabled = dis && document.activeElement !== R.ta; R.send.disabled = dis || sending;
  R.send.textContent = sending ? PO.t('Sending…') : (it.status === 'gone' && r === 'agent' ? PO.t('Call back and send') : PO.t('Send'));
  const nm = a.nick || PO.t('worker');
  const ph = r === 'main' ? PO.t('To the manager: write a command for {name}…', { name: nm }) : PO.t('Write a command for {name}…', { name: nm });
  if (R.ta.placeholder !== ph) R.ta.placeholder = ph;
}
async function doSend(viaMain) {
  const it = cur(); if (!it || sending) return;
  const text = R.ta.value.trim(); if (!text) { R.ta.focus(); return; }
  const a = it.agent || {}, r = viaMain === true && it.can_main ? 'main' : route(it); if (r === 'none') return;
  sending = true; paintCmd(it);
  let target = a.id, tx = PO.t('For your output “{label}”: {text}', { label: it.label || PO.t('image'), text }), res = null;
  if (r === 'main') { target = a.session; tx = PO.t('Request for the output “{label}” of the worker named {nick}: {text}', { nick: a.nick || PO.t('Worker'), label: it.label || PO.t('image'), text }); }
  try {
    if (r === 'agent' && it.status === 'gone') {
      const rr = await PO.api.restore(a.id);
      if (!rr || !rr.ok) { PO.ui.toast(PO.t('Could not call back to the office: {reason}', { reason: (rr && rr.reason) || PO.t('unknown problem') }), { kind: 'bad' }); sending = false; paintCmd(it); return; }
      PO.ui.toast(PO.t('{nick} was called back to the office', { nick: a.nick || PO.t('Worker') }), { kind: 'ok', ms: 2400 });
    }
    res = await PO.api.send(target, tx);
    if ((!res || !res.ok) && r === 'agent' && a.session && a.session !== a.id && /bulunamad|not found/i.test((res && res.reason) || '') && it.can_main) {   // the worker dropped from the records: forward to the manager
      res = await PO.api.send(a.session, PO.t('Request for the output “{label}” of the worker named {nick}: {text}', { nick: a.nick || PO.t('Worker'), label: it.label || PO.t('image'), text }));
      if (res && res.ok) PO.ui.toast(PO.t('The worker is not in the records; your request was passed to the manager'), { kind: 'ok', ms: 3200 });
    } else if (res && res.ok) {
      PO.ui.toast(r === 'main' ? PO.t('Request passed to the manager') : PO.t('Command delivered: {nick}', { nick: a.nick || PO.t('worker') }), { kind: 'ok', ms: 2400 });
      if (r === 'agent' && !PO.demo) watchAck(a.id, tx);
    }
  } catch (e) { res = { ok: false, reason: PO.t('unexpected error') }; }
  sending = false;
  if (res && res.ok) { R.ta.value = ''; drafts.delete(a.id); setTimeout(() => refresh(true), 900); }
  else PO.ui.toast(PO.t('Could not send the command: {reason}', { reason: (res && res.reason) || PO.t('unknown problem') }), { kind: 'bad' });   // the text you typed stays in the box
  const c = cur(); if (c) paintCmd(c);
}

// if it cannot be delivered to the worker (no longer in Claude / closed) an error mark appears in the chat: show the user the "Send to manager" path
function watchAck(id, text) {
  setTimeout(() => {
    const info = PO.api.find && PO.api.find(id); if (!info) return;
    const m = (info.chat || []).slice().reverse().find(x => x.who === 'ben' && String(x.text).startsWith(text));
    if (m && m.st === 'hata') PO.ui.toast(PO.t('Could not reach the worker. Try "Send to manager" in the gallery.'), { kind: 'bad', ms: 7000 });
  }, 3800);
}

/* ---------------------------------------------------------------- open / close */
const INERT = ['cv', 'floors', 'zoombar', 'splitter', 'side'];      // the tab bar stays open: clicking a tab in the gallery brings up that chat's gallery
function setInert(on) { INERT.forEach(id => { const el = document.getElementById(id); if (el && el.inert !== on) el.inert = on; }); }
function open(k) {
  if (!R.head) build();
  if (!isOpen) {
    isOpen = true; root.hidden = false; returnFocus.el = document.activeElement;
    scope = 'active'; lastSid = PO.activeSid;
    clearInterval(tabWatch); tabWatch = setInterval(watchTab, 250);
    setInert(true);
    if (btn) { btn.setAttribute('aria-expanded', 'true'); btn.classList.add('on'); }
    if (PO.settingsUI && PO.settingsUI.isOpen && PO.settingsUI.isOpen()) PO.settingsUI.close();
    render();
    refresh(true).then(() => { if (k) openViewer(k); });
    clearInterval(timer); timer = setInterval(() => { if (!document.hidden) refresh(); }, 6000);
    setTimeout(() => { const t = $('.gal-filters .on', root) || $('.gal-x', root); if (t) t.focus({ preventScroll: true }); }, 30);
  } else if (k) openViewer(k);
}
function close() {
  if (!isOpen) return;
  isOpen = false; root.hidden = true; clearInterval(timer); timer = 0; clearInterval(tabWatch); tabWatch = 0;
  closeViewer(true); setInert(false);
  if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('on'); }
  const f = returnFocus.el; if (f && f.focus && document.contains(f)) f.focus({ preventScroll: true });
}
function watchTab() {                                 // when the tab changes (click, ‹ ›, Ctrl+←/→) that chat's gallery opens
  if (!isOpen || PO.activeSid === lastSid) return;
  lastSid = PO.activeSid; scope = 'active'; who = '';
  closeViewer(true); fillSess(); fillWho(); render();
  if (R.body) R.body.scrollTop = 0;
}
addEventListener('keydown', e => {
  if (!isOpen) return;
  if (PO.lightboxOpen && PO.lightboxOpen()) return;
  const typing = e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (e.key === 'Escape') {
    e.stopImmediatePropagation(); e.preventDefault();
    if (!R.viewer.hidden) closeViewer(); else close();
    return;
  }
  if (R.viewer.hidden || typing || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); step(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); step(1); }
}, true);

PO.gallery = { open, close, toggle() { isOpen ? close() : open(); }, isOpen: () => isOpen, refresh: () => refresh(true) };
if (btn) { btn.setAttribute('aria-controls', 'galleryview'); btn.setAttribute('aria-expanded', 'false'); btn.addEventListener('click', () => PO.gallery.toggle()); }
const q = new URLSearchParams(location.search);
if (q.get('gallery') === '1' || q.get('gal') != null) setTimeout(() => {
  open();
  if (q.get('gal') != null) setTimeout(() => { const it = shown[+q.get('gal')]; if (it) openViewer(it.k); }, 1200);
}, 1500);
})(window.PO = window.PO || {});
