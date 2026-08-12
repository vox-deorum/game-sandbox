from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import AgentPlayer, run_episode
from three_branches import ENTRY
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


@pytest.mark.parametrize("seat_plan, player_count", [("cast_5", 6), ("cast_10", 11)])
def test_harness_day_records_and_replays_captured_actions(
    seat_plan: str, player_count: int, tmp_path: Path, record_property
) -> None:
    players = {f"player_{index}": AgentPlayer(_StillAgent()) for index in range(player_count)}
    attribution = {
        player: {"kind": "agent", "label": "Still test agent", "builtin_name": "naive"} for player in players
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

    env = make_env({"seat_plan": seat_plan, "daynight": False})
    observations, _ = env.reset(seed=3)
    assert all(env.observation_space(player).contains(value) for player, value in observations.items())
    for state in states:
        actions = {
            player: {
                "heading": np.array(record["action"]["heading"], dtype=np.float32),
                "speed": np.array(record["action"]["speed"], dtype=np.float32),
                "action": record["action"]["action"],
            }
            for player, record in state["agents"].items()
        }
        observations, _, _, _, _ = env.step(actions)
        assert all(env.observation_space(player).contains(value) for player, value in observations.items())
        assert extract_overlay(env) == state["overlay"]
    assert not env.agents
    assert all(env.observation_space(player).contains(value) for player, value in observations.items())
