// Editing a spool's line: remove a part and close the gap, move a fitting up
// or down the line, insert parts between two others, line two points up.
// Pure functions on the node tree (tested in tests/edit.test.mjs).
//
// Every function takes a context:
//   nodes     the spool nodes (copied, not changed)
//   portsOf   node -> its local ports ({name, origin, dir, family, od, engage…})
//   placed    solve() result: id -> {matrix, ports (world)}
//   centreOf  node -> world centre of a part (or null)
// and returns {nodes, cuts, branchX} or throws an Error with a message for the
// user. `cuts` (pipe id -> cut length) are written back by the caller in the
// pipe's own dimension mode; `branchX` (branch part id -> mm from its pipe's
// A end) likewise become the branch's `along`.
import { directJoin } from './joints.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.sqrt(dot(a, a));

/** The end that continues the run: the one pointing most away from the attach end. */
export function runPort(ports, attachName) {
  const own = ports.find((p) => p.name === attachName);
  const free = ports.filter((p) => p.name !== attachName);
  if (own && free.length > 1) free.sort((a, b) => dot(a.dir, own.dir) - dot(b.dir, own.dir));
  return free[0]?.name || null;
}

const engageOf = (p) => (p?.family === 'bspF' ? p.engage || 0 : 0);
const clone = (nodes) => nodes.map((n) => JSON.parse(JSON.stringify(n)));

function tools(ctx) {
  const nodes = clone(ctx.nodes);
  const byId = (id) => nodes.find((n) => n.id === id);
  const kids = (id) => nodes.filter((n) => n.parent === id);
  const world = (id, name) => ctx.placed.get(id)?.ports.find((p) => p.name === name) || null;
  const local = (n, name) => ctx.portsOf(n)?.find((p) => p.name === name) || null;
  /** Cut a run loose where it is: its node becomes a root fixed in place. */
  const fix = (n) => {
    const w = world(n.id, n.port);
    if (!w) throw new Error('That part is not placed');
    delete n.parent; delete n.parentPort; delete n.gap; delete n.branch;
    n.roll = 0;
    n.fix = { origin: w.origin, dir: scale(w.dir, -1), up: w.up };
  };
  const remove = (id) => { const i = nodes.findIndex((n) => n.id === id); if (i >= 0) nodes.splice(i, 1); };
  return { nodes, byId, kids, world, local, fix, remove };
}

/** Can the end `a` (on the parent) take the end `b` (of the child) straight on? */
export function canJoin(a, b) {
  return !!a && !!b && directJoin(a, b);
}

/** Two ends of a part pointing opposite ways (an inline part). */
const inline = (a, b) => a && b && dot(a.dir, b.dir) < -0.999;

/**
 * Remove one node and close the gap: the parts either side join back up and
 * what is beyond stays where it is (cut loose as its own run when it can't).
 */
