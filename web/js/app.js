// Spool builder: main application (runs entirely in the browser).
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { Viewer, toMatrix4 } from './viewer.js';
import { solve, openPorts, pipePorts, START_DIRS, OD_TOLERANCE } from './kinematics.js';
import { PIPE_TYPES, pipeType, sizeForOd, odLabel } from './pipe-types.js';
import { Library, kvGet, kvSet } from './library.js';
import { createPartLoader } from './parts.js';
import { startCad, cad } from './cad-client.js';
import { toast, esc, ask, saveFile } from './ui.js';
import { LibraryEditor } from './library-editor.js';

const COLORS = { pipe: 0x9aabbd, part: 0xd38a3a, fitting: 0x8195ab };
const SPOOLS_KEY = 'pipe-spool-tool.spools';

// ---------------------------------------------------------------------- state
const state = {
  name: 'Spool-01',
  pipeType: PIPE_TYPES[0].id,
  defaultSize: 'DN50',
  nodes: [],
  selected: null,
  active: null, // "nodeId:portName" – where the next component goes
  lastPipeLength: 200,
};
const library = new Library();
const parts = createPartLoader(library);
let solved = { placed: new Map(), errors: [] };
let open = [];
const undoStack = [];
const redoStack = [];
let nextId = 1;
let needFit = true;
let recent = [];

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
const type = () => pipeType(state.pipeType);
const pipeSize = (label) => type().sizes.find((s) => s.label === label) || null;
const isFitting = (p) => /fitting/i.test(p?.category || '');

function nodeLabel(n) {
  if (!n) return '?';
  if (n.type === 'pipe') return 'Pipe';
  return library.parts.get(n.part)?.name || n.part.split('/').pop();
}

function nodeSizeText(n) {
  if (n.type === 'pipe') return n.size;
  const ps = library.parts.get(n.part)?.ports || [];
  return [...new Set(ps.map((p) => odLabel(type(), p.od)))].join('×');
}

/** Does this part connect to the current pipe type? */
function fitsType(p) {
  return p.ports.some((x) => sizeForOd(type(), x.od));
}

const resolved = new Map(); // node id -> {geometry, ports}

async function loadNode(n) {
  if (n.type === 'pipe') {
    const s = pipeSize(n.size);
    if (!s) throw new Error(`${n.size} is not a size of ${type().name}`);
    return { geometry: null, ports: pipePorts(s.od, Number(n.length) || 1) };
  }
  const meta = library.parts.get(n.part);
  if (!meta) throw new Error(`Part not in the library: ${n.part}. Open the library folder that contains it.`);
  if (!meta.ports.length) throw new Error(`${meta.name} has no connection ports set up`);
  const d = await parts.get(n.part);
  return { geometry: d.geometry, ports: meta.ports };
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
  if (seq !== buildSeq) return;
  for (const id of [...resolved.keys()]) if (!nodeById(id)) resolved.delete(id);
  solved = solve(state.nodes, portsOf);
  solved.errors = solved.errors.filter((e) => !(e.message === 'No ports defined' && loadErrors.some((l) => l.id === e.id)));
  solved.errors.push(...loadErrors);
  open = openPorts(state.nodes, solved.placed);
  kvSet('lastSpool', spoolData());
  const keys = open.map((o) => `${o.nodeId}:${o.port.name}`);
  if (state.active && !keys.includes(state.active) && !portByKey(state.active)) state.active = null;
  if (!state.active && keys.length) state.active = keys[keys.length - 1];
  draw();
  renderTree();
  renderProps();
  renderStatus();
  renderPartList();
}

function portByKey(key) {
  if (!key) return null;
  const [id, name] = key.split(':');
  return solved.placed.get(id)?.ports.find((p) => p.name === name) || null;
}

