// Shrink-wrap: replaces a part's detailed model with a few simple solids that
// enclose it, so an exported spool is small and light. Pure maths on the
// part's display mesh and its end geometry; the solids are built by
// cad.js buildPrimitives(). Runs in the CAD worker and in node tests.
//
// Levels:  'envelope'  coarsest: smooth hull profiles, one box per handle/bonnet
//          'wrap'      profiles stepped at `res` mm, handles split into boxes
//
// Primitive list (part coordinates, mm):
//   {t:'revolve', o, d, x, pts:[[h, r]…]}   profile about the line o + h·d, closed to the axis
//   {t:'cyl', o, d, r, L}
//   {t:'torus', c, n, x, R, r, angle}       ring segment from direction x about n
//   {t:'box', o, x, y, z, min:[3], max:[3]} box in the frame (o; x, y, z)

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.sqrt(dot(a, a));
const norm = (a) => { const l = len(a); return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 0]; };

function perpendicular(d) {
  for (const ref of [[0, 0, 1], [1, 0, 0]]) {
    const p = sub(ref, scale(d, dot(ref, d)));
    if (len(p) > 1e-3) return norm(p);
  }
  return [0, 1, 0];
}

/** Points on the mesh surface: vertices plus points along long edges. */
export function samplePoints(mesh, spacing) {
  const P = mesh.positions, I = mesh.indices;
  const out = [];
  for (let i = 0; i < P.length; i += 3) out.push([P[i], P[i + 1], P[i + 2]]);
  const seen = new Set();
  for (let t = 0; t < I.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = I[t + k], b = I[t + (k + 1) % 3];
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      if (seen.has(key)) continue;
      seen.add(key);
      const pa = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]];
      const pb = [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]];
      const n = Math.floor(len(sub(pb, pa)) / spacing);
      for (let s = 1; s <= n; s++) out.push(add(pa, scale(sub(pb, pa), s / (n + 1))));
    }
  }
  return out;
}

/**
 * Profile of the points about an axis line.
 * Returns {pts (open profile [[h, r]]), outliers:[[h, y, z]…] in the axis frame}
 * Points standing well proud of the body on one side (handles, bonnets,
 * strainer legs) are returned as outliers instead of widening the profile.
 */
