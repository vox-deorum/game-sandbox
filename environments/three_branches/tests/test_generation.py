"""Guarantee suite for the seeded village generator, run across the pinned seed batch.

This suite tests structure, not looks. There are no assertions about bend radius, corridor widths,
monotonicity, curvature, bend inventory, or variety: whether a village looks grown is the owner's
call in the browser. Bounds are read from ``generation.json`` rather than restated, so a tuning pass
does not need a test edit. The one exception is the arithmetic test, which deliberately owns its
numbers because it pins the conversions everything else relies on.

Gate A covers the land: terrain, water, and ground classes. Buildings, props, scenery, and the
spawn are still padded fixture content, so nothing here asserts anything about them beyond the one
thing a day depends on, which is that the padded visitor can stand and walk.
"""

from __future__ import annotations

import json
import math
from importlib import resources

import pytest

from three_branches.env import make_env
from three_branches.generation import Report, build_village, carve, generate, grounds
from three_branches.generation.config import GENERATION
from three_branches.grid import Cell
from three_branches.layout import Layout
from three_branches.rules import FRAME

# Seed 0 is the reset default and seed 17 is the one the shared conformance suite rolls out.
BATCH = (0, 1, 2, 3, 5, 7, 11, 17)

TUNING = json.loads(
    resources.files("three_branches.generation").joinpath("generation.json").read_text(encoding="utf-8")
)
WATER = TUNING["water"]


@pytest.fixture(scope="module")
def batch() -> dict[int, tuple[Layout, Report]]:
    """Build every pinned seed once and share it, so one suite run is one build per seed."""
    return {seed: generate(seed) for seed in BATCH}


def _cells(layout: Layout, codes: str) -> set[Cell]:
    return {(x, y) for y, row in enumerate(layout.grid.rows) for x, code in enumerate(row) if code in codes}


def _runs(columns: set[int]) -> tuple[tuple[int, ...], ...]:
    """Split columns into contiguous west-to-east runs."""
    runs: list[tuple[int, ...]] = []
    current: list[int] = []
    for x in sorted(columns):
        if current and x != current[-1] + 1:
            runs.append(tuple(current))
            current = []
        current.append(x)
    if current:
        runs.append(tuple(current))
    return tuple(runs)


def _pieces(cells: set[Cell]) -> tuple[frozenset[Cell], ...]:
    """Split cells into four-connected pieces."""
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
    return tuple(found)


def _contacts(left: frozenset[Cell], right: frozenset[Cell]) -> set[tuple[Cell, Cell]]:
    """Cell pairs where one course meets another, sharing an edge, a corner, or the cell itself."""
    return {
        ((x, y), (x + dx, y + dy))
        for x, y in left
        for dx in (-1, 0, 1)
        for dy in (-1, 0, 1)
        if (x + dx, y + dy) in right
    }


