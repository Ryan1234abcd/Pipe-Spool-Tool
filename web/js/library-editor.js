// Library setup tab: define the connection ports of STEP parts.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { Viewer } from './viewer.js';
import { api, toast, esc } from './api.js';
import { defaultUp } from './kinematics.js';

const KINDS = ['flange', 'weld', 'thread', 'socket', 'other'];
const same = (a, b, tol = 0.5) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

export class LibraryEditor {
  constructor({ getConfig, getStandard, partGeometry, onSaved }) {
    this.getConfig = getConfig;
    this.getStandard = getStandard;
    this.partGeometry = partGeometry;
    this.onSaved = onSaved;
    this.viewer = null;
    this.parts = [];
    this.current = null; // {meta, rows}
    this.$ = (id) => document.getElementById(id);
    this._wire();
  }

  setLibraryPath(p) { this.$('libPath').textContent = p; }

  _wire() {
    this.$('libRefresh').onclick = () => this.refresh();
    this.$('libSearch').oninput = () => this.renderList();
    this.$('libList').onclick = (e) => { const it = e.target.closest('[data-id]'); if (it) this.select(it.dataset.id); };
    this.$('libShowAll').onchange = () => { this.renderEditor(); this.drawMarkers(); };
    this.$('libFit').onclick = () => this.viewer?.fit();
    document.querySelectorAll('[data-lview]').forEach((b) => b.addEventListener('click', () => this.viewer?.setView(b.dataset.lview)));
    this.$('libUpload').onchange = async (e) => {
      const files = [...e.target.files];
      let last;
      for (const f of files) {
        try { last = await api.uploadPart(f); toast(`Added ${f.name}`); } catch (err) { toast(`${f.name}: ${err.message}`, true); }
      }
      e.target.value = '';
      await this.refresh();
      await this.onSaved();
      if (last) this.select(last.id);
    };
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

  async refresh() {
    this.parts = await api.library();
    this.renderList();
  }

  renderList() {
    const q = this.$('libSearch').value.toLowerCase();
    this.$('libList').innerHTML = this.parts
      .filter((p) => !q || `${p.name} ${p.id}`.toLowerCase().includes(q))
      .map((p) => `<div class="item ${this.current?.meta.id === p.id ? 'sel' : ''}" data-id="${esc(p.id)}" title="${esc(p.id)}">
          ${esc(p.name)}<span class="meta">${p.configured ? `<span class="badge ok">${p.ports.length} ports</span>` : '<span class="badge">set up</span>'}</span></div>`)
      .join('') || '<p class="hint">No STEP files found. Use “Add STEP files…” or copy .stp files into the library folder and press Refresh.</p>';
  }

  async select(id) {
    if (!this.viewer) await this.show();
    if (!this.parts.length) await this.refresh();
    const meta = this.parts.find((p) => p.id === id);
    if (!meta) return;
    this.current = { meta: { ...meta }, rows: [] };
    this.renderList();
    this.$('libStatus').textContent = 'Loading model…';
    this.$('libEditor').innerHTML = '<p class="hint">Loading…</p>';
    try {
      const geom = await this.partGeometry(id);
      if (this.current?.meta.id !== id) return;
      this.viewer.clear();
      const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
        color: 0xd38a3a, metalness: 0.2, roughness: 0.6, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide,
      }));
      this.viewer.content.add(mesh);
      this.mesh = mesh;
      this.viewer.fit(mesh, 1.3);
      this.$('libStatus').textContent = 'Detecting connection points…';
      const cands = await api.partDetect(id, this.getStandard());
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
        name: '', origin: c.origin, dir: c.dir, up: c.up, size: c.size, kind: 'flange',
        diameters: c.diameters, likely: c.likely, use: !configured && c.likely,
      });
    }
    // weld ends usually show the pipe OD as the largest circle
    for (const r of rows) {
      if (r.saved || !r.size || !r.diameters) continue;
      const od = this.getConfig().standards[this.getStandard()]?.sizes[r.size]?.od;
      if (od && Math.abs(r.diameters[0] - od) < 1.5) r.kind = 'weld';
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
    const sizes = this.getConfig().sizes;
    const fmt = (v) => v.map((x) => Math.round(x * 10) / 10).join(', ');
    const rowHtml = rows.map((r, i) => {
      if (!showAll && !r.use && !r.likely) return '';
      return `<tr data-row="${i}" class="${r.use ? 'sel' : ''}">
        <td><input type="checkbox" data-f="use" ${r.use ? 'checked' : ''}></td>
        <td><input type="text" data-f="name" value="${esc(r.use ? r.name : '')}" ${r.use ? '' : 'disabled'}></td>
        <td><select data-f="size"><option value="">—</option>${sizes.map((s) => `<option ${s === r.size ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
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
      <p class="hint">Green arrows = ports used by the spool builder. Arrows must point <b>out</b> of the part.
        Click an arrow in the view or tick a row to toggle it. The port sits on the connecting face (flange face or weld end).</p>
      <table class="ports"><tr><th></th><th>Name</th><th>Size</th><th>Type</th><th></th><th>Position</th></tr>${rowHtml}</table>
      <details style="margin-top:6px"><summary>Add a port manually</summary>
        <div class="hint">Local coordinates of the STEP file (mm) and the outward direction.</div>
        <label>Origin x,y,z <input id="lpManO" value="0, 0, 0"></label>
        <label>Direction x,y,z <input id="lpManD" value="1, 0, 0"></label>
        <button id="lpManAdd">Add port</button>
      </details>
      <div class="row" style="margin-top:10px"><span class="grow"></span><button id="lpSave" class="primary">Save part</button></div>`;

    el.querySelectorAll('tr[data-row]').forEach((tr) => {
      const r = rows[Number(tr.dataset.row)];
      tr.querySelectorAll('[data-f]').forEach((inp) => {
        const f = inp.dataset.f;
        const ev = f === 'flip' ? 'click' : 'change';
        inp.addEventListener(ev, () => {
          if (f === 'use') { r.use = inp.checked; this.renumber(); }
          else if (f === 'name') { r.name = inp.value.trim(); r.auto = false; this.renumber(); }
          else if (f === 'size') r.size = inp.value || null;
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
      rows.push({ name: '', origin: o, dir: d, up: defaultUp(d), size: null, kind: 'flange', use: true, likely: true });
      this.renumber();
      this.renderEditor();
      this.drawMarkers();
    };
    this.$('lpSave').onclick = () => this.save();
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
        el.textContent = `${r.name}${r.size ? ` ${r.size}` : ''}`;
        const lbl = new CSS2DObject(el);
        lbl.position.copy(origin).add(dir.clone().multiplyScalar(L * 1.25));
        this.markers.add(lbl);
      }
    });
    this.viewer.content.add(this.markers);
    this.viewer.render();
  }

  async save() {
    const { meta, rows } = this.current;
    const used = rows.filter((r) => r.use);
    if (!used.length) { toast('Tick at least one port', true); return; }
    const names = used.map((r) => r.name);
    if (names.some((n) => !n) || new Set(names).size !== names.length) { toast('Port names must be unique and not empty', true); return; }
    if (used.some((r) => !r.size) && !confirm('Some ports have no size. Size checks will be skipped for them. Save anyway?')) return;
    try {
      const saved = await api.savePart(meta.id, {
        name: meta.name, category: meta.category, notes: meta.notes,
        ports: used.map((r) => ({ name: r.name, origin: r.origin, dir: r.dir, up: r.up, size: r.size, kind: r.kind })),
      });
      toast(`Saved ${saved.name}`);
      await this.refresh();
      this.current.meta = { ...saved };
      rows.forEach((r) => { r.saved = r.use; });
      await this.onSaved();
    } catch (e) { toast(`Save failed: ${e.message}`, true); }
  }
}
