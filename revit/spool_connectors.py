# Adds a pipe connector at every open end of a spool imported into a Revit
# family, using the "<spool>-connectors.json" file the Pipe Spool Tool saves
# with the STEP export.
#
# Revit only hosts connectors on native family geometry, not on imported
# geometry, so for each end this makes a thin native disc (an extrusion,
# 1 mm deep, its outer face flush with the end face, hidden by default) and
# places the connector on that face, sized to the pipe.
#
# Runs in a Dynamo Python node (CPython3) in the family editor:
#   IN[0]  path of the connectors .json file
#   IN[1]  pipe system classification, e.g. "OtherPipe", "SupplyHydronic",
#          "ReturnHydronic", "DomesticColdWater" (default "OtherPipe")
#   IN[2]  True: connector diameter = nominal size (DN); False: pipe OD
#   IN[3]  True to leave the discs visible (default hidden)
# Import the STEP into the family with Positioning "Origin to origin" and
# units millimetres, so the file's coordinates line up with the geometry.
import json
import math

import clr
clr.AddReference('RevitAPI')
clr.AddReference('RevitServices')
from Autodesk.Revit.DB import (Arc, BuiltInParameter, ConnectorElement, CurveArray, CurveArrArray,
                               Options, Plane, PlanarFace, SketchPlane, Solid, XYZ)
from Autodesk.Revit.DB.Plumbing import PipeSystemType
from RevitServices.Persistence import DocumentManager
from RevitServices.Transactions import TransactionManager

MM = 1.0 / 304.8  # Revit works in feet
DISC = 1.0 * MM   # disc thickness

doc = DocumentManager.Instance.CurrentDBDocument
path = IN[0]
system_name = IN[1] if len(IN) > 1 and IN[1] else 'OtherPipe'
use_nominal = IN[2] if len(IN) > 2 and IN[2] is not None else True
visible = IN[3] if len(IN) > 3 and IN[3] is not None else False


def xyz(v, scale=1.0):
    return XYZ(v[0] * scale, v[1] * scale, v[2] * scale)


def disc(point, normal, radius):
    """Native extrusion: a disc ending on the plane (point, normal), lying behind it."""
    base = point - normal * DISC
    plane = Plane.CreateByNormalAndOrigin(normal, base)
    sketch = SketchPlane.Create(doc, plane)
    loop = CurveArray()
    loop.Append(Arc.Create(plane, radius, 0.0, math.pi))
    loop.Append(Arc.Create(plane, radius, math.pi, 2.0 * math.pi))
    profile = CurveArrArray()
    profile.Append(loop)
    return doc.FamilyCreate.NewExtrusion(True, profile, sketch, DISC)


def end_face(element, point, normal):
    """The disc's planar face that lies on the end face, with a reference."""
    opts = Options()
    opts.ComputeReferences = True
    for g in element.get_Geometry(opts):
        if not isinstance(g, Solid):
            continue
        for f in g.Faces:
            if isinstance(f, PlanarFace) and f.FaceNormal.IsAlmostEqualTo(normal) \
                    and abs((f.Origin - point).DotProduct(normal)) < 1e-6:
                return f.Reference
    return None


out = []
if not doc.IsFamilyDocument:
    out.append('Open the family (family editor) first – this only works in a family.')
else:
    data = json.load(open(path))
    system = getattr(PipeSystemType, system_name, PipeSystemType.OtherPipe)
    TransactionManager.Instance.EnsureInTransaction(doc)
    for e in data.get('ends', []):
        try:
            point = xyz(e['point'], MM)
            normal = xyz(e['direction']).Normalize()
            od = float(e.get('od') or 0)
            if od <= 0:
                out.append('%s: no size, skipped' % e.get('name'))
                continue
            ext = disc(point, normal, od / 2.0 * MM)
            if not visible:
                p = ext.get_Parameter(BuiltInParameter.IS_VISIBLE_PARAM)
                if p is not None and not p.IsReadOnly:
                    p.Set(0)
            doc.Regenerate()
            ref = end_face(ext, point, normal)
            if ref is None:
                out.append('%s: could not find the disc face' % e.get('name'))
                continue
            conn = ConnectorElement.CreatePipeConnector(doc, system, ref)
            dia = float(e.get('nominal') or od) if use_nominal else od
            for bip in (BuiltInParameter.CONNECTOR_DIAMETER, BuiltInParameter.RBS_PIPE_DIAMETER_PARAM):
                p = conn.get_Parameter(bip)
                if p is not None and not p.IsReadOnly:
                    p.Set(dia * MM)
                    break
            out.append('%s: connector %s mm at %s' % (e.get('name'), dia, e.get('point')))
        except Exception as ex:  # keep going with the other ends
            out.append('%s: %s' % (e.get('name'), ex))
    TransactionManager.Instance.TransactionTaskDone()

OUT = out