def test_water_enters_north_and_leaves_south_in_three_separated_runs(
    batch: dict[int, tuple[Layout, Report]],
) -> None:
    for seed, (layout, report) in batch.items():
        water = _cells(layout, "w")
        assert water == report.water.trunk.union(*report.water.channels), seed

        entry = _runs({x for x, y in report.water.trunk if y == FRAME.cells_y - 1})
        assert len(entry) == 1, seed
        assert WATER["entry_band"][0] <= entry[0][0] and entry[0][-1] <= WATER["entry_band"][1], seed
        assert WATER["trunk_width"][0] <= len(entry[0]) <= WATER["trunk_width"][1], seed

        mouths: list[tuple[int, ...]] = []
        for index, channel in enumerate(report.water.channels):
            runs = _runs({x for x, y in channel if y == 0})
            assert len(runs) == 1, (seed, index)
            assert WATER["channel_width"][0] <= len(runs[0]) <= WATER["channel_width"][1] + 1, seed
            mouths.append(runs[0])
        assert len(_runs({x for x, y in water if y == 0})) == len(report.water.channels), seed
        centres = sorted(sum(run) // len(run) for run in mouths)
        gaps = [right - left for left, right in zip(centres, centres[1:], strict=False)]
        assert min(gaps) >= WATER["mouth_separation"], (seed, gaps)

        assert all(WATER["edge_margin"] <= x < FRAME.cells_x - WATER["edge_margin"] for x, _ in water), seed


def test_courses_only_meet_inside_the_shared_fork_area(
    batch: dict[int, tuple[Layout, Report]],
) -> None:
    for seed, (_, report) in batch.items():
        courses = (report.water.trunk, *report.water.channels)
        for left in range(len(courses)):
            for right in range(left + 1, len(courses)):
                # A meeting counts as inside the shared area when either side of it is shared
                # water, which is the same rule the carver applies while it steers.
                assert all(
                    first in report.water.fork_mask or second in report.water.fork_mask
                    for first, second in _contacts(courses[left], courses[right])
                ), (seed, left, right)
        for index, channel in enumerate(report.water.channels):
            assert len(_pieces(set(channel))) == 1, (seed, index)
        # The walk stops on the step that crosses its line, so the fork lands in the band within
        # one step of it. The road band is sized against that same overshoot.
        depth = FRAME.cells_y - 1 - report.water.fork[1]
        overshoot = math.ceil(WATER["walker"]["step"])
        assert WATER["fork_band"][0] <= depth <= WATER["fork_band"][1] + overshoot, (seed, depth)


def test_grounds_collect_reeds_at_every_mouth(batch: dict[int, tuple[Layout, Report]]) -> None:
    for seed, (layout, report) in batch.items():
        for index, channel in enumerate(report.water.channels):
            mouth = {(x, y) for x, y in channel if y < WATER["edge_straight"]}
            assert any(
                layout.grid.value_at((x + dx, y + dy)) == "e"
                for x, y in mouth
                for dx in (-1, 0, 1)
                for dy in (-1, 0, 1)
                if layout.grid.in_bounds((x + dx, y + dy))
            ), (seed, index)
        assert _cells(layout, "f"), seed


def test_reeds_only_grow_near_water(batch: dict[int, tuple[Layout, Report]]) -> None:
    span = WATER["channel_width"][1] + TUNING["grounds"]["reed_distance"]
    for seed, (layout, _) in batch.items():
        water = _cells(layout, "w")
        for x, y in _cells(layout, "e"):
            assert any(math.dist((x, y), spot) <= span for spot in water), (seed, (x, y))


def test_the_padded_visitor_can_stand_and_walk(batch: dict[int, tuple[Layout, Report]]) -> None:
    """Padding is out of review scope, but a day still has to run on it until the road arrives."""
    for seed, (layout, _) in batch.items():
        cell = layout.grid.cell_at(layout.spawn)
        assert cell is not None, seed
        assert layout.spawn == layout.grid.center(cell), seed
        assert layout.body_clear(layout.spawn), seed
        assert any(layout.body_clear(layout.grid.center(spot)) for spot in layout.grid.neighbours(cell)), seed


def test_majority_smoothing_clears_a_lone_speck() -> None:
    """Smoothing is what turns per-cell thresholds into ground a village can read."""
    tuning = GENERATION.grounds
    rows = [["g"] * FRAME.cells_x for _ in range(FRAME.cells_y)]
    elevation = [[tuning.field_elevation] * FRAME.cells_x for _ in range(FRAME.cells_y)]
    moisture = [[tuning.field_moisture] * FRAME.cells_x for _ in range(FRAME.cells_y)]
    # This one cell fails the dryness test, so before smoothing it stands out as a speck of open
    # ground in the middle of a field.
    moisture[40][40] = 1.0
    assert tuning.smoothing_passes >= 1
    grounds.paint_grounds(rows, elevation, moisture, grounds.water_distance(rows), tuning)
    assert rows[41][41] == "f"
    assert rows[40][40] == "f"


def test_same_seed_builds_match_and_batch_seeds_differ(
    batch: dict[int, tuple[Layout, Report]],
) -> None:
    first = batch[BATCH[0]][0]
    assert generate(BATCH[0])[0] == first
    assert build_village(BATCH[0]) == first
    assert len({layout.grid.rows for layout, _ in batch.values()}) == len(BATCH)


def test_redraw_counts_keep_headroom_under_the_configured_cap(
    batch: dict[int, tuple[Layout, Report]],
) -> None:
    """Exhausting the cap raises, so this watches the headroom rather than the cap itself."""
    for seed, (_, report) in batch.items():
        assert report.seed == seed
        assert 0 <= report.redraws <= TUNING["redraw"]["cap"] // 2, seed


def test_reset_publishes_the_generated_village(batch: dict[int, tuple[Layout, Report]]) -> None:
    env = make_env({"seat_plan": "cast_5", "daynight": False})
    observations, _ = env.reset(seed=BATCH[0])
    village = observations["player_0"]["village"]
    assert village["ground"] == batch[BATCH[0]][0].grid.rows
    assert env.observation_space("player_0").contains(observations["player_0"])
    # A reset with no seed builds the default village, which is the one seed 0 builds.
    default, _ = env.reset()
    assert default["player_0"]["village"]["ground"] == build_village(0).grid.rows


def test_frame_derived_conversion_and_brush_arithmetic() -> None:
    """Pin the conversions the rest of the suite reads, on the shipped one metre frame."""
    assert (FRAME.cells_x, FRAME.cells_y, FRAME.cell_size) == (100, 100, 1.0)
    layout = build_village(BATCH[0])
    assert layout.grid.center((7, 12)) == (7.5, 12.5)
    # An odd brush centres on its cell, and an even one puts the extra cell on the lower index.
    assert {x for x, _ in carve.stamp((40, 40), 3)} == {39, 40, 41}
    assert {x for x, _ in carve.stamp((40, 40), 2)} == {39, 40}
    assert {x for x, _ in carve.stamp((40, 40), 1)} == {40}
    # A round brush of a given width carves exactly that many cells across its centre row.
    assert len([1 for dx, dy in carve.disc_offsets(2.5) if dy == 0]) == 5
    assert len([1 for dx, dy in carve.disc_offsets(3.5) if dy == 0]) == 7


def test_reset_time_is_reported_for_every_batch_seed(
    batch: dict[int, tuple[Layout, Report]], record_property
) -> None:
    """Report generation and validation time per seed. There is no timing limit to pass or fail."""
    for seed, (_, report) in batch.items():
        assert math.isfinite(report.reset_seconds) and report.reset_seconds >= 0.0, seed
        record_property(f"seed_{seed}_reset_seconds", round(report.reset_seconds, 4))
        print(
            f"three_branches reset seed {seed}: "
            f"{report.reset_seconds * 1000:.0f} ms, {report.redraws} redraws"
        )
