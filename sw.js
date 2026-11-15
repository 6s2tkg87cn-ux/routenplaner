// Service Worker: hält die App-Dateien vor, damit sie schnell startet und sich installieren lässt.
// Karten, Routing, Suche und Wetter kommen immer live aus dem Netz.
const CACHE = 'rueckenwind-v5';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/routing.js', 'js/elevation.js', 'js/roundtrip.js', 'js/weather.js', 'js/pois.js',
  'vendor/maplibre/maplibre-gl.js', 'vendor/maplibre/maplibre-gl.css',
  'profiles/rennrad.brf', 'profiles/gravel.brf', 'profiles/alltag.brf',
  'vendor/fonts/barlow-latin-400-normal.woff2', 'vendor/fonts/barlow-latin-500-normal.woff2', 'vendor/fonts/barlow-latin-600-normal.woff2',
  'vendor/fonts/barlow-semi-condensed-latin-500-normal.woff2', 'vendor/fonts/barlow-semi-condensed-latin-600-normal.woff2',
  'icons/icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (ev) => {
  ev.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Eigene Dateien: erst Netz (damit Updates sofort ankommen), ohne Netz aus dem Cache.
self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== 'GET' || url.origin !== location.origin) return;
  ev.respondWith(
    fetch(ev.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(ev.request, copy)); }
      return res;
    }).catch(() => caches.match(ev.request, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')))
  );
});
