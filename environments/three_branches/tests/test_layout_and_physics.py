from __future__ import annotations

from dataclasses import replace
from math import isfinite

from three_branches.catalog import CATALOG, PROP_BY_TOKEN
from three_branches.engine import Day, step
from three_branches.fixture import build_fixture
from three_branches.geometry import Circle, Rect, distance, nearest_point
from three_branches.layout import PlacedProp, Scenery, footprint, footprint_cells
from three_branches.physics import Physics
from three_branches.rules import FRAME, GROUND_BY_CODE, PROFILE


def test_fixture_is_fresh_deterministic_and_has_required_topology() -> None:
    first = build_fixture()
    second = build_fixture()
    assert first is not second
    assert first.grid.rows == second.grid.rows
    assert {building.id for building in first.buildings} == {
        "home_0",
        "home_1",
        "home_2",
        "home_3",
        "home_4",
        "inn",
        "shed",
    }
    assert {item.type for item in first.props} == {item.token for item in CATALOG.props}
    assert {item.type for item in first.scenery} == {item.token for item in CATALOG.scenery}
    assert sum(first.grid.value_at((channel, 50)) == "b" for channel in (25, 50, 75)) == 3
    assert first.ground_at(first.spawn).code == "r"
    assert first.body_clear(first.spawn)


def test_layout_paints_doorways_and_exposes_clear_home_poses() -> None:
    layout = build_fixture()
    for home_index in range(5):
        doorway = layout.doorway(f"home_{home_index}")
        assert len(doorway) == 2
        assert all(layout.grid.value_at(cell) == "d" for cell in doorway)
        first = layout.residence_pose(f"home_{home_index}", 0)
        second = layout.residence_pose(f"home_{home_index}", 1)
        assert layout.body_clear(first.position)
        assert layout.body_clear(second.position)
        assert (
            abs(first.position[0] - second.position[0]) + abs(first.position[1] - second.position[1]) >= 0.8
        )


def test_layout_shapes_and_static_projection_are_distinct() -> None:
    layout = build_fixture()
    assert len(layout.solids) == len(layout.props) + len(layout.scenery)
    assert layout.blocked
    assert any(
        GROUND_BY_CODE[layout.grid.value_at((50, y))].passable is False for y in range(66, FRAME.cells_y)
    )
    first = layout.village()
    second = layout.village()
    assert first == second and first is not second
    assert first["ground"] == layout.grid.rows
    for item in (*layout.props, *layout.scenery):
        shape = layout.shape_for(item)
        assert isinstance(shape, Rect | Circle)
    for item in layout.props:
        shape = layout.shape_for(item)
        assert any(
            layout.body_clear(layout.grid.center((x, y)))
            and distance(layout.grid.center((x, y)), nearest_point(layout.grid.center((x, y)), shape))
            <= PROFILE.prop_reach
            and layout.line_clear(
                layout.grid.center((x, y)), nearest_point(layout.grid.center((x, y)), shape)
            )
            for x in range(max(0, item.cell[0] - 2), min(FRAME.cells_x, item.cell[0] + 4))
            for y in range(max(0, item.cell[1] - 2), min(FRAME.cells_y, item.cell[1] + 4))
        )


def test_a_prop_footprint_turns_with_an_east_or_west_facing() -> None:
    layout = build_fixture()
    bench = PlacedProp("bench_turned", "bench", (10, 10))
    kind = PROP_BY_TOKEN["bench"]
    assert kind.width != kind.height
    for facing, expected in (
        ("north", (kind.width, kind.height)),
        ("south", (kind.width, kind.height)),
        ("east", (kind.height, kind.width)),
        ("west", (kind.height, kind.width)),
    ):
        turned = replace(bench, facing=facing)
        assert footprint(turned) == expected
        assert len(set(footprint_cells(turned))) == kind.width * kind.height
        shape = layout.shape_for(turned)
        assert isinstance(shape, Rect)
        assert (shape.width, shape.height) == expected
    # A circle prop measures the same either way, and scenery has no facing to turn with.
    assert footprint(PlacedProp("pump_turned", "pump", (10, 10), "east")) == (1, 1)
    crate = Scenery("crate", (10, 10))
    assert footprint(crate) == (2, 2)
    assert len(footprint_cells(crate)) == 4
    assert layout.shape_for(crate) == Rect(10.0, 10.0, 2.0, 2.0)


def test_circle_scenery_collision_scales_with_its_drawn_size() -> None:
    """A circular placement's solid grows with its drawn size, so trees collide as big as they look."""
    layout = build_fixture()
    small = layout.shape_for(Scenery("pine", (10, 10)))
    large = layout.shape_for(Scenery("pine", (10, 10), scale=2.0))
    assert isinstance(small, Circle)
    assert small.radius == 0.5
    assert isinstance(large, Circle)
    assert large.radius == 1.0
    assert large.radius == small.radius * 2.0


