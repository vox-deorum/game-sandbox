from __future__ import annotations

from three_branches.engine import Day, phase_at, step
from three_branches.generation import build_village
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


def _place(day: Day, character_id: str, point: tuple[float, float]) -> None:
    day.characters[character_id].position = point
    day.physics._bodies[character_id].position = point


def test_each_prop_transition_follows_begin_hold_and_release_rules() -> None:
    cases = (
        ("stall_0", "open"),
        ("bench_0", "occupied"),
        ("pump_0", "flowing"),
        ("board_0", "none"),
    )
    for prop_id, expected in cases:
        day = Day(build_village(0), 5, True)
        prop = next(item for item in day.layout.props if item.id == prop_id)
        kind = prop.type
        start = day.prop_states[prop_id]
        _place(day, "visitor", _use_point(day, prop_id))

        step(day, {"visitor": {"heading": 0.0, "speed": 0.0, "action": 1}})
        assert day.prop_states[prop_id] == expected, prop.type

        if kind == "stall":
            step(day, {"visitor": {"heading": 0.0, "speed": 0.0, "action": 1}})
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
    day = Day(build_village(0), 5, False)
    _place(day, "visitor", _use_point(day, "bell", 0))
    _place(day, "npc_0", _use_point(day, "bell", 1))
    step(
        day,
        {
            "visitor": {"heading": 0.0, "speed": 0.0, "action": 1},
            "npc_0": {"heading": 0.0, "speed": 0.0, "action": 1},
        },
    )
    assert day.characters["visitor"].expression_type == "use"
    assert day.characters["npc_0"].expression_type == "none"
    assert day.holders["bell"] == "visitor"
    assert all(observe(day, character_id)["bell"] == 1 for character_id in day.characters)


def test_perception_passes_doors_but_not_walls_and_reports_post_tick_motion() -> None:
    day = Day(build_village(0), 5, False)
    visitor = day.characters["visitor"]
    npc = day.characters["npc_0"]
    visitor.position, visitor.heading = (7.5, 61.5), 90.0
    npc.position = (7.5, 63.5)
    doorway_view = observe(day, "visitor")
    assert [person["id"] for person in doorway_view["seen"]] == ["npc_0"]
    assert [person["id"] for person in doorway_view["nearby"]] == ["npc_0"]

    visitor.position, visitor.heading = (4.5, 64.5), 0.0
    npc.position = (6.5, 64.5)
    wall_view = observe(day, "visitor")
    assert wall_view["seen"] == () and wall_view["nearby"] == ()

    _place(day, "visitor", (10.0, 50.5))
    _place(day, "npc_0", (13.0, 50.5))
    day.characters["npc_0"].heading = 180.0
    post = step(day, {"visitor": {"heading": 0.0, "speed": 0.5, "action": 2}})
    visitor_seen = next(person for person in post["npc_0"]["seen"] if person["id"] == "visitor")
    assert visitor_seen["moved"] > 0
    assert visitor_seen["expression"] == {"type": "wave", "target": "none"}


def test_day_phase_boundaries_name_the_displayed_tick() -> None:
    assert phase_at(120, True) == "dawn"
    assert phase_at(121, True) == "morning"
    assert phase_at(1200, True) == "night"
    assert phase_at(121, False) == "day"
