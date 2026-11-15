// Höhenprofil: Fläche nach Steigung eingefärbt, Untergrund als Band darunter, Fadenkreuz mit Tooltip.
import { pointAt, sectionAt, SURFACE_LABEL, WAY_LABEL } from './routing.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs) => {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};

// Steigungsklassen in Prozent: flach/bergab, 3–6, 6–9, 9–12, über 12
export function slopeClass(pct) {
  if (pct < 3) return 0;
  if (pct < 6) return 1;
  if (pct < 9) return 2;
  if (pct < 12) return 3;
  return 4;
}

function niceStep(range, target) {
  const raw = range / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

const fmt = (v, digits = 0) => v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function createProfileChart(host, { onHover }) {
  host.classList.add('chart');
  const svg = el('svg', { role: 'img', 'aria-label': 'Höhenprofil der Route' });
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  host.append(svg, tip);

  let route = null, geom = null;

  function draw() {
    svg.replaceChildren();
    geom = null;
    const W = host.clientWidth, H = host.clientHeight;
    if (!route || W < 80 || H < 60) return;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const m = { l: 40, r: 10, t: 8, b: 30 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;

    // Wertebereich: mindestens 80 m, damit flache Touren nicht alpin aussehen
    let lo = route.minEle, hi = route.maxEle;
    const pad = Math.max(8, (hi - lo) * 0.08);
    lo -= pad; hi += pad;
    if (hi - lo < 80) { const mid = (hi + lo) / 2; lo = mid - 40; hi = mid + 40; }
    const yStep = niceStep(hi - lo, 3);
    lo = Math.floor(lo / yStep) * yStep;
    const x = (d) => m.l + (d / route.dist) * pw;
    const y = (e) => m.t + ph - ((e - lo) / (hi - lo)) * ph;

    // Raster und Achsenbeschriftung
    const grid = el('g', { class: 'chart-grid' });
    for (let v = lo; v <= hi; v += yStep) {
      if (y(v) < m.t - 1) break;
      grid.append(el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
      const t = el('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' });
      t.textContent = fmt(v);
      grid.append(t);
    }
    const km = route.dist / 1000;
    const xStep = niceStep(km, Math.max(3, Math.min(9, Math.floor(pw / 70))));
    for (let v = 0; v <= km + 1e-6; v += xStep) {
      const t = el('text', { x: x(v * 1000), y: H - 4, 'text-anchor': v === 0 ? 'start' : 'middle' });
      t.textContent = v === 0 ? '0 km' : fmt(v, xStep < 1 ? 1 : 0);
      grid.append(t);
    }
    svg.append(grid);

    // Fläche in Streifen, je Steigungsklasse ein Pfad
    const bins = Math.max(20, Math.min(420, Math.floor(pw / 2)));
    const step = route.dist / bins;
    const win = Math.max(step, 150);
    const paths = ['', '', '', '', ''];
    let line = '';
    const base = m.t + ph;
    let prevE = pointAt(route, 0).ele;
    line = `M${x(0).toFixed(1)},${y(prevE).toFixed(1)}`;
    for (let i = 0; i < bins; i++) {
      const d0 = i * step, d1 = d0 + step, mid = (d0 + d1) / 2;
      const e1 = pointAt(route, d1).ele;
      const a = Math.max(0, mid - win / 2), b = Math.min(route.dist, mid + win / 2);
      const slope = b > a ? ((pointAt(route, b).ele - pointAt(route, a).ele) / (b - a)) * 100 : 0;
      const c = slopeClass(slope);
      // 0,3 px Überlappung verhindert Haarlinien zwischen den Streifen
      paths[c] += `M${x(d0).toFixed(1)},${base}L${x(d0).toFixed(1)},${y(prevE).toFixed(1)}L${(x(d1) + 0.3).toFixed(1)},${y(e1).toFixed(1)}L${(x(d1) + 0.3).toFixed(1)},${base}Z`;
      line += `L${x(d1).toFixed(1)},${y(e1).toFixed(1)}`;
      prevE = e1;
    }
    paths.forEach((d, c) => { if (d) svg.append(el('path', { d, class: 'slope slope-' + c })); });
    svg.append(el('path', { d: line, class: 'chart-line' }));
    svg.append(el('line', { x1: m.l, x2: W - m.r, y1: base, y2: base, class: 'chart-base' }));

    // Untergrund als Band unter dem Profil
    const band = el('g', {});
    for (const s of route.sections) {
      const w = x(s.to) - x(s.from);
      if (w < 0.4) continue;
      band.append(el('rect', { x: x(s.from).toFixed(1), y: base + 3, width: w.toFixed(1), height: 5, class: 'surf surf-' + s.surface }));
    }
    svg.append(band);

    // Fadenkreuz
    const cross = el('g', { class: 'chart-cross', visibility: 'hidden' });
    const cl = el('line', { y1: m.t, y2: base });
    const cd = el('circle', { r: 4.5 });
    cross.append(cl, cd);
    svg.append(cross);
    geom = { m, pw, ph, W, H, x, y, cross, cl, cd, win };
  }

  function showAt(d, fromChart) {
    if (!route || !geom) return;
    if (d == null) { geom.cross.setAttribute('visibility', 'hidden'); tip.hidden = true; return; }
    d = Math.max(0, Math.min(route.dist, d));
    const p = pointAt(route, d);
    const px = geom.x(d), py = geom.y(p.ele);
    geom.cl.setAttribute('x1', px); geom.cl.setAttribute('x2', px);
    geom.cd.setAttribute('cx', px); geom.cd.setAttribute('cy', py);
    geom.cross.setAttribute('visibility', 'visible');
    const a = Math.max(0, d - geom.win / 2), b = Math.min(route.dist, d + geom.win / 2);
    const slope = b > a ? ((pointAt(route, b).ele - pointAt(route, a).ele) / (b - a)) * 100 : 0;
    const s = sectionAt(route, d);
    tip.innerHTML = `<strong>${fmt(d / 1000, 1)} km</strong><span>${fmt(p.ele)} m Höhe</span>` +
      `<span>${slope >= 0 ? 'Steigung' : 'Gefälle'} ${fmt(Math.abs(slope), 1)} %</span>` +
      (s ? `<span>${SURFACE_LABEL[s.surface]}, ${WAY_LABEL[s.way]}</span>` : '');
    tip.hidden = false;
    const tw = tip.offsetWidth;
    let left = px + 12;
    if (left + tw > geom.W - 4) left = px - tw - 12;
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = geom.m.t + 'px';
    if (fromChart) onHover(d, p);
  }

  function fromEvent(ev) {
    if (!geom) return null;
    const r = svg.getBoundingClientRect();
    const px = ev.clientX - r.left;
    return ((px - geom.m.l) / geom.pw) * route.dist;
  }
  svg.addEventListener('pointermove', (ev) => { const d = fromEvent(ev); if (d != null) showAt(d, true); });
  svg.addEventListener('pointerdown', (ev) => { const d = fromEvent(ev); if (d != null) showAt(d, true); });
  svg.addEventListener('pointerleave', () => { showAt(null); onHover(null); });

  new ResizeObserver(() => draw()).observe(host);

  return {
    setRoute(r) { route = r; tip.hidden = true; draw(); },
    setCursor(d) { showAt(d, false); },
  };
}
