// Automatic connection-port detection for STEP parts.
// A port candidate is a group of full circles sharing a centre and axis; it is
// "likely" when no part geometry lies in front of it (an exposed end face).
import { defaultUp } from './kinematics.js';
import { guessOd } from './pipe-types.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const r3 = (v, n = 1000) => v.map((x) => Math.round(x * n) / n || 0);

/**
 * @param circles  [{centre, axis, radius, span}] from Cad.circles()
 * @param mesh     {positions (flat), bbox}
 * @param preferType pipe type used to prefer size matches
 */
export function detectPorts(circles, mesh, preferType) {
  const pos = mesh.positions;
  const [lo, hi] = mesh.bbox;
  const extent = dist(lo, hi) || 1;
  const tol = Math.max(0.5, extent * 0.002);

  const groups = [];
  for (const c of circles) {
    let axis = norm(c.axis);
    const first = axis.find((x) => Math.abs(x) > 1e-6);
    if (first < 0) axis = axis.map((x) => -x);
    const g = groups.find((x) => dist(x.centre, c.centre) < tol && Math.abs(Math.abs(dot(x.axis, axis)) - 1) < 1e-4);
    const key = Math.round(c.radius * 100) / 100;
    if (g) g.radii.set(key, (g.radii.get(key) || 0) + c.span);
    else groups.push({ centre: c.centre, axis, radii: new Map([[key, c.span]]) });
  }

  const cands = [];
  for (const g of groups) {
    const full = [...g.radii].filter(([, s]) => s >= 2 * Math.PI - 0.05).map(([r]) => r);
    if (!full.length) continue;
    const a = g.axis;
    const rMax = Math.max(...full) * 1.02;
    let front = false, back = false, hMin = Infinity, hMax = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const off = [pos[i] - g.centre[0], pos[i + 1] - g.centre[1], pos[i + 2] - g.centre[2]];
      const h = dot(off, a);
      if (h < hMin) hMin = h;
      if (h > hMax) hMax = h;
      if (Math.abs(h) <= tol) continue;
      if (dot(off, off) - h * h < rMax * rMax) { if (h > 0) front = true; else back = true; }
      if (front && back) break;
    }
    let dir, likely = true;
    if (!front) dir = a;
    else if (!back) dir = a.map((x) => -x);
    else { likely = false; dir = hMax < -hMin ? a : a.map((x) => -x); }
    cands.push({ origin: r3(g.centre), dir: r3(dir, 1e6), axis: a, diameters: full.map((r) => 2 * r).sort((x, y) => y - x), likely });
  }

  // bolt holes etc: off-axis circles inside a larger parallel circle
  const insideOther = (c) => cands.some((o) => {
    if (o === c || Math.abs(Math.abs(dot(o.axis, c.axis)) - 1) > 1e-4) return false;
    const off = sub(c.origin, o.origin);
    const along = dot(off, o.axis);
    const radial = Math.sqrt(Math.max(dot(off, off) - along * along, 0));
    return radial > tol && radial < o.diameters[0] / 2 && o.diameters[0] > c.diameters[0];
  });

  return cands.filter((c) => !insideOther(c)).map((c) => ({
    origin: c.origin, dir: c.dir, up: r3(defaultUp(c.dir), 1e6), diameters: c.diameters,
    likely: c.likely, od: guessOd(c.diameters, preferType),
  })).sort((x, y) => (x.likely === y.likely ? y.diameters[0] - x.diameters[0] : x.likely ? -1 : 1));
}
