/* global maplibregl */
// Rückenwind: Oberfläche und Ablauf der App.
// Aufbau dieser Datei: Zustand · Karte · Wegpunkte · Suche und Standort · Sperrzonen · Optionen · Route ·
// Vorschläge (Rundtour, Umweg) · Abfahrt und Wetter · Navigation · Export · Meine Touren und Offline ·
// Stopps · Oberfläche (Bottom-Sheet, Höhenprofil) · Start.
// Rechnen und Daten liegen in eigenen Dateien: routing.js, roundtrip.js, weather.js, pois.js, offline.js, elevation.js.
import {
  PROFILES, DEFAULT_OPTIONS, travelHours, findClimbs, projectOnRoute, routeBearing, haversine, fetchRoute, RouteError, nearestIndex, pointAt, toGpx, parseGpx, simplifyTrack,
  SURFACES, SURFACE_LABEL, WAYS, WAY_LABEL,
} from './routing.js';
import { createProfileChart } from './elevation.js';
import { generateRoundTrips, generateDetours } from './roundtrip.js';
import { POI_CATS, POI_GROUPS, fetchPois, PoiError } from './pois.js';
import { listOffline, planDownload, runDownload, removeDownload } from './offline.js';
import { searchRoutes, searchRoutesQuick, loadRouteTrack, sliceTrack, previewRoute, cachedPreview, hasPreview, fetchRouteLengths, prefetchPreviews, byImportance, buildRouteTour, suggestRouteLoops, routeLabel } from './routes.js';
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
const online = () => navigator.onLine !== false;
const mb = (bytes) => (bytes < 10e6 ? fmt(bytes / 1e6, 1) : fmt(bytes / 1e6)) + ' MB';

// ---------------------------------------------------------------- Zustand

const STORE_KEY = 'rueckenwind.v1';
const TABS = { plan: 'Planen', routen: 'Routen', tour: 'Tour', wetter: 'Wetter', stopps: 'Stopps', touren: 'Meine' };
const emptyWp = () => ({ id: uid(), lat: null, lon: null, label: '' });

const state = {
  profile: 'rennrad',
  options: structuredClone(DEFAULT_OPTIONS),
  speeds: Object.fromEntries(Object.entries(PROFILES).map(([k, p]) => [k, p.speed])),
  layer: 'standard',
  layerV: 2,
  trails: 'none',
  mode: 'route',
  loop: false,
  round: { km: 50, dir: 'any', climb: 'any', wind: true },
  departTime: '',
  windOnMap: true,
  poiCats: [],
  poiRadius: 300,
  folds: {},
  detourKm: '',
  chartH: { desktop: 110, mobile: 90 },
  tab: 'plan',
  panelW: 404,
  routeTour: null, // Tour auf einer eingetragenen Route: { id, name, from, to, approach, back }
  rtOpts: { approach: true, back: false },
  rtRoundOnly: false,
  rtKind: '',   // Art in der Routenliste: bicycle, mtb, hiking; leer = passend zum Profil
  rtMaxKm: 0,   // Länge höchstens (0 = beliebig)
  radar: false,
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
    if (typeof s.trails === 'string') state.trails = s.trails;
    if (s.mode === 'round') state.mode = 'round';
    state.loop = !!s.loop;
    if (s.round) state.round = { ...state.round, ...s.round };
    if (typeof s.departTime === 'string') state.departTime = s.departTime;
    if (typeof s.windOnMap === 'boolean') state.windOnMap = s.windOnMap;
    if (Array.isArray(s.poiCats)) state.poiCats = s.poiCats.filter((c) => POI_CATS[c]);
    if (s.poiRadius >= 100 && s.poiRadius <= 5000) state.poiRadius = s.poiRadius;
    if (s.folds && typeof s.folds === 'object') state.folds = s.folds;
    if (s.detourKm) state.detourKm = s.detourKm;
    if (s.chartH && s.chartH.desktop > 0 && s.chartH.mobile > 0) state.chartH = s.chartH;
    if (TABS[s.tab]) state.tab = s.tab;
    if (s.panelW >= 300 && s.panelW <= 720) state.panelW = s.panelW;
    if (s.routeTour && s.routeTour.id) state.routeTour = s.routeTour;
    if (s.rtOpts) state.rtOpts = { ...state.rtOpts, ...s.rtOpts };
    state.rtRoundOnly = !!s.rtRoundOnly;
    if (['bicycle', 'mtb', 'hiking'].includes(s.rtKind)) state.rtKind = s.rtKind;
    if (s.rtMaxKm > 0) state.rtMaxKm = s.rtMaxKm;
    state.radar = !!s.radar;
    if (Array.isArray(s.waypoints) && s.waypoints.length >= 2) state.waypoints = s.waypoints.map((w) => ({ ...emptyWp(), ...w, id: uid() }));
    if (Array.isArray(s.nogos)) state.nogos = s.nogos.map((n) => ({ ...n, id: uid() }));
    if (Array.isArray(s.favorites)) state.favorites = s.favorites;
    if (typeof s.tourName === 'string') state.tourName = s.tourName;
    if (s.view && Number.isFinite(s.view.lat)) state.view = s.view;
  } catch (e) { /* gespeicherter Stand unlesbar: mit Standard starten */ }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* Speicher nicht verfügbar */ }
  trackUndo();
}

// ---------------------------------------------------------------- Rückgängig
// Jeder gespeicherte Stand der Planung (Punkte, Profil, Einstellungen, Sperrzonen, übernommene Route) ist ein Schritt.
// Die berechnete Strecke wird mitgemerkt, damit Rückgängig sofort wirkt, ohne neu zu rechnen.
const UNDO_MAX = 40;
let undoCur = null, undoBusy = false;
const undoStack = [], redoStack = [];
function planState() {
  return {
    mode: state.mode, profile: state.profile, options: structuredClone(state.options[state.profile]), loop: state.loop,
    waypoints: state.waypoints.filter((w) => w.lat != null).map((w) => ({ lat: w.lat, lon: w.lon, label: w.label })),
    nogos: state.nogos.map((n) => ({ lat: n.lat, lon: n.lon, radius: n.radius })),
    rt: state.routeTour ? structuredClone(state.routeTour) : null,
  };
}
// Vergleichsschlüssel ohne Ortsnamen (die kommen oft erst später nach)
const planKey = (p) => JSON.stringify({ ...p, waypoints: p.waypoints.map((w) => [+w.lat.toFixed(6), +w.lon.toFixed(6)]) });

function trackUndo() {
  if (undoBusy) return;
  const plan = planState(), key = planKey(plan);
  if (!undoCur) { undoCur = { plan, key }; return; }
  if (key === undoCur.key) { undoCur.plan = plan; return; } // nur Namen nachgetragen
  undoStack.push(undoCur);
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;
  undoCur = { plan, key };
  renderUndo();
}
// fertige Strecke dem aktuellen Stand zuordnen
function noteRoute() {
  if (undoCur && route && planKey(planState()) === undoCur.key) { undoCur.route = route; undoCur.alt = alt; }
}

// Was hat sich zwischen zwei Ständen geändert? Für die Meldung.
function planDiff(a, b) {
  if (a.profile !== b.profile) return 'Profil gewechselt';
  if (JSON.stringify(a.rt) !== JSON.stringify(b.rt)) return a.rt || b.rt ? 'Route aus „Routen“' : 'Route';
  if (a.mode !== b.mode) return 'Art der Planung gewechselt';
  if (a.nogos.length !== b.nogos.length) return a.nogos.length < b.nogos.length ? 'Sperrzone gesetzt' : 'Sperrzone entfernt';
  if (JSON.stringify(a.nogos) !== JSON.stringify(b.nogos)) return 'Sperrzone geändert';
  if (JSON.stringify(a.options) !== JSON.stringify(b.options)) return 'Einstellung geändert';
  if (a.waypoints.length === 0 && b.waypoints.length > 1) return 'Tour geladen';
  if (b.waypoints.length === 0) return 'Neue Tour';
  if (a.waypoints.length !== b.waypoints.length) return Math.abs(a.waypoints.length - b.waypoints.length) > 1 ? 'Wegpunkte geändert'
    : a.waypoints.length < b.waypoints.length ? 'Punkt gesetzt' : 'Punkt entfernt';
  if (a.loop !== b.loop) return b.loop ? 'Zurück zum Start eingeschaltet' : 'Zurück zum Start ausgeschaltet';
  const same = (x, y) => x.length === y.length && x.every((w, i) => w.lat === y[i].lat && w.lon === y[i].lon);
  const rev = b.loop ? [b.waypoints[0], ...b.waypoints.slice(1).reverse()] : [...b.waypoints].reverse();
  if (same(a.waypoints, rev)) return 'Richtung umgekehrt';
  const moved = a.waypoints.filter((w, i) => w.lat !== b.waypoints[i].lat || w.lon !== b.waypoints[i].lon).length;
  if (moved > 1) return 'Wegpunkte geändert';
  return 'Punkt verschoben';
}

function applyPlan(entry) {
  const p = entry.plan;
  undoBusy = true;
  try {
    state.mode = p.mode;
    state.profile = p.profile;
    state.options[p.profile] = structuredClone(p.options);
    state.loop = p.loop;
    state.routeTour = p.rt ? structuredClone(p.rt) : null;
    state.nogos = p.nogos.map((n) => ({ ...n, id: uid() }));
    state.waypoints = p.waypoints.map((w) => ({ id: uid(), ...w }));
    while (state.waypoints.length < 2) state.waypoints.push(emptyWp());
    if (state.mode === 'round') state.waypoints = state.waypoints.length > 1 && state.waypoints[1].lat != null ? state.waypoints : [state.waypoints[0], emptyWp()];
    renderProfile(); renderOptions(); renderMode(); renderLoop(); renderWaypoints(); renderNogos(); renderRtInfo();
    clearCandidates();
    if (entry.route) {
      // bereits berechnete Strecke wieder zeigen
      if (routeCtrl) { routeCtrl.abort(); routeCtrl = null; }
      clearTimeout(routeTimer);
      $('busy').hidden = true;
      route = entry.route;
      alt = entry.alt || 0;
      renderAlt();
      save();
      showRoute();
    } else changed();
  } finally { undoBusy = false; }
  undoCur = entry;
  renderUndo();
}

