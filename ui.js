'use strict';
/* NorthLight Tower — shared UI helpers: face image/avatar, plain status texts, notification (toast), collapsible sections.
   Loaded after core.js. Other modules use these; there is no business logic here. */
(function (PO) {
const esc = s => PO.esc(s);

/* ---- identity: name, face, role ---- */
const CHAR_OK = /^[a-z0-9_-]{1,24}$/i;           // a character id can only be in this form (so it can be safely written into style/URL); otherwise 'robot'
// face: 'faces/<character>.png' in the theme if it exists, otherwise cyberpunk's assets/faces
PO.faceUrl = ch => {
  const c = CHAR_OK.test(ch || '') ? ch : 'robot', th = PO.TH;
  return th && th.id !== 'cyberpunk' && th.files && th.files.includes('faces/' + c + '.png') ? 'assets/themes/' + th.id + '/faces/' + c + '.png' : 'assets/faces/' + c + '.png';
};
PO.avatar = (infoOrChar, size = 28, cls = '') => {
  const ch = typeof infoOrChar === 'string' ? infoOrChar : (infoOrChar && infoOrChar.char);
  return `<span class="av ${cls}" style="--s:${size}px;background-image:url(${PO.faceUrl(ch)})" aria-hidden="true"></span>`;
};
PO.nickOf = info => (info ? (info.nick || (PO.shortLabel ? PO.shortLabel(info) : '') || info.label || '') : '');
PO.roleOf = info => (info ? (info.role || '') : '');
PO.nameLine = info => { if (!info) return ''; const k = info.kind_tr; return PO.nickOf(info) + (k && info.sub ? ' · ' + k : ''); };
PO.nowSec = () => (PO.demo ? Date.now() / 1000 : (PO.serverTime || Date.now() / 1000));

/* ---- what is it doing? (plain wording instead of the tool name) ---- */
const TOOL_TR = [
  [/^(Edit|Write|NotebookEdit)$/, 'Writing a file'], [/^(Bash|PowerShell)$/, 'Running a command'], [/^Read$/, 'Reading a file'],
  [/^(Grep|Glob)$/, 'Searching files'], [/^(WebSearch|WebFetch)$/, 'Searching the web'], [/^(Agent|Task|Workflow)$/, 'Delegating'],
  [/pixellab|image|character|animate|tile/i, 'Making images'], [/^(Skill|ToolSearch)$/, 'Getting ready'],
];
// when there is no tool info, typing / reading / thinking are all "Working" (so "Thinking / Researching" does not show in the list and contradict the summary counter); "Delegating" is only the manager's separate state
const STATE_TR = { delegating:'Delegating', waiting:'Waiting for approval', done:'Done' };
PO.friendly = info => {
  if (!info) return '';
  if (info.state === 'done') return PO.t('Done');
  if (info.state === 'waiting') return PO.t('Waiting for approval');
  const t = String(info.tool || '');
  if (info.sub && /^(Agent|Task|Workflow)$/.test(t)) return PO.t('Working');       // "Delegating" is the manager's state; a newly started worker is only working
  for (const [re, tr] of TOOL_TR) if (t && re.test(t)) return PO.t(tr);
  return PO.t(STATE_TR[info.state] || 'Working');
};
// short status summary (costs no tokens): from the information the office has. "<Name> is currently <status>. Task: <role>. Started <time> ago."
const lowerFirst = t => PO.lower(t.charAt(0)) + t.slice(1);
const clipW = (s, n) => (PO.clipWords || PO.clip)(s, n);                     // do not cut in the middle of a word in a sentence / title
const dotted = t => (/[.!?…]$/.test(t) ? t : t + '.');                       // do not add a second period to shortened or already dotted text
PO.summarize = info => {
  const n = PO.nowSec(), parts = [], who = PO.nickOf(info);
  if (info.state === 'done') parts.push(PO.t('{who} finished the job.', { who }));
  else parts.push(PO.t('{who} is currently {doing}{target}.', { who, doing:lowerFirst(PO.friendly(info)), target:info.target ? ' (' + PO.clip(info.target, 70) + ')' : '' }));          // target = file path: no word boundary, hard truncation
  if (info.role || info.task) parts.push(PO.t('Task: {task}', { task:dotted(clipW(info.role || info.task, 160)) }));
  if (info.started) parts.push(PO.t('Started {dur} ago.', { dur:PO.dur(Math.max(0, n - info.started)) }));
  const art = (info.artifacts || []).length;
  if (art) parts.push(PO.tn(art, 'Made {n} image.', 'Made {n} images.'));
  if (info.reply && info.reply.head) parts.push(PO.t('Last reply: “{text}”', { text:clipW(info.reply.head, 140) }));
  return parts.join(' ');
};

/* ---- task duration estimate: the server only gives eta {est: median s, hi: ~75th percentile s, n: sample count, t0: start} from the durations of similar jobs finished in the past.
   Here there is only display: no certainty is claimed (always "~" / "estimated"), a neutral sentence rather than an alarm when late. ---- */
PO.durApprox = s => {
  s = Math.max(0, s);
  if (s < 57.5) return PO.t('~{n} s', { n:Math.max(5, Math.round(s / 5) * 5) });
  if (s < 3600) { const m = s < 600 ? Math.max(1, Math.round(s / 60)) : Math.round(s / 300) * 5; return m >= 60 ? PO.t('~1 h') : PO.t('~{n} min', { n:m }); }
  const m = Math.round(s / 600) * 10, h = Math.floor(m / 60), r = m % 60;
  return r ? PO.t('~{h} h {m} min', { h, m:r }) : PO.t('~{h} h', { h });
};
// null: do not show (no estimate / done / waiting for approval). Otherwise { short: the dim text in the list, text: the "Estimated time left" row on the card }
PO.etaInfo = info => {
  const e = info && info.eta;
  if (!e || !(e.est > 0) || !(e.n >= 3) || !(e.t0 > 0) || info.state === 'done' || info.state === 'waiting') return null;
  const el = Math.max(0, PO.nowSec() - e.t0), rem = e.est - el, based = eta => PO.t('{eta} (based on the last {n} jobs)', { eta, n:e.n });
  if (rem >= 5) { const t = PO.durApprox(rem); return { short:t, text:based(t) }; }
  if (el <= Math.max(e.hi || 0, e.est)) return { short:PO.t('soon'), text:based(PO.t('soon')) };
  return { short:PO.t('taking long'), text:PO.t('Taking longer than expected (usually {eta})', { eta:PO.durApprox(e.est) }) };
};

// When data is insufficient (server eta_n: 0..2) a single hint line on the card; null: do not show. Absent if there is an estimate / finished / waiting for approval.
PO.etaHint = info => {
  const n = info && info.eta_n;
  if (!Number.isInteger(n) || n < 0 || n >= 3 || PO.etaInfo(info) || info.state === 'done' || info.state === 'waiting') return null;
  return { text:PO.t('collecting data ({n}/3 jobs)', { n }), tip:PO.t('The estimate comes from how long earlier jobs of the same kind took; at least 3 finished jobs are needed.') };
};

/* ---- shared user texts (so that multiple modules use the same sentence) ---- */
PO.TXT = {
  msgOff: PO.t('You can\'t send messages right now: the Pixel Office plugin is not connected to this Claude chat. If the chat was just opened, wait a few seconds.'),
  // the "What are you doing?" / "Try again" buttons fill the text box with these constants (the user presses Send). The panel and chat READ them (otherwise they carry the same text as a fallback).
  askStatus: PO.t('What are you working on right now? Explain briefly, in plain words.'),
  retry: PO.t('Your last attempt didn\'t work. Please try again and briefly explain the result.'),
  summaryTip: PO.t('Sums up right away what it is doing; does not send Claude a question.'),          // tip of the "Status summary" button (the panel and chat show the same text)
};

/* ---- notification (toast): ui.toast('Text', { action:{label, fn}, ms, kind:'ok'|'bad'|'info' }) ---- */
PO.ui = PO.ui || {};
PO.ui.toast = function (msg, opts = {}) {
  let host = document.getElementById('toasts');
  if (!host) { host = document.createElement('div'); host.id = 'toasts'; document.body.appendChild(host); }
  const t = document.createElement('div');
  t.className = 'toast ' + (opts.kind || 'info');
  const span = document.createElement('span'); span.textContent = msg; t.appendChild(span);
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 220); };
  if (opts.action) {
    const b = document.createElement('button'); b.textContent = opts.action.label;
    b.onclick = () => { try { opts.action.fn(); } finally { close(); } };
    t.appendChild(b);
  }
  host.appendChild(t);
  while (host.children.length > 4) host.firstChild.remove();
  setTimeout(close, opts.ms || (opts.action ? 9000 : 3800));
  return close;
};
// If an api result failed, it warns with a short reason; if successful, returns true. Usage: if (!PO.ui.report(await PO.api.stop(id), 'Could not stop')) return;
PO.ui.report = function (r, fallback) {
  if (r && r.ok) return true;
  PO.ui.toast(PO.t(String((r && r.reason) || fallback || 'The action could not be completed')), { kind:'bad' });          // the server's reason comes in English: PO.t (tr_server.js)
  return false;
};

