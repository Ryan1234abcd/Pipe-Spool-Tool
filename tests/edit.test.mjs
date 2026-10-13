// Editing the line: remove and close the gap, move up/down, insert, align.
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { solve, pipePorts } from '../web/js/kinematics.js';
import { removeNode, moveNode, insertChain, alignFix } from '../web/js/edit.js';

const OD = 60.3;
const inl = (L, fa, fb, extra = {}) => [
  { name: '0', origin: [-L / 2, 0, 0], dir: [-1, 0, 0], up: [0, 0, 1], od: OD, family: fa, ...extra },
  { name: '1', origin: [L / 2, 0, 0], dir: [1, 0, 0], up: [0, 0, 1], od: OD, family: fb, ...extra },
];
const PARTS = {
  valve: inl(100, 'weld', 'weld'), // a weld-end valve, 100 mm face to face
  valveB: inl(60, 'weld', 'weld'),
  nip: inl(40, 'weld', 'bspM'),
  bsp: inl(80, 'bspF', 'bspF', { engage: 15 }),
  elbow: [
    { name: '0', origin: [0, 0, 0], dir: [-1, 0, 0], up: [0, 0, 1], od: OD, family: 'weld' },
    { name: '1', origin: [76, 76, 0], dir: [0, 1, 0], up: [0, 0, 1], od: OD, family: 'weld' },
  ],
};
const CENTRE = { elbow: [76, 0, 0] };
const portsOf = (n) => (n.type === 'pipe'
  ? pipePorts(n.od, Math.max(n.cut || 0, 0)).map((p) => ({ ...p, family: 'pipe', threaded: !!n.threaded }))
  : PARTS[n.part]);
const ctxOf = (nodes) => {
  const { placed, errors } = solve(nodes, portsOf);
  assert.deepEqual(errors, []);
  return { nodes, portsOf, placed, centreOf: (n) => { const e = placed.get(n.id); const c = CENTRE[n.part] || [0, 0, 0]; return [0, 1, 2].map((i) => e.matrix[i][0] * c[0] + e.matrix[i][1] * c[1] + e.matrix[i][2] * c[2] + e.matrix[i][3]); } };
};
const apply = (res) => res.nodes.map((n) => (res.cuts.has(n.id) ? { ...n, cut: res.cuts.get(n.id) } : n));
const where = (nodes, id, port) => solve(nodes, portsOf).placed.get(id).ports.find((p) => p.name === port).origin;
const near = (a, b, msg) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-6, `${msg}: ${a} != ${b}`));
const pipe = (id, parent, parentPort, cut, more = {}) => ({ id, type: 'pipe', od: OD, wall: 2.77, port: 'A', parent, parentPort, cut, dim: { mode: 'cc', value: 0 }, ...more });
const part = (id, p, parent, parentPort, port = '0', more = {}) => ({ id, type: 'part', part: p, port, roll: 0, parent, parentPort, ...more });

test('removing the first fitting keeps the rest where it was', () => {
  const nodes = [part('v', 'valve'), pipe('p1', 'v', '1', 200), part('e', 'elbow', 'p1', 'B'), pipe('p2', 'e', '1', 100)];
  const before = where(nodes, 'p2', 'B');
  const res = removeNode(ctxOf(nodes), 'v');
  const after = apply(res);
  assert.equal(after.length, 3);
  assert.ok(!after.find((n) => n.id === 'p1').parent, 'the pipe is the new start');
  near(where(after, 'p2', 'B'), before, 'far end');
});

test('removing a valve between two pipes merges them, the far side unmoved', () => {
  const nodes = [pipe('p1', undefined, undefined, 200), part('v', 'valve', 'p1', 'B'), pipe('p2', 'v', '1', 300), part('e', 'elbow', 'p2', 'B')];
  const before = where(nodes, 'e', '1');
  const res = removeNode(ctxOf(nodes), 'v');
  assert.equal(res.cuts.get('p1'), 600);
  const after = apply(res);
  assert.deepEqual(after.map((n) => n.id), ['p1', 'e']);
  near(where(after, 'e', '1'), before, 'elbow outlet');
});

test('removing a 0 mm pipe joins the parts either side straight together', () => {
  const nodes = [part('v', 'valve'), pipe('p0', 'v', '1', 0), part('n', 'nip', 'p0', 'B')];
  const after = apply(removeNode(ctxOf(nodes), 'p0'));
  const n = after.find((x) => x.id === 'n');
  assert.equal(n.parent, 'v');
  assert.equal(n.parentPort, '1');
});

