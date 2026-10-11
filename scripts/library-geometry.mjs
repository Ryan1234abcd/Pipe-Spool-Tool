// Works out where every part's ends are in its STEP model, for Part-Library.
//
//   node scripts/library-geometry.mjs ../Part-Library [part ids…]
//
// Writes <library>/geometry.json: { id: { ends:[{o, d, u, engage?}], c } } in the
// model's own coordinates (mm), ends in the same order as library.json. Parts
// listed in <library>/geometry-overrides.json are taken from there instead.
// Prints the parts whose match looks doubtful so they can be checked.
import fs from 'node:fs';
import path from 'node:path';
import Module from 'replicad-opencascadejs';
import { Cad } from '../web/js/cad.js';
import { locateEnds } from './ends.mjs';

const dir = path.resolve(process.argv[2] || '../Part-Library');
const only = process.argv.slice(3);
const lib = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'));
const outFile = path.join(dir, 'geometry.json');
const overridesFile = path.join(dir, 'geometry-overrides.json');
const overrides = fs.existsSync(overridesFile) ? JSON.parse(fs.readFileSync(overridesFile, 'utf8')) : {};
const previous = only.length && fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')).parts : {};

const oc = await Module({ print: () => {}, printErr: () => {} });
const cad = new Cad(oc);
const r = (v) => v.map((x) => Math.round(x * 100) / 100 || 0);
const r6 = (v) => v.map((x) => Math.round(x * 1e6) / 1e6 || 0);

// valves whose handle can be shown open or closed: the solids that turn with
// it (lever, nut, stem, ball or disc) and the stem axis they turn about
const HANDLE_TYPES = ['ball-2pc', 'ball-3pc', 'butterfly-lugged'];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function findHandle(shape, res, p) {
  const solids = cad.solids(shape);
  if (solids.length < 2) return null;
  const vols = solids.map((so) => cad.volume(so));
  const body = vols.indexOf(Math.max(...vols));
  const meshes = solids.map((so) => cad.mesh(so).positions);
  const c = res.centre;
  const run = res.ends[0].dir;
  // stem: the principal axis square to the run that most separate pieces sit on
  // beyond the body (stem, nut, hub, lever) – not the one a long lever points along
  const od0 = p.ends[0].od_mm || 50;
  const rho0 = Math.max(4, 0.15 * od0);
  let best = null;
  for (const ax of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    if (Math.abs(dot(ax, run)) > 0.5) continue;
    for (const sg of [1, -1]) {
      const d = ax.map((v) => v * sg);
      let hits = 0, reach = 0;
      meshes.forEach((P, i) => {
        if (i === body) return;
        for (let k = 0; k < P.length; k += 3) {
          const v = [P[k] - c[0], P[k + 1] - c[1], P[k + 2] - c[2]];
          const h = dot(v, d);
          if (h > 0.6 * od0 && Math.hypot(v[0] - d[0] * h, v[1] - d[1] * h, v[2] - d[2] * h) < rho0) { hits++; reach = Math.max(reach, h); break; }
        }
      });
      if (!best || hits > best.hits || (hits === best.hits && reach > best.reach)) best = { d, hits, reach };
    }
  }
  if (!best) return null;
  const od = p.ends[0].od_mm || 50;
  const rho = Math.max(4, 0.15 * od);
  const turn = [];
  meshes.forEach((P, i) => {
    if (i === body) return;
    for (let k = 0; k < P.length; k += 3) {
      const v = [P[k] - c[0], P[k + 1] - c[1], P[k + 2] - c[2]];
      const h = dot(v, best.d);
      const rr = Math.hypot(v[0] - best.d[0] * h, v[1] - best.d[1] * h, v[2] - best.d[2] * h);
      if (h > -0.3 * od && rr < rho) { turn.push(i); return; }
    }
  });
  // plus whatever touches those (a lever's grip, a latch plate), but never the body
  const sample = (P) => { const out = []; const step = Math.max(1, Math.floor(P.length / 3 / 600)); for (let k = 0; k < P.length; k += 3 * step) out.push([P[k], P[k + 1], P[k + 2]]); return out; };
  const pts = meshes.map(sample);
  const touches = (i, j) => pts[i].some((a) => pts[j].some((b) => Math.abs(a[0] - b[0]) < 1 && Math.abs(a[1] - b[1]) < 1 && Math.abs(a[2] - b[2]) < 1));
  for (let grew = true; grew;) {
    grew = false;
    meshes.forEach((_, i) => {
      if (i === body || turn.includes(i)) return;
      if (turn.some((j) => touches(i, j))) { turn.push(i); grew = true; }
    });
  }
  turn.sort((a, b) => a - b);
  return turn.length ? { o: c, d: best.d, turn } : null;
}

const parts = { ...previous };
const doubtful = [];
const ids = only.length ? only : Object.keys(lib.parts);
let n = 0;
for (const id of ids) {
  const p = lib.parts[id];
  n++;
  if (overrides[id]) { parts[id] = overrides[id]; continue; }
  try {
    const shape = cad.readStep(fs.readFileSync(path.join(dir, p.files.step)));
    const mesh = cad.mesh(shape);
    const res = locateEnds(p, cad.circles(shape), mesh);
    const handle = res && HANDLE_TYPES.includes(p.type) ? findHandle(shape, res, p) : null;
    shape.delete?.();
    if (!res) { doubtful.push([id, 'no match']); continue; }
    parts[id] = {
      ends: res.ends.map((e) => ({ o: r(e.origin), d: r6(e.dir), u: r6(e.up), ...(e.engage ? { engage: e.engage } : {}) })),
      c: r(res.centre),
      bbox: mesh.bbox.map(r),
      ...(handle ? { stem: { o: r(handle.o), d: r6(handle.d) }, turn: handle.turn } : {}),
    };
    if (HANDLE_TYPES.includes(p.type) && !handle) doubtful.push([id, 'no handle found']);
    if (res.cost > 1.5 || res.notes.length) doubtful.push([id, `cost ${res.cost.toFixed(2)} ${res.notes.join(', ')}`]);
  } catch (e) {
    doubtful.push([id, `error: ${e.message || e}`]);
  }
  if (n % 50 === 0) process.stderr.write(`${n}/${ids.length}\n`);
}

const sorted = Object.fromEntries(Object.keys(lib.parts).filter((id) => parts[id]).map((id) => [id, parts[id]]));
const head = JSON.stringify({ schema_version: 1, units: 'mm', generated_by: 'Pipe-Spool-Tool scripts/library-geometry.mjs' }).slice(0, -1);
const rows = Object.entries(sorted).map(([id, v]) => `  ${JSON.stringify(id)}: ${JSON.stringify(v)}`);
fs.writeFileSync(outFile, `${head},\n "parts": {\n${rows.join(',\n')}\n }\n}\n`); // one part per line, for readable diffs
console.log(`${Object.keys(sorted).length} of ${Object.keys(lib.parts).length} parts written to ${outFile}`);
if (doubtful.length) {
  console.log(`\nCheck these ${doubtful.length}:`);
  for (const [id, why] of doubtful) console.log(`  ${id}  ${lib.parts[id].type}  ${why}`);
}
