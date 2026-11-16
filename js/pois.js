// Stopps an der Strecke (Trinkwasser, Café, Einkehr, Supermarkt, Radladen) aus OpenStreetMap über Overpass.
import { pointAt, nearestIndex } from './routing.js';


export const POI_CATS = {
  wasser: { label: 'Trinkwasser', icon: '💧', filters: ['[amenity=drinking_water]', '[natural=spring][drinking_water=yes]'] },
  cafe: { label: 'Café und Bäcker', icon: '☕', filters: ['[amenity~"^(cafe|ice_cream)$"]', '[shop~"^(bakery|pastry)$"]'] },
  essen: { label: 'Einkehr', icon: '🍽️', filters: ['[amenity~"^(restaurant|biergarten|pub|fast_food)$"]', '[tourism=alpine_hut]'] },
  schlafen: { label: 'Übernachtung', icon: '🛏️', filters: ['[tourism~"^(alpine_hut|wilderness_hut|hotel|guest_house|hostel)$"]'] },
  camping: { label: 'Campingplatz', icon: '⛺', filters: ['[tourism~"^(camp_site|caravan_site)$"]'] },
  laden: { label: 'Supermarkt', icon: '🛒', filters: ['[shop~"^(supermarket|convenience)$"]'] },
  parken: { label: 'Parkplatz kostenlos', icon: '🅿️', filters: ['[amenity=parking][fee=no]', '[amenity=parking][!fee][access!~"^(private|customers|no|permit|delivery)$"]'] },
  sehens: { label: 'Sehenswertes', icon: '⭐', filters: ['[tourism~"^(viewpoint|attraction)$"]', '[historic~"^(castle|ruins|monument|archaeological_site)$"]', '[natural=peak][name]', '[waterway=waterfall]', '[natural=cave_entrance]'] },
  bahn: { label: 'Bahnhof', icon: '🚆', filters: ['[railway~"^(station|halt)$"]'] },
  rad: { label: 'Radladen', icon: '🔧', filters: ['[shop=bicycle]', '[amenity=bicycle_repair_station]'] },
};

// Ein Ort kann zu mehreren Kategorien gehören, z. B. eine Berghütte zu Einkehr und Übernachtung.
function categoriesOf(t) {
  const out = [];
  if (t.amenity === 'drinking_water' || t.natural === 'spring') out.push('wasser');
  if (t.amenity === 'cafe' || t.amenity === 'ice_cream' || t.shop === 'bakery' || t.shop === 'pastry') out.push('cafe');
  if (['restaurant', 'biergarten', 'pub', 'fast_food'].includes(t.amenity) || t.tourism === 'alpine_hut') out.push('essen');
  if (['alpine_hut', 'wilderness_hut', 'hotel', 'guest_house', 'hostel'].includes(t.tourism)) out.push('schlafen');
  if (t.tourism === 'camp_site' || t.tourism === 'caravan_site') out.push('camping');
  if (t.shop === 'supermarket' || t.shop === 'convenience') out.push('laden');
  if (t.shop === 'bicycle' || t.amenity === 'bicycle_repair_station') out.push('rad');
  if (t.tourism === 'viewpoint' || t.tourism === 'attraction' || /^(castle|ruins|monument|archaeological_site)$/.test(t.historic || '') ||
    (t.natural === 'peak' && t.name) || t.waterway === 'waterfall' || t.natural === 'cave_entrance') out.push('sehens');
  if (t.railway === 'station' || t.railway === 'halt') out.push('bahn');
  // Parkplätze: ausdrücklich kostenlos oder ohne Angabe zur Gebühr; private und Kundenparkplätze nicht
  if (t.amenity === 'parking' && (!t.fee || t.fee === 'no') && !/^(private|customers|no|permit|delivery)$/.test(t.access || '')) out.push('parken');
  return out;
}
// Gliederung der Auswahl in der App
export const POI_GROUPS = [['Verpflegung', ['wasser', 'cafe', 'essen', 'laden']], ['Übernachten und Anreise', ['schlafen', 'camping', 'parken', 'bahn']], ['Unterwegs', ['sehens', 'rad']]];
function sightKind(t) {
  if (t.natural === 'peak') return 'Gipfel' + (t.ele ? ', ' + Math.round(parseFloat(t.ele)) + ' m' : '');
  if (t.tourism === 'viewpoint') return 'Aussichtspunkt';
  if (t.historic === 'castle') return 'Burg oder Schloss';
  if (t.historic === 'ruins') return 'Ruine';
  if (t.historic === 'monument') return 'Denkmal';
  if (t.historic === 'archaeological_site') return 'Archäologische Stätte';
  if (t.waterway === 'waterfall') return 'Wasserfall';
  if (t.natural === 'cave_entrance') return 'Höhle';
  return 'Sehenswürdigkeit';
}
// Nur echte Web-Adressen übernehmen (Angaben in OpenStreetMap sind frei eingetragen)
function safeUrl(u) {
  if (!u) return '';
  const url = /^https?:\/\//i.test(u) ? u : 'https://' + u;
  try { const p = new URL(url); return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : ''; } catch (e) { return ''; }
}
const KIND = { alpine_hut: 'Berghütte', wilderness_hut: 'Schutzhütte ohne Bewirtung', hotel: 'Hotel', guest_house: 'Pension', hostel: 'Hostel', camp_site: 'Campingplatz', caravan_site: 'Wohnmobilstellplatz' };

