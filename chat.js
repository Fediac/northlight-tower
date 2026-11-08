'use strict';
/* NorthLight Tower — the wide conversation window "Messages" (Teams-like, two panes).
   Left: the workers of this chat (search + manager + workers). Right: the conversation with the selected person.
   Contract (called by other modules):
     PO.chat.open(agentId?, { expand: messageId }?)  — open; if agentId is given that worker's conversation comes up selected, otherwise the last selected one per chat / the manager.
       if expand is given, that message comes up expanded and is scrolled into view.
     PO.chat.close()  PO.chat.isOpen()  PO.chat.update()  (session.js calls update on every state update)
   Container #chatview, header button #chatBtn. Test: ?chat=main (manager) | ?chat=<n> (the n-th worker of the active chat, from 0; same order as ?sel=).
   Design principles:
   - The text box (textarea) is built once; no update disturbs its value/focus.
   - Messages and list rows are updated with a keyed patch (only the changed node is rebuilt); the scroll position is kept,
     sticks to the bottom if it is at the bottom, otherwise a "New message" button appears.
   - Sending is optimistic: the message shows at once as "sending"; if it fails the text (and attachments) return to the box + toast.
   - File attachments (attachments.js, PO.att): "+", drag and drop (anywhere in the conversation), Ctrl+V. Attachments are per worker like the draft;
     Send is disabled while uploading or while a failed chip exists. A message's attachments (the server's separate "atts" field) show as chips in the bubble. */
(function (PO) {
const esc = s => PO.esc(s);
const tE = (k, p) => esc(PO.t(k, p));                // translated text, escaped for an HTML attribute/content
const SEL_KEY = 'po_chat_sel', SEEN_KEY = 'po_chat_seen';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];   // translated with PO.t when displayed
const WORKING = { typing:1, reading:1, thinking:1, delegating:1 };
const askText = () => (PO.TXT && PO.TXT.askStatus) || PO.t('What are you working on right now? Describe it briefly, in plain language.');   // single text: the shell's PO.TXT.askStatus
const clipW = (s, n) => (PO.clipWords || PO.clip)(s, n);          // does not cut mid-word (the shell writes it); otherwise plain clipping
const HINT_NEW = () => PO.t('The worker is just starting; you can write in a moment.');
const MSG_OFF = () => PO.t("You can't send messages right now: the NorthLight Tower add-on isn't connected to this Claude chat. If the chat was just opened, wait a few seconds.");
const hintOff = () => (PO.TXT && PO.TXT.msgOff) || MSG_OFF();      // single text: the shell's PO.TXT.msgOff
const BLANK_HELP = () => PO.t('You can give this worker a task or ask how it is going.');
const kindOf = a => (a.kind_tr ? PO.t(a.kind_tr) : '');

PO.localMsgs = PO.localMsgs || {};

/* ---------------------------------------------------------------- emoji shortcuts while typing (":)" → 🙂)
   PO.emoji.attach(field): binds to an input/textarea. A shortcut is converted only at the start of a line or after a space, when its last character is typed
   (does not touch text inside a word like "http://"). The questions card uses the same helper. */
PO.emoji = PO.emoji || (function () {
  const MAP = {
    ':)':'🙂', ':-)':'🙂', '=)':'🙂', ':(':'🙁', ':-(':'🙁', ':D':'😄', ':-D':'😄', 'xD':'😆', 'XD':'😆', ';)':'😉', ';-)':'😉',
    ':P':'😛', ':p':'😛', ':-P':'😛', ':O':'😮', ':o':'😮', ':*':'😘', ":'(":'😢', ':/':'😕', ':|':'😐', '8)':'😎', 'B)':'😎',
    '<3':'❤️', '</3':'💔', ':heart:':'❤️', ':fire:':'🔥', ':ok:':'👌', ':+1:':'👍', ':-1:':'👎', ':tada:':'🎉', ':thinking:':'🤔',
  };
  const KEYS = Object.keys(MAP).sort((a, b) => b.length - a.length);
  function convert(f) {
    const pos = f.selectionStart;
    if (pos == null || pos !== f.selectionEnd) return;
    const head = f.value.slice(0, pos);
    for (const k of KEYS) {
      if (!head.endsWith(k)) continue;
      const before = head.charAt(head.length - k.length - 1);
      if (before && !/\s/.test(before)) continue;
      f.setRangeText(MAP[k], pos - k.length, pos, 'end');
      return;
    }
  }
  return {
    map:MAP,
    attach(f) {
      if (!f || f._emoji) return;
      f._emoji = true;
      f.addEventListener('input', e => { if (e.inputType === 'insertText' && !e.isComposing) convert(f); });
    },
  };
})();

/* ---------------------------------------------------------------- persistence (silently ignore if corrupt) */
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch (e) { return {}; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* */ } };
let selMap = lsGet(SEL_KEY);          // chat -> last selected conversation
let seen = lsGet(SEEN_KEY);           // worker -> time of the latest reply seen
let seenTimer = 0, bootMode = null;
function saveSeen() {
  if (seenTimer || PO.demo) return;   // demo mode keeps no "seen" record (so no fake unread appears)
  seenTimer = setTimeout(() => {
    seenTimer = 0;
    if (PO.demo) return;
    const keys = Object.keys(seen);
    if (keys.length > 400) {           // so it does not bloat: drop agents that no longer exist
      const live = new Set((PO.allList || []).map(a => a.id));
      keys.forEach(k => { if (!live.has(k)) delete seen[k]; });
    }
    lsSet(SEEN_KEY, seen);
  }, 400);
}

/* ---------------------------------------------------------------- state */
let view = null, btn = null;
const R = {};                          // DOM references
let isOpen = false, sid = null, selId = null, lastActive = null, booted = false, timer = 0;
let convId = null, headSig = '', footSig = '', stick = true, newCount = -1, pn = 0, stopTimer = 0;
let holdUntil = 0, revealTok = 0;         // while scrolling per message, the scroll event must not spoil the "am I at the bottom" decision
let stopWatch = null, kbd = false, returnTo = null;
const INERT_IDS = ['cv', 'floors', 'zoombar', 'splitter', 'side'];   // shell left behind the chat (inside #holo #stage: not inert)
let msgMap = new Map(), rowMap = new Map();
const drafts = {}, expanded = new Set(), pending = {};
let ATT = null;                           // attachment box (PO.att.box): the attachment list per worker, like the draft
const narrowMQ = window.matchMedia ? window.matchMedia('(max-width:759px)') : { matches:false };