export function removeNode(ctx, id) {
  const T = tools(ctx);
  const x = T.byId(id);
  if (!x) throw new Error('Nothing to remove');
  const cuts = new Map();
  const branchX = new Map();
  let msg = '';
  const xPorts = ctx.portsOf(x) || [];
  const runName = x.type === 'pipe' ? 'B' : x.type === 'start' ? 'out' : runPort(xPorts, x.port);
  const children = T.kids(x.id);
  const run = children.find((c) => c.parentPort === runName && !c.branch) || null;
  const p = x.parent ? T.byId(x.parent) : null;
  const loose = children.filter((c) => c !== run);
  for (const c of loose) T.fix(c);
  if (loose.length) msg = `The other ${loose.length === 1 ? 'part' : 'parts'} on it ${loose.length === 1 ? 'is' : 'are'} now a separate run, where ${loose.length === 1 ? 'it was' : 'they were'}.`;
  T.remove(x.id);
  if (!run) return { nodes: T.nodes, cuts, branchX, msg };
  const cutLoose = () => { T.fix(run); msg = 'What was beyond it is now a separate run, where it was.'; };
  if (!p) { T.fix(run); return { nodes: T.nodes, cuts, branchX, msg }; }

  const pEnd = T.local(p, x.parentPort);
  const runEnd = T.local(run, run.port);
  const reattach = () => { run.parent = p.id; run.parentPort = x.parentPort; delete run.gap; };
  if (x.type === 'pipe') {
    if (canJoin(pEnd, runEnd)) reattach(); else cutLoose();
    return { nodes: T.nodes, cuts, branchX, msg };
  }
  const xIn = T.world(x.id, x.port), xOut = T.world(x.id, runName);
  if (!inline(xIn, xOut)) { cutLoose(); return { nodes: T.nodes, cuts, branchX, msg }; }
  const d = xOut.dir;
  if (p.type === 'pipe' && run.type === 'pipe' && Math.abs(p.od - run.od) < 0.6 && !!p.threaded === !!run.threaded) {
    // pipe – part – pipe on one line: one pipe, as long as both plus the part
    const A = T.world(p.id, 'A').origin, B = T.world(run.id, 'B').origin;
    cuts.set(p.id, dot(sub(B, A), d));
    for (const c of T.kids(run.id)) {
      if (c.branch) branchX.set(c.id, dot(sub(T.world(c.id, c.port).origin, A), d));
      c.parent = p.id;
    }
    T.remove(run.id);
    return { nodes: T.nodes, cuts, branchX, msg };
  }
  if (p.type === 'pipe' && canJoin(pEnd, runEnd)) {
    // the pipe grows to reach the next part where it is
    const A = T.world(p.id, 'A').origin;
    cuts.set(p.id, dot(sub(T.world(run.id, run.port).origin, A), d) + engageOf(runEnd));
    reattach();
    return { nodes: T.nodes, cuts, branchX, msg };
  }
  if (run.type === 'pipe' && canJoin(pEnd, runEnd)) {
    // the next pipe grows back to the part before, its far end where it was
    const face = T.world(p.id, x.parentPort).origin;
    const a = add(face, scale(d, -engageOf(pEnd)));
    const B = T.world(run.id, 'B').origin;
    cuts.set(run.id, dot(sub(B, a), d));
    for (const c of T.kids(run.id)) if (c.branch) branchX.set(c.id, dot(sub(T.world(c.id, c.port).origin, a), d));
    reattach();
    return { nodes: T.nodes, cuts, branchX, msg };
  }
  if (canJoin(pEnd, runEnd)) { reattach(); msg = 'The parts beyond moved up to close the gap.'; } else cutLoose();
  return { nodes: T.nodes, cuts, branchX, msg };
}

/** Fittings in a line, the way `dir` goes from node id (skipping pipes). */
function neighbour(T, ctx, n, dir) {
  if (dir < 0) {
    let up = n.parent ? T.byId(n.parent) : null;
    const via = [];
    while (up && up.type === 'pipe') { via.push(up); up = up.parent ? T.byId(up.parent) : null; }
    return up && up.type === 'part' ? { other: up, via } : null;
  }
  const ports = ctx.portsOf(n) || [];
  const runName = runPort(ports, n.port);
  let down = T.nodes.find((c) => c.parent === n.id && c.parentPort === runName && !c.branch);
  const via = [];
  while (down && down.type === 'pipe') { via.push(down); down = T.nodes.find((c) => c.parent === via[via.length - 1].id && c.parentPort === 'B' && !c.branch); }
  return down && down.type === 'part' ? { other: down, via } : null;
}

const PART_KEYS = ['part', 'port', 'roll', 'handle', 'tag'];

/**
 * Swap a fitting with the one before (dir -1) or after (+1) it in its line.
 * The tree slots (and the pipes between them) stay; the parts change places.
 */
