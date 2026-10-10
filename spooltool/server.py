"""FastAPI web server: serves the UI and the CAD API."""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .export import export_step_bytes
from .fittings import FITTING_TYPES, make_fitting
from .library import CAD_LOCK, Library, mesh_shape
from .pipedata import PipeData

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


def _safe_name(name: str) -> str:
    name = re.sub(r"[^\w\- .()]+", "_", name).strip(" .")
    if not name:
        raise HTTPException(400, "Invalid name")
    return name


def create_app(library_dir: Path, projects_dir: Path, pipe_data: Path | None = None) -> FastAPI:
    pd = PipeData(pipe_data) if pipe_data else PipeData()
    lib = Library(library_dir, pd)
    projects_dir = Path(projects_dir)
    projects_dir.mkdir(parents=True, exist_ok=True)

    app = FastAPI(title="Pipe Spool Tool")

    @app.exception_handler(ValueError)
    async def _value_error(_: Request, exc: ValueError):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.exception_handler(FileNotFoundError)
    async def _not_found(_: Request, exc: FileNotFoundError):
        return JSONResponse({"detail": f"Not found: {exc}"}, status_code=404)

    # ------------------------------------------------------------ config
    @app.get("/api/config")
    def config():
        return {
            "standards": {
                k: {"description": v.get("description", ""),
                    "defaultSchedule": v.get("defaultSchedule"),
                    "schedules": sorted({s for size in v["sizes"].values() for s in size["wall"]}),
                    "sizes": v["sizes"]}
                for k, v in pd.standards.items()
            },
            "sizes": pd.size_list(),
            "sizeData": pd.sizes,
            "fittingTypes": FITTING_TYPES,
            "libraryDir": str(lib.root.resolve()),
            "projectsDir": str(projects_dir.resolve()),
        }

    # ---------------------------------------------------------- fittings
    @lru_cache(maxsize=512)
    def _fitting_cached(key: str):
        params = json.loads(key)
        with CAD_LOCK:
            shape, ports = make_fitting(pd, params)
            return {"mesh": mesh_shape(shape), "ports": ports}

    @app.post("/api/fitting")
    def fitting(params: dict = Body(...)):
        keep = {k: params.get(k) for k in ("type", "size", "size2", "standard", "schedule")}
        if keep["type"] == "pipe":
            raise HTTPException(400, "Pipes are drawn by the client")
        if keep["type"] not in ("tee", "reducer", "reducer_ecc"):
            keep["size2"] = None
        return _fitting_cached(json.dumps(keep, sort_keys=True))

    # ----------------------------------------------------------- library
    @app.get("/api/library")
    def library_list():
        return lib.list()

    @app.get("/api/library/part")
    def library_part(id: str = Query(...)):
        return lib.meta(id)

    @app.get("/api/library/mesh")
    def library_mesh(id: str = Query(...)):
        return lib.mesh(id)

    @app.get("/api/library/detect")
    def library_detect(id: str = Query(...), standard: str | None = None):
        return lib.detect(id, standard)

    @app.put("/api/library/part")
    def library_save(id: str = Query(...), meta: dict = Body(...)):
        return lib.save_meta(id, meta)

    @app.post("/api/library/upload")
    async def library_upload(request: Request, filename: str = Query(...), folder: str = ""):
        content = await request.body()
        if not content:
            raise HTTPException(400, "Empty file")
        part_id = lib.add_file(filename, content, folder)
        return lib.meta(part_id)

    # ---------------------------------------------------------- projects
    @app.get("/api/projects")
    def projects_list():
        return sorted(p.stem for p in projects_dir.glob("*.json"))

    @app.get("/api/projects/{name}")
    def project_get(name: str):
        p = projects_dir / (_safe_name(name) + ".json")
        if not p.exists():
            raise HTTPException(404, "Project not found")
        return json.loads(p.read_text(encoding="utf-8"))

    @app.put("/api/projects/{name}")
    def project_put(name: str, data: dict = Body(...)):
        p = projects_dir / (_safe_name(name) + ".json")
        p.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return {"saved": p.stem}

    @app.delete("/api/projects/{name}")
    def project_delete(name: str):
        p = projects_dir / (_safe_name(name) + ".json")
        if p.exists():
            p.unlink()
        return {"deleted": name}

    # ------------------------------------------------------------ export
    @app.post("/api/export")
    def export(payload: dict = Body(...)):
        name = _safe_name(payload.get("name") or "Spool")
        opts = payload.get("options", {})
        data, warnings, solids = export_step_bytes(
            payload.get("items", []), pd, lib,
            name=name, fuse=opts.get("fuse", True), hollow=opts.get("hollow", True))
        headers = {
            "Content-Disposition": f'attachment; filename="{name}.stp"',
            "X-Spool-Warnings": json.dumps(warnings),
            "X-Spool-Solids": str(solids),
            "Access-Control-Expose-Headers": "X-Spool-Warnings, X-Spool-Solids",
        }
        return Response(data, media_type="application/step", headers=headers)

    # ------------------------------------------------------------- web UI
    @app.get("/")
    def index():
        return FileResponse(WEB_DIR / "index.html")

    app.mount("/", StaticFiles(directory=WEB_DIR), name="web")
    return app
