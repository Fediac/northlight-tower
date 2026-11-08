'use strict';
/* NorthLight Tower — side panel "Team": plain summary, collapsible sections (Workers / Removed from the office / Recent activity),
   compact worker card (chat · images · history), floor and zoom buttons, image enlargement, alerts.
   Class prefix pnl-; colors only from theme.css variables (panel.css). Server actions go through PO.api.
   The card's message box accepts file attachments ("+", drag-and-drop, Ctrl+V; attachments.js PO.att, chip styles attachments.css). */
(function (PO) {
const $ = PO.$, esc = PO.esc, clip = PO.clip;
const clipS = (s, n) => (PO.clipWords || PO.clip)(s, n);   // sentence/title shortening: does not cut in the middle of a word (core.js PO.clipWords); plain clip for file names/paths
const setDis = (el, v) => { if (el && el.disabled !== v) el.disabled = v; };     // write only when it changes: no DOM mutation while idle

PO.selectedId = null; PO.hoverId = null; PO.hoverGallery = -1;
PO.serverList = []; PO.serverTime = 0; PO.demo = !!PO.demo;
PO.localMsgs = {};                                   // local system notes that land in the chat (Status summary): { agentId: [message…] }
let tab = 'chat';                                    // 'chat' | 'gal' | 'log'
try { tab = localStorage.getItem('po_tab') || 'chat'; } catch (e) { /* */ }
if (!/^(chat|gal|log)$/.test(tab)) tab = 'chat';

let root, sumEl, cardHost, listBody, goneBody, feedBody, floorsEl, listCnt, goneCnt, goneFold;
let feedFold, built = null, refs = null, sending = false;
const sigs = {};                                     // section signatures: the DOM is not touched unless the content changes
const drafts = new Map();                            // agent -> unfinished message
// message attachments (attachments.js): a list per agent; the card is rebuilt for every agent, so buildCard re-binds the items.
// Attachments (like the text) are cleared when sending SUCCEEDS; if it fails they stay in the box.
const ATT = PO.att.box({ can:() => { const i = infoById(PO.selectedId); return !!i && canMessage(i); }, onChange:() => { const i = infoById(PO.selectedId); if (i && refs) updateCard(i); } });
const infoById = id => PO.serverList.find(x => x.id === id) || null;
const nowSec = () => PO.nowSec();
const setText = (el, v) => { if (el && el._t !== v) { el._t = v; el.textContent = v; } };
const tE = (k, p) => esc(PO.t(k, p));                // translated text, escaped for an HTML attribute/content
const whyOf = r => (r && r.reason) ? PO.t(r.reason) : PO.t('unknown problem');   // the server's reason (static patterns are translated from tr_server.js)

/* ------------------------------------------------------------------ icons (currentColor) */
const SV = (inner, fill) => `<svg viewBox="0 0 16 16" width="14" height="14" ${fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'} aria-hidden="true">${inner}</svg>`;
const ICON = {
  chat:  SV('<path d="M2.5 3.5h11v7.5h-6.2L4.5 13.3V11h-2z"/>'),
  focus: SV('<circle cx="8" cy="8" r="4.2"/><path d="M8 1.5v2.6M8 11.9v2.6M1.5 8h2.6M11.9 8h2.6"/>'),
  stop:  SV('<rect x="3.5" y="3.5" width="9" height="9" rx="1.6"/>', true),
  more:  SV('<circle cx="3.5" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.5" cy="8" r="1.4"/>', true),
  send:  SV('<path d="M2 8l11-5-4 11-2-4.6z"/>'),
};

/* ------------------------------------------------------------------ simplify events (no technical tool name) */
const TOOL_PAST = [
  [/^(Edit|Write|NotebookEdit)$/, 'Wrote a file', 'file'], [/^Read$/, 'Read a file', 'file'], [/^(Grep|Glob)$/, 'Searched files', ''],
  [/^(Bash|PowerShell)$/, 'Ran a command', ''], [/^(WebSearch|WebFetch)$/, 'Searched the web', 'text'],
  [/^Workflow$/, 'Delegated a task', ''], [/^(Agent|Task)$/, 'Delegated a task', 'desc'],
  [/pixellab|image|character|animate|tile/i, 'Generated an image', ''], [/^(Skill|ToolSearch|TodoWrite|Task\w+)$/, '', ''],
];
const baseName = s => String(s).split(/[\\/]/).filter(Boolean).pop() || '';
const codeLike = t => /^[\s{(\[\/<]|^(export|const|let|var|function|import|async|return)\b|[{};=]|=>/.test(t);
function plainEvent(e) {
  let x = String(e.x || '');
  if (e.k !== 'tool') x = x.replace(/^\s*(?:ÖZET|SUMMARY)\s*:\s*/i, '');               // the raw "ÖZET:" / "SUMMARY:" label at the start of plugin replies should not show
  if (e.k === 'tool') {
    const m = /^([^\s·]+)(?:\s*·\s*(.*))?$/.exec(x), name = m ? m[1] : x, arg = m && m[2] ? m[2] : '';
    for (const [re, tr, kind] of TOOL_PAST) {
      if (!re.test(name)) continue;
      if (!tr) return '';                              // noise: do not show
      const extra = kind === 'file' && arg ? clip(baseName(arg), 28) : kind === 'text' && arg ? clipS(arg, 30) : kind === 'desc' && arg && !codeLike(arg) ? clipS(arg, 30) : '';
      return extra ? PO.t(tr) + ': ' + extra : PO.t(tr);
    }
    return '';                                         // unknown / mcp__ tools: do not show
  }
  if (e.k === 'task') return PO.t('New task: {x}', { x:clipS(x, 40) });
  if (e.k === 'done') {
    // "Alt ajan bitti: X" / "Çalışan bitirdi: X" / "Görevi bitirdi, raporu teslim etti" (sub-agent finished: X / worker finished: X / finished the task, handed in the report) -> a single plain pattern: "İşini bitirdi[: X]" (Finished its work[: X])
    const m = /^(?:Alt ajan bitti|Çalışan bitti|Çalışan bitirdi|Worker finished|Sub-?agent finished)\s*:?\s*(.*)$/i.exec(x);
    if (m) return m[1] ? PO.t('Finished the job: {x}', { x:clipS(m[1], 34) }) : PO.t('Finished the job');
    if (!x || /^(Görevi|İşini)\s+bitirdi|^(?:Finished|Completed)\b/i.test(x)) return PO.t('Finished the job');
    return clipS(PO.t(x), 40);
  }
  return clipS(x, 56);
}
// event array (oldest to newest) -> plain lines; consecutive identical lines are merged with "×n". The output is also oldest to newest: { t, x }
function plainList(events) {
  const out = [];
  (events || []).forEach(e => {
    const x = plainEvent(e); if (!x) return;
    const last = out[out.length - 1];
    if (last && last.base === x) { last.n++; last.t = e.t; last.x = x + ' ×' + last.n; }
    else out.push({ t:e.t, base:x, x, n:1, k:e.k });
  });
  return out;
}
// recent activity (oldest to newest): { t, who, x, k }. The screen strip in the world uses this too; the text is simplified, the name is the person's name
PO.latestEvents = function (n) {
  const out = [];
  PO.serverList.forEach(a => plainList((a.events || []).slice(-14)).slice(-6).forEach(e => out.push({ t:e.t, who:clip(PO.nickOf(a), 12), x:clipS(e.x, 52), k:e.k })));
  return out.sort((p, q) => q.t - p.t).slice(0, n).reverse();
};

// all images of this session (newest to oldest). Of multiple outputs of the same tool call (e.g. 4 directions or animation frames)
// only one enters the gallery: the animated one, otherwise the front-facing one
PO.computeGallery = function (infos) {
  const groups = new Map();
  infos.forEach(ag => (ag.artifacts || []).forEach(art => {
    const k = ag.id + '|' + Math.round(art.t);
    const pref = PO.isAnim(art) ? 2 : /south|front|preview|main/i.test(String(art.label) + String(art.src)) ? 1 : 0;
    const g = groups.get(k);
    if (!g || pref > g.pref) groups.set(k, { agent:ag, art, pref });
  }));
  const arr = [...groups.values()].sort((p, q) => q.art.t - p.art.t);
  arr.forEach(it => { it.key = it.agent.id + '|' + it.art.id; it.anim = PO.isAnim(it.art); });
  PO.galItems = arr;
  return arr;
};
PO.galItems = [];
PO.galleryItems = () => PO.galItems;

/* ------------------------------------------------------------------ floor and zoom buttons */
let floorSig = '';
PO.buildFloorChips = function () {
  if (!floorsEl) return;
  floorSig = '';
  floorsEl.innerHTML = PO.FL.map(fl => {
    const c = `rgb(${fl.acc.join(',')})`;
    return `<button type="button" class="pnl-fl" data-f="${fl.i}" style="--fc:${c}" data-tip="${tE('Go to this floor: {name}', { name:fl.name })}" data-tip-pos="right" aria-label="${tE('Go to the {name} floor', { name:fl.name })}"><b>${esc(fl.num)}</b><span>${esc(fl.short)}</span><i class="n" hidden></i><i class="w" hidden></i></button>`;
  }).join('');
  PO.updateFloorChips();
};
PO.updateFloorChips = function () {
  if (!floorsEl || !PO.FL) return;
  const st = PO.floorStats(), cur = PO.currentFloor();
  const sig = cur + '|' + st.map(s => s ? s.total + ':' + s.wait : '-').join(',');
  if (sig === floorSig) return;
  floorSig = sig;
  floorsEl.querySelectorAll('.pnl-fl').forEach(b => {
    const f = +b.dataset.f, s = st[f];
    if (!s) return;
    const isCur = f === cur;                           // the previous value is stored per button: only what changed is written
    if (b._cur !== isCur) { b._cur = isCur; b.classList.toggle('cur', isCur); b.setAttribute('aria-current', isCur ? 'true' : 'false'); }
    if (b._n !== s.total) { b._n = s.total; const n = b.querySelector('.n'); n.hidden = !s.total; n.textContent = s.total; }
    if (b._w !== s.wait) { b._w = s.wait; const w = b.querySelector('.w'); w.hidden = !s.wait; w.textContent = '! ' + s.wait; }
  });
};

/* ------------------------------------------------------------------ main update */
PO.panelUpdate = function (list) {
  PO.serverList = list;
  renderSum(list);
  renderList(list);
  renderGone();
  renderDetail();
  renderFeed();
};
PO.renderAll = function () { renderList(PO.serverList); renderGone(); renderDetail(); };
// when the theme changes the faces (assets/themes/<id>/faces) change: signatures are reset and the list is redrawn
PO.onTheme.push(() => { Object.keys(sigs).forEach(k => { sigs[k] = ''; }); if (PO.serverList) { try { PO.renderAll(); } catch (e) { /* first load: the panel is not built yet, it gets drawn afterwards anyway */ } } });

// one-line summary: ● n working ● n waiting for approval ● n done · 8/16 desks occupied (a counter at zero is hidden; no summary if there are no workers)
function renderSum(list) {
  const cnt = { work:0, wait:0, rest:0 };
  list.forEach(a => { if (a.state === 'done') cnt.rest++; else if (a.state === 'waiting') cnt.wait++; else cnt.work++; });
  const desks = PO.PL && PO.PL.desk ? PO.PL.desk : [], used = desks.filter(d => d.owner).length;
  const standing = [...PO.AG.values()].filter(a => !a.leaving && !a.boss && !a.desk && a.state !== 'done').length;
  const sig = [list.length, cnt.work, cnt.wait, cnt.rest, used, desks.length, standing].join(',');
  if (sig === sigs.sum) return;
  sigs.sum = sig;
  sumEl.hidden = !list.length;
  if (!list.length) { sumEl.innerHTML = ''; return; }
  sumEl.innerHTML = (cnt.work ? `<span class="pnl-sc" title="${tE('Working')}"><i data-st="typing"></i>${tE('{n} working', { n:cnt.work })}</span>` : '')
    + (cnt.wait ? `<span class="pnl-sc" title="${tE('Waiting for approval')}"><i data-st="waiting"></i>${tE('{n} waiting for approval', { n:cnt.wait })}</span>` : '')
    + (cnt.rest ? `<span class="pnl-sc" title="${tE('Done')}"><i data-st="done"></i>${tE('{n} done', { n:cnt.rest })}</span>` : '')
    + (desks.length ? `<span class="pnl-sc pnl-sc-desk" title="${tE('Desks on the code and design floors')}">${tE('{used}/{total} desks taken', { used, total:desks.length })}</span>` : '')
    + (standing ? `<span class="pnl-sc pnl-sc-warn" title="${tE('Desks are full: these workers are waiting standing in the lobby')}">${tE('{n} waiting in the lobby', { n:standing })}</span>` : '');
}
// status word: the same vocabulary everywhere (Working / Waiting for approval / Done); what it is doing while working is told by PO.friendly
const stWord = a => a.state === 'done' ? PO.t('Done') : a.state === 'waiting' ? PO.t('Waiting for approval') : PO.friendly(a);

/* ------------------------------------------------------------------ workers list */
function keepFocus(container, fn) {
  const ae = document.activeElement, id = ae && container.contains(ae) ? (ae.dataset.id || '') + '|' + (ae.dataset.act || '') : null;
  fn();
  if (id) {
    const [i, a] = id.split('|');
    const el = [...container.querySelectorAll('[data-id]')].find(x => x.dataset.id === i && (x.dataset.act || '') === a);
    if (el) el.focus({ preventScroll:true });
  }
}
const roleLine = a => (a.sub ? PO.t(a.role || clipS(a.task || '', 60)) : (a.label || ''));

function renderList(list) {
  const rows = list.slice().sort((p, q) => ((p.sub ? 1 : 0) - (q.sub ? 1 : 0)) || ((p.started || 0) - (q.started || 0)));      // manager on top
  const sig = rows.map(a => { const ag = PO.AG.get(a.id); return [a.id, a.state, stWord(a), PO.nickOf(a), roleLine(a), a.char, a.sub ? 1 : 0, ag && ag.f === PO.lobbyIdx ? 1 : 0].join('~'); }).join('|');
  setText(listCnt, rows.length ? String(rows.length) : '');
  if (feedFold && feedFold.hidden !== !rows.length) feedFold.hidden = !rows.length;       // "Recent activity" is hidden in an empty office
  if (sig === sigs.list) { markSel(); paintEta(); return; }
  sigs.list = sig;
  keepFocus(listBody, () => {
    if (!rows.length) { listBody.innerHTML = '<div class="pnl-empty">' + PO.t('No workers yet. When you give Claude a task (Code tab), they show up here.') + '</div>'; return; }
    listBody.innerHTML = '<div class="pnl-rows">' + rows.map(a => {
      const ag = PO.AG.get(a.id), boss = !a.sub;
      const nick = PO.nickOf(a), fr = stWord(a);
      const tag = boss ? (/^m[üu]d[üu]r|^m[üu]dire|^manager/i.test(nick) ? '' : '<span class="pnl-tg boss">' + PO.t('manager') + '</span>') : (ag && ag.f === PO.lobbyIdx && a.state === 'done' ? '<span class="pnl-tg">' + PO.t('in the lobby') + '</span>' : '');
      return `<button type="button" class="pnl-row${boss ? ' pnl-boss' : ''}" data-id="${esc(a.id)}" data-st="${esc(a.state)}" aria-label="${esc(nick + ', ' + fr)}">`
        + `<span class="pnl-avw">${PO.avatar(a, 32)}<i class="pnl-dot" data-st="${esc(a.state)}"></i></span>`
        + `<span class="pnl-rt"><span class="pnl-l1"><b>${esc(nick)}</b>${tag}<span class="pnl-fr">${esc(fr)}</span><span class="pnl-eta" data-r="eta"></span></span>`
        + `<span class="pnl-l2">${esc(roleLine(a) || ' ')}</span></span></button>`;
    }).join('') + '</div>';
  });
  markSel();
  paintEta();
}
// the dim "~2 min" in the row: not part of the signature (it changes over time), only the text is updated in place; the list is not rebuilt
function paintEta() {
  if (!listBody) return;
  listBody.querySelectorAll('.pnl-row[data-id]').forEach(r => {
    const e = r.querySelector('.pnl-eta'); if (!e) return;
    const t = PO.etaInfo(infoById(r.dataset.id));
    setText(e, t ? t.short : '');
  });
}
function markSel() {
  if (!listBody) return;
  listBody.querySelectorAll('.pnl-row').forEach(r => { const on = r.dataset.id === PO.selectedId; if (r.classList.contains('sel') !== on) r.classList.toggle('sel', on); });
}

/* ------------------------------------------------------------------ removed from the office */
let goneN = null, goneAutoDone = false;
function renderGone() {
  const g = (PO.gone || []).filter(x => !PO.activeSid || !x.session || x.session === PO.activeSid).slice().sort((p, q) => (q.at || 0) - (p.at || 0));
  if (goneFold.hidden !== !g.length) goneFold.hidden = !g.length;
  setText(goneCnt, g.length ? String(g.length) : '');
  // first time 0 -> 1: the section opens by itself once so the way to undo is visible (not when the page first opens)
  if (goneN !== null && goneN === 0 && g.length === 1 && !goneAutoDone) {
    goneAutoDone = true;
    try { if (!localStorage.getItem('po_gone_auto')) { localStorage.setItem('po_gone_auto', '1'); PO.ui.foldOpen('pnl-gone', true); } } catch (e) { PO.ui.foldOpen('pnl-gone', true); }
  }
  goneN = g.length;
  const sig = g.map(x => [x.id, x.nick, x.char, x.role, x.label].join('~')).join('|');
  if (sig === sigs.gone) return;
  sigs.gone = sig;
  keepFocus(goneBody, () => {
    goneBody.innerHTML = g.length ? '<div class="pnl-rows">' + g.map(x => {
      const nick = x.nick || PO.shortLabel(x) || x.label || '';
      return `<div class="pnl-row pnl-grow">${PO.avatar(x, 28)}<span class="pnl-rt"><span class="pnl-l1"><b>${esc(nick)}</b></span><span class="pnl-l2">${esc((x.sub ? x.role : x.label) || ' ')}</span></span>`
        + `<button type="button" class="pnl-btn pnl-restore" data-act="restore" data-id="${esc(x.id)}" data-tip="${tE('Brings the worker back to the tower.')}" data-tip-pos="left">${tE('Restore')}</button></div>`;
    }).join('') + '</div>' : '';
  });
}
async function restore(id, nick) {
  const r = await PO.api.restore(id);
  if (r && r.ok) PO.ui.toast(PO.t('{name} restored', { name:nick || PO.t('Worker') }), { kind:'ok', ms:2600 });
  else PO.ui.toast(PO.t('Could not restore: {reason}', { reason:whyOf(r) }), { kind:'bad' });
}
async function dismiss(info) {
  const id = info.id, nick = PO.nickOf(info) || PO.t('Worker');
  const r = await PO.api.dismiss(id);
  if (!r || !r.ok) { PO.ui.toast(PO.t('Could not remove from the office: {reason}', { reason:whyOf(r) }), { kind:'bad' }); return; }
  if (PO.selectedId === id) PO.select(null);
  PO.ui.toast(PO.t('{name} removed from the office', { name:nick }), { action:{ label:PO.t('Undo'), fn:() => restore(id, nick) }, ms:12000 });
}

/* ------------------------------------------------------------------ recent activity */
function renderFeed() {
  const fe = PO.latestEvents(14).reverse();
  if (!PO.serverList.length) return;                   // section hidden in an empty office (renderList)
  const sig = fe.map(e => e.t + e.who + e.x).join('|');
  if (sig === sigs.feed) return;
  sigs.feed = sig;
  feedBody.innerHTML = fe.length ? '<div class="pnl-evs">' + fe.map(e => `<div class="pnl-ev"><time>${PO.fmtHM(e.t)}</time><span><b>${esc(e.who)}</b> ${esc(e.x)}</span></div>`).join('') + '</div>' : '<div class="pnl-empty">' + PO.t('No activity yet.') + '</div>';
}

/* ------------------------------------------------------------------ worker card */
function renderDetail() {
  const info = infoById(PO.selectedId);
  if (!info) {
    if (built !== null || cardHost.firstChild) { cardHost.innerHTML = ''; built = null; refs = null; }
    return;
  }
  if (built !== info.id) buildCard(info);
  updateCard(info);
}
const ABTN = (act, icon, label, tip, pos, cls = '') => `<button type="button" class="pnl-btn pnl-ab${cls}" data-act="${act}" data-tip="${esc(tip)}" data-tip-pos="${pos}">${icon}<span>${label}</span></button>`;
function buildCard(info) {
  built = info.id;
  sigs.chat = sigs.gal = sigs.log = sigs.kv = sigs.head = null;
  cardHost.innerHTML = `<div class="pnl-card" data-st="${esc(info.state)}">
    <div class="pnl-ch">
      ${PO.avatar(info, 40)}
      <div class="pnl-ci">
        <div class="pnl-cn"><b data-r="nick"></b><small data-r="kind"></small><span class="pnl-chip" data-r="chip"><i class="pnl-dot" data-r="cdot"></i><span data-r="cst"></span></span></div>
        <div class="pnl-cr" data-r="role"></div>
      </div>
      <button type="button" class="pnl-x" data-act="close" aria-label="${tE('Close card')}" data-tip="${tE('Close card')}" data-tip-pos="left">×</button>
    </div>
    <div class="pnl-acts">
      ${ABTN('chat', ICON.chat, tE('Enlarge'), PO.t('Open the messages on a wide screen'), 'bottom-start')}
      ${ABTN('focus', ICON.focus, tE('Bring camera'), PO.t('Moves the camera next to this worker.'), 'bottom')}
      ${ABTN('stop', ICON.stop, tE('Stop'), PO.t("Stops the worker's current job."), 'bottom-end', ' pnl-danger')}
      <button type="button" class="pnl-btn pnl-ab pnl-ab-more" data-act="more" aria-haspopup="menu" aria-expanded="false" aria-label="${tE('More actions')}" data-tip="${tE('More actions')}" data-tip-pos="bottom-end">${ICON.more}</button>
      <div class="pnl-menu" role="menu" hidden>
        <button type="button" role="menuitem" data-act="sum" data-tip="${tE("Instantly summarizes what it is doing right now; sends no question to Claude.")}" data-tip-pos="end">${tE('Status summary')}</button>
        <button type="button" role="menuitem" data-act="rev" data-tip="${tE('Opens the box so you can write your revision request.')}" data-tip-pos="end">${tE('Revise…')}</button>
        <button type="button" role="menuitem" data-act="retry" data-tip="${tE('Fills the message box with a ready-made text; you press Send.')}" data-tip-pos="end">${tE('Try again')}</button>
        <button type="button" role="menuitem" data-act="dismiss" class="pnl-mdanger" data-tip="${tE("Hides the worker from the tower; it is not deleted. You can bring it back from 'Removed from the office'.")}" data-tip-pos="end">${tE('Remove from the office')}</button>
      </div>
    </div>
    <div class="pnl-tabs" role="tablist">
      <button type="button" role="tab" data-tab="chat">${tE('Messages')}</button><button type="button" role="tab" data-tab="gal">${tE('Images')}<span class="n" data-r="galn"></span></button><button type="button" role="tab" data-tab="log">${tE('History')}</button>
    </div>
    <div class="pnl-pane" data-tc="chat">
      <div class="pnl-msgs" data-r="msgs"></div>
      <ul class="att-list pnl-atts" data-r="atts" hidden></ul>
      <div class="pnl-compose"><button type="button" class="att-add pnl-attb" data-r="attb" aria-label="${tE('Add file')}" data-tip="${tE('Add a file (drag and drop or Ctrl+V also works)')}" data-tip-pos="start">+</button><input type="file" data-r="file" multiple hidden tabindex="-1" aria-hidden="true"><textarea data-r="ta" rows="1" maxlength="2000" aria-label="${tE('Write a message')}"></textarea><button type="button" class="pnl-btn pnl-send" data-act="send" aria-label="${tE('Send')}">${ICON.send}<span>${tE('Send')}</span></button></div>
      <div class="pnl-note" data-r="hint" hidden></div>
    </div>
    <div class="pnl-pane" data-tc="gal" hidden><div class="pnl-grid" data-r="grid"></div></div>
    <div class="pnl-pane" data-tc="log" hidden><div class="pnl-evs" data-r="log"></div></div>
    <section class="fold pnl-fold pnl-detay" data-fold="pnl-detay" open><button class="fold-h" type="button">${tE('Details')}</button><div class="fold-b"><div><div class="pnl-kv" data-r="kv"></div></div></div></section>
  </div>`;
  refs = {};
  cardHost.querySelectorAll('[data-r]').forEach(el => { refs[el.dataset.r] = el; });
  refs.menu = cardHost.querySelector('.pnl-menu');
  PO.ui.initFolds(cardHost);
  setTab(tab);
  const ta = refs.ta, id = info.id;
  if (drafts.has(id)) { ta.value = drafts.get(id); grow(ta); }
  ta.addEventListener('input', () => { if (ta.value) drafts.set(id, ta.value); else drafts.delete(id); grow(ta); });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); } });
  ATT.mount({ list:refs.atts, add:refs.attb, input:refs.file, zone:cardHost.querySelector('.pnl-pane[data-tc="chat"]'), ta });
  ATT.use(id);
}
function grow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 96) + 'px'; }
function setTab(t) {
  tab = t; try { localStorage.setItem('po_tab', t); } catch (e) { /* */ }
  if (!cardHost) return;
  cardHost.querySelectorAll('[data-tab]').forEach(b => { const on = b.dataset.tab === t; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  cardHost.querySelectorAll('[data-tc]').forEach(p => { p.hidden = p.dataset.tc !== t; });
  if (t === 'chat' && refs && refs.msgs) refs.msgs.scrollTop = refs.msgs.scrollHeight;
}
PO.setTab = t => { if (refs) setTab(t); else tab = t; };

/* local system note (costs no tokens); the chat module can merge it with PO.localMsgs[id] */
PO.addLocalNote = function (id, text) {
  (PO.localMsgs[id] = PO.localMsgs[id] || []).push({ id:'l' + Date.now() + Math.random().toString(36).slice(2, 6), t:Date.now() / 1000, who:'ofis', text, st:'', local:true });
  sigs.chat = null;
};
const chatItems = info => (info.chat || []).concat(PO.localMsgs[info.id] || []).sort((a, b) => a.t - b.t);
const isLong = t => String(t).length > 240 || (String(t).match(/\n/g) || []).length >= 4;
function msgHTML(m, info) {
  if (m.who === 'ofis') {
    // failed stop: the server appends the reason to the end of the text; show one clear sentence instead of the raw (!) marker
    const MARK = '\n(!) ', k = String(m.text).indexOf(MARK);
    if (m.st === 'hata' && k >= 0) {
      const why = PO.t(String(m.text).slice(k + MARK.length)).replace(/^(?:Durdurulamadı|Could not stop|Couldn't stop|Stop failed)\s*:\s*/i, '').replace(/[.\s]+$/, '');
      return `<div class="pnl-msg sys err"><div class="b">${esc(PO.t('Could not stop: {why}.', { why }))}</div><small>${tE('Office')}</small></div>`;
    }
    return `<div class="pnl-msg sys"><div class="b">${esc(m.local ? m.text : PO.t(m.text))}</div><small>${m.local ? tE('Automatic summary') : tE('Office')}</small></div>`;
  }
  if (m.who === 'ajan') {
    const long = isLong(m.text);
    return `<div class="pnl-msg ag"><div class="b"><div class="pnl-md${long ? ' pnl-clamp' : ''}">${PO.md.render(m.text)}</div></div>${long ? `<button type="button" class="pnl-link" data-act="readmore" data-mid="${esc(m.id)}">${tE('Read more')}</button>` : ''}<small>${PO.fmtHM(m.t)} · ${esc(clip(PO.nickOf(info), 24))}</small></div>`;
  }
  const MARK = '\n(!) ';
  let why = '', text = m.text;
  if (m.st === 'hata' && text.includes(MARK)) {            // the server appends the error reason to the end of the text
    const i = text.indexOf(MARK); why = text.slice(i + MARK.length); text = text.slice(0, i);
    if (/classifier|verdict|auto mode/i.test(why)) why = PO.t("Claude's automatic permission check blocked sending"); else why = PO.t(why);
  }
  const stale = m.st === 'bekliyor' && nowSec() - m.t > 25;
  const meta = PO.fmtHM(m.t) + ' · ' + (m.st === 'iletildi' ? tE('✓ delivered') : m.st === 'hata' ? (why ? PO.t('! not delivered: {why}', { why:esc(why) }) : tE('! not delivered')) : stale ? tE('… still waiting (Claude has not received it yet)') : tE('… waiting'));
  const pa = PO.att.split(text, m.atts);                   // attachments (the server's atts field) as chips in the bubble
  return `<div class="pnl-msg me st-${esc(m.st)}"><div class="b">${pa.text ? esc(pa.text) : ''}${PO.att.msgHTML(pa.atts)}</div><small>${meta}</small></div>`;
}

const RETRY_TXT = () => PO.t("Your last attempt didn't work. Please try again and briefly describe the result.");
const FLOOR_TXT = ag => { const f = ag ? PO.FL[ag.ride ? ag.ride.f : ag.f] : null; return f ? PO.t('{name} floor', { name:f.name }) : '—'; };
const MSG_OFF = () => (PO.TXT && PO.TXT.msgOff) || PO.t("You can't send messages right now: the NorthLight Tower add-on isn't connected to this Claude chat. If the chat was just opened, wait a few seconds.");
// "Hayalet'e yaz…" (Turkish): dative suffix (e/a by the last vowel, ye/ya if it ends in a vowel); generic text if unsure. English: "Write to Ghost…"
function writeTo(info) {
  const nick = String(PO.nickOf(info) || '').trim();
  const generic = PO.t(info.sub ? 'Write to this worker…' : 'Write to the main worker…');       // main worker: Müdür or Müdire (manager, male or female form); generic text if the name is unknown
  if (!/^[A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,14}$/.test(nick)) return generic;
  if (PO.lang !== 'tr') return PO.t('Write to {name}…', { name:nick });
  const low = PO.lower(nick), v = low.match(/[aeıioöuüâîû]/g);
  if (!v) return generic;
  const lastV = v[v.length - 1], back = /[aıouâû]/.test(lastV), endsV = /[aeıioöuüâîû]$/.test(low);
  return PO.t('Write to {name}…', { name:nick + "'" + (endsV ? 'y' : '') + (back ? 'a' : 'e') });
}

function updateCard(info) {
  const n = nowSec(), ag = PO.AG.get(info.id), can = canMessage(info);
  const nick = PO.nickOf(info), fr = stWord(info);
  // top section (the state is in the signature: so the menu items do not go stale when the message link changes)
  const hsig = [nick, info.kind_tr, fr, info.state, roleLine(info), info.sub ? 1 : 0, can ? 1 : 0].join('~');
  if (hsig !== sigs.head) {
    sigs.head = hsig;
    refs.nick.textContent = nick; refs.kind.textContent = info.sub && info.kind_tr ? PO.t(info.kind_tr) : '';
    refs.cst.textContent = fr; refs.cdot.dataset.st = info.state; cardHost.firstChild.dataset.st = info.state;
    refs.role.textContent = roleLine(info); refs.role.title = roleLine(info);
    cardHost.querySelector('[data-act="stop"]').hidden = info.state === 'done';
    cardHost.querySelector('[data-act="dismiss"]').hidden = !info.sub;
    const rt = cardHost.querySelector('[data-act="retry"]');
    rt.hidden = info.state !== 'done'; setDis(rt, !can);
    setDis(cardHost.querySelector('[data-act="rev"]'), !can);
  }
  // details (open by default, po_folds remembers it if the user closes it; refreshed every 5 s): only Right now / Task / Where / Running for
  const ksig = [info.state, info.detail, info.tool, info.target, info.task, info.started, Math.floor(n / 5), ag && ag.f, info.eta ? info.eta.est + ':' + info.eta.n : '', info.eta_n].join('|');
  if (ksig !== sigs.kv) {
    sigs.kv = ksig;
    // while working the same word as in the list (PO.friendly); for finished / waiting for approval, the server's sentence with extra info
    const nowTxt = (info.state === 'done' || info.state === 'waiting') ? (info.detail ? PO.t(info.detail) : PO.friendly(info)) : PO.friendly(info);
    const eta = PO.etaInfo(info), hint = eta ? null : PO.etaHint(info);
    refs.kv.innerHTML = `<span>${tE('Right now')}</span><span>${esc(nowTxt || '—')}${info.target ? '<br><code>' + esc(clip(info.target, 100)) + '</code>' : ''}</span>`
      + (eta ? `<span>${tE('Estimated time left')}</span><span>${esc(eta.text)}</span>` : hint ? `<span>${tE('Estimated time left')}</span><span class="pnl-hint" title="${esc(hint.tip)}">${esc(hint.text)}</span>` : '')
      + `<span>${tE('Task')}</span><span>${esc(clipS(PO.t(info.task || info.role || '—'), 200))}</span>`
      + `<span>${tE('Where')}</span><span>${esc(FLOOR_TXT(ag))}</span>`
      + `<span>${tE('Running for')}</span><span>${info.started ? esc(PO.dur(Math.max(0, n - info.started))) : '—'}</span>`;
  }
  // chat: the latest 5 messages
  const items = chatItems(info).slice(-5);
  const csig = (can ? 'c:' : 'x:') + items.map(m => m.id + m.st + m.text.length + (m.local ? 'l' : '')).join(',') + (items.some(m => m.who === 'ben' && m.st === 'bekliyor') ? '|' + Math.floor(n / 10) : '');
  if (csig !== sigs.chat) {
    sigs.chat = csig;
    const near = refs.msgs.scrollHeight - refs.msgs.scrollTop - refs.msgs.clientHeight < 40;
    refs.msgs.innerHTML = items.length ? items.map(m => msgHTML(m, info)).join('') : can ? '<div class="pnl-empty">' + PO.t('No messages yet. Write below; the worker will read it at the next opportunity.') + '</div>' : '';   // when messaging is off only the reason (below) is shown
    if (near) refs.msgs.scrollTop = refs.msgs.scrollHeight;
  }
  setDis(refs.ta, !can && document.activeElement !== refs.ta);      // the box should not lock even if the connection drops while typing
  const sb = cardHost.querySelector('[data-act="send"]'); setDis(sb, !can || sending || !ATT.ready());   // disabled while an attachment is uploading / while there is a faulty chip
  ATT.paint();
  const ph = can ? writeTo(info) : PO.t('Messages cannot be sent right now');
  if (refs.ta.placeholder !== ph) refs.ta.placeholder = ph;
  const why = can ? '' : (String(info.id).startsWith('spawn-') ? PO.t('The worker is just starting; you can write in a moment.') : MSG_OFF());
  if (refs.hint._t !== why) { refs.hint._t = why; refs.hint.textContent = why; refs.hint.hidden = !why; }
  // images
  const arts = (info.artifacts || []).slice().sort((a, b) => b.t - a.t);
  const gsig = arts.map(a => a.id + a.src).join(',');
  setText(refs.galn, arts.length ? ' ' + arts.length : '');
  if (gsig !== sigs.gal) {
    sigs.gal = gsig;
    refs.grid.innerHTML = arts.length ? arts.map(a => `<button type="button" class="pnl-th" data-art="${esc(a.id)}" title="${esc(a.label)}">${a.kind === 'vid' ? '<span class="pnl-vid">▶</span>' : `<img src="${esc(a.src)}" alt="" loading="lazy">`}<span>${esc(a.label)}</span></button>`).join('')
      : '<div class="pnl-empty pnl-span">' + PO.t("This worker hasn't generated any images yet. What it makes shows up here and in the gallery.") + '</div>';
  }
  // history
  const ev = plainList(info.events).reverse();
  const lsig = ev.map(e => e.t + e.x).join('|');
  if (lsig !== sigs.log) {
    sigs.log = lsig;
    refs.log.innerHTML = ev.length ? ev.map(e => `<div class="pnl-ev"><time>${PO.fmtHM(e.t)}</time><span>${esc(e.x)}</span></div>`).join('') : '<div class="pnl-empty">' + PO.t('No recorded activity.') + '</div>';
  }
}
function canMessage(info) { return !!info.can_message || (PO.demo && !String(info.id).startsWith('spawn-')); }

/* ------------------------------------------------------------------ actions */
async function doSend(text) {
  const info = infoById(PO.selectedId); if (!info || !refs || sending) return;
  const id = info.id, mine = refs, tx = String(text != null ? text : mine.ta.value).trim();
  // attachments go only when sent from the box; they STAY in the box and are cleared on success (like the text)
  if (text == null && !ATT.ready()) { PO.ui.toast(ATT.busy() ? PO.t('Attachments are still uploading; send in a moment.') : PO.t('Remove the attachment that failed to upload (×), then send.'), { kind:'bad' }); return; }
  const atts = text == null ? ATT.items() : [];
  if (!tx && !atts.length) return;
  sending = true; updateCard(info);
  const r = await PO.api.send(id, tx, atts);
  sending = false;
  if (r && r.ok) {
    if (text == null) ATT.drop(id, atts);
    if (text == null) {                                      // only the SENT text is deleted: what was typed while sending is kept
      const ta = built === id && refs ? refs.ta : null, v = ta ? ta.value : (drafts.get(id) || '');
      const lead = v.replace(/^\s+/, ''), rest = v.trim() === tx ? '' : lead.startsWith(tx) ? lead.slice(tx.length).replace(/^\s+/, '') : v;
      if (rest) drafts.set(id, rest); else drafts.delete(id);
      if (ta && rest !== v) { ta.value = rest; grow(ta); }
    }
    sigs.chat = null;
    if (text != null) PO.ui.toast(PO.t('Your message is being delivered'), { kind:'ok', ms:2200 });
  } else {
    if (r && r.missing && text == null) ATT.fail(id, r.missing, r.reason);   // an attachment chip that cannot be found becomes "faulty" (removed with ×)
    PO.ui.toast(PO.t('Message could not be sent: {reason}', { reason:whyOf(r) }), { kind:'bad' });   // the text you typed stays in the box
  }
  const cur = infoById(PO.selectedId); if (cur && refs) updateCard(cur);
}
function setMenu(open) {
  if (!refs || !refs.menu) return;
  refs.menu.hidden = !open;
  const b = cardHost.querySelector('[data-act="more"]'); if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
}
const menuOpen = () => !!(refs && refs.menu && !refs.menu.hidden);
function focusCompose(prefix) {
  setTab('chat');
  if (!refs) return;
  refs.ta.value = prefix; refs.ta.focus(); refs.ta.setSelectionRange(prefix.length, prefix.length);
  drafts.set(built, prefix); grow(refs.ta);
}
function onCardClick(e) {
  const t = e.target.closest('button'); if (!t || !refs) return;
  const info = infoById(PO.selectedId); if (!info) return;
  if (t.dataset.tab) { setTab(t.dataset.tab); return; }
  if (t.dataset.art) { PO.openLightbox(info.id, t.dataset.art); return; }
  const act = t.dataset.act; if (!act) return;
  if (act !== 'more') setMenu(false);
  switch (act) {
    case 'close': PO.select(null); break;
    case 'more': setMenu(!menuOpen()); break;
    case 'chat': PO.chat.open(info.id); break;
    case 'readmore': PO.chat.open(info.id, t.dataset.mid ? { expand:t.dataset.mid } : undefined); break;     // the chat owner supports the expand option; if it does not, it only opens
    case 'focus': { const a = PO.AG.get(info.id); if (a) PO.focusAgent(a); break; }
    case 'stop': {
      const lbl = t.querySelector('span');
      if (!info.sub && t.dataset.armed !== '1') {      // stopping the manager takes two steps: the first click only arms it, it goes back after 4 s
        t.dataset.armed = '1'; if (lbl) lbl.textContent = PO.t('Are you sure?');      // short label + icon hidden (css .pnl-ab[data-armed]): the button width and card height do not change
        clearTimeout(t._tm); t._tm = setTimeout(() => { delete t.dataset.armed; if (lbl) lbl.textContent = PO.t('Stop'); }, 4000);
        break;
      }
      clearTimeout(t._tm); delete t.dataset.armed; if (lbl) lbl.textContent = PO.t('Stop');
      PO.api.stop(info.id).then(r => {
        if (r && r.ok) { PO.ui.toast(PO.t('Stop request sent'), { kind:'ok', ms:2800 }); PO.renderAll(); }
        else PO.ui.toast(PO.t('Could not stop: {reason}', { reason:whyOf(r) }), { kind:'bad' });
      });
      break;
    }
    case 'send': doSend(); break;
    case 'sum': PO.addLocalNote(info.id, PO.summarize(info)); setTab('chat'); renderDetail(); break;
    case 'retry': focusCompose((PO.TXT && PO.TXT.retry) || RETRY_TXT()); break;       // does not send a message: fills the box, the user presses Send
    case 'rev': focusCompose(PO.t('Revise the following: ')); break;
    case 'dismiss': dismiss(info); break;
    default: break;
  }
}

/* ------------------------------------------------------------------ image enlargement (image, GIF and video) */
let lb = { list:[], i:0 };
const lbEl = () => $('#lb');
PO.lightboxOpen = () => { const el = lbEl(); return !!el && !el.hidden; };
// click on the gallery (wall / podium / frame): you browse among all images of this session
PO.openGallery = function (it) {
  const list = (PO.galItems || []).map(x => ({ agent:x.agent, art:x.art }));
  let i = list.findIndex(x => x.art.id === it.art.id && x.agent.id === it.agent.id);
  if (i < 0) { list.unshift({ agent:it.agent, art:it.art }); i = 0; }
  lb = { list, i };
  paintLightbox();
  lbEl().hidden = false;
};
// from the small thumbnails on the agent card: only that agent's images
PO.openLightbox = function (agentId, artId) {
  const info = infoById(agentId); if (!info) return;
  const arts = (info.artifacts || []).slice().sort((a, b) => b.t - a.t);
  if (!arts.length) return;
  lb = { list:arts.map(art => ({ agent:info, art })), i:Math.max(0, arts.findIndex(a => a.id === artId)) };
  paintLightbox();
  lbEl().hidden = false;
};
function paintLightbox() {
  const cur = lb.list[lb.i];
  if (!cur) return;
  const a = cur.art, info = cur.agent, isVid = a.kind === 'vid';
  const img = $('#lbimg'), vid = $('#lbvid');
  img.hidden = isVid; vid.hidden = !isVid;
  img.classList.remove('smooth');
  img.style.width = img.style.height = ''; img.style.maxWidth = img.style.maxHeight = '';
  if (isVid) {
    img.removeAttribute('src');
    vid.src = a.src; vid.play().catch(() => {});
  } else {
    vid.pause(); vid.removeAttribute('src'); vid.load();
    img.onload = () => {
      const nw = img.naturalWidth, nh = img.naturalHeight;
      const maxW = Math.min(innerWidth * 0.9, 1060) - 40, maxH = innerHeight * 0.94 - 160;
      if (nw && nw <= 520 && nh <= 520) {        // small pixel art: enlarge by an integer multiple so it stays sharp
        const k = Math.max(1, Math.floor(Math.min(maxW / nw, maxH / nh)));
        img.style.maxWidth = img.style.maxHeight = 'none'; img.style.width = (nw * k) + 'px'; img.style.height = (nh * k) + 'px';
      } else img.classList.add('smooth');
    };
    img.src = a.src;                              // the GIF plays by itself here
  }
  $('#lbtitle').textContent = (a.label || PO.t('Image')) + (PO.isAnim(a) ? '  ·  ' + (isVid ? PO.t('video') : PO.t('animated')) : '');
  $('#lbmeta').textContent = `${info ? PO.nickOf(info) : ''} · ${PO.fmtT(a.t)}`;
  $('#lbpos').textContent = (lb.i + 1) + ' / ' + lb.list.length;
  $('#lbprev').disabled = lb.i <= 0; $('#lbnext').disabled = lb.i >= lb.list.length - 1;
}
function closeLightbox() {
  lbEl().hidden = true; $('#lbimg').removeAttribute('src');
  const v = $('#lbvid'); v.pause(); v.removeAttribute('src'); v.load();
}
function initLightbox() {
  if (!lbEl()) return;
  $('#lbx').onclick = closeLightbox;
  lbEl().addEventListener('click', e => { if (e.target === lbEl()) closeLightbox(); });
  $('#lbprev').onclick = () => { if (lb.i > 0) { lb.i--; paintLightbox(); } };
  $('#lbnext').onclick = () => { if (lb.i < lb.list.length - 1) { lb.i++; paintLightbox(); } };
  $('#lbopen').onclick = () => { const c = lb.list[lb.i]; if (c) window.open(c.art.src, '_blank', 'noopener'); };
  $('#lbrev').onclick = () => {
    const c = lb.list[lb.i]; closeLightbox();
    if (!c) return;
    PO.select(c.agent.id, true);
    focusCompose(PO.t('Revise the image “{label}”: ', { label:c.art.label }));
  };
  addEventListener('keydown', e => {
    if (lbEl().hidden) return;
    if (e.key === 'Escape') { closeLightbox(); e.stopPropagation(); }
    else if (e.key === 'ArrowLeft') $('#lbprev').click();
    else if (e.key === 'ArrowRight') $('#lbnext').click();
  }, true);
}

/* ------------------------------------------------------------------ selection */
PO.select = function (id, focus = true) {
  const same = id === PO.selectedId;
  PO.selectedId = id;
  setMenu(false);
  renderDetail();
  markSel();
  if (id && focus && !same) { const a = PO.AG.get(id); if (a) PO.focusAgent(a); }
  const side = $('#side'); if (side && id) side.scrollTop = 0;
};

/* ------------------------------------------------------------------ alert + sound */
let audio = null, flashTimer = null;
const prevState = new Map();
PO.baseTitle = document.title;
// the single rule for the tab title (the panel.js flashing, session.js and questions.js read it from the same place): "(?) " prefix if there is a pending question
PO.titleFor = () => (PO.asks && PO.asks.count() ? '(?) ' : '') + PO.baseTitle;
// audio context: the browser creates it suspended without user interaction. It is NOT created right on the first click/key (creating it causes a ~100 ms stall):
// if the sound setting is on it is prepared after the first interaction when idle (delayed); if off it is never created, and is created when a beep is needed (if on).
function audioCtx() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume().catch(() => {});
  } catch (e) { audio = null; }
  return audio;
}
function warmAudio() {
  if (audio || !PO.settings || !PO.settings.get('sound')) return;
  const go = () => { if (!audio && PO.settings.get('sound')) audioCtx(); };
  setTimeout(() => { if (window.requestIdleCallback) requestIdleCallback(go, { timeout:3000 }); else go(); }, 1500);
}
['pointerdown', 'keydown'].forEach(ev => addEventListener(ev, warmAudio, { once:true, capture:true }));
function beep() {
  if (!PO.settings.get('sound')) return;
  try {
    const ac = audioCtx(); if (!ac) return;
    const play = () => {
      const t0 = ac.currentTime;
      [[880, 0], [660, 0.16], [880, 0.32]].forEach(([f, dl]) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = 'square'; o.frequency.value = f; o.connect(g); g.connect(ac.destination);
        g.gain.setValueAtTime(0.0001, t0 + dl); g.gain.exponentialRampToValueAtTime(0.08, t0 + dl + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dl + 0.13);
        o.start(t0 + dl); o.stop(t0 + dl + 0.15);
      });
    };
    if (ac.state === 'running') play();
    else {                                             // suspended: if it resumes, play right away; if there is no interaction, stay silent (so a stale beep does not play later)
      let late = false; const tm = setTimeout(() => { late = true; }, 400);
      ac.resume().then(() => { clearTimeout(tm); if (!late && ac.state === 'running') play(); }).catch(() => {});
    }
  } catch (e) { /* no sound */ }
}
PO.beep = beep;
// workers of all sessions (buildings): if one is waiting for approval, a beep plus the tab title flashes
PO.checkAlerts = function (list) {
  let n = 0;
  const first = prevState.size === 0;                  // page just opened: do not beep for those waiting at that moment
  const ids = new Set();
  for (const a of list) {
    ids.add(a.id);
    if (a.state === 'waiting') { n++; if (!first && prevState.get(a.id) !== 'waiting') beep(); }
    prevState.set(a.id, a.state);
  }
  for (const id of [...prevState.keys()]) if (!ids.has(id)) prevState.delete(id);   // forget those no longer in the list
  // the flashing does not erase the "(?)" prefix (Claude's question awaiting an answer): PO.titleFor() is written in every frame other than the alert
  if (n && !flashTimer) flashTimer = setInterval(() => { document.title = document.title.startsWith('⚠') ? PO.titleFor() : '⚠ ' + PO.t('A worker is waiting for approval'); }, 900);
  if (!n && flashTimer) { clearInterval(flashTimer); flashTimer = null; document.title = PO.titleFor(); }
};

/* ------------------------------------------------------------------ start */
const fold = (id, title, open, hidden) => `<section class="fold pnl-fold" data-fold="${id}"${open ? ' open' : ''}${hidden ? ' hidden' : ''}><button class="fold-h" type="button">${title}<span class="cnt"></span></button><div class="fold-b"><div></div></div></section>`;
PO.initPanel = function () {
  const side = $('#side') || document.querySelector('aside');
  floorsEl = $('#floors');
  PO.statusEl = $('#status');
  // remove the old side panel parts, build the new one
  ['#sum', '#detail', '#list', '#feed'].forEach(s => { const e = side.querySelector(s); if (e) e.remove(); });
  side.querySelectorAll(':scope > h2').forEach(h => h.remove());
  root = document.createElement('div');
  root.className = 'pnl'; root.id = 'pnl';
  root.innerHTML = '<div class="pnl-sum" id="pnlSum"></div><div class="pnl-cardhost" id="pnlCard"></div>'
    + fold('pnl-ekip', esc(PO.t('Workers')), true, false) + fold('pnl-gone', esc(PO.t('Removed from the office')), false, true) + fold('pnl-feed', esc(PO.t('Recent activity')), false, false);
  side.appendChild(root);
  sumEl = root.querySelector('#pnlSum'); cardHost = root.querySelector('#pnlCard');
  const body = id => root.querySelector(`.fold[data-fold="${id}"] > .fold-b > div`);
  const cnt = id => root.querySelector(`.fold[data-fold="${id}"] > .fold-h .cnt`);
  listBody = body('pnl-ekip'); goneBody = body('pnl-gone'); feedBody = body('pnl-feed');
  listCnt = cnt('pnl-ekip'); goneCnt = cnt('pnl-gone'); goneFold = root.querySelector('.fold[data-fold="pnl-gone"]'); feedFold = root.querySelector('.fold[data-fold="pnl-feed"]');
  PO.ui.initFolds(root);

  // floor and zoom buttons
  floorsEl.addEventListener('click', e => { const b = e.target.closest('.pnl-fl'); if (b) { PO.cam.moved = true; PO.focusFloor(+b.dataset.f); } });
  const zb = (id, tip, fn) => { const b = $(id); if (!b) return; if (!b.dataset.tip) { b.dataset.tip = tip; b.dataset.tipPos = 'bottom'; } b.onclick = fn; };
  zb('#zin', PO.t('Zoom in (Ctrl + wheel)'), () => { PO.cam.moved = true; PO.setView(PO.cam.tcx, PO.cam.tcy, PO.cam.ts * 1.3); });
  zb('#zout', PO.t('Zoom out'), () => { PO.cam.moved = true; PO.setView(PO.cam.tcx, PO.cam.tcy, PO.cam.ts / 1.3); });
  zb('#zall', PO.t('Show the whole tower'), () => PO.focusAll());
  initLightbox();

  // list: click to select, highlight in the world on hover
  listBody.addEventListener('click', e => { const r = e.target.closest('.pnl-row[data-id]'); if (r) PO.select(r.dataset.id === PO.selectedId ? null : r.dataset.id, true); });
  goneBody.addEventListener('click', e => {
    const b = e.target.closest('[data-act="restore"]'); if (!b) return;
    const g = (PO.gone || []).find(x => x.id === b.dataset.id);
    restore(b.dataset.id, g && g.nick);
  });
  const hov = (e, on) => {
    const r = e.target.closest && e.target.closest('.pnl-row[data-id]'); if (!r || !listBody.contains(r)) return;
    if (on) PO.hoverId = r.dataset.id;
    else if (!(e.relatedTarget && r.contains(e.relatedTarget)) && PO.hoverId === r.dataset.id) PO.hoverId = null;
  };
  listBody.addEventListener('mouseover', e => hov(e, true));
  listBody.addEventListener('mouseout', e => hov(e, false));
  listBody.addEventListener('focusin', e => hov(e, true));
  listBody.addEventListener('focusout', e => hov(e, false));

  cardHost.addEventListener('click', onCardClick);
  document.addEventListener('pointerdown', e => { if (menuOpen() && !e.target.closest('.pnl-acts')) setMenu(false); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && menuOpen()) { setMenu(false); e.stopPropagation(); } }, true);

  setInterval(PO.updateFloorChips, 400);
  setInterval(() => { if (refs) renderDetail(); }, 1000);      // in demo mode or when idle, message states should also be refreshed
};
})(window.PO = window.PO || {});
