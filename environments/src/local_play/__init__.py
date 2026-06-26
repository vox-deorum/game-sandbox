"""Shared, import-self-contained helpers for local pygame play.

This is not an environment — it holds standalone support modules (currently the HiDPI display
shim, :mod:`local_play.hidpi`) reused by the Hearts renderer and the maintainer launcher
``scripts/play.py``, and copied verbatim by ``scripts/generate.py`` into
``templates/base/sandbox/`` so the student template's local play uses the exact same code (as
``sandbox.hidpi``). Modules here import only the standard library and third-party packages — never
the harness — so they sync cleanly into the template.
"""

from __future__ import annotations
