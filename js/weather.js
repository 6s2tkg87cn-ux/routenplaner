// Wetter und Wind entlang der Route (Open-Meteo, ohne Schlüssel).
import { pointAt } from './routing.js';

const API = 'https://api.open-meteo.com/v1/forecast';
const RAD = Math.PI / 180;
const cache = new Map(); // Schlüssel: gerundete Koordinaten -> { at, data }

export class WeatherError extends Error {}

/** Stündliche Vorhersage für mehrere Orte. Ergebnis je Ort: { time[], temp[], pprob[], precip[], code[], wind[], wdir[], gust[], sunrise[], sunset[] } */
export async function fetchForecast(points, signal) {
  const key = points.map((p) => p.lat.toFixed(2) + ',' + p.lon.toFixed(2)).join(';');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 20 * 60 * 1000) return hit.data;
  const url = API + '?latitude=' + points.map((p) => p.lat.toFixed(3)).join(',') + '&longitude=' + points.map((p) => p.lon.toFixed(3)).join(',') +
    '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
    '&daily=sunrise,sunset&forecast_days=7&timeformat=unixtime&timezone=GMT&wind_speed_unit=kmh';
  let res;
  try { res = await fetch(url, { signal }); } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new WeatherError('Die Wetterdaten sind gerade nicht erreichbar.');
  }
  if (!res.ok) throw new WeatherError('Die Wetterdaten sind gerade nicht erreichbar.');
  const json = await res.json();
  const list = Array.isArray(json) ? json : [json];
  const data = list.map((o) => {
    const hly = o.hourly || {}, d = o.daily || {};
    return {
      time: hly.time || [], temp: hly.temperature_2m || [], pprob: hly.precipitation_probability || [], precip: hly.precipitation || [],
      code: hly.weather_code || [], wind: hly.wind_speed_10m || [], wdir: hly.wind_direction_10m || [], gust: hly.wind_gusts_10m || [],
      sunrise: d.sunrise || [], sunset: d.sunset || [],
    };
  });
  if (!data.length || !data[0].time.length) throw new WeatherError('Für diese Strecke liegen keine Wetterdaten vor.');
  cache.set(key, { at: Date.now(), data });
  return data;
}

// Werte eines Orts zu einem Zeitpunkt (Unix-Sekunden); null außerhalb des Vorhersagezeitraums.
export function at(fc, t) {
  const n = fc.time.length;
  if (!n || t < fc.time[0] || t > fc.time[n - 1] + 3600) return null;
  let i = Math.min(n - 1, Math.max(0, Math.floor((t - fc.time[0]) / 3600)));
  const j = Math.min(n - 1, i + 1), f = Math.min(1, Math.max(0, (t - fc.time[i]) / 3600));
  const mix = (a) => (a[i] == null ? null : a[j] == null ? a[i] : a[i] + (a[j] - a[i]) * f);
  const near = f < 0.5 ? i : j;
  return { temp: mix(fc.temp), wind: mix(fc.wind), gust: mix(fc.gust), wdir: fc.wdir[near], pprob: fc.pprob[near], precip: fc.precip[near], code: fc.code[near] };
}

