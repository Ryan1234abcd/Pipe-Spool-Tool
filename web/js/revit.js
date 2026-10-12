// The Revit file for the Dynamo graph in revit/: native solids for the pipes
// and simple fittings, and every open end of the spool (a pipe connector, a
// centreline reference line and an end reference plane go on each).
// Pure (tested in tests/joints.test.mjs).
import { nominalSize } from './joints.js';

/** Part groups built as native Revit solids; the rest (valves, strainers) go in the STEP. */
export const NATIVE_GROUPS = ['Elbows & bends', 'Tees', 'Reducers', 'Flanges', 'Unions & couplings',
  'Nipples & bushes', 'Caps & plugs', 'Adapters'];

const r3 = (v) => v.map((x) => Math.round(x * 1000) / 1000 || 0);
const unit = (v) => { const l = Math.hypot(...v) || 1; return r3(v.map((x) => x / l)); };

/** Nominal size (DN) of a port: its own, from an "NNNB" label, or the tube OD. */
function nominalOf(port) {
  if (port.dn) return typeof port.dn === 'number' ? port.dn : nominalSize({ dn: port.dn });
  const m = /^(\d+)\s*NB/i.exec(port.label || '');
  return m ? Number(m[1]) : nominalSize({ od_mm: port.od });
}

/**
 * @param open   openPorts() result: [{nodeId, port}] with world ports
 * @param nodeOf function(nodeId) -> spool node
 * @param native node ids built as native solids (their ends get the connector on that solid)
 * @returns {units, origin, ends:[{name, point, direction, od, nominal, end, part, native, item}]}
 */
export function connectorEnds(open, nodeOf, native = new Set()) {
  const ends = [];
  for (const { nodeId, port } of open) {
    if (port.family === 'start' || port.family === 'none') continue; // start point markers
    const n = nodeOf(nodeId);
    ends.push({
      name: `E${ends.length + 1}`,
      point: r3(port.origin),
      direction: unit(port.dir), // out of the spool
      od: port.od || null,
      nominal: nominalOf(port),
      end: port.family === 'pipe' ? 'pipe end' : (port.end || port.family),
      part: n?.type === 'pipe' ? `pipe ${n.label || ''}`.trim() : n?.part || null,
      native: native.has(nodeId),
      item: native.has(nodeId) ? nodeId : null,
    });
  }
  return { units: 'mm', origin: 'STEP origin (spool origin)', note: 'point is on the end face; direction points out of the spool', ends };
}

/**
 * The whole file: native solids [{node, name, prims}] (spool coordinates, mm) and the open ends.
 */
export function revitFile(open, nodeOf, native = []) {
  const ids = new Set(native.map((g) => g.node));
  return {
    version: 2,
    ...connectorEnds(open, nodeOf, ids),
    solids: native.map((g) => ({ item: g.node, name: g.name, prims: g.prims })),
  };
}
