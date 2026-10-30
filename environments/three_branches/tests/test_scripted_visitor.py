"""Behavioral tests for the scripted visitor builtin."""

from __future__ import annotations

import json
import math
import random
from dataclasses import replace
from pathlib import Path

import numpy as np

from game_sandbox_harness.manifest import load_agent
from three_branches import scripted_visitor
from three_branches.engine import Day, step
from three_branches.env import make_env
from three_branches.fixture import build_fixture
from three_branches.geometry import Rect
from three_branches.grid import Grid
from three_branches.layout import PlacedProp, Scenery
from three_branches.perception import observe
from three_branches.prop_use import select
from three_branches.rules import FRAME


class _QuietRandom:
    """Deterministic entropy that never triggers the spontaneous mode change."""

    def random(self) -> float:
        return 1.0

    def randint(self, low: int, high: int) -> int:
        del low
        return high

    def choice(self, values):
        return values[0]

    def choices(self, values, weights=None, k=1):
        del weights
        return [values[0]] * k


class _PurposefulRandom(_QuietRandom):
    def random(self) -> float:
        return 0.5


class _ForwardRandom(_QuietRandom):
    """Deterministic entropy that always accepts the best steering candidate."""

    def random(self) -> float:
        return 0.0


def _flat_village(rows: int = 24, columns: int = 24, *, props=(), scenery=()) -> dict[str, object]:
    return {
        "size": {"cells_x": columns, "cells_y": rows, "cell_size": 1.0},
        "ground": tuple("g" * columns for _ in range(rows)),
        "buildings": (),
        "props": tuple(props),
        "scenery": tuple(scenery),
        "spawn": {"x": 0.5, "y": 0.5},
    }


def _prop(prop_id: str, prop_type: str, x: int, y: int, facing: str = "north") -> dict[str, object]:
    return {"id": prop_id, "type": prop_type, "cell": {"x": x, "y": y}, "facing": facing}


def _person(person_id: str, position: tuple[float, float]) -> dict[str, object]:
    return {"id": person_id, "position": {"x": position[0], "y": position[1]}}


def _observation(
    position: tuple[float, float],
    *,
    seen=(),
    nearby=(),
    props=(),
    village: dict[str, object] | None = None,
) -> dict[str, object]:
    return {
        "self": {"position": {"x": position[0], "y": position[1]}, "heading": 0.0},
        "seen": tuple(seen),
        "nearby": tuple(nearby),
        "props": tuple(props),
        "bell": 0,
        "village": _flat_village() if village is None else village,
    }


def _agent(
    observation: dict[str, object], *, mode: str | None = None, seed: int = 7
) -> scripted_visitor.Agent:
    agent = scripted_visitor.Agent()
    agent.reset(0, observation)
    agent._rng = random.Random(seed)
    if mode is not None:
        agent._mode = mode
    return agent


def _use_point(day: Day, prop_id: str) -> tuple[float, float]:
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
    return clear[0]


def _place_for_use(day: Day, prop_id: str) -> tuple[tuple[float, float], tuple[float, float]]:
    point = _use_point(day, prop_id)
    prop = next(item for item in day.layout.props if item.id == prop_id)
    shape = day.layout.shape_for(prop)
    center = (
        (shape.x + shape.width / 2, shape.y + shape.height / 2)
        if isinstance(shape, Rect)
        else (shape.x, shape.y)
    )
    day.place("player_0", point)
    day.characters["player_0"].heading = (
        math.degrees(math.atan2(center[1] - point[1], center[0] - point[0])) % 360.0
    )
    return point, center


def _engine_observation(day: Day) -> dict[str, object]:
    return {**observe(day, "player_0"), "village": day.layout.village()}


def test_reset_uses_fresh_controlled_entropy_and_ignores_the_session_seed(monkeypatch) -> None:
    monkeypatch.setattr(scripted_visitor, "_new_rng", lambda: random.Random(4))
    agent = scripted_visitor.Agent()
    agent.reset(1, _observation((2.0, 2.0)))
    first_rng = agent._rng
    first_mode = agent._mode

    agent._tick = 9
    agent._goal = scripted_visitor._Goal("stroll", "stroll", (3.0, 3.0), (3.0, 3.0))
    agent.reset(2, _observation((4.0, 4.0)))

    assert agent._rng is not first_rng
    assert agent._mode == first_mode
    assert (agent._tick, agent._goal, agent._state) == (0, None, "travel")
    assert agent._village.width == 24.0


