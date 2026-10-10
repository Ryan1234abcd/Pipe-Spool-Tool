# Pipe Spool Tool – notes for Claude

## Git workflow
- **Commit and push directly to `main`.** Do not create feature branches or pull requests
  unless the user asks for one.

## Project
- Browser-only app – no server, nothing for the user to install. The deliverable is the single file
  `pipe-spool-tool.html`, built from `web/` by `npm run build` (`scripts/build.mjs`). Always rebuild and
  commit it after changing anything in `web/` or `library/Samples/`.
- CAD: OpenCascade WebAssembly (`replicad-opencascadejs`, pinned in `package.json`) in a Web Worker
  (`web/js/cad.js`, `web/js/cad-worker.js`). The 23 MB kernel is loaded from `oc/` next to the page if
  present, else from jsDelivr/unpkg (`web/js/cad-client.js`). `--hosted DIR` writes the split kernel.
- All fittings/valves come from the user's STEP library folder (`web/js/library.js`); port set-ups live
  in `<part>.stp.json` next to each STEP file (or IndexedDB when the folder isn't writable). Only straight
  pipe is generated. Ports carry the connecting pipe `od` (mm); sizes are matched by OD (`pipe-types.js`).
- Placement maths: `web/js/kinematics.js`. Port detection: `web/js/detect.js`.
- Tests: `npm test` (node; runs the real OpenCascade build).
- Pages hosted on claude.ai can't use `alert/confirm/prompt` or plain downloads – use `ask()` / `saveFile()`
  from `web/js/ui.js` (`saveFile` uses the host's downloads capability and zips STEP files there).
