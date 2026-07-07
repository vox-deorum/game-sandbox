"""Environment metadata serialization and entry-point discovery."""

from __future__ import annotations

import json

import pytest

from game_sandbox_harness.environment import (
    EnvironmentEntry,
    EnvironmentLookupError,
    EnvironmentMeta,
    discover_environments,
    load_environment,
)


def _meta() -> EnvironmentMeta:
    return EnvironmentMeta(
        env_id="demo",
        display_name="Demo",
        description="A demo environment.",
        min_slots=1,
        max_slots=1,
        human_slots=("player_0",),
        human_timeout_ms=None,
        recommended_episode_ticks=1000,
        pace_interval_ms=50,
        step_limit_ms=1000,
        episode_limit_ms=120_000,
        messaging=False,
        message_cap=None,
        llm=False,
        renderer="demo",
    )


def test_meta_to_json_round_trips():
    meta = _meta()
    blob = json.dumps(meta.to_json())
    parsed = json.loads(blob)
    assert parsed["env_id"] == "demo"
    assert parsed["human_slots"] == ["player_0"]  # tuple serialized as a JSON array
    assert parsed["human_timeout_ms"] is None
    assert parsed["pace_interval_ms"] == 50
    assert parsed["seat_order_matters"] is False
    assert parsed["view_interval_ms"] is None  # defaulted, present in the serialized shape
    assert parsed["live_interval_ms"] is None  # defaulted, present in the serialized shape


def test_flappy_bird_is_discoverable():
    found = discover_environments()
    assert "flappy_bird" in found
    entry = found["flappy_bird"]
    assert entry.meta.env_id == "flappy_bird"
    assert entry.meta.human_slots == ("player_0",)
    # The metadata is serialisable end to end.
    json.dumps(entry.meta.to_json())


def test_load_environment_unknown_id_raises():
    with pytest.raises(EnvironmentLookupError, match="no environment registered as 'nope'"):
        load_environment("nope")


def test_discovery_rejects_name_envid_mismatch(monkeypatch):
    from game_sandbox_harness import environment as env_mod

    entry = EnvironmentEntry(meta=_meta(), make=lambda: None, default_action=lambda env, s: 0)

    class _FakeEP:
        name = "mismatch"  # != meta.env_id ("demo")

        def load(self):
            return entry

    monkeypatch.setattr(env_mod, "entry_points", lambda group: [_FakeEP()])
    with pytest.raises(ValueError, match="meta.env_id"):
        discover_environments()
