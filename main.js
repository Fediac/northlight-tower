'use strict';
/* Pixel Office — startup, shell layout (header height, splitter), server polling, demo mode, main loop. */
(async function (PO) {
const $ = PO.$;
const statusEl = $('#status');
const q = new URLSearchParams(location.search);

/* Header status chip: dot + short text. cls: 'ok' (connected) | 'warn' (connected but messaging off) | 'err' | 'demo' | '' (connecting). title: detail (on hover).
   In a narrow header (<560 px) CSS hides the text, only the colored dot remains; the full text stays on hover (title) and for the screen reader (aria-label). */
PO.statusEl = statusEl;
PO.setStatus = function (text, cls, title) {
  const c = cls || '';
  const full = title ? text + ' — ' + title : text;
  if (statusEl.className !== c) statusEl.className = c;
  if (statusEl.textContent !== text) statusEl.textContent = text;
  if ((statusEl.title || '') !== full) statusEl.title = full;
  if (statusEl.getAttribute('aria-label') !== full) statusEl.setAttribute('aria-label', full);
};

/* ------------------------------------------------------------------ shell layout */
// The page never scrolls sideways/down: html/body have overflow:clip in CSS; still, if something (focus, selection drag, old browser) scrolls it, undo it.
function initShell() {
  const root = document.documentElement;
  const resetScroll = () => { if (root.scrollLeft || root.scrollTop || document.body.scrollLeft || document.body.scrollTop) { root.scrollLeft = root.scrollTop = 0; document.body.scrollLeft = document.body.scrollTop = 0; } };
  addEventListener('scroll', resetScroll, { passive:true });
  document.addEventListener('scroll', resetScroll, { passive:true });
  document.body.addEventListener('scroll', resetScroll, { passive:true });

  // --hdr-h: bottom edge of the header + tab bar (px). Chat / settings overlays start below it.
  const hdr = $('header'), bar = $('#tabbar');
  let lastH = 0;
  const setHdr = () => { const h = Math.ceil(bar.getBoundingClientRect().bottom); if (h > 0 && h !== lastH) { lastH = h; root.style.setProperty('--hdr-h', h + 'px'); } };
  setHdr();
  if (window.ResizeObserver) { const ro = new ResizeObserver(setHdr); ro.observe(hdr); ro.observe(bar); } else addEventListener('resize', setHdr);

  // in a narrow scene the floor buttons become numbers only
  const stage = $('#stage');
  const narrow = () => stage.classList.toggle('narrow', stage.clientWidth < 540);
  narrow();
  if (window.ResizeObserver) new ResizeObserver(narrow).observe(stage);

  initSplitter();
}

/* Splitter: drag → side panel width (300…min(720, 70% of the window)); double click resets (360); when focused ←/→ ±24 px. Persistent in the 'asideW' setting. */
function initSplitter() {
  const sp = $('#splitter'), mainEl = $('main'), side = $('#side');
  const MIN = 300, DEF = 360;
  const maxW = () => Math.max(MIN, Math.min(720, Math.floor(mainEl.clientWidth * 0.7)));
  const clampW = w => Math.round(PO.clamp(w, MIN, maxW()));
  const live = w => document.documentElement.style.setProperty('--aside-w', w + 'px');
  const aria = () => {
    const w = Math.round(side.getBoundingClientRect().width);
    sp.setAttribute('aria-valuemin', MIN); sp.setAttribute('aria-valuemax', maxW()); sp.setAttribute('aria-valuenow', w);
    sp.setAttribute('aria-valuetext', PO.t('Panel {w} pixels', { w }));
  };
  let drag = null, raf = 0, pending = 0;
  sp.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { id:e.pointerId, x0:e.clientX, w0:side.getBoundingClientRect().width };
    pending = drag.w0;
    try { sp.setPointerCapture(e.pointerId); } catch (x) { /* */ }
    document.body.classList.add('dragging');
  });
  sp.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    pending = clampW(drag.w0 + (drag.x0 - e.clientX));          // drag left → the panel grows
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; live(pending); });
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    document.body.classList.remove('dragging');
    PO.settings.set('asideW', clampW(pending));
    PO.settings.apply();                                           // sync the live value to the setting even if it did not change
    aria();
  };
  sp.addEventListener('pointerup', end);
  sp.addEventListener('pointercancel', end);
  sp.addEventListener('lostpointercapture', end);
  sp.addEventListener('dblclick', () => { PO.settings.set('asideW', DEF); PO.settings.apply(); aria(); });
  sp.addEventListener('keydown', e => {
    let w = null;
    const cur = side.getBoundingClientRect().width;
    if (e.key === 'ArrowLeft') w = cur + 24; else if (e.key === 'ArrowRight') w = cur - 24;
    else if (e.key === 'Home') w = MIN; else if (e.key === 'End') w = maxW(); else if (e.key === 'Enter') w = DEF;
    if (w == null) return;
    e.preventDefault();
    PO.settings.set('asideW', clampW(w)); PO.settings.apply(); aria();
  });
  if (window.ResizeObserver) new ResizeObserver(aria).observe(side); else addEventListener('resize', aria);
  aria();
}
initShell();

