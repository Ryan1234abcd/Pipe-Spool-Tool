// Spool builder: main application (runs entirely in the browser).
//
// Insert parts from the library, roll them, and set centre-to-centre (or
// cut-length) dimensions on the pipes between them. A part can only go on an
// open end it fits: same pipe size and a matching connection.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { Viewer, toMatrix4, geometryFromMesh } from './viewer.js';
import { solve, openPorts, pipePorts, applyPoint, mul, rotate, cross, defaultUp } from './kinematics.js';
import { joinOptions, directJoin, pipeFor, centreToEnd, cutLength, dimFromCut } from './joints.js';
import { Library, kvGet, kvSet, GROUPS, groupOf } from './library.js';
import { createPartLoader } from './parts.js';
import { startCad, cad } from './cad-client.js';
import { toast, esc, ask, saveFile } from './ui.js';
import { revitFile, NATIVE_GROUPS } from './revit.js';
import { runPort, canJoin, removeNode, moveNode, insertChain, alignFix, alignPipes } from './edit.js';

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
  insertAt: null, // {pipe} or {node, port} while picking a part to insert there
  alignFor: null, // node id while lining it up with another (alignRef once picked)
  alignRef: null,
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
  if (n.type === 'start') return `Start point ${n.label}`;
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

/** Pipe lengths from their dimensions, then where everything goes. */
function solveAll() {
  for (const n of state.nodes) {
    if (n.type !== 'pipe') continue;
    const { a, b } = pipeSides(n);
    n.cut = round(cutLength(n.dim, a, b), 2);
  }
  for (const n of state.nodes) n.gap = jointGap(n);
  solved = solve(state.nodes, localPorts); // start points sit at their own origin (rootTarget)
}

const editCtx = () => ({ nodes: state.nodes, portsOf: localPorts, placed: solved.placed, centreOf });

/** Write a pipe's cut length back as its dimension, in its own mode (C-C or cut). */
function setCut(pipe, cut) {
  const mode = pipe.dim?.mode || 'cc';
  const { a, b } = pipeSides(pipe);
  pipe.dim = { mode, value: round(dimFromCut(mode, Math.max(0, cut), a, b), 2) };
}

/** Locked alignments: change their pipes until everything lines up again. */
function applyLocks() {
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const n of state.nodes) {
      if (!n.align) continue;
      try {
        const f = alignFix(editCtx(), { ...n.align, id: n.id });
        const pipe = nodeById(f.pipe);
        if (Math.abs(f.cut - pipe.cut) > 0.01) { setCut(pipe, f.cut); changed = true; }
      } catch (e) {
        toast(`${nodeLabel(n)} is no longer lined up: ${e.message}`, true);
        delete n.align;
      }
    }
    if (!changed) return;
    solveAll();
  }
}

