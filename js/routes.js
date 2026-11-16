// Eingetragene Routen aus OpenStreetMap (Radfernwege, Wanderwege, …): suchen, laden, als Tour aufbereiten.
import { overpass } from './pois.js';
import { fetchRoute, mergeGeo, parseRoute, pointAt, projectOnRoute, haversine, RouteError } from './routing.js';
import { compassName } from './roundtrip.js';

// Welche Routenarten zu welchem Typ passen
const RANK = { icn: 0, iwn: 0, ncn: 1, nwn: 1, rcn: 2, rwn: 2, lcn: 3, lwn: 3 };
const LEVEL = { 0: 'International', 1: 'National', 2: 'Regional', 3: 'Lokal', 4: '' };
const KIND_LABEL = { bicycle: 'Radroute', mtb: 'MTB-Route', hiking: 'Wanderweg', foot: 'Wanderweg' };

export function routeLabel(r) {
  const lvl = LEVEL[r.rank];
  const km = r.km ? `, ${r.km.toLocaleString('de-DE', { maximumFractionDigits: 0 })} km` : r.lenKm ? `, etwa ${r.lenKm.toLocaleString('de-DE', { maximumFractionDigits: 0 })} km` : '';
  return (lvl ? lvl + 'e ' : '') + (KIND_LABEL[r.kind] || 'Route') + km;
}

// Wichtigkeit: erst die Einstufung (international vor lokal), dann die Länge im Kartenausschnitt (sobald bekannt),
// sonst die eingetragene Gesamtlänge, zuletzt der Name.
export function byImportance(a, c) {
  return a.rank - c.rank || (c.visKm ?? -1) - (a.visKm ?? -1) || (c.km || 0) - (a.km || 0) || a.name.localeCompare(c.name, 'de');
}

// Rundweg: ausdrücklich so eingetragen, oder der Name sagt es
const looksRound = (name) => /rund(weg|wanderweg|tour|kurs|e\b)|runde\b|\bloop\b/i.test(name || '');

/**
 * Routen im Kartenausschnitt [Süd, West, Nord, Ost]: Rad-, MTB- und Wanderrouten. Übergeordnete Routen werden mitgeliefert.
 * Von den Routen selbst kommen nur die Angaben (ohne Wegelisten), das hält die Antwort klein.
 */
export async function searchRoutes(bbox, signal) {
  const kinds = 'bicycle|mtb|hiking|foot';
  const b = bbox.map((v) => v.toFixed(4)).join(',');
  const q = (out) => `[out:json][timeout:25];rel[type=route][route~"^(${kinds})$"](${b})->.r;.r out ${out};rel(br.r)[type~"^(route|superroute)$"]->.p;.p out body;`;
  let json;
  try { json = await overpass(q('tags'), signal, 30000, 5, 2000); } catch (e) {
    if (e.name === 'AbortError') throw e;
    // zweiter Versuch mit der früheren, größeren Abfrage
    json = await overpass(q('body'), signal, 35000, 5, 2000);
  }
  const map = new Map();
  for (const e of json.elements || []) {
    if (e.type !== 'relation') continue;
    const t = e.tags || {};
    const item = map.get(e.id) || {
      id: e.id, name: t.name || t['name:de'] || t.ref || '', ref: t.ref || '', kind: t.route || '', rank: RANK[t.network] ?? 4,
      km: parseFloat(String(t.distance || '').replace(',', '.')) || 0, website: t.website || t.url || '', parents: [], children: [],
      round: t.roundtrip === 'yes' || (t.roundtrip !== 'no' && looksRound(t.name)),
    };
    if (e.members) for (const m of e.members) if (m.type === 'relation' && !item.children.includes(m.ref)) item.children.push(m.ref);
    map.set(e.id, item);
  }
  for (const it of map.values()) for (const c of it.children) { const ch = map.get(c); if (ch && !ch.parents.includes(it.id)) ch.parents.push(it.id); }
  return [...map.values()].filter((r) => r.name).sort(byImportance).slice(0, 200)
    .map((r) => ({ ...r, parentNames: r.parents.map((id) => map.get(id)).filter((x) => x && x.name).map((x) => x.name) }));
}

// Schnelle erste Liste von Waymarked Trails (fertig aufbereitete Routen aus OpenStreetMap). Liefert nur Name und
// Einstufung; die vollständige Liste kommt danach von Overpass. Fällt der Dienst aus, bleibt es bei Overpass.
const WMT = { bicycle: 'cycling', mtb: 'mtb', hiking: 'hiking' };
const WMT_RANK = { INT: 0, NAT: 1, REG: 2, LOC: 3 };
const mercator = (lat, lon) => [(lon * 20037508.34) / 180, (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * 20037508.34) / Math.PI];