function axisProfile(points, o, d, level, res, { outliers: allowOutliers = true, hRange = null } = {}) {
  const x = perpendicular(d);
  const y = cross(d, x);
  const S = points.map((p) => {
    const v = sub(p, o);
    const h = dot(v, d);
    const px = dot(v, x), py = dot(v, y);
    return { h, r: Math.hypot(px, py), px, py };
  });
  if (!S.length) return null;
  let h0 = Infinity, h1 = -Infinity;
  for (const s of S) { if (s.h < h0) h0 = s.h; if (s.h > h1) h1 = s.h; }
  if (hRange) { h0 = Math.min(h0, hRange[0]); h1 = Math.max(h1, hRange[1]); }
  const span = Math.max(h1 - h0, 1e-3);
  const n = Math.max(1, Math.min(400, Math.ceil(span / res)));
  const w = span / n;
  const SECT = 8;
  const bins = Array.from({ length: n }, () => ({ sect: new Array(SECT).fill(0), pts: [] }));
  for (const s of S) {
    const i = Math.min(n - 1, Math.max(0, Math.floor((s.h - h0) / w)));
    const a = Math.floor(((Math.atan2(s.py, s.px) + Math.PI) / (2 * Math.PI)) * SECT) % SECT;
    s.sector = a;
    bins[i].pts.push(s);
    if (s.r > bins[i].sect[a]) bins[i].sect[a] = s.r;
  }
  // radius the body reaches nearly all the way round (3rd largest of 8 sectors)
  const core = bins.map((b) => (b.pts.length ? [...b.sect].sort((p, q) => q - p)[2] : -1));
  for (let i = 0; i < n; i++) if (core[i] < 0) {
    let l = i - 1, r = i + 1;
    while (l >= 0 && core[l] < 0) l--;
    while (r < n && core[r] < 0) r++;
    core[i] = Math.max(l >= 0 ? core[l] : 0, r < n ? core[r] : 0);
  }
  const radius = new Array(n).fill(0);
  const outliers = [];
  for (let i = 0; i < n; i++) {
    const thr = allowOutliers ? 1.25 * core[i] + 0.5 * res : Infinity;
    radius[i] = core[i];
    for (const s of bins[i].pts) {
      if (s.r <= thr) { if (s.r > radius[i]) radius[i] = s.r; } else outliers.push(s);
    }
  }
  // empty bins (long plain faces have no sample inside): carry the neighbours
  for (let i = 0; i < n; i++) if (!bins[i].pts.length) {
    radius[i] = Math.max(radius[i - 1] || 0, radius[i + 1] || 0, radius[i]);
  }

  let pts;
  if (level === 'envelope') {
    // upper convex hull of the bin tops: smooth, few faces, encloses everything
    const raw = [];
    for (let i = 0; i < n; i++) raw.push([h0 + i * w, radius[i]], [h0 + (i + 1) * w, radius[i]]);
    pts = upperHull(raw);
  } else {
    // stepped profile; merge steps that differ by less than half the resolution
    const steps = [];
    for (let i = 0; i < n; i++) {
      const last = steps[steps.length - 1];
      if (last && Math.abs(last.r - radius[i]) <= 0.5 * res) { last.r = Math.max(last.r, radius[i]); last.h1 = h0 + (i + 1) * w; } else steps.push({ h0: h0 + i * w, h1: h0 + (i + 1) * w, r: radius[i] });
    }
    pts = [];
    for (const s of steps) pts.push([s.h0, s.r], [s.h1, s.r]);
  }
  return { pts: flatten(pts), x, y, outliers };
}

/**
 * Make runs of nearly equal radius exactly equal (their largest value), so a
 * near-cylinder becomes a true cylinder: a cone tapering by a few microns makes
 * the solid merge fail.
 */
function flatten(pts) {
  const out = pts.map(([h, r]) => [h, Math.ceil(Math.max(r, 0.01) * 1000) / 1000]);
  for (let i = 0; i < out.length;) {
    let j = i;
    let top = out[i][1];
    while (j + 1 < out.length && Math.abs(out[j + 1][1] - out[i][1]) < 0.05) { j++; top = Math.max(top, out[j][1]); }
    for (let k = i; k <= j; k++) out[k][1] = top;
    i = j + 1;
  }
  return out;
}

/** Upper convex hull of [h, r] points sorted by h (monotone chain). */
export function upperHull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const hull = [];
  for (const q of p) {
    while (hull.length >= 2) {
      const [a, b] = hull.slice(-2);
      if ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) >= 0) hull.pop(); else break;
    }
    hull.push(q);
  }
  return hull;
}