def test_missing_fields_and_numpy_scalars_produce_finite_actions() -> None:
    agent = scripted_visitor.Agent()
    agent.reset(0, _observation((5.0, 5.0), village=_flat_village(rows=12, columns=12)))

    cases = (
        {},
        {"self": None},
        {
            "self": {
                "position": {"x": np.float32(2.5), "y": np.float32(3.5)},
                "heading": np.float32(45.0),
            }
        },
        {
            "seen": (None, "not-a-record", {"id": "player_1"}),
            "nearby": ({"id": "player_2"},),
        },
    )
    for observation in cases:
        action = agent.act(observation)
        assert set(action) == {"heading", "speed", "action"}
        assert isinstance(action["heading"], float)
        assert 0.0 <= action["heading"] < 360.0
        assert isinstance(action["speed"], float)
        assert 0.0 <= action["speed"] <= 1.0
        assert isinstance(action["action"], int)
        json.dumps(action, allow_nan=False)

    reset_agent = scripted_visitor.Agent()
    reset_agent.reset(
        0,
        {
            "self": {
                "position": {
                    "x": np.array(3, dtype=np.float32),
                    "y": np.array(4, dtype=np.float32),
                },
                "heading": np.array(90, dtype=np.float32),
            }
        },
    )
    assert reset_agent._heading == 90.0
    assert reset_agent.act({})["speed"] == 0.0


def test_modes_choose_purposeful_destinations_from_controlled_entropy() -> None:
    all_props = (
        _prop("board_0", "board", 6, 6),
        _prop("bench_0", "bench", 12, 6),
        _prop("pump_0", "pump", 6, 12),
        _prop("shrine_0", "shrine", 14, 12),
        _prop("stall_0", "stall", 22, 6),
        _prop("bell", "bell", 22, 12),
    )
    village = _flat_village(rows=40, columns=40, props=all_props)
    observation = _observation((2.0, 2.0), village=village)

    activities = _agent(observation, mode="activities")
    activities._tick = 20
    activities.act(observation)
    assert activities._goal is not None
    assert activities._goal.category in {"board", "bench", "pump", "shrine"}
    assert activities._village.selected_prop(activities._goal.point) == activities._goal.prop

    scenic_village = _flat_village(
        rows=40,
        columns=40,
        props=(_prop("stall_0", "stall", 10, 10), _prop("bell", "bell", 16, 10)),
    )
    scenic = _observation((2.0, 2.0), village=scenic_village)
    sightseeing = _agent(scenic, mode="sightseeing")
    sightseeing._tick = 20
    sightseeing.act(scenic)
    assert sightseeing._goal is not None
    assert sightseeing._goal.category in {"stall", "bell"}

    no_activity = _agent(scenic, mode="activities")
    no_activity._tick = 20
    no_activity.act(scenic)
    assert no_activity._goal is not None
    assert no_activity._goal.category == "stroll"

    person = _person("player_1", (5.0, 2.0))
    social_observation = _observation((2.0, 2.0), seen=(person,), nearby=(person,), village=scenic_village)
    social = _agent(social_observation, mode="social")
    social._tick = 20
    social.act(social_observation)
    assert social._goal is not None
    assert social._goal.category == "person"
    assert social._goal.person == "player_1"


def test_a_chosen_destination_stays_stable_while_the_visitor_approaches_it() -> None:
    village = _flat_village(rows=32, columns=32, props=(_prop("bench_0", "bench", 20, 20),))
    agent = _agent(_observation((2.0, 2.0), village=village), mode="activities")
    agent._rng = _ForwardRandom()
    agent._tick = 0
    position = (2.0, 2.0)
    action = agent.act(_observation(position, village=village))
    assert agent._goal is not None
    assert agent._goal.category == "bench"
    key, point = agent._goal.key, agent._goal.point
    remaining = math.dist(position, point)

    for _ in range(8):
        heading = math.radians(action["heading"])
        travel = action["speed"] * 0.75
        position = (
            position[0] + math.cos(heading) * travel,
            position[1] + math.sin(heading) * travel,
        )
        action = agent.act(_observation(position, village=village))
        assert agent._goal is not None
        assert agent._goal.key == key
        assert agent._goal.point == point
        closer = math.dist(position, point)
        assert closer < remaining
        remaining = closer


