// Spool builder: main application.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { Viewer, geometryFromMesh, toMatrix4 } from './viewer.js';
import { solve, openPorts, pipePorts, START_DIRS } from './kinematics.js';
import { api, download, toast, esc } from './api.js';
import { LibraryEditor } from './library-editor.js';

// ------------------------------------------------------------------ constants
const FITTINGS = [
  { type: 'pipe', label: 'Pipe', key: 'P' },
  { type: 'elbow90', label: 'Elbow 90 LR', key: 'E' },
  { type: 'elbow45', label: 'Elbow 45', key: '⇧E' },
  { type: 'elbow90sr', label: 'Elbow 90 SR' },
  { type: 'tee', label: 'Tee', key: 'T' },
  { type: 'reducer', label: 'Reducer conc.' },
  { type: 'reducer_ecc', label: 'Reducer ecc.' },
  { type: 'flange_wn', label: 'WN flange', key: 'F' },
  { type: 'flange_blind', label: 'Blind flange' },
  { type: 'cap', label: 'Cap' },
];
const TYPE_LABEL = Object.fromEntries(FITTINGS.map((f) => [f.type, f.label]));
const TWO_SIZE = new Set(['tee', 'reducer', 'reducer_ecc']);
const COLORS = { pipe: 0x9aabbd, fitting: 0x7f95ad, flange: 0x6f7f91, part: 0xd38a3a };

// ---------------------------------------------------------------------- state
const state = {
  name: 'Spool-01',
  standard: null,
  schedule: null,
  defaultSize: 'DN50',
  nodes: [],
  selected: null,
  active: null, // "nodeId:portName"
  lastPipeLength: 200,
};
let config;
let library = new Map(); // part id -> meta
const fittingCache = new Map(); // key -> Promise<{geometry, ports}>
const partMeshCache = new Map(); // id -> Promise<geometry>
let solved = { placed: new Map(), errors: [] };
let open = [];
const undoStack = [];
const redoStack = [];
let nextId = 1;
let needFit = true;

const $ = (id) => document.getElementById(id);
const viewer = new Viewer($('viewport'));
const materials = {};

