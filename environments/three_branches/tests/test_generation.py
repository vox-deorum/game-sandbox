"""Guarantee suite for the seeded village generator, run across the pinned seed batch.

This suite tests structure, not looks. There are no assertions about bend radius, corridor widths,
monotonicity, curvature, bend inventory, or variety: whether a village looks grown is the owner's
call in the browser. Bounds are read from ``generation.json`` rather than restated, so a tuning pass
does not need a test edit. The one exception is the arithmetic test, which deliberately owns its
numbers because it pins the conversions everything else relies on.

Guarantees are re-derived here rather than read back from the generator. The connected region is
flooded again from the layout, and every prop's standing cell is found again from the catalog shape
and the ruleset reach, so a test passes because the village holds up and not because the generator
said so. The one reported record these tests read is the water masks, which no layout publishes.
"""

from __future__ import annotations

import json
import math
from dataclasses import replace
from importlib import resources
from itertools import combinations

import pytest

from three_branches.catalog import BUILDING_BY_TOKEN, CATALOG
from three_branches.env import make_env
from three_branches.generation import Report, build_village, carve, generate, grounds
from three_branches.generation.accessories import _WAY_REACH
from three_branches.generation.config import GENERATION
from three_branches.geometry import (
    Circle,
    Rect,
    circle_intersects_circle,
    circle_intersects_rect,
    distance,
    nearest_point,
)
from three_branches.grid import Cell
from three_branches.layout import Building, Layout, footprint, footprint_cells
from three_branches.rules import FRAME, PROFILE

# Seed 0 is the reset default and seed 17 is the one the shared conformance suite rolls out.
BATCH = (0, 1, 2, 3, 5, 7, 11, 17)
HOMES = ("home_0", "home_1", "home_2", "home_3", "home_4")

TUNING = json.loads(
    resources.files("three_branches.generation").joinpath("generation.json").read_text(encoding="utf-8")
)
WATER = GENERATION.water
ACCESSORIES = TUNING["accessories"]
_ORDER = {kind.token: index for index, kind in enumerate(CATALOG.props)}


@pytest.fixture(scope="module")
def batch() -> dict[int, tuple[Layout, Report]]:
    """Build every pinned seed once and share it, so one suite run is one build per seed."""
    return {seed: generate(seed) for seed in BATCH}


@pytest.fixture(scope="module")
def connected(batch: dict[int, tuple[Layout, Report]]) -> dict[int, frozenset[Cell]]:
    """Flood each village from its spawn, using the clearance physics uses.

    This is derived here rather than taken from the generator, so the connectivity guarantee is
    established from the layout the browser receives.
    """
    return {seed: _flood(layout) for seed, (layout, _) in batch.items()}


def _flood(layout: Layout) -> frozenset[Cell]:
    start = layout.grid.cell_at(layout.spawn)
    if start is None or not layout.body_clear(layout.spawn):
        return frozenset()
    reached = {start}
    pending = [start]
    while pending:
        cell = pending.pop()
        here = layout.grid.center(cell)
        for spot in layout.grid.neighbours(cell):
            if spot in reached or not layout.body_clear(layout.grid.center(spot)):
                continue
            there = layout.grid.center(spot)
            if not layout.body_clear(((here[0] + there[0]) / 2, (here[1] + there[1]) / 2)):
                continue
            reached.add(spot)
            pending.append(spot)
    return frozenset(reached)


def _all_cells() -> tuple[Cell, ...]:
    return tuple((x, y) for y in range(FRAME.cells_y) for x in range(FRAME.cells_x))


def _around(cell: Cell) -> tuple[Cell, ...]:
    x, y = cell
    return ((x, y - 1), (x - 1, y), (x + 1, y), (x, y + 1))


def _window(cell: Cell, width: int, height: int, reach: int) -> tuple[Cell, ...]:
    x, y = cell
    return tuple(
        (column, row)
        for row in range(y - reach, y + height + reach)
        for column in range(x - reach, x + width + reach)
        if 0 <= column < FRAME.cells_x and 0 <= row < FRAME.cells_y
    )


