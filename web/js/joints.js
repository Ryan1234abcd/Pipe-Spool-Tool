// Which ends can be joined, and pipe lengths from centre dimensions.
// Pure functions (tested in tests/joints.test.mjs).
//
// End families (from the `end` text in Part-Library's library.json):
//   weld    butt-weld, plain weld end, slip-on, RJT union weld ends – welded to pipe or another weld end
//   bspF    BSP female – takes threaded pipe or a BSP male end
//   bspM    BSP male   – screws into a BSP female end
//   rjtM / rjtF  RJT male thread / RJT female (liner + nut)
//   flange  flange face – bolts to another flange face or a wafer/lugged valve
//   wafer   wafer or lugged valve face – sits between two flange faces
//   pipe    the generated straight pipe

export const OD_TOL = 0.6;

export function endFamily(end = '') {
  if (/BSP female/i.test(end)) return 'bspF';
  if (/BSP male/i.test(end)) return 'bspM';
  if (/RJT female/i.test(end)) return 'rjtF';
  if (/^RJT male/i.test(end)) return 'rjtM';
  if (/flange face/i.test(end)) return 'flange';
  if (/wafer|lugged/i.test(end)) return 'wafer';
  return 'weld';
}

const sameOd = (a, b) => !(a.od > 0) || !(b.od > 0) || Math.abs(a.od - b.od) <= OD_TOL;

/** Can these two ends be joined face to face (no pipe between)? */
export function directJoin(a, b) {
  const f = [a.family, b.family].sort().join('+');
  switch (f) {
    case 'pipe+weld': return sameOd(a, b) && !(a.family === 'pipe' ? a : b).threaded;
    case 'bspF+pipe': return sameOd(a, b) && !!(a.family === 'pipe' ? a : b).threaded;
    case 'weld+weld': case 'bspF+bspM': case 'rjtF+rjtM':
      return sameOd(a, b);
    case 'flange+flange': case 'flange+wafer':
      return sameOd(a, b) && (!(a.flange && b.flange) || Math.abs(a.flange - b.flange) < 1);
    default: return false;
  }
}

/** Does this end take a pipe (welded or threaded into it)? */
export const takesPipe = (e) => e.family === 'weld' || e.family === 'bspF';

/** Ends of a part that can go on `target`: [{port, viaPipe}] (direct joins first). */
export function joinOptions(target, ports) {
  const out = [];
  for (const p of ports) {
    if (target.family === 'pipe') { if (directJoin(target, p)) out.push({ port: p, viaPipe: false }); continue; }
    if (directJoin(target, p) && !(takesPipe(target) && takesPipe(p))) out.push({ port: p, viaPipe: false });
    // the pipe between must suit both ends: welded both ends, or threaded both ends
    else if (takesPipe(target) && target.family === p.family && sameOd(target, p)) out.push({ port: p, viaPipe: true });
  }
  return out;
}

// EN 10255 medium walls for pipe threaded into BSP ends (by OD).
const BSP_WALL = [[10.2, 2.0], [13.5, 2.3], [17.2, 2.3], [21.3, 2.6], [26.9, 2.6], [33.7, 3.2], [42.4, 3.2],
  [48.3, 3.2], [60.3, 3.6], [76.1, 3.6], [88.9, 4.0], [114.3, 4.5], [139.7, 5.0], [165.1, 5.0]];

/** Pipe for an end: {od, wall, label, threaded}. */
export function pipeFor(end) {
  const threaded = end.family === 'bspF';
  let wall = end.wall;
  if (!(wall > 0)) {
    const row = BSP_WALL.find(([od]) => Math.abs(od - end.od) <= 1);
    wall = row ? row[1] : Math.max(1, end.od * 0.06);
  }
  return { od: end.od, wall, label: end.label || `Ø${end.od}`, threaded };
}

/** Centre-to-end of a part port, along the port (mm). */
export function centreToEnd(port, centre) {
  if (!centre) return 0;
  const v = [port.origin[0] - centre[0], port.origin[1] - centre[1], port.origin[2] - centre[2]];
  return Math.max(0, v[0] * port.dir[0] + v[1] * port.dir[1] + v[2] * port.dir[2]);
}

/**
 * Cut length of a pipe from its dimension.
 * @param dim  {mode: 'cc' | 'cut', value}   cc: centre to centre (or centre to the
 *             pipe end when nothing is on the far side)
 * @param a, b the parts at either end: {c2e, engage} or null (open end)
 */
export function cutLength(dim, a, b) {
  const v = Number(dim?.value) || 0;
  if (dim?.mode !== 'cc') return v;
  const side = (s) => (s ? s.c2e - (s.engage || 0) : 0);
  return v - side(a) - side(b);
}

/** The value a cut length shows as in a mode (inverse of cutLength). */
export function dimFromCut(mode, cut, a, b) {
  if (mode !== 'cc') return cut;
  const side = (s) => (s ? s.c2e - (s.engage || 0) : 0);
  return cut + side(a) + side(b);
}