/* ---------------------------------------------------------------- helpers */
const infoOf = id => (PO.allList || []).find(x => x.id === id) || null;
const sidOf = a => a.session || a.id;
const teamOf = s => { const g = (PO.sessions || []).find(x => x.id === s); return g ? g.infos : []; };
const canMsg = a => !!a && (!!a.can_message || (!!PO.demo && !String(a.id).startsWith('spawn-')));
const roleLine = a => {
  if (!a) return '';
  if (!a.sub) { const t = a.label || '', n = PO.nickOf(a); return t && t !== n ? t : (a.project || PO.t('Manager')); }
  const r = PO.t(PO.roleOf(a) || clipW(a.task || '', 60));
  return [kindOf(a), r].filter(Boolean).join(' · ');
};
const shortRole = a => (!a.sub ? (a.label && a.label !== PO.nickOf(a) ? a.label : '') : PO.t(PO.roleOf(a) || kindOf(a) || clipW(a.task || '', 40)));
const dotCls = a => (a.state === 'waiting' ? 's-wait' : a.state === 'done' ? 's-done' : 's-work');
const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
function daysAgo(t) { return Math.round((midnight(new Date()) - midnight(new Date(t * 1000))) / 864e5); }
function dayLabel(t) {
  const n = daysAgo(t); if (n === 0) return PO.t('Today'); if (n === 1) return PO.t('Yesterday');
  const d = new Date(t * 1000);
  return d.getDate() + ' ' + PO.t(MONTHS[d.getMonth()]) + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '');
}
function rowTime(t) {
  if (!t) return '';
  const n = daysAgo(t); if (n === 0) return PO.fmtHM(t); if (n === 1) return PO.t('Yesterday');
  const d = new Date(t * 1000); return d.getDate() + ' ' + PO.t(MONTHS[d.getMonth()]);
}
const dayKey = t => { const d = new Date(t * 1000); return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate(); };
const isLong = t => t.length > 600 || t.split('\n').length > 12;
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
// compare before writing: do not rewrite the same value (no needless DOM change / screen reader announcement)
const setText = (e, v) => { if (e.textContent !== v) e.textContent = v; };
const setHidden = (e, v) => { v = !!v; if (e.hidden !== v) e.hidden = v; };
const setAttr = (e, k, v) => { v = String(v); if (e.getAttribute(k) !== v) e.setAttribute(k, v); };
const setData = (e, k, v) => { v = String(v); if (e.dataset[k] !== v) e.dataset[k] = v; };
// Turkish: dative suffix like "Hayalet'e"; English: the name itself. Returns '' if unsure (the caller falls back to the generic text)
function dative(name) {
  const n = String(name || '').trim();
  if (!n || n.length > 14 || !/^[A-Za-zÇĞİıÖŞÜçğöşü]+$/.test(n)) return '';
  if (PO.lang !== 'tr') return n;
  const low = PO.lower(n), vow = low.match(/[aeıioöuü]/g);
  if (!vow) return '';
  const last = vow[vow.length - 1], front = 'eiöü'.includes(last), endsV = 'aeıioöuü'.includes(low[low.length - 1]);
  return n + '\'' + (endsV ? 'y' : '') + (front ? 'e' : 'a');
}
// puts the container's children in the given order; moves/removes only what is needed
function reconcile(box, els) {
  let ref = box.firstChild;
  for (const e of els) { if (e === ref) ref = ref.nextSibling; else box.insertBefore(e, ref); }
  while (ref) { const n = ref.nextSibling; box.removeChild(ref); ref = n; }
}
function overlayAbove() {
  const q = s => { const e = document.querySelector(s); return !!(e && !e.hidden); };
  // hidden is never used in #settings (inert when closed): the settings module knows whether it is open
  // #inboxpop (Replies list) opens above the chat: a single Esc should close only it
  return q('#reader') || q('#inboxpop') ||!!(PO.settingsUI && PO.settingsUI.isOpen && PO.settingsUI.isOpen()) || !!(PO.lightboxOpen && PO.lightboxOpen());
}

