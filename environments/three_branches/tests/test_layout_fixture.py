"""Fixture topology and static-layout derivation pins."""

from __future__ import annotations

from collections import deque
from dataclasses import replace

import pymunk
import pytest

from three_branches.fixture import FIXTURE_VILLAGE
from three_branches.generation import build_village
from three_branches.geometry import (
    add,
    distance,
    distance_to_segment,
    heading_to,
    heading_vector,
    orientation,
    segments_intersect,
)
from three_branches.layout import WORLD_SIZE, Bridge
from three_branches.physics import Physics


def _clear(point: tuple[float, float]) -> bool:
    return FIXTURE_VILLAGE.body_clear(point)


def _rectangle_bounds(
    center: tuple[float, float], footprint: tuple[float, float]
) -> tuple[float, float, float, float]:
    return (
        center[0] - footprint[0] / 2,
        center[0] + footprint[0] / 2,
        center[1] - footprint[1] / 2,
        center[1] + footprint[1] / 2,
    )


def _overlap(first: tuple[float, float, float, float], second: tuple[float, float, float, float]) -> bool:
    return first[0] < second[1] and second[0] < first[1] and first[2] < second[3] and second[2] < first[3]


def test_fixture_has_the_fixed_inventory_and_generation_seam_ignores_the_seed() -> None:
    layout = FIXTURE_VILLAGE
    assert build_village(1) is layout is build_village(999)
    assert len(layout.channels) == 4
    assert [building.id for building in layout.buildings] == [
        "home_0",
        "home_1",
        "home_2",
        "home_3",
        "home_4",
        "inn",
        "shed",
    ]
    assert len(layout.props) == 31
    assert [prop.type for prop in layout.props] == [
        *(["stall"] * 5),
        *(["lantern"] * 9),
        *(["bench"] * 5),
        *(["shrine"] * 2),
        "board",
        *(["plot"] * 5),
        "hearth",
        "repair_bench",
        "pump",
        "bell",
    ]


def test_wall_segments_leave_exactly_one_doorway_gap_per_building() -> None:
    layout = FIXTURE_VILLAGE
    assert len(layout.wall_segments) == len(layout.buildings) * 5
    for building in layout.buildings:
        doorway = building.doorway.position
        assert not any(
            distance(doorway, start) < 1e-8 or distance(doorway, end) < 1e-8
            for start, end in layout.wall_segments
        )
        assert not any(segments_intersect((doorway, doorway), wall) for wall in layout.wall_segments)


def test_water_banks_have_a_gap_at_every_road_deck() -> None:
    layout = FIXTURE_VILLAGE
    for bridge in layout.bridges:
        assert layout.body_clear(bridge.position)
        forward = heading_vector(bridge.heading)
        normal = -forward[1], forward[0]
        left = add(bridge.position, normal, -bridge.width / 2 + 0.25)
        right = add(bridge.position, normal, bridge.width / 2 - 0.25)
        assert not layout.body_clear(left)
        assert not layout.body_clear(right)


def test_unequal_channel_confluence_collision_covers_the_widest_water_cap() -> None:
    layout = replace(
        FIXTURE_VILLAGE,
        channels=(
            replace(FIXTURE_VILLAGE.channels[0], width=6.0),
            *(replace(channel, width=4.0) for channel in FIXTURE_VILLAGE.channels[1:]),
        ),
    )
    assert layout.water_confluence_disks == (((50.0, 65.0), 3.0),)
    physics = Physics(layout, {})
    saw_dry_shoulder = False
    for heading in range(0, 360, 15):
        for radius in (2.99, 3.2):
            point = add((50.0, 65.0), heading_vector(heading), radius)
            if radius == 2.99:
                assert layout.ground_at(point) == "water"
            else:
                saw_dry_shoulder |= layout.ground_at(point) != "water"
            assert not layout.body_clear(point, 0.4)
            hit = physics.space.point_query_nearest(point, 0.4, pymunk.ShapeFilter())
            assert hit is not None, (heading, radius)
    assert saw_dry_shoulder