export function codeText(code) {
  if (code == null) return '';
  if (code === 0) return 'sonnig';
  if (code === 1) return 'überwiegend klar';
  if (code === 2) return 'wechselnd bewölkt';
  if (code === 3) return 'bedeckt';
  if (code === 45 || code === 48) return 'Nebel';
  if (code >= 51 && code <= 57) return 'Nieselregen';
  if (code === 61 || code === 80) return 'leichter Regen';
  if (code === 63 || code === 81) return 'Regen';
  if (code === 65 || code === 82) return 'starker Regen';
  if (code === 66 || code === 67) return 'gefrierender Regen';
  if (code >= 71 && code <= 77) return 'Schnee';
  if (code === 85 || code === 86) return 'Schneeschauer';
  if (code >= 95) return 'Gewitter';
  return 'wechselhaft';
}
export const isNight = (fc, t) => {
  for (let k = 0; k < fc.sunrise.length; k++) if (t >= fc.sunrise[k] && t <= fc.sunset[k]) return false;
  return true;
};
export function compass(deg) {
  return ['Nord', 'Nordost', 'Ost', 'Südost', 'Süd', 'Südwest', 'West', 'Nordwest'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

function bearing(a, b) {
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
  return Math.atan2(y, x) / RAD;
}

// Orte entlang der Route, für die Wetter abgefragt wird: etwa alle 10 km, höchstens 12.
export function samplePoints(route) {
  const n = Math.max(2, Math.min(12, Math.round(route.dist / 10000) + 1));
  const out = [];
  for (let i = 0; i < n; i++) { const d = (route.dist * i) / (n - 1); const p = pointAt(route, d); out.push({ d, lat: p.lat, lon: p.lon }); }
  return out;
}

/**
 * Wind und Temperatur entlang der Strecke, etwa jeden Kilometer, zu der Zeit, zu der man dort ist.
 * Liefert [{ d, wind (km/h, 10 m Höhe), wdir (woher, Grad), temp }] oder null außerhalb der Vorhersage.
 */
export function windProfile(route, samples, forecasts, start, speed) {
  const mps = speed / 3.6, n = Math.max(2, Math.min(300, Math.round(route.dist / 1000) + 1)), out = [];
  for (let i = 0; i < n; i++) {
    const d = (route.dist * i) / (n - 1);
    let best = 0;
    for (let k = 1; k < samples.length; k++) if (Math.abs(samples[k].d - d) < Math.abs(samples[best].d - d)) best = k;
    const w = at(forecasts[Math.min(best, forecasts.length - 1)], start + d / mps);
    if (!w || w.wind == null) return null;
    out.push({ d, wind: w.wind, wdir: w.wdir, temp: w.temp });
  }
  return out;
}

/**
 * Wertet Wetter und Wind für eine Fahrt aus.
 * start: Unix-Sekunden, speed: km/h, reverse: Strecke in Gegenrichtung fahren.
 * Liefert null, wenn die Fahrt außerhalb des Vorhersagezeitraums liegt.
 */
export function analyze(route, samples, forecasts, start, speed, reverse = false) {
  const mps = speed / 3.6, total = route.dist;
  const fcAt = (d) => {
    let best = 0;
    for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i].d - d) < Math.abs(samples[best].d - d)) best = i;
    return forecasts[Math.min(best, forecasts.length - 1)];
  };
  // d = Distanz in Fahrtrichtung; pos = Position auf der gespeicherten Strecke
  const pos = (d) => (reverse ? total - d : d);

  const NB = Math.max(20, Math.min(240, Math.round(total / 250)));
  const bins = [];
  let head = 0, tail = 0, side = 0, sumComp = 0, sumLate = 0, lateLen = 0, sumWind = 0, maxGust = 0;
  for (let i = 0; i < NB; i++) {
    const d0 = (total * i) / NB, d1 = (total * (i + 1)) / NB, mid = (d0 + d1) / 2;
    const w = at(fcAt(pos(mid)), start + mid / mps);
    if (!w || w.wind == null) return null;
    const br = bearing(pointAt(route, pos(d0)), pointAt(route, pos(d1)));
    // Anteil des Winds, der von vorn kommt: positiv = Gegenwind, negativ = Rückenwind
    const comp = w.wind * Math.cos((w.wdir - br) * RAD);
    const cls = w.wind < 6 ? 'side' : comp > 0.4 * w.wind ? 'head' : comp < -0.4 * w.wind ? 'tail' : 'side';
    const len = d1 - d0;
    if (cls === 'head') head += len; else if (cls === 'tail') tail += len; else side += len;
    sumComp += comp * len; sumWind += w.wind * len;
    if (mid > total / 2) { sumLate += comp * len; lateLen += len; }
    if (w.gust > maxGust) maxGust = w.gust;
    const last = bins[bins.length - 1];
    if (last && last.cls === cls) { last.to = d1; last.comp = (last.comp + comp) / 2; } else bins.push({ from: d0, to: d1, cls, comp, wind: w.wind, wdir: w.wdir });
  }

  const rows = [];
  let tMin = Infinity, tMax = -Infinity, maxProb = 0, rain = 0, firstWet = null, night = false;
  const dur = total / mps;
  const nRows = Math.max(2, Math.min(7, Math.round(total / 15000) + 1));
  for (let i = 0; i < nRows; i++) {
    const d = (total * i) / (nRows - 1), t = start + d / mps;
    const fc = fcAt(pos(d)), w = at(fc, t);
    if (!w) return null;
    const a = pointAt(route, pos(Math.max(0, d - 400))), b = pointAt(route, pos(Math.min(total, d + 400)));
    const comp = w.wind * Math.cos((w.wdir - bearing(a, b)) * RAD);
    const rel = w.wind < 6 ? 'kaum Wind' : comp > 0.4 * w.wind ? 'Gegenwind' : comp < -0.4 * w.wind ? 'Rückenwind' : 'Seitenwind';
    rows.push({ d, t, ...w, rel, night: isNight(fc, t) });
    if (w.temp < tMin) tMin = w.temp;
    if (w.temp > tMax) tMax = w.temp;
    if ((w.pprob || 0) > maxProb) maxProb = w.pprob || 0;
    if (firstWet == null && ((w.pprob || 0) >= 50 || (w.precip || 0) >= 0.3)) firstWet = { d, t };
    rain += (w.precip || 0) * (dur / 3600 / nRows);
    if (isNight(fc, t)) night = true;
  }
  const fc0 = fcAt(pos(0)), endT = start + dur;
  // nächster Sonnenuntergang nach der Abfahrt
  const sunset = fc0.sunset.find((s) => s > start) || null;

  return {
    bins: reverse ? bins.map((b) => ({ ...b, from: total - b.to, to: total - b.from })).reverse() : bins,
    rows, start, end: endT, tMin, tMax, maxProb, rain, firstWet, night, sunset,
    headShare: head / total, tailShare: tail / total, sideShare: side / total,
    meanComp: sumComp / total, lateComp: lateLen ? sumLate / lateLen : 0,
    wind: sumWind / total, gust: maxGust, wdir: rows[0].wdir, code: rows[0].code,
  };
}