/* ---------------------------------------------------------------- messages: those from the server + local notes + those being sent */
function msgsOf(a) {
  const base = (a.chat || []).concat(PO.localMsgs[a.id] || []);
  const now = Date.now() / 1000;
  const ids = x => (x.atts || []).map(t => t.id).join(',');
  const pend = (pending[a.id] || []).filter(p => now - p.t < 25 &&
    !base.some(m => m.who === 'ben' && m.t >= p.t - 8 && (m.text === p.text || (p.text && String(m.text).startsWith(p.text))) &&
      (!Array.isArray(m.atts) || ids(m) === ids(p))));
  pending[a.id] = pend;
  return base.concat(pend).sort((p, q) => p.t - q.t);
}
// turns a raw error reason into a plain sentence in the UI language; known server patterns are translated with PO.t, unknown ones are shown as they are
function reasonTr(why) {
  why = String(why == null ? '' : why).trim();
  if (!why) return '';
  if (/classifier|verdict|auto mode/i.test(why)) return PO.t("Claude's automatic permission check blocked sending");
  if (/no running turn|not running|nothing to (?:stop|interrupt)/i.test(why)) return PO.t('there is no job to stop right now');
  if (/timed? ?out|timeout|no response/i.test(why)) return PO.t('Claude did not respond in time');
  return PO.t(why).replace(/^(?:Durdurulamadı|Could not stop|Couldn't stop|Stop failed)\s*:\s*/i, '');       // if the server/plugin already added the prefix, do not double it
}
const ERR_MARK = '\n(!) ';
function parseErr(m) {
  let text = String(m.text == null ? '' : m.text), why = '';
  if (m.who === 'ben' && m.st === 'hata') {
    const i = text.indexOf(ERR_MARK);
    if (i >= 0) { why = text.slice(i + ERR_MARK.length); text = text.slice(0, i); }
    why = reasonTr(why);
  }
  return { text, why };
}
// system note sent to the worker ("Stop request sent."): if it fails, the server appends "\n(!) reason"
function parseNote(m) {
  const text = String(m.text == null ? '' : m.text), i = text.indexOf(ERR_MARK);
  if (m.st !== 'hata' || i < 0) return { text:m.local ? text : PO.t(text), failed:false };
  const base = text.slice(0, i), why = reasonTr(text.slice(i + ERR_MARK.length));
  const out = '! ' + (/durdur|stop/i.test(base) ? PO.t('Could not stop') : PO.t(base).replace(/[.\s]+$/, '')) + (why ? ': ' + why : '');
  return { text:out.replace(/([^.!?])$/, '$1.'), failed:true };
}
// the plugin's "how it was delivered" note: say technical names plainly (server tests expect the old name, so it is translated here; the keys are plugin codes)
const VIA_TR ={ 'TaskStop': 'stopped', 'by message': 'delivered by message', 'turn stopped': 'stopped', 'mesajla': 'delivered by message', 'tur durduruldu': 'stopped' };   // old Turkish codes are for old records
const viaText = v => PO.t(VIA_TR[v] || v);
const latestAjan = a => (a.chat || []).reduce((mx, m) => (m.who === 'ajan' && m.t > mx ? m.t : mx), 0);
const unreadOf = a => { const s = seen[a.id] || 0; let n = 0; (a.chat || []).forEach(m => { if (m.who === 'ajan' && m.t > s) n++; }); return n; };
function setSeen(a) {
  const t = latestAjan(a);
  if (t > (seen[a.id] || 0)) { seen[a.id] = t; saveSeen(); }
}
function boot() {                       // count the messages present at first glance as "seen" (only later ones are unread)
  if (!(PO.allList && PO.allList.length)) return;
  const mode = !!PO.demo;
  if (booted && bootMode === mode) return;
  booted = true;
  if (bootMode !== null || mode) seen = mode ? {} : lsGet(SEEN_KEY);   // demo mode uses no persistent record: old times must not produce fake unread
  bootMode = mode;
  PO.allList.forEach(a => { if (!(a.id in seen)) seen[a.id] = latestAjan(a); });
  saveSeen();
}
function updateBadge() {
  if (!btn) return;
  let b = btn.querySelector('.chat-bdg');
  if (!b) { b = document.createElement('i'); b.className = 'chat-bdg'; b.hidden = true; btn.appendChild(b); }
  let n = 0; (PO.allList || []).forEach(a => { n += unreadOf(a); });
  setHidden(b, n < 1);
  setText(b, n > 99 ? '99+' : String(n));
  setAttr(b, 'aria-label', PO.tn(n, '{n} unread message', '{n} unread messages'));
}

/* ---------------------------------------------------------------- skeleton (built once; the text box is never touched again) */
function build() {
  view = document.getElementById('chatview');
  if (!view) { view = document.createElement('div'); view.id = 'chatview'; view.hidden = true; document.body.appendChild(view); }
  view.classList.add('chat-root');
  view.setAttribute('role', 'dialog'); view.setAttribute('aria-label', PO.t('Messages'));
  view.dataset.view = 'list';
  view.innerHTML = `
  <aside class="chat-side" aria-label="${tE('Workers')}">
    <div class="chat-sideh">
      <div class="chat-sidet"><div><b>${tE('Workers')}</b><small class="chat-bname"></small></div><button type="button" class="chat-ib chat-listx" data-act="close" aria-label="${tE('Close messages')}">×</button></div>
      <label class="chat-sw"><input type="search" class="chat-search" placeholder="${tE('Search workers…')}" aria-label="${tE('Search workers')}" autocomplete="off" spellcheck="false"></label>
    </div>
    <div class="chat-fh"><span>${tE("This chat's workers")}</span><em class="chat-cnt"></em></div>
    <div class="chat-rows"></div>
    <div class="chat-none" hidden></div>
  </aside>
  <section class="chat-conv" aria-label="${tE('Messages with the selected worker')}" data-empty="1">
    <div class="chat-ph"><b>${tE('Select a worker')}</b><span>${tE('Pick a worker from the list on the left to chat here.')}</span></div>
    <div class="chat-head">
      <button type="button" class="chat-ib chat-back" data-act="back" aria-label="${tE('Back to the list')}">‹</button>
      <span class="chat-hav"></span>
      <div class="chat-hid"><div class="chat-hn"><b></b><span class="chat-hs"></span></div><div class="chat-hr"></div></div>
      <div class="chat-acts">
        <button type="button" class="chat-act chat-stop" data-act="stop" data-tip="${tE("Stops the worker's current job.")}" data-tip-pos="bottom"><i aria-hidden="true">■</i><span class="chat-lbl">${tE('Stop')}</span></button>
        <button type="button" class="chat-act chat-cam" data-act="cam" data-tip="${tE('Moves the camera next to this worker.')}" data-tip-pos="bottom"><i aria-hidden="true">◎</i><span class="chat-lbl">${tE('Bring camera')}</span></button>
        <button type="button" class="chat-ib chat-xb" data-act="close" aria-label="${tE('Close messages')}" data-tip="${tE('Close messages')}" data-tip-pos="bottom">×</button>
      </div>
    </div>
    <div class="chat-askslot"></div>
    <div class="chat-mwrap">
      <div class="chat-msgs" role="log" aria-live="polite" aria-label="${tE('Messages')}" tabindex="0"></div>
      <div class="chat-blank" hidden></div>
      <button type="button" class="chat-newbtn" hidden>${tE('↓ New message')}</button>
    </div>
    <div class="chat-foot">
      <div class="chat-hint" hidden></div>
      <div class="chat-quick">
        <button type="button" class="chat-q" data-q="sum" data-tip="${tE("Instantly summarizes what it is doing right now; sends no question to Claude.")}" data-tip-pos="start">${tE('Status summary')}</button>
        <button type="button" class="chat-q" data-q="ask" data-tip="${tE('Puts the question in the message box; you press Send.')}" data-tip-pos="start">${tE('What are you doing?')}</button>
      </div>
      <ul class="att-list chat-atts" hidden></ul>
      <div class="chat-comp">
        <button type="button" class="att-add chat-attb" aria-label="${tE('Add file')}" data-tip="${tE('Add a file: image, PDF, text/code, audio, video. You can drag and drop or paste with Ctrl+V.')}" data-tip-pos="start">+</button>
        <input type="file" class="chat-file" multiple hidden tabindex="-1" aria-hidden="true">
        <textarea class="chat-ta" rows="1" aria-label="${tE('Write a message')}" placeholder="${tE('Write your message… (Enter sends)')}"></textarea>
        <button type="button" class="chat-send" disabled>${tE('Send')}</button>
      </div>
    </div>
  </section>`;
  const q = s => view.querySelector(s);
  Object.assign(R, {
    bname:q('.chat-bname'), search:q('.chat-search'), cnt:q('.chat-cnt'), rows:q('.chat-rows'), none:q('.chat-none'), conv:q('.chat-conv'),
    hav:q('.chat-hav'), hn:q('.chat-hn b'), hs:q('.chat-hs'), hr:q('.chat-hr'), stop:q('.chat-stop'),
    stopLbl:q('.chat-stop .chat-lbl'), askslot:q('.chat-askslot'), msgs:q('.chat-msgs'), blank:q('.chat-blank'), newbtn:q('.chat-newbtn'), hint:q('.chat-hint'), ta:q('.chat-ta'), send:q('.chat-send'),
    qsum:q('[data-q="sum"]'), qask:q('[data-q="ask"]'),
  });
  ATT = PO.att.box({ can:() => { const a = selId ? infoOf(selId) : null; return !!a && canMsg(a); }, onChange:paintSend });
  ATT.mount({ list:q('.chat-atts'), add:q('.chat-attb'), input:q('.chat-file'), zone:R.conv, ta:R.ta });

  /* clicks */
  view.addEventListener('click', e => {
    const t = e.target.closest('button'); if (!t || !view.contains(t)) return;
    if (t.classList.contains('chat-r')) { select(t.dataset.id, true); return; }
    if (t.dataset.act === 'close') { close(); return; }
    if (t.dataset.act === 'back') { view.dataset.view = 'list'; return; }
    if (t.dataset.act === 'stop') { doStop(t); return; }
    if (t.dataset.act === 'cam') { camTo(); return; }
    if (t.dataset.q === 'sum') { quickSummary(); return; }
    if (t.dataset.q === 'ask') { fillBox(askText()); return; }
    if (t.classList.contains('chat-send')) { sendBox(); return; }
    if (t.classList.contains('chat-newbtn')) { toBottom(); return; }
    if (t.dataset.more) { toggleMore(t.dataset.more); return; }
    if (t.dataset.retry) { retry(t.dataset.retry, t); return; }
  });
  /* text box */
  PO.emoji.attach(R.ta);                  // translate first, so the next listener stores the draft in its translated form
  R.ta.addEventListener('input', () => { autosize(); if (selId) drafts[selId] = R.ta.value; paintSend(); });
  R.ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendBox(); }
  });
  /* search */
  R.search.addEventListener('input', () => { try { renderAll(false); } catch (e) { console.error(e); } });
  /* scroll: sticky if at the bottom */
  R.msgs.addEventListener('scroll', () => {
    if (performance.now() < holdUntil) return;       // "Read more" scroll: do not stick even if near the bottom
    stick = nearBottom(); if (stick) setHidden(R.newbtn, true);
  }, { passive:true });
  if (window.ResizeObserver) new ResizeObserver(() => { if (isOpen && stick) R.msgs.scrollTop = R.msgs.scrollHeight; }).observe(R.msgs);
  /* keyboard: Esc closes (leaves it to another window if one is on top); while the chat is open ↑/↓ must not trigger the floor scrolling behind it */
  addEventListener('keydown', e => {
    if (!isOpen || e.defaultPrevented) return;
    if (e.key === 'Escape') {
      if (overlayAbove()) return;
      if (document.activeElement === R.search && R.search.value) { R.search.value = ''; renderAll(false); e.stopPropagation(); return; }
      close(); e.stopPropagation();
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !overlayAbove()) {
      const t = e.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (t && t.classList && t.classList.contains('chat-r')) {
        const rows = [...R.rows.querySelectorAll('.chat-r:not([hidden])')], i = rows.indexOf(t), n = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
        if (n) n.focus();
        e.preventDefault();
      }
      e.stopPropagation();
    }
  }, true);
  addEventListener('keydown', () => { kbd = true; }, true);
  addEventListener('pointerdown', () => { kbd = false; }, true);
  if (narrowMQ.addEventListener) narrowMQ.addEventListener('change', () => { if (isOpen) view.dataset.view = selId ? 'conv' : 'list'; });
}

