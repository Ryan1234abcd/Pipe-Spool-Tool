// Library setup tab: define the connection ports of STEP parts.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { Viewer } from './viewer.js';
import { toast, esc, ask, saveFile } from './ui.js';
import { defaultUp } from './kinematics.js';
import { detectPorts } from './detect.js';
import { PIPE_TYPES, sizeForOd } from './pipe-types.js';

const KINDS = ['weld', 'press', 'flange', 'thread', 'socket', 'solvent', 'other'];
const same = (a, b, tol = 0.5) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

export class LibraryEditor {
  constructor({ library, parts, getType, onSaved, openLibrary }) {
    this.library = library;
    this.loader = parts;
    this.getType = getType;
    this.onSaved = onSaved;
    this.openLibrary = openLibrary;
    this.viewer = null;
    this.parts = [];
    this.current = null; // {meta, rows}
    this.$ = (id) => document.getElementById(id);
    this._wire();
  }

  _wire() {
    this.$('libOpen').onclick = () => this.openLibrary();
    this.$('libSearch').oninput = () => this.renderList();
    this.$('libList').onclick = (e) => { const it = e.target.closest('[data-id]'); if (it) this.select(it.dataset.id); };
    this.$('libShowAll').onchange = () => { this.renderEditor(); this.drawMarkers(); };
    this.$('libFit').onclick = () => this.viewer?.fit();
    document.querySelectorAll('[data-lview]').forEach((b) => b.addEventListener('click', () => this.viewer?.setView(b.dataset.lview)));
  }

  async show() {
    if (!this.viewer) {
      this.viewer = new Viewer(this.$('libViewport'));
      const canvas = this.viewer.renderer.domElement;
      let down;
      canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
      canvas.addEventListener('pointerup', (e) => {
        if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
        const hit = this.viewer.pick(e, this.markers?.children || []).find((h) => h.object.userData.row !== undefined);
        if (hit) { const r = this.current.rows[hit.object.userData.row]; r.use = !r.use; this.renumber(); this.renderEditor(); this.drawMarkers(); }
      });
    }
    this.viewer.resize();
    await this.refresh();
  }

  refresh() {
    this.parts = this.library.list().sort((a, b) => a.id.localeCompare(b.id));
    this.$('libPath').textContent = this.library.folderName
      ? `${this.library.folderName} – ${this.library.writable ? 'set-ups are saved as .stp.json files next to each STEP file' : 'set-ups are saved in this browser'}`
      : 'Showing the built-in samples. Open your STEP library folder to set up your own parts.';
    this.renderList();
  }

  renderList() {
    const q = this.$('libSearch').value.toLowerCase();
    this.$('libList').innerHTML = this.parts
      .filter((p) => !q || `${p.name} ${p.id}`.toLowerCase().includes(q))
      .map((p) => `<div class="item ${this.current?.meta.id === p.id ? 'sel' : ''}" data-id="${esc(p.id)}" title="${esc(p.id)}">
          ${esc(p.name)}<span class="meta">${p.configured ? `<span class="badge ok">${p.ports.length} ports</span>` : '<span class="badge">set up</span>'}</span></div>`)
      .join('') || '<p class="hint">No STEP files found in this folder.</p>';
  }

