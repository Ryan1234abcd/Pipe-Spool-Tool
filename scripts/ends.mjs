// Finds where each end listed in Part-Library's library.json sits in its STEP
// model: origin on the end face, outward direction, and the fitting centre.
// Pure maths on the circle edges and display mesh from cad.js, so it can be
// tested without the CAD kernel. Used by scripts/library-geometry.mjs.

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.sqrt(dot(a, a));
const norm = (a) => { const l = len(a); return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 0]; };

/** BSP thread engagement (ISO 7-1 gauge length, mm) by thread size. */
export const BSP_ENGAGE = {
  '1/8"': 4.0, '1/4"': 6.0, '3/8"': 6.4, '1/2"': 8.2, '3/4"': 9.5, '1"': 10.4, '1-1/4"': 12.7,
  '1-1/2"': 12.7, '2"': 15.9, '2-1/2"': 17.5, '3"': 20.6, '4"': 25.4, '5"': 28.6, '6"': 28.6,
};
export function engageOf(end) {
  const t = (end.thread || '').replace(/\s*BSP.*/, '');
  return BSP_ENGAGE[t] || Math.max(4, 0.45 * (end.thread_od_mm || end.od_mm || 10));
}

/** Diameters an end face may show, and the largest outline expected there. */
function endSizes(e) {
  const od = e.od_mm || 0;
  const th = e.thread_od_mm || od;
  switch (true) {
    case /BSP female/.test(e.end): return { refs: [th, th * 0.9], outer: th * 1.7, slack: 0.7 };
    case /BSP male/.test(e.end): return { refs: [th, th * 0.85], outer: th * 1.6, slack: 0.5 };
    case /RJT female/.test(e.end): return { refs: [od * 2, od * 1.6, od], outer: od * 2.3, slack: 0.6 };
    case /RJT male/.test(e.end): return { refs: [od * 1.5, od], outer: od * 2.0, slack: 0.6 };
    case /flange|wafer|lugged/.test(e.end): return { refs: [e.flange_od_mm || od * 2, e.pcd_mm || od * 1.6, od], outer: (e.flange_od_mm || od * 2.5) * 1.05, slack: 0.5 };
    case /slip-on/.test(e.end): return { refs: [od, e.flange_od_mm || od * 2.5], outer: (e.flange_od_mm || od * 2.6) * 1.05, slack: 0.5 };
    default: return { refs: [od, od - 2 * (e.wall_mm || 0)], outer: od * 1.3, slack: 0.15 };
  }
}

/** First hit of a ray with the mesh (Möller–Trumbore), Infinity if none. */
function rayHit(mesh, o, d, tMin = 0.05) {
  const P = mesh.positions, I = mesh.indices;
  let best = Infinity;
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const pv = cross(d, e2);
    const det = dot(e1, pv);
    if (Math.abs(det) < 1e-12) continue;
    const tv = [o[0] - P[a], o[1] - P[a + 1], o[2] - P[a + 2]];
    const u = dot(tv, pv) / det;
    if (u < 0 || u > 1) continue;
    const qv = cross(tv, e1);
    const v = dot(d, qv) / det;
    if (v < 0 || u + v > 1) continue;
    const t = dot(e2, qv) / det;
    if (t > tMin && t < best) best = t;
  }
  return best;
}

/** Join arcs of the same circle (models often split a circle in two halves). */
export function mergeArcs(circles) {
  const out = [];
  for (const c of circles) {
    const a = norm(c.axis);
    const m = out.find((x) => Math.abs(x.radius - c.radius) < 1e-3 && len(sub(x.centre, c.centre)) < 1e-3 && Math.abs(Math.abs(dot(x.axis, a)) - 1) < 1e-6);
    if (m) m.span += c.span; else out.push({ ...c, axis: a });
  }
  return out;
}