function undo() {
  if (!undoStack.length || nav) return;
  const prev = undoStack.pop(), what = planDiff(prev.plan, undoCur.plan);
  redoStack.push(undoCur);
  applyPlan(prev);
  toast('Rückgängig: ' + what);
}
function redo() {
  if (!redoStack.length || nav) return;
  const next = redoStack.pop(), what = planDiff(undoCur.plan, next.plan);
  undoStack.push(undoCur);
  applyPlan(next);
  toast('Wiederhergestellt: ' + what);
}
function renderUndo() {
  if (!$('btnUndo')) return;
  $('btnUndo').disabled = !undoStack.length;
  $('btnRedo').hidden = !redoStack.length;
}
function initUndo() {
  trackUndo();
  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);
  document.addEventListener('keydown', (ev) => {
    if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || ev.key.toLowerCase() !== 'z' && ev.key.toLowerCase() !== 'y') return;
    const t = ev.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return; // dort gilt das Rückgängig des Textfelds
    ev.preventDefault();
    if (ev.key.toLowerCase() === 'y' || ev.shiftKey) redo(); else undo();
  });
  renderUndo();
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
  hell: { label: 'Hell', style: 'https://tiles.openfreemap.org/styles/positron' },
  radkarte: { label: 'Radkarte', style: raster(['a', 'b', 'c'].map((s) => `https://${s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png`),
    '<a href="https://www.cyclosm.org" target="_blank" rel="noopener">CyclOSM</a> | ' + OSM, 19) },
  topo: { label: 'Topo', style: raster(['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
    OSM + ', SRTM | <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a>', 17) },
  topplus: { label: 'Topo amtlich (DE)', style: raster(['https://sgx.geodatenzentrum.de/wmts_topplus_open/tile/1.0.0/web/default/WEBMERCATOR/{z}/{y}/{x}.png'],
    '© <a href="https://www.bkg.bund.de" target="_blank" rel="noopener">Bundesamt für Kartographie und Geodäsie</a>, TopPlusOpen', 18) },
  basemapat: { label: 'Österreich', style: raster(['https://mapsneu.wien.gv.at/basemap/geolandbasemap/normal/google3857/{z}/{y}/{x}.png'],
    'Datenquelle: <a href="https://www.basemap.at" target="_blank" rel="noopener">basemap.at</a>', 19) },
  satellit: { label: 'Satellit', style: raster(['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    'Bilder © Esri, Maxar, Earthstar Geographics', 19) },
};

// Markierte Routen als Überlagerung über jeder Grundkarte
const TRAILS = { none: 'Keine', hiking: 'Wanderwege', cycling: 'Radrouten', mtb: 'MTB-Routen' };
function applyTrails() {
  if (!map.isStyleLoaded() && !map.getSource('route')) return;
  if (map.getLayer('trails')) map.removeLayer('trails');
  if (map.getSource('trails')) map.removeSource('trails');
  for (const b of $('layerMenu').querySelectorAll('[data-trail]')) b.setAttribute('aria-checked', String(b.dataset.trail === state.trails));
  if (!TRAILS[state.trails] || state.trails === 'none') return;
  map.addSource('trails', { type: 'raster', tiles: [`https://tile.waymarkedtrails.org/${state.trails}/{z}/{x}/{y}.png`], tileSize: 256, maxzoom: 17,
    attribution: 'Routen: <a href="https://waymarkedtrails.org" target="_blank" rel="noopener">Waymarked Trails</a>' });
  // unter den eigenen Ebenen (Route, Sperrzonen), über der Grundkarte
  map.addLayer({ id: 'trails', type: 'raster', source: 'trails', paint: { 'raster-opacity': 0.85 } }, map.getLayer('nogo-fill') ? 'nogo-fill' : undefined);
}

// Regenradar (RainViewer): letztes Radarbild als Überlagerung, alle fünf Minuten erneuert
let radarTimer = 0, radarInfo = null;
async function applyRadar() {
  clearTimeout(radarTimer);
  const btn = $('layerMenu').querySelector('[data-radar]');
  if (btn) btn.setAttribute('aria-checked', String(state.radar));
  const clear = () => { if (map.getLayer('radar')) map.removeLayer('radar'); if (map.getSource('radar')) map.removeSource('radar'); };
  if (!state.radar || !online()) { clear(); radarInfo = null; return renderRadarInfo(); }
  try {
    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    const data = await res.json(), frames = (data.radar && data.radar.past) || [], last = frames[frames.length - 1];
    if (!last) throw new Error('keine Radarbilder');
    if (!state.radar) return;
    clear();
    map.addSource('radar', { type: 'raster', tiles: [`${data.host}${last.path}/256/{z}/{x}/{y}/2/1_1.png`], tileSize: 256, maxzoom: 7,
      attribution: 'Radar: <a href="https://www.rainviewer.com" target="_blank" rel="noopener">RainViewer</a>' });
    map.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': 0.6 } }, map.getLayer('nogo-fill') ? 'nogo-fill' : undefined);
    radarInfo = 'Regenradar, Stand ' + new Date(last.time * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  } catch (e) {
    clear();
    radarInfo = 'Das Regenradar ist gerade nicht erreichbar.';
  }
  renderRadarInfo();
  radarTimer = setTimeout(applyRadar, 5 * 60 * 1000);
}
function renderRadarInfo() {
  $('radarBadge').hidden = !radarInfo;
  $('radarBadge').textContent = radarInfo || '';
}

let map, chart, hoverMarker = null, popup = null;
let markers = [], nogoMarkers = [];
const EMPTY = { type: 'FeatureCollection', features: [] };
const overlay = { route: EMPTY, cands: EMPTY, nogo: EMPTY, wind: EMPTY, sel: EMPTY, rtrack: EMPTY, rsec: EMPTY, rtprev: EMPTY, rtall: EMPTY };

// Weißer Winkel, der in Fahrtrichtung zeigt (wird entlang der Route wiederholt)
function chevronImage() {
  const c = document.createElement('canvas');
  c.width = c.height = 24;
  const g = c.getContext('2d');
  g.strokeStyle = '#ffffff'; g.lineWidth = 3.4; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(9, 6); g.lineTo(15, 12); g.lineTo(9, 18); g.stroke();
  return g.getImageData(0, 0, 24, 24);
}
// Teilstück der Route zwischen zwei Distanzen als Linie
function sliceFeature(r, from, to, props) {
  const a = pointAt(r, from), b = pointAt(r, to), coordinates = [[a.lon, a.lat]];
  for (let i = a.i + 1; i <= b.i; i++) coordinates.push([r.lon[i], r.lat[i]]);
  coordinates.push([b.lon, b.lat]);
  return { type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates } };
}

function setLayer(key) {
  if (!LAYERS[key]) key = 'standard';
  if (!online() && key !== 'standard') return toast('Ohne Internet gibt es nur die Standardkarte.');
  state.layer = key;
  map.setStyle(LAYERS[key].style, { diff: false });
  for (const b of $('layerMenu').querySelectorAll('[data-key]')) b.setAttribute('aria-checked', b.dataset.key === key ? 'true' : 'false');
  save();
}

// Eigene Ebenen (Route, Vorschläge, Sperrzonen) liegen über jeder Basiskarte und werden
// nach jedem Stilwechsel neu angelegt.
function addOverlays() {
  if (map.getSource('route')) return;
  for (const k of ['nogo', 'cands', 'rtall', 'rtprev', 'rtrack', 'rsec', 'wind', 'route', 'sel']) map.addSource(k, { type: 'geojson', data: overlay[k] });
  if (!map.hasImage('chevron')) map.addImage('chevron', chevronImage(), { pixelRatio: 2 });
  const round = { 'line-cap': 'round', 'line-join': 'round' };
  map.addLayer({ id: 'nogo-fill', type: 'fill', source: 'nogo', paint: { 'fill-color': '#b3261e', 'fill-opacity': 0.14 } });
  map.addLayer({ id: 'nogo-line', type: 'line', source: 'nogo', paint: { 'line-color': '#b3261e', 'line-width': 2, 'line-dasharray': [3, 2.5] } });
  map.addLayer({ id: 'cand-casing', type: 'line', source: 'cands', layout: round, paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9 } });
  map.addLayer({ id: 'cand-line', type: 'line', source: 'cands', layout: round, paint: { 'line-color': '#47595d', 'line-width': 3.5 } });
  map.addLayer({ id: 'cand-hit', type: 'line', source: 'cands', paint: { 'line-color': '#000', 'line-width': 24, 'line-opacity': 0.01 } });
  // eingetragene Route im Reiter „Routen“ (blau) und der gewählte Abschnitt
  // Vorschau beim Überfahren der Liste: grob, gestrichelt
  // alle Routen der Liste; die hervorgehobene (Maus, gerade geöffnet) liegt darüber
  map.addLayer({ id: 'rtall-casing', type: 'line', source: 'rtall', layout: round, paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.85 } });
  map.addLayer({ id: 'rtall-line', type: 'line', source: 'rtall', layout: round, paint: { 'line-color': '#2a78d6', 'line-width': 3, 'line-opacity': 0.85 } });
  map.addLayer({ id: 'rtall-hit', type: 'line', source: 'rtall', paint: { 'line-color': '#000', 'line-width': 18, 'line-opacity': 0.01 } });
  map.addLayer({ id: 'rtprev-casing', type: 'line', source: 'rtprev', layout: round, paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.95 } });
  map.addLayer({ id: 'rtprev-line', type: 'line', source: 'rtprev', layout: round, paint: { 'line-color': '#1f5fae', 'line-width': 5 } });
  map.addLayer({ id: 'rt-casing', type: 'line', source: 'rtrack', layout: round, paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9 } });
  map.addLayer({ id: 'rt-line', type: 'line', source: 'rtrack', layout: round, paint: { 'line-color': '#2a78d6', 'line-width': 3.5, 'line-opacity': 0.75 } });
  map.addLayer({ id: 'rsec-line', type: 'line', source: 'rsec', layout: round, paint: { 'line-color': '#1f5fae', 'line-width': 7 } });
  map.addLayer({ id: 'rt-hit', type: 'line', source: 'rtrack', paint: { 'line-color': '#000', 'line-width': 24, 'line-opacity': 0.01 } });
  // Wind als farbiger Rand der Route: rot = Gegenwind, violett = Rückenwind
  map.addLayer({ id: 'wind-halo', type: 'line', source: 'wind', layout: round,
    paint: { 'line-color': ['match', ['get', 'cls'], 'head', '#d03b3b', '#6250d6'], 'line-width': 15, 'line-opacity': 0.9 } });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.95 } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#d0146a', 'line-width': 5 } });
  // im Höhenprofil ausgewählter Abschnitt
  map.addLayer({ id: 'sel-line', type: 'line', source: 'sel', layout: round, paint: { 'line-color': '#12262b', 'line-width': 5 } });
  // kleine Pfeile in Fahrtrichtung
  map.addLayer({ id: 'route-dir', type: 'symbol', source: 'route', layout: { 'symbol-placement': 'line', 'symbol-spacing': 110,
    'icon-image': 'chevron', 'icon-size': 0.9, 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map' } });
  map.addLayer({ id: 'route-hit', type: 'line', source: 'route', paint: { 'line-color': '#000', 'line-width': 24, 'line-opacity': 0.01 } });
  applyTrails();
  applyRadar();
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
    container: 'map', style: online() && LAYERS[state.layer] ? LAYERS[state.layer].style : LAYERS.standard.style,
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
  menu.append(h('div', { class: 'menu-sep', text: 'Markierte Routen' }));
  for (const key in TRAILS) {
    menu.append(h('button', { type: 'button', role: 'menuitemradio', 'data-trail': key, text: TRAILS[key], 'aria-checked': String(key === state.trails),
      onclick: () => { state.trails = key; save(); applyTrails(); toggleLayerMenu(false); } }));
  }
  menu.append(h('div', { class: 'menu-sep', text: 'Wetter' }));
  menu.append(h('button', { type: 'button', role: 'menuitemcheckbox', 'data-radar': '1', text: 'Regenradar', 'aria-checked': String(state.radar),
    onclick: () => { state.radar = !state.radar; save(); applyRadar(); toggleLayerMenu(false); } }));
  $('btnLayers').addEventListener('click', () => toggleLayerMenu($('layerMenu').hidden));

  map.on('moveend', () => {
    const c = map.getCenter();
    state.view = { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
    save();
  });
  // Ein einzelner Klick wird kurz zurückgehalten: Folgt ein zweiter, ist es ein Doppelklick zum Zoomen.
  let clickTimer = 0, lastClick = 0;
  // Auch ein beginnender Zoom (Doppeltipp am Tablet) oder ein Verschieben hebt den zurückgehaltenen Klick auf.
  const cancelClick = () => { clearTimeout(clickTimer); clickTimer = 0; };
  map.on('dblclick', () => { cancelClick(); lastClick = 0; });
  map.on('zoomstart', cancelClick);
  map.on('dragstart', cancelClick);
  map.on('click', (ev) => {
    const now = Date.now(), second = now - lastClick < 500;
    lastClick = second ? 0 : now;
    cancelClick();
    if (second) return;
    clickTimer = setTimeout(() => { clickTimer = 0; handleMapClick(ev); }, 420);
  });
  function handleMapClick(ev) {
    if (nav) return;
    toggleLayerMenu(false);
    const box = [[ev.point.x - 9, ev.point.y - 9], [ev.point.x + 9, ev.point.y + 9]];
    if (state.tab === 'routen') {
      if (!rtSel && !rtLoading) return rtPick(box, ev.lngLat.lat, ev.lngLat.lng);
      const onTrack = rtSel && map.getLayer('rt-hit') && map.queryRenderedFeatures(box, { layers: ['rt-hit'] }).length;
      return onTrack ? rtMenu(ev.lngLat.lat, ev.lngLat.lng) : rtStartMenu(ev.lngLat.lat, ev.lngLat.lng);
    }
    const layers = ['route-hit', 'cand-hit'].filter((id) => map.getLayer(id));
    const hits = layers.length ? map.queryRenderedFeatures(box, { layers }) : [];
    const cand = hits.find((f) => f.layer.id === 'cand-hit');
    if (hits.some((f) => f.layer.id === 'route-hit')) {
      if (state.mode === 'route' && !state.routeTour) addVia(ev.lngLat.lat, ev.lngLat.lng);
      return;
    }
    if (cand) return applyCandidate(cand.properties.i);
    if (state.routeTour) return toast('Diese Tour folgt einer eingetragenen Route. Ändere sie im Reiter „Routen“ oder wandle sie unter „Planen“ in eine normale Route um.');
    onMapClick(ev.lngLat.lat, ev.lngLat.lng);
  }
  map.on('mousemove', 'route-hit', (ev) => {
    if (!route) return;
    map.getCanvas().style.cursor = state.mode === 'route' && !state.routeTour ? 'copy' : '';
    const i = nearestIndex(route, ev.lngLat.lat, ev.lngLat.lng);
    setHover(route.cum[i], { lat: route.lat[i], lon: route.lon[i] });
    chart.setCursor(route.cum[i]);
  });
  map.on('mouseleave', 'route-hit', () => { map.getCanvas().style.cursor = ''; setHover(null); chart.setCursor(null); });
  // Routen auf der Karte: unter der Maus hervorheben
  let rtHover = null;
  map.on('mousemove', 'rtall-hit', (ev) => {
    const id = ev.features[0].properties.id;
    map.getCanvas().style.cursor = 'pointer';
    if (id === rtHover) return;
    rtHover = id;
    setOverlay('rtprev', cachedPreview(id) || EMPTY);
  });
  map.on('mouseleave', 'rtall-hit', () => { map.getCanvas().style.cursor = ''; rtHover = null; if (!rtLoading) setOverlay('rtprev', EMPTY); });
  map.on('mouseenter', 'cand-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'cand-hit', () => { map.getCanvas().style.cursor = ''; });
}

function toggleLayerMenu(open) {
  $('layerMenu').hidden = !open;
  $('btnLayers').setAttribute('aria-expanded', String(open));
}

// Freie Kartenfläche neben Seitenleiste, Ergebnisleiste oder Bottom-Sheet
function fitPadding() {
  if (isMobile()) return { top: 70, left: 40, right: 40, bottom: sheetVisible() + 30 };
  return { top: 70, left: 70, right: 70, bottom: 50 };
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
      item('Rundtour über diesen Punkt', () => setRoundVia(lat, lng, null)),
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
  renderRtInfo();
  const list = $('wpList');
  list.replaceChildren();
  state.waypoints.forEach((w, i) => {
    if (state.mode === 'round' && i > 0) return;
    const input = h('input', { class: 'wp-input', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: wpName(i) + ' suchen oder auf Karte tippen', 'aria-label': wpName(i) });
    input.value = w.label;
    const drop = h('div', { class: 'ac', hidden: true });
    attachAutocomplete(input, drop, wpTarget(i));
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

// Ziel einer Ortssuche: ein Wegpunkt oder (bei der Rundtour) der Wunschpunkt
const wpTarget = (index) => ({
  pick: (lat, lon, label) => { fitNext = true; setWaypoint(index, lat, lon, label); },
  locate: () => locate(index),
  label: () => (state.waypoints[index] ? state.waypoints[index].label : ''),
  isSet: () => !!state.waypoints[index] && state.waypoints[index].lat != null,
});

function attachAutocomplete(input, drop, target) {
  let ctrl = null, timer = 0, items = [], active = -1;

  const close = () => { drop.hidden = true; active = -1; };
  const choose = (it) => {
    close();
    input.blur();
    if (isMobile()) setSheet('half');
    if (it.locate) return target.locate();
    target.pick(it.lat, it.lon, it.short || it.main);
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
  const baseItems = () => [...(target.locate ? [{ locate: true, main: 'Mein Standort' }] : []), ...state.favorites.map((f) => ({ fav: true, main: f.label, sub: 'Favorit', lat: f.lat, lon: f.lon }))];

  const run = async () => {
    const q = input.value.trim();
    if (ctrl) ctrl.abort();
    if (q.length < 2) return show(baseItems());
    if (!online()) return show([], 'Die Ortssuche braucht Internet.');
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

  input.addEventListener('focus', () => { input.select(); if (input.value.trim().length < 2 || target.isSet()) show(baseItems()); else run(); });
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 280); });
  input.addEventListener('blur', () => { setTimeout(close, 120); input.value = target.label(); });
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

// Eigener Standort: blauer Punkt auf der Karte, der sich mitbewegt
let meMarker = null, watchId = null, lastPos = null;

function showMe(pos) {
  lastPos = { lat: pos.coords.latitude, lon: pos.coords.longitude, at: Date.now() };
  if (!meMarker) meMarker = new maplibregl.Marker({ element: h('div', { class: 'me-dot', title: 'Mein Standort' }) }).setLngLat([lastPos.lon, lastPos.lat]).addTo(map);
  else meMarker.setLngLat([lastPos.lon, lastPos.lat]);
  if (nav) navUpdate(pos);
}

function startWatch(center) {
  if (!navigator.geolocation) { if (center) toast('Dieser Browser kann den Standort nicht bestimmen.'); return; }
  const go = () => map.easeTo({ center: [lastPos.lon, lastPos.lat], zoom: Math.max(map.getZoom(), 14) });
  if (watchId != null) { if (center && lastPos) go(); return; }
  if (center) toast('Standort wird bestimmt …');
  watchId = navigator.geolocation.watchPosition((pos) => {
    showMe(pos);
    if (center) { center = false; hideToast(); go(); }
  }, (err) => {
    if (center) toast('Der Standort ist nicht verfügbar. Erlaube den Zugriff in den Einstellungen des Browsers.');
    center = false;
    // Nur bei verweigertem Zugriff aufgeben; ein kurzer GPS-Ausfall (Tunnel, Wald) darf die Ortung nicht beenden
    if (err && err.code === 1) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}

// Eigene Position einmal bestimmen (eine frische Ortung wird wiederverwendet) und an "use" übergeben
function myPosition(use) {
  if (!navigator.geolocation) return toast('Dieser Browser kann den Standort nicht bestimmen.');
  const done = (lat, lon) => { hideToast(); use(lat, lon); startWatch(false); };
  if (lastPos && Date.now() - lastPos.at < 30000) return done(lastPos.lat, lastPos.lon);
  toast('Standort wird bestimmt …');
  navigator.geolocation.getCurrentPosition((pos) => { showMe(pos); done(pos.coords.latitude, pos.coords.longitude); },
    () => toast('Der Standort ist nicht verfügbar. Erlaube den Zugriff in den Einstellungen des Browsers.'), { enableHighAccuracy: true, timeout: 12000 });
}

function locate(index) {
  if (index == null) return startWatch(true);
  myPosition((lat, lon) => {
    if (state.mode === 'round' || state.waypoints.filter((w) => w.lat != null).length === 0) map.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 13) });
    else fitNext = true;
    setWaypoint(index, lat, lon, null);
  });
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
// Reihenfolge ist für alle Radtypen gleich: erst die gemeinsamen Optionen, dann die speziellen.
const BIKES = ['rennrad', 'gravel', 'alltag'];
const OPTION_DEFS = [
  { key: 'sac', label: 'Schwierigkeit höchstens', steps: [[1, 'T1'], [2, 'T2'], [3, 'T3'], [4, 'T4'], [5, 'T5/T6']], only: ['wandern'], main: true,
    note: 'T1 Talweg, T2 einfacher Bergweg (Alpenverein: blau), T3 mittelschwer (rot), T4 schwer (schwarz), T5/T6 alpin, oft weglos. Schwerere Wege sind gesperrt.' },
  { key: 'traffic', label: 'Autoverkehr', steps: ['egal', 'normal', 'wenig', 'kaum'], only: BIKES, main: true },
  { key: 'elevation', label: 'Höhenmeter', steps: [['flat', 'flach halten'], ['balanced', 'ausgewogen'], ['nosteep', 'Rampen meiden']], only: BIKES, main: true },
  { key: 'elevation', label: 'Höhenmeter', steps: [['flat', 'möglichst wenig'], ['balanced', 'egal']], only: ['wandern'], main: true },
  { key: 'forest', label: 'Wald', steps: STEP3 },
  { key: 'river', label: 'Flüsse und Seen', steps: STEP3 },
  { key: 'town', label: 'Ortschaften', steps: ['egal', 'eher meiden', 'umfahren'] },
  { key: 'noMain', label: 'Bundesstraßen meiden', only: BIKES, main: true },
  { key: 'ferries', label: 'Fähren erlauben' },
  { key: 'cycleways', label: 'Radwege mitnutzen', only: ['rennrad'] },
  { key: 'cobble', label: 'Kopfsteinpflaster meiden', only: ['rennrad'] },
  { key: 'strictPaved', label: 'Schotter strikt ausschließen', note: 'Sonst sind kurze Stücke erlaubt, wenn sie einen großen Umweg sparen.', only: ['rennrad'] },
  { key: 'preferUnpaved', label: 'Schotterwege bevorzugen', only: ['gravel'] },
  { key: 'trails', label: 'Pfade und Trails erlauben', note: 'Auch schmale, verwurzelte Wege.', only: ['gravel'] },
  { key: 'wet', label: 'Nasse Verhältnisse', note: 'Meidet Wege, die bei Nässe schmierig werden.', only: ['gravel', 'wandern'] },
  { key: 'cycleRoutes', label: 'Ausgeschilderten Radrouten folgen', only: ['gravel', 'alltag'] },
  { key: 'hikingRoutes', label: 'Markierte Wanderwege bevorzugen', only: ['wandern'] },
  { key: 'paths', label: 'Pfade statt Straßen und Forstwege', only: ['wandern'] },
  { key: 'visibility', label: 'Schlecht erkennbare Wege meiden', only: ['wandern'] },
  { key: 'ferrata', label: 'Klettersteige erlauben', only: ['wandern'],
    note: 'Nur mit Klettersteigset und Erfahrung. Der Grad des Klettersteigs lässt sich nicht einschränken.' },
];

function renderOptions() {
  const o = state.options[state.profile];
  const list = $('optList');
  list.replaceChildren();
  let special = false;
  for (const def of OPTION_DEFS) {
    if (def.only && !def.only.includes(state.profile)) continue;
    if (def.only && !def.main && !special) { special = true; list.append(h('h3', { class: 'opt-group', text: 'Nur für ' + PROFILES[state.profile].label })); }
    if (def.steps) {
      const seg = h('div', { class: 'seg seg-small', role: 'radiogroup', 'aria-label': def.label });
      def.steps.forEach((s, i) => {
        const val = Array.isArray(s) ? s[0] : i, text = Array.isArray(s) ? s[1] : s;
        seg.append(h('button', { type: 'button', role: 'radio', 'aria-checked': String(o[def.key] === val), text,
          onclick: () => { o[def.key] = val; renderOptions(); changed(); } }));
      });
      list.append(h('div', { class: 'opt opt-steps' }, h('span', { class: 'opt-label', text: def.label }), seg, def.note ? h('span', { class: 'opt-note', text: def.note }) : null));
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
      onclick: () => {
        // Rundtour-Länge an Rad oder Fuß anpassen
        const foot = !!PROFILES[key].foot;
        if (foot && state.round.km > 40) state.round.km = 12;
        if (!foot && state.round.km < 15) state.round.km = 50;
        $('roundKm').value = state.round.km;
        state.profile = key; renderProfile(); renderOptions(); changed();
      } }));
  }
  $('speedLabel').textContent = { rennrad: 'Rennrad: Tempo in der Ebene', gravel: 'Gravelbike: Tempo in der Ebene', alltag: 'Alltagsrad: Tempo in der Ebene', wandern: 'Gehtempo in der Ebene' }[state.profile];
  renderRoundChips();
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
  if (state.routeTour) return calcRouteTour();
  const pts = state.waypoints.filter((w) => w.lat != null);
  if (routeCtrl) routeCtrl.abort();
  const distinct = pts.some((p) => Math.abs(p.lat - pts[0].lat) > 1e-5 || Math.abs(p.lon - pts[0].lon) > 1e-5);
  if (pts.length < 2 || !distinct) { route = null; $('busy').hidden = true; showRoute(); return; }
  if (state.loop) pts.push(pts[0]);
  if (!online()) { $('busy').hidden = true; toast('Ohne Internet lässt sich keine Route berechnen. Offline-Touren findest du unter „Meine Touren“.', true); return; }
  routeCtrl = new AbortController();
  const ctrl = routeCtrl;
  $('busy').hidden = false;
  try {
    const r = await fetchRoute({ profile: state.profile, options: state.options[state.profile], points: pts, nogos: state.nogos, alt, signal: ctrl.signal,
      onProgress: (done, total) => { if (ctrl === routeCtrl && total > 1) toast(`Lange Strecke: wird in ${total} Etappen berechnet (${done} fertig) …`); } });
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

const tourHours = (r) => travelHours(r, state.profile, state.speeds[state.profile]);
const tourSpeed = (r) => r.dist / 1000 / tourHours(r); // tatsächliches Durchschnittstempo inkl. Höhenmeter

function formatTime(hours) {
  const min = Math.round(hours * 60);
  return Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0') + ' h';
}

function showRoute() {
  setHover(null);
  noteRoute();
  const has = !!route;
  $('dock').hidden = !has;
  $('tourBlock').hidden = !has;
  $('poiBlock').hidden = !has;
  $('btnNav').hidden = !has || !canNavigate();
  document.body.classList.toggle('has-route', has);
  setOverlay('route', has ? { type: 'FeatureCollection', features: [lineFeature(route)] } : EMPTY);
  setOverlay('sel', EMPTY);
  $('selInfo').hidden = true;
  if (!has) { chart.setRoute(null); placeDock(); scheduleWeather(); schedulePois(); return; }

  $('stDist').innerHTML = `${fmt(route.dist / 1000, route.dist < 100000 ? 1 : 0)}<small> km</small>`;
  $('stUp').innerHTML = route.hasEle ? `${fmt(route.ascent)}<small> m</small>` : '–';
  $('stDown').innerHTML = route.hasEle ? `${fmt(route.descent)}<small> m</small>` : '–';
  $('stMax').innerHTML = route.hasEle ? `${fmt(route.maxEle)}<small> m</small>` : '–';
  renderTime();
  renderAlt();
  renderClimbs();
  renderComposition();
  placeDock();
  chart.setRoute(route);
  scheduleWeather();
  schedulePois();

  if (!state.tourName) $('tourName').placeholder = defaultTourName();
  if (isMobile()) setSheet(sheetMode);
  if (fitNext) {
    fitNext = false;
    const mobile = isMobile(), r = route;
    if (mobile && state.mode === 'route' && !cands.length) setSheet('peek');
    else if (mobile) setSheet(sheetMode);
    setTimeout(() => fitRoute(r), 30);
  }
}

function renderTime() {
  if (!route) return;
  $('stTime').innerHTML = formatTime(tourHours(route)).replace(' h', '<small> h</small>');
  document.querySelector('#stTime').previousElementSibling.textContent = PROFILES[state.profile].foot ? 'Gehzeit' : 'Fahrzeit';
}

// Im Höhenprofil gewählter Bereich: Kennzahlen zeigen, auf der Karte hervorheben und dorthin zoomen
function selectRange(range) {
  $('selInfo').hidden = !range;
  if (!range || !route) {
    setOverlay('sel', EMPTY);
    if (route && !range) fitRoute(route);
    return;
  }
  const [a, b] = range, pa = pointAt(route, a), pb = pointAt(route, b);
  let up = 0, down = 0, ref = pa.ele;
  const step = (e) => { const d = e - ref; if (d > 4) { up += d; ref = e; } else if (d < -4) { down -= d; ref = e; } };
  for (let i = pa.i + 1; i <= pb.i; i++) step(route.ele[i]);
  step(pb.ele);
  const len = b - a, slope = ((pb.ele - pa.ele) / len) * 100;
  $('selText').replaceChildren('Auswahl ', h('b', { text: `${fmt(len / 1000, 1)} km` }), `, km ${fmt(a / 1000, 1)} bis ${fmt(b / 1000, 1)}, `,
    h('b', { text: `${fmt(up)} m` }), ' bergauf, ', h('b', { text: `${fmt(down)} m` }), ` bergab, im Schnitt ${fmt(slope, 1)} %`);
  const f = sliceFeature(route, a, b, {});
  setOverlay('sel', { type: 'FeatureCollection', features: [f] });
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lon, lat] of f.geometry.coordinates) { w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat); }
  map.fitBounds([[w, s], [e, n]], { padding: fitPadding(), duration: 700, maxZoom: 16 });
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

function renderClimbs() {
  const host = $('climbs');
  host.replaceChildren();
  if (!route) return;
  const list = findClimbs(route, !!PROFILES[state.profile].foot);
  if (!list.length) return;
  const ul = h('ul', { class: 'climb-list' });
  list.forEach((c, i) => {
    ul.append(h('li', {}, h('button', { type: 'button', class: 'climb', title: 'Im Profil und auf der Karte zeigen',
      onclick: () => { chart.setSelection([c.from, c.to]); selectRange([c.from, c.to]); if (isMobile()) setSheet('half'); } },
    h('span', { class: 'climb-main', text: `Anstieg ${i + 1}: ${fmt(c.gain)} m auf ${fmt(c.len / 1000, 1)} km` }),
    h('span', { class: 'climb-sub', text: `km ${fmt(c.from / 1000, 1)} bis ${fmt(c.to / 1000, 1)}, steilstes Stück ${fmt(c.max)} %` }),
    h('span', { class: 'climb-grade', text: fmt(c.avg, 1) + ' %' }))));
  });
  host.append(h('div', { class: 'comp', style: 'margin-top:14px' }, h('h3', { text: list.length === 1 ? '1 Anstieg' : `${list.length} Anstiege, zusammen ${fmt(list.reduce((s2, c) => s2 + c.gain, 0))} m` }), ul));
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
  if (PROFILES[state.profile].foot) {
    // Hinweise zur Schwierigkeit (Angaben aus OpenStreetMap)
    const notes = h('div', { class: 'wx-hints', style: 'margin-top:14px' });
    const note = (text, warn) => notes.append(h('div', { class: 'wx-hint' + (warn ? ' warn' : '') }, h('span', { text })));
    const km = (v) => fmt(v / 1000, 1) + ' km';
    const sh = route.sacShare, hard = (sh[5] || 0) + (sh[6] || 0);
    if (route.unknownLen > 0) note(`${km(route.unknownLen)} mit unbekanntem Wegtyp, möglicherweise Klettersteig. Vor der Tour unbedingt prüfen.`, true);
    if (hard > 0) note(`${km(hard)} alpine Route (T5/T6): oft weglos, Kletterstellen, nur für sehr Erfahrene.`, true);
    if (sh[4] > 0) note(`${km(sh[4])} schwerer Bergweg (T4, schwarz): ausgesetzt, Hände nötig, Trittsicherheit und Schwindelfreiheit erforderlich.`, true);
    if (sh[3] > 0) note(`${km(sh[3])} mittelschwerer Bergweg (T3, rot): Trittsicherheit nötig, ausgesetzte Stellen möglich.`, true);
    note('Schwierigkeitsgrade stammen aus OpenStreetMap und können fehlen oder falsch sein. Schnee, Nässe und Sperrungen sind nicht berücksichtigt. Prüfe Bergtouren zusätzlich mit Karte oder dem Tourenportal des Alpenvereins.');
    host.append(notes);
    bar('Schwierigkeit', ['1', '2', '3', '4', '5', '6', '0'], { 1: 'T1 Talweg', 2: 'T2 einfach (blau)', 3: 'T3 mittelschwer (rot)', 4: 'T4 schwer (schwarz)', 5: 'T5 alpin', 6: 'T6 alpin', 0: 'ohne Angabe' }, route.sacShare, 'sac-');
  }
  bar('Untergrund', SURFACES, SURFACE_LABEL, route.surfaceShare, 'surf-');
  bar('Wegtyp', WAYS, WAY_LABEL, route.wayShare, 'way-');
}

// ---------------------------------------------------------------- Rundtour

let cands = [], candSel = -1, roundCtrl = null;
let renderRoundChips = () => {};
const DIRS = [['any', 'egal'], ['0', 'Norden'], ['45', 'Nordosten'], ['90', 'Osten'], ['135', 'Südosten'], ['180', 'Süden'], ['225', 'Südwesten'], ['270', 'Westen'], ['315', 'Nordwesten']];

function clearCandidates() {
  if (roundCtrl) { roundCtrl.abort(); roundCtrl = null; setRoundBusy(false); }
  if (!cands.length) return;
  cands = []; candSel = -1;
  renderCandidates();
}

function setRoundBusy(on, text) {
  $('btnRound').disabled = on;
  $('btnDetour').disabled = on;
  $('btnRound').textContent = on ? 'Wird berechnet …' : (cands.length && cands[0].kind === 'round' ? 'Neue Vorschläge' : 'Rundtour vorschlagen');
  $('roundStatus').hidden = !text;
  $('roundStatus').textContent = text || '';
}

async function runProposals(kind) {
  const start = state.waypoints[0], end = state.waypoints[state.waypoints.length - 1];
  if (!online()) return toast('Vorschläge brauchen Internet.', true);
  if (start.lat == null) return toast('Wähle zuerst einen Startpunkt.');
  const km = kind === 'round' ? state.round.km : parseFloat($('detourKm').value);
  const minKm = PROFILES[state.profile].foot ? 2 : 5;
  if (!(km >= minKm && km <= 300)) return toast(`Gib eine Länge zwischen ${minKm} und 300 km ein.`);
  if (kind === 'detour' && (state.loop || end.lat == null)) return toast('Für einen Umweg brauchst du Start und Ziel, ohne „Hin und zurück“.');
  const from = { lat: start.lat, lon: start.lon }, to = kind === 'detour' ? { lat: end.lat, lon: end.lon, label: end.label } : null;
  const directDist = kind === 'detour' && route && state.waypoints.filter((w) => w.lat != null).length === 2 ? route.dist : 0;
  clearCandidates();
  if (routeCtrl) routeCtrl.abort();
  roundCtrl = new AbortController();
  const ctrl = roundCtrl;
  setRoundBusy(true, 'Die App probiert mehrere Möglichkeiten aus. Das dauert einen Moment.');
  $('busy').hidden = false;
  try {
    const common = { profile: state.profile, options: state.options[state.profile], nogos: state.nogos, signal: ctrl.signal, km,
      onProgress: (done, total) => { if (ctrl === roundCtrl) setRoundBusy(true, `${done} von ${total} Möglichkeiten berechnet …`); } };
    let res;
    if (kind === 'round') {
      let wind = null;
      if (state.round.wind) {
        // Wind am Start zur Abfahrtszeit; ohne Wetterdaten wird die Runde trotzdem berechnet
        try {
          const fc = await fetchForecast([from], ctrl.signal);
          const w = weatherAt(fc[0], departUnix());
          if (w && w.wind != null) wind = { from: w.wdir, speed: w.wind };
        } catch (e) { if (e.name === 'AbortError') throw e; }
      }
      res = await generateRoundTrips({ ...common, start: from, climb: state.round.climb, wind, via: state.round.via || null, direction: state.round.dir === 'any' ? null : +state.round.dir });
    } else {
      res = await generateDetours({ ...common, start: from, end: to, directDist });
      res.forEach((c) => { c.end = to; });
    }
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
    toast(e instanceof RouteError ? e.message : 'Die Vorschläge konnten nicht berechnet werden.', true);
    if (!(e instanceof RouteError)) console.error(e);
  } finally {
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
  if (c.kind === 'detour') state.waypoints.push({ id: uid(), lat: c.end.lat, lon: c.end.lon, label: c.end.label });
  state.loop = c.kind !== 'detour';
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
  $('btnRound').textContent = cands.length && cands[0].kind === 'round' ? 'Neue Vorschläge' : 'Rundtour vorschlagen';
  $('btnEditWp').hidden = state.mode === 'route';
  if (!cands.length) return;
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
        h('span', {}, h('b', { text: formatTime(tourHours(r)).replace(' h', '') }), ' h'),
        h('span', {}, h('b', { text: fmt(unpaved) }), ' % unbefestigt')),
      c.windNote ? h('span', { class: 'cand-tag', text: c.windNote }) : null,
      c.overlap > 300 ? h('span', { class: 'cand-tag', text: `${fmt(c.overlap / 1000, 1)} km doppelt befahren` }) : null)));
  });
}