/** Boxes around clusters of outlier points (handles, bonnets, side legs). */
function outlierBoxes(outliers, o, d, x, y, level, res) {
  if (!outliers.length) return [];
  const SECT = 8;
  const bySector = Array.from({ length: SECT }, () => []);
  for (const s of outliers) bySector[s.sector].push(s);
  // clusters = runs of neighbouring non-empty sectors (wrapping round)
  const clusters = [];
  const start = bySector.findIndex((b) => !b.length);
  if (start < 0) clusters.push(outliers);
  else {
    let cur = null;
    for (let k = 1; k <= SECT; k++) {
      const b = bySector[(start + k) % SECT];
      if (b.length) { if (!cur) { cur = []; clusters.push(cur); } cur.push(...b); } else cur = null;
    }
  }
  const boxes = [];
  for (const c of clusters) {
    let mx = 0, my = 0;
    for (const s of c) { mx += s.px; my += s.py; }
    const zr = norm(add(scale(x, mx), scale(y, my)));
    const bz = len(zr) > 0 ? zr : x;
    const by = cross(bz, d);
    const loc = c.map((s) => { const p = add(add(scale(d, s.h), scale(x, s.px)), scale(y, s.py)); return [s.h, dot(p, by), dot(p, bz)]; });
    const lo = [0, 1, 2].map((k) => Math.min(...loc.map((p) => p[k])));
    const hi = [0, 1, 2].map((k) => Math.max(...loc.map((p) => p[k])));
    lo[2] = Math.min(lo[2], 0); // reach down into the body so the box joins it
    const frame = { o, x: d, y: by, z: bz };
    const ext = sub(hi, lo);
    const axis = level === 'envelope' ? -1 : ext.indexOf(Math.max(...ext));
    const k = axis < 0 ? 1 : Math.max(1, Math.min(6, Math.ceil(ext[axis] / (4 * res))));
    if (k === 1) { boxes.push({ t: 'box', ...frame, min: lo, max: hi }); continue; }
    const slab = ext[axis] / k;
    for (let i = 0; i < k; i++) {
      const a = lo[axis] + i * slab, b = a + slab;
      const inside = loc.filter((p) => p[axis] >= a - 1e-6 && p[axis] <= b + 1e-6);
      if (!inside.length) continue;
      const mn = [0, 1, 2].map((j) => (j === axis ? a : Math.min(...inside.map((p) => p[j]))));
      const mxv = [0, 1, 2].map((j) => (j === axis ? b : Math.max(...inside.map((p) => p[j]))));
      if (axis !== 2) mn[2] = Math.min(mn[2], 0);
      boxes.push({ t: 'box', ...frame, min: mn, max: mxv });
    }
  }
  return boxes;
}

const distToSegment = (p, a, b) => {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return len(sub(p, add(a, scale(ab, t))));
};

/**
 * Simplified solids for one part.
 * @param mesh   {positions, indices, bbox} of the part
 * @param geom   {ends:[{o, d}], c}  from geometry.json
 * @param info   {ods:[end ODs]}
 */
export function wrapPart(mesh, geom, info, level = 'wrap', res = 5) {
  res = Math.max(0.5, Number(res) || 5);
  const ends = geom.ends.map((e) => ({ o: e.o, d: norm(e.d) }));
  const c = geom.c;
  const bb = mesh.bbox;
  const diag = len(sub(bb[1], bb[0])) || 1;
  const pts = samplePoints(mesh, Math.max(res / 2, diag / 300));
  const maxOd = Math.max(...(info.ods || []).filter((x) => x > 0), 1);

  // elbows: a ring segment when the bend is long enough, else legs
  if (ends.length === 2 && dot(ends[0].d, ends[1].d) > -0.95) {
    const [e1, e2] = ends;
    const parallel = dot(e1.d, e2.d) > 0.999;
    const T1 = len(sub(e1.o, c)), T2 = len(sub(e2.o, c));
    const b = parallel || Math.min(T1, T2) >= 0.9 * maxOd ? bend(pts, e1, e2, c, parallel) : null;
    if (b) return b;
    return legs(pts, ends, c, level, res);
  }
  if (ends.length >= 3) return legs(pts, ends, c, level, res);

  // inline and one-ended parts: one profile along the first end's axis
  const e = ends[0];
  const d = scale(e.d, -1);
  const prof = axisProfile(pts, e.o, d, level, res);
  if (!prof) return [];
  return [{ t: 'revolve', o: e.o, d, x: prof.x, pts: prof.pts }, ...outlierBoxes(prof.outliers, e.o, d, prof.x, prof.y, level, res)];
}

