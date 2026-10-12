# Builds a Pipe Spool Tool spool in a Revit family from the "<spool>-revit.json"
# file the tool exports:
#   - the pipes and simple fittings as native family solids (revolves and
#     extrusions), which Revit can host connectors on;
#   - a pipe connector at every open end of the spool, sized to the pipe;
#   - at every open end, a reference line on the pipe centreline and a
#     reference plane on the end face, to align the family with other pipes.
# Valves come as a separate STEP file: import it into the family with
# Insert > Import CAD, Positioning "Origin to origin", units millimetres.
# Ends on a valve get their connector on a thin native disc (1 mm, hidden),
# because Revit won't host a connector on imported geometry.
#
# Runs in a Dynamo Python node (CPython3) in the family editor:
#   IN[0]  path of the -revit.json file
#   IN[1]  pipe system classification, e.g. "OtherPipe", "SupplyHydronic",
#          "ReturnHydronic", "DomesticColdWater" (default "OtherPipe")
#   IN[2]  True: connector diameter = nominal size (DN); False: pipe OD
#   IN[3]  True to leave the valve-end discs visible (default hidden)
# Run it once per family (Ctrl+Z in Revit undoes a run).
import json
import math

import clr
clr.AddReference('RevitAPI')
clr.AddReference('RevitServices')
from Autodesk.Revit.DB import (Arc, BuiltInParameter, ConnectorElement, CurveArray, CurveArrArray, Line,
                               Options, Plane, PlanarFace, SketchPlane, Solid, ViewPlan, XYZ,
                               FilteredElementCollector)
from Autodesk.Revit.DB.Plumbing import PipeSystemType
from RevitServices.Persistence import DocumentManager
from RevitServices.Transactions import TransactionManager

MM = 1.0 / 304.8  # Revit works in feet
DISC = 1.0 * MM   # valve-end disc thickness

doc = DocumentManager.Instance.CurrentDBDocument
create = doc.FamilyCreate if doc.IsFamilyDocument else None
path = IN[0]
system_name = IN[1] if len(IN) > 1 and IN[1] else 'OtherPipe'
use_nominal = IN[2] if len(IN) > 2 and IN[2] is not None else True
visible = IN[3] if len(IN) > 3 and IN[3] is not None else False


# ------------------------------------------------------------------ vectors
def xyz(v, scale=1.0):
    return XYZ(v[0] * scale, v[1] * scale, v[2] * scale)


def pt(v):
    return xyz(v, MM)


def at(o, a, s, b=None, t=0.0):
    """o + a*s (+ b*t)"""
    p = o.Add(a.Multiply(s))
    return p.Add(b.Multiply(t)) if b is not None else p


def perpendicular(d):
    for ref in (XYZ(0, 0, 1), XYZ(1, 0, 0)):
        p = ref.Subtract(d.Multiply(ref.DotProduct(d)))
        if p.GetLength() > 1e-3:
            return p.Normalize()
    return XYZ(0, 1, 0)


def square(x, d):
    """x made exactly square to d (the file's directions are rounded)."""
    return x.Subtract(d.Multiply(x.DotProduct(d))).Normalize()


def plane_xy(origin, x, y):
    return Plane.CreateByOriginAndBasis(origin, x, square(y, x))


def loop_of(points):
    loop = CurveArray()
    for i in range(len(points)):
        a, b = points[i], points[(i + 1) % len(points)]
        if a.DistanceTo(b) > 1e-6:
            loop.Append(Line.CreateBound(a, b))
    return loop


def circle(plane, radius):
    loop = CurveArray()
    loop.Append(Arc.Create(plane, radius, 0.0, math.pi))
    loop.Append(Arc.Create(plane, radius, math.pi, 2.0 * math.pi))
    return loop


def profile_of(*loops):
    arr = CurveArrArray()
    for lp in loops:
        arr.Append(lp)
    return arr


def solids_of(element):
    opts = Options()
    opts.ComputeReferences = True
    geo = element.get_Geometry(opts)
    return [g for g in geo if isinstance(g, Solid) and g.Volume > 0] if geo is not None else []