/** Candidate axis lines: circle axes (merged) plus the box axes through the centre. */
function axisLines(circles, bbox, minDia) {
  const lines = [];
  const centre = scale(add(bbox[0], bbox[1]), 0.5);
  const extent = len(sub(bbox[1], bbox[0])) || 1;
  const tol = Math.max(0.3, extent * 0.004);
  const addLine = (p, a, dia) => {
    a = norm(a);
    const k = a.findIndex((x) => Math.abs(x) > 1e-6);
    if (a[k] < 0) a = scale(a, -1);
    const l = lines.find((x) => Math.abs(dot(x.a, a)) > 1 - 1e-4 && len(sub(sub(p, x.p), scale(x.a, dot(sub(p, x.p), x.a)))) < tol);
    if (l) { l.dias.push(dia); return; }
    lines.push({ p, a, dias: [dia] });
  };
  for (const c of circles) if (c.span > 2 * Math.PI - 0.05 && 2 * c.radius >= minDia) addLine(c.centre, c.axis, 2 * c.radius);
  for (const a of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) addLine(centre, a, 0);
  return { lines, tol };
}

/**
 * Locate the library ends in a model.
 * @param part   library.json part ({category, angle, ends})
 * @param circles [{centre, axis, radius, span}]   (Cad.circles)
 * @param mesh   {positions, indices, bbox}          (Cad.mesh)
 * @returns {ends:[{origin, dir, up, engage?}], centre, cost, notes:[]}
 */
