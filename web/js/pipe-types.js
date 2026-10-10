// Pipe types offered in the spool builder. OD and wall thickness in mm.
// Edit or extend this list; sizes are matched to STEP fitting ports by OD.

const series = (rows) => rows.map(([label, od, wall]) => ({ label, od, wall }));

export const PIPE_TYPES = [
  {
    id: 'en10255-m',
    name: 'Steel · medium (EN 10255)',
    sizes: series([
      ['DN8', 13.5, 2.3], ['DN10', 17.2, 2.3], ['DN15', 21.3, 2.6], ['DN20', 26.9, 2.6], ['DN25', 33.7, 3.2],
      ['DN32', 42.4, 3.2], ['DN40', 48.3, 3.2], ['DN50', 60.3, 3.6], ['DN65', 76.1, 3.6], ['DN80', 88.9, 4.0],
      ['DN100', 114.3, 4.5], ['DN125', 139.7, 5.0], ['DN150', 165.1, 5.0],
    ]),
  },
  {
    id: 'en1057-x',
    name: 'Copper · Table X (EN 1057)',
    sizes: series([
      ['8 mm', 8, 0.6], ['10 mm', 10, 0.6], ['12 mm', 12, 0.6], ['15 mm', 15, 0.7], ['22 mm', 22, 0.9],
      ['28 mm', 28, 0.9], ['35 mm', 35, 1.2], ['42 mm', 42, 1.2], ['54 mm', 54, 1.2], ['67 mm', 67, 1.2],
      ['76.1 mm', 76.1, 1.5], ['108 mm', 108, 1.5], ['133 mm', 133, 1.5], ['159 mm', 159, 2.0],
    ]),
  },
  {
    id: 'pex-sdr74',
    name: 'PE-X / PE-RT · SDR 7.4',
    sizes: series([
      ['16 mm', 16, 2.2], ['20 mm', 20, 2.8], ['25 mm', 25, 3.5], ['32 mm', 32, 4.4], ['40 mm', 40, 5.5],
      ['50 mm', 50, 6.9], ['63 mm', 63, 8.6], ['75 mm', 75, 10.3], ['90 mm', 90, 12.3], ['110 mm', 110, 15.1],
    ]),
  },
  {
    id: 'en10312-press',
    name: 'Stainless press-fit (EN 10312)',
    sizes: series([
      ['15 mm', 15, 1.0], ['18 mm', 18, 1.0], ['22 mm', 22, 1.2], ['28 mm', 28, 1.2], ['35 mm', 35, 1.5],
      ['42 mm', 42, 1.5], ['54 mm', 54, 1.5], ['76.1 mm', 76.1, 2.0], ['88.9 mm', 88.9, 2.0], ['108 mm', 108, 2.0],
    ]),
  },
  {
    id: 'a312-10s',
    name: 'Stainless Sch 10S (ASTM A312)',
    sizes: series([
      ['1/2"', 21.3, 2.11], ['3/4"', 26.7, 2.11], ['1"', 33.4, 2.77], ['1-1/4"', 42.2, 2.77], ['1-1/2"', 48.3, 2.77],
      ['2"', 60.3, 2.77], ['2-1/2"', 73.0, 3.05], ['3"', 88.9, 3.05], ['4"', 114.3, 3.05], ['5"', 141.3, 3.40],
      ['6"', 168.3, 3.40], ['8"', 219.1, 3.76], ['10"', 273.0, 4.19], ['12"', 323.8, 4.57],
    ]),
  },
  {
    id: 'a312-40s',
    name: 'Stainless Sch 40S (ASTM A312)',
    sizes: series([
      ['1/2"', 21.3, 2.77], ['3/4"', 26.7, 2.87], ['1"', 33.4, 3.38], ['1-1/4"', 42.2, 3.56], ['1-1/2"', 48.3, 3.68],
      ['2"', 60.3, 3.91], ['2-1/2"', 73.0, 5.16], ['3"', 88.9, 5.49], ['4"', 114.3, 6.02], ['5"', 141.3, 6.55],
      ['6"', 168.3, 7.11], ['8"', 219.1, 8.18], ['10"', 273.0, 9.27], ['12"', 323.8, 9.53],
    ]),
  },
  {
    id: 'as1528-1',
    name: 'Dairy tube (AS 1528.1)',
    sizes: series([
      ['25.4 mm', 25.4, 1.6], ['31.8 mm', 31.8, 1.6], ['38.1 mm', 38.1, 1.6], ['50.8 mm', 50.8, 1.6],
      ['63.5 mm', 63.5, 1.6], ['76.2 mm', 76.2, 1.6], ['101.6 mm', 101.6, 2.0], ['152.4 mm', 152.4, 2.6],
    ]),
  },
];

/** OD match tolerance between a pipe and a fitting port (mm). */
export const OD_TOL = 0.6;

export const pipeType = (id) => PIPE_TYPES.find((t) => t.id === id) || PIPE_TYPES[0];

/** Size of this pipe type whose OD matches, or null. */
export function sizeForOd(type, od) {
  if (!(od > 0)) return null;
  let best = null;
  for (const s of type.sizes) if (Math.abs(s.od - od) <= OD_TOL && (!best || Math.abs(s.od - od) < Math.abs(best.od - od))) best = s;
  return best;
}

/** Human label for a port OD in the context of a pipe type. */
export function odLabel(type, od) {
  if (!(od > 0)) return '?';
  const s = sizeForOd(type, od);
  return s ? s.label : `Ø${Math.round(od * 10) / 10}`;
}

/**
 * Guess the connecting pipe OD from circle diameters found on a part end:
 * a pipe OD (weld/press ends) first, then a pipe bore. Prefers the current type.
 */
export function guessOd(diameters, preferType) {
  const types = preferType ? [preferType, ...PIPE_TYPES.filter((t) => t !== preferType)] : PIPE_TYPES;
  const ds = [...diameters].sort((a, b) => b - a);
  for (const t of types) for (const d of ds) for (const s of t.sizes) if (Math.abs(s.od - d) <= 1.0) return s.od;
  for (const t of types) for (const d of ds) for (const s of t.sizes) if (Math.abs(s.od - 2 * s.wall - d) <= OD_TOL) return s.od;
  return null;
}