async function rebuild() {
  const seq = ++buildSeq;
  solveAll();
  if (state.nodes.some((n) => n.align)) applyLocks();
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
    } else if (n.type === 'start') {
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

/** Start point: a marker at its origin with its coordinates, and a line from the spool origin. */
function drawStart(n) {
  const o = n.origin || [0, 0, 0];
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(...o)]);
  const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x2f6fb3, dashSize: 8, gapSize: 5, depthTest: false }));
  line.computeLineDistances();
  line.renderOrder = 5;
  viewer.content.add(line);
  const sph = new THREE.Mesh(new THREE.SphereGeometry(Math.max(4, (n.od || 50) * 0.12), 12, 8), new THREE.MeshBasicMaterial({ color: n.id === state.selected ? 0xe8792b : 0x2f6fb3, depthTest: false }));
  sph.position.set(...o);
  sph.renderOrder = 10;
  sph.userData.nodeId = n.id;
  viewer.content.add(sph);
  if ($('chkDims').checked) {
    const el = addLabel('dim-label', `X ${round(o[0])} · Y ${round(o[1])} · Z ${round(o[2])}`, o);
    el.dataset.node = n.id;
    el.title = 'Start point, from the spool origin – click to edit';
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

// Valves have BSP or flange ends, so on a welded line one needs an adaptor
// first: a weld nipple (weld end x BSP male) or a flange (weld end x flange face).
const ADAPTOR_GROUPS = ['Adapters', 'Flanges'];
const NEEDS_ADAPTOR = ['Valves', 'Strainers'];
const adaptorCache = new Map();

/**
 * Adaptors that go straight onto an end (a weld end or pipe end, welded close-coupled):
 * [{part, opt, out}] (out = the end a valve goes on), best first.
 */
function adaptorsOnto(end, system) {
  if (!end || !['weld', 'pipe'].includes(end.family) || end.threaded) return []; // BSP lines take valves as they are
  const key = `${end.family}|${end.od}|${system}|${library.parts.size}`;
  if (adaptorCache.has(key)) return adaptorCache.get(key);
  const list = [];
  for (const a of library.list()) {
    if (a.kit || a.ports.length !== 2 || !ADAPTOR_GROUPS.includes(groupOf(a))) continue;
    for (const port of a.ports) {
      if (port.family !== 'weld' || !canJoin(end, port)) continue;
      const out = a.ports.find((q) => q !== port);
      if (!['bspM', 'flange'].includes(out.family)) continue; // takes a valve straight on
      const score = (a.system === system ? 0 : 2) + (/extend|long/i.test(`${a.type} ${a.name}`) ? 1 : 0);
      list.push({ part: a, opt: { port, viaPipe: false }, out, score });
    }
  }
  list.sort((x, y) => x.score - y.score || x.part.id.localeCompare(y.part.id));
  adaptorCache.set(key, list);
  return list;
}

const systemAt = (n) => (n?.type === 'part' ? library.parts.get(n.part)?.system : state.pipeType);

/** An adaptor joining `end` to the valve end `vp` (either way round): {part, port (on end), run (to vp)}. */
function adaptorBetween(end, vp, system) {
  for (const a of adaptorsOnto(end, system)) if (directJoin(a.out, vp)) return a;
  return null;
}

/** For a valve that doesn't fit the active end: the adaptor and the valve end that goes on it. */
function adaptorFor(part) {
  if (!state.nodes.length || state.branchOn || !NEEDS_ADAPTOR.includes(groupOf(part))) return null;
  const t = activeTarget();
  if (!t) return null;
  for (const a of adaptorsOnto(t.port, systemAt(t.n))) {
    const port = part.ports.find((vp) => directJoin(a.out, vp));
    if (port) return { ...a, port };
  }
  return null;
}

/**
 * Parts to insert for `part` at state.insertAt: [{part, port, run}] (with a weld
 * nipple or flange either side of a valve on a welded line), or null.
 */
function insertChainFor(part) {
  const at = state.insertAt;
  if (!at || part.ports.length !== 2) return null;
  let e1, e2, sys;
  if (at.pipe) {
    const pipe = nodeById(at.pipe);
    const ps = localPorts(pipe);
    e1 = ps.find((q) => q.name === 'B'); e2 = ps.find((q) => q.name === 'A'); sys = systemAt(nodeById(pipe.parent));
  } else {
    const x = nodeById(at.node);
    e1 = localPorts(x)?.find((q) => q.name === at.port);
    const next = state.nodes.find((c) => c.parent === x.id && c.parentPort === at.port && !c.branch);
    e2 = next ? localPorts(next)?.find((q) => q.name === next.port) : null;
    sys = systemAt(x);
  }
  if (!e1) return null;
  const valve = NEEDS_ADAPTOR.includes(groupOf(part));
  for (const port of part.ports) {
    const run = part.ports.find((q) => q !== port);
    const chain = [];
    if (!canJoin(e1, port)) {
      const a = valve && adaptorBetween(e1, port, sys);
      if (!a) continue;
      chain.push({ part: a.part.id, port: a.opt.port.name, run: a.out.name });
    }
    chain.push({ part: part.id, port: port.name, run: run.name });
    if (e2 && !canJoin(run, e2)) {
      const a = valve && adaptorBetween(e2, run, sys);
      if (!a) continue;
      chain.push({ part: a.part.id, port: a.out.name, run: a.opt.port.name }); // turned round: valve side first
    }
    return chain;
  }
  return null;
}

const ADAPTOR_TEXT = (a) => (a.out.family === 'flange' ? 'flange' : /nipple/i.test(a.part.type || '') ? 'weld nipple' : 'adaptor');

function addPart(id) {
  const part = library.parts.get(id);
  if (!part) return;
  if (state.insertAt) {
    const chain = insertChainFor(part);
    if (!chain) { toast(`${part.name} doesn't fit there.`, true); return; }
    const at = state.insertAt;
    commit(() => {
      const res = insertChain(editCtx(), at, chain, newId);
      applyEdit(res);
      state.insertAt = null;
      state.selected = res.made[chain.findIndex((c) => c.part === part.id)];
      if (chain.length > 1) toast(`Inserted with ${chain.length === 3 ? 'an adaptor either side' : 'an adaptor'}.`);
    });
    return;
  }
  const opts = optionsFor(part);
  const adaptor = opts.length ? null : adaptorFor(part);
  if (!opts.length && !adaptor) { toast(`${part.name} doesn't fit the ${state.nodes.length ? 'selected end' : 'start size'}.`, true); return; }
  if (state.branchOn) { addBranch(state.branchOn, part, opts[0].port); return; }
  commit(() => {
    if (adaptor) { // the adaptor first, then the valve straight on it
      placePart(adaptor.part, adaptor.opt, activeTarget());
      placePart(part, { port: adaptor.port, viaPipe: false }, activeTarget());
      toast(`Added a ${adaptor.part.name} for the valve.`);
    } else placePart(part, opts[0], state.nodes.length ? activeTarget() : null);
  });
}

/** Put a part on the end t (or as the first part), joined by opt.port; inside commit(). */
function placePart(part, opt, t) {
  const id = part.id;
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

/** A new start point: another run from X/Y/Z (mm) off the spool origin. */
function addStartPoint() {
  const label = state.startSize;
  const end = library.list().flatMap((p) => p.ports).find((q) => q.label === label);
  if (!end) { toast('Pick a start size first.', true); return; }
  commit(() => {
    const spec = end.family === 'bspF' || end.family === 'bspM' ? pipeFor({ ...end, family: 'bspF' }) : pipeFor(end);
    const n = { id: newId(), type: 'start', port: 'in', origin: [0, 500, 0], startDir: state.startDir || '+X',
      od: spec.od, wall: spec.wall, label: spec.label, threaded: spec.threaded };
    state.nodes.push(n);
    state.selected = n.id;
    state.active = `${n.id}:out`;
    needFit = true;
  });
}

function removeSubtree(id) {
  const kill = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of state.nodes) {
      if (!kill.has(n.id) && n.parent && kill.has(n.parent)) { kill.add(n.id); grew = true; }
    }
  }
  state.nodes = state.nodes.filter((n) => !kill.has(n.id));
}

