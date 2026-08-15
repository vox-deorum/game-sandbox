"""Behavior checks for the internal sweeper example."""

from __future__ import annotations

import ast
import copy
import inspect

import agent
import pytest
from sandbox.env import META, make_env
from sandbox.harness.environment import resolve_parameters
from sandbox.village import action, me, props


def _agent_and_observation(player_id: str = "player_1"):
    env = make_env(resolve_parameters(META))
    observations, _ = env.reset(seed=9)
    example = agent.Agent()
    example.reset(9, observations[player_id])
    return env, example, observations[player_id]


def test_seeded_role_target_and_quarter_repeat_for_one_player():
    _first_env, first, first_observation = _agent_and_observation()
    _second_env, second, second_observation = _agent_and_observation()

    assert (first._role, first._quarter, first._target["id"]) == (
        second._role,
        second._quarter,
        second._target["id"],
    )
    assert first._target["type"] == first._role
    assert first._target in first_observation["village"]["props"]
    assert second._target in second_observation["village"]["props"]


def test_reset_uses_the_first_two_rng_draws_for_role_and_quarter():
    _env, example, observation = _agent_and_observation()
    rng = me.rng(observation, 9)

    assert example._role == rng.choice(tuple(props.TYPES))
    assert example._quarter == rng.randrange(4)
    assert example._idle_offset == rng.randrange(agent.IDLE_TICKS)


@pytest.mark.parametrize(
    ("cell", "quarter"),
    [
        ({"x": 59, "y": 59}, 0),
        ({"x": 60, "y": 59}, 1),
        ({"x": 59, "y": 60}, 2),
        ({"x": 60, "y": 60}, 3),
    ],
)
def test_quarter_uses_east_and_north_halves_at_the_frame_midpoint(cell, quarter):
    assert agent._quarter(cell, {"cells_x": 120, "cells_y": 120}) == quarter


def test_reset_selects_the_first_matching_target_in_its_quarter_then_layout_order():
    _env, example, observation = _agent_and_observation()
    adjusted = copy.deepcopy(observation)
    role, quarter = example._role, example._quarter
    cells = ({"x": 1, "y": 1}, {"x": 61, "y": 1}, {"x": 1, "y": 61}, {"x": 61, "y": 61})
    adjusted["village"]["props"] = tuple(
        {"id": f"candidate_{index}", "type": role, "cell": cell, "facing": "north"}
        for index, cell in enumerate(cells)
    )

    example.reset(9, adjusted)
    assert example._target["id"] == f"candidate_{quarter}"

    adjusted["village"]["props"] = tuple(
        {"id": f"outside_{index}", "type": role, "cell": cells[(quarter + index + 1) % 4], "facing": "north"}
        for index in range(2)
    )
    example.reset(9, adjusted)
    assert example._target["id"] == "outside_0"


def test_reset_without_a_matching_prop_sweeps_in_place():
    _env, example, observation = _agent_and_observation()
    adjusted = copy.deepcopy(observation)
    adjusted["village"]["props"] = ()
    example.reset(9, adjusted)

    assert example._target is None
    assert example.act(adjusted) == action.stand(me.heading(adjusted), "sweep")


def test_sweeper_returns_a_contained_sweep_or_use_order():
    env, example, observation = _agent_and_observation()
    order = example.act(observation)

    assert env.action_space("player_1").contains(order)
    assert order["action"] in {1, 10}


def test_sweeper_uses_its_selected_usable_target(monkeypatch):
    _env, example, observation = _agent_and_observation()
    monkeypatch.setattr(agent.props, "usable", lambda _observation: example._target)

    assert example.act(observation) == action.stand(me.heading(observation), "use")


def test_sweeper_chooses_north_first_when_north_and_east_are_equally_good(monkeypatch):
    _env, example, observation = _agent_and_observation()
    example._target = {"id": "target", "type": example._role, "cell": {"x": 2, "y": 2}, "facing": "north"}
    example._idle_offset = 1
    observation["tick"] = 0
    monkeypatch.setattr(agent.me, "position", lambda _observation: {"x": 1.5, "y": 1.5})
    monkeypatch.setattr(agent.me, "heading", lambda _observation: 0.0)
    monkeypatch.setattr(agent.props, "usable", lambda _observation: None)
    monkeypatch.setattr(agent.layout, "cell_at", lambda _observation, _position: {"x": 1, "y": 1})
    monkeypatch.setattr(
        agent.layout, "walkable", lambda _observation, cell: cell["x"] >= 1 and cell["y"] >= 1
    )
    monkeypatch.setattr(
        agent.layout, "can_step", lambda _observation, _start, end: end["x"] >= 1 and end["y"] >= 1
    )

    assert example.act(observation) == action.walk(90.0, 1.0, "sweep")


def test_sweeper_skips_invalid_neighbors_and_sweeps_when_no_move_improves(monkeypatch):
    _env, example, observation = _agent_and_observation()
    example._target = {"id": "target", "type": example._role, "cell": {"x": 3, "y": 1}, "facing": "north"}
    example._idle_offset = 1
    observation["tick"] = 0
    monkeypatch.setattr(agent.me, "position", lambda _observation: {"x": 1.5, "y": 1.5})
    monkeypatch.setattr(agent.me, "heading", lambda _observation: 35.0)
    monkeypatch.setattr(agent.props, "usable", lambda _observation: None)
    monkeypatch.setattr(agent.layout, "cell_at", lambda _observation, _position: {"x": 1, "y": 1})
    monkeypatch.setattr(agent.layout, "walkable", lambda _observation, cell: cell == {"x": 2, "y": 1})
    monkeypatch.setattr(agent.layout, "can_step", lambda _observation, _start, _end: False)

    assert example.act(observation) == action.stand(35.0, "sweep")


def test_sweeper_is_written_only_against_the_public_sandbox_helpers():
    tree = ast.parse(inspect.getsource(agent))
    imports = {
        alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names
    } | {
        node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module is not None
    }

    assert imports == {"sandbox.observation_types", "sandbox.village"}
