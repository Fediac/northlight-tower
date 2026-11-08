'use strict';
/* NorthLight Tower — all actions sent to the server in one place: message (+ attachment upload), stop, removing from / restoring to the office, reply text, window.
   UI modules do not write fetch; they call PO.api.*. In demo mode (PO.demo) the same calls run fake but realistic.
   Every call returns { ok, reason?, ... } (never throws). */
(function (PO) {
let tokenP = null;
// the server's rejection reason (a fixed English sentence) is translated to the local language; dynamic ones stay as they are
const loc = r => { if (r && typeof r === 'object' && typeof r.reason === 'string') r.reason = PO.t(r.reason); return r; };
function getToken(fresh) {
  if (fresh) tokenP = null;
  if (!tokenP) tokenP = fetch('/config', { cache:'no-store' }).then(r => r.json()).then(j => j.token).catch(() => { tokenP = null; return null; });
  return tokenP;
}
// If the server restarted, the old key on the page is invalid (403): gets a new one and retries once
async function authedPost(url, payload) {
  for (let k = 0; k < 2; k++) {
    const token = await getToken(k === 1);
    if (!token) return { ok:false, reason:PO.t('Cannot reach the tower; Start.bat may not be running') };
    let r;
    const ac = new AbortController(), to = setTimeout(() => ac.abort(), 12000);       // so the UI does not wait forever if the server does not answer
    try { r = await fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json', 'X-PO-Token':token }, body:JSON.stringify(payload), signal:ac.signal }); }
    catch (e) { return { ok:false, reason:e && e.name === 'AbortError' ? PO.t('The tower did not respond; try again in a moment') : PO.t('Cannot reach the tower; Start.bat may not be running') }; }
    finally { clearTimeout(to); }
    if (r.status === 403) { if (k === 0) continue; return { ok:false, reason:PO.t('Authorization failed; reload the page (F5)') }; }
    try { return loc(await r.json()); } catch (e) { return { ok:false, reason:PO.t('Unexpected response; try again') }; }
  }
  return { ok:false, reason:PO.t('Authorization failed; reload the page (F5)') };
}
PO.getToken = getToken;
PO.authedPost = authedPost;
PO.pollNow = () => { if (PO.poll) PO.poll(); };
const find = id => (PO.allList || []).find(x => x.id === id) || (PO.serverList || []).find(x => x.id === id) || null;

/* ---- demo mode: fake but consistent behavior ---- */
function demoReply(info, tx, atts) {
  const t = Date.now() / 1000;
  (info.chat = info.chat || []).push({ id:'d' + Date.now(), t, who:'ben', text:tx, st:'bekliyor', atts:atts || [] });   // like the server: attachments in a separate field
  const m = info.chat[info.chat.length - 1];
  setTimeout(() => { m.st = 'iletildi'; }, 500);
  setTimeout(() => {
    info.chat.push({ id:'d' + Date.now(), t:Date.now() / 1000, who:'ajan', st:'yanit',
      text:PO.t("OK, I'm looking into it; I'll write back shortly.") });          // neutral reply independent of the question (it must not give an unrelated answer to "What are you doing?")
  }, 1800);
}
function demoGoneEntry(info) {
  return { id:info.id, session:info.session, nick:info.nick, char:info.char, label:info.label, role:info.role, kind_tr:info.kind_tr, project:info.project, sub:info.sub, dept:info.dept, at:Date.now() / 1000 };
}

// message attachment: the raw bytes of the file POST /upload?to=<worker> (name in the X-PO-Name header). The server checks type/size/content,
// saves it under yuklemeler/<session>/ with a unique name: { ok, id, name, path, size, kind, line } or { ok:false, reason }
async function uploadFile(file, to) {
  for (let k = 0; k < 2; k++) {
    const token = await getToken(k === 1);
    if (!token) return { ok:false, reason:PO.t('Cannot reach the tower; Start.bat may not be running') };
    let r;
    const ac = new AbortController(), to2 = setTimeout(() => ac.abort(), 120000);   // a 40 MB video also fits comfortably locally
    try {
      r = await fetch('/upload?to=' + encodeURIComponent(to), { method:'POST', body:file, signal:ac.signal,
        headers:{ 'Content-Type':'application/octet-stream', 'X-PO-Token':token, 'X-PO-Name':encodeURIComponent(file.name || '') } });
    } catch (e) { return { ok:false, reason:e && e.name === 'AbortError' ? PO.t('The upload took too long; try again') : PO.t('Could not send the file (the tower dropped the connection); check its type and size') }; }
    finally { clearTimeout(to2); }
    if (r.status === 403) { if (k === 0) continue; return { ok:false, reason:PO.t('Authorization failed; reload the page (F5)') }; }
    try { return loc(await r.json()); } catch (e) { return { ok:false, reason:PO.t('Unexpected response; try again') }; }
  }
  return { ok:false, reason:PO.t('Authorization failed; reload the page (F5)') };
}

PO.api = {
  find,
  // files: PO.att attachments ({ id, line }); only ids go to the server, the server writes the attachment lines
  async send(id, text, files) {
    const tx = String(text || '').trim(), atts = (files || []).filter(a => a && a.id);
    if (!tx && !atts.length) return { ok:false, reason:PO.t('Empty message') };
    const info = find(id);
    if (PO.demo) { if (!info) return { ok:false, reason:PO.t('Worker not found') }; demoReply(info, PO.att ? PO.att.neutral(tx) : tx, atts.map(a => ({ id:a.id, name:a.name, kind:a.kind, size:a.size, path:a.path }))); return { ok:true }; }
    const r = await authedPost('/send', atts.length ? { to:id, text:tx, files:atts.map(a => a.id) } : { to:id, text:tx });
    if (r && r.ok) PO.pollNow();
    return r;
  },
  async upload(file, to) {
    if (PO.demo) {                                   // demo mode: fake but replies in the same format (the path is not real)
      await new Promise(res => setTimeout(res, 400));
      const kind = PO.att ? PO.att.kindOf(file.name) : 'txt', uid = Math.random().toString(16).slice(2, 14).padEnd(12, '0');
      const path = 'C:\\Demo\\_cache\\yuklemeler\\demo\\' + uid + '_' + String(file.name).replace(/[^\wçğıöşüÇĞİÖŞÜ .()+-]/g, '_');
      return { ok:true, id:uid, name:file.name, path, size:file.size, kind, line:PO.att ? PO.att.lineFor(path, kind, file.size) : '' };
    }
    return uploadFile(file, to);
  },
  // stop the worker: cuts the current turn on the main agent, stops the task on a sub-agent (via the plugin's delivery path)
  async stop(id) {
    const info = find(id);
    if (PO.demo) {
      if (!info) return { ok:false, reason:PO.t('Worker not found') };
      info.state = 'done'; info.detail = PO.t('Stopped');
      (info.chat = info.chat || []).push({ id:'s' + Date.now(), t:Date.now() / 1000, who:'ofis', st:'', text:PO.t('Stop request sent.') });   // the server also adds such a system note to the chat
      return { ok:true };
    }
    const r = await authedPost('/stop', { id });
    if (r && r.ok) PO.pollNow();
    return r;
  },
  // remove from the office (does not delete, hides); restore to bring it back
  async dismiss(id) {
    const info = find(id);
    if (PO.demo) {
      if (!info) return { ok:false, reason:PO.t('Not found') };
      PO.demoGone = (PO.demoGone || []).concat([demoGoneEntry(info)]);
      PO.demoList = (PO.demoList || []).filter(x => x.id !== id);
      PO.onState(PO.demoList, PO.demoGone);
      return { ok:true };
    }
    const r = await authedPost('/dismiss', { id });
    if (r && r.ok) PO.pollNow();
    return r;
  },
  async restore(id) {
    if (PO.demo) {
      const g = (PO.demoGone || []).find(x => x.id === id);
      const orig = (PO.demoAll || []).find(x => x.id === id);
      PO.demoGone = (PO.demoGone || []).filter(x => x.id !== id);
      if (orig && !(PO.demoList || []).some(x => x.id === id)) PO.demoList.push(orig);
      PO.onState(PO.demoList, PO.demoGone);
      return { ok:!!(g || orig) };                                // idempotent: succeeds even if it is already in the office (so the old "Undo" notification does not fail)
    }
    const r = await authedPost('/restore', { id });
    if (r && r.ok) PO.pollNow();
    return r;
  },
  // full text of a worker's latest reply: { ok, text, t, n, task, nick, label }
  async reply(id, n) {
    if (PO.demo) {
      const info = find(id);
      if (!info || !info.reply) return { ok:false, reason:PO.t('No reply') };
      return { ok:true, id, n:info.reply.n, t:info.reply.t, text:info.reply.text || info.reply.head, task:info.task, nick:info.nick, label:info.label };
    }
    try {
      const r = await fetch('/reply?id=' + encodeURIComponent(id) + (n ? '&n=' + n : ''), { cache:'no-store' });
      if (!r.ok) return { ok:false, reason:r.status === 404 ? PO.t('Reply not found') : PO.t('The tower returned an error; try again') };
      const j = await r.json();
      if (PO.localizeInfo && j) PO.localizeInfo(j);                      // nick: English name in English mode
      return Object.assign({ ok:true }, j);
    } catch (e) { return { ok:false, reason:PO.t('Cannot reach the tower; Start.bat may not be running') }; }
  },
  // Windows: keep the tower window on top / release it
  async window(action) { return authedPost('/window', { action }); },
  // Claude's questions (AskUserQuestion): pending cards { now, items:[...], recent:[{id,status,reason,delivered,lost}] } or null.
  // This polling tells the tower "the office is open"; vis: is the tab visible (document.visibilityState), focus: does the page have focus. The server gives a new question
  // only to a visible office; if the polling stops (tab closed) or the tab stays in the background, questions are asked in the Claude window.
  // Needs a token (so no other page can fake "office is open"). Goes to the real server in demo mode too.
  async asks(vis, focus) {
    for (let k = 0; k < 2; k++) {
      const token = await getToken(k === 1);
      if (!token) return null;
      const ac = new AbortController(), to = setTimeout(() => ac.abort(), 8000);       // so a hung polling request does not block the following ones
      try {
        const r = await fetch('/asks?v=' + (vis ? 1 : 0) + '&f=' + (focus ? 1 : 0), { cache:'no-store', headers:{ 'X-PO-Token':token }, signal:ac.signal });
        if (r.status === 403) { if (k === 0) continue; return null; }                  // server restarted: once more with the new token
        if (!r.ok) return null;
        const j = await r.json();
        return j && typeof j === 'object' && Array.isArray(j.items) ? j : null;
      } catch (e) { return null; }
      finally { clearTimeout(to); }
    }
    return null;
  },
  // answers: in question order [{ sel:[i…], other }, { text }, { num }]; the server converts to Claude's format.
  // nonce: the card's attempt id. If the request stays unanswered for 12 s and is retried, and the server already received the first one, the result is success, not "already answered".
  // sidebar / "+" list: Claude's saved chats { ok, total, offset, limit, items:[{ id, title, project, last, pinned }] } (needs a token; not available in demo mode)
  // o: { offset, limit (at most 200), q (title / project search) }; if not given, the newest 50
  async recent(o) {
    if (PO.demo) return { ok:false, reason:PO.t('The saved chat list is not available in demo mode') };
    const p = new URLSearchParams();
    if (o && o.offset > 0) p.set('offset', String(Math.floor(o.offset)));
    if (o && o.limit > 0) p.set('limit', String(Math.min(200, Math.floor(o.limit))));
    if (o && o.q) p.set('q', String(o.q).slice(0, 100));
    const qs = p.toString();
    for (let k = 0; k < 2; k++) {
      const token = await getToken(k === 1);
      if (!token) return { ok:false, reason:PO.t('Cannot reach the tower; Start.bat may not be running') };
      const ac = new AbortController(), to = setTimeout(() => ac.abort(), 12000);
      try {
        const r = await fetch('/sessions/recent' + (qs ? '?' + qs : ''), { cache:'no-store', headers:{ 'X-PO-Token':token }, signal:ac.signal });
        if (r.status === 403) { if (k === 0) continue; return { ok:false, reason:PO.t('Authorization failed; reload the page (F5)') }; }
        const j = await r.json();
        return j && typeof j === 'object' && Array.isArray(j.items) ? j : { ok:false, reason:PO.t((j && j.reason) || 'Unexpected response; try again') };
      } catch (e) { return { ok:false, reason:e && e.name === 'AbortError' ? PO.t('The tower did not respond; try again in a moment') : PO.t('Cannot reach the tower; Start.bat may not be running') }; }
      finally { clearTimeout(to); }
    }
    return { ok:false, reason:PO.t('Authorization failed; reload the page (F5)') };
  },
  // add the chat to the tower and pin it (it does not close even if idle) / remove the pin (the × on the tab)
  async pin(id) { if (PO.demo) return { ok:false, reason:PO.t('Not available in demo mode') }; return authedPost('/sessions/pin', { id }); },
  async unpin(id) { if (PO.demo) return { ok:true }; return authedPost('/sessions/unpin', { id }); },
  async answer(id, answers, nonce) { return authedPost('/answer', { id, answers, nonce }); },
  async handoff(id, nonce) { return authedPost('/answer', { id, handoff:true, nonce }); },
};
})(window.PO = window.PO || {});