export async function searchRoutesQuick(bbox, signal) {
  const box = [...mercator(bbox[0], bbox[1]), ...mercator(bbox[2], bbox[3])].map((v) => v.toFixed(0)).join(',');
  const ctrl = new AbortController(), stop = () => ctrl.abort(), timer = setTimeout(stop, 6000);
  if (signal) signal.addEventListener('abort', stop);
  try {
    const res = await Promise.allSettled(Object.entries(WMT).map(async ([kind, host]) => {
      const r = await fetch(`https://${host}.waymarkedtrails.org/api/v1/list/by_area?bbox=${box}&limit=40`, { signal: ctrl.signal });
      if (!r.ok) throw new Error('Status ' + r.status);
      return ((await r.json()).results || []).filter((e) => e.type === 'relation' && (e.name || e.ref)).map((e) => ({
        id: e.id, name: e.name || e.ref, ref: e.ref || '', kind, rank: WMT_RANK[e.group] ?? 4, km: 0, website: '', parents: [], children: [], parentNames: [],
        round: looksRound(e.name), quick: true }));
    }));
    if (signal && signal.aborted) { const e = new Error('abgebrochen'); e.name = 'AbortError'; throw e; }
    const ok = res.filter((x) => x.status === 'fulfilled');
    if (!ok.length) throw new Error('Schnelle Liste nicht erreichbar');
    const seen = new Set();
    return ok.flatMap((x) => x.value).filter((r) => !seen.has(r.id) && seen.add(r.id)).sort(byImportance);
  } finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', stop); }
}

// ---------------------------------------------------------------- Strecke aus den Wegstücken

const SKIP_ROLES = /^(alternative|excursion|approach|connection|link|platform|stop|guidepost)$/;
const trackCache = new Map(), trackDone = new Map();

// Geladene Strecken bleiben auf dem Gerät (Cache des Browsers), damit dieselbe Route beim nächsten Mal sofort da ist.
const STORE = 'rw-tracks', STORE_INDEX = 'rueckenwind.tracks', STORE_DAYS = 30, STORE_MAX = 15;
const storeUrl = (id) => location.origin + '/__track/' + id;
const SLIM = ['highway', 'surface', 'tracktype', 'sac_scale', 'bicycle', 'smoothness'];
const slim = (t) => { const o = {}; for (const k of SLIM) if (t && t[k]) o[k] = t[k]; return o; };

