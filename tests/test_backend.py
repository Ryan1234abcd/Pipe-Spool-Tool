import json
import shutil
from pathlib import Path

import cadquery as cq
import pytest
from fastapi.testclient import TestClient

from spooltool.export import build_spool, write_step
from spooltool.fittings import FITTING_TYPES, make_fitting
from spooltool.library import Library
from spooltool.pipedata import PipeData
from spooltool.server import create_app

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = ROOT / "library" / "Samples"
pd = PipeData()


def translate(x=0.0, y=0.0, z=0.0):
    return [[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, z], [0, 0, 0, 1]]


def roundtrip_valid(shape, tmp_path):
    p = tmp_path / "rt.stp"
    write_step(shape, str(p))
    return cq.importers.importStep(str(p)).val().isValid()


@pytest.fixture()
def lib(tmp_path):
    root = tmp_path / "library"
    shutil.copytree(SAMPLES, root / "Samples")
    return Library(root, pd)


@pytest.mark.parametrize("ftype", [t for t in FITTING_TYPES])
@pytest.mark.parametrize("size", ["DN25", "DN100"])
def test_fittings_valid_and_survive_step(ftype, size, tmp_path):
    params = {"type": ftype, "size": size, "length": 250,
              "size2": "DN20" if ftype.startswith("reducer") else size}
    shape, ports = make_fitting(pd, params)
    assert shape.isValid()
    assert len(shape.Solids()) == 1
    assert ports[0]["name"] == "A"
    if ftype != "tee":  # tees are modelled about their centre
        assert ports[0]["origin"] == [0, 0, 0]
    assert roundtrip_valid(shape, tmp_path)


def test_reducing_tee_branch_size():
    _, ports = make_fitting(pd, {"type": "tee", "size": "DN100", "size2": "DN50"})
    assert [p["size"] for p in ports] == ["DN100", "DN100", "DN50"]


def test_elbow_port_geometry():
    _, ports = make_fitting(pd, {"type": "elbow90", "size": "DN50"})
    r = pd.fitting("DN50", "elbow90LR")
    assert ports[1]["origin"] == pytest.approx([r, r, 0])
    assert ports[1]["dir"] == pytest.approx([0, 1, 0], abs=1e-9)


def test_detect_ports_on_samples(lib):
    cands = lib.detect("Samples/Ball_valve_flanged_DN50.stp")
    likely = [c for c in cands if c["likely"]]
    assert len(likely) == 2
    assert all(c["size"] == "DN50" for c in likely)
    assert sorted(c["origin"][1] for c in likely) == pytest.approx([-89, 89])
    # bolt holes are not offered as candidates
    assert not any(abs(c["origin"][0]) > 1 for c in cands if c["diameters"][0] < 25)

    weld = [c for c in lib.detect("Samples/Globe_valve_weld_DN50.stp") if c["likely"] and c["size"] == "DN50"]
    assert len(weld) == 2


def test_export_chain_is_one_valid_solid(lib, tmp_path):
    flange_len = pd.flange("DN50")["wnLength"]
    items = [
        {"type": "pipe", "size": "DN50", "length": 300, "matrix": translate()},
        {"type": "flange_wn", "size": "DN50", "matrix": translate(300)},
        # valve port A is at y=-89 facing -Y: rotate -90 about Z so it faces -X, then move into place
        {"type": "part", "part": "Samples/Ball_valve_flanged_DN50.stp",
         "matrix": [[0, 1, 0, 300 + flange_len + 89], [-1, 0, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]},
    ]
    shape, warnings = build_spool(items, pd, lib)
    assert warnings == []
    assert len(shape.Solids()) == 1
    bb = shape.BoundingBox()
    assert bb.xmin == pytest.approx(0, abs=0.01)
    assert bb.xmax == pytest.approx(300 + flange_len + 178, abs=0.01)
    assert roundtrip_valid(shape, tmp_path)


def test_api_end_to_end(tmp_path):
    lib_dir = tmp_path / "library"
    shutil.copytree(SAMPLES, lib_dir / "Samples")
    client = TestClient(create_app(lib_dir, tmp_path / "projects"))

    cfg = client.get("/api/config").json()
    assert "DN50" in cfg["sizes"]

    parts = client.get("/api/library").json()
    assert {p["id"] for p in parts} >= {"Samples/Ball_valve_flanged_DN50.stp"}

    r = client.post("/api/fitting", json={"type": "elbow90", "size": "DN80"})
    assert r.status_code == 200 and len(r.json()["ports"]) == 2

    # upload + configure a new part
    src = (SAMPLES / "Ball_valve_flanged_DN50.stp").read_bytes()
    up = client.post("/api/library/upload?filename=my_valve.stp", content=src).json()
    assert up["configured"] is False
    det = client.get("/api/library/detect", params={"id": up["id"]}).json()
    ports = [dict(c, name="AB"[i]) for i, c in enumerate([c for c in det if c["likely"]])]
    saved = client.put("/api/library/part", params={"id": up["id"]}, json={"name": "My valve", "ports": ports}).json()
    assert saved["configured"] and len(saved["ports"]) == 2

    # path traversal is refused
    assert client.get("/api/library/mesh", params={"id": "../secret.stp"}).status_code == 400

    # projects
    client.put("/api/projects/VS-01", json={"nodes": []})
    assert client.get("/api/projects").json() == ["VS-01"]

    # export
    res = client.post("/api/export", json={
        "name": "VS-01",
        "items": [{"type": "pipe", "size": "DN50", "length": 200, "matrix": translate()},
                  {"type": "elbow90", "size": "DN50", "matrix": translate(200)}],
    })
    assert res.status_code == 200
    assert res.content.startswith(b"ISO-10303-21")
    assert json.loads(res.headers["X-Spool-Warnings"]) == []
    assert res.headers["X-Spool-Solids"] == "1"
