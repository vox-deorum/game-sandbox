from __future__ import annotations

from three_branches.engine import Day, phase_at, step
from three_branches.fixture import build_fixture
from three_branches.geometry import Rect
from three_branches.perception import observe


def _use_point(day: Day, prop_id: str, side: int = 0) -> tuple[float, float]:
    prop = next(item for item in day.layout.props if item.id == prop_id)
    shape = day.layout.shape_for(prop)
    if isinstance(shape, Rect):
        candidates = (
            (shape.x - 0.5, shape.y + shape.height / 2),
            (shape.right + 0.5, shape.y + shape.height / 2),
            (shape.x + shape.width / 2, shape.y - 0.5),
            (shape.x + shape.width / 2, shape.top + 0.5),
        )
    else:
        candidates = (
            (shape.x - shape.radius - 0.5, shape.y),
            (shape.x + shape.radius + 0.5, shape.y),
            (shape.x, shape.y - shape.radius - 0.5),
            (shape.x, shape.y + shape.radius + 0.5),
        )
    clear = tuple(point for point in candidates if day.layout.body_clear(point))
    return clear[side]


def test_each_prop_transition_follows_begin_hold_and_release_rules() -> None:
    cases = (
        ("stall_0", "open"),
        ("bench_0", "occupied"),
        ("pump_0", "flowing"),
        ("board_0", "none"),
    )
    for prop_id, expected in cases:
        day = Day(build_fixture(), 5, True)
        prop = next(item for item in day.layout.props if item.id == prop_id)
        kind = prop.type
        start = day.prop_states[prop_id]
        day.place("player_0", _use_point(day, prop_id))

        step(day, {"player_0": {"heading": 0.0, "speed": 0.0, "action": 1}})
        assert day.prop_states[prop_id] == expected, prop.type

        if kind == "stall":
            step(day, {"player_0": {"heading": 0.0, "speed": 0.0, "action": 1}})
            assert day.prop_states[prop_id] == expected
            step(day, {})
            assert day.prop_states[prop_id] == expected
        elif kind == "bench":
            step(day, {})
            assert day.prop_states[prop_id] == start
        elif kind == "pump":
            for _ in range(9):
                step(day, {})
            assert day.prop_states[prop_id] == expected
            step(day, {})
            assert day.prop_states[prop_id] == start


def test_prop_contention_is_visitor_first_and_the_bell_is_global() -> None:
    day = Day(build_fixture(), 5, False)
    day.place("player_0", _use_point(day, "bell", 0))
    day.place("player_1", _use_point(day, "bell", 1))
    step(
        day,
        {
            "player_0": {"heading": 0.0, "speed": 0.0, "action": 1},
            "player_1": {"heading": 0.0, "speed": 0.0, "action": 1},
        },
    )
    assert day.characters["player_0"].expression_type == "use"
    assert day.characters["player_1"].expression_type == "none"
    assert day.holders["bell"] == "player_0"
    assert all(observe(day, character_id)["bell"] == 1 for character_id in day.characters)


def test_perception_passes_doors_but_not_walls_and_reports_post_tick_motion() -> None:
    day = Day(build_fixture(), 5, False)
    visitor = day.characters["player_0"]
    npc = day.characters["player_1"]
    visitor.position, visitor.heading = (8.5, 61.5), 90.0
    npc.position = (8.5, 63.5)
    doorway_view = observe(day, "player_0")
    assert [person["id"] for person in doorway_view["seen"]] == ["player_1"]
    assert [person["id"] for person in doorway_view["nearby"]] == ["player_1"]

    visitor.position, visitor.heading = (4.5, 64.5), 0.0
    npc.position = (6.5, 64.5)
    wall_view = observe(day, "player_0")
    assert wall_view["seen"] == () and wall_view["nearby"] == ()

    day.place("player_0", (10.0, 50.5))
    day.place("player_1", (13.0, 50.5))
    day.characters["player_1"].heading = 180.0
    post = step(day, {"player_0": {"heading": 0.0, "speed": 0.5, "action": 2}})
    visitor_seen = next(person for person in post["player_1"]["seen"] if person["id"] == "player_0")
    assert visitor_seen["moved"] > 0
    assert visitor_seen["expression"] == {"type": "wave", "target": "none"}


def test_day_phase_boundaries_name_the_displayed_tick() -> None:
    assert phase_at(120, True) == "dawn"
    assert phase_at(121, True) == "morning"
    assert phase_at(1200, True) == "night"
    assert phase_at(121, False) == "day"