export function moveNode(ctx, id, dir) {
  const T = tools(ctx);
  const x = T.byId(id);
  if (!x || x.type !== 'part') throw new Error('Only fittings can be moved');
  const nb = neighbour(T, ctx, x, dir);
  if (!nb) throw new Error(dir < 0 ? 'It is already the first fitting in its line' : 'It is already the last fitting in its line');
  const [first, second] = dir < 0 ? [nb.other, x] : [x, nb.other];
  for (const n of [first, second]) {
    if ((ctx.portsOf(n) || []).length !== 2) throw new Error('Only fittings with two ends can be moved (not tees)');
  }
  const runOf = (n) => runPort(ctx.portsOf(n), n.port);
  const oldRun = new Map([[first.id, runOf(first)], [second.id, runOf(second)]]);
  const a = Object.fromEntries(PART_KEYS.map((k) => [k, first[k]]));
  const b = Object.fromEntries(PART_KEYS.map((k) => [k, second[k]]));
  const put = (n, data) => { for (const k of PART_KEYS) { if (data[k] === undefined) delete n[k]; else n[k] = data[k]; } };
  put(first, b); put(second, a);
  // each part in its new slot: by the same end it had, else turned round
  const joints = (n) => {
    const out = [];
    if (n.parent) out.push([T.local(T.byId(n.parent), n.parentPort), T.local(n, n.port)]);
    const r = runPort(ctx.portsOf(n), n.port);
    for (const c of T.kids(n.id)) if (c.parentPort === oldRun.get(n.id) && !c.branch) out.push([T.local(n, r), T.local(c, c.port)]);
    return out;
  };
  const ok = (n) => joints(n).every(([p, q]) => canJoin(p, q));
  const tries = [];
  for (const fa of [false, true]) for (const fb of [false, true]) tries.push([fa, fb]);
  const flip = (n) => { n.port = (ctx.portsOf(n) || []).find((q) => q.name !== n.port).name; };
  let found = false;
  for (const [fa, fb] of tries) {
    const pa = first.port, pb = second.port;
    if (fa) flip(first);
    if (fb) flip(second);
    if (ok(first) && ok(second)) { found = true; break; }
    first.port = pa; second.port = pb;
  }
  if (!found) {
    const name = (n) => n.part;
    throw new Error(`${name(second)} and ${name(first)} can't swap: their ends don't fit the joints either side`);
  }
  // children on the old run end go on the new run end
  for (const n of [first, second]) {
    const r = runOf(n);
    for (const c of T.kids(n.id)) if (c.parentPort === oldRun.get(n.id) && !c.branch) c.parentPort = r;
  }
  // the slot the moved part is in now
  return { nodes: T.nodes, cuts: new Map(), branchX: new Map(), msg: '', moved: x === first ? second.id : first.id };
}

/** Length of a chain of inline parts, face to face along the line. */
function chainLength(ctx, chain) {
  let L = 0;
  for (const c of chain) {
    const ports = ctx.portsOf({ type: 'part', part: c.part });
    const a = ports.find((p) => p.name === c.port), b = ports.find((p) => p.name === c.run);
    L += len(sub(b.origin, a.origin));
  }
  return L;
}

/**
 * Put a chain of parts ([{part, port, run}], each attached by `port`, the next
 * one on its `run` end) into the line:
 *   {pipe: id}            in the middle of a pipe, splitting it in two
 *   {node: id, port: nm}  between a part and what is on its end `port`
 * What is beyond stays where it is when there is a pipe to take up the length.
 */
export function insertChain(ctx, at, chain, newId) {
  const T = tools(ctx);
  const cuts = new Map();
  const branchX = new Map();
  const total = chainLength(ctx, chain);
  const portsOfPart = (c) => ctx.portsOf({ type: 'part', part: c.part });
  const first = portsOfPart(chain[0]).find((p) => p.name === chain[0].port);
  const last = portsOfPart(chain[chain.length - 1]).find((p) => p.name === chain[chain.length - 1].run);
  const made = chain.map((c) => ({ id: newId(), type: 'part', part: c.part, port: c.port, roll: 0 }));
  made.forEach((n, i) => { if (i) { n.parent = made[i - 1].id; n.parentPort = chain[i - 1].run; } });
  const tail = made[made.length - 1], tailRun = chain[chain.length - 1].run;
  let msg = '';
  if (at.pipe) {
    const p = T.byId(at.pipe);
    const A = T.world(p.id, 'A').origin, B = T.world(p.id, 'B').origin;
    const d = T.world(p.id, 'B').dir;
    const L = dot(sub(B, A), d);
    if (total > L + 0.01) throw new Error(`Not enough room: the pipe is ${Math.round(L)} mm and the parts need ${Math.round(total)} mm`);
    const s = (L - total) / 2; // the parts in the middle
    cuts.set(p.id, s + engageOf(first));
    const p2 = { id: newId(), type: 'pipe', od: p.od, wall: p.wall, label: p.label, threaded: p.threaded, port: 'A', roll: 0, parent: tail.id, parentPort: tailRun, dim: { mode: p.dim?.mode || 'cc', value: 0 } };
    const startB = s + total - engageOf(last);
    cuts.set(p2.id, L - startB);
    made[0].parent = p.id; made[0].parentPort = 'B';
    for (const c of T.kids(p.id)) {
      if (c.branch) {
        const x = dot(sub(T.world(c.id, c.port).origin, A), d);
        if (x < s) continue;
        if (x > s + total) { c.parent = p2.id; branchX.set(c.id, x - startB); } else { T.fix(c); msg = 'A branch where the parts go is now a separate run.'; }
      } else { c.parent = p2.id; }
    }
    T.nodes.push(...made, p2);
    return { nodes: T.nodes, cuts, branchX, msg, made: made.map((n) => n.id) };
  }
  const x = T.byId(at.node);
  const next = T.nodes.find((c) => c.parent === x.id && c.parentPort === at.port && !c.branch) || null;
  made[0].parent = x.id; made[0].parentPort = at.port;
  if (next) {
    next.parent = tail.id; next.parentPort = tailRun; delete next.gap;
    if (next.type === 'pipe') {
      const face = T.world(x.id, at.port);
      const B = T.world(next.id, 'B').origin;
      const a = add(face.origin, scale(face.dir, total - engageOf(last)));
      const cut = dot(sub(B, a), face.dir);
      if (cut < -0.01) throw new Error(`Not enough room: the next pipe is too short for ${Math.round(total)} mm of parts`);
      cuts.set(next.id, cut);
      for (const c of T.kids(next.id)) if (c.branch) branchX.set(c.id, dot(sub(T.world(c.id, c.port).origin, a), face.dir));
    } else msg = 'The parts beyond moved on to make room.';
  }
  T.nodes.push(...made);
  return { nodes: T.nodes, cuts, branchX, msg, made: made.map((n) => n.id) };
}

