// Routing über BRouter: Profile zusammenbauen, hochladen, Route abrufen und auswerten.

const BROUTER = 'https://brouter.de/brouter';

export const PROFILES = {
  rennrad: { label: 'Rennrad', file: 'profiles/rennrad.brf', speed: 27 },
  gravel: { label: 'Gravel', file: 'profiles/gravel.brf', speed: 20 },
  alltag: { label: 'Alltag', file: 'profiles/alltag.brf', speed: 17 },
};

export const DEFAULT_OPTIONS = {
  rennrad: { traffic: 1, elevation: 'balanced', forest: 0, river: 0, town: 0, noMain: false, ferries: true,
    cobble: true, strictPaved: false, cycleways: true },
  gravel: { traffic: 2, elevation: 'balanced', forest: 1, river: 0, town: 0, noMain: false, ferries: true,
    trails: false, preferUnpaved: true, wet: false, cycleRoutes: false },
  alltag: { traffic: 2, elevation: 'balanced', forest: 0, river: 0, town: 0, noMain: false, ferries: true,
    cycleRoutes: false },
};

const templates = {};

async function loadTemplate(profile) {
  if (!templates[profile]) {
    const res = await fetch(PROFILES[profile].file);
    if (!res.ok) throw new RouteError('Das Routing-Profil konnte nicht geladen werden. Bitte Seite neu laden.');
    templates[profile] = await res.text();
  }
  return templates[profile];
}

// Setzt in einem Profiltext die erste Zuweisung "assign NAME [=] WERT" auf einen neuen Wert.
function setVar(text, name, value) {
  const re = new RegExp('^(assign\\s+' + name + '\\s*=?\\s*)(\\S+)', 'm');
  if (!re.test(text)) throw new Error('Profilvariable fehlt: ' + name);
  return text.replace(re, (m, head) => head + value);
}

// Übersetzt die Optionen der App in die Variablen des jeweiligen BRouter-Profils.
export function profileVars(profile, o) {
  const pick = (arr, i) => arr[Math.max(0, Math.min(arr.length - 1, i | 0))];
  const v = {};
  if (profile === 'rennrad') {
    v.consider_traffic = pick([0, 1, 2, 3.5], o.traffic);
    v.kv_noise = pick([0, 0, 0.5, 1], o.traffic);
    v.kv_forest = pick([0, 0.6, 1.5], o.forest);
    v.kv_river = pick([0, 0.5, 1.2], o.river);
    v.kv_town = pick([0, 0.7, 1.5], o.town);
    v.kv_nomain = o.noMain ? 8 : 0;
    v.kv_cobble = o.cobble ? 3 : 0.3;
    v.kv_unpaved = o.strictPaved ? 40 : 0;
    v.kv_cycleway = o.cycleways ? 1.05 : 1.5;
    v.allow_steps = false;
    v.allow_ferries = !!o.ferries;
    Object.assign(v, elevationVars(o.elevation));
  } else if (profile === 'alltag') {
    v.kv_traffic = pick([0, 1, 2, 3.5], o.traffic);
    v.kv_noise = pick([0, 0, 0.5, 1], o.traffic);
    v.avoid_unsafe = o.traffic >= 3;
    v.kv_forest = pick([0, 0.6, 1.5], o.forest);
    v.kv_river = pick([0, 0.5, 1.2], o.river);
    v.kv_town = pick([0, 0.7, 1.5], o.town);
    v.kv_nomain = o.noMain ? 8 : 0;
    v.stick_to_cycleroutes = !!o.cycleRoutes;
    v.allow_steps = false;
    v.allow_ferries = !!o.ferries;
    Object.assign(v, elevationVars(o.elevation));
  } else {
    v.kv_traffic = pick([0, 1, 1.6, 2.5], o.traffic);
    v.kv_noise = pick([0, 0, 0.5, 1], o.traffic);
    v.kv_forest = pick([0, 0.5, 1], o.forest);
    v.kv_river = pick([0, 0.5, 1], o.river);
    v.kv_town = pick([0, 0.5, 1], o.town);
    v.kv_nomain = o.noMain ? 4 : 1;
    v.kv_path = o.trails ? 0.45 : 1.5;
    v.prefer_unpaved_paths = !!o.preferUnpaved;
    v.assume_wet_conditions = !!o.wet;
    v.prefer_cycle_routes = !!o.cycleRoutes;
    v.consider_elevation = o.elevation === 'flat';
    v.avoid_steep_inclines = o.elevation === 'nosteep';
  }
  return v;
}

