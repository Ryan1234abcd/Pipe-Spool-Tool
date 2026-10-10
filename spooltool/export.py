"""Assemble a configured spool into one STEP file."""

from __future__ import annotations

import os
import tempfile

import cadquery as cq
from OCP.gp import gp_Trsf
from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

from .fittings import make_fitting
from .library import CAD_LOCK, Library
from .pipedata import PipeData


def matrix_location(m) -> cq.Location:
    """Row-major 4x4 (or 3x4) rigid transform -> cq.Location."""
    t = gp_Trsf()
    t.SetValues(
        float(m[0][0]), float(m[0][1]), float(m[0][2]), float(m[0][3]),
        float(m[1][0]), float(m[1][1]), float(m[1][2]), float(m[1][3]),
        float(m[2][0]), float(m[2][1]), float(m[2][2]), float(m[2][3]),
    )
    return cq.Location(t)


def component_shape(item: dict, pd: PipeData, lib: Library, hollow: bool) -> cq.Shape:
    if item.get("type") == "part":
        return lib.shape(item["part"])
    params = dict(item)
    params["hollow"] = hollow
    shape, _ = make_fitting(pd, params)
    return shape


def build_spool(items: list[dict], pd: PipeData, lib: Library, *, fuse=True, hollow=True):
    """Place every component and optionally fuse them into a single solid.

    ``items``: ``[{type, size, ..., matrix: [[...]x4]}]`` where ``matrix`` is
    the world transform computed by the UI.  Returns ``(shape, warnings)``.
    """
    warnings: list[str] = []
    placed = []
    with CAD_LOCK:
        for it in items:
            shape = component_shape(it, pd, lib, hollow)
            placed.append(shape.moved(matrix_location(it["matrix"])))
        if not placed:
            raise ValueError("The spool is empty")
        result = None
        if fuse and len(placed) > 1:
            try:
                fused = placed[0].fuse(*placed[1:])
                try:
                    fused = fused.clean()
                except Exception:  # clean() is cosmetic only
                    pass
                if fused.isValid():
                    result = fused
                else:
                    warnings.append("Boolean union produced invalid geometry; exported as a compound instead.")
            except Exception as exc:  # pragma: no cover - depends on input geometry
                warnings.append(f"Boolean union failed ({exc}); exported as a compound instead.")
        if result is None:
            result = placed[0] if len(placed) == 1 else cq.Compound.makeCompound(placed)
        elif len(result.Solids()) > 1:
            warnings.append(f"The spool fused into {len(result.Solids())} separate solids: some components "
                            "do not touch (check gaps or the STEP parts themselves).")
    return result, warnings


def write_step(shape: cq.Shape, path: str, name: str = "Spool") -> None:
    with CAD_LOCK:
        Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
        Interface_Static.SetCVal_s("write.step.unit", "MM")
        Interface_Static.SetCVal_s("write.step.product.name", name)
        w = STEPControl_Writer()
        w.Transfer(shape.wrapped, STEPControl_AsIs)
        if w.Write(path) != IFSelect_RetDone:
            raise RuntimeError("STEP export failed")


def export_step_bytes(items, pd, lib, *, name="Spool", fuse=True, hollow=True):
    shape, warnings = build_spool(items, pd, lib, fuse=fuse, hollow=hollow)
    fd, tmp = tempfile.mkstemp(suffix=".stp")
    os.close(fd)
    try:
        write_step(shape, tmp, name)
        with open(tmp, "rb") as f:
            data = f.read()
    finally:
        os.unlink(tmp)
    return data, warnings, len(shape.Solids())