function legs(pts, ends, c, level, res) {
  // opposite ends on one line (a tee's run) make one leg from end to end, so
  // no two legs meet face to face at the centre (that upsets the merge)
  const segs = [];
  const used = new Set();
  ends.forEach((e, i) => {
    if (used.has(i)) return;
    const j = ends.findIndex((f, k) => k !== i && !used.has(k) && dot(e.d, f.d) < -0.999
      && len(sub(sub(f.o, e.o), scale(e.d, dot(sub(f.o, e.o), e.d)))) < 0.5);
    if (j >= 0) { used.add(i); used.add(j); segs.push({ a: e.o, b: ends[j].o, e }); } else { used.add(i); segs.push({ a: e.o, b: c, e }); }
  });
  const groups = segs.map(() => []);
  for (const p of pts) {
    let best = 0, bd = Infinity;
    segs.forEach((s, i) => { const dd = distToSegment(p, s.a, s.b); if (dd < bd) { bd = dd; best = i; } });
    groups[best].push(p);
  }
  const out = [];
  const radii = [];
  segs.forEach((s, i) => {
    const d = scale(s.e.d, -1);
    const L = dot(sub(s.b, s.a), d);
    const prof = axisProfile(groups[i], s.a, d, level, res, { outliers: false, hRange: [0, L] });
    if (!prof) return;
    // two equal cylinders meeting square on touch tangentially, which the
    // merge can't handle: make this leg 2% fatter than an equal earlier one
    let r = Math.max(...prof.pts.map((q) => q[1]));
    if (radii.some((x) => Math.abs(x - r) < 0.02 * x)) {
      const f = 1.02 * Math.max(...radii.filter((x) => Math.abs(x - r) < 0.02 * x)) / r;
      prof.pts = flatten(prof.pts.map(([h, q]) => [h, q * f]));
      r *= f;
    }
    radii.push(r);
    out.push({ t: 'revolve', o: s.a, d, x: prof.x, pts: prof.pts });
  });
  return out;
}

function bend(pts, e1, e2, V, parallel) {
  if (parallel) return bendWith(pts, e1, e2, V, true, 0);
  // the bend radius isn't the centre-to-end when the bend has straight
  // tangents: try radii and keep the one the part fits most tightly
  const T = Math.min(len(sub(e1.o, V)), len(sub(e2.o, V)));
  const theta = Math.acos(Math.max(-1, Math.min(1, -dot(e1.d, e2.d))));
  const sample = pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 400)) === 0);
  let best = null;
  for (let k = 1; k <= 20; k++) {
    const R = (T / Math.tan(theta / 2)) * (k / 20);
    const r = tubeRadius(sample, skeleton(e1, e2, V, R, theta));
    if (r < 0.98 * R && (!best || r < best.r - 1e-6)) best = { R, r };
  }
  return best ? bendWith(pts, e1, e2, V, false, best.R) : null; // too tight for a ring: use legs
}

/** Arc of radius R between the two ends' axes, plus the straight tangents. */
function skeleton(e1, e2, V, R, theta) {
  const t = R * Math.tan(theta / 2);
  const P1 = add(V, scale(e1.d, t)), P2 = add(V, scale(e2.d, t));
  const C = add(V, scale(norm(add(e1.d, e2.d)), Math.sqrt(t * t + R * R)));
  const x = norm(sub(P1, C));
  const n = norm(cross(x, scale(e1.d, -1)));
  const y = cross(n, x);
  const arcPt = (a) => add(C, add(scale(x, R * Math.cos(a)), scale(y, R * Math.sin(a))));
  const segs = [];
  const N = 24;
  for (let i = 0; i < N; i++) segs.push([arcPt((theta * i) / N), arcPt((theta * (i + 1)) / N)]);
  const T1 = len(sub(e1.o, V)), T2 = len(sub(e2.o, V));
  if (T1 - t > 0.1) segs.push([P1, e1.o]);
  if (T2 - t > 0.1) segs.push([P2, e2.o]);
  return { segs, C, n, x, R, P1, P2, t, T1, T2 };
}

function tubeRadius(pts, sk) {
  let r = 0;
  for (const p of pts) {
    let m = Infinity;
    for (const [a, b] of sk.segs) { const dd = distToSegment(p, a, b); if (dd < m) m = dd; }
    if (m > r) r = m;
  }
  return r;
}

