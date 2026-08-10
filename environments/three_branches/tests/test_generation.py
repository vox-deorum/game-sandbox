"""Structural guarantees for the seeded terrain, site, and road network layers across the batch.

The suite tests structure, not aesthetics. The look of the land is the review rounds'
jurisdiction, so there are no curvature, heading, or variety assertions here.
"""

from __future__ import annotations

import itertools
import json
import math
import struct
from functools import cache
from time import perf_counter

import pytest

from three_branches.engine import Day, DayConfig
from three_branches.env import ThreeBranchesEnv
from three_branches.generation import (
    BOUNDARY_MARGIN,
    BUILDING_GAP,
    HOME_CLUSTER_RADIUS,
    MAX_POLYLINE_POINTS,
    SPAWN_CLEARANCE,
    WATER_CLEARANCE,
    build_village,
)
from three_branches.geometry import (
    Point,
    add,
    distance,
    distance_to_rectangle,
    distance_to_segment,
    heading_vector,
    polyline_distance,
    rectangle_corners,
    segments_intersect,
)
from three_branches.layout import BUILDING_ROSTER, WORLD_SIZE, Bridge, Layout
from three_branches.overlay import encode_overlay_static

BATCH_SEEDS = (0, 1, 2, 3, 5, 7, 11, 17)
_CADENCE_SECONDS = 0.250
_MAX_STATIC_BYTES = 12 * 1024


@cache
def _village(seed: int) -> Layout:
    return build_village(seed)


def _segments(points: tuple[Point, ...], closed: bool) -> list[tuple[Point, Point]]:
    segments = list(itertools.pairwise(points))
    if closed:
        segments.append((points[-1], points[0]))
    return segments


def _self_crossing(points: tuple[Point, ...], closed: bool) -> bool:
    segments = _segments(points, closed)
    for index, first in enumerate(segments):
        for second in segments[index + 1 :]:
            if first[0] in second or first[1] in second:
                continue
            if segments_intersect(first, second):
                return True
    return False


def _lines_crossing(first: tuple[Point, ...], second: tuple[Point, ...]) -> bool:
    for a in itertools.pairwise(first):
        for b in itertools.pairwise(second):
            if a[0] in b or a[1] in b:
                continue
            if segments_intersect(a, b):
                return True
    return False


def _component_count(points: tuple[Point, ...], link_distance: float) -> int:
    """Count single-linkage clusters: points join a cluster when within link_distance of a member."""
    parents = list(range(len(points)))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    for first, second in itertools.combinations(range(len(points)), 2):
        if distance(points[first], points[second]) <= link_distance:
            root_first, root_second = find(first), find(second)
            if root_first != root_second:
                parents[root_first] = root_second

    return len({find(index) for index in range(len(points))})


def _f32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", value))[0]


def _point_matches(observed: dict, point: Point) -> bool:
    return float(observed["x"]) == _f32(point[0]) and float(observed["y"]) == _f32(point[1])


def _deck_axis(bridge: Bridge) -> tuple[Point, Point]:
    forward = heading_vector(bridge.heading)
    half = bridge.span / 2.0
    return add(bridge.position, forward, -half), add(bridge.position, forward, half)


def _crossed_channels(bridge: Bridge, layout: Layout) -> list[int]:
    """The channel indices whose centerline the deck axis crosses."""
    axis = _deck_axis(bridge)
    return [
        index
        for index, channel in enumerate(layout.channels)
        if any(segments_intersect(axis, piece) for piece in itertools.pairwise(channel.points))
    ]


def _on_polyline(point: Point, points: tuple[Point, ...]) -> bool:
    return polyline_distance(point, points) <= 1e-6


def _road_decks(layout: Layout) -> list[Bridge]:
    return [bridge for bridge in layout.bridges if _on_polyline(bridge.position, layout.road.points)]


def _line_samples(points: tuple[Point, ...], spacing: float = 0.25) -> list[Point]:
    samples: list[Point] = [points[0]]
    for start, end in itertools.pairwise(points):
        steps = max(1, math.ceil(distance(start, end) / spacing))
        run = (end[0] - start[0], end[1] - start[1])
        samples.extend(add(start, run, step / steps) for step in range(1, steps + 1))
    return samples


