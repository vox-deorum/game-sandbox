from __future__ import annotations

import random
from pathlib import Path

import numpy as np
import pytest

from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import AgentPlayer, run_episode
from three_branches import ENTRY, scripted_visitor
from three_branches.env import make_env
from three_branches.overlay import extract_overlay


class _StillAgent:
    def reset(self, seed, observation) -> None:
        del seed, observation

    def act(self, observation):
        return {
            "heading": np.array(observation["self"]["heading"], dtype=np.float32),
            "speed": np.array(0, dtype=np.float32),
            "action": 0,
        }


def _position(observation) -> tuple[float, float]:
    position = observation["self"]["position"]
    return float(position["x"]), float(position["y"])


@pytest.mark.parametrize("seat_plan, player_count", [("cast_5", 6), ("cast_10", 11)])
def test_harness_day_records_and_replays_captured_actions(
    seat_plan: str, player_count: int, tmp_path: Path, record_property, monkeypatch
) -> None:
    monkeypatch.setattr(scripted_visitor, "_new_rng", lambda: random.Random(7))
    players = {"player_0": AgentPlayer(scripted_visitor.Agent())}
    players.update({f"player_{index}": AgentPlayer(_StillAgent()) for index in range(1, player_count)})
    attribution = {
        player: {"kind": "agent", "label": "Still test agent", "builtin_name": "naive"} for player in players
    }
    attribution["player_0"] = {
        "kind": "agent",
        "label": "Scripted visitor",
        "builtin_name": "scripted_visitor",
    }
    recording_id = f"three-branches-{seat_plan}"
    result = run_episode(
        ENTRY,
        players,
        parameters={"seat_plan": seat_plan, "daynight": False},
        seed=3,
        store=FolderRecordingStore(tmp_path),
        recording_id=recording_id,
        player_attribution=attribution,
    )
    assert result.ticks == 1200
    assert result.failed_player is None
    assert set(result.scores.values()) == {100.0}
    assert set(result.step_timeouts.values()) == {0}

    path = tmp_path / recording_id / "recording.jsonl"
    record_property(f"{seat_plan}_recording_bytes", path.stat().st_size)
    recording = FolderRecordingStore(tmp_path).open(recording_id)
    states = list(recording.steps())
    assert len(states) == 1200

    visitor_actions = [state["agents"]["player_0"]["action"] for state in states]
    assert any(action["speed"] > 0 for action in visitor_actions)
    for state in states:
        for player in players:
            if player != "player_0":
                assert state["agents"][player]["action"]["speed"] == 0

    env = make_env({"seat_plan": seat_plan, "daynight": False})
    observations, _ = env.reset(seed=3)
    assert all(env.observation_space(player).contains(value) for player, value in observations.items())
    visitor_positions = {_position(observations["player_0"])}
    visitor_moved = []
    for state in states:
        # Replay the recorded values exactly. Casting Python floats to float32 changes the
        # commands and can move physics across a rounded overlay boundary.
        actions = {player: record["action"] for player, record in state["agents"].items()}
        assert all(env.action_space(player).contains(action) for player, action in actions.items())
        observations, _, _, _, _ = env.step(actions)
        assert all(env.observation_space(player).contains(value) for player, value in observations.items())
        assert extract_overlay(env) == state["overlay"]
        visitor_positions.add(_position(observations["player_0"]))
        visitor_moved.append(float(observations["player_0"]["self"]["moved"]))
    assert len(visitor_positions) > 1
    assert any(moved > 0 for moved in visitor_moved)
    assert not env.agents
    assert all(env.observation_space(player).contains(value) for player, value in observations.items())