function childAt(key) {
  const [id, name] = key.split(':');
  return state.nodes.find((c) => c.parent === id && c.parentPort === name) || null;
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
      const od = pipeSize(n.size).od;
      const g = new THREE.CylinderGeometry(od / 2, od / 2, L, 32, 1, false);
      g.rotateZ(-Math.PI / 2).translate(L / 2, 0, 0);
      mesh = new THREE.Mesh(g, material('pipe', sel, xray));
    } else {
      mesh = new THREE.Mesh(r.geometry, material(isFitting(library.parts.get(n.part)) ? 'fitting' : 'part', sel, xray));
    }
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(toMatrix4(e.matrix));
    mesh.userData.nodeId = n.id;
    viewer.content.add(mesh);

    if (n.type === 'pipe' && showDims) {
      const a = e.ports[0].origin, b = e.ports[1].origin;
      addLabel('dim-label', `${Math.round(Number(n.length) * 10) / 10}`, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
    }
    if (n.type !== 'pipe' && showTags && (n.tag || !isFitting(library.parts.get(n.part)))) {
      const box = new THREE.Box3().setFromObject(mesh);
      const c = box.getCenter(new THREE.Vector3());
      addLabel('tag-label', n.tag || nodeLabel(n), [c.x, c.y, box.max.z + 15]);
    }
  }
  for (const o of open) drawPort(o.nodeId, o.port);
  const act = portByKey(state.active);
  if (act && !open.some((o) => `${o.nodeId}:${o.port.name}` === state.active)) drawPort(state.active.split(':')[0], act, true);
  if (needFit && viewer.content.children.length) { viewer.fit(); needFit = false; }
  viewer.render();
}

function addLabel(cls, text, pos) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  const lbl = new CSS2DObject(el);
  lbl.position.set(...pos);
  viewer.content.add(lbl);
}

function drawPort(nodeId, p, insert) {
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
  try { fn(); } catch (e) { restore(before); toast(e.message, true); return; }
  undoStack.push(before);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  rebuild();
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); rebuild(); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); rebuild(); }

/** Which of the new component's ports mates with the target port. */
function choosePort(ports, target) {
  if (!target) return ports[0]?.name || 'A';
  const fit = (p) => !(target.od > 0) || !(p.od > 0) || Math.abs(p.od - target.od) <= OD_TOLERANCE;
  const same = ports.find((p) => fit(p) && p.kind === target.kind) || ports.find(fit);
  return (same || ports[0]).name;
}

