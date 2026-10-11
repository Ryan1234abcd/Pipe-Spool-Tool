// Spool builder: main application (runs entirely in the browser).
//
// Insert parts from the library, roll them, and set centre-to-centre (or
// cut-length) dimensions on the pipes between them. A part can only go on an
// open end it fits: same pipe size and a matching connection.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { Viewer, toMatrix4, geometryFromMesh } from './viewer.js';
import { solve, openPorts, pipePorts, applyPoint, mul, rotate, cross, defaultUp } from './kinematics.js';
import { joinOptions, pipeFor, centreToEnd, cutLength, dimFromCut } from './joints.js';
import { Library, kvGet, kvSet, GROUPS, groupOf } from './library.js';
import { createPartLoader } from './parts.js';
import { startCad, cad } from './cad-client.js';
import { toast, esc, ask, saveFile } from './ui.js';

const COLORS = { pipe: 0x9aabbd, part: 0xd38a3a, fitting: 0x8195ab };
const SPOOLS_KEY = 'pipe-spool-tool.spools.v2';
const DEFAULT_CUT = 150;
const SHARED_SYSTEMS = ['valves', 'adapters', 'rjt-unions']; // offered with every pipe type
let partGroup = 'All'; // the one part type shown in the list
try { partGroup = localStorage.getItem('pipe-spool-tool.partGroup') || 'All'; } catch { /* default */ }
// parts that can be stabbed into the side of a pipe to start a branch
const STAB_TYPES = ['weld-nipple-pipe', 'weld-nipple-pipe-ext', 'weld-nipple-tube', 'half-socket'];
const DIR_TEXT = { '+X': 'Horizontal (along X)', '+Y': 'Horizontal (along Y)', '+Z': 'Vertical, going up', '-Z': 'Vertical, going down' };

// ---------------------------------------------------------------------- state
const state = {
  name: 'Spool-01',
  pipeType: 'pipe-sch10s', // Part-Library system the spool starts in
  startDir: '+X', // which way the first part runs
  branchOn: null, // pipe id while picking a part to stab into it
  startSize: null,
  nodes: [],
  selected: null,
  active: null, // "nodeId:portName" – where the next part goes
};
const library = new Library();
const parts = createPartLoader(library);
let solved = { placed: new Map(), errors: [] };
let open = [];
const undoStack = [];
const redoStack = [];
let nextId = 1;
let needFit = true;

const $ = (id) => document.getElementById(id);
const viewer = new Viewer($('viewport'));
const materials = {};
const round = (v, n = 1) => Math.round(v * 10 ** n) / 10 ** n;

function material(kind, selected) {
  const key = `${kind}|${selected}`;
  if (!materials[key]) {
    materials[key] = new THREE.MeshStandardMaterial({
      color: COLORS[kind], metalness: 0.25, roughness: 0.55, side: THREE.DoubleSide,
      emissive: selected ? 0x1f5fa8 : 0x000000, emissiveIntensity: selected ? 0.55 : 0,
    });
  }
  return materials[key];
}

// ------------------------------------------------------------------- helpers
const newId = () => {
  while (state.nodes.some((n) => n.id === `n${nextId}`)) nextId++;
  return `n${nextId++}`;
};
const nodeById = (id) => state.nodes.find((n) => n.id === id);
const childrenOf = (id) => state.nodes.filter((n) => n.parent === id);
const childAt = (id, port) => state.nodes.find((c) => c.parent === id && c.parentPort === port) || null;
const partOf = (n) => (n?.type === 'part' ? library.parts.get(n.part) : null);
const isFitting = (p) => !/valve|strainer/.test(p?.category || '');

function nodeLabel(n) {
  if (!n) return '?';
  if (n.type === 'pipe') return `Pipe ${n.label}`;
  if (n.type === 'start') return `Parallel line ${n.label}`;
  return partOf(n)?.name || n.part;
}

/** Local ports of a node (part ports from geometry.json, or the pipe's two ends). */
function localPorts(n) {
  if (n.type === 'start') {
    const base = { origin: [0, 0, 0], up: [0, 0, 1], od: n.od, label: n.label };
    return [{ ...base, name: 'in', dir: [-1, 0, 0], family: 'none' }, { ...base, name: 'out', dir: [1, 0, 0], family: 'start', wall: n.wall, threaded: n.threaded }];
  }
  if (n.type === 'pipe') {
    const ports = pipePorts(n.od, Math.max(n.cut || 0, 0)).map((p) => ({ ...p, family: 'pipe', label: n.label, threaded: !!n.threaded }));
    for (const c of childrenOf(n.id)) if (c.branch) ports.push(branchPort(n, c));
    return ports;
  }
  return partOf(n)?.ports || null;
}

/**
 * Where a stabbed-in branch sits on its pipe: `along` from the upstream
 * fitting centre, `angle` round the pipe from its up side; the nipple end is
 * set in flush with the bore.
 */
function branchPort(pipe, c) {
  const { a } = pipeSides(pipe);
  const x = (Number(c.branch.along) || 0) - (a ? a.c2e - (a.engage || 0) : 0);
  const v = rotate([0, 0, 1], [1, 0, 0], ((Number(c.branch.angle) || 0) * Math.PI) / 180);
  const r = pipe.od / 2 - (pipe.wall || 0);
  return { name: `br:${c.id}`, origin: [x, v[1] * r, v[2] * r], dir: v, up: [1, 0, 0], od: pipe.od, label: pipe.label, family: 'branch' };
}

/** Centre-to-end data of the part on the far side of a pipe end. */
function sideOf(n, portName) {
  const p = partOf(n);
  const port = p?.ports.find((x) => x.name === portName);
  if (!port) return null;
  return { c2e: centreToEnd(port, p.centre), engage: port.family === 'bspF' ? port.engage : 0 };
}

/** The parts at each end of a pipe: {a (upstream), b (downstream)}. */
function pipeSides(n) {
  const up = nodeById(n.parent);
  const down = childAt(n.id, 'B');
  return {
    a: up ? sideOf(up, n.parentPort) : null,
    b: down ? sideOf(down, down.port) : null,
  };
}

/** Gap at a joint: a pipe goes into a BSP female end by its thread engagement. */
function jointGap(n) {
  if (!n.parent) return 0;
  const parent = nodeById(n.parent);
  const target = localPorts(parent)?.find((p) => p.name === n.parentPort);
  const own = localPorts(n)?.find((p) => p.name === n.port);
  if (!target || !own) return 0;
  if (own.family === 'pipe' && target.family === 'bspF') return -target.engage;
  if (target.family === 'pipe' && own.family === 'bspF') return -own.engage;
  return 0;
}

// ---------------------------------------------------------------- rebuilding
const meshes = new Map(); // part id -> THREE geometry
let buildSeq = 0;

