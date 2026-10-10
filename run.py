"""Start the Pipe Spool Tool.

    python run.py                       # library in ./library, projects in ./projects
    python run.py --library "D:/STEP Library" --port 8765
"""

import argparse
import threading
import webbrowser
from pathlib import Path

import uvicorn

from spooltool.server import create_app

HERE = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser(description="Pipe Spool Tool")
    ap.add_argument("--library", default=str(HERE / "library"), help="folder of STEP components")
    ap.add_argument("--projects", default=str(HERE / "projects"), help="folder for saved spools")
    ap.add_argument("--pipe-data", default=None, help="custom pipe_data.json")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    app = create_app(Path(args.library), Path(args.projects), args.pipe_data)
    url = f"http://{args.host}:{args.port}/"
    print(f"Pipe Spool Tool running at {url}")
    print(f"  STEP library : {Path(args.library).resolve()}")
    print(f"  Projects     : {Path(args.projects).resolve()}")
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