// Wunschpunkt der Rundtour
let viaMarker = null;
async function setRoundVia(lat, lon, label) {
  state.round.via = lat == null ? null : { lat, lon, label: label || fmt(lat, 5) + ', ' + fmt(lon, 5) };
  save(); renderRoundVia();
  if (lat != null && !label) {
    const name = await reverseGeocode(lat, lon);
    if (name && state.round.via && state.round.via.lat === lat) { state.round.via.label = name; save(); renderRoundVia(); }
  }
}
function renderRoundVia() {
  const v = state.round.via;
  $('roundVia').value = v ? v.label : '';
  $('roundDir').disabled = !!v; // die Richtung ergibt sich aus dem Wunschpunkt
  if (viaMarker) { viaMarker.remove(); viaMarker = null; }
  if (v && state.mode === 'round') viaMarker = new maplibregl.Marker({ element: h('div', { class: 'pin pin-via', text: '★', title: 'Wunschpunkt' }), draggable: true }).setLngLat([v.lon, v.lat]).addTo(map);
  if (viaMarker) viaMarker.on('dragend', () => { const p = viaMarker.getLngLat(); setRoundVia(p.lat, p.lng, null); });
}

function renderLoop() {
  $('loopSwitch').checked = state.loop;
}

function renderMode() {
  for (const b of $('modeSeg').children) b.setAttribute('aria-checked', String(b.dataset.mode === state.mode));
  document.body.dataset.mode = state.mode;
  $('roundBlock').hidden = state.mode !== 'round';
  $('routeExtras').hidden = state.mode !== 'route';
  $('btnEditWp').hidden = state.mode === 'route';
  renderRoundVia();
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
  km.addEventListener('change', () => { const v = parseFloat(km.value); if (v >= 2 && v <= 300) { state.round.km = v; save(); renderRoundChips(); } else km.value = state.round.km; });
  renderRoundChips = () => {
    $('roundKm').min = PROFILES[state.profile].foot ? 2 : 5;
    $('kmChips').replaceChildren(...(PROFILES[state.profile].foot ? [5, 10, 15, 20] : [30, 50, 80, 100]).map((v) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(state.round.km === v), text: v + ' km',
      onclick: () => { state.round.km = v; km.value = v; save(); renderRoundChips(); } })));
  };
  renderRoundChips();
  const dir = $('roundDir');
  for (const [v, label] of DIRS) dir.append(h('option', { value: v, text: label, selected: v === state.round.dir }));
  dir.addEventListener('change', () => { state.round.dir = dir.value; save(); });
  const renderClimb = () => {
    $('climbSeg').replaceChildren(...[['flat', 'wenig'], ['any', 'egal'], ['hilly', 'viel']].map(([v, label]) => h('button', { type: 'button', role: 'radio',
      'aria-checked': String(state.round.climb === v), text: label, onclick: () => { state.round.climb = v; save(); renderClimb(); } })));
  };
  renderClimb();
  attachAutocomplete($('roundVia'), $('roundViaAc'), {
    pick: (lat, lon, label) => setRoundVia(lat, lon, label),
    label: () => (state.round.via ? state.round.via.label : ''),
    isSet: () => !!state.round.via,
  });
  $('roundVia').addEventListener('change', () => { if (!$('roundVia').value.trim()) setRoundVia(null); });
  $('btnRound').addEventListener('click', () => runProposals('round'));
  $('btnDetour').addEventListener('click', () => runProposals('detour'));
  $('detourKm').value = state.detourKm;
  $('detourKm').addEventListener('change', () => { state.detourKm = $('detourKm').value; save(); });
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

