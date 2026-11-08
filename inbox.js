'use strict';
/* NorthLight Tower — "Replies": replies of finished tasks (inbox), hologram notification and reader.
   Contract (SPEC 7.3):
     PO.inbox.update(allInfos)     — session.js calls it on every state update (agents of ALL buildings); detects the increase of the main agents' reply.n
     PO.inbox.open()               — open/close the Replies list (#inboxBtn does the same)
     PO.inbox.read(agentId, n?)    — open the reader (the full text is fetched with PO.api.reply)
     PO.inbox.unread()             — number of unread replies (all buildings)
     PO.inbox.unreadFor(agentId)   — number of unread replies of that agent (world drawing: the ✓ hologram mark at the manager's desk)
     PO.inbox.unreadInSession(sid) — number of unread in that building (tab)
   Also: PO.inbox.close() (close the list), PO.inbox.closeReader().
   Persistence (real mode): localStorage po_seen { agentId: {n,t} } and po_inbox [at most 40 records of meta, newest first]. In demo mode (PO.demo) the state is kept only in memory.
   Test parameters: ?holo=1 (force the hologram; ?holo=wait the red approval variant), ?reader=1 (open the first reply), ?inbox=1 (open the list).
   Notes: "Previous" = older reply, "Next" = newer. The approval variant plays no beep (panel.js checkAlerts plays the approval beep; to avoid a double beep). */
