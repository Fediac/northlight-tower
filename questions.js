'use strict';
/* NorthLight Tower — QUESTION CARD for Claude's questions (AskUserQuestion).
   When Claude asks a question, the Pixel Office plugin leaves the question in the tower (POST /ask); this module polls GET /asks for
   pending questions, shows the card at the bottom right, and sends the answer with POST /answer. The plugin hands the answer to Claude: no need to go back to the Claude window.
   - Even if the window is behind another window, or even when the office is closed, the question is accepted into the tower and waits (the badge, title, beep
     give notice); when the office opens the card appears right away. If no answer comes in 10 min, the question is asked in the Claude window.
   - After an answer is sent it says "passing it to Claude…"; when the plugin reports it received the answer (recent[].delivered) it says "iletildi" (delivered), and if it does not report
     or says "ulaşmadı" (not reached) (recent[].lost, ~15 s) it gives the "Claude penceresinde cevapla" (answer in the Claude window) warning.
   - Gets attention but does not disturb: it does not steal focus; a short notification (toast), the "Question" badge in the header, (?) in the tab title and
     a single short beep if sound is on. Esc or "–" minimizes the card (the badge stays).
   Security: every text in the question is written with textContent (HTML is not interpreted). The answer goes with the question id given by the server.
   Contract: PO.asks.count() — number of pending questions; PO.asks.open() — opens the card and focuses the first field. */
(function (PO) {
const POLL_MS = 1000;
const $ = id => document.getElementById(id);
const btnEl = $('askBtn'), badgeEl = $('askBadge');
const BASE_TITLE = document.title;

const DELIVER_MS = 15000;        // after an answer is sent it waits at most this long for the plugin's "received" notice
let dock = null;                 // #askdock: container of the cards
let live = null;                 // screen reader announcement (aria-live): new card / result
const cards = new Map();         // question id -> { item, el, tag, sending, mine, nonce }
const sent = new Map();          // questions whose answer was sent and for which the plugin's received notice is awaited: id -> { t, close }
const announced = new Set();     // question ids already announced
const closedSeen = new Set();    // ids for which the "Moved to the Claude window" notice was already given
let minimized = false, busy = false, seq = 0;
let scope = null, scopeKey = '';   // which conversation's questions are visible in the Messages window (null: all)
const nonceOf = () => 'k' + Array.from(crypto.getRandomValues(new Uint8Array(9)), b => b.toString(16).padStart(2, '0')).join('');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}
function ensureDock() {
  if (dock) return dock;
  dock = el('div', 'ask-dock');
  dock.id = 'askdock';
  dock.hidden = true;
  dock.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); setMin(true); if (btnEl && !btnEl.hidden) btnEl.focus(); }
  });
  document.body.appendChild(dock);
  live = el('div', 'ask-sr');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  document.body.appendChild(live);
  return dock;
}
// short announcement to the screen reader (cleared first so the same text is read even if it comes twice in a row)
function say(text) {
  ensureDock();
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 60);
}

/* ---- attention: a single short beep (if sound is on) ---- */
let actx = null;
function bip() {
  if (!PO.settings || !PO.settings.get('sound')) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const t0 = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine'; o.frequency.value = 880; o.connect(g); g.connect(actx.destination);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.06, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    o.start(t0); o.stop(t0 + 0.24);
  } catch (e) { /* no sound */ }
}