# ------------------------------------------------------------------ native solids
def revolve(p):
    """Profile [[h, r]...] about the line o + h*d, closed to the axis."""
    o, d = pt(p['o']), xyz(p['d']).Normalize()
    x = square(xyz(p['x']), d)
    pts = p['pts']
    ring = [[pts[0][0], 0.0]] + pts + [[pts[-1][0], 0.0]]
    poly = []
    for h, r in ring:
        q = at(o, d, h * MM, x, r * MM)
        if not poly or poly[-1].DistanceTo(q) > 0.5 * MM:
            poly.append(q)
    plane = plane_xy(o, d, x)
    sketch = SketchPlane.Create(doc, plane)
    h0, h1 = min(q[0] for q in pts), max(q[0] for q in pts)
    axis = Line.CreateBound(at(o, d, h0 * MM), at(o, d, max(h1, h0 + 1.0) * MM))
    return [create.NewRevolution(True, profile_of(loop_of(poly)), sketch, axis, 0.0, 2.0 * math.pi)]


def torus(p):
    """Ring segment: tube radius r about the circle of radius R round the axis
    (c, n), from direction x through `angle` (towards n x x)."""
    c, n = pt(p['c']), xyz(p['n']).Normalize()
    x = square(xyz(p['x']), n)
    R, r, angle = p['R'] * MM, p['r'] * MM, float(p['angle'])
    y = n.CrossProduct(x)
    centre = at(c, x, R)
    plane = plane_xy(c, x, n)
    sketch = SketchPlane.Create(doc, plane)
    tube = circle(plane_xy(centre, x, n), r)
    for axis in (Line.CreateBound(c, c.Add(n)), Line.CreateBound(c.Add(n), c)):
        el = create.NewRevolution(True, profile_of(tube), sketch, axis, 0.0, angle)
        doc.Regenerate()
        sol = solids_of(el)
        # Revit turns the profile one way about the axis line: keep the one
        # that goes from x towards y (the bend's middle is on that side)
        if sol and sol[0].ComputeCentroid().Subtract(c).DotProduct(y) > 0:
            return [el]
        doc.Delete(el.Id)
    raise Exception('bend could not be oriented')


def extrude(origin, normal, loop_fn, depth):
    plane = Plane.CreateByNormalAndOrigin(normal, origin)
    sketch = SketchPlane.Create(doc, plane)
    return create.NewExtrusion(True, profile_of(loop_fn(plane)), sketch, depth)


def cyl(p):
    o, d = pt(p['o']), xyz(p['d']).Normalize()
    return [extrude(o, d, lambda pl: circle(pl, p['r'] * MM), p['L'] * MM)]


def box(p):
    o = pt(p['o'])
    z = xyz(p['z']).Normalize()
    x = square(xyz(p['x']), z)
    y = square(xyz(p['y']), z)
    lo, hi = p['min'], p['max']
    base = at(at(o, x, 0.0), z, lo[2] * MM)
    corners = [at(at(base, x, a * MM), y, b * MM)
               for a, b in ((lo[0], lo[1]), (hi[0], lo[1]), (hi[0], hi[1]), (lo[0], hi[1]))]
    return [extrude(base, z, lambda pl: loop_of(corners), max(hi[2] - lo[2], 1.0) * MM)]


BUILD = {'revolve': revolve, 'torus': torus, 'cyl': cyl, 'box': box}


# ------------------------------------------------------------------ connectors
def end_face(elements, point, normal, reach):
    """Reference of the planar face of the elements on the end: facing out along
    `normal`, on the pipe axis, nearest the end plane (within `reach`)."""
    best, best_off = None, None
    for el in elements:
        for s in solids_of(el):
            for f in s.Faces:
                if not isinstance(f, PlanarFace) or f.FaceNormal.DotProduct(normal) < 0.9999:
                    continue
                off = f.Origin.Subtract(point).DotProduct(normal)
                if abs(off) > reach:
                    continue
                on_axis = point.Add(normal.Multiply(off))
                hit = f.Project(on_axis)
                if hit is None or hit.Distance > 0.5 * MM:
                    continue  # the axis doesn't pass through this face
                if best is None or abs(off) < best_off:
                    best, best_off = f.Reference, abs(off)
    return best


