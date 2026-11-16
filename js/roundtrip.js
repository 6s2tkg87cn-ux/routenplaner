// Automatische Rundtour: legt Wegpunkte auf einen Kreis durch den Start, routet hindurch
// und passt die Größe an, bis die Wunschlänge erreicht ist.
import { fetchRoute, RouteError, pointAt, haversine, projectOnRoute } from './routing.js';
import { lateHeadwind } from './weather.js';

const R = 6371008.8, RAD = Math.PI / 180;

export function destination(lat, lon, bearing, dist) {
  const d = dist / R, b = bearing * RAD, la = lat * RAD, lo = lon * RAD;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { lat: la2 / RAD, lon: lo2 / RAD };
}

export function compassName(bearing) {
  const names = ['Norden', 'Nordosten', 'Osten', 'Südosten', 'Süden', 'Südwesten', 'Westen', 'Nordwesten'];
  return names[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

// Drei Wegpunkte auf einem Kreis mit Radius r, der durch den Start geht und in Richtung "bearing" liegt.
function circleVias(start, bearing, r, clockwise) {
  const c = destination(start.lat, start.lon, bearing, r);
  return [1, 2, 3].map((k) => destination(c.lat, c.lon, bearing + 180 + (clockwise ? 1 : -1) * k * 90, r));
}

function nearestFrom(route, lat, lon, from) {
  let best = from, bestD = Infinity;
  const k = Math.cos(lat * RAD);
  for (let i = from; i < route.n; i++) {
    const dx = (route.lon[i] - lon) * k, dy = route.lat[i] - lat, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Stichstrecken entfernen: Führt die Route zu einem Wegpunkt hin und auf demselben Weg zurück,
// wird der Wegpunkt an die Stelle gezogen, an der die Stichstrecke von der Runde abzweigt.
// "fixed" nennt Wegpunkte, die bleiben müssen (z. B. der Wunschpunkt des Nutzers).
export function fixSpurs(route, vias, fixed = []) {
  let from = 0, changed = false;
  const out = vias.map((v) => {
    const idx = nearestFrom(route, v.lat, v.lon, from);
    from = idx;
    if (fixed.some((f) => f.lat === v.lat && f.lon === v.lon)) return v;
    const d0 = route.cum[idx];
    const sep = (s) => {
      const a = pointAt(route, d0 - s), b = pointAt(route, d0 + s);
      return haversine(a.lat, a.lon, b.lat, b.lon);
    };
    // Hin- und Rückweg liegen 80 m vor und hinter dem Wegpunkt noch praktisch aufeinander: Stichstrecke
    if (d0 < 80 || d0 > route.dist - 80 || sep(80) > 35) return v;
    let s = 80;
    while (s < 8000 && d0 - s > 0 && d0 + s < route.dist && sep(s) < 60) s += 40;
    const p = pointAt(route, Math.max(0, d0 - s - 20));
    changed = true;
    return { lat: p.lat, lon: p.lon };
  });
  return { vias: out, changed };
}

// Länge der Abschnitte, die doppelt befahren werden (hin und auf demselben Weg zurück), in Metern.
export function overlapLength(route) {
  const step = 60, cell = 0.0004, pts = [], grid = new Map();
  for (let d = 0; d <= route.dist; d += step) {
    const p = pointAt(route, d);
    const key = Math.round(p.lat / cell) + ':' + Math.round(p.lon / cell);
    pts.push({ d, lat: p.lat, lon: p.lon, cx: Math.round(p.lat / cell), cy: Math.round(p.lon / cell) });
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(pts.length - 1);
  }
  let n = 0;
  for (const a of pts) {
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx++) for (let dy = -1; dy <= 1 && !hit; dy++) {
      for (const j of grid.get((a.cx + dx) + ':' + (a.cy + dy)) || []) {
        const b = pts[j];
        if (Math.abs(a.d - b.d) < 400) continue;
        // Start und Ziel einer Runde liegen zwangsläufig aufeinander
        if (Math.min(a.d, b.d) < 200 && Math.max(a.d, b.d) > route.dist - 200) continue;
        if (haversine(a.lat, a.lon, b.lat, b.lon) < 30) { hit = true; break; }
      }
    }
    if (hit) n++;
  }
  return n * step;
}

// Stützpunkte, die einen neu gefundenen Rückweg festhalten: je ein Punkt in der Mitte jedes Stücks,
// auf dem der neue Weg vom alten abweicht (bei langen Stücken etwa alle 3 km).
export function pinsForDetour(newLeg, oldRoute) {
  const pins = [];
  let from = null;
  const flush = (to) => {
    if (from == null) return;
    const len = to - from, k = Math.max(1, Math.round(len / 3000));
    for (let i = 0; i < k; i++) { const p = pointAt(newLeg, from + (len * (i + 0.5)) / k); pins.push({ lat: p.lat, lon: p.lon, d: from + (len * (i + 0.5)) / k }); }
    from = null;
  };
  for (let d = 0; d <= newLeg.dist; d += 150) {
    const p = pointAt(newLeg, d);
    const differs = projectOnRoute(oldRoute, p.lat, p.lon).dist > 60;
    if (differs && from == null) from = d;
    if (!differs) flush(d);
  }
  flush(newLeg.dist);
  return pins;
}

/**
 * Macht aus einem Vorschlag eine echte Runde ohne doppelt befahrene Stücke. Zwei Mittel, mehrere Durchgänge:
 * 1. Stichstrecken zu Wegpunkten: Wegpunkt an den Abzweig ziehen.
 * 2. Rückweg auf dem Hinweg: Rückweg neu suchen, während der Hinweg gesperrt ist, und mit Stützpunkten festhalten.
 * Von allen Zwischenständen gewinnt der mit der kürzesten Doppelstrecke (bei passender Länge).
 */
async function removeOverlap(c, { start, target, profile, options, nogos, signal, fixed = [] }) {
  const full = (vias) => fetchRoute({ profile, options, nogos, signal, points: [start, ...vias, start] });
  const okLen = (r) => Math.abs(r.dist / target - 1) < 0.15;
  let best = { route: c.route, vias: c.vias, overlap: overlapLength(c.route) };
  const consider = (route, vias) => {
    const overlap = overlapLength(route);
    if (okLen(route) && overlap < best.overlap - 60) best = { route, vias, overlap };
    return overlap;
  };
  // Stichstrecken in bis zu drei Durchgängen entfernen
  const despur = async (state) => {
    let cur = state;
    for (let i = 0; i < 3; i++) {
      const f = fixSpurs(cur.route, cur.vias, fixed);
      if (!f.changed) break;
      const r = await full(f.vias);
      cur = { route: r, vias: f.vias };
      consider(r, f.vias);
    }
    return cur;
  };
  try {
    await despur(best);
    const small = () => best.overlap < Math.max(250, best.route.dist * 0.01);
    if (!small() && best.vias.length >= 2 && best.vias.length <= 9) {
      const b0 = best, midIdx = Math.floor(b0.vias.length / 2), mid = b0.vias[midIdx];
      let from = 0, dMid = 0;
      b0.vias.slice(0, midIdx + 1).forEach((v) => { dMid = projectOnRoute(b0.route, v.lat, v.lon, from).d; from = dMid; });
      const blocks = [];
      for (let d = 500; d < dMid - 300; d += 200) { const p = pointAt(b0.route, d); blocks.push({ lat: p.lat, lon: p.lon, radius: 35 }); }
      if (blocks.length) {
        const back = await fetchRoute({ profile, options, signal, nogos: [...nogos, ...blocks], points: [mid, ...b0.vias.slice(midIdx + 1), start] });
        let f2 = 0;
        const tail = b0.vias.slice(midIdx + 1).map((v) => { const d = projectOnRoute(back, v.lat, v.lon, f2).d; f2 = d; return { lat: v.lat, lon: v.lon, d }; });
        const merged = [...tail, ...pinsForDetour(back, b0.route)].sort((x, y) => x.d - y.d).map((v) => ({ lat: v.lat, lon: v.lon }));
        const vias = [...b0.vias.slice(0, midIdx + 1), ...merged];
        if (vias.length <= 12) {
          const r = await full(vias);
          consider(r, vias);
          // Stützpunkte können selbst Stichstrecken erzeugen: gleich wieder bereinigen
          await despur({ route: r, vias });
        }
      }
    }
  } catch (e) { if (e.name === 'AbortError') throw e; }
  c.route = best.route; c.vias = best.vias; c.overlap = best.overlap;
}

async function buildCandidate({ start, target, bearing, clockwise, profile, options, nogos, signal }) {
  const route = (vias) => fetchRoute({ profile, options, nogos, signal, points: [start, ...vias, start] });
  const off = (r) => Math.abs(r.dist / target - 1);
  let r = target / (5.66 * 1.3), best = null, fails = 0, b = bearing;

  for (let iter = 0; iter < 3; iter++) {
    const vias = circleVias(start, b, r, clockwise);
    let res;
    try {
      res = await route(vias);
    } catch (e) {
      // Ein Wegpunkt liegt z. B. im Wasser oder abseits aller Wege: Kreis leicht drehen und verkleinern
      if (!(e instanceof RouteError) || ++fails > 3) throw e;
      b += 14; r *= 0.94; iter--;
      continue;
    }
    if (!best || off(res) < off(best.route)) best = { route: res, vias };
    if (off(res) < 0.06) break;
    r *= Math.pow(target / res.dist, 0.9);
  }
  if (!best) throw new RouteError('Kein Vorschlag möglich.');

  // Stichstrecken entfernen und, falls nötig, die Länge einmal nachziehen
  try {
    const fixed = fixSpurs(best.route, best.vias);
    if (fixed.changed) {
      let res = await route(fixed.vias), vias = fixed.vias;
      if (off(res) > 0.08) {
        const f = Math.pow(target / res.dist, 0.9);
        const scaled = vias.map((v) => ({ lat: start.lat + (v.lat - start.lat) * f, lon: start.lon + (v.lon - start.lon) * f }));
        try { const res2 = await route(scaled); if (off(res2) < off(res)) { res = res2; vias = scaled; } } catch (e) { if (e.name === 'AbortError') throw e; }
      }
      if (off(res) < Math.max(0.12, off(best.route) + 0.03)) best = { route: res, vias };
    }
  } catch (e) { if (e.name === 'AbortError') throw e; }

  return { route: best.route, vias: best.vias, bearing: b, clockwise, kind: 'round' };
}

function bearingDeg(a, b) {
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
  return Math.atan2(y, x) / RAD;
}

/**
 * Umwege von A nach B mit Wunschlänge: ein oder zwei Wegpunkte seitlich der direkten Linie,
 * so weit ausgelenkt, dass die Route die gewünschte Länge bekommt.
 */
export async function generateDetours({ start, end, km, directDist, profile, options, nogos, signal, onProgress }) {
  const target = km * 1000;
  const d = haversine(start.lat, start.lon, end.lat, end.lon);
  const direct = directDist || d * 1.25;
  if (target < direct * 1.08) throw new RouteError('Die Wunschlänge ist kaum länger als der direkte Weg (' + Math.round(direct / 1000) + ' km). Gib eine größere Länge ein.');
  const br = bearingDeg(start, end);
  const lerp = (t) => ({ lat: start.lat + (end.lat - start.lat) * t, lon: start.lon + (end.lon - start.lon) * t });
  const off = (r) => Math.abs(r.dist / target - 1);
  const route = (vias) => fetchRoute({ profile, options, nogos, signal, points: [start, ...vias, end] });
  const shapes = [{ side: 1, n: 1 }, { side: -1, n: 1 }, { side: 1, n: 2 }, { side: -1, n: 2 }];
  let done = 0;

  const build = async ({ side, n }) => {
    const geom = (hh) => (n === 1 ? 2 * Math.hypot(d / 2, hh) : 2 * Math.hypot(d / 3, hh) + d / 3);
    const solve = (f) => {
      const g = target / f;
      const v = n === 1 ? (g / 2) ** 2 - (d / 2) ** 2 : ((g - d / 3) / 2) ** 2 - (d / 3) ** 2;
      return Math.sqrt(Math.max(0, v));
    };
    const viasAt = (hh, turn) => (n === 1 ? [0.5] : [1 / 3, 2 / 3]).map((t) => { const m = lerp(t); return destination(m.lat, m.lon, br + 90 * side + turn, hh); });
    let f = Math.max(1.05, direct / Math.max(d, 1)), best = null, fails = 0, turn = 0;
    for (let iter = 0; iter < 3; iter++) {
      const hh = solve(f) * (1 - 0.06 * fails);
      if (hh < 200) break;
      const vias = viasAt(hh, turn);
      let res;
      try { res = await route(vias); } catch (e) {
        if (!(e instanceof RouteError) || ++fails > 3) throw e;
        turn += 12; iter--;
        continue;
      }
      if (!best || off(res) < off(best.route)) best = { route: res, vias };
      if (off(res) < 0.06) break;
      f = res.dist / geom(hh);
    }
    if (!best) throw new RouteError('Kein Vorschlag möglich.');
    try {
      const fixed = fixSpurs(best.route, best.vias);
      if (fixed.changed) { const res = await route(fixed.vias); if (off(res) < Math.max(0.12, off(best.route) + 0.03)) best = { route: res, vias: fixed.vias }; }
    } catch (e) { if (e.name === 'AbortError') throw e; }
    return { ...best, kind: 'detour', name: 'Umweg über ' + compassName(br + 90 * side) + (n === 2 ? ', weiter Bogen' : ''), score: -off(best.route) };
  };

  const settled = await Promise.allSettled(shapes.map((s) => build(s).finally(() => { done++; if (onProgress) onProgress(done, shapes.length); })));
  if (signal && signal.aborted) { const e = new Error('abgebrochen'); e.name = 'AbortError'; throw e; }
  const cands = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  if (!cands.length) {
    const first = settled.find((s) => s.status === 'rejected');
    throw first && first.reason instanceof RouteError ? first.reason : new RouteError('Für diese Strecke wurde kein Umweg gefunden.');
  }
  return cands.sort((a, b) => b.score - a.score).slice(0, 3);
}

// Runde über einen Wunschpunkt: Start und Wunschpunkt liegen sich gegenüber, zwei seitliche Wegpunkte
// spannen den Hin- und den Rückweg auf (eine Raute). Ihre Auslenkung bestimmt die Länge.
async function viaRoundTrips({ start, via, target, climb, profile, options, nogos, signal, onProgress, wind }) {
  const L = haversine(start.lat, start.lon, via.lat, via.lon);
  if (L < 300) throw new RouteError('Der Wunschpunkt liegt zu nah am Start.');
  if (target < L * 2 * 1.15) throw new RouteError('Der Wunschpunkt ist für diese Länge zu weit weg: Hin und zurück sind schon etwa ' + Math.round((L * 2.5) / 1000) + ' km.');
  const br = bearingDeg(start, via);
  const mid = (t) => ({ lat: start.lat + (via.lat - start.lat) * t, lon: start.lon + (via.lon - start.lon) * t });
  const off = (r) => Math.abs(r.dist / target - 1);
  const route = (v) => fetchRoute({ profile, options, nogos, signal, points: [start, ...v, start] });
  // a, b: Verhältnis der Auslenkung von Hin- und Rückweg; side: auf welcher Seite der Hinweg liegt
  const shapes = [{ a: 1, b: 1, side: 1 }, { a: 1, b: 1, side: -1 }, { a: 1.5, b: 0.5, side: 1 }, { a: 0.5, b: 1.5, side: 1 }];
  let done = 0;
  const build = async ({ a, b, side }) => {
    const geom = (w) => 2 * Math.hypot(L / 2, w * a) + 2 * Math.hypot(L / 2, w * b);
    const viasAt = (w) => {
      const m = mid(0.5);
      return [destination(m.lat, m.lon, br + 90 * side, Math.max(50, w * a)), { lat: via.lat, lon: via.lon }, destination(m.lat, m.lon, br - 90 * side, Math.max(50, w * b))];
    };
    let f = 1.3, best = null, fails = 0;
    for (let iter = 0; iter < 3; iter++) {
      // Auslenkung, bei der die Raute mal Umwegfaktor die Wunschlänge ergibt (Halbierungsverfahren)
      let lo = 0, hi = target;
      for (let k = 0; k < 30; k++) { const w = (lo + hi) / 2; if (geom(w) * f > target) hi = w; else lo = w; }
      const w = lo * (1 - 0.08 * fails);
      const vias = viasAt(w);
      let res;
      try { res = await route(vias); } catch (e) {
        if (!(e instanceof RouteError) || ++fails > 3) throw e;
        iter--;
        continue;
      }
      if (!best || off(res) < off(best.route)) best = { route: res, vias };
      if (off(res) < 0.06) break;
      f = res.dist / geom(w);
    }
    if (!best) throw new RouteError('Kein Vorschlag möglich.');
    const wide = a > b ? side : b > a ? -side : 0;
    return { ...best, kind: 'round', bearing: br, clockwise: side > 0,
      name: 'Über ' + (via.label || 'Wunschpunkt').split(',')[0] + (wide ? ', weiter Bogen im ' + compassName(br + 90 * wide) : side > 0 ? ', Hinweg im ' + compassName(br + 90) : ', Hinweg im ' + compassName(br - 90)) };
  };
  const settled = await Promise.allSettled(shapes.map((s) => build(s).finally(() => { done++; if (onProgress) onProgress(done, shapes.length); })));
  if (signal && signal.aborted) { const e = new Error('abgebrochen'); e.name = 'AbortError'; throw e; }
  const cands = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  if (!cands.length) {
    const first = settled.find((s) => s.status === 'rejected');
    throw first && first.reason instanceof RouteError ? first.reason : new RouteError('Über diesen Punkt wurde keine Rundtour gefunden.');
  }
  const perKm = cands.map((c) => c.route.ascent / (c.route.dist / 1000)), lo = Math.min(...perKm), hi = Math.max(...perKm);
  const sign = climb === 'hilly' ? 1 : climb === 'flat' ? -1 : 0;
  cands.forEach((c, i) => { c.score = -off(c.route) * 4 + sign * (hi > lo ? (perKm[i] - lo) / (hi - lo) : 0.5); });
  cands.sort((x, y) => y.score - x.score);
  const top = cands.slice(0, 3);
  await Promise.all(top.map((c) => removeOverlap(c, { start, target, profile, options, nogos, signal, fixed: [via] })));
  top.sort((x, y) => ((x.overlap || 0) - (y.overlap || 0) > 300 ? 1 : (y.overlap || 0) - (x.overlap || 0) > 300 ? -1 : 0));
  await orientForWind(top, wind, { start, target, profile, options, nogos, signal });
  return top;
}

// Wind: Runde so herum fahren, dass der Gegenwind am Anfang liegt und der Heimweg Rückenwind hat
async function orientForWind(top, wind, { start, target, profile, options, nogos, signal }) {
  if (!wind || wind.speed < 8) return;
  await Promise.all(top.map(async (c) => {
    const fwd = lateHeadwind(c.route, wind.from, wind.speed), rev = lateHeadwind(c.route, wind.from, wind.speed, true);
    let late = fwd;
    if (rev < fwd - 2) {
      try {
        const vias = [...c.vias].reverse();
        const r = await fetchRoute({ profile, options, nogos, signal, points: [start, ...vias, start] });
        if (Math.abs(r.dist / target - 1) < Math.abs(c.route.dist / target - 1) + 0.06) {
          c.route = r; c.vias = vias; c.clockwise = !c.clockwise;
          late = lateHeadwind(r, wind.from, wind.speed);
        }
      } catch (e) { if (e.name === 'AbortError') throw e; }
    }
    c.windNote = late < -2 ? 'Rückenwind auf dem Heimweg' : late > 2 ? 'Gegenwind auf dem Heimweg' : '';
  }));
}

/**
 * Erzeugt Vorschläge für eine Rundtour.
 * direction: Grad (0 = Norden) oder null für beliebig. climb: 'flat' | 'any' | 'hilly'.
 */
export async function generateRoundTrips({ start, km, direction, climb, profile, options, nogos, signal, onProgress, wind, via }) {
  const target = km * 1000;
  if (via) return viaRoundTrips({ start, via, target, climb, profile, options, nogos, signal, onProgress, wind });
  // Ohne Wunschrichtung und bei spürbarem Wind geht es zuerst gegen den Wind hinaus:
  // Der fernste Punkt liegt dann dort, wo der Wind herkommt, und der Heimweg hat Rückenwind.
  const windy = wind && wind.speed >= 8;
  if (direction == null && windy) direction = wind.from;
  const base = direction == null ? Math.random() * 360 : direction + (Math.random() * 16 - 8);
  const bearings = direction == null ? [0, 90, 180, 270].map((d) => base + d) : [-50, -17, 17, 50].map((d) => base + d);
  let done = 0;
  const jobs = bearings.map((bearing, i) => buildCandidate({ start, target, bearing, clockwise: i % 2 === 0, profile, options, nogos, signal })
    .finally(() => { done++; if (onProgress) onProgress(done, bearings.length); }));
  const settled = await Promise.allSettled(jobs);
  if (signal && signal.aborted) { const e = new Error('abgebrochen'); e.name = 'AbortError'; throw e; }
  const cands = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  if (!cands.length) {
    const first = settled.find((s) => s.status === 'rejected');
    throw first && first.reason instanceof RouteError ? first.reason : new RouteError('Für diesen Start wurde keine Rundtour gefunden. Versuche eine andere Länge oder Richtung.');
  }

  // Bewertung: Wunschlänge treffen, dazu die Höhenmeter-Vorliebe
  const perKm = cands.map((c) => c.route.ascent / (c.route.dist / 1000));
  const lo = Math.min(...perKm), hi = Math.max(...perKm);
  const sign = climb === 'hilly' ? 1 : climb === 'flat' ? -1 : 0;
  cands.forEach((c, i) => {
    const rel = hi > lo ? (perKm[i] - lo) / (hi - lo) : 0.5;
    c.score = -Math.abs(c.route.dist / target - 1) * 4 + sign * rel;
    c.name = 'Richtung ' + compassName(c.bearing);
  });
  cands.sort((a, b) => b.score - a.score);
  const top = cands.slice(0, 3);
  await Promise.all(top.map((c) => removeOverlap(c, { start, target, profile, options, nogos, signal })));
  top.sort((x, y) => ((x.overlap || 0) - (y.overlap || 0) > 300 ? 1 : (y.overlap || 0) - (x.overlap || 0) > 300 ? -1 : 0));
  await orientForWind(top, wind, { start, target, profile, options, nogos, signal });
  return top;
}
