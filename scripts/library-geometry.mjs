// Works out where every part's ends are in its STEP model, for Part-Library.
//
//   node scripts/library-geometry.mjs ../Part-Library [part ids…]
//
// Writes <library>/geometry.json: { id: { ends:[{o, d, u, engage?}], c } } in the
// model's own coordinates (mm), ends in the same order as library.json. Parts
// listed in <library>/geometry-overrides.json are taken from there instead.
// Prints the parts whose match looks doubtful so they can be checked.
import fs from 'node:fs';
import path from 'node:path';
import Module from 'replicad-opencascadejs';
import { Cad } from '../web/js/cad.js';
import { locateEnds } from './ends.mjs';

const dir = path.resolve(process.argv[2] || '../Part-Library');
const only = process.argv.slice(3);
const lib = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'));
const outFile = path.join(dir, 'geometry.json');
const overridesFile = path.join(dir, 'geometry-overrides.json');
const overrides = fs.existsSync(overridesFile) ? JSON.parse(fs.readFileSync(overridesFile, 'utf8')) : {};
const previous = only.length && fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')).parts : {};

const oc = await Module({ print: () => {}, printErr: () => {} });
const cad = new Cad(oc);
const r = (v) => v.map((x) => Math.round(x * 100) / 100 || 0);
const r6 = (v) => v.map((x) => Math.round(x * 1e6) / 1e6 || 0);

const parts = { ...previous };
const doubtful = [];
const ids = only.length ? only : Object.keys(lib.parts);
let n = 0;
for (const id of ids) {
  const p = lib.parts[id];
  n++;
  if (overrides[id]) { parts[id] = overrides[id]; continue; }
  try {
    const shape = cad.readStep(fs.readFileSync(path.join(dir, p.files.step)));
    const mesh = cad.mesh(shape);
    const res = locateEnds(p, cad.circles(shape), mesh);
    shape.delete?.();
    if (!res) { doubtful.push([id, 'no match']); continue; }
    parts[id] = {
      ends: res.ends.map((e) => ({ o: r(e.origin), d: r6(e.dir), u: r6(e.up), ...(e.engage ? { engage: e.engage } : {}) })),
      c: r(res.centre),
      bbox: mesh.bbox.map(r),
    };
    if (res.cost > 1.5 || res.notes.length) doubtful.push([id, `cost ${res.cost.toFixed(2)} ${res.notes.join(', ')}`]);
  } catch (e) {
    doubtful.push([id, `error: ${e.message || e}`]);
  }
  if (n % 50 === 0) process.stderr.write(`${n}/${ids.length}\n`);
}

const sorted = Object.fromEntries(Object.keys(lib.parts).filter((id) => parts[id]).map((id) => [id, parts[id]]));
const head = JSON.stringify({ schema_version: 1, units: 'mm', generated_by: 'Pipe-Spool-Tool scripts/library-geometry.mjs' }).slice(0, -1);
const rows = Object.entries(sorted).map(([id, v]) => `  ${JSON.stringify(id)}: ${JSON.stringify(v)}`);
fs.writeFileSync(outFile, `${head},\n "parts": {\n${rows.join(',\n')}\n }\n}\n`); // one part per line, for readable diffs
console.log(`${Object.keys(sorted).length} of ${Object.keys(lib.parts).length} parts written to ${outFile}`);
if (doubtful.length) {
  console.log(`\nCheck these ${doubtful.length}:`);
  for (const [id, why] of doubtful) console.log(`  ${id}  ${lib.parts[id].type}  ${why}`);
}
