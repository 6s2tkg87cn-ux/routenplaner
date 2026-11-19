// Leistung und Tempo auf dem Rad: Luft-, Roll- und Steigungswiderstand entlang der Strecke, mit Wind.
// Modell: gleichmäßig treten; wo das Tempo bergab zu hoch würde, wird weniger getreten oder gerollt und gebremst.
import { pointAt, BIKE, ROLL, VCAP } from './routing.js';

const G = 9.81;
const ETA = 0.97;          // Verluste im Antrieb (Kette, Lager): gemessen wird an der Kurbel
const WIND_HEIGHT = 0.6;   // Wind in Fahrerhöhe im Verhältnis zum Wert in 10 m Höhe (Hecken, Bäume, Häuser bremsen)
const RAD = Math.PI / 180;

/** Übliches Gewicht des Rads samt Flaschen und kleiner Tasche, kg */
export const BIKE_WEIGHT = { rennrad: 9, gravel: 11, alltag: 17 };

function bearing(a, b) {
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
  return Math.atan2(y, x) / RAD;
}

// Strecke in Stücke von 80 bis 200 m teilen (einmal je Strecke)
function segments(route) {
  if (route._segs) return route._segs;
  const step = Math.max(80, Math.min(200, route.dist / 1000)), out = [];
  let si = 0;
  for (let d = 0; d < route.dist; d += step) {
    const d1 = Math.min(route.dist, d + step), len = d1 - d;
    if (len < 1) break;
    const a = Math.max(0, d - 40), z = Math.min(route.dist, d1 + 40);
    const slope = route.hasEle ? (pointAt(route, z).ele - pointAt(route, a).ele) / (z - a) : 0;
    while (si < route.sections.length - 1 && route.sections[si].to < d + len / 2) si++;
    const surf = route.sections.length ? route.sections[si].surface : 'asphalt';
    const p0 = pointAt(route, d), p1 = pointAt(route, d1);
    out.push({ d: d + len / 2, len, slope: Math.max(-0.3, Math.min(0.3, slope)), surf, br: bearing(p0, p1), ele: route.hasEle ? (p0.ele + p1.ele) / 2 : 300 });
  }
  route._segs = out;
  return out;
}

// Werte je Stück, die sich während der Rechnung nicht ändern
function prepare(route, o) {
  const b = BIKE[o.profile] || BIKE.alltag, m = o.rider + o.bike, segs = segments(route);
  const wind = o.wind || null;
  let wi = 0;
  return segs.map((s) => {
    let hw = 0, temp = o.temp ?? 15;
    if (wind) {
      while (wi < wind.length - 1 && Math.abs(wind[wi + 1].d - s.d) <= Math.abs(wind[wi].d - s.d)) wi++;
      const w = wind[wi];
      // Anteil von vorn: positiv = Gegenwind, negativ = Rückenwind (Seitenwind zählt nicht)
      hw = ((w.wind * WIND_HEIGHT) / 3.6) * Math.cos((w.wdir - s.br) * RAD);
      if (w.temp != null) temp = w.temp;
    }
    const rho = 1.225 * Math.exp(-s.ele / 8500) * (288.15 / (273.15 + temp));
    let cap = Math.min(b.vmax, VCAP[s.surf] || 99) / 3.6;
    if (s.slope < -0.06) cap *= Math.max(0.45, 1 + (s.slope + 0.06) * 5);
    return { len: s.len, k: 0.5 * rho * b.cda, grade: m * G * s.slope, roll: m * G * b.crr * (ROLL[s.surf] || 1), hw, cap };
  });
}

// Fahrt mit gleichmäßiger Leistung P an der Kurbel
function ride(segs, P) {
  let T = 0, E = 0, air = 0, roll = 0, climb = 0, dist = 0;
  for (const s of segs) {
    const need = (v) => ((s.grade + s.roll) * v + s.k * (v + s.hw) * Math.abs(v + s.hw) * v) / ETA;
    let v, p;
    if (need(s.cap) <= P) { v = s.cap; p = Math.max(0, need(v)); } else {
      let lo = 0.3, hi = s.cap;
      for (let i = 0; i < 26; i++) { const mid = (lo + hi) / 2; if (need(mid) > P) hi = mid; else lo = mid; }
      v = (lo + hi) / 2; p = P;
    }
    if (v < 0.9) { v = 0.9; p = P; } // unter 3 km/h wird geschoben
    const t = s.len / v;
    T += t; E += p * t; dist += s.len;
    air += Math.max(0, s.k * (v + s.hw) * Math.abs(v + s.hw)) * s.len;
    roll += s.roll * s.len;
    climb += Math.max(0, s.grade) * s.len;
  }
  return { T, E, avgP: E / T, v: dist / T, P, air, roll, climb };
}

const MAX_P = 2000;

/**
 * Watt für einen Schnitt (km/h). o: { profile, rider, bike, wind, temp }
 * Liefert { avgP (Durchschnitt), P (beim Treten), T (s), v (m/s), E (J), air, roll, climb } oder null, wenn unerreichbar.
 */
export function powerForSpeed(route, kmh, o) {
  const segs = prepare(route, o), target = kmh / 3.6;
  if (ride(segs, MAX_P).v < target) return null;
  let lo = 0, hi = MAX_P;
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (ride(segs, mid).v < target) lo = mid; else hi = mid; }
  return ride(segs, hi);
}

/** Schnitt für eine Durchschnittsleistung (W). Gleiche Angaben wie oben. */
export function speedForPower(route, watts, o) {
  const segs = prepare(route, o);
  let lo = 0, hi = MAX_P;
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (ride(segs, mid).avgP < watts) lo = mid; else hi = mid; }
  return ride(segs, (lo + hi) / 2);
}
