'use strict';
/* Pixel Office — tower: builds a building from the floor list (floor types can repeat), sitting/standing spots, road network (including elevator), route. */
(function (PO) {
const DESKS_PER_FLOOR = 8, ART_PER_GALLERY = 14, DESIGN_FRAMES = 5, MAX_PER_TYPE = 3;
PO.DESKS_PER_FLOOR = DESKS_PER_FLOOR; PO.ART_PER_GALLERY = ART_PER_GALLERY; PO.DESIGN_FRAMES = DESIGN_FRAMES; PO.MAX_PER_TYPE = MAX_PER_TYPE;

/* Floor list by the number of agents and images of a session (top to bottom).
   Each type starts with one floor; a floor is added when the desks (8/floor) or images (gallery 14/floor) fill up. At most 3 floors of each. */
PO.layoutFor = function (infos, artCount) {
  let nKod = 0, nTas = 0;
  (infos || []).forEach(i => { if (!i.sub) return; if (i.dept === 'tasarim') nTas++; else nKod++; });
  const kodF = PO.clamp(Math.ceil(nKod / DESKS_PER_FLOOR), 1, MAX_PER_TYPE), tasF = PO.clamp(Math.ceil(nTas / DESKS_PER_FLOOR), 1, MAX_PER_TYPE);
  const galF = artCount > DESIGN_FRAMES ? PO.clamp(Math.ceil(artCount / ART_PER_GALLERY), 1, MAX_PER_TYPE) : 0;   // when the design floor's frames are not enough, a gallery opens
  return ['mudur', ...Array(kodF).fill('kod'), ...Array(tasF).fill('tasarim'), ...Array(galF).fill('galeri'), 'lobi'];
};

PO.buildTower = function (order) {
  const SC = PO.SC, E = SC.elev, FH = SC.fh;
  const nodes = new Map();
  const nk = (f, x, y) => f + ':' + x + ',' + y;
  function node(f, x, y) { const k = nk(f, x, y); if (!nodes.has(k)) nodes.set(k, { f, x, y, k, adj:new Map() }); return nodes.get(k); }
  function link(a, b, w, ride) {
    const d = w != null ? w : Math.hypot(a.x - b.x, a.y - b.y);
    a.adj.set(b.k, { to:b, w:d, ride:!!ride }); b.adj.set(a.k, { to:a, w:d, ride:!!ride });
  }
  function lane(f, pts) { let prev = null; for (const [x, y] of pts) { const n = node(f, x, y); if (prev && prev !== n) link(prev, n); prev = n; } }

  const n = order.length;
  const floors = order.map((type, i) => {
    const spec = SC.types[type], y0 = SC.top + i * FH;
    const same = order.filter(t => t === type).length, k = order.slice(0, i + 1).filter(t => t === type).length;
    const sfx = same > 1 ? ' ' + k : '';
    return { i, type, k, key:type + ':' + k, y0, spec, acc:(PO.TH && PO.TH.acc[type]) || spec.acc, theme:spec.theme, laneY:y0 + SC.lane, name:(PO.FLOOR_NAME[type] || spec.name) + sfx, short:(PO.FLOOR_SHORT[type] || spec.name) + sfx };
  });
  PO.FL = floors; PO.order = order.slice(); PO.H = SC.top + n * FH + SC.bot;
  PO.nodes = nodes;
  PO.lobbyIdx = floors.findIndex(f => f.type === 'lobi');
  PO.floorsOf = type => floors.filter(f => f.type === type);
  PO.floorOfY = y => PO.clamp(Math.floor((y - SC.top) / FH), 0, n - 1);

  const PL = { desk:[], office:[], sofa:[], arm:[], arcade:[], balcony:[], stand:[], podium:[] };
  PO.PL = PL;
  const elevFront = [], elevIn = [];
  floors.forEach(fl => {
    const f = fl.i, ly = fl.laneY;
    elevFront[f] = node(f, E.cx, fl.y0 + E.frontY); elevFront[f].front = true;
    elevIn[f] = node(f, E.cx, fl.y0 + E.inY); elevIn[f].door = true;
    link(elevFront[f], elevIn[f]);
    link(node(f, E.cx, ly), elevFront[f]);
  });
  for (let f = 0; f + 1 < n; f++) link(elevIn[f], elevIn[f + 1], 70 + 60, true);
  PO.elevFront = elevFront; PO.elevIn = elevIn;
  PO.doors = floors.map(() => ({ open:0, hold:0 }));
  PO.doorFlash = floors.map(() => 0);

  floors.forEach(fl => {
    const f = fl.i, ly = fl.laneY, sp = fl.spec, y0 = fl.y0;
    if (fl.type === 'kod' || fl.type === 'tasarim') {
      fl.desks = sp.desks.map((d, i) => {
        const p = { kind:'desk', f, i, key:fl.key + '#' + i, dx:d.x, dy:y0 + d.y, x:d.x, y:y0 + d.y + 16, face:'north', who:null, owner:null };
        p.access = node(f, p.x, ly);
        PL.desk.push(p);
        return p;
      });
      lane(f, [[40, ly], ...sp.desks.map(d => [d.x, ly]), [E.cx, ly]]);
      if (sp.gallery) fl.gallery = sp.gallery.map(g => ({ x:g.x, y:y0 + g.y, w:g.w, h:g.h }));
    } else if (fl.type === 'mudur') {
      const o = sp.office, deskY = y0 + o.deskY, seatY = deskY - 44;
      const p = { kind:'office', f, i:0, key:fl.key + '#0', deskX:o.deskX, deskY, x:o.deskX, y:seatY, face:'south', who:null, owner:null, sideX:o.sideX };
      p.access = node(f, o.sideX, seatY);
      link(p.access, node(f, o.sideX, ly));
      PL.office.push(p);
      lane(f, [[40, ly], [o.sideX, ly], [E.cx, ly]]);
    } else if (fl.type === 'galeri') {
      fl.wall = sp.wall.map(g => ({ x:g.x, y:y0 + g.y, w:g.w, h:g.h }));
      fl.podiums = sp.podiums.map(p => ({ x:p.x, y:y0 + p.y }));
      lane(f, [[40, ly], [E.cx, ly]]);
    } else if (fl.type === 'lobi') {
      const L = sp;
      fl.door = [L.door[0], y0 + L.door[1]];
      fl.sofa = { x:L.sofa.x, y:y0 + L.sofa.y, seats:L.sofa.seats };
      fl.table = { x:L.table.x, y:y0 + L.table.y };
      fl.armchairs = L.armchairs.map(a => ({ x:a.x, y:y0 + a.y }));
      fl.lamps = L.lamps.map(a => ({ x:a.x, y:y0 + a.y }));
      fl.arcade = { x:L.arcade.x, y:y0 + L.arcade.y };
      fl.vape = { x:L.vape.x, y:y0 + L.vape.y };
      fl.balconySpots = L.balconySpots.map(b => ({ x:b.x, y:y0 + b.y }));
      fl.balconyDoor = [L.balconyDoor[0], y0 + L.balconyDoor[1]];
      fl.reception = { x:L.reception.x, y:y0 + L.reception.y };
      fl.frontLane = y0 + L.frontLane; fl.sideX = L.sideX;
      fl.board = { x0:L.board.x0, y0:y0 + L.board.y0, x1:L.board.x1, y1:y0 + L.board.y1 };
      const fy = fl.frontLane;
      fl.sofa.seats.forEach((dx, i) => {
        const p = { kind:'sofa', f, i, x:fl.sofa.x + dx, y:fl.sofa.y + 1, face:'south', who:null };
        p.access = node(f, p.x, fy);
        PL.sofa.push(p);
      });
      const sx = fl.sideX, sx2 = fl.sofa.x + (fl.sofa.x - fl.sideX);
      lane(f, [[sx, ly], [sx, fy], ...fl.sofa.seats.map(d => [fl.sofa.x + d, fy]), [sx2, fy], [sx2, ly]]);
      fl.armchairs.forEach((a, i) => {
        const p = { kind:'arm', f, i, ax:a.x, ay:a.y, x:a.x, y:a.y + 7, face:'south', who:null };
        p.access = node(f, p.x, ly);
        PL.arm.push(p);
      });
      { const p = { kind:'arcade', f, x:fl.arcade.x, y:fl.arcade.y + 18, face:'north', who:null }; p.access = node(f, p.x, ly); PL.arcade.push(p); }
      const bd = fl.balconyDoor, by = y0 + 104;
      fl.balconySpots.forEach((b, i) => {
        const p = { kind:'balcony', f, i, x:b.x, y:b.y, face:'east', who:null };
        p.access = node(f, b.x, by);
        PL.balcony.push(p);
      });
      lane(f, [[bd[0], ly], [bd[0], bd[1]], [bd[0], by]]);
      lane(f, [...fl.balconySpots.map(b => [b.x, by]), [bd[0], by]].sort((a, b) => a[0] - b[0]));
      [110, 150, 205, 255, 305, 690, 730, 770].forEach((x, i) => {
        const p = { kind:'stand', f, i, x, y:y0 + 234, face:'south', who:null };
        p.access = node(f, x, ly);
        PL.stand.push(p);
      });
      // in a crowd (more than 8 waiting standing) a second row: shifted between the gaps of the first row, a bit forward. Those going on a break are not picked here (extra).
      const STAND2 = [130, 178, 230, 280, 710, 750, 790];
      STAND2.forEach((x, i) => {
        const p = { kind:'stand', f, i:8 + i, x, y:y0 + 248, face:'south', who:null, extra:true };
        p.access = node(f, x, ly);
        PL.stand.push(p);
      });
      lane(f, [[fl.door[0], fl.door[1]], [fl.door[0], ly]]);
      const laneXs = [fl.door[0], 110, 150, 205, 255, 305, sx, fl.armchairs[0].x, fl.sofa.x, sx2, fl.armchairs[1].x, fl.arcade.x, 690, 730, 770, ...STAND2, bd[0], E.cx];
      lane(f, [...new Set(laneXs)].sort((a, b) => a - b).map(x => [x, ly]));
      PO.doorNode = node(f, fl.door[0], fl.door[1]);
    }
  });
  PO.lobby = floors[PO.lobbyIdx];
  // text: each floor's name + its number in the building (counted from the ground)
  floors.forEach(fl => { fl.num = n - fl.i; });
  PO.towerVersion = (PO.towerVersion || 0) + 1;
};

/* ---- route ---- */
PO.route = function (from, to) {
  if (from === to) return [from];
  const nodes = PO.nodes;
  const dist = new Map([[from.k, 0]]), prev = new Map(), open = new Set([from.k]), done = new Set();
  while (open.size) {
    let bk = null, bd = Infinity;
    for (const k of open) if (dist.get(k) < bd) { bd = dist.get(k); bk = k; }
    open.delete(bk); done.add(bk);
    if (bk === to.k) break;
    for (const [k2, e] of nodes.get(bk).adj) {
      if (done.has(k2)) continue;
      const nd = bd + e.w;
      if (nd < (dist.has(k2) ? dist.get(k2) : Infinity)) { dist.set(k2, nd); prev.set(k2, bk); open.add(k2); }
    }
  }
  if (!dist.has(to.k)) return null;
  const out = []; let k = to.k;
  while (k !== undefined) { out.unshift(nodes.get(k)); k = prev.get(k); }
  return out;
};
// convert the node list into walking points (elevator: call → enter → ride down → exit)
PO.toPath = function (ns) {
  const pts = [];
  for (let i = 0; i < ns.length; i++) {
    const n = ns[i], prev = ns[i - 1], next = ns[i + 1];
    if (prev && prev.f !== n.f) {
      pts.push({ op:'ride', f:n.f, t:0.9 + 0.55 * Math.abs(n.f - prev.f), x:n.x, y:n.y });
      pts.push({ x:n.x, y:n.y, f:n.f, op:'exit' });
      continue;
    }
    const p = { x:n.x, y:n.y, f:n.f };
    if (n.front) p.op = 'call';
    else if (n.door && next && next.f !== n.f) p.op = 'enter';
    pts.push(p);
  }
  return pts;
};
PO.nearestNode = function (x, y, f) {
  let best = null, bd = Infinity;
  for (const n of PO.nodes.values()) { if (f != null && n.f !== f) continue; const d = Math.hypot(n.x - x, n.y - y); if (d < bd) { bd = d; best = n; } }
  return best;
};
})(window.PO = window.PO || {});
