// Placement maths for spools: pure functions, no three.js, so it can be unit
// tested with node (see tests/kinematics.test.mjs).
//
// A spool is a tree of nodes. Every node is one component with named ports
// ({name, origin, dir, up, size, kind} in local coordinates, dir pointing
// outwards). A child node attaches its own port `node.port` to the parent's
// port `node.parentPort`: the two ports coincide (plus an optional gap), point
// in opposite directions, and `node.roll` (degrees) turns the child about the
// connection axis, measured from the parent port's `up` vector.
//
// Matrices are row-major 4x4 arrays: [[r00,r01,r02,tx],[...],[...],[0,0,0,1]].

export const OD_TOLERANCE = 0.6;

export const IDENTITY = () => [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const len = (a) => Math.sqrt(dot(a, a));
export const norm = (a) => { const l = len(a); return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 0]; };

export function mul(A, B) {
  const C = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++)
      C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j] + A[i][3] * B[3][j];
  return C;
}

export function invRigid(M) {
  // inverse of [R t] is [R^T, -R^T t]
  const R = [[M[0][0], M[1][0], M[2][0]], [M[0][1], M[1][1], M[2][1]], [M[0][2], M[1][2], M[2][2]]];
  const t = [M[0][3], M[1][3], M[2][3]];
  const ti = R.map((row) => -dot(row, t));
  return [[...R[0], ti[0]], [...R[1], ti[1]], [...R[2], ti[2]], [0, 0, 0, 1]];
}

export const applyPoint = (M, p) => [0, 1, 2].map((i) => M[i][0] * p[0] + M[i][1] * p[1] + M[i][2] * p[2] + M[i][3]);
export const applyDir = (M, v) => [0, 1, 2].map((i) => M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2]);

/** Frame with columns x, y, z and origin o. */
export function frame(o, x, y, z) {
  return [[x[0], y[0], z[0], o[0]], [x[1], y[1], z[1], o[1]], [x[2], y[2], z[2], o[2]], [0, 0, 0, 1]];
}

/** Rotate vector v about unit axis k by angle (radians) – Rodrigues. */
export function rotate(v, k, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

/** A vector perpendicular to dir: +Z projected, else +X. */
export function defaultUp(dir) {
  const d = norm(dir);
  for (const ref of [[0, 0, 1], [1, 0, 0]]) {
    const p = sub(ref, scale(d, dot(ref, d)));
    if (len(p) > 1e-3) return norm(p);
  }
  return [0, 1, 0];
}

/** Orthonormal frame for a port: z = dir, x = up (orthogonalised). */
export function portFrame(port) {
  const z = norm(port.dir);
  let x = port.up ? sub(port.up, scale(z, dot(port.up, z))) : defaultUp(z);
  x = len(x) > 1e-6 ? norm(x) : defaultUp(z);
  return frame(port.origin, x, cross(z, x), z);
}

/**
 * World transform of a component so that its local port `childPort` mates
 * with the world-space port `target` ({origin, dir, up}).
 */
export function attachTransform(target, childPort, rollDeg = 0, gap = 0) {
  const d = norm(target.dir);
  const o = add(target.origin, scale(d, gap || 0));
  let up = target.up ? sub(target.up, scale(d, dot(target.up, d))) : defaultUp(d);
  up = len(up) > 1e-6 ? norm(up) : defaultUp(d);
  const x = rotate(up, d, ((rollDeg || 0) * Math.PI) / 180);
  const z = scale(d, -1);
  const world = frame(o, x, cross(z, x), z);
  return mul(world, invRigid(portFrame(childPort)));
}

export const START_DIRS = {
  '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1],
};

/** Virtual port the root node attaches to: at `origin`, flow leaving along startDir. */
export function rootTarget(node) {
  if (node.target) return node.target; // e.g. the start of a parallel line
  const dir = START_DIRS[node.startDir || '+X'] || [1, 0, 0];
  const up = Math.abs(dir[2]) > 0.5 ? [1, 0, 0] : [0, 0, 1];
  return { origin: node.origin || [0, 0, 0], dir, up };
}

export function transformPort(M, p) {
  return { ...p, origin: applyPoint(M, p.origin), dir: norm(applyDir(M, p.dir)), up: norm(applyDir(M, p.up || defaultUp(p.dir))) };
}

/**
 * Solve world placement of every node.
 * @param nodes   array of nodes ({id, parent, parentPort, port, roll, gap, startDir})
 * @param portsOf function(node) -> local ports array, or null if not loaded/invalid
 * @returns {placed: Map(id -> {matrix, ports}), errors: [{id, message}]}
 */
export function solve(nodes, portsOf) {
  const placed = new Map();
  const errors = [];
  const children = new Map();
  for (const n of nodes) {
    const k = n.parent || null;
    if (!children.has(k)) children.set(k, []);
    children.get(k).push(n);
  }
  const queue = [...(children.get(null) || [])].map((n) => [n, null]);
  while (queue.length) {
    const [n, parent] = queue.shift();
    const ports = portsOf(n);
    if (!ports || !ports.length) { errors.push({ id: n.id, message: 'No ports defined' }); continue; }
    const own = ports.find((p) => p.name === n.port) || ports[0];
    let target;
    if (!parent) {
      target = rootTarget(n);
    } else {
      target = parent.ports.find((p) => p.name === n.parentPort);
      if (!target) { errors.push({ id: n.id, message: `Parent has no port ${n.parentPort}` }); continue; }
    }
    const matrix = attachTransform(target, own, n.roll, parent ? n.gap : 0);
    const worldPorts = ports.map((p) => transformPort(matrix, p));
    const entry = { matrix, ports: worldPorts, attachPort: own.name };
    // flanged joints match by drilling, not pipe OD (joints.js decides those)
    const byOd = ![target.family, own.family].some((f) => ['flange', 'wafer', 'start', 'branch'].includes(f));
    if (parent && byOd && target.od > 0 && own.od > 0 && Math.abs(target.od - own.od) > OD_TOLERANCE) {
      errors.push({ id: n.id, message: `Size mismatch: Ø${own.od} joined to Ø${target.od}`, kind: 'size' });
    }
    placed.set(n.id, entry);
    for (const c of children.get(n.id) || []) queue.push([c, entry]);
  }
  for (const n of nodes) if (!placed.has(n.id) && !errors.find((e) => e.id === n.id)) errors.push({ id: n.id, message: 'Not connected' });
  return { placed, errors };
}

/** Ports that nothing is connected to: [{nodeId, port}] */
export function openPorts(nodes, placed) {
  const used = new Set();
  for (const n of nodes) {
    const e = placed.get(n.id);
    if (!e) continue;
    if (!n.parent) continue; // the root's attach port is a free end
    used.add(`${n.id}:${e.attachPort}`);
    used.add(`${n.parent}:${n.parentPort}`);
  }
  const out = [];
  for (const n of nodes) {
    const e = placed.get(n.id);
    if (!e) continue;
    for (const p of e.ports) if (!used.has(`${n.id}:${p.name}`)) out.push({ nodeId: n.id, port: p });
  }
  return out;
}

/** Pipe ports (pipes are generated, not from STEP). */
export function pipePorts(od, length) {
  return [
    { name: 'A', origin: [0, 0, 0], dir: [-1, 0, 0], up: [0, 0, 1], od, kind: 'pipe' },
    { name: 'B', origin: [length, 0, 0], dir: [1, 0, 0], up: [0, 0, 1], od, kind: 'pipe' },
  ];
}