function reviveTrack(j) {
  const n = j.lat.length, lat = Float64Array.from(j.lat), lon = Float64Array.from(j.lon), cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + haversine(lat[i - 1], lon[i - 1], lat[i], lon[i]);
  return { lat, lon, cum, n, dist: cum[n - 1], ele: new Float64Array(n), segWay: Int32Array.from(j.segWay), wayTags: j.wayTags, gaps: j.gaps || [],
    closed: !!j.closed, id: j.id, name: j.name, website: j.website || '' };
}
async function readStored(id) {
  try {
    if (typeof caches === 'undefined') return null;
    const res = await (await caches.open(STORE)).match(storeUrl(id));
    if (!res) return null;
    const j = await res.json();
    if (j.v !== 1 || Date.now() - j.at > STORE_DAYS * 864e5 || !Array.isArray(j.lat) || j.lat.length < 2) return null;
    return reviveTrack(j);
  } catch (e) { return null; }
}
async function writeStored(t) {
  try {
    if (typeof caches === 'undefined') return;
    const r6 = (v) => Math.round(v * 1e6) / 1e6;
    const body = JSON.stringify({ v: 1, at: Date.now(), id: t.id, name: t.name, website: t.website, closed: t.closed, gaps: t.gaps,
      lat: Array.from(t.lat, r6), lon: Array.from(t.lon, r6), segWay: Array.from(t.segWay), wayTags: t.wayTags });
    const cache = await caches.open(STORE);
    await cache.put(storeUrl(t.id), new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    let index = [];
    try { index = JSON.parse(localStorage.getItem(STORE_INDEX) || '[]'); } catch (e) { /* neu anfangen */ }
    index = [t.id, ...index.filter((x) => x !== t.id)];
    for (const old of index.slice(STORE_MAX)) cache.delete(storeUrl(old));
    localStorage.setItem(STORE_INDEX, JSON.stringify(index.slice(0, STORE_MAX)));
  } catch (e) { /* Speicher voll oder gesperrt: dann eben ohne */ }
}

/** Lädt eine Route (auch mit Unterrouten) und setzt die Wegstücke zu einer durchgehenden Strecke zusammen. */
export async function loadRouteTrack(id, signal) {
  if (trackCache.has(id)) return trackCache.get(id);
  const q = `[out:json][timeout:90];rel(${id})->.t;rel(r.t)->.c1;rel(r.c1)->.c2;(.t;.c1;.c2;)->.all;.all out body;way(r.all);out geom tags;`;
  const job = (async () => {
    const stored = await readStored(id);
    if (stored) return stored;
    const json = await overpass(q, signal, 95000, 5, 4000);
    const rels = new Map(), ways = new Map();
    for (const e of json.elements || []) {
      if (e.type === 'relation') rels.set(e.id, e);
      else if (e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length > 1) ways.set(e.id, e);
    }
    const top = rels.get(id);
    if (!top) throw new RouteError('Diese Route wurde nicht gefunden.');
    const list = [], seen = new Set([id]);
    const walk = (rel, depth) => {
      for (const m of rel.members || []) {
        if (SKIP_ROLES.test(m.role || '')) continue;
        if (m.type === 'way' && ways.has(m.ref)) list.push(ways.get(m.ref));
        else if (m.type === 'relation' && rels.has(m.ref) && depth < 3 && !seen.has(m.ref)) { seen.add(m.ref); walk(rels.get(m.ref), depth + 1); }
      }
    };
    walk(top, 0);
    if (!list.length) throw new RouteError('Für diese Route sind keine Wege eingetragen.');
    const t = top.tags || {}, chain = chainWays(list);
    const track = { ...chain, wayTags: chain.wayTags.map(slim), id, name: t.name || t['name:de'] || t.ref || 'Route', website: t.website || t.url || '' };
    writeStored(track);
    return track;
  })();
  trackCache.set(id, job);
  job.then((t) => trackDone.set(id, t), () => trackCache.delete(id));
  return job;
}

// ---------------------------------------------------------------- Schnelle Vorschau

const prevCache = new Map(), prefetched = new Map();

function linesOf(ways) {
  const lines = [];
  let len = 0;
  for (const w of ways) {
    let cur = [];
    for (const g of w.geometry || []) {
      if (g && Number.isFinite(g.lat)) {
        if (cur.length) { const q = cur[cur.length - 1]; len += haversine(q[1], q[0], g.lat, g.lon); }
        cur.push([g.lon, g.lat]);
      } else { if (cur.length > 1) lines.push(cur); cur = []; }
    }
    if (cur.length > 1) lines.push(cur);
  }
  const fc = { type: 'FeatureCollection', features: lines.length ? [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } }] : [] };
  return { fc, km: len / 1000 };
}

/**
 * Vorschau für alle Routen einer Liste auf einmal laden (nur die Wegstücke im Kartenausschnitt).
 * Liefert je Route die Länge im Ausschnitt; die Linien liegen danach für die Vorschau bereit.
 */
export async function prefetchPreviews(ids, bbox, signal) {
  if (!ids.length) return new Map();
  const b = bbox.map((v) => v.toFixed(3)).join(',');
  const q = `[out:json][timeout:25];rel(id:${ids.join(',')})->.t;rel(r.t)->.c;rel(r.c)->.c2;(.t;.c;.c2;)->.a;.a out body;way(r.a)(${b});out geom qt;`;
  const json = await overpass(q, signal, 35000, 5, 3000);
  const rels = new Map(), ways = new Map();
  for (const e of json.elements || []) { if (e.type === 'relation') rels.set(e.id, e); else if (e.type === 'way') ways.set(e.id, e); }
  const out = new Map();
  for (const id of ids) {
    const found = [], seen = new Set([id]);
    const walk = (rel, depth) => {
      for (const m of rel.members || []) {
        if (m.type === 'way' && ways.has(m.ref)) found.push(ways.get(m.ref));
        else if (m.type === 'relation' && rels.has(m.ref) && depth < 3 && !seen.has(m.ref)) { seen.add(m.ref); walk(rels.get(m.ref), depth + 1); }
      }
    };
    if (rels.has(id)) walk(rels.get(id), 0);
    const { fc, km } = linesOf(found);
    prefetched.set(id, fc);
    out.set(id, km);
  }
  return out;
}

/** Liegt für diese Route schon eine Vorschau vor (auch eine leere)? */
export const hasPreview = (id) => prefetched.has(id);

/**
 * Längen der Routen in km, vom Server aus den Wegstücken summiert. Grobe Angabe: in beiden Richtungen
 * getrennt eingetragene Strecken zählen doppelt, Routen nur aus Unterrouten liefern nichts.
 */