def _in_reach(layout: Layout, cell: Cell, shape: Rect | Circle) -> bool:
    """The ruleset's own use rule: stand clear, within reach, with an unblocked line to the prop."""
    centre = layout.grid.center(cell)
    spot = nearest_point(centre, shape)
    return (
        layout.body_clear(centre)
        and distance(centre, spot) <= PROFILE.prop_reach
        and layout.line_clear(centre, spot)
    )


def _rectangle(building: Building) -> frozenset[Cell]:
    kind = BUILDING_BY_TOKEN[building.type]
    x, y = building.cell
    return frozenset(
        (column, row) for row in range(y, y + kind.height) for column in range(x, x + kind.width)
    )


def _grown(rectangle: frozenset[Cell], margin: int) -> frozenset[Cell]:
    return (
        frozenset(
            (x + dx, y + dy)
            for x, y in rectangle
            for dx in range(-margin, margin + 1)
            for dy in range(-margin, margin + 1)
        )
        - rectangle
    )


def _garden_offsets(plot: object, building: Building) -> tuple[int, int]:
    """The gap and slide of a plot against its home, read from the cells alone.

    The gap is cells of open ground between the wall and the plot's near edge. The slide is how far
    the plot's near corner sits from the home's origin along the wall.
    """
    kind = BUILDING_BY_TOKEN[building.type]
    width, height = footprint(plot)
    x, y = building.cell
    px, py = plot.cell
    if building.facing == "north":
        return y - py - height, px - x
    if building.facing == "south":
        return py - y - kind.height, px - x
    if building.facing == "east":
        return x - px - width, py - y
    return px - x - kind.width, py - y


def _decks(layout: Layout, channel: frozenset[Cell]) -> tuple[frozenset[Cell], frozenset[Cell]]:
    """Split a channel's bridge ground into the road's deck and any footpath's.

    Both are bridge ground, so they are told apart by shape: the road decks a channel at its own
    width, and a footpath decks it at a narrower one.
    """
    width = TUNING["network"]["road"]["width"]
    road: set[Cell] = set()
    walked: set[Cell] = set()
    for piece in _pieces({cell for cell in _cells(layout, "b") if cell in channel}):
        rows = {y for _, y in piece}
        columns = {x for x, _ in piece}
        (road if min(len(rows), len(columns)) >= width else walked).update(piece)
    return frozenset(road), frozenset(walked)


def _road_cells(layout: Layout, report: Report) -> set[Cell]:
    """The road itself: its paved ground plus the decks it carries over the channels."""
    road = _cells(layout, "r")
    for channel in report.water.channels:
        road |= _decks(layout, channel)[0]
    return road


def _without(layout: Layout, token: str) -> tuple[tuple[str, str, Cell, str], ...]:
    return tuple((item.id, item.type, item.cell, item.facing) for item in layout.props if item.type != token)


def _cells(layout: Layout, codes: str) -> set[Cell]:
    return {(x, y) for y, row in enumerate(layout.grid.rows) for x, code in enumerate(row) if code in codes}


def _nearest_way(layout: Layout, centre: tuple[float, float], code: str) -> tuple[float, float] | None:
    """The nearest ``code`` cell centre within reach of a point, or None."""
    best: tuple[float, tuple[float, float]] | None = None
    for row in range(int(centre[1]) - _WAY_REACH, int(centre[1]) + _WAY_REACH + 1):
        for column in range(int(centre[0]) - _WAY_REACH, int(centre[0]) + _WAY_REACH + 1):
            if not layout.grid.in_bounds((column, row)) or layout.grid.value_at((column, row)) != code:
                continue
            spot = (column + 0.5, row + 0.5)
            distance = math.dist(spot, centre)
            if best is None or distance < best[0]:
                best = (distance, spot)
    return None if best is None else best[1]