function material(kind, selected, xray) {
  const key = `${kind}|${selected}|${xray}`;
  if (!materials[key]) {
    materials[key] = new THREE.MeshStandardMaterial({
      color: COLORS[kind], metalness: 0.25, roughness: 0.55,
      emissive: selected ? 0x1f5fa8 : 0x000000, emissiveIntensity: selected ? 0.55 : 0,
      transparent: xray, opacity: xray ? 0.35 : 1, depthWrite: !xray, side: THREE.DoubleSide,
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
const sizes = () => config.sizes.filter((s) => config.standards[state.standard].sizes[s]);
const od = (size) => config.standards[state.standard].sizes[size]?.od ?? 50;
const sizeNum = (s) => parseFloat(String(s).replace(/[^\d.]/g, '')) || 0;

function nodeLabel(n) {
  if (n.type === 'part') return library.get(n.part)?.name || n.part;
  return TYPE_LABEL[n.type] || n.type;
}

function nodeSizeText(n) {
  if (n.type === 'part') {
    const ps = library.get(n.part)?.ports || [];
    return [...new Set(ps.map((p) => p.size).filter(Boolean))].join('/');
  }
  return TWO_SIZE.has(n.type) && n.size2 && n.size2 !== n.size ? `${n.size}×${n.size2}` : n.size;
}

function fittingParams(n) {
  return {
    type: n.type, size: n.size, size2: TWO_SIZE.has(n.type) ? (n.size2 || n.size) : null,
    standard: state.standard, schedule: state.schedule,
  };
}

function fittingEntry(n) {
  const key = JSON.stringify(fittingParams(n));
  if (!fittingCache.has(key)) {
    const p = api.fitting(fittingParams(n)).then((r) => ({ geometry: geometryFromMesh(r.mesh), ports: r.ports }));
    p.catch(() => fittingCache.delete(key));
    fittingCache.set(key, p);
  }
  return fittingCache.get(key);
}

function partGeometry(id) {
  if (!partMeshCache.has(id)) {
    const p = api.partMesh(id).then(geometryFromMesh);
    p.catch(() => partMeshCache.delete(id));
    partMeshCache.set(id, p);
  }
  return partMeshCache.get(id);
}

const resolved = new Map(); // node id -> {geometry, ports}

async function loadNode(n) {
  if (n.type === 'pipe') return { geometry: null, ports: pipePorts(n.size, Number(n.length) || 1) };
  if (n.type === 'part') {
    const meta = library.get(n.part);
    if (!meta) throw new Error(`Library part not found: ${n.part}`);
    return { geometry: await partGeometry(n.part), ports: meta.ports };
  }
  return fittingEntry(n);
}

function portsOf(n) { return resolved.get(n.id)?.ports || null; }

// ---------------------------------------------------------------- rebuilding
let buildSeq = 0;
async function rebuild() {
  const seq = ++buildSeq;
  const loadErrors = [];
  await Promise.all(state.nodes.map(async (n) => {
    try { resolved.set(n.id, await loadNode(n)); } catch (e) { resolved.delete(n.id); loadErrors.push({ id: n.id, message: e.message }); }
  }));
  if (seq !== buildSeq) return; // a newer rebuild started
  for (const id of [...resolved.keys()]) if (!nodeById(id)) resolved.delete(id);
  solved = solve(state.nodes, portsOf);
  solved.errors.push(...loadErrors.filter((e) => !solved.errors.some((x) => x.id === e.id && x.message === e.message)));
  open = openPorts(state.nodes, solved.placed);
  const keys = open.map((o) => `${o.nodeId}:${o.port.name}`);
  if (state.active && !keys.includes(state.active) && !isUsedPortValid(state.active)) state.active = null;
  if (!state.active && keys.length) state.active = keys[keys.length - 1];
  draw();
  renderTree();
  renderProps();
  renderStatus();
}

function isUsedPortValid(key) {
  const [id, name] = key.split(':');
  return !!solved.placed.get(id)?.ports.find((p) => p.name === name);
}

function draw() {
  viewer.clear();
  const xray = $('chkXray').checked;
  const showDims = $('chkDims').checked;
  const showTags = $('chkTags').checked;
  for (const n of state.nodes) {
    const e = solved.placed.get(n.id);
    const r = resolved.get(n.id);
    if (!e || !r) continue;
    const sel = n.id === state.selected;
    let mesh;
    if (n.type === 'pipe') {
      const L = Number(n.length) || 1;
      const g = new THREE.CylinderGeometry(od(n.size) / 2, od(n.size) / 2, L, 32, 1, false);
      g.rotateZ(-Math.PI / 2).translate(L / 2, 0, 0);
      mesh = new THREE.Mesh(g, material('pipe', sel, xray));
    } else {
      const kind = n.type === 'part' ? 'part' : n.type.startsWith('flange') ? 'flange' : 'fitting';
      mesh = new THREE.Mesh(r.geometry, material(kind, sel, xray));
    }
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(toMatrix4(e.matrix));
    mesh.userData.nodeId = n.id;
    viewer.content.add(mesh);

    if (n.type === 'pipe' && showDims) {
      const a = e.ports[0].origin, b = e.ports[1].origin;
      const el = document.createElement('div');
      el.className = 'dim-label';
      el.textContent = `${Math.round(Number(n.length) * 10) / 10}`;
      const lbl = new CSS2DObject(el);
      lbl.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
      viewer.content.add(lbl);
    }
    if (n.type !== 'pipe' && showTags && (n.tag || n.type === 'part')) {
      const box = new THREE.Box3().setFromObject(mesh);
      const el = document.createElement('div');
      el.className = 'tag-label';
      el.textContent = n.tag || nodeLabel(n);
      const lbl = new CSS2DObject(el);
      const c = box.getCenter(new THREE.Vector3());
      lbl.position.set(c.x, c.y, box.max.z + 15);
      viewer.content.add(lbl);
    }
  }
  // open port markers
  for (const o of open) drawPort(o.nodeId, o.port, false);
  // a selected *used* port (insert mode) is drawn too
  if (state.active && !open.some((o) => `${o.nodeId}:${o.port.name}` === state.active)) {
    const [id, name] = state.active.split(':');
    const p = solved.placed.get(id)?.ports.find((x) => x.name === name);
    if (p) drawPort(id, p, true);
  }
  if (needFit) { viewer.fit(); needFit = false; }
  viewer.render();
}

function drawPort(nodeId, p, insert) {
  const key = `${nodeId}:${p.name}`;
  const active = key === state.active;
  const r = Math.max(6, (p.size ? od(p.size) : 50) * 0.18);
  const color = active ? 0xe8792b : 0x2f6fb3;
  const grp = new THREE.Group();
  const sph = new THREE.Mesh(new THREE.SphereGeometry(r * (active ? 1.4 : 1), 16, 12),
    new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
  sph.renderOrder = 10;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(r * 0.8, r * 3, 16),
    new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
  cone.renderOrder = 10;
  const d = new THREE.Vector3(...p.dir);
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
  cone.position.copy(d.clone().multiplyScalar(r * 2.2));
  grp.add(sph, cone);
  grp.position.set(...p.origin);
  grp.traverse((o) => { o.userData.portKey = key; });
  if (active && insert) {
    const el = document.createElement('div');
    el.className = 'port-label';
    el.textContent = 'insert here';
    const l = new CSS2DObject(el);
    l.position.set(0, 0, r * 3);
    grp.add(l);
  }
  viewer.content.add(grp);
}

// ---------------------------------------------------------------- mutations
function snapshot() { return JSON.stringify({ nodes: state.nodes, selected: state.selected, active: state.active }); }
function restore(s) { const o = JSON.parse(s); state.nodes = o.nodes; state.selected = o.selected; state.active = o.active; }

function commit(fn) {
  const before = snapshot();
  try {
    fn();
  } catch (e) {
    restore(before);
    toast(e.message, true);
    return;
  }
  undoStack.push(before);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  rebuild();
}

function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); rebuild(); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); rebuild(); }

/** Which of the new component's ports should mate with `target`. */
function choosePort(type, ports, target) {
  // a flange starting the spool presents its face; otherwise mate like with like
  if (type === 'flange_wn') return !target || target.kind === 'flange' ? 'B' : 'A';
  if (type === 'reducer' || type === 'reducer_ecc') return 'A';
  if (target?.kind) {
    const same = ports.find((p) => p.kind === target.kind && (!target.size || !p.size || p.size === target.size));
    if (same) return same.name;
  }
  if (target?.size) {
    const sz = ports.find((p) => p.size === target.size);
    if (sz) return sz.name;
  }
  return ports[0]?.name || 'A';
}

function nextPortAfterAdd(n, ports) {
  const free = ports.filter((p) => p.name !== n.port);
  if (n.type === 'tee' && n.port !== 'C') return free.find((p) => p.name !== 'C')?.name;
  // the port pointing most "away" from the attach port continues the run
  const own = ports.find((p) => p.name === n.port);
  if (own && free.length > 1) {
    free.sort((a, b) => dot3(a.dir, own.dir) - dot3(b.dir, own.dir));
  }
  return free[0]?.name;
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function activeTarget() {
  if (!state.active) return null;
  const [id, name] = state.active.split(':');
  const port = solved.placed.get(id)?.ports.find((p) => p.name === name);
  return port ? { nodeId: id, port } : null;
}

async function addComponent(type, extra = {}) {
  if (!config) return;
  const target = state.nodes.length ? activeTarget() : null;
  if (state.nodes.length && !target) { toast('Select an open port (blue marker) to add to.', true); return; }
  const size = target?.port.size && config.sizeData[target.port.size] ? target.port.size : state.defaultSize;
  const n = { id: newId(), type, size, roll: 0, gap: 0 };
  if (type === 'pipe') n.length = state.lastPipeLength;
  if (TWO_SIZE.has(type)) {
    const list = sizes();
    const i = list.indexOf(size);
    n.size2 = type === 'tee' ? size : list[Math.max(0, i - 1)];
    if (n.size2 === size && type !== 'tee') { toast('No smaller size available for a reducer', true); return; }
  }
  Object.assign(n, extra);
  let ports;
  try {
    ports = (await loadNode(n)).ports;
  } catch (e) { toast(e.message, true); return; }
  if (!ports?.length) { toast('This component has no ports defined – set it up in Library setup first.', true); return; }
  n.port = choosePort(type, ports, target?.port);
  if (target) {
    n.parent = target.nodeId;
    n.parentPort = target.port.name;
  } else {
    n.startDir = '+X';
  }
  commit(() => {
    // insert mode: something already hangs off the target port -> re-hang it on the new component
    if (target) {
      const existing = state.nodes.find((c) => c.parent === target.nodeId && c.parentPort === target.port.name);
      const next = nextPortAfterAdd(n, ports);
      if (existing) {
        if (!next) throw new Error('Cannot insert a component with only one port here');
        existing.parent = n.id;
        existing.parentPort = next;
      }
    }
    state.nodes.push(n);
    state.selected = n.id;
    const next = nextPortAfterAdd(n, ports);
    state.active = next ? `${n.id}:${next}` : null;
    if (state.nodes.length === 1) needFit = true;
  });
  if (type === 'pipe') setTimeout(() => { const el = $('propLength'); if (el) { el.focus(); el.select(); } }, 60);
}

function removeSubtree(id) {
  const kill = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of state.nodes) if (n.parent && kill.has(n.parent) && !kill.has(n.id)) { kill.add(n.id); grew = true; }
  }
  state.nodes = state.nodes.filter((n) => !kill.has(n.id));
}

function deleteNode(id, rejoin = false) {
  const n = nodeById(id);
  if (!n) return;
  commit(() => {
    const kids = childrenOf(id);
    if (rejoin && kids.length === 1) {
      const k = kids[0];
      if (n.parent) {
        k.parent = n.parent; k.parentPort = n.parentPort; k.gap = n.gap || 0;
      } else {
        k.parent = undefined; k.parentPort = undefined; k.startDir = n.startDir; k.origin = n.origin;
      }
      state.nodes = state.nodes.filter((x) => x.id !== id);
      state.active = null;
    } else {
      removeSubtree(id);
      state.active = n.parent ? `${n.parent}:${n.parentPort}` : null;
    }
    state.selected = n.parent || null;
  });
}

function rollNode(id, delta) {
  commit(() => { const n = nodeById(id); n.roll = (((Number(n.roll) || 0) + delta) % 360 + 540) % 360 - 180; });
}

function flipNode(id) {
  const n = nodeById(id);
  const ports = portsOf(n);
  if (!ports || ports.length < 2) return;
  commit(() => setAttachPort(n, ports[(ports.findIndex((p) => p.name === n.port) + 1) % ports.length].name));
}

function setAttachPort(n, name) {
  const old = n.port;
  // a child hanging off the port we are about to use moves to the port we free up
  for (const c of childrenOf(n.id)) if (c.parentPort === name) c.parentPort = old;
  n.port = name;
}

/** Change a node's size and carry it downstream through same-size components. */
function cascadeSize(n, oldSize, newSize) {
  const seen = new Set();
  const walk = (node) => {
    for (const c of childrenOf(node.id)) {
      if (seen.has(c.id) || c.type === 'part') continue;
      if (c.size !== oldSize) continue;
      // stop past the small end of a reducer or the branch of a reducing tee
      if (TWO_SIZE.has(node.type) && node.size2 && node.size2 !== node.size &&
          (c.parentPort === 'B' && node.type !== 'tee' || c.parentPort === 'C')) continue;
      seen.add(c.id);
      c.size = newSize;
      if (c.type === 'tee' && c.size2 === oldSize) c.size2 = newSize;
      if (!(c.type === 'reducer' || c.type === 'reducer_ecc')) walk(c);
    }
  };
  n.size = newSize;
  if (n.type === 'tee' && n.size2 === oldSize) n.size2 = newSize;
  walk(n);
}

function splitPipe(id, at) {
  const n = nodeById(id);
  const L = Number(n.length);
  if (!(at > 0 && at < L)) { toast('Split distance must be inside the pipe', true); return; }
  commit(() => {
    const b = { id: newId(), type: 'pipe', size: n.size, length: L - at, port: 'A', parent: n.id, parentPort: n.port === 'A' ? 'B' : 'A', roll: 0, gap: 0 };
    for (const c of childrenOf(n.id)) c.parent = b.id;
    n.length = at;
    state.nodes.push(b);
    state.active = `${n.id}:${b.parentPort}`; // insert point between the halves
    state.selected = n.id;
  });
}

// ------------------------------------------------------------------- panels
function renderPalette() {
  $('palette').innerHTML = FITTINGS.map((f) =>
    `<button data-add="${f.type}">${f.label}${f.key ? ` <kbd>${f.key}</kbd>` : ''}</button>`).join('');
  $('palette').onclick = (e) => { const b = e.target.closest('[data-add]'); if (b) addComponent(b.dataset.add); };
}

function renderPartList() {
  const q = $('partSearch').value.toLowerCase();
  const parts = [...library.values()].filter((p) => !q || `${p.name} ${p.category} ${p.file}`.toLowerCase().includes(q));
  const cats = {};
  for (const p of parts) (cats[p.category || 'Uncategorised'] ||= []).push(p);
  let html = '';
  for (const [cat, list] of Object.entries(cats).sort()) {
    html += `<div class="cat">${esc(cat)}</div>`;
    for (const p of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const sz = [...new Set(p.ports.map((x) => x.size).filter(Boolean))].join('/');
      html += p.configured
        ? `<div class="item" data-part="${esc(p.id)}" title="Add at the active port">${esc(p.name)}<span class="meta">${esc(sz)}</span></div>`
        : `<div class="item disabled" data-setup="${esc(p.id)}" title="Ports not set up yet – click to set up">${esc(p.name)}<span class="meta"><span class="badge">set up</span></span></div>`;
    }
  }
  $('partList').innerHTML = html || '<p class="hint">No STEP parts yet. Add them in Library setup.</p>';
}

function renderTree() {
  const errById = new Map();
  for (const e of solved.errors) errById.set(e.id, e.message);
  let html = '';
  const walk = (parent, depth) => {
    for (const n of state.nodes.filter((x) => (x.parent || null) === parent)) {
      const extra = n.type === 'pipe' ? `${n.size} · ${n.length}` : nodeSizeText(n);
      const cls = ['item', n.id === state.selected ? 'sel' : '', errById.has(n.id) ? 'err' : ''].join(' ');
      html += `<div class="${cls}" data-node="${n.id}" style="padding-left:${6 + depth * 12}px" title="${esc(errById.get(n.id) || '')}">` +
        `${esc(n.tag ? `${n.tag} – ` : '')}${esc(nodeLabel(n))}<span class="meta">${esc(extra)}${n.roll ? ` ⟳${n.roll}°` : ''}</span></div>`;
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  $('tree').innerHTML = html || '<p class="hint">Empty spool. Pick a fitting or library part to start.</p>';
}

function sizeOptions(selected) {
  return sizes().map((s) => `<option ${s === selected ? 'selected' : ''}>${s}</option>`).join('');
}

function renderProps() {
  const el = $('props');
  const n = nodeById(state.selected);
  if (!n) {
    el.innerHTML = `<h3>Spool</h3><p class="hint">Click a component to edit it. Blue markers are open ends –
      click one to make it the active (orange) port, then pick a fitting or part to add there.
      Click an already-connected port in a component's port list to insert in between.</p>`;
    return;
  }
  const ports = portsOf(n) || [];
  const err = solved.errors.filter((e) => e.id === n.id).map((e) => esc(e.message)).join('<br>');
  const isRoot = !n.parent;
  const typeOpts = n.type === 'part'
    ? [...library.values()].filter((p) => p.configured).map((p) => `<option value="${esc(p.id)}" ${p.id === n.part ? 'selected' : ''}>${esc(p.name)}</option>`).join('')
    : FITTINGS.map((f) => `<option value="${f.type}" ${f.type === n.type ? 'selected' : ''}>${f.label}</option>`).join('');
  const portRows = ports.map((p) => {
    const key = `${n.id}:${p.name}`;
    const isAttach = p.name === n.port && !isRoot;
    const child = state.nodes.find((c) => c.parent === n.id && c.parentPort === p.name);
    const status = isAttach ? 'upstream' : child ? `→ ${esc(nodeLabel(child))}` : 'open';
    const btn = isAttach ? '' : `<button data-activate="${key}" title="${child ? 'Insert a component here' : 'Add components here'}">${state.active === key ? '●' : child ? 'insert' : 'add'}</button>`;
    return `<div class="item"><b>${esc(p.name)}</b> ${esc(p.size || '')} <span class="meta">${status}</span>${btn}</div>`;
  }).join('');

  el.innerHTML = `
    <h4>${esc(nodeLabel(n))}</h4>
    <div class="grid">
      <span>Tag</span><input id="propTag" value="${esc(n.tag || '')}" placeholder="e.g. V-101">
      <span>${n.type === 'part' ? 'Part' : 'Type'}</span><select id="propType">${typeOpts}</select>
      ${n.type !== 'part' ? `<span>Size</span><select id="propSize">${sizeOptions(n.size)}</select>` : ''}
      ${TWO_SIZE.has(n.type) ? `<span>${n.type === 'tee' ? 'Branch' : 'Small end'}</span><select id="propSize2">${sizeOptions(n.size2)}</select>` : ''}
      ${n.type === 'pipe' ? `<span>Length mm</span><input id="propLength" type="number" min="1" step="1" value="${n.length}">` : ''}
      <span>Attach by</span><select id="propPort">${ports.map((p) => `<option ${p.name === n.port ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <span>Roll °</span><div class="rollbtns"><input id="propRoll" type="number" step="15" value="${n.roll || 0}" style="width:60px">
        <button data-roll="-90">−90</button><button data-roll="-45">−45</button><button data-roll="45">+45</button><button data-roll="90">+90</button></div>
      ${isRoot ? `<span>Start dir</span><select id="propStart">${Object.keys(START_DIRS).map((d) => `<option ${d === (n.startDir || '+X') ? 'selected' : ''}>${d}</option>`).join('')}</select>`
        : `<span>Gap mm</span><input id="propGap" type="number" step="0.5" value="${n.gap || 0}" title="Gasket / weld gap before this component">`}
    </div>
    <h3 style="margin-top:10px">Ports</h3>
    <div class="list">${portRows}</div>
    <div class="btns">
      <button id="propFlip" title="Attach by the next port (X)">Flip</button>
      ${n.type === 'pipe' ? '<button id="propSplit" title="Split this pipe in two so you can insert a component">Split…</button>' : ''}
      ${childrenOf(n.id).length <= 1 && (n.parent || childrenOf(n.id).length) ? '<button id="propRejoin" title="Remove this component and join its neighbours">Remove &amp; rejoin</button>' : ''}
      <button id="propDelete" class="danger" title="Delete this and everything downstream (Del)">Delete</button>
    </div>
    ${err ? `<div class="msg">${err}</div>` : ''}`;

  const on = (id, ev, fn) => { const x = $(id); if (x) x.addEventListener(ev, fn); };
  on('propTag', 'change', (e) => commit(() => { n.tag = e.target.value.trim(); }));
  on('propType', 'change', (e) => commit(() => {
    if (n.type === 'part') { n.part = e.target.value; return; }
    n.type = e.target.value;
    if (n.type === 'pipe' && !n.length) n.length = state.lastPipeLength;
    if (TWO_SIZE.has(n.type) && !n.size2) n.size2 = n.size;
    if (!['A', 'B', 'C'].includes(n.port)) n.port = 'A';
  }));
  on('propSize', 'change', (e) => commit(() => cascadeSize(n, n.size, e.target.value)));
  on('propSize2', 'change', (e) => commit(() => { n.size2 = e.target.value; }));
  on('propLength', 'change', (e) => {
    const v = parseFloat(e.target.value);
    if (!(v > 0)) { toast('Length must be > 0', true); return; }
    state.lastPipeLength = v;
    commit(() => { n.length = v; });
  });
  on('propLength', 'keydown', (e) => { if (e.key === 'Enter') { e.target.blur(); } });
  on('propPort', 'change', (e) => commit(() => setAttachPort(n, e.target.value)));
  on('propRoll', 'change', (e) => commit(() => { n.roll = parseFloat(e.target.value) || 0; }));
  on('propStart', 'change', (e) => commit(() => { n.startDir = e.target.value; }));
  on('propGap', 'change', (e) => commit(() => { n.gap = parseFloat(e.target.value) || 0; }));
  on('propFlip', 'click', () => flipNode(n.id));
  on('propDelete', 'click', () => deleteNode(n.id));
  on('propRejoin', 'click', () => deleteNode(n.id, true));
  on('propSplit', 'click', () => {
    const v = parseFloat(prompt('Split at distance from the upstream end (mm):', Math.round(n.length / 2)));
    if (v) splitPipe(n.id, v);
  });
  el.querySelectorAll('[data-roll]').forEach((b) => b.addEventListener('click', () => rollNode(n.id, Number(b.dataset.roll))));
  el.querySelectorAll('[data-activate]').forEach((b) => b.addEventListener('click', () => { state.active = b.dataset.activate; draw(); renderProps(); renderStatus(); }));
}

function renderStatus() {
  const box = new THREE.Box3();
  viewer.content.children.forEach((c) => { if (c.isMesh) box.expandByObject(c); });
  const parts = [`${state.nodes.length} components`];
  if (!box.isEmpty()) {
    const s = box.getSize(new THREE.Vector3());
    parts.push(`overall ${Math.round(s.x)} × ${Math.round(s.y)} × ${Math.round(s.z)} mm (X×Y×Z)`);
  }
  const t = activeTarget();
  if (t) parts.push(`active port: ${nodeLabel(nodeById(t.nodeId))} ${t.port.name} (${t.port.size || '?'})`);
  const errs = solved.errors.map((e) => `<span class="bad">⚠ ${esc(nodeLabel(nodeById(e.id) || { type: '?' }))}: ${esc(e.message)}</span>`);
  $('status').innerHTML = [...parts.map(esc), ...errs].join(' · ');
}

// -------------------------------------------------------------- BOM / export
function bom() {
  const pipes = {};
  const items = {};
  for (const n of state.nodes) {
    if (n.type === 'pipe') {
      (pipes[n.size] ||= { total: 0, cuts: [] });
      pipes[n.size].total += Number(n.length);
      pipes[n.size].cuts.push(Number(n.length));
    } else {
      const key = `${nodeLabel(n)}|${nodeSizeText(n)}`;
      (items[key] ||= { desc: nodeLabel(n), size: nodeSizeText(n), qty: 0, tags: [] });
      items[key].qty++;
      if (n.tag) items[key].tags.push(n.tag);
    }
  }
  const rows = [];
  for (const [size, p] of Object.entries(pipes).sort((a, b) => sizeNum(a[0]) - sizeNum(b[0]))) {
    rows.push({ desc: `Pipe ${state.standard} ${state.schedule || ''}`.trim(), size, qty: `${Math.round(p.total)} mm`, notes: `cuts: ${p.cuts.map((c) => Math.round(c * 10) / 10).join(', ')}` });
  }
  for (const it of Object.values(items).sort((a, b) => a.desc.localeCompare(b.desc))) {
    rows.push({ desc: it.desc, size: it.size, qty: it.qty, notes: it.tags.join(', ') });
  }
  return rows;
}

function showBom() {
  const rows = bom();
  $('bomBody').innerHTML = `<table class="bom"><tr><th>Description</th><th>Size</th><th>Qty</th><th>Notes</th></tr>${
    rows.map((r) => `<tr><td>${esc(r.desc)}</td><td>${esc(r.size)}</td><td class="num">${esc(r.qty)}</td><td>${esc(r.notes)}</td></tr>`).join('')}</table>`;
  $('dlgBom').showModal();
}

function spoolData() {
  return { version: 1, name: state.name, standard: state.standard, schedule: state.schedule, defaultSize: state.defaultSize, nodes: state.nodes };
}

async function exportStep() {
  if (!state.nodes.length) { toast('Nothing to export', true); return; }
  if (solved.errors.some((e) => e.kind !== 'size')) {
    if (!confirm('Some components could not be placed and will be left out. Export anyway?')) return;
  } else if (solved.errors.length && !confirm('There are size mismatches in the spool. Export anyway?')) return;
  $('expMsg').textContent = '';
  $('dlgExport').showModal();
}

async function doExport() {
  const items = [];
  for (const n of state.nodes) {
    const e = solved.placed.get(n.id);
    if (!e) continue;
    items.push({
      type: n.type, size: n.size, size2: TWO_SIZE.has(n.type) ? (n.size2 || n.size) : null,
      length: n.length, part: n.part, standard: state.standard, schedule: state.schedule, matrix: e.matrix,
    });
  }
  $('expGo').disabled = true;
  $('expMsg').textContent = 'Building STEP… (fusing large models can take a minute)';
  try {
    const res = await api.exportStep({
      name: state.name, items,
      options: { fuse: $('expFuse').checked, hollow: $('expHollow').checked },
    });
    const warnings = JSON.parse(res.headers.get('X-Spool-Warnings') || '[]');
    download(`${state.name}.stp`, await res.blob());
    $('dlgExport').close();
    if (warnings.length) toast(warnings.join(' '), true, 8000);
    else toast(`Exported ${state.name}.stp (${res.headers.get('X-Spool-Solids')} solid body)`);
  } catch (e) {
    $('expMsg').textContent = `Export failed: ${e.message}`;
  } finally {
    $('expGo').disabled = false;
  }
}

// ------------------------------------------------------------ save / open
async function saveProject() {
  state.name = $('projectName').value.trim() || 'Spool';
  try {
    await api.saveProject(state.name, spoolData());
    toast(`Saved ${state.name}`);
  } catch (e) { toast(`Save failed: ${e.message}`, true); }
}

function loadSpool(data) {
  state.name = data.name || 'Spool';
  $('projectName').value = state.name;
  if (data.standard && config.standards[data.standard]) state.standard = data.standard;
  state.schedule = data.schedule || config.standards[state.standard].defaultSchedule;
  state.defaultSize = data.defaultSize || state.defaultSize;
  state.nodes = data.nodes || [];
  state.selected = null;
  state.active = null;
  undoStack.length = 0;
  redoStack.length = 0;
  renderSpec();
  needFit = true;
  rebuild();
}

async function showOpen() {
  const list = await api.projects();
  $('projectList').innerHTML = list.length
    ? list.map((n) => `<div class="item" data-proj="${esc(n)}">${esc(n)}</div>`).join('')
    : '<p class="hint">No saved spools yet.</p>';
  $('dlgOpen').showModal();
}

// ------------------------------------------------------------------- specs
function renderSpec() {
  $('selStandard').innerHTML = Object.keys(config.standards).map((s) => `<option ${s === state.standard ? 'selected' : ''}>${esc(s)}</option>`).join('');
  const std = config.standards[state.standard];
  $('selSchedule').innerHTML = std.schedules.map((s) => `<option ${s === state.schedule ? 'selected' : ''}>${esc(s)}</option>`).join('');
  $('selSize').innerHTML = sizeOptions(state.defaultSize);
}

// -------------------------------------------------------------------- events
function wire() {
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
    if (b.dataset.tab === 'library') libEditor.show(); else { viewer.resize(); }
  }));
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => viewer.setView(b.dataset.view)));
  $('btnFit').onclick = () => viewer.fit();
  $('btnUndo').onclick = undo;
  $('btnRedo').onclick = redo;
  ['chkDims', 'chkTags', 'chkXray'].forEach((id) => { $(id).onchange = draw; });
  $('selStandard').onchange = (e) => {
    state.standard = e.target.value;
    state.schedule = config.standards[state.standard].defaultSchedule;
    renderSpec();
    rebuild();
  };
  $('selSchedule').onchange = (e) => { state.schedule = e.target.value; rebuild(); };
  $('selSize').onchange = (e) => { state.defaultSize = e.target.value; };
  $('partSearch').oninput = renderPartList;
  $('partList').onclick = (e) => {
    const it = e.target.closest('[data-part]');
    if (it) { addComponent('part', { part: it.dataset.part }); return; }
    const su = e.target.closest('[data-setup]');
    if (su) { document.querySelector('.tabs [data-tab=library]').click(); libEditor.select(su.dataset.setup); }
  };
  $('tree').onclick = (e) => {
    const it = e.target.closest('[data-node]');
    if (!it) return;
    state.selected = it.dataset.node;
    draw(); renderTree(); renderProps();
  };
  $('projectName').onchange = (e) => { state.name = e.target.value.trim() || 'Spool'; };
  $('btnNew').onclick = () => {
    if (state.nodes.length && !confirm('Start a new spool? Unsaved changes are lost.')) return;
    loadSpool({ name: 'Spool-01', standard: state.standard, schedule: state.schedule, nodes: [] });
  };
  $('btnSave').onclick = saveProject;
  $('btnOpen').onclick = showOpen;
  $('projectList').onclick = async (e) => {
    const it = e.target.closest('[data-proj]');
    if (!it) return;
    try { loadSpool(await api.loadProject(it.dataset.proj)); $('dlgOpen').close(); } catch (err) { toast(err.message, true); }
  };
  $('importJson').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { loadSpool(JSON.parse(await f.text())); $('dlgOpen').close(); } catch (err) { toast(`Could not read file: ${err.message}`, true); }
    e.target.value = '';
  };
  $('btnBom').onclick = showBom;
  $('bomCsv').onclick = () => {
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = ['Description,Size,Qty,Notes', ...bom().map((r) => [r.desc, r.size, r.qty, r.notes].map(q).join(','))].join('\r\n');
    download(`${state.name}-BOM.csv`, csv, 'text/csv');
  };
  $('bomJson').onclick = () => download(`${state.name}.json`, JSON.stringify(spoolData(), null, 2), 'application/json');
  $('btnExport').onclick = exportStep;
  $('expGo').onclick = doExport;
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  // picking in the viewport (ignore drags)
  let down = null;
  const canvas = viewer.renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || e.button !== 0) return;
    const hits = viewer.pick(e, viewer.content.children);
    const portHit = hits.find((h) => h.object.userData.portKey);
    if (portHit) {
      state.active = portHit.object.userData.portKey;
      state.selected = portHit.object.userData.portKey.split(':')[0];
    } else {
      const h = hits.find((x) => x.object.userData.nodeId);
      state.selected = h ? h.object.userData.nodeId : null;
    }
    draw(); renderTree(); renderProps(); renderStatus();
  });

  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('tab-builder').classList.contains('active')) return;
    if (document.querySelector('dialog[open]')) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    const sel = state.selected;
    if (e.ctrlKey || e.metaKey) {
      if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (k === 'y') { e.preventDefault(); redo(); }
      else if (k === 's') { e.preventDefault(); saveProject(); }
      return;
    }
    if (k === 'p') addComponent('pipe');
    else if (k === 'e') addComponent(e.shiftKey ? 'elbow45' : 'elbow90');
    else if (k === 't') addComponent('tee');
    else if (k === 'f') addComponent('flange_wn');
    else if (k === 'r' && sel) rollNode(sel, e.shiftKey ? -90 : 90);
    else if (k === 'x' && sel) flipNode(sel);
    else if ((k === 'delete' || k === 'backspace') && sel) { e.preventDefault(); deleteNode(sel); }
    else if (k === 'n' && open.length) {
      const keys = open.map((o) => `${o.nodeId}:${o.port.name}`);
      state.active = keys[(keys.indexOf(state.active) + 1) % keys.length];
      draw(); renderProps(); renderStatus();
    } else if (k === 'home') viewer.fit();
    else if (k === 'escape') { state.selected = null; draw(); renderTree(); renderProps(); }
  });
}

// ---------------------------------------------------------------------- init
async function refreshLibrary() {
  const parts = await api.library();
  library = new Map(parts.map((p) => [p.id, p]));
  renderPartList();
}

const libEditor = new LibraryEditor({
  getConfig: () => config,
  getStandard: () => state.standard,
  partGeometry,
  onSaved: async () => { await refreshLibrary(); rebuild(); },
});

async function init() {
  config = await api.config();
  state.standard = Object.keys(config.standards)[0];
  state.schedule = config.standards[state.standard].defaultSchedule;
  renderSpec();
  renderPalette();
  wire();
  await refreshLibrary();
  libEditor.setLibraryPath(config.libraryDir);
  rebuild();
}

init().catch((e) => toast(`Failed to start: ${e.message}`, true, 10000));
