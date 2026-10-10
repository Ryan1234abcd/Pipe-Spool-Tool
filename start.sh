#!/usr/bin/env sh
# Pipe Spool Tool - macOS / Linux launcher.
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt || exit 1
fi
exec .venv/bin/python run.py "$@"