async function rebuild() {
  const seq = ++buildSeq;
  // pipe lengths from their dimensions
  for (const n of state.nodes) {
    if (n.type !== 'pipe') continue;
    const { a, b } = pipeSides(n);
    n.cut = round(cutLength(n.dim, a, b), 2);
  }
  for (const n of state.nodes) n.gap = jointGap(n);
  // parallel lines start from a point beside their reference pipe, so place
  // the rest first and then them (a few passes for lines off parallel lines)
  const starts = state.nodes.filter((n) => n.type === 'start');
  for (const n of starts) delete n.target;
  solved = solve(state.nodes.filter((n) => !starts.includes(n) && !hangsOff(n, starts)), localPorts);
  for (let pass = 0; pass < 4 && starts.length; pass++) {
    for (const n of starts) n.target = startTarget(n) || undefined;
    solved = solve(state.nodes.filter((n) => n.type !== 'start' || n.target ? !hangsOffUnplaced(n) : false), localPorts);
  }
  for (const n of starts) if (!n.target) solved.errors.push({ id: n.id, message: 'Its reference pipe is gone' });
  for (const n of state.nodes) {
    if (n.type === 'pipe' && n.cut < 0) solved.errors.push({ id: n.id, message: `Dimension too short by ${round(-n.cut)} mm` });
  }
  open = openPorts(state.nodes, solved.placed);
  const keys = open.map((o) => `${o.nodeId}:${o.port.name}`);
  if (state.active && !keys.includes(state.active)) state.active = null;
  if (!state.active && keys.length) state.active = keys[keys.length - 1];
  kvSet('lastSpool', spoolData());
  draw();
  renderTree();
  renderProps();
  renderStatus();
  renderPartList();
  // load display meshes of parts not seen yet, then redraw
  const missing = [...new Set(state.nodes.filter((n) => n.type === 'part').flatMap((n) => membersOf(partOf(n)).map((m) => m.part)))].filter((id) => !meshes.has(id));
  if (!missing.length) return;
  await Promise.all(missing.map(async (id) => {
    try { const d = await parts.get(id); meshes.set(id, { geometry: d.geometry, turnGeometry: d.turnGeometry }); } catch (e) { toast(`${library.parts.get(id)?.name || id}: ${e.message}`, true); }
  }));
  if (seq === buildSeq) draw();
}

/** Is n (or something it hangs off) one of the given roots? */
function hangsOff(n, roots) {
  for (let x = n; x; x = nodeById(x.parent)) if (roots.includes(x)) return true;
  return false;
}
function hangsOffUnplaced(n) {
  for (let x = n; x; x = nodeById(x.parent)) if (x.type === 'start' && !x.target) return true;
  return false;
}

/** World start of a parallel line: beside its reference pipe at the centre distance. */
function startTarget(n) {
  const e = solved.placed.get(n.ref);
  if (!e) return null;
  const a = e.ports[0].origin, b = e.ports[1].origin;
  let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = Math.hypot(...u);
  u = L > 1e-6 ? u.map((v) => v / L) : e.ports[1].dir;
  const v = rotate(defaultUp(u), u, ((Number(n.angle) || 0) * Math.PI) / 180);
  const along = Number(n.along) || 0, dist = Number(n.dist) || 0;
  const origin = [0, 1, 2].map((k) => a[k] + u[k] * along + v[k] * dist);
  const dir = n.reverse ? u.map((x) => -x) : u;
  return { origin, dir, up: v, from: [0, 1, 2].map((k) => a[k] + u[k] * along) };
}

function portByKey(key) {
  if (!key) return null;
  const [id, name] = key.split(':');
  return solved.placed.get(id)?.ports.find((p) => p.name === name) || null;
}

/** World centre of a part node. */
function centreOf(n) {
  const e = solved.placed.get(n.id);
  const p = partOf(n);
  return e && p ? applyPoint(e.matrix, p.centre) : null;
}

function draw() {
  viewer.clear();
  const showDims = $('chkDims').checked;
  for (const n of state.nodes) {
    const e = solved.placed.get(n.id);
    if (!e) continue;
    const sel = n.id === state.selected;
    let mesh = null;
    if (n.type === 'pipe') {
      const L = n.cut;
      if (L > 0.01) {
        const g = new THREE.CylinderGeometry(n.od / 2, n.od / 2, L, 32, 1, false);
        g.rotateZ(-Math.PI / 2).translate(L / 2, 0, 0);
        mesh = new THREE.Mesh(g, material('pipe', sel));
      }
    } else if (n.type === 'part') {
      // a kit (RJT union) is drawn as its halves
      const p = partOf(n);
      for (const m of membersOf(p)) {
        const g = meshes.get(m.part);
        if (!g) continue;
        const mat = material(isFitting(p) ? 'fitting' : 'part', sel);
        const parts = [[g.geometry, mul(e.matrix, m.matrix)]];
        // a valve's handle is drawn separately, turned when it is closed
        if (g.turnGeometry) parts.push([g.turnGeometry, mul(mul(e.matrix, m.matrix), n.handle === 'closed' ? stemTurn(p, 90) : IDENTITY4)]);
        for (const [geo, M] of parts) {
          const mm = new THREE.Mesh(geo, mat);
          mm.matrixAutoUpdate = false;
          mm.matrix.copy(toMatrix4(M));
          mm.userData.nodeId = n.id;
          viewer.content.add(mm);
        }
      }
      if (n.branch && showDims) {
        const pt = e.ports.find((q) => q.name === n.port)?.origin;
        if (pt) {
          const el = addLabel('dim-label', `↦ ${round(Number(n.branch.along) || 0)} · ${round(Number(n.branch.angle) || 0)}°`, pt);
          el.dataset.node = n.id;
          el.title = 'Branch position: from the upstream centre, and round the pipe – click to edit';
        }
      }
    } else if (n.type === 'start' && n.target) {
      drawStart(n);
    }
    if (mesh) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(toMatrix4(e.matrix));
      mesh.userData.nodeId = n.id;
      viewer.content.add(mesh);
    }
    if (n.type === 'part' && n.tag) {
      const c = centreOf(n);
      if (c) addLabel('tag-label', n.tag, [c[0], c[1], c[2] + (partOf(n).bbox?.[1]?.[2] || 50) + 20]);
    }
    if (n.type === 'pipe' && showDims) drawDimension(n, e);
  }
  for (const o of open) drawPort(o.nodeId, o.port);
  const shown = viewer.content.children.some((c) => c.isMesh && c.userData.nodeId);
  if (shown && (needFit || offScreen())) { viewer.fit(); needFit = false; }
  viewer.render();
}

const IDENTITY4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];

/** Rotation of a valve's handle about its stem axis (part coordinates). */
function stemTurn(p, deg) {
  if (!p?.stem) return IDENTITY4;
  const { o, d } = p.stem;
  const a = (deg * Math.PI) / 180;
  const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((v) => rotate(v, d, a));
  const R = [0, 1, 2].map((i) => [cols[0][i], cols[1][i], cols[2][i]]);
  const t = [0, 1, 2].map((i) => o[i] - (R[i][0] * o[0] + R[i][1] * o[1] + R[i][2] * o[2]));
  return [[...R[0], t[0]], [...R[1], t[1]], [...R[2], t[2]], [0, 0, 0, 1]];
}

/** The STEP parts a library part is made of (itself, or a kit's halves). */
function membersOf(p) {
  if (!p) return [];
  return p.members || [{ part: p.id, matrix: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] }];
}

/** Parallel line: dashed centre-distance line from its reference pipe, with the value. */
function drawStart(n) {
  const t = n.target;
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...t.from), new THREE.Vector3(...t.origin)]);
  const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x2f6fb3, dashSize: 8, gapSize: 5, depthTest: false }));
  line.computeLineDistances();
  line.renderOrder = 5;
  viewer.content.add(line);
  const sph = new THREE.Mesh(new THREE.SphereGeometry(Math.max(4, (n.od || 50) * 0.12), 12, 8), new THREE.MeshBasicMaterial({ color: n.id === state.selected ? 0xe8792b : 0x2f6fb3, depthTest: false }));
  sph.position.set(...t.origin);
  sph.renderOrder = 10;
  sph.userData.nodeId = n.id;
  viewer.content.add(sph);
  if ($('chkDims').checked) {
    const el = addLabel('dim-label', `C-C ${round(Number(n.dist) || 0)}`, t.from.map((v, i) => (v + t.origin[i]) / 2));
    el.dataset.node = n.id;
    el.title = 'Centre distance to the reference pipe – click to edit';
    el.classList.toggle('sel', n.id === state.selected);
  }
}