def test_activities_skip_a_destination_where_a_nearer_unintended_prop_would_be_used() -> None:
    village = _flat_village(
        rows=20,
        columns=20,
        props=(_prop("bench_0", "bench", 5, 5), _prop("stall_0", "stall", 8, 6)),
    )
    model = scripted_visitor._Village(_observation((1.0, 1.0), village=village))
    east = (7.85, 5.5)
    assert model.clear(east, east)
    assert model.selected_prop(east) == "stall_0"

    observation = _observation((1.0, 1.0), village=village)
    agent = _agent(observation, mode="activities")
    agent._tick = 20
    agent.act(observation)
    assert agent._goal is not None
    assert agent._goal.prop == "bench_0"
    assert agent._goal.point != east
    assert model.selected_prop(agent._goal.point) == "bench_0"


def test_a_wall_corner_does_not_hide_a_nearer_prop_from_use_selection() -> None:
    rows = [list("g" * FRAME.cells_x) for _ in range(FRAME.cells_y)]
    rows[5][4] = "x"
    layout = replace(
        build_fixture(),
        grid=Grid(FRAME, tuple("".join(row) for row in rows)),
        props=(PlacedProp("stall_0", "stall", (5, 5)), PlacedProp("board_0", "board", (1, 3))),
        scenery=(),
        spawn=(4.2, 4.2),
    )
    day = Day(layout, 5, False)
    day.characters["player_0"].heading = 180.0
    observation = _engine_observation(day)
    assert {p["prop"] for p in observation["props"]} == {"board_0"}
    agent = _agent(observation, mode="activities")
    agent._tick = 10
    agent._state = "visit"
    agent._visit_until = 30
    agent._goal = scripted_visitor._Goal("board_0", "board", (4.2, 4.2), (2.0, 4.0), prop="board_0")

    # The wall touching the ray endpoint does not hide the nearer stall. Selection must
    # include that stall outside the vision cone, so a board visit cannot accidentally use it.
    assert agent._village.selected_prop((4.2, 4.2)) == "stall_0"
    engine_target = select(layout, (4.2, 4.2))
    assert engine_target is not None
    assert engine_target.id == "stall_0"

    action = agent.act(observation)
    assert action["action"] == 0
    step(day, {"player_0": action})
    assert day.prop_states["stall_0"] == "closed"
    assert day.holders["board_0"] is None


def test_a_nearby_bench_activity_holds_and_releases_through_the_engine() -> None:
    day = Day(build_fixture(), 5, False)
    point, center = _place_for_use(day, "bench_0")
    observation = _engine_observation(day)
    agent = scripted_visitor.Agent()
    agent.reset(0, observation)
    agent._rng = random.Random(3)
    agent._mode = "activities"
    agent._tick = 10
    agent._goal = scripted_visitor._Goal("bench_0", "bench", point, center, prop="bench_0")
    agent._state = "visit"
    agent._visit_until = agent._tick + 12
    agent._use_until = agent._tick + 2

    held = False
    released = False
    for _ in range(20):
        action = agent.act(_engine_observation(day))
        if action["action"] == 1:
            held = True
            step(day, {"player_0": action})
            assert day.prop_states["bench_0"] == "occupied"
            assert day.holders["bench_0"] == "player_0"
            continue
        step(day, {"player_0": action})
        if held:
            released = True
            assert day.prop_states["bench_0"] == "empty"
            assert day.holders["bench_0"] is None
            break

    assert held
    assert released


def test_a_nearby_pump_activity_completes_after_the_visitor_stops_using_it() -> None:
    day = Day(build_fixture(), 5, False)
    point, center = _place_for_use(day, "pump_0")
    observation = _engine_observation(day)
    agent = scripted_visitor.Agent()
    agent.reset(0, observation)
    agent._rng = random.Random(4)
    agent._mode = "activities"
    agent._tick = 10
    agent._goal = scripted_visitor._Goal("pump_0", "pump", point, center, prop="pump_0")
    agent._state = "visit"
    agent._visit_until = agent._tick + 20
    agent._use_until = agent._tick + 2

    uses = 0
    stopped = False
    for _ in range(20):
        action = agent.act(_engine_observation(day))
        if action["action"] == 1:
            uses += 1
        elif uses:
            stopped = True
        step(day, {"player_0": action})
        if stopped and day.prop_states["pump_0"] == "idle":
            break

    assert uses >= 1
    assert stopped
    assert day.prop_states["pump_0"] == "idle"


