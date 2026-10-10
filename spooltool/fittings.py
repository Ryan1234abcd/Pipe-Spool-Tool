"""Parametric pipe, fitting and flange solids.

Every generator returns ``(shape, ports)`` in the component's *local*
coordinate system.  Conventions shared with the web UI (web/js/kinematics.js):

* Port ``A`` sits at the origin and points along ``-X`` (outwards); tees are
  modelled about their centre instead.
* ``dir`` is the outward direction of a port, ``up`` a reference vector
  perpendicular to it that defines roll (``+Z`` wherever possible).
* All dimensions are millimetres.
"""

from __future__ import annotations

import math

import cadquery as cq

from .pipedata import PipeData

Z_UP = [0.0, 0.0, 1.0]

# type -> human label, list of size parameters used
FITTING_TYPES = {
    "pipe": "Pipe",
    "elbow90": "Elbow 90° LR",
    "elbow90sr": "Elbow 90° SR",
    "elbow45": "Elbow 45° LR",
    "tee": "Tee",
    "reducer": "Reducer (concentric)",
    "reducer_ecc": "Reducer (eccentric)",
    "flange_wn": "Weld neck flange",
    "flange_blind": "Blind flange",
    "cap": "Cap",
}


def port(name, origin, direction, size, kind="weld", up=None):
    return {
        "name": name,
        "origin": [float(v) for v in origin],
        "dir": [float(v) for v in direction],
        "up": [float(v) for v in (up or Z_UP)],
        "size": size,
        "kind": kind,
    }


def _v(*a):
    return cq.Vector(*a)


def _tube_along_x(od, idia, x0, length, hollow=True):
    outer = cq.Solid.makeCylinder(od / 2, length, _v(x0, 0, 0), _v(1, 0, 0))
    if hollow and idia > 0:
        inner = cq.Solid.makeCylinder(idia / 2, length + 2, _v(x0 - 1, 0, 0), _v(1, 0, 0))
        return outer.cut(inner)
    return outer


def make_pipe(pd: PipeData, size, length, standard=None, schedule=None, hollow=True):
    length = float(length)
    if length <= 0:
        raise ValueError("Pipe length must be greater than zero")
    od = pd.od(size, standard)
    shape = _tube_along_x(od, pd.id(size, standard, schedule), 0, length, hollow)
    ports = [
        port("A", [0, 0, 0], [-1, 0, 0], size),
        port("B", [length, 0, 0], [1, 0, 0], size),
    ]
    return shape, ports


def make_elbow(pd: PipeData, size, angle=90.0, radius_key="elbow90LR", standard=None,
               schedule=None, hollow=True):
    """Elbow in the XY plane, entering at A (origin, along +X) turning towards +Y."""
    od = pd.od(size, standard)
    idia = pd.id(size, standard, schedule)
    a = math.radians(angle)
    if radius_key == "elbow45LR":
        # B16.9 gives centre-to-end B for 45 elbows; bend radius R = B / tan(22.5)
        radius = pd.fitting(size, "elbow45LR") / math.tan(a / 2)
    else:
        radius = pd.fitting(size, radius_key)
    centre_start = _v(0, radius, 0)
    centre_end = _v(0, radius, 1)
    outer = cq.Wire.makeCircle(od / 2, _v(0, 0, 0), _v(1, 0, 0))
    inner = [cq.Wire.makeCircle(idia / 2, _v(0, 0, 0), _v(1, 0, 0))] if hollow else []
    shape = cq.Solid.revolve(outer, inner, angle, centre_start, centre_end)
    end = [radius * math.sin(a), radius * (1 - math.cos(a)), 0]
    ports = [
        port("A", [0, 0, 0], [-1, 0, 0], size),
        port("B", end, [math.cos(a), math.sin(a), 0], size),
    ]
    return shape, ports


