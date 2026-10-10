# Pipe Spool Tool

Lay out valve stations and pipe spools in an isometric 3D view, using the STEP fittings and valves
from your own library, then save the whole assembly as **one STEP file**. That file imports into a
Revit family as a single body.

**It runs entirely in your web browser. There is nothing to install.**

![Spool builder](docs/workflow.png)

## Start

1. Open **`pipe-spool-tool.html`** (double-click it). Chrome or Edge is recommended.
2. The first time, the page downloads the 23 MB OpenCascade CAD engine from a public CDN
   (jsDelivr, with unpkg as a fallback). The browser caches it after that.
3. Click **Open folder…** and choose your STEP library folder. Sub-folders become categories.
   In Chrome/Edge the page remembers the folder; next time click **Reconnect**.

Built-in sample parts (EN 10255 elbows, tees, reducer, flange, cap and a few valves) are always
available to try it out.

## Pipe types

Steel · medium (EN 10255) · Copper · Table X (EN 1057) · PE-X / PE-RT · SDR 7.4 ·
Stainless press-fit (EN 10312) · Stainless Sch 10S (ASTM A312) · Stainless Sch 40S (ASTM A312) ·
Dairy tube (AS 1528.1)

Pipes are generated at the length you type. Fittings and valves are matched to a pipe by OD, so the
part list shows the parts that fit the selected pipe type. Tick **All** to see everything. The
OD × wall tables are in `web/js/pipe-types.js`; check them against your suppliers.

## 1. Set up a STEP part (once per part)

Go to **Library setup** and pick a part. The page finds the circular end faces (pipe ends, weld ends,
press-socket stops, flange faces) and suggests them as green arrows, with the pipe size guessed from
the diameters. Untick anything that isn't a real connection (handwheels, strainer caps), check the
pipe size and type, flip an arrow with ⇄ if it points inwards, then **Save part**.

* In Chrome/Edge, the set-up is written next to the STEP file as `<part>.stp.json`.
  It stays with your library, so other people using the same folder get it too.
* In other browsers, it's kept in this browser. **Download set-up file** gives you the
  `.stp.json` to put next to the STEP file yourself.

## 2. Build the spool

* **Add pipe** (`P`) and type the length. Click a part in the list to add it at the **orange** end.
  The next free end becomes orange, so you can chain parts quickly.
  Press `F`, type part of a name, then Enter to add the first match.
* Click any blue marker to continue from another open end.
* **Insert before / Insert after** (`[` / `]`): select a component, press one, then pick a pipe or part.
  It goes in between, and the existing run reconnects to it. A pipe that ends up on the far side of an
  inserted reducer takes the reducer's size.
* Select a component to roll it about the pipe axis (`R` / `Shift+R` = ±90°), flip it (`X`), set a
  gap, add a tag (e.g. `V-101`), change its size, split a pipe, or remove it and rejoin the run.
* Iso views from four quadrants plus top, front and right views. Dimensions and tags are drawn in the view.
* **Save** / **Open** keep spools in this browser, and the open dialog also imports and downloads
  `.json`. The current spool is also kept automatically. **BOM** gives a parts list and pipe cut list (CSV).

## 3. Export STEP

**Export STEP** builds the exact geometry in your browser: real B-rep from your STEP files, plus
pipes generated at the right OD and wall. By default everything is merged into **one solid**, and
the page downloads `<spool name>.stp` in millimetres. The spool's start point is the origin.
If a manufacturer model can't be merged, the file still holds every part, as separate bodies.

## Develop

```bash
npm install          # three.js and the OpenCascade WebAssembly build
npm run build        # web/ -> pipe-spool-tool.html (commit it)
npm test             # node tests using the same CAD engine
```

| Path | Contents |
| --- | --- |
| `web/js/app.js` | spool builder UI |
| `web/js/kinematics.js` | port-to-port placement |
| `web/js/library.js` | library folder access, set-up storage |
| `web/js/library-editor.js`, `detect.js` | part set-up and automatic connection detection |
| `web/js/cad.js`, `cad-worker.js`, `cad-client.js` | OpenCascade (WebAssembly) in a Web Worker |
| `web/js/pipe-types.js` | pipe types and sizes |
| `library/Samples/` | sample STEP parts built into the page |

`node scripts/build.mjs --hosted DIR` also writes a copy for a web server, with the CAD kernel split
into `DIR/oc/` so it loads from the same site instead of the CDN.

**Licences:** three.js (MIT); OpenCascade via
[replicad-opencascadejs](https://www.npmjs.com/package/replicad-opencascadejs) (LGPL-2.1, loaded
unmodified at runtime).
