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
  assert.ok(!directJoin(end('flange face', 60.3, { flange: 150 }), end('flange face', 60.3, { flange: 165 })), 'different drilling');
  assert.ok(!directJoin(end('wafer between flanges', 60.3), end('lugged between flanges', 60.3)));
  // a dairy tube flange (50.8 tube) takes a 50NB wafer valve: same drilling
  assert.ok(directJoin(end('flange face', 50.8, { flange: 150, pcd: 114 }), end('wafer between flanges', 60.3, { flange: 150, pcd: 114 })));
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
