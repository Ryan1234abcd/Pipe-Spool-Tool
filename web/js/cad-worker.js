// Web Worker hosting the OpenCascade kernel. The build inlines the
// replicad-opencascadejs glue (global `Module`) ahead of this file.
import { Cad } from './cad.js';

let cad = null;
const shapes = new Map(); // part key -> TopoDS_Shape

function errText(err) {
  if (typeof err === 'number') return 'The CAD kernel could not process this geometry';
  return err?.message || String(err);
}

const handlers = {
  async init({ wasm }) {
    // eslint-disable-next-line no-undef
    const oc = await Module({ wasmBinary: wasm, locateFile: (f) => f, print: () => {}, printErr: () => {} });
    cad = new Cad(oc);
    return {};
  },

  load({ key, bytes }) {
    const shape = cad.readStep(bytes);
    shapes.set(key, shape);
    const mesh = cad.mesh(shape);
    return { result: { mesh, circles: cad.circles(shape) }, transfer: [mesh.positions.buffer, mesh.indices.buffer] };
  },

  has({ key }) { return { result: shapes.has(key) }; },

  /** items: [{kind:'pipe', od, id, length, matrix} | {kind:'part', key, matrix}] */
  export({ name, items, fuse = true }) {
    const warnings = [];
    const placed = items.map((it) => {
      let shape;
      if (it.kind === 'pipe') shape = cad.makePipe(it.od, it.id, it.length);
      else {
        shape = shapes.get(it.key);
        if (!shape) throw new Error(`Part not loaded: ${it.key}`);
      }
      return cad.place(shape, it.matrix);
    });
    if (!placed.length) throw new Error('The spool is empty');
    let result = null;
    if (fuse && placed.length > 1) {
      try {
        const f = cad.fuse(placed);
        if (f.ok) result = f.shape;
        else warnings.push('The parts could not be merged into one solid, so they are exported as separate bodies in one file.');
      } catch (e) {
        warnings.push(`Merging failed (${errText(e)}); the parts are exported as separate bodies in one file.`);
      }
    }
    if (!result) result = placed.length === 1 ? placed[0] : cad.compound(placed);
    const solids = cad.count(result);
    if (fuse && result && solids > 1 && !warnings.length) {
      warnings.push(`The spool is ${solids} separate solids: some parts don't touch (check gaps, or the STEP parts themselves).`);
    }
    const bytes = cad.writeStep(result, name);
    return { result: { bytes, warnings, solids }, transfer: [bytes.buffer] };
  },
};

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    const out = (await handlers[op](args)) || {};
    self.postMessage({ id, ok: true, result: out.result }, out.transfer || []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: errText(err) });
  }
};