export async function fetchRouteLengths(ids, signal) {
  if (!ids.length) return new Map();
  const json = await overpass(`[out:json][timeout:25];rel(id:${ids.join(',')});convert rel ::id=id(),len=length();out;`, signal, 30000, 5, 3000);
  const out = new Map();
  for (const e of json.elements || []) { const v = parseFloat(e.tags && e.tags.len); if (v > 0) out.set(e.id, v / 1000); }
  return out;
}

/** Bereits vorliegende Vorschau (aus der Liste), ohne neue Abfrage. */
export const cachedPreview = (id) => (prefetched.has(id) && prefetched.get(id).features.length ? prefetched.get(id) : null);

/**
 * Grobe Vorschau einer Route für den Kartenausschnitt. Reihenfolge: schon ganz geladene Strecke,
 * vorab geladene Vorschau der Liste, sonst eine eigene schnelle Abfrage nur für diese Route.
 */
export async function previewRoute(id, bbox, signal) {
  const done = trackDone.get(id);
  if (done) {
    const step = Math.max(1, Math.floor(done.n / 3000)), coordinates = [];
    for (let i = 0; i < done.n; i += step) coordinates.push([done.lon[i], done.lat[i]]);
    coordinates.push([done.lon[done.n - 1], done.lat[done.n - 1]]);
    return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }] };
  }
  if (prefetched.has(id) && prefetched.get(id).features.length) return prefetched.get(id);
  const b = bbox.map((v) => v.toFixed(3)).join(',');
  const key = id + '|' + b;
  if (!prevCache.has(key)) {
    const q = `[out:json][timeout:15];rel(${id})->.t;rel(r.t)->.c;rel(r.c)->.c2;(.t;.c;.c2;)->.a;way(r.a)(${b});out geom qt;`;
    const job = overpass(q, signal, 20000, 5, 2000).then((json) => linesOf((json.elements || []).filter((e) => e.type === 'way')).fc);
    prevCache.set(key, job);
    job.catch(() => prevCache.delete(key));
  }
  return prevCache.get(key);
}

const hav = (a, b) => haversine(a.lat, a.lon, b.lat, b.lon);

// Wegstücke in Reihenfolge verketten. Verbunden sind Wege, die sich einen Punkt teilen.
// Varianten (zweiter Ast einer geteilten Führung), die zurück zu bereits befahrenen Stellen führen, fallen weg.
// Lücken in den Daten werden als gerade Verbindung markiert (segWay = -1) und später mit dem Router überbrückt.
export function chainWays(ways) {
  const key = (p) => p.lat.toFixed(7) + ',' + p.lon.toFixed(7);
  const items = ways.map((w, order) => ({ order, g: w.geometry, tags: w.tags || {}, a: key(w.geometry[0]), b: key(w.geometry[w.geometry.length - 1]) }));
  const ends = new Map();
  const add = (k, i) => { if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); };
  items.forEach((it, i) => { add(it.a, i); add(it.b, i); });
  const used = new Uint8Array(items.length), visited = new Set();
  const pts = [], segWay = [], wayTags = [], gaps = [];
  let lastOrder = 0;
  const branches = []; // Stellen, an denen mehrere Wege weitergingen (Index in pts)
  const append = (i, reversed) => {
    used[i] = 1;
    const g = reversed ? [...items[i].g].reverse() : items[i].g;
    const wi = wayTags.push(items[i].tags) - 1;
    for (let k = pts.length ? 1 : 0; k < g.length; k++) {
      if (pts.length) segWay.push(wi);
      pts.push({ lat: g[k].lat, lon: g[k].lon });
      visited.add(key(g[k]));
    }
    lastOrder = items[i].order;
  };
  const others = (k, i) => (ends.get(k) || []).some((j) => j !== i);
  append(0, !others(items[0].b, 0) && others(items[0].a, 0));
  for (;;) {
    const E = pts[pts.length - 1], kE = key(E), startKey = key(pts[0]);
    const cands = (ends.get(kE) || []).filter((i) => !used[i]);
    if (cands.length) {
      const far = (i) => (items[i].a === kE ? items[i].b : items[i].a);
      const back = (i) => visited.has(far(i)) && far(i) !== startKey;
      cands.sort((x, y) => (back(x) - back(y)) || Math.abs(items[x].order - lastOrder - 1) - Math.abs(items[y].order - lastOrder - 1));
      const i = cands[0];
      if (back(i)) { used[i] = 1; continue; } // führt nur zurück: zweiter Ast einer geteilten Führung
      if (cands.length > 1) branches.push(pts.length - 1);
      append(i, items[i].b === kE);
      continue;
    }
    // Lücke: nächster freier Weg in der Reihenfolge, sonst der räumlich nächste
    let next = -1, near = -1, nearD = Infinity;
    for (let i = 0; i < items.length; i++) {
      if (used[i]) continue;
      // beide Enden schon befahren: Variante einer bereits verketteten Führung
      if (visited.has(items[i].a) && visited.has(items[i].b)) { used[i] = 1; continue; }
      if (next < 0 && items[i].order > lastOrder) next = i;
      const d = Math.min(hav(E, items[i].g[0]), hav(E, items[i].g[items[i].g.length - 1]));
      if (d < nearD) { nearD = d; near = i; }
    }
    if (near < 0) break;
    let i = next;
    const dist = (j) => Math.min(hav(E, items[j].g[0]), hav(E, items[j].g[items[j].g.length - 1]));
    if (i < 0 || dist(i) > 3 * nearD + 500) i = near;
    const da = hav(E, items[i].g[0]), db = hav(E, items[i].g[items[i].g.length - 1]);
    const gap = Math.min(da, db);
    if (gap > 25000) break; // getrenntes Teilstück: Strecke endet hier
    const rev = db < da;
    const N = rev ? items[i].g[items[i].g.length - 1] : items[i].g[0];
    // Der nächste Weg setzt an einer früheren Abzweigung an: Das Stück seitdem war eine Sackgasse (Abstecher) und fällt weg
    const bi = branches.findLastIndex((b) => b < pts.length - 1 && hav(pts[b], N) < 30);
    if (bi >= 0) {
      const b = branches[bi];
      branches.length = bi;
      pts.length = b + 1;
      segWay.length = b;
      append(i, rev);
      continue;
    }
    if (gap > 1) { segWay.push(-1); pts.push({ lat: N.lat, lon: N.lon }); if (gap > 30) gaps.push(gap); }
    append(i, rev);
  }
  const n = pts.length, lat = new Float64Array(n), lon = new Float64Array(n), cum = new Float64Array(n);
  for (let i = 0; i < n; i++) { lat[i] = pts[i].lat; lon[i] = pts[i].lon; if (i) cum[i] = cum[i - 1] + hav(pts[i - 1], pts[i]); }
  // Rundweg: Ende liegt wieder am Anfang
  const closed = n > 2 && hav(pts[0], pts[n - 1]) < 500 && cum[n - 1] > 2000;
  return { lat, lon, cum, n, dist: cum[n - 1], ele: new Float64Array(n), segWay: Int32Array.from(segWay), wayTags, gaps, closed };
}

