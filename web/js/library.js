// Part library: the user's Part-Library folder (library.json + geometry.json +
// models/…), or the small demo set built into the page.
//
// Where the browser supports it (Chrome / Edge: File System Access API) the
// folder is remembered between visits. Otherwise it is read through a normal
// folder picker each time. STEP files are only read when a part is used.
import { endFamily } from './joints.js';

// ------------------------------------------------------------- IndexedDB
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('pipe-spool-tool', 2);
      req.onupgradeneeded = () => {
        for (const s of ['kv', 'mesh']) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      };
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

/** Short name for a part: its type and size, e.g. "90° Elbow (long radius) 50NB". */
export function partName(p) {
  return `${p.type_name || p.type} ${p.size_label || ''}`.trim();
}

// --------------------------------------------------------------- library
export class Library {
  constructor() {
    this.parts = new Map(); // id -> part (library.json entry + geom + ports)
    this.systems = [];
    this.name = null;
    this.source = null; // 'demo' | 'folder'
    this._files = null; // fallback: path -> File
    this.dirHandle = null;
  }

  get canPickDirectory() {
    try { return typeof window.showDirectoryPicker === 'function' && window.self === window.top; } catch { return false; }
  }

  /** Build the part map from library.json + geometry.json contents. */
  _index(lib, geometry, name, source) {
    this.parts.clear();
    this.systems = lib.systems || [];
    this.name = name;
    this.source = source;
    const geo = geometry?.parts || {};
    for (const [id, p] of Object.entries(lib.parts || {})) {
      const g = geo[id];
      if (!g || g.ends.length !== p.ends.length) continue; // no end positions: can't be placed
      const ports = p.ends.map((e, i) => ({
        name: String(i),
        origin: g.ends[i].o,
        dir: g.ends[i].d,
        up: g.ends[i].u,
        od: e.od_mm,
        wall: e.wall_mm,
        label: e.label,
        end: e.end,
        family: endFamily(e.end),
        flange: e.flange_od_mm || null,
        engage: g.ends[i].engage || 0,
        thread: e.thread || null,
      }));
      this.parts.set(id, { ...p, id, ports, centre: g.c, bbox: g.bbox, name: partName(p) });
    }
  }

  /** The demo parts built into the page: {library, geometry, files: {path: text}} */
  loadDemo(demo) {
    this._demo = demo;
    this._index(demo.library, demo.geometry, 'Demo parts', 'demo');
  }

  /** Ask for the Part-Library folder with the File System Access API. */
  async pickDirectory() {
    const handle = await window.showDirectoryPicker({ id: 'part-library', mode: 'read' });
    await this.loadDirectory(handle);
    await kvSet('libraryHandle', handle);
  }

  /** Re-open the remembered folder (asks for permission again if needed). */
  async reconnect(interactive) {
    const handle = await kvGet('libraryHandle');
    if (!handle) return false;
    let perm = await handle.queryPermission({ mode: 'read' });
    if (perm !== 'granted' && interactive) perm = await handle.requestPermission({ mode: 'read' });
    if (perm !== 'granted') return handle.name; // known but needs a click
    await this.loadDirectory(handle);
    return true;
  }

  async rememberedName() { return (await kvGet('libraryHandle'))?.name || null; }

  async loadDirectory(handle) {
    const readJson = async (name) => {
      try { return JSON.parse(await (await (await handle.getFileHandle(name)).getFile()).text()); } catch { return null; }
    };
    const lib = await readJson('library.json');
    if (!lib?.parts) throw new Error(`“${handle.name}” has no library.json – choose the Part-Library folder.`);
    const geometry = await readJson('geometry.json');
    if (!geometry) throw new Error(`“${handle.name}” has no geometry.json – update your copy of Part-Library.`);
    this.dirHandle = handle;
    this._files = null;
    this._index(lib, geometry, handle.name, 'folder');
  }

  /** Fallback: files from <input type=file webkitdirectory>. */
  async loadFileList(fileList) {
    const files = new Map();
    let root = null;
    for (const f of fileList) {
      const rel = (f.webkitRelativePath || f.name).split('/');
      if (rel.length > 1) { root = rel[0]; rel.shift(); }
      files.set(rel.join('/'), f);
    }
    const json = async (name) => { const f = files.get(name); return f ? JSON.parse(await f.text()) : null; };
    const lib = await json('library.json');
    if (!lib?.parts) throw new Error('That folder has no library.json – choose the Part-Library folder.');
    const geometry = await json('geometry.json');
    if (!geometry) throw new Error('That folder has no geometry.json – update your copy of Part-Library.');
    this.dirHandle = null;
    this._files = files;
    this._index(lib, geometry, root || 'Part-Library', 'folder');
  }

  async bytes(id) {
    const p = this.parts.get(id);
    if (!p) throw new Error(`Part not in the library: ${id}`);
    const path = p.files.step;
    if (this.source === 'demo') return new TextEncoder().encode(this._demo.files[path]);
    if (this._files) {
      const f = this._files.get(path);
      if (!f) throw new Error(`Missing file ${path}`);
      return new Uint8Array(await f.arrayBuffer());
    }
    let dir = this.dirHandle;
    const segs = path.split('/');
    for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s);
    const file = await (await dir.getFileHandle(segs[segs.length - 1])).getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  cacheKey(id) {
    const p = this.parts.get(id);
    return `${id}|${p?.files?.step || ''}|v${p?.model_version || 1}`;
  }

  list() { return [...this.parts.values()]; }
}