def test_layout_rejects_a_rotated_bridge_overlapping_a_confluence_cap() -> None:
    overlapping = Bridge((53.5, 68.5), 45.0, 2.0, 4.0)
    with pytest.raises(ValueError, match="bridge deck cannot overlap"):
        replace(FIXTURE_VILLAGE, bridges=(overlapping, *FIXTURE_VILLAGE.bridges[1:]))


@pytest.mark.parametrize(
    "props",
    (
        tuple(reversed(FIXTURE_VILLAGE.props)),
        (replace(FIXTURE_VILLAGE.props[0], type="lantern"), *FIXTURE_VILLAGE.props[1:]),
    ),
)
def test_layout_rejects_prop_reordering_and_id_type_mismatches(props: tuple[object, ...]) -> None:
    with pytest.raises(ValueError, match="canonical id and type sequence"):
        replace(FIXTURE_VILLAGE, props=props)  # type: ignore[arg-type]


def test_layout_rejects_a_building_roster_off_the_canonical_sequence() -> None:
    with pytest.raises(ValueError, match="canonical id and type sequence"):
        replace(FIXTURE_VILLAGE, buildings=tuple(reversed(FIXTURE_VILLAGE.buildings)))


def test_road_crosses_each_branch_once_on_a_deck_and_never_crosses_the_trunk() -> None:
    layout = FIXTURE_VILLAGE
    road_segments = tuple(zip(layout.road.points[:-1], layout.road.points[1:], strict=True))
    assert not any(
        segments_intersect(road_segment, channel_segment)
        for road_segment in road_segments
        for channel_segment in zip(layout.channels[0].points[:-1], layout.channels[0].points[1:], strict=True)
    )
    for channel, bridge in zip(layout.channels[1:], layout.bridges, strict=True):
        crossings = [
            (road_segment, channel_segment)
            for road_segment in road_segments
            for channel_segment in zip(channel.points[:-1], channel.points[1:], strict=True)
            if segments_intersect(road_segment, channel_segment)
        ]
        assert len(crossings) == 1
        road_segment, channel_segment = crossings[0]
        assert distance_to_segment(bridge.position, *road_segment) == pytest.approx(0, abs=1e-8)
        assert distance_to_segment(bridge.position, *channel_segment) == pytest.approx(0, abs=1e-8)
        assert bridge.heading == pytest.approx(heading_to(*road_segment))
        road_direction = heading_vector(heading_to(*road_segment))
        channel_direction = heading_vector(heading_to(*channel_segment))
        crossing_sine = abs(
            road_direction[0] * channel_direction[1] - road_direction[1] * channel_direction[0]
        )
        assert bridge.span >= channel.width / crossing_sine + 2.0


def test_road_bends_at_both_shrine_footpath_junctions() -> None:
    layout = FIXTURE_VILLAGE
    for path in layout.footpaths[-2:]:
        junction = path.points[0]
        index = layout.road.points.index(junction)
        incoming = heading_to(layout.road.points[index - 1], junction)
        outgoing = heading_to(junction, layout.road.points[index + 1])
        assert incoming != pytest.approx(outgoing)


def test_market_stalls_and_their_crates_dress_both_sides_of_the_road() -> None:
    layout = FIXTURE_VILLAGE
    market_segment = layout.road.points[1], layout.road.points[2]
    stalls = [prop for prop in layout.props if prop.type == "stall"]
    assert {orientation(*market_segment, stall.position) > 0 for stall in stalls} == {False, True}
    crates = [scenery for scenery in layout.scenery if scenery.type == "crate"]
    nearest_crates = [
        min(crates, key=lambda crate: distance(crate.position, stall.position)) for stall in stalls
    ]
    assert len({crate.position for crate in nearest_crates}) == len(stalls)
    for stall, crate in zip(stalls, nearest_crates, strict=True):
        center_clearance = (stall.footprint[0] ** 2 + stall.footprint[1] ** 2) ** 0.5 / 2 + crate.radius
        assert center_clearance < distance(stall.position, crate.position) <= 2.0


