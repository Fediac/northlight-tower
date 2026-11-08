'use strict';
/* NorthLight Tower — attaching files to the message box (shared by the wide "Messages" window and the worker card in the side panel).
   Ways: the "+" button (file picker), drag and drop, Ctrl+V. The chosen file is uploaded to the server right away (PO.api.upload -> POST /upload)
   and appears above the box as a chip (name, size, a small preview if it is an image, ×). On send only attachment IDs go;
   the SERVER writes the '[Attachment: name="…" (kind, size) path="…"]' line the worker will read (the path is not taken from the client); in the chat record attachments are in a separate field (atts).
   The type / size limit is enforced on the server (server.py UP_*); the same list here is only for instant feedback.
   Contract:
     PO.att.box({ can, onChange }) -> box controller (a separate attachment list per agent; like the draft text):
       mount({ list, add, input, zone, ta })  binds the elements (the panel card is rebuilt for every agent: called again)
       use(agentId)  count()  ready()  busy()  items()  take()  restore(agentId, atts, bad?)  fail(agentId, attId, reason)
       drop(agentId, atts)  add(files)  paint()
     PO.att.split(text, atts) -> { text, atts }  the message's attachments: the server's separate "atts" field (chip in the bubble; ids on "Resend");
       if the field is missing (old record) PO.att.parse(text) separates only the attachment lines in the server's format
     PO.att.neutral(text)                   as the server does, "[Ek:" at the start of a line -> "(Ek:" (so the optimistic bubble matches)
     PO.att.compose(text, atts)             client copy of the text the server builds for the worker (attachment lines if the attachment has "line")
     PO.att.msgHTML(atts)  PO.att.plain(text, atts)  PO.att.lineFor(path, kind, size)  PO.att.accept */
