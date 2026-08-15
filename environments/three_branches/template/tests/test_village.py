"""Pins for the public ``sandbox.village`` helpers and starter agent."""

from __future__ import annotations

import copy
import subprocess
import sys

import agent
import pytest
from sandbox.env import META, make_env
from sandbox.harness.environment import resolve_parameters
from sandbox.village import action, day, geometry, layout, me, people, props


def _observations():
    env = make_env(resolve_parameters(META))
    observations, _ = env.reset(seed=7)
    return env, observations


def test_helpers_read_native_observation_values_and_build_normalized_actions():
    env, observations = _observations()
    observation = observations["player_1"]

    assert me.player_id(observation) == "player_1"
    assert me.position(observation) is observation["self"]["position"]
    assert people.seen(observation) is observation["seen"]
    assert people.nearby(observation) is observation["nearby"]
    assert people.roster(observation) is observation["roster"]
    assert props.all(observation) is observation["village"]["props"]
    assert props.seen(observation) is observation["props"]
    assert layout.frame(observation) is observation["village"]["size"]
    assert layout.buildings(observation) is observation["village"]["buildings"]
    assert layout.spawn(observation) is observation["village"]["spawn"]
    assert me.heading(observation) is observation["self"]["heading"]
    assert me.moved(observation) is observation["self"]["moved"]
    assert me.expression(observation) is observation["self"]["expression"]
    assert me.home(observation) == next(
        item["home"] for item in observation["roster"] if item["id"] == "player_1"
    )
    assert day.tick(observation) is observation["tick"]
    assert day.phase(observation) is observation["phase"]
    assert day.bell_ringing(observation) is bool(observation["bell"])
    assert day.parameters(observation) is observation["parameters"]
    assert action.walk(360.0, 4.0, "wave") == {"heading": 0.0, "speed": 1.0, "action": 2}
    assert action.stand(-90.0, "use") == {"heading": 270.0, "speed": 0.0, "action": 1}
    assert action.walk(-1.0, -4.0) == {"heading": 359.0, "speed": 0.0, "action": 0}
    with pytest.raises(ValueError, match="unknown expression"):
        action.walk(0.0, 1.0, "dance")
    assert env.action_space("player_1").contains(action.stand(me.heading(observation)))


def test_static_helpers_respect_the_boundary_and_do_not_cross_observations():
    _env, observations = _observations()
    first, second = observations["player_1"], observations["player_2"]
    here = me.position(first)
    assert layout.cell_at(first, {"x": -0.01, "y": 0.0}) is None
    assert layout.ground_at(first, {"x": -1, "y": 0}) is None
    assert not layout.walkable(first, {"x": -1, "y": 0})
    assert not layout.can_step(first, {"x": 0, "y": 0}, {"x": -1, "y": 0})
    assert not layout.line_of_sight(first, {"x": -1.0, "y": 0.0}, here)
    assert layout.line_of_sight(first, here, here)

    building = layout.buildings(first)[0]
    assert layout.building(first, building["id"]) is building
    assert layout.building(first, "not-a-building") is None
    assert layout.doorway(first, building["id"]) is not None
    assert layout.doorway(first, "not-a-building") is None
    assert layout.SPEED_LIMITS["road"] == 1.0
    assert layout.SPEED_LIMITS["water"] == 0.0

    # Build a cached model before mutating one player's isolated static mapping.
    assert layout.cell_at(first, here) is not None
    first_prop = props.all(first)[0]
    second_prop = props.all(second)[0]
    first_prop["cell"]["x"] = 99
    assert second_prop["cell"]["x"] != 99


def test_player_id_predicates_and_geometry_are_stable():
    assert people.is_visitor("player_0")
    assert not people.is_visitor("visitor")
    assert people.is_npc("player_1")
    assert people.is_npc("player_10")
    assert not people.is_npc("player_0")
    assert not people.is_npc("player_01")
    assert not people.is_npc("npc_0")
    assert geometry.distance({"x": 0.0, "y": 0.0}, {"x": 3.0, "y": 4.0}) == 5.0
    assert geometry.heading_to({"x": 1.0, "y": 1.0}, {"x": 1.0, "y": 1.0}) == 0.0
    assert geometry.heading_to({"x": 0.0, "y": 0.0}, {"x": 0.0, "y": -1.0}) == 270.0
    assert geometry.wrap(-1.0) == 359.0
    assert geometry.in_cone({"x": 0.0, "y": 0.0}, 0.0, {"x": 1.0, "y": 0.0})
    assert not geometry.in_cone({"x": 0.0, "y": 0.0}, 0.0, {"x": 0.0, "y": 1.0}, 90.0)
    assert not geometry.in_cone({"x": 0.0, "y": 0.0}, 0.0, {"x": 2.0, "y": 0.0}, reach=1.0)


