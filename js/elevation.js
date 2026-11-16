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

export function createProfileChart(host, { onHover, onSelect, onArm }) {
  host.classList.add('chart');
  const svg = el('svg', { role: 'img', 'aria-label': 'Höhenprofil der Route' });
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  host.append(svg, tip);

  let armed = false; // Bereichsauswahl nur, wenn sie vorher eingeschaltet wurde: Streichen bewegt sonst nur das Fadenkreuz
  let route = null, geom = null, wind = null, sel = null, drag = null, view = null; // view: gezoomter Ausschnitt [von, bis] in Metern

  function draw() {
    svg.replaceChildren();
    geom = null;
    const W = host.clientWidth, H = host.clientHeight;
    if (!route || W < 80 || H < 60) return;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const m = { l: 40, r: 10, t: 8, b: wind ? 38 : 30 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;

    // Wertebereich: mindestens 80 m, damit flache Touren nicht alpin aussehen
    // Sichtbarer Ausschnitt: ganze Route oder der gewählte Bereich
    const v0 = view ? view[0] : 0, v1 = view ? view[1] : route.dist, span = Math.max(1, v1 - v0);
    let lo = route.minEle, hi = route.maxEle;
    if (view) {
      lo = Infinity; hi = -Infinity;
      for (let i = 0; i <= 80; i++) { const e = pointAt(route, v0 + (span * i) / 80).ele; if (e < lo) lo = e; if (e > hi) hi = e; }
    }
    const pad = Math.max(8, (hi - lo) * 0.08);
    lo -= pad; hi += pad;
    const minRange = view ? 30 : 80;
    if (hi - lo < minRange) { const mid = (hi + lo) / 2; lo = mid - minRange / 2; hi = mid + minRange / 2; }
    const yStep = niceStep(hi - lo, 3);
    lo = Math.floor(lo / yStep) * yStep;
    const x = (d) => m.l + ((d - v0) / span) * pw;
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
    const km0 = v0 / 1000, km1 = v1 / 1000;
    const xStep = niceStep(km1 - km0, Math.max(3, Math.min(9, Math.floor(pw / 70))));
    const digits = xStep < 0.1 ? 2 : xStep < 1 ? 1 : 0;
    let first = true;
    for (let v = Math.ceil(km0 / xStep - 1e-9) * xStep; v <= km1 + 1e-6; v += xStep) {
      if (Math.abs(v) < 1e-9) v = 0;
      const px = x(v * 1000);
      const t = el('text', { x: px, y: H - 4, 'text-anchor': px < m.l + 12 ? 'start' : 'middle' });
      t.textContent = fmt(v, digits) + (first ? ' km' : '');
      first = false;
      grid.append(t);
    }
    svg.append(grid);

    // Fläche in Streifen, je Steigungsklasse ein Pfad
    const bins = Math.max(20, Math.min(420, Math.floor(pw / 2)));
    const step = span / bins;
    const win = Math.max(step, view ? 60 : 150);
    const paths = ['', '', '', '', ''];
    let line = '';
    const base = m.t + ph;
    let prevE = pointAt(route, v0).ele;
    line = `M${x(v0).toFixed(1)},${y(prevE).toFixed(1)}`;
    for (let i = 0; i < bins; i++) {
      const d0 = v0 + i * step, d1 = d0 + step, mid = (d0 + d1) / 2;
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
      const a = Math.max(s.from, v0), b = Math.min(s.to, v1), w = x(b) - x(a);
      if (b <= a || w < 0.4) continue;
      band.append(el('rect', { x: x(a).toFixed(1), y: base + 3, width: w.toFixed(1), height: 5, class: 'surf surf-' + s.surface }));
    }
    svg.append(band);

    // Wind als zweites Band: Gegenwind, Seitenwind, Rückenwind
    if (wind) {
      const wb = el('g', {});
      for (const b of wind) {
        const a = Math.max(b.from, v0), z = Math.min(b.to, v1), w = x(z) - x(a);
        if (z <= a || w < 0.4) continue;
        wb.append(el('rect', { x: x(a).toFixed(1), y: base + 11, width: w.toFixed(1), height: 5, class: 'wind wind-' + b.cls }));
      }
      svg.append(wb);
    }

    // Ausgewählter Bereich
    const selRect = el('rect', { class: 'chart-sel', y: m.t, height: ph, visibility: 'hidden' });
    svg.append(selRect);

    // Fadenkreuz
    const cross = el('g', { class: 'chart-cross', visibility: 'hidden' });
    const cl = el('line', { y1: m.t, y2: base });
    const cd = el('circle', { r: 4.5 });
    cross.append(cl, cd);
    svg.append(cross);
    geom = { m, pw, ph, W, H, x, y, cross, cl, cd, win, selRect, v0, v1, span };
  }

  function paintSel(range) {
    if (!geom) return;
    if (!range) { geom.selRect.setAttribute('visibility', 'hidden'); return; }
    const a = geom.x(Math.min(range[0], range[1])), b = geom.x(Math.max(range[0], range[1]));
    geom.selRect.setAttribute('x', a);
    geom.selRect.setAttribute('width', Math.max(1, b - a));
    geom.selRect.setAttribute('visibility', 'visible');
  }

  function showAt(d, fromChart) {
    if (!route || !geom) return;
    if (d == null || (!fromChart && (d < geom.v0 || d > geom.v1))) { geom.cross.setAttribute('visibility', 'hidden'); tip.hidden = true; return; }
    d = Math.max(geom.v0, Math.min(geom.v1, d));
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
      (s ? `<span>${SURFACE_LABEL[s.surface]}, ${WAY_LABEL[s.way]}</span>` : '') + windLine(d);
    tip.hidden = false;
    const tw = tip.offsetWidth;
    let left = px + 12;
    if (left + tw > geom.W - 4) left = px - tw - 12;
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = geom.m.t + 'px';
    if (fromChart) onHover(d, p);
  }

  function windLine(d) {
    if (!wind) return '';
    const b = wind.find((k) => d >= k.from && d <= k.to);
    if (!b) return '';
    const name = b.cls === 'head' ? 'Gegenwind' : b.cls === 'tail' ? 'Rückenwind' : b.wind < 6 ? 'Kaum Wind' : 'Seitenwind';
    return `<span>${name}, ${fmt(b.wind)} km/h</span>`;
  }

  function fromEvent(ev) {
    if (!geom) return null;
    const r = svg.getBoundingClientRect();
    const px = ev.clientX - r.left;
    return geom.v0 + ((px - geom.m.l) / geom.pw) * geom.span;
  }
  const clamp = (d) => Math.max(geom.v0, Math.min(geom.v1, d));
  svg.addEventListener('pointermove', (ev) => {
    const d = fromEvent(ev);
    if (d == null) return;
    showAt(d, true);
    // Waagerecht ziehen wählt einen Bereich aus
    if (drag && ev.pointerId === drag.id) {
      if (Math.abs(ev.clientX - drag.x0) > 6) drag.active = true;
      if (drag.active) paintSel([drag.d0, clamp(d)]);
    }
  });
  svg.addEventListener('pointerdown', (ev) => {
    const d = fromEvent(ev);
    if (d == null) return;
    showAt(d, true);
    if (!armed) return;
    drag = { id: ev.pointerId, x0: ev.clientX, d0: clamp(d), active: false };
    try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* nicht kritisch */ }
  });
  const finish = (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const g = drag;
    drag = null;
    if (g.active) {
      const d1 = clamp(fromEvent(ev)), a = Math.min(g.d0, d1), b = Math.max(g.d0, d1);
      if (b - a < Math.max(60, geom.span * 0.02)) { paintSel(null); return; }
      sel = [a, b];
    } else return;
    armed = false;
    host.classList.remove('armed');
    if (onArm) onArm(false);
    // Das Profil zoomt selbst auf den gewählten Bereich
    view = sel;
    tip.hidden = true;
    draw();
    if (onSelect) onSelect(sel);
  };
  svg.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', (ev) => { if (drag && ev.pointerId === drag.id) { drag = null; paintSel(sel); } });
  svg.addEventListener('pointerleave', () => { if (!drag) { showAt(null); onHover(null); } });

  new ResizeObserver(() => draw()).observe(host);

  return {
    setRoute(r) { route = r; sel = null; view = null; drag = null; tip.hidden = true; draw(); },
    clearSelection() { sel = null; view = null; draw(); },
    arm(on) { armed = !!on; host.classList.toggle('armed', armed); },
    setSelection(range) { sel = range; view = range; tip.hidden = true; draw(); },
    setCursor(d) { showAt(d, false); },
    setWind(bins) { wind = bins && bins.length ? bins : null; draw(); },
  };
}