/* ---------------------------------------------------------------- text box */
function autosize() {
  const ta = R.ta;
  ta.style.height = 'auto';
  ta.style.height = (ta.scrollHeight + (ta.offsetHeight - ta.clientHeight)) + 'px';   // at most 8 lines: CSS max-height cuts it
}
function paintSend() {
  const info = selId ? infoOf(selId) : null;
  const off = !(info && canMsg(info) && (R.ta.value.trim() || ATT.count()) && ATT.ready());   // disabled while an attachment is uploading / a failed chip exists
  if (R.send.disabled !== off) R.send.disabled = off;
}
function focusBox() { if (!R.ta.disabled) R.ta.focus({ preventScroll:true }); }
// puts the canned text in the text box and focuses it; does not send (the user presses Send)
function fillBox(text) {
  if (!selId || R.ta.disabled) return;
  const cur = R.ta.value.trim();
  if (!cur.includes(text)) {              // if the same question is already in the box it is not added a second time (double click), only focuses
    R.ta.value = cur ? cur + '\n' + text : text;
    drafts[selId] = R.ta.value;
    autosize(); paintSend();
  }
  R.ta.focus({ preventScroll:true });
  R.ta.setSelectionRange(R.ta.value.length, R.ta.value.length);
}

/* ---------------------------------------------------------------- list */
function metaOf(a) {
  const items = msgsOf(a);
  let last = null;
  for (let i = items.length - 1; i >= 0; i--) if (items[i].who !== 'ofis') { last = items[i]; break; }
  return { items, last, unread: unreadOf(a) };
}
function previewOf(a, mt) {
  if (!mt.last) return PO.friendly(a);
  const p = PO.att.plain(parseErr(mt.last).text, mt.last.atts).replace(/^\s*(?:özet|ozet|summary)\s*:\s*/i, '');     // the "ÖZET:" / "SUMMARY:" label is not shown in the row ("ÖZET:" is Turkish for "SUMMARY:"; kept verbatim, the code matches it); "Attachment: name" instead of the attachment line
  return (mt.last.who === 'ben' ? PO.t('You: ') : '') + clipW(PO.md.plain(p.slice(0, 300)), 90);
}
function sortTeam(team, metas) {
  const rank = a => (a.state === 'waiting' ? 0 : a.state === 'done' ? 2 : 1);
  const lastT = a => (metas.get(a.id).last ? metas.get(a.id).last.t : 0);
  const boss = team.filter(a => !a.sub).sort((p, q) => (p.started || 0) - (q.started || 0));
  const subs = team.filter(a => a.sub).sort((p, q) => rank(p) - rank(q) || lastT(q) - lastT(p) || (p.started || 0) - (q.started || 0));
  return boss.concat(subs);
}
function rowInner(a, mt) {
  const nick = PO.nickOf(a), role = shortRole(a), pv = previewOf(a, mt), t = mt.last ? rowTime(mt.last.t) : '';
  return `<span class="chat-rav">${PO.avatar(a, 38)}<i class="chat-dot ${dotCls(a)}"></i></span>` +
    `<span class="chat-rt"><span class="chat-r1"><b>${esc(nick)}</b>${role ? `<span class="chat-rr">${esc(role)}</span>` : ''}<time>${esc(t)}</time></span>` +
    `<span class="chat-r2"><span class="chat-pv">${esc(pv)}</span>${mt.unread ? `<i class="chat-un">${mt.unread > 99 ? '99+' : mt.unread}</i>` : ''}</span></span>`;
}
function renderList(team, metas) {
  const q = PO.lower(R.search.value.trim());
  const order = sortTeam(team, metas);
  const g = (PO.sessions || []).find(x => x.id === sid);
  setText(R.bname, g ? clipW(g.title, 40) : '');
  setText(R.cnt, team.length ? String(team.length) : '');
  const next = new Map(), els = [];
  let shown = 0;
  order.forEach(a => {
    const mt = metas.get(a.id), nick = PO.nickOf(a);
    const sig = [a.id, nick, a.char, shortRole(a), a.state, a.tool, previewOf(a, mt), mt.unread, mt.last ? rowTime(mt.last.t) : '', a.id === selId ? 1 : 0].join('|');
    let e = rowMap.get(a.id);
    if (!e) { e = document.createElement('button'); e.type = 'button'; e.className = 'chat-r'; e.dataset.id = a.id; }
    if (e._sig !== sig) {
      e._sig = sig;
      e.innerHTML = rowInner(a, mt);
      e.classList.toggle('sel', a.id === selId);
      e.classList.toggle('unread', mt.unread > 0);
      e.classList.toggle('boss', !a.sub);
      if (a.id === selId) e.setAttribute('aria-current', 'true'); else e.removeAttribute('aria-current');
      e.title = nick + (roleLine(a) ? ' · ' + roleLine(a) : '');
    }
    const hay = PO.lower([nick, kindOf(a), a.role, a.label, a.task, previewOf(a, mt)].join(' '));
    const hit = !q || hay.includes(q);
    setHidden(e, !hit); if (hit) shown++;
    next.set(a.id, e); els.push(e);
  });
  reconcile(R.rows, els);
  rowMap = next;
  const msg = !team.length ? PO.t('There are no workers in this chat yet.') : (!shown ? PO.t('No matching workers.') : '');
  setHidden(R.none, !msg); setText(R.none, msg);
}

