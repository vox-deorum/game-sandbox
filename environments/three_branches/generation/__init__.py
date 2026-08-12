"""Seeded village generation for Days at Three Branches.

``build_village`` is the seam the environment resets through. ``generate`` is the same work plus an
internal report that only the guarantee suite and the batch summary read. Both run one labelled
stream, ``random.Random(f"{seed}:village")``, which is separate from anything a match plays with, so
the same build and the same seed always produce the same village.

Construction runs terrain fields, water, then ground classes. Each stage reads what the ones before
it committed. A stage that runs out of candidates raises ``Retry``, which discards the partial
village and draws the whole layout again on the same stream.

Settlement, the road, and dressing arrive in gate B, where the road is walked after the district
anchors exist so it can connect them. Until then the layout is padded with fixture buildings, props,
scenery, and a spawn on open ground, so the browser still receives a complete village. Padded content
is placed clear of the generated land where it can be, but it is not generated content and does not
carry the village guarantees.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from math import dist
from time import perf_counter

from ..catalog import BUILDING_BY_TOKEN, PROP_BY_TOKEN, SCENERY_BY_TOKEN, BuildingType
from ..fixture import build_fixture
from ..geometry import Point
from ..grid import Cell, Grid
from ..layout import Building, Layout, paint_site
from ..rules import FRAME, GROUND_BY_CODE, RULES
from . import fields, grounds, water
from .config import GENERATION, Generation, Retry

__all__ = ["Report", "build_village", "generate"]

# Ground a padded fixture building must not be dropped on. Generated land is what the owner reviews.
_PAD_KEEP_CLEAR = frozenset({"w"})


@dataclass(frozen=True, slots=True)
class Report:
    """Generator internals. Only the guarantee suite and the batch summary read these."""

    seed: int
    redraws: int
    water: water.Water
    # Generation and validation together, which is what a reset spends. Reported, never asserted.
    reset_seconds: float


def build_village(seed: int | None = None) -> Layout:
    """Build the village for a match seed. A reset without a seed builds the default village."""
    return generate(0 if seed is None else seed)[0]


def generate(seed: int, tuning: Generation = GENERATION) -> tuple[Layout, Report]:
    """Build the village for a seed and report how it went."""
    stream = random.Random(f"{seed}:village")
    started = perf_counter()
    for redraws in range(tuning.redraw_cap):
        try:
            layout, courses = _draw(stream, tuning)
        except Retry:
            continue
        return layout, Report(
            seed,
            redraws,
            courses,
            perf_counter() - started,
        )
    raise RuntimeError(f"village generation for seed {seed} exceeded the redraw cap of {tuning.redraw_cap}")


def _draw(stream: random.Random, tuning: Generation) -> tuple[Layout, water.Water]:
    """Draw one whole village. Any mandatory stage that runs out of room raises ``Retry``."""
    rows = [[RULES.fill] * FRAME.cells_x for _ in range(FRAME.cells_y)]
    elevation, moisture = fields.build_fields(stream, tuning.fields)
    courses = water.carve_water(stream, rows, elevation, tuning.water)
    grounds.paint_grounds(rows, elevation, moisture, grounds.water_distance(rows), tuning.grounds)
    return _pad(rows), courses


def _pad(rows: list[list[str]]) -> Layout:
    """Fill the ungenerated half of the village with fixture content."""
    fixture = build_fixture()
    taken: set[Cell] = set()
    buildings: list[Building] = []
    for building in fixture.buildings:
        kind = BUILDING_BY_TOKEN[building.type]
        origin = _free_origin(rows, kind, building.cell, taken)
        placed = Building(building.id, building.type, origin, building.facing)
        paint_site(rows, placed)
        taken.update(_reserved(kind, origin))
        buildings.append(placed)
    for item in (*fixture.props, *fixture.scenery):
        kind = PROP_BY_TOKEN.get(item.type) or SCENERY_BY_TOKEN[item.type]
        taken.update(
            (item.cell[0] + dx, item.cell[1] + dy) for dx in range(kind.width) for dy in range(kind.height)
        )
    return Layout(
        Grid(FRAME, rows), tuple(buildings), fixture.props, fixture.scenery, _pad_spawn(rows, taken)
    )


def _pad_spawn(rows: list[list[str]], taken: set[Cell]) -> Point:
    """Stand the padded visitor in the middle of the widest stretch of open ground.

    There is no road to spawn on until gate B, and a day still has to run, so the visitor needs
    somewhere it can walk away from. The largest walkable region is that somewhere, and its middle
    keeps the opening view on the village rather than in a corner of the frame.
    """
    open_ground = {
        (x, y)
        for y, row in enumerate(rows)
        for x, code in enumerate(row)
        if GROUND_BY_CODE[code].passable and (x, y) not in taken
    }
    room = max(_regions(open_ground), key=lambda region: (len(region), min(region)))
    middle = (
        sum(x for x, _ in room) / len(room),
        sum(y for _, y in room) / len(room),
    )
    # Open on all four sides, so the body radius clears whatever the neighbouring cells hold.
    standing = [
        cell
        for cell in sorted(room)
        if all(
            spot in open_ground
            for spot in (
                (cell[0], cell[1] - 1),
                (cell[0] - 1, cell[1]),
                (cell[0] + 1, cell[1]),
                (cell[0], cell[1] + 1),
            )
        )
    ]
    if not standing:
        raise Retry("padding found nowhere clear for the visitor to stand")
    x, y = min(standing, key=lambda cell: (dist((cell[0] + 0.5, cell[1] + 0.5), middle), cell))
    return (x + 0.5, y + 0.5)


def _regions(cells: set[Cell]) -> list[frozenset[Cell]]:
    remaining = set(cells)
    found: list[frozenset[Cell]] = []
    while remaining:
        start = min(remaining)
        group = {start}
        pending = [start]
        remaining.discard(start)
        while pending:
            x, y = pending.pop()
            for spot in ((x, y - 1), (x - 1, y), (x + 1, y), (x, y + 1)):
                if spot in remaining:
                    remaining.discard(spot)
                    group.add(spot)
                    pending.append(spot)
        found.append(frozenset(group))
    return found


def _free_origin(rows: list[list[str]], kind: BuildingType, wanted: Cell, taken: set[Cell]) -> Cell:
    """Find the nearest origin whose site and margin miss generated water and the other sites."""
    for radius in range(max(FRAME.cells_x, FRAME.cells_y)):
        for origin in _ring(wanted, radius):
            if _site_is_free(rows, kind, origin, taken):
                return origin
    raise Retry("padding found nowhere clear to stand a fixture building")


def _ring(centre: Cell, radius: int) -> tuple[Cell, ...]:
    x, y = centre
    if radius == 0:
        return ((x, y),)
    span = range(-radius, radius + 1)
    return tuple(
        sorted(
            {(x + dx, y + dy) for dx in span for dy in (-radius, radius)}
            | {(x + dx, y + dy) for dx in (-radius, radius) for dy in span}
        )
    )


def _site_is_free(rows: list[list[str]], kind: BuildingType, origin: Cell, taken: set[Cell]) -> bool:
    x, y = origin
    if x < 1 or y < 1 or x + kind.width >= FRAME.cells_x or y + kind.height >= FRAME.cells_y:
        return False
    return all(
        cell not in taken and rows[cell[1]][cell[0]] not in _PAD_KEEP_CLEAR
        for cell in _reserved(kind, origin)
    )


def _reserved(kind: BuildingType, origin: Cell) -> tuple[Cell, ...]:
    """The site rectangle plus one ring, which is what keeps padded buildings off each other."""
    x, y = origin
    return tuple(
        (column, row)
        for row in range(y - 1, y + kind.height + 1)
        for column in range(x - 1, x + kind.width + 1)
        if 0 <= column < FRAME.cells_x and 0 <= row < FRAME.cells_y
    )