  async select(id) {
    if (!this.viewer) await this.show();
    if (!this.parts.length) this.refresh();
    const meta = this.parts.find((p) => p.id === id);
    if (!meta) return;
    this.current = { meta: { ...meta }, rows: [] };
    this.renderList();
    this.$('libStatus').textContent = 'Reading the STEP file…';
    this.$('libEditor').innerHTML = '<p class="hint">Loading…</p>';
    try {
      const data = await this.loader.get(id);
      const geom = data.geometry;
      if (this.current?.meta.id !== id) return;
      this.viewer.clear();
      const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
        color: 0xd38a3a, metalness: 0.2, roughness: 0.6, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide,
      }));
      this.viewer.content.add(mesh);
      this.mesh = mesh;
      this.viewer.fit(mesh, 1.3);
      this.$('libStatus').textContent = 'Detecting connection points…';
      const cands = detectPorts(data.circles, data.mesh, this.getType());
      if (this.current?.meta.id !== id) return;
      this.current.rows = this.mergeRows(meta.ports, cands);
      this.renumber();
      this.$('libStatus').textContent = `${cands.length} circular end candidates found. Tick the real connections, check sizes, then Save.`;
    } catch (e) {
      this.$('libStatus').textContent = `Failed: ${e.message}`;
    }
    this.renderEditor();
    this.drawMarkers();
  }

  mergeRows(ports, cands) {
    const rows = ports.map((p) => ({ ...p, use: true, likely: true, saved: true }));
    const configured = ports.length > 0;
    for (const c of cands) {
      const match = rows.find((r) => same(r.origin, c.origin));
      if (match) { match.diameters = c.diameters; continue; }
      rows.push({
        name: '', origin: c.origin, dir: c.dir, up: c.up, od: c.od, kind: 'flange',
        diameters: c.diameters, likely: c.likely, use: !configured && c.likely,
      });
    }
    // pre-tick only connections sized for the current pipe type when there are at least two of them
    if (!configured) {
      const typed = rows.filter((r) => r.use && r.od && sizeForOd(this.getType(), r.od));
      if (typed.length >= 2) for (const r of rows) if (r.use && !typed.includes(r)) r.use = false;
    }
    // weld ends usually show the pipe OD as the largest circle
    for (const r of rows) {
      if (r.saved || !r.od || !r.diameters) continue;
      if (Math.abs(r.diameters[0] - r.od) < 1.5) r.kind = 'weld';
    }
    return rows;
  }

  renumber() {
    // used ports get A, B, C… in list order, unless the user named them
    const rows = this.current.rows;
    for (const r of rows) if (r.auto || !r.use) { if (r.auto || !r.saved) r.name = ''; r.auto = false; }
    const taken = new Set(rows.filter((r) => r.use && r.name).map((r) => r.name));
    let i = 0;
    for (const r of rows) {
      if (!r.use || r.name) continue;
      while (taken.has(String.fromCharCode(65 + i))) i++;
      r.name = String.fromCharCode(65 + i);
      r.auto = true;
      taken.add(r.name);
    }
  }

  renderEditor() {
    const el = this.$('libEditor');
    if (!this.current) { el.innerHTML = '<p class="hint">No part selected.</p>'; return; }
    const { meta, rows } = this.current;
    const showAll = this.$('libShowAll').checked;
    const odOptions = (od) => {
      const known = PIPE_TYPES.some((t) => t.sizes.some((x) => x.od === od));
      let picked = false;
      const sel = (x) => { if (picked || x.od !== od) return ''; picked = true; return 'selected'; };
      return `<option value="">—</option>${od && !known ? `<option value="${od}" selected>Ø${od}</option>` : ''}${
        [this.getType(), ...PIPE_TYPES.filter((t) => t !== this.getType())].map((t) => `<optgroup label="${esc(t.name)}">${
          t.sizes.map((x) => `<option value="${x.od}" ${sel(x)}>${esc(x.label)} · Ø${x.od}</option>`).join('')}</optgroup>`).join('')}`;
    };
    const fmt = (v) => v.map((x) => Math.round(x * 10) / 10).join(', ');
    const rowHtml = rows.map((r, i) => {
      if (!showAll && !r.use && !r.likely) return '';
      return `<tr data-row="${i}" class="${r.use ? 'sel' : ''}">
        <td><input type="checkbox" data-f="use" ${r.use ? 'checked' : ''}></td>
        <td><input type="text" data-f="name" value="${esc(r.use ? r.name : '')}" ${r.use ? '' : 'disabled'}></td>
        <td><select data-f="od" title="Pipe that connects here">${odOptions(r.od)}</select></td>
        <td><select data-f="kind">${KINDS.map((k) => `<option ${k === r.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></td>
        <td><button data-f="flip" title="Reverse the outward direction">⇄</button></td>
        <td class="xyz">@ ${fmt(r.origin)}<br>→ ${fmt(r.dir)}${r.diameters ? `<br>Ø ${r.diameters.map((d) => Math.round(d * 10) / 10).join(' / ')}` : ''}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `
      <h3>Part</h3>
      <div class="hint">${esc(meta.id)}</div>
      <label>Name <input id="lpName" value="${esc(meta.name)}" style="width:260px"></label>
      <label>Category <input id="lpCat" value="${esc(meta.category)}" placeholder="e.g. Valves" style="width:220px"></label>
      <h3 style="margin-top:10px">Connection ports</h3>
      <p class="hint">Green arrows are the connections the spool builder uses. Arrows must point <b>out</b> of the part.
        Click an arrow in the view or tick a row to toggle it. A connection sits on the joint face (pipe end, weld end, press socket stop or flange face);
        “Pipe size” is the pipe that joins there.</p>
      <table class="ports"><tr><th></th><th>Name</th><th>Pipe size</th><th>Type</th><th></th><th>Position</th></tr>${rowHtml}</table>
      <details style="margin-top:6px"><summary>Add a port manually</summary>
        <div class="hint">Local coordinates of the STEP file (mm) and the outward direction.</div>
        <label>Origin x,y,z <input id="lpManO" value="0, 0, 0"></label>
        <label>Direction x,y,z <input id="lpManD" value="1, 0, 0"></label>
        <button id="lpManAdd">Add port</button>
      </details>
      <div class="row" style="margin-top:10px">
        ${meta.id.startsWith('Samples/') ? '' : '<button id="lpDownload" title="Save the set-up as a .stp.json file to put next to the STEP file">Download set-up file</button>'}
        <span class="grow"></span><button id="lpSave" class="primary">Save part</button></div>`;

    el.querySelectorAll('tr[data-row]').forEach((tr) => {
      const r = rows[Number(tr.dataset.row)];
      tr.querySelectorAll('[data-f]').forEach((inp) => {
        const f = inp.dataset.f;
        const ev = f === 'flip' ? 'click' : 'change';
        inp.addEventListener(ev, () => {
          if (f === 'use') { r.use = inp.checked; this.renumber(); }
          else if (f === 'name') { r.name = inp.value.trim(); r.auto = false; this.renumber(); }
          else if (f === 'od') r.od = inp.value ? Number(inp.value) : null;
          else if (f === 'kind') r.kind = inp.value;
          else if (f === 'flip') { r.dir = r.dir.map((x) => -x); r.up = defaultUp(r.dir); }
          this.renderEditor();
          this.drawMarkers();
        });
      });
    });
    this.$('lpName').onchange = (e) => { meta.name = e.target.value; };
    this.$('lpCat').onchange = (e) => { meta.category = e.target.value; };
    this.$('lpManAdd').onclick = () => {
      const o = this.$('lpManO').value.split(',').map(Number);
      const d = this.$('lpManD').value.split(',').map(Number);
      if (o.length !== 3 || d.length !== 3 || [...o, ...d].some(Number.isNaN) || d.every((x) => x === 0)) { toast('Enter three numbers for origin and direction', true); return; }
      rows.push({ name: '', origin: o, dir: d, up: defaultUp(d), od: null, kind: 'weld', use: true, likely: true });
      this.renumber();
      this.renderEditor();
      this.drawMarkers();
    };
    this.$('lpSave').onclick = () => this.save();
    if (this.$('lpDownload')) {
      this.$('lpDownload').onclick = async () => {
        const data = { name: meta.name, category: meta.category, ports: this.usedPorts() };
        try { await saveFile(`${meta.file}.json`, JSON.stringify(data, null, 2), 'application/json'); } catch (e) { toast(e.message, true); }
      };
    }
  }

  drawMarkers() {
    if (!this.viewer || !this.current) return;
    if (this.markers) {
      this.viewer.content.remove(this.markers);
      this.markers.traverse((o) => { if (o.isCSS2DObject) o.element.remove(); });
    }
    this.markers = new THREE.Group();
    const showAll = this.$('libShowAll').checked;
    const box = this.mesh ? new THREE.Box3().setFromObject(this.mesh) : null;
    const scaleLen = box ? box.getSize(new THREE.Vector3()).length() * 0.12 : 50;
    this.current.rows.forEach((r, i) => {
      if (!showAll && !r.use && !r.likely) return;
      const color = r.use ? 0x23a455 : 0x8a96a3;
      const L = Math.max(scaleLen, (r.diameters?.[0] || 40) * 0.8);
      const dir = new THREE.Vector3(...r.dir).normalize();
      const origin = new THREE.Vector3(...r.origin);
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(L * 0.04, L * 0.04, L, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
      shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      shaft.position.copy(origin).add(dir.clone().multiplyScalar(L / 2));
      const head = new THREE.Mesh(new THREE.ConeGeometry(L * 0.12, L * 0.3, 16), new THREE.MeshBasicMaterial({ color, depthTest: false }));
      head.quaternion.copy(shaft.quaternion);
      head.position.copy(origin).add(dir.clone().multiplyScalar(L));
      const dot = new THREE.Mesh(new THREE.SphereGeometry(L * 0.09, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
      dot.position.copy(origin);
      for (const m of [shaft, head, dot]) { m.renderOrder = 10; m.userData.row = i; this.markers.add(m); }
      if (r.use) {
        const el = document.createElement('div');
        el.className = 'port-label';
        const sz = r.od ? sizeForOd(this.getType(), r.od)?.label || `Ø${r.od}` : '';
        el.textContent = `${r.name}${sz ? ` ${sz}` : ''}`;
        const lbl = new CSS2DObject(el);
        lbl.position.copy(origin).add(dir.clone().multiplyScalar(L * 1.25));
        this.markers.add(lbl);
      }
    });
    this.viewer.content.add(this.markers);
    this.viewer.render();
  }

  usedPorts() {
    return this.current.rows.filter((r) => r.use)
      .map((r) => ({ name: r.name, origin: r.origin, dir: r.dir, up: r.up, od: r.od || null, kind: r.kind }));
  }

  async save() {
    const { meta, rows } = this.current;
    const used = rows.filter((r) => r.use);
    if (!used.length) { toast('Tick at least one connection', true); return; }
    const names = used.map((r) => r.name);
    if (names.some((n) => !n) || new Set(names).size !== names.length) { toast('Connection names must be unique and not empty', true); return; }
    if (used.some((r) => !r.od) && !await ask('Some connections have no pipe size, so size checks are skipped for them. Save anyway?', { ok: 'Save' })) return;
    try {
      const where = await this.library.savePart(meta.id, { name: meta.name, category: meta.category, notes: meta.notes, ports: this.usedPorts() });
      toast(where === 'folder' ? `Saved ${meta.name} (${meta.file}.json in your library folder)` : `Saved ${meta.name} in this browser`);
      rows.forEach((r) => { r.saved = r.use; });
      this.refresh();
      await this.onSaved();
    } catch (e) { toast(`Save failed: ${e.message}`, true); }
  }
}
