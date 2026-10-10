"""Library of user STEP components.

Each ``part.stp`` may have a sidecar ``part.stp.json`` describing it::

    {
      "name": "Ball valve DN50",
      "category": "Valves",
      "ports": [
        {"name": "A", "origin": [0,0,0], "dir": [-1,0,0], "up": [0,0,1],
         "size": "DN50", "kind": "flange"},
        ...
      ]
    }

Ports can be detected automatically from the circular end faces of the part
and confirmed / edited in the UI.
"""

from __future__ import annotations

import hashlib
import json
import math
import threading
from collections import OrderedDict
from pathlib import Path

import cadquery as cq
import numpy as np
from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.GeomAbs import GeomAbs_Circle

from .pipedata import PipeData

STEP_EXT = (".stp", ".step")
MESH_VERSION = 2

# OpenCascade is not thread safe for everything we do; serialise CAD work.
CAD_LOCK = threading.RLock()


def mesh_shape(shape: cq.Shape, tolerance: float | None = None) -> dict:
    """Triangulate a shape into a compact JSON-friendly mesh (mm)."""
    bb = shape.BoundingBox()
    if tolerance is None:
        tolerance = max(0.05, min(2.0, bb.DiagonalLength / 600))
    verts, tris = shape.tessellate(tolerance, 0.3)
    pos = []
    for v in verts:
        pos += [round(v.x, 3), round(v.y, 3), round(v.z, 3)]
    idx = [i for t in tris for i in t]
    return {
        "positions": pos,
        "indices": idx,
        "bbox": [[bb.xmin, bb.ymin, bb.zmin], [bb.xmax, bb.ymax, bb.zmax]],
    }


def _norm(v):
    n = math.sqrt(sum(c * c for c in v))
    return [c / n for c in v] if n > 1e-12 else [0.0, 0.0, 0.0]


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _sub(a, b):
    return [x - y for x, y in zip(a, b)]


def default_up(direction):
    """Reference vector perpendicular to ``direction``: +Z projected, else +Y."""
    d = _norm(direction)
    for ref in ([0.0, 0.0, 1.0], [0.0, 1.0, 0.0]):
        p = _sub(ref, [c * _dot(ref, d) for c in d])
        if math.sqrt(_dot(p, p)) > 1e-3:
            return _norm(p)
    return [1.0, 0.0, 0.0]


def detect_ports(shape: cq.Shape, mesh: dict, pd: PipeData, standard: str | None = None) -> list[dict]:
    """Find candidate connection points from full circles on the part.

    Returns candidates sorted with the most likely ports (circles centred on
    the extreme end faces of the part) first.  Each candidate carries
    ``likely`` so the UI can pre-select them.
    """
    circles = []
    for e in shape.Edges():
        ad = BRepAdaptor_Curve(e.wrapped)
        if ad.GetType() != GeomAbs_Circle:
            continue
        c = ad.Circle()
        loc, ax = c.Location(), c.Axis().Direction()
        span = abs(ad.LastParameter() - ad.FirstParameter())
        axis = _norm([ax.X(), ax.Y(), ax.Z()])
        # canonical sign so +a and -a group together
        for comp in axis:
            if abs(comp) > 1e-6:
                if comp < 0:
                    axis = [-x for x in axis]
                break
        circles.append(([loc.X(), loc.Y(), loc.Z()], axis, c.Radius(), span))

    pts = mesh["positions"]
    verts = np.asarray(pts, dtype=float).reshape(-1, 3) if pts else np.zeros((1, 3))
    bb = mesh["bbox"]
    extent = math.dist(bb[0], bb[1]) or 1.0
    tol = max(0.5, extent * 0.002)

    # group circles by centre + axis
    groups: list[dict] = []
    for centre, axis, radius, span in circles:
        for g in groups:
            if math.dist(g["centre"], centre) < tol and abs(abs(_dot(g["axis"], axis)) - 1) < 1e-4:
                g["radii"].setdefault(round(radius, 2), 0.0)
                g["radii"][round(radius, 2)] += span
                break
        else:
            groups.append({"centre": centre, "axis": axis, "radii": {round(radius, 2): span}})

    cands = []
    for g in groups:
        full = [r for r, s in g["radii"].items() if s >= 2 * math.pi - 0.05]
        if not full:
            continue
        a = g["axis"]
        r_max = max(full)

        off = verts - np.asarray(g["centre"])
        h = off @ np.asarray(a)
        near = (np.einsum("ij,ij->i", off, off) - h * h) < (r_max * 1.02) ** 2

        def blocked(sign):
            # is any part geometry in front of this circle (within its radius)?
            return bool(np.any(near & (h * sign > tol)))

        if not blocked(1):
            direction, likely = a, True
        elif not blocked(-1):
            direction, likely = [-x for x in a], True
        else:
            # interior circle: unlikely to be a connection, point to the nearer extremity
            direction, likely = (a if h.max() < -h.min() else [-x for x in a]), False
        cands.append({
            "origin": [round(x, 3) for x in g["centre"]],
            "dir": [round(x, 6) for x in direction],
            "diameters": sorted([2 * r for r in full], reverse=True),
            "likely": likely,
            "axis": a,
        })

    # drop circles (bolt holes etc.) lying off-axis inside a larger parallel circle
    def inside_other(c):
        for o in cands:
            if o is c or abs(abs(_dot(o["axis"], c["axis"])) - 1) > 1e-4:
                continue
            off = _sub(c["origin"], o["origin"])
            dist = math.sqrt(max(_dot(off, off) - _dot(off, o["axis"]) ** 2, 0))
            if tol < dist < o["diameters"][0] / 2 and o["diameters"][0] > c["diameters"][0]:
                return True
        return False

    result = [c for c in cands if not inside_other(c)]
    for c in result:
        c["size"] = pd.guess_size(c["diameters"], standard)
        c["up"] = [round(x, 6) for x in default_up(c["dir"])]
        c.pop("axis", None)
    result.sort(key=lambda c: (not c["likely"], -c["diameters"][0]))
    return result