def test_physics_holds_still_characters_and_respects_boundaries_and_walls() -> None:
    layout = build_fixture()
    day = Day(layout, 5, False)
    visitor = day.characters["player_0"]
    start = visitor.position
    # A dynamic neighbour cannot push a speed-zero body, which remains kinematic for this tick.
    day.place("player_0", layout.residence_pose("home_0").position)
    still_position = visitor.position
    day.place("player_1", (visitor.position[0] - 1, visitor.position[1]))
    step(
        day,
        {
            "player_0": {"heading": 0.0, "speed": 0.0, "action": 0},
            "player_1": {"heading": 0.0, "speed": 1.0, "action": 0},
        },
    )
    assert day.characters["player_0"].position == still_position

    # Fast commands cannot cross the outer frame or an impassable cell in one tick.
    day = Day(layout, 5, False)
    day.place("player_0", (0.41, 50.5))
    step(day, {"player_0": {"heading": 180.0, "speed": 1.0, "action": 0}})
    assert day.characters["player_0"].position[0] >= 0.4
    day.place("player_0", (24.0, 45.5))
    step(day, {"player_0": {"heading": 0.0, "speed": 1.0, "action": 0}})
    assert day.characters["player_0"].position[0] <= 25.0 - PROFILE.body_radius + 1e-9
    # Two full-speed characters cannot pass through one another between solver samples.
    day = Day(layout, 5, False)
    day.place("player_0", (10.0, 50.5))
    day.place("player_1", (11.8, 50.5))
    step(
        day,
        {
            "player_0": {"heading": 0.0, "speed": 1.0, "action": 0},
            "player_1": {"heading": 180.0, "speed": 1.0, "action": 0},
        },
    )
    assert day.characters["player_0"].position[0] < day.characters["player_1"].position[0]
    assert start != day.characters["player_0"].position

    # An angled command keeps its free component when a water bank blocks the other one.
    day.place("player_0", (24.2, 42.5))
    step(day, {"player_0": {"heading": 45.0, "speed": 1.0, "action": 0}})
    assert day.characters["player_0"].position[0] <= 25.0 - PROFILE.body_radius + 1e-9
    assert day.characters["player_0"].position[1] > 42.5

    # Equal-mass moving bodies push one another; only a commanded stop becomes immovable.
    day = Day(layout, 5, False)
    day.place("player_0", (10.0, 50.5))
    day.place("player_1", (11.0, 50.5))
    step(
        day,
        {
            "player_0": {"heading": 0.0, "speed": 1.0, "action": 0},
            "player_1": {"heading": 0.0, "speed": 0.01, "action": 0},
        },
    )
    assert day.characters["player_1"].moved > 0.01

    # The fastest command cannot tunnel through the one-cell bank in one tick.
    day = Day(layout, 5, False)
    day.place("player_0", (24.1, 42.5))
    step(day, {"player_0": {"heading": 0.0, "speed": 1.0, "action": 0}})
    assert day.characters["player_0"].position[0] <= 25.0 - PROFILE.body_radius + 1e-9


def test_physics_restores_finite_dynamic_bodies_after_a_stop() -> None:
    physics = Physics(build_fixture())
    physics.add("player_0", (10.0, 50.5))
    physics.add("player_1", (10.75, 50.5))

    # This contact reproduces the visitor policy's stop, greet, and angled departure sequence.
    physics.move({"player_0": 0.0, "player_1": 0.0}, {"player_0": 0.0, "player_1": 0.0})
    for _ in range(24):
        moved = physics.move(
            {"player_0": 0.75, "player_1": 0.65},
            {"player_0": 251.5, "player_1": 270.0},
        )
        values = (*physics.position("player_0"), *physics.position("player_1"), *moved.values())
        assert all(isfinite(value) for value in values)


def test_physics_does_not_accumulate_penetration_through_a_wall() -> None:
    layout = build_fixture()
    physics = Physics(layout)
    physics.add("player_0", (6.5, 61.4))

    # Repeatedly press into home_0's south wall. A weak contact correction used to move the center
    # through the wall after several ticks, leaving the body trapped inside the building wall ring.
    for _ in range(12):
        physics.move({"player_0": 1.0}, {"player_0": 90.0})
        assert physics.position("player_0")[1] < 62.0

    against_wall = physics.position("player_0")[1]
    physics.move({"player_0": 1.0}, {"player_0": 270.0})
    assert physics.position("player_0")[1] < against_wall - 0.9
