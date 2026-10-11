// The Revit connector file: every open end of the spool, for the Dynamo graph
// in revit/ that adds a pipe connector at each end of the imported spool.
// Pure (tested in tests/joints.test.mjs).
import { nominalSize } from './joints.js';

const r3 = (v) => v.map((x) => Math.round(x * 1000) / 1000 || 0);
const unit = (v) => { const l = Math.hypot(...v) || 1; return r3(v.map((x) => x / l)); };

/** Nominal size (DN) of a port: its own, from an "NNNB" label, or the tube OD. */
function nominalOf(port) {
  if (port.dn) return port.dn;
  const m = /^(\d+)\s*NB/i.exec(port.label || '');
  return m ? Number(m[1]) : nominalSize({ od_mm: port.od });
}

/**
 * @param open   openPorts() result: [{nodeId, port}] with world ports
 * @param nodeOf function(nodeId) -> spool node
 * @returns {units, origin, ends:[{name, point, direction, od, nominal, end, part}]}
 */
export function connectorEnds(open, nodeOf) {
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
    });
  }
  return { units: 'mm', origin: 'STEP origin (spool origin)', note: 'point is on the end face; direction points out of the spool', ends };
}