/** Is the newest part outside the view? (then the view is refitted) */
function offScreen() {
  const n = nodeById(state.selected);
  const c = n?.type === 'part' ? centreOf(n) : null;
  if (!c || !lastAdded || lastAdded !== n.id) return false;
  lastAdded = null;
  viewer.camera.updateMatrixWorld();
  const v = new THREE.Vector3(...c).project(viewer.camera);
  return Math.abs(v.x) > 0.85 || Math.abs(v.y) > 0.85;
}
let lastAdded = null;

/** Dimension line between the centres either side of a pipe, with its value. */
function drawDimension(n, e) {
  const up = nodeById(n.parent);
  const down = childAt(n.id, 'B');
  const cc = n.dim?.mode === 'cc';
  const a = cc && up?.type === 'part' ? centreOf(up) : e.ports[0].origin;
  const b = cc ? (down?.type === 'part' ? centreOf(down) : e.ports[1].origin) : e.ports[1].origin;
  if (!a || !b) return;
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
  const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x2f6fb3, dashSize: 8, gapSize: 5, depthTest: false }));
  line.computeLineDistances();
  line.renderOrder = 5;
  viewer.content.add(line);
  const text = cc ? `${down ? 'C-C' : 'C-E'} ${round(n.dim.value)}` : `${round(n.cut)}`;
  const el = addLabel('dim-label', text, a.map((v, i) => (v + b[i]) / 2));
  el.dataset.node = n.id;
  el.title = `Cut length ${round(n.cut)} mm – click to edit`;
  el.classList.toggle('sel', n.id === state.selected);
}

function addLabel(cls, text, pos) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  const lbl = new CSS2DObject(el);
  lbl.position.set(...pos);
  viewer.content.add(lbl);
  return el;
}

function drawPort(nodeId, p) {
  const key = `${nodeId}:${p.name}`;
  const active = key === state.active;
  const r = Math.max(6, (p.od || 50) * 0.18);
  const color = active ? 0xe8792b : 0x2f6fb3;
  const grp = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 });
  const sph = new THREE.Mesh(new THREE.SphereGeometry(r * (active ? 1.4 : 1), 16, 12), mat);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(r * 0.8, r * 3, 16), mat);
  sph.renderOrder = cone.renderOrder = 10;
  const d = new THREE.Vector3(...p.dir);
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
  cone.position.copy(d.clone().multiplyScalar(r * 2.2));
  grp.add(sph, cone);
  grp.position.set(...p.origin);
  grp.traverse((o) => { o.userData.portKey = key; });
  viewer.content.add(grp);
}

// ---------------------------------------------------------------- mutations
function snapshot() { return JSON.stringify({ nodes: state.nodes, selected: state.selected, active: state.active }); }
function restore(s) { const o = JSON.parse(s); state.nodes = o.nodes; state.selected = o.selected; state.active = o.active; }

function commit(fn) {
  const before = snapshot();
  try { fn(); } catch (e) { restore(before); toast(e.message, true); return; }
  undoStack.push(before);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  rebuild();
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); rebuild(); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); rebuild(); }

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The end that continues the run: the one pointing most away from the attach end. */
function runPort(ports, attachName) {
  const own = ports.find((p) => p.name === attachName);
  const free = ports.filter((p) => p.name !== attachName);
  if (own && free.length > 1) free.sort((a, b) => dot3(a.dir, own.dir) - dot3(b.dir, own.dir));
  return free[0]?.name || null;
}

/** The open end the next part goes on, as a port with family/od. */
function activeTarget() {
  if (!state.active) return null;
  const [nodeId, name] = state.active.split(':');
  const n = nodeById(nodeId);
  const port = localPorts(n)?.find((p) => p.name === name);
  return port ? { nodeId, n, port } : null;
}

/** Ends a part could join at the active end (or the start size when empty). */
function optionsFor(part) {
  if (state.branchOn) { // stab-in: the nipple's weld end, smaller than the pipe
    const pipe = nodeById(state.branchOn);
    if (!pipe || !STAB_TYPES.includes(part.type)) return [];
    return part.ports.filter((q) => q.family === 'weld' && q.od < pipe.od * 0.9).map((port) => ({ port, viaPipe: false }));
  }
  if (!state.nodes.length) {
    const ok = part.ports.filter((p) => p.label === state.startSize);
    return ok.map((port) => ({ port, viaPipe: false }));
  }
  const t = activeTarget();
  return t ? joinOptions(t.port, part.ports) : [];
}

/** Pipe dimension that gives a default cut length between two parts. */
function defaultDim(a, b) {
  return { mode: 'cc', value: Math.ceil(dimFromCut('cc', DEFAULT_CUT, a, b) / 10) * 10 };
}

function addPart(id) {
  const part = library.parts.get(id);
  if (!part) return;
  const opts = optionsFor(part);
  if (!opts.length) { toast(`${part.name} doesn't fit the ${state.nodes.length ? 'selected end' : 'start size'}.`, true); return; }
  const opt = opts[0];
  if (state.branchOn) { addBranch(state.branchOn, part, opt.port); return; }
  const t = state.nodes.length ? activeTarget() : null;
  commit(() => {
    const n = { id: newId(), type: 'part', part: id, port: opt.port.name, roll: 0 };
    if (!t) { n.startDir = state.startDir; state.nodes.push(n); needFit = true; } else {
      let parent = t.nodeId, parentPort = t.port.name;
      if (opt.viaPipe) {
        const spec = pipeFor(t.port);
        const pipe = { id: newId(), type: 'pipe', ...spec, port: 'A', parent, parentPort, roll: 0 };
        const a = t.n.type === 'part' ? sideOf(t.n, t.port.name) : null;
        const b = { c2e: centreToEnd(opt.port, part.centre), engage: opt.port.family === 'bspF' ? opt.port.engage : 0 };
        pipe.dim = defaultDim(a, b);
        state.nodes.push(pipe);
        parent = pipe.id; parentPort = 'B';
      }
      Object.assign(n, { parent, parentPort });
      state.nodes.push(n);
    }
    const next = runPort(part.ports, n.port);
    state.active = next ? `${n.id}:${next}` : null;
    state.selected = n.id;
    lastAdded = n.id;
  });
}

/** Stab a weld nipple into a pipe, half way along it, to start a branch. */
function addBranch(pipeId, part, port) {
  const pipe = nodeById(pipeId);
  const { a, b } = pipeSides(pipe);
  const span = Math.max(pipe.cut, 0) + (a ? a.c2e - (a.engage || 0) : 0) + (b ? b.c2e - (b.engage || 0) : 0);
  state.branchOn = null;
  commit(() => {
    const n = { id: newId(), type: 'part', part: part.id, port: port.name, roll: 0, parent: pipeId, branch: { along: Math.round((span / 2) / 5) * 5, angle: 0 } };
    n.parentPort = `br:${n.id}`;
    state.nodes.push(n);
    const next = runPort(part.ports, n.port);
    state.active = next ? `${n.id}:${next}` : null;
    state.selected = n.id;
  });
}

