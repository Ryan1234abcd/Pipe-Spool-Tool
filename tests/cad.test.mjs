// CAD kernel tests: run the same OpenCascade WebAssembly build the browser uses.
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'replicad-opencascadejs';
import { Cad } from '../web/js/cad.js';
import { detectPorts } from '../web/js/detect.js';
import { PIPE_TYPES, pipeType, sizeForOd } from '../web/js/pipe-types.js';
import { solve, pipePorts } from '../web/js/kinematics.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SAMPLES = path.join(ROOT, 'library', 'Samples');
const oc = await Module({ print: () => {}, printErr: () => {} });
const cad = new Cad(oc);
const steel = pipeType('en10255-m');

function sampleFiles() {
  const out = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.stp$/i.test(e.name)) out.push(p);
  });
  walk(SAMPLES);
  return out;
}

test('pipe types are the seven offered', () => {
  assert.deepEqual(PIPE_TYPES.map((t) => t.name), [
    'Steel · medium (EN 10255)', 'Copper · Table X (EN 1057)', 'PE-X / PE-RT · SDR 7.4',
    'Stainless press-fit (EN 10312)', 'Stainless Sch 10S (ASTM A312)', 'Stainless Sch 40S (ASTM A312)', 'Dairy tube (AS 1528.1)',
  ]);
  for (const t of PIPE_TYPES) for (const s of t.sizes) assert.ok(s.od > 2 * s.wall && s.wall > 0, `${t.name} ${s.label}`);
  assert.equal(sizeForOd(steel, 60.3).label, 'DN50');
});

test('detects the two flange faces of the sample ball valve', () => {
  const shape = cad.readStep(fs.readFileSync(path.join(SAMPLES, 'Valves/Ball_valve_flanged_DN50.stp')));
  const mesh = cad.mesh(shape);
  const likely = detectPorts(cad.circles(shape), mesh, steel).filter((c) => c.likely && c.od === 60.3);
  assert.equal(likely.length, 2);
  assert.deepEqual(likely.map((c) => c.origin[1]).sort((a, b) => a - b), [-89, 89]);
  assert.ok(likely.every((c) => c.od === 60.3));
});

test('every sample part set-up matches a detected connection', () => {
  for (const file of sampleFiles()) {
    const meta = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'));
    const shape = cad.readStep(fs.readFileSync(file));
    const cands = detectPorts(cad.circles(shape), cad.mesh(shape), steel);
    for (const p of meta.ports) {
      const hit = cands.find((c) => Math.hypot(...c.origin.map((v, i) => v - p.origin[i])) < 0.5);
      assert.ok(hit, `${path.basename(file)} port ${p.name} not detected`);
      assert.ok(Math.hypot(...hit.dir.map((v, i) => v - p.dir[i])) < 1e-3, `${path.basename(file)} port ${p.name} direction`);
    }
  }
});

test('pipe + elbow + valve fuse into one valid solid that survives STEP', () => {
  const lib = (f) => ({ shape: cad.readStep(fs.readFileSync(path.join(SAMPLES, f))), meta: JSON.parse(fs.readFileSync(path.join(SAMPLES, `${f}.json`), 'utf8')) });
  const elbow = lib('Fittings/Elbow_90_LR_DN50.stp');
  const valve = lib('Valves/Globe_valve_weld_DN50.stp');
  const s = sizeForOd(steel, 60.3);
  const nodes = [
    { id: 'p1', type: 'pipe', length: 300, port: 'A' },
    { id: 'e', type: 'elbow', port: 'A', parent: 'p1', parentPort: 'B', roll: 90 },
    { id: 'p2', type: 'pipe', length: 200, port: 'A', parent: 'e', parentPort: 'B' },
    { id: 'v', type: 'valve', port: 'A', parent: 'p2', parentPort: 'B' },
  ];
  const portsOf = (n) => (n.type === 'pipe' ? pipePorts(s.od, n.length) : n.type === 'elbow' ? elbow.meta.ports : valve.meta.ports);
  const { placed, errors } = solve(nodes, portsOf);
  assert.deepEqual(errors, []);
  const shapes = nodes.map((n) => {
    const m = placed.get(n.id).matrix;
    const base = n.type === 'pipe' ? cad.makePipe(s.od, s.od - 2 * s.wall, n.length) : n.type === 'elbow' ? elbow.shape : valve.shape;
    return cad.place(base, m);
  });
  const fused = cad.fuse(shapes);
  assert.ok(fused.ok);
  assert.equal(cad.count(fused.shape), 1);
  const bytes = cad.writeStep(fused.shape, 'Test');
  assert.match(new TextDecoder().decode(bytes.slice(0, 20)), /^ISO-10303-21/);
  const back = cad.readStep(bytes);
  assert.ok(cad.isValid(back));
  assert.equal(cad.count(back), 1);
  // the riser goes up (+Z) after the rolled elbow
  const bb = cad.bbox(back);
  assert.ok(bb[1][2] > 200 + 70, `top ${bb[1][2]}`);
});