/* temporary setting parameters for test / development (not saved permanently): ?theme=western &dark=black &accent=cyan &fps=saver &aside=420 &font=1.1 &compact=1 */
(function urlSettings() {
  const t = { temp:true };
  const th = q.get('theme'); if (th) PO.settings.set('theme', th, t);         // ?theme=western (not persistent)
  const d = q.get('dark'); if (d) PO.settings.set('dark', d, t);
  const a = q.get('accent'); if (a) PO.settings.set('accent', a, t);
  const f = q.get('fps'); if (f) PO.settings.set('fps', f, t);
  const w = +q.get('aside'); if (w) PO.settings.set('asideW', w, t);
  const fs = +q.get('font'); if (fs) PO.settings.set('font', fs, t);
  if (q.get('compact') === '1') PO.settings.set('compact', true, t);
})();

/* if starting one section blows up, the others keep working (error to the console + a single notification) */
const failed = [];
function guard(name, fn) { try { return fn(); } catch (e) { console.error('[' + name + ']', e); failed.push(name); } }

try {
  await PO.loadAssets();
} catch (e) {
  console.error('[assets]', e);
  PO.setStatus(PO.t('Could not load the tower files. Refresh the page (F5).'), 'err'); throw e;
}
PO.towerTitle = PO.towerTitle || { title:PO.t('Empty office'), project:'' };          // sign when there is no session in the first frame
PO.buildTower(PO.layoutFor([], 0));          // first building: an empty default floor array until a session arrives
PO.initDraw();
PO.initCam();
guard('panel', () => PO.initPanel());
guard('tabs', () => PO.initSessions());
guard('floors', () => PO.buildFloorChips());
PO.focusFloor(1, true);
if (failed.length) PO.ui.toast(PO.t('Some parts could not be opened. Refresh the page (F5).'), { kind:'bad', ms:9000 });          // detail (which section) in the console