/**
 * Punkte und Wegzuordnung eines Abschnitts. Ist to < from, wird der Abschnitt in Gegenrichtung gefahren.
 * Bei Rundwegen darf der Abschnitt über Anfang oder Ende der Eintragung hinweglaufen (to > Länge oder to < 0).
 */
export function sliceTrack(track, from, to) {
  const D = track.dist;
  if (track.closed && (to > D + 1 || to < -1)) {
    const fwd = to > from;
    const a = fwd ? sliceTrack(track, from, D) : sliceTrack(track, from, 0);
    const b = fwd ? sliceTrack(track, 0, Math.min(D, to - D)) : sliceTrack(track, D, Math.max(0, D + to));
    const join = hav(a.pts[a.pts.length - 1], b.pts[0]) > 30;
    return { pts: [...a.pts, ...(join ? b.pts : b.pts.slice(1))], segs: [...a.segs, ...(join ? [-1] : []), ...b.segs] };
  }
  const a = Math.max(0, Math.min(from, to)), b = Math.min(track.dist, Math.max(from, to));
  const pa = pointAt(track, a), pb = pointAt(track, b), last = track.segWay.length - 1;
  const pts = [{ lat: pa.lat, lon: pa.lon }], segs = [];
  for (let i = pa.i + 1; i <= pb.i; i++) { segs.push(track.segWay[Math.min(i - 1, last)]); pts.push({ lat: track.lat[i], lon: track.lon[i] }); }
  segs.push(track.segWay[Math.min(pb.i, last)]);
  pts.push({ lat: pb.lat, lon: pb.lon });
  if (to < from) { pts.reverse(); segs.reverse(); }
  return { pts, segs };
}

// ---------------------------------------------------------------- Höhen

// Höhen aus Geländemodell-Kacheln (Terrarium-Format, frei verfügbar, ohne Abfragegrenze): Die Höhe steckt
// in den Farbwerten jedes Pixels. Zoomstufe 12 entspricht in Mitteleuropa rund 25 m je Pixel.
const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const demCache = new Map();