(function (PO) {
const esc = s => PO.esc(s), clip = (s, n) => PO.clip(s, n);
const tE = (k, p) => esc(PO.t(k, p));                // translated text, escaped for an HTML attribute/content
const RE_SUM = /^(?:ÖZET|SUMMARY)\s*:\s*/i;            // raw "ÖZET:" / "SUMMARY:" label at the start of a reply ("ÖZET:" is Turkish for "SUMMARY:"; kept verbatim, the code matches it)
// shorten a sentence / title: does not cut mid-word (core.js PO.clipWords; otherwise character cut). Plain clip for single-piece text like a file name.
const clipS = (s, n) => (PO.clipWords || PO.clip)(s, n);
const $ = id => document.getElementById(id);
const MAXE = 40, SHOW = 20, HOLO_MS = 25000, TEXT_CACHE = 30;
const q = new URLSearchParams(location.search);
const holoEl = $('holo'), popEl = $('inboxpop'), readerEl = $('reader'), btnEl = $('inboxBtn'), badgeEl = $('inboxBadge');

/* ------------------------------------------------------------------ state (real: persistent, test: in memory) */
function load(key, def) { try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? def : v; } catch (e) { return def; } }
function newState(persist) {
  const st = { persist, entries:[], seen:{}, known:new Set(), prev:{}, lastWait:{}, inited:false };
  if (persist) {
    const e = load('po_inbox', []), s = load('po_seen', {});
    if (Array.isArray(e)) st.entries = e.filter(x => x && x.id && x.n != null).slice(0, MAXE);
    if (s && typeof s === 'object') st.seen = s;
  }
  return st;
}
const real = newState(true), fake = newState(false);
let lastMode = false;                                   // last seen PO.demo
const S = () => (PO.demo ? fake : real);
function save() {
  const st = S(); if (!st.persist) return;
  try {
    localStorage.setItem('po_inbox', JSON.stringify(st.entries.slice(0, MAXE).map(m => { const c = Object.assign({}, m); delete c.text; return c; })));
    localStorage.setItem('po_seen', JSON.stringify(st.seen));
  } catch (e) { /* no storage */ }
}
const keyOf = m => m.id + '#' + m.n + '#' + Math.round(m.t || 0);
const texts = new Map();                                // in-memory full-text cache: id#n -> {text, task}
function cacheText(k, v) { texts.delete(k); texts.set(k, v); while (texts.size > TEXT_CACHE) texts.delete(texts.keys().next().value); }

/* counters: unreadFor / unreadInSession can be asked on every frame → O(1) */
let cntAll = 0, cntAgent = {}, cntSess = {};
function recount() {
  cntAll = 0; cntAgent = {}; cntSess = {};
  for (const m of S().entries) {
    if (m.r) continue;
    cntAll++; cntAgent[m.id] = (cntAgent[m.id] || 0) + 1;
    if (m.session) cntSess[m.session] = (cntSess[m.session] || 0) + 1;
  }
}
function changed() {
  recount(); save(); paintBadge();
  if (!popEl.hidden) renderPop();
  PO.needRender = true;                                 // so the ✓ mark at the manager's desk is redrawn
  try { document.dispatchEvent(new CustomEvent('po-inbox')); } catch (e) { /* */ }
}
let paintedBadge = null;
function paintBadge() {
  if (!badgeEl || paintedBadge === cntAll) return;            // the same number is not rewritten (so the animation/reader reaction is not reset)
  paintedBadge = cntAll;
  const txt = cntAll > 99 ? '99+' : String(cntAll);
  if (badgeEl.hidden !== (cntAll === 0)) badgeEl.hidden = cntAll === 0;
  if (badgeEl.textContent !== txt) badgeEl.textContent = txt;
  if (btnEl) {
    btnEl.classList.toggle('inb-has', cntAll > 0);
    const lbl = cntAll ? PO.t('Replies, {n} unread', { n:cntAll }) : PO.t('Replies');
    if (btnEl.getAttribute('aria-label') !== lbl) btnEl.setAttribute('aria-label', lbl);
  }
}

/* ------------------------------------------------------------------ helpers */
function plain(t, n) { return PO.md && PO.md.plain ? PO.md.plain(t, n) : String(t || '').slice(0, n); }
// first sentence (summary line): the "ÖZET:" prefix (Turkish for "SUMMARY:") is dropped, cut at about 150 characters.
// If lines are kept, a heading ("## Kule hazır", i.e. "## Tower ready") or a short first line without punctuation is skipped: "Ofis kulesinin yeni sürümünü bitirdim." (I finished the new version of the office tower.)
function firstSentence(t) {
  const rows = String(t == null ? '' : t).replace(/```[\s\S]*?```/g, '\n').split(/\r?\n/)
    .map(raw => ({ raw, p:plain(raw, 400).replace(RE_SUM, '') })).filter(x => /[\p{L}\p{N}]/u.test(x.p));
  let i = 0;
  while (i < rows.length - 1 && (/^\s*#{1,6}\s/.test(rows[i].raw) || (rows[i].p.length <= 60 && !/[.!?…:;]$/.test(rows[i].p) && !/^\s*([-*+•]|\d+[.)])\s/.test(rows[i].raw)))) i++;
  let s = rows.slice(i, i + 4).map(x => x.p).join(' ');
  if (!s) s = plain(t, 400).replace(RE_SUM, '');
  const m = /^(.{18,}?[.!?…])(\s|$)/.exec(s);
  if (m) s = m[1];
  return clipS(s, 150);
}
// a record's summary sentence: from the full text if known (line structure kept), otherwise from the server's one-line summary
function sumOf(m) {
  if (m.sum) return m.sum;
  const hit = texts.get(keyOf(m)), tx = (hit && hit.text) || m.text;
  if (tx) { m.sum = firstSentence(tx); return m.sum; }
  return firstSentence(m.head);
}
function ago(t) {
  const s = Math.max(0, PO.nowSec() - (t || 0));
  if (s < 45) return PO.t('just now');
  if (s < 3600) return PO.t('{n} min ago', { n:Math.round(s / 60) });
  if (s < 86400) return PO.t('{n} h ago', { n:Math.floor(s / 3600) });
  const dd = Math.floor(s / 86400);
  return PO.tn(dd, '{n} day ago', '{n} days ago');
}
function whenFull(t) {
  const d = new Date(t * 1000), now = new Date(PO.nowSec() * 1000);
  const hm = PO.fmtHM(t);
  if (d.toDateString() === now.toDateString()) return PO.t('Today {time}', { time:hm });
  return d.toLocaleDateString(PO.locale(), { day:'numeric', month:'long' }) + ' ' + hm;
}
const roleBit = m => (m.nick || '');
function metaFrom(info) {
  const r = info.reply;
  return { id:info.id, n:r.n, t:r.t, head:r.head || '', nick:info.nick || '', char:info.char || '', label:info.label || '', session:info.session || '', project:info.project || '', task:clipS(info.task || '', 240), r:0, sum:r.text ? firstSentence(r.text) : '' };
}
function addEntry(st, m) {
  const k = keyOf(m);
  if (st.entries.some(x => keyOf(x) === k)) return null;
  st.entries.unshift(m);
  st.entries.sort((a, b) => (b.t || 0) - (a.t || 0));
  while (st.entries.length > MAXE) st.entries.pop();
  return m;
}
const findEntry = k => S().entries.find(x => keyOf(x) === k) || null;

/* ------------------------------------------------------------------ sound (its own small beep) */
let actx = null;
function bip() {
  if (!PO.settings || !PO.settings.get('sound')) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const t0 = actx.currentTime;
    [[660, 0], [990, 0.11]].forEach(([f, dl]) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(actx.destination);
      g.gain.setValueAtTime(0.0001, t0 + dl); g.gain.exponentialRampToValueAtTime(0.07, t0 + dl + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dl + 0.16);
      o.start(t0 + dl); o.stop(t0 + dl + 0.18);
    });
  } catch (e) { /* no sound */ }
}

/* ------------------------------------------------------------------ hologram */
let cur = null, curEl = null, queue = [], holoTimer = 0, hideTimer = 0;
const holoOn = item => item.force || !PO.settings || PO.settings.get('holo') !== false;
const TOOL_VERB = [[/^(Edit|Write|NotebookEdit)$/, 'edit'], [/^(Bash|PowerShell)$/, 'run']];
// "Pank wants to run a command (python test.py). Give the approval in the Claude window."  Target: only the name in the file, at most 30 characters
function waitText(info) {
  const t = String(info.tool || '');
  let v = 'act';
  for (const [re, tr] of TOOL_VERB) if (t && re.test(t)) { v = tr; break; }
  let g = String(info.target || '').replace(/\s+/g, ' ').trim();
  if (g && (/^(Edit|Write|NotebookEdit|Read)$/.test(t) || /^([A-Za-z]:[\\/]|\/)/.test(g))) g = g.split(/[\\/]/).pop();
  g = g ? ' (' + clip(g, 30) + ')' : '';
  const name = info.nick || PO.nickOf(info) || PO.t('Worker');
  return v === 'edit' ? PO.t('{name} wants to edit a file{target}. Approve it in the Claude window.', { name, target:g })
    : v === 'run' ? PO.t('{name} wants to run a command{target}. Approve it in the Claude window.', { name, target:g })
    : PO.t('{name} wants to perform an action{target}. Approve it in the Claude window.', { name, target:g });
}
// approval card title: worker name + chat title (which chat?)
function chatTitleOf(it) {
  const main = (PO.allList || []).find(x => !x.sub && x.session && x.session === it.session);
  return (main && main.label) || it.label || '';
}
function itemTitle(it) {
  if (it.kind !== 'wait') return it.label;
  const c = chatTitleOf(it);
  return c && c !== it.nick ? it.nick + ' · ' + c : it.nick;
}
function enqueue(item) {
  if (!holoEl || !holoOn(item)) return;
  if ((cur && cur.key === item.key) || queue.some(x => x.key === item.key)) return;
  if (item.kind === 'wait') { queue.unshift(item); let w = 0; queue = queue.filter(x => x.kind !== 'wait' || ++w <= 3); } else queue.push(item);
  if (!cur) showNext(); else paintQueueTag();
}
function paintQueueTag() {
  const tag = curEl && curEl.querySelector('.inb-tag.q'); if (!tag) return;
  const txt = queue.length ? '+' + queue.length : '';
  if (tag.hidden !== !queue.length) tag.hidden = !queue.length;
  if (tag.textContent !== txt) tag.textContent = txt;
}
function showNext() {
  if (cur || (readerEl && !readerEl.hidden)) return;       // no new card appears while the reader is open (the next one comes when it closes)
  let it = null;
  while (queue.length) {
    const c = queue.shift();
    if (c.kind === 'wait' && !c.force) { const inf = (PO.allList || []).find(x => x.id === c.id); if (!inf || inf.state !== 'waiting') continue; }
    if (!holoOn(c)) continue;
    it = c; break;
  }
  if (!it) { holoEl.hidden = true; holoEl.innerHTML = ''; return; }
  cur = it; renderCard(it);
}
function renderCard(it) {
  const wait = it.kind === 'wait';
  const other = it.session && PO.activeSid && it.session !== PO.activeSid;
  const el = document.createElement('div');
  el.className = 'inb-holo' + (wait ? ' wait' : '');
  el.setAttribute('role', wait ? 'alert' : 'status');
  el.innerHTML =
    '<div class="inb-holo-edge"><div class="inb-holo-in">' +
      '<i class="inb-c tl"></i><i class="inb-c tr"></i><i class="inb-c bl"></i><i class="inb-c br"></i>' +
      '<div class="inb-holo-row">' + PO.avatar({ char:it.char }, 46) +
        '<div class="inb-holo-txt">' +
          '<div class="inb-holo-kick"><span class="inb-pip"></span>' + (wait ? tE('APPROVAL NEEDED') : tE('TASK DONE')) +
            (other ? '<span class="inb-tag">' + tE('OTHER CHAT') + '</span>' : '') + '<span class="inb-tag q" hidden></span></div>' +
          '<div class="inb-holo-title">' + esc(itemTitle(it) || PO.t('Task')) + '</div>' +
          '<div class="inb-holo-line">' + esc(it.line || '') + '</div>' +
        '</div></div>' +
      '<div class="inb-holo-btns">' + (wait ? '' : '<button type="button" class="inb-btn pri" data-a="read">' + tE('Read') + '</button>') + '<button type="button" class="inb-btn" data-a="ok">' + tE('OK') + '</button></div>' +
    '</div></div>';
  el.addEventListener('click', e => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    if (b.dataset.a === 'read') { hideCard('out'); openReaderByKey(it.key); }
    else { if (!wait) markRead(it.key, true); hideCard('out'); }
  });
  const arm = () => { clearTimeout(holoTimer); holoTimer = setTimeout(() => hideCard('fly'), HOLO_MS); };
  const disarm = () => clearTimeout(holoTimer);
  el.addEventListener('mouseenter', disarm); el.addEventListener('mouseleave', arm);
  el.addEventListener('focusin', disarm); el.addEventListener('focusout', arm);
  holoEl.innerHTML = ''; holoEl.appendChild(el); holoEl.hidden = false;
  curEl = el; paintQueueTag(); arm();
  if (!wait) bip();
}
// 'out': fades out, 'fly': shrinks and floats to the Replies button in the header (stays unread)
function hideCard(how) {
  if (!cur || !curEl) return;
  clearTimeout(holoTimer);
  const el = curEl;
  cur = null; curEl = null;
  if (how === 'fly' && btnEl) {
    const a = el.getBoundingClientRect(), b = btnEl.getBoundingClientRect();
    el.style.setProperty('--fx', (b.left + b.width / 2 - (a.left + a.width / 2)) + 'px');
    el.style.setProperty('--fy', (b.top + b.height / 2 - (a.top + a.height / 2)) + 'px');
  }
  el.classList.add(how === 'fly' ? 'fly' : 'out');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { el.remove(); showNext(); }, how === 'fly' ? 720 : 260);
}
function clearHolo() {
  queue = []; clearTimeout(holoTimer); clearTimeout(hideTimer);
  cur = null; curEl = null;
  if (holoEl) { holoEl.innerHTML = ''; holoEl.hidden = true; }
}
function itemFromMeta(m, force) {
  return { kind:'done', key:keyOf(m), id:m.id, n:m.n, char:m.char, label:m.label || m.nick, nick:m.nick, session:m.session, line:sumOf(m), force:!!force };
}