def _nearest_point_on(point: Point, points: tuple[Point, ...]) -> Point:
    best: Point = points[0]
    best_span = math.inf
    for start, end in itertools.pairwise(points):
        run = (end[0] - start[0], end[1] - start[1])
        length_squared = run[0] * run[0] + run[1] * run[1]
        if length_squared == 0.0:
            candidate = start
        else:
            offset = (point[0] - start[0], point[1] - start[1])
            t = max(0.0, min(1.0, (offset[0] * run[0] + offset[1] * run[1]) / length_squared))
            candidate = add(start, run, t)
        span = distance(point, candidate)
        if span < best_span:
            best_span = span
            best = candidate
    return best


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_trunk_enters_the_north_edge_inside_its_middle_third(seed: int) -> None:
    trunk = _village(seed).channels[0]
    entry = trunk.points[0]
    assert entry[1] == WORLD_SIZE
    assert WORLD_SIZE / 3.0 <= entry[0] <= WORLD_SIZE * 2.0 / 3.0


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_channels_fan_from_one_fork_inside_the_band(seed: int) -> None:
    layout = _village(seed)
    fork = layout.channels[0].points[-1]
    assert 40.0 <= fork[1] <= 60.0
    for channel in layout.channels[1:]:
        assert channel.points[0] == fork
    assert len(layout.water_confluence_disks) == 1
    assert layout.water_confluence_disks[0][0] == fork


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_widths_stay_inside_their_bounds(seed: int) -> None:
    layout = _village(seed)
    assert 5.0 <= layout.channels[0].width <= 7.0
    for channel in layout.channels[1:]:
        assert 2.5 <= channel.width <= 4.0
    assert 4.0 <= layout.road.width <= 5.0
    for path in layout.footpaths:
        assert 1.5 <= path.width <= 2.5
    for bridge in layout.bridges:
        assert 2.0 <= bridge.width <= 3.0


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_mouths_land_apart_on_the_south_edge_inside_the_margin(seed: int) -> None:
    mouths = [channel.points[-1] for channel in _village(seed).channels[1:]]
    for mouth in mouths:
        assert mouth[1] == 0.0
        assert 10.0 <= mouth[0] <= WORLD_SIZE - 10.0
    xs = [mouth[0] for mouth in mouths]
    assert xs == sorted(xs)
    for west, east in itertools.pairwise(xs):
        assert east - west >= 20.0


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_water_never_crosses_itself_or_a_sibling(seed: int) -> None:
    channels = _village(seed).channels
    for channel in channels:
        assert not _self_crossing(channel.points, closed=False)
    for first, second in itertools.combinations(channels, 2):
        assert not _lines_crossing(first.points, second.points)


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_terrace_and_reed_polygons_stay_simple(seed: int) -> None:
    layout = _village(seed)
    for polygon in (*layout.fields, *layout.reed_banks):
        assert len(polygon) >= 3
        assert not _self_crossing(polygon, closed=True)


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_buildings_follow_the_canonical_roster_order(seed: int) -> None:
    layout = _village(seed)
    assert tuple((building.id, building.type) for building in layout.buildings) == BUILDING_ROSTER


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_homes_gather_in_two_or_three_clusters(seed: int) -> None:
    layout = _village(seed)
    homes = tuple(building.center for building in layout.buildings if building.type == "home")
    assert _component_count(homes, HOME_CLUSTER_RADIUS * 2 + 1.0) in (2, 3)


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_buildings_clear_each_other(seed: int) -> None:
    layout = _village(seed)
    for first, second in itertools.combinations(layout.buildings, 2):
        first_corners = rectangle_corners(first.center, first.width, first.depth, first.rotation)
        second_corners = rectangle_corners(second.center, second.width, second.depth, second.rotation)
        for edge_a, edge_b in itertools.product(
            _segments(first_corners, closed=True), _segments(second_corners, closed=True)
        ):
            assert not segments_intersect(edge_a, edge_b)
        for corner in first_corners:
            gap = distance_to_rectangle(corner, second.center, second.width, second.depth, second.rotation)
            assert gap >= BUILDING_GAP - 1e-6
        for corner in second_corners:
            gap = distance_to_rectangle(corner, first.center, first.width, first.depth, first.rotation)
            assert gap >= BUILDING_GAP - 1e-6


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_buildings_clear_water_and_the_confluence(seed: int) -> None:
    layout = _village(seed)
    for building in layout.buildings:
        rectangle = (building.center, building.width, building.depth, building.rotation)
        corners = rectangle_corners(*rectangle)
        edges = _segments(corners, closed=True)
        for channel in layout.channels:
            channel_segments = list(itertools.pairwise(channel.points))
            for channel_segment, edge in itertools.product(channel_segments, edges):
                assert not segments_intersect(channel_segment, edge)
            clearances = [
                distance_to_segment(corner, start, end)
                for corner in corners
                for start, end in channel_segments
            ]
            clearances.extend(distance_to_rectangle(point, *rectangle) for point in channel.points)
            assert min(clearances) >= channel.width / 2 + WATER_CLEARANCE - 1e-6
        for center, radius in layout.water_confluence_disks:
            assert distance_to_rectangle(center, *rectangle) >= radius + WATER_CLEARANCE - 1e-6


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_buildings_stay_inside_the_boundary(seed: int) -> None:
    layout = _village(seed)
    lower, upper = BOUNDARY_MARGIN - 1e-6, WORLD_SIZE - BOUNDARY_MARGIN + 1e-6
    for building in layout.buildings:
        for x, y in rectangle_corners(building.center, building.width, building.depth, building.rotation):
            assert lower <= x <= upper
            assert lower <= y <= upper


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_doorways_sit_on_their_perimeters_and_open_onto_dry_ground(seed: int) -> None:
    layout = _village(seed)
    for building in layout.buildings:
        corners = rectangle_corners(building.center, building.width, building.depth, building.rotation)
        edges = _segments(corners, closed=True)
        position = building.doorway.position
        nearest = min(distance_to_segment(position, *edge) for edge in edges)
        assert nearest <= 1e-6
        outward_x = position[0] - building.center[0]
        outward_y = position[1] - building.center[1]
        length = math.hypot(outward_x, outward_y)
        threshold = (position[0] + outward_x / length, position[1] + outward_y / length)
        assert layout.ground_at(threshold) != "water"
        assert layout.in_bounds(threshold)


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_road_runs_west_to_east_south_of_the_fork(seed: int) -> None:
    layout = _village(seed)
    entry = layout.road.points[0]
    exit_point = layout.road.points[-1]
    assert entry[0] == 0.0
    assert exit_point[0] == WORLD_SIZE
    assert entry[1] < layout.channels[0].points[-1][1]


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_road_crosses_each_channel_once_at_its_deck_and_never_the_trunk(seed: int) -> None:
    layout = _village(seed)
    road_decks = _road_decks(layout)
    for index, channel in enumerate(layout.channels):
        decks = [bridge for bridge in road_decks if index in _crossed_channels(bridge, layout)]
        crossing_segments = [
            segment
            for segment in itertools.pairwise(layout.road.points)
            if any(segments_intersect(segment, piece) for piece in itertools.pairwise(channel.points))
        ]
        if index == 0:
            assert decks == []
            assert crossing_segments == []
        else:
            assert len(decks) == 1
            assert crossing_segments
            for segment in crossing_segments:
                assert all(decks[0].distance_to(endpoint) <= 1e-6 for endpoint in segment)


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_footpath_bridges_stay_inside_their_per_channel_budget(seed: int) -> None:
    layout = _village(seed)
    footpath_decks = [bridge for bridge in layout.bridges if bridge not in _road_decks(layout)]
    for deck in footpath_decks:
        assert any(_on_polyline(deck.position, path.points) for path in layout.footpaths)
    for index in range(len(layout.channels)):
        crossing = [deck for deck in footpath_decks if index in _crossed_channels(deck, layout)]
        assert len(crossing) <= (0 if index == 0 else 1)


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_decks_span_their_water_clear_of_the_confluence(seed: int) -> None:
    layout = _village(seed)
    cap_center, cap_radius = layout.water_confluence_disks[0]
    for bridge in layout.bridges:
        crossed = _crossed_channels(bridge, layout)
        assert len(crossed) == 1
        for endpoint in _deck_axis(bridge):
            for channel in layout.channels:
                assert polyline_distance(endpoint, channel.points) > channel.width / 2.0
        assert bridge.distance_to(cap_center) > cap_radius


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_paths_touch_water_only_on_a_deck(seed: int) -> None:
    layout = _village(seed)
    for line in (layout.road, *layout.footpaths):
        for sample in _line_samples(line.points):
            wet = any(
                polyline_distance(sample, channel.points) <= channel.width / 2.0
                for channel in layout.channels
            )
            if wet:
                assert any(bridge.contains(sample) for bridge in layout.bridges)


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_spawn_sits_on_the_road_centerline_clear_of_every_footprint(seed: int) -> None:
    layout = _village(seed)
    spawn = layout.spawn
    assert spawn[0] == 1.0
    start, end = next(
        (start, end)
        for start, end in itertools.pairwise(layout.road.points)
        if min(start[0], end[0]) <= 1.0 <= max(start[0], end[0]) and start[0] != end[0]
    )
    expected_y = start[1] + (end[1] - start[1]) * (1.0 - start[0]) / (end[0] - start[0])
    assert abs(spawn[1] - expected_y) <= 1e-9
    for building in layout.buildings:
        gap = distance_to_rectangle(spawn, building.center, building.width, building.depth, building.rotation)
        assert gap >= SPAWN_CLEARANCE - 1e-6
    for prop in layout.props:
        gap = distance_to_rectangle(spawn, prop.position, *prop.footprint, prop.rotation)
        assert gap >= SPAWN_CLEARANCE - 1e-6
    for scenery in layout.scenery:
        assert distance(spawn, scenery.position) - scenery.radius >= SPAWN_CLEARANCE - 1e-6


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_doorways_face_the_path_nearest_their_building(seed: int) -> None:
    layout = _village(seed)
    paths = (layout.road, *layout.footpaths)
    for building in layout.buildings:
        nearest = min(paths, key=lambda path: polyline_distance(building.center, path.points))
        aim = _nearest_point_on(building.center, nearest.points)
        corners = rectangle_corners(building.center, building.width, building.depth, building.rotation)
        edges = _segments(corners, closed=True)
        expected = min(
            edges,
            key=lambda edge: distance(((edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2), aim),
        )
        middle = ((expected[0][0] + expected[1][0]) / 2, (expected[0][1] + expected[1][1]) / 2)
        assert distance(building.doorway.position, middle) <= 1e-6


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_geometry_fits_the_overlay_codec(seed: int) -> None:
    layout = _village(seed)
    for line in (*layout.channels, layout.road, *layout.footpaths):
        assert len(line.points) <= MAX_POLYLINE_POINTS
        for x, y in line.points:
            assert 0.0 <= x <= WORLD_SIZE
            assert 0.0 <= y <= WORLD_SIZE
    for polygon in (*layout.fields, *layout.reed_banks):
        for x, y in polygon:
            assert 0.0 <= x <= WORLD_SIZE
            assert 0.0 <= y <= WORLD_SIZE


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_same_seed_builds_compare_equal(seed: int) -> None:
    assert build_village(seed) == build_village(seed)


def test_batch_seeds_diverge() -> None:
    assert _village(0).channels != _village(17).channels


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_static_overlay_payload_stays_inside_its_budget(seed: int) -> None:
    day = Day(DayConfig(seed=seed, cast_size=10), _village(seed))
    payload = json.dumps(encode_overlay_static(day)).encode("utf-8")
    assert len(payload) < _MAX_STATIC_BYTES


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_reset_stays_inside_the_cadence(seed: int) -> None:
    env = ThreeBranchesEnv(seat_plan="cast_10")
    start = perf_counter()
    env.reset(seed=seed)
    assert perf_counter() - start < _CADENCE_SECONDS


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_observation_village_matches_the_generated_layout(seed: int) -> None:
    env = ThreeBranchesEnv(seat_plan="cast_5")
    observations, _infos = env.reset(seed=seed)
    village = observations["player_0"]["village"]
    layout = env.day.layout
    assert layout == _village(seed)
    for observed, line in zip(
        (*village["channels"], village["road"], *village["footpaths"]),
        (*layout.channels, layout.road, *layout.footpaths),
        strict=True,
    ):
        assert float(observed["width"]) == _f32(line.width)
        for observed_point, point in zip(observed["points"], line.points, strict=True):
            assert _point_matches(observed_point, point)
    for observed, bridge in zip(village["bridges"], layout.bridges, strict=True):
        assert _point_matches(observed["position"], bridge.position)
        assert float(observed["heading"]) == _f32(bridge.heading)
        assert float(observed["width"]) == _f32(bridge.width)
        assert float(observed["span"]) == _f32(bridge.span)
    for observed_polygon, polygon in zip(
        (*village["fields"], *village["reed_banks"]), (*layout.fields, *layout.reed_banks), strict=True
    ):
        for observed_point, point in zip(observed_polygon, polygon, strict=True):
            assert _point_matches(observed_point, point)
    assert _point_matches(village["spawn"], layout.spawn)
    for observed, building in zip(village["buildings"], layout.buildings, strict=True):
        assert observed["id"] == building.id
        assert observed["type"] == building.type
        assert _point_matches(observed["center"], building.center)
        assert float(observed["width"]) == _f32(building.width)
        assert float(observed["depth"]) == _f32(building.depth)
        assert float(observed["rotation"]) == _f32(building.rotation)
        assert _point_matches(observed["doorway"]["position"], building.doorway.position)
        assert float(observed["doorway"]["width"]) == _f32(building.doorway.width)