def test_an_outing_detours_around_a_crate_and_completes_a_pump_visit() -> None:
    fixture = build_fixture()
    layout = replace(fixture, scenery=(*fixture.scenery, Scenery("crate", (40, 60))))
    day = Day(layout, 5, False)
    day.place("player_0", (37.5, 60.5))
    agent = _agent(_engine_observation(day), mode="activities")
    agent._rng = _PurposefulRandom()
    agent._village.places = [goal for goal in agent._village.places if goal.prop == "pump_0"]
    used = False
    detoured = False
    completed = False
    for _ in range(80):
        action = agent.act(_engine_observation(day))
        step(day, {"player_0": action})
        character = day.characters["player_0"]
        assert layout.body_clear(character.position)
        detoured |= character.position[1] < 59.6
        used |= character.expression_type == "use" and character.expression_target == "pump_0"
        if used and agent._goal is None:
            completed = True
            break

    assert detoured
    assert used
    assert completed
    assert day.holders["pump_0"] is None


def test_mode_changes_interrupt_travel_and_wait_for_a_social_visit_to_finish() -> None:
    class SwitchingRandom(_QuietRandom):
        def random(self) -> float:
            return 0.0

    observation = _observation((2.0, 2.0))
    agent = _agent(observation, mode="activities")
    agent._rng = SwitchingRandom()
    agent._tick = 18
    agent.act(observation)
    assert agent._goal is not None
    cancelled = agent._goal.key
    agent.act(observation)
    assert agent._mode != "activities"
    assert cancelled not in agent._recent

    person = _person("player_1", (3.5, 2.0))
    close = _observation((2.0, 2.0), seen=(person,), nearby=(person,))
    social = _agent(close, mode="social")
    social._rng = SwitchingRandom()
    social._tick = 18
    assert social.act(close)["action"] == 2
    assert social.chat([])
    assert social.act(close)["speed"] == 0
    assert social._mode == "social"


def test_conversations_keep_their_person_and_ignore_early_or_out_of_range_messages() -> None:
    person = _person("player_1", (5.0, 2.0))
    invalid = tuple(_person(name, (3.0, 2.0)) for name in ("player_0", "player_01", "npc_0", "visitor"))
    far = _observation((2.0, 2.0), seen=(person, *invalid), nearby=(person, *invalid))
    agent = _agent(far, mode="social")
    agent.act(far)
    assert agent.chat([{"from": "player_1", "text": "Earlier."}]) == []
    other = _person("player_2", (3.0, 2.0))
    agent.act(_observation((2.0, 2.0), seen=(person, other), nearby=(person, other)))
    close = _person("player_1", (3.5, 2.0))
    assert agent.act(_observation((2.0, 2.0), seen=(close, other), nearby=(close, other)))["action"] == 2
    assert agent.chat([])[0]["to"] == "player_1"
    assert agent.chat([{"from": "player_2", "text": "Hello."}]) == []
    agent.act(_observation((2.0, 2.0), seen=(close,)))
    assert agent.chat([{"from": "player_1", "text": "Too far."}]) == []
    agent.act(_observation((2.0, 2.0), seen=(close,), nearby=(close,)))
    assert agent._target != "player_1"


def test_sightseeing_visits_without_using_the_prop() -> None:
    day = Day(build_fixture(), 5, False)
    point, center = _place_for_use(day, "pump_0")
    observation = _engine_observation(day)
    agent = scripted_visitor.Agent()
    agent.reset(0, observation)
    agent._rng = random.Random(5)
    agent._mode = "sightseeing"
    agent._tick = 10
    agent._goal = scripted_visitor._Goal("pump_0", "pump", point, center, prop="pump_0")
    agent._state = "visit"
    agent._visit_until = agent._tick + 8

    for _ in range(8):
        action = agent.act(_engine_observation(day))
        assert action["action"] == 0
        step(day, {"player_0": action})

    assert day.prop_states["pump_0"] == "idle"


