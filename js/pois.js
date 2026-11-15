// Stopps an der Strecke (Trinkwasser, Café, Einkehr, Supermarkt, Radladen) aus OpenStreetMap über Overpass.
import { pointAt, nearestIndex } from './routing.js';

const OVERPASS = 'https://overpass-api.de/api/interpreter';

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

/** Sucht Stopps im Umkreis von 200 m um die Route. cats: Liste der gewünschten Kategorien. */
export async function fetchPois(route, cats, signal) {
  if (!cats.length) return [];
  const step = Math.max(400, route.dist / 110);
  const coords = [];
  for (let d = 0; d <= route.dist; d += step) { const p = pointAt(route, d); coords.push(p.lat.toFixed(4) + ',' + p.lon.toFixed(4)); }
  const end = pointAt(route, route.dist);
  coords.push(end.lat.toFixed(4) + ',' + end.lon.toFixed(4));
  const around = '(around:200,' + coords.join(',') + ')';
  const parts = cats.flatMap((c) => POI_CATS[c].filters.map((f) => 'nwr' + around + f + ';'));
  const query = '[out:json][timeout:25];(' + parts.join('') + ');out center tags 300;';
  let res;
  try {
    res = await fetch(OVERPASS, { method: 'POST', body: 'data=' + encodeURIComponent(query), signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new PoiError('Die Stopps konnten nicht geladen werden.');
  }
  if (!res.ok) throw new PoiError(res.status === 429 || res.status === 504 ? 'Der Dienst für die Stopps ist gerade ausgelastet. Versuche es gleich noch einmal.' : 'Die Stopps konnten nicht geladen werden.');
  const json = await res.json();
  const seen = new Set(), out = [];
  for (const e of json.elements || []) {
    const lat = e.lat != null ? e.lat : e.center && e.center.lat, lon = e.lon != null ? e.lon : e.center && e.center.lon;
    const t = e.tags || {}, cat = categoryOf(t);
    if (lat == null || !cat || !cats.includes(cat)) continue;
    const key = cat + (t.name || '') + lat.toFixed(3) + lon.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lat, lon, cat, name: t.name || POI_CATS[cat].label, hours: t.opening_hours || '', d: route.cum[nearestIndex(route, lat, lon)] });
  }
  return out.sort((a, b) => a.d - b.d);
}
