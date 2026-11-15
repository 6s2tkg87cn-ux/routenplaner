// Offline-Touren: Strecke und Stopps in IndexedDB, Kartenteile der Standardkarte im Cache-Speicher.
// Der Service Worker (sw.js) liefert die gespeicherten Kartenteile aus, wenn kein Netz da ist.

const DB = 'rueckenwind', STORE = 'offline';
const MAX_TILES = 2800; // der Kartenanbieter erlaubt höchstens 3.000 Kacheln je Download

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req && req.result); };
    t.onerror = t.onabort = () => { db.close(); reject(t.error); };
  });
}
export const getOffline = (id) => tx('readonly', (s) => s.get(id));
export const listOffline = () => tx('readonly', (s) => s.getAll());
const putOffline = (rec) => tx('readwrite', (s) => s.put(rec));
const cacheName = (id) => 'rw-off-' + id;

// Kartenteile tragen im Pfad eine Versionsnummer (Datum). Für den Offline-Speicher wird sie entfernt,
// damit gespeicherte Teile auch nach einem Karten-Update des Anbieters gefunden werden. (Gleiche Regel in sw.js.)
export const canon = (url) => url.replace(/\/\d{8}_[^/]+\//g, '/_/');

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };

// Alle Kacheln einer Zoomstufe, die den Streifen (Puffer in Metern) um die Route berühren
function tilesAlong(route, z, buffer) {
  const set = new Set(), n = 2 ** z;
  const add = (lat, lon) => { const x = lon2x(lon, z), y = lat2y(lat, z); if (x >= 0 && y >= 0 && x < n && y < n) set.add(x + '/' + y); };
  const tileM = (40075000 * Math.cos((route.lat[0] * Math.PI) / 180)) / n;
  const step = Math.max(150, Math.min(tileM / 3, buffer / 2));
  let next = 0;
  for (let i = 0; i < route.n; i++) {
    if (route.cum[i] < next && i < route.n - 1) continue;
    next = route.cum[i] + step;
    const lat = route.lat[i], lon = route.lon[i], dLat = buffer / 111320, dLon = dLat / Math.cos((lat * Math.PI) / 180);
    add(lat, lon);
    for (const f of [0.5, 1]) for (let a = 0; a < 8; a++) add(lat + dLat * f * Math.sin((a * Math.PI) / 4), lon + dLon * f * Math.cos((a * Math.PI) / 4));
  }
  return [...set];
}

const OPS = new Set(['get', 'literal', 'coalesce', 'to-string', 'case', 'match', 'step', 'concat', 'format', 'interpolate', 'zoom', 'has', 'all', 'any']);
function fontStacks(style) {
  const out = new Set();
  const walk = (v, top) => {
    if (!Array.isArray(v) || !v.length) return;
    if (v[0] === 'literal' && Array.isArray(v[1])) { out.add(v[1].join(',')); return; }
    if (top && v.every((e) => typeof e === 'string') && !OPS.has(v[0])) { out.add(v.join(',')); return; }
    v.forEach((e) => walk(e, false));
  };
  for (const l of style.layers || []) { const f = l.layout && l.layout['text-font']; if (f) walk(f.stops ? f.stops.map((s) => ['literal', s[1]]) : f, true); }
  return [...out];
}

async function getJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('Die Kartendaten sind nicht erreichbar (' + res.status + ').');
  return res.json();
}