// ---------------------------------------------------------------- Routen (eingetragene Rad- und Wanderwege)

let rtList = [], rtSel = null, rtSec = null, rtCtrl = null, rtMarkers = [], rtLoopCands = [];
let rtLoading = null;   // Route, deren Strecke gerade geladen wird (Ansicht ist schon offen)
let rtMode = 'whole';   // whole: ganze Route, part: Abschnitt, loop: Runde mit Wunschlänge
let rtSearchCtrl = null, rtSearched = false;
let rtBbox = null, rtLenReady = false, rtLenFailed = false, rtPreBusy = false, rtPreAgain = false;
const RT_KINDS = [['bicycle', 'Rad'], ['mtb', 'MTB'], ['hiking', 'Wandern']];
const RT_LEN = [5, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200, 300, 500, 0]; // Stufen des Schiebers, 0 = beliebig
const rtKindOf = (r) => (r.kind === 'foot' ? 'hiking' : r.kind);
const rtKind = () => state.rtKind || (state.profile === 'wandern' ? 'hiking' : 'bicycle');
// Länge einer Route: eingetragen, sonst aus den Wegstücken summiert
const rtKm = (r) => r.km || r.lenKm || 0;
function rtPasses(r) {
  if (state.rtRoundOnly && !r.round) return false;
  const max = state.rtMaxKm, km = rtKm(r);
  // unbekannte Länge: solange die Längen noch laden, zeigen; danach nur ohne Längenfilter
  return !max || (km ? km <= max : !rtLenReady);
}
const rtVisible = () => rtList.filter((r) => rtKindOf(r) === rtKind() && rtPasses(r));

const hasStart = () => !!state.waypoints[0] && state.waypoints[0].lat != null;
const rtWhole = () => !!rtSel && Math.abs(rtSec.to - rtSec.from) > rtSel.track.dist - 50;

// Beschreibung eines Abschnitts; bei Rundwegen kann er über das Ende der Eintragung hinweglaufen
function secDescription(from, to, dist, closed) {
  const len = Math.abs(to - from), whole = len > dist - 50;
  if (closed && whole) return `Ganze Runde, ${kmText(len)} km`;
  if (whole) return `Ganze Route, ${kmText(len)} km` + (to < from ? ', in Gegenrichtung' : '');
  const norm = (d) => (closed ? ((d % dist) + dist) % dist : d);
  const a = norm(from), z = norm(to);
  return `km ${kmText(a)} bis ${kmText(z)}, ${kmText(len)} km` + (to < from ? ', in Gegenrichtung' : '');
}
const kmText = (m) => fmt(m / 1000, m < 100000 ? 1 : 0);

function initRoutes() {
  $('btnRtSearch').addEventListener('click', runRtSearch);
  $('rtRoundOnly').checked = state.rtRoundOnly;
  $('rtRoundOnly').addEventListener('change', () => { state.rtRoundOnly = $('rtRoundOnly').checked; save(); renderRtList(); ensurePreviews(); });
  const len = $('rtLen');
  len.value = Math.max(0, RT_LEN.indexOf(state.rtMaxKm));
  len.addEventListener('input', () => { state.rtMaxKm = RT_LEN[+len.value] || 0; renderRtList(); });
  len.addEventListener('change', () => { save(); ensurePreviews(); });
  $('btnRtBack').addEventListener('click', () => {
    if (rtCtrl) rtCtrl.abort();
    rtCtrl = null; rtSel = null; rtLoading = null; rtLoopCands = [];
    $('busy').hidden = true;
    setOverlay('rtprev', EMPTY);
    renderRtSel(); renderRtMap();
  });
  $('btnRtReverse').addEventListener('click', () => { if (!rtSec) return; rtSec = { from: rtSec.to, to: rtSec.from }; renderRtSel(); renderRtMap(); });
  $('rtApproach').checked = state.rtOpts.approach;
  $('rtBackSw').checked = state.rtOpts.back;
  $('rtApproach').addEventListener('change', () => { state.rtOpts.approach = $('rtApproach').checked; save(); renderRtSel(); });
  $('rtBackSw').addEventListener('change', () => { state.rtOpts.back = $('rtBackSw').checked; save(); });
  $('btnRtApply').addEventListener('click', () => applyRouteTour(rtSec.from, rtSec.to, state.rtOpts.approach && hasStart(), state.rtOpts.back));
  $('btnRtLoop').addEventListener('click', runRtLoops);
  $('btnRtEdit').addEventListener('click', editRouteTour);
  $('btnRtConvert').addEventListener('click', convertRouteTour);
  attachAutocomplete($('rtStart'), $('rtStartAc'), {
    pick: (lat, lon, label) => setRtStart(lat, lon, label),
    locate: () => myPosition((lat, lon) => setRtStart(lat, lon, null)),
    label: () => (hasStart() ? state.waypoints[0].label : ''),
    isSet: hasStart,
  });
  const km = $('rtLoopKm');
  km.addEventListener('change', () => { const v = parseFloat(km.value); if (v >= 2 && v <= 300) { state.round.km = v; $('roundKm').value = v; save(); renderRoundChips(); } renderRtLoopKm(); });
  renderRtList();
  renderRtSel();
}

// Der Start gilt für die ganze App. Hier gesetzt, wird eine bestehende Tour damit neu berechnet.
function setRtStart(lat, lon, label) {
  rtLoopCands = [];
  setWaypoint(0, lat, lon, label).then(renderRtSel);
  renderRtSel();
}

// Wunschlänge der Runde: derselbe Wert wie bei der Rundtour im Reiter „Planen“
function renderRtLoopKm() {
  $('rtLoopKm').value = state.round.km;
  $('rtLoopChips').replaceChildren(...(PROFILES[state.profile].foot ? [5, 10, 15, 20] : [30, 50, 80, 100]).map((v) => h('button', { type: 'button', class: 'chip',
    'aria-pressed': String(state.round.km === v), text: v + ' km', onclick: () => { state.round.km = v; $('roundKm').value = v; save(); renderRoundChips(); renderRtLoopKm(); } })));
}

function rtStatus(text) { $('rtStatus').hidden = !text; $('rtStatus').textContent = text || ''; $('rtStatus').dataset.lines = ''; }

const QUICK_ONLY = 'Das sind nur die wichtigsten Routen. Die vollständige Liste ist gerade nicht erreichbar; suche gleich noch einmal.';
async function runRtSearch() {
  if (!online()) return toast('Die Suche nach Routen braucht Internet.', true);
  if (map.getZoom() < 7) return rtStatus('Zoome näher heran. Bei sehr großen Ausschnitten dauert die Suche zu lange.');
  if (rtSearchCtrl) rtSearchCtrl.abort();
  const ctrl = rtSearchCtrl = new AbortController();
  const b = map.getBounds(), bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
  rtSearched = true;
  rtList = [];
  rtOpen = {};
  rtBbox = bbox; rtLenReady = false; rtLenFailed = false;
  renderRtList();
  rtStatus('Routen werden gesucht …');
  $('btnRtSearch').disabled = true;
  let full = false, failed = false;
  // Schnelle erste Liste; die vollständige (mit Längen, Teilabschnitten und Rundwegen) ersetzt sie, sobald sie da ist
  searchRoutesQuick(bbox, ctrl.signal).then((quick) => {
    if (ctrl !== rtSearchCtrl || full || !quick.length) return;
    rtList = quick;
    rtStatus(failed ? QUICK_ONLY : 'Erste Treffer. Die Liste wird noch vervollständigt …');
    if (!rtSel && !rtLoading) renderRtList();
    if (failed) ensurePreviews();
  }).catch(() => { /* dann nur die vollständige Liste */ });
  try {
    const list = await searchRoutes(bbox, ctrl.signal);
    if (ctrl !== rtSearchCtrl) return;
    full = true;
    rtList = list;
    rtStatus(rtList.length ? '' : 'Hier ist keine Route eingetragen. Verschiebe die Karte oder zoome heraus.');
    renderRtList();
  } catch (e) {
    if (e.name === 'AbortError' || ctrl !== rtSearchCtrl) return;
    failed = true;
    // Die schnelle Liste reicht zum Weitermachen (kommt sie erst noch, ersetzt sie die Meldung); nur ohne sie ist es ein Fehler
    rtStatus(rtList.length ? QUICK_ONLY : (e.message || 'Die Routen konnten nicht geladen werden.'));
  } finally { if (ctrl === rtSearchCtrl) $('btnRtSearch').disabled = false; }
  if (ctrl === rtSearchCtrl && rtList.length) ensurePreviews();
}

// Linien für die Karte im Hintergrund laden: eine Abfrage für die Routen, die gerade in der Liste stehen (die
// wichtigsten zuerst). Die Längen für den Schieber kommen nur, wenn er benutzt wird. Zwischen zwei Abfragen liegt
// eine Pause, weil die öffentlichen Server schnelle Folgen abweisen.
async function ensurePreviews() {
  if (!rtBbox || !rtSearchCtrl) return;
  if (rtPreBusy) { rtPreAgain = true; return; }
  const ctrl = rtSearchCtrl, bbox = rtBbox, mine = () => ctrl === rtSearchCtrl;
  const pause = (ms) => new Promise((f) => setTimeout(f, ms));
  const note = (text) => { if (mine() && !rtSel && !rtLoading && (!$('rtStatus').textContent || $('rtStatus').dataset.lines)) { rtStatus(text); $('rtStatus').dataset.lines = text ? '1' : ''; } };
  rtPreBusy = true; rtPreAgain = false;
  try {
    // bis zu drei Portionen, die wichtigsten Routen zuerst; die Linien erscheinen nach jeder Portion
    let got = false;
    for (let part = 0; part < 3; part++) {
      const ids = rtVisible().filter((r) => !hasPreview(r.id)).slice(0, 60).map((r) => r.id);
      if (!ids.length) break;
      note('Linien für die Karte werden geladen …');
      await pause(part ? 1200 : 400);
      try {
        const km = await prefetchPreviews(ids, bbox, ctrl.signal);
        if (!mine()) return;
        for (const r of rtList) if (km.has(r.id)) r.visKm = km.get(r.id);
        got = true;
        renderRtAll();
      } catch (e) {
        if (!mine()) return;
        if (!got) { note('Die Linien für die Karte konnten nicht geladen werden. ' + (e.message || '') + ' Die Liste funktioniert trotzdem.'); return; }
        break;
      }
    }
    if (got) { rtList.sort(byImportance); note(''); if (!rtSel && !rtLoading) renderRtList(); }
    if (state.rtMaxKm && !rtLenReady) {
      const need = rtList.filter((r) => !r.km).slice(0, 150).map((r) => r.id);
      await pause(700);
      try { const len = await fetchRouteLengths(need, ctrl.signal); for (const r of rtList) if (len.has(r.id)) r.lenKm = len.get(r.id); rtLenReady = true; } catch (e) { rtLenFailed = true; }
      if (!mine()) return;
      if (!rtSel && !rtLoading) renderRtList();
    }
  } finally {
    rtPreBusy = false;
    if (rtPreAgain && mine()) ensurePreviews();
  }
}

// Alle Routen der Liste als Linien auf der Karte (nur in der Listenansicht)
function renderRtAll() {
  if (!map || !map.getSource('rtall')) return;
  const show = state.tab === 'routen' && !rtSel && !rtLoading;
  const features = [];
  if (show) {
    for (const r of rtVisible()) {
      const fc = cachedPreview(r.id);
      if (fc) features.push({ type: 'Feature', properties: { id: r.id }, geometry: fc.features[0].geometry });
    }
  }
  setOverlay('rtall', { type: 'FeatureCollection', features });
}

// Tipp auf die Karte in der Listenansicht: Route unter dem Finger öffnen; bei mehreren zur Wahl stellen
function rtPick(box, lat, lon) {
  if (popup) return closeMenu();
  const ids = [...new Set(map.queryRenderedFeatures(box, { layers: ['rtall-hit'] }).map((f) => f.properties.id))];
  const hits = ids.map((id) => rtList.find((r) => r.id === id)).filter(Boolean);
  if (!hits.length) return rtStartMenu(lat, lon);
  if (hits.length === 1) return openRoute(hits[0]);
  openMenu(lat, lon, h('div', { class: 'map-menu' }, h('strong', { text: `${hits.length} Routen an dieser Stelle` }),
    ...hits.slice(0, 8).map((r) => h('button', { type: 'button', text: r.name, onclick: () => { closeMenu(); openRoute(r); } }))));
}

const RT_LEVELS = ['International', 'National', 'Regional', 'Lokal', 'Ohne Einstufung'];
let rtOpen = {};