def test_social_visit_greets_once_replies_once_and_then_stays_quiet() -> None:
    village = _flat_village()
    person = _person("player_1", (5.0, 2.0))
    far = _observation((2.0, 2.0), seen=(person,), nearby=(person,), village=village)
    agent = _agent(far, mode="social")
    agent._tick = 5

    assert agent.act(far)["speed"] > 0
    assert agent._goal is not None
    assert agent._goal.person == "player_1"

    close_person = _person("player_1", (3.5, 2.0))
    close = _observation((2.0, 2.0), seen=(close_person,), nearby=(close_person,), village=village)
    greeting = agent.act(close)
    assert greeting["action"] == 2
    assert agent.chat([]) == [{"to": "player_1", "text": "Hello. How is your day going?"}]
    assert agent.chat([]) == []
    assert agent.chat([{"from": "player_1", "text": "Good."}]) == [
        {"to": "player_1", "text": "Thank you. I am glad to be here."}
    ]
    assert agent.chat([{"from": "player_1", "text": "More."}]) == []


def test_a_lost_social_target_is_abandoned_and_respects_its_cooldown() -> None:
    village = _flat_village()
    person = _person("player_1", (5.0, 2.0))
    with_person = _observation((2.0, 2.0), seen=(person,), nearby=(person,), village=village)
    agent = _agent(with_person, mode="social")
    agent._tick = 5
    agent.act(with_person)
    assert agent._goal is not None
    target = agent._goal.person
    assert target == "player_1"

    lost = _observation((2.0, 2.0), village=village)
    agent._last_seen = agent._tick - 9
    action = agent.act(lost)
    assert action["speed"] == 0.0
    assert agent._goal is None
    failed_until = agent._failed[target]
    assert failed_until > agent._tick

    agent.act(with_person)
    assert agent._goal is not None
    assert agent._goal.person != target

    agent._goal = None
    agent._state = "travel"
    agent._tick = failed_until
    agent.act(with_person)
    assert agent._goal is not None
    assert agent._goal.person == target


def test_a_stuck_visitor_recovers_and_abandons_its_destination_within_a_bounded_window() -> None:
    village = _flat_village(rows=40, columns=40, props=(_prop("bench_0", "bench", 20, 20),))
    observation = _observation((2.0, 2.0), village=village)
    agent = _agent(observation, mode="activities")
    agent._rng = _QuietRandom()
    agent._tick = 0

    escaped = False
    abandoned = False
    for _ in range(60):
        agent.act(observation)
        escaped = escaped or agent._escape_until > agent._tick
        if "bench_0" in agent._failed:
            abandoned = True
            break

    assert escaped
    assert abandoned
    assert agent._goal is None
    assert agent._failed["bench_0"] <= 120

    agent.act(observation)
    assert agent._goal is not None
    assert agent._goal.key != "bench_0"


def test_local_clearance_sweeps_the_body_around_rotated_props_and_scaled_pines() -> None:
    turned = _flat_village(rows=30, columns=30, props=(_prop("bench_0", "bench", 10, 10, "east"),))
    assert not scripted_visitor._Village(_observation((1.0, 1.0), village=turned)).clear(
        (8.0, 11.5), (14.0, 11.5)
    )

    straight = _flat_village(rows=30, columns=30, props=(_prop("bench_0", "bench", 10, 10, "north"),))
    assert scripted_visitor._Village(_observation((1.0, 1.0), village=straight)).clear(
        (8.0, 11.5), (14.0, 11.5)
    )

    small = _flat_village(
        rows=30,
        columns=30,
        scenery=({"type": "pine", "cell": {"x": 20, "y": 20}, "scale": 1.0},),
    )
    large = _flat_village(
        rows=30,
        columns=30,
        scenery=({"type": "pine", "cell": {"x": 20, "y": 20}, "scale": 2.0},),
    )
    assert scripted_visitor._Village(_observation((1.0, 1.0), village=small)).clear(
        (18.0, 21.7), (24.0, 21.7)
    )
    assert not scripted_visitor._Village(_observation((1.0, 1.0), village=large)).clear(
        (18.0, 21.7), (24.0, 21.7)
    )