test('removing an elbow leaves what was beyond as its own run, where it was', () => {
  const nodes = [pipe('p1', undefined, undefined, 200), part('e', 'elbow', 'p1', 'B'), pipe('p2', 'e', '1', 300)];
  const before = where(nodes, 'p2', 'B');
  const res = removeNode(ctxOf(nodes), 'e');
  const after = apply(res);
  const p2 = after.find((x) => x.id === 'p2');
  assert.ok(p2.fix && !p2.parent);
  assert.match(res.msg, /separate run/);
  near(where(after, 'p2', 'B'), before, 'loose run unmoved');
});

test('moving a valve up the line swaps it with the one before', () => {
  const nodes = [pipe('p1', undefined, undefined, 200), part('a', 'valve', 'p1', 'B'), pipe('p2', 'a', '1', 300), part('b', 'valveB', 'p2', 'B'), pipe('p3', 'b', '1', 100)];
  const after = apply(moveNode(ctxOf(nodes), 'b', -1));
  assert.equal(after.find((n) => n.id === 'a').part, 'valveB', 'first slot now holds the other valve');
  assert.equal(after.find((n) => n.id === 'b').part, 'valve');
  assert.equal(solve(after, portsOf).errors.length, 0);
  assert.throws(() => moveNode(ctxOf(nodes), 'a', -1), /first fitting/);
});

test("a weld nipple and a BSP valve can't swap (the valve can't weld to the pipe)", () => {
  const nodes = [pipe('p1', undefined, undefined, 200), part('n', 'nip', 'p1', 'B'), part('v', 'bsp', 'n', '1')];
  assert.throws(() => moveNode(ctxOf(nodes), 'v', -1), /can't swap/);
});

test('inserting a valve into a pipe splits it, the far side unmoved', () => {
  const nodes = [pipe('p1', undefined, undefined, 400), part('e', 'elbow', 'p1', 'B')];
  const before = where(nodes, 'e', '1');
  let k = 0;
  const res = insertChain(ctxOf(nodes), { pipe: 'p1' }, [{ part: 'valve', port: '0', run: '1' }], () => `x${k++}`);
  assert.equal(res.cuts.get('p1'), 150);
  const after = apply(res);
  const p2 = after.find((n) => n.type === 'pipe' && n.id !== 'p1');
  assert.equal(res.cuts.get(p2.id), 150);
  assert.equal(after.find((n) => n.id === 'e').parent, p2.id);
  near(where(after, 'e', '1'), before, 'elbow outlet');
  assert.throws(() => insertChain(ctxOf(nodes), { pipe: 'p1' }, Array(5).fill({ part: 'valve', port: '0', run: '1' }), () => `y${k++}`), /Not enough room/);
});

test('inserting after a fitting shortens the next pipe so the rest stays put', () => {
  const nodes = [part('v', 'valve'), pipe('p1', 'v', '1', 300), part('e', 'elbow', 'p1', 'B')];
  const before = where(nodes, 'e', '1');
  let k = 0;
  const res = insertChain(ctxOf(nodes), { node: 'v', port: '1' }, [{ part: 'valveB', port: '0', run: '1' }], () => `x${k++}`);
  assert.equal(res.cuts.get('p1'), 240);
  near(where(apply(res), 'e', '1'), before, 'elbow outlet');
});

test('align: a pipe along the axis takes up the difference', () => {
  const nodes = [
    part('v1', 'valve', undefined, undefined, '0', { startDir: '+X' }), pipe('pa', 'v1', '1', 300), part('v2', 'valve', 'pa', 'B'),
    pipe('pb', undefined, undefined, 200, { fix: { origin: [0, 500, 0], dir: [1, 0, 0], up: [0, 0, 1] } }), part('v3', 'valve', 'pb', 'B'),
  ];
  const ctx = ctxOf(nodes);
  const fixd = alignFix(ctx, { id: 'v3', at: 'centre', ref: 'v2', refAt: 'centre', axis: 'X' });
  assert.equal(fixd.pipe, 'pb');
  assert.ok(Math.abs(fixd.cut - 400) < 1e-6, `cut ${fixd.cut}`);
  const after = nodes.map((n) => (n.id === 'pb' ? { ...n, cut: fixd.cut } : n));
  const c = (id) => solve(after, portsOf).placed.get(id).matrix.map((r) => r[3]);
  assert.ok(Math.abs(c('v3')[0] - c('v2')[0]) < 1e-6, 'same X');
  assert.throws(() => alignFix(ctx, { id: 'v3', at: 'centre', ref: 'v2', refAt: 'centre', axis: 'Z' }), /No pipe along Z/);
  // end faces too
  const f = alignFix(ctx, { id: 'v3', at: '1', ref: 'v2', refAt: '0', axis: 'X' });
  assert.ok(Math.abs(f.cut - 300) < 1e-6, `cut ${f.cut}`);
});