function demTile(z, x, y, signal) {
  const key = z + '/' + x + '/' + y;
  if (!demCache.has(key)) {
    const job = (async () => {
      const res = await fetch(DEM.replace('{z}', z).replace('{x}', x).replace('{y}', y), { signal });
      if (!res.ok) throw new Error('Geländemodell ' + res.status);
      const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      return g.getImageData(0, 0, 256, 256).data;
    })();
    demCache.set(key, job);
    job.catch(() => demCache.delete(key));
    if (demCache.size > 400) demCache.delete(demCache.keys().next().value);
  }
  return demCache.get(key);
}

async function elevationsDem(samples, signal) {
  const world = (p, z) => {
    const n = 256 * 2 ** z, r = (p.lat * Math.PI) / 180;
    return [((p.lon + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n];
  };
  // Zoomstufe so wählen, dass höchstens 80 Kacheln nötig sind
  let z = 12, need;
  for (; z >= 8; z--) {
    need = new Set();
    for (const p of samples) { const [fx, fy] = world(p, z); need.add(Math.floor(fx / 256) + '/' + Math.floor(fy / 256)); }
    if (need.size <= 80) break;
  }
  const tiles = new Map(), list = [...need];
  let next = 0;
  const worker = async () => { while (next < list.length) { const k = list[next++], [x, y] = k.split('/').map(Number); tiles.set(k, await demTile(z, x, y, signal)); } };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  const px = (X, Y) => {
    const tx = Math.floor(X / 256), ty = Math.floor(Y / 256), d = tiles.get(tx + '/' + ty);
    if (!d) return NaN;
    const i = ((Y - ty * 256) * 256 + (X - tx * 256)) * 4;
    return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768;
  };
  return samples.map((p) => {
    // bilinear zwischen den vier umliegenden Pixeln
    const [fx, fy] = world(p, z), X = Math.floor(fx - 0.5), Y = Math.floor(fy - 0.5), u = fx - 0.5 - X, v = fy - 0.5 - Y;
    const a = px(X, Y), b = px(X + 1, Y), c = px(X, Y + 1), d = px(X + 1, Y + 1);
    const e = a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
    return Number.isFinite(e) ? e : [a, b, c, d].find(Number.isFinite);
  });
}

// Ersatz, falls das Geländemodell nicht erreichbar ist: Open-Meteo, mit wenigen Punkten (jeder Punkt zählt dort als eigene Abfrage)
async function elevationsMeteo(samples, signal) {
  const step = Math.max(1, Math.ceil(samples.length / 300)), pick = samples.filter((_, i) => i % step === 0 || i === samples.length - 1);
  const vals = [];
  for (let k = 0; k < pick.length; k += 100) {
    const part = pick.slice(k, k + 100);
    const url = 'https://api.open-meteo.com/v1/elevation?latitude=' + part.map((p) => p.lat.toFixed(5)).join(',') + '&longitude=' + part.map((p) => p.lon.toFixed(5)).join(',');
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error('Höhendienst ' + res.status);
    const ele = (await res.json()).elevation;
    if (!Array.isArray(ele) || ele.length !== part.length) throw new Error('Höhendienst: unvollständige Antwort');
    vals.push(...ele);
  }
  return samples.map((_, i) => { const j = Math.min(vals.length - 1, i / step), j0 = Math.floor(j), t = j - j0; return vals[j0] + ((vals[j0 + 1] ?? vals[j0]) - vals[j0]) * t; });
}

/** Höhen für eine Punktfolge: Punkte etwa alle 30 m (bei langen Strecken weiter), auf alle Punkte übertragen. */
async function elevationsFor(pts, signal) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hav(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1], step = Math.max(30, total / 4000);
  const samples = [];
  for (let d = 0, i = 0; d <= total + step; d += step) {
    const dd = Math.min(d, total);
    while (i < pts.length - 2 && cum[i + 1] < dd) i++;
    const t = cum[i + 1] > cum[i] ? Math.min(1, (dd - cum[i]) / (cum[i + 1] - cum[i])) : 0;
    samples.push({ d: dd, lat: pts[i].lat + (pts[i + 1].lat - pts[i].lat) * t, lon: pts[i].lon + (pts[i + 1].lon - pts[i].lon) * t });
    if (dd >= total) break;
  }
  let vals;
  try { vals = await elevationsDem(samples, signal); } catch (e) {
    if (e.name === 'AbortError') throw e;
    vals = await elevationsMeteo(samples, signal);
  }
  return cum.map((d) => {
    const i = Math.min(samples.length - 2, Math.max(0, Math.floor(d / step)));
    const t = Math.min(1, Math.max(0, (d - samples[i].d) / ((samples[i + 1].d - samples[i].d) || 1)));
    return vals[i] + (vals[i + 1] - vals[i]) * t;
  });
}

// ---------------------------------------------------------------- Als Tour aufbereiten

const tagString = (t) => ['highway', 'surface', 'tracktype', 'sac_scale', 'bicycle', 'smoothness'].filter((k) => t && t[k]).map((k) => k + '=' + t[k]).join(' ');
const HEAD = ['Longitude', 'Latitude', 'Elevation', 'Distance', 'CostPerKm', 'ElevCost', 'TurnCost', 'NodeCost', 'InitialCost', 'WayTags', 'NodeTags', 'Time', 'Energy'];

function bearing(a, b) {
  const r = Math.PI / 180, y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return Math.atan2(y, x) / r;
}

// Ein Stück der eingetragenen Strecke im Antwortformat des Routers, damit es sich wie eine berechnete Etappe weiterverarbeiten lässt.
// Abbiegehinweise entstehen dort, wo ein Weg auf einen anderen wechselt und die Richtung deutlich ändert.
function synthetic(pts, segs, ele, i0, i1, wayTags) {
  const coords = [], msgs = [HEAD], hints = [];
  for (let k = i0; k <= i1; k++) coords.push([pts[k].lon, pts[k].lat, ele ? Math.round(ele[k] * 10) / 10 : undefined]);
  let run = null;
  for (let k = i0; k < i1; k++) {
    const len = hav(pts[k], pts[k + 1]), w = segs[k];
    if (run && run.w === w) run.d += len;
    else { if (run) msgs.push(['', '', '', String(Math.round(run.d)), '', '', '', '', '', run.tags, '', '', '']); run = { w, d: len, tags: w >= 0 ? tagString(wayTags[w]) : '' }; }
    if (k > i0 && segs[k - 1] !== w) {
      let a = k, z = k;
      while (a > i0 && hav(pts[a], pts[k]) < 25) a--;
      while (z < i1 && hav(pts[k], pts[z]) < 25) z++;
      if (a < k && z > k) {
        const ang = ((bearing(pts[k], pts[z]) - bearing(pts[a], pts[k]) + 540) % 360) - 180;
        if (Math.abs(ang) >= 40) hints.push([k - i0, 0, 0, 0, Math.round(ang), '']);
      }
    }
  }
  if (run) msgs.push(['', '', '', String(Math.round(run.d)), '', '', '', '', '', run.tags, '', '', '']);
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { messages: msgs, voicehints: hints }, geometry: { type: 'LineString', coordinates: coords } }] };
}

