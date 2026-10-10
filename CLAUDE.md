# Pipe Spool Tool – notes for Claude

## Git workflow
- **Commit and push directly to `main`.** Do not create feature branches or pull requests
  unless the user asks for one.

## Project
- Backend: `spooltool/` (FastAPI + CadQuery/OpenCascade). Frontend: `web/` (plain ES modules + three.js, no build step).
- Port placement maths lives in `web/js/kinematics.js`; fitting port positions are defined in
  `spooltool/fittings.py` and mirrored in `web/js/fittings-client.js` (keep them identical).
- After changing anything in `web/` or `spooltool/data/pipe_data.json`, rebuild the single-file demo:
  `python scripts/build_standalone.py` (writes `demo/pipe-spool-tool.html`) and commit it.
- Tests: `python -m pytest tests` and `node --test tests/*.test.mjs`.
- Browser-hosted pages can't use `alert/confirm/prompt` or downloads – use `ask()` / `copyText()` from `web/js/api.js`.
