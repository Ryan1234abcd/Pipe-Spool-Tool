// CAD kernel tests: run the same OpenCascade WebAssembly build the browser uses,
// on the demo parts in library/Demo (a copy of a few Part-Library parts).
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'replicad-opencascadejs';
import { Cad, compactStep } from '../web/js/cad.js';
import { wrapPart, visibleSolids, boreFillers } from '../web/js/wrap.js';
import { solve, pipePorts } from '../web/js/kinematics.js';
import { locateEnds } from '../scripts/ends.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DEMO = path.join(ROOT, 'library', 'Demo');
const lib = JSON.parse(fs.readFileSync(path.join(DEMO, 'library.json'), 'utf8'));
const geo = JSON.parse(fs.readFileSync(path.join(DEMO, 'geometry.json'), 'utf8')).parts;
const oc = await Module({ print: () => {}, printErr: () => {} });
const cad = new Cad(oc);

const shapes = new Map();
function load(id) {
  if (!shapes.has(id)) {
    const shape = cad.readStep(fs.readFileSync(path.join(DEMO, lib.parts[id].files.step)));
    shapes.set(id, { shape, mesh: cad.mesh(shape) });
  }
  return shapes.get(id);
}
const near = (a, b, tol = 0.05) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('end finding reproduces geometry.json for every demo part', () => {
  for (const id of Object.keys(lib.parts)) {
    const { shape, mesh } = load(id);
    const res = locateEnds(lib.parts[id], cad.circles(shape), mesh);
    assert.ok(res, `${id}: no match`);
    res.ends.forEach((e, i) => {
      assert.ok(near(e.origin, geo[id].ends[i].o), `${id} end ${i} origin ${e.origin} != ${geo[id].ends[i].o}`);
      assert.ok(near(e.dir, geo[id].ends[i].d, 1e-3), `${id} end ${i} direction`);
    });
    assert.ok(near(res.centre, geo[id].c), `${id} centre`);
  }
});

test('long-radius 90° elbow: centre to end is 1.5 × nominal size (ASME B16.9)', () => {
  const g = geo.SPB5090S10;
  for (const e of g.ends) {
    const c2e = e.d.reduce((s, d, k) => s + d * (e.o[k] - g.c[k]), 0);
    assert.ok(Math.abs(c2e - 76.2) < 0.05, `c2e ${c2e}`);
  }
});

/** Is point p inside the closed triangle mesh (ray parity, majority of 3 rays)? */
function inside(mesh, p) {
  const P = mesh.positions, I = mesh.indices;
  let votes = 0;
  for (const d of [[0.577, 0.577, 0.577], [-0.3, 0.8, -0.52], [0.9, -0.2, 0.39]]) {
    let n = 0;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
      const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      const pv = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
      const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
      if (Math.abs(det) < 1e-12) continue;
      const tv = [p[0] - P[a], p[1] - P[a + 1], p[2] - P[a + 2]];
      const u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) / det;
      if (u < 0 || u > 1) continue;
      const qv = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
      const v = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) / det;
      if (v < 0 || u + v > 1) continue;
      if ((e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) / det > 1e-6) n++;
    }
    if (n % 2) votes++;
  }
  return votes >= 2;
}

