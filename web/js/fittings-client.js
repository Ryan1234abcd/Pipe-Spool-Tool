// Browser-side fitting geometry for the standalone (no server) build.
// Port positions mirror spooltool/fittings.py exactly; the meshes are
// display approximations (no bolt holes). STEP export always uses the
// Python/OpenCascade geometry.
import * as THREE from 'three';

const port = (name, origin, dir, size, kind = 'weld') => ({ name, origin, dir, up: [0, 0, 1], size, kind });

function merge(geoms) {
  const pos = [], nrm = [];
  for (let g of geoms) {
    g = g.index ? g.toNonIndexed() : g;
    g.computeVertexNormals();
    pos.push(...g.attributes.position.array);
    nrm.push(...g.attributes.normal.array);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.userData.shared = true;
  return out;
}

/** Tube along +X from x0, open ended (outer and bore surfaces plus end rings). */
function tube(od, id, x0, length) {
  const parts = [new THREE.CylinderGeometry(od / 2, od / 2, length, 40, 1, true)];
  if (id > 0) parts.push(new THREE.CylinderGeometry(id / 2, id / 2, length, 40, 1, true));
  const g = merge(parts);
  g.rotateZ(-Math.PI / 2).translate(x0 + length / 2, 0, 0);
  const rings = id > 0 ? [0, length].map((x) => new THREE.RingGeometry(id / 2, od / 2, 40).rotateY(Math.PI / 2).translate(x0 + x, 0, 0)) : [];
  return merge([g, ...rings]);
}

/** Lathe of an (radius, axial) profile about +X. */
function lathe(profile) {
  const g = new THREE.LatheGeometry(profile.map(([r, x]) => new THREE.Vector2(r, x)), 48);
  g.rotateZ(-Math.PI / 2);
  return g;
}

export function clientFitting(params, config) {
  const { type, size } = params;
  const std = config.standards[params.standard] || Object.values(config.standards)[0];
  const pipe = (s) => {
    const d = std.sizes[s];
    if (!d) throw new Error(`Unknown pipe size ${s}`);
    const walls = d.wall;
    const w = walls[params.schedule] ?? walls[std.defaultSchedule] ?? Object.values(walls)[0];
    return { od: d.od, id: d.od - 2 * w };
  };
  const fit = (s, k) => config.sizeData[s].fitting[k];
  const { od, id } = pipe(size);

  if (type === 'elbow90' || type === 'elbow90sr' || type === 'elbow45') {
    const angle = type === 'elbow45' ? 45 : 90;
    const a = (angle * Math.PI) / 180;
    const R = type === 'elbow45' ? fit(size, 'elbow45LR') / Math.tan(a / 2) : fit(size, type === 'elbow90sr' ? 'elbow90SR' : 'elbow90LR');
    const outer = new THREE.TorusGeometry(R, od / 2, 24, 48, a);
    const inner = new THREE.TorusGeometry(R, id / 2, 24, 48, a);
    const g = merge([outer, inner]);
    g.rotateZ(-Math.PI / 2).translate(0, R, 0);
    return {
      geometry: g,
      ports: [port('A', [0, 0, 0], [-1, 0, 0], size), port('B', [R * Math.sin(a), R * (1 - Math.cos(a)), 0], [Math.cos(a), Math.sin(a), 0], size)],
    };
  }
  if (type === 'tee') {
    const branch = params.size2 || size;
    const b = pipe(branch);
    const c = fit(size, 'teeC');
    const br = merge([new THREE.CylinderGeometry(b.od / 2, b.od / 2, c, 40, 1, true)]);
    br.translate(0, c / 2, 0);
    return {
      geometry: merge([tube(od, id, -c, 2 * c), br]),
      ports: [port('A', [-c, 0, 0], [-1, 0, 0], size), port('B', [c, 0, 0], [1, 0, 0], size), port('C', [0, c, 0], [0, 1, 0], branch)],
    };
  }
  if (type === 'reducer' || type === 'reducer_ecc') {
    const small = params.size2;
    const s = pipe(small);
    if (s.od >= od) throw new Error('Reducer small end must be smaller than the large end');
    const h = fit(size, 'reducerH');
    const off = type === 'reducer_ecc' ? (od - s.od) / 2 : 0;
    const g = merge([new THREE.CylinderGeometry(s.od / 2, od / 2, h, 40, 1, true), new THREE.CylinderGeometry(s.id / 2, id / 2, h, 40, 1, true)]);
    g.rotateZ(-Math.PI / 2).translate(h / 2, 0, 0);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) + off * (p.getX(i) / h));
    g.computeVertexNormals();
    return { geometry: g, ports: [port('A', [0, 0, 0], [-1, 0, 0], size), port('B', [h, 0, off], [1, 0, 0], small)] };
  }
  if (type === 'flange_wn') {
    const fl = config.sizeData[size].flange;
    const y = fl.wnLength, t = fl.thickness, rf = fl.rfHeight, hub = y - t;
    const g = lathe([[id / 2, 0], [od / 2, 0], [fl.hubDia / 2, hub], [fl.od / 2, hub], [fl.od / 2, y - rf], [fl.rfDia / 2, y - rf], [fl.rfDia / 2, y], [id / 2, y], [id / 2, 0]]);
    return { geometry: g, ports: [port('A', [0, 0, 0], [-1, 0, 0], size, 'weld'), port('B', [y, 0, 0], [1, 0, 0], size, 'flange')] };
  }
  if (type === 'flange_blind') {
    const fl = config.sizeData[size].flange;
    const g = lathe([[0, 0], [fl.rfDia / 2, 0], [fl.rfDia / 2, fl.rfHeight], [fl.od / 2, fl.rfHeight], [fl.od / 2, fl.thickness], [0, fl.thickness]]);
    return { geometry: g, ports: [port('A', [0, 0, 0], [-1, 0, 0], size, 'flange')] };
  }
  if (type === 'cap') {
    const e = fit(size, 'capE');
    const r = od / 2;
    const depth = Math.min(e * 0.75, r / 2);
    const straight = Math.max(e - depth, 0.1);
    const prof = [[0, 0], [r, 0], [r, straight]];
    for (let i = 1; i <= 12; i++) {
      const a = (i * Math.PI) / 2 / 12;
      prof.push([r * Math.cos(a), straight + depth * Math.sin(a)]);
    }
    return { geometry: lathe(prof), ports: [port('A', [0, 0, 0], [-1, 0, 0], size)] };
  }
  throw new Error(`Unknown fitting type ${type}`);
}