/* ------------------------------------------------------------------ read marks */
function markRead(k, quiet) {
  const m = findEntry(k); if (!m || m.r) return;
  m.r = 1;
  if (quiet !== 'nosave') changed();
}
function markAllRead() {
  let any = false;
  S().entries.forEach(m => { if (!m.r) { m.r = 1; any = true; } });
  if (any) changed();
  if (cur && cur.kind === 'done') hideCard('out');
  queue = queue.filter(x => x.kind === 'wait');
}

/* ------------------------------------------------------------------ reply list (#inboxpop) */
let popSig = '';
function renderPop() {
  const list = S().entries.slice(0, SHOW);
  const sig = list.map(m => keyOf(m) + (m.r ? 'r' : 'u')).join('|') + '#' + Math.floor(PO.nowSec() / 60);
  if (sig === popSig && popEl.firstChild) return;
  popSig = sig;
  const sc = popEl.querySelector('.inb-pop-list'), top = sc ? sc.scrollTop : 0;
  popEl.innerHTML =
    '<div class="inb-pop-head"><h3>' + tE('Replies') + '</h3><button type="button" class="inb-link" data-a="all"' + (cntAll ? '' : ' disabled') + '>' + tE('Mark all as read') + '</button></div>' +
    '<div class="inb-pop-list">' + (list.length ? list.map(m => {
      const sub = [m.nick, m.project && m.project !== m.label ? m.project : ''].filter(Boolean).join(' · ');
      return `<button type="button" class="inb-row${m.r ? '' : ' unread'}" data-k="${esc(keyOf(m))}">` + PO.avatar({ char:m.char }, 34) +
        `<span class="inb-row-t"><span class="inb-row-top"><b>${esc(m.label || m.nick || PO.t('Chat'))}</b><time>${esc(ago(m.t))}</time></span>` +
        (sub ? `<span class="inb-row-sub">${esc(sub)}</span>` : '') +
        `<span class="inb-row-head">${esc(sumOf(m) || PO.t('Reply'))}</span></span><i class="inb-dot" aria-hidden="true"></i></button>`;
    }).join('') : '<div class="inb-empty">' + tE('No replies yet. They show up here when a task finishes in a chat.') + '</div>') + '</div>';
  const nsc = popEl.querySelector('.inb-pop-list'); if (nsc) nsc.scrollTop = top;
}
function placePop() {
  const b = btnEl && btnEl.getBoundingClientRect();
  if (b && b.width) {
    popEl.style.top = Math.round(b.bottom + 8) + 'px';
    const w = Math.min(400, innerWidth - 16);                // on a narrow screen the button may be at the left: the window must not overflow the screen
    popEl.style.right = Math.min(Math.max(8, Math.round(innerWidth - b.right)), Math.max(8, innerWidth - w - 8)) + 'px';
    popEl.style.maxHeight = Math.max(160, innerHeight - b.bottom - 16) + 'px';
  }
}
function openPop() {
  if (!popEl) return;
  popSig = ''; renderPop(); placePop(); popEl.hidden = false;
  if (btnEl) btnEl.setAttribute('aria-expanded', 'true');
}
function closePop() {
  if (!popEl || popEl.hidden) return;
  popEl.hidden = true;
  if (btnEl) btnEl.setAttribute('aria-expanded', 'false');
}
if (popEl) {
  popEl.setAttribute('role', 'dialog'); popEl.setAttribute('aria-label', PO.t('Replies'));
  popEl.addEventListener('click', e => {
    if (e.target.closest('[data-a="all"]')) { markAllRead(); return; }
    const r = e.target.closest('.inb-row'); if (r) { closePop(); openReaderByKey(r.dataset.k); }
  });
}
if (btnEl) {
  btnEl.setAttribute('aria-haspopup', 'dialog'); btnEl.setAttribute('aria-expanded', 'false');
  btnEl.addEventListener('click', e => {
    if (popEl.hidden) {
      openPop();
      // if opened with the keyboard (Enter / Space: detail 0) focus goes to the list; focus does not change when opened with the mouse
      if (e.detail === 0) requestAnimationFrame(() => { const f = popEl.querySelector('.inb-row') || popEl.querySelector('button:not([disabled])'); if (f) f.focus({ preventScroll: true }); });
    } else closePop();
  });
}
document.addEventListener('pointerdown', e => {
  if (popEl && !popEl.hidden && !popEl.contains(e.target) && !(btnEl && btnEl.contains(e.target))) closePop();
}, true);
addEventListener('resize', () => { if (popEl && !popEl.hidden) placePop(); });

