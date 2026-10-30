from __future__ import annotations

import ast
import json
import random
import sys
from pathlib import Path

import pytest

from three_branches import naive
from three_branches.env import default_action, make_env
from three_branches.overlay import extract_overlay, extract_overlay_static


@pytest.mark.parametrize(("seat_plan", "cast_size"), [("cast_5", 5), ("cast_10", 10)])
def test_overlay_separates_static_data_and_rounds_dynamic_numbers(seat_plan: str, cast_size: int) -> None:
    env = make_env({"seat_plan": seat_plan, "daynight": True})
    observations, _ = env.reset(seed=2)
    static = extract_overlay_static(env)
    assert static == json.loads(json.dumps(env.day.layout.village()))
    assert static["ground"] == list(observations["player_0"]["village"]["ground"])

    env.day.characters["player_0"].position = (1.234, 5.678)
    env.day.characters["player_0"].heading = 12.34
    overlay = extract_overlay(env)
    expected_ids = [f"player_{index}" for index in range(cast_size + 1)]
    assert set(overlay) == {"tick", "phase", "characters", "props", "terminal"}
    assert "ground" not in overlay
    assert list(env.day.characters) == expected_ids
    assert [entry["id"] for entry in observations["player_0"]["roster"]] == expected_ids
    assert [record["id"] for record in overlay["characters"]] == expected_ids
    assert "visitor" not in json.dumps(overlay)
    assert "npc_" not in json.dumps(overlay)
    if seat_plan == "cast_10":
        assert overlay["characters"][-1]["id"] == "player_10"
    assert overlay["characters"][0]["x"] == 1.23
    assert overlay["characters"][0]["heading"] == 12.3
    assert list(overlay["props"]) == list(env.day.prop_states)
    json.dumps(overlay, allow_nan=False)


def test_naive_builtin_handles_real_observations_and_follows_its_state_machine(monkeypatch) -> None:
    monkeypatch.setattr(naive, "_new_rng", lambda: random.Random(7))
    env = make_env({"seat_plan": "cast_5", "daynight": False})
    observations, _ = env.reset(seed=2)
    walker = naive.Agent()
    walker.reset(2, observations["player_1"])
    original_heading = walker._heading
    actions = [walker.act(observations["player_1"]) for _ in range(3)]
    assert actions[0]["heading"] == original_heading
    assert actions[-1]["heading"] != original_heading
    assert all(action["speed"] > 0 and action["action"] == 0 for action in actions)


def test_builtins_are_stdlib_only_and_match_the_staged_copies() -> None:
    package = Path(__file__).resolve().parents[1]
    staged = (
        Path(__file__).resolve().parents[3] / "backend/images/session-base/deps-v1/builtin/three_branches"
    )
    for name in ("naive", "scripted_visitor"):
        source = package / f"{name}.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        roots = {
            alias.name.partition(".")[0]
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        } | {
            (node.module or "").partition(".")[0]
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.level == 0
        }
        assert roots <= sys.stdlib_module_names
        assert source.read_bytes() == (staged / name / "agent.py").read_bytes()
    # The visitor reads the canonical rules and catalog from sidecars beside its staged agent.
    for name in ("rules.json", "catalog.json"):
        assert (package / name).read_bytes() == (staged / "scripted_visitor" / name).read_bytes()

    # The environment's default remains a valid fallback independently of either builtin.
    env = make_env({"seat_plan": "cast_5", "daynight": False})
    env.reset()
    assert env.action_space("player_0").contains(default_action(env, "player_0"))