export class PoiError extends Error {}

const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter', 'https://overpass.openstreetmap.fr/api/interpreter'];
const cache = new WeakMap(); // Route -> { Kategorie: Stopps }

// Fragt mehrere Server und nimmt die erste brauchbare Antwort. Die öffentlichen Server sind oft einzeln
// überlastet; so reicht es, wenn einer von ihnen gerade antwortet. Mit "stagger" (ms) starten die Server
// nacheinander: der nächste erst, wenn der vorige so lange nicht geantwortet hat oder gescheitert ist. Das
// schont die Server, die jede Abfrage sonst alle zu Ende rechnen und weitere Abfragen dann abweisen.
export async function overpass(query, signal, timeoutMs = 35000, maxServers = SERVERS.length, stagger = 0) {
  const ctrls = [], why = [];
  let busy = false, failed = 0, over = false;
  const t0 = Date.now();
  // wartet, bis Server i an der Reihe ist; false, wenn inzwischen eine Antwort da ist oder abgebrochen wurde
  const turn = async (i) => {
    while (stagger && !over && Date.now() - t0 < (i - failed) * stagger) await new Promise((f) => setTimeout(f, 150));
    return !over;
  };
  const ask = (url) => askOne(url).catch((e) => { why.push(new URL(url).hostname.split('.').slice(-2, -1)[0] + ': ' + (e.name === 'TypeError' ? 'keine Verbindung' : e.message)); throw e; });
  const askOne = async (url) => {
    const ctrl = new AbortController();
    ctrls.push(ctrl);
    const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), signal: ctrl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (!res.ok) { if (res.status === 429 || res.status === 504) busy = true; throw new Error('Status ' + res.status); }
    let json;
    try { json = await res.json(); } catch (e) { if (e.name === 'AbortError') throw e; throw new Error('unlesbare Antwort'); }
    if (!Array.isArray(json.elements)) throw new Error('keine Daten');
    // Abgebrochene Abfrage auf dem Server (Zeit oder Speicher überschritten) nicht als leeres Ergebnis werten
    if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) { busy = true; throw new Error(json.remark); }
    return json;
  };
  const stopAll = () => { over = true; ctrls.forEach((c) => c.abort()); };
  const timer = setTimeout(stopAll, timeoutMs);
  if (signal) signal.addEventListener('abort', stopAll);
  try {
    return await Promise.any(SERVERS.slice(0, maxServers).map(async (url, i) => {
      if (!(await turn(i))) throw new Error('nicht mehr nötig');
      try { return await ask(url); } catch (e) { failed++; throw e; }
    }));
  } catch (e) {
    if (signal && signal.aborted) { const err = new Error('abgebrochen'); err.name = 'AbortError'; throw err; }
    // Kurzer Grund je Server, damit sich die Ursache eingrenzen lässt
    throw new PoiError((busy ? 'Die Server für die Kartendaten sind gerade ausgelastet. Versuche es gleich noch einmal.' : 'Keiner der Server für die Kartendaten hat geantwortet.') +
      ' (' + why.join('; ').slice(0, 200) + ')');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', stopAll);
    stopAll();
  }
}

