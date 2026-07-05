"""The builders produce schema-valid output by construction."""

from __future__ import annotations

import pytest

from game_sandbox_harness.schema import (
    SCHEMA_VERSION,
    SchemaValidationError,
    validate_header,
    validate_step,
)
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


def test_chat_ms_is_emitted_only_when_supplied():
    # A non-chatting agent carries no chat field, so a chat-less recording is unchanged.
    without = build_agent_step(reward=0.0, score=0.0, decision_ms=0.5, learn_ms=0.2)
    assert "chat_ms" not in without["timing"]
    # A chatting tick carries chat_ms alongside decision_ms and learn_ms.
    with_chat = build_agent_step(reward=0.0, score=0.0, decision_ms=0.5, chat_ms=0.3)
    assert with_chat["timing"]["chat_ms"] == 0.3


def test_step_with_messages_and_chat_ms_validates():
    state = build_step_state(
        tick=1,
        agents={
            "player_0": build_agent_step(reward=0.0, score=0.0, action=57, decision_ms=0.5, chat_ms=0.25)
        },
        started_at=1_700_000_000_000,
        duration_ms=1.0,
        messages=[
            {"from": "player_0", "to": "player_1", "text": "strong:hearts"},
            {"from": "player_0", "to": None, "text": "table!"},
        ],
    )
    validate_step(state)
    assert state["agents"]["player_0"]["timing"]["chat_ms"] == 0.25


def test_header_builder_is_valid():
    validate_header(build_header(environment="flappy"))
    validate_header(build_header(environment="flappy", created_at="2026-06-10T00:00:00Z", seed=9))


def test_header_builder_carries_player_attribution():
    header = build_header(
        environment="flappy",
        players={
            "player_0": {"kind": "human", "label": "alice", "user": "alice"},
            "player_1": {"kind": "agent", "label": "Naive agent"},
        },
    )
    validate_header(header)
    assert header["players"]["player_0"]["user"] == "alice"
    assert header["players"]["player_1"]["label"] == "Naive agent"


def test_header_rejects_player_attribution_with_empty_label():
    with pytest.raises(SchemaValidationError):
        validate_header(
            build_header(
                environment="flappy",
                players={"player_0": {"kind": "agent", "label": ""}},
            )
        )
