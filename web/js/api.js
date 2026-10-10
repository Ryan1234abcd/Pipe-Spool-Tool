// Thin wrappers around the backend API.
import { clientFitting } from './fittings-client.js';

async function handle(res) {
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res;
}

export const getJSON = async (url) => (await handle(await fetch(url))).json();

export const sendJSON = async (method, url, body) => (await handle(await fetch(url, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}))).json();

const serverApi = {
  config: () => getJSON('/api/config'),
  library: () => getJSON('/api/library'),
  partMesh: (id) => getJSON(`/api/library/mesh?id=${encodeURIComponent(id)}`),
  partDetect: (id, standard) => getJSON(`/api/library/detect?id=${encodeURIComponent(id)}&standard=${encodeURIComponent(standard || '')}`),
  savePart: (id, meta) => sendJSON('PUT', `/api/library/part?id=${encodeURIComponent(id)}`, meta),
  uploadPart: async (file) => (await handle(await fetch(`/api/library/upload?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST', body: file,
  }))).json(),
  fitting: (params) => sendJSON('POST', '/api/fitting', params),
  projects: () => getJSON('/api/projects'),
  loadProject: (name) => getJSON(`/api/projects/${encodeURIComponent(name)}`),
  saveProject: (name, data) => sendJSON('PUT', `/api/projects/${encodeURIComponent(name)}`, data),
  exportStep: async (payload) => handle(await fetch('/api/export', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })),
};

// Standalone build (scripts/build_standalone.py): everything runs in the page.
// Sample parts are baked in, fittings are drawn client side, spools are kept
// in this browser, and STEP export needs the local app.
const STATIC = typeof window !== 'undefined' ? window.SPOOL_STATIC : null;
export const isStatic = !!STATIC;
const PROJECT_KEY = 'pipe-spool-tool.projects';
const readProjects = () => { try { return JSON.parse(localStorage.getItem(PROJECT_KEY)) || {}; } catch { return {}; } };
const writeProjects = (p) => { try { localStorage.setItem(PROJECT_KEY, JSON.stringify(p)); } catch { /* storage blocked */ } };
const needsApp = () => Promise.reject(new Error('This needs the full app running on your PC (start.bat).'));

const staticApi = STATIC && {
  config: async () => STATIC.config,
  library: async () => STATIC.library.map((p) => ({ ...p })),
  partMesh: async (id) => STATIC.meshes[id],
  partDetect: async (id) => STATIC.detect[id] || [],
  savePart: async (id, meta) => {
    const p = STATIC.library.find((x) => x.id === id);
    Object.assign(p, { name: meta.name || p.name, category: meta.category ?? p.category, ports: meta.ports, configured: meta.ports.length > 0 });
    return { ...p };
  },
  uploadPart: needsApp,
  fitting: async (params) => clientFitting(params, STATIC.config),
  projects: async () => Object.keys(readProjects()).sort(),
  loadProject: async (name) => { const p = readProjects()[name]; if (!p) throw new Error('Spool not found'); return p; },
  saveProject: async (name, data) => { const p = readProjects(); p[name] = data; writeProjects(p); return { saved: name }; },
  exportStep: needsApp,
};

export const api = staticApi || serverApi;

export function download(filename, blobOrText, type = 'application/octet-stream') {
  const blob = blobOrText instanceof Blob ? blobOrText : new Blob([blobOrText], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

let toastTimer;
export function toast(msg, bad = false, ms = 3500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, ms);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** In-page replacement for confirm()/prompt(). Resolves to true/false, or the text (null on cancel). */
export function ask(message, { input = null, ok = 'OK', cancel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'ask';
    dlg.innerHTML = `<p>${esc(message)}</p>${input !== null ? `<input id="askInput" value="${esc(input)}">` : ''}
      <div class="row"><span class="grow"></span><button data-v="0">${esc(cancel)}</button><button data-v="1" class="primary">${esc(ok)}</button></div>`;
    document.body.appendChild(dlg);
    const field = dlg.querySelector('input');
    const done = (v) => { dlg.close(); dlg.remove(); resolve(input !== null ? (v ? field.value : null) : v); };
    dlg.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => done(b.dataset.v === '1')));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    if (field) field.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); });
    dlg.showModal();
    (field || dlg.querySelector('[data-v="1"]')).focus();
    if (field) field.select();
  });
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
