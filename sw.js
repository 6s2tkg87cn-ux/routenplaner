// Service Worker: hält die App-Dateien vor, damit sie schnell startet und sich installieren lässt.
// Karten, Routing, Suche und Wetter kommen immer live aus dem Netz.
const CACHE = 'rueckenwind-v31';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/routing.js', 'js/elevation.js', 'js/roundtrip.js', 'js/weather.js', 'js/pois.js', 'js/offline.js', 'js/routes.js',
  'vendor/maplibre/maplibre-gl.js', 'vendor/maplibre/maplibre-gl.css',
  'profiles/rennrad.brf', 'profiles/gravel.brf', 'profiles/alltag.brf', 'profiles/wandern.brf',
  'vendor/fonts/barlow-latin-400-normal.woff2', 'vendor/fonts/barlow-latin-500-normal.woff2', 'vendor/fonts/barlow-latin-600-normal.woff2',
  'vendor/fonts/barlow-semi-condensed-latin-500-normal.woff2', 'vendor/fonts/barlow-semi-condensed-latin-600-normal.woff2',
  'icons/icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (ev) => {
  // alte App-Versionen entfernen; Offline-Touren (rw-off-…) und geladene Routen (rw-tracks) behalten
  ev.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'rw-tracks' && !k.startsWith('rw-off-')).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Kartenteile der Standardkarte: gespeicherte Offline-Teile zuerst, sonst Netz.
// Versionsnummer im Pfad wird ignoriert (gleiche Regel wie in js/offline.js).
const MAP_HOST = 'tiles.openfreemap.org';
const canon = (url) => url.replace(/\/\d{8}_[^/]+\//g, '/_/');
async function mapRequest(req) {
  const url = new URL(req.url), key = canon(req.url);
  const isPart = /\/\d+\/\d+\/\d+\.\w+$/.test(url.pathname) || /\/(fonts|sprites)\//.test(url.pathname);
  if (isPart) {
    const hit = await caches.match(key);
    return hit || fetch(req);
  }
  // Stil und Kachelverzeichnis: aktuell aus dem Netz, ohne Netz (oder nach 4 Sekunden) aus dem Speicher
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    return await fetch(req.url, { signal: ctrl.signal });
  } catch (e) {
    const hit = await caches.match(key);
    if (hit) return hit;
    throw e;
  } finally { clearTimeout(timer); }
}

// Eigene Dateien: erst Netz (damit Updates sofort ankommen), ohne Netz aus dem Cache.
self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  if (ev.request.method === 'GET' && url.hostname === MAP_HOST) { ev.respondWith(mapRequest(ev.request)); return; }
  if (ev.request.method !== 'GET' || url.origin !== location.origin) return;
  ev.respondWith(
    // 'no-cache': immer beim Server nachfragen, damit nach einem Update nicht alte und neue Dateien gemischt werden
    fetch(ev.request.mode === 'navigate' ? ev.request : new Request(ev.request.url, { cache: 'no-cache' })).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(ev.request, copy)); }
      return res;
    }).catch(() => caches.match(ev.request, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')))
  );
});
