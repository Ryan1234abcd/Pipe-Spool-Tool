// STEP library on the user's computer.
//
// The user picks their library folder. Where the browser supports it
// (Chrome / Edge: File System Access API) the folder is remembered and the port
// set-up of each part is written next to the STEP file as `<part>.stp.json`, so
// it travels with the library. Otherwise the folder is read through a normal
// folder picker and port set-ups are kept in this browser.

const STEP_RE = /\.(stp|step)$/i;

// ------------------------------------------------------------- IndexedDB
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('pipe-spool-tool', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('kv'); req.result.createObjectStore('mesh'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}
async function idb(store, mode, fn) {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const r = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(r?.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch { return undefined; }
}
export const kvGet = (k) => idb('kv', 'readonly', (s) => s.get(k));
export const kvSet = (k, v) => idb('kv', 'readwrite', (s) => s.put(v, k));
export const meshGet = (k) => idb('mesh', 'readonly', (s) => s.get(k));
export const meshSet = (k, v) => idb('mesh', 'readwrite', (s) => s.put(v, k));

// --------------------------------------------------------------- library
export class Library {
  constructor() {
    this.parts = new Map(); // id -> part
    this.folderName = null;
    this.writable = false;
    this.dirHandle = null;
  }

  get canPickDirectory() {
    try { return typeof window.showDirectoryPicker === 'function' && window.self === window.top; } catch { return false; }
  }

  /** Built-in sample parts: {path: {step: text, meta}} */
  addSamples(samples) {
    for (const [path, s] of Object.entries(samples)) {
      const id = `Samples/${path}`;
      this.parts.set(id, this._part(id, s.meta, { kind: 'sample', text: s.step }, s.step.length, 0));
    }
  }

  _part(id, meta, source, size, lastModified) {
    const folder = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '';
    const file = id.slice(id.lastIndexOf('/') + 1);
    return {
      id, file, source, size, lastModified,
      name: meta?.name || file.replace(STEP_RE, '').replace(/_/g, ' '),
      category: meta?.category || folder || 'Library',
      ports: meta?.ports || [],
      notes: meta?.notes || '',
      configured: !!meta?.ports?.length,
    };
  }

  /** Ask for a folder with the File System Access API. */
  async pickDirectory() {
    const handle = await window.showDirectoryPicker({ id: 'step-library', mode: 'readwrite' });
    await kvSet('libraryHandle', handle);
    await this.loadDirectory(handle);
  }

  /** Re-open the remembered folder (asks the browser for permission again if needed). */
  async reconnect(interactive) {
    const handle = await kvGet('libraryHandle');
    if (!handle) return false;
    let perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted' && interactive) perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      perm = await handle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') return handle.name; // known but needs a click
    }
    await this.loadDirectory(handle);
    return true;
  }

  async rememberedName() { return (await kvGet('libraryHandle'))?.name || null; }

  _clearUserParts() {
    for (const id of [...this.parts.keys()]) if (!id.startsWith('Samples/')) this.parts.delete(id);
  }

  async loadDirectory(handle) {
    this._clearUserParts();
    this.dirHandle = handle;
    this.folderName = handle.name;
    this.writable = (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
    const files = new Map();
    const walk = async (dir, prefix) => {
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'directory') { if (!name.startsWith('.')) await walk(h, `${prefix}${name}/`); }
        else files.set(`${prefix}${name}`, { handle: h, dir });
      }
    };
    await walk(handle, '');
    for (const [path, f] of files) {
      if (!STEP_RE.test(path)) continue;
      const file = await f.handle.getFile();
      const meta = await this._readSidecar(path, () => files.get(`${path}.json`)?.handle.getFile());
      this.parts.set(path, this._part(path, meta, { kind: 'handle', handle: f.handle, dir: f.dir }, file.size, file.lastModified));
    }
  }

  /** Fallback: files from <input type=file webkitdirectory>. */
  async loadFileList(fileList) {
    this._clearUserParts();
    this.dirHandle = null;
    this.writable = false;
    const files = new Map();
    for (const f of fileList) {
      const rel = (f.webkitRelativePath || f.name).split('/');
      if (rel.length > 1) { this.folderName = rel[0]; rel.shift(); }
      files.set(rel.join('/'), f);
    }
    for (const [path, f] of files) {
      if (!STEP_RE.test(path)) continue;
      const meta = await this._readSidecar(path, async () => files.get(`${path}.json`));
      this.parts.set(path, this._part(path, meta, { kind: 'file', file: f }, f.size, f.lastModified));
    }
  }

  async _readSidecar(path, getFile) {
    const local = await kvGet(`ports:${path}`); // set-up saved in this browser wins
    if (local) return local;
    try {
      const f = await getFile();
      return f ? JSON.parse(await f.text()) : null;
    } catch { return null; }
  }

  async bytes(id) {
    const p = this.parts.get(id);
    if (!p) throw new Error(`Part not in the library: ${id}`);
    const s = p.source;
    if (s.kind === 'sample') return new TextEncoder().encode(s.text);
    const file = s.kind === 'handle' ? await s.handle.getFile() : s.file;
    return new Uint8Array(await file.arrayBuffer());
  }

  cacheKey(id) {
    const p = this.parts.get(id);
    return p ? `${id}|${p.size}|${p.lastModified}` : id;
  }

  /** Save a part's name/category/ports. Returns where it was saved. */
  async savePart(id, meta) {
    const p = this.parts.get(id);
    const data = { name: meta.name, category: meta.category, notes: meta.notes || '', ports: meta.ports };
    Object.assign(p, data, { configured: data.ports.length > 0 });
    if (p.source.kind === 'handle' && this.writable) {
      try {
        const fh = await p.source.dir.getFileHandle(`${p.file}.json`, { create: true });
        const w = await fh.createWritable();
        await w.write(JSON.stringify(data, null, 2));
        await w.close();
        await idb('kv', 'readwrite', (s) => s.delete(`ports:${id}`));
        return 'folder';
      } catch { /* fall through to browser storage */ }
    }
    await kvSet(`ports:${id}`, data);
    return 'browser';
  }

  /** Port set-ups kept in this browser (for parts whose folder isn't writable). */
  browserSetups() {
    const out = {};
    for (const p of this.parts.values()) {
      if (p.configured && !p.id.startsWith('Samples/')) out[p.id] = { name: p.name, category: p.category, notes: p.notes, ports: p.ports };
    }
    return out;
  }

  list() { return [...this.parts.values()]; }
}