def disc(point, normal, radius):
    """Thin native extrusion ending on the end plane, lying behind it."""
    el = extrude(point.Subtract(normal.Multiply(DISC)), normal, lambda pl: circle(pl, radius), DISC)
    if not visible:
        p = el.get_Parameter(BuiltInParameter.IS_VISIBLE_PARAM)
        if p is not None and not p.IsReadOnly:
            p.Set(0)
    return el


def size_connector(conn, dia):
    for bip in (BuiltInParameter.CONNECTOR_DIAMETER, BuiltInParameter.RBS_PIPE_DIAMETER_PARAM):
        p = conn.get_Parameter(bip)
        if p is not None and not p.IsReadOnly:
            p.Set(dia * MM)
            return


# ------------------------------------------------------------------ references
_plane_view = []


def plane_views():
    """Views to create reference planes in (the API needs one)."""
    if not _plane_view:
        views = [v for v in FilteredElementCollector(doc).OfClass(ViewPlan) if not v.IsTemplate]
        _plane_view.extend([doc.ActiveView] + views)
    return _plane_view


def references(name, point, normal, od):
    made = []
    u = perpendicular(normal)
    v = normal.CrossProduct(u)
    # centreline: from the end face into the spool
    length = max(od, 50.0) * MM
    line = Line.CreateBound(point, point.Subtract(normal.Multiply(length)))
    curve = create.NewModelCurve(line, SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin(u, point)))
    curve.ChangeToReferenceLine()
    made.append('centreline')
    # reference plane on the end face
    half = max(od, 50.0) * MM
    for view in plane_views():
        try:
            rp = create.NewReferencePlane(point.Subtract(u.Multiply(half)), point.Add(u.Multiply(half)), v, view)
        except Exception:
            continue
        for k in range(1, 50):
            try:
                rp.Name = '%s end' % name if k == 1 else '%s end (%d)' % (name, k)
                break
            except Exception:
                pass  # name taken
        made.append('end plane')
        break
    return made


# ------------------------------------------------------------------ run
out = []
if create is None:
    out.append('Open the family (family editor) first: this only works in a family.')
else:
    with open(path) as fh:
        data = json.load(fh)
    system = getattr(PipeSystemType, system_name, PipeSystemType.OtherPipe)
    TransactionManager.Instance.EnsureInTransaction(doc)

    items = {}
    for s in data.get('solids', []):
        made = []
        for p in s.get('prims', []):
            try:
                made.extend(BUILD[p['t']](p))
            except Exception as ex:  # keep going with the rest
                out.append('%s: a %s could not be built (%s)' % (s.get('name'), p.get('t'), ex))
        items[s.get('item')] = made
    if items:
        out.append('%d native solids for %d pipes and fittings' % (sum(len(v) for v in items.values()), len(items)))
    doc.Regenerate()

    for e in data.get('ends', []):
        name = e.get('name')
        try:
            point = pt(e['point'])
            normal = xyz(e['direction']).Normalize()
            od = float(e.get('od') or 0)
            if od <= 0:
                out.append('%s: no size, skipped' % name)
                continue
            ref = None
            if e.get('native') and items.get(e.get('item')):
                ref = end_face(items[e.get('item')], point, normal, max(30.0, od / 2.0) * MM)
            on = 'fitting'
            if ref is None:  # a valve end (imported geometry): a disc to host the connector
                el = disc(point, normal, od / 2.0 * MM)
                doc.Regenerate()
                ref = end_face([el], point, normal, 0.5 * MM)
                on = 'disc'
            if ref is None:
                out.append('%s: no face to put the connector on' % name)
                continue
            conn = ConnectorElement.CreatePipeConnector(doc, system, ref)
            dia = float(e.get('nominal') or od) if use_nominal else od
            size_connector(conn, dia)
            refs = references(name, point, normal, od)
            out.append('%s: connector %s mm on the %s, %s at %s' % (name, dia, on, ' + '.join(refs), e.get('point')))
        except Exception as ex:  # keep going with the other ends
            out.append('%s: %s' % (name, ex))
    TransactionManager.Instance.TransactionTaskDone()

OUT = out
