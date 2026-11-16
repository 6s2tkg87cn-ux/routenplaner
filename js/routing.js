// Routing über BRouter: Profile zusammenbauen, hochladen, Route abrufen und auswerten.

const BROUTER = 'https://brouter.de/brouter';

export const PROFILES = {
  rennrad: { label: 'Rennrad', file: 'profiles/rennrad.brf', speed: 27 },
  gravel: { label: 'Gravel', file: 'profiles/gravel.brf', speed: 20 },
  alltag: { label: 'Alltag', file: 'profiles/alltag.brf', speed: 17 },
  wandern: { label: 'Wandern', file: 'profiles/wandern.brf', speed: 4, foot: true },
};

export const DEFAULT_OPTIONS = {
  rennrad: { traffic: 1, elevation: 'balanced', forest: 0, river: 0, town: 0, noMain: false, ferries: true,
    cobble: true, strictPaved: false, cycleways: true },
  gravel: { traffic: 2, elevation: 'balanced', forest: 1, river: 0, town: 0, noMain: false, ferries: true,
    trails: false, preferUnpaved: true, wet: false, cycleRoutes: false },
  alltag: { traffic: 2, elevation: 'balanced', forest: 0, river: 0, town: 0, noMain: false, ferries: true,
    cycleRoutes: false },
  wandern: { sac: 2, elevation: 'balanced', forest: 0, river: 0, town: 0, ferries: true,
    hikingRoutes: true, paths: false, visibility: true, wet: false, ferrata: false },
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
  } else if (profile === 'wandern') {
    // Schwierigkeit nach SAC-Wanderskala: Grenze (härter ist gesperrt) und bevorzugter Grad
    const sac = Math.max(1, Math.min(5, o.sac | 0));
    v.SAC_scale_limit = [1, 2, 3, 4, 6][sac - 1];
    v.SAC_scale_preferred = [1, 1, 2, 3, 3][sac - 1];
    v.consider_elevation = o.elevation === 'flat';
    v.consider_forest = o.forest >= 1;
    v.consider_river = o.river >= 1;
    v.consider_town = o.town >= 1;
    v.iswet = o.wet ? 1 : 0;
    v.hiking_routes_preference = o.hikingRoutes ? 0.6 : 0.1;
    v.path_preference = o.paths ? 20 : 0;
    v.allow_ferries = !!o.ferries;
    v.kv_unknown = o.ferrata ? 1 : 0;
    v.kv_visibility = o.visibility ? 2 : 0;
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
      '&format=geojson&timode=2' + (nogoStr ? '&nogos=' + encodeURIComponent(nogoStr) : '');
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
  const SAC = { hiking: 1, 'T1-hiking': 1, yes: 1, mountain_hiking: 2, demanding_mountain_hiking: 3, alpine_hiking: 4, demanding_alpine_hiking: 5, difficult_alpine_hiking: 6 };
  return { surface, way, sac: SAC[t.sac_scale] || 0, unknown: hw === 'unknown' };
}

/** Fahr- oder Gehzeit in Stunden. Wandern nach DIN 33466: 300 hm/h bergauf, 500 hm/h bergab, dazu die Strecke. */
export function travelHours(route, profile, speed) {
  if (PROFILES[profile].foot) {
    const flat = route.dist / 1000 / speed, vert = route.ascent / 300 + route.descent / 500;
    return Math.max(flat, vert) + Math.min(flat, vert) / 2;
  }
  const key = profile + ':' + speed;
  if (route._time && route._time.key === key) return route._time.hours;
  const hours = rideHours(route, profile, speed);
  route._time = { key, hours };
  return hours;
}

// Fahrzeit mit dem Rad aus Steigung und Untergrund: Aus dem Tempo in der Ebene wird die Leistung bestimmt,
// die du dort trittst. Mit dieser Leistung wird für jedes Stück der Strecke das Tempo berechnet
// (Steigung, Rollwiderstand des Untergrunds, Luftwiderstand), bergab begrenzt durch Bremsen.
const BIKE = {
  rennrad: { cda: 0.32, crr: 0.005, vmax: 60, mass: 84 },
  gravel: { cda: 0.38, crr: 0.007, vmax: 48, mass: 86 },
  alltag: { cda: 0.5, crr: 0.008, vmax: 38, mass: 92 },
};
const ROLL = { asphalt: 1, pflaster: 1.8, schotter: 2.2, natur: 3.2, unbekannt: 1.6 };
const VCAP = { asphalt: 99, pflaster: 28, schotter: 32, natur: 22, unbekannt: 35 }; // km/h, was der Untergrund zulässt

