// Loads library parts: display mesh + circle data, cached in IndexedDB so a
// part is only parsed by the CAD kernel once per file version.
import { geometryFromMesh } from './viewer.js';
import { cad } from './cad-client.js';
import { meshGet, meshSet } from './library.js';

export function createPartLoader(library) {
  const cache = new Map(); // cache key -> Promise<{geometry, mesh, circles}>
  return {
    get(id) {
      const key = library.cacheKey(id);
      if (!cache.has(key)) {
        const p = (async () => {
          let d = await meshGet(key);
          if (!d) {
            d = await cad.load(key, await library.bytes(id));
            meshSet(key, d);
          }
          return { ...d, geometry: geometryFromMesh(d.mesh) };
        })();
        p.catch(() => cache.delete(key));
        cache.set(key, p);
      }
      return cache.get(key);
    },
    /** Make sure the exact B-rep shape is loaded in the CAD kernel (for export). */
    async ensureKernel(id) {
      const key = library.cacheKey(id);
      if (!(await cad.has(key))) await cad.load(key, await library.bytes(id));
      return key;
    },
  };
}