export function locateEnds(part, circles, mesh) {
  circles = mergeArcs(circles);
  const ends = part.ends;
  const sizes = ends.map(endSizes);
  const minRef = Math.min(...sizes.flatMap((s) => s.refs).filter((x) => x > 0));
  const R = Math.max(...sizes.map((s) => s.outer)) * 0.55;
  const { lines, tol } = axisLines(circles, mesh.bbox, minRef * 0.3);
  const P = mesh.positions;
  // valves and strainers may have a disc or plate right at the end, so no bore test
  const valveLike = /valve|strainer/.test(part.category);
  const eccentric = /eccentric/.test(part.type || '');

  // one candidate per line and direction: the outermost face within R of the line
  const cands = [];
  for (const l of lines) {
    for (const s of [1, -1]) {
      const d = scale(l.a, s);
      let hMax = -Infinity;
      let found = false;
      for (let i = 0; i < P.length; i += 3) {
        const off = [P[i] - l.p[0], P[i + 1] - l.p[1], P[i + 2] - l.p[2]];
        const h = dot(off, d);
        const r2 = dot(off, off) - h * h;
        if (r2 < R * R && h > hMax) { hMax = h; found = true; }
      }
      if (!found) continue;
      // the end face: points on the outermost plane near the line; its outline
      // gives the face centre (the line may be off-centre, e.g. eccentric reducers)
      const u = defaultUp(d), v = cross(d, u);
      const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      for (let i = 0; i < P.length; i += 3) {
        const off = [P[i] - l.p[0], P[i + 1] - l.p[1], P[i + 2] - l.p[2]];
        const h = dot(off, d);
        if (h < hMax - Math.max(tol, 0.5)) continue;
        const a = dot(off, u), b = dot(off, v);
        if (a * a + b * b >= R * R) continue;
        if (a < lo[0]) lo[0] = a; if (a > hi[0]) hi[0] = a;
        if (b < lo[1]) lo[1] = b; if (b > hi[1]) hi[1] = b;
      }
      const cu = (lo[0] + hi[0]) / 2, cv = (lo[1] + hi[1]) / 2;
      const rFace = Math.max(hi[0] - lo[0], hi[1] - lo[1]) / 2;
      // only eccentric reducers really have an end off the line; elsewhere hex
      // nuts, lugs and bonnets make the outline lopsided, so keep the line centre
      const origin = add(add(l.p, scale(d, hMax)), eccentric ? add(scale(u, cu), scale(v, cv)) : [0, 0, 0]);
      // the face outline should sit around the axis, not to one side of it
      const offCentre = Math.hypot(cu, cv) / Math.max(rFace, minRef / 2);
      const dias = [2 * rFace];
      for (const c of circles) {
        if (c.span < 2 * Math.PI - 0.05 || Math.abs(Math.abs(dot(norm(c.axis), d)) - 1) > 1e-3) continue;
        const off = sub(c.centre, origin);
        const h = dot(off, d);
        if (len(sub(off, scale(d, h))) < tol && h > -Math.max(3, 0.25 * R)) dias.push(2 * c.radius);
      }
      const bore = valveLike ? Infinity : rayHit(mesh, add(origin, scale(d, 0.01)), scale(d, -1));
      cands.push({ origin, dir: d, dias, bore, offCentre, line: l, circleLine: l.dias.some((x) => x > 0) });
    }
  }

  // cost of end e on candidate c
  const sizeCost = (e, c) => {
    const s = sizes[e];
    let best = Infinity;
    for (const x of c.dias) for (const r of s.refs) if (x > 0 && r > 0) best = Math.min(best, Math.abs(Math.log(x / r)));
    return Math.max(0, best - s.slack * 0.3) * 4 + (best > s.slack ? 2 : 0);
  };
  const boreCost = (e, c) => {
    const od = ends[e].od_mm || minRef;
    if (/BSP male/.test(ends[e].end) && ends.length === 1) return 0; // plugs are solid
    return c.bore < 0.25 * od ? 2.5 : 0;
  };
  const per = ends.map((_, e) => cands.map((c, i) => ({ i, cost: sizeCost(e, c) + boreCost(e, c) + 4 * c.offCentre + (c.circleLine ? 0 : 1.5) }))
    .sort((a, b) => a.cost - b.cost).slice(0, 14));

  const lineGap = (a, b) => { // distance between two axis lines (parallel-safe)
    const n = cross(a.dir, b.dir);
    const w = sub(b.origin, a.origin);
    if (len(n) < 1e-6) return len(sub(w, scale(a.dir, dot(w, a.dir))));
    return Math.abs(dot(w, norm(n)));
  };
  const maxOd = Math.max(...ends.map((e) => e.od_mm || 0));
  const geomCost = (cs) => {
    if (cs.length === 1) return 0;
    if (cs.length === 2) {
      const [a, b] = cs;
      const dd = dot(a.dir, b.dir);
      if (part.category === 'elbow' && part.angle) {
        const target = -Math.cos((part.angle * Math.PI) / 180);
        return 6 * Math.abs(dd - target) + (part.angle === 180 ? 0 : lineGap(a, b) / maxOd);
      }
      return 6 * Math.abs(dd + 1) + Math.max(0, lineGap(a, b) / maxOd - 0.35) * 4;
    }
    // tee: two run ends opposite and collinear, branch square to them and meeting the run
    const bi = ends.findIndex((e) => e.role === 'branch');
    const b = cs[bi >= 0 ? bi : 2];
    const [r1, r2] = cs.filter((c) => c !== b);
    return 6 * Math.abs(dot(r1.dir, r2.dir) + 1) + 2 * lineGap(r1, r2) / maxOd
      + 3 * Math.abs(dot(b.dir, r1.dir)) + 2 * lineGap(b, r1) / maxOd;
  };

  let best = null;
  const pick = (e, used, chosen, cost) => {
    if (best && cost >= best.cost) return;
    if (e === ends.length) {
      const cs = chosen.map((i) => cands[i]);
      const total = cost + geomCost(cs);
      if (!best || total < best.cost) best = { cost: total, cs };
      return;
    }
    for (const { i, cost: c } of per[e]) {
      if (used.has(i)) continue;
      if (chosen.some((j) => len(sub(cands[j].origin, cands[i].origin)) < tol * 3 && dot(cands[j].dir, cands[i].dir) > 0.99)) continue;
      used.add(i); chosen.push(i);
      pick(e + 1, used, chosen, cost + c);
      used.delete(i); chosen.pop();
    }
  };
  pick(0, new Set(), [], 0);
  if (process?.env?.ENDS_DEBUG) console.log(cands.map((c, i) => `${i} o${c.origin.map((v) => v.toFixed(1))} d${c.dir.map((v) => v.toFixed(2))} dias${c.dias.map((v) => v.toFixed(1))} bore${c.bore.toFixed(1)} off${c.offCentre.toFixed(2)}`).join("\n"), per.map((p) => p.map((q) => `${q.i}:${q.cost.toFixed(2)}`).join(" ")));
  if (!best) return null;

  const notes = [];
  const out = best.cs.map((c) => ({ origin: c.origin, dir: c.dir }));
  // a flange is dimensioned to its face
  const faceIdx = ends.findIndex((e) => /flange face/.test(e.end));
  const centre = part.category === 'flange' && faceIdx >= 0 ? out[faceIdx].origin : fittingCentre(out, mesh, part);

  // connection details
  ends.forEach((e, k) => {
    const p = out[k];
    if (/BSP/.test(e.end)) {
      p.engage = engageOf(e);
      // a male thread goes into the female: its port sits at the shoulder
      if (/male/.test(e.end) && !/female/.test(e.end)) p.origin = sub(p.origin, scale(p.dir, p.engage));
    }
    if (/slip-on/.test(e.end)) {
      // the pipe passes through a slip-on flange and stops just short of the face
      const face = out.find((q, j) => /flange face/.test(ends[j].end));
      if (face) {
        const setback = e.wall_mm || 3;
        const thick = dot(sub(p.origin, face.origin), p.dir);
        p.origin = sub(p.origin, scale(p.dir, Math.max(0, thick - setback)));
      } else notes.push('slip-on end without a flange face');
    }
  });
  for (const p of out) p.up = defaultUp(p.dir);
  return { ends: out, centre, cost: best.cost, notes };
}

