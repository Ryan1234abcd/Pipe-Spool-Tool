// Starts the CAD worker and loads the OpenCascade WebAssembly binary.
// The binary is fetched from files published next to the page (oc/…) when
// available, otherwise from the jsDelivr or unpkg CDN (cached by the browser).

export const OC_VERSION = '1.1.0';
const CDNS = [
  `https://cdn.jsdelivr.net/npm/replicad-opencascadejs@${OC_VERSION}/dist/replicad_single.wasm`,
  `https://unpkg.com/replicad-opencascadejs@${OC_VERSION}/dist/replicad_single.wasm`,
];

async function fetchWithProgress(url, onProgress, done = 0, total = 0) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const size = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !onProgress) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    chunks.push(value);
    got += value.length;
    onProgress(done + got, total || size);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function loadWasm(onProgress) {
  // 1. split copy published alongside the page
  try {
    const manifest = await (await fetch(new URL('oc/manifest.json', location.href))).json();
    const parts = [];
    let done = 0;
    for (const p of manifest.parts) {
      const bytes = await fetchWithProgress(new URL(`oc/${p}`, location.href), onProgress, done, manifest.size);
      parts.push(bytes);
      done += bytes.length;
    }
    const out = new Uint8Array(done);
    let o = 0;
    for (const b of parts) { out.set(b, o); o += b.length; }
    return out;
  } catch { /* not available: use a CDN */ }
  let last;
  for (const url of CDNS) {
    try { return await fetchWithProgress(url, onProgress); } catch (e) { last = e; }
  }
  throw new Error(`Could not download the CAD engine (${last?.message || 'network error'})`);
}

let worker = null;
let seq = 0;
const pending = new Map();

function call(op, args = {}, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, args }, transfer);
  });
}

let ready = null;
/** Start the kernel once. onProgress(bytesDone, bytesTotal) while downloading. */
export function startCad(onProgress) {
  if (ready) return ready;
  ready = (async () => {
    const src = window.CAD_WORKER_SRC;
    if (!src) throw new Error('CAD worker source missing (run the build)');
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result); else p.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'CAD worker failed')); pending.clear(); };
    const wasm = await loadWasm(onProgress);
    await call('init', { wasm: wasm.buffer }, [wasm.buffer]);
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

export const cad = {
  /** Read STEP bytes; returns {mesh}. The shape stays in the worker under `key`. */
  load: async (key, bytes, turn = null) => { await startCad(); const b = bytes.slice(); return call('load', { key, bytes: b, turn }, [b.buffer]); },
  has: async (key) => { await startCad(); return call('has', { key }); },
  /** Build the spool at a level of detail; returns {faces, solids, warnings, mesh}. */
  build: async (payload) => { await startCad(); return call('build', payload); },
  /** STEP bytes of the last build. */
  writeStep: async (payload) => { await startCad(); return call('writeStep', payload); },
};