/* ---------------------------------------------------------------- conversation header + bottom part */
function renderHead(a) {
  const can = canMsg(a);
  const sig = [a.id, PO.nickOf(a), a.char, roleLine(a), a.state, a.tool, can ? 1 : 0].join('|');
  if (sig !== headSig) {
    headSig = sig;
    R.hav.innerHTML = PO.avatar(a, 42);
    R.hn.textContent = PO.nickOf(a);
    const working = !!WORKING[a.state];
    R.hs.className = 'chat-hs ' + dotCls(a);
    R.hs.innerHTML = `<i class="chat-dot ${dotCls(a)}"></i><span>${esc(PO.friendly(a))}</span>` + (working ? '<span class="chat-typing" aria-hidden="true"><i></i><i></i><i></i></span>' : '');
    R.hr.textContent = roleLine(a);
    R.hr.title = roleLine(a);
  }
  setHidden(R.stop, a.state === 'done');
}
function renderFoot(a, blank) {
  const can = canMsg(a), boss = !a.sub, spawn = String(a.id).startsWith('spawn-'), nick = PO.nickOf(a);
  const sig = [a.id, nick, can ? 1 : 0, boss ? 1 : 0, spawn ? 1 : 0, blank ? 1 : 0].join('|');
  if (sig !== footSig) {
    footSig = sig;
    // why an empty conversation already says it in the middle: the same text must not be written a second time at the bottom
    const to = dative(nick);       // Turkish "Müdire'ye", "Hayalet'e" (dative suffix); English: the name; '' if unsure (generic text)
    const txt = !can ? (blank ? '' : (spawn ? HINT_NEW() : hintOff())) : (boss ? (to ? PO.t('Messages you write to {name} go to Claude as your own message.', { name:to }) : PO.t('Messages you write to this worker go to Claude as your own message.')) : '');
    setHidden(R.hint, !txt); setText(R.hint, txt); R.hint.classList.toggle('err', !can);
    R.qask.disabled = !can;
    R.ta.setAttribute('aria-disabled', can ? 'false' : 'true');
    R.ta.placeholder = to ? PO.t('Write to {name}… (Enter sends)', { name:to }) : PO.t('Write to this worker… (Enter sends)');
  }
  // the box must not lock while typing: leave it open if focused (the send button is already disabled)
  const lock = !can && document.activeElement !== R.ta;
  if (R.ta.disabled !== lock) R.ta.disabled = lock;
  paintSend();
}

