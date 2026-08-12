"""Generation seam retained for the seeded village generator in Stage 4."""

from __future__ import annotations

from ..fixture import build_fixture
from ..layout import Layout


def build_village(seed: int | None = None) -> Layout:
    """Build a fresh temporary mechanics fixture. The future generator owns ``seed``."""
    del seed
    return build_fixture()