/* ------------------------------------------------------------------ reader (#reader) */
let rdKey = null, rdToken = 0, rdPrevFocus = null, rdBuilt = false;
function buildReader() {
  if (rdBuilt) return; rdBuilt = true;
  readerEl.innerHTML =
    '<div class="inb-rd-card" role="dialog" aria-modal="true" aria-labelledby="inbRdTitle" tabindex="-1">' +
      '<div class="inb-rd-head"><span id="inbRdAv"></span><div class="inb-rd-ht"><h2 id="inbRdTitle"></h2><small id="inbRdMeta"></small></div>' +
        '<button type="button" class="inb-x" data-a="close" aria-label="' + tE('Close') + '" data-tip="' + tE('Close (Esc)') + '" data-tip-pos="left">×</button></div>' +
      '<div class="inb-rd-task" id="inbRdTask"></div>' +
      '<div class="inb-rd-body" id="inbRdBody"></div>' +
      '<div class="inb-rd-foot">' +
        '<button type="button" class="inb-btn" data-a="copy">' + tE('Copy') + '</button><span class="sp"></span>' +
        '<button type="button" class="inb-btn" data-a="prev" data-tip="' + tE('Older reply') + '" data-tip-pos="start">' + tE('‹ Previous') + '</button>' +
        '<span class="inb-rd-pos" id="inbRdPos"></span>' +
        '<button type="button" class="inb-btn" data-a="next" data-tip="' + tE('Newer reply') + '" data-tip-pos="end">' + tE('Next ›') + '</button>' +
        '<button type="button" class="inb-btn pri" data-a="close">' + tE('Close') + '</button>' +
      '</div></div>';
  readerEl.addEventListener('mousedown', e => { if (e.target === readerEl) closeReader(); });
  readerEl.addEventListener('click', e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'close') closeReader();
    else if (a === 'copy') copyText();
    else if (a === 'prev') step(1);
    else if (a === 'next') step(-1);
    else if (a === 'retry') loadReader(rdKey);
  });
  readerEl.addEventListener('keydown', e => {                 // focus trap: Tab cycles inside the reader
    if (e.key !== 'Tab') return;
    const f = [...readerEl.querySelectorAll('button:not(:disabled)')];
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1], ae = document.activeElement;
    if (e.shiftKey && (ae === first || ae === readerEl.querySelector('.inb-rd-card'))) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && ae === last) { first.focus(); e.preventDefault(); }
  });
}
function openReaderByKey(k) {
  const m = findEntry(k); if (!m) return;
  buildReader();
  if (readerEl.hidden) rdPrevFocus = document.activeElement;
  readerEl.hidden = false;
  closePop();
  markRead(k);
  if (cur && cur.key === k) hideCard('out');
  loadReader(k);
  const card = readerEl.querySelector('.inb-rd-card'); if (card && !readerEl.contains(document.activeElement)) card.focus();
}
function closeReader() {
  if (readerEl.hidden) return;
  readerEl.hidden = true; rdKey = null; rdToken++;
  const pf = rdPrevFocus; rdPrevFocus = null;
  // if the previous focus target was removed from the DOM (hologram card, a list row that closed) focus returns to the Replies button
  const back = pf && pf.focus && document.contains(pf) && pf.getClientRects().length ? pf : btnEl;
  if (back) { try { back.focus(); } catch (e) { /* */ } }
  showNext();
}
function step(d) {                                          // d=+1: one older reply, -1: one newer
  const arr = S().entries, i = arr.findIndex(x => keyOf(x) === rdKey), j = i + d;
  if (i < 0 || j < 0 || j >= arr.length) return;
  const k = keyOf(arr[j]); markRead(k); loadReader(k);
}
function paintReaderHead(m) {
  $('inbRdAv').innerHTML = PO.avatar({ char:m.char }, 46);
  $('inbRdTitle').textContent = m.label || m.nick || PO.t('Reply');
  $('inbRdMeta').textContent = [m.nick, m.project && m.project !== m.label ? m.project : '', whenFull(m.t) + ' (' + ago(m.t) + ')'].filter(Boolean).join(' · ');
  const arr = S().entries, i = arr.findIndex(x => keyOf(x) === keyOf(m));
  const multi = arr.length > 1;
  $('inbRdPos').textContent = i >= 0 && multi ? (arr.length - i) + ' / ' + arr.length : '';
  const pv = readerEl.querySelector('[data-a="prev"]'), nx = readerEl.querySelector('[data-a="next"]');
  pv.hidden = nx.hidden = $('inbRdPos').hidden = !multi;
  pv.disabled = i < 0 || i >= arr.length - 1;
  nx.disabled = i <= 0;
}
function setTask(t) {
  const el = $('inbRdTask');
  el.innerHTML = t ? '<b>' + tE('Task:') + '</b>' + esc(clipS(String(t).replace(/\s+/g, ' ').trim(), 220)) : '';
}
let rdText = '';
async function loadReader(k) {
  const m = findEntry(k); if (!m) return;
  rdKey = k; const tok = ++rdToken;
  paintReaderHead(m);
  setTask(m.task);
  const body = $('inbRdBody');
  body.scrollTop = 0; rdText = '';
  const hit = texts.get(k) || (m.text ? { text:m.text, task:m.task } : null);
  if (hit && hit.text) { showText(m, hit); return; }
  body.innerHTML = '<div class="inb-skel" aria-busy="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>';
  let r = null;
  try { r = await PO.api.reply(m.id, m.n); } catch (e) { r = { ok:false, reason:PO.t('Unexpected error') }; }
  if (tok !== rdToken) return;                                 // meanwhile moved to another reply / closed
  if (r && r.ok && r.text && (!r.n || r.n === m.n)) {
    const v = { text:r.text, task:r.task || m.task };
    cacheText(k, v);
    if (r.task && r.task !== m.task) { m.task = clipS(r.task, 240); save(); }
    showText(m, v);
  } else if (m.head) {
    // full text could not be fetched (the server restarted or there is a newer reply): show the stored summary
    rdText = m.head;
    body.innerHTML = '<p class="inb-rd-note">' + tE('The full reply is no longer available; only its summary is shown.') + '</p>' + PO.md.render(m.head) +
      '<div class="inb-rd-err" style="margin-top:14px"><button type="button" class="inb-btn" data-a="retry">' + tE('Try again') + '</button></div>';
  } else {
    const why = r && r.reason ? PO.t(String(r.reason).trim()) : '';   // reason often ends with its own punctuation: avoid a double period
    body.innerHTML = '<div class="inb-rd-err"><p>' + (why ? PO.t('Could not load the reply text: {why}', { why:esc(why) + (/[.!?…]$/.test(why) ? '' : '.') }) : tE('Could not load the reply text.')) + '</p><button type="button" class="inb-btn" data-a="retry">' + tE('Try again') + '</button></div>';
  }
}
function showText(m, v) {
  rdText = v.text;
  if (v.task) setTask(v.task);
  $('inbRdBody').innerHTML = PO.md.render(v.text);
}
async function copyText() {
  if (!rdText) { PO.ui.toast(PO.t('Nothing to copy.'), { kind:'bad' }); return; }
  let ok = false;
  try { await navigator.clipboard.writeText(rdText); ok = true; } catch (e) {
    try { const ta = document.createElement('textarea'); ta.value = rdText; ta.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove(); } catch (e2) { ok = false; }
  }
  PO.ui.toast(ok ? PO.t('Reply copied.') : PO.t('Could not copy; you can select the text and copy it by hand.'), { kind:ok ? 'ok' : 'bad' });
}
// Esc: first the reader, then the list (in the capture phase; so the windows beneath do not handle the same Esc)
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (readerEl && !readerEl.hidden) { closeReader(); e.preventDefault(); e.stopImmediatePropagation(); }
  else if (popEl && !popEl.hidden) { closePop(); if (btnEl) btnEl.focus(); e.preventDefault(); e.stopImmediatePropagation(); }
}, true);