function renderRtList() {
  const host = $('rtList');
  host.replaceChildren();
  $('rtFilter').hidden = !rtList.length;
  // Art: Rad, MTB, Wandern (mit Zahl der Routen, die zu Länge und Rundweg-Filter passen)
  const kind = rtKind();
  $('rtKindSeg').replaceChildren(...RT_KINDS.map(([k, label]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(kind === k),
    onclick: () => { state.rtKind = k; save(); renderRtList(); ensurePreviews(); } },
  label, h('span', { class: 'rt-count', text: String(rtList.filter((r) => rtKindOf(r) === k && rtPasses(r)).length) }))));
  $('rtLen').value = Math.max(0, RT_LEN.indexOf(state.rtMaxKm));
  $('rtLenOut').textContent = state.rtMaxKm ? `bis ${state.rtMaxKm} km` : 'beliebig';
  if (state.rtMaxKm && !rtLenReady && rtList.length) host.append(h('p', { class: 'hint', text: rtLenFailed ? 'Die Längen konnten nicht geladen werden. Routen ohne eingetragene Länge bleiben deshalb sichtbar.' : 'Längen werden geladen. Bis dahin bleiben Routen ohne eingetragene Länge sichtbar.' }));
  const list = rtVisible();
  if (rtList.length && !list.length) {
    const other = RT_KINDS.find(([k]) => rtList.some((r) => rtKindOf(r) === k && rtPasses(r)));
    host.append(h('p', { class: 'hint', text: state.rtMaxKm || state.rtRoundOnly ? 'Keine Route passt zu Länge und Rundweg-Filter. Lockere die Auswahl oder verschiebe die Karte.'
      : `Hier ist dazu nichts eingetragen.${other ? ` Unter „${other[1]}“ gibt es Routen.` : ''}` }));
  }
  const ids = new Set(list.map((r) => r.id)), byId = new Map(list.map((r) => [r.id, r]));
  const item = (r, small) => h('li', {}, h('button', { type: 'button', class: 'cand', onclick: () => openRoute(r),
    onmouseenter: () => schedulePreview(r), onmouseleave: () => cancelPreview(), onfocus: () => schedulePreview(r), onblur: () => cancelPreview() },
  h('span', { class: 'cand-top' }, h('span', { class: 'cand-name', text: r.name }), r.round ? h('span', { class: 'rt-round', text: 'Rundweg' }) : null),
  small ? null : h('span', { class: 'cand-nums' }, h('span', { text: routeLabel(r) + (r.visKm >= 0.5 ? `, ${fmt(r.visKm)} km im Ausschnitt` : '') }))));
  const fold = (key, def, el) => { el.open = key in rtOpen ? rtOpen[key] : def; el.addEventListener('toggle', () => { rtOpen[key] = el.open; }); return el; };
  const top = list.filter((r) => !r.parents.some((p) => ids.has(p)));
  RT_LEVELS.forEach((lv, rank) => {
    const lvItems = top.filter((r) => r.rank === rank);
    if (!lvItems.length) return;
    const ul = h('ul', { class: 'cand-list' });
    for (const r of lvItems) {
      ul.append(item(r));
      const kids = r.children.map((c) => byId.get(c)).filter(Boolean);
      if (kids.length) {
        const sub = fold('sub' + r.id, false, h('details', { class: 'rt-sub' }, h('summary', { text: `${kids.length} Teilabschnitt${kids.length > 1 ? 'e' : ''}` })));
        sub.append(h('ul', { class: 'cand-list' }, ...kids.map((k) => item(k, true))));
        ul.append(h('li', {}, sub));
      }
    }
    // lokale Routen sind oft sehr viele: eingeklappt, solange es auch wichtigere gibt
    if (rank >= 3 && lvItems.length > 6 && lvItems.length < top.length) host.append(fold(kind + rank, false, h('details', { class: 'rt-level-fold' }, h('summary', { text: `${lv} (${lvItems.length})` }), ul)));
    else host.append(h('div', { class: 'rt-level', text: lv }), ul);
  });
  renderRtAll();
}

// Vorschau beim Überfahren mit der Maus: nach kurzer Pause grob die Strecke im Kartenausschnitt zeigen
let prevTimer = 0, prevCtrl = null, prevFor = null;
function schedulePreview(r) {
  if (!window.matchMedia('(hover: hover)').matches) return;
  clearTimeout(prevTimer);
  prevTimer = setTimeout(async () => {
    if (prevCtrl) prevCtrl.abort();
    const ctrl = prevCtrl = new AbortController();
    prevFor = r.id;
    const b = map.getBounds(), dLat = (b.getNorth() - b.getSouth()) * 0.3, dLon = (b.getEast() - b.getWest()) * 0.3;
    try {
      const fc = await previewRoute(r.id, [b.getSouth() - dLat, b.getWest() - dLon, b.getNorth() + dLat, b.getEast() + dLon], ctrl.signal);
      if (ctrl === prevCtrl && prevFor === r.id) setOverlay('rtprev', fc);
    } catch (e) { /* Vorschau ist nur ein Extra */ }
  }, 300);
}
function cancelPreview() {
  clearTimeout(prevTimer);
  if (prevCtrl) prevCtrl.abort();
  prevCtrl = null; prevFor = null;
  setOverlay('rtprev', EMPTY);
}


// Route öffnen: Die Ansicht erscheint sofort, die Strecke folgt. "preset" stellt einen gespeicherten Abschnitt wieder her.
async function openRoute(item, preset) {
  cancelPreview();
  if (rtCtrl) rtCtrl.abort();
  const ctrl = rtCtrl = new AbortController();
  rtSel = null; rtLoading = item; rtLoopCands = [];
  $('rtLoopStatus').hidden = true;
  rtStatus('');
  renderRtSel(); renderRtMap();
  $('panelScroll').scrollTop = 0;
  const fc = cachedPreview(item.id);
  if (fc) setOverlay('rtprev', fc);
  $('busy').hidden = false;
  try {
    const track = await loadRouteTrack(item.id, ctrl.signal);
    if (ctrl !== rtCtrl) return;
    rtLoading = null;
    rtSel = { item, track };
    rtSec = preset ? { from: preset.from, to: preset.to } : { from: 0, to: track.dist };
    rtMode = rtWhole() ? 'whole' : 'part';
    if (preset) state.rtOpts = { approach: !!preset.approach, back: !!preset.back };
    else if (track.closed) state.rtOpts = { approach: true, back: true };
    $('rtApproach').checked = state.rtOpts.approach; $('rtBackSw').checked = state.rtOpts.back;
    save();
    setOverlay('rtprev', EMPTY);
    renderRtSel(); renderRtMap();
    if (!preset) fitTrack();
  } catch (e) {
    if (e.name === 'AbortError' || ctrl !== rtCtrl) return;
    rtLoading = null;
    setOverlay('rtprev', EMPTY);
    renderRtSel();
    rtStatus(e.message || 'Die Route konnte nicht geladen werden.');
  } finally { if (ctrl === rtCtrl) $('busy').hidden = true; }
}

function fitTrack() {
  if (!rtSel) return;
  const t = rtSel.track;
  let w = Infinity, s2 = Infinity, e = -Infinity, n = -Infinity;
  for (let i = 0; i < t.n; i += Math.max(1, Math.floor(t.n / 2000))) { w = Math.min(w, t.lon[i]); e = Math.max(e, t.lon[i]); s2 = Math.min(s2, t.lat[i]); n = Math.max(n, t.lat[i]); }
  map.fitBounds([[w, s2], [e, n]], { padding: fitPadding(), duration: 700, maxZoom: 15 });
}

function setRtMode(mode) {
  if (!rtSel) return;
  rtMode = mode;
  if (mode === 'whole') { rtSec = { from: 0, to: rtSel.track.dist }; fitTrack(); }
  renderRtSel(); renderRtMap();
}

function renderRtSel() {
  const item = rtSel ? rtSel.item : rtLoading;
  $('rtSearch').hidden = !!item;
  $('rtSel').hidden = !item;
  if (!item) return;
  $('rtName').textContent = item.name;
  $('rtBody').hidden = !rtSel;
  if (!rtSel) { $('rtMeta').textContent = 'Die Strecke wird geladen. Lange Routen brauchen einige Sekunden …'; return; }
  const { track } = rtSel, foot = !!PROFILES[state.profile].foot;
  const meta = [routeLabel({ ...item, km: 0 }) + (track.closed ? ', Rundweg' : '') + `, ${kmText(track.dist)} km zusammenhängend eingetragen.`];
  if (track.gaps.length) meta.push(`${track.gaps.length} Lücke${track.gaps.length > 1 ? 'n' : ''} in den Daten, überbrückt mit deinem Profil.`);
  if (item.km && track.dist / 1000 < item.km * 0.8) meta.push(`Offiziell ${fmt(item.km)} km. Die Daten sind nicht durchgehend; gezeigt wird nur ein zusammenhängender Teil.`);
  $('rtMeta').replaceChildren(meta.join(' ') + ' ', track.website || item.website ? h('a', { href: track.website || item.website, target: '_blank', rel: 'noopener noreferrer', text: 'Offizielle Seite' }) : '');
  if (document.activeElement !== $('rtStart')) $('rtStart').value = hasStart() ? state.waypoints[0].label : '';

  // Was soll gefahren werden? Eine Runde mit Wunschlänge gibt es nur auf Strecken, nicht auf Rundwegen.
  if (track.closed && rtMode === 'loop') rtMode = 'whole';
  const modes = track.closed ? [['whole', 'Ganze Runde'], ['part', 'Abschnitt']] : [['whole', 'Ganze Route'], ['part', 'Abschnitt'], ['loop', 'Runde']];
  $('rtModeSeg').replaceChildren(...modes.map(([m, label]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(rtMode === m), text: label, onclick: () => setRtMode(m) })));
  $('rtPart').hidden = rtMode === 'loop';
  $('rtLoopBox').hidden = rtMode !== 'loop';
  const whole = rtWhole(), start = hasStart(), unset = rtMode === 'part' && whole, approach = state.rtOpts.approach && start;
  $('rtSecText').textContent = unset ? 'Noch kein Abschnitt gewählt.'
    : secDescription(rtSec.from, rtSec.to, track.dist, track.closed) + (track.closed && whole && approach ? '. Einstieg dort, wo die Runde deinem Start am nächsten ist.' : '');
  $('rtPartHint').hidden = rtMode !== 'part';
  $('rtApproach').disabled = !start;
  $('rtStartNote').textContent = start ? 'Von ' + state.waypoints[0].label.split(',')[0] + ' zum Anfang.' : 'Dafür oben einen Start setzen.';
  // Ganze Runde ohne Anfahrt endet ohnehin, wo sie beginnt
  $('rtBackRow').hidden = track.closed && whole && !approach;
  $('rtBackLabel').textContent = approach ? 'Zurück zum Start' : 'Zurück zum Anfang';
  $('btnRtApply').disabled = unset;
  $('btnRtReverse').hidden = unset;
  $('rtLoopLead').textContent = start ? `Von ${state.waypoints[0].label.split(',')[0]} zur Route, ein Stück darauf und auf anderem Weg zurück.`
    : (foot ? 'Setze oben einen Start. Die Runde führt von dort zur Route, ein Stück darauf und zurück.' : 'Setze oben einen Start. Die Runde führt von dort zur Route, ein Stück darauf und auf anderem Weg zurück.');
  renderRtLoopKm();
  renderRtLoops();
}

// Route und Abschnitt auf der Karte, nur im Reiter „Routen“
function renderRtMap() {
  rtMarkers.forEach((m) => m.remove());
  rtMarkers = [];
  renderRtAll();
  const show = state.tab === 'routen' && rtSel;
  setOverlay('rtrack', show ? { type: 'FeatureCollection', features: [lineFeature(rtSel.track)] } : EMPTY);
  if (!show) { setOverlay('rsec', EMPTY); return; }
  const t = rtSel.track, sl = sliceTrack(t, rtSec.from, rtSec.to);
  setOverlay('rsec', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: sl.pts.map((q) => [q.lon, q.lat]) } }] });
  const whole = Math.abs(rtSec.to - rtSec.from) > t.dist - 50;
  if ((t.closed && whole) || rtMode === 'loop') return; // Einstieg ergibt sich erst aus dem Start; bei der Runde aus dem Vorschlag
  for (const [p, text, title] of [[sl.pts[0], '▶', 'Anfang des Abschnitts'], [sl.pts[sl.pts.length - 1], '■', 'Ende des Abschnitts']]) {
    rtMarkers.push(new maplibregl.Marker({ element: h('div', { class: 'pin pin-sec', text, title }) }).setLngLat([p.lon, p.lat]).addTo(map));
  }
}

function rtMenu(lat, lon) {
  const t = rtSel.track, d = projectOnRoute(t, lat, lon).d, p = pointAt(t, d);
  const item = (text, fn) => h('button', { type: 'button', text, onclick: () => { closeMenu(); fn(); renderRtSel(); renderRtMap(); } });
  const far = d < t.dist / 2 ? t.dist : 0; // fällt das andere Ende auf denselben Punkt, gilt das entferntere Routenende
  openMenu(p.lat, p.lon, h('div', { class: 'map-menu' },
    h('strong', { text: `km ${kmText(d)}` }),
    item('Abschnitt beginnt hier', () => { rtMode = 'part'; rtSec = { from: d, to: Math.abs(rtSec.to - d) < 200 ? far : rtSec.to }; }),
    item('Abschnitt endet hier', () => { rtMode = 'part'; rtSec = { from: Math.abs(rtSec.from - d) < 200 ? far : rtSec.from, to: d }; }),
    item(t.closed ? 'Ganze Runde' : 'Ganze Route', () => { rtMode = 'whole'; rtSec = { from: 0, to: t.dist }; })));
}

function rtStartMenu(lat, lon) {
  if (popup) return closeMenu();
  openMenu(lat, lon, h('div', { class: 'map-menu' }, h('button', { type: 'button', text: 'Als Start', onclick: () => { closeMenu(); setRtStart(lat, lon, null); } })));
}

function applyRouteTour(from, to, approach, back) {
  if (!rtSel) return;
  const start = state.waypoints[0];
  state.routeTour = { id: rtSel.item.id, name: rtSel.item.name, from, to, approach: !!approach, back: !!back, dist: rtSel.track.dist, closed: !!rtSel.track.closed };
  state.mode = 'route';
  state.loop = false;
  state.waypoints = [start && start.lat != null ? start : emptyWp(), emptyWp()];
  state.tourName = '';
  $('tourName').value = '';
  clearCandidates();
  fitNext = true;
  renderMode(); renderLoop(); renderWaypoints();
  setTab('tour');
  changed();
}

// Tour auf einer Route berechnen: Strecke laden (wird gemerkt), Abschnitt aufbereiten, Anfahrt und Rückweg ergänzen
async function calcRouteTour() {
  if (routeCtrl) routeCtrl.abort();
  if (!online()) { $('busy').hidden = true; toast('Ohne Internet lässt sich die Tour nicht berechnen. Offline-Touren findest du unter „Meine Touren“.', true); return; }
  const ctrl = routeCtrl = new AbortController();
  const rt = state.routeTour, start = state.waypoints[0] && state.waypoints[0].lat != null ? state.waypoints[0] : null;
  $('busy').hidden = false;
  toast(`Tour auf „${rt.name}“ wird berechnet …`);
  try {
    const track = await loadRouteTrack(rt.id, ctrl.signal);
    const r = await buildRouteTour({ track, from: rt.from, to: rt.to, start: rt.approach ? start : null, back: rt.back,
      profile: state.profile, options: state.options[state.profile], nogos: state.nogos, signal: ctrl.signal });
    if (ctrl !== routeCtrl) return;
    route = r;
    hideToast();
    showRoute();
    renderRtInfo();
    if (r.eleMissing) toast('Die Höhen für den Routenabschnitt konnten nicht geladen werden. Höhenprofil und Fahrzeit sind dort ungenau.', true);
    else if (r.bridged) toast(`${r.bridged} Lücke${r.bridged > 1 ? 'n' : ''} in den Routendaten mit deinem Profil überbrückt.`);
  } catch (e) {
    if (e.name === 'AbortError' || ctrl !== routeCtrl) return;
    route = null;
    showRoute();
    toast(e instanceof RouteError ? e.message : 'Die Tour auf der Route konnte nicht berechnet werden.', true);
    if (!(e instanceof RouteError)) console.error(e);
  } finally { if (ctrl === routeCtrl) $('busy').hidden = true; }
}

function renderRtInfo() {
  const rt = state.routeTour;
  document.body.classList.toggle('route-tour', !!rt);
  $('rtInfo').hidden = !rt;
  if (!rt) return;
  $('rtInfoName').textContent = rt.name;
  const extra = [rt.approach && state.waypoints[0].lat != null ? 'mit Anfahrt' : '', rt.back ? 'zurück zum Start' : ''].filter(Boolean).join(', ');
  const dist = route && route.secLen ? Math.max(route.secLen, Math.abs(rt.to - rt.from)) : Math.abs(rt.to - rt.from);
  $('rtInfoSub').textContent = secDescription(rt.from, rt.to, rt.dist || dist, !!rt.closed) + (route && route.entry != null ? ', Einstieg nahe deinem Start' : '') + (extra ? ', ' + extra : '');
}

