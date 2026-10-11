# Pipe Spool Tool

Build pipe spools in an isometric 3D view from the parts in your
[Part-Library](https://github.com/Ryan1234abcd/Part-Library), set the centre-to-centre dimensions, and
save the whole spool as **one STEP file**, shrink-wrapped so it stays small. That file imports into
a Revit family as a single body.

**It runs entirely in your web browser. There is nothing to install.**

![Spool builder](docs/workflow.png)

## Start

1. Open **`pipe-spool-tool.html`** (double-click it). Chrome or Edge is recommended.
2. The first time, the page downloads the 23 MB OpenCascade CAD engine from a public CDN
   (jsDelivr, with unpkg as a fallback). The browser caches it after that.
3. Click **Open Part-Library…** and choose your copy of the Part-Library folder (the one with
   `library.json`, `geometry.json` and `models/`). In Chrome/Edge the page remembers it; next time
   click **Reconnect**.

A few 50NB / 40NB Sch 10S parts, a butterfly valve and a wafer check valve are built in, so you can
try it before opening the library.

## Build a spool

1. **Pick the pipe type, start and first part.** Choose the pipe type (e.g. Sch 10S pipe or dairy
   tube) – the start size list then only has that type's sizes – and whether the spool starts
   horizontal or vertical (**Start**; it can be changed later on the first part), then click a part.
2. **Carry on from the orange end.** The list only shows parts that fit that end: the same pipe size
   and a connection that mates with it. Weld ends and BSP female ends are joined with a pipe (marked
   **+ pipe**); BSP male into female, RJT, and flange to flange or wafer valve go straight together
   (flanges match by their drilling). Click any blue marker to carry on from another open end.
   The chips above the list pick one part type at a time (Elbows & bends, Tees, Valves…, or All).
   Flanged joints match by size only (DN), whatever the flange standard.
3. **Rotate and connect.** Select a part and roll it with **⟳ 90°** / **⟲ 90°** (`R` / `Shift+R`) or
   type an angle. **Connected by** picks which end it is joined by (a tee's run end or its branch);
   **Next part on** picks which free end the next part goes on.
4. **Dimension.** Click a pipe, or its dimension in the view, and type the **centre-to-centre**
   (fitting centre to fitting centre; to the pipe end when nothing is beyond it). The pipe's cut
   length is worked out from each fitting's centre-to-end. You can switch a pipe to a plain
   **cut length**, or make it **close-coupled** (no pipe, fittings welded straight together).
5. **Parallel lines.** Select a pipe and click **Parallel line…**: a new line starts beside it at the
   **centre distance** you type. Turn it round the pipe (⟳ 90°), slide it along, or run it the other
   way, then add parts or a pipe (`P`) on its orange end. Change the distance any time.

6. **Branches.** Select a pipe and click **Branch…**, then pick a weld nipple (normal or extended),
   a tube weld nipple or a half socket: it is stabbed into the pipe (set in, flush with the bore).
   Set **Along pipe** (from the upstream fitting centre) and **Round pipe** (angle), then carry on
   from the nipple's thread.
7. **Valve handles.** Ball valves and lever butterfly valves have **Handle: Open / Closed**; closed
   turns the lever (and the ball) a quarter turn about the stem, in the view and the export.

**RJT unions** are one part: an RJT female half and an RJT male half of the same size come screwed
together (e.g. *RJT Union BSP male × BSP male*), and only their outer ends connect. The BOM lists
both halves.

Fitting centres: where the centrelines cross (elbows, tees), midway between the ends (valves,
reducers), the flange face (flanges) or the end (caps). A pipe screwed into a BSP female end goes in
by the thread engagement, and the cut length allows for it.

**Save** / **Open** keep spools in this browser; the open dialog also imports and downloads `.json`.
The current spool is kept automatically. **BOM** gives a parts list and pipe cut list (CSV).

| Key | |
|---|---|
| `F` or `/` | search parts, Enter adds the first match |
| `R` / `Shift+R` | roll the selected part ±90° |
| `X` | turn the selected part round |
| `P` | plain pipe on the orange end |
| `N` | next open end |
| `Del` | delete the selected item and everything beyond it |
| `Ctrl+Z` / `Ctrl+Y` | undo / redo |

## Export STEP

Everything is built in your browser and merged into one solid per line. Choose the level of detail:

| Level | What you get | Typical size |
|---|---|---|
| **Envelope** | each part replaced by a smooth outline (spun round its pipe line, rings for bends) and a block for each handle or bonnet | smallest |
| **Shrink-wrap** | the part's real outside: hidden inner parts (balls, seats, springs) left out, bores and threads filled, bolt holes and other holes and loose bits smaller than the **resolution** removed | small |
| **Full model** | the original manufacturer geometry | largest |

**Build preview** shows the result, its face count and file size before you download it. Pipes are
solid unless you tick **Hollow pipes** on the full model. All levels are written without the
duplicate 2D edge curves and with numbers to 0.001 mm, which roughly halves the file.
Complex valves take a few seconds each to shrink-wrap the first time.

## Develop

```bash
npm install          # three.js and the OpenCascade WebAssembly build
npm run build        # web/ -> pipe-spool-tool.html (commit it)
npm test             # node tests using the same CAD engine
```

| Path | Contents |
| --- | --- |
| `web/js/app.js` | spool builder UI |
| `web/js/joints.js` | which ends fit together, pipe sizes, cut length from dimensions |
| `web/js/kinematics.js` | end-to-end placement |
| `web/js/wrap.js` | shrink-wrap: simple solids that enclose a part |
| `web/js/library.js` | reads Part-Library (`library.json` + `geometry.json`) |
| `web/js/cad.js`, `cad-worker.js`, `cad-client.js` | OpenCascade (WebAssembly) in a Web Worker |
| `scripts/library-geometry.mjs`, `scripts/ends.mjs` | find each part's ends in its STEP model → Part-Library `geometry.json` |
| `scripts/make-demo.mjs` | copy the built-in demo parts from Part-Library into `library/Demo/` |

After adding parts to Part-Library, run `node scripts/library-geometry.mjs ../Part-Library <ids…>`
and commit the updated `geometry.json` there.

`node scripts/build.mjs --hosted DIR` also writes a copy for a web server, with the CAD kernel split
into `DIR/oc/` so it loads from the same site instead of the CDN.

**Licences:** three.js (MIT); OpenCascade via
[replicad-opencascadejs](https://www.npmjs.com/package/replicad-opencascadejs) (LGPL-2.1, loaded
unmodified at runtime).