/** Apply an edit.js result: the new nodes, pipe lengths and branch positions. */
function applyEdit(res) {
  state.nodes = res.nodes;
  for (const [id, cut] of res.cuts) { const pipe = nodeById(id); if (pipe) { pipe.cut = cut; setCut(pipe, cut); } }
  for (const [id, x] of res.branchX) {
    const c = nodeById(id);
    const { a } = pipeSides(nodeById(c.parent));
    c.branch = { ...c.branch, along: round(x + (a ? a.c2e - (a.engage || 0) : 0), 1) };
  }
  for (const n of state.nodes) if (n.align && (!nodeById(n.align.ref) || !nodeById(n.align.pipe))) delete n.align;
  if (res.msg) toast(res.msg);
}

/** Remove one part or pipe and close the gap (the rest stays where it is). */
function removeOne(id) {
  if (!nodeById(id)) return;
  commit(() => {
    applyEdit(removeNode(editCtx(), id));
    if (state.selected === id) state.selected = null;
    if (state.active?.startsWith(`${id}:`)) state.active = null;
  });
}

/** Move a fitting up (-1, towards the start) or down (+1) its line. */
function moveOne(id, dir) {
  commit(() => {
    const res = moveNode(editCtx(), id, dir);
    applyEdit(res);
    state.selected = res.moved;
  });
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

const FAMILY_TEXT = { start: 'start point (any end of this size)', weld: 'weld end', bspF: 'BSP female', bspM: 'BSP male', rjtM: 'RJT male', rjtF: 'RJT female', flange: 'flange face', wafer: 'wafer face', pipe: 'pipe end' };

function renderPartList() {
  const empty = !state.nodes.length;
  $('startSizeRow').hidden = !empty;
  $('pipeTypeRow').hidden = !empty;
  $('startDirRow').hidden = !empty;
  if (state.branchOn && !nodeById(state.branchOn)) state.branchOn = null;
  if (state.insertAt && !nodeById(state.insertAt.pipe || state.insertAt.node)) state.insertAt = null;
  const ins = state.insertAt;
  const t = empty || state.branchOn || ins ? null : activeTarget();
  $('nextEnd').innerHTML = ins
    ? `Insert ${ins.pipe ? 'into' : 'after'}: <b>${esc(nodeLabel(nodeById(ins.pipe || ins.node)))}</b> – pick a part <button id="brCancel" class="link">Cancel</button>`
    : state.branchOn
    ? `Branch on: <b>${esc(nodeLabel(nodeById(state.branchOn)))}</b> – pick a weld nipple <button id="brCancel" class="link">Cancel</button>`
    : empty
    ? '<span class="hint">Pick the first part. The orange end shows where the next one goes.</span>'
    : t ? `Next on: <b>${esc(t.port.label || `Ø${t.port.od}`)}</b> ${esc(FAMILY_TEXT[t.port.family] || '')}`
      : '<span class="hint">No open end selected – click a blue marker in the view.</span>';
  const q = $('partSearch').value.toLowerCase().trim();
  const words = q.split(/\s+/).filter(Boolean);
  const inlinePart = (p) => p.ports.length === 2 && p.ports[0].dir.reduce((s2, v, i) => s2 + v * p.ports[1].dir[i], 0) < -0.999;
  const chains = new Map();
  if (ins) for (const p of library.list()) if (inlinePart(p)) { const c = insertChainFor(p); if (c) chains.set(p.id, c); }
  const fits = ins ? library.list().filter((p) => chains.has(p.id) && words.every((w) => `${p.search || ''} ${p.name} ${p.id}`.toLowerCase().includes(w)))
    : (empty || t || state.branchOn) ? library.list().filter((p) => (optionsFor(p).length || adaptorFor(p))
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
      const chain = chains.get(p.id);
      const o = empty || chain ? null : optionsFor(p)[0];
      const ad = !empty && !o && !chain ? adaptorFor(p) : null;
      const via = chain ? (chain.length > 1 ? `<span class="badge ok" title="Inserted with ${chain.length === 3 ? 'an adaptor either side' : 'an adaptor'}">+ adaptor${chain.length === 3 ? 's' : ''}</span>` : '')
        : ad ? `<span class="badge ok" title="Added with a ${esc(ad.part.name)}${ad.opt.viaPipe ? ' (and a pipe)' : ''}">+ ${ADAPTOR_TEXT(ad)}</span>`
        : o?.viaPipe ? '<span class="badge ok" title="Joined with a pipe">+ pipe</span>' : '';
      const twin = ps.some((q) => q !== p && q.type_name === p.type_name && q.size_label === p.size_label);
      html += `<div class="item" data-part="${esc(p.id)}" title="${esc(`${p.id} – ${p.description}`)}">${esc(p.type_name || p.type)}${twin ? ` <span class="hint">${esc(p.kit ? '' : p.id)}</span>` : ''}<span class="meta">${via} ${esc(p.size_label || '')}</span></div>`;
    }
  }
  const note = partGroup !== 'All' && shown === 'All' && fits.length ? `<p class="hint">No ${esc(partGroup.toLowerCase())} fit here – showing everything that does.</p>` : '';
  $('partList').innerHTML = note + (html || `<p class="hint">${!library.parts.size ? 'Open your Part-Library folder to see parts.' : 'Nothing in the library fits here.'}</p>`);
  if ($('brCancel')) $('brCancel').onclick = () => { state.branchOn = null; state.insertAt = null; renderPartList(); };
}

