"""The generic browser launcher always gives the live runner complete slot attribution."""

from __future__ import annotations

import importlib
import io
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

from sandbox import play


def test_single_slot_local_config_uses_metadata_timeout_when_omitted(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(play, "possible_slots", lambda: ("player_0",))
    monkeypatch.setattr(play, "REPO_ROOT", tmp_path / "repo")

    config = play.local_config(
        seed=7,
        mode="human",
        seat=0,
        recording_dir=tmp_path / "recordings",
        step_limit=None,
    )

    assert config["slots"] == {"player_0": {"kind": "external"}}
    assert config["players"] == {"player_0": {"kind": "human", "label": "You"}}
    assert "human_timeout_ms" not in config
    assert "max_steps" not in config


def test_four_slot_local_config_covers_every_slot_and_preserves_null_timeout(monkeypatch, tmp_path: Path):
    slots = ("player_0", "player_1", "player_2", "player_3")
    monkeypatch.setattr(play, "possible_slots", lambda: slots)
    monkeypatch.setattr(play, "REPO_ROOT", tmp_path / "repo")

    config = play.local_config(
        seed=8,
        mode="human",
        seat=2,
        recording_dir=tmp_path / "recordings",
        step_limit=52,
        human_timeout_ms=None,
    )

    assert set(config["slots"]) == set(slots)
    assert set(config["players"]) == set(slots)
    assert config["slots"]["player_2"] == {"kind": "external"}
    assert config["players"]["player_2"] == {"kind": "human", "label": "You"}
    assert config["human_timeout_ms"] is None
    assert config["max_steps"] == 52


def test_local_runner_passes_stdin_to_the_harness_run_seam(monkeypatch, tmp_path: Path):
    """The relocated harness, not this shim, starts stdin after client-ready state emits."""
    env = ModuleType("sandbox.env")
    env.META = SimpleNamespace(env_id="fake")
    env.default_action = lambda environment, slot_id: 0
    env.extract_overlay = lambda environment: {}
    env.make_env = lambda: object()
    monkeypatch.delitem(sys.modules, "sandbox.live_local", raising=False)
    monkeypatch.setitem(sys.modules, "sandbox.env", env)
    live_local = importlib.import_module("sandbox.live_local")
    captured: dict[str, object] = {}

    def fake_run(*args: object, **kwargs: object) -> int:
        captured.update(kwargs)
        return 0

    monkeypatch.setattr(live_local, "_claim_stdout", lambda: io.StringIO())
    monkeypatch.setattr(live_local, "run", fake_run)
    config = {
        "env_id": live_local.META.env_id,
        "seed": 0,
        "slots": {"player_0": {"kind": "external"}},
        "players": {"player_0": {"kind": "human", "label": "You"}},
        "recording_dir": str(tmp_path / "recordings"),
        "recording_id": "local",
    }

    assert live_local.main([json.dumps(config)]) == 0
    assert captured["command_lines"] is sys.stdin