function bendWith(pts, e1, e2, V, parallel, Rfit) {
  let C, R, x, n, angle, P1, P2, T1 = 0, T2 = 0, T = 0;
  if (parallel) { // 180° return bend
    C = scale(add(e1.o, e2.o), 0.5);
    R = len(sub(e1.o, C));
    x = norm(sub(e1.o, C));
    n = norm(cross(x, scale(e1.d, -1)));
    angle = Math.PI;
    P1 = e1.o; P2 = e2.o;
  } else {
    const theta = Math.acos(Math.max(-1, Math.min(1, -dot(e1.d, e2.d))));
    const sk = skeleton(e1, e2, V, Rfit, theta);
    ({ C, n, x, R, P1, P2, T1, T2 } = sk);
    T = sk.t;
    angle = theta;
  }
  // skeleton: arc + straight stubs; the tube radius encloses every sample
  const skel = [];
  const N = 24;
  const y = cross(n, x);
  const arcPt = (t) => add(C, add(scale(x, R * Math.cos(t)), scale(y, R * Math.sin(t))));
  for (let i = 0; i < N; i++) skel.push([arcPt((angle * i) / N), arcPt((angle * (i + 1)) / N)]);
  if (T1 - T > 0.1) skel.push([P1, e1.o]);
  if (T2 - T > 0.1) skel.push([P2, e2.o]);
  let r = 0;
  for (const p of pts) {
    let m = Infinity;
    for (const [a, b] of skel) { const dd = distToSegment(p, a, b); if (dd < m) m = dd; }
    if (m > r) r = m;
  }
  r = Math.min(r, R * 0.98);
  const out = [{ t: 'torus', c: C, n, x, R, r, angle }];
  if (T1 - T > 0.1) out.push({ t: 'cyl', o: P1, d: e1.d, r, L: T1 - T });
  if (T2 - T > 0.1) out.push({ t: 'cyl', o: P2, d: e2.d, r, L: T2 - T });
  return out;
}

// ------------------------------------------------------------ shrink-wrap
//
// The shrink-wrap keeps a part's real outer surfaces (cad.js shrinkWrap()):
// these helpers decide which solids are on the outside and which bores to fill.

/**
 * Which solids of a part can be seen from outside (the rest – balls, seats,
 * springs – are hidden inside the body and left out).
 * @param meshes one display mesh per solid
 * @returns [bool] per solid
 */
export function visibleSolids(meshes, { minFraction = 0.15, samples = 80 } = {}) {
  // all triangles, with a grid per axis for fast ray tests
  const tris = [];
  for (const m of meshes) {
    const P = m.positions, I = m.indices;
    for (let t = 0; t < I.length; t += 3) {
      tris.push([0, 1, 2].map((k) => [P[I[t + k] * 3], P[I[t + k] * 3 + 1], P[I[t + k] * 3 + 2]]));
    }
  }
  if (!tris.length) return meshes.map(() => true);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const p of t) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  const N = 48;
  const grids = [0, 1, 2].map((axis) => {
    const [a, b] = [0, 1, 2].filter((k) => k !== axis);
    const sa = (hi[a] - lo[a]) / N || 1, sb = (hi[b] - lo[b]) / N || 1;
    const cells = new Map();
    tris.forEach((t, i) => {
      const ia = t.map((p) => Math.floor((p[a] - lo[a]) / sa)), ib = t.map((p) => Math.floor((p[b] - lo[b]) / sb));
      for (let x = Math.max(0, Math.min(...ia)); x <= Math.min(N, Math.max(...ia)); x++) {
        for (let y = Math.max(0, Math.min(...ib)); y <= Math.min(N, Math.max(...ib)); y++) {
          const k = x * (N + 1) + y;
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push(i);
        }
      }
    });
    return { a, b, sa, sb, cells };
  });
  const escapes = (p, axis, sign) => {
    const g = grids[axis];
    const k = Math.floor((p[g.a] - lo[g.a]) / g.sa) * (N + 1) + Math.floor((p[g.b] - lo[g.b]) / g.sb);
    const d = [0, 0, 0];
    d[axis] = sign;
    for (const i of g.cells.get(k) || []) if (rayTriangle(p, d, tris[i]) > 1e-3 * (hi[axis] - lo[axis] + 1)) return false;
    return true;
  };
  // only a solid lying inside another's box can be hidden in it
  const boxes = meshes.map((m) => boxOf(m.positions));
  const insideAnother = (i) => boxes.some((b, j) => j !== i && b && boxes[i]
    && [0, 1, 2].every((k) => boxes[i][0][k] >= b[0][k] - 0.5 && boxes[i][1][k] <= b[1][k] + 0.5));
  return meshes.map((m, i) => {
    const n = m.positions.length / 3;
    if (!n) return false;
    if (!insideAnother(i)) return true;
    const step = Math.max(1, Math.floor(n / samples));
    let seen = 0, tested = 0;
    for (let v = 0; v < n; v += step) {
      const p = [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]];
      tested++;
      if ([0, 1, 2].some((ax) => escapes(p, ax, 1) || escapes(p, ax, -1))) seen++;
    }
    return seen / tested >= minFraction;
  });
}

