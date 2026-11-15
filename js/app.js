/* global maplibregl */
import {
  PROFILES, DEFAULT_OPTIONS, fetchRoute, RouteError, nearestIndex, toGpx,
  SURFACES, SURFACE_LABEL, WAYS, WAY_LABEL,
} from './routing.js';
import { createProfileChart } from './elevation.js';
import { generateRoundTrips } from './roundtrip.js';
import { fetchForecast, samplePoints, analyze, penalty, bestStart, at as weatherAt, codeText, compass, WeatherError } from './weather.js';

const $ = (id) => document.getElementById(id);
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const k in props) {
    if (k === 'class') e.className = props[k];
    else if (k === 'text') e.textContent = props[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), props[k]);
    else if (props[k] !== false && props[k] != null) e.setAttribute(k, props[k] === true ? '' : props[k]);
  }
  for (const kid of kids) if (kid != null) e.append(kid);
  return e;
};
const fmt = (v, d = 0) => v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const uid = () => Math.random().toString(36).slice(2, 9);
const isMobile = () => window.matchMedia('(max-width: 820px)').matches;

// ---------------------------------------------------------------- Zustand

const STORE_KEY = 'rueckenwind.v1';
const emptyWp = () => ({ id: uid(), lat: null, lon: null, label: '' });

const state = {
  profile: 'rennrad',
  options: structuredClone(DEFAULT_OPTIONS),
  speeds: Object.fromEntries(Object.entries(PROFILES).map(([k, p]) => [k, p.speed])),
  layer: 'standard',
  layerV: 2,
  mode: 'route',
  loop: false,
  round: { km: 50, dir: 'any', climb: 'any', wind: true },
  departTime: '',
  waypoints: [emptyWp(), emptyWp()],
  nogos: [],
  favorites: [],
  tourName: '',
  view: { lat: 48.3984, lon: 9.9916, zoom: 12 }, // Ulm
};
let alt = 0;
let route = null;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!s) return;
    if (PROFILES[s.profile]) state.profile = s.profile;
    for (const p in DEFAULT_OPTIONS) state.options[p] = { ...DEFAULT_OPTIONS[p], ...(s.options && s.options[p]) };
    for (const p in PROFILES) if (s.speeds && s.speeds[p] > 0) state.speeds[p] = s.speeds[p];
    if (s.layer && s.layerV === 2) state.layer = s.layer;
    if (s.mode === 'round') state.mode = 'round';
    state.loop = !!s.loop;
    if (s.round) state.round = { ...state.round, ...s.round };
    if (typeof s.departTime === 'string') state.departTime = s.departTime;
    if (Array.isArray(s.waypoints) && s.waypoints.length >= 2) state.waypoints = s.waypoints.map((w) => ({ ...emptyWp(), ...w, id: uid() }));
    if (Array.isArray(s.nogos)) state.nogos = s.nogos.map((n) => ({ ...n, id: uid() }));
    if (Array.isArray(s.favorites)) state.favorites = s.favorites;
    if (typeof s.tourName === 'string') state.tourName = s.tourName;
    if (s.view && Number.isFinite(s.view.lat)) state.view = s.view;
  } catch (e) { /* gespeicherter Stand unlesbar: mit Standard starten */ }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* Speicher nicht verfügbar */ }
}

// ---------------------------------------------------------------- Karte