def test_ground_priority_pins_deck_over_water_and_path_over_reeds() -> None:
    layout = FIXTURE_VILLAGE
    assert layout.ground_at(layout.bridges[1].position) == "road"
    assert layout.ground_at((50, 32)) == "water"
    assert layout.ground_at((15, 32)) == "road"
    assert layout.ground_at((14, 47)) == "reeds"
    assert layout.ground_at((10, 10)) == "field"
    assert layout.ground_at((45, 90)) == "open"
    assert layout.ground_speed(layout.bridges[1].position) == 1.0
    assert layout.ground_speed((14, 47)) == 0.5


def test_fixture_footprints_are_disjoint_except_for_authorized_interior_props() -> None:
    layout = FIXTURE_VILLAGE
    prop_bounds = [_rectangle_bounds(prop.position, prop.footprint) for prop in layout.props]
    assert not any(
        _overlap(first, second)
        for index, first in enumerate(prop_bounds)
        for second in prop_bounds[index + 1 :]
    )
    for prop, bounds in zip(layout.props, prop_bounds, strict=True):
        containing = [
            building
            for building in layout.buildings
            if _overlap(bounds, _rectangle_bounds(building.center, (building.width, building.depth)))
        ]
        if containing:
            assert (prop.id, containing[0].id) in {("hearth_0", "inn"), ("repair_bench_0", "shed")}
        else:
            assert not any(
                _overlap(bounds, _rectangle_bounds(building.center, (building.width, building.depth)))
                for building in layout.buildings
            )


def test_interior_props_are_flush_against_the_wall_opposite_each_south_doorway() -> None:
    props = {prop.id: prop for prop in FIXTURE_VILLAGE.props}
    assert props["hearth_0"].position[1] + props["hearth_0"].footprint[1] / 2 == pytest.approx(42.0)
    assert props["repair_bench_0"].position[1] + props["repair_bench_0"].footprint[1] / 2 == pytest.approx(
        41.0
    )


def test_fixture_spawn_and_all_props_have_clear_unblocked_standing_positions() -> None:
    layout = FIXTURE_VILLAGE
    assert _clear(layout.spawn)
    for prop in layout.props:
        candidates = (
            (x / 4, y / 4)
            for x in range(round((prop.position[0] - 1.5) * 4), round((prop.position[0] + 1.5) * 4) + 1)
            for y in range(round((prop.position[1] - 1.5) * 4), round((prop.position[1] + 1.5) * 4) + 1)
        )
        assert any(
            _clear(candidate)
            and distance(candidate, prop.position) <= 1.5
            and not layout.line_blocked(candidate, prop.position)
            for candidate in candidates
        ), prop.id


def test_fixture_samples_one_connected_walkable_region() -> None:
    layout = FIXTURE_VILLAGE
    points = {
        (x / 4 + 0.125, y / 4 + 0.125)
        for x in range(400)
        for y in range(400)
        if _clear((x / 4 + 0.125, y / 4 + 0.125))
    }
    start = layout.spawn
    nearest = min(points, key=lambda point: distance(point, start))
    seen = {nearest}
    pending = deque((nearest,))
    while pending:
        x, y = pending.popleft()
        for candidate in ((x + 0.25, y), (x - 0.25, y), (x, y + 0.25), (x, y - 0.25)):
            if candidate in points and candidate not in seen:
                seen.add(candidate)
                pending.append(candidate)
    assert seen == points


def test_start_poses_are_formulaic_and_keep_housemates_apart() -> None:
    poses = FIXTURE_VILLAGE.start_poses(10)
    assert set(poses) == {*(f"npc_{index}" for index in range(10)), "visitor"}
    assert poses["npc_0"].home == poses["npc_5"].home == "home_0"
    assert distance(poses["npc_0"].position, poses["npc_5"].position) == pytest.approx(1.2)
    assert poses["visitor"].position == (1.0, 25.0)
    assert poses["visitor"].heading == 0
    assert all(0 <= coordinate <= WORLD_SIZE for pose in poses.values() for coordinate in pose.position)
