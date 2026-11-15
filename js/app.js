/* global L */
import {
  PROFILES, DEFAULT_OPTIONS, fetchRoute, RouteError, nearestIndex, toGpx,
  SURFACES, SURFACE_LABEL, WAYS, WAY_LABEL,
} from './routing.js';
import { createProfileChart } from './elevation.js';

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
  layer: 'radkarte',
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
    if (s.layer) state.layer = s.layer;
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

const LAYERS = {
  radkarte: { label: 'Radkarte', url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', sub: 'abc', max: 20,
    attr: '<a href="https://www.cyclosm.org">CyclOSM</a> | © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
  schlicht: { label: 'Schlicht', url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', sub: 'abcd', max: 20,
    darkUrl: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attr: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, © <a href="https://carto.com/attributions">CARTO</a>' },
  topo: { label: 'Topo', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', sub: 'abc', max: 17,
    attr: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM | <a href="https://opentopomap.org">OpenTopoMap</a>' },
  satellit: { label: 'Satellit', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', sub: '', max: 19,
    attr: 'Bilder © Esri, Maxar, Earthstar Geographics' },
};

let map, tileLayer, routeGroup, markerGroup, nogoGroup, hoverMarker, chart;
const dark = window.matchMedia('(prefers-color-scheme: dark)');

function setLayer(key) {
  if (!LAYERS[key]) key = 'radkarte';
  state.layer = key;
  const def = LAYERS[key];
  if (tileLayer) tileLayer.remove();
  tileLayer = L.tileLayer(dark.matches && def.darkUrl ? def.darkUrl : def.url, {
    subdomains: def.sub || 'abc', maxZoom: 20, maxNativeZoom: def.max, attribution: def.attr,
  }).addTo(map);
  for (const b of $('layerMenu').children) b.setAttribute('aria-checked', b.dataset.key === key ? 'true' : 'false');
  save();
}

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([state.view.lat, state.view.lon], state.view.zoom);
  map.attributionControl.setPrefix(false);
  L.control.zoom({ position: 'topright' }).addTo(map);
  nogoGroup = L.layerGroup().addTo(map);
  routeGroup = L.layerGroup().addTo(map);
  markerGroup = L.layerGroup().addTo(map);

  const menu = $('layerMenu');
  for (const key in LAYERS) {
    menu.append(h('button', { type: 'button', role: 'menuitemradio', 'data-key': key, text: LAYERS[key].label,
      onclick: () => { setLayer(key); toggleLayerMenu(false); } }));
  }
  $('btnLayers').addEventListener('click', () => toggleLayerMenu($('layerMenu').hidden));
  setLayer(state.layer);
  dark.addEventListener('change', () => setLayer(state.layer));

  map.on('moveend', () => {
    const c = map.getCenter();
    state.view = { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
    save();
  });
  map.on('click', onMapClick);
}

function toggleLayerMenu(open) {
  $('layerMenu').hidden = !open;
  $('btnLayers').setAttribute('aria-expanded', String(open));
}

// Freie Kartenfläche neben Seitenleiste, Ergebnisleiste oder Bottom-Sheet
function fitPadding() {
  if (isMobile()) return { paddingTopLeft: [30, 30], paddingBottomRight: [30, $('panel').offsetHeight + 20] };
  const dockH = $('dock').hidden ? 0 : $('dock').offsetHeight;
  return { paddingTopLeft: [40, 40], paddingBottomRight: [60, dockH + 40] };
}

function onMapClick(ev) {
  toggleLayerMenu(false);
  const { lat, lng } = ev.latlng;
  const filled = state.waypoints.filter((w) => w.lat != null).length;
  if (state.waypoints[0].lat == null) return setWaypoint(0, lat, lng, null);
  if (filled === 1 && state.waypoints[state.waypoints.length - 1].lat == null) return setWaypoint(state.waypoints.length - 1, lat, lng, null);

  const box = h('div', { class: 'map-menu' },
    h('button', { type: 'button', text: 'Als Start', onclick: () => { map.closePopup(); setWaypoint(0, lat, lng, null); } }),
    h('button', { type: 'button', text: 'Als Zwischenziel', onclick: () => { map.closePopup(); addVia(lat, lng); } }),
    h('button', { type: 'button', text: 'Als Ziel', onclick: () => { map.closePopup(); setWaypoint(state.waypoints.length - 1, lat, lng, null); } }),
    h('button', { type: 'button', class: 'danger', text: 'Hier sperren', onclick: () => { map.closePopup(); addNogo(lat, lng); } }));
  L.popup({ closeButton: false, className: 'menu-popup', offset: [0, -2] }).setLatLng(ev.latlng).setContent(box).openOn(map);
}

// ---------------------------------------------------------------- Wegpunkte

const wpName = (i) => (i === 0 ? 'Start' : i === state.waypoints.length - 1 ? 'Ziel' : 'Zwischenziel ' + i);
const wpBadge = (i) => (i === 0 ? 'A' : i === state.waypoints.length - 1 ? 'B' : String(i));

async function setWaypoint(index, lat, lon, label) {
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
  // Zwischenziel dort einfügen, wo es entlang der aktuellen Route liegt
  let at = state.waypoints.length - 1;
  if (route) {
    const k = nearestIndex(route, lat, lon);
    at = 1;
    for (let i = 1; i < state.waypoints.length - 1; i++) {
      const w = state.waypoints[i];
      if (w.lat != null && nearestIndex(route, w.lat, w.lon) <= k) at = i + 1;
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
    const input = h('input', { class: 'wp-input', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: wpName(i) + ' suchen oder auf Karte tippen', 'aria-label': wpName(i) });
    input.value = w.label;
    const drop = h('div', { class: 'ac', hidden: true });
    attachAutocomplete(input, drop, i);
    const set = w.lat != null;
    const li = h('li', { class: 'wp' + (i === 0 ? ' wp-start' : i === state.waypoints.length - 1 ? ' wp-end' : '') },
      h('span', { class: 'wp-badge', text: wpBadge(i), 'aria-hidden': 'true' }),
      h('div', { class: 'wp-field' }, input, drop),
      set ? h('button', { class: 'icon-btn' + (isFavorite(w) ? ' on' : ''), type: 'button',
        title: isFavorite(w) ? 'Favorit entfernen' : 'Als Favorit speichern', 'aria-label': 'Favorit', 'aria-pressed': String(isFavorite(w)),
        onclick: () => toggleFavorite(w) }, icon('star')) : null,
      (set || state.waypoints.length > 2) ? h('button', { class: 'icon-btn', type: 'button', title: 'Entfernen',
        'aria-label': wpName(i) + ' entfernen', onclick: () => removeWaypoint(i) }, icon('x')) : null);
    list.append(li);
  });
  const filled = state.waypoints.filter((w) => w.lat != null).length;
  $('mapHint').textContent = filled === 0 ? 'Tippe auf die Karte, um den Start zu setzen.'
    : filled === 1 ? 'Tippe auf die Karte, um das Ziel zu setzen.'
      : 'Tippe auf die Route, um ein Zwischenziel einzufügen. Punkte lassen sich verschieben.';
  $('btnLoop').disabled = state.waypoints[0].lat == null;
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
  markerGroup.clearLayers();
  state.waypoints.forEach((w, i) => {
    if (w.lat == null) return;
    const kind = i === 0 ? 'start' : i === state.waypoints.length - 1 ? 'end' : 'via';
    const m = L.marker([w.lat, w.lon], {
      draggable: true, autoPan: true, title: wpName(i), zIndexOffset: kind === 'via' ? 500 : 800,
      icon: L.divIcon({ className: '', html: `<div class="pin pin-${kind}">${wpBadge(i)}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
    });
    m.on('dragend', () => { const p = m.getLatLng(); setWaypoint(state.waypoints.indexOf(w), p.lat, p.lng, null); });
    m.on('click', () => {
      const box = h('div', { class: 'map-menu' },
        h('strong', { text: w.label }),
        h('button', { type: 'button', class: 'danger', text: 'Entfernen', onclick: () => { map.closePopup(); removeWaypoint(state.waypoints.indexOf(w)); } }));
      L.popup({ closeButton: false, className: 'menu-popup', offset: [0, -12] }).setLatLng(m.getLatLng()).setContent(box).openOn(map);
    });
    markerGroup.addLayer(m);
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
    if (index == null) { map.setView([latitude, longitude], Math.max(map.getZoom(), 14)); hideToast(); return; }
    hideToast();
    if (state.waypoints.filter((w) => w.lat != null).length === 0) map.setView([latitude, longitude], Math.max(map.getZoom(), 14));
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
  nogoGroup.clearLayers();
  const list = $('nogoList');
  list.replaceChildren();
  $('nogoBlock').hidden = state.nogos.length === 0;
  state.nogos.forEach((n, i) => {
    const circle = L.circle([n.lat, n.lon], { radius: n.radius, className: 'nogo-circle', interactive: false });
    const m = L.marker([n.lat, n.lon], { draggable: true, title: 'Sperrzone ' + (i + 1),
      icon: L.divIcon({ className: '', html: '<div class="pin pin-nogo"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }) });
    m.on('drag', () => circle.setLatLng(m.getLatLng()));
    m.on('dragend', () => { const p = m.getLatLng(); n.lat = p.lat; n.lon = p.lng; changed(); });
    nogoGroup.addLayer(circle).addLayer(m);

    const sel = h('select', { 'aria-label': 'Radius der Sperrzone ' + (i + 1),
      onchange: () => { n.radius = +sel.value; circle.setRadius(n.radius); changed(); } });
    for (const r of [50, 100, 200, 500, 1000, 2000]) sel.append(h('option', { value: r, text: r < 1000 ? r + ' m' : r / 1000 + ' km', selected: r === n.radius }));
    list.append(h('li', {},
      h('button', { type: 'button', class: 'nogo-name', text: 'Sperrzone ' + (i + 1), title: 'Auf der Karte zeigen', onclick: () => map.setView([n.lat, n.lon], Math.max(map.getZoom(), 14)) }),
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
  save();
  clearTimeout(routeTimer);
  routeTimer = setTimeout(calcRoute, 120);
}

async function calcRoute() {
  const pts = state.waypoints.filter((w) => w.lat != null);
  if (routeCtrl) routeCtrl.abort();
  const distinct = pts.some((p) => Math.abs(p.lat - pts[0].lat) > 1e-5 || Math.abs(p.lon - pts[0].lon) > 1e-5);
  if (pts.length < 2 || !distinct) { route = null; $('busy').hidden = true; showRoute(); return; }
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
  routeGroup.clearLayers();
  hoverMarker = null;
  const has = !!route;
  $('dock').hidden = !has;
  $('tourBlock').hidden = !has;
  document.body.classList.toggle('has-route', has);
  if (!has) { chart.setRoute(null); placeDock(); return; }

  const latlngs = [];
  for (let i = 0; i < route.n; i++) latlngs.push([route.lat[i], route.lon[i]]);
  L.polyline(latlngs, { className: 'route-casing', interactive: false }).addTo(routeGroup);
  const line = L.polyline(latlngs, { className: 'route-line' }).addTo(routeGroup);
  // breite unsichtbare Linie als Treffer-Fläche
  const hit = L.polyline(latlngs, { className: 'route-hit', weight: 22, opacity: 0 }).addTo(routeGroup);
  hit.on('click', (ev) => { L.DomEvent.stopPropagation(ev); addVia(ev.latlng.lat, ev.latlng.lng); });
  hit.on('mousemove', (ev) => { const i = nearestIndex(route, ev.latlng.lat, ev.latlng.lng); setHover(route.cum[i], { lat: route.lat[i], lon: route.lon[i] }); chart.setCursor(route.cum[i]); });
  hit.on('mouseout', () => { setHover(null); chart.setCursor(null); });

  $('stDist').innerHTML = `${fmt(route.dist / 1000, route.dist < 100000 ? 1 : 0)}<small> km</small>`;
  $('stUp').innerHTML = route.hasEle ? `${fmt(route.ascent)}<small> m</small>` : '–';
  $('stDown').innerHTML = route.hasEle ? `${fmt(route.descent)}<small> m</small>` : '–';
  $('stMax').innerHTML = route.hasEle ? `${fmt(route.maxEle)}<small> m</small>` : '–';
  renderTime();
  renderAlt();
  renderComposition();
  placeDock();
  chart.setRoute(route);

  if (!state.tourName) $('tourName').placeholder = defaultTourName();
  if (fitNext) {
    fitNext = false;
    const mobile = isMobile();
    if (mobile) setSheet('peek');
    // mobil erst nach dem Einfahren des Sheets einpassen
    setTimeout(() => { map.invalidateSize(); map.fitBounds(line.getBounds(), fitPadding()); }, mobile ? 260 : 0);
  }
}

function renderTime() {
  if (!route) return;
  $('stTime').innerHTML = formatTime(route.dist / 1000 / state.speeds[state.profile]).replace(' h', '<small> h</small>');
}

function setHover(d, p) {
  if (d == null || !p) { if (hoverMarker) { hoverMarker.remove(); hoverMarker = null; } return; }
  if (!hoverMarker) hoverMarker = L.circleMarker([p.lat, p.lon], { radius: 7, className: 'hover-dot', interactive: false }).addTo(routeGroup);
  else hoverMarker.setLatLng([p.lat, p.lon]);
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

// ---------------------------------------------------------------- Export

function defaultTourName() {
  const pts = state.waypoints.filter((w) => w.lat != null);
  if (pts.length < 2) return 'Tour';
  const short = (s) => s.split(',')[0];
  const a = short(pts[0].label), b = short(pts[pts.length - 1].label);
  const km = route ? ' ' + fmt(route.dist / 1000) + ' km' : '';
  return (a === b ? 'Runde ab ' + a : a + ' – ' + b) + km;
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
  requestAnimationFrame(() => map && map.invalidateSize());
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
    state.waypoints.splice(state.waypoints.length - 1, 0, emptyWp());
    renderWaypoints();
    const inputs = $('wpList').querySelectorAll('input');
    inputs[inputs.length - 2].focus();
  });
  $('btnLoop').addEventListener('click', () => {
    const s = state.waypoints[0], last = state.waypoints[state.waypoints.length - 1];
    if (s.lat == null) return;
    if (last.lat != null) state.waypoints.push(emptyWp());
    fitNext = true;
    setWaypoint(state.waypoints.length - 1, s.lat, s.lon, s.label);
    if (state.waypoints.filter((w) => w.lat != null).length < 3) toast('Setze jetzt ein Zwischenziel, damit eine Runde entsteht.');
  });
  $('btnReverse').addEventListener('click', () => { state.waypoints.reverse(); renderWaypoints(); changed(); });
  $('btnNew').addEventListener('click', () => {
    state.waypoints = [emptyWp(), emptyWp()];
    state.nogos = [];
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
    if (v >= 5 && v <= 60) { state.speeds[state.profile] = v; save(); renderTime(); } else $('speedInput').value = state.speeds[state.profile];
  });
  $('btnLocate').addEventListener('click', () => locate(null));
  $('btnGpx').addEventListener('click', downloadGpx);
  if (navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.gpx', { type: 'application/gpx+xml' })] })) {
    $('btnShare').hidden = false;
    $('btnShare').addEventListener('click', shareGpx);
  }
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') toggleLayerMenu(false); });

  if (state.waypoints.filter((w) => w.lat != null).length >= 2) calcRoute();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