/* ---- badge, tab title, minimizing ---- */
function paint() {
  const n = cards.size;
  if (btnEl) {
    if (btnEl.hidden !== (n === 0)) btnEl.hidden = n === 0;
    btnEl.classList.toggle('ask-has', n > 0);
    btnEl.classList.toggle('on', n > 0 && !minimized);
    btnEl.setAttribute('aria-expanded', n > 0 && !minimized ? 'true' : 'false');
    const lbl = n ? PO.t(minimized ? '{q} (open card)' : '{q} (minimize card)', { q:PO.tn(n, 'Claude has {n} question waiting', 'Claude has {n} questions waiting') }) : PO.t('Question');
    if (btnEl.getAttribute('aria-label') !== lbl) btnEl.setAttribute('aria-label', lbl);
  }
  if (badgeEl) {
    if (badgeEl.hidden !== (n === 0)) badgeEl.hidden = n === 0;
    if (badgeEl.textContent !== String(n)) badgeEl.textContent = String(n);
  }
  const base = PO.baseTitle || BASE_TITLE, want = n ? '(?) ' + base : base;       // same rule as panel.js PO.titleFor (so they do not fight)
  if (document.title !== want && !document.title.startsWith('⚠')) document.title = want;
  if (dock) {
    // while the Messages window is open only that conversation's question is visible (scope); in the corner container, all of them
    const mine = [...cards.values()].filter(c => !scope || scope(c.item)).length;
    dock.hidden = mine === 0;
    dock.classList.toggle('min', minimized);
    let i = 0;
    for (const c of cards.values()) {                         // one card at a time: the oldest question in front, the others in the queue
      if (scope && !scope(c.item)) { c.el.hidden = true; continue; }
      c.el.hidden = i++ > 0;
      const other = !!(c.item.sid && PO.activeSid && c.item.sid !== PO.activeSid);   // updated when the chat tab changes
      if (c.tag.hidden === other) c.tag.hidden = !other;
      const more = c.el.querySelector('.ask-more');
      if (more) { more.hidden = mine < 2; more.textContent = mine > 1 ? PO.t('+{n} more in queue', { n:mine - 1 }) : ''; }
    }
  }
}
function setMin(v) { minimized = !!v; paint(); }
function firstField(c) { return c && (c.el.querySelector('.ask-body input:not([disabled]), .ask-body textarea:not([disabled])') || c.el.querySelector('button:not([disabled])')); }
function open() {
  setMin(false);
  const c = cards.values().next().value;
  const f = firstField(c);
  if (f) f.focus();
}
if (btnEl) btnEl.addEventListener('click', () => { if (minimized || !dock || !dock.contains(document.activeElement)) open(); else setMin(true); });