/** A click on a node: selects it, or picks it as the part to line up with. */
function pickNode(id) {
  if (state.alignFor && id !== state.alignFor) {
    state.alignRef = id;
    state.selected = state.alignFor;
  } else state.selected = id;
  draw(); renderTree(); renderProps();
}

function renderTree() {
  const errById = new Map(solved.errors.map((e) => [e.id, e.message]));
  let html = '';
  const walk = (parent, depth) => {
    for (const n of state.nodes.filter((x) => (x.parent || null) === parent)) {
      const extra = n.type === 'pipe' ? `${round(n.cut)} mm` : n.type === 'start' ? (n.origin || [0, 0, 0]).map((v) => round(v)).join(', ') : (partOf(n)?.size_label || '');
      const name = n.type === 'pipe' ? 'Pipe' : n.type === 'start' ? 'Start point' : (partOf(n)?.type_name || n.part);
      const cls = ['item', n.id === state.selected ? 'sel' : '', errById.has(n.id) ? 'err' : '', n.id === state.alignRef ? 'ref' : ''].join(' ');
      const two = n.type === 'part' && (partOf(n)?.ports.length || 0) === 2;
      const btn = (act, text, title, off = false) => `<button data-act="${act}" title="${title}" aria-label="${title}" ${off ? 'disabled' : ''}>${text}</button>`;
      const acts = (n.type === 'part'
        ? btn('up', '↑', two ? 'Move up the line (swap with the fitting before)' : 'Only two-ended fittings can be moved', !two)
          + btn('down', '↓', two ? 'Move down the line (swap with the fitting after)' : 'Only two-ended fittings can be moved', !two) : '')
        + btn('del', '×', n.type === 'pipe' ? 'Remove this pipe: the parts either side join up' : 'Remove: the parts either side join up, the rest stays where it is');
      html += `<div class="${cls}" data-node="${n.id}" style="padding-left:${6 + depth * 10}px" title="${esc(errById.get(n.id) || '')}">`
        + `<span class="nm">${n.align ? '🔒 ' : ''}${esc(n.tag ? `${n.tag} – ` : '')}${esc(name)}</span><span class="meta">${esc(extra)}</span><span class="acts">${acts}</span></div>`;
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
      Click a blue marker to carry on from another open end (<kbd>P</kbd> puts a pipe on it).<br>
      In the Spool list, <b>↑ ↓</b> swap a fitting with its neighbour and <b>×</b> removes one (the rest stays put).</p>`;
    return;
  }
  const err = solved.errors.filter((e) => e.id === n.id).map((e) => esc(e.message)).join('<br>');
  if (n.type === 'pipe') {
    const down = childAt(n.id, 'B');
    const lockedBy = state.nodes.find((x) => x.align?.pipe === n.id);
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
        <span>mm</span><input id="propDim" type="number" min="0" step="1" value="${round(n.dim?.value ?? n.cut)}" ${lockedBy ? `disabled title="Set by lining up ${esc(nodeLabel(lockedBy))} – unlock it to edit"` : ''}>
        <span>Cut length</span><b>${round(n.cut)} mm</b>
      </div>
      ${lockedBy ? `<div class="hint">🔒 Length set by lining up <b>${esc(nodeLabel(lockedBy))}</b>.</div>` : ''}
      <div class="btns">
        <button id="propClose" title="No pipe: the parts weld or screw straight together" ${lockedBy ? 'disabled' : ''}>Close-coupled</button>
        <button id="propBranch" title="Stab a weld nipple into this pipe to start a branch">Branch…</button>
        <button id="propInsert" title="Put a part (e.g. a valve) in the middle of this pipe; what is beyond stays where it is">Insert part…</button>
        <button id="propAlign" title="Line this pipe's end up with another part or pipe">Align…</button>
      </div>
      ${alignHtml(n)}
      <div class="btns">
        <button id="propDel" class="danger" title="Remove this pipe: the parts either side join up (Del)">Remove</button>
        <button id="propDelAll" class="link danger" title="Delete this pipe and everything beyond it (Shift+Del)">Delete with everything beyond</button>
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
    $('propBranch').onclick = () => { state.branchOn = n.id; state.insertAt = null; renderPartList(); toast('Pick a weld nipple to stab into this pipe'); };
    $('propInsert').onclick = () => { state.insertAt = { pipe: n.id }; state.branchOn = null; renderPartList(); toast('Pick the part to put in this pipe'); };
    wireAlign(n);
    $('propDel').onclick = () => removeOne(n.id);
    $('propDelAll').onclick = () => deleteNode(n.id);
    setTimeout(() => { const f = $('propDim'); if (f && !f.disabled && document.activeElement === document.body) { f.focus(); f.select(); } }, 30);
    return;
  }
  if (n.type === 'start') {
    const o = n.origin || [0, 0, 0];
    const labels = [...labelOd.keys()].filter((l) => library.list().some((p) => inPipeType(p) && p.ports.some((q) => q.label === l))).sort((a, b) => sizeOrder(a) - sizeOrder(b));
    el.innerHTML = `
      <h4>Start point ${esc(n.label)}</h4>
      <div class="hint">Another run, from the spool origin (where the first part starts). Add a part or a pipe (<kbd>P</kbd>) on its orange end.</div>
      <div class="grid">
        <span>X (mm)</span><input id="spX" type="number" step="10" value="${round(o[0])}">
        <span>Y (mm)</span><input id="spY" type="number" step="10" value="${round(o[1])}">
        <span>Z (mm)</span><input id="spZ" type="number" step="10" value="${round(o[2])}">
        <span>Start</span><select id="spDir">${Object.entries(DIR_TEXT).map(([k, t]) => `<option value="${k}" ${k === (n.startDir || '+X') ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <span>Size</span><select id="spSize" ${childrenOf(n.id).length ? 'disabled title="Delete what is on it to change the size"' : ''}>${labels.map((l) => `<option ${l === n.label ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      </div>
      <div class="btns"><button id="propDel" class="danger" title="Delete this start point and everything on it (Del)">Delete</button></div>
      ${err ? `<div class="msg">${err}</div>` : ''}`;
    const setXYZ = (k, v) => commit(() => { const q = [...(n.origin || [0, 0, 0])]; q[k] = Number(v) || 0; n.origin = q; });
    ['spX', 'spY', 'spZ'].forEach((id, k) => {
      $(id).onchange = (e) => setXYZ(k, e.target.value);
      $(id).onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
    });
    $('spDir').onchange = (e) => commit(() => { n.startDir = e.target.value; });
    $('spSize').onchange = (e) => commit(() => {
      const end = library.list().flatMap((p) => p.ports).find((q) => q.label === e.target.value);
      const spec = end.family === 'bspF' || end.family === 'bspM' ? pipeFor({ ...end, family: 'bspF' }) : pipeFor(end);
      Object.assign(n, { od: spec.od, wall: spec.wall, label: spec.label, threaded: spec.threaded });
    });
    $('propDel').onclick = () => deleteNode(n.id);
    return;
  }
  const p = partOf(n);
  const attachOpts = attachOptions(n);
  const free = (p?.ports || []).filter((q) => q.name !== n.port && !childAt(n.id, q.name));
  // open ends that take a pipe (the first part's own start end too)
  const ends = (p?.ports || []).filter((q) => (q.name !== n.port || !n.parent) && !childAt(n.id, q.name) && ['weld', 'bspF'].includes(q.family));
  const runName = p ? runPort(p.ports, n.port) : null;
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
    ${ends.length ? `<div class="ends"><span class="hint">Open ends:</span> ${ends.map((q) => `<button data-pipe-on="${q.name}" title="A straight pipe on this end (or click its blue marker and press P)">+ pipe on ${esc(portText(p, q).split(' – ')[0].toLowerCase())}</button>`).join(' ')}</div>` : ''}
    <div class="btns">
      <button id="propFlip" title="Attach by its next end (X)" ${attachOpts.length > 1 ? '' : 'disabled'}>Turn round</button>
      ${runName && childAt(n.id, runName) ? '<button id="propInsert" title="Put a part between this one and the next; what is beyond stays put when there is a pipe to shorten">Insert after…</button>' : ''}
      <button id="propAlign" title="Line this part up with another part or pipe: same X, Y or RL, by centre or end face">Align…</button>
    </div>
    ${alignHtml(n)}
    <div class="btns">
      <button id="propDel" class="danger" title="Remove this part: the parts either side join up, the rest stays where it is (Del)">Remove</button>
      <button id="propDelAll" class="link danger" title="Delete this part and everything beyond it (Shift+Del)">Delete with everything beyond</button>
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
  if ($('propInsert')) $('propInsert').onclick = () => { state.insertAt = { node: n.id, port: runName }; state.branchOn = null; renderPartList(); toast('Pick the part to put after this one'); };
  el.querySelectorAll('[data-pipe-on]').forEach((b) => { b.onclick = () => { state.active = `${n.id}:${b.dataset.pipeOn}`; addPipe(); }; });
  wireAlign(n);
  $('propDel').onclick = () => removeOne(n.id);
  $('propDelAll').onclick = () => deleteNode(n.id);
}

// ------------------------------------------------------------------- align
const AXIS_TEXT = { X: 'same X', Y: 'same Y', Z: 'same RL (Z)' };
let alignSel = { at: 'centre', refAt: 'centre', axis: null, lock: false };

/** Points of a node to line up: centre and its ends. */
function alignPoints(n) {
  if (n.type === 'pipe') return [['centre', 'Middle'], ['A', 'Start end'], ['B', 'Far end']];
  if (n.type !== 'part') return [];
  const p = partOf(n);
  return [['centre', 'Centre'], ...(p?.ports || []).map((q) => [q.name, `${portText(p, q).split(' – ')[0]} face`])];
}

function alignHtml(n) {
  if (n.align) {
    const r = nodeById(n.align.ref);
    return `<div class="align">🔒 Lined up with <b>${esc(nodeLabel(r))}</b>, ${AXIS_TEXT[n.align.axis]} (pipe ${esc(nodeLabel(nodeById(n.align.pipe)))} follows) <button id="alUnlock">Unlock</button></div>`;
  }
  if (state.alignFor !== n.id) return '';
  if (!state.alignRef) return `<div class="align">Click the part or pipe to line this up with (in the view or the list). <button id="alCancel" class="link">Cancel</button></div>`;
  const r = nodeById(state.alignRef);
  const opts = (list, v) => list.map(([k, t]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${esc(t)}</option>`).join('');
  return `<div class="align"><div class="grid">
      <span>This</span><select id="alAt">${opts(alignPoints(n), alignSel.at)}</select>
      <span>With</span><select id="alRefAt">${opts(alignPoints(r), alignSel.refAt)}</select>
      <span></span><span class="hint">of ${esc(nodeLabel(r))}</span>
      <span>Line up</span><div class="seg" id="alAxis">${['X', 'Y', 'Z'].map((a) => `<button data-axis="${a}">${a === 'Z' ? 'RL (Z)' : a}</button>`).join('')}</div>
    </div>
    <label><input type="checkbox" id="alLock" ${alignSel.lock ? 'checked' : ''}> Keep lined up (lock)</label>
    <div class="btns"><button id="alGo" class="primary">Align</button><button id="alCancel">Cancel</button></div>
    <div id="alMsg" class="hint"></div></div>`;
}

function wireAlign(n) {
  $('propAlign').onclick = () => {
    state.alignFor = n.id; state.alignRef = null; state.insertAt = state.branchOn = null;
    alignSel = { at: 'centre', refAt: 'centre', axis: null, lock: false };
    renderProps(); renderPartList();
  };
  if ($('alUnlock')) $('alUnlock').onclick = () => commit(() => { delete n.align; });
  if ($('alCancel')) $('alCancel').onclick = () => { state.alignFor = state.alignRef = null; draw(); renderTree(); renderProps(); };
  if (!$('alGo')) return;
  if (!alignPoints(nodeById(state.alignRef)).some(([k]) => k === alignSel.refAt)) alignSel.refAt = 'centre';
  const refresh = () => {
    alignSel.at = $('alAt').value; alignSel.refAt = $('alRefAt').value;
    const ok = (a) => alignPipes(editCtx(), n.id, alignSel.at, state.alignRef, a).length > 0;
    if (alignSel.axis && !ok(alignSel.axis)) alignSel.axis = null;
    if (!alignSel.axis) alignSel.axis = ['X', 'Y', 'Z'].find(ok) || null;
    $('alAxis').querySelectorAll('button').forEach((b) => {
      b.disabled = !ok(b.dataset.axis);
      b.title = b.disabled ? `No pipe along ${b.dataset.axis} between them to adjust` : `Give them the ${AXIS_TEXT[b.dataset.axis]}`;
      b.classList.toggle('on', b.dataset.axis === alignSel.axis);
    });
    $('alGo').disabled = !alignSel.axis;
    $('alMsg').textContent = alignSel.axis ? '' : 'No pipe between them runs along X, Y or Z to take up the difference.';
  };
  $('alAt').onchange = refresh;
  $('alRefAt').onchange = refresh;
  $('alLock').onchange = (e) => { alignSel.lock = e.target.checked; };
  $('alAxis').onclick = (e) => { const b = e.target.closest('[data-axis]'); if (b && !b.disabled) { alignSel.axis = b.dataset.axis; refresh(); } };
  refresh();
  $('alGo').onclick = () => {
    const spec = { id: n.id, at: alignSel.at, ref: state.alignRef, refAt: alignSel.refAt, axis: alignSel.axis };
    let f;
    try { f = alignFix(editCtx(), spec); } catch (e) { $('alMsg').textContent = e.message; return; }
    const pipe = nodeById(f.pipe);
    commit(() => {
      setCut(pipe, f.cut);
      if (alignSel.lock) n.align = { ref: spec.ref, refAt: spec.refAt, at: spec.at, axis: spec.axis, pipe: f.pipe };
      state.alignFor = state.alignRef = null;
    });
    toast(`Lined up (${AXIS_TEXT[spec.axis]}): ${nodeLabel(pipe)} changed by ${round(Math.abs(f.delta))} mm${alignSel.lock ? ', locked' : ''}.`);
  };
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
  const output = document.querySelector('input[name=expOut]:checked').value;
  return { output, level, res: Number($('expRes').value), hollow: $('expHollow').checked };
}

function exportItems() {
  const items = [];
  for (const n of state.nodes) {
    const e = solved.placed.get(n.id);
    if (!e) continue;
    if (n.type === 'pipe') {
      if (n.cut > 0.01) items.push({ kind: 'pipe', node: n.id, native: true, od: n.od, id: n.od - 2 * n.wall, length: n.cut, matrix: e.matrix });
    } else if (n.type === 'part') {
      for (const m of membersOf(partOf(n))) {
        const p = library.parts.get(m.part);
        if (!p) continue;
        items.push({
          kind: 'part', node: n.id, native: NATIVE_GROUPS.includes(groupOf(p)),
          key: library.cacheKey(m.part), part: m.part, matrix: mul(e.matrix, m.matrix), name: p.name,
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
  const { level, res, output } = exportSettings();
  const revit = output === 'revit';
  $('expResRow').hidden = level !== 'wrap';
  $('expHollowRow').hidden = level !== 'full';
  $('expLevelHead').textContent = revit ? 'Valves and strainers (STEP)' : 'Level of detail';
  $('expConnRow').hidden = revit; // always written for a Revit family
  $('expResOut').textContent = `${res} mm`;
  const stale = built && built.sig !== JSON.stringify({ ...exportSettings(), nodes: spoolData().nodes });
  $('expGo').textContent = built && !stale ? (revit ? 'Download files' : 'Download STEP') : 'Build and download';
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
    const split = settings.output === 'revit';
    const res = await cad.build({ items, level: settings.level, res: settings.res, hollow: settings.hollow, runs, split });
    const bytes = split && !res.solids ? null : (await cad.writeStep({ name: state.name })).bytes;
    built = { sig, bytes, warnings: res.warnings, native: res.native || [], split };
    expViewer.clear();
    const g = geometryFromMesh(res.mesh);
    g.userData.shared = false;
    expViewer.content.add(new THREE.Mesh(g, material('fitting', false)));
    expViewer.resize();
    expViewer.fit();
    const secs = `built in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    const mb = (b) => `${(b.length / 1024 / 1024).toFixed(2)} MB`;
    const nNative = built.native.reduce((k, g) => k + g.prims.length, 0);
    $('expStats').innerHTML = !split
      ? `<b>${mb(bytes)}</b> · ${res.faces} faces · ${res.solids} solid${res.solids === 1 ? '' : 's'} · ${secs}`
      : `${bytes ? `Valve STEP <b>${mb(bytes)}</b> (${res.solids} bod${res.solids === 1 ? 'y' : 'ies'}, ${res.faces} faces)` : 'No valves: no STEP file'} · <b>${nNative}</b> native Revit solids for ${built.native.length} pipes and fittings · ${secs}`;
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
    // for the Dynamo graph: native pipes and fittings, connectors and references at the open ends
    const file = () => JSON.stringify(revitFile(open, nodeById, b.split ? b.native : []));
    let saved = null;
    if (b.bytes) {
      saved = await saveFile(`${state.name}${b.split ? '-valves' : ''}.stp`, b.bytes, 'application/step');
      if (!saved) { $('expMsg').textContent = 'Download cancelled.'; return; }
    }
    if (b.split || $('expConn').checked) {
      const j = await saveFile(`${state.name}-revit.json`, file(), 'application/json');
      if (!j) { $('expMsg').textContent = 'Download cancelled.'; return; }
      saved = saved ? `${saved} and ${j}` : j;
    }
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
  // parallel lines (measured from a pipe) were replaced by start points at X/Y/Z
  const old = state.nodes.filter((n) => n.type === 'start' && n.ref);
  for (const n of old) removeSubtree(n.id);
  if (old.length) toast(`${old.length} parallel line${old.length === 1 ? '' : 's'} removed – use Start point… instead.`, true, 7000);
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
  $('btnStartPt').onclick = addStartPoint;
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
    const act = e.target.closest('[data-act]')?.dataset.act;
    const id = it.dataset.node;
    if (act === 'del') { removeOne(id); return; }
    if (act === 'up' || act === 'down') { moveOne(id, act === 'up' ? -1 : 1); return; }
    pickNode(id);
  };
  $('viewport').addEventListener('click', (e) => {
    const lbl = e.target.closest('.dim-label[data-node]');
    if (!lbl) return;
    if (state.alignFor) { pickNode(lbl.dataset.node); return; }
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
  document.querySelectorAll('input[name=expOut]').forEach((r) => {
    try { if (localStorage.getItem('pst.exportOutput') === r.value) r.checked = true; } catch { /* no storage */ }
    r.onchange = () => { try { localStorage.setItem('pst.exportOutput', r.value); } catch { /* no storage */ } syncExportForm(); };
  });
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
      if (state.alignFor) { if (h) pickNode(h.object.userData.nodeId); return; }
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
    else if (k === 's') addStartPoint();
    else if (k === 'r' && sel) rollNode(sel, e.shiftKey ? -90 : 90);
    else if (k === 'x' && sel) flipNode(sel);
    else if ((k === 'delete' || k === 'backspace') && sel) { e.preventDefault(); if (e.shiftKey) deleteNode(sel); else removeOne(sel); }
    else if (k === 'n' && open.length) {
      const keys = open.map((o) => `${o.nodeId}:${o.port.name}`);
      state.active = keys[(keys.indexOf(state.active) + 1) % keys.length];
      draw(); renderPartList();
    } else if (k === 'home') viewer.fit();
    else if (k === 'escape') {
      if (state.alignFor || state.insertAt || state.branchOn) { state.alignFor = state.alignRef = state.insertAt = state.branchOn = null; } else state.selected = null;
      draw(); renderTree(); renderProps(); renderPartList();
    }
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

window.spoolDebug = () => ({ state, solved }); // for tests

init().catch((e) => toast(`Failed to start: ${e.message}`, true, 10000));