/** A vector perpendicular to dir: +Z projected, else +X (same rule as kinematics.js). */
export function defaultUp(dir) {
  const d = norm(dir);
  for (const ref of [[0, 0, 1], [1, 0, 0]]) {
    const p = sub(ref, scale(d, dot(ref, d)));
    if (len(p) > 1e-3) return norm(p);
  }
  return [0, 1, 0];
}

/**
 * Fitting centre: where the end axes meet (least squares). Inline parts:
 * midway between the ends. One end (caps, plugs): the far end of the part.
 */
export function fittingCentre(ends, mesh, part) {
  if (ends.length === 1) {
    const e = ends[0];
    const P = mesh.positions;
    let hMin = 0;
    for (let i = 0; i < P.length; i += 3) {
      const h = dot([P[i] - e.origin[0], P[i + 1] - e.origin[1], P[i + 2] - e.origin[2]], e.dir);
      if (h < hMin) hMin = h;
    }
    return add(e.origin, scale(e.dir, hMin));
  }
  const parallel = ends.every((e) => Math.abs(dot(e.dir, ends[0].dir)) > 0.999);
  if (parallel) return scale(ends.reduce((s, e) => add(s, e.origin), [0, 0, 0]), 1 / ends.length);
  // least squares: sum (I - d d^T) (x - o) = 0
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (const e of ends) {
    const d = e.dir;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) A[i][j] += (i === j ? 1 : 0) - d[i] * d[j];
      b[i] += e.origin[i] - d[i] * dot(d, e.origin);
    }
  }
  return solve3(A, b) || scale(ends.reduce((s, e) => add(s, e.origin), [0, 0, 0]), 1 / ends.length);
}

function solve3(A, b) {
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-9) return null;
  return [0, 1, 2].map((k) => det(A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)))) / D);
}