const AXES = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

/** World point of a node: 'centre' or one of its ends. */
export function pointOf(ctx, n, at) {
  if (at === 'centre') {
    if (n.type === 'pipe') {
      const e = ctx.placed.get(n.id);
      const a = e?.ports.find((p) => p.name === 'A'), b = e?.ports.find((p) => p.name === 'B');
      return a && b ? scale(add(a.origin, b.origin), 0.5) : null;
    }
    return ctx.centreOf(n);
  }
  return ctx.placed.get(n.id)?.ports.find((p) => p.name === at)?.origin || null;
}

/** Pipes whose length moves this node: between it and the start of its run, nearest first. */
function pipesBehind(ctx, n, at) {
  const byId = (id) => ctx.nodes.find((q) => q.id === id);
  const out = [];
  if (n.type === 'pipe' && at === 'B') out.push(n);
  let up = n.parent ? byId(n.parent) : null;
  let child = n;
  while (up) {
    if (up.type === 'pipe' && !child.branch && child.parentPort === 'B') out.push(up);
    child = up;
    up = up.parent ? byId(up.parent) : null;
  }
  return out;
}

const inSubtree = (nodes, rootId, id) => {
  for (let n = nodes.find((q) => q.id === id); n; n = n.parent ? nodes.find((q) => q.id === n.parent) : null) if (n.id === rootId) return true;
  return false;
};

/** Pipes that can line the node up on an axis: [{pipe}] (along the axis, the reference not beyond them). */
export function alignPipes(ctx, id, at, refId, axis) {
  const n = ctx.nodes.find((q) => q.id === id);
  const k = AXES[axis];
  return pipesBehind(ctx, n, at).filter((p) => {
    const d = ctx.placed.get(p.id)?.ports.find((q) => q.name === 'B')?.dir;
    return d && Math.abs(dot(d, k)) > 0.999 && !inSubtree(ctx.nodes, p.id, refId);
  });
}

/**
 * Line node `id` (its point `at`) up with node `refId` (its point `refAt`) on
 * an axis ('X', 'Y' or 'Z'), by changing the length of one pipe behind it
 * (`pipeId`, or the nearest that runs along the axis). Returns {pipe, cut}.
 */
export function alignFix(ctx, { id, at, ref, refAt, axis, pipe: pipeId = null }) {
  const n = ctx.nodes.find((q) => q.id === id), r = ctx.nodes.find((q) => q.id === ref);
  if (!n || !r) throw new Error('The part to line up with is gone');
  const P = pointOf(ctx, n, at), Q = pointOf(ctx, r, refAt);
  if (!P || !Q) throw new Error('That point is not placed');
  const k = AXES[axis];
  const pipes = alignPipes(ctx, id, at, ref, axis);
  const pipe = pipeId ? pipes.find((p) => p.id === pipeId) : pipes[0];
  if (!pipe) throw new Error(`No pipe along ${axis === 'Z' ? 'Z (RL)' : axis} between them to adjust`);
  const d = ctx.placed.get(pipe.id).ports.find((q) => q.name === 'B').dir;
  const delta = dot(sub(Q, P), k);
  const cut = (pipe.cut || 0) + delta / dot(d, k);
  if (cut < -0.01) throw new Error(`That would need the pipe ${Math.round(-cut)} mm shorter than nothing`);
  return { pipe: pipe.id, cut: Math.max(0, cut), delta };
}