/** Add a plain pipe on the active end (open-ended, centre-to-end dimension). */
function addPipe() {
  const t = activeTarget();
  if (!t || t.port.family === 'pipe') { toast('Pick an open end of a part first.', true); return; }
  if (!['weld', 'bspF', 'start'].includes(t.port.family)) { toast('That end takes a part, not a pipe.', true); return; }
  commit(() => {
    const spec = t.port.family === 'start'
      ? { od: t.n.od, wall: t.n.wall, label: t.n.label, threaded: !!t.n.threaded } : pipeFor(t.port);
    const a = t.n.type === 'part' ? sideOf(t.n, t.port.name) : null;
    const pipe = { id: newId(), type: 'pipe', ...spec, port: 'A', parent: t.nodeId, parentPort: t.port.name, roll: 0, dim: defaultDim(a, null) };
    state.nodes.push(pipe);
    state.active = `${pipe.id}:B`;
    state.selected = pipe.id;
  });
}

/** Start a line parallel to a pipe, at a centre distance from it. */
function addParallel(pipeId) {
  const p = nodeById(pipeId);
  if (!p || p.type !== 'pipe') return;
  commit(() => {
    const n = { id: newId(), type: 'start', port: 'in', ref: p.id, dist: Math.ceil((p.od * 3) / 50) * 50, angle: 0, along: 0, reverse: false,
      od: p.od, wall: p.wall, label: p.label, threaded: !!p.threaded };
    state.nodes.push(n);
    state.selected = n.id;
    state.active = `${n.id}:out`;
  });
}

function removeSubtree(id) {
  const kill = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of state.nodes) {
      // what hangs off it, and parallel lines measured from it
      if (!kill.has(n.id) && ((n.parent && kill.has(n.parent)) || (n.type === 'start' && kill.has(n.ref)))) { kill.add(n.id); grew = true; }
    }
  }
  state.nodes = state.nodes.filter((n) => !kill.has(n.id));
}

/** Delete a node and everything beyond it (a part also takes the pipe leading to it). */
function deleteNode(id) {
  let n = nodeById(id);
  if (!n) return;
  commit(() => {
    const up = nodeById(n.parent);
    if (n.type === 'part' && up?.type === 'pipe' && n.parentPort === 'B' && childrenOf(up.id).length === 1) n = up; // its pipe goes too
    removeSubtree(n.id);
    state.active = n.parent ? `${n.parent}:${n.parentPort}` : null;
    state.selected = null;
  });
}

function rollNode(id, delta) {
  commit(() => { const n = nodeById(id); n.roll = (((Number(n.roll) || 0) + delta) % 360 + 540) % 360 - 180; });
}

/** Ends of a placed part it could be attached by, where it is. */
function attachOptions(n) {
  const part = partOf(n);
  if (!part) return [];
  if (!n.parent) return part.ports.map((p) => p.name);
  const target = localPorts(nodeById(n.parent))?.find((p) => p.name === n.parentPort);
  return target ? joinOptions(target, part.ports).map((o) => o.port.name) : [];
}

/** Attach a part by another of its ends; what was on that end moves to the old one. */
function setAttach(id, name) {
  const n = nodeById(id);
  if (!n || n.port === name) return;
  commit(() => {
    for (const c of childrenOf(n.id)) if (c.parentPort === name) c.parentPort = n.port;
    if (state.active === `${n.id}:${name}`) state.active = `${n.id}:${n.port}`;
    n.port = name;
  });
}

/** Describe an end of a part: "Branch – 40NB butt-weld". */
function portText(part, port) {
  const e = part.ends?.[Number(port.name)] || {};
  const isTee = part.category === 'tee' && part.ports.length === 3;
  const runs = isTee ? part.ends.map((x, i) => (x.role === 'branch' ? -1 : i)).filter((i) => i >= 0) : [];
  const role = isTee ? (e.role === 'branch' ? 'Branch' : `Run end ${runs.indexOf(Number(port.name)) + 1}`) : `End ${Number(port.name) + 1}`;
  return `${role} – ${port.label || ''} ${(e.end || port.family || '').replace(/\s*\(.*\)/, '')}`.trim();
}

/** Attach the part by its next end that fits the same joint. */
function flipNode(id) {
  const n = nodeById(id);
  const part = partOf(n);
  if (!part) return;
  let opts;
  if (n.parent) {
    const target = localPorts(nodeById(n.parent))?.find((p) => p.name === n.parentPort);
    opts = target ? joinOptions(target, part.ports).map((o) => o.port.name) : [];
  } else opts = part.ports.map((p) => p.name); // the first part can start from any end
  if (opts.length < 2) { toast('This part only fits one way round here.'); return; }
  commit(() => {
    const next = opts[(opts.indexOf(n.port) + 1) % opts.length];
    for (const c of childrenOf(n.id)) if (c.parentPort === next) c.parentPort = n.port;
    if (state.active === `${n.id}:${next}`) state.active = `${n.id}:${n.port}`;
    n.port = next;
  });
}

function setDim(id, mode, value) {
  commit(() => {
    const n = nodeById(id);
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) throw new Error('Enter a length in mm');
    n.dim = { mode, value: v };
  });
}

// ------------------------------------------------------------------- panels
let labelOd = new Map(); // size label -> OD, for sorting
const sizeOrder = (label) => labelOd.get(label) || 0;

/** Pipe types: the Part-Library systems that are pipe or tube (not valves or adapters). */
function pipeTypes() {
  return library.systems.filter((sy) => !SHARED_SYSTEMS.includes(sy.system) && library.list().some((p) => p.system === sy.system));
}
const inPipeType = (p) => state.pipeType === 'any' || p.system === state.pipeType;

function renderStartSizes() {
  labelOd = new Map();
  for (const p of library.parts.values()) for (const e of p.ports) if (!labelOd.has(e.label)) labelOd.set(e.label, e.od);
  const types = pipeTypes();
  if (state.pipeType !== 'any' && !types.some((t) => t.system === state.pipeType)) state.pipeType = types[0]?.system || 'any';
  $('selType').innerHTML = types.map((t) => `<option value="${esc(t.system)}" ${t.system === state.pipeType ? 'selected' : ''}>${esc(t.name)}</option>`).join('')
    + `<option value="any" ${state.pipeType === 'any' ? 'selected' : ''}>Any</option>`;
  const labels = [...new Set(library.list().filter(inPipeType).flatMap((p) => p.ports.map((e) => e.label)))].sort((a, b) => sizeOrder(a) - sizeOrder(b));
  if (!labels.includes(state.startSize)) state.startSize = labels.find((l) => /50NB/.test(l)) || labels[0] || null;
  $('selStart').innerHTML = labels.map((l) => `<option ${l === state.startSize ? 'selected' : ''}>${esc(l)}</option>`).join('');
}

const FAMILY_TEXT = { weld: 'weld end', bspF: 'BSP female', bspM: 'BSP male', rjtM: 'RJT male', rjtF: 'RJT female', flange: 'flange face', wafer: 'wafer face', pipe: 'pipe end' };