/** The port that continues the run: the one pointing most away from the attach port. */
function runPort(ports, attachName, prefer) {
  const free = ports.filter((p) => p.name !== attachName);
  if (prefer && free.some((p) => p.name === prefer)) return prefer;
  const own = ports.find((p) => p.name === attachName);
  if (own && free.length > 1) free.sort((a, b) => dot3(a.dir, own.dir) - dot3(b.dir, own.dir));
  return free[0]?.name;
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function activeTarget() {
  const port = portByKey(state.active);
  return port ? { nodeId: state.active.split(':')[0], port } : null;
}

async function addComponent(kind, extra = {}) {
  const target = state.nodes.length ? activeTarget() : null;
  if (state.nodes.length && !target) { toast('Pick where to add: click a blue end marker, or use Insert before / after.', true); return; }
  const n = { id: newId(), type: kind, roll: 0, gap: 0, ...extra };
  if (kind === 'pipe') {
    const s = target?.port.od ? sizeForOd(type(), target.port.od) : pipeSize(state.defaultSize);
    if (!s) { toast(`No ${type().name} size matches Ø${target.port.od} – change the pipe type or size.`, true); return; }
    n.size = s.label;
    n.length = state.lastPipeLength;
  }
  let ports;
  try { ports = (await loadNode(n)).ports; } catch (e) { toast(e.message, true); return; }
  n.port = choosePort(ports, target?.port);
  if (target) { n.parent = target.nodeId; n.parentPort = target.port.name; } else n.startDir = '+X';
  commit(() => {
    const next = runPort(ports, n.port);
    if (target) {
      const existing = childAt(`${target.nodeId}:${target.port.name}`);
      if (existing) {
        if (!next) throw new Error('A part with one connection cannot be inserted between two others');
        existing.parent = n.id;
        existing.parentPort = next;
        // a pipe moved onto the far end of e.g. a reducer takes that end's size
        const nextOd = ports.find((p) => p.name === next)?.od;
        const s = existing.type === 'pipe' && nextOd ? sizeForOd(type(), nextOd) : null;
        if (s && s.label !== existing.size) cascadeSize(existing, s.label, n.id);
      }
    }
    state.nodes.push(n);
    state.selected = n.id;
    state.active = next ? `${n.id}:${next}` : null;
    if (state.nodes.length === 1) needFit = true;
  });
  if (kind === 'part') {
    recent = [n.part, ...recent.filter((x) => x !== n.part)].slice(0, 6);
    try { localStorage.setItem('pipe-spool-tool.recent', JSON.stringify(recent)); } catch { /* ignore */ }
  }
  if (kind === 'pipe') setTimeout(() => { const el = $('propLength'); if (el) { el.focus(); el.select(); } }, 60);
}

/** Make the next added component go in front of (before) or after a component. */
function insertAt(id, where) {
  const n = nodeById(id);
  const e = solved.placed.get(id);
  if (!n || !e) return;
  if (where === 'before') {
    state.active = n.parent ? `${n.parent}:${n.parentPort}` : `${n.id}:${e.attachPort}`;
  } else {
    const ports = portsOf(n) || [];
    const out = runPort(ports, e.attachPort);
    if (!out) { toast('This part has no downstream connection', true); return; }
    state.active = `${n.id}:${out}`;
  }
  state.selected = id;
  draw(); renderProps(); renderStatus();
  toast(`Pick a pipe or part to insert ${where} ${nodeLabel(n)}`);
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
      if (n.parent) { k.parent = n.parent; k.parentPort = n.parentPort; k.gap = n.gap || 0; }
      else { delete k.parent; delete k.parentPort; k.startDir = n.startDir; k.origin = n.origin; }
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
  for (const c of childrenOf(n.id)) if (c.parentPort === name) c.parentPort = old;
  n.port = name;
}

/** Change a pipe size and carry it along connected pipes of the same size. */
function cascadeSize(n, newSize, stopAt = null) {
  const old = n.size;
  const seen = new Set(stopAt ? [stopAt] : []);
  const walk = (node) => {
    node.size = newSize;
    seen.add(node.id);
    const near = [...childrenOf(node.id), nodeById(node.parent)].filter(Boolean);
    for (const c of near) if (!seen.has(c.id) && c.type === 'pipe' && c.size === old) walk(c);
  };
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
    state.active = `${n.id}:${b.parentPort}`;
    state.selected = n.id;
  });
}

// ------------------------------------------------------------------- panels
function renderPartList() {
  const q = $('partSearch').value.toLowerCase().trim();
  const all = $('chkAllParts').checked;
  const words = q.split(/\s+/).filter(Boolean);
  const list = library.list().filter((p) => (all || !p.configured || fitsType(p))
    && words.every((w) => `${p.name} ${p.category} ${p.file}`.toLowerCase().includes(w)));
  const item = (p) => {
    const sz = [...new Set(p.ports.map((x) => odLabel(type(), x.od)))].join(' × ');
    return p.configured
      ? `<div class="item" data-part="${esc(p.id)}" title="${esc(p.id)}">${esc(p.name)}<span class="meta">${esc(sz)}</span></div>`
      : `<div class="item disabled" data-setup="${esc(p.id)}" title="Ports not set up yet – click to set up">${esc(p.name)}<span class="meta"><span class="badge">set up</span></span></div>`;
  };
  let html = '';
  const rec = recent.map((id) => library.parts.get(id)).filter((p) => p && list.includes(p));
  if (rec.length && !q) html += `<div class="cat">Recent</div>${rec.map(item).join('')}`;
  const cats = {};
  for (const p of list) (cats[p.category] ||= []).push(p);
  for (const [cat, ps] of Object.entries(cats).sort()) {
    html += `<div class="cat">${esc(cat)}</div>${ps.sort((a, b) => a.name.localeCompare(b.name)).map(item).join('')}`;
  }
  $('partList').innerHTML = html || `<p class="hint">${library.parts.size ? `No parts match${all ? '' : ` ${esc(type().name)} – tick “All”`}.` : 'Open your STEP library folder to see your fittings and valves.'}</p>`;
}

