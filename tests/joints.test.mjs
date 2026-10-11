// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { endFamily, directJoin, joinOptions, pipeFor, cutLength, dimFromCut, centreToEnd } from '../web/js/joints.js';

const end = (end, od, extra = {}) => ({ name: extra.name || '0', end, family: endFamily(end), od, ...extra });

test('end families from library.json end text', () => {
  assert.equal(endFamily('butt-weld'), 'weld');
  assert.equal(endFamily('slip-on (fillet weld)'), 'weld');
  assert.equal(endFamily('butt-weld (RJT male)'), 'weld');
  assert.equal(endFamily('BSP female'), 'bspF');
  assert.equal(endFamily('BSP male'), 'bspM');
  assert.equal(endFamily('RJT male'), 'rjtM');
  assert.equal(endFamily('RJT female (liner + hex nut)'), 'rjtF');
  assert.equal(endFamily('flange face'), 'flange');
  assert.equal(endFamily('lugged between flanges'), 'wafer');
});

test('only matching sizes and connections join', () => {
  const weld50 = end('butt-weld', 60.3);
  assert.ok(directJoin(weld50, end('butt-weld', 60.3)));
  assert.ok(!directJoin(weld50, end('butt-weld', 48.3)), 'different OD');
  assert.ok(!directJoin(weld50, end('BSP female', 60.3)), 'weld to thread');
  assert.ok(directJoin(end('BSP female', 21.3), end('BSP male', 21.3)));
  assert.ok(!directJoin(end('BSP male', 21.3), end('BSP male', 21.3)));
  assert.ok(directJoin(end('flange face', 60.3, { flange: 150 }), end('wafer between flanges', 60.3, { flange: 150 })));
  assert.ok(directJoin(end('flange face', 73.0, { flange: 165, dn: 65 }), end('flange face', 73.0, { flange: 185, dn: 65 })), 'same size, other flange standard');
  assert.ok(!directJoin(end('flange face', 60.3, { flange: 150, dn: 50 }), end('flange face', 73.0, { flange: 165, dn: 65 })), 'different size');
  assert.ok(!directJoin(end('wafer between flanges', 60.3), end('lugged between flanges', 60.3)));
  // a dairy tube flange (50.8 tube) takes a 50NB wafer valve: same drilling
  assert.ok(directJoin(end('flange face', 50.8, { flange: 150, dn: 50 }), end('wafer between flanges', 60.3, { flange: 150, dn: 50 })));
});

test('weld and BSP female ends join through a pipe; others join directly', () => {
  const ports = [end('butt-weld', 60.3, { name: '0' }), end('butt-weld', 48.3, { name: '1' })];
  assert.deepEqual(joinOptions(end('butt-weld', 60.3), ports).map((o) => [o.port.name, o.viaPipe]), [['0', true]]);
  const valve = [end('BSP female', 21.3, { name: '0' }), end('BSP female', 21.3, { name: '1' })];
  assert.deepEqual(joinOptions(end('BSP male', 21.3), valve).map((o) => o.viaPipe), [false, false]);
  assert.deepEqual(joinOptions(end('BSP female', 21.3), valve).map((o) => o.viaPipe), [true, true]);
  assert.equal(joinOptions(end('flange face', 60.3, { flange: 150 }), ports).length, 0);
  // no pipe threaded at one end and welded at the other
  assert.equal(joinOptions(end('BSP female', 21.3), [end('butt-weld', 21.3)]).length, 0);
  // an open pipe end takes weld or female ends of its size directly
  assert.deepEqual(joinOptions({ family: 'pipe', od: 60.3 }, ports).map((o) => [o.port.name, o.viaPipe]), [['0', false]]);
  assert.equal(joinOptions({ family: 'pipe', od: 60.3, threaded: true }, ports).length, 0, 'threaded pipe takes no weld end');
  assert.equal(joinOptions({ family: 'pipe', od: 21.3, threaded: true }, [end('BSP female', 21.3)]).length, 1);
});