/* ------------------------------------------------------------------ detecting a new reply / waiting for approval */
function prefetch(m) {
  if (PO.demo || texts.has(keyOf(m))) return;
  PO.api.reply(m.id, m.n).then(r => {
    if (r && r.ok && r.text && (!r.n || r.n === m.n)) {
      cacheText(keyOf(m), { text:r.text, task:r.task || m.task });
      if (r.task && r.task !== m.task) { m.task = clipS(r.task, 240); }
      const sm = firstSentence(r.text);
      if (sm !== m.sum) {                                       // the summary derived from the full text replaces the server's stuck summary
        m.sum = sm; save(); popSig = '';
        if (!popEl.hidden) renderPop();
        if (cur && cur.key === keyOf(m) && curEl) { cur.line = sm; const ln = curEl.querySelector('.inb-holo-line'); if (ln && ln.textContent !== sm) ln.textContent = sm; }
      } else save();
    }
  }).catch(() => { /* retried when the reader opens */ });
}
let testPending = q.get('holo') || q.get('reader') || q.get('inbox');
function update(all) {
  if (!!PO.demo !== lastMode) {                               // real ↔ demo mode switch: reset what is on screen
    lastMode = !!PO.demo; clearHolo(); closePop(); closeReader(); popSig = ''; recount(); paintBadge();
  }
  const st = S();
  if (!all || !all.length) { if (testPending) runTests(); return; }
  const first = !st.inited;
  const nowS = PO.nowSec();
  let dirty = false;
  for (const a of all) {
    // --- transition to waiting for approval (all agents)
    const pv = st.prev[a.id];
    if (!first && a.state === 'waiting' && pv !== 'waiting' && nowS - (st.lastWait[a.id] || 0) > 20) {
      st.lastWait[a.id] = nowS;
      enqueue({ kind:'wait', key:'w#' + a.id + '#' + Math.round(nowS), id:a.id, char:a.char, nick:a.nick || PO.nickOf(a), label:a.label, session:a.session, line:waitText(a) });
    }
    st.prev[a.id] = a.state;
    // --- new reply (main agents only)
    if (a.sub) continue;
    const r = a.reply, known = st.known.has(a.id);
    st.known.add(a.id);
    if (!r || r.n == null) continue;
    const s = st.seen[a.id];
    const isNew = s ? (r.n > s.n || r.t > s.t) : (known || (!first && nowS - r.t < 90));
    if (!isNew) { if (!s) st.seen[a.id] = { n:r.n, t:r.t }; continue; }
    st.seen[a.id] = { n:r.n, t:r.t };
    const m = addEntry(st, metaFrom(a));
    if (!m) continue;
    if (r.text) { m.text = r.text; m.sum = firstSentence(r.text); cacheText(keyOf(m), { text:r.text, task:m.task }); }  // only in demo mode the state has text
    dirty = true;
    if (!first) { enqueue(itemFromMeta(m)); prefetch(m); }     // replies in the first call silently become unread
  }
  st.inited = true;
  if (dirty) changed(); else if (first) { save(); }
  // close the approval card currently shown if the agent is no longer waiting
  if (cur && cur.kind === 'wait' && !cur.force) {
    const inf = all.find(x => x.id === cur.id);
    if (!inf || inf.state !== 'waiting') hideCard('out');
  }
  if (!popEl.hidden) renderPop();
  if (testPending) runTests();
}