function elevationVars(mode) {
  if (mode === 'flat') return { uphillcost: 80, uphillcutoff: 1.5, downhillcost: 80, downhillcutoff: 1.5 };
  if (mode === 'nosteep') return { uphillcost: 150, uphillcutoff: 7, downhillcost: 100, downhillcutoff: 8 };
  return { uphillcost: 0, uphillcutoff: 1.5, downhillcost: 60, downhillcutoff: 1.5 };
}

export async function buildProfileText(profile, options) {
  let text = await loadTemplate(profile);
  const vars = profileVars(profile, options);
  for (const [k, val] of Object.entries(vars)) text = setVar(text, k, String(val));
  return text;
}

export class RouteError extends Error {}

// Hochgeladene Profile: Profiltext -> ID auf dem BRouter-Server (dort nur begrenzt haltbar).
const uploaded = new Map();

async function uploadProfile(text, signal) {
  if (uploaded.has(text)) return uploaded.get(text);
  let res;
  try {
    res = await fetch(BROUTER + '/profile', { method: 'POST', body: text, signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new RouteError('Der Routing-Server ist nicht erreichbar. Prüfe deine Internetverbindung.');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* unten behandelt */ }
  if (!res.ok || !data || !data.profileid || data.error) {
    throw new RouteError('Der Routing-Server hat das Profil abgelehnt' + (data && data.error ? ': ' + data.error : '.'));
  }
  uploaded.set(text, data.profileid);
  return data.profileid;
}

function translateError(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('not mapped') || m.includes('datafile')) {
    if (m.includes('from-position') || m.includes('wp=0')) return 'Am Startpunkt gibt es keinen befahrbaren Weg in der Nähe. Setze ihn näher an eine Straße.';
    if (m.includes('to-position')) return 'Am Ziel gibt es keinen befahrbaren Weg in der Nähe. Setze es näher an eine Straße.';
    return 'Ein Punkt liegt zu weit von befahrbaren Wegen entfernt oder außerhalb der Kartendaten.';
  }
  if (m.includes('island')) return 'Ein Punkt liegt auf einem Wegstück, das mit diesem Profil nicht erreichbar ist. Verschiebe ihn ein Stück.';
  if (m.includes('no track found') || m.includes('target not found')) return 'Zwischen diesen Punkten wurde keine Route gefunden. Lockere die Optionen oder entferne Sperrzonen.';
  if (m.includes('watchdog') || m.includes('timeout') || m.includes('killed')) return 'Die Berechnung hat zu lange gedauert. Setze Zwischenziele, um lange Strecken aufzuteilen.';
  if (m.includes('busy') || m.includes('overload')) return 'Der Routing-Server ist gerade ausgelastet. Versuche es gleich noch einmal.';
  return 'Die Route konnte nicht berechnet werden' + (msg ? ' (' + msg.trim().slice(0, 140) + ')' : '') + '.';
}

/**
 * Berechnet eine Route.
 * points: [{lat, lon}], nogos: [{lat, lon, radius}], alt: 0..3
 */
export async function fetchRoute({ profile, options, points, nogos = [], alt = 0, signal }) {
  const text = await buildProfileText(profile, options);
  const lonlats = points.map((p) => p.lon.toFixed(6) + ',' + p.lat.toFixed(6)).join('|');
  const nogoStr = nogos.map((n) => n.lon.toFixed(6) + ',' + n.lat.toFixed(6) + ',' + Math.round(n.radius)).join('|');

  for (let attempt = 0; attempt < 2; attempt++) {
    const id = await uploadProfile(text, signal);
    const url = BROUTER + '?lonlats=' + encodeURIComponent(lonlats) + '&profile=' + id + '&alternativeidx=' + alt +
      '&format=geojson' + (nogoStr ? '&nogos=' + encodeURIComponent(nogoStr) : '');
    let res;
    try {
      res = await fetch(url, { signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new RouteError('Der Routing-Server ist nicht erreichbar. Prüfe deine Internetverbindung.');
    }
    if (res.ok) {
      let json;
      try { json = await res.json(); } catch (e) { throw new RouteError('Der Routing-Server hat eine unlesbare Antwort geschickt.'); }
      return parseRoute(json);
    }
    const body = await res.text().catch(() => '');
    // Profil auf dem Server abgelaufen: einmal neu hochladen.
    if (attempt === 0 && (res.status >= 500 || res.status === 404 || /profile/i.test(body))) {
      uploaded.delete(text);
      continue;
    }
    throw new RouteError(translateError(body));
  }
  throw new RouteError('Die Route konnte nicht berechnet werden.');
}

// ---------------------------------------------------------------- Auswertung

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export const SURFACES = ['asphalt', 'schotter', 'natur', 'pflaster', 'unbekannt'];
export const SURFACE_LABEL = { asphalt: 'Asphalt', schotter: 'Schotter', natur: 'Naturboden', pflaster: 'Pflaster', unbekannt: 'Unbekannt' };
export const WAYS = ['hauptstrasse', 'nebenstrasse', 'radweg', 'wirtschaftsweg', 'pfad'];
export const WAY_LABEL = { hauptstrasse: 'Hauptstraße', nebenstrasse: 'Nebenstraße', radweg: 'Radweg', wirtschaftsweg: 'Wirtschaftsweg', pfad: 'Pfad' };

export function classifyTags(tagStr) {
  const t = {};
  for (const part of (tagStr || '').split(' ')) {
    const i = part.indexOf('=');
    if (i > 0) t[part.slice(0, i)] = part.slice(i + 1);
  }
  const hw = t.highway || '', s = t.surface || '', tt = t.tracktype || '';
  let surface;
  if (/^(asphalt|paved|concrete|paving_stones|metal|wood)/.test(s)) surface = 'asphalt';
  else if (/^(sett|cobblestone|unhewn_cobblestone)/.test(s)) surface = 'pflaster';
  else if (/^(fine_gravel|compacted|gravel|unpaved|pebblestone|grass_paver)/.test(s)) surface = 'schotter';
  else if (s) surface = 'natur';
  else if (hw === 'track') surface = tt === 'grade1' ? 'asphalt' : (tt === 'grade2' || tt === 'grade3') ? 'schotter' : tt ? 'natur' : 'unbekannt';
  else if (hw === 'path' || hw === 'bridleway') surface = 'natur';
  else if (hw === 'footway' || hw === 'steps' || hw === 'pedestrian' || hw === '') surface = 'unbekannt';
  else surface = 'asphalt';

  let way;
  if (/^(trunk|primary|secondary)/.test(hw)) way = 'hauptstrasse';
  else if (hw === 'cycleway' || ((hw === 'path' || hw === 'footway') && t.bicycle === 'designated')) way = 'radweg';
  else if (hw === 'track') way = 'wirtschaftsweg';
  else if (/^(path|footway|steps|bridleway|pedestrian)$/.test(hw)) way = 'pfad';
  else way = 'nebenstrasse';
  return { surface, way };
}

export function parseRoute(geojson) {
  const f = geojson && geojson.features && geojson.features[0];
  if (!f || !f.geometry || !f.geometry.coordinates || f.geometry.coordinates.length < 2) {
    throw new RouteError('Der Routing-Server hat keine Strecke geliefert.');
  }
  const coords = f.geometry.coordinates;
  const n = coords.length;
  const lat = new Float64Array(n), lon = new Float64Array(n), ele = new Float64Array(n), cum = new Float64Array(n);
  let lastEle = NaN;
  for (let i = 0; i < n; i++) {
    lon[i] = coords[i][0]; lat[i] = coords[i][1];
    const e = coords[i][2];
    ele[i] = Number.isFinite(e) ? e : NaN;
    if (i > 0) cum[i] = cum[i - 1] + haversine(lat[i - 1], lon[i - 1], lat[i], lon[i]);
  }
  // Lücken in den Höhendaten schließen
  for (let i = 0; i < n; i++) { if (Number.isNaN(ele[i])) ele[i] = lastEle; else lastEle = ele[i]; }
  for (let i = n - 1, next = NaN; i >= 0; i--) { if (Number.isNaN(ele[i])) ele[i] = next; else next = ele[i]; }
  const hasEle = !Number.isNaN(ele[0]);
  if (!hasEle) ele.fill(0);

  const dist = cum[n - 1];
  const p = f.properties || {};

  // Anstieg mit Schwelle, damit Höhenrauschen nicht mitzählt
  let ascent = 0, descent = 0, ref = ele[0], minEle = ele[0], maxEle = ele[0];
  const TH = 4;
  for (let i = 1; i < n; i++) {
    const d = ele[i] - ref;
    if (d > TH) { ascent += d; ref = ele[i]; } else if (d < -TH) { descent -= d; ref = ele[i]; }
    if (ele[i] < minEle) minEle = ele[i];
    if (ele[i] > maxEle) maxEle = ele[i];
  }
  const filtered = parseFloat(p['filtered ascend']);
  if (Number.isFinite(filtered) && filtered >= 0) {
    ascent = filtered;
    descent = Math.max(0, ascent - (ele[n - 1] - ele[0]));
  }

  // Abschnitte nach Untergrund und Wegtyp aus den Streckendaten
  const sections = [];
  const msgs = p.messages;
  if (Array.isArray(msgs) && msgs.length > 1) {
    const head = msgs[0];
    const iDist = head.indexOf('Distance'), iTags = head.indexOf('WayTags');
    if (iDist >= 0 && iTags >= 0) {
      let pos = 0;
      for (let k = 1; k < msgs.length; k++) {
        const d = parseFloat(msgs[k][iDist]) || 0;
        if (d <= 0) continue;
        const c = classifyTags(msgs[k][iTags]);
        const last = sections[sections.length - 1];
        if (last && last.surface === c.surface && last.way === c.way) last.to = pos + d;
        else sections.push({ from: pos, to: pos + d, surface: c.surface, way: c.way });
        pos += d;
      }
      // auf die tatsächliche Streckenlänge skalieren
      if (pos > 0) { const k = dist / pos; for (const s of sections) { s.from *= k; s.to *= k; } }
    }
  }
  const surfaceShare = {}, wayShare = {};
  for (const s of sections) {
    surfaceShare[s.surface] = (surfaceShare[s.surface] || 0) + (s.to - s.from);
    wayShare[s.way] = (wayShare[s.way] || 0) + (s.to - s.from);
  }

  return { lat, lon, ele, cum, n, dist, ascent, descent, minEle, maxEle, hasEle, sections, surfaceShare, wayShare };
}

// Index des Streckenpunkts, der einer Position am nächsten liegt.
export function nearestIndex(route, lat, lon) {
  let best = 0, bestD = Infinity;
  const k = Math.cos(lat * Math.PI / 180);
  for (let i = 0; i < route.n; i++) {
    const dx = (route.lon[i] - lon) * k, dy = route.lat[i] - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Position (lat, lon, ele) bei einer Distanz entlang der Strecke.
export function pointAt(route, d) {
  const { cum, n } = route;
  if (d <= 0) return { i: 0, lat: route.lat[0], lon: route.lon[0], ele: route.ele[0] };
  if (d >= cum[n - 1]) return { i: n - 1, lat: route.lat[n - 1], lon: route.lon[n - 1], ele: route.ele[n - 1] };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
  const span = cum[hi] - cum[lo] || 1, t = (d - cum[lo]) / span;
  return {
    i: lo,
    lat: route.lat[lo] + (route.lat[hi] - route.lat[lo]) * t,
    lon: route.lon[lo] + (route.lon[hi] - route.lon[lo]) * t,
    ele: route.ele[lo] + (route.ele[hi] - route.ele[lo]) * t,
  };
}

export function sectionAt(route, d) {
  for (const s of route.sections) if (d >= s.from && d <= s.to) return s;
  return null;
}

const PLAN_TAG = 'rueckenwind-plan:';

/** Liest eine GPX-Datei: eingebetteter Plan dieser App (falls vorhanden), Name und Streckenpunkte. */
export function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new RouteError('Die Datei ist keine lesbare GPX-Datei.');
  let plan = null;
  const desc = doc.querySelector('metadata > desc');
  if (desc && desc.textContent.startsWith(PLAN_TAG)) { try { plan = JSON.parse(desc.textContent.slice(PLAN_TAG.length)); } catch (e) { plan = null; } }
  const nameEl = doc.querySelector('metadata > name, trk > name, rte > name');
  let nodes = doc.querySelectorAll('trkpt');
  if (!nodes.length) nodes = doc.querySelectorAll('rtept');
  const points = [];
  for (const n of nodes) {
    const lat = parseFloat(n.getAttribute('lat')), lon = parseFloat(n.getAttribute('lon'));
    if (Number.isFinite(lat) && Number.isFinite(lon)) points.push({ lat, lon });
  }
  if (!plan && points.length < 2) throw new RouteError('Die GPX-Datei enthält keine Strecke.');
  return { plan, points, name: nameEl ? nameEl.textContent.trim() : '' };
}

// Reduziert eine Punktfolge auf höchstens maxN Stützpunkte (Douglas-Peucker mit wachsender Toleranz).
export function simplifyTrack(points, maxN) {
  const k = Math.cos(points[0].lat * Math.PI / 180);
  const dist = (p, a, b) => {
    const ax = a.lon * k, ay = a.lat, bx = b.lon * k, by = b.lat, px = p.lon * k, py = p.lat;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  };
  const run = (tol) => {
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let best = -1, bd = tol;
      for (let i = a + 1; i < b; i++) { const d = dist(points[i], points[a], points[b]); if (d > bd) { bd = d; best = i; } }
      if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
    }
    return points.filter((_, i) => keep[i]);
  };
  // Bei geschlossenen Runden zusätzlich den fernsten Punkt halten, sonst fällt alles auf den Start zusammen
  let tol = 0.002, out = run(tol);
  while (out.length > maxN && tol < 1) { tol *= 1.5; out = run(tol); }
  if (out.length < 3) {
    let far = 0, fd = 0;
    points.forEach((p, i) => { const d = Math.hypot((p.lon - points[0].lon) * k, p.lat - points[0].lat); if (d > fd) { fd = d; far = i; } });
    if (fd > 0.002) out = [points[0], points[Math.floor(far / 2)], points[far], points[Math.floor((far + points.length - 1) / 2)], points[points.length - 1]];
  }
  return out;
}

export function toGpx(route, name, plan) {
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Rueckenwind Routenplaner" xmlns="http://www.topografix.com/GPX/1/1">',
    ' <metadata><name>' + esc(name) + '</name>' + (plan ? '<desc>' + esc(PLAN_TAG + JSON.stringify(plan)) + '</desc>' : '') +
      '<time>' + new Date().toISOString() + '</time></metadata>',
    ' <trk><name>' + esc(name) + '</name><type>cycling</type><trkseg>'];
  for (let i = 0; i < route.n; i++) {
    out.push('  <trkpt lat="' + route.lat[i].toFixed(6) + '" lon="' + route.lon[i].toFixed(6) + '">' +
      (route.hasEle ? '<ele>' + route.ele[i].toFixed(1) + '</ele>' : '') + '</trkpt>');
  }
  out.push(' </trkseg></trk>', '</gpx>');
  return out.join('\n');
}