class Library:
    def __init__(self, root: Path | str, pd: PipeData):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.cache_dir = self.root / ".cache"
        self.pd = pd
        self._shapes: OrderedDict[str, tuple[float, cq.Shape]] = OrderedDict()
        self._max_shapes = 40

    # --------------------------------------------------------------- listing
    def _path(self, part_id: str) -> Path:
        p = (self.root / part_id).resolve()
        if self.root.resolve() not in p.parents or p.suffix.lower() not in STEP_EXT:
            raise ValueError(f"Invalid part id {part_id!r}")
        if not p.exists():
            raise FileNotFoundError(part_id)
        return p

    def list(self) -> list[dict]:
        out = []
        for p in sorted(self.root.rglob("*")):
            if p.suffix.lower() not in STEP_EXT or ".cache" in p.parts:
                continue
            rel = p.relative_to(self.root).as_posix()
            meta = self.meta(rel)
            out.append(meta)
        return out

    def meta(self, part_id: str) -> dict:
        p = self._path(part_id)
        side = p.with_name(p.name + ".json")
        meta = {}
        if side.exists():
            with open(side, encoding="utf-8") as f:
                meta = json.load(f)
        rel_parent = Path(part_id).parent.as_posix()
        return {
            "id": part_id,
            "file": p.name,
            "name": meta.get("name") or p.stem.replace("_", " "),
            "category": meta.get("category") or ("" if rel_parent == "." else rel_parent),
            "ports": meta.get("ports", []),
            "configured": bool(meta.get("ports")),
            "notes": meta.get("notes", ""),
        }

    def save_meta(self, part_id: str, meta: dict) -> dict:
        p = self._path(part_id)
        ports = []
        for i, prt in enumerate(meta.get("ports", [])):
            d = _norm([float(x) for x in prt["dir"]])
            up = prt.get("up") or default_up(d)
            # re-orthogonalise up against dir
            up = _sub(up, [c * _dot(up, d) for c in d])
            up = _norm(up) if math.sqrt(_dot(up, up)) > 1e-6 else default_up(d)
            ports.append({
                "name": str(prt.get("name") or chr(65 + i)),
                "origin": [float(x) for x in prt["origin"]],
                "dir": d,
                "up": up,
                "size": prt.get("size") or None,
                "kind": prt.get("kind") or "flange",
            })
        data = {
            "name": meta.get("name") or p.stem,
            "category": meta.get("category", ""),
            "notes": meta.get("notes", ""),
            "ports": ports,
        }
        with open(p.with_name(p.name + ".json"), "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        return self.meta(part_id)

    def add_file(self, filename: str, content: bytes, folder: str = "") -> str:
        name = Path(filename).name
        if Path(name).suffix.lower() not in STEP_EXT:
            raise ValueError("Only .stp / .step files can be added")
        target_dir = (self.root / folder).resolve() if folder else self.root.resolve()
        if target_dir != self.root.resolve() and self.root.resolve() not in target_dir.parents:
            raise ValueError("Invalid folder")
        target_dir.mkdir(parents=True, exist_ok=True)
        (target_dir / name).write_bytes(content)
        return (target_dir / name).relative_to(self.root.resolve()).as_posix()

    # ---------------------------------------------------------------- shapes
    def shape(self, part_id: str) -> cq.Shape:
        p = self._path(part_id)
        mtime = p.stat().st_mtime
        hit = self._shapes.get(part_id)
        if hit and hit[0] == mtime:
            self._shapes.move_to_end(part_id)
            return hit[1]
        with CAD_LOCK:
            wp = cq.importers.importStep(str(p))
            vals = [v for v in wp.vals() if isinstance(v, cq.Shape)]
            if not vals:
                raise ValueError(f"No geometry found in {part_id}")
            shape = vals[0] if len(vals) == 1 else cq.Compound.makeCompound(vals)
        self._shapes[part_id] = (mtime, shape)
        while len(self._shapes) > self._max_shapes:
            self._shapes.popitem(last=False)
        return shape

    def _cache_file(self, part_id: str, kind: str) -> Path:
        p = self._path(part_id)
        st = p.stat()
        key = f"{MESH_VERSION}|{part_id}|{st.st_mtime}|{st.st_size}|{kind}"
        return self.cache_dir / (hashlib.sha1(key.encode()).hexdigest() + ".json")

    def mesh(self, part_id: str) -> dict:
        cf = self._cache_file(part_id, "mesh")
        if cf.exists():
            with open(cf, encoding="utf-8") as f:
                return json.load(f)
        with CAD_LOCK:
            m = mesh_shape(self.shape(part_id))
        self.cache_dir.mkdir(exist_ok=True)
        with open(cf, "w", encoding="utf-8") as f:
            json.dump(m, f)
        return m

    def detect(self, part_id: str, standard: str | None = None) -> list[dict]:
        with CAD_LOCK:
            return detect_ports(self.shape(part_id), self.mesh(part_id), self.pd, standard)