function renderPartList() {
  const empty = !state.nodes.length;
  $('startSizeRow').hidden = !empty;
  $('pipeTypeRow').hidden = !empty;
  $('startDirRow').hidden = !empty;
  if (state.branchOn && !nodeById(state.branchOn)) state.branchOn = null;
  const t = empty || state.branchOn ? null : activeTarget();
  $('nextEnd').innerHTML = state.branchOn
    ? `Branch on: <b>${esc(nodeLabel(nodeById(state.branchOn)))}</b> – pick a weld nipple <button id="brCancel" class="link">Cancel</button>`
    : empty
    ? '<span class="hint">Pick the first part. The orange end shows where the next one goes.</span>'
    : t ? `Next on: <b>${esc(t.port.label || `Ø${t.port.od}`)}</b> ${esc(FAMILY_TEXT[t.port.family] || '')}`
      : '<span class="hint">No open end selected – click a blue marker in the view.</span>';
  const q = $('partSearch').value.toLowerCase().trim();
  const words = q.split(/\s+/).filter(Boolean);
  const fits = (empty || t || state.branchOn) ? library.list().filter((p) => optionsFor(p).length
    && (!empty || inPipeType(p) || SHARED_SYSTEMS.includes(p.system))
    && words.every((w) => `${p.search || ''} ${p.name} ${p.id}`.toLowerCase().includes(w))) : [];
  // filter chips: one per part group that has something fitting here
  const counts = new Map();
  for (const p of fits) counts.set(groupOf(p), (counts.get(groupOf(p)) || 0) + 1);
  // one part type at a time (or All)
  const shown = partGroup === 'All' || !counts.has(partGroup) ? 'All' : partGroup;
  const chip = (g, n) => `<button class="chip ${g === partGroup ? 'on' : ''}" data-group="${esc(g)}" role="radio" aria-checked="${g === partGroup}">${esc(g)} <span>${n}</span></button>`;
  $('groupChips').innerHTML = chip('All', fits.length) + GROUPS.map(([g]) => g).filter((g) => counts.has(g)).map((g) => chip(g, counts.get(g))).join('');
  const list = shown === 'All' ? fits : fits.filter((p) => groupOf(p) === shown);
  const groups = new Map(GROUPS.map(([g]) => [g, []]));
  for (const p of list) {
    const g = groupOf(p);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  let html = '';
  for (const [g, ps] of [...groups].filter(([, ps]) => ps.length)) {
    html += `<div class="cat">${esc(g)}</div>`;
    for (const p of ps.sort((a, b) => (a.type_name || '').localeCompare(b.type_name || '') || (a.ports[0]?.od || 0) - (b.ports[0]?.od || 0) || a.id.localeCompare(b.id))) {
      const via = !empty && optionsFor(p)[0].viaPipe ? '<span class="badge ok" title="Joined with a pipe">+ pipe</span>' : '';
      const twin = ps.some((q) => q !== p && q.type_name === p.type_name && q.size_label === p.size_label);
      html += `<div class="item" data-part="${esc(p.id)}" title="${esc(`${p.id} – ${p.description}`)}">${esc(p.type_name || p.type)}${twin ? ` <span class="hint">${esc(p.kit ? '' : p.id)}</span>` : ''}<span class="meta">${via} ${esc(p.size_label || '')}</span></div>`;
    }
  }
  const note = partGroup !== 'All' && shown === 'All' && fits.length ? `<p class="hint">No ${esc(partGroup.toLowerCase())} fit here – showing everything that does.</p>` : '';
  $('partList').innerHTML = note + (html || `<p class="hint">${!library.parts.size ? 'Open your Part-Library folder to see parts.' : 'Nothing in the library fits here.'}</p>`);
  if ($('brCancel')) $('brCancel').onclick = () => { state.branchOn = null; renderPartList(); };
}

function renderTree() {
  const errById = new Map(solved.errors.map((e) => [e.id, e.message]));
  let html = '';
  const walk = (parent, depth) => {
    for (const n of state.nodes.filter((x) => (x.parent || null) === parent)) {
      const extra = n.type === 'pipe' ? `${round(n.cut)} mm` : n.type === 'start' ? `C-C ${round(Number(n.dist) || 0)}` : (partOf(n)?.size_label || '');
      const name = n.type === 'pipe' ? 'Pipe' : n.type === 'start' ? 'Parallel line' : (partOf(n)?.type_name || n.part);
      const cls = ['item', n.id === state.selected ? 'sel' : '', errById.has(n.id) ? 'err' : ''].join(' ');
      html += `<div class="${cls}" data-node="${n.id}" style="padding-left:${6 + depth * 10}px" title="${esc(errById.get(n.id) || '')}">`
        + `${esc(n.tag ? `${n.tag} – ` : '')}${esc(name)}<span class="meta">${esc(extra)}</span></div>`;
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  $('tree').innerHTML = html || '<p class="hint">Empty. Pick a part on the left to start.</p>';
}

function renderProps() {
  const el = $('props');
  const n = nodeById(state.selected);
  if (!n) {
    el.innerHTML = `<h3>How to</h3><p class="hint">1. Pick a part on the left – it goes on the <b>orange</b> end.<br>
      2. Select it to roll it (<kbd>R</kbd>) or turn it round (<kbd>X</kbd>).<br>
      3. Click a pipe or its dimension to set the centre-to-centre.<br>
      Click a blue marker to carry on from another open end.</p>`;
    return;
  }
  const err = solved.errors.filter((e) => e.id === n.id).map((e) => esc(e.message)).join('<br>');
  if (n.type === 'pipe') {
    const down = childAt(n.id, 'B');
    const cc = n.dim?.mode === 'cc';
    el.innerHTML = `
      <h4>Pipe ${esc(n.label)}</h4>
      <div class="hint">Ø${n.od} × ${n.wall} mm${n.threaded ? ', threaded' : ''}</div>
      <div class="grid">
        <span>Dimension</span>
        <select id="propMode">
          <option value="cc" ${cc ? 'selected' : ''}>${down ? 'Centre to centre' : 'Centre to end'}</option>
          <option value="cut" ${cc ? '' : 'selected'}>Cut length</option>
        </select>
        <span>mm</span><input id="propDim" type="number" min="0" step="1" value="${round(n.dim?.value ?? n.cut)}">
        <span>Cut length</span><b>${round(n.cut)} mm</b>
      </div>
      <div class="btns">
        <button id="propClose" title="No pipe: the parts weld or screw straight together">Close-coupled</button>
        <button id="propPar" title="Start a new line parallel to this pipe, at a centre distance">Parallel line…</button>
        <button id="propBranch" title="Stab a weld nipple into this pipe to start a branch">Branch…</button>
        <button id="propDel" class="danger" title="Delete this pipe and everything beyond it (Del)">Delete</button>
      </div>
      ${err ? `<div class="msg">${err}</div>` : ''}`;
    const apply = () => setDim(n.id, $('propMode').value, $('propDim').value);
    $('propDim').onchange = apply;
    $('propDim').onkeydown = (e) => { if (e.key === 'Enter') apply(); };
    $('propMode').onchange = () => {
      const { a, b } = pipeSides(n);
      const mode = $('propMode').value;
      setDim(n.id, mode, round(dimFromCut(mode, Math.max(n.cut, 0), a, b)));
    };
    $('propClose').onclick = () => setDim(n.id, 'cut', 0);
    $('propPar').onclick = () => addParallel(n.id);
    $('propBranch').onclick = () => { state.branchOn = n.id; renderPartList(); toast('Pick a weld nipple to stab into this pipe'); };
    $('propDel').onclick = () => deleteNode(n.id);
    setTimeout(() => { const f = $('propDim'); if (f && document.activeElement === document.body) { f.focus(); f.select(); } }, 30);
    return;
  }
  if (n.type === 'start') {
    el.innerHTML = `
      <h4>Parallel line ${esc(n.label)}</h4>
      <div class="hint">Starts beside ${esc(nodeLabel(nodeById(n.ref)))}. Add parts or a pipe (<kbd>P</kbd>) on its orange end.</div>
      <div class="grid">
        <span>Centre dist.</span><input id="parDist" type="number" step="5" min="0" value="${round(Number(n.dist) || 0)}" aria-label="Centre distance in mm">
        <span>Side</span><div class="rollbtns">
          <button id="parRotM" title="Turn the side −90° about the pipe">⟲ 90°</button>
          <button id="parRotP" title="Turn the side +90° about the pipe">⟳ 90°</button>
          <input id="parAngle" type="number" step="15" value="${Number(n.angle) || 0}" aria-label="Side angle in degrees">°
        </div>
        <span>Along</span><input id="parAlong" type="number" step="10" value="${round(Number(n.along) || 0)}" title="Distance along the reference pipe from its start" aria-label="Offset along the pipe in mm">
        <span>Direction</span><label class="inline"><input type="checkbox" id="parRev" ${n.reverse ? 'checked' : ''}> Run the other way</label>
      </div>
      <div class="btns"><button id="propDel" class="danger" title="Delete this line and everything on it (Del)">Delete</button></div>
      ${err ? `<div class="msg">${err}</div>` : ''}`;
    const set = (k, v) => commit(() => { n[k] = v; });
    $('parDist').onchange = (e) => set('dist', Math.max(0, Number(e.target.value) || 0));
    $('parDist').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
    $('parAngle').onchange = (e) => set('angle', Number(e.target.value) || 0);
    $('parRotM').onclick = () => set('angle', ((Number(n.angle) || 0) - 90 + 360) % 360);
    $('parRotP').onclick = () => set('angle', ((Number(n.angle) || 0) + 90) % 360);
    $('parAlong').onchange = (e) => set('along', Number(e.target.value) || 0);
    $('parRev').onchange = (e) => set('reverse', e.target.checked);
    $('propDel').onclick = () => deleteNode(n.id);
    return;
  }
  const p = partOf(n);
  const attachOpts = attachOptions(n);
  const free = (p?.ports || []).filter((q) => q.name !== n.port && !childAt(n.id, q.name));
  el.innerHTML = `
    <h4>${esc(nodeLabel(n))}</h4>
    <div class="hint">${esc(p?.id || n.part)} – ${esc(p?.description || '')}</div>
    <div class="grid">
      <span>Tag</span><input id="propTag" value="${esc(n.tag || '')}" placeholder="e.g. V-101">
      ${n.branch ? `<span>Along pipe</span><input id="brAlong" type="number" step="5" value="${round(Number(n.branch.along) || 0)}" title="From the upstream fitting centre (mm)" aria-label="Distance along the pipe in mm">
      <span>Round pipe</span><div class="rollbtns"><button id="brM" title="−90°">⟲ 90°</button><button id="brP" title="+90°">⟳ 90°</button>
        <input id="brAngle" type="number" step="15" value="${Number(n.branch.angle) || 0}" aria-label="Angle round the pipe in degrees">°</div>` : ''}
      ${p?.turn ? `<span>Handle</span><div class="seg"><button id="hOpen" class="${n.handle === 'closed' ? '' : 'on'}">Open</button><button id="hClosed" class="${n.handle === 'closed' ? 'on' : ''}">Closed</button></div>` : ''}
      ${!n.parent ? `<span>Start</span><select id="propDir">${Object.entries(DIR_TEXT).map(([k, t]) => `<option value="${k}" ${k === (n.startDir || '+X') ? 'selected' : ''}>${t}</option>`).join('')}</select>` : ''}
      ${attachOpts.length > 1 ? `<span>Connected by</span><select id="propAttach">${attachOpts.map((nm) => `<option value="${nm}" ${nm === n.port ? 'selected' : ''}>${esc(portText(p, p.ports.find((q) => q.name === nm)))}</option>`).join('')}</select>` : ''}
      ${free.length > 1 ? `<span>Next part on</span><select id="propNext">${free.map((q) => `<option value="${q.name}" ${state.active === `${n.id}:${q.name}` ? 'selected' : ''}>${esc(portText(p, q))}</option>`).join('')}</select>` : ''}
      <span>Roll</span><div class="rollbtns">
        <button id="propRollM" title="Roll −90° (Shift+R)">⟲ 90°</button>
        <button id="propRollP" title="Roll +90° (R)">⟳ 90°</button>
        <input id="propRoll" type="number" step="15" value="${Number(n.roll) || 0}" aria-label="Roll angle in degrees">°
      </div>
    </div>
    <div class="btns">
      <button id="propFlip" title="Attach by its next end (X)" ${attachOpts.length > 1 ? '' : 'disabled'}>Turn round</button>
      <button id="propDel" class="danger" title="Delete this part and everything beyond it (Del)">Delete</button>
    </div>
    ${err ? `<div class="msg">${err}</div>` : ''}`;
  $('propTag').onchange = (e) => commit(() => { n.tag = e.target.value.trim(); });
  if (n.branch) {
    const setB = (k, v) => commit(() => { n.branch = { ...n.branch, [k]: v }; });
    $('brAlong').onchange = (e) => setB('along', Number(e.target.value) || 0);
    $('brAngle').onchange = (e) => setB('angle', Number(e.target.value) || 0);
    $('brM').onclick = () => setB('angle', ((Number(n.branch.angle) || 0) - 90 + 360) % 360);
    $('brP').onclick = () => setB('angle', ((Number(n.branch.angle) || 0) + 90) % 360);
  }
  if (p?.turn) {
    $('hOpen').onclick = () => commit(() => { delete n.handle; });
    $('hClosed').onclick = () => commit(() => { n.handle = 'closed'; });
  }
  if ($('propDir')) $('propDir').onchange = (e) => commit(() => { n.startDir = e.target.value; state.startDir = e.target.value; needFit = true; });
  if ($('propAttach')) $('propAttach').onchange = (e) => setAttach(n.id, e.target.value);
  if ($('propNext')) {
    if (!free.some((q) => state.active === `${n.id}:${q.name}`)) $('propNext').selectedIndex = -1;
    $('propNext').onchange = (e) => { state.active = `${n.id}:${e.target.value}`; draw(); renderPartList(); };
  }
  $('propRollM').onclick = () => rollNode(n.id, -90);
  $('propRollP').onclick = () => rollNode(n.id, 90);
  $('propRoll').onchange = (e) => commit(() => { n.roll = Number(e.target.value) || 0; });
  $('propFlip').onclick = () => flipNode(n.id);
  $('propDel').onclick = () => deleteNode(n.id);
}

function renderStatus() {
  const errs = solved.errors;
  const pipes = state.nodes.filter((n) => n.type === 'pipe');
  const total = pipes.reduce((s, n) => s + Math.max(n.cut, 0), 0);
  const count = state.nodes.length - pipes.length;
  let html = `${count} part${count === 1 ? '' : 's'}, ${pipes.length} pipe${pipes.length === 1 ? '' : 's'} (${round(total / 1000, 2)} m)`;
  if (errs.length) html += ` · <span class="bad">${esc(errs[0].message)}${errs.length > 1 ? ` (+${errs.length - 1} more)` : ''}</span>`;
  $('status').innerHTML = html;
}

// -------------------------------------------------------------------- BOM
function bom() {
  const rows = new Map();
  for (const n of state.nodes) {
    if (n.type === 'part') {
      for (const m of membersOf(partOf(n))) { // a kit lists its halves
        const p = library.parts.get(m.part);
        const k = `part|${m.part}`;
        if (!rows.has(k)) rows.set(k, { item: m.part, desc: p?.description || m.part, size: p?.size_label || '', qty: 0, tags: [] });
        const r = rows.get(k);
        r.qty++;
        if (n.tag) r.tags.push(n.tag);
      }
    }
  }
  const out = [...rows.values()].map((r) => ({ ...r, notes: r.tags.join(' ') }));
  const pipes = state.nodes.filter((n) => n.type === 'pipe' && n.cut > 0);
  for (const n of pipes) out.push({ item: 'Pipe', desc: `Pipe ${n.label} Ø${n.od}×${n.wall}${n.threaded ? ' threaded' : ''}`, size: n.label, qty: 1, notes: `cut ${round(n.cut)} mm` });
  return out;
}

function showBom() {
  const rows = bom();
  $('bomBody').innerHTML = rows.length ? `<table class="bom"><tr><th>Item</th><th>Description</th><th>Size</th><th>Qty</th><th>Notes</th></tr>${rows.map((r) => `<tr><td>${esc(r.item)}</td><td>${esc(r.desc)}</td><td>${esc(r.size)}</td><td class="num">${r.qty}</td><td>${esc(r.notes)}</td></tr>`).join('')}</table>` : '<p class="hint">The spool is empty.</p>';
  $('dlgBom').showModal();
}

function spoolData() {
  return { app: 'pipe-spool-tool', version: 2, name: state.name, pipeType: state.pipeType, startSize: state.startSize, startDir: state.startDir, nodes: state.nodes.map(({ cut, gap, target, ...n }) => n) };
}

// ----------------------------------------------------------------- export
let expViewer = null;
let built = null; // {sig, stats}

function exportSettings() {
  const level = document.querySelector('input[name=expLevel]:checked').value;
  return { level, res: Number($('expRes').value), hollow: $('expHollow').checked };
}

function exportItems() {
  const items = [];
  for (const n of state.nodes) {
    const e = solved.placed.get(n.id);
    if (!e) continue;
    if (n.type === 'pipe') {
      if (n.cut > 0.01) items.push({ kind: 'pipe', od: n.od, id: n.od - 2 * n.wall, length: n.cut, matrix: e.matrix });
    } else if (n.type === 'part') {
      for (const m of membersOf(partOf(n))) {
        const p = library.parts.get(m.part);
        if (!p) continue;
        items.push({
          kind: 'part', key: library.cacheKey(m.part), part: m.part, matrix: mul(e.matrix, m.matrix), name: p.name,
          geom: { ends: p.ports.map((q) => ({ o: q.origin, d: q.dir, engage: q.engage })), c: p.centre }, ods: p.ports.map((q) => q.od),
          ends: p.ends, info: { category: p.category, type: p.type },
          turn: p.turn, stem: p.stem, closed: n.handle === 'closed',
        });
      }
    }
  }
  return items;
}

function syncExportForm() {
  const { level, res } = exportSettings();
  $('expResRow').hidden = level !== 'wrap';
  $('expHollowRow').hidden = level !== 'full';
  $('expResOut').textContent = `${res} mm`;
  const stale = built && built.sig !== JSON.stringify({ ...exportSettings(), nodes: spoolData().nodes });
  $('expGo').textContent = built && !stale ? 'Download STEP' : 'Build and download';
  if (stale) $('expStats').textContent = 'Settings changed – build the preview again to see the result.';
}

async function exportStep() {
  if (!state.nodes.length) { toast('Nothing to export yet', true); return; }
  if (solved.errors.length && !await ask(`${solved.errors[0].message}. Export anyway?`, { ok: 'Continue' })) return;
  $('expMsg').textContent = '';
  built = null;
  $('expStats').textContent = 'Build a preview to see the size of the file.';
  $('dlgExport').showModal();
  if (!expViewer) expViewer = new Viewer($('expView'));
  expViewer.clear();
  expViewer.resize();
  expViewer.render();
  syncExportForm();
}

async function buildExport() {
  const msg = (t) => { $('expMsg').textContent = t; };
  const settings = exportSettings();
  const sig = JSON.stringify({ ...settings, nodes: spoolData().nodes });
  if (built?.sig === sig) return built;
  $('expBuild').disabled = $('expGo').disabled = true;
  const t0 = performance.now();
  try {
    msg('Loading the CAD engine…');
    await startCad();
    const items = exportItems();
    for (const it of items) if (it.kind === 'part') { msg(`Reading ${it.name}…`); await parts.ensureKernel(it.part); }
    msg(settings.level === 'full' ? 'Merging the full models… (large valves can take a minute)' : 'Shrink-wrapping the parts…');
    const runs = state.nodes.filter((n) => !n.parent).length;
    const res = await cad.build({ items, level: settings.level, res: settings.res, hollow: settings.hollow, runs });
    const { bytes } = await cad.writeStep({ name: state.name });
    built = { sig, bytes, warnings: res.warnings };
    expViewer.clear();
    const g = geometryFromMesh(res.mesh);
    g.userData.shared = false;
    expViewer.content.add(new THREE.Mesh(g, material('fitting', false)));
    expViewer.resize();
    expViewer.fit();
    $('expStats').innerHTML = `<b>${(bytes.length / 1024 / 1024).toFixed(2)} MB</b> · ${res.faces} faces · ${res.solids} solid${res.solids === 1 ? '' : 's'} · built in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    msg(res.warnings.join(' '));
    return built;
  } catch (e) {
    msg(`Export failed: ${e.message}`);
    return null;
  } finally {
    $('expBuild').disabled = $('expGo').disabled = false;
    syncExportForm();
  }
}

async function downloadExport() {
  const b = await buildExport();
  if (!b) return;
  try {
    const saved = await saveFile(`${state.name}.stp`, b.bytes, 'application/step');
    if (!saved) { $('expMsg').textContent = 'Download cancelled.'; return; }
    $('dlgExport').close();
    toast(`Saved ${saved}`);
  } catch (e) { $('expMsg').textContent = e.message; }
}

// ------------------------------------------------------------ save / open
const readSpools = () => { try { return JSON.parse(localStorage.getItem(SPOOLS_KEY)) || {}; } catch { return {}; } };

function saveSpool() {
  state.name = $('projectName').value.trim() || 'Spool';
  const all = readSpools();
  all[state.name] = spoolData();
  try { localStorage.setItem(SPOOLS_KEY, JSON.stringify(all)); toast(`Saved ${state.name} in this browser`); } catch { toast('This browser blocked saving – use Download .json instead', true); }
}

function loadSpool(data) {
  if (data?.nodes?.length && data.version !== 2) { toast('That spool was made with the old version of the tool and can’t be opened.', true); return; }
  state.name = data.name || 'Spool';
  $('projectName').value = state.name;
  if (data.startSize) state.startSize = data.startSize;
  if (data.pipeType) state.pipeType = data.pipeType;
  if (data.startDir) { state.startDir = data.startDir; $('selDir').value = data.startDir; }
  state.branchOn = null;
  state.nodes = data.nodes || [];
  state.selected = null;
  state.active = null;
  undoStack.length = 0;
  redoStack.length = 0;
  const missing = state.nodes.filter((n) => n.type === 'part' && !library.parts.has(n.part));
  if (missing.length) toast(`${missing.length} part${missing.length === 1 ? ' is' : 's are'} not in the open library – open your Part-Library folder.`, true, 7000);
  renderStartSizes();
  needFit = true;
  rebuild();
}

function showOpen() {
  const names = Object.keys(readSpools()).sort();
  $('projectList').innerHTML = names.length
    ? names.map((n) => `<div class="item" data-proj="${esc(n)}">${esc(n)}<span class="meta"><button data-del="${esc(n)}" title="Delete" aria-label="Delete ${esc(n)}">✕</button></span></div>`).join('')
    : '<p class="hint">No spools saved in this browser yet.</p>';
  $('dlgOpen').showModal();
}

// ---------------------------------------------------------------- library
async function renderLibraryBar() {
  const demo = library.source === 'demo';
  const remembered = demo ? await library.rememberedName() : null;
  $('libFolder').innerHTML = demo
    ? `<b>Demo parts</b> <span class="hint">(${library.parts.size} parts, 50NB / 40NB Sch 10S)${remembered ? ` – last used: <b>${esc(remembered)}</b>` : ''}</span>`
    : `<b>${esc(library.name)}</b> <span class="hint">${library.parts.size} parts</span>`;
  $('btnReconnect').hidden = !remembered;
}

async function openLibrary() {
  if (library.canPickDirectory) {
    try { await library.pickDirectory(); } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); return; }
    afterLibraryChange();
  } else {
    $('libInput').click();
  }
}

function afterLibraryChange() {
  meshes.clear();
  renderLibraryBar();
  renderStartSizes();
  toast(`Library loaded: ${library.parts.size} parts`);
  rebuild();
}

// -------------------------------------------------------------------- events
function wire() {
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => viewer.setView(b.dataset.view)));
  $('btnFit').onclick = () => viewer.fit();
  $('btnUndo').onclick = undo;
  $('btnRedo').onclick = redo;
  $('chkDims').onchange = draw;
  $('selStart').onchange = (e) => { state.startSize = e.target.value; renderPartList(); };
  $('selType').onchange = (e) => { state.pipeType = e.target.value; renderStartSizes(); renderPartList(); };
  $('groupChips').onclick = (e) => {
    const b = e.target.closest('[data-group]');
    if (!b) return;
    partGroup = b.dataset.group;
    try { localStorage.setItem('pipe-spool-tool.partGroup', partGroup); } catch { /* ignore */ }
    renderPartList();
  };
  $('selDir').onchange = (e) => { state.startDir = e.target.value; };
  $('partSearch').oninput = renderPartList;
  $('partSearch').onkeydown = (e) => {
    if (e.key === 'Enter') { const first = $('partList').querySelector('[data-part]'); if (first) { addPart(first.dataset.part); e.target.blur(); } }
    if (e.key === 'Escape') e.target.blur();
  };
  $('partList').onclick = (e) => { const it = e.target.closest('[data-part]'); if (it) addPart(it.dataset.part); };
  $('btnOpenLib').onclick = openLibrary;
  $('btnReconnect').onclick = async () => {
    try { if (await library.reconnect(true) === true) afterLibraryChange(); else toast('Permission was not given', true); } catch (e) { toast(e.message, true); }
  };
  $('libInput').onchange = async (e) => {
    if (!e.target.files.length) return;
    try { await library.loadFileList(e.target.files); afterLibraryChange(); } catch (err) { toast(err.message, true); }
    e.target.value = '';
  };
  $('tree').onclick = (e) => {
    const it = e.target.closest('[data-node]');
    if (!it) return;
    state.selected = it.dataset.node;
    draw(); renderTree(); renderProps();
  };
  $('viewport').addEventListener('click', (e) => {
    const lbl = e.target.closest('.dim-label[data-node]');
    if (!lbl) return;
    state.selected = lbl.dataset.node;
    draw(); renderTree(); renderProps();
    setTimeout(() => { const f = $('propDim'); if (f) { f.focus(); f.select(); } }, 30);
  });
  $('projectName').onchange = (e) => { state.name = e.target.value.trim() || 'Spool'; };
  $('btnNew').onclick = async () => {
    if (state.nodes.length && !await ask('Start a new spool? Unsaved changes are lost.', { ok: 'New spool' })) return;
    loadSpool({ version: 2, name: 'Spool-01', pipeType: state.pipeType, startSize: state.startSize, nodes: [] });
  };
  $('btnSave').onclick = saveSpool;
  $('btnOpen').onclick = showOpen;
  $('projectList').onclick = async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      if (!await ask(`Delete the saved spool “${del.dataset.del}”?`, { ok: 'Delete' })) return;
      const all = readSpools(); delete all[del.dataset.del];
      try { localStorage.setItem(SPOOLS_KEY, JSON.stringify(all)); } catch { /* ignore */ }
      showOpen();
      return;
    }
    const it = e.target.closest('[data-proj]');
    if (it) { loadSpool(readSpools()[it.dataset.proj]); $('dlgOpen').close(); }
  };
  $('importJson').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { loadSpool(JSON.parse(await f.text())); $('dlgOpen').close(); } catch (err) { toast(`Could not read that file: ${err.message}`, true); }
    e.target.value = '';
  };
  $('btnDownloadJson').onclick = async () => {
    try { await saveFile(`${state.name}.json`, JSON.stringify(spoolData(), null, 2), 'application/json'); } catch (err) { toast(err.message, true); }
  };
  $('btnBom').onclick = showBom;
  $('bomCsv').onclick = async () => {
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = ['Item,Description,Size,Qty,Notes', ...bom().map((r) => [r.item, r.desc, r.size, r.qty, r.notes].map(q).join(','))].join('\r\n');
    try { await saveFile(`${state.name}-BOM.csv`, csv, 'text/csv'); } catch (err) { toast(err.message, true); }
  };
  $('btnExport').onclick = exportStep;
  $('expBuild').onclick = buildExport;
  $('expGo').onclick = downloadExport;
  document.querySelectorAll('input[name=expLevel]').forEach((r) => { r.onchange = syncExportForm; });
  $('expRes').oninput = syncExportForm;
  $('expHollow').onchange = syncExportForm;
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  let down = null;
  const canvas = viewer.renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || e.button !== 0) return;
    const hits = viewer.pick(e, viewer.content.children);
    const portHit = hits.find((h) => h.object.userData.portKey);
    if (portHit) {
      state.active = portHit.object.userData.portKey;
      state.selected = state.active.split(':')[0];
    } else {
      const h = hits.find((x) => x.object.userData.nodeId);
      state.selected = h ? h.object.userData.nodeId : null;
    }
    draw(); renderTree(); renderProps(); renderStatus(); renderPartList();
  });

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    const sel = state.selected;
    if (e.ctrlKey || e.metaKey) {
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); } else if (k === 'y') { e.preventDefault(); redo(); } else if (k === 's') { e.preventDefault(); saveSpool(); }
      return;
    }
    if (k === '/' || k === 'f') { e.preventDefault(); $('partSearch').focus(); $('partSearch').select(); }
    else if (k === 'p') addPipe();
    else if (k === 'r' && sel) rollNode(sel, e.shiftKey ? -90 : 90);
    else if (k === 'x' && sel) flipNode(sel);
    else if ((k === 'delete' || k === 'backspace') && sel) { e.preventDefault(); deleteNode(sel); }
    else if (k === 'n' && open.length) {
      const keys = open.map((o) => `${o.nodeId}:${o.port.name}`);
      state.active = keys[(keys.indexOf(state.active) + 1) % keys.length];
      draw(); renderPartList();
    } else if (k === 'home') viewer.fit();
    else if (k === 'escape') { state.selected = null; draw(); renderTree(); renderProps(); }
  });
}

// ---------------------------------------------------------------------- init
function showEngineProgress(done, total) {
  const el = $('engine');
  if (total) el.textContent = `Loading CAD engine… ${Math.round(done / 1e6)} / ${Math.round(total / 1e6)} MB`;
}

async function init() {
  library.loadDemo(window.SPOOL_DEMO || { library: { parts: {} }, geometry: { parts: {} }, files: {} });
  wire();
  try { if (await library.reconnect(false) === true) meshes.clear(); } catch { /* needs a click */ }
  renderLibraryBar();
  renderStartSizes();
  const last = await kvGet('lastSpool');
  if (last?.nodes?.length && last.version === 2) loadSpool(last); else rebuild();
  $('engine').hidden = false;
  startCad(showEngineProgress)
    .then(() => { $('engine').hidden = true; })
    .catch((e) => { $('engine').textContent = `CAD engine failed to load: ${e.message}. Check the internet connection and reload the page.`; $('engine').classList.add('bad'); });
}

init().catch((e) => toast(`Failed to start: ${e.message}`, true, 10000));
