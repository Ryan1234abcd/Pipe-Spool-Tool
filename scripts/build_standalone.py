"""Build a single self-contained HTML demo of the spool builder.

    python scripts/build_standalone.py            # writes demo/pipe-spool-tool.html

The page runs entirely in the browser: three.js and the app code are inlined,
the sample STEP parts are baked in as meshes, fittings are drawn client side
and spools are saved in the browser.  STEP export still needs the full app.

``--fragment PATH`` additionally writes the page without the
<html>/<head>/<body> wrapper (for hosts that add their own skeleton).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

WEB = ROOT / "web"
THREE_UMD = WEB / "vendor" / "three.min.js"

# bundle order (dependencies first) -> module key used in imports
MODULES = [
    ("vendor/OrbitControls.js", "three/addons/OrbitControls.js"),
    ("vendor/CSS2DRenderer.js", "three/addons/CSS2DRenderer.js"),
    ("js/kinematics.js", "./kinematics.js"),
    ("js/fittings-client.js", "./fittings-client.js"),
    ("js/api.js", "./api.js"),
    ("js/viewer.js", "./viewer.js"),
    ("js/library-editor.js", "./library-editor.js"),
    ("js/app.js", "./app.js"),
]

IMPORT_RE = re.compile(r"import\s+(\*\s+as\s+\w+|\{[^}]*\})\s+from\s+'([^']+)';?", re.S)
EXPORT_DECL_RE = re.compile(r"^export\s+(async\s+function|function|const|let|class)\s+(\w+)", re.M)
EXPORT_LIST_RE = re.compile(r"^export\s*\{([^}]*)\};?", re.M)


def convert(code: str, key: str) -> str:
    def imp(m):
        what, src = m.group(1), m.group(2)
        target = "window.THREE" if src == "three" else f"__mods[{json.dumps(src)}]"
        if src != "three" and not any(src == k for _, k in MODULES):
            raise SystemExit(f"{key}: unknown import {src}")
        if what.startswith("*"):
            return f"const {what.split()[-1]} = {target};"
        names = [n.strip() for n in what.strip("{} \n").split(",") if n.strip()]
        names = [n.replace(" as ", ": ") for n in names]
        return f"const {{ {', '.join(names)} }} = {target};"

    code = IMPORT_RE.sub(imp, code)
    exports = [m.group(2) for m in EXPORT_DECL_RE.finditer(code)]
    code = EXPORT_DECL_RE.sub(lambda m: f"{m.group(1)} {m.group(2)}", code)
    for m in EXPORT_LIST_RE.finditer(code):
        exports += [n.strip() for n in m.group(1).split(",") if n.strip()]
    code = EXPORT_LIST_RE.sub("", code)
    if re.search(r"^\s*(import|export)\s", code, re.M):
        raise SystemExit(f"{key}: unconverted import/export left")
    return f"__mods[{json.dumps(key)}] = (() => {{\n{code}\nreturn {{ {', '.join(exports)} }};\n}})();\n"


def static_data() -> dict:
    from fastapi.testclient import TestClient

    from spooltool.server import create_app

    with tempfile.TemporaryDirectory() as tmp:
        lib = Path(tmp) / "library"
        # copy samples so cache files don't land in the repo
        for src in (ROOT / "library" / "Samples").iterdir():
            (lib / "Samples").mkdir(parents=True, exist_ok=True)
            (lib / "Samples" / src.name).write_bytes(src.read_bytes())
        client = TestClient(create_app(lib, Path(tmp) / "projects"))
        config = client.get("/api/config").json()
        config["libraryDir"] = "(built-in samples)"
        library = [p for p in client.get("/api/library").json()]
        meshes, detect = {}, {}
        for p in library:
            m = client.get("/api/library/mesh", params={"id": p["id"]}).json()
            m["positions"] = [round(v, 1) for v in m["positions"]]
            meshes[p["id"]] = m
            detect[p["id"]] = client.get("/api/library/detect", params={"id": p["id"]}).json()
    return {"config": config, "library": library, "meshes": meshes, "detect": detect}


def three_js() -> str:
    # drop the UMD build's deprecation console warning
    return re.sub(r"^console\.warn\([^)]*\),", "void ", THREE_UMD.read_text(encoding="utf-8"), count=1)


def safe_script(text: str) -> str:
    return text.replace("</script", "<\\/script")


def build(out: Path, fragment: Path | None):
    if not THREE_UMD.exists():
        raise SystemExit(f"Missing {THREE_UMD} (three.js UMD build)")
    html = (WEB / "index.html").read_text(encoding="utf-8")
    css = (WEB / "style.css").read_text(encoding="utf-8")
    bundle = "const __mods = {};\n" + "".join(
        convert((WEB / path).read_text(encoding="utf-8"), key) for path, key in MODULES)
    data = json.dumps(static_data(), separators=(",", ":"))

    head_match = re.search(r"<title>.*?</title>", html, re.S)
    body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
    body = re.sub(r'<script type="module" src="js/app.js"></script>\s*', "", body)
    scripts = (
        f"<script>{safe_script(three_js())}</script>\n"
        f"<script>window.SPOOL_STATIC = {safe_script(data)};</script>\n"
        f"<script>\n{safe_script(bundle)}</script>\n"
    )
    icon = re.search(r'<link rel="icon"[^>]*>', html).group(0)
    inner_head = f"{head_match.group(0)}\n{icon}\n<style>\n{css}\n</style>\n"

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n"
        f"{inner_head}</head>\n<body>{body}{scripts}</body>\n</html>\n",
        encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB)")
    if fragment:
        fragment.write_text(f"{inner_head}{body}{scripts}", encoding="utf-8")
        print(f"wrote {fragment}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "demo" / "pipe-spool-tool.html"))
    ap.add_argument("--fragment", default=None)
    a = ap.parse_args()
    build(Path(a.out), Path(a.fragment) if a.fragment else None)