// Bewertung einer Fahrt: kleiner ist besser (Regen, Gegenwind, Kälte/Hitze, Dunkelheit).
export function penalty(a) {
  if (!a) return Infinity;
  let p = 0;
  for (const r of a.rows) {
    p += ((r.pprob || 0) / 100) * 3 + Math.min(4, (r.precip || 0) * 2);
    if (r.code >= 95) p += 6;
    if (r.night) p += 5;
    if (r.temp < 5) p += (5 - r.temp) * 0.25; else if (r.temp > 28) p += (r.temp - 28) * 0.3;
    p += Math.max(0, r.gust - 45) * 0.08;
  }
  p /= a.rows.length;
  return p + Math.max(0, a.meanComp) * 0.06 + a.wind * 0.03;
}

/** Beste Startzeit am selben Tag: volle Stunden von 6 bis 20 Uhr (Ortszeit des Geräts). */
export function bestStart(route, samples, forecasts, dayStart, speed) {
  let best = null;
  for (let hh = 6; hh <= 20; hh++) {
    const t = dayStart + hh * 3600;
    if (t < Date.now() / 1000 - 1800) continue;
    const a = analyze(route, samples, forecasts, t, speed);
    // nur Startzeiten vorschlagen, bei denen die ganze Fahrt im Hellen liegt
    if (!a || a.night) continue;
    const p = penalty(a);
    if (!best || p < best.p - 1e-9) best = { t, p, a };
  }
  return best;
}

// Gegenwind-Anteil in der zweiten Streckenhälfte bei gleichbleibendem Wind (für die Rundtour-Ausrichtung).
export function lateHeadwind(route, windFrom, windSpeed, reverse = false) {
  const total = route.dist, NB = 60;
  let sum = 0;
  for (let i = NB / 2; i < NB; i++) {
    const d0 = (total * i) / NB, d1 = (total * (i + 1)) / NB;
    const a = pointAt(route, reverse ? total - d0 : d0), b = pointAt(route, reverse ? total - d1 : d1);
    sum += windSpeed * Math.cos((windFrom - bearing(a, b)) * RAD);
  }
  return sum / (NB / 2);
}