def _cardinal(direction: tuple[float, float]) -> str:
    if abs(direction[0]) >= abs(direction[1]):
        return "east" if direction[0] >= 0 else "west"
    return "north" if direction[1] >= 0 else "south"


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
        courses = report.water.trunk.union(*report.water.channels)
        # Every open water cell belongs to a course, and the only course cells that are not open
        # water are the ones a bridge was decked over.
        assert water <= courses, seed
        assert courses - water <= _cells(layout, "b"), seed

        entry = _runs({x for x, y in report.water.trunk if y == FRAME.cells_y - 1})
        assert len(entry) == 1, seed
        assert WATER.entry_band[0] <= entry[0][0] and entry[0][-1] <= WATER.entry_band[1], seed
        assert WATER.trunk_width[0] <= len(entry[0]) <= WATER.trunk_width[1], seed

        mouths: list[tuple[int, ...]] = []
        for index, channel in enumerate(report.water.channels):
            runs = _runs({x for x, y in channel if y == 0})
            assert len(runs) == 1, (seed, index)
            assert WATER.channel_width[0] <= len(runs[0]) <= WATER.channel_width[1] + 1, seed
            mouths.append(runs[0])
        assert len(_runs({x for x, y in water if y == 0})) == len(report.water.channels), seed
        centres = sorted(sum(run) // len(run) for run in mouths)
        gaps = [right - left for left, right in zip(centres, centres[1:], strict=False)]
        assert min(gaps) >= WATER.mouth_separation, (seed, gaps)

        assert all(WATER.edge_margin <= x < FRAME.cells_x - WATER.edge_margin for x, _ in water), seed


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
        overshoot = math.ceil(WATER.walker.step)
        assert WATER.fork_band[0] <= depth <= WATER.fork_band[1] + overshoot, (seed, depth)


def test_grounds_collect_reeds_at_every_mouth(batch: dict[int, tuple[Layout, Report]]) -> None:
    for seed, (layout, report) in batch.items():
        for index, channel in enumerate(report.water.channels):
            mouth = {(x, y) for x, y in channel if y < WATER.edge_straight}
            assert any(
                layout.grid.value_at((x + dx, y + dy)) == "e"
                for x, y in mouth
                for dx in (-1, 0, 1)
                for dy in (-1, 0, 1)
                if layout.grid.in_bounds((x + dx, y + dy))
            ), (seed, index)
        assert _cells(layout, "f"), seed


def test_reeds_only_grow_near_water(batch: dict[int, tuple[Layout, Report]]) -> None:
    span = WATER.channel_width[1] + TUNING["grounds"]["reed_distance"]
    for seed, (layout, _) in batch.items():
        water = _cells(layout, "w")
        for x, y in _cells(layout, "e"):
            assert any(math.dist((x, y), spot) <= span for spot in water), (seed, (x, y))


def test_stable_features_appear_once_and_prop_ids_run_without_a_gap(
    batch: dict[int, tuple[Layout, Report]],
) -> None:
    for seed, (layout, _) in batch.items():
        assert {building.id for building in layout.buildings} == {*HOMES, "inn", "shed"}, seed
        held: dict[str, list[str]] = {}
        for item in layout.props:
            held.setdefault(item.type, []).append(item.id)
        for token in ("pump", "board", "hearth", "repair_bench", "bell"):
            assert held[token] == [f"{token}_0"], (seed, token)
        assert len(held["stall"]) == ACCESSORIES["stall"]["count"], seed
        assert len(held["plot"]) == len(HOMES), seed
        assert len(held["shrine"]) == ACCESSORIES["shrine"]["count"], seed
        for token, ids in held.items():
            numbers = sorted(int(name.rsplit("_", 1)[1]) for name in ids)
            assert numbers == list(range(len(ids))), (seed, token)
        # Catalog type order, then placement order within a type, is the published prop order.
        order = [_ORDER[item.type] for item in layout.props]
        assert order == sorted(order), seed


def test_walkable_ground_forms_one_body_clear_region(
    batch: dict[int, tuple[Layout, Report]], connected: dict[int, frozenset[Cell]]
) -> None:
    """The village's own ground is one region: no road, path, deck, doorway, or floor is cut off.

    Open country beyond a channel is not the village and is not claimed to be reachable, so this
    asks the question of the ground the village actually built.
    """
    for seed, (layout, _) in batch.items():
        village = {
            cell
            for cell in _all_cells()
            if layout.grid.value_at(cell) in "rpbdi" and layout.body_clear(layout.grid.center(cell))
        }
        assert village, seed
        assert village <= connected[seed], (seed, sorted(village - connected[seed])[:6])


def test_every_doorway_and_start_pose_joins_the_village(
    batch: dict[int, tuple[Layout, Report]], connected: dict[int, frozenset[Cell]]
) -> None:
    for seed, (layout, _) in batch.items():
        for building in layout.buildings:
            doorway = layout.doorway(building.id)
            assert len(doorway) == BUILDING_BY_TOKEN[building.type].door_width, (seed, building.id)
            for cell in doorway:
                assert layout.grid.value_at(cell) == "d", (seed, building.id)
                assert cell in connected[seed], (seed, building.id, cell)
            if building.type != "home":
                continue
            for resident in (0, 1):
                pose = layout.residence_pose(building.id, resident)
                assert layout.body_clear(pose.position), (seed, building.id, resident)
                assert layout.grid.cell_at(pose.position) in connected[seed], (seed, building.id)


def test_every_prop_has_an_independently_found_reachable_witness(
    batch: dict[int, tuple[Layout, Report]], connected: dict[int, frozenset[Cell]]
) -> None:
    """Find a standing cell for each prop from the catalog and the ruleset, not from the report."""
    for seed, (layout, report) in batch.items():
        banked = dict(report.witnesses)
        for item in layout.props:
            shape = layout.shape_for(item)
            width, height = footprint(item)
            reach = math.ceil(PROFILE.prop_reach) + 1
            found = [
                cell
                for cell in _window(item.cell, width, height, reach)
                if cell in connected[seed] and _in_reach(layout, cell, shape)
            ]
            assert found, (seed, item.id)
            # The generator's own record is checked against the same rule, but never relied on.
            assert _in_reach(layout, banked[item.id], shape), (seed, item.id)


def test_every_batch_seed_keeps_lanterns_and_pines(
    batch: dict[int, tuple[Layout, Report]],
) -> None:
    """Each batch seed ships at least one lantern and one pine, which cut-off dressing used to eat."""
    for seed, (layout, _) in batch.items():
        assert any(item.type == "lantern" for item in layout.props), seed
        assert any(item.type == "pine" for item in layout.scenery), seed


def test_pines_ship_a_drawn_visual_size_and_crates_keep_the_default(
    batch: dict[int, tuple[Layout, Report]],
) -> None:
    """Every pine draws a size in range or shrinks to the base size when the drawn solid would not
    fit; crates never vary."""
    low, high = TUNING["accessories"]["pine"]["size"]
    drew_big = False
    for seed, (layout, _) in batch.items():
        for item in layout.scenery:
            if item.type == "pine":
                assert item.scale == 1.0 or low <= item.scale <= high, (seed, item.cell, item.scale)
                drew_big = drew_big or item.scale != 1.0
            else:
                assert item.scale == 1.0, (seed, item.cell)
    assert drew_big, "the randomized pine size must actually grow at least one planted tree"


def test_market_crates_keep_their_full_footprint_on_standable_ground(
    batch: dict[int, tuple[Layout, Report]],
) -> None:
    """A crate reserves four cells of ground nobody walks over; it no longer dresses a stall."""
    for seed, (layout, _) in batch.items():
        for crate in [item for item in layout.scenery if item.type == "crate"]:
            crate_cells = set(footprint_cells(crate))
            assert footprint(crate) == (2, 2), (seed, crate.cell)
            assert len(crate_cells) == 4, (seed, crate.cell)
            assert all(layout.grid.value_at(cell) in "gfe" for cell in crate_cells), (seed, crate.cell)


def test_no_two_published_solids_overlap(
    batch: dict[int, tuple[Layout, Report]],
) -> None:
    """A scaled pine can never cover another object: every pair of published solids is disjoint."""
    for seed, (layout, _) in batch.items():
        for first, second in combinations(layout.solids, 2):
            assert not _solids_overlap(first, second), (seed, first, second)


def _solids_overlap(first: Rect | Circle, second: Rect | Circle) -> bool:
    if isinstance(first, Circle) and isinstance(second, Circle):
        return circle_intersects_circle((first.x, first.y), first.radius, second)
    if isinstance(first, Circle) and isinstance(second, Rect):
        return circle_intersects_rect((first.x, first.y), first.radius, second)
    if isinstance(first, Rect) and isinstance(second, Circle):
        return circle_intersects_rect((second.x, second.y), second.radius, first)
    return first.x < second.right and second.x < first.right and first.y < second.top and second.y < first.top


def test_sites_keep_their_margin_and_are_painted_from_the_catalog(
    batch: dict[int, tuple[Layout, Report]],
) -> None:
    margin = TUNING["sites"]["margin"]
    for seed, (layout, _) in batch.items():
        rectangles = {building.id: _rectangle(building) for building in layout.buildings}
        for building in layout.buildings:
            rectangle = rectangles[building.id]
            doors = set(layout.doorway(building.id))
            for cell in rectangle:
                wall = any(spot not in rectangle for spot in _around(cell))
                wanted = "d" if cell in doors else "x" if wall else "i"
                assert layout.grid.value_at(cell) == wanted, (seed, building.id, cell)
            for cell in _grown(rectangle, margin):
                if not layout.grid.in_bounds(cell):
                    continue
                assert layout.grid.value_at(cell) not in {"w", "r", "b"}, (seed, building.id, cell)
                assert all(cell not in other for name, other in rectangles.items() if name != building.id), (
                    seed,
                    building.id,
                    cell,
                )


def test_gardens_face_away_from_the_doorway_within_the_garden_offsets(
    batch: dict[int, tuple[Layout, Report]],
) -> None:
    """Each plot stands on the wall opposite its home's doorway, at a drawn gap and slide.

    Bounds come from the tuning, and the batch has to show variety: somewhere a plot clears the
    wall, and somewhere one is not planted at the same place on it.
    """
    gap_max = TUNING["sites"]["garden_gap"]
    slide = TUNING["sites"]["garden_slide"]
    gaps: set[int] = set()
    slides: set[int] = set()
    for seed, (layout, _) in batch.items():
        homes = [building for building in layout.buildings if building.type == "home"]
        plots = [item for item in layout.props if item.type == "plot"]
        assert len(plots) == len(homes), seed
        for plot in plots:
            building = min(homes, key=lambda home: _centre_distance(plot, home))
            kind = BUILDING_BY_TOKEN[building.type]
            width, height = footprint(plot)
            gap, offset = _garden_offsets(plot, building)
            assert 0 <= gap <= gap_max, (seed, building.id, gap)
            wall, plot_len = (
                (kind.width, width) if building.facing in {"north", "south"} else (kind.height, height)
            )
            assert -slide <= offset <= wall - plot_len + slide, (seed, building.id, offset)
            gaps.add(gap)
            slides.add(offset)
    assert len(gaps) > 1, "the garden gap must not always be zero"
    assert len(slides) > 1, "the garden must not always sit at the same place on the wall"


def _centre_distance(plot: object, building: Building) -> float:
    """The distance between a plot's footprint centre and a home's rectangle centre."""
    width, height = footprint(plot)
    px, py = plot.cell
    kind = BUILDING_BY_TOKEN[building.type]
    x, y = building.cell
    return math.dist((px + width / 2, py + height / 2), (x + kind.width / 2, y + kind.height / 2))


def test_interior_props_stay_on_floor_and_leave_the_doorway_open(
    batch: dict[int, tuple[Layout, Report]],
) -> None:
    for seed, (layout, _) in batch.items():
        for building_id, token in (("inn", "hearth"), ("shed", "repair_bench")):
            item = next(prop for prop in layout.props if prop.type == token)
            doors = set(layout.doorway(building_id))
            for cell in footprint_cells(item):
                assert layout.grid.value_at(cell) == "i", (seed, token, cell)
                assert cell not in doors, (seed, token)


def test_no_two_placements_share_a_cell(batch: dict[int, tuple[Layout, Report]]) -> None:
    for seed, (layout, _) in batch.items():
        placed = [cell for item in (*layout.props, *layout.scenery) for cell in footprint_cells(item)]
        assert len(placed) == len(set(placed)), seed
        assert all(layout.grid.in_bounds(cell) for cell in placed), seed


def test_the_road_spans_the_frame_and_bridges_every_channel_once(
    batch: dict[int, tuple[Layout, Report]],
) -> None:
    band = GENERATION.network.road.band
    third = FRAME.cells_x // 3
    for seed, (layout, report) in batch.items():
        road = _road_cells(layout, report)
        assert len(_pieces(road)) == 1, seed
        assert any(x == 0 for x, _ in road) and any(x == FRAME.cells_x - 1 for x, _ in road), seed
        assert all(band[0] <= y <= band[1] for _, y in road), seed
        # The road belongs to every third of the frame, which is what carries it past the districts.
        for low, high in ((0, third), (third, 2 * third), (2 * third, FRAME.cells_x)):
            assert any(low <= x < high for x, _ in road), (seed, low)
        # The trunk is the water the road stays south of, so nothing ever decks it.
        assert not _cells(layout, "b") & report.water.trunk, seed
        for index, channel in enumerate(report.water.channels):
            deck, _ = _decks(layout, channel)
            assert deck, (seed, index)
            assert len(_pieces(deck)) == 1, (seed, index)


def test_bridge_decks_carry_the_road_width_and_land_on_dry_aprons(
    batch: dict[int, tuple[Layout, Report]],
) -> None:
    road_tuning = TUNING["network"]["road"]
    for seed, (layout, report) in batch.items():
        for index, channel in enumerate(report.water.channels):
            deck, _ = _decks(layout, channel)
            rows = {y for _, y in deck}
            columns = {x for x, _ in deck}
            assert len(rows) == road_tuning["width"], (seed, index)
            assert len(columns) <= road_tuning["crossing_run"] - 2 * road_tuning["apron"], (seed, index)
            for row in rows:
                span = sorted(x for x, y in deck if y == row)
                for step in range(1, road_tuning["apron"] + 1):
                    for column in (span[0] - step, span[-1] + step):
                        assert layout.grid.value_at((column, row)) in {"r", "b"}, (seed, index)


def test_the_visitor_spawns_on_the_road_at_the_configured_inset(
    batch: dict[int, tuple[Layout, Report]], connected: dict[int, frozenset[Cell]]
) -> None:
    spawn_tuning = TUNING["network"]["spawn"]
    for seed, (layout, _) in batch.items():
        cell = layout.grid.cell_at(layout.spawn)
        assert cell is not None and layout.spawn == layout.grid.center(cell), seed
        assert layout.grid.value_at(cell) == "r", seed
        assert cell[0] == spawn_tuning["edge_inset"], seed
        assert layout.body_clear(layout.spawn, spawn_tuning["clearance"]), seed
        assert cell in connected[seed], seed


def test_footpaths_join_the_road_to_the_plaza_the_homes_and_the_shrines(
    batch: dict[int, tuple[Layout, Report]],
) -> None:
    """Every place a path is promised to reach has one, and the whole network hangs off the road."""
    plaza = TUNING["sites"]["plaza_radius"]
    roadside = TUNING["accessories"]["setback"] + TUNING["network"]["road"]["width"]
    for seed, (layout, _) in batch.items():
        ways = _cells(layout, "rpb")
        assert len(_pieces(ways)) == 1, seed
        for building in layout.buildings:
            for cell in layout.doorway(building.id):
                assert any(spot in ways for spot in _around(cell)), (seed, building.id, cell)
        # A shrine stands one setback off the road, so the road it was placed against is its way,
        # and the plaza's footpath is promised to the plaza rather than to the pump standing in it.
        for item in layout.props:
            if item.type == "shrine":
                assert any(math.dist(item.cell, spot) <= roadside + 1 for spot in ways), (seed, item.id)
        pump = next(item for item in layout.props if item.type == "pump").cell
        assert any(math.dist(pump, spot) <= plaza + 2 for spot in ways), (seed, pump)


def test_stalls_and_shrines_front_the_nearest_way(batch: dict[int, tuple[Layout, Report]]) -> None:
    """A stall or shrine faces the nearest road cell, or the nearest path when no road is close."""
    for seed, (layout, _) in batch.items():
        for item in layout.props:
            if item.type not in {"stall", "shrine"}:
                continue
            width, height = footprint(item)
            centre = (item.cell[0] + width / 2, item.cell[1] + height / 2)
            spot = _nearest_way(layout, centre, "r") or _nearest_way(layout, centre, "p")
            assert spot is not None, (seed, item.id, "no way in reach to front")
            assert item.facing == _cardinal((spot[0] - centre[0], spot[1] - centre[1])), (seed, item.id)


def test_shrines_stand_on_the_north_side_of_the_road(
    batch: dict[int, tuple[Layout, Report]],
) -> None:
    """A shrine fronts the road's north bank: nothing in its own columns stands above its centre."""
    for seed, (layout, _) in batch.items():
        for item in layout.props:
            if item.type != "shrine":
                continue
            width, height = footprint(item)
            centre_y = item.cell[1] + height / 2
            for column in range(item.cell[0], item.cell[0] + width):
                assert all(
                    layout.grid.value_at((column, row)) not in {"r", "b"} or row < centre_y
                    for row in range(FRAME.cells_y)
                ), (seed, item.id, column)


def test_a_footpath_that_cannot_be_walked_is_still_laid_along_its_route() -> None:
    """A walk out of steps hands its leg back to the search, which is what joins every doorway."""
    network = GENERATION.network
    path = network.path
    stranded = replace(
        GENERATION,
        network=replace(network, path=replace(path, walker=replace(path.walker, step_budget=0))),
    )
    layout, _ = generate(BATCH[0], stranded)
    assert len(_pieces(_cells(layout, "rpb"))) == 1
    for building in layout.buildings:
        for cell in layout.doorway(building.id):
            assert any(spot in _cells(layout, "rpb") for spot in _around(cell)), (building.id, cell)


def test_each_channel_carries_at_most_one_footpath_crossing(
    batch: dict[int, tuple[Layout, Report]],
) -> None:
    """Road decks and path decks are both bridge ground, so a channel carries at most two."""
    for seed, (layout, report) in batch.items():
        decks = _cells(layout, "b")
        for index, channel in enumerate(report.water.channels):
            assert len(_pieces({cell for cell in decks if cell in channel})) <= 2, (seed, index)


def test_lantern_and_pine_skips_do_not_move_the_land_road_or_buildings(
    batch: dict[int, tuple[Layout, Report]],
) -> None:
    """Optional dressing is skipped where it will not fit, and nothing before it is drawn again."""
    seed = next(
        seed
        for seed, (normal, report) in batch.items()
        if report.redraws == 0
        and any(item.type == "lantern" for item in normal.props)
        and any(item.type == "pine" for item in normal.scenery)
    )
    far = FRAME.cells_x * 2
    accessories = GENERATION.accessories
    starved = replace(
        GENERATION,
        accessories=replace(
            accessories,
            lantern=replace(accessories.lantern, spacing=far, market_spacing=far),
            pine=replace(accessories.pine, spacing=far, scatter=1),
        ),
    )
    layout, report = generate(seed, starved)
    normal, expected = batch[seed]
    assert layout.grid.rows == normal.grid.rows
    assert layout.buildings == normal.buildings
    assert report.redraws == expected.redraws
    for kind in (layout, normal):
        assert any(item.type == "lantern" for item in kind.props)
    assert _without(layout, "lantern") == _without(normal, "lantern")
    assert sum(1 for item in layout.props if item.type == "lantern") < sum(
        1 for item in normal.props if item.type == "lantern"
    )


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
    assert (FRAME.cells_x, FRAME.cells_y, FRAME.cell_size) == (120, 120, 1.0)
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
