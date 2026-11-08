'use strict';
/* Pixel Office — agents: who sits where, when they walk, how they change floors by elevator, when they teleport.
   Rule: an agent owns its desk; even when its job is done it waits at its desk (✓ on its screen), occasionally goes on a break,
   and when it gets a job again (or a message is written to it) it teleports to its desk wherever it is. */
(function (PO) {
const AG = new Map();
PO.AG = AG;
PO.clock = { t:0 };
const SPEED = 58;
const REST_KINDS = ['sofa', 'arm', 'arcade', 'balcony', 'stand'];
const T = () => PO.clock.t;
const rnd = PO.rnd;
const S = k => (PO.settings ? PO.settings.get(k) : undefined);
// break frequency (setting): "Rarely" lengthens the intervals, "Often" shortens them
const BREAK_SCALE = { rare:2.4, normal:1, often:0.45 };
const breakScale = () => BREAK_SCALE[S('breakRate')] || 1;
const breaksOn = () => S('breaks') !== false;
// test parameter: ?rest=sofa|arm|arcade|balcony → those whose job is done go straight to that break spot
const TEST_REST = new URLSearchParams(location.search).get('rest');
const isRest = p => !!(p && REST_KINDS.includes(p.kind));
const holdDoor = f => { if (f != null && PO.doors[f]) PO.doors[f].hold = 0.7; };

// when the "break frequency" setting changes, recompute the pending break times
if (PO.settings) PO.settings.onChange(p => { if (p === 'breakRate' || p === '*') for (const a of AG.values()) a.breakAfter = (a.doneFor || 0) + rnd(18, 60) * breakScale(); });

function pickChar(id) {
  const used = new Set([...AG.values()].map(a => a.char));
  const S = PO.STAFF, start = PO.hash(id) % S.length;
  for (let k = 0; k < S.length; k++) { const c = S[(start + k) % S.length]; if (!used.has(c)) return c; }
  return S[start];
}
// character: assigned by the server (info.char, fixed); if missing/invalid, the old fallback pick
function charFromInfo(info, boss) {
  const c = info && info.char, ch = c && PO.AT && PO.AT.chars[c];
  return ch && !!ch.boss === !!boss ? c : null;
}
function bossChar(session) {
  const b = PO.BOSSES.filter(Boolean);
  return b.length ? b[PO.hash(String(session)) % b.length] : null;
}
function freeDeskIn(type) {
  for (const fl of PO.floorsOf(type)) for (const p of fl.desks || []) if (!p.owner) return p;
  return null;
}
function deskFor(a) {
  const pref = a.info.dept === 'tasarim' ? 'tasarim' : 'kod';
  return freeDeskIn(pref) || freeDeskIn(pref === 'kod' ? 'tasarim' : 'kod');
}
function tryAssignDesk(a) {
  if (a.desk || a.boss) return;
  const d = deskFor(a);
  if (d) { d.owner = a.id; a.desk = d; }
}
function releaseDesk(a) { if (a.desk) { a.desk.owner = null; a.desk = null; } }
function releasePlace(a) { if (a.place) { if (a.place.who === a.id) a.place.who = null; a.place = null; } }
function freeStand(a) { return PO.PL.stand.find(p => !p.who || p.who === a.id) || null; }

PO.newAgent = function (info, opts = {}) {
  const door = PO.doorNode;
  const a = { id:info.id, info, boss:false, char:null, f:PO.lobbyIdx, x:door.x, y:door.y, dir:'south', path:[], place:null, target:null, at:door,
              leaving:false, walkT:0, doneFor:0, restUntil:0, breakMode:0, away:false, breakAfter:rnd(18, 60), desk:null, office:null, state:info.state, since:T(), spawnT:T(),
              hidden:false, ride:null, waitDoor:null, dispState:null, dispSince:0, label:info.label, tele:0, hold:0 };
  if (!info.sub) {
    const o = PO.PL.office.find(p => !p.owner);
    const ch = charFromInfo(info, true) || bossChar(info.session || info.id);
    if (o && ch) { o.owner = a.id; a.office = o; a.boss = true; a.char = ch; }
  }
  if (!a.char) a.char = charFromInfo(info, false) || pickChar(info.id);
  tryAssignDesk(a);
  if (opts.instant) placeInstant(a);
  else {
    // those arriving at the same time enter through the door one after another
    PO.spawnAt = Math.max(PO.spawnAt || 0, T()) + 0.9;
    a.hold = Math.max(0, PO.spawnAt - 0.9 - T());
    if (!a.hold) PO.doorFlash[PO.lobbyIdx] = 1;
  }
  return a;
};

// place it in its own spot from where it is without walking at all (when the building is rebuilt, the tab changes, the page opens)
function placeInstant(a) {
  releasePlace(a);
  a.path = []; a.ride = null; a.hidden = false; a.hold = 0; a.target = null; a.waitDoor = null;
  let p = a.boss ? a.office : a.desk;
  if (!p && !a.boss) p = freeStand(a);
  if (!p) return;
  p.who = a.id; a.place = p; a.target = p;
  a.x = p.x; a.y = p.y; a.f = p.f; a.dir = p.face; a.at = p.access;
}

function goTo(a, place) {
  if (!place || a.target === place || a.place === place) return;
  if (a.ride) { a.goalAfter = place; return; }
  if (a.target && a.target.who === a.id) a.target.who = null;
  const wasSeated = !!a.place;
  releasePlace(a);
  place.who = a.id;
  a.target = place;
  const start = wasSeated || !a.path.length ? (a.at || PO.doorNode) : PO.nearestNode(a.x, a.y, a.f);
  const ns = PO.route(start, place.access);
  const pts = ns ? PO.toPath(ns) : [{ x:place.access.x, y:place.access.y, f:place.access.f }];
  pts.push({ x:place.x, y:place.y, f:place.f });
  a.path = pts;
  a.at = place.access;
}
PO.goTo = goTo;

// teleport: a light column at the old place and the new place, a brief appearance at the new place
function teleportTo(a, place) {
  if (!place) return;
  if (PO.fxBeam && !a.hidden) PO.fxBeam(a.x, a.y);
  if (a.target && a.target.who === a.id) a.target.who = null;
  releasePlace(a);
  a.path = []; a.ride = null; a.hidden = false; a.waitDoor = null; a.hold = 0; a.goalAfter = null; a.restUntil = 0; a.breakMode = 0;
  place.who = a.id; a.place = place; a.target = place;
  a.x = place.x; a.y = place.y; a.f = place.f; a.dir = place.face; a.at = place.access; a.tele = 0.5; a.walkT = 0;
  if (PO.fxBeam) PO.fxBeam(a.x, a.y);
}
PO.teleportTo = teleportTo;

function leave(a) {
  if (a.leaving) return;
  a.leaving = true;
  if (a.target && a.target.who === a.id) a.target.who = null;
  releasePlace(a);
  releaseDesk(a);
  if (a.office) { a.office.owner = null; a.office = null; }
  if (a.ride) { a.goalAfter = null; return; }
  const start = a.path.length ? PO.nearestNode(a.x, a.y, a.f) : (a.at || PO.doorNode);
  const ns = PO.route(start, PO.doorNode);
  a.path = ns ? PO.toPath(ns) : [];
  a.target = null;
  PO.doorFlash[PO.lobbyIdx] = 1;
}

function restCandidates(a) {
  const PL = PO.PL, free = list => list.filter(p => !p.who || p.who === a.id);
  const out = [];
  free(PL.sofa).forEach(p => out.push([p, 3]));
  free(PL.arm).forEach(p => out.push([p, 1.5]));
  free(PL.arcade).forEach(p => out.push([p, 1.2]));
  free(PL.balcony).forEach(p => out.push([p, 2]));
  free(PL.stand).filter(p => !p.extra).forEach(p => out.push([p, 0.7]));
  return out.filter(([p]) => p !== a.place);
}
function pickRest(a) {
  let c = restCandidates(a);
  if (TEST_REST) { const t = c.filter(([p]) => p.kind === TEST_REST); if (t.length) c = t; }
  if (!c.length) { a.breakAfter = a.doneFor + 30; return; }
  const sum = c.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * sum, pick = c[0][0];
  for (const [p, w] of c) { r -= w; if (r <= 0) { pick = p; break; } }
  goTo(a, pick);
  a.away = true;                   // left its desk: teleports if work comes
  a.breakMode = 1;                 // 1: walking to the break, 2: on break (starts when the time is up: the walk can take long)
  a.restUntil = 0;
}

function think(a, dt) {
  if (a.leaving) return;
  const st = a.info.state;
  if (st !== a.state) { a.state = st; a.since = T(); }
  // short state changes must not flicker in the drawing: at the moment of waiting, others after at least 1 s
  if (a.dispState !== st && (st === 'waiting' || !a.dispState || T() - a.dispSince > 1.0)) { a.dispState = st; a.dispSince = T(); }
  if (a.boss) { if (a.office) goTo(a, a.office); return; }
  if (st !== 'done') {
    a.doneFor = 0; a.restUntil = 0; a.breakMode = 0; a.breakAfter = rnd(18, 60) * breakScale();
    tryAssignDesk(a);
    if (a.desk) {
      if (a.place !== a.desk) {
        if (a.away || isRest(a.place) || isRest(a.target)) { teleportTo(a, a.desk); a.away = false; }   // work came while on a break / on the way: teleport to the desk
        else if (a.target !== a.desk) goTo(a, a.desk);                                                   // new arrival: walk there
      } else a.away = false;
    } else if (!a.place || a.place.kind !== 'stand') { const s = freeStand(a); if (s) goTo(a, s); }   // if there is no desk, wait in the lobby
  } else {
    a.doneFor += dt;
    const home = a.desk && a.place === a.desk && !a.path.length && !a.ride;
    if (home) a.away = false;
    if (!breaksOn()) {                                                          // "Idle workers take a break now and then" is off: those on a break return to their desk, nobody goes out
      if (a.breakMode) { a.breakMode = 0; a.restUntil = 0; if (a.desk) goTo(a, a.desk); }
    } else if (home && !a.breakMode && (TEST_REST || a.doneFor > a.breakAfter)) {
      if (TEST_REST || Math.random() < 0.55) pickRest(a);                      // occasionally goes on a break
      else a.breakAfter = a.doneFor + rnd(25, 70) * breakScale();
    } else if (a.breakMode === 1 && isRest(a.place) && !a.path.length && !a.ride) {
      a.breakMode = 2; a.restUntil = TEST_REST ? 1e9 : T() + rnd(14, 28);                        // arrived at the break spot: the timer starts now
    } else if (a.breakMode === 2 && T() > a.restUntil) {
      a.breakMode = 0; a.restUntil = 0; a.breakAfter = a.doneFor + rnd(30, 80) * breakScale();  // break over: walk back to the desk
      if (a.desk) goTo(a, a.desk);
    } else if (!a.desk && !a.place && !a.target && !a.path.length) {
      const s = freeStand(a); if (s) goTo(a, s);
    }
  }
}

function startRide(a, p) {
  a.ride = { t:p.t, f:p.f, x:p.x, y:p.y };
  a.hidden = true; a.walkT = 0;
  holdDoor(a.f);
}
function endRide(a) {
  const r = a.ride;
  a.f = r.f; a.x = r.x; a.y = r.y; a.ride = null; a.hidden = false;
  PO.doorFlash[a.f] = 1;
  if (a.goalAfter) { const g = a.goalAfter; a.goalAfter = null; if (!a.leaving) { a.path = []; a.target = null; a.at = PO.elevIn[a.f]; goTo(a, g); } }
}

function move(a, dt) {
  if (a.tele > 0) a.tele = Math.max(0, a.tele - dt);
  if (a.hold > 0) { a.hold -= dt; a.hidden = true; if (a.hold <= 0) { a.hidden = false; PO.doorFlash[PO.lobbyIdx] = 1; } return; }
  if (a.ride) { a.ride.t -= dt; if (a.ride.t <= 0) endRide(a); return; }
  if (a.waitDoor != null) {
    holdDoor(a.waitDoor);
    if (PO.doors[a.waitDoor].open >= 0.9) a.waitDoor = null; else { a.walkT = 0; return; }
  }
  if (!a.path.length) {
    a.walkT = 0;
    if (a.leaving) { removeAgent(a); return; }
    if (a.target && !a.place) { a.place = a.target; a.dir = a.target.face; a.arrivedAt = T(); }
    return;
  }
  const p = a.path[0];
  if (p.op === 'ride') { startRide(a, p); a.path.shift(); return; }
  if (p.op === 'enter' || p.op === 'call' || p.op === 'exit') holdDoor(p.f != null ? p.f : a.f);
  if (p.f != null && p.f !== a.f && p.op === 'exit') a.f = p.f;
  const dx = p.x - a.x, dy = p.y - a.y, d = Math.hypot(dx, dy);
  if (d < 1.2) {
    a.x = p.x; a.y = p.y; a.path.shift();
    if (p.f != null) a.f = p.f;
    if (p.op === 'call' || p.op === 'exit') a.waitDoor = a.f;
    return;
  }
  const mv = Math.min(d, SPEED * dt);
  a.x += dx / d * mv; a.y += dy / d * mv;
  a.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'south' : 'north');
  a.walkT += dt;
}

function removeAgent(a) {
  if (a.target && a.target.who === a.id) a.target.who = null;
  releasePlace(a); releaseDesk(a);
  if (a.office) { a.office.owner = null; a.office = null; }
  AG.delete(a.id);
}

// open state of the elevator doors
PO.updateDoors = function (dt) {
  PO.doors.forEach((d, f) => {
    d.hold = Math.max(0, d.hold - dt);
    const target = d.hold > 0 ? 1 : 0;
    d.open += (target - d.open) * Math.min(1, dt * 6);
    if (Math.abs(target - d.open) < 0.01) d.open = target;
    PO.doorFlash[f] = Math.max(0, PO.doorFlash[f] - dt * 1.4);
  });
};

PO.stepAgents = function (dt) {
  for (const a of [...AG.values()]) { think(a, dt); move(a, dt); }
};

// if an agent that was leaving the office comes back (the list may have been missing it for a moment), settle it again
function revive(a) {
  a.leaving = false; a.target = null; a.path = a.ride ? a.path : [];
  if (a.boss && !a.office) {
    const o = PO.PL.office.find(p => !p.owner);
    if (o) { o.owner = a.id; a.office = o; } else a.boss = false;
  }
  a.at = a.ride ? a.at : (PO.nearestNode(a.x, a.y, a.f) || PO.doorNode);
}

// apply the info from the server to the agents. opts.instant: new agents sit at their places without walking in through the door
PO.applyInfos = function (list, opts = {}) {
  const seen = new Set();
  const ordered = opts.instant ? list.slice().sort((p, q) => (p.started || 0) - (q.started || 0)) : list;
  for (const info of ordered) {
    seen.add(info.id);
    let a = AG.get(info.id);
    if (!a) { a = PO.newAgent(info, opts); AG.set(info.id, a); }
    else if (a.leaving) revive(a);
    a.info = info; a.leaving = false; a.label = info.label;
    { const c = charFromInfo(info, a.boss); if (c && c !== a.char) a.char = c; }     // if the server reports the character later (fixed), follow it
  }
  for (const a of AG.values()) if (!seen.has(a.id)) leave(a);
};
PO.resetAgents = function () { AG.clear(); };

// worker display names: the server (and demo mode) gives the Turkish names in assets/names.json (nick, kind_tr);
// in English mode they are replaced here with the nick_en / types_en fields. Stays fixed per worker (matched by character + base name, the "Hayalet 2" suffix is kept);
// does not change when called again. Character ids and Turkish fields are not touched.
PO.localizeInfo = function (info) {
  const NM = PO.NAMES;
  if (!info || !NM || PO.lang === 'tr') return info;
  const m = /^(.*?)( \d+)?$/.exec(String(info.nick || '')), base = m ? m[1] : '', suffix = (m && m[2]) || '';
  if (base) {
    const all = (NM.staff || []).concat(NM.bosses || []);
    const e = all.find(x => x.nick_en && x.nick === base && x.char === info.char) || all.find(x => x.nick_en && x.nick === base);
    if (e) info.nick = e.nick_en + suffix;
    else if (base === NM.type_default_tr && NM.type_default_en) info.nick = NM.type_default_en + suffix;      // the server's fallback name ("Çalışan", i.e. Worker)
  }
  if (info.kind_tr) {
    const k = Object.keys(NM.types_tr || {}).find(x => NM.types_tr[x] === info.kind_tr);
    if (k && NM.types_en && NM.types_en[k]) info.kind_tr = NM.types_en[k];
    else if (info.kind_tr === NM.type_default_tr && NM.type_default_en) info.kind_tr = NM.type_default_en;
  }
  return info;
};

// for the camera when the user clicks an agent: the current position
PO.agentPos = a => ({ x:a.x, y:a.y - 24 });

// counts per floor (for the floor selector)
PO.floorStats = function () {
  const n = PO.FL.length;
  const out = Array.from({ length:n }, () => ({ total:0, work:0, wait:0, rest:0 }));
  for (const a of AG.values()) {
    if (a.leaving || (a.hidden && !a.ride)) continue;
    const f = PO.clamp(a.ride ? a.ride.f : a.f, 0, n - 1);
    const s = out[f]; s.total++;
    if (a.state === 'waiting') s.wait++; else if (a.state === 'done') s.rest++; else s.work++;
  }
  return out;
};
})(window.PO = window.PO || {});
