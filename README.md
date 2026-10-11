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

1. **Pick the first part.** Choose the start size, then click a part in the list.
2. **Carry on from the orange end.** The list only shows parts that fit that end: the same pipe size
   and a connection that mates with it. Weld ends and BSP female ends are joined with a pipe (marked
   **+ pipe**); BSP male into female, RJT, and flange to flange or wafer valve go straight together.
   Click any blue marker to carry on from another open end.
3. **Rotate.** Select a part and roll it with **⟳ 90°** / **⟲ 90°** (`R` / `Shift+R`) or type an
   angle. **Turn round** (`X`) attaches it by its other end.
4. **Dimension.** Click a pipe, or its dimension in the view, and type the **centre-to-centre**
   (fitting centre to fitting centre; to the pipe end when nothing is beyond it). The pipe's cut
   length is worked out from each fitting's centre-to-end. You can switch a pipe to a plain
   **cut length**, or make it **close-coupled** (no pipe, fittings welded straight together).

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

Everything is built in your browser and merged into one solid. Choose the level of detail:

| Level | What you get | Typical size |
|---|---|---|
| **Envelope** | each part replaced by a smooth outline (spun round its pipe line, rings for bends) and a block for each handle or bonnet | smallest |
| **Shrink-wrap** | the outline follows each part at the **resolution** you set (1–50 mm); handles become a few blocks | small |
| **Full model** | the original manufacturer geometry | largest |

Shrink-wrapped parts are solid (bores, threads and text are gone) and always enclose the real part.
**Build preview** shows the result, its face count and file size before you download it. Pipes are
solid unless you tick **Hollow pipes** on the full model.

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