/* ---------------------------------------------------------------- messages */
const nearBottom = () => R.msgs.scrollHeight - R.msgs.scrollTop - R.msgs.clientHeight < 60;
function toBottom() { R.msgs.scrollTop = R.msgs.scrollHeight; stick = true; setHidden(R.newbtn, true); }
function bodyHTML(text, key, plainUser) {
  const open = expanded.has(key), long = isLong(text);
  let head = '', rest = text, hasSum = false;
  if (!plainUser) {
    const sm = /^\s*(?:özet|ozet|summary)\s*:[ \t]*([^\n]*)(?:\n([\s\S]*))?$/i.exec(text);
    if (sm && sm[1].trim()) { hasSum = true; head = sm[1]; rest = sm[2] || ''; }
  }
  let html = '';
  if (hasSum) html += `<div class="chat-sum"><span class="chat-sumk">${tE('SUMMARY')}</span><div class="chat-sumt">${PO.md.render(head)}</div></div>`;
  const hasBody = rest.trim().length > 0;
  if (hasBody) {
    const clipIt = long && !open;
    html += `<div class="chat-body${clipIt ? ' chat-clip' : ''}${plainUser ? ' chat-plain' : ''}">${plainUser ? esc(rest) : PO.md.render(rest)}</div>`;
    if (long) html += `<button type="button" class="chat-more" data-more="${esc(key)}" aria-expanded="${open ? 'true' : 'false'}">${open ? tE('Show less') : tE('Read more')}</button>`;
  }
  return html;
}
function buildMsg(it, a) {
  const m = it.m, key = it.key;
  let html = it.day ? `<div class="chat-day"><span>${esc(it.day)}</span></div>` : '', cls;
  if (m.who === 'ofis') {
    cls = 'chat-m chat-sysm';
    const nt = parseNote(m);
    html += `<div class="chat-sys${nt.failed ? ' err' : ''}">${esc(nt.text)}</div>`;
  } else if (m.who === 'ben') {
    cls = 'chat-m chat-me';
    const er = parseErr(m), pa = PO.att.split(er.text, m.atts);   // attachments (the server's atts field) become chips in the bubble (full path in the tooltip)
    let st;
    if (m.st === 'iletildi' || m.st === 'yanit') st = tE('✓ delivered') + (m.via ? ' · ' + esc(viaText(m.via)) : '');
    else if (m.st === 'hata') st = (er.why ? PO.t('! not delivered: {why}', { why:esc(er.why) }) : tE('! not delivered')) + ` <button type="button" class="chat-retry" data-retry="${esc(key)}">${tE('Resend')}</button>`;
    else if (m.local) st = tE('… sending');
    else st = it.stale ? tE('… still waiting (Claude has not received it yet)') : tE('… waiting');
    html += `<div class="chat-line"><div class="chat-col"><div class="chat-bub">${bodyHTML(pa.text, key, true)}${PO.att.msgHTML(pa.atts)}</div><div class="chat-meta${m.st === 'hata' ? ' err' : ''}"><time>${esc(PO.fmtHM(m.t))}</time> · ${st}</div></div></div>`;
  } else {
    cls = 'chat-m chat-ag';
    html += `<div class="chat-line"><div class="chat-avc">${it.first ? PO.avatar(a, 34) : ''}</div><div class="chat-col">` +
      (it.first ? `<div class="chat-who"><b>${esc(PO.nickOf(a))}</b><time>${esc(PO.fmtHM(m.t))}</time></div>` : '') +
      `<div class="chat-bub">${bodyHTML(String(m.text == null ? '' : m.text), key, false)}</div></div></div>`;
  }
  const w = document.createElement('div');
  w.className = cls + (it.first ? ' first' : '');
  w.dataset.k = key; w._sig = it.sig;
  w.innerHTML = html;
  return w;
}
function renderMsgs(a, items, force) {
  const now = PO.nowSec();
  const out = [], keys = new Set();
  let prev = null;
  items.forEach((m, i) => {
    let key = String(m.id == null ? 'i' + i : m.id); while (keys.has(key)) key += '_'; keys.add(key);
    const showDay = !prev || dayKey(prev.t) !== dayKey(m.t);
    const first = showDay || !prev || prev.who !== m.who || m.who === 'ofis' || (m.t - prev.t) > 240;
    const stale = m.who === 'ben' && m.st === 'bekliyor' && !m.local && now - m.t > 25;
    const text = String(m.text == null ? '' : m.text);
    const day = showDay ? dayLabel(m.t) : '';
    out.push({ m, key, first, day, stale,
      sig:[key, m.who, m.st || '', m.via || '', text.length, text.slice(-14), first ? 1 : 0, day, expanded.has(key) ? 1 : 0, stale ? 1 : 0, m.local ? 1 : 0, PO.nickOf(a), a.char].join('|') });
    prev = m;
  });
  const wasStick = stick || force;
  const next = new Map(), els = [];
  out.forEach(it => {
    let e = msgMap.get(it.key);
    if (!e || e._sig !== it.sig) e = buildMsg(it, a);
    next.set(it.key, e); els.push(e);
  });
  reconcile(R.msgs, els);
  msgMap = next;
  // empty conversation
  const blank = !items.length;
  if (blank) {
    setHidden(R.blank, false);
    const can = canMsg(a), bsig = [a.id, PO.nickOf(a), a.char, can ? 1 : 0, a.sub ? 1 : 0, String(a.id).startsWith('spawn-') ? 1 : 0].join('|');
    if (R.blank._id !== bsig) {
      R.blank._id = bsig;
      // if messaging is off, only the reason is written instead of the empty-state text
      const why = !can ? (String(a.id).startsWith('spawn-') ? HINT_NEW() : hintOff()) : (a.sub ? BLANK_HELP() : PO.t('Write your first message below; press Enter to send.'));
      R.blank.innerHTML = `${PO.avatar(a, 64)}<b>${esc(PO.t('You have not chatted with {name} yet', { name:PO.nickOf(a) }))}</b><span>${esc(why)}</span>`;
    }
  } else { setHidden(R.blank, true); R.blank._id = null; }
  // scroll: stick if at the bottom; otherwise a hint for the newly arrived reply
  const last = items[items.length - 1];
  if (wasStick) { R.msgs.scrollTop = R.msgs.scrollHeight; stick = true; setHidden(R.newbtn, true); }
  else if (newCount >= 0 && items.length > newCount && last && last.who === 'ajan') setHidden(R.newbtn, false);
  newCount = items.length;
  return blank;
}
// brings the top of the message `gap` px close to the top of the container. Measures once more after the layout settles (double rAF);
// the scroll event does not change the stick-to-bottom decision (stick) in the meantime.
function revealMsg(key, gap) {
  const tok = ++revealTok;
  const place = () => {
    const w = msgMap.get(key); if (!w || !w.isConnected) return;
    R.msgs.scrollTop += w.getBoundingClientRect().top - R.msgs.getBoundingClientRect().top - gap;
  };
  stick = false;
  holdUntil = performance.now() + 500;
  place();
  requestAnimationFrame(() => requestAnimationFrame(() => { if (tok === revealTok && isOpen) { place(); holdUntil = performance.now() + 150; } }));
}
function toggleMore(key) {
  const a = infoOf(selId); if (!a) return;
  const was = expanded.has(key), w0 = msgMap.get(key);
  const rel = w0 ? w0.getBoundingClientRect().top - R.msgs.getBoundingClientRect().top : 8;   // the message's position in the view (kept when collapsing)
  if (was) expanded.delete(key); else expanded.add(key);
  stick = false;                                                   // jumping to the bottom: the start of the message should be visible
  renderMsgs(a, msgsOf(a), false);
  revealMsg(key, was ? Math.max(8, rel) : 8);
  const b = R.msgs.querySelector('[data-more="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
  if (b) b.focus({ preventScroll:true });
}

/* ---------------------------------------------------------------- main render */
function pickDefault(team) {
  const rem = selMap[sid];
  if (rem && team.some(a => a.id === rem)) return rem;
  const boss = team.find(a => !a.sub);
  return (boss || team[0] || {}).id || null;
}
function renderAll(force) {
  const team = teamOf(sid);
  if (!team.length) selId = null; else if (!team.some(a => a.id === selId)) selId = pickDefault(team);
  const a = selId ? team.find(x => x.id === selId) : null;
  if (a && isOpen && !document.hidden && (!narrowMQ.matches || view.dataset.view === 'conv')) setSeen(a);
  const metas = new Map(); team.forEach(x => metas.set(x.id, metaOf(x)));
  renderList(team, metas);
  setData(R.conv, 'empty', a ? '0' : '1');
  if (narrowMQ.matches && !a) setData(view, 'view', 'list');
  if (!a) { convId = null; if (PO.asks && PO.asks.setScope) PO.asks.setScope('none', () => false); disarmStop(); updateBadge(); return; }
  if (convId !== a.id) {                   // conversation changed: store/restore the draft, rebuild the history from scratch
    if (convId) drafts[convId] = R.ta.value;
    convId = a.id; headSig = ''; footSig = ''; force = true; stick = true; newCount = -1;
    msgMap = new Map(); R.msgs.textContent = ''; R.blank._id = null; setHidden(R.newbtn, true);
    R.ta.value = drafts[a.id] || '';
    ATT.use(a.id);
    autosize();
    disarmStop();
  }
  if (PO.asks && PO.asks.setScope) {      // the question card shows only in the conversation of the session / worker the question came from
    const ss = sidOf(a), boss = !a.sub;
    PO.asks.setScope(ss + '|' + a.id, it => it.sid === ss && (boss ? !it.aid : 'agent-' + it.aid === a.id));
  }
  renderHead(a);
  ATT.paint();                            // the "+" button opens/closes with the message link (touches the DOM only when changed)
  const blank = renderMsgs(a, metas.get(a.id).items, force);
  renderFoot(a, blank);
  updateBadge();
}

/* ---------------------------------------------------------------- actions */
function select(id, user) {
  if (!id) return;
  selId = id; selMap[sid] = id; lsSet(SEL_KEY, selMap);
  if (narrowMQ.matches) view.dataset.view = 'conv';
  renderAll(true);
  if (user) focusBox();
}
// atts: PO.att attachments (id + name/kind/size). The bubble shows the same as what the server will record (text + separate attachments; so they match when it arrives).
async function send(text, atts) {
  const id = selId, a = infoOf(id), tx = String(text || '').trim();
  atts = atts || [];
  if (!a || (!tx && !atts.length)) return;
  if (!canMsg(a)) { PO.ui.toast(PO.t('Messages cannot be sent right now.'), { kind:'bad' }); ATT.restore(id, atts); return; }
  const p = { id:'p' + (++pn), t:Date.now() / 1000, who:'ben', text:PO.att.neutral(tx), st:'bekliyor', local:true,
    atts:atts.map(x => ({ id:x.id, name:x.name, kind:x.kind, size:x.size, sizeTxt:x.sizeTxt, path:x.path })) };
  (pending[id] = pending[id] || []).push(p);
  if (id === selId) renderMsgs(a, msgsOf(a), true);
  let r;
  try { r = await PO.api.send(id, tx, atts); } catch (e) { r = { ok:false, reason:PO.t('Unexpected error') }; }
  if (r && r.ok) { ATT.drop(id, atts); return; }
  pending[id] = (pending[id] || []).filter(x => x !== p);
  const reason = reasonTr((r && r.reason) || '') || PO.t('Could not send');
  PO.ui.toast(PO.t('Message could not be sent: {reason}', { reason }), { kind:'bad' });
  // do not lose the text and attachments: put them back in the box (in front of any other text in the box; attachments at the head of that worker's list).
  // The server reports an attachment it could not find (missing): that chip comes back as "failed", the user can remove it with × and send again.
  ATT.restore(id, atts, r && r.missing ? { [r.missing]: reason } : null);
  if (tx) {
    const cur = id === selId ? R.ta.value : (drafts[id] || '');
    const back = cur.trim() ? tx + '\n' + cur : tx;
    drafts[id] = back;
    if (id === selId) R.ta.value = back;
  }
  if (id === selId) { autosize(); paintSend(); const a2 = infoOf(id); if (a2) renderMsgs(a2, msgsOf(a2), false); }
}
function sendBox() {
  const tx = R.ta.value.trim();
  if (R.send.disabled || (!tx && !ATT.count())) return;
  const atts = ATT.take();
  R.ta.value = ''; drafts[selId] = ''; autosize(); paintSend();
  send(tx, atts);
  focusBox();
}
const retrying = new Set();                // while "Resend" is in progress the same message must not go a second time
async function retry(key, b) {
  const a = infoOf(selId); if (!a || retrying.has(key)) return;
  const m = msgsOf(a).find(x => String(x.id) === key || String(x.id) + '_' === key);
  if (!m) return;
  const pa = PO.att.split(parseErr(m).text, m.atts);  // attachments are sent again with their ids (the server rewrites the lines)
  retrying.add(key);
  if (b) b.disabled = true;
  try { await send(pa.text, pa.atts); } finally { retrying.delete(key); if (b && b.isConnected) b.disabled = false; }
}
function quickSummary() {
  const a = infoOf(selId); if (!a) return;
  (PO.localMsgs[a.id] = PO.localMsgs[a.id] || []).push({ id:'l' + Date.now() + Math.random().toString(36).slice(2, 6), t:Date.now() / 1000, who:'ofis', text:PO.summarize(a), st:'', local:true });
  renderMsgs(a, msgsOf(a), true);
}
function disarmStop() {
  clearTimeout(stopTimer); stopTimer = 0;
  if (!R.stop || !R.stop.classList.contains('armed')) return;
  R.stop.classList.remove('armed');
  R.stopLbl.textContent = PO.t('Stop');
}
async function doStop(b) {
  const id = selId, a = infoOf(id); if (!id || !a || b.disabled) return;
  if (!a.sub) {                          // stopping the manager cuts the main work: two steps
    if (!b.classList.contains('armed')) {
      b.classList.add('armed'); R.stopLbl.textContent = PO.t('Are you sure?');
      stopTimer = setTimeout(disarmStop, 4000);
      return;
    }
    disarmStop();
  }
  b.disabled = true;
  let r; try { r = await PO.api.stop(id); } catch (e) { r = { ok:false, reason:PO.t('Unexpected error') }; }
  setTimeout(() => { b.disabled = false; }, 1500);
  if (r && r.ok) {
    PO.ui.toast(PO.t('Stop request sent'), { kind:'ok' });
    if (r.id) stopWatch = { id, mid:r.id, t:Date.now() };      // if Claude rejects the request (ack error) report it in the same language
  } else PO.ui.toast(PO.t('Could not stop: {reason}', { reason:reasonTr((r && r.reason) || '') || PO.t('unknown reason') }), { kind:'bad' });
}
function checkStopWatch() {
  if (!stopWatch) return;
  const a = infoOf(stopWatch.id), m = a && (a.chat || []).find(x => x.id === stopWatch.mid);
  if (m && m.st === 'hata') { stopWatch = null; PO.ui.toast(parseNote(m).text.replace(/^!\s*/, ''), { kind:'bad' }); }
  else if ((m && m.st === 'iletildi') || Date.now() - stopWatch.t > 20000) stopWatch = null;
}
function camTo() {
  const id = selId, g = sid; if (!id) return;
  close();
  if (g && g !== PO.activeSid && PO.switchSession) PO.switchSession(g);
  const a = PO.AG && PO.AG.get(id);
  if (!a) { PO.ui.toast(PO.t('The worker is not visible in the office right now.'), { kind:'bad' }); return; }
  if (PO.select) PO.select(id, false);
  PO.focusAgent(a);
}

/* ---------------------------------------------------------------- open / close */
// the shell left behind while the chat is open is inert: so Tab focus does not go to covered elements. We re-enable only what we made inert.
let inertSet = [];
function setShellInert(on) {
  if (on) { inertSet = INERT_IDS.map(i => document.getElementById(i)).filter(e => e && !e.inert); inertSet.forEach(e => { e.inert = true; }); }
  else {
    // if the settings drawer is open the side panel and the splitter must stay inert for it; they must not get stuck whatever the order
    const setOpen = !!(PO.settingsUI && PO.settingsUI.isOpen && PO.settingsUI.isOpen());
    inertSet.forEach(e => { e.inert = false; });
    ['side', 'splitter'].forEach(i => { const e = document.getElementById(i); if (e) e.inert = setOpen; });
    inertSet = [];
  }
}
function open(id, opts) {
  if (!view) return;
  const ex = opts && opts.expand != null ? String(opts.expand) : '';
  if (ex) expanded.add(ex);              // "Read more" on the card: that message should come up expanded
  const was = isOpen;
  const inf = id ? infoOf(id) : null;
  if (inf) { sid = sidOf(inf); selId = inf.id; selMap[sid] = inf.id; lsSet(SEL_KEY, selMap); }
  else if (!was) { sid = PO.activeSid || ((PO.sessions || [])[0] || {}).id || null; selId = null; }
  lastActive = PO.activeSid;
  if (!was) {                            // return focus only if it was opened with the keyboard (so the hint does not stick when opened with the mouse and closed with Esc)
    const ae = document.activeElement;
    returnTo = kbd ? ((ae && ae !== document.body && !view.contains(ae)) ? ae : btn) : null;
    setShellInert(true);
  }
  isOpen = true; view.hidden = false;
  if (PO.asks && PO.asks.dockIn) PO.asks.dockIn(R.askslot);     // Claude's question card shows inside the conversation
  if (btn) { btn.setAttribute('aria-pressed', 'true'); btn.classList.add('on'); }
  if (!timer) timer = setInterval(() => { try { PO.chat.update(); } catch (e) { /* */ } }, 1000);
  if (narrowMQ.matches) view.dataset.view = inf ? 'conv' : (was ? view.dataset.view : 'list');
  renderAll(true);
  if (!was || inf) {
    if (narrowMQ.matches && view.dataset.view === 'list') { const r = R.rows.querySelector('.chat-r.sel') || R.rows.querySelector('.chat-r'); if (r) r.focus({ preventScroll:true }); }
    else focusBox();
  }
  if (ex && msgMap.has(ex)) revealMsg(ex, 8);      // the top of that message should come into the visible area
}
function close() {
  if (!isOpen) return;
  if (convId) drafts[convId] = R.ta.value;
  disarmStop();
  const hadFocus = view.contains(document.activeElement);
  isOpen = false; view.hidden = true;
  if (PO.asks && PO.asks.dockIn) { PO.asks.setScope('', null); PO.asks.dockIn(null); }          // the card returns to its place in the corner
  clearInterval(timer); timer = 0;
  setShellInert(false);
  if (btn) { btn.setAttribute('aria-pressed', 'false'); btn.classList.remove('on'); }
  const back = returnTo; returnTo = null;
  if (hadFocus && back && back.isConnected && !back.closest('[hidden]')) back.focus({ preventScroll:true });
}

PO.chat = {
  open(id, opts) { try { open(id, opts); } catch (e) { console.error(e); } },
  close() { try { close(); } catch (e) { console.error(e); } },
  isOpen() { return isOpen; },
  update() {
    try {
      boot();
      checkStopWatch();
      if (!isOpen) { updateBadge(); return; }
      const alive = (PO.sessions || []).some(x => x.id === sid);
      if (PO.activeSid !== lastActive || !alive) { lastActive = PO.activeSid; sid = PO.activeSid; selId = null; }
      renderAll(false);
    } catch (e) { console.error(e); }
  },
};

/* ---------------------------------------------------------------- start */
build();
btn = document.getElementById('chatBtn');
if (btn) { btn.setAttribute('aria-haspopup', 'dialog'); btn.setAttribute('aria-pressed', 'false'); btn.addEventListener('click', () => (isOpen ? close() : open())); }
updateBadge();
// test: ?chat=main | ?chat=<index> (waits until the state arrives)
(function () {
  let p = null; try { p = new URLSearchParams(location.search).get('chat'); } catch (e) { /* */ }
  if (p == null) return;
  let tries = 0;
  const iv = setInterval(() => {
    if (++tries > 80) { clearInterval(iv); return; }
    const team = teamOf(PO.activeSid || ((PO.sessions || [])[0] || {}).id);
    if (!team.length) return;
    clearInterval(iv);
    const list = PO.serverList && PO.serverList.length ? PO.serverList : team;
    const a = p === 'main' || p === '' ? (team.find(x => !x.sub) || team[0]) : (list[+p] || team[0]);
    open(a.id);
  }, 150);
})();
})(window.PO = window.PO || {});