/* ---- card ---- */
function whoLine(it) {
  return (it.nick || (it.sub ? PO.t('Worker') : PO.t('Manager'))) + (it.sub && it.kind_tr ? ' · ' + it.kind_tr : '');
}
function buildChoice(q, qi, fs, uid) {
  const multi = !!q.multiSelect, name = uid + '-q' + qi;
  const box = el('div', 'ask-opts');
  box.setAttribute('role', multi ? 'group' : 'radiogroup');
  box.setAttribute('aria-labelledby', uid + '-qt' + qi);                 // name of the option group: the question itself
  const prev = q.options.some(o => o.preview) ? el('pre', 'ask-prev') : null;
  if (prev) prev.hidden = true;
  const showPrev = o => { if (!prev) return; prev.hidden = !o.preview; prev.textContent = o.preview || ''; };
  q.options.forEach((o, oi) => {
    const lab = el('label', 'ask-opt');
    const inp = el('input');
    inp.type = multi ? 'checkbox' : 'radio'; inp.name = name; inp.value = String(oi); inp.dataset.opt = String(oi);
    const tx = el('span', 'ask-ot');
    tx.appendChild(el('b', '', o.label));
    if (o.description) tx.appendChild(el('small', '', o.description));
    lab.append(inp, tx);
    inp.addEventListener('focus', () => showPrev(o));
    inp.addEventListener('change', () => { if (inp.checked) showPrev(o); });
    lab.addEventListener('mouseenter', () => showPrev(o));
    box.appendChild(lab);
  });
  // "Other": free text (like in Claude's box); it is selected by itself once you start typing
  const lab = el('label', 'ask-opt ask-other');
  const inp = el('input');
  inp.type = multi ? 'checkbox' : 'radio'; inp.name = name; inp.value = 'other'; inp.dataset.other = '1';
  const tx = el('span', 'ask-ot');
  tx.appendChild(el('b', '', PO.t('Other')));
  const other = el('input', 'ask-otext');
  other.type = 'text'; other.maxLength = 2000; other.placeholder = PO.t('Type your own answer…');
  other.setAttribute('aria-label', PO.t('Other: your own answer'));
  if (PO.emoji) PO.emoji.attach(other);
  other.addEventListener('input', () => { if (other.value.trim() && !inp.checked) { inp.checked = true; if (prev) prev.hidden = true; } });
  other.addEventListener('click', e => e.stopPropagation());
  inp.addEventListener('change', () => { if (inp.checked) { if (prev) prev.hidden = true; other.focus(); } });
  tx.appendChild(other);
  lab.append(inp, tx);
  box.appendChild(lab);
  fs.appendChild(box);
  if (prev) fs.appendChild(prev);
  return () => {
    const sel = [...box.querySelectorAll('input[data-opt]')].filter(x => x.checked).map(x => +x.dataset.opt);
    const o = inp.checked ? other.value.trim() : '';
    if (inp.checked && !o) return { err:PO.t('Type your answer for “Other”'), focus:other };
    if (!sel.length && !o) return { err:PO.t('Answer this question'), focus:box.querySelector('input') };
    return { val:o ? { sel, other:o } : { sel } };
  };
}
function buildText(q, fs) {
  const ta = el('textarea', 'ask-text');
  ta.rows = 3; ta.maxLength = 2000; ta.placeholder = q.placeholder || PO.t('Type your answer…');
  ta.setAttribute('aria-label', q.question);
  if (PO.emoji) PO.emoji.attach(ta);
  fs.appendChild(ta);
  return () => (ta.value.trim() ? { val:{ text:ta.value.trim() } } : { err:PO.t('Answer this question'), focus:ta });
}
function buildNumber(q, fs, uid, qi) {
  const row = el('div', 'ask-num');
  const rng = el('input'), num = el('input');
  rng.type = 'range'; num.type = 'number';
  for (const x of [rng, num]) { x.min = String(q.min); x.max = String(q.max); x.step = q.step ? String(q.step) : 'any'; }
  const start = q.defaultValue != null ? q.defaultValue : q.min;
  rng.value = num.value = String(start);
  rng.setAttribute('aria-label', q.question); num.setAttribute('aria-label', PO.t('{q} (number)', { q:q.question }));
  num.id = uid + '-n' + qi;
  rng.addEventListener('input', () => { num.value = rng.value; });
  num.addEventListener('input', () => { if (num.value !== '') rng.value = num.value; });
  row.append(rng, num);
  if (q.unit) row.appendChild(el('span', 'ask-unit', q.unit));
  row.appendChild(el('small', 'ask-range', q.min + ' – ' + q.max));
  fs.appendChild(row);
  return () => {
    const v = Number(num.value);
    if (num.value === '' || !Number.isFinite(v) || v < q.min || v > q.max) return { err:PO.t('The number must be between {min} and {max}', { min:q.min, max:q.max }), focus:num };
    return { val:{ num:v } };
  };
}
function buildCard(it) {
  const uid = 'ask' + (++seq);
  const card = el('section', 'ask-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'false');
  card.setAttribute('aria-labelledby', uid + '-t');
  const hd = el('div', 'ask-hd');
  if (PO.avatar) { const a = el('span'); a.innerHTML = PO.avatar({ char:it.char }, 38); hd.appendChild(a.firstChild); }   // avatar: the character id is filtered in ui.js
  const ht = el('div', 'ask-ht');
  const kick = el('div', 'ask-kick');
  kick.appendChild(el('span', 'ask-pip'));
  kick.appendChild(el('span', '', PO.t('QUESTION · {who}', { who:whoLine(it) })));
  const tag = el('span', 'ask-tag', PO.t('OTHER CHAT'));
  tag.hidden = !(it.sid && PO.activeSid && it.sid !== PO.activeSid);         // paint() recomputes when the chat changes
  kick.appendChild(tag);
  const more = el('span', 'ask-tag ask-more'); more.hidden = true; kick.appendChild(more);
  const h = el('h2', 'ask-title', it.chat || PO.t('Claude is asking something'));
  h.id = uid + '-t';
  ht.append(kick, h);
  const min = el('button', 'ask-min', '–');
  min.type = 'button'; min.setAttribute('aria-label', PO.t('Minimize card (Esc)')); min.title = PO.t('Minimize (Esc)');
  min.addEventListener('click', () => { setMin(true); if (btnEl) btnEl.focus(); });
  hd.append(ht, min);
  card.appendChild(hd);

  const form = el('form', 'ask-body');
  form.noValidate = true;
  const getters = [];
  (it.questions || []).forEach((q, qi) => {
    const fs = el('fieldset', 'ask-q');
    const lg = el('legend', 'ask-lg');
    if (q.header) lg.appendChild(el('span', 'ask-chip', q.header));
    const qt = el('span', 'ask-qt', q.question);
    qt.id = uid + '-qt' + qi;
    lg.appendChild(qt);
    fs.appendChild(lg);
    if (q.description) fs.appendChild(el('p', 'ask-qd', q.description));
    if (q.kind === 'choice' && q.multiSelect) fs.appendChild(el('p', 'ask-hint', PO.t('You can pick more than one.')));
    getters.push(q.kind === 'text' ? buildText(q, fs) : q.kind === 'number' ? buildNumber(q, fs, uid, qi) : buildChoice(q, qi, fs, uid));
    form.appendChild(fs);
  });
  const err = el('div', 'ask-err');
  err.setAttribute('role', 'alert');
  const btns = el('div', 'ask-btns');
  const send = el('button', 'ask-btn pri', PO.t('Send'));
  send.type = 'submit';
  btns.append(send);
  const note = el('small', 'ask-note', PO.t('Answer every question. If you do not answer, the question will be asked in the Claude window after 10 min. Ctrl+Enter: send.'));
  form.append(err, btns, note);
  card.appendChild(form);

  const c = { item:it, el:card, tag, sending:false, mine:false, nonce:nonceOf() };   // nonce: on retry, success instead of "already answered"
  const lock = (on, label) => {
    c.sending = on;
    form.querySelectorAll('input, textarea, button').forEach(x => { x.disabled = on; });
    send.textContent = on ? (label || PO.t('Sending…')) : PO.t('Send');
  };
  const fail = (reason, focus) => {
    err.textContent = reason || PO.t('Could not send; try again');
    if (focus) focus.focus();
  };
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (c.sending) return;
    err.textContent = '';
    const answers = [];
    for (const g of getters) {
      const r = g();
      if (r.err) { fail(r.err, r.focus); return; }
      answers.push(r.val);
    }
    lock(true);
    const r = await PO.api.answer(it.id, answers, c.nonce);
    if (r && r.ok) { c.mine = true; finish(it.id, ''); awaitDelivery(it); return; }
    lock(false);
    if (r && /geçerli değil|zaten|devredildi|no longer valid|already|handed over/i.test(r.reason || '')) { c.mine = true; finish(it.id, r.reason, 'bad'); return; }
    fail(r && r.reason);
  });
  form.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit ? form.requestSubmit(send) : send.click(); }
  });
  return c;
}

