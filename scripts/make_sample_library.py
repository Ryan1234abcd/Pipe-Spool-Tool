"""Generate a few simple sample STEP components for trying the tool.

Deliberately modelled in "awkward" local coordinates (axis along Y, origin at
the body centre) like real manufacturer downloads, to exercise port detection.

    python scripts/make_sample_library.py [library_dir]
"""

import sys
from pathlib import Path

import cadquery as cq

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from spooltool.fittings import make_flange_blind  # noqa: E402
from spooltool.pipedata import PipeData  # noqa: E402

pd = PipeData()


def flange_y(size, y0, sign):
    """Short flange (no hub) with its raised face at y = y0, facing sign*Y."""
    shape, _ = make_flange_blind(pd, size)  # face at origin facing -X, body towards +X
    shape = shape.rotate(cq.Vector(0, 0, 0), cq.Vector(0, 0, 1), 90 if sign < 0 else -90)
    return cq.Workplane("XY").add(shape.translate(cq.Vector(0, y0, 0)))


def bore(size, length):
    return cq.Workplane("XZ").circle(pd.id(size) / 2).extrude(length / 2, both=True)


def ball_valve(size="DN50", ftf=178):
    od = pd.od(size)
    body = cq.Workplane("XY").sphere(od * 0.9)
    neck = cq.Workplane("XZ").circle(od * 0.62).extrude(ftf / 2 - 5, both=True)
    v = body.union(neck).union(flange_y(size, ftf / 2, 1)).union(flange_y(size, -ftf / 2, -1))
    stem = cq.Workplane("XY").circle(od * 0.15).extrude(od * 1.3)
    lever = cq.Workplane("XY").workplane(offset=od * 1.3).center(od * 1.2, 0).box(od * 3, 12, 8)
    return v.union(stem).union(lever).cut(bore(size, ftf + 10))


def globe_valve_weld(size="DN50", ftf=230):
    od = pd.od(size)
    body = cq.Workplane("XY").sphere(od * 1.0)
    ends = cq.Workplane("XZ").circle(od / 2).extrude(ftf / 2, both=True)
    bonnet = cq.Workplane("XY").circle(od * 0.45).extrude(od * 2.2)
    wheel = (cq.Workplane("XY").workplane(offset=od * 2.2).circle(od * 1.1).circle(od * 0.9)
             .extrude(15))
    spokes = (cq.Workplane("XY").workplane(offset=od * 2.2).rect(od * 2.0, 10).extrude(12)
              .union(cq.Workplane("XY").workplane(offset=od * 2.2).rect(10, od * 2.0).extrude(12)))
    return body.union(ends).union(bonnet).union(wheel).union(spokes).cut(bore(size, ftf + 10))


def y_strainer(size="DN80", ftf=310):
    od = pd.od(size)
    body = cq.Workplane("XZ").circle(od * 0.75).extrude(ftf / 2 - 30, both=True)
    leg = (cq.Workplane("XY").transformed(rotate=(-45, 0, 0)).circle(od * 0.55)
           .extrude(-od * 2.2))
    v = (body.union(leg).union(flange_y(size, ftf / 2, 1)).union(flange_y(size, -ftf / 2, -1))
         .union(cq.Workplane("XZ").circle(od * 0.62).extrude(ftf / 2 - 5, both=True)))
    return v.cut(bore(size, ftf + 10))


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "library") / "Samples"
    out.mkdir(parents=True, exist_ok=True)
    parts = {
        "Ball_valve_flanged_DN50.stp": ball_valve(),
        "Globe_valve_weld_DN50.stp": globe_valve_weld(),
        "Y_strainer_flanged_DN80.stp": y_strainer(),
    }
    for name, wp in parts.items():
        cq.exporters.export(wp, str(out / name), "STEP")
        print("wrote", out / name)


if __name__ == "__main__":
    main()