function rideHours(route, profile, speedFlat) {
  const b = BIKE[profile] || BIKE.alltag, g = 9.81, rho = 1.2;
  const v0 = speedFlat / 3.6;
  const power = b.mass * g * b.crr * v0 + 0.5 * rho * b.cda * v0 ** 3; // Leistung am Hinterrad in der Ebene
  const step = Math.max(50, Math.min(150, route.dist / 400));
  let t = 0, si = 0;
  for (let d = 0; d < route.dist; d += step) {
    const d1 = Math.min(route.dist, d + step), len = d1 - d;
    if (len <= 0) break;
    const a = Math.max(0, d - 40), z = Math.min(route.dist, d1 + 40);
    const slope = route.hasEle ? (pointAt(route, z).ele - pointAt(route, a).ele) / (z - a) : 0;
    while (si < route.sections.length - 1 && route.sections[si].to < d + len / 2) si++;
    const surf = route.sections.length ? route.sections[si].surface : 'asphalt';
    const crr = b.crr * (ROLL[surf] || 1);
    // Tempo, bei dem die Leistung gerade reicht (Halbierungsverfahren)
    let lo = 0.8, hi = 30;
    for (let k = 0; k < 24; k++) {
      const v = (lo + hi) / 2;
      const need = b.mass * g * (slope + crr) * v + 0.5 * rho * b.cda * v ** 3;
      // bergauf tritt man erfahrungsgemäß etwas kräftiger als in der Ebene (bis etwa ein Viertel mehr)
      if (need > power * (1 + Math.max(0, Math.min(0.25, slope * 4)))) hi = v; else lo = v;
    }
    let v = (lo + hi) / 2;
    // bergab wird gebremst: je steiler und je loser der Untergrund, desto früher
    let cap = Math.min(b.vmax, VCAP[surf] || 99) / 3.6;
    if (slope < -0.06) cap *= Math.max(0.45, 1 + (slope + 0.06) * 5);
    v = Math.max(0.9, Math.min(v, cap)); // unter 3 km/h wird geschoben
    t += len / v;
  }
  return t / 3600;
}

/**
 * Anstiege der Strecke: zusammenhängende Steigungen, kurze Flachstücke und kleine Senken gehören dazu.
 * Liefert je Anstieg Anfang, Ende, Höhenmeter, Länge, Durchschnitts- und Maximalsteigung.
 */
export function findClimbs(route, foot = false) {
  if (!route.hasEle || route.dist < 500) return [];
  const step = 50, n = Math.floor(route.dist / step);
  const e = [];
  for (let i = 0; i <= n; i++) e.push(pointAt(route, i * step).ele);
  const minGain = foot ? 60 : 30, minAvg = foot ? 4 : 2.5, climbs = [];
  let start = 0, top = 0;
  const close = () => {
    // flachen Anlauf vor dem eigentlichen Anstieg abschneiden
    const tol = Math.max(3, (e[top] - e[start]) * 0.03);
    for (let i = top; i > start; i--) if (e[i] <= e[start] + tol) { start = i; break; }
    const gain = e[top] - e[start], len = (top - start) * step;
    if (len >= 300 && gain >= minGain && (gain / len) * 100 >= minAvg) {
      let max = 0;
      for (let i = start; i + 4 <= top; i++) max = Math.max(max, ((e[i + 4] - e[i]) / (4 * step)) * 100);
      climbs.push({ from: start * step, to: top * step, gain, len, avg: (gain / len) * 100, max: Math.max(max, (gain / len) * 100) });
    }
  };
  for (let i = 1; i <= n; i++) {
    if (e[i] > e[top]) top = i;
    const gain = e[top] - e[start], drop = e[top] - e[i];
    if (e[i] < e[start] && top === start) { start = i; top = i; continue; }
    // Der Anstieg endet, wenn es deutlich wieder hinuntergeht
    if (drop > Math.max(12, gain * 0.2)) { close(); start = i; top = i; }
  }
  close();
  return climbs;
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
        if (last && last.surface === c.surface && last.way === c.way && last.sac === c.sac && last.unknown === c.unknown) last.to = pos + d;
        else sections.push({ from: pos, to: pos + d, surface: c.surface, way: c.way, sac: c.sac, unknown: c.unknown });
        pos += d;
      }
      // auf die tatsächliche Streckenlänge skalieren
      if (pos > 0) { const k = dist / pos; for (const s of sections) { s.from *= k; s.to *= k; } }
    }
  }
  const surfaceShare = {}, wayShare = {}, sacShare = {};
  let unknownLen = 0;
  for (const s of sections) {
    sacShare[s.sac] = (sacShare[s.sac] || 0) + (s.to - s.from);
    if (s.unknown) unknownLen += s.to - s.from;
    surfaceShare[s.surface] = (surfaceShare[s.surface] || 0) + (s.to - s.from);
    wayShare[s.way] = (wayShare[s.way] || 0) + (s.to - s.from);
  }

  const base = { lat, lon, ele, cum, n, dist, ascent, descent, minEle, maxEle, hasEle, sections, surfaceShare, wayShare, sacShare, unknownLen };
  base.turns = findTurns(base, p.voicehints);
  return base;
}