// removes the card; if focus is on the card, it moves to the next card or to the "Question" button
function finish(id, msg, kind) {
  const c = cards.get(id);
  if (!c) return;
  const hadFocus = c.el.contains(document.activeElement);
  c.el.remove();
  cards.delete(id);
  closedSeen.add(id);
  paint();
  if (msg && PO.ui && PO.ui.toast) PO.ui.toast(msg, { kind:kind || 'info' });
  if (hadFocus) {
    const next = cards.values().next().value;
    const f = !minimized && firstField(next);
    if (f) f.focus(); else if (btnEl && !btnEl.hidden) btnEl.focus();
  }
}

function add(it) {
  ensureDock();
  const c = buildCard(it);
  cards.set(it.id, c);
  dock.appendChild(c.el);
  paint();
  if (!announced.has(it.id)) {
    announced.add(it.id);
    bip();
    const lead = cards.size > 1 ? ' (' + PO.t('{n} questions waiting', { n:cards.size }) + ')' : '';
    if (PO.ui && PO.ui.toast) PO.ui.toast(PO.t('{who} asked you a question{lead}', { who:whoLine(it), lead }), { action:{ label:PO.t('Answer'), fn:open } });
    const q0 = it.questions[0] && it.questions[0].question;
    say(PO.t("Claude's question, {who}{lead}: {q}{more}", { who:whoLine(it), lead, q:q0 || '', more:it.questions.length > 1 ? ' ' + PO.tn(it.questions.length - 1, 'and {n} more question', 'and {n} more questions') : '' }));
  }
}