/**
 * Baut eine Tour aus einem Abschnitt der Route: optional Anfahrt vom Start, der Abschnitt selbst
 * (Lücken mit dem Router überbrückt) und optional der Rückweg zum Start, möglichst nicht auf dem Abschnitt.
 */
export async function buildRouteTour({ track, from, to, start, back, profile, options, nogos = [], signal }) {
  if (Math.abs(to - from) < 200) throw new RouteError('Der Abschnitt ist zu kurz. Wähle Anfang und Ende weiter auseinander.');
  // Ganzer Rundweg mit eigenem Start: dort einsteigen, wo die Route dem Start am nächsten ist, einmal herum
  // und am selben Punkt wieder aussteigen. Der Rückweg ist dann einfach der kürzeste Weg nach Hause.
  let entry = null;
  if (track.closed && start && Math.abs(to - from) > track.dist - 50) {
    const P = projectOnRoute(track, start.lat, start.lon).d, dir = to >= from ? 1 : -1;
    from = P; to = P + dir * track.dist; entry = P;
  }
  const { pts, segs } = sliceTrack(track, from, to);
  const secStart = pts[0], secEnd = pts[pts.length - 1];
  const leg = (points, extra = []) => fetchRoute({ profile, options, signal, points, nogos: [...nogos, ...extra], raw: true });
  // Höhen (bei Ausfall des Dienstes ohne Höhen weiter)
  const eleJob = elevationsFor(pts, signal).catch((e) => { if (e.name === 'AbortError') throw e; return null; });
  // Anfahrt
  const useStart = start && hav(start, secStart) > 150;
  const approachJob = useStart ? leg([start, secStart]) : null;
  // Lücken
  const runs = [];
  let r0 = 0, bridged = 0;
  for (let k = 0; k < segs.length; k++) {
    if (segs[k] === -1 && hav(pts[k], pts[k + 1]) > 30) {
      if (k > r0) runs.push({ i0: r0, i1: k });
      runs.push({ gap: k, job: leg([pts[k], pts[k + 1]]).catch((e) => { if (e.name === 'AbortError') throw e; return null; }) });
      bridged++;
      r0 = k + 1;
    }
  }
  if (segs.length > r0) runs.push({ i0: r0, i1: segs.length });
  // Rückweg: Abschnitt sperren, damit er nicht noch einmal gefahren wird
  let backJob = null;
  if (back && entry != null) {
    if (hav(secEnd, start) > 150) backJob = leg([secEnd, start]);
  } else if (back) {
    const target = useStart ? start : secStart;
    const blocks = [], total = Math.abs(to - from), spacing = Math.max(200, total / 110);
    const wrap = (d) => (track.closed ? ((d % track.dist) + track.dist) % track.dist : d);
    for (let d = Math.min(from, to) + 500; d < Math.max(from, to) - 500; d += spacing) { const p = pointAt(track, wrap(d)); blocks.push({ lat: p.lat, lon: p.lon, radius: 35 }); }
    if (hav(secEnd, target) > 150) backJob = leg([secEnd, target], blocks).catch((e) => { if (e.name === 'AbortError' || !blocks.length) throw e; return leg([secEnd, target]); });
  }
  const ele = await eleJob;
  const parts = [];
  if (approachJob) parts.push(await approachJob);
  for (const r of runs) {
    if (r.job) {
      const g = await r.job;
      parts.push(g || synthetic(pts, segs, ele, r.gap, r.gap + 1, track.wayTags));
    } else parts.push(synthetic(pts, segs, ele, r.i0, r.i1, track.wayTags));
  }
  if (backJob) parts.push(await backJob);
  const route = parseRoute(mergeGeo(parts));
  route.eleMissing = !ele;
  route.bridged = bridged;
  route.secLen = Math.abs(to - from);
  route.entry = entry;
  return route;
}