/** Stellt zusammen, was für eine Tour heruntergeladen wird: Kartenstil, Schriften, Symbole und Kartenteile. */
export async function planDownload(route, styleUrl, signal) {
  const style = await getJson(styleUrl, signal);
  const fixed = [styleUrl]; // Dateien, die unabhängig von der Route gebraucht werden
  const sources = [];
  for (const s of Object.values(style.sources || {})) {
    let tiles = s.tiles, maxzoom = s.maxzoom, minzoom = s.minzoom || 0;
    if (s.url) {
      const tj = await getJson(s.url, signal);
      fixed.push(s.url);
      tiles = tj.tiles; maxzoom = tj.maxzoom; minzoom = tj.minzoom || 0;
    }
    if (tiles && tiles.length && (s.type === 'vector' || s.type === 'raster')) sources.push({ type: s.type, template: tiles[0], maxzoom: maxzoom == null ? 14 : maxzoom, minzoom });
  }
  if (!sources.length) throw new Error('Der Kartenstil enthält keine ladbaren Kartenteile.');
  if (typeof style.sprite === 'string') for (const sfx of ['.json', '.png', '@2x.json', '@2x.png']) fixed.push(style.sprite + sfx);
  else if (Array.isArray(style.sprite)) for (const sp of style.sprite) for (const sfx of ['.json', '.png', '@2x.json', '@2x.png']) fixed.push(sp.url + sfx);
  if (style.glyphs) for (const stack of fontStacks(style)) for (const range of ['0-255', '256-511', '8192-8447']) fixed.push(style.glyphs.replace('{fontstack}', stack).replace('{range}', range));

  // Streifenbreite: 2 km je Seite; bei sehr langen Touren schmaler, damit die Obergrenze des Anbieters hält
  let buffer = 2000, tiles = [];
  for (const b of [2000, 1000, 500, 250]) {
    buffer = b; tiles = [];
    for (const src of sources) {
      const top = src.type === 'vector' ? Math.min(src.maxzoom, 14) : Math.min(src.maxzoom, 6);
      for (let z = src.minzoom; z <= top; z++) {
        const buf = z >= 12 ? b : z >= 9 ? b * 3 : b * 10;
        for (const t of tilesAlong(route, z, buf)) { const [x, y] = t.split('/'); tiles.push({ url: src.template.replace('{z}', z).replace('{x}', x).replace('{y}', y), heavy: src.type === 'vector' && z >= 11 }); }
      }
    }
    if (tiles.length <= MAX_TILES) break;
  }
  if (tiles.length > MAX_TILES) throw new Error('Diese Tour ist zu lang für eine Offline-Karte. Teile sie in Etappen auf.');
  const estBytes = tiles.reduce((s, t) => s + (t.heavy ? 110000 : 35000), 0) + 900000;
  return { fixed, tiles: tiles.map((t) => t.url), buffer, estBytes };
}

/** Lädt alles herunter und legt die Tour offline ab. rec: { id, name, route, pois, ... } */
export async function runDownload(rec, plan, onProgress, signal) {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await caches.delete(cacheName(rec.id));
  const cache = await caches.open(cacheName(rec.id));
  const all = [...plan.fixed.map((url) => ({ url, fixed: true })), ...plan.tiles.map((url) => ({ url }))];
  let done = 0, bytes = 0, failed = 0, failedFixed = 0, next = 0;
  const worker = async () => {
    while (next < all.length) {
      const item = all[next++];
      try {
        const res = await fetch(item.url, { signal });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          bytes += buf.byteLength;
          await cache.put(canon(item.url), new Response(buf, { headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream' } }));
        } else if (res.status !== 404 && res.status !== 204) { failed++; if (item.fixed) failedFixed++; }
      } catch (e) {
        if (signal && signal.aborted) throw e;
        failed++; if (item.fixed) failedFixed++;
      }
      done++;
      if (onProgress) onProgress(done, all.length);
    }
  };
  try {
    await Promise.all([worker(), worker(), worker(), worker()]); // höchstens 4 Anfragen gleichzeitig
    // Stil und Kachelverzeichnis müssen da sein; bei den Kartenteilen dürfen einzelne fehlen
    if (failedFixed > 2 || failed > all.length * 0.1) throw new Error('Zu viele Kartenteile konnten nicht geladen werden. Versuche es bei besserer Verbindung noch einmal.');
  } catch (e) {
    await caches.delete(cacheName(rec.id));
    throw e;
  }
  const full = { ...rec, bytes, tiles: plan.tiles.length, buffer: plan.buffer, date: Date.now() };
  await putOffline(full);
  return full;
}

export async function removeDownload(id) {
  await caches.delete(cacheName(id));
  await tx('readwrite', (s) => s.delete(id));
}