function editRouteTour() {
  const rt = state.routeTour;
  if (!rt) return;
  setTab('routen');
  openRoute({ id: rt.id, name: rt.name, kind: '', rank: 4, km: 0, website: '', parentNames: [] }, rt);
}

// Aus der Routen-Tour eine normale, frei bearbeitbare Route machen (folgt ihr über Stützpunkte)
function convertRouteTour() {
  if (!state.routeTour || !route) return;
  const pts = [];
  for (let i = 0; i < route.n; i++) pts.push({ lat: route.lat[i], lon: route.lon[i] });
  const a = pts[0], z = pts[pts.length - 1];
  const closed = Math.hypot(a.lat - z.lat, (a.lon - z.lon) * Math.cos(a.lat * Math.PI / 180)) < 0.003;
  let keep = simplifyTrack(pts, 16);
  if (closed) keep = keep.slice(0, -1);
  const start = state.waypoints[0];
  state.waypoints = keep.map((q, i) => ({ id: uid(), lat: q.lat, lon: q.lon, label: i === 0 && start.lat != null ? start.label : 'Wegpunkt ' + i }));
  while (state.waypoints.length < 2) state.waypoints.push(emptyWp());
  state.loop = closed;
  state.routeTour = null;
  renderLoop(); renderWaypoints();
  changed();
  toast('Die Tour ist jetzt eine normale Route und folgt dem Abschnitt über Wegpunkte. Sie kann an einzelnen Stellen abweichen.');
}

async function runRtLoops() {
  if (!rtSel) return;
  const start = state.waypoints[0];
  if (!start || start.lat == null) { toast('Setze zuerst einen Start: Ort suchen oder neben die Route auf die Karte tippen.'); $('rtStart').focus(); return; }
  const km = parseFloat($('rtLoopKm').value);
  if (!(km >= 2 && km <= 300)) return toast('Gib eine Länge zwischen 2 und 300 km ein.');
  if (rtCtrl) rtCtrl.abort();
  const ctrl = rtCtrl = new AbortController();
  const st = $('rtLoopStatus');
  st.hidden = false; st.textContent = 'Runden werden berechnet …';
  rtLoopCands = []; renderRtLoops();
  $('btnRtLoop').disabled = true;
  try {
    rtLoopCands = await suggestRouteLoops({ track: rtSel.track, start: { lat: start.lat, lon: start.lon }, km, profile: state.profile,
      options: state.options[state.profile], nogos: state.nogos, signal: ctrl.signal });
    if (ctrl !== rtCtrl) return;
    st.hidden = true;
    renderRtLoops();
  } catch (e) {
    if (e.name !== 'AbortError') st.textContent = e.message || 'Es wurde keine Runde gefunden.';
  } finally { $('btnRtLoop').disabled = false; }
}

function renderRtLoops() {
  const ul = $('rtLoops');
  ul.replaceChildren();
  for (const c of rtLoopCands) {
    const r = c.route;
    ul.append(h('li', {}, h('button', { type: 'button', class: 'cand', onclick: () => applyRouteTour(c.from, c.to, true, true) },
      h('span', { class: 'cand-top' }, h('span', { class: 'cand-name', text: c.name })),
      h('span', { class: 'cand-nums' },
        h('span', {}, h('b', { text: fmt(r.dist / 1000, 1) }), ' km'),
        h('span', {}, h('b', { text: fmt(r.ascent) }), ' hm'),
        h('span', {}, h('b', { text: kmText(r.secLen) }), ' km auf der Route')))));
  }
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
  $('wxMap').checked = state.windOnMap;
  $('wxMap').addEventListener('change', () => { state.windOnMap = $('wxMap').checked; save(); renderWindMap(); });
  renderWeather(null);
  renderWindMap(null);
}

function scheduleWeather() {
  clearTimeout(wxTimer);
  wxTimer = setTimeout(updateWeather, 250);
}

async function updateWeather() {
  if (wxCtrl) wxCtrl.abort();
  if (!route) { chart.setWind(null); renderWindMap(null); return renderWeather(null); }
  if (!online()) { chart.setWind(null); renderWindMap(null); return renderWeather(null, 'Das Wetter braucht Internet.'); }
  wxCtrl = new AbortController();
  const ctrl = wxCtrl, r = route;
  if (!$('wxBody').dataset.filled) renderWeather(null, 'Wetter wird geladen …');
  try {
    const samples = samplePoints(r);
    const fcs = await fetchForecast(samples, ctrl.signal);
    if (ctrl !== wxCtrl || r !== route) return;
    const start = departUnix(), speed = tourSpeed(r);
    const a = analyze(r, samples, fcs, start, speed);
    if (!a) { chart.setWind(null); renderWindMap(null); return renderWeather(null, 'Für diesen Zeitpunkt gibt es keine Vorhersage. Wähle eine Abfahrt in den nächsten sieben Tagen.'); }
    const closed = state.loop || Math.hypot(r.lat[0] - r.lat[r.n - 1], r.lon[0] - r.lon[r.n - 1]) < 0.003;
    const rev = closed ? analyze(r, samples, fcs, start, speed, true) : null;
    const best = bestStart(r, samples, fcs, dayStartUnix(), speed);
    chart.setWind(a.bins);
    renderWeather({ a, rev, best, closed });
    renderWindMap(a, r);
  } catch (e) {
    if (e.name === 'AbortError') return;
    chart.setWind(null);
    renderWindMap(null);
    renderWeather(null, e instanceof WeatherError ? e.message : 'Das Wetter konnte nicht ausgewertet werden.');
    if (!(e instanceof WeatherError)) console.error(e);
  }
}

// Wind auf der Karte: farbiger Rand an der Route (rot = Gegenwind, violett = Rückenwind) und ein Hinweis oben
let lastWind = null;
function renderWindMap(a, r) {
  if (a !== undefined) lastWind = a ? { a, r } : null;
  const badge = $('windBadge');
  $('wxMapRow').hidden = !lastWind;
  if (!lastWind || !state.windOnMap || lastWind.r !== route) { badge.hidden = true; setOverlay('wind', EMPTY); return; }
  const { a: an, r: rt } = lastWind;
  badge.replaceChildren(windArrow(an.wdir), h('span', {}, h('b', { text: fmt(an.wind) + ' km/h' }), ' aus ' + compass(an.wdir)),
    h('span', { class: 'wind-key' }, h('i', { class: 'sw wind-head' }), 'Gegenwind'), h('span', { class: 'wind-key' }, h('i', { class: 'sw wind-tail' }), 'Rückenwind'));
  badge.hidden = false;
  setOverlay('wind', { type: 'FeatureCollection', features: an.bins.filter((b) => b.cls !== 'side').map((b) => sliceFeature(rt, b.from, b.to, { cls: b.cls })) });
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
  else if (a.night) hint('Ein Teil der Tour liegt im Dunkeln. Nimm Licht mit.', { warn: true });

  body.append(lead, facts);
  if (hints.children.length) body.append(hints);
  body.append(share);
}

// ---------------------------------------------------------------- Navigation

let nav = null, wakeLock = null;
// Navigation gibt es nur auf Geräten mit Touch-Bedienung (Handy, Tablet), nicht am Computer
const canNavigate = () => window.matchMedia('(pointer: coarse)').matches;