def make_tee(pd: PipeData, size, branch=None, standard=None, schedule=None, hollow=True):
    branch = branch or size
    od = pd.od(size, standard)
    idia = pd.id(size, standard, schedule)
    bod = pd.od(branch, standard)
    bid = pd.id(branch, standard, schedule)
    if bod > od:
        raise ValueError("Tee branch cannot be larger than the run")
    c = pd.fitting(size, "teeC")
    run = cq.Solid.makeCylinder(od / 2, 2 * c, _v(-c, 0, 0), _v(1, 0, 0))
    br = cq.Solid.makeCylinder(bod / 2, c, _v(0, 0, 0), _v(0, 1, 0))
    shape = run.fuse(br)
    if hollow:
        # Equal-radius bores meet in a singular saddle that does not survive a
        # STEP round trip, so keep the branch bore fractionally smaller.
        bid = min(bid, idia - 0.5)
        run_bore = cq.Solid.makeCylinder(idia / 2, 2 * c + 2, _v(-c - 1, 0, 0), _v(1, 0, 0))
        br_bore = cq.Solid.makeCylinder(bid / 2, c + 1, _v(0, 0, 0), _v(0, 1, 0))
        shape = shape.cut(run_bore).cut(br_bore)
    shape = shape.clean()
    ports = [
        port("A", [-c, 0, 0], [-1, 0, 0], size),
        port("B", [c, 0, 0], [1, 0, 0], size),
        port("C", [0, c, 0], [0, 1, 0], branch),
    ]
    return shape, ports


def make_reducer(pd: PipeData, size, small, eccentric=False, standard=None, schedule=None,
                 hollow=True):
    """Large end A at origin, small end B at +X.  Eccentric: flat side on +Z."""
    if not small or small == size:
        raise ValueError("Reducer needs a smaller second size")
    od1, od2 = pd.od(size, standard), pd.od(small, standard)
    if od2 >= od1:
        raise ValueError("Reducer small end must be smaller than the large end")
    id1, id2 = pd.id(size, standard, schedule), pd.id(small, standard, schedule)
    h = pd.fitting(size, "reducerH")
    off = (od1 - od2) / 2 if eccentric else 0.0

    w1 = cq.Wire.makeCircle(od1 / 2, _v(0, 0, 0), _v(1, 0, 0))
    w2 = cq.Wire.makeCircle(od2 / 2, _v(h, 0, off), _v(1, 0, 0))
    shape = cq.Solid.makeLoft([w1, w2], True)
    if hollow:
        # inner offset follows the outer flat so wall thickness stays similar
        shape = shape.cut(_inner_loft(id1, id2, h, off))
    ports = [
        port("A", [0, 0, 0], [-1, 0, 0], size),
        port("B", [h, 0, off], [1, 0, 0], small),
    ]
    return shape, ports


def _inner_loft(d1, d2, h, off):
    w0 = cq.Wire.makeCircle(d1 / 2, _v(-1, 0, 0), _v(1, 0, 0))
    w1 = cq.Wire.makeCircle(d1 / 2, _v(0, 0, 0), _v(1, 0, 0))
    w2 = cq.Wire.makeCircle(d2 / 2, _v(h, 0, off), _v(1, 0, 0))
    w3 = cq.Wire.makeCircle(d2 / 2, _v(h + 1, 0, off), _v(1, 0, 0))
    return cq.Solid.makeLoft([w0, w1, w2, w3], True)


def _bolt_holes(fl: dict, x0: float, length: float):
    n = int(fl["boltCount"])
    r = float(fl["boltPCD"]) / 2
    holes = []
    for k in range(n):
        # holes straddle the vertical centre line (no hole on top dead centre)
        ang = math.pi / n + k * 2 * math.pi / n
        y, z = r * math.sin(ang), r * math.cos(ang)
        holes.append(cq.Solid.makeCylinder(float(fl["boltHole"]) / 2, length + 2,
                                           _v(x0 - 1, y, z), _v(1, 0, 0)))
    return holes


