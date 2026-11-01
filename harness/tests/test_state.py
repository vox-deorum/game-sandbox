"""Builders preserve supplied state and header data, omitting absent optional fields."""

from __future__ import annotations

import pytest

from game_sandbox_harness.environment import ResolvedLayout, ResolvedSeat
from game_sandbox_harness.schema import validate_header, validate_step
from game_sandbox_harness.state import build_agent_step, build_header, build_step_state


def test_minimal_step_is_valid():
    state = build_step_state(
        tick=0,
        agents={"player_0": build_agent_step(reward=0.0, score=0.0)},
        started_at=0,
        duration_ms=0.0,
    )
    validate_step(state)
    assert state == {
        "schema_version": 1,
        "tick": 0,
        "agents": {"player_0": {"reward": 0.0, "score": 0.0}},
        "timing": {"started_at": 0, "duration_ms": 0.0},
    }


@pytest.mark.parametrize(
    ("hook_times", "expected_timing"),
    [
        ({"learn_ms": 0.2}, {"decision_ms": 0.5, "learn_ms": 0.2}),
        ({"learn_ms": 0.2, "chat_ms": 0.3}, {"decision_ms": 0.5, "learn_ms": 0.2, "chat_ms": 0.3}),
        (
            {"decision_ms": 0.0, "learn_ms": 0.0, "chat_ms": 0.0},
            {"decision_ms": 0.0, "learn_ms": 0.0, "chat_ms": 0.0},
        ),
    ],
)
def test_full_step_is_valid(hook_times, expected_timing):
    state = build_step_state(
        tick=3,
        agents={
            "player_0": build_agent_step(
                reward=1.0,
                score=4.0,
                observation={"y": 1},
                action=0,
                **({"decision_ms": 0.5} | hook_times),
            )
        },
        started_at=1_700_000_000_000,
        duration_ms=2.0,
        overlay={"pipes": []},
        messages=[
            {"from": "player_0", "to": "player_1", "text": "strong:hearts"},
            {"from": "player_0", "to": None, "text": "table!"},
        ],
    )
    validate_step(state)
    assert state == {
        "schema_version": 1,
        "tick": 3,
        "agents": {
            "player_0": {
                "reward": 1.0,
                "score": 4.0,
                "observation": {"y": 1},
                "action": 0,
                "timing": expected_timing,
            }
        },
        "timing": {"started_at": 1_700_000_000_000, "duration_ms": 2.0},
        "overlay": {"pipes": []},
        "messages": [
            {"from": "player_0", "to": "player_1", "text": "strong:hearts"},
            {"from": "player_0", "to": None, "text": "table!"},
        ],
    }


def test_step_with_live_chat_options_validates():
    state = build_step_state(
        tick=4,
        agents={},
        started_at=100,
        duration_ms=0,
        chat_options={
            "sender": "player_0",
            "target_recipients": ["player_2", "player_1", "player_3"],
            "default_recipient": "player_2",
        },
    )
    validate_step(state)
    assert state["chat_options"] == {
        "sender": "player_0",
        "target_recipients": ["player_2", "player_1", "player_3"],
        "default_recipient": "player_2",
    }


@pytest.mark.parametrize(
    ("optional", "expected_optional"),
    [
        ({}, {}),
        (
            {
                "seed": 0,
                "created_at": "2026-06-10T00:00:00Z",
                "overlay_static": {"sprites": {"bird": "blue"}},
                "sidecars": [{"name": "future", "path": "future.bin"}],
            },
            {
                "seed": 0,
                "created_at": "2026-06-10T00:00:00Z",
                "overlay_static": {"sprites": {"bird": "blue"}},
                "sidecars": [{"name": "future", "path": "future.bin"}],
            },
        ),
    ],
)
def test_header_builder_is_valid(optional, expected_optional):
    header = build_header(
        environment="demo",
        parameters={"seat_plan": "shared", "goal": 5},
        players={
            "player_0": {"kind": "human", "label": "Alice", "user": "alice"},
            "player_1": {"kind": "agent", "builtin_name": "naive", "label": "Baseline"},
            "player_2": {"kind": "agent", "submission_id": "submission-9", "label": "Student"},
        },
        layout=ResolvedLayout(
            "shared",
            (ResolvedSeat("seat_0", ("player_0", "player_2")), ResolvedSeat("seat_1", ("player_1",))),
            3,
            2,
        ),
        **optional,
    )
    validate_header(header)
    assert header == {
        "schema_version": 1,
        "environment": "demo",
        "parameters": {"seat_plan": "shared", "goal": 5},
        "players": {
            "player_0": {"kind": "human", "label": "Alice", "user": "alice"},
            "player_1": {"kind": "agent", "builtin_name": "naive", "label": "Baseline"},
            "player_2": {"kind": "agent", "submission_id": "submission-9", "label": "Student"},
        },
        "seats": {"seat_0": ["player_0", "player_2"], "seat_1": ["player_1"]},
        "seat_plan": "shared",
        **expected_optional,
    }