/* ------------------------------------------------------------------ server polling */
let connected = false, pollBusy = false, buildId = null;
// If the page files changed (new version), the open page refreshes itself; if you are typing a message it shows a button without spoiling what you typed
function newBuild() {
  const ae = document.activeElement;
  const typing = ae && /^(TEXTAREA|INPUT)$/.test(ae.tagName) && ae.value.trim();
  const rd = $('#reader');
  let busy = !!(rd && !rd.hidden);                                              // the page must not refresh suddenly while the reader / chat / settings / an image is open
  try { busy = busy || !!(PO.chat && PO.chat.isOpen && PO.chat.isOpen()) || !!(PO.settingsUI && PO.settingsUI.isOpen && PO.settingsUI.isOpen()) || !!(PO.gallery && PO.gallery.isOpen && PO.gallery.isOpen()) || !!(PO.lightboxOpen && PO.lightboxOpen()); } catch (e) { /* */ }
  if (!typing && !busy) { location.reload(); return; }
  if (!$('#newBuildBtn')) {
    const b = document.createElement('button');
    b.id = 'newBuildBtn'; b.className = 'hbtn pri'; b.innerHTML = '⟳<span class="lbl">' + PO.esc(PO.t('New version: refresh')) + '</span>';
    b.setAttribute('aria-label', PO.t('New version: refresh')); b.setAttribute('data-tip', PO.t('A new version is ready. The page did not refresh by itself so the message you are typing is not lost.')); b.setAttribute('data-tip-pos', 'bottom-end'); b.onclick = () => location.reload();
    $('.btns').prepend(b);
  }
}
PO.poll = async function () {
  if (PO.demo || pollBusy) return;
  pollBusy = true;
  try {
    let r, s;
    try { r = await fetch('/state', { cache:'no-store' }); }
    catch (e) {
      connected = false; PO.setStatus(PO.t('The tower is off. Double-click Start.bat.'), 'err');
      console.error(e); return;
    }
    try { s = await r.json(); } catch (e) { s = null; }
    if (PO.demo) return;
    // broken / unexpected reply (HTML error page, null, array, agents not an array…): the chip must not stick on "Connecting"; it fixes itself on the next poll
    if (!r.ok || !s || typeof s !== 'object' || Array.isArray(s) || (s.agents != null && !Array.isArray(s.agents))) {
      connected = false; PO.setStatus(PO.t('The tower sent an unexpected reply. It will try again shortly.'), 'err');
      return;
    }
    if (s.build) { if (buildId === null) buildId = s.build; else if (s.build !== buildId) newBuild(); }
    connected = true;
    const okItem = x => !!x && typeof x === 'object' && !Array.isArray(x) && x.id != null;          // broken items like null / number / array are skipped
    const list = (s.agents || []).filter(okItem).sort((p, q) => (p.started || 0) - (q.started || 0));
    const gone = Array.isArray(s.gone) ? s.gone.filter(okItem) : [];
    PO.serverTime = s.time;
    PO.pinnedSids = Array.isArray(s.pinned) ? s.pinned.filter(x => typeof x === 'string') : [];      // chats added (pinned) with "+"
    try { PO.onState(list, gone); } catch (e) { console.error('[onState]', e); }          // one module's error must not stop the state flow
    if (!s.root_exists) PO.setStatus(PO.t('Claude logs not found'), 'err', PO.t('Folder searched: {path}', { path:s.root }));
    else if (!list.length) PO.setStatus(PO.t('Connected · no workers right now'), 'ok');
    else {
      const base = PO.sessions.length > 1
        ? PO.tn(list.length, 'Connected · {n} worker · {k} chats', 'Connected · {n} workers · {k} chats', { k:PO.sessions.length })
        : PO.tn(list.length, 'Connected · {n} worker', 'Connected · {n} workers');
      if (s.mods) PO.setStatus(base, 'ok', PO.t('You can send messages to workers.'));
      else PO.setStatus(PO.t('{status} · messages off', { status:base }), 'warn', PO.t('To send messages, the Pixel Office plugin in Claude must be connected to this chat.'));
    }
    if (!PO.cam.moved && list.length && !PO.framedOnce) { PO.framedOnce = true; setTimeout(() => PO.autoFrame(), 2500); }
  } finally { pollBusy = false; }
};
setInterval(PO.poll, 700); PO.poll();