/* ------------------------------------------------------------------ test parameters (?holo=1 ?reader=1 ?inbox=1) */
const SAMPLE = () => PO.t('## Sample reply\n\nThis is a reply prepared to try out how the reader looks.\n\n- First item\n- Second item\n\n> Note: Real replies show up here.');
function sampleMeta() {
  const a = (PO.allList || []).find(x => !x.sub && x.reply) || (PO.allList || []).find(x => !x.sub) || (PO.allList || [])[0];
  if (a && a.reply) return metaFrom(a);
  return { id:a ? a.id : 'ornek', n:1, t:PO.nowSec() - 120, head:PO.t('Sample reply: task completed, details in the reader.'), nick:a ? (a.nick || '') : PO.t('Manager'), char:a ? (a.char || 'mudur') : 'mudur',
    label:a ? a.label : PO.t('Sample chat'), session:a ? a.session : '', project:a ? a.project : '', task:PO.t('Sample task'), r:0 };
}
let testRan = false;
function runTests() {
  if (testRan || !(PO.allList || []).length) return;
  testRan = true;
  const st = S();
  setTimeout(() => {
    const hv = q.get('holo');
    if (q.get('inbox') || q.get('reader')) {
      // fill the list meaningfully: each main agent's reply (the first two unread, the rest read) + a sample if needed
      const mains = (PO.allList || []).filter(x => !x.sub && x.reply), nm = mains.length;
      mains.slice().reverse().forEach((x, j) => {
        const i = nm - 1 - j, m = addEntry(st, metaFrom(x)); if (m && i >= 2) m.r = 1;
        if (m && x.reply.text) m.text = x.reply.text;
      });
      if (!st.entries.length) { const m = addEntry(st, sampleMeta()); if (m) m.text = SAMPLE(); }
      changed();
    }
    if (hv) {
      if (hv === 'wait' || hv === '2') {
        const w = (PO.allList || []).find(x => x.state === 'waiting') || (PO.allList || []).find(x => x.sub) || PO.allList[0];
        enqueue({ kind:'wait', key:'w#test', id:w.id, char:w.char, nick:w.nick || PO.nickOf(w), label:w.label, session:w.session, line:waitText(w.state === 'waiting' ? w : { nick:w.nick || PO.nickOf(w), tool:'Bash', target:'python test.py' }), force:true });
      } else {
        const m = addEntry(st, sampleMeta()) || st.entries[0];
        if (m) { if (m.r) { m.r = 0; } if (!m.text && !texts.has(keyOf(m)) && !PO.demo) m.text = SAMPLE(); changed(); enqueue(itemFromMeta(m, true)); }
      }
    }
    if (q.get('reader')) { const m = st.entries[0]; if (m) openReaderByKey(keyOf(m)); }
    else if (q.get('inbox')) openPop();
  }, 900);
  testPending = null;
}