/* ---- did the answer reach Claude (the plugin's received notice) ---- */
function awaitDelivery(it) {
  const msg = PO.t('Answer received; passing it to Claude…');
  const close = PO.ui && PO.ui.toast ? PO.ui.toast(msg, { kind:'info', ms:DELIVER_MS + 2000 }) : null;
  sent.set(it.id, { t:Date.now(), close });
  say(msg);
}
function settleDelivery(id, ok, reason) {
  const s = sent.get(id);
  if (!s) return;
  sent.delete(id);
  if (s.close) s.close();
  const msg = ok ? PO.t('Your answer was delivered to Claude ✓') : reason ? PO.t('Your answer did not reach Claude; answer in the Claude window ({reason})', { reason:PO.t(reason) }) : PO.t('Your answer did not reach Claude; answer in the Claude window');
  if (PO.ui && PO.ui.toast) PO.ui.toast(msg, { kind:ok ? 'ok' : 'bad', ms:ok ? 3800 : 12000 });
  say(msg);
}
function checkDelivery(recent) {
  for (const [id, s] of [...sent]) {
    const rc = recent.get(id);
    if (rc && rc.delivered === true) settleDelivery(id, true);
    else if (rc && rc.lost) settleDelivery(id, false, rc.reason || '');
    else if (Date.now() - s.t > DELIVER_MS) settleDelivery(id, false, '');
  }
}

/* ---- polling ---- */
const CLOSED = { handoff:'The question moved to the Claude window; answer it there', expired:'The question expired; it will be asked in the Claude window', cancelled:'The question moved to the Claude window' };
// the server's reason (e.g. "The office tab stayed in the background", "The question was cancelled in Claude") is added only if it says something new
function closedText(rc) {
  if (rc.status === 'answered') return PO.t('Question answered');
  const base = PO.t(CLOSED[rc.status] || CLOSED.cancelled), why = rc.reason ? PO.t(String(rc.reason)) : '';
  return why && !base.toLowerCase().includes(why.toLowerCase()) ? base + ' (' + why + ')' : base;
}
async function poll() {
  if (busy) return;
  busy = true;
  try {
    // whether it is visible / focused is sent to the server (polling may slow down in the background: the server counts that as "open" with a wide margin).
    const r = await PO.api.asks(document.visibilityState === 'visible', document.hasFocus());
    if (!r) return;
    const liveIds = new Set();
    for (const it of r.items) {
      if (!it || typeof it.id !== 'string' || !Array.isArray(it.questions) || !it.questions.length) continue;
      liveIds.add(it.id);
      if (PO.localizeInfo) PO.localizeInfo(it);
      if (!cards.has(it.id) && !closedSeen.has(it.id)) add(it);
    }
    const recent = new Map((Array.isArray(r.recent) ? r.recent : []).filter(x => x && x.id).map(x => [x.id, x]));
    for (const [id, c] of [...cards]) {
      if (liveIds.has(id) || c.sending) continue;
      const rc = recent.get(id);
      // the card went away without the user answering here: handed over / expired / answered in Claude
      finish(id, rc && !c.mine ? closedText(rc) : '', 'info');
    }
    checkDelivery(recent);
    for (const id of [...closedSeen]) if (!recent.has(id) && !liveIds.has(id) && closedSeen.size > 50) closedSeen.delete(id);
    paint();
  } finally { busy = false; }
}
setInterval(poll, POLL_MS);
document.addEventListener('visibilitychange', () => { poll(); });   // when brought to the front the cards come immediately; when moved to the background the server should know immediately
poll();

// when the Messages window opens the card container is moved to the slot inside the conversation (host); when it closes it returns to the corner (null)
function dockIn(host) {
  ensureDock();
  if (host) { if (dock.parentNode !== host) host.appendChild(dock); dock.classList.add('inline'); }
  else { if (dock.parentNode !== document.body) document.body.appendChild(dock); dock.classList.remove('inline'); }
}
// fn(item) -> does it belong to this conversation; it does not redraw unless the key changes (the Messages window calls this every second)
function setScope(key, fn) {
  if (key === scopeKey) return;
  scopeKey = key; scope = fn || null;
  paint();
}
PO.asks = { count:() => cards.size, open, dockIn, setScope, refresh:() => { if (cards.size) paint(); } };
})(window.PO = window.PO || {});
