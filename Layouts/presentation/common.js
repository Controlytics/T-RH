/* Shared by every presentation page: the floor data, the geometry each model
 * draws from, the status vocabulary, and the page chrome (floor tabs, legend,
 * footer). Pure functions; each model page only draws. Opened from file://,
 * so this is a plain script, not a module. */
(function () {
  'use strict';
  const DATA = window.LAYOUT_MODELS;

  // ── Status vocabulary: the dashboard's four-colour rule, kept identical in all models ──
  const STATUS = {
    OK:          { label: 'In limit',      color: '#1F9D55' },
    OUT_OF_SPEC: { label: 'Out of limit',  color: '#D6453D' },
    ERROR:       { label: 'Sensor fault',  color: '#7C3AED' },
    OFFLINE:     { label: 'Not reporting', color: '#D98E04' },
    NO_DATA:     { label: 'No reading',    color: '#8A94A6' },
  };
  const STATUS_ORDER = ['OK', 'OUT_OF_SPEC', 'ERROR', 'OFFLINE', 'NO_DATA'];

  // ── Geometry ──────────────────────────────────────────────────────────────
  function bbox(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function centroid(pts) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
      const f = x1 * y2 - x2 * y1; a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
    }
    if (Math.abs(a) < 1e-9) { const b = bbox(pts); return [b.x + b.w / 2, b.y + b.h / 2]; }
    return [cx / (3 * a), cy / (3 * a)];
  }
  function pointInPolygon([px, py], pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  /** The largest axis-aligned rectangle inside a (rectilinear) outline: the grid
   *  of its own corner lines, cells tested at their centre, maximal block. */
  function largestInscribedRect(pts) {
    const xs = [...new Set(pts.map((p) => p[0]))].sort((a, b) => a - b);
    const ys = [...new Set(pts.map((p) => p[1]))].sort((a, b) => a - b);
    if (xs.length < 2 || ys.length < 2) return bbox(pts);
    const inside = ys.slice(0, -1).map((y, j) => xs.slice(0, -1).map((x, i) =>
      pointInPolygon([(x + xs[i + 1]) / 2, (y + ys[j + 1]) / 2], pts)));
    let best = null;
    for (let i0 = 0; i0 < xs.length - 1; i0++) for (let i1 = i0; i1 < xs.length - 1; i1++)
      for (let j0 = 0; j0 < ys.length - 1; j0++) for (let j1 = j0; j1 < ys.length - 1; j1++) {
        let ok = true;
        for (let j = j0; j <= j1 && ok; j++) for (let i = i0; i <= i1; i++) if (!inside[j][i]) { ok = false; break; }
        if (!ok) continue;
        const r = { x: xs[i0], y: ys[j0], w: xs[i1 + 1] - xs[i0], h: ys[j1 + 1] - ys[j0] };
        if (!best || r.w * r.h > best.w * best.h) best = r;
      }
    return best || bbox(pts);
  }

  /** Every door on the floor as a wall gap: {axis, at, from, to, hinge, swing, room}. */
  function allDoors(floor) {
    const out = [];
    for (const r of floor.rooms) for (const d of r.doors) out.push(Object.assign({ room: r }, d));
    return out;
  }
  /** A room code without its "(2)" piece suffix: two pieces of one code are ONE space. */
  const baseCode = (code) => code.replace(/\s*\(\d+\)\s*$/, '');
  /** The room containing a point, or null. */
  function roomAt(floor, p) { return floor.rooms.find((r) => pointInPolygon(p, r.outline)) || null; }
  /**
   * The floor's walls as segments `{a, b, exterior}` with every door gap cut
   * out, whichever room owns the door — a shared wall is drawn once per room,
   * and both copies must show the opening. Each straight run is split at every
   * corner any room has on that line and classified by probing both sides:
   * a room on one side only = an EXTERIOR wall (the building's real outline,
   * which on an L-shaped floor is not its bounding box); the same code on both
   * sides = the seam between two pieces of one corridor, which is no wall.
   */
  function wallSegments(floor) {
    const doors = allDoors(floor);
    const segs = [];
    const seen = new Set();
    const key = (a, b) => [a, b].map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).sort().join('|');
    for (const r of floor.rooms) {
      const pts = r.outline;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const vertical = Math.abs(a[0] - b[0]) < 0.01, horizontal = Math.abs(a[1] - b[1]) < 0.01;
        if (!vertical && !horizontal) { segs.push({ a, b, exterior: false }); continue; }
        const axis = vertical ? 'x' : 'y', at = vertical ? a[0] : a[1];
        const lo = Math.min(vertical ? a[1] : a[0], vertical ? b[1] : b[0]);
        const hi = Math.max(vertical ? a[1] : a[0], vertical ? b[1] : b[0]);
        // Breakpoints: every corner any room has on this line, inside the run.
        const cuts = new Set([lo, hi]);
        for (const o of floor.rooms) for (const [x, y] of o.outline) {
          const on = vertical ? Math.abs(x - at) < 0.6 : Math.abs(y - at) < 0.6;
          const t = vertical ? y : x;
          if (on && t > lo + 0.5 && t < hi - 0.5) cuts.add(t);
        }
        const gaps = doors.filter((d) => d.axis === axis && Math.abs(d.at - at) < 0.6 && d.to > lo + 0.5 && d.from < hi - 0.5)
          .map((d) => [Math.max(lo, d.from), Math.min(hi, d.to)]);
        for (const g of gaps) { cuts.add(g[0]); cuts.add(g[1]); }
        const ts = [...cuts].sort((p, q) => p - q);
        for (let k = 0; k < ts.length - 1; k++) {
          const t0 = ts[k], t1 = ts[k + 1];
          if (t1 - t0 < 0.5) continue;
          if (gaps.some((g) => t0 >= g[0] - 0.25 && t1 <= g[1] + 0.25)) continue; // inside a doorway
          const m = (t0 + t1) / 2;
          const pA = vertical ? [at + 2, m] : [m, at + 2], pB = vertical ? [at - 2, m] : [m, at - 2];
          const rA = roomAt(floor, pA), rB = roomAt(floor, pB);
          if (rA && rB && baseCode(rA.code) === baseCode(rB.code)) continue; // one space, two pieces
          const p = vertical ? [at, t0] : [t0, at], q = vertical ? [at, t1] : [t1, at];
          const kk = key(p, q);
          if (seen.has(kk)) continue;
          seen.add(kk);
          segs.push({ a: p, b: q, exterior: !(rA && rB) });
        }
      }
    }
    return segs;
  }
  /** A door's leaf and swing: hinge point, free end, open tip, and the SVG arc. */
  function doorLeaf(d) {
    const w = d.to - d.from;
    const p = (t) => (d.axis === 'x' ? [d.at, t] : [t, d.at]);
    const H = p(d.hinge === 'to' ? d.to : d.from), F = p(d.hinge === 'to' ? d.from : d.to);
    const mid = p((d.from + d.to) / 2);
    // Into the room the door is stored on: probe either side of the gap.
    let n = d.axis === 'x' ? [1, 0] : [0, 1];
    const probe = [mid[0] + n[0] * 6, mid[1] + n[1] * 6];
    if (!pointInPolygon(probe, d.room.outline)) n = [-n[0], -n[1]];
    if (d.swing === 'out') n = [-n[0], -n[1]];
    const tip = [H[0] + n[0] * w, H[1] + n[1] * w];
    const cross = (F[0] - H[0]) * (tip[1] - H[1]) - (F[1] - H[1]) * (tip[0] - H[0]);
    const sweep = cross > 0 ? 1 : 0;
    return { w, H, F, tip, mid, n, leafless: d.hinge === 'none', arc: `M ${F[0]} ${F[1]} A ${w} ${w} 0 0 ${sweep} ${tip[0]} ${tip[1]}` };
  }

  // ── Readings ──────────────────────────────────────────────────────────────
  function reading(room) { return room.instrument ? DATA.readings[room.instrument] || null : null; }
  function fmt(v, dec) {
    if (v === null || v === undefined) return 'NA';
    if (typeof v === 'string') return 'Error';
    return v.toFixed(dec);
  }
  function roomStatus(room) { const r = reading(room); return r ? r.status : null; }
  function slotTone(r, slot) {
    if (!r) return 'NO_DATA';
    if (!r.reporting) return 'OFFLINE';
    const v = r[slot];
    if (typeof v === 'string') return 'ERROR';
    if (v === null) return 'NO_DATA';
    const lo = slot === 'temperature' ? r.limits.tempMin : r.limits.rhMin;
    const hi = slot === 'temperature' ? r.limits.tempMax : r.limits.rhMax;
    if ((lo !== null && v < lo) || (hi !== null && v > hi)) return 'OUT_OF_SPEC';
    return 'OK';
  }
  function limitsText(r) {
    const t = r.limits, d = r.decimals;
    const f = (lo, hi, dec, unit) => (lo === null && hi === null) ? null : `${lo === null ? '—' : lo.toFixed(dec)} to ${hi === null ? '—' : hi.toFixed(dec)} ${unit}`;
    return { temperature: f(t.tempMin, t.tempMax, d.temperature, '°C'), humidity: f(t.rhMin, t.rhMax, d.humidity, '%RH') };
  }
  function counts(floor) {
    const n = { OK: 0, OUT_OF_SPEC: 0, ERROR: 0, OFFLINE: 0, NO_DATA: 0 };
    for (const r of floor.rooms) { const s = roomStatus(r); if (s) n[s]++; }
    return n;
  }

  // ── Chrome ────────────────────────────────────────────────────────────────
  function floorFromHash() {
    const m = /floor=([a-z0-9-]+)/.exec(location.hash);
    return (m && DATA.floors.find((f) => f.id === m[1])) || DATA.floors[0];
  }
  /** Mounts the top bar and footer into `root` and calls `onFloor(floor)` now and on every tab change. */
  function mountChrome(root, opts) {
    const bar = document.createElement('header');
    bar.className = 'lm-bar';
    bar.innerHTML = `
      <div class="lm-brand"><a class="lm-back" href="index.html" title="All models">‹</a><div><div class="lm-model">${opts.modelName}</div><div class="lm-sub">${opts.subtitle || ''}</div></div></div>
      <nav class="lm-tabs" aria-label="Floors"></nav>
      <div class="lm-legend">${STATUS_ORDER.map((k) => `<span class="lm-key" data-k="${k}"><i style="background:${STATUS[k].color}"></i><b></b>${STATUS[k].label}</span>`).join('')}</div>`;
    const tabs = bar.querySelector('.lm-tabs');
    for (const f of DATA.floors) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = f.title; b.dataset.id = f.id;
      b.onclick = () => { location.hash = `floor=${f.id}`; };
      tabs.appendChild(b);
    }
    const foot = document.createElement('footer');
    foot.className = 'lm-foot';
    const when = new Date(DATA.generatedAt);
    foot.innerHTML = `<span class="lm-counts"></span><span>Sample snapshot taken ${when.toLocaleString()} — a few instruments are set to demonstration states so every colour shows.</span>`;
    root.prepend(bar); root.appendChild(foot);
    const apply = () => {
      const f = floorFromHash();
      for (const b of tabs.children) b.classList.toggle('is-active', b.dataset.id === f.id);
      const n = counts(f);
      for (const k of bar.querySelectorAll('.lm-key')) { k.querySelector('b').textContent = n[k.dataset.k]; k.classList.toggle('is-zero', !n[k.dataset.k]); }
      if (tipEl) tipEl.style.display = 'none';
      foot.querySelector('.lm-counts').innerHTML = `<b>${f.title}</b> · ${f.rooms.length} rooms · ${Object.values(n).reduce((a, b) => a + b, 0)} instruments: `
        + STATUS_ORDER.filter((k) => n[k]).map((k) => `<span style="color:${STATUS[k].color}">${n[k]} ${STATUS[k].label.toLowerCase()}</span>`).join(', ');
      document.title = `${opts.modelName} — ${f.title}`;
      opts.onFloor(f);
    };
    window.addEventListener('hashchange', apply);
    apply();
  }

  const svgNS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, parent) {
    const e = document.createElementNS(svgNS, tag);
    for (const k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  const pathOf = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0]} ${p[1]}`).join(' ') + ' Z';
  /** A label trimmed to fit `maxChars`, title-cased from the drawing's capitals. */
  function roomName(room) {
    const s = (room.label || room.code || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bHplc\b/, 'HPLC').replace(/\bGc\b/, 'GC').replace(/\bQc\b/, 'QC').replace(/\bLcms\b/, 'LCMS').replace(/\bLaf\b/, 'LAF').replace(/\bBsc\b/, 'BSC').replace(/\bHphv\b/, 'HPHV').replace(/\bAhu\b/, 'AHU').replace(/\bUv\b/, 'UV').replace(/\bIpqa\b/, 'IPQA').replace(/\bRm\b/, 'RM').replace(/\bPm\b/, 'PM').replace(/\bKf\b/, 'KF').replace(/\bCwh\b/, 'CWH')
      .replace(/\b(Ii|Iii|Iv)\b/g, (m) => m.toUpperCase()).replace(/-(Ii|Iii|Iv)\b/g, (m) => m.toUpperCase());
    return s;
  }

  /**
   * A room name fitted into `w` x `h` (in the same units as `max`/`min` font
   * sizes): one line as large as fits, else two lines split at the nearest
   * space, else the first line cut with an ellipsis. Width is estimated at
   * 0.56 em per character. Returns {lines, font} or null when nothing fits.
   */
  function fitName(name, w, h, max, min) {
    const width = (s, f) => s.length * 0.56 * f;
    let f = Math.min(max, w / (name.length * 0.56), h / 1.15);
    if (f >= min) return { lines: [name], font: f };
    const words = name.split(' ');
    if (words.length > 1) {
      let best = null;
      for (let i = 1; i < words.length; i++) {
        const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
        const longest = Math.max(a.length, b.length);
        const f2 = Math.min(max, w / (longest * 0.56), h / 2.3);
        if (f2 >= min && (!best || f2 > best.font)) best = { lines: [a, b], font: f2 };
      }
      if (best) return best;
    }
    if (h < min * 1.15) return null;
    const chars = Math.floor(w / (0.56 * min)) - 1;
    if (chars < 4) return null;
    return { lines: [name.slice(0, chars) + '…'], font: min };
  }

  // ── Premium pieces shared by the SVG models ───────────────────────────────
  /** Thermometer and droplet glyphs, 24 x 24 boxes. */
  const ICONS = {
    temperature: 'M12 2a3 3 0 0 0-3 3v8.3a5 5 0 1 0 6 0V5a3 3 0 0 0-3-3zm0 2a1 1 0 0 1 1 1v9.2l.5.3a3 3 0 1 1-3 0l.5-.3V5a1 1 0 0 1 1-1zm0 7a1 1 0 0 0-1 1v3.4a2 2 0 1 0 2 0V12a1 1 0 0 0-1-1z',
    humidity: 'M12 2.5c-3.6 4.4-6.5 8-6.5 11.5a6.5 6.5 0 0 0 13 0c0-3.5-2.9-7.1-6.5-11.5zm0 3.2c2.6 3.3 4.5 6 4.5 8.3a4.5 4.5 0 0 1-9 0c0-2.3 1.9-5 4.5-8.3zM9.5 14a2.5 2.5 0 0 0 2.5 2.5v-1.2a1.3 1.3 0 0 1-1.3-1.3H9.5z',
  };
  function icon(kind, x, y, size, fill, parent) {
    const g = el('g', { transform: `translate(${x} ${y}) scale(${size / 24})` }, parent);
    el('path', { d: ICONS[kind], fill }, g);
    return g;
  }
  /** Where a value sits in its [lo, hi] band: a bar with the band and a marker. Draws nothing without a bound. */
  function limitBar(parent, x, y, w, h, value, lo, hi, color, track) {
    if (typeof value !== 'number' || (lo === null && hi === null)) return;
    const span = (hi ?? lo) - (lo ?? hi) || 1;
    const pad = span * 0.35;
    const min = (lo ?? hi) - pad, max = (hi ?? lo) + pad;
    const t = (v) => x + Math.max(0, Math.min(1, (v - min) / (max - min))) * w;
    el('rect', { x, y, width: w, height: h, rx: h / 2, fill: track || 'rgba(27,36,48,.10)' }, parent);
    el('rect', { x: t(lo ?? min), y, width: t(hi ?? max) - t(lo ?? min), height: h, rx: h / 2, fill: color, 'fill-opacity': 0.28 }, parent);
    el('rect', { x: t(value) - h * 0.6, y: y - h * 0.5, width: h * 1.2, height: h * 2, rx: h * 0.4, fill: color }, parent);
  }

  /** One hover panel per page; `bindTip(node, room)` shows it for that room. */
  let tipEl = null;
  function tipHtml(room) {
    const rd = reading(room);
    const name = roomName(room);
    if (!rd) return `<div class="lm-tip-h"><b>${name}</b><span>${room.code}</span></div><div class="lm-tip-muted">No instrument in this room</div>`;
    const lim = limitsText(rd);
    const row = (kind, label, v, dec, unit, limit) => `<div class="lm-tip-row"><i style="background:${STATUS[slotTone(rd, kind)].color}"></i><span>${label}</span><b style="color:${STATUS[slotTone(rd, kind)].color}">${fmt(v, dec)}<small>${typeof v === 'number' ? ' ' + unit : ''}</small></b><em>${limit ? 'limit ' + limit : 'no limit set'}</em></div>`;
    return `<div class="lm-tip-h"><b>${name}</b><span>${room.code}</span></div>
      <div class="lm-tip-id">${rd.code}<span style="color:${STATUS[rd.status].color}">${STATUS[rd.status].label}</span></div>
      ${row('temperature', 'Temperature', rd.temperature, rd.decimals.temperature, '°C', lim.temperature)}
      ${row('humidity', 'Humidity', rd.humidity, rd.decimals.humidity, '%RH', lim.humidity)}
      ${rd.location ? `<div class="lm-tip-muted">Location attribute: ${rd.location}</div>` : ''}
      ${rd.demo ? `<div class="lm-tip-muted">Sample: ${rd.demo}</div>` : ''}`;
  }
  function bindTip(node, room) {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'lm-tip'; document.body.appendChild(tipEl); }
    const move = (e) => {
      const W = window.innerWidth, H = window.innerHeight, r = tipEl.getBoundingClientRect();
      tipEl.style.left = `${Math.min(e.clientX + 16, W - r.width - 12)}px`;
      tipEl.style.top = `${Math.min(Math.max(12, e.clientY - r.height / 2), H - r.height - 12)}px`;
    };
    node.addEventListener('pointerenter', (e) => { tipEl.innerHTML = tipHtml(room); tipEl.style.display = 'block'; move(e); });
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerleave', () => { tipEl.style.display = 'none'; });
    node.style.cursor = 'default';
  }

  /** Sizes an SVG/canvas to fill the stage: full width, or as wide as the stage's height allows. */
  function fitStyle(W, H) { return `width: min(100%, calc((100vh - 118px) * ${(W / H).toFixed(4)})); height: auto;`; }

  window.LM = { DATA, STATUS, STATUS_ORDER, bbox, centroid, pointInPolygon, largestInscribedRect, allDoors, wallSegments, doorLeaf, baseCode, roomAt, fitStyle, fitName, ICONS, icon, limitBar, bindTip, tipHtml,
    reading, fmt, roomStatus, slotTone, limitsText, counts, mountChrome, el, pathOf, roomName, floorFromHash };
})();
