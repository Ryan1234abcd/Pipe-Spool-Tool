# Runs revit/spool_family.py against a small fake of the Revit API, to catch
# mistakes without Revit: geometry built in the right planes, no curve shorter
# than Revit allows, a connector and references on every end.
# Usage: python3 -I tests/revit_stub.py <spool-revit.json>   (exit 1 on a problem)
import json
import math
import os
import sys
import types

MM = 1.0 / 304.8
SHORT = 0.78 * MM  # Revit's short curve tolerance (1/256 ft ~ 0.0026 ft)
problems = []


class XYZ:
    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.X, self.Y, self.Z = float(x), float(y), float(z)

    def Add(self, o): return XYZ(self.X + o.X, self.Y + o.Y, self.Z + o.Z)
    def Subtract(self, o): return XYZ(self.X - o.X, self.Y - o.Y, self.Z - o.Z)
    def Multiply(self, s): return XYZ(self.X * s, self.Y * s, self.Z * s)
    def DotProduct(self, o): return self.X * o.X + self.Y * o.Y + self.Z * o.Z

    def CrossProduct(self, o):
        return XYZ(self.Y * o.Z - self.Z * o.Y, self.Z * o.X - self.X * o.Z, self.X * o.Y - self.Y * o.X)

    def GetLength(self): return math.sqrt(self.DotProduct(self))
    def DistanceTo(self, o): return self.Subtract(o).GetLength()

    def Normalize(self):
        L = self.GetLength()
        return self.Multiply(1.0 / L) if L > 1e-12 else XYZ()

    def __add__(self, o): raise TypeError('use XYZ.Add (operators on .NET types are unreliable in Dynamo)')
    __sub__ = __mul__ = __add__


class Plane:
    def __init__(self, origin, normal, x=None, y=None):
        self.Origin, self.Normal, self.XVec, self.YVec = origin, normal.Normalize(), x, y

    @staticmethod
    def CreateByNormalAndOrigin(normal, origin):
        if normal.GetLength() < 1e-9:
            raise ValueError('zero normal')
        return Plane(origin, normal)

    @staticmethod
    def CreateByOriginAndBasis(origin, x, y):
        if abs(x.DotProduct(y)) > 1e-9 or abs(x.GetLength() - 1) > 1e-9 or abs(y.GetLength() - 1) > 1e-9:
            raise ValueError('basis must be orthonormal')
        return Plane(origin, x.CrossProduct(y), x, y)

    def dist(self, p): return abs(p.Subtract(self.Origin).DotProduct(self.Normal))


class Line:
    def __init__(self, a, b): self.a, self.b = a, b

    @staticmethod
    def CreateBound(a, b):
        if a.DistanceTo(b) < SHORT:
            raise ValueError('Curve length is too small for Revit\'s tolerance')
        return Line(a, b)

    def points(self): return [self.a, self.b]


class Arc:
    def __init__(self, plane, r, a0, a1): self.plane, self.r, self.a0, self.a1 = plane, r, a0, a1

    @staticmethod
    def Create(plane, r, a0, a1):
        if plane.XVec is None:  # Revit picks a basis for a plane made from a normal
            n = plane.Normal
            x = XYZ(0, 0, 1).CrossProduct(n) if abs(n.Z) < 0.9 else XYZ(1, 0, 0).CrossProduct(n)
            plane.XVec = x.Normalize()
            plane.YVec = n.CrossProduct(plane.XVec)
        return Arc(plane, r, a0, a1)

    def points(self):
        p = self.plane
        return [p.Origin.Add(p.XVec.Multiply(self.r * math.cos(a))).Add(p.YVec.Multiply(self.r * math.sin(a)))
                for a in (self.a0, (self.a0 + self.a1) / 2, self.a1)]


class CurveArray(list):
    def Append(self, c): self.append(c)


class CurveArrArray(list):
    def Append(self, c): self.append(c)


class SketchPlane:
    def __init__(self, plane): self.plane = plane

    @staticmethod
    def Create(doc, plane): return SketchPlane(plane)


class Reference:
    def __init__(self, owner): self.owner = owner


class PlanarFace:
    def __init__(self, owner, origin, normal, radius):
        self.Origin, self.FaceNormal, self.radius = origin, normal.Normalize(), radius
        self.Reference = Reference(owner)

    def Project(self, p):
        off = p.Subtract(self.Origin)
        h = off.DotProduct(self.FaceNormal)
        lateral = off.Subtract(self.FaceNormal.Multiply(h)).GetLength()
        if lateral > self.radius + 1e-9:
            return None
        return types.SimpleNamespace(Distance=abs(h))


