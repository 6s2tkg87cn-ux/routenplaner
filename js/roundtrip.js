// Automatische Rundtour: legt Wegpunkte auf einen Kreis durch den Start, routet hindurch
// und passt die Größe an, bis die Wunschlänge erreicht ist.
import { fetchRoute, RouteError, pointAt, haversine } from './routing.js';
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
// wird der Wegpunkt an die Stelle gezogen, an der sich Hin- und Rückweg trennen.
export function fixSpurs(route, vias) {
  let from = 0, changed = false;
  const out = vias.map((v) => {
    const idx = nearestFrom(route, v.lat, v.lon, from);
    from = idx;
    const d0 = route.cum[idx];
    const sep = (s) => {
      const a = pointAt(route, d0 - s), b = pointAt(route, d0 + s);
      return haversine(a.lat, a.lon, b.lat, b.lon);
    };
    if (sep(250) > 120) return v;
    let s = 250;
    while (s < 6000 && d0 - s > 0 && d0 + s < route.dist && sep(s) < 120) s += 150;
    const p = pointAt(route, Math.max(0, d0 - s));
    changed = true;
    return { lat: p.lat, lon: p.lon };
  });
  return { vias: out, changed };
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

  return { route: best.route, vias: best.vias, bearing: b, clockwise };
}

/**
 * Erzeugt Vorschläge für eine Rundtour.
 * direction: Grad (0 = Norden) oder null für beliebig. climb: 'flat' | 'any' | 'hilly'.
 */
export async function generateRoundTrips({ start, km, direction, climb, profile, options, nogos, signal, onProgress, wind }) {
  const target = km * 1000;
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

  // Wind: Runde so herum fahren, dass der Gegenwind am Anfang liegt und der Heimweg Rückenwind hat
  if (wind && wind.speed >= 8) {
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
  return top;
}
