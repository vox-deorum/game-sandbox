from __future__ import annotations

from three_branches.catalog import CATALOG
from three_branches.engine import Day, step
from three_branches.generation import build_village
from three_branches.geometry import Circle, Rect, distance, nearest_point
from three_branches.rules import GROUND_BY_CODE, PROFILE


def test_fixture_is_fresh_complete_and_has_required_topology() -> None:
    first = build_village(1)
    second = build_village(2)
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
    assert first.ground_code_at(first.spawn) == "r"
    assert first.body_clear(first.spawn)


def test_layout_paints_doorways_and_exposes_clear_home_poses() -> None:
    layout = build_village(0)
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


def test_layout_shapes_occupancy_and_static_projection_are_distinct() -> None:
    layout = build_village(0)
    assert len(layout.solids) == len(layout.props) + len(layout.scenery)
    assert len(layout.occupancy) == len(layout.props)
    assert layout.blocked
    assert any(GROUND_BY_CODE[layout.grid.value_at((50, y))].passable is False for y in range(66, 100))
    first = layout.village()
    second = layout.village()
    assert first == second and first is not second
    assert first["ground"] == tuple("".join(row) for row in layout.grid.rows)
    for item in (*layout.props, *layout.scenery):
        shape = layout.shape_for(item)
        assert isinstance(shape, Rect | Circle)
    for item in layout.props:
        shape = layout.shape_for(item)
        assert any(
            layout.body_clear(layout.grid.center((x, y)))
            and distance(layout.grid.center((x, y)), nearest_point(layout.grid.center((x, y)), shape)) <= 1.5
            and layout.line_clear(
                layout.grid.center((x, y)), nearest_point(layout.grid.center((x, y)), shape)
            )
            for x in range(max(0, item.cell[0] - 2), min(100, item.cell[0] + 4))
            for y in range(max(0, item.cell[1] - 2), min(100, item.cell[1] + 4))
        )


def test_physics_holds_still_characters_and_respects_boundaries_and_walls() -> None:
    layout = build_village(0)
    day = Day(layout, 5, False)
    visitor = day.characters["visitor"]
    start = visitor.position
    # A dynamic neighbour cannot push a speed-zero body, which remains kinematic for this tick.
    visitor.position = layout.residence_pose("home_0").position
    day.physics._bodies["visitor"].position = visitor.position
    still_position = visitor.position
    neighbour = day.characters["npc_0"]
    neighbour.position = (visitor.position[0] - 1, visitor.position[1])
    day.physics._bodies["npc_0"].position = neighbour.position
    step(
        day,
        {
            "visitor": {"heading": 0.0, "speed": 0.0, "action": 0},
            "npc_0": {"heading": 0.0, "speed": 1.0, "action": 0},
        },
    )
    assert day.characters["visitor"].position == still_position

    # Fast commands cannot cross the outer frame or an impassable cell in one tick.
    day = Day(layout, 5, False)
    day.characters["visitor"].position = (0.41, 50.5)
    day.physics._bodies["visitor"].position = (0.41, 50.5)
    step(day, {"visitor": {"heading": 180.0, "speed": 1.0, "action": 0}})
    assert day.characters["visitor"].position[0] >= 0.4
    day.characters["visitor"].position = (24.0, 45.5)
    day.physics._bodies["visitor"].position = (24.0, 45.5)
    step(day, {"visitor": {"heading": 0.0, "speed": 1.0, "action": 0}})
    assert day.characters["visitor"].position[0] <= 25.0 - PROFILE.body_radius + 1e-9

    # Two full-speed characters cannot pass through one another between solver samples.
    day = Day(layout, 5, False)
    day.characters["visitor"].position = (10.0, 50.5)
    day.physics._bodies["visitor"].position = (10.0, 50.5)
    day.characters["npc_0"].position = (11.8, 50.5)
    day.physics._bodies["npc_0"].position = (11.8, 50.5)
    step(
        day,
        {
            "visitor": {"heading": 0.0, "speed": 1.0, "action": 0},
            "npc_0": {"heading": 180.0, "speed": 1.0, "action": 0},
        },
    )
    assert day.characters["visitor"].position[0] < day.characters["npc_0"].position[0]
    assert start != day.characters["visitor"].position

    # An angled command keeps its free component when a water bank blocks the other one.
    day.characters["visitor"].position = (24.2, 42.5)
    day.physics._bodies["visitor"].position = (24.2, 42.5)
    step(day, {"visitor": {"heading": 45.0, "speed": 1.0, "action": 0}})
    assert day.characters["visitor"].position[0] <= 25.0 - PROFILE.body_radius + 1e-9
    assert day.characters["visitor"].position[1] > 42.5

    # Equal-mass moving bodies push one another; only a commanded stop becomes immovable.
    day = Day(layout, 5, False)
    day.characters["visitor"].position = (10.0, 50.5)
    day.physics._bodies["visitor"].position = (10.0, 50.5)
    day.characters["npc_0"].position = (11.0, 50.5)
    day.physics._bodies["npc_0"].position = (11.0, 50.5)
    step(
        day,
        {
            "visitor": {"heading": 0.0, "speed": 1.0, "action": 0},
            "npc_0": {"heading": 0.0, "speed": 0.01, "action": 0},
        },
    )
    assert day.characters["npc_0"].moved > 0.01

    # The fastest command cannot tunnel through the one-cell bank in one tick.
    day = Day(layout, 5, False)
    day.characters["visitor"].position = (24.1, 42.5)
    day.physics._bodies["visitor"].position = (24.1, 42.5)
    step(day, {"visitor": {"heading": 0.0, "speed": 1.0, "action": 0}})
    assert day.characters["visitor"].position[0] <= 25.0 - PROFILE.body_radius + 1e-9