/**
 * Runden mit Wunschlänge, die ein Stück der Route fahren: Anfahrt zum nächsten Punkt der Route,
 * ein Abschnitt in die eine oder andere Richtung, Rückweg zum Start. Die Abschnittslänge wird so gewählt,
 * dass die ganze Runde passt.
 */
export async function suggestRouteLoops({ track, start, km, profile, options, nogos, signal, onProgress }) {
  const L = km * 1000, P = projectOnRoute(track, start.lat, start.lon).d;
  const wrap = (d) => (track.closed ? ((d % track.dist) + track.dist) % track.dist : d);
  const airTo = (d) => { const q = pointAt(track, wrap(d)); return haversine(start.lat, start.lon, q.lat, q.lon); };
  const approach = 1.3 * airTo(P);
  if (approach > L * 0.6) throw new RouteError('Die Route liegt für diese Länge zu weit vom Start entfernt. Wähle eine größere Länge oder einen Start näher an der Route.');
  const build = (from, to) => buildRouteTour({ track, from, to, start, back: true, profile, options, nogos, signal });
  let done = 0;
  const jobs = [1, -1].map(async (dir) => {
    const xmax = track.closed ? track.dist - 500 : dir > 0 ? track.dist - P : P;
    if (xmax < 2000) return null;
    const est = (x) => approach + x + 1.3 * airTo(P + dir * x);
    const pick = (fac) => {
      let best = null;
      for (let x = 1000; x <= xmax; x += Math.max(250, xmax / 400)) { const e = Math.abs(est(x) * fac - L); if (!best || e < best.e) best = { x, e }; }
      return best.x;
    };
    let x = pick(1), r = await build(P, P + dir * x);
    if (Math.abs(r.dist / L - 1) > 0.07) {
      const x2 = pick(r.dist / est(x));
      if (Math.abs(x2 - x) > 200) {
        try { const r2 = await build(P, P + dir * x2); if (Math.abs(r2.dist / L - 1) < Math.abs(r.dist / L - 1)) { r = r2; x = x2; } } catch (e) { if (e.name === 'AbortError') throw e; }
      }
    }
    done++;
    if (onProgress) onProgress(done, 2);
    const a = pointAt(track, P), z = pointAt(track, wrap(P + dir * Math.min(x, 3000)));
    return { from: P, to: P + dir * x, route: r, name: 'Auf der Route Richtung ' + compassName(bearing(a, z)) };
  });
  const res = (await Promise.allSettled(jobs)).filter((s) => s.status === 'fulfilled' && s.value).map((s) => s.value);
  if (signal && signal.aborted) { const e = new Error('abgebrochen'); e.name = 'AbortError'; throw e; }
  if (!res.length) {
    const fail = (await Promise.allSettled(jobs)).find((s) => s.status === 'rejected');
    throw fail && fail.reason instanceof RouteError ? fail.reason : new RouteError('Mit dieser Route wurde keine passende Runde gefunden.');
  }
  return res.sort((a, b) => Math.abs(a.route.dist / L - 1) - Math.abs(b.route.dist / L - 1));
}
