// Thin wrappers around the backend API.

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

export const api = {
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