// Abstand eines Punkts zur Route in Metern (zu den Streckenstücken um den nächstgelegenen Streckenpunkt)
function distToRoute(route, i, lat, lon) {
  const k = Math.cos(lat * Math.PI / 180), M = 111320;
  let best = Infinity;
  for (let j = Math.max(0, i - 1); j < Math.min(route.n - 1, i + 1); j++) {
    const ax = (route.lon[j] - lon) * k * M, ay = (route.lat[j] - lat) * M;
    const bx = (route.lon[j + 1] - lon) * k * M, by = (route.lat[j + 1] - lat) * M;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return Number.isFinite(best) ? best : Math.hypot((route.lon[i] - lon) * k * M, (route.lat[i] - lat) * M);
}

// Rechtecke um Streckenabschnitte von etwa 12 km: schnelle Flächenabfrage statt Suche entlang jeder Kurve
function boxes(route, radius) {
  const n = Math.max(1, Math.min(10, Math.ceil(route.dist / 12000)));
  const out = [];
  for (let k = 0; k < n; k++) {
    const d0 = (route.dist * k) / n, d1 = (route.dist * (k + 1)) / n;
    let s = 90, w = 180, nn = -90, e = -180;
    for (let d = d0; d <= d1 + 1; d += Math.max(100, (d1 - d0) / 60)) {
      const p = pointAt(route, Math.min(d, d1));
      s = Math.min(s, p.lat); nn = Math.max(nn, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon);
    }
    const padLat = radius / 111320 + 0.0005, padLon = padLat / Math.cos(s * Math.PI / 180);
    out.push(`(${(s - padLat).toFixed(4)},${(w - padLon).toFixed(4)},${(nn + padLat).toFixed(4)},${(e + padLon).toFixed(4)})`);
  }
  return out;
}

/** Sucht Stopps bis "radius" Meter neben der Route. cats: Liste der gewünschten Kategorien. Ergebnisse werden je Route gemerkt. */
export async function fetchPois(route, cats, signal, radius = 300) {
  if (!cats.length) return [];
  let store = cache.get(route);
  // Bei größerem Umkreis als bisher geladen neu abfragen; kleinere Umkreise werden aus dem Vorhandenen gefiltert
  if (!store || store.radius < radius) { store = { radius, cats: {} }; cache.set(route, store); }
  const missing = cats.filter((c) => !store.cats[c]);
  if (missing.length) {
    const bb = boxes(route, store.radius);
    const parts = missing.flatMap((c) => POI_CATS[c].filters.flatMap((f) => bb.map((b) => 'nw' + f + b + ';')));
    const json = await overpass('[out:json][timeout:20];(' + parts.join('') + ');out center tags 1500;', signal);
    const found = Object.fromEntries(missing.map((c) => [c, []]));
    const seen = new Set();
    for (const e of json.elements || []) {
      const lat = e.lat != null ? e.lat : e.center && e.center.lat, lon = e.lon != null ? e.lon : e.center && e.center.lon;
      const t = e.tags || {}, mine = categoriesOf(t).filter((c) => found[c]);
      if (lat == null || !mine.length) continue;
      const i = nearestIndex(route, lat, lon);
      const off = distToRoute(route, i, lat, lon);
      if (off > store.radius) continue;
      for (const cat of mine) {
        const key = cat + (t.name || '') + lat.toFixed(3) + lon.toFixed(3);
        if (seen.has(key)) continue;
        seen.add(key);
        const parking = cat === 'parken';
        const kind = parking ? (t.fee === 'no' ? 'Kostenloser Parkplatz' : 'Parkplatz, Gebühr nicht angegeben')
          : cat === 'sehens' ? sightKind(t) : cat === 'bahn' ? (t.railway === 'halt' ? 'Haltepunkt' : 'Bahnhof') : KIND[t.tourism] || '';
        found[cat].push({ lat, lon, cat, name: t.name || (parking ? 'Parkplatz' : kind || POI_CATS[cat].label), kind,
          unsure: parking && t.fee !== 'no', hours: t.opening_hours || '', d: route.cum[i], off,
          web: safeUrl(t.website || t['contact:website'] || t.url), phone: t.phone || t['contact:phone'] || '' });
      }
    }
    Object.assign(store.cats, found);
  }
  // Gleicher Ort in zwei gewählten Kategorien: nur einmal anzeigen
  const shown = new Set();
  return cats.flatMap((c) => store.cats[c]).filter((q) => q.off <= radius).filter((q) => { const k = q.name + q.lat.toFixed(4) + q.lon.toFixed(4); if (shown.has(k)) return false; shown.add(k); return true; })
    .sort((a, b) => a.d - b.d);
}