/* ------------------------------------------------------------------ demo office (fake workers): 3 chats = 3 offices */
let demoTimer = null;
const DEMO_SEQ = ['thinking', 'reading', 'typing', 'typing', 'waiting', 'delegating', 'typing', 'done', 'done', 'done', 'done', 'done'];
// fake data is English source text; it reaches the screen via PO.t (in the Turkish view the old Turkish texts, tr_core.js)
const DEMO_SESS = [
  { title:'Finish the checkout page', project:'web-shop', t:'Finish the checkout page' },
  { title:'Pixel-art game', project:'game-jam', t:'Prepare the run animations' },
  { title:'Map update', project:'game-jam', t:'Draw the map' },
];
const DEMO_SUBS = [
  { n:'test', dept:'kod', t:'Write and run the tests', ty:'general-purpose' },
  { n:'code scan', dept:'arastirma', t:'Scan the codebase', ty:'Explore' },
  { n:'architecture', dept:'arastirma', t:'Plan the architecture', ty:'Plan' },
  { n:'PixelLab', dept:'tasarim', t:'Fetch character images from PixelLab', ty:'general-purpose' },
  { n:'UI', dept:'tasarim', t:'Draw the UI icons', ty:'general-purpose' },
  { n:'bug', dept:'kod', t:'Find and fix the bug', ty:'general-purpose' },
  { n:'docs', dept:'arastirma', t:'Review the docs', ty:'claude-code-guide' },
];
const DEMO_ETA = [[240, 300, 9], [150, 200, 14], [170, 240, 5], [150, 190, 20], null, [900, 1200, 7], [600, 800, 11]];   // [median s, ~75% s, sample count]
const DEMO_SUB_SESS = [0, 0, 0, 0, 0, 1, 2];                    // which chat the sub-agents belong to
const DEMO_EV = [['task', 'Rewrite the office page'], ['tool', 'Read · office.js'], ['tool', 'Edit · office.js'], ['say', 'Fixing the desk positions'], ['tool', 'Bash · python compose_tower.py'], ['tool', 'WebSearch · pixel art office']];
const DEMO_IMGS = ['assets/f/poster_synth.png', 'assets/f/poster_robot.png', 'assets/f/arcade.png', 'assets/f/vending.png', 'assets/f/whiteboard.png', 'assets/f/easel.png', 'assets/f/sofa_a.png', 'assets/f/desk_a.png', 'assets/f/trophy_case.png'];
const DEMO_ANIMS = ['assets/demo/demo_anim1.gif', 'assets/demo/demo_anim2.gif'];
const DEMO_REPLIES = [
`## The tower is ready

I finished the new version of the office tower. In short:

- Every chat has **its own office**; switch between them with the tabs at the top.
- Floors are added automatically as the work grows.
- GIFs and videos play in the gallery.

### What changed?

1. Added a tab bar
2. Gallery floor and hologram pedestals
3. Workers who are done wait at their desks

> Note: To send messages, the Pixel Office plugin must be connected to this chat.

\`\`\`python
print("tower ready")
\`\`\`

If you like, I can add the settings window in the next step.`,
`I updated the island map.

| Area | Status |
|---|---|
| Lighthouse | Done |
| Pier | Needs revision |
| Cliffs | Done |

The new images are on the gallery floor. There is one revision note for the **Pier**: the planks came out too dark.`,
`I ran the tests: all 19 passed. There is one warning, but it is not blocking; I can send the details if you want.`,
];
// similar to the server's head_of: skip the markdown heading and the short first line without punctuation, take the first body sentence
function demoFirstSentence(t) {
  const lines = String(t).split('\n').map(s => s.trim()).filter(Boolean);
  const body = lines.filter(s => !/^#{1,6}\s/.test(s) && !(s.length <= 80 && !/[.!?:…]$/.test(s)));
  const pick = (body[0] || lines[0] || '').replace(/[#>*`|]/g, ' ').replace(/^-\s+/, '').replace(/\s+/g, ' ').trim();
  const m = pick.match(/^.{20,}?[.!?](\s|$)/);
  return m ? m[0].trim().slice(0, 150) : (PO.clipWords || PO.clip)(pick, 150);
}
PO.startDemo = function () {
  if (PO.demo) return;
  PO.demo = true;
  window.dispatchEvent(new CustomEvent('po:demo', { detail:{ on:true } }));          // so the settings window can sync its switch
  const now = Date.now() / 1000;
  const n = Math.max(3, +(q.get('n') || DEMO_SESS.length + DEMO_SUBS.length));
  const nart = +(q.get('art') || 0);
  const list = [], T = PO.t;
  DEMO_SESS.forEach((s, k) => list.push({
    id:'demo' + k, session:'demo' + k, label:T(s.title), sub:false, project:s.project, agent_type:null, dept:'mudur', state:'thinking', detail:'', target:'', since:now, started:now - 900 + k * 40,
    task:T(s.t), tools:3 + k, events:[], step:k * 3, finished:false, can_message:true, tool_names:['Read', 'Edit', 'Bash'], chat:[], artifacts:[],
    eta:{ est:1200, hi:1600, n:12, t0:now - 900 + k * 40 },                              // fake time estimate (same format as eta on the server)
  }));
  for (let i = 0; i < n - DEMO_SESS.length; i++) {
    const d = DEMO_SUBS[i % DEMO_SUBS.length], sIdx = i < DEMO_SUBS.length ? DEMO_SUB_SESS[i] : 0;
    const art = d.dept === 'tasarim' ? DEMO_IMGS.slice(0, 3 + (i % 3)).map((src, k) => ({ id:'img' + i + k, kind:'img', src, label:T('draft_{n}.png', { n:k + 1 }), t:now - 600 + k * 90 + i })) : [];
    list.push({
      id:'agent-demo' + i, session:'demo' + sIdx, label:`${d.ty} · ${i < DEMO_SUBS.length ? T(d.n) : T(d.n) + ' ' + i}`, sub:true, project:'demo', agent_type:d.ty, dept:d.dept,
      state:'thinking', detail:'', target:'', since:now, started:now - 60 * (i + 1), task:T(d.t), tools:3 + i, events:[], step:i * 3 + 1, finished:false, can_message:true,
      tool_names:['Read', 'Edit', 'Bash'], chat:[], artifacts:art,
    });
    const E = DEMO_ETA[i % DEMO_ETA.length];                                              // so each agent looks different: remaining / soon / taking long / no data
    list[list.length - 1].eta = E ? { est:E[0], hi:E[1], n:E[2], t0:now - 60 * (i + 1) } : null;
    list[list.length - 1].eta_n = E ? null : 1;                                           // no data: like eta_n on the server (n/3 hint)
  }
  // test: add many images + animated GIFs to the first design agent (gallery floor trial)
  const des = list.find(x => x.dept === 'tasarim');
  if (des && nart) {
    for (let k = 0; k < nart; k++) {
      const gif = k % 4 === 1;
      des.artifacts.push({ id:'art' + k, kind:'img', anim:gif, src:gif ? DEMO_ANIMS[(k >> 2) % DEMO_ANIMS.length] : DEMO_IMGS[k % DEMO_IMGS.length], label:gif ? T('animation_{n}.gif', { n:k }) : T('image_{n}.png', { n:k }), t:now - 3000 + k * 120 });
    }
  }
  list[0].chat = [{ id:'c1', t:now - 300, who:'ben', text:T('How is it going?'), st:'iletildi' }, { id:'c2', t:now - 280, who:'ajan', text:T('The tower shell is ready; now I am wiring up the interface.'), st:'yanit' }];
  // name, face, role (same as the server's assignment: fixed person name + task title)
  const NM = PO.NAMES, subCount = {};
  list.forEach(d => {
    const si = +d.session.slice(4);
    if (!d.sub) { const b = NM.bosses[si % NM.bosses.length]; d.char = b.char; d.nick = b.nick; d.kind_tr = ''; d.role = ''; }
    else { const c = subCount[d.session] = (subCount[d.session] || 0); subCount[d.session]++; const st = NM.staff[(c + si * 3) % NM.staff.length]; d.char = st.char; d.nick = st.nick; d.kind_tr = NM.types_tr[d.agent_type] || NM.type_default_tr; d.role = d.task; }
    if (!d.sub) { const tx = T(DEMO_REPLIES[si % DEMO_REPLIES.length]); d.reply = { n:1, t:now - 900, head:demoFirstSentence(tx), len:tx.length, text:tx }; }
  });
  PO.demoList = list; PO.demoAll = list.slice(); PO.demoGone = [];
  const tick = () => {
    const now2 = Date.now() / 1000;
    PO.demoList.forEach(d => {
      const prev = d.state;
      if (d.forceWait && d.forceWait > now2) d.step++;                                  // approval test: stay in "onay bekliyor" (waiting for approval) until the time runs out
      d.state = d.forceWait && d.forceWait > now2 ? 'waiting' : DEMO_SEQ[d.step++ % DEMO_SEQ.length];
      if (d.state !== prev) d.since = now2;
      d.detail = d.state === 'waiting' ? (d.forceWait && d.forceWait > now2 ? T('Waiting for approval (folder trust prompt)') : T('Waiting for approval')) : d.state === 'done' ? T('Finished, waiting for your next message') : PO.stateOf(d.state).tr;
      d.target = d.state === 'typing' ? 'office.js' : d.state === 'reading' ? 'server.py' : '';
      const e = DEMO_EV[Math.floor(Math.random() * DEMO_EV.length)];
      d.events.push({ t:now2, k:e[0], x:T(e[1]) }); if (d.events.length > 14) d.events.shift();
      if (!d.sub && d.state === 'done' && prev !== 'done' && d.reply) {            // main agent finished its turn: new reply
        const tx = T(DEMO_REPLIES[(d.reply.n) % DEMO_REPLIES.length]);
        d.reply = { n:d.reply.n + 1, t:now2, head:demoFirstSentence(tx), len:tx.length, text:tx };
      }
    });
    PO.serverTime = now2;
    PO.setStatus(T('Demo office · fake workers'), 'demo', T('Fake workers are shown right now, not real ones. To turn this off: Settings > Advanced.'));
    PO.onState(PO.demoList, PO.demoGone);
  };
  tick(); demoTimer = setInterval(tick, q.get('hold') ? 3600000 : 4500);
  PO.demoTick = tick;
};
// Approval test: without opening Claude, puts the first fake worker in "onay bekliyor" (waiting for approval) for 30 s (tries the hologram, badge, beep, tab alert)
PO.testApproval = function () {
  if (!PO.demo) PO.startDemo();
  const d = PO.demoList && PO.demoList[0];
  if (!d) return false;
  d.forceWait = Date.now() / 1000 + 30;
  PO.demoTick();
  return true;
};
PO.stopDemo = function () {
  if (!PO.demo) return;
  PO.demo = false; clearInterval(demoTimer);
  window.dispatchEvent(new CustomEvent('po:demo', { detail:{ on:false } }));
  PO.setStatus(PO.t('Connecting…'), '');
  PO.activeSid = null; PO.onState([]); PO.poll();
};
if (q.get('demo') === '1') PO.startDemo();
if (q.get('sess') != null) setTimeout(() => { const g = PO.sessions[+q.get('sess')]; if (g) PO.switchSession(g.id); }, 150);
if (q.get('floor') != null) setTimeout(() => { PO.cam.moved = true; PO.focusFloor(+q.get('floor'), true); }, 200);
// development/test parameters: ?warp=60 (fast-forward s) &sel=2 (select the n-th agent) &tab=gal &cam=x,y,width &sess=1 (n-th building) &art=12 (gallery trial) &perf=1
if (q.get('lb') != null) setTimeout(() => { const it = (PO.galItems || [])[+q.get('lb')]; if (it) PO.openGallery(it); }, 800);
if (q.get('view') === 'all') setTimeout(() => PO.focusAll(true), 300);
if (q.get('seat') != null) PO.SEAT_DY = +q.get('seat');
if (q.get('warp')) setTimeout(() => window.__po.step(+q.get('warp')), 400);
if (q.get('cam')) setTimeout(() => { const c = q.get('cam').split(',').map(Number); PO.cam.moved = true; PO.focusZone(0, c[0], c[1], c[2], true); }, 500);
if (q.get('selid')) setTimeout(() => { PO.select(q.get('selid'), !q.get('cam')); if (q.get('tab')) PO.setTab(q.get('tab')); }, 900);
if (q.get('sel') != null) setTimeout(() => { const it = PO.serverList[+q.get('sel')]; if (it) { PO.select(it.id, !q.get('cam')); if (q.get('tab')) PO.setTab(q.get('tab')); } }, 700);

/* ------------------------------------------------------------------ main loop
   The camera is smoothed on every screen frame (60 Hz) → smooth scrolling. World drawing (agents, screens, lights) is sparser.
   Setting "Frame rate": Smooth ('smooth') ≈ 30 frames/s (≈ 15 when the window is in the background); Saver ('saver') is always ≈ 15 frames/s.
   When idle (camera still, nobody walking, no mouse/selection, no playing GIF) the world is drawn at ≈ 15 frames/s and the loop, instead of rAF,
   sleeps with setTimeout: CPU load drops; it wakes instantly when the user moves the mouse/presses a key/wheel. Floors off screen are never drawn. */
const IDLE_GAP = 66, CALM_MS = 1500;
let lastRaf = performance.now(), lastWorld = lastRaf, errShown = false, list = [];
const perf = { w:0, wn:0, b:0, bn:0, t:lastRaf, wf:0, bf:0, wms:0, bms:0 };
PO.perf = perf;
let saver = PO.settings.get('fps') === 'saver';
// Measurement strip (#perf): ?perf=1 or Settings > Advanced > "Show the measurement strip"
let perfEl = null;
function syncPerf() {
  const on = !!(q.get('perf') || PO.settings.get('perf'));
  if (on && !perfEl) { perfEl = document.createElement('div'); perfEl.id = 'perf'; perfEl.textContent = PO.t('measuring…'); $('#stage').appendChild(perfEl); }
  if (perfEl) perfEl.hidden = !on;
}
syncPerf();
PO.settings.onChange(path => {
  if (path === 'fps' || path === '*') { saver = PO.settings.get('fps') === 'saver'; PO.needRender = true; }
  if (path === 'perf' || path === '*') syncPerf();
  wake();                                                                             // every setting change (line color, motion…) wakes the sleeping loop at once
});

/* Idle? Did the workers (walking, elevator, teleport, door) move in the last 1.5 s → signal: agent fields + position signature
   (a position change is caught even if a field name changes). This check runs only each time the world is drawn (not per frame). */
let lastMotion = 0, motionSig = 0, animGal = false;
function scanMotion(now, ags) {
  let sig = 0, busy = false;
  for (const a of ags) {
    if ((a.path && a.path.length) || a.ride || a.hold > 0 || a.tele > 0 || a.leaving || a.waitDoor != null) busy = true;
    sig += a.x * 1.31 + a.y * 2.17 + (a.f || 0) * 97;
  }
  if (sig !== motionSig) { motionSig = sig; busy = true; }
  for (const d of PO.doors || []) if (d.hold > 0 || (d.open > 0.001 && d.open < 0.999)) busy = true;
  for (const v of PO.doorFlash || []) if (v > 0.01) busy = true;
  if (busy) lastMotion = now;
  animGal = PO.settings.get('gifs') !== false && (PO.galHits || []).some(h => h.it && h.it.anim);       // playing GIF / video on a visible floor
}
// if there is user interaction (over the mouse, selected worker, location marker) smooth drawing continues
const interacting = () => PO.hoverId != null || PO.selectedId != null || !!PO.hoverDeskKey || !!PO.hoverGalKey || PO.clock.t < (PO.pingUntil || 0);

let timer = 0, slept = false;
function wake() { if (timer) { clearTimeout(timer); timer = 0; requestAnimationFrame(frame); } }
PO.wake = wake;
['pointermove', 'pointerdown', 'wheel', 'keydown', 'touchstart'].forEach(ev => addEventListener(ev, wake, { passive:true, capture:true }));
{ const touch0 = PO.touch; if (touch0) PO.touch = function () { wake(); return touch0.apply(this, arguments); }; }          // wake without waiting when the camera/interaction starts

function frame(now) {
  timer = 0;
  let sleepMs = -1;
  try {
    const dtRaf = Math.min(slept ? 1 / 60 : 0.1, (now - lastRaf) / 1000); lastRaf = now; slept = false;          // after waking from sleep the camera must not jump on the first step
    PO.camStep(dtRaf);
    const active = PO.camMoving || now < PO.activeUntil;
    const calm = !active && now - lastMotion > CALM_MS && !animGal && !interacting();
    const gap = saver ? 64 : (active ? 30 : (calm ? IDLE_GAP : (document.hasFocus() ? 31 : 64)));
    const dr = PO.drawn, v = PO.view;
    const uncovered = !dr || Math.max(0, v.y0) < dr.y0 - 0.5 || Math.min(PO.H, v.y1) > dr.y1 + 0.5;
    let didWorld = false;
    if (PO.needRender || uncovered || now - lastWorld >= gap) {
      const dt = Math.min(0.5, (now - lastWorld) / 1000); lastWorld = now; PO.needRender = false;
      PO.clock.t += dt;
      PO.stepAgents(dt); PO.updateDoors(dt);
      list = [...PO.AG.values()];
      const t0 = performance.now();
      PO.render(dt, list);
      perf.w += performance.now() - t0; perf.wn++;
      didWorld = true;
      scanMotion(now, list);
    }
    if (didWorld || PO.camMoving || PO.needBlit) {
      const t1 = performance.now();
      PO.blit(list); PO.needBlit = false;
      perf.b += performance.now() - t1; perf.bn++;
    }
    if (window.__snap) { const f = window.__snap; window.__snap = null; f(); }
    if (now - perf.t > 1000) {
      perf.wf = perf.wn / ((now - perf.t) / 1000); perf.bf = perf.bn / ((now - perf.t) / 1000);
      perf.wms = perf.wn ? perf.w / perf.wn : 0; perf.bms = perf.bn ? perf.b / perf.bn : 0;
      if (perfEl && !perfEl.hidden) perfEl.textContent = PO.t('world {w} ms ×{wf}/s · blit {b} ms ×{bf}/s · {mode}', { w:perf.wms.toFixed(1), wf:perf.wf.toFixed(0), b:perf.bms.toFixed(1), bf:perf.bf.toFixed(0), mode:PO.t(saver ? 'saver' : calm ? 'idle' : 'smooth') });
      perf.w = perf.wn = perf.b = perf.bn = 0; perf.t = now;
    }
    // when to request the next frame: immediately when active (rAF), when idle/saving at a time near the next world drawing
    if (!active && !PO.needRender && !PO.needBlit && (calm || saver)) sleepMs = Math.max(0, gap - (performance.now() - lastWorld) - 6);
  } catch (e) {
    console.error(e);
    if (!errShown) { errShown = true; PO.setStatus(PO.t('Something went wrong while drawing. Refresh the page (F5).'), 'err'); }          // the raw error is above in console.error
  }
  if (sleepMs > 8) { slept = true; timer = setTimeout(() => { timer = 0; requestAnimationFrame(frame); }, sleepMs); }
  else requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// "Main office": closes the open gallery / replies / messages / settings panels and returns to the office view
{
  const homeBtn = document.getElementById('homeBtn');
  const isAny = () => {
    const o = (m, f) => { try { return !!(PO[m] && PO[m][f] && PO[m][f]()); } catch (e) { return false; } };
    const pop = document.getElementById('inboxpop'), rd = document.getElementById('reader');
    return o('gallery', 'isOpen') || o('chat', 'isOpen') || o('settingsUI', 'isOpen') || !!(pop && !pop.hidden) || !!(rd && !rd.hidden);
  };
  const sync = () => { if (!homeBtn) return; const any = isAny(); homeBtn.classList.toggle('on', !any); homeBtn.setAttribute('aria-pressed', any ? 'false' : 'true'); };
  if (homeBtn) {
    homeBtn.addEventListener('click', () => {
      const c = (m, f) => { try { if (PO[m] && PO[m][f]) PO[m][f](); } catch (e) { console.error(e); } };
      c('gallery', 'close'); c('chat', 'close'); c('settingsUI', 'close'); c('inbox', 'closeReader'); c('inbox', 'close');
      sync();
    });
    setInterval(sync, 250); sync();
  }
}

window.__po = {
  PO,
  force:l => { PO.demo = true; clearInterval(demoTimer); PO.demoList = l; PO.serverTime = Date.now() / 1000; PO.onState(l); },
  step:sec => { for (let i = 0; i < sec * 20; i++) { PO.clock.t += 0.05; PO.stepAgents(0.05); PO.updateDoors(0.05); } PO.needRender = true; },
  render:(dt = 0.016) => { PO.render(dt, [...PO.AG.values()]); PO.blit([...PO.AG.values()]); },
  snapWorld:() => PO.world.toDataURL('image/png'),
};
})(window.PO = window.PO || {});
