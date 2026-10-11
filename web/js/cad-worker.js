// Web Worker hosting the OpenCascade kernel. The build inlines the
// replicad-opencascadejs glue (global `Module`) ahead of this file.
import { Cad } from './cad.js';
import { wrapPart, visibleSolids, boreFillers } from './wrap.js';

let cad = null;
const shapes = new Map(); // part key -> TopoDS_Shape
const wrapped = new Map(); // part key|level|res -> simplified shape
let lastExport = null; // shape of the last build, for download / preview

function errText(err) {
  if (typeof err === 'number') return 'The CAD kernel could not process this geometry';
  return err?.message || String(err);
}

/** The shape exported for a part at a level of detail. */
function partShape(it, level, res, warnings) {
  let shape = shapes.get(it.key);
  if (!shape) throw new Error(`Part not loaded: ${it.key}`);
  if (it.closed && it.turn?.length && it.stem) { // handle turned to closed
    const ck = `${it.key}|closed`;
    if (!shapes.has(ck)) shapes.set(ck, cad.turnHandle(shape, it.turn, it.stem.o, it.stem.d, 90));
    shape = shapes.get(ck);
  }
  if (level === 'full' || !it.geom) return shape;
  const k = `${it.key}|${it.closed ? 'closed|' : ''}${level}|${res}`;
  if (!wrapped.has(k)) {
    try {
      let out = null;
      if (level === 'wrap') {
        // the part's own outer surfaces, bores and small holes filled, hidden pieces dropped
        const solids = cad.solids(shape);
        const keep = visibleSolids(solids.map((so) => cad.mesh(so)));
        // bolt holes go whatever the resolution
        const bolt = Math.max(0, ...(it.ends || []).map((e) => (e.bolt_hole_mm ? e.bolt_hole_mm / 2 + 1 : /flange|wafer|lugged/.test(e.end || '') ? 0.08 * (e.flange_od_mm || 150) : 0)));
        out = cad.shrinkWrap(shape, keep, boreFillers(it.geom, it.ends, it.info), res, bolt);
      }
      if (!out) out = cad.buildPrimitives(wrapPart(cad.mesh(shape), it.geom, { ods: it.ods }, level === 'wrap' ? 'wrap' : 'envelope', res));
      wrapped.set(k, out);
    } catch (e) {
      warnings.push(`${it.name || 'A part'} could not be simplified (${errText(e)}), so its full model is used.`);
      wrapped.set(k, shape);
    }
  }
  return wrapped.get(k);
}

const handlers = {
  async init({ wasm }) {
    // eslint-disable-next-line no-undef
    const oc = await Module({ wasmBinary: wasm, locateFile: (f) => f, print: () => {}, printErr: () => {} });
    cad = new Cad(oc);
    return {};
  },

  /** Read a part. With `turn` (handle solids), the handle is meshed separately so it can be shown turned. */
  load({ key, bytes, turn = null }) {
    const shape = shapes.get(key) || cad.readStep(bytes);
    shapes.set(key, shape);
    if (!turn?.length) {
      const mesh = cad.mesh(shape);
      return { result: { mesh }, transfer: [mesh.positions.buffer, mesh.indices.buffer] };
    }
    cad.mesh(shape);
    const solids = cad.solids(shape);
    const mesh = cad.mesh(cad.compound(solids.filter((_, i) => !turn.includes(i))));
    const turnMesh = cad.mesh(cad.compound(solids.filter((_, i) => turn.includes(i))));
    return { result: { mesh, turnMesh }, transfer: [mesh.positions.buffer, mesh.indices.buffer, turnMesh.positions.buffer, turnMesh.indices.buffer] };
  },

  has({ key }) { return { result: shapes.has(key) }; },

  /**
   * Build the spool. items: [{kind:'pipe', od, id, length, matrix} | {kind:'part', key, matrix, geom, ods, name}]
   * level: 'envelope' | 'wrap' | 'full'; res: shrink-wrap step (mm).
   * Returns stats and a display mesh; the STEP bytes come from writeStep().
   */
  build({ items, level = 'wrap', res = 5, hollow = false, fuse = true, runs = 1 }) {
    const warnings = [];
    const placed = items.map((it) => {
      const shape = it.kind === 'pipe' ? cad.makePipe(it.od, level === 'full' && hollow ? it.id : 0, it.length) : partShape(it, level, res, warnings);
      return cad.place(it.kind === 'pipe' ? shape : cad.copy(shape), it.matrix); // keep the cached part clean
    });
    if (!placed.length) throw new Error('The spool is empty');
    let result = null;
    if (fuse && placed.length > 1) {
      try {
        const f = cad.fuse(placed);
        if (f.ok) result = f.shape;
        else {
          // merge one solid at a time; a piece that won't merge stays separate
          const pieces = placed.flatMap((x) => cad.solids(x)).sort((a, b) => cad.volume(b) - cad.volume(a));
          let acc = pieces[0];
          const apart = [];
          for (const piece of pieces.slice(1)) {
            let g = null;
            try { g = cad.fuse([cad.copy(acc), piece]); } catch { g = null; } // a failed merge can spoil its inputs
            if (g?.ok) acc = g.shape; else apart.push(piece);
          }
          result = apart.length ? cad.compound([acc, ...apart]) : acc;
          if (apart.length) warnings.push(`${apart.length} piece${apart.length === 1 ? '' : 's'} could not be merged and ${apart.length === 1 ? 'is' : 'are'} kept as separate bodies in the file.`);
        }
      } catch (e) {
        warnings.push(`Merging failed (${errText(e)}); the parts are exported as separate bodies in one file.`);
      }
    }
    if (!result) result = placed.length === 1 ? placed[0] : cad.compound(placed);
    const solids = cad.count(result);
    if (fuse && solids > runs && !warnings.length) { // separate lines are separate solids
      warnings.push(level === 'full'
        ? `${solids} separate bodies: manufacturer models are often several bodies (handles, bolts) that don't merge.`
        : `The spool is ${solids} separate solids: some parts don't touch.`);
    }
    lastExport = result;
    const mesh = cad.mesh(result);
    const faces = cad.count(result, 'TopAbs_FACE');
    return { result: { warnings, solids, faces, mesh }, transfer: [mesh.positions.buffer, mesh.indices.buffer] };
  },

  /** STEP bytes of the last build. */
  writeStep({ name }) {
    if (!lastExport) throw new Error('Nothing built yet');
    const bytes = cad.writeStep(lastExport, name);
    return { result: { bytes }, transfer: [bytes.buffer] };
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