function boxOf(P) {
  if (!P.length) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[i + k]); hi[k] = Math.max(hi[k], P[i + k]); }
  return [lo, hi];
}

function rayTriangle(o, d, [a, b, c]) {
  const e1 = sub(b, a), e2 = sub(c, a);
  const pv = cross(d, e2);
  const det = dot(e1, pv);
  if (Math.abs(det) < 1e-12) return -1;
  const tv = sub(o, a);
  const u = dot(tv, pv) / det;
  if (u < 0 || u > 1) return -1;
  const qv = cross(tv, e1);
  const v = dot(d, qv) / det;
  if (v < 0 || u + v > 1) return -1;
  return dot(e2, qv) / det;
}

/**
 * Solid cylinders that fill a part's bores and threads, from each end towards
 * the centre. Threads (female and male) are covered at 2% over their major
 * diameter; weld ends are filled to the middle of the wall. Bends are left
 * hollow (their bore is a smooth surface anyway).
 * @param geom  {ends:[{o, d, engage}], c}
 * @param ends  library.json ends ({end, od_mm, wall_mm, thread_od_mm})
 */
export function boreFillers(geom, ends, part = {}) {
  const out = [];
  const E = geom.ends.map((e) => ({ ...e, d: norm(e.d) }));
  const inline = E.length === 2 && dot(E[0].d, E[1].d) < -0.999;
  const bend = /elbow/.test(part.category || '') || (E.length === 2 && !inline);
  E.forEach((e, i) => {
    const info = ends[i] || {};
    const end = info.end || '';
    const od = info.od_mm || 0;
    const into = scale(e.d, -1);
    const toCentre = dot(sub(geom.c, e.o), into);
    let r, from = e.o, L;
    if (/BSP/.test(end)) {
      r = 1.02 * (info.thread_od_mm || od) / 2;
      L = toCentre;
      if (/male/.test(end) && !/female/.test(end)) { from = add(e.o, scale(e.d, e.engage || 0)); L = toCentre + (e.engage || 0); }
    } else if (bend || /cap|plug/.test(part.category || '')) {
      return;
    } else if (/flange|wafer|lugged|slip-on/.test(end)) {
      // a flange's bore is a little over the pipe; a flanged valve's body can be
      // narrower than the pipe further in, so fill well inside it
      r = /valve|strainer/.test(part.category || '') ? 0.4 * od : od / 2 + 1.5; L = toCentre;
    } else {
      r = od / 2 - (info.wall_mm || od * 0.05) / 2; L = toCentre;
    }
    if (!(r > 0) || !(L > 0.5)) return;
    out.push({ t: 'cyl', o: from, d: into, r, L: L + (inline ? 0.5 : 0) });
  });
  return out;
}