async function keepAwake(on) {
  try {
    if (on && navigator.wakeLock && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}

function startNav() {
  if (!route || !canNavigate()) return;
  if (!navigator.geolocation) return toast('Dieser Browser kann den Standort nicht bestimmen.', true);
  nav = { d: 0, off: 0, follow: true, heading: routeBearing(route, 0), last: null, rerouteAt: 0, busy: false, arrived: false };
  closeMenu();
  chart.clearSelection();
  setOverlay('sel', EMPTY);
  document.body.classList.add('navigating');
  for (const id of ['navTop', 'navBottom']) $(id).hidden = false;
  $('navCenter').hidden = true;
  keepAwake(true);
  setTimeout(() => map.resize(), 50);
  navRender({ wait: true });
  startWatch(false);
  if (lastPos && Date.now() - lastPos.at < 15000) navUpdate({ coords: { latitude: lastPos.lat, longitude: lastPos.lon, accuracy: 20 } });
  else navCamera(route.lat[0], route.lon[0]);
}

function stopNav() {
  if (!nav) return;
  nav = null;
  keepAwake(false);
  document.body.classList.remove('navigating');
  for (const id of ['navTop', 'navBottom', 'navCenter']) $(id).hidden = true;
  setTimeout(() => { map.resize(); map.easeTo({ bearing: 0, duration: 400 }); if (route) fitRoute(route); if (isMobile()) setSheet(sheetMode); }, 60);
}

// Karte folgt dem Standort und dreht sich in Fahrtrichtung; der Standort liegt im unteren Drittel
function navCamera(lat, lon) {
  if (!nav || !nav.follow) return;
  const h2 = map.getContainer().clientHeight;
  map.easeTo({ center: [lon, lat], bearing: nav.heading, zoom: Math.max(map.getZoom(), PROFILES[state.profile].foot ? 16.5 : 16), offset: [0, h2 * 0.18], duration: 800, easing: (t) => t });
}

function navUpdate(pos) {
  if (!nav || !route) return;
  const lat = pos.coords.latitude, lon = pos.coords.longitude, acc = pos.coords.accuracy || 20;
  // Fahrtrichtung aus der Bewegung (Kompasswert des Geräts, sonst aus den letzten Positionen)
  let moved = 0;
  if (nav.last) moved = haversine(nav.last.lat, nav.last.lon, lat, lon);
  let heading = null;
  if (Number.isFinite(pos.coords.heading) && pos.coords.speed > 0.8) heading = pos.coords.heading;
  else if (nav.last && moved > 6) {
    const r = Math.PI / 180, y = Math.sin((lon - nav.last.lon) * r) * Math.cos(lat * r);
    const x = Math.cos(nav.last.lat * r) * Math.sin(lat * r) - Math.sin(nav.last.lat * r) * Math.cos(lat * r) * Math.cos((lon - nav.last.lon) * r);
    heading = Math.atan2(y, x) / r;
  }
  if (!nav.last || moved > 6) nav.last = { lat, lon };

  // Position auf der Route: erst in der Nähe der letzten Stelle suchen, dann überall (Abkürzung)
  const limit = Math.max(50, acc * 1.5);
  let m = projectOnRoute(route, lat, lon, nav.d - 150, nav.d + 1500);
  if (m.dist > limit) { const all = projectOnRoute(route, lat, lon); if (all.dist < Math.min(m.dist, limit)) m = all; }
  const onRoute = m.dist <= limit;
  if (onRoute) { nav.d = m.d; nav.off = 0; } else nav.off++;

  // Im Stand flattert die Richtung: dann an der Route ausrichten
  nav.heading = heading != null ? heading : onRoute ? routeBearing(route, nav.d) : nav.heading;
  navCamera(lat, lon);
  chart.setCursor(onRoute ? nav.d : null);

  if (nav.off >= 2) {
    // Neben der Route: mit Internet neu berechnen, sonst Richtung zurück zeigen
    const back = projectOnRoute(route, lat, lon);
    if (online() && !state.routeTour && !nav.busy && Date.now() - nav.rerouteAt > 20000) navReroute(lat, lon);
    const r = Math.PI / 180, y = Math.sin((back.lon - lon) * r) * Math.cos(back.lat * r);
    const x = Math.cos(lat * r) * Math.sin(back.lat * r) - Math.sin(lat * r) * Math.cos(back.lat * r) * Math.cos((back.lon - lon) * r);
    return navRender({ back: { dist: back.dist, rel: Math.atan2(y, x) / r - nav.heading }, busy: nav.busy });
  }
  navRender({});
}

async function navReroute(lat, lon) {
  nav.busy = true;
  nav.rerouteAt = Date.now();
  try {
    // offene Wegpunkte: alle, die auf der bisherigen Route noch vor uns liegen
    const here = projectOnRoute(route, lat, lon).d, rest = [];
    let from = 0;
    const wps = state.waypoints.filter((w) => w.lat != null);
    wps.forEach((w, i) => {
      if (i === 0) return;
      const d = projectOnRoute(route, w.lat, w.lon, from).d;
      from = d;
      if (d > here + 40) rest.push({ id: uid(), lat: w.lat, lon: w.lon, label: w.label });
    });
    const start = wps[0];
    if (state.loop) rest.push({ id: uid(), lat: start.lat, lon: start.lon, label: start.label });
    if (!rest.length) { const end = wps[wps.length - 1]; rest.push({ id: uid(), lat: end.lat, lon: end.lon, label: end.label }); }
    const pts = [{ lat, lon }, ...rest];
    const r = await fetchRoute({ profile: state.profile, options: state.options[state.profile], points: pts, nogos: state.nogos });
    if (!nav) return;
    // Die Planung zeigt ab jetzt den Rest der Tour ab dem aktuellen Standort
    state.waypoints = [{ id: uid(), lat, lon, label: 'Standort' }, ...rest];
    state.loop = false;
    renderLoop(); renderWaypoints(); save();
    route = r;
    storedPois = null;
    fitNext = false;
    showRoute();
    nav.d = 0; nav.off = 0;
    navRender({});
  } catch (e) {
    /* nächster Versuch nach der Wartezeit; bis dahin zeigt der Pfeil zurück zur Route */
  } finally { if (nav) nav.busy = false; }
}

function navArrow(angle) {
  // Pfeil mit Knick: Schaft von unten, Spitze in Abbiegerichtung
  const a = (Math.max(-160, Math.min(160, angle)) * Math.PI) / 180;
  const x = 30 + 20 * Math.sin(a), y = 32 - 20 * Math.cos(a);
  const hx = (da) => (x - 10 * Math.sin(a + da)).toFixed(1) + ' ' + (y + 10 * Math.cos(a + da)).toFixed(1);
  return `<svg viewBox="0 0 60 60"><path d="M30 54V32L${x.toFixed(1)} ${y.toFixed(1)}"/><path d="M${hx(0.6)}L${x.toFixed(1)} ${y.toFixed(1)}L${hx(-0.6)}"/></svg>`;
}
const navDistText = (m) => (m < 1000 ? fmt(Math.max(10, Math.round(m / 10) * 10)) + ' m' : fmt(m / 1000, 1) + ' km');

function navRender({ wait, back, busy }) {
  if (!nav || !route) return;
  const top = $('navTop'), rest = Math.max(0, route.dist - nav.d);
  top.classList.toggle('warn', !!back);
  if (wait) {
    $('navIcon').innerHTML = navArrow(0); $('navDist').textContent = 'Standort …'; $('navHint').textContent = 'Warte auf GPS';
  } else if (back) {
    $('navIcon').innerHTML = navArrow(((back.rel + 540) % 360) - 180);
    $('navDist').textContent = navDistText(back.dist);
    $('navHint').textContent = busy ? 'Route wird neu berechnet …' : online() ? 'Neben der Route' : 'Zurück zur Route';
  } else if (rest < 30) {
    nav.arrived = true;
    $('navIcon').innerHTML = '<svg viewBox="0 0 60 60"><path d="M16 32l10 10 18-22"/></svg>';
    $('navDist').textContent = 'Ziel'; $('navHint').textContent = 'Du bist angekommen';
  } else {
    const t = (route.turns || []).find((k) => k.d > nav.d + 8);
    if (!t) {
      $('navIcon').innerHTML = navArrow(0); $('navDist').textContent = navDistText(rest); $('navHint').textContent = 'Dem Weg bis zum Ziel folgen';
    } else {
      const dist = t.d - nav.d, a = t.angle, abs = Math.abs(a), side = a < 0 ? 'links' : 'rechts';
      $('navDist').textContent = navDistText(dist);
      if (t.exit) {
        $('navIcon').innerHTML = `<svg viewBox="0 0 60 60"><circle cx="30" cy="30" r="15"/><text x="30" y="38" text-anchor="middle">${t.exit}</text></svg>`;
        $('navHint').textContent = `Kreisverkehr, ${t.exit}. Ausfahrt`;
      } else {
        $('navIcon').innerHTML = navArrow(dist > 1000 ? 0 : a);
        $('navHint').textContent = dist > 1000 ? 'Geradeaus, dann ' + side : abs > 150 ? 'Wenden' : abs > 110 ? 'Scharf ' + side : abs < 40 ? 'Leicht ' + side : side === 'links' ? 'Links abbiegen' : 'Rechts abbiegen';
      }
    }
  }
  // Rest: Strecke, Höhenmeter bergauf, Ankunft
  let up = 0, ref = pointAt(route, nav.d).ele;
  for (let i = pointAt(route, nav.d).i + 1; i < route.n; i++) { const dd = route.ele[i] - ref; if (dd > 4) { up += dd; ref = route.ele[i]; } else if (dd < -4) ref = route.ele[i]; }
  $('navRest').innerHTML = `${fmt(rest / 1000, 1)}<small> km</small>`;
  $('navUp').innerHTML = route.hasEle ? `${fmt(up)}<small> m</small>` : '–';
  const hours = tourHours(route) * (rest / (route.dist || 1));
  $('navEta').textContent = new Date(Date.now() + hours * 3600000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function initNav() {
  $('btnNav').addEventListener('click', startNav);
  $('navStop').addEventListener('click', stopNav);
  $('navCenter').addEventListener('click', () => { if (!nav) return; nav.follow = true; $('navCenter').hidden = true; if (lastPos) navCamera(lastPos.lat, lastPos.lon); });
  // Wer die Karte selbst verschiebt, schaut sich um: Nachführen pausieren, bis „Zentrieren" getippt wird
  map.on('dragstart', () => { if (nav) { nav.follow = false; $('navCenter').hidden = false; } });
  document.addEventListener('visibilitychange', () => { if (nav && document.visibilityState === 'visible') keepAwake(true); });
}

// ---------------------------------------------------------------- Export

function defaultTourName() {
  if (state.routeTour) { const rt = state.routeTour; return rt.closed && Math.abs(rt.to - rt.from) > (rt.dist || 0) - 50 ? `${rt.name} (Runde)` : `${rt.name}, ${secDescription(rt.from, rt.to, rt.dist || Math.abs(rt.to - rt.from), !!rt.closed).split(',')[0]}`; }
  const pts = state.waypoints.filter((w) => w.lat != null);
  if (pts.length < 2 && !state.loop) return 'Tour';
  const short = (s) => s.split(',')[0];
  const a = short(pts[0].label), b = short(pts[pts.length - 1].label);
  const km = route ? ' ' + fmt(route.dist / 1000) + ' km' : '';
  return (state.loop || a === b ? 'Runde ab ' + a : a + ' – ' + b) + km;
}

// Stand der Planung, mit dem sich eine Tour später genau wiederherstellen lässt
function snapshot() {
  return {
    profile: state.profile, options: state.options[state.profile], loop: state.loop,
    waypoints: state.waypoints.filter((w) => w.lat != null).map((w) => ({ lat: +w.lat.toFixed(6), lon: +w.lon.toFixed(6), label: w.label })),
    nogos: state.nogos.map((n) => ({ lat: n.lat, lon: n.lon, radius: n.radius })),
    rt: state.routeTour || undefined,
  };
}

function restore(plan, name, stored) {
  if (!plan || !Array.isArray(plan.waypoints) || (plan.waypoints.length < 1 && !plan.rt)) return toast('Diese Tour lässt sich nicht laden.', true);
  if (PROFILES[plan.profile]) { state.profile = plan.profile; state.options[plan.profile] = { ...DEFAULT_OPTIONS[plan.profile], ...plan.options }; }
  state.waypoints = plan.waypoints.map((w) => ({ id: uid(), lat: w.lat, lon: w.lon, label: w.label || fmt(w.lat, 5) + ', ' + fmt(w.lon, 5) }));
  while (state.waypoints.length < 2) state.waypoints.push(emptyWp());
  state.loop = !!plan.loop;
  state.routeTour = plan.rt && plan.rt.id ? plan.rt : null;
  state.nogos = (plan.nogos || []).map((n) => ({ ...n, id: uid() }));
  state.mode = 'route';
  setTab('plan');
  state.tourName = name || '';
  $('tourName').value = state.tourName;
  fitNext = true;
  renderProfile(); renderOptions(); renderMode(); renderLoop(); renderWaypoints(); renderNogos();
  if (!stored) return changed();
  // Offline-Tour: gespeicherte Strecke und Stopps zeigen, ohne neu zu rechnen
  alt = 0;
  clearCandidates();
  if (routeCtrl) { routeCtrl.abort(); routeCtrl = null; }
  clearTimeout(routeTimer);
  $('busy').hidden = true;
  save();
  route = stored.route;
  storedPois = { route, pois: stored.pois || [] };
  showRoute();
}

function gpxFile(type = 'application/gpx+xml') {
  const name = state.tourName.trim() || defaultTourName();
  // Dateiname ohne Umlaute und Sonderzeichen, damit ihn auch Garmin-Geräte sauber anzeigen
  const map = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' };
  const safe = name.replace(/[äöüÄÖÜß]/g, (c) => map[c]).normalize('NFD').replace(/[^A-Za-z0-9 _-]+/g, '')
    .trim().replace(/\s+/g, '_') || 'Tour';
  return new File([toGpx(route, name, snapshot())], safe + '.gpx', { type });
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

// Teilen: Als allgemeine Datei übergeben, damit das Handy die Apps nach der Endung .gpx auswählt
// (so erscheint z. B. Garmin Connect eher in der Liste als beim Typ "GPX").
function shareFile() {
  for (const type of ['application/octet-stream', 'application/gpx+xml']) {
    const file = gpxFile(type);
    if (navigator.canShare && navigator.canShare({ files: [file] })) return file;
  }
  return null;
}
async function shareGpx() {
  if (!route) return;
  const file = shareFile();
  if (!file) return downloadGpx();
  try { await navigator.share({ files: [file] }); } catch (e) { if (e.name !== 'AbortError') downloadGpx(); }
}

// ---------------------------------------------------------------- Tour-Link

// Der Link enthält die ganze Planung (Radtyp, Optionen, Wegpunkte, Sperrzonen), gepackt und für URLs kodiert.
const b64 = {
  enc: (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
};
async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
async function tourLink() {
  const plan = snapshot(), def = DEFAULT_OPTIONS[plan.profile], opts = {};
  for (const k in plan.options) if (plan.options[k] !== def[k]) opts[k] = plan.options[k]; // nur Abweichungen vom Standard
  const data = { n: state.tourName.trim() || defaultTourName(), p: plan.profile, o: opts, l: plan.loop ? 1 : 0, r: plan.rt,
    w: plan.waypoints.map((w) => [+w.lat.toFixed(5), +w.lon.toFixed(5), w.label]), g: plan.nogos.map((n) => [+n.lat.toFixed(5), +n.lon.toFixed(5), n.radius]) };
  const raw = new TextEncoder().encode(JSON.stringify(data));
  let code = 'j' + b64.enc(raw);
  if (window.CompressionStream) { try { code = 'z' + b64.enc(await pipe(raw, new CompressionStream('deflate-raw'))); } catch (e) { /* ungepackt verwenden */ } }
  return location.origin + location.pathname + '#t=' + code;
}
async function readTourLink() {
  const m = location.hash.match(/[#&]t=([jz])([\w-]+)/);
  if (!m) return false;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    let bytes = b64.dec(m[2]);
    if (m[1] === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    const d = JSON.parse(new TextDecoder().decode(bytes));
    restore({ profile: d.p, options: d.o || {}, loop: !!d.l, rt: d.r, waypoints: d.w.map((w) => ({ lat: w[0], lon: w[1], label: w[2] })),
      nogos: (d.g || []).map((n) => ({ lat: n[0], lon: n[1], radius: n[2] })) }, d.n || '');
    toast('Tour aus dem Link geladen.');
    return true;
  } catch (e) {
    toast('Der Tour-Link ist beschädigt und konnte nicht gelesen werden.', true);
    return false;
  }
}
async function shareLink() {
  if (!route) return;
  const url = await tourLink(), title = state.tourName.trim() || defaultTourName();
  if (navigator.share && isMobile()) { try { await navigator.share({ title, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(url); toast('Link kopiert. Er öffnet die Tour auf jedem Gerät.'); } catch (e) { window.prompt('Link zur Tour:', url); }
}

// ---------------------------------------------------------------- Meine Touren

const TOURS_KEY = 'rueckenwind.tours';
function loadTours() { try { return JSON.parse(localStorage.getItem(TOURS_KEY) || '[]'); } catch (e) { return []; } }
function storeTours(list) { try { localStorage.setItem(TOURS_KEY, JSON.stringify(list)); } catch (e) { toast('Die Tour konnte nicht gespeichert werden.', true); } }

function saveTour() {
  if (!route) return;
  const name = state.tourName.trim() || defaultTourName();
  const old = loadTours().filter((t) => t.name === name);
  old.forEach((t) => { if (offRecs.has(t.id)) removeDownload(t.id).then(refreshOffline).catch(() => {}); });
  const list = loadTours().filter((t) => t.name !== name);
  list.unshift({ id: uid(), name, date: Date.now(), dist: route.dist, ascent: route.ascent, plan: snapshot() });
  storeTours(list);
  renderTours();
  toast('Tour gespeichert: ' + name);
}

// ---- Offline: Tour mit Karte und Stopps aufs Gerät laden
let offRecs = new Map(), offJob = null, storedPois = null;

async function refreshOffline() {
  try { offRecs = new Map((await listOffline()).map((r) => [r.id, r])); } catch (e) { offRecs = new Map(); }
  renderTours();
}

async function prepareOffline(t) {
  if (!online()) return toast('Zum Herunterladen brauchst du Internet.', true);
  if (!('caches' in window) || !('indexedDB' in window)) return toast('Dieser Browser kann keine Offline-Daten speichern.', true);
  if (offJob) offJob.ctrl.abort();
  const job = offJob = { id: t.id, stage: 'prep', ctrl: new AbortController() };
  renderTours();
  try {
    const p = t.plan, pts = p.waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));
    if (p.loop) pts.push(pts[0]);
    const opts = { ...DEFAULT_OPTIONS[p.profile], ...p.options };
    const r = p.rt
      ? await buildRouteTour({ track: await loadRouteTrack(p.rt.id, job.ctrl.signal), from: p.rt.from, to: p.rt.to, start: p.rt.approach && p.waypoints[0] ? p.waypoints[0] : null,
        back: p.rt.back, profile: p.profile, options: opts, nogos: p.nogos || [], signal: job.ctrl.signal })
      : await fetchRoute({ profile: p.profile, options: opts, points: pts, nogos: p.nogos || [], signal: job.ctrl.signal });
    const dl = await planDownload(r, LAYERS.standard.style, job.ctrl.signal);
    let pois = [], poiNote = state.poiCats.length ? '' : ' Stopps sind keine gewählt.';
    if (state.poiCats.length) {
      try { pois = await fetchPois(r, state.poiCats, job.ctrl.signal, state.poiRadius); poiNote = ` ${pois.length} Stopps.`; } catch (e) {
        if (e.name === 'AbortError') throw e;
        poiNote = ' Die Stopps konnten gerade nicht geladen werden.';
      }
    }
    if (offJob !== job) return;
    Object.assign(job, { stage: 'confirm', dl, rec: { id: t.id, name: t.name, plan: p, route: r, pois },
      text: `${fmt(dl.tiles.length)} Kartenteile, rund ${mb(dl.estBytes)}, Streifen ${dl.buffer >= 1000 ? dl.buffer / 1000 + ' km' : dl.buffer + ' m'} je Seite.${poiNote}` });
    renderTours();
  } catch (e) {
    if (offJob === job) { offJob = null; renderTours(); }
    if (e.name !== 'AbortError') toast(e instanceof RouteError ? e.message : (e.message || 'Die Offline-Daten konnten nicht vorbereitet werden.'), true);
  }
}

async function startOffline() {
  const job = offJob;
  if (!job || job.stage !== 'confirm') return;
  job.stage = 'loading'; job.text = 'Lädt …';
  renderTours();
  try {
    const rec = await runDownload(job.rec, job.dl, (done, total) => {
      if (offJob !== job) return;
      const el = document.querySelector('.tour-off-text');
      if (el) el.textContent = `Lädt … ${fmt(done)} von ${fmt(total)} Teilen`;
    }, job.ctrl.signal);
    if (offJob === job) offJob = null;
    await refreshOffline();
    toast(`„${rec.name}“ ist offline verfügbar (${mb(rec.bytes)}).`);
  } catch (e) {
    if (offJob === job) { offJob = null; renderTours(); }
    if (e.name !== 'AbortError') toast(e.message || 'Der Download ist fehlgeschlagen.', true);
  }
}

function openTour(t) {
  const rec = offRecs.get(t.id);
  if (!rec && !online()) return toast('Diese Tour ist nicht offline gespeichert.', true);
  restore(t.plan, t.name, rec ? { route: rec.route, pois: rec.pois } : null);
  if (isMobile()) setSheet('half');
}

function renderTours() {
  const list = loadTours(), ul = $('tourList');
  ul.replaceChildren();
  $('tourEmpty').hidden = list.length > 0;
  const link = (text, fn, cls = 'link-btn') => h('button', { type: 'button', class: cls, text, onclick: fn });
  for (const t of list) {
    const rec = offRecs.get(t.id), job = offJob && offJob.id === t.id ? offJob : null;
    let off;
    if (job && job.stage === 'prep') off = [h('span', { class: 'tour-off-text', text: 'Wird vorbereitet …' }), link('Abbrechen', () => { job.ctrl.abort(); offJob = null; renderTours(); })];
    else if (job && job.stage === 'confirm') off = [h('span', { class: 'tour-off-text', text: job.text }), link('Herunterladen', startOffline, 'ghost-btn'), link('Abbrechen', () => { offJob = null; renderTours(); })];
    else if (job) off = [h('span', { class: 'tour-off-text', text: job.text }), link('Abbrechen', () => { job.ctrl.abort(); offJob = null; renderTours(); })];
    else if (rec) off = [h('span', { class: 'tour-off-text ok', text: `Offline verfügbar, ${mb(rec.bytes)}` }), link('Offline-Daten löschen', () => removeDownload(t.id).then(refreshOffline))];
    else off = [link('Offline verfügbar machen', () => prepareOffline(t))];
    ul.append(h('li', {},
      h('button', { type: 'button', class: 'tour-item', onclick: () => openTour(t) },
        h('span', { class: 'tour-name', text: t.name }),
        h('span', { class: 'tour-meta', text: `${fmt(t.dist / 1000)} km, ${fmt(t.ascent)} hm, ${PROFILES[t.plan.profile] ? PROFILES[t.plan.profile].label : ''}, ${new Date(t.date).toLocaleDateString('de-DE')}` })),
      h('button', { class: 'icon-btn', type: 'button', title: 'Tour löschen', 'aria-label': t.name + ' löschen',
        onclick: () => { storeTours(loadTours().filter((x) => x.id !== t.id)); if (rec) removeDownload(t.id).then(refreshOffline).catch(() => {}); renderTours(); } }, icon('x')),
      h('div', { class: 'tour-off' }, ...off)));
  }
  let total = 0;
  for (const r of offRecs.values()) total += r.bytes || 0;
  const clear = $('btnOffClear');
  clear.hidden = offRecs.size === 0;
  clear.textContent = `Alle Offline-Daten löschen (${mb(total)})`;
}

// Hinweis und Kartenwechsel, wenn das Netz weg ist oder wiederkommt
function applyOnline() {
  $('offlineBadge').hidden = online();
  document.body.classList.toggle('is-offline', !online());
  if (!map) return;
  if (!online() && state.layer !== 'standard') map.setStyle(LAYERS.standard.style, { diff: false });
  else if (online() && state.layer !== 'standard') map.setStyle(LAYERS[state.layer].style, { diff: false });
  if (online() && route) { scheduleWeather(); }
}

async function importGpx(file) {
  try {
    const g = parseGpx(await file.text());
    if (g.plan) { restore(g.plan, g.name); return toast('Tour geladen: ' + (g.name || file.name)); }
    // Fremde GPX-Datei: Strecke über wenige Stützpunkte mit dem aktuellen Radtyp nachbauen
    const pts = g.points, a = pts[0], b = pts[pts.length - 1];
    const closed = Math.hypot(a.lat - b.lat, (a.lon - b.lon) * Math.cos(a.lat * Math.PI / 180)) < 0.003;
    let keep = simplifyTrack(pts, 14);
    if (closed) keep = keep.slice(0, -1);
    restore({ profile: state.profile, options: state.options[state.profile], loop: closed, nogos: [],
      waypoints: keep.map((q, i) => ({ lat: q.lat, lon: q.lon, label: i === 0 ? 'Start aus GPX' : 'Wegpunkt ' + i })) }, g.name);
    toast('Strecke aus der GPX-Datei nachgebaut. Sie kann leicht vom Original abweichen.');
  } catch (e) {
    toast(e instanceof RouteError ? e.message : 'Die Datei konnte nicht gelesen werden.', true);
  }
}

// ---------------------------------------------------------------- Stopps an der Strecke

let poiMarkers = [], poiCtrl = null, poiTimer = 0;

function renderPoiChips() {
  const host = $('poiChips');
  host.replaceChildren();
  for (const [title, keys] of POI_GROUPS) {
    host.append(h('div', { class: 'poi-group', text: title }), h('div', { class: 'chips' }, ...keys.map((key) => h('button', { type: 'button', class: 'chip',
      'aria-pressed': String(state.poiCats.includes(key)), text: POI_CATS[key].icon + ' ' + POI_CATS[key].label, onclick: () => {
        state.poiCats = state.poiCats.includes(key) ? state.poiCats.filter((k) => k !== key) : [...state.poiCats, key];
        save(); renderPoiChips(); schedulePois(100);
      } }))));
  }
}

function schedulePois(delay = 300) {
  clearTimeout(poiTimer);
  poiTimer = setTimeout(updatePois, delay);
}

function drawPois(pois) {
  for (const q of pois) {
      const elm = h('button', { type: 'button', class: 'poi poi-' + q.cat + (q.unsure ? ' poi-unsure' : ''), title: q.name, text: POI_CATS[q.cat].icon });
      elm.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openMenu(q.lat, q.lon, h('div', { class: 'map-menu' },
          h('strong', { text: q.name }),
          h('span', { class: 'menu-note', text: `${q.kind || POI_CATS[q.cat].label}, bei km ${fmt(q.d / 1000, 1)}, ${fmt(Math.round(q.off / 10) * 10)} m neben der Strecke` }),
          q.hours ? h('span', { class: 'menu-note', text: q.hours }) : null,
          h('span', { class: 'menu-links' },
            q.web ? h('a', { href: q.web, target: '_blank', rel: 'noopener noreferrer', text: 'Webseite' }) : null,
            h('a', { href: 'https://www.google.com/maps/search/' + encodeURIComponent(q.name) + '/@' + q.lat.toFixed(5) + ',' + q.lon.toFixed(5) + ',16z', target: '_blank', rel: 'noopener noreferrer', text: 'Bei Google Maps' }),
            q.phone ? h('a', { href: 'tel:' + q.phone.replace(/[^+\d]/g, ''), text: q.phone }) : null),
          h('button', { type: 'button', text: 'Als Wegpunkt einfügen', onclick: () => { closeMenu(); addVia(q.lat, q.lon); } })), 14);
      });
      poiMarkers.push(new maplibregl.Marker({ element: elm }).setLngLat([q.lon, q.lat]).addTo(map));
  }
}

async function updatePois() {
  if (poiCtrl) poiCtrl.abort();
  poiMarkers.forEach((m) => m.remove());
  poiMarkers = [];
  const status = $('poiStatus');
  status.hidden = true;
  // Offline-Tour: die mit der Tour gespeicherten Stopps zeigen
  if (route && storedPois && storedPois.route === route && (!online() || !state.poiCats.length)) {
    status.hidden = false;
    status.textContent = storedPois.pois.length ? `${storedPois.pois.length} gespeicherte Stopps. Tippe auf ein Symbol in der Karte.` : 'Mit dieser Tour wurden keine Stopps gespeichert.';
    return drawPois(storedPois.pois);
  }
  if (!route || !state.poiCats.length) return;
  if (!online()) { status.hidden = false; status.textContent = 'Neue Stopps brauchen Internet.'; return; }
  poiCtrl = new AbortController();
  const ctrl = poiCtrl, r = route;
  status.hidden = false;
  status.textContent = 'Stopps werden gesucht …';
  try {
    const pois = await fetchPois(r, state.poiCats, ctrl.signal, state.poiRadius);
    if (ctrl !== poiCtrl || r !== route) return;
    status.textContent = pois.length ? `${pois.length} Stopps an der Strecke. Tippe auf ein Symbol in der Karte.` : `Keine passenden Stopps im Umkreis von ${state.poiRadius < 1000 ? state.poiRadius + ' m' : state.poiRadius / 1000 + ' km'} um die Strecke gefunden.`;
    drawPois(pois);
  } catch (e) {
    if (e.name === 'AbortError') return;
    status.textContent = (e instanceof PoiError ? e.message : 'Die Stopps konnten nicht geladen werden.') + ' ';
    status.append(h('button', { type: 'button', class: 'link-btn', text: 'Erneut versuchen', onclick: () => schedulePois(0) }));
  }
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

// Bottom-Sheet am Handy: feste Höhe, wird per Verschiebung ein- und ausgefahren (läuft flüssig, ohne die Karte umzubauen)
const SHEET = ['peek', 'half', 'full'];
let sheetMode = 'half';

function safeBottom() {
  let probe = $('safeProbe');
  if (!probe) { probe = h('div', { id: 'safeProbe', style: 'position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom);visibility:hidden' }); document.body.append(probe); }
  return probe.offsetHeight || 0;
}
function sheetHeights() {
  const vh = window.innerHeight, full = vh - 48;
  return { full, half: Math.round(vh * 0.5), peek: (route ? 92 : 86) + safeBottom() };
}
function sheetVisible() { return isMobile() ? sheetHeights()[sheetMode] : 0; }
function applySheet(y, visible) {
  $('panel').style.setProperty('--sheet-y', Math.round(y) + 'px');
  document.body.style.setProperty('--sheet-vis', Math.round(visible) + 'px');
}
function setSheet(mode) {
  sheetMode = mode;
  const hts = sheetHeights();
  $('panel').style.setProperty('--sheet-h', hts.full + 'px');
  applySheet(hts.full - hts[mode], hts[mode]);
  document.body.dataset.sheet = mode;
  if (mode !== 'full') $('panelScroll').scrollTop = 0;
}

function initSheet() {
  const p = $('panel');
  let drag = null;
  setSheet(sheetMode);
  // Ziehen am Griff, an der Kopfzeile und an den Kennzahlen
  p.addEventListener('pointerdown', (ev) => {
    if (!isMobile()) return;
    const zone = ev.target.closest('.sheet-handle, .dock-head, #brandBar');
    if (!zone || (ev.target.closest('button, input, select, a') && !ev.target.closest('.sheet-handle'))) return;
    const hts = sheetHeights();
    drag = { id: ev.pointerId, y0: ev.clientY, base: hts.full - hts[sheetMode], hts, moved: false, lastY: ev.clientY, lastT: ev.timeStamp, v: 0, handle: !!ev.target.closest('.sheet-handle') };
    p.setPointerCapture(ev.pointerId);
    p.classList.add('dragging');
  });
  p.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const dy = ev.clientY - drag.y0;
    if (Math.abs(dy) > 5) drag.moved = true;
    if (!drag.moved) return;
    const dt = ev.timeStamp - drag.lastT;
    if (dt > 0) drag.v = 0.7 * ((ev.clientY - drag.lastY) / dt) + 0.3 * drag.v;
    drag.lastY = ev.clientY; drag.lastT = ev.timeStamp;
    const y = Math.max(0, Math.min(drag.hts.full - 60, drag.base + dy));
    applySheet(y, drag.hts.full - y);
  });
  const end = (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    p.classList.remove('dragging');
    const i = SHEET.indexOf(sheetMode);
    if (!d.moved) { if (d.handle) setSheet(SHEET[(i + 1) % 3]); return; }
    const y = d.base + (ev.clientY - d.y0), visible = d.hts.full - y;
    let target;
    // Schneller Wisch: eine Stufe in Wischrichtung; sonst die nächstgelegene Stufe
    if (Math.abs(d.v) > 0.45) target = SHEET[Math.max(0, Math.min(2, i + (d.v < 0 ? 1 : -1)))];
    else target = SHEET.reduce((best, m) => (Math.abs(d.hts[m] - visible) < Math.abs(d.hts[best] - visible) ? m : best), 'peek');
    setSheet(target);
  };
  p.addEventListener('pointerup', end);
  p.addEventListener('pointercancel', end);
  window.addEventListener('resize', () => setSheet(sheetMode));

  // Texteingabe: Sheet ganz öffnen und das Feld nach oben holen, damit die Tastatur nichts verdeckt
  const scroll = $('panelScroll');
  scroll.addEventListener('focusin', (ev) => {
    if (!isMobile() || !ev.target.matches('input[type=text], input[type=number]')) return;
    setSheet('full');
    document.body.classList.add('typing');
    const field = ev.target;
    setTimeout(() => {
      const top = field.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
      scroll.scrollTo({ top: Math.max(0, top - 14), behavior: 'smooth' });
    }, 320);
  });
  scroll.addEventListener('focusout', () => document.body.classList.remove('typing'));
  if (window.visualViewport) {
    const onVV = () => {
      if (!isMobile()) return;
      // Platz für die Tastatur schaffen und verhindern, dass der Browser die ganze Seite wegschiebt
      const kb = Math.max(0, window.innerHeight - window.visualViewport.height);
      scroll.style.setProperty('--kb', (kb > 80 ? kb : 0) + 'px');
      if (window.scrollY || document.documentElement.scrollTop) window.scrollTo(0, 0);
    };
    window.visualViewport.addEventListener('resize', onVV);
    window.visualViewport.addEventListener('scroll', onVV);
  }
}

// Höhe des Höhenprofils: am Griff ziehen, wird je Gerät gemerkt
function applyChartHeight() {
  $('dock').style.setProperty('--chart-h', state.chartH[isMobile() ? 'mobile' : 'desktop'] + 'px');
}
function initChartGrip() {
  const grip = $('chartGrip');
  let drag = null;
  applyChartHeight();
  grip.addEventListener('pointerdown', (ev) => {
    const key = isMobile() ? 'mobile' : 'desktop';
    drag = { id: ev.pointerId, y0: ev.clientY, h0: state.chartH[key], key };
    grip.setPointerCapture(ev.pointerId);
    grip.classList.add('active');
    ev.preventDefault();
  });
  grip.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    // Am Desktop sitzt der Griff über dem Profil (hochziehen = größer), am Handy darunter (runterziehen = größer)
    const dy = (ev.clientY - drag.y0) * (drag.key === 'mobile' ? 1 : -1);
    state.chartH[drag.key] = Math.round(Math.max(60, Math.min(drag.key === 'mobile' ? 220 : Math.max(120, window.innerHeight - 320), drag.h0 + dy)));
    applyChartHeight();
  });
  const end = (ev) => { if (!drag || ev.pointerId !== drag.id) return; drag = null; grip.classList.remove('active'); save(); };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}

function setTab(tab) {
  state.tab = TABS[tab] ? tab : 'plan';
  document.body.dataset.tab = state.tab;
  if (map) renderRtMap();
  for (const b of $('tabBar').children) b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
  $('panelScroll').scrollTop = 0;
  save();
  // Routen: beim ersten Öffnen gleich im Kartenausschnitt suchen
  if (state.tab === 'routen' && map && !rtSearched && !rtSel && !rtLoading && online() && map.getZoom() >= 9) runRtSearch();
}
function initTabs() {
  for (const key in TABS) $('tabBar').append(h('button', { type: 'button', role: 'tab', 'data-tab': key, text: TABS[key],
    onclick: () => { setTab(key); if (isMobile() && sheetMode === 'peek') setSheet('half'); } }));
  $('tabBar').setAttribute('role', 'tablist');
  setTab(state.tab);
  initRoutes();
}

function initLegend() {
  const btn = $('btnLegend'), legend = $('chartLegend');
  const apply = () => { legend.hidden = !state.folds.legend; btn.setAttribute('aria-expanded', String(!!state.folds.legend)); btn.textContent = state.folds.legend ? 'Legende ausblenden' : 'Legende'; };
  btn.addEventListener('click', () => { state.folds.legend = !state.folds.legend; save(); apply(); });
  apply();
}

// Breite des Menüs am Computer: am rechten Rand ziehen
function initPanelGrip() {
  const grip = $('panelGrip'), apply = () => $('app').style.setProperty('--panel-w', state.panelW + 'px');
  let drag = null;
  apply();
  grip.addEventListener('pointerdown', (ev) => { drag = { id: ev.pointerId, x0: ev.clientX, w0: state.panelW }; grip.setPointerCapture(ev.pointerId); grip.classList.add('active'); ev.preventDefault(); });
  grip.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    state.panelW = Math.round(Math.max(300, Math.min(720, Math.min(window.innerWidth - 320, drag.w0 + ev.clientX - drag.x0))));
    apply();
  });
  const end = (ev) => { if (!drag || ev.pointerId !== drag.id) return; drag = null; grip.classList.remove('active'); save(); };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', () => { state.panelW = 404; apply(); save(); });
}

function initFolds() {
  for (const d of document.querySelectorAll('details[data-fold]')) {
    const key = d.dataset.fold;
    if (key in state.folds) d.open = state.folds[key];
    d.addEventListener('toggle', () => { state.folds[key] = d.open; save(); });
  }
}

async function init() {
  load();
  initUndo();
  initTabs();
  initFolds();
  initMap();
  initRound();
  initWeather();
  const setArmed = (on) => { $('btnRange').setAttribute('aria-pressed', String(on)); $('btnRange').textContent = on ? 'Jetzt im Profil ziehen' : 'Bereich wählen'; };
  chart = createProfileChart($('profileChart'), { onHover: (d, p) => setHover(d, p), onSelect: selectRange, onArm: setArmed });
  $('btnRange').addEventListener('click', () => { const on = $('btnRange').getAttribute('aria-pressed') !== 'true'; chart.arm(on); setArmed(on); });
  // Karte passt sich an, wenn Menü oder Höhenprofil ihre Größe ändern
  new ResizeObserver(() => map.resize()).observe($('mapArea'));
  initPanelGrip();
  $('btnSelClear').addEventListener('click', () => { chart.clearSelection(); selectRange(null); });
  initSheet();
  initChartGrip();
  initLegend();
  initNav();
  placeDock();
  window.matchMedia('(max-width: 820px)').addEventListener('change', () => { placeDock(); setSheet(sheetMode); applyChartHeight(); });

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
    state.routeTour = null;
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
    if (v >= 2 && v <= 60) { state.speeds[state.profile] = v; save(); renderTime(); scheduleWeather(); } else $('speedInput').value = state.speeds[state.profile];
  });
  $('btnLocate').addEventListener('click', () => locate(null));
  $('btnGpx').addEventListener('click', downloadGpx);
  if (navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.gpx', { type: 'application/octet-stream' })] })) {
    $('btnShare').hidden = false;
    $('btnShare').addEventListener('click', shareGpx);
    $('gpxHint').textContent = 'Für Garmin: „Teilen“ und Connect wählen. Fehlt Connect in der Liste, tippe am Ende der App-Reihe auf „Mehr“ oder sichere die Datei in „Dateien“ und teile sie von dort mit Connect.';
  }
  $('btnSave').addEventListener('click', saveTour);
  $('btnLink').addEventListener('click', shareLink);
  $('btnImport').addEventListener('click', () => $('gpxFile').click());
  $('gpxFile').addEventListener('change', () => { const f = $('gpxFile').files[0]; $('gpxFile').value = ''; if (f) importGpx(f); });
  renderTours();
  refreshOffline();
  $('btnOffClear').addEventListener('click', async () => { for (const id of [...offRecs.keys()]) await removeDownload(id).catch(() => {}); refreshOffline(); toast('Alle Offline-Daten gelöscht.'); });
  window.addEventListener('hashchange', readTourLink);
  window.addEventListener('online', applyOnline);
  window.addEventListener('offline', applyOnline);
  applyOnline();
  renderPoiChips();
  $('poiRadius').value = String(state.poiRadius);
  $('poiRadius').addEventListener('change', () => { state.poiRadius = +$('poiRadius').value; save(); schedulePois(100); });
  // Standort gleich anzeigen, wenn der Zugriff schon früher erlaubt wurde
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then((r) => { if (r.state === 'granted') startWatch(false); }).catch(() => {});
  }
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { toggleLayerMenu(false); closeMenu(); } });

  if (await readTourLink()) { /* Tour aus dem Link wird geladen */ }
  else if (state.waypoints.filter((w) => w.lat != null).length >= 2 && online()) calcRoute();
  else if (!online()) toast('Kein Internet. Offline-Touren findest du unter „Meine Touren“.');
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === '127.0.0.1' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
