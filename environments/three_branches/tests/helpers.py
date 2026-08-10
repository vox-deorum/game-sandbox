"""Shared connectivity sampling for layout test suites."""

from __future__ import annotations

from collections import deque

from three_branches.geometry import distance
from three_branches.layout import WORLD_SIZE, Layout


def walkable_samples(layout: Layout, spacing: float = 0.25) -> set[tuple[float, float]]:
    """Every body-clear sample center on the spacing grid."""
    steps = int(WORLD_SIZE / spacing)
    offset = spacing / 2
    return {
        (x * spacing + offset, y * spacing + offset)
        for x in range(steps)
        for y in range(steps)
        if layout.body_clear((x * spacing + offset, y * spacing + offset))
    }


def flood_from_spawn(
    layout: Layout, samples: set[tuple[float, float]], spacing: float = 0.25
) -> set[tuple[float, float]]:
    """The samples reachable from the sample nearest the spawn by 4-neighbor steps."""
    nearest = min(samples, key=lambda point: distance(point, layout.spawn))
    seen = {nearest}
    pending = deque((nearest,))
    while pending:
        x, y = pending.popleft()
        for candidate in ((x + spacing, y), (x - spacing, y), (x, y + spacing), (x, y - spacing)):
            if candidate in samples and candidate not in seen:
                seen.add(candidate)
                pending.append(candidate)
    return seen
