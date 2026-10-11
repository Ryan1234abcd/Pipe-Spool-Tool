// Copies a few parts from Part-Library into library/Demo, the set built into
// the page so it works before the user opens their own library folder.
//
//   node scripts/make-demo.mjs ../Part-Library
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(process.argv[2] || '../Part-Library');
const out = path.join(ROOT, 'library', 'Demo');
const IDS = [
  'SPB5090S10', 'SPB5045S10', 'SPET50S10', 'SPRT5040S10', 'SPCR5040S10', 'SPEC50S10', 'SPF50E',
  'SPB4090S10', 'SPET40S10', 'SPEC40S10', 'SPF40E', 'CILBV50DE', 'CIWCV50',
];
const lib = JSON.parse(fs.readFileSync(path.join(src, 'library.json'), 'utf8'));
const geo = JSON.parse(fs.readFileSync(path.join(src, 'geometry.json'), 'utf8'));
fs.rmSync(out, { recursive: true, force: true });
const parts = {};
const g = {};
for (const id of IDS) {
  const p = lib.parts[id];
  if (!p || !geo.parts[id]) throw new Error(`${id} missing`);
  parts[id] = p;
  g[id] = geo.parts[id];
  fs.mkdirSync(path.join(out, path.dirname(p.files.step)), { recursive: true });
  fs.copyFileSync(path.join(src, p.files.step), path.join(out, p.files.step));
}
const systems = lib.systems
  .map((s) => ({ ...s, types: s.types.map((t) => ({ ...t, parts: t.parts.filter((id) => parts[id]) })).filter((t) => t.parts.length) }))
  .filter((s) => s.types.length);
fs.writeFileSync(path.join(out, 'library.json'), `${JSON.stringify({ name: `${lib.name} (demo subset)`, systems, parts }, null, 1)}\n`);
fs.writeFileSync(path.join(out, 'geometry.json'), `${JSON.stringify({ ...geo, parts: g })}\n`);
console.log(`${IDS.length} demo parts written to ${path.relative(ROOT, out)}`);