/* ---- collapsible sections:
   <section class="fold" data-fold="ajanlar" [open]><button class="fold-h" type="button">Title<span class="cnt"></span></button><div class="fold-b"><div>…content…</div></div></section>
   PO.ui.initFolds(root) wires the click and remembers the open/closed state (po_folds). When refreshing the content, change only the inside of .fold-b > div. ---- */
const FKEY = 'po_folds';
let folds = {};
try { folds = JSON.parse(localStorage.getItem(FKEY) || '{}') || {}; } catch (e) { folds = {}; }
PO.ui.initFolds = function (root) {
  (root || document).querySelectorAll('.fold[data-fold]').forEach(el => {
    if (el.dataset.foldInit) return;
    el.dataset.foldInit = '1';
    const id = el.dataset.fold, head = el.querySelector(':scope > .fold-h');
    if (!head) return;
    if (id in folds) el.toggleAttribute('open', !!folds[id]);
    head.setAttribute('aria-expanded', el.hasAttribute('open') ? 'true' : 'false');
    head.addEventListener('click', () => {
      const open = !el.hasAttribute('open');
      el.toggleAttribute('open', open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      folds[id] = open; try { localStorage.setItem(FKEY, JSON.stringify(folds)); } catch (e) { /* */ }
    });
  });
};
PO.ui.foldOpen = (id, open) => {
  const el = document.querySelector(`.fold[data-fold="${id}"]`);
  if (el) { el.toggleAttribute('open', open); const h = el.querySelector(':scope > .fold-h'); if (h) h.setAttribute('aria-expanded', open ? 'true' : 'false'); }
  folds[id] = open; try { localStorage.setItem(FKEY, JSON.stringify(folds)); } catch (e) { /* */ }
};
})(window.PO = window.PO || {});