(function (PO) {
const esc = s => PO.esc(s);
const MB = 1024 * 1024;
const KIND = {};
[['img', 'png jpg jpeg gif webp'], ['pdf', 'pdf'],
 ['txt', 'txt md markdown json jsonl csv tsv log ini cfg conf toml yaml yml xml html htm css scss less js mjs cjs ts tsx jsx py gd gdshader tscn tres cs c h cpp hpp cc java kt go rs rb php lua sql sh glsl hlsl shader vert frag srt vtt diff patch'],
 ['aud', 'mp3 wav ogg m4a'], ['vid', 'mp4 webm mov']].forEach(([k, l]) => l.split(' ').forEach(e => { KIND[e] = k; }));
const DENY = new Set('exe bat cmd ps1 psm1 psd1 msi msp dll sys scr com cpl msc vbs vbe wsf wsh hta jar lnk url reg pif appx msix appinstaller application gadget inf'.split(' '));
const LIMIT = { img:12 * MB, pdf:12 * MB, txt:12 * MB, aud:40 * MB, vid:40 * MB };
const KIND_TR = { img:'image', pdf:'PDF', txt:'text', aud:'audio', vid:'video' };       // protocol words of the server line (server.py UP_KIND_TR; kindName is used on screen)
const kindName = k => ({ img:PO.t('image'), pdf:'PDF', txt:PO.t('text'), aud:PO.t('audio'), vid:PO.t('video') })[k] || '';
const TR_KIND = { 'image':'img', 'PDF':'pdf', 'text':'txt', 'audio':'aud', 'video':'vid', 'görsel':'img', 'metin':'txt', 'ses':'aud' };       // Turkish words in old records are read too
const ICON = { img:'▣', pdf:'PDF', txt:'≡', aud:'♪', vid:'▶' };
const MAX_FILES = 5;                       // UP_MAX_FILES on the server
const MEDIA_NOTE = ' Note: cannot be read directly; process it by extracting frames/audio with ffmpeg or by transcribing it.';
// the line the server writes (server.py attach_line): [Attachment: name="<name>" (<kind>, <size>) path="<path>"] [ses/video notu] (audio/video note)  (the old format [Ek: ad="…" (görsel, …) yol="…"] is read too);
// the path is ".../yuklemeler/<session>/<12 hex id>_<name>". Parsed only for old records (without the atts field).
const RE_LINE = /^\[(?:Attachment: name|Ek: ad)="([^"\n]+)" \((image|PDF|text|audio|video|görsel|metin|ses), ([^()\n]+)\) (?:path|yol)="([^"\n]+)"\](.*)$/;
const RE_ID = /^([0-9a-f]{12})_(.+)$/;
const RE_UPDIR = /[\\/]yuklemeler[\\/][A-Za-z0-9_-]+[\\/][0-9a-f]{12}_[^\\/]+$/;
// the server turns the "[Attachment: ..." (old: "[Ek: ...") line the user typed into "(Attachment: ..." (server.py neutral_text): so the optimistic bubble matches the server's
const neutral = t => String(t == null ? '' : t).replace(/^((?:[^\S\n]|﻿)*)\[(Ek:|Attachment:)/gim, '$1($2');

// size shown on screen: in Turkish as before "3,2 MB" / "512 bayt", in English "3.2 MB" / "512 bytes" (both formats, from the server or from an old record, are read)
function showSizeTxt(t) {
  t = String(t == null ? '' : t);
  const m = /^(\d+(?:[.,]\d)?) (bytes|bayt|KB|MB|GB)$/.exec(t);
  if (!m) return t;
  const tr = PO.lang === 'tr';
  return m[1].replace(/[.,]/, tr ? ',' : '.') + ' ' + (m[2] === 'bytes' || m[2] === 'bayt' ? (tr ? 'bayt' : 'bytes') : m[2]);
}
const extOf = n => { const m = /\.([^.\\/]+)$/.exec(String(n || '')); return m ? m[1].toLowerCase() : ''; };
const kindOf = n => KIND[extOf(n)] || '';
const baseName = p => String(p).split(/[\\/]/).pop() || '';
function sizeTr(n) {                       // same format as size_tr on the server ("512 bytes", "240 KB", "3.2 MB")
  if (n < 1024) return n + ' bytes';
  if (n < MB) return Math.max(1, Math.round(n / 1024)) + ' KB';
  if (n < 1024 * MB) return (n / MB).toFixed(1) + ' MB';
  return (n / (1024 * MB)).toFixed(1) + ' GB';
}
const sizeShow = n => showSizeTxt(sizeTr(n));
// instant feedback: '' = acceptable; otherwise the reason (the real check is on the server)
function check(f) {
  const e = extOf(f.name);
  if (!e) return PO.t('no file extension');
  if (DENY.has(e)) return PO.t('executable files cannot be attached');
  const k = KIND[e];
  if (!k) return PO.t('this type cannot be attached (.{ext})', { ext:e.slice(0, 12) });
  if (!f.size) return PO.t('file is empty');
  if (f.size > LIMIT[k]) return PO.t('too large ({size}; max {max} MB)', { size:sizeShow(f.size), max:LIMIT[k] / MB });
  return '';
}
const lineFor = (path, kind, size) => '[Attachment: name="' + (RE_ID.exec(baseName(path)) || [0, 0, baseName(path)])[2] + '" (' + KIND_TR[kind] + ', ' + sizeTr(size) + ') path="' + path + '"]' + (kind === 'aud' || kind === 'vid' ? MEDIA_NOTE : '');

// fallback for OLD records (no atts field): separates the attachment lines in the message text. Only the format the server writes counts as an attachment:
// labeled line + a file with an id in the upload folder + the name in the line equals the file name. A hand-typed lookalike text stays.
function parse(text) {
  const keep = [], atts = [];
  String(text == null ? '' : text).split('\n').forEach(ln => {
    const m = RE_LINE.exec(ln.trim()), nm = m && RE_UPDIR.test(m[4]) ? RE_ID.exec(baseName(m[4])) : null;
    if (m && nm && nm[2] === m[1]) atts.push({ line:ln.trim(), path:m[4], id:nm[1], name:nm[2], kind:TR_KIND[m[2]], sizeTxt:showSizeTxt(m[3]), st:'ok' });
    else keep.push(ln);
  });
  return { text:keep.join('\n').trim(), atts };
}
// the message's text and attachments: the server gives attachments in a separate field (atts); the text is not parsed. If the field is missing (old record), parse.
function split(text, atts) {
  if (!Array.isArray(atts)) return parse(text);
  return { text:String(text == null ? '' : text).trim(),
    atts:atts.filter(a => a && /^[0-9a-f]{12}$/.test(String(a.id || ''))).map(a => ({ id:a.id, name:String(a.name || ''), path:String(a.path || ''),
      kind:KIND_TR[a.kind] ? a.kind : kindOf(a.name), size:a.size, sizeTxt:a.sizeTxt ? showSizeTxt(a.sizeTxt) : sizeShow(+a.size || 0), st:'ok' })) };
}
const compose = (text, atts) => { const t = String(text || '').trim(), l = (atts || []).map(a => a.line); return t + (t && l.length ? '\n\n' : '') + l.join('\n'); };
// list preview: "Attachment: name" instead of the full path
function plain(text, atts) { const p = split(text, atts); return [p.text].concat(p.atts.map(a => PO.t('Attachment: {name}', { name:a.name }))).filter(Boolean).join(' · '); }
// attachments in the bubble of a sent message (the path only in the tooltip; a processing note for audio/video)
function msgHTML(atts) {
  if (!atts || !atts.length) return '';
  return '<span class="att-msg">' + atts.map(a => `<span class="att-mc" title="${esc(a.path + (a.kind === 'aud' || a.kind === 'vid' ? '\n' + PO.t('Note: cannot be read directly; process the content by extracting frames/audio with ffmpeg or transcribing it.') : ''))}">` +
    `<i aria-hidden="true">${esc(ICON[a.kind] || '•')}</i><span class="att-mn">${esc(a.name)}</span><small>${esc(kindName(a.kind) + ' · ' + a.sizeTxt)}</small></span>`).join('') + '</span>';
}
const hasFiles = e => { const t = e.dataTransfer && e.dataTransfer.types; return !!t && [...t].includes('Files'); };
// The screenshot pasted with Ctrl+V is often named "image.png": make it clear who pasted it and when
function renamePasted(f) {
  const ext = extOf(f.name) || ({ 'image/png':'png', 'image/jpeg':'jpg', 'image/gif':'gif', 'image/webp':'webp' })[f.type] || '';
  if (!ext || (f.name && !/^image\.\w+$/i.test(f.name))) return f;
  const d = new Date(), p = n => String(n).padStart(2, '0');
  try { return new File([f], PO.t('pasted-{time}', { time:p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) }) + '.' + ext, { type:f.type, lastModified:Date.now() }); }
  catch (e) { return f; }
}

/* ---------------------------------------------------------------- box controller */
function box(opt) {
  opt = opt || {};
  const lists = new Map();                 // agent -> [attachment]; attachment: { key, file?, name, size?, sizeTxt, kind, url?, st:'up'|'ok'|'err', why, id, line, path }
  let cur = null, els = {}, seq = 0, sig = '';
  const listOf = id => { let l = lists.get(id); if (!l) { l = []; lists.set(id, l); } return l; };
  const items = () => (cur && lists.get(cur)) || [];
  const can = () => !opt.can || !!opt.can();
  const notify = () => { try { if (opt.onChange) opt.onChange(); } catch (e) { console.error(e); } };
  const changed = () => { paint(); notify(); };
  const revoke = it => { if (it && it.url) { try { URL.revokeObjectURL(it.url); } catch (e) { /* */ } it.url = ''; } };

  function add(files, src) {
    files = [...(files || [])];
    if (!files.length || !cur) return;
    if (!can()) { PO.ui.toast(PO.t('Files cannot be attached right now: messages cannot be sent to this worker.'), { kind:'bad' }); return; }
    const id = cur, l = listOf(id), bad = [];
    for (let f of files) {
      if (l.length >= MAX_FILES) { bad.push(PO.t('at most {n} files can be attached to a message', { n:MAX_FILES })); break; }
      if (src === 'paste') f = renamePasted(f);
      const why = check(f);
      if (why) { bad.push((f.name || PO.t('file')) + ': ' + why); continue; }
      if (l.some(x => x.file && x.file.name === f.name && x.file.size === f.size && x.file.lastModified === f.lastModified)) continue;   // the same file a second time
      const it = { key:'a' + (++seq), file:f, name:f.name, size:f.size, sizeTxt:sizeShow(f.size), kind:kindOf(f.name), st:'up', why:'', id:'', line:'', path:'' };
      if (it.kind === 'img') { try { it.url = URL.createObjectURL(f); } catch (e) { it.url = ''; } }
      l.push(it);
      upload(id, it);
    }
    if (bad.length) PO.ui.toast(PO.t('Could not attach: {list}', { list:bad.join(' · ') }), { kind:'bad', ms:6000 });
    changed();
    announce(files.length - bad.length > 0 ? PO.t('Adding file') : '');
  }
  async function upload(id, it) {
    let r;
    try { r = await PO.api.upload(it.file, id); } catch (e) { r = { ok:false, reason:PO.t('Unexpected error') }; }
    if (!(lists.get(id) || []).includes(it)) return;          // removed while uploading
    if (r && r.ok) { it.st = 'ok'; it.id = r.id; it.line = r.line; it.path = r.path; announce(PO.t('{name} added', { name:it.name })); }
    else { it.st = 'err'; it.why = (r && r.reason) ? PO.t(r.reason) : PO.t('Upload failed'); announce(PO.t('{name} could not be uploaded: {why}', { name:it.name, why:it.why })); }
    if (id === cur) changed(); else notify();
  }
  function remove(key) {
    const l = items(), i = l.findIndex(x => x.key === key);
    if (i < 0) return;
    revoke(l[i]); l.splice(i, 1);
    changed();
    // do not lose focus: the × of the next (else the previous) chip, the text box if none are left
    const xs = els.list ? els.list.querySelectorAll('.att-x') : [];
    const nx = xs[Math.min(i, xs.length - 1)];
    if (nx) nx.focus(); else if (els.ta && !els.ta.disabled) els.ta.focus({ preventScroll:true });
  }
  function announce(t) { if (els.live && t) { els.live.textContent = ''; setTimeout(() => { if (els.live) els.live.textContent = t; }, 30); } }

  function chipHTML(it) {
    const th = it.url ? `<img class="att-th" src="${esc(it.url)}" alt="">` : `<span class="att-th att-ic" aria-hidden="true">${esc(ICON[it.kind] || '•')}</span>`;
    const st = it.st === 'up' ? PO.t('uploading…') : it.st === 'err' ? it.why : kindName(it.kind);
    return `<li class="att-chip att-${it.st}" data-key="${esc(it.key)}" title="${esc(it.name + (it.st === 'err' ? '\n' + it.why : ''))}">${th}` +
      `<span class="att-t"><b>${esc(it.name)}</b><small>${esc(it.sizeTxt)}${st ? ' · ' + esc(st) : ''}</small></span>` +
      `<button type="button" class="att-x" data-key="${esc(it.key)}" aria-label="${esc(PO.t('Remove attachment {name}', { name:it.name }))}">×</button></li>`;
  }
  // draws only when something changed (the chat updates every second); the focused × is kept
  function paint() {
    const l = items(), ok = can();
    if (els.add && els.add.disabled !== !ok) els.add.disabled = !ok;
    if (!els.list) return;
    const s = cur + '|' + l.map(x => [x.key, x.st, x.why, x.url ? 1 : 0].join(':')).join(',');
    if (s === sig && els.list._att === true) return;
    sig = s; els.list._att = true;
    const ae = document.activeElement, fk = ae && els.list.contains(ae) ? ae.dataset.key : null;
    els.list.innerHTML = l.map(chipHTML).join('');
    els.list.hidden = !l.length;
    if (fk) { const b = els.list.querySelector('.att-x[data-key="' + fk + '"]'); if (b) b.focus(); }
  }
  function mount(e) {
    els = e || {};
    sig = '';
    if (els.list && !els.list._bound) {
      els.list._bound = true;
      els.list.setAttribute('aria-label', PO.t('Attachments'));
      els.list.addEventListener('click', ev => { const b = ev.target.closest('.att-x'); if (b) remove(b.dataset.key); });
      // live region next to the chips: the upload result is told to the screen reader in a short sentence (so the list is not read at every draw)
      const live = document.createElement('span'); live.className = 'att-sr'; live.setAttribute('aria-live', 'polite');
      els.list.after(live); els.live = live;
    } else if (els.list) els.live = els.list.nextElementSibling;
    if (els.add && !els.add._bound) {
      els.add._bound = true;
      els.add.addEventListener('click', () => { if (els.input && !els.add.disabled) els.input.click(); });
    }
    if (els.input && !els.input._bound) {
      els.input._bound = true;
      els.input.accept = ACCEPT;
      els.input.addEventListener('change', () => { add(els.input.files, 'pick'); els.input.value = ''; if (els.ta && !els.ta.disabled) els.ta.focus({ preventScroll:true }); });
    }
    if (els.ta && !els.ta._attBound) {
      els.ta._attBound = true;
      els.ta.addEventListener('paste', ev => {
        const cd = ev.clipboardData; if (!cd || !cd.files || !cd.files.length) return;
        if (![...cd.types].includes('text/plain')) ev.preventDefault();     // file only (screenshot): do not write "image.png" into the box
        add(cd.files, 'paste');
      });
    }
    const z = els.zone;
    if (z && !z._attBound) {
      z._attBound = true;
      let depth = 0;
      const off = () => { depth = 0; z.classList.remove('att-drop'); };
      z.addEventListener('dragenter', ev => { if (!hasFiles(ev)) return; ev.preventDefault(); depth++; z.classList.add('att-drop'); });
      z.addEventListener('dragover', ev => { if (!hasFiles(ev)) return; ev.preventDefault(); ev.dataTransfer.dropEffect = can() ? 'copy' : 'none'; });
      z.addEventListener('dragleave', ev => { if (!hasFiles(ev)) return; if (--depth <= 0) off(); });
      z.addEventListener('drop', ev => { if (!hasFiles(ev)) return; ev.preventDefault(); off(); add(ev.dataTransfer.files, 'drop'); });
    }
    paint();
  }
  return {
    mount, add, paint,
    use(id) { if (cur !== id) { cur = id; paint(); } },
    items: () => items().slice(),
    count: () => items().length,
    busy: () => items().some(x => x.st === 'up'),
    // can it be sent: no chip is uploading or failed (it opens once the failed chip is removed with ×)
    ready: () => items().every(x => x.st === 'ok'),
    // takes the ready attachments from the box for sending (optimistic send: if it fails they are put back with restore)
    take() { const l = items(), out = l.filter(x => x.st === 'ok'); if (out.length) { lists.set(cur, l.filter(x => x.st !== 'ok')); changed(); } return out; },
    // bad: { attId: reason } — an attachment the server could not find / rejected comes back as a "failed" chip (removed with ×)
    restore(id, atts, bad) {
      if (!id || !atts || !atts.length) return;
      const l = listOf(id), have = new Set(l.map(x => x.id).filter(Boolean));
      const back = atts.filter(a => !have.has(a.id)).map(a => Object.assign({ key:'a' + (++seq), st:'ok', why:'', sizeTxt:a.sizeTxt || sizeShow(a.size || 0) }, a,
        bad && bad[a.id] ? { st:'err', why:bad[a.id] } : { st:'ok', why:'' }));
      const all = back.concat(l), keep = all.slice(0, MAX_FILES), cut = all.slice(MAX_FILES);
      lists.set(id, keep);
      if (cut.length) {                    // chips that do not fit must not vanish silently: the preview is released, the result of an ongoing upload is ignored (upload())
        cut.forEach(revoke);
        PO.ui.toast(PO.t('At most {n} files can be attached to a message; removed from the box: {names}', { n:MAX_FILES, names:cut.map(x => x.name).join(', ') }), { kind:'bad', ms:6000 });
      }
      if (id === cur) changed(); else notify();
    },
    // send was rejected: the chip with that id becomes failed (for attachments left in the box; the panel keeps attachments in the box until success)
    fail(id, attId, why) {
      const it = (lists.get(id) || []).find(x => x.id && x.id === attId);
      if (!it) return;
      it.st = 'err'; it.why = why ? PO.t(why) : PO.t('Attachment not found');
      if (id === cur) changed(); else notify();
    },
    // send succeeded: previews are released; if they are still in the box (panel: they stay until success) they are removed
    drop(id, atts) {
      const ks = new Set((atts || []).map(a => a.key));
      (atts || []).forEach(revoke);
      const l = lists.get(id);
      if (l && l.some(x => ks.has(x.key))) { lists.set(id, l.filter(x => !ks.has(x.key))); if (id === cur) changed(); else notify(); }
    },
  };
}
const ACCEPT = Object.keys(KIND).map(e => '.' + e).join(',');

// a file dropped anywhere on the page (outside the zone) must not make the browser navigate to that file: the typed draft would be lost
addEventListener('dragover', e => { if (!hasFiles(e) || e.defaultPrevented) return; e.preventDefault(); e.dataTransfer.dropEffect = 'none'; });
addEventListener('drop', e => { if (hasFiles(e) && !e.defaultPrevented) e.preventDefault(); });

PO.att = { box, parse, split, neutral, compose, plain, msgHTML, lineFor, check, kindOf, sizeTr:sizeShow, accept:ACCEPT, MAX_FILES };
})(window.PO = window.PO || {});
