"""Village generation seam, fixed to the hand-authored fixture for Stage 2."""

from __future__ import annotations

from .fixture import FIXTURE_VILLAGE
from .layout import Layout


def build_village(seed: int) -> Layout:
    """Return the Stage 2 fixture without consuming the future generation seed."""
    del seed
    return FIXTURE_VILLAGE
