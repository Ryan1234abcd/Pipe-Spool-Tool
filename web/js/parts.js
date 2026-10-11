// Loads library parts: display mesh, cached in IndexedDB so a part is only
// parsed by the CAD kernel once per file version.
import { geometryFromMesh } from './viewer.js';
import { cad } from './cad-client.js';
import { meshGet, meshSet } from './library.js';

export function createPartLoader(library) {
  const cache = new Map(); // cache key -> Promise<{geometry, mesh}>
  return {
    get(id) {
      const key = library.cacheKey(id);
      const turn = library.parts.get(id)?.turn || null;
      const mkey = turn ? `${key}|turn${turn.join('.')}` : key; // valves: handle drawn separately
      if (!cache.has(mkey)) {
        const p = (async () => {
          let d = await meshGet(mkey);
          if (!d) {
            d = await cad.load(key, await library.bytes(id), turn);
            meshSet(mkey, d);
          }
          return { ...d, geometry: geometryFromMesh(d.mesh), turnGeometry: d.turnMesh ? geometryFromMesh(d.turnMesh) : null };
        })();
        p.catch(() => cache.delete(mkey));
        cache.set(mkey, p);
      }
      return cache.get(mkey);
    },
    /** Make sure the exact B-rep shape is loaded in the CAD kernel (for export). */
    async ensureKernel(id) {
      const key = library.cacheKey(id);
      if (!(await cad.has(key))) await cad.load(key, await library.bytes(id));
      return key;
    },
  };
}
