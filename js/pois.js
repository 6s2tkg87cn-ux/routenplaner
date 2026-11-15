// Stopps an der Strecke (Trinkwasser, Café, Einkehr, Supermarkt, Radladen) aus OpenStreetMap über Overpass.
import { pointAt, nearestIndex } from './routing.js';


export const POI_CATS = {
  wasser: { label: 'Trinkwasser', icon: '💧', filters: ['[amenity=drinking_water]', '[natural=spring][drinking_water=yes]'] },
  cafe: { label: 'Café und Bäcker', icon: '☕', filters: ['[amenity~"^(cafe|ice_cream)$"]', '[shop~"^(bakery|pastry)$"]'] },
  essen: { label: 'Einkehr', icon: '🍽️', filters: ['[amenity~"^(restaurant|biergarten|pub|fast_food)$"]'] },
  laden: { label: 'Supermarkt', icon: '🛒', filters: ['[shop~"^(supermarket|convenience)$"]'] },
  rad: { label: 'Radladen', icon: '🔧', filters: ['[shop=bicycle]', '[amenity=bicycle_repair_station]'] },
};

function categoryOf(t) {
  if (t.amenity === 'drinking_water' || t.natural === 'spring') return 'wasser';
  if (t.amenity === 'cafe' || t.amenity === 'ice_cream' || t.shop === 'bakery' || t.shop === 'pastry') return 'cafe';
  if (['restaurant', 'biergarten', 'pub', 'fast_food'].includes(t.amenity)) return 'essen';
  if (t.shop === 'supermarket' || t.shop === 'convenience') return 'laden';
  if (t.shop === 'bicycle' || t.amenity === 'bicycle_repair_station') return 'rad';
  return null;
}

export class PoiError extends Error {}

const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const cache = new WeakMap(); // Route -> { Kategorie: Stopps }

// Eine Anfrage an den ersten Server, der innerhalb von 12 Sekunden antwortet.
async function overpass(query, signal) {
  let lastStatus = 0;
  for (const url of SERVERS) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), signal: ctrl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (res.ok) return await res.json();
      lastStatus = res.status;
    } catch (e) {
      if (signal && signal.aborted) { const err = new Error('abgebrochen'); err.name = 'AbortError'; throw err; }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  throw new PoiError(lastStatus === 429 || lastStatus === 504 ? 'Der Dienst für die Stopps ist gerade ausgelastet. Versuche es gleich noch einmal.' : 'Die Stopps konnten nicht geladen werden.');
}

// Rechtecke um Streckenabschnitte von etwa 12 km: schnelle Flächenabfrage statt Suche entlang jeder Kurve
function boxes(route) {
  const n = Math.max(1, Math.min(10, Math.ceil(route.dist / 12000)));
  const out = [];
  for (let k = 0; k < n; k++) {
    const d0 = (route.dist * k) / n, d1 = (route.dist * (k + 1)) / n;
    let s = 90, w = 180, nn = -90, e = -180;
    for (let d = d0; d <= d1 + 1; d += Math.max(100, (d1 - d0) / 60)) {
      const p = pointAt(route, Math.min(d, d1));
      s = Math.min(s, p.lat); nn = Math.max(nn, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon);
    }
    const padLat = 0.003, padLon = 0.003 / Math.cos(s * Math.PI / 180);
    out.push(`(${(s - padLat).toFixed(4)},${(w - padLon).toFixed(4)},${(nn + padLat).toFixed(4)},${(e + padLon).toFixed(4)})`);
  }
  return out;
}

/** Sucht Stopps bis 200 m neben der Route. cats: Liste der gewünschten Kategorien. Ergebnisse werden je Route gemerkt. */
export async function fetchPois(route, cats, signal) {
  if (!cats.length) return [];
  let store = cache.get(route);
  if (!store) { store = {}; cache.set(route, store); }
  const missing = cats.filter((c) => !store[c]);
  if (missing.length) {
    const bb = boxes(route);
    const parts = missing.flatMap((c) => POI_CATS[c].filters.flatMap((f) => bb.map((b) => 'nw' + f + b + ';')));
    const json = await overpass('[out:json][timeout:20];(' + parts.join('') + ');out center tags 1500;', signal);
    const found = Object.fromEntries(missing.map((c) => [c, []]));
    const seen = new Set();
    const k = Math.cos(route.lat[0] * Math.PI / 180);
    for (const e of json.elements || []) {
      const lat = e.lat != null ? e.lat : e.center && e.center.lat, lon = e.lon != null ? e.lon : e.center && e.center.lon;
      const t = e.tags || {}, cat = categoryOf(t);
      if (lat == null || !cat || !found[cat]) continue;
      const i = nearestIndex(route, lat, lon);
      // höchstens rund 200 m neben der Strecke
      if (Math.hypot((route.lon[i] - lon) * k, route.lat[i] - lat) * 111320 > 200) continue;
      const key = cat + (t.name || '') + lat.toFixed(3) + lon.toFixed(3);
      if (seen.has(key)) continue;
      seen.add(key);
      found[cat].push({ lat, lon, cat, name: t.name || POI_CATS[cat].label, hours: t.opening_hours || '', d: route.cum[i] });
    }
    Object.assign(store, found);
  }
  return cats.flatMap((c) => store[c]).sort((a, b) => a.d - b.d);
}
