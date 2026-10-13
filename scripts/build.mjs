// Build the single-file app: pipe-spool-tool.html
//
//   npm install          (once – fetches three.js and the OpenCascade build)
//   npm run build        -> pipe-spool-tool.html
//   node scripts/build.mjs --hosted DIR
//        also writes DIR/index.html (page body without <html>/<head> for hosts
//        that add their own skeleton) and DIR/oc/* (the WebAssembly kernel split
//        into chunks so it can be served next to the page).
//
// The page loads the 23 MB OpenCascade WebAssembly kernel from oc/ next to the
// page if present, otherwise from the jsDelivr CDN.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const NM = path.join(ROOT, 'node_modules');
const read = (p) => fs.readFileSync(p, 'utf8');

const THREE_ADDONS = path.join(NM, 'three/examples/jsm');
const APP_MODULES = [
  [path.join(THREE_ADDONS, 'controls/OrbitControls.js'), 'three/addons/OrbitControls.js'],
  [path.join(THREE_ADDONS, 'renderers/CSS2DRenderer.js'), 'three/addons/CSS2DRenderer.js'],
  ['js/kinematics.js', './kinematics.js'],
  ['js/joints.js', './joints.js'],
  ['js/revit.js', './revit.js'],
  ['js/edit.js', './edit.js'],
  ['js/ui.js', './ui.js'],
  ['js/library.js', './library.js'],
  ['js/cad-client.js', './cad-client.js'],
  ['js/viewer.js', './viewer.js'],
  ['js/parts.js', './parts.js'],
  ['js/app.js', './app.js'],
];
const WORKER_MODULES = [
  ['js/cad.js', './cad.js'],
  ['js/wrap.js', './wrap.js'],
  ['js/cad-worker.js', './cad-worker.js'],
];

const IMPORT_RE = /import\s+(\*\s+as\s+\w+|\{[^}]*\})\s+from\s+'([^']+)';?/gs;
const EXPORT_DECL_RE = /^export\s+(async\s+function|function|const|let|class)\s+(\w+)/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\};?/gm;

/** Turn an ES module into a function-scoped block registered in __mods. */
function convert(code, key, known) {
  code = code.replace(IMPORT_RE, (_, what, src) => {
    const target = src === 'three' ? 'self.THREE' : `__mods[${JSON.stringify(src)}]`;
    if (src !== 'three' && !known.has(src)) throw new Error(`${key}: unknown import ${src}`);
    if (what.startsWith('*')) return `const ${what.split(/\s+/).pop()} = ${target};`;
    const names = what.replace(/[{}\n]/g, ' ').split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': '));
    return `const { ${names.join(', ')} } = ${target};`;
  });
  const exports = [...code.matchAll(EXPORT_DECL_RE)].map((m) => m[2]);
  code = code.replace(EXPORT_DECL_RE, '$1 $2');
  for (const m of code.matchAll(EXPORT_LIST_RE)) exports.push(...m[1].split(',').map((n) => n.trim()).filter(Boolean));
  code = code.replace(EXPORT_LIST_RE, '');
  if (/^\s*(import|export)\s/m.test(code)) throw new Error(`${key}: unconverted import/export`);
  return `__mods[${JSON.stringify(key)}] = (() => {\n${code}\nreturn { ${exports.join(', ')} };\n})();\n`;
}

function bundle(modules) {
  const known = new Set(modules.map(([, k]) => k));
  return 'const __mods = {};\n' + modules.map(([p, k]) => convert(read(path.isAbsolute(p) ? p : path.join(WEB, p)), k, known)).join('');
}

function workerSource() {
  let glue = read(path.join(NM, 'replicad-opencascadejs/dist/replicad_single.js'));
  glue = glue.replace(/import\.meta\.url/g, 'self.location.href').replace(/export\s+default\s+Module;?\s*$/, '');
  if (/\bimport\.meta\b|^export /m.test(glue)) throw new Error('unexpected module syntax in OpenCascade glue');
  return `${glue}\n;${bundle(WORKER_MODULES)}`;
}

/** The demo parts in library/Demo (made by scripts/make-demo.mjs). */
function demo() {
  const base = path.join(ROOT, 'library', 'Demo');
  const library = JSON.parse(read(path.join(base, 'library.json')));
  const geometry = JSON.parse(read(path.join(base, 'geometry.json')));
  const files = {};
  for (const p of Object.values(library.parts)) files[p.files.step] = read(path.join(base, p.files.step));
  return { library, geometry, files };
}

const safe = (s) => s.replace(/<\/script/gi, '<\\/script');

function build() {
  const html = read(path.join(WEB, 'index.html'));
  const css = read(path.join(WEB, 'style.css'));
  const three = read(path.join(NM, 'three/build/three.min.js')).replace(/^console\.warn\([^)]*\),/, 'void ');
  const title = html.match(/<title>.*?<\/title>/s)[0];
  const icon = html.match(/<link rel="icon"[^>]*>/)[0];
  const body = html.match(/<body>(.*)<\/body>/s)[1];
  const scripts = [
    `<script>${safe(three)}</script>`,
    `<script>window.SPOOL_DEMO = ${safe(JSON.stringify(demo()))};\nwindow.CAD_WORKER_SRC = ${safe(JSON.stringify(workerSource()))};</script>`,
    `<script>\n${safe(bundle(APP_MODULES))}</script>`,
  ].join('\n');
  const head = `${title}\n${icon}\n<style>\n${css}\n</style>\n`;
  const page = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n`
    + `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${head}</head>\n`
    + `<body>${body}${scripts}\n</body>\n</html>\n`;
  const out = path.join(ROOT, 'pipe-spool-tool.html');
  fs.writeFileSync(out, page);
  console.log(`wrote ${path.relative(ROOT, out)} (${(page.length / 1e6).toFixed(1)} MB)`);

  const i = process.argv.indexOf('--hosted');
  if (i > 0) {
    const dir = path.resolve(process.argv[i + 1]);
    fs.mkdirSync(path.join(dir, 'oc'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), `${head}${body}${scripts}\n`);
    const wasm = fs.readFileSync(path.join(NM, 'replicad-opencascadejs/dist/replicad_single.wasm'));
    const CHUNK = 12 * 1024 * 1024;
    const parts = [];
    for (let o = 0, n = 0; o < wasm.length; o += CHUNK, n++) {
      const name = `kernel.${n}.wasm`;
      fs.writeFileSync(path.join(dir, 'oc', name), wasm.subarray(o, o + CHUNK));
      parts.push(name);
    }
    fs.writeFileSync(path.join(dir, 'oc', 'manifest.json'), JSON.stringify({ size: wasm.length, parts }));
    console.log(`wrote hosted copy to ${dir} (${parts.length} kernel chunks)`);
  }
}

build();
