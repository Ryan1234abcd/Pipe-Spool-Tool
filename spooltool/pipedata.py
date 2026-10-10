"""Pipe size / fitting dimension tables.

The data lives in ``data/pipe_data.json`` so it can be edited without touching
code.  A user override file can be supplied with ``--pipe-data``.
"""

from __future__ import annotations

import json
from pathlib import Path

DEFAULT_PATH = Path(__file__).parent / "data" / "pipe_data.json"


class PipeData:
    def __init__(self, path: Path | str = DEFAULT_PATH):
        self.path = Path(path)
        with open(self.path, encoding="utf-8") as f:
            self.raw = json.load(f)
        self.standards: dict = self.raw["standards"]
        self.sizes: dict = self.raw["sizes"]

    # ------------------------------------------------------------------ pipes
    def standard(self, name: str | None) -> dict:
        if name and name in self.standards:
            return self.standards[name]
        return next(iter(self.standards.values()))

    def od(self, size: str, standard: str | None = None) -> float:
        std = self.standard(standard)
        try:
            return float(std["sizes"][size]["od"])
        except KeyError:
            raise ValueError(f"Unknown pipe size {size!r} for standard {standard!r}")

    def wall(self, size: str, standard: str | None = None, schedule: str | None = None) -> float:
        std = self.standard(standard)
        walls = std["sizes"][size]["wall"]
        if schedule and schedule in walls:
            return float(walls[schedule])
        default = std.get("defaultSchedule")
        if default in walls:
            return float(walls[default])
        return float(next(iter(walls.values())))

    def id(self, size: str, standard: str | None = None, schedule: str | None = None) -> float:
        return self.od(size, standard) - 2 * self.wall(size, standard, schedule)

    # --------------------------------------------------------------- fittings
    def fitting(self, size: str, key: str) -> float:
        try:
            return float(self.sizes[size]["fitting"][key])
        except KeyError:
            raise ValueError(f"No fitting dimension {key!r} for size {size!r}")

    def flange(self, size: str) -> dict:
        try:
            return self.sizes[size]["flange"]
        except KeyError:
            raise ValueError(f"No flange dimensions for size {size!r}")

    def size_list(self) -> list[str]:
        return sorted(self.sizes.keys(), key=lambda s: float(s.replace("DN", "")))

    def guess_size(self, diameters: list[float], standard: str | None = None) -> str | None:
        """Guess a nominal size from circle diameters found on a part end.

        Matches pipe OD first (weld ends), then flange OD (flanged ends).
        """
        std = self.standard(standard)
        ds = sorted(diameters, reverse=True)
        checks = [
            # (tolerance, iterator of (size, reference diameter))
            (1.0, ((n, float(s["od"])) for n, s in std["sizes"].items())),
            (0.6, ((n, float(s["od"]) - 2 * float(w)) for n, s in std["sizes"].items()
                   for w in s["wall"].values())),
            (1.5, ((n, float(s["flange"]["rfDia"])) for n, s in self.sizes.items())),
            (2.0, ((n, float(s["flange"]["od"])) for n, s in self.sizes.items())),
        ]
        for tol, refs in checks:
            refs = list(refs)
            for d in ds:
                for name, ref in refs:
                    if abs(ref - d) <= tol:
                        return name
        return None