class Solid:
    def __init__(self, faces, centroid): self.Faces, self.centroid, self.Volume = faces, centroid, 1.0
    def ComputeCentroid(self): return self.centroid


class Element:
    _ids = [0]

    def __init__(self, kind, **kw):
        Element._ids[0] += 1
        self.Id, self.kind, self.solids, self.params = Element._ids[0], kind, [], {}
        self.__dict__.update(kw)

    def get_Geometry(self, opts):
        assert opts.ComputeReferences, 'face references need ComputeReferences'
        return list(self.solids)

    def get_Parameter(self, bip):
        return self.params.setdefault(bip, types.SimpleNamespace(IsReadOnly=False, value=None, Set=lambda v, b=bip: self.params[b].__dict__.update(value=v)))

    def ChangeToReferenceLine(self): self.kind = 'reference line'


def in_plane(curves, plane, what):
    for c in curves:
        for p in c.points():
            if plane.dist(p) > 1e-7:
                problems.append('%s: a profile point is %.4f mm off its sketch plane' % (what, plane.dist(p) / MM))


class FamilyCreate:
    def __init__(self, doc): self.doc = doc

    def NewExtrusion(self, solid, profile, sketch, depth):
        loop = profile[0]
        in_plane(loop, sketch.plane, 'extrusion')
        pl = sketch.plane
        pts = [p for c in loop for p in c.points()]
        centre = pts[0]
        for p in pts[1:]:
            centre = centre.Add(p)
        centre = centre.Multiply(1.0 / len(pts))
        radius = max(p.DistanceTo(centre) for p in pts)
        el = Element('extrusion', depth=depth)
        top = centre.Add(pl.Normal.Multiply(depth))
        el.solids = [Solid([PlanarFace(el, centre, pl.Normal.Multiply(-1), radius), PlanarFace(el, top, pl.Normal, radius)],
                           centre.Add(pl.Normal.Multiply(depth / 2)))]
        self.doc.created.append(el)
        return el

    def NewRevolution(self, solid, profile, sketch, axis, a0, a1):
        loop = profile[0]
        pl = sketch.plane
        in_plane(loop, pl, 'revolution')
        in_plane([axis], pl, 'revolution axis')
        o, d = axis.a, axis.b.Subtract(axis.a).Normalize()
        el = Element('revolution', angle=a1 - a0)
        if a1 - a0 < 2 * math.pi - 1e-9:  # ring segment: end faces of the turned circle
            arc = loop[0]
            c0 = arc.plane.Origin
            radial = c0.Subtract(o).Subtract(d.Multiply(c0.Subtract(o).DotProduct(d)))
            R = radial.GetLength()
            x = radial.Normalize()
            y = d.CrossProduct(x)
            th = a1 - a0
            cen = o.Add(d.Multiply(c0.Subtract(o).DotProduct(d)))
            end = cen.Add(x.Multiply(R * math.cos(th))).Add(y.Multiply(R * math.sin(th)))
            t_end = x.Multiply(-math.sin(th)).Add(y.Multiply(math.cos(th)))
            k = math.sin(th / 2) / (th / 2)
            centroid = cen.Add(x.Multiply(R * k * math.cos(th / 2))).Add(y.Multiply(R * k * math.sin(th / 2)))
            el.solids = [Solid([PlanarFace(el, c0, y.Multiply(-1), arc.r), PlanarFace(el, end, t_end, arc.r)], centroid)]
        else:
            # faces square to the axis: the profile's edges at one station, facing out of the profile
            pts = [(p.Subtract(o).DotProduct(d), p.Subtract(o).Subtract(d.Multiply(p.Subtract(o).DotProduct(d))).GetLength())
                   for c in loop for p in c.points()[:1]]
            area = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
            faces = []
            for i in range(len(pts)):
                (h1, r1), (h2, r2) = pts[i], pts[(i + 1) % len(pts)]
                if abs(h1 - h2) < 1e-9 and abs(r1 - r2) > 1e-9:
                    sign = (r2 - r1) * (1 if area > 0 else -1)
                    faces.append(PlanarFace(el, o.Add(d.Multiply(h1)), d.Multiply(1 if sign > 0 else -1), max(r1, r2)))
            el.solids = [Solid(faces, o)]
        for c in loop:
            for a, b in zip(c.points(), c.points()[1:]):
                if isinstance(c, Line) and a.DistanceTo(b) < SHORT:
                    problems.append('revolution: an edge shorter than Revit allows')
        self.doc.created.append(el)
        return el

    def NewModelCurve(self, line, sketch):
        in_plane([line], sketch.plane, 'model curve')
        el = Element('model line', line=line)
        self.doc.created.append(el)
        return el

    def NewReferencePlane(self, bubble, free, cut, view):
        if view is None:
            raise ValueError('needs a view')
        el = Element('reference plane', origin=bubble.Add(free).Multiply(0.5))
        self.doc.created.append(el)
        return el