function bearingAt(route, d0, d1) {
  const a = pointAt(route, Math.max(0, d0)), b = pointAt(route, Math.min(route.dist, d1));
  const r = Math.PI / 180, y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return Math.atan2(y, x) / r;
}
export const routeBearing = (route, d) => bearingAt(route, d, d + 25);

// Abbiegepunkte: bevorzugt die Hinweise des Routing-Servers (nur an echten Abzweigen),
// sonst aus der Form der Strecke geschätzt. Winkel: negativ = links, positiv = rechts.
function findTurns(route, hints) {
  const turns = [];
  if (Array.isArray(hints) && hints.length) {
    for (const h of hints) {
      const i = h[0], exit = h[2] || 0, angle = h[4] || 0;
      if (!(i >= 0 && i < route.n) || (Math.abs(angle) < 20 && !exit)) continue;
      turns.push({ d: route.cum[i], angle, exit: Math.abs(exit) });
    }
    return turns;
  }
  for (let i = 1; i < route.n - 1; i++) {
    const d = route.cum[i];
    if (d < 20 || d > route.dist - 20) continue;
    let ang = bearingAt(route, d + 3, d + 25) - bearingAt(route, d - 25, d - 3);
    ang = ((ang + 540) % 360) - 180;
    if (Math.abs(ang) < 55) continue;
    const last = turns[turns.length - 1];
    if (last && d - last.d < 40) { if (Math.abs(ang) > Math.abs(last.angle)) { last.d = d; last.angle = ang; } continue; }
    turns.push({ d, angle: ang, exit: 0, guessed: true });
  }
  return turns;
}

// Nächster Punkt auf der Strecke zu einer Position, gesucht zwischen zwei Distanzen. Liefert Abstand und Streckendistanz.
export function projectOnRoute(route, lat, lon, dFrom = 0, dTo = Infinity) {
  const i0 = pointAt(route, Math.max(0, dFrom)).i, i1 = Math.min(route.n - 2, pointAt(route, Math.min(route.dist, dTo)).i);
  const k = Math.cos(lat * Math.PI / 180) * 111320, M = 111320;
  let best = { dist: Infinity, d: 0, lat, lon };
  for (let i = i0; i <= i1; i++) {
    const ax = (route.lon[i] - lon) * k, ay = (route.lat[i] - lat) * M, bx = (route.lon[i + 1] - lon) * k, by = (route.lat[i + 1] - lat) * M;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    const dist = Math.hypot(ax + t * dx, ay + t * dy);
    if (dist < best.dist) best = { dist, d: route.cum[i] + t * (route.cum[i + 1] - route.cum[i]),
      lat: route.lat[i] + t * (route.lat[i + 1] - route.lat[i]), lon: route.lon[i] + t * (route.lon[i + 1] - route.lon[i]) };
  }
  return best;
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
    ' <trk><name>' + esc(name) + '</name><type>' + (plan && plan.profile === 'wandern' ? 'hiking' : 'cycling') + '</type><trkseg>'];
  for (let i = 0; i < route.n; i++) {
    out.push('  <trkpt lat="' + route.lat[i].toFixed(6) + '" lon="' + route.lon[i].toFixed(6) + '">' +
      (route.hasEle ? '<ele>' + route.ele[i].toFixed(1) + '</ele>' : '') + '</trkpt>');
  }
  out.push(' </trkseg></trk>', '</gpx>');
  return out.join('\n');
}