/* ------------------------------------------------------------------ setting change */
if (PO.settings && PO.settings.onChange) PO.settings.onChange((path, v) => {
  if (path === 'holo' && v === false) { queue = queue.filter(x => x.force); if (cur && !cur.force) hideCard('out'); }
  else if (path === '*' && PO.settings.get('holo') === false) { queue = queue.filter(x => x.force); if (cur && !cur.force) hideCard('out'); }
});

/* ------------------------------------------------------------------ public API */
PO.inbox = {
  update,
  open() { if (popEl.hidden) openPop(); else closePop(); },
  close: closePop,
  closeReader,
  read(agentId, n) {
    const st = S();
    let m = st.entries.find(x => x.id === agentId && (n == null || x.n === n));
    if (!m) {                                                 // not tracked but the agent has a reply (e.g. chat or panel "Read more")
      const a = (PO.allList || []).find(x => x.id === agentId);
      if (a && a.reply && (n == null || a.reply.n === n)) { m = addEntry(st, metaFrom(a)); if (m) { m.r = 1; if (a.reply.text) m.text = a.reply.text; changed(); } }
    }
    if (!m) { PO.ui.toast(PO.t('This worker has no reply yet.'), { kind:'bad' }); return; }
    openReaderByKey(keyOf(m));
  },
  unread() { return cntAll; },
  unreadFor(agentId) { return cntAgent[agentId] || 0; },
  unreadInSession(sid) { return cntSess[sid] || 0; },
};
recount(); paintBadge();
})(window.PO = window.PO || {});