function renderTree() {
  const errById = new Map(solved.errors.map((e) => [e.id, e.message]));
  let html = '';
  const walk = (parent, depth) => {
    for (const n of state.nodes.filter((x) => (x.parent || null) === parent)) {
      const extra = n.type === 'pipe' ? `${n.size} · ${n.length}` : nodeSizeText(n);
      const cls = ['item', n.id === state.selected ? 'sel' : '', errById.has(n.id) ? 'err' : ''].join(' ');
      html += `<div class="${cls}" data-node="${n.id}" style="padding-left:${6 + depth * 12}px" title="${esc(errById.get(n.id) || '')}">`
        + `${esc(n.tag ? `${n.tag} – ` : '')}${esc(nodeLabel(n))}<span class="meta">${esc(extra)}${n.roll ? ` ⟳${n.roll}°` : ''}</span></div>`;
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  $('tree').innerHTML = html || '<p class="hint">Empty spool. Add a pipe or pick a part from your library to start.</p>';
}

function sizeOptions(selected) {
  return type().sizes.map((s) => `<option ${s.label === selected ? 'selected' : ''} value="${esc(s.label)}">${esc(s.label)} · Ø${s.od}×${s.wall}</option>`).join('');
}

function renderProps() {
  const el = $('props');
  const n = nodeById(state.selected);
  if (!n) {
    el.innerHTML = `<h3>Spool</h3><p class="hint">Click a component to edit it. Blue markers are open ends –
      click one to make it the active (orange) end, then add a pipe or a library part there.
      Select a component and use <b>Insert before</b> / <b>Insert after</b> to put something in between.</p>`;
    return;
  }
  const ports = portsOf(n) || [];
  const err = solved.errors.filter((e) => e.id === n.id).map((e) => esc(e.message)).join('<br>');
  const isRoot = !n.parent;
  const attach = solved.placed.get(n.id)?.attachPort;
  const portRows = ports.map((p) => {
    const key = `${n.id}:${p.name}`;
    const isAttach = p.name === attach && !isRoot;
    const child = state.nodes.find((c) => c.parent === n.id && c.parentPort === p.name);
    const status = isAttach ? 'upstream' : child ? `→ ${esc(nodeLabel(child))}` : 'open';
    const btn = isAttach ? '' : `<button data-activate="${key}" title="${child ? 'Insert a component here' : 'Add components here'}">${state.active === key ? '●' : child ? 'insert' : 'add'}</button>`;
    return `<div class="item"><b>${esc(p.name)}</b> ${esc(odLabel(type(), p.od))} <span class="meta">${status}</span>${btn}</div>`;
  }).join('');
  const partOpts = n.type === 'part'
    ? library.list().filter((p) => p.configured).sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => `<option value="${esc(p.id)}" ${p.id === n.part ? 'selected' : ''}>${esc(p.name)}</option>`).join('') : '';

  el.innerHTML = `
    <h4>${esc(nodeLabel(n))}</h4>
    <div class="btns top">
      <button id="propBefore" title="Insert the next pipe or part before this one ([)">⇤ Insert before</button>
      <button id="propAfter" title="Insert the next pipe or part after this one (])">Insert after ⇥</button>
    </div>
    <div class="grid">
      <span>Tag</span><input id="propTag" value="${esc(n.tag || '')}" placeholder="e.g. V-101">
      ${n.type === 'part' ? `<span>Part</span><select id="propPart">${partOpts}</select>` : ''}
      ${n.type === 'pipe' ? `<span>Size</span><select id="propSize">${sizeOptions(n.size)}</select>
        <span>Length mm</span><input id="propLength" type="number" min="1" step="1" value="${n.length}">` : ''}
      <span>Attach by</span><select id="propPort">${ports.map((p) => `<option ${p.name === n.port ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <span>Roll °</span><div class="rollbtns"><input id="propRoll" type="number" step="15" value="${n.roll || 0}" style="width:60px">
        <button data-roll="-90">−90</button><button data-roll="-45">−45</button><button data-roll="45">+45</button><button data-roll="90">+90</button></div>
      ${isRoot ? `<span>Start dir</span><select id="propStart">${Object.keys(START_DIRS).map((d) => `<option ${d === (n.startDir || '+X') ? 'selected' : ''}>${d}</option>`).join('')}</select>`
        : `<span>Gap mm</span><input id="propGap" type="number" step="0.5" value="${n.gap || 0}" title="Gasket / weld gap before this component">`}
    </div>
    <h3 style="margin-top:10px">Connections</h3>
    <div class="list">${portRows}</div>
    <div class="btns">
      <button id="propFlip" title="Attach by the next port (X)">Flip</button>
      ${n.type === 'pipe' ? '<button id="propSplit" title="Split this pipe in two">Split…</button>' : ''}
      ${childrenOf(n.id).length <= 1 && (n.parent || childrenOf(n.id).length) ? '<button id="propRejoin" title="Remove this component and join its neighbours">Remove &amp; rejoin</button>' : ''}
      <button id="propDelete" class="danger" title="Delete this and everything downstream (Del)">Delete</button>
    </div>
    ${err ? `<div class="msg">${err}</div>` : ''}`;

  const on = (id, ev, fn) => { const x = $(id); if (x) x.addEventListener(ev, fn); };
  on('propBefore', 'click', () => insertAt(n.id, 'before'));
  on('propAfter', 'click', () => insertAt(n.id, 'after'));
  on('propTag', 'change', (e) => commit(() => { n.tag = e.target.value.trim(); }));
  on('propPart', 'change', (e) => commit(() => { n.part = e.target.value; }));
  on('propSize', 'change', (e) => commit(() => cascadeSize(n, e.target.value)));
  on('propLength', 'change', (e) => {
    const v = parseFloat(e.target.value);
    if (!(v > 0)) { toast('Length must be more than 0', true); return; }
    state.lastPipeLength = v;
    commit(() => { n.length = v; });
  });
  on('propLength', 'keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  on('propPort', 'change', (e) => commit(() => setAttachPort(n, e.target.value)));
  on('propRoll', 'change', (e) => commit(() => { n.roll = parseFloat(e.target.value) || 0; }));
  on('propStart', 'change', (e) => commit(() => { n.startDir = e.target.value; }));
  on('propGap', 'change', (e) => commit(() => { n.gap = parseFloat(e.target.value) || 0; }));
  on('propFlip', 'click', () => flipNode(n.id));
  on('propDelete', 'click', () => deleteNode(n.id));
  on('propRejoin', 'click', () => deleteNode(n.id, true));
  on('propSplit', 'click', async () => {
    const v = parseFloat(await ask('Split at distance from the upstream end (mm):', { input: String(Math.round(n.length / 2)), ok: 'Split' }));
    if (v) splitPipe(n.id, v);
  });
  el.querySelectorAll('[data-roll]').forEach((b) => b.addEventListener('click', () => rollNode(n.id, Number(b.dataset.roll))));
  el.querySelectorAll('[data-activate]').forEach((b) => b.addEventListener('click', () => { state.active = b.dataset.activate; draw(); renderProps(); renderStatus(); }));
}

function renderStatus() {
  const box = new THREE.Box3();
  viewer.content.children.forEach((c) => { if (c.isMesh) box.expandByObject(c); });
  const out = [`${state.nodes.length} components`];
  if (!box.isEmpty()) {
    const s = box.getSize(new THREE.Vector3());
    out.push(`overall ${Math.round(s.x)} × ${Math.round(s.y)} × ${Math.round(s.z)} mm`);
  }
  const t = activeTarget();
  if (t) {
    const child = childAt(state.active);
    const where = child ? `insert between ${nodeLabel(nodeById(t.nodeId))} and ${nodeLabel(child)}` : `add at ${nodeLabel(nodeById(t.nodeId))} ${t.port.name}`;
    out.push(`next: ${where} (${odLabel(type(), t.port.od)})`);
  }
  const errs = solved.errors.map((e) => `<span class="bad">⚠ ${esc(nodeLabel(nodeById(e.id)))}: ${esc(e.message)}</span>`);
  $('status').innerHTML = [...out.map(esc), ...errs].join(' · ');
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
      const key = n.part;
      (items[key] ||= { desc: nodeLabel(n), size: nodeSizeText(n), qty: 0, tags: [] });
      items[key].qty++;
      if (n.tag) items[key].tags.push(n.tag);
    }
  }
  const rows = [];
  for (const [size, p] of Object.entries(pipes)) {
    rows.push({ desc: `Pipe ${type().name}`, size, qty: `${Math.round(p.total)} mm`, notes: `cuts: ${p.cuts.map((c) => Math.round(c * 10) / 10).join(', ')}` });
  }
  for (const it of Object.values(items).sort((a, b) => a.desc.localeCompare(b.desc))) rows.push({ desc: it.desc, size: it.size, qty: it.qty, notes: it.tags.join(', ') });
  return rows;
}

function showBom() {
  $('bomBody').innerHTML = `<div class="scroll-x"><table class="bom"><tr><th>Description</th><th>Size</th><th>Qty</th><th>Notes</th></tr>${
    bom().map((r) => `<tr><td>${esc(r.desc)}</td><td>${esc(r.size)}</td><td class="num">${esc(r.qty)}</td><td>${esc(r.notes)}</td></tr>`).join('')}</table></div>`;
  $('dlgBom').showModal();
}

function spoolData() {
  return { version: 2, name: state.name, pipeType: state.pipeType, defaultSize: state.defaultSize, nodes: state.nodes };
}

async function exportStep() {
  if (!state.nodes.length) { toast('Nothing to export yet', true); return; }
  if (solved.errors.some((e) => e.kind !== 'size')) {
    if (!await ask('Some components could not be placed and will be left out. Export anyway?', { ok: 'Export' })) return;
  } else if (solved.errors.length && !await ask('There are size mismatches in the spool. Export anyway?', { ok: 'Export' })) return;
  $('expMsg').textContent = '';
  $('dlgExport').showModal();
}

async function doExport() {
  $('expGo').disabled = true;
  const msg = (t) => { $('expMsg').textContent = t; };
  try {
    msg('Loading the CAD engine…');
    await startCad();
    const items = [];
    for (const n of state.nodes) {
      const e = solved.placed.get(n.id);
      if (!e) continue;
      if (n.type === 'pipe') {
        const s = pipeSize(n.size);
        items.push({ kind: 'pipe', od: s.od, id: $('expHollow').checked ? s.od - 2 * s.wall : 0, length: Number(n.length), matrix: e.matrix });
      } else {
        msg(`Reading ${nodeLabel(n)}…`);
        items.push({ kind: 'part', key: await parts.ensureKernel(n.part), matrix: e.matrix });
      }
    }
    msg('Building the STEP file… (merging large manufacturer models can take a minute)');
    const res = await cad.exportStep({ name: state.name, items, fuse: $('expFuse').checked });
    const saved = await saveFile(`${state.name}.stp`, res.bytes, 'application/step');
    if (!saved) { msg('Download cancelled.'); return; }
    $('dlgExport').close();
    if (res.warnings.length) toast(res.warnings.join(' '), true, 9000);
    else toast(`Saved ${saved} – ${res.solids} solid body`);
  } catch (e) {
    msg(`Export failed: ${e.message}`);
  } finally {
    $('expGo').disabled = false;
  }
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
  state.name = data.name || 'Spool';
  $('projectName').value = state.name;
  state.pipeType = pipeType(data.pipeType).id;
  state.defaultSize = data.defaultSize || type().sizes[0].label;
  state.nodes = data.nodes || [];
  state.selected = null;
  state.active = null;
  undoStack.length = 0;
  redoStack.length = 0;
  renderSpec();
  needFit = true;
  rebuild();
}

function showOpen() {
  const names = Object.keys(readSpools()).sort();
  $('projectList').innerHTML = names.length
    ? names.map((n) => `<div class="item" data-proj="${esc(n)}">${esc(n)}<span class="meta"><button data-del="${esc(n)}" title="Delete">✕</button></span></div>`).join('')
    : '<p class="hint">No spools saved in this browser yet.</p>';
  $('dlgOpen').showModal();
}

// ------------------------------------------------------------------- specs
function renderSpec() {
  $('selType').innerHTML = PIPE_TYPES.map((t) => `<option value="${t.id}" ${t.id === state.pipeType ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  if (!pipeSize(state.defaultSize)) state.defaultSize = type().sizes[Math.min(4, type().sizes.length - 1)].label;
  $('selSize').innerHTML = sizeOptions(state.defaultSize);
}

async function renderLibraryBar() {
  const name = library.folderName;
  const remembered = name ? null : await library.rememberedName();
  $('libFolder').innerHTML = name
    ? `<b>${esc(name)}</b> <span class="hint">${library.writable ? 'port set-ups save into the folder' : 'port set-ups save in this browser'}</span>`
    : remembered ? `<span class="hint">Last used: <b>${esc(remembered)}</b></span>` : '<span class="hint">Built-in samples only</span>';
  $('btnReconnect').hidden = !remembered;
}

// -------------------------------------------------------------------- events
async function openLibrary() {
  if (library.canPickDirectory) {
    try { await library.pickDirectory(); } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); return; }
    afterLibraryChange();
  } else {
    $('libInput').click();
  }
}

function afterLibraryChange() {
  renderLibraryBar();
  renderPartList();
  libEditor.refresh();
  const n = library.parts.size - library.list().filter((p) => p.id.startsWith('Samples/')).length;
  toast(`Library loaded: ${n} STEP file${n === 1 ? '' : 's'}`);
  rebuild();
}

function wire() {
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
    if (b.dataset.tab === 'library') libEditor.show(); else viewer.resize();
  }));
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => viewer.setView(b.dataset.view)));
  $('btnFit').onclick = () => viewer.fit();
  $('btnUndo').onclick = undo;
  $('btnRedo').onclick = redo;
  ['chkDims', 'chkTags', 'chkXray'].forEach((id) => { $(id).onchange = draw; });
  $('selType').onchange = (e) => { state.pipeType = e.target.value; renderSpec(); rebuild(); };
  $('selSize').onchange = (e) => { state.defaultSize = e.target.value; };
  $('btnPipe').onclick = () => addComponent('pipe');
  $('partSearch').oninput = renderPartList;
  $('partSearch').onkeydown = (e) => {
    if (e.key === 'Enter') { const first = $('partList').querySelector('[data-part]'); if (first) { addComponent('part', { part: first.dataset.part }); e.target.blur(); } }
    if (e.key === 'Escape') e.target.blur();
  };
  $('chkAllParts').onchange = renderPartList;
  $('partList').onclick = (e) => {
    const it = e.target.closest('[data-part]');
    if (it) { addComponent('part', { part: it.dataset.part }); return; }
    const su = e.target.closest('[data-setup]');
    if (su) { document.querySelector('.tabs [data-tab=library]').click(); libEditor.select(su.dataset.setup); }
  };
  $('btnOpenLib').onclick = openLibrary;
  $('btnReconnect').onclick = async () => {
    try { if (await library.reconnect(true) === true) afterLibraryChange(); else toast('Permission was not given', true); } catch (e) { toast(e.message, true); }
  };
  $('libInput').onchange = async (e) => {
    if (!e.target.files.length) return;
    await library.loadFileList(e.target.files);
    e.target.value = '';
    afterLibraryChange();
  };
  $('tree').onclick = (e) => {
    const it = e.target.closest('[data-node]');
    if (!it) return;
    state.selected = it.dataset.node;
    draw(); renderTree(); renderProps();
  };
  $('projectName').onchange = (e) => { state.name = e.target.value.trim() || 'Spool'; };
  $('btnNew').onclick = async () => {
    if (state.nodes.length && !await ask('Start a new spool? Unsaved changes are lost.', { ok: 'New spool' })) return;
    loadSpool({ name: 'Spool-01', pipeType: state.pipeType, defaultSize: state.defaultSize, nodes: [] });
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
    const csv = ['Description,Size,Qty,Notes', ...bom().map((r) => [r.desc, r.size, r.qty, r.notes].map(q).join(','))].join('\r\n');
    try { await saveFile(`${state.name}-BOM.csv`, csv, 'text/csv'); } catch (err) { toast(err.message, true); }
  };
  $('btnExport').onclick = exportStep;
  $('expGo').onclick = doExport;
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
    draw(); renderTree(); renderProps(); renderStatus();
  });

  document.addEventListener('keydown', (e) => {
    if (!$('tab-builder').classList.contains('active') || document.querySelector('dialog[open]')) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    const sel = state.selected;
    if (e.ctrlKey || e.metaKey) {
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); } else if (k === 'y') { e.preventDefault(); redo(); } else if (k === 's') { e.preventDefault(); saveSpool(); }
      return;
    }
    if (k === 'p') addComponent('pipe');
    else if (k === '/' || k === 'f') { e.preventDefault(); $('partSearch').focus(); $('partSearch').select(); }
    else if (k === '[' && sel) insertAt(sel, 'before');
    else if (k === ']' && sel) insertAt(sel, 'after');
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
const libEditor = new LibraryEditor({
  library,
  parts,
  getType: type,
  onSaved: () => { renderPartList(); rebuild(); },
  openLibrary,
});

function showEngineProgress(done, total) {
  const el = $('engine');
  if (total) el.textContent = `Loading CAD engine… ${Math.round(done / 1e6)} / ${Math.round(total / 1e6)} MB`;
}

async function init() {
  try { recent = JSON.parse(localStorage.getItem('pipe-spool-tool.recent')) || []; } catch { recent = []; }
  library.addSamples(window.SPOOL_SAMPLES || {});
  renderSpec();
  wire();
  renderLibraryBar();
  try { if (await library.reconnect(false) === true) renderLibraryBar(); } catch { /* needs a click */ }
  renderPartList();
  const last = await kvGet('lastSpool');
  if (last?.nodes?.length) loadSpool(last); else rebuild();
  $('engine').hidden = false;
  startCad(showEngineProgress)
    .then(() => { $('engine').hidden = true; })
    .catch((e) => { $('engine').textContent = `CAD engine failed to load: ${e.message}. Check the internet connection and reload the page.`; $('engine').classList.add('bad'); });
}

init().catch((e) => toast(`Failed to start: ${e.message}`, true, 10000));
