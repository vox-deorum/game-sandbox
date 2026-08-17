"""Draw the Three Branches terrain contours for one village seed.

The picture and the numbers belong together when judging a boundary: an aggregate can improve while
the line on screen gets worse. This builds the village, runs the renderer's own contour pipeline
over it, and writes one SVG whose layers are the stages of that pipeline, from the raw cell
staircase through the reference polyline to the curve the game strokes.

    uv run python plans/days-at-three-branches/tools/contours.py
    uv run python plans/days-at-three-branches/tools/contours.py --seed 7
    uv run python plans/days-at-three-branches/tools/contours.py --window 40,50,16 --scale 80

The drawing lands under build/three-branches-contours/. This tool belongs to the terrain work in
stages/5-1-art-style.md and leaves with it; the measuring and drawing it calls live beside the
pipeline itself, in environments/three_branches/renderer/contour-debug.ts.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
OUTPUT_DIR = REPO_ROOT / "build" / "three-branches-contours"
WORKER = "../environments/three_branches/renderer/contour-debug.ts"
NPX = "npx.cmd" if sys.platform == "win32" else "npx"

# A script runs with its own directory on the path rather than the repo root, so the environment
# package has to be reachable before it can be imported.
sys.path.insert(0, str(REPO_ROOT))

from environments.three_branches.generation import build_village  # noqa: E402


def village_rows(seed: int) -> list[str]:
    """The village grid in the south-first order a recording carries it in."""
    # The renderer performs the sole south-to-north inversion itself, in buildStaticScene, and the
    # drawing tool reuses that rule. Rows leave here in the order the generator and the recording
    # both keep them in, so there is one place that decides which way up a village is.
    return ["".join(row) for row in build_village(seed).grid.rows]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Draw the Three Branches terrain contours.")
    parser.add_argument("--seed", type=int, default=0, help="village seed to build, default 0")
    parser.add_argument(
        "--window",
        default=None,
        metavar="X,Y,SPAN",
        help="draw a square patch of SPAN cells with its corner at cell (X, Y), default the whole map",
    )
    parser.add_argument(
        "--scale",
        type=int,
        default=0,
        help="pixels per cell, default a size that fits the window on screen",
    )
    parser.add_argument(
        "--out",
        default=None,
        help=f"where to write the SVG, default {OUTPUT_DIR}/seed-<seed>.svg",
    )
    args = parser.parse_args(argv)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    rows_path = OUTPUT_DIR / f"seed-{args.seed}-rows.txt"
    rows_path.write_text("\n".join(village_rows(args.seed)), encoding="utf8")
    out_path = OUTPUT_DIR / f"seed-{args.seed}.svg" if args.out is None else REPO_ROOT / args.out

    command = [
        NPX,
        "vite-node",
        "--script",
        WORKER,
        f"--rows={rows_path}",
        f"--out={out_path}",
        f"--seed={args.seed}",
    ]
    if args.window is not None:
        command.append(f"--window={args.window}")
    if args.scale > 0:
        command.append(f"--scale={args.scale}")

    print(f"$ {' '.join(command)} (in frontend)", flush=True)
    # The worker runs from frontend/ so vite-node picks up the vite config that resolves the
    # renderer's @renderers alias.
    return subprocess.run(command, cwd=REPO_ROOT / "frontend").returncode


if __name__ == "__main__":
    raise SystemExit(main())