/** Distance from p to the nearest triangle of the mesh. */
function surfaceDistance(mesh, p) {
  const P = mesh.positions, I = mesh.indices;
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dt = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const at = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const tri = (a, b, c) => { // closest point on triangle (Ericson, Real-Time Collision Detection 5.1.5)
    const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    const d1 = dt(ab, ap), d2 = dt(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a;
    const bp = sub(p, b), d3 = dt(ab, bp), d4 = dt(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b;
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(a, b, d1 / (d1 - d3));
    const cp = sub(p, c), d5 = dt(ab, cp), d6 = dt(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c;
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(a, c, d2 / (d2 - d6));
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return at(b, c, (d4 - d3) / (d4 - d3 + d5 - d6));
    const den = 1 / (va + vb + vc);
    return [0, 1, 2].map((k) => a[k] + ab[k] * vb * den + ac[k] * vc * den);
  };
  let best = Infinity;
  for (let t = 0; t < I.length; t += 3) {
    const v = [I[t], I[t + 1], I[t + 2]].map((i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
    const q = tri(...v);
    best = Math.min(best, Math.hypot(...sub(p, q)));
  }
  return best;
}

test('shrink-wrap and envelope enclose the part, as one small valid solid', () => {
  for (const id of ['SPB5090S10', 'SPRT5040S10', 'SPCR5040S10', 'SPF50E', 'CILBV50DE', 'CIWCV50']) {
    const { shape, mesh } = load(id);
    const full = cad.writeStep(shape).length;
    for (const [level, res] of [['envelope', 5], ['wrap', 3], ['wrap', 20]]) {
      const prims = wrapPart(mesh, geo[id], { ods: lib.parts[id].ends.map((e) => e.od_mm) }, level, res);
      const s = cad.buildPrimitives(prims);
      assert.ok(cad.isValid(s), `${id} ${level}${res} invalid`);
      assert.equal(cad.count(s), 1, `${id} ${level}${res} solids`);
      const bytes = cad.writeStep(s).length;
      assert.ok(bytes < full * 0.5, `${id} ${level}${res}: ${bytes} bytes vs ${full} full`);
      // every model vertex inside the wrap, or on its surface (within 0.3 mm)
      const wm = cad.mesh(s, 0.2);
      const P = mesh.positions;
      const step = Math.max(3, Math.floor(P.length / 3 / 300) * 3);
      for (let i = 0; i < P.length; i += step) {
        const p = [P[i], P[i + 1], P[i + 2]];
        if (!inside(wm, p)) {
          const d = surfaceDistance(wm, p);
          assert.ok(d < 0.3, `${id} ${level}${res}: point ${p.map((v) => v.toFixed(1))} is ${d.toFixed(2)} mm outside`);
        }
      }
    }
  }
});

test('a finer resolution gives a closer fit', () => {
  const { mesh } = load('CILBV50DE');
  const vol = (res) => cad.volume(cad.buildPrimitives(wrapPart(mesh, geo.CILBV50DE, { ods: [60.3, 60.3] }, 'wrap', res)));
  const env = cad.volume(cad.buildPrimitives(wrapPart(mesh, geo.CILBV50DE, { ods: [60.3, 60.3] }, 'envelope', 5)));
  assert.ok(vol(2) < vol(25), 'res 2 should be tighter than res 25');
  assert.ok(vol(25) <= env * 1.01, 'shrink-wrap no bigger than envelope');
});

test('elbow + pipe + flange fuse into one valid solid that survives STEP', () => {
  const p = (id) => ({ ...lib.parts[id], ports: geo[id].ends.map((e, i) => ({ name: String(i), origin: e.o, dir: e.d, up: e.u, od: lib.parts[id].ends[i].od_mm })) });
  const elbow = p('SPB5090S10');
  const nodes = [
    { id: 'e', type: 'part', part: 'SPB5090S10', port: '0' },
    { id: 'p', type: 'pipe', od: 60.3, length: 300, port: 'A', parent: 'e', parentPort: '1' },
    { id: 'e2', type: 'part', part: 'SPB5090S10', port: '0', parent: 'p', parentPort: 'B', roll: 90 },
  ];
  const { placed, errors } = solve(nodes, (n) => (n.type === 'pipe' ? pipePorts(n.od, n.length) : elbow.ports));
  assert.deepEqual(errors, []);
  const { shape } = load('SPB5090S10');
  const items = [
    cad.place(shape, placed.get('e').matrix),
    cad.place(cad.makePipe(60.3, 0, 300), placed.get('p').matrix),
    cad.place(shape, placed.get('e2').matrix),
  ];
  const f = cad.fuse(items);
  assert.ok(f.ok);
  assert.equal(cad.count(f.shape), 1);
  const back = cad.readStep(cad.writeStep(f.shape, 'Test'));
  assert.ok(Math.abs(cad.volume(back) - cad.volume(f.shape)) / cad.volume(f.shape) < 1e-3);
});

test('shrink-wrap keeps the real outside of a valve as one lighter solid', () => {
  const id = 'CILBV50DE';
  const { shape } = load(id);
  const solids = cad.solids(shape);
  const keep = visibleSolids(solids.map((so) => cad.mesh(so)));
  assert.ok(keep.some((k) => !k) || solids.length === 1, 'some hidden inner piece is left out');
  const s = cad.shrinkWrap(shape, keep, boreFillers(geo[id], lib.parts[id].ends, lib.parts[id]), 5);
  assert.ok(s, 'built');
  assert.ok(cad.isValid(s));
  assert.ok(cad.count(s, 'TopAbs_FACE') < cad.count(shape, 'TopAbs_FACE'), 'fewer faces');
  // same overall size as the real valve (it is not an envelope)
  const a = cad.bbox(shape), b = cad.bbox(s);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs((a[1][k] - a[0][k]) - (b[1][k] - b[0][k])) < 1, `extent ${k}`);
});

test('STEP files are written compactly and read back the same', () => {
  const { shape } = load('SPF50E');
  const bytes = cad.writeStep(shape, 'Flange');
  const text = new TextDecoder().decode(bytes);
  assert.ok(!/PCURVE/.test(text), 'no 2D edge copies');
  assert.ok(!/\d\.\d{11,}/.test(text.slice(text.indexOf('DATA;'))), 'numbers rounded (not 15 digits)');
  const back = cad.readStep(bytes);
  assert.ok(Math.abs(cad.volume(back) - cad.volume(shape)) / cad.volume(shape) < 1e-4);
  assert.equal(new TextDecoder().decode(compactStep(bytes)).length, text.length, 'idempotent');
});
