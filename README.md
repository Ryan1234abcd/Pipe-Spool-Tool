# Pipe Spool Tool

Configure piping valve stations and spools quickly in an isometric 3D view,
then export the whole assembly as **one STEP file** ready to import into a
Revit family as a single body.

* Build the spool fitting by fitting: pipe, 90°/45° elbows, tees (equal and reducing),
  concentric/eccentric reducers, weld neck and blind flanges, caps.
* Drop in your own components (valves, strainers, actuators…) from a folder of STEP files.
* Type pipe lengths, roll components about the pipe axis, flip valves, split pipes
  and insert components, set gasket gaps.
* Sizes carry through the run automatically, and size mismatches are flagged.
* Export a fused single-solid STEP, plus a BOM / cut list (CSV).

![workflow](docs/workflow.png)

## Try it in the browser first

Open **`demo/pipe-spool-tool.html`** in a browser (double-click it; no install needed).
It's the same spool builder with the three sample parts built in. It runs completely
in the page:

* Fittings are drawn in the browser from the same dimension tables.
  Port positions match the full app exactly.
* Spools are saved in your browser. BOM and spool data are copied to the clipboard.
* Exporting STEP and adding your own STEP files need the full app below.
  Use **Export STEP › Copy spool .json**, save the text as a `.json` file, and import it
  into the full app with **Open… › Import .json**.

Rebuild the demo after changing the web UI or the pipe data with
`python scripts/build_standalone.py`.

## Install and run

Requires **Python 3.10 – 3.13**. CAD work uses [CadQuery](https://cadquery.readthedocs.io/) / OpenCascade,
installed with pip. No CAD licence is needed.

**Windows:** double-click `start.bat`. The first run sets up a local Python environment,
which takes a few minutes. Your browser then opens at <http://127.0.0.1:8765>.

**Manual / other OS:**

```bash
python -m venv .venv
.venv/Scripts/activate        # Windows  (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
python run.py
```

Options:

```
python run.py --library "D:\STEP Library"    # use your own STEP library folder
              --projects "D:\Spools"         # where saved spools (.json) go
              --pipe-data my_pipe_data.json  # custom pipe/fitting dimensions
              --port 8765 --no-browser
```

The same options can be passed to `start.bat`, e.g. `start.bat --library "D:\STEP Library"`.

## 1. Set up your STEP library (once per part)

The app needs to know where each part connects. Open the **Library setup** tab:

1. Copy `.stp`/`.step` files into the library folder (sub-folders become categories), or use
   **Add STEP files…**.
2. Select a part. The app searches the model for circular end faces (flange faces and weld ends)
   and suggests connection points as green arrows, with the nominal size guessed from the
   pipe OD, bore, raised face or flange OD.
3. Untick anything that isn't a real connection, such as a handwheel or a strainer cap.
   Check the sizes and the type (flange/weld/…). Arrows must point **out** of the part;
   use ⇄ to reverse one. If a connection wasn't found, tick *Show all circle
   candidates* or add a port manually from coordinates.
4. **Save part.** The port data goes into a small sidecar file next to the STEP
   (`part.stp.json`), so the STEP itself is never changed.

The roll reference for library parts is the model's own +Z axis. A valve with its stem up
along +Z in the STEP stays stem-up when you drop it into a horizontal run at roll 0°.

## 2. Build a spool

* Pick the **pipe standard / schedule / start size** on the left.
* Click a fitting (or press its key) to start. Each new component attaches at the **orange port**,
  and the next free end becomes the orange port, so you can chain quickly:
  `P` type `500` Enter, `E`, `P` `300` Enter, click a valve, `P` …
* Click any blue marker to continue from a different open end, or press `N` to cycle through them.
* Select a component to edit it on the right: size (changes carry downstream until a reducer),
  pipe length, **roll** (`R` / `Shift+R` = ±90°), **attach by** port / **Flip** (`X`),
  gap (e.g. 3 mm for a gasket; leave 0 if you need one fused body), tag (e.g. `V-101`).
* To insert something into an existing run, click **insert** next to a connected port in the
  component's port list, or **Split…** a pipe, then add the component.
  **Remove & rejoin** takes an inline component out and closes the gap.
* Views: Iso (four quadrants), Top, Front, Right. Pipe lengths and tags are shown in the view.
  Use **X-ray** to see inside.
* **Save** / **Open** store spools in the projects folder. **BOM** gives a parts list and cut list.

Roll is measured right-handed about the flow direction (the outward direction of the port
you are attaching to). For example, with a run along +X, an elbow at roll 0° turns towards +Y,
+90° turns up (+Z), and −90° turns down.

## 3. Export to Revit

**Export STEP** writes `<spool name>.stp` in millimetres with the spool's start point at the origin.

* *Fuse into a single solid body* (default) unions everything into one solid for a single body
  in the family. If a boolean union fails on a complex manufacturer model, the file is still
  written as a multi-body compound and you get a warning.
* *Hollow pipes & fittings* models the bore. Untick it for lighter geometry.

In Revit, open or create the family and import the STEP. The spool's first open end sits at the
family origin, which makes placement predictable.

## Pipe and fitting data

Dimensions are in `spooltool/data/pipe_data.json`:

* Pipe standards: ASME B36.10 (Sch10/40/80) and EN 10220 (common refrigeration wall thicknesses).
* Fittings per ASME B16.9 (LR/SR elbow centre-to-end, tee C, reducer H, cap E).
* Flanges per ASME B16.5 Class 150 (OD, thickness, hub, raised face, bolt holes).

You can add standards or schedules, or change dimensions, by copying the file and
starting with `--pipe-data`.

## Development

```
spooltool/        Python backend (FastAPI + CadQuery)
  fittings.py     parametric pipe/fitting/flange solids and their ports
  library.py      STEP library, meshing, automatic port detection
  export.py       placement, boolean union, STEP writer
  server.py       HTTP API + static web UI
web/              browser UI (three.js, no build step)
  js/kinematics.js  port-to-port placement maths (shared convention with fittings.py)
scripts/make_sample_library.py   regenerates the sample STEP parts
scripts/build_standalone.py      builds demo/pipe-spool-tool.html (single-file browser demo)
tests/            pytest (backend) and node:test (placement maths)
```

Run the tests:

```bash
pip install pytest httpx
python -m pytest tests
node --test tests/*.test.mjs
```

How placement works: every component has named ports with an origin, an outward direction and
an "up" reference vector. A component is placed by mating one of its ports to a parent port.
The two origins coincide (plus the gap) and the directions oppose. The roll angle turns the
component about the joint axis, measured from the parent port's up vector. The browser
computes every component's 4×4 transform. The server rebuilds the exact geometry with those
transforms and fuses it.