def test_rng_is_stable_per_player_and_seed():
    _env, observations = _observations()

    first = me.rng(observations["player_1"], 17).random()
    assert first == me.rng(observations["player_1"], 17).random()
    assert first != me.rng(observations["player_2"], 17).random()
    assert first != me.rng(observations["player_1"], 18).random()


def test_props_preview_real_shape_reach_and_preserve_observation_records():
    _env, observations = _observations()
    observation = copy.deepcopy(observations["player_1"])
    bench = next(prop for prop in props.all(observation) if prop["type"] == "bench")
    observation["self"]["position"] = {"x": bench["cell"]["x"] + 0.5, "y": bench["cell"]["y"] + 0.5}

    assert bench in props.in_reach(observation)
    assert props.usable(observation) is bench
    assert set(props.TYPES) == {prop["type"] for prop in props.all(observation)}


def test_doorway_returns_none_or_the_nearest_deterministic_multi_cell_run():
    _env, observations = _observations()
    observation = copy.deepcopy(observations["player_1"])
    rows = [["g"] * 120 for _ in range(120)]
    for x, y in ((10, 12), (11, 12), (30, 30), (31, 30)):
        rows[y][x] = "d"
    observation["village"]["ground"] = tuple("".join(row) for row in rows)
    observation["village"]["buildings"] = (
        {"id": "near", "type": "home", "cell": {"x": 10, "y": 10}},
        {"id": "far", "type": "home", "cell": {"x": 30, "y": 30}},
        {"id": "tie", "type": "home", "cell": {"x": 20, "y": 20}},
    )

    assert layout.doorway(observation, "near") == {"x": 11.0, "y": 12.5}
    assert layout.doorway(observation, "far") == {"x": 31.0, "y": 30.5}
    assert layout.doorway(observation, "tie") == {"x": 11.0, "y": 12.5}

    observation["village"]["ground"] = tuple("g" * 120 for _ in range(120))
    assert layout.doorway(observation, "near") is None


def test_starter_prioritizes_benches_then_doorways_then_pumps_and_waves(monkeypatch):
    _env, observations = _observations()
    observation = copy.deepcopy(observations["player_1"])
    example = agent.Agent()
    example.reset(7, observation)
    heading = me.heading(observation)
    bench = next(prop for prop in props.all(observation) if prop["type"] == "bench")

    monkeypatch.setattr(agent.props, "usable", lambda _observation: bench)
    assert example.act(observation) == action.stand(heading, "use")

    monkeypatch.setattr(agent.props, "usable", lambda _observation: None)
    monkeypatch.setattr(agent.layout, "ground_at", lambda _observation, _cell: "interior")
    monkeypatch.setattr(agent.layout, "doorway", lambda _observation, _home: {"x": 3.0, "y": 4.0})
    monkeypatch.setattr(agent.me, "position", lambda _observation: {"x": 1.0, "y": 1.0})
    monkeypatch.setattr(agent.layout, "cell_at", lambda _observation, _position: {"x": 1, "y": 1})
    assert example.act(observation) == action.walk(
        geometry.heading_to({"x": 1.0, "y": 1.0}, {"x": 3.0, "y": 4.0}), 1.0
    )

    monkeypatch.setattr(agent.layout, "ground_at", lambda _observation, _cell: "ground")
    observation["seen"] = (observation["self"],)
    assert example.act(observation)["action"] == action.walk(0.0, 1.0, "wave")["action"]

    observation["seen"] = ()
    observation["village"]["props"] = tuple(prop for prop in props.all(observation) if prop["type"] != "pump")
    assert example.act(observation) == action.walk(heading, 0.0)


def test_importing_helpers_does_not_load_the_engine_stack():
    code = (
        "import sys; from sandbox.village import action, day, geometry, layout, me, people, props; "
        "assert 'gymnasium' not in sys.modules; assert 'pettingzoo' not in sys.modules; "
        "assert 'pymunk' not in sys.modules"
    )
    subprocess.run([sys.executable, "-c", code], check=True)
