"""The builders produce schema-valid output by construction."""

from __future__ import annotations

from game_sandbox_harness.schema import SCHEMA_VERSION, validate_header, validate_step
from game_sandbox_harness.state import build_agent_step, build_header, build_step_state


def test_minimal_step_is_valid():
    state = build_step_state(
        tick=0,
        agents={"player_0": build_agent_step(reward=0.0, score=0.0)},
        started_at=0,
        duration_ms=0.0,
    )
    validate_step(state)
    assert state["schema_version"] == SCHEMA_VERSION
    # Optional regions are absent, not present-and-empty, to keep lines small.
    assert "overlay" not in state
    assert "messages" not in state


def test_full_step_is_valid():
    state = build_step_state(
        tick=3,
        agents={
            "player_0": build_agent_step(
                reward=1.0, score=4.0, observation={"y": 1}, action=1, decision_ms=0.5
            )
        },
        started_at=1_700_000_000_000,
        duration_ms=2.0,
        overlay={"pipes": []},
        messages=[{"from": "player_0", "to": None, "text": "hi"}],
    )
    validate_step(state)


def test_header_builder_is_valid():
    validate_header(build_header(environment="flappy"))
    validate_header(build_header(environment="flappy", created_at="2026-06-10T00:00:00Z", seed=9))
