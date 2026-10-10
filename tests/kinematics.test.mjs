// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { solve, openPorts, pipePorts, applyPoint } from '../web/js/kinematics.js';

const close = (a, b, msg) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-6, `${msg}: ${a} != ${b}`));

const elbow = (R) => [
  { name: 'A', origin: [0, 0, 0], dir: [-1, 0, 0], up: [0, 0, 1], size: 'DN50' },
  { name: 'B', origin: [R, R, 0], dir: [0, 1, 0], up: [0, 0, 1], size: 'DN50' },
];

function portsOf(n) {
  if (n.type === 'pipe') return pipePorts(n.size, n.length);
  if (n.type === 'elbow90') return elbow(76);
  // valve modelled along Y like a manufacturer download
  if (n.type === 'valve') return [
    { name: 'A', origin: [0, -89, 0], dir: [0, -1, 0], up: [0, 0, 1], size: 'DN50' },
    { name: 'B', origin: [0, 89, 0], dir: [0, 1, 0], up: [0, 0, 1], size: 'DN50' },
  ];
  return null;
}

test('straight run: pipe + pipe', () => {
  const nodes = [
    { id: 'a', type: 'pipe', size: 'DN50', length: 500, port: 'A', startDir: '+X' },
    { id: 'b', type: 'pipe', size: 'DN50', length: 300, port: 'A', parent: 'a', parentPort: 'B' },
  ];
  const { placed, errors } = solve(nodes, portsOf);
  assert.equal(errors.length, 0);
  close(placed.get('b').ports[1].origin, [800, 0, 0], 'end of run');
});

test('elbow roll turns the branch', () => {
  const base = [
    { id: 'a', type: 'pipe', size: 'DN50', length: 500, port: 'A', startDir: '+X' },
    { id: 'e', type: 'elbow90', size: 'DN50', port: 'A', parent: 'a', parentPort: 'B', roll: 0 },
  ];
  let r = solve(base, portsOf);
  // roll 0: elbow turns towards local +Y. With up=+Z and dir=+X, local Y maps to world +Y.
  close(r.placed.get('e').ports[1].origin, [576, 76, 0], 'roll 0');
  close(r.placed.get('e').ports[1].dir, [0, 1, 0], 'roll 0 dir');
  base[1].roll = 90;
  r = solve(base, portsOf);
  close(r.placed.get('e').ports[1].dir, [0, 0, 1], 'roll 90 turns up (right hand about flow)');
  base[1].roll = -90;
  r = solve(base, portsOf);
  close(r.placed.get('e').ports[1].dir, [0, 0, -1], 'roll -90 turns down');
});

test('valve along Y keeps its stem up when inline on an X run', () => {
  const nodes = [
    { id: 'a', type: 'pipe', size: 'DN50', length: 100, port: 'A', startDir: '+X' },
    { id: 'v', type: 'valve', size: 'DN50', port: 'A', parent: 'a', parentPort: 'B', gap: 3 },
  ];
  const { placed } = solve(nodes, portsOf);
  const M = placed.get('v').matrix;
  close(applyPoint(M, [0, 0, 50]), [103 + 89, 0, 50], 'stem stays up');
  close(placed.get('v').ports[1].origin, [103 + 178, 0, 0], 'outlet');
});

test('vertical start and open ports', () => {
  const nodes = [
    { id: 'a', type: 'pipe', size: 'DN50', length: 250, port: 'A', startDir: '+Z' },
    { id: 'e', type: 'elbow90', size: 'DN50', port: 'A', parent: 'a', parentPort: 'B' },
  ];
  const { placed } = solve(nodes, portsOf);
  close(placed.get('a').ports[1].origin, [0, 0, 250], 'riser');
  const open = openPorts(nodes, placed).map((o) => `${o.nodeId}:${o.port.name}`);
  assert.deepEqual(open.sort(), ['a:A', 'e:B']);
});

test('size mismatch is reported', () => {
  const nodes = [
    { id: 'a', type: 'pipe', size: 'DN80', length: 250, port: 'A' },
    { id: 'b', type: 'pipe', size: 'DN50', length: 250, port: 'A', parent: 'a', parentPort: 'B' },
  ];
  const { errors } = solve(nodes, portsOf);
  assert.equal(errors[0].kind, 'size');
});