def make_flange_wn(pd: PipeData, size, standard=None, schedule=None, hollow=True, bolt_holes=True):
    """Weld neck flange: weld end A at origin, raised face B at +X."""
    fl = pd.flange(size)
    od = pd.od(size, standard)
    idia = pd.id(size, standard, schedule)
    y, t, rf = float(fl["wnLength"]), float(fl["thickness"]), float(fl["rfHeight"])
    hub_len = y - t
    hub = cq.Solid.makeCone(od / 2, float(fl["hubDia"]) / 2, hub_len, _v(0, 0, 0), _v(1, 0, 0))
    disk = cq.Solid.makeCylinder(float(fl["od"]) / 2, t - rf, _v(hub_len, 0, 0), _v(1, 0, 0))
    face = cq.Solid.makeCylinder(float(fl["rfDia"]) / 2, rf, _v(y - rf, 0, 0), _v(1, 0, 0))
    shape = hub.fuse(disk, face)
    cuts = []
    if hollow:
        cuts.append(cq.Solid.makeCylinder(idia / 2, y + 2, _v(-1, 0, 0), _v(1, 0, 0)))
    if bolt_holes:
        cuts += _bolt_holes(fl, hub_len, t)
    if cuts:
        shape = shape.cut(*cuts)
    shape = shape.clean()
    ports = [
        port("A", [0, 0, 0], [-1, 0, 0], size, "weld"),
        port("B", [y, 0, 0], [1, 0, 0], size, "flange"),
    ]
    return shape, ports


def make_flange_blind(pd: PipeData, size, bolt_holes=True, **_):
    """Blind flange: raised face (port A) at origin, back face at +X."""
    fl = pd.flange(size)
    t, rf = float(fl["thickness"]), float(fl["rfHeight"])
    face = cq.Solid.makeCylinder(float(fl["rfDia"]) / 2, rf, _v(0, 0, 0), _v(1, 0, 0))
    disk = cq.Solid.makeCylinder(float(fl["od"]) / 2, t - rf, _v(rf, 0, 0), _v(1, 0, 0))
    shape = face.fuse(disk)
    if bolt_holes:
        shape = shape.cut(*_bolt_holes(fl, rf, t - rf))
    shape = shape.clean()
    return shape, [port("A", [0, 0, 0], [-1, 0, 0], size, "flange")]


def make_cap(pd: PipeData, size, standard=None, **_):
    """Butt-weld cap (2:1 elliptical head style).  Port A at origin."""
    od = pd.od(size, standard)
    e = pd.fitting(size, "capE")
    r = od / 2
    depth = min(e * 0.75, r / 2)
    straight = max(e - depth, 0.1)
    # profile in the XY plane (x = axial, y = radial), revolved about X
    pts = [_v(straight + depth * math.sin(t), r * math.cos(t), 0)
           for t in [i * (math.pi / 2) / 12 for i in range(13)]]
    edges = [
        cq.Edge.makeLine(_v(0, 0, 0), _v(0, r, 0)),
        cq.Edge.makeLine(_v(0, r, 0), _v(straight, r, 0)),
        cq.Edge.makeSpline(pts),
        cq.Edge.makeLine(_v(straight + depth, 0, 0), _v(0, 0, 0)),
    ]
    wire = cq.Wire.assembleEdges(edges)
    shape = cq.Solid.revolve(wire, [], 360, _v(0, 0, 0), _v(1, 0, 0))
    return shape, [port("A", [0, 0, 0], [-1, 0, 0], size)]


def make_fitting(pd: PipeData, params: dict):
    """Dispatch on ``params['type']``.  Returns (cq.Shape, ports)."""
    t = params.get("type")
    size = params.get("size")
    common = dict(
        standard=params.get("standard"),
        schedule=params.get("schedule"),
        hollow=params.get("hollow", True),
    )
    if not size:
        raise ValueError("Component has no size")
    if t == "pipe":
        return make_pipe(pd, size, params.get("length", 0), **common)
    if t == "elbow90":
        return make_elbow(pd, size, 90, "elbow90LR", **common)
    if t == "elbow90sr":
        return make_elbow(pd, size, 90, "elbow90SR", **common)
    if t == "elbow45":
        return make_elbow(pd, size, 45, "elbow45LR", **common)
    if t == "tee":
        return make_tee(pd, size, params.get("size2") or size, **common)
    if t == "reducer":
        return make_reducer(pd, size, params.get("size2"), False, **common)
    if t == "reducer_ecc":
        return make_reducer(pd, size, params.get("size2"), True, **common)
    if t == "flange_wn":
        return make_flange_wn(pd, size, bolt_holes=params.get("boltHoles", True), **common)
    if t == "flange_blind":
        return make_flange_blind(pd, size, bolt_holes=params.get("boltHoles", True), **common)
    if t == "cap":
        return make_cap(pd, size, **common)
    raise ValueError(f"Unknown fitting type {t!r}")