class Doc:
    IsFamilyDocument = True

    def __init__(self):
        self.created, self.connectors = [], []
        self.FamilyCreate = FamilyCreate(self)
        self.ActiveView = object()

    def Regenerate(self): pass
    def Delete(self, eid): self.created = [e for e in self.created if e.Id != eid]


doc = Doc()


class ConnectorElement:
    @staticmethod
    def CreatePipeConnector(d, system, ref):
        el = Element('connector', host=ref.owner, system=system)
        doc.connectors.append(el)
        return el


def module(name, **attrs):
    m = types.ModuleType(name)
    m.__dict__.update(attrs)
    sys.modules[name] = m
    return m


class FilteredElementCollector(list):
    def __init__(self, d): super().__init__()
    def OfClass(self, cls): return self


module('clr', AddReference=lambda name: None)
module('Autodesk')
module('Autodesk.Revit')
module('Autodesk.Revit.DB', Arc=Arc, BuiltInParameter=types.SimpleNamespace(
    IS_VISIBLE_PARAM='visible', CONNECTOR_DIAMETER='dia', RBS_PIPE_DIAMETER_PARAM='pipe dia'),
    ConnectorElement=ConnectorElement, CurveArray=CurveArray, CurveArrArray=CurveArrArray, Line=Line,
    Options=lambda: types.SimpleNamespace(ComputeReferences=False), Plane=Plane, PlanarFace=PlanarFace,
    SketchPlane=SketchPlane, Solid=Solid, ViewPlan=object, XYZ=XYZ, FilteredElementCollector=FilteredElementCollector)
module('Autodesk.Revit.DB.Plumbing', PipeSystemType=types.SimpleNamespace(OtherPipe='OtherPipe', SupplyHydronic='SupplyHydronic'))
module('RevitServices')
module('RevitServices.Persistence', DocumentManager=types.SimpleNamespace(Instance=types.SimpleNamespace(CurrentDBDocument=doc)))
module('RevitServices.Transactions', TransactionManager=types.SimpleNamespace(Instance=types.SimpleNamespace(
    EnsureInTransaction=lambda d: None, TransactionTaskDone=lambda: None)))

path = sys.argv[1]
script = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'revit', 'spool_family.py')
env = {'IN': [path, 'OtherPipe', True, False], '__name__': 'dynamo'}
exec(compile(open(script).read(), script, 'exec'), env)

data = json.load(open(path))
out = env['OUT']
for line in out:
    print(line)
ends = data['ends']
if any('could not' in s or 'no face' in s or 'skipped' in s for s in out):
    problems.append('the script reported a failure')
if len([s for s in out if ': connector ' in s]) != len(ends):
    problems.append('not every end got a connector line in OUT')
if len(doc.connectors) != len(ends):
    problems.append('%d connectors for %d ends' % (len(doc.connectors), len(ends)))
for e, c in zip(ends, doc.connectors):
    if e.get('native') and c.host.kind == 'extrusion' and getattr(c.host, 'depth', 0) == 1.0 * MM:
        problems.append('%s: native end got a disc' % e['name'])
    if c.params.get('dia') is None or c.params['dia'].value is None:
        problems.append('%s: connector not sized' % e['name'])
lines = [e for e in doc.created if e.kind == 'reference line']
planes = [e for e in doc.created if e.kind == 'reference plane']
if len(lines) != len(ends) or len(planes) != len(ends):
    problems.append('%d reference lines and %d planes for %d ends' % (len(lines), len(planes), len(ends)))
n_prims = sum(len(s['prims']) for s in data.get('solids', []))
n_solids = len([e for e in doc.created if e.kind in ('extrusion', 'revolution')]) - sum(1 for c in doc.connectors if c.host.kind == 'extrusion' and getattr(c.host, 'depth', 0) == 1.0 * MM)
if n_solids != n_prims:
    problems.append('%d native solids for %d primitives' % (n_solids, n_prims))
for p in problems:
    print('PROBLEM:', p)
sys.exit(1 if problems else 0)