def test_float32_contact_observations_allow_the_visitor_to_step_outward() -> None:
    for props, scenery in (
        ((PlacedProp("bench_0", "bench", (30, 10)),), ()),
        ((), (Scenery("pine", (30, 10)),)),
    ):
        layout = replace(build_fixture(), props=props, scenery=scenery, spawn=(29.5999999, 10.5))
        day = Day(layout, 5, False)
        assert layout.body_clear(day.characters["player_0"].position)
        observation = _engine_observation(day)
        observation["self"]["position"]["x"] = np.float32(29.5999999)
        agent = _agent(observation)
        agent._rng = _PurposefulRandom()
        agent._goal = scripted_visitor._Goal("stroll", "stroll", (27.0, 10.5), (27.0, 10.5))
        agent._deadline = 100

        action = agent.act(observation)
        assert action["speed"] > 0
        assert math.cos(math.radians(action["heading"])) < 0
        step(day, {"player_0": action})
        assert day.characters["player_0"].position[0] < 29.5999999
        assert layout.body_clear(day.characters["player_0"].position)


def test_recovery_can_take_a_clear_step_in_a_tight_corner() -> None:
    rows = tuple(
        "".join("g" if 9 <= x <= 10 and 9 <= y <= 10 else "x" for x in range(FRAME.cells_x))
        for y in range(FRAME.cells_y)
    )
    layout = replace(build_fixture(), grid=Grid(FRAME, rows), props=(), scenery=(), spawn=(10.0, 10.0))
    day = Day(layout, 5, False)
    agent = _agent(_engine_observation(day))
    agent._rng = _PurposefulRandom()
    agent._goal = scripted_visitor._Goal("stroll", "stroll", (18.0, 10.0), (18.0, 10.0))
    agent._deadline = 100
    for _ in range(10):
        action = agent.act(_engine_observation(day))
        step(day, {"player_0": action})
        assert layout.body_clear(day.characters["player_0"].position)
        if day.characters["player_0"].moved > 0.05:
            break
    else:
        raise AssertionError("the visitor never tried a clear recovery step")


def test_a_visit_that_starts_near_the_outing_deadline_runs_to_completion() -> None:
    village = _flat_village(props=(_prop("bench_0", "bench", 10, 10),))
    observation = _observation((9.0, 11.0), village=village)
    agent = _agent(observation, mode="sightseeing")
    agent._rng = _QuietRandom()
    agent._goal = scripted_visitor._Goal("bench_0", "bench", (9.0, 11.0), (11.0, 10.5), prop="bench_0")
    agent._state = "visit"
    agent._tick = agent._deadline = 30
    agent._visit_until = 34

    for _ in range(3):
        agent.act(observation)
        assert agent._state == "visit"
    agent.act(observation)

    assert agent._goal is None
    assert agent._recent["bench_0"] == agent._tick
    assert "bench_0" not in agent._failed


def test_a_visitor_pushed_into_a_doorway_steps_back_outdoors() -> None:
    # South of row 10 is open ground; row 10 is a wall with a two-cell doorway, and the interior lies north.
    ground = tuple(
        "g" * 24 if y < 10 else "x" * 11 + "dd" + "x" * 11 if y == 10 else "x" + "i" * 22 + "x"
        for y in range(24)
    )
    village = {**_flat_village(), "ground": ground}
    doorway = (11.5, 10.5)
    observation = _observation(doorway, village=village)
    agent = _agent(observation)
    agent._rng = _PurposefulRandom()
    agent._goal = scripted_visitor._Goal("stroll", "stroll", (11.5, 4.0), (11.5, 4.0))
    agent._deadline = 100

    # Destination and stroll checks still keep the visitor outdoors.
    assert not agent._village.clear(doorway, doorway)
    action = agent.act(observation)
    assert action["speed"] > 0
    assert math.sin(math.radians(action["heading"])) < 0


def test_the_staged_builtin_loads_standalone(tmp_path: Path) -> None:
    staged = (
        Path(__file__).resolve().parents[3]
        / "backend/images/session-base/deps-v1/builtin/three_branches/scripted_visitor"
    )
    root = tmp_path / "scripted_visitor"
    root.mkdir()
    for name in ("agent.py", "manifest.json", "rules.json", "catalog.json"):
        (root / name).write_bytes((staged / name).read_bytes())

    env = make_env({"seat_plan": "cast_5", "daynight": False})
    observations, _ = env.reset(seed=2)
    staged_agent = load_agent(root)
    package_agent = scripted_visitor.Agent()
    for agent in (staged_agent, package_agent):
        agent.reset(2, observations["player_0"])
        agent._mode = "activities"
        agent._rng = random.Random(3)

    for _ in range(6):
        assert staged_agent.act(observations["player_0"]) == package_agent.act(observations["player_0"])