test('pipe size and wall for an end', () => {
  assert.deepEqual(pipeFor({ family: 'weld', od: 60.3, wall: 2.77, label: '50NB' }), { od: 60.3, wall: 2.77, label: '50NB', threaded: false });
  const bsp = pipeFor({ family: 'bspF', od: 21.3, label: '15NB' });
  assert.equal(bsp.wall, 2.6);
  assert.ok(bsp.threaded);
});

test('cut length from centre-to-centre, centre-to-end and thread engagement', () => {
  const elbow = { c2e: 76.2 };
  assert.equal(cutLength({ mode: 'cut', value: 250 }, elbow, elbow), 250);
  assert.ok(Math.abs(cutLength({ mode: 'cc', value: 500 }, elbow, elbow) - 347.6) < 1e-9);
  assert.ok(Math.abs(cutLength({ mode: 'cc', value: 500 }, elbow, null) - 423.8) < 1e-9, 'open end: centre to pipe end');
  // pipe screws 8.2 mm into a BSP female end
  assert.ok(Math.abs(cutLength({ mode: 'cc', value: 200 }, { c2e: 30, engage: 8.2 }, null) - 178.2) < 1e-9);
  assert.ok(Math.abs(dimFromCut('cc', 347.6, elbow, elbow) - 500) < 1e-9);
  assert.equal(centreToEnd({ origin: [76.2, 0, 76.2], dir: [1, 0, 0] }, [0, 0, 76.2]), 76.2);
});

test('Revit connector file lists the open ends with point, direction and size', async () => {
  const { connectorEnds } = await import('../web/js/revit.js');
  const { solve, openPorts, pipePorts } = await import('../web/js/kinematics.js');
  const elbow = [
    { name: '0', origin: [0, 0, 0], dir: [0, 0, -1], up: [1, 0, 0], od: 60.3, dn: 50, family: 'weld', end: 'butt-weld' },
    { name: '1', origin: [76.2, 0, 76.2], dir: [1, 0, 0], up: [0, 0, 1], od: 60.3, dn: 50, family: 'weld', end: 'butt-weld' },
  ];
  const nodes = [
    { id: 'e', type: 'part', part: 'SPB5090S10', port: '0' },
    { id: 'p', type: 'pipe', label: '50NB', od: 60.3, length: 300, port: 'A', parent: 'e', parentPort: '1' },
    { id: 's', type: 'start', port: 'in', origin: [0, 500, 0], startDir: '+X' },
  ];
  const portsOf = (n) => (n.type === 'pipe' ? pipePorts(n.od, n.length).map((q) => ({ ...q, family: 'pipe', label: n.label }))
    : n.type === 'start' ? [{ name: 'in', origin: [0, 0, 0], dir: [-1, 0, 0], family: 'none' }, { name: 'out', origin: [0, 0, 0], dir: [1, 0, 0], family: 'start' }] : elbow);
  const { placed } = solve(nodes, portsOf);
  const file = connectorEnds(openPorts(nodes, placed), (id) => nodes.find((n) => n.id === id));
  assert.equal(file.units, 'mm');
  assert.equal(file.ends.length, 2, 'elbow inlet and pipe end, not the start point');
  for (const e of file.ends) {
    assert.equal(e.nominal, 50);
    assert.ok(Math.abs(Math.hypot(...e.direction) - 1) < 1e-3);
  }
  const pipeEnd = file.ends.find((e) => e.end === 'pipe end');
  const elbowEnd = file.ends.find((e) => e.end === 'butt-weld');
  // the open pipe end is 300 mm on from the elbow outlet, pointing away from the elbow
  const outlet = placed.get('e').ports[1].origin;
  assert.ok(Math.abs(Math.hypot(...pipeEnd.point.map((v, i) => v - outlet[i])) - 300) < 1e-3);
  assert.ok(pipeEnd.direction.every((v, i) => Math.abs(v - placed.get('e').ports[1].dir[i]) < 1e-3));
  assert.ok(elbowEnd.point.every((v, i) => Math.abs(v - placed.get('e').ports[0].origin[i]) < 1e-3));
});