const OSM = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const raster = (tiles, attribution, maxzoom) => ({
  version: 8,
  sources: { base: { type: 'raster', tiles, tileSize: 256, attribution, maxzoom } },
  layers: [{ id: 'base', type: 'raster', source: 'base' }],
});
const LAYERS = {
  standard: { label: 'Standard', style: 'https://tiles.openfreemap.org/styles/liberty' },
  radkarte: { label: 'Radkarte', style: raster(['a', 'b', 'c'].map((s) => `https://${s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png`),
    '<a href="https://www.cyclosm.org" target="_blank" rel="noopener">CyclOSM</a> | ' + OSM, 19) },
  topo: { label: 'Topo', style: raster(['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
    OSM + ', SRTM | <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a>', 17) },
  satellit: { label: 'Satellit', style: raster(['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    'Bilder © Esri, Maxar, Earthstar Geographics', 19) },
};

let map, chart, hoverMarker = null, popup = null;
let markers = [], nogoMarkers = [];
const EMPTY = { type: 'FeatureCollection', features: [] };
const overlay = { route: EMPTY, cands: EMPTY, nogo: EMPTY };

function setLayer(key) {
  if (!LAYERS[key]) key = 'standard';
  state.layer = key;
  map.setStyle(LAYERS[key].style, { diff: false });
  for (const b of $('layerMenu').children) b.setAttribute('aria-checked', b.dataset.key === key ? 'true' : 'false');
  save();
}

// Eigene Ebenen (Route, Vorschläge, Sperrzonen) liegen über jeder Basiskarte und werden
// nach jedem Stilwechsel neu angelegt.
function addOverlays() {
  if (map.getSource('route')) return;
  for (const k of ['nogo', 'cands', 'route']) map.addSource(k, { type: 'geojson', data: overlay[k] });
  const round = { 'line-cap': 'round', 'line-join': 'round' };
  map.addLayer({ id: 'nogo-fill', type: 'fill', source: 'nogo', paint: { 'fill-color': '#b3261e', 'fill-opacity': 0.14 } });
  map.addLayer({ id: 'nogo-line', type: 'line', source: 'nogo', paint: { 'line-color': '#b3261e', 'line-width': 2, 'line-dasharray': [3, 2.5] } });
  map.addLayer({ id: 'cand-casing', type: 'line', source: 'cands', layout: round, paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9 } });
  map.addLayer({ id: 'cand-line', type: 'line', source: 'cands', layout: round, paint: { 'line-color': '#47595d', 'line-width': 3.5 } });
  map.addLayer({ id: 'cand-hit', type: 'line', source: 'cands', paint: { 'line-color': '#000', 'line-width': 24, 'line-opacity': 0.01 } });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.95 } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#d0146a', 'line-width': 5 } });
  map.addLayer({ id: 'route-hit', type: 'line', source: 'route', paint: { 'line-color': '#000', 'line-width': 24, 'line-opacity': 0.01 } });
}
function setOverlay(key, data) {
  overlay[key] = data;
  const src = map && map.getSource(key);
  if (src) src.setData(data);
}
const lineFeature = (r, props = {}) => {
  const coordinates = [];
  for (let i = 0; i < r.n; i++) coordinates.push([r.lon[i], r.lat[i]]);
  return { type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates } };
};
function circleFeature(n) {
  const ring = [];
  const dLat = n.radius / 111320, dLon = dLat / Math.cos(n.lat * Math.PI / 180);
  for (let i = 0; i <= 64; i++) { const a = (i / 64) * 2 * Math.PI; ring.push([n.lon + dLon * Math.cos(a), n.lat + dLat * Math.sin(a)]); }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

function initMap() {
  map = new maplibregl.Map({
    container: 'map', style: LAYERS[state.layer] ? LAYERS[state.layer].style : LAYERS.standard.style,
    center: [state.view.lon, state.view.lat], zoom: state.view.zoom,
    attributionControl: false, dragRotate: false, pitchWithRotate: false, maxPitch: 0,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');
  map.on('style.load', addOverlays);

  const menu = $('layerMenu');
  for (const key in LAYERS) {
    menu.append(h('button', { type: 'button', role: 'menuitemradio', 'data-key': key, text: LAYERS[key].label,
      'aria-checked': String(key === state.layer), onclick: () => { setLayer(key); toggleLayerMenu(false); } }));
  }
  $('btnLayers').addEventListener('click', () => toggleLayerMenu($('layerMenu').hidden));

  map.on('moveend', () => {
    const c = map.getCenter();
    state.view = { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
    save();
  });
  map.on('click', (ev) => {
    toggleLayerMenu(false);
    const box = [[ev.point.x - 9, ev.point.y - 9], [ev.point.x + 9, ev.point.y + 9]];
    const layers = ['route-hit', 'cand-hit'].filter((id) => map.getLayer(id));
    const hits = layers.length ? map.queryRenderedFeatures(box, { layers }) : [];
    const cand = hits.find((f) => f.layer.id === 'cand-hit');
    if (hits.some((f) => f.layer.id === 'route-hit')) {
      if (state.mode === 'route') addVia(ev.lngLat.lat, ev.lngLat.lng);
      return;
    }
    if (cand) return applyCandidate(cand.properties.i);
    onMapClick(ev.lngLat.lat, ev.lngLat.lng);
  });
  map.on('mousemove', 'route-hit', (ev) => {
    if (!route) return;
    map.getCanvas().style.cursor = state.mode === 'route' ? 'copy' : '';
    const i = nearestIndex(route, ev.lngLat.lat, ev.lngLat.lng);
    setHover(route.cum[i], { lat: route.lat[i], lon: route.lon[i] });
    chart.setCursor(route.cum[i]);
  });
  map.on('mouseleave', 'route-hit', () => { map.getCanvas().style.cursor = ''; setHover(null); chart.setCursor(null); });
  map.on('mouseenter', 'cand-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'cand-hit', () => { map.getCanvas().style.cursor = ''; });
}

function toggleLayerMenu(open) {
  $('layerMenu').hidden = !open;
  $('btnLayers').setAttribute('aria-expanded', String(open));
}

// Freie Kartenfläche neben Seitenleiste, Ergebnisleiste oder Bottom-Sheet
function fitPadding() {
  if (isMobile()) return { top: 70, left: 40, right: 40, bottom: $('panel').offsetHeight + 30 };
  const dockH = $('dock').hidden ? 0 : $('dock').offsetHeight;
  return { top: 50, left: 70, right: 70, bottom: dockH + 60 };
}
function fitRoute(r) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (let i = 0; i < r.n; i++) { w = Math.min(w, r.lon[i]); e = Math.max(e, r.lon[i]); s = Math.min(s, r.lat[i]); n = Math.max(n, r.lat[i]); }
  map.resize();
  map.fitBounds([[w, s], [e, n]], { padding: fitPadding(), duration: 700, maxZoom: 16 });
}

function openMenu(lat, lon, box, offset = 4) {
  closeMenu();
  popup = new maplibregl.Popup({ closeButton: false, className: 'menu-popup', offset, maxWidth: '260px' })
    .setLngLat([lon, lat]).setDOMContent(box).addTo(map);
}
function closeMenu() { if (popup) { popup.remove(); popup = null; } }

function onMapClick(lat, lng) {
  if (popup) return closeMenu();
  const last = state.waypoints.length - 1;
  const filled = state.waypoints.filter((w) => w.lat != null).length;
  if (state.waypoints[0].lat == null) return setWaypoint(0, lat, lng, null);
  const item = (text, fn, cls) => h('button', { type: 'button', class: cls, text, onclick: () => { closeMenu(); fn(); } });
  if (state.mode === 'round') {
    return openMenu(lat, lng, h('div', { class: 'map-menu' },
      item('Als Start', () => setWaypoint(0, lat, lng, null)),
      item('Hier sperren', () => addNogo(lat, lng), 'danger')));
  }
  if (filled === 1 && state.waypoints[last].lat == null) return setWaypoint(last, lat, lng, null);
  openMenu(lat, lng, h('div', { class: 'map-menu' },
    item('Als Start', () => setWaypoint(0, lat, lng, null)),
    item(state.loop ? 'Als Wegpunkt' : 'Als Zwischenziel', () => addVia(lat, lng)),
    state.loop ? null : item('Als Ziel', () => setWaypoint(state.waypoints.length - 1, lat, lng, null)),
    item('Hier sperren', () => addNogo(lat, lng), 'danger')));
}

// ---------------------------------------------------------------- Wegpunkte

const isEnd = (i) => !state.loop && i === state.waypoints.length - 1;
const wpName = (i) => (i === 0 ? 'Start' : isEnd(i) ? 'Ziel' : (state.loop ? 'Wegpunkt ' : 'Zwischenziel ') + i);
const wpBadge = (i) => (i === 0 ? 'A' : isEnd(i) ? 'B' : String(i));

async function setWaypoint(index, lat, lon, label) {
  // Neuer Start im Rundtour-Modus: alte Wegpunkte gehören zur vorherigen Runde und entfallen
  if (state.mode === 'round' && index === 0) { state.waypoints = [state.waypoints[0], emptyWp()]; state.loop = false; renderLoop(); }
  const w = state.waypoints[index];
  w.lat = lat; w.lon = lon;
  w.label = label || fmt(lat, 5) + ', ' + fmt(lon, 5);
  renderWaypoints();
  changed();
  if (!label) {
    const name = await reverseGeocode(lat, lon);
    if (name && w.lat === lat && w.lon === lon) { w.label = name; renderWaypoints(); save(); }
  }
}

function addVia(lat, lon) {
  // Wegpunkt dort einfügen, wo er entlang der aktuellen Route liegt
  const maxAt = state.loop ? state.waypoints.length : state.waypoints.length - 1;
  let at = maxAt;
  if (route) {
    const k = nearestIndex(route, lat, lon);
    at = 1;
    let from = 0;
    for (let i = 1; i < maxAt; i++) {
      const w = state.waypoints[i];
      if (w.lat == null) continue;
      // Wegpunkte der Reihe nach entlang der Route suchen (wichtig bei Hin- und Rückweg auf derselben Straße)
      let best = from, bestD = Infinity;
      for (let j = from; j < route.n; j++) {
        const dx = (route.lon[j] - w.lon) * Math.cos(w.lat * Math.PI / 180), dy = route.lat[j] - w.lat, d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = j; }
      }
      from = best;
      if (best <= k) at = i + 1;
    }
  }
  state.waypoints.splice(at, 0, emptyWp());
  setWaypoint(at, lat, lon, null);
}

function removeWaypoint(index) {
  if (state.waypoints.length > 2) state.waypoints.splice(index, 1);
  else Object.assign(state.waypoints[index], { lat: null, lon: null, label: '' });
  renderWaypoints();
  changed();
}

function isFavorite(w) {
  return state.favorites.some((f) => Math.abs(f.lat - w.lat) < 1e-5 && Math.abs(f.lon - w.lon) < 1e-5);
}
function toggleFavorite(w) {
  if (isFavorite(w)) state.favorites = state.favorites.filter((f) => !(Math.abs(f.lat - w.lat) < 1e-5 && Math.abs(f.lon - w.lon) < 1e-5));
  else state.favorites.push({ label: w.label, lat: w.lat, lon: w.lon });
  save();
  renderWaypoints();
  toast(isFavorite(w) ? 'Als Favorit gespeichert.' : 'Favorit entfernt.');
}

function renderWaypoints() {
  const list = $('wpList');
  list.replaceChildren();
  state.waypoints.forEach((w, i) => {
    if (state.mode === 'round' && i > 0) return;
    const input = h('input', { class: 'wp-input', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: wpName(i) + ' suchen oder auf Karte tippen', 'aria-label': wpName(i) });
    input.value = w.label;
    const drop = h('div', { class: 'ac', hidden: true });
    attachAutocomplete(input, drop, i);
    const set = w.lat != null;
    const li = h('li', { class: 'wp' + (i === 0 ? ' wp-start' : isEnd(i) ? ' wp-end' : '') },
      h('span', { class: 'wp-badge', text: wpBadge(i), 'aria-hidden': 'true' }),
      h('div', { class: 'wp-field' }, input, drop),
      set ? h('button', { class: 'icon-btn' + (isFavorite(w) ? ' on' : ''), type: 'button',
        title: isFavorite(w) ? 'Favorit entfernen' : 'Als Favorit speichern', 'aria-label': 'Favorit', 'aria-pressed': String(isFavorite(w)),
        onclick: () => toggleFavorite(w) }, icon('star')) : null,
      (state.mode === 'route' && (set || state.waypoints.length > 2)) ? h('button', { class: 'icon-btn', type: 'button', title: 'Entfernen',
        'aria-label': wpName(i) + ' entfernen', onclick: () => removeWaypoint(i) }, icon('x')) : null);
    list.append(li);
  });
  const filled = state.waypoints.filter((w) => w.lat != null).length;
  $('mapHint').textContent = state.mode === 'round'
    ? (filled === 0 ? 'Wähle den Start: suchen, „Mein Standort“ oder auf die Karte tippen.' : 'Der Start lässt sich auf der Karte verschieben.')
    : filled === 0 ? 'Tippe auf die Karte, um den Start zu setzen.'
      : filled === 1 ? (state.loop ? 'Tippe auf die Karte, um den Wendepunkt zu setzen.' : 'Tippe auf die Karte, um das Ziel zu setzen.')
        : 'Tippe auf die Route, um einen Wegpunkt einzufügen. Punkte lassen sich verschieben.';
  $('btnReverse').disabled = filled < 2;
  renderMarkers();
}

function icon(name) {
  const paths = {
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8L12 3.5Z"/>',
    pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
    here: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  };
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
  return t.content.firstChild;
}

function renderMarkers() {
  markers.forEach((m) => m.remove());
  markers = [];
  state.waypoints.forEach((w, i) => {
    if (w.lat == null) return;
    const kind = i === 0 ? 'start' : isEnd(i) ? 'end' : 'via';
    const elm = h('div', { class: 'pin pin-' + kind, text: wpBadge(i), title: wpName(i) });
    const m = new maplibregl.Marker({ element: elm, draggable: true }).setLngLat([w.lon, w.lat]).addTo(map);
    m.on('dragend', () => { const p = m.getLngLat(); setWaypoint(state.waypoints.indexOf(w), p.lat, p.lng, null); });
    elm.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const idx = state.waypoints.indexOf(w);
      if (state.mode === 'round' && idx === 0) return;
      openMenu(w.lat, w.lon, h('div', { class: 'map-menu' },
        h('strong', { text: w.label }),
        h('button', { type: 'button', class: 'danger', text: 'Entfernen', onclick: () => { closeMenu(); removeWaypoint(state.waypoints.indexOf(w)); } })), 18);
    });
    markers.push(m);
  });
}

// ---------------------------------------------------------------- Suche

const PHOTON = 'https://photon.komoot.io';

function placeLabel(p) {
  const street = p.street ? p.street + (p.housenumber ? ' ' + p.housenumber : '') : '';
  const main = p.name || street || p.city || p.county || 'Unbenannter Ort';
  const place = [p.postcode, p.city && p.city !== main ? p.city : (p.district && p.district !== main ? p.district : '')].filter(Boolean).join(' ');
  const sub = [p.name && street ? street : '', place, p.country && p.country !== 'Deutschland' ? p.country : (p.state || '')].filter(Boolean).join(', ');
  const town = p.city || p.town || p.village || '';
  return { main, sub, short: main + (town && town !== main ? ', ' + town : '') };
}

async function searchPlaces(q, signal) {
  const c = map.getCenter();
  const url = `${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=6&lang=de&lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('Suche fehlgeschlagen');
  const data = await res.json();
  return (data.features || []).map((f) => {
    const l = placeLabel(f.properties || {});
    return { ...l, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
  });
}

async function reverseGeocode(lat, lon) {
  try {
    const res = await fetch(`${PHOTON}/reverse?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&lang=de`);
    if (!res.ok) return null;
    const f = (await res.json()).features[0];
    if (!f) return null;
    return placeLabel(f.properties || {}).short;
  } catch (e) { return null; }
}

function attachAutocomplete(input, drop, index) {
  let ctrl = null, timer = 0, items = [], active = -1;

  const close = () => { drop.hidden = true; active = -1; };
  const choose = (it) => {
    close();
    input.blur();
    if (it.locate) return locate(index);
    fitNext = true;
    setWaypoint(index, it.lat, it.lon, it.short || it.main);
  };
  const show = (list, note) => {
    items = list; active = -1;
    drop.replaceChildren();
    list.forEach((it, k) => {
      drop.append(h('button', { type: 'button', class: 'ac-item', 'data-k': k,
        // mousedown statt click, damit die Auswahl vor dem blur des Felds greift
        onmousedown: (ev) => { ev.preventDefault(); choose(it); } },
      icon(it.locate ? 'here' : it.fav ? 'star' : 'pin'),
      h('span', { class: 'ac-text' }, h('span', { class: 'ac-main', text: it.main }), it.sub ? h('span', { class: 'ac-sub', text: it.sub }) : null)));
    });
    if (note) drop.append(h('div', { class: 'ac-note', text: note }));
    drop.hidden = list.length === 0 && !note;
  };
  const baseItems = () => [{ locate: true, main: 'Mein Standort' }, ...state.favorites.map((f) => ({ fav: true, main: f.label, sub: 'Favorit', lat: f.lat, lon: f.lon }))];

  const run = async () => {
    const q = input.value.trim();
    if (ctrl) ctrl.abort();
    if (q.length < 2) return show(baseItems());
    const mm = q.match(/^(-?\d{1,2}[.,]\d+)\s*[,; ]\s*(-?\d{1,3}[.,]\d+)$/);
    if (mm) {
      const lat = parseFloat(mm[1].replace(',', '.')), lon = parseFloat(mm[2].replace(',', '.'));
      return show([{ main: fmt(lat, 5) + ', ' + fmt(lon, 5), sub: 'Koordinaten', lat, lon }]);
    }
    ctrl = new AbortController();
    try {
      const res = await searchPlaces(q, ctrl.signal);
      show(res, res.length ? '' : 'Nichts gefunden. Prüfe die Schreibweise oder tippe auf die Karte.');
    } catch (e) {
      if (e.name !== 'AbortError') show([], 'Die Suche ist gerade nicht erreichbar.');
    }
  };

  input.addEventListener('focus', () => { input.select(); if (input.value.trim().length < 2 || state.waypoints[index].lat != null) show(baseItems()); else run(); });
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 280); });
  input.addEventListener('blur', () => { setTimeout(close, 120); input.value = state.waypoints[index] ? state.waypoints[index].label : ''; });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!items.length) return;
      active = (active + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      [...drop.querySelectorAll('.ac-item')].forEach((b, k) => b.classList.toggle('active', k === active));
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (items.length) choose(items[Math.max(0, active)]);
    } else if (ev.key === 'Escape') { close(); input.blur(); }
  });
}

function locate(index) {
  if (!navigator.geolocation) return toast('Dieser Browser kann den Standort nicht bestimmen.');
  toast('Standort wird bestimmt …');
  navigator.geolocation.getCurrentPosition((pos) => {
    const { latitude, longitude } = pos.coords;
    if (index == null) { map.easeTo({ center: [longitude, latitude], zoom: Math.max(map.getZoom(), 14) }); hideToast(); return; }
    hideToast();
    if (state.mode === 'round' || state.waypoints.filter((w) => w.lat != null).length === 0) map.easeTo({ center: [longitude, latitude], zoom: Math.max(map.getZoom(), 13) });
    else fitNext = true;
    setWaypoint(index, latitude, longitude, null);
  }, () => toast('Der Standort ist nicht verfügbar. Erlaube den Zugriff in den Browser-Einstellungen.'), { enableHighAccuracy: true, timeout: 10000 });
}

// ---------------------------------------------------------------- Sperrzonen

function addNogo(lat, lon) {
  state.nogos.push({ id: uid(), lat, lon, radius: 200 });
  renderNogos();
  changed();
  toast('Sperrzone gesetzt. Radius und Position kannst du anpassen.');
}

function renderNogos() {
  nogoMarkers.forEach((m) => m.remove());
  nogoMarkers = [];
  const list = $('nogoList');
  list.replaceChildren();
  $('nogoBlock').hidden = state.nogos.length === 0;
  const draw = () => setOverlay('nogo', { type: 'FeatureCollection', features: state.nogos.map(circleFeature) });
  draw();
  state.nogos.forEach((n, i) => {
    const m = new maplibregl.Marker({ element: h('div', { class: 'pin pin-nogo', title: 'Sperrzone ' + (i + 1) }), draggable: true })
      .setLngLat([n.lon, n.lat]).addTo(map);
    m.on('drag', () => { const p = m.getLngLat(); n.lat = p.lat; n.lon = p.lng; draw(); });
    m.on('dragend', () => changed());
    m.getElement().addEventListener('click', (ev) => ev.stopPropagation());
    nogoMarkers.push(m);

    const sel = h('select', { 'aria-label': 'Radius der Sperrzone ' + (i + 1),
      onchange: () => { n.radius = +sel.value; draw(); changed(); } });
    for (const r of [50, 100, 200, 500, 1000, 2000]) sel.append(h('option', { value: r, text: r < 1000 ? r + ' m' : r / 1000 + ' km', selected: r === n.radius }));
    list.append(h('li', {},
      h('button', { type: 'button', class: 'nogo-name', text: 'Sperrzone ' + (i + 1), title: 'Auf der Karte zeigen', onclick: () => map.easeTo({ center: [n.lon, n.lat], zoom: Math.max(map.getZoom(), 14) }) }),
      h('label', { class: 'nogo-radius' }, 'Radius ', sel),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Sperrzone ' + (i + 1) + ' entfernen', title: 'Entfernen',
        onclick: () => { state.nogos.splice(i, 1); renderNogos(); changed(); } }, icon('x'))));
  });
}

// ---------------------------------------------------------------- Optionen

const STEP3 = ['egal', 'gern', 'möglichst viel'];
const OPTION_DEFS = [
  { key: 'traffic', label: 'Autoverkehr', steps: ['egal', 'normal', 'wenig', 'kaum'] },
  { key: 'elevation', label: 'Höhenmeter', steps: [['flat', 'flach halten'], ['balanced', 'ausgewogen'], ['nosteep', 'Rampen meiden']] },
  { key: 'forest', label: 'Wald', steps: STEP3 },
  { key: 'river', label: 'Flüsse und Seen', steps: STEP3 },
  { key: 'town', label: 'Ortschaften', steps: ['egal', 'eher meiden', 'umfahren'] },
  { key: 'preferUnpaved', label: 'Schotterwege bevorzugen', only: ['gravel'] },
  { key: 'trails', label: 'Pfade und Trails erlauben', note: 'Auch schmale, verwurzelte Wege.', only: ['gravel'] },
  { key: 'wet', label: 'Nasse Verhältnisse', note: 'Meidet Wege, die bei Nässe schmierig werden.', only: ['gravel'] },
  { key: 'cycleways', label: 'Radwege mitnutzen', only: ['rennrad'] },
  { key: 'cobble', label: 'Kopfsteinpflaster meiden', only: ['rennrad'] },
  { key: 'strictPaved', label: 'Schotter strikt ausschließen', note: 'Sonst sind kurze Stücke erlaubt, wenn sie einen großen Umweg sparen.', only: ['rennrad'] },
  { key: 'cycleRoutes', label: 'Ausgeschilderten Radrouten folgen', only: ['gravel', 'alltag'] },
  { key: 'noMain', label: 'Bundesstraßen meiden' },
  { key: 'ferries', label: 'Fähren erlauben' },
];

function renderOptions() {
  const o = state.options[state.profile];
  const list = $('optList');
  list.replaceChildren();
  for (const def of OPTION_DEFS) {
    if (def.only && !def.only.includes(state.profile)) continue;
    if (def.steps) {
      const seg = h('div', { class: 'seg seg-small', role: 'radiogroup', 'aria-label': def.label });
      def.steps.forEach((s, i) => {
        const val = Array.isArray(s) ? s[0] : i, text = Array.isArray(s) ? s[1] : s;
        seg.append(h('button', { type: 'button', role: 'radio', 'aria-checked': String(o[def.key] === val), text,
          onclick: () => { o[def.key] = val; renderOptions(); changed(); } }));
      });
      list.append(h('div', { class: 'opt opt-steps' }, h('span', { class: 'opt-label', text: def.label }), seg));
    } else {
      const id = 'opt-' + def.key;
      const box = h('input', { type: 'checkbox', id, class: 'switch', checked: !!o[def.key],
        onchange: () => { o[def.key] = box.checked; changed(); } });
      box.checked = !!o[def.key];
      list.append(h('div', { class: 'opt opt-toggle' },
        h('label', { for: id }, h('span', { class: 'opt-label', text: def.label }), def.note ? h('span', { class: 'opt-note', text: def.note }) : null), box));
    }
  }
}

function renderProfile() {
  const seg = $('profileSeg');
  seg.replaceChildren();
  for (const key in PROFILES) {
    seg.append(h('button', { type: 'button', role: 'radio', 'aria-checked': String(state.profile === key), text: PROFILES[key].label,
      onclick: () => { state.profile = key; renderProfile(); renderOptions(); changed(); } }));
  }
  $('speedLabel').textContent = { rennrad: 'Durchschnitt mit dem Rennrad', gravel: 'Durchschnitt mit dem Gravelbike', alltag: 'Durchschnitt im Alltag' }[state.profile];
  $('speedInput').value = state.speeds[state.profile];
}

// ---------------------------------------------------------------- Route

let fitNext = true, routeCtrl = null, routeTimer = 0;

// Nach jeder Änderung: speichern und Route neu berechnen
function changed({ keepAlt = false } = {}) {
  if (!keepAlt) alt = 0;
  clearCandidates();
  save();
  clearTimeout(routeTimer);
  routeTimer = setTimeout(calcRoute, 120);
}

async function calcRoute() {
  const pts = state.waypoints.filter((w) => w.lat != null);
  if (routeCtrl) routeCtrl.abort();
  const distinct = pts.some((p) => Math.abs(p.lat - pts[0].lat) > 1e-5 || Math.abs(p.lon - pts[0].lon) > 1e-5);
  if (pts.length < 2 || !distinct) { route = null; $('busy').hidden = true; showRoute(); return; }
  if (state.loop) pts.push(pts[0]);
  routeCtrl = new AbortController();
  const ctrl = routeCtrl;
  $('busy').hidden = false;
  try {
    const r = await fetchRoute({ profile: state.profile, options: state.options[state.profile], points: pts, nogos: state.nogos, alt, signal: ctrl.signal });
    if (ctrl !== routeCtrl) return;
    route = r;
    hideToast();
    showRoute();
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (ctrl !== routeCtrl) return;
    if (alt > 0 && e instanceof RouteError) {
      alt = 0; renderAlt();
      toast('Für diese Strecke gibt es keine weitere Variante.');
      return calcRoute();
    }
    route = null;
    showRoute();
    toast(e instanceof RouteError ? e.message : 'Die Route konnte nicht berechnet werden.', true);
    if (!(e instanceof RouteError)) console.error(e);
  } finally {
    if (ctrl === routeCtrl) $('busy').hidden = true;
  }
}

function formatTime(hours) {
  const min = Math.round(hours * 60);
  return Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0') + ' h';
}

function showRoute() {
  setHover(null);
  const has = !!route;
  $('dock').hidden = !has;
  $('tourBlock').hidden = !has;
  document.body.classList.toggle('has-route', has);
  setOverlay('route', has ? { type: 'FeatureCollection', features: [lineFeature(route)] } : EMPTY);
  if (!has) { chart.setRoute(null); placeDock(); scheduleWeather(); return; }

  $('stDist').innerHTML = `${fmt(route.dist / 1000, route.dist < 100000 ? 1 : 0)}<small> km</small>`;
  $('stUp').innerHTML = route.hasEle ? `${fmt(route.ascent)}<small> m</small>` : '–';
  $('stDown').innerHTML = route.hasEle ? `${fmt(route.descent)}<small> m</small>` : '–';
  $('stMax').innerHTML = route.hasEle ? `${fmt(route.maxEle)}<small> m</small>` : '–';
  renderTime();
  renderAlt();
  renderComposition();
  placeDock();
  chart.setRoute(route);
  scheduleWeather();

  if (!state.tourName) $('tourName').placeholder = defaultTourName();
  if (fitNext) {
    fitNext = false;
    const mobile = isMobile(), r = route;
    if (mobile && state.mode === 'route') setSheet('peek');
    // mobil erst nach dem Einfahren des Sheets einpassen
    setTimeout(() => fitRoute(r), mobile ? 260 : 30);
  }
}

function renderTime() {
  if (!route) return;
  $('stTime').innerHTML = formatTime(route.dist / 1000 / state.speeds[state.profile]).replace(' h', '<small> h</small>');
}

function setHover(d, p) {
  if (d == null || !p) { if (hoverMarker) { hoverMarker.remove(); hoverMarker = null; } return; }
  if (!hoverMarker) hoverMarker = new maplibregl.Marker({ element: h('div', { class: 'hover-dot' }) }).setLngLat([p.lon, p.lat]).addTo(map);
  else hoverMarker.setLngLat([p.lon, p.lat]);
}

function renderAlt() {
  const seg = $('altSeg');
  seg.replaceChildren();
  for (let i = 0; i < 4; i++) {
    seg.append(h('button', { type: 'button', role: 'radio', 'aria-checked': String(alt === i), text: String(i + 1), 'aria-label': 'Variante ' + (i + 1),
      onclick: () => { alt = i; renderAlt(); changed({ keepAlt: true }); } }));
  }
}

function renderComposition() {
  const host = $('composition');
  host.replaceChildren();
  const bar = (title, keys, labels, share, cls) => {
    const total = keys.reduce((s, k) => s + (share[k] || 0), 0);
    if (total <= 0) return;
    const track = h('div', { class: 'cbar', role: 'img', 'aria-label': title });
    const legend = h('ul', { class: 'clegend' });
    for (const k of keys) {
      const v = share[k] || 0;
      if (v / total < 0.005) continue;
      const pct = (v / total) * 100;
      track.append(h('span', { class: cls + k, style: `flex:${pct.toFixed(2)} 0 0`, title: `${labels[k]}: ${fmt(v / 1000, 1)} km` }));
      legend.append(h('li', {}, h('i', { class: 'sw ' + cls + k }), h('span', { class: 'cl-name', text: labels[k] }),
        h('span', { class: 'cl-val', text: `${fmt(v / 1000, 1)} km` }), h('span', { class: 'cl-pct', text: `${fmt(pct)} %` })));
    }
    host.append(h('div', { class: 'comp' }, h('h3', { text: title }), track, legend));
  };
  bar('Untergrund', SURFACES, SURFACE_LABEL, route.surfaceShare, 'surf-');
  bar('Wegtyp', WAYS, WAY_LABEL, route.wayShare, 'way-');
}

// ---------------------------------------------------------------- Rundtour

let cands = [], candSel = -1, roundCtrl = null;
const DIRS = [['any', 'egal'], ['0', 'Norden'], ['45', 'Nordosten'], ['90', 'Osten'], ['135', 'Südosten'], ['180', 'Süden'], ['225', 'Südwesten'], ['270', 'Westen'], ['315', 'Nordwesten']];

function clearCandidates() {
  if (roundCtrl) { roundCtrl.abort(); roundCtrl = null; setRoundBusy(false); }
  if (!cands.length) return;
  cands = []; candSel = -1;
  renderCandidates();
}

function setRoundBusy(on, text) {
  $('btnRound').disabled = on;
  $('btnRound').textContent = on ? 'Wird berechnet …' : (cands.length ? 'Neue Vorschläge' : 'Rundtour vorschlagen');
  $('roundStatus').hidden = !text;
  $('roundStatus').textContent = text || '';
}

async function runRoundTrip() {
  const start = state.waypoints[0];
  if (start.lat == null) return toast('Wähle zuerst einen Startpunkt.');
  const km = state.round.km;
  if (!(km >= 5 && km <= 300)) return toast('Gib eine Länge zwischen 5 und 300 km ein.');
  clearCandidates();
  if (routeCtrl) routeCtrl.abort();
  roundCtrl = new AbortController();
  const ctrl = roundCtrl;
  setRoundBusy(true, 'Die App probiert mehrere Richtungen aus. Das dauert einen Moment.');
  $('busy').hidden = false;
  try {
    let wind = null;
    if (state.round.wind) {
      // Wind am Start zur Abfahrtszeit; ohne Wetterdaten wird die Runde trotzdem berechnet
      try {
        const fc = await fetchForecast([{ lat: start.lat, lon: start.lon }], ctrl.signal);
        const w = weatherAt(fc[0], departUnix());
        if (w && w.wind != null) wind = { from: w.wdir, speed: w.wind };
      } catch (e) { if (e.name === 'AbortError') throw e; }
    }
    const res = await generateRoundTrips({
      start: { lat: start.lat, lon: start.lon }, km, climb: state.round.climb,
      direction: state.round.dir === 'any' ? null : +state.round.dir,
      profile: state.profile, options: state.options[state.profile], nogos: state.nogos, signal: ctrl.signal, wind,
      onProgress: (done, total) => { if (ctrl === roundCtrl) setRoundBusy(true, `${done} von ${total} Richtungen berechnet …`); },
    });
    if (ctrl !== roundCtrl) return;
    roundCtrl = null;
    cands = res;
    setRoundBusy(false);
    fitNext = true;
    applyCandidate(0);
  } catch (e) {
    if (e.name === 'AbortError' || ctrl !== roundCtrl) return;
    roundCtrl = null;
    setRoundBusy(false);
    toast(e instanceof RouteError ? e.message : 'Die Rundtour konnte nicht berechnet werden.', true);
    if (!(e instanceof RouteError)) console.error(e);
  } finally {
    if (!roundCtrl && !routeCtrl) $('busy').hidden = true;
    if (!roundCtrl) $('busy').hidden = true;
  }
}

// Übernimmt einen Vorschlag als bearbeitbare Route (Start, drei Wegpunkte, zurück zum Start).
function applyCandidate(i) {
  i = +i;
  const c = cands[i];
  if (!c) return;
  candSel = i;
  const start = state.waypoints[0];
  state.waypoints = [start, ...c.vias.map((v, k) => ({ id: uid(), lat: v.lat, lon: v.lon, label: 'Wegpunkt ' + (k + 1) }))];
  state.loop = true;
  alt = 0;
  if (routeCtrl) { routeCtrl.abort(); routeCtrl = null; }
  clearTimeout(routeTimer);
  route = c.route;
  save();
  renderLoop();
  renderWaypoints();
  renderCandidates();
  showRoute();
}

function renderCandidates() {
  const list = $('candList');
  list.replaceChildren();
  $('candWrap').hidden = cands.length === 0;
  setOverlay('cands', { type: 'FeatureCollection', features: cands.map((c, i) => (i === candSel ? null : lineFeature(c.route, { i }))).filter(Boolean) });
  if (!cands.length) { $('btnRound').textContent = 'Rundtour vorschlagen'; return; }
  $('btnRound').textContent = 'Neue Vorschläge';
  const perKm = cands.map((c) => c.route.ascent / c.route.dist);
  const flat = perKm.indexOf(Math.min(...perKm)), hilly = perKm.indexOf(Math.max(...perKm));
  cands.forEach((c, i) => {
    const r = c.route, total = r.dist || 1;
    const unpaved = ((r.surfaceShare.schotter || 0) + (r.surfaceShare.natur || 0)) / total * 100;
    const tag = cands.length > 1 && flat !== hilly ? (i === flat ? 'am flachsten' : i === hilly ? 'am bergigsten' : '') : '';
    list.append(h('li', {}, h('button', { type: 'button', class: 'cand', 'aria-pressed': String(i === candSel), onclick: () => applyCandidate(i) },
      h('span', { class: 'cand-top' }, h('span', { class: 'cand-name', text: c.name }), tag ? h('span', { class: 'cand-tag', text: tag }) : null),
      h('span', { class: 'cand-nums' },
        h('span', {}, h('b', { text: fmt(r.dist / 1000, 1) }), ' km'),
        h('span', {}, h('b', { text: fmt(r.ascent) }), ' hm'),
        h('span', {}, h('b', { text: formatTime(r.dist / 1000 / state.speeds[state.profile]).replace(' h', '') }), ' h'),
        h('span', {}, h('b', { text: fmt(unpaved) }), ' % unbefestigt')),
      c.windNote ? h('span', { class: 'cand-tag', text: c.windNote }) : null)));
  });
}

function renderLoop() {
  $('loopSwitch').checked = state.loop;
}

function renderMode() {
  for (const b of $('modeSeg').children) b.setAttribute('aria-checked', String(b.dataset.mode === state.mode));
  document.body.dataset.mode = state.mode;
  $('roundBlock').hidden = state.mode !== 'round';
  $('routeExtras').hidden = state.mode !== 'route';
}

function initRound() {
  const seg = $('modeSeg');
  for (const [mode, label] of [['route', 'Route planen'], ['round', 'Rundtour erstellen']]) {
    seg.append(h('button', { type: 'button', role: 'radio', 'data-mode': mode, text: label, onclick: () => {
      if (state.mode === mode) return;
      state.mode = mode;
      save(); renderMode(); renderWaypoints();
      if (isMobile()) setSheet('half');
    } }));
  }
  const km = $('roundKm');
  km.value = state.round.km;
  km.addEventListener('change', () => { const v = parseFloat(km.value); if (v >= 5 && v <= 300) { state.round.km = v; save(); renderChips(); } else km.value = state.round.km; });
  const renderChips = () => {
    $('kmChips').replaceChildren(...[30, 50, 80, 100].map((v) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(state.round.km === v), text: v + ' km',
      onclick: () => { state.round.km = v; km.value = v; save(); renderChips(); } })));
  };
  renderChips();
  const dir = $('roundDir');
  for (const [v, label] of DIRS) dir.append(h('option', { value: v, text: label, selected: v === state.round.dir }));
  dir.addEventListener('change', () => { state.round.dir = dir.value; save(); });
  const renderClimb = () => {
    $('climbSeg').replaceChildren(...[['flat', 'wenig'], ['any', 'egal'], ['hilly', 'viel']].map(([v, label]) => h('button', { type: 'button', role: 'radio',
      'aria-checked': String(state.round.climb === v), text: label, onclick: () => { state.round.climb = v; save(); renderClimb(); } })));
  };
  renderClimb();
  $('btnRound').addEventListener('click', runRoundTrip);
  $('btnEditWp').addEventListener('click', () => { state.mode = 'route'; save(); renderMode(); renderWaypoints(); });
  $('roundWind').checked = state.round.wind;
  $('roundWind').addEventListener('change', () => { state.round.wind = $('roundWind').checked; save(); });
  $('loopSwitch').addEventListener('change', () => {
    state.loop = $('loopSwitch').checked;
    fitNext = true;
    renderWaypoints(); changed();
  });
  renderLoop();
  renderMode();
}

// ---------------------------------------------------------------- Abfahrt und Wetter

let departDay = 0, wxCtrl = null, wxTimer = 0;
const clock = (t) => new Date(t * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

function dayStartUnix() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + departDay);
  return d.getTime() / 1000;
}
function departUnix() {
  const [hh, mm] = ($('wxTime').value || '10:00').split(':').map(Number);
  return dayStartUnix() + hh * 3600 + (mm || 0) * 60;
}

function reverseRoute() {
  // Bei Hin und zurück bleibt der Start, nur die Reihenfolge der übrigen Punkte dreht sich
  if (state.loop) state.waypoints = [state.waypoints[0], ...state.waypoints.slice(1).reverse()];
  else state.waypoints.reverse();
  renderWaypoints();
  changed();
}

function initWeather() {
  const sel = $('wxDay');
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const label = i === 0 ? 'Heute' : i === 1 ? 'Morgen' : d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'numeric' });
    sel.append(h('option', { value: i, text: label }));
  }
  sel.addEventListener('change', () => { departDay = +sel.value; scheduleWeather(); });
  const time = $('wxTime');
  const next = new Date(Date.now() + 3600 * 1000);
  time.value = state.departTime || String(Math.min(20, Math.max(6, next.getHours()))).padStart(2, '0') + ':00';
  time.addEventListener('change', () => { if (time.value) { state.departTime = time.value; save(); scheduleWeather(); } });
  renderWeather(null);
}

function scheduleWeather() {
  clearTimeout(wxTimer);
  wxTimer = setTimeout(updateWeather, 250);
}

async function updateWeather() {
  if (wxCtrl) wxCtrl.abort();
  if (!route) { chart.setWind(null); return renderWeather(null); }
  wxCtrl = new AbortController();
  const ctrl = wxCtrl, r = route;
  if (!$('wxBody').dataset.filled) renderWeather(null, 'Wetter wird geladen …');
  try {
    const samples = samplePoints(r);
    const fcs = await fetchForecast(samples, ctrl.signal);
    if (ctrl !== wxCtrl || r !== route) return;
    const start = departUnix(), speed = state.speeds[state.profile];
    const a = analyze(r, samples, fcs, start, speed);
    if (!a) { chart.setWind(null); return renderWeather(null, 'Für diesen Zeitpunkt gibt es keine Vorhersage. Wähle eine Abfahrt in den nächsten sieben Tagen.'); }
    const closed = state.loop || Math.hypot(r.lat[0] - r.lat[r.n - 1], r.lon[0] - r.lon[r.n - 1]) < 0.003;
    const rev = closed ? analyze(r, samples, fcs, start, speed, true) : null;
    const best = bestStart(r, samples, fcs, dayStartUnix(), speed);
    chart.setWind(a.bins);
    renderWeather({ a, rev, best, closed });
  } catch (e) {
    if (e.name === 'AbortError') return;
    chart.setWind(null);
    renderWeather(null, e instanceof WeatherError ? e.message : 'Das Wetter konnte nicht ausgewertet werden.');
    if (!(e instanceof WeatherError)) console.error(e);
  }
}

function windArrow(from) {
  // Pfeil zeigt, wohin der Wind weht
  const t = document.createElement('template');
  t.innerHTML = `<svg class="wx-arrow" viewBox="0 0 14 14" style="transform:rotate(${Math.round(from + 180)}deg)" aria-hidden="true"><path d="M7 12V2M3 6l4-4 4 4"/></svg>`;
  return t.content.firstChild;
}

function renderWeather(w, note) {
  const body = $('wxBody');
  body.replaceChildren();
  delete body.dataset.filled;
  for (const e of document.querySelectorAll('.lg-wind')) e.hidden = !w;
  if (!w) {
    body.append(h('p', { class: 'hint', style: 'margin:0', text: note || 'Sobald eine Route steht, siehst du hier Wetter und Wind entlang der Strecke.' }));
    return;
  }
  body.dataset.filled = '1';
  const { a, rev, best, closed } = w;
  const temp = Math.round(a.tMin) === Math.round(a.tMax) ? `${fmt(a.tMin)} °C` : `${fmt(a.tMin)} bis ${fmt(a.tMax)} °C`;
  const lead = h('div', { class: 'wx-lead' }, temp + ' ', h('small', { text: codeText(a.code) }));
  const dry = a.maxProb < 20 && a.rain < 0.1;
  const facts = h('ul', { class: 'wx-facts' },
    h('li', {}, 'Wind ', h('b', { text: `${fmt(a.wind)} km/h aus ${compass(a.wdir)}` }), a.gust >= a.wind + 8 ? `, Böen bis ${fmt(a.gust)} km/h` : ''),
    h('li', {}, 'Regen ', h('b', { text: dry ? 'bleibt voraussichtlich trocken' : `Risiko bis ${fmt(a.maxProb)} %` }), !dry && a.rain >= 0.1 ? `, etwa ${fmt(a.rain, 1)} mm` : ''),
    h('li', {}, 'Unterwegs ', h('b', { text: `${clock(a.start)} bis ${clock(a.end)} Uhr` })));

  // Anteile Gegen-, Seiten- und Rückenwind
  const share = h('div', { class: 'comp', style: 'margin-top:0' }, h('h3', { text: 'Wind auf der Strecke' }));
  const track = h('div', { class: 'cbar', role: 'img', 'aria-label': 'Windanteile' }), legend = h('ul', { class: 'clegend' });
  for (const [cls, label, v] of [['head', 'Gegenwind', a.headShare], ['side', 'Seitenwind oder kaum Wind', a.sideShare], ['tail', 'Rückenwind', a.tailShare]]) {
    if (v < 0.005) continue;
    track.append(h('span', { class: 'wind-' + cls, style: `flex:${(v * 100).toFixed(1)} 0 0` }));
    legend.append(h('li', {}, h('i', { class: 'sw wind-' + cls }), h('span', { text: label }), h('span', {}), h('span', { class: 'cl-pct', text: fmt(v * 100) + ' %' })));
  }
  share.append(track, legend);

  // Hinweise
  const hints = h('div', { class: 'wx-hints' });
  const hint = (text, opts = {}) => hints.append(h('div', { class: 'wx-hint' + (opts.warn ? ' warn' : '') }, h('span', { text }),
    opts.action ? h('button', { type: 'button', class: 'ghost-btn', text: opts.label, onclick: opts.action }) : null));
  if (best && best.t !== a.start && penalty(a) - best.p > 0.5) {
    const why = [];
    if (a.maxProb - best.a.maxProb >= 15) why.push('geringeres Regenrisiko');
    if (a.meanComp - best.a.meanComp >= 3 || a.wind - best.a.wind >= 4) why.push('weniger Wind von vorn');
    if (a.night && !best.a.night) why.push('Tageslicht');
    if ((a.tMin < 5 && best.a.tMin > a.tMin + 2) || (a.tMax > 28 && best.a.tMax < a.tMax - 2)) why.push('angenehmere Temperatur');
    hint(`Besser um ${clock(best.t)} Uhr starten` + (why.length ? ': ' + why.join(', ') + '.' : '.'), { label: 'Übernehmen',
      action: () => { $('wxTime').value = clock(best.t); state.departTime = $('wxTime').value; save(); scheduleWeather(); } });
  }
  if (closed && rev && a.wind >= 10) {
    if (rev.lateComp < a.lateComp - 3) hint('Andersherum hast du auf dem Heimweg mehr Rückenwind.', { label: 'Richtung umkehren', action: reverseRoute });
    else if (a.lateComp < -3) hint('Gute Richtung: Gegenwind zuerst, Rückenwind auf dem Heimweg.');
  }
  if (a.firstWet) hint(a.firstWet.d < 1000 ? 'Regen ist schon bei der Abfahrt wahrscheinlich.' : `Regen ist ab etwa km ${fmt(a.firstWet.d / 1000)} wahrscheinlich (${clock(a.firstWet.t)} Uhr).`, { warn: true });
  if (a.rows.some((r) => r.code >= 95)) hint('Unterwegs sind Gewitter möglich.', { warn: true });
  if (a.gust >= 50) hint(`Kräftige Böen bis ${fmt(a.gust)} km/h.`, { warn: true });
  if (a.sunset && a.end > a.sunset - 900 && a.start < a.sunset) hint(`Sonnenuntergang um ${clock(a.sunset)} Uhr, Ankunft gegen ${clock(a.end)} Uhr. Nimm Licht mit.`, { warn: true });
  else if (a.night) hint('Ein Teil der Fahrt liegt im Dunkeln. Nimm Licht mit.', { warn: true });

  // Verlauf entlang der Strecke
  const table = h('table', { class: 'wx-table' }, h('thead', {}, h('tr', {},
    h('th', { text: 'km' }), h('th', { text: 'Uhrzeit' }), h('th', { text: '°C' }), h('th', { text: 'Regen' }), h('th', { text: 'Wind' }), h('th', { text: '' }))));
  const tb = h('tbody', {});
  for (const r of a.rows) {
    tb.append(h('tr', {}, h('td', { text: fmt(r.d / 1000) }), h('td', { text: clock(r.t) }), h('td', { text: fmt(r.temp) }),
      h('td', { text: fmt(r.pprob || 0) + ' %' }), h('td', {}, windArrow(r.wdir), fmt(r.wind) + ' km/h'), h('td', { class: 'rel', text: r.rel })));
  }
  table.append(tb);

  body.append(lead, facts);
  if (hints.children.length) body.append(hints);
  body.append(share, table);
}

// ---------------------------------------------------------------- Export

function defaultTourName() {
  const pts = state.waypoints.filter((w) => w.lat != null);
  if (pts.length < 2 && !state.loop) return 'Tour';
  const short = (s) => s.split(',')[0];
  const a = short(pts[0].label), b = short(pts[pts.length - 1].label);
  const km = route ? ' ' + fmt(route.dist / 1000) + ' km' : '';
  return (state.loop || a === b ? 'Runde ab ' + a : a + ' – ' + b) + km;
}

function gpxFile() {
  const name = state.tourName.trim() || defaultTourName();
  // Dateiname ohne Umlaute und Sonderzeichen, damit ihn auch Garmin-Geräte sauber anzeigen
  const map = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' };
  const safe = name.replace(/[äöüÄÖÜß]/g, (c) => map[c]).normalize('NFD').replace(/[^A-Za-z0-9 _-]+/g, '')
    .trim().replace(/\s+/g, '_') || 'Tour';
  return new File([toGpx(route, name)], safe + '.gpx', { type: 'application/gpx+xml' });
}

function downloadGpx() {
  if (!route) return;
  const file = gpxFile();
  const a = h('a', { href: URL.createObjectURL(file), download: file.name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('GPX heruntergeladen: ' + file.name);
}

async function shareGpx() {
  if (!route) return;
  const file = gpxFile();
  try { await navigator.share({ files: [file], title: file.name }); } catch (e) { if (e.name !== 'AbortError') downloadGpx(); }
}

// ---------------------------------------------------------------- Oberfläche

let toastTimer = 0;
function toast(msg, sticky = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', sticky);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, sticky ? 9000 : 3500);
}
function hideToast() { $('toast').hidden = true; }

// Ergebnisleiste: am Desktop unter der Karte, mobil oben im Bottom-Sheet
function placeDock() {
  const slot = isMobile() ? $('dockSlotMobile') : $('dockSlotDesktop');
  if ($('dock').parentElement !== slot) slot.append($('dock'));
  requestAnimationFrame(() => map && map.resize());
}

const SHEET = ['peek', 'half', 'full'];
function setSheet(mode) {
  const p = $('panel');
  p.style.height = '';
  SHEET.forEach((m) => p.classList.toggle('sheet-' + m, m === mode));
  document.body.dataset.sheet = mode;
}
function initSheet() {
  const p = $('panel'), handle = $('sheetHandle');
  let startY = 0, startH = 0, moved = false, dragging = false;
  setSheet('half');
  handle.addEventListener('pointerdown', (ev) => {
    if (!isMobile()) return;
    dragging = true; moved = false; startY = ev.clientY; startH = p.offsetHeight;
    handle.setPointerCapture(ev.pointerId);
    p.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const dy = startY - ev.clientY;
    if (Math.abs(dy) > 4) moved = true;
    p.style.height = Math.max(90, Math.min(window.innerHeight - 40, startH + dy)) + 'px';
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    p.classList.remove('dragging');
    const cur = SHEET.find((m) => p.classList.contains('sheet-' + m)) || 'half';
    if (!moved) return setSheet(cur === 'peek' ? 'half' : cur === 'half' ? 'full' : 'peek');
    const hNow = p.offsetHeight, vh = window.innerHeight;
    setSheet(hNow < vh * 0.32 ? 'peek' : hNow < vh * 0.72 ? 'half' : 'full');
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  // Beim Tippen in ein Suchfeld das Sheet öffnen, damit die Vorschläge Platz haben
  $('panelScroll').addEventListener('focusin', (ev) => { if (isMobile() && ev.target.matches('input[type=text]')) setSheet('full'); });
}

function init() {
  load();
  initMap();
  initRound();
  initWeather();
  chart = createProfileChart($('profileChart'), { onHover: (d, p) => setHover(d, p) });
  initSheet();
  placeDock();
  window.matchMedia('(max-width: 820px)').addEventListener('change', placeDock);

  renderProfile();
  renderOptions();
  renderWaypoints();
  renderNogos();
  renderAlt();

  $('tourName').value = state.tourName;
  $('tourName').addEventListener('input', () => { state.tourName = $('tourName').value; save(); });
  $('btnAddVia').addEventListener('click', () => {
    const at = state.loop ? state.waypoints.length : state.waypoints.length - 1;
    state.waypoints.splice(at, 0, emptyWp());
    renderWaypoints();
    $('wpList').querySelectorAll('input')[at].focus();
  });
  $('btnReverse').addEventListener('click', reverseRoute);
  $('btnNew').addEventListener('click', () => {
    state.waypoints = [emptyWp(), emptyWp()];
    state.nogos = [];
    state.loop = false;
    renderLoop();
    state.tourName = '';
    $('tourName').value = '';
    fitNext = true;
    renderWaypoints(); renderNogos(); changed();
    if (isMobile()) setSheet('half');
  });
  $('btnResetOpt').addEventListener('click', (ev) => {
    ev.preventDefault();
    state.options[state.profile] = structuredClone(DEFAULT_OPTIONS[state.profile]);
    renderOptions(); changed();
  });
  $('speedInput').addEventListener('change', () => {
    const v = parseFloat($('speedInput').value);
    if (v >= 5 && v <= 60) { state.speeds[state.profile] = v; save(); renderTime(); scheduleWeather(); } else $('speedInput').value = state.speeds[state.profile];
  });
  $('btnLocate').addEventListener('click', () => locate(null));
  $('btnGpx').addEventListener('click', downloadGpx);
  if (navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.gpx', { type: 'application/gpx+xml' })] })) {
    $('btnShare').hidden = false;
    $('btnShare').addEventListener('click', shareGpx);
  }
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { toggleLayerMenu(false); closeMenu(); } });

  if (state.waypoints.filter((w) => w.lat != null).length >= 2) calcRoute();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
