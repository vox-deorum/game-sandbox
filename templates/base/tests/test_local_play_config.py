"""The generic browser launcher always gives the live runner complete player attribution."""

from __future__ import annotations

import importlib
import io
import json
import sys
from dataclasses import replace
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest
from sandbox import evaluate, play


def test_single_player_local_config_uses_metadata_timeout_when_omitted(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(play, "possible_players", lambda: ("player_0",))
    monkeypatch.setattr(play, "REPO_ROOT", tmp_path / "repo")

    config = play.local_config(
        seed=7,
        mode="human",
        player=0,
        recording_dir=tmp_path / "recordings",
        step_limit=None,
    )

    assert config["player_bindings"] == {"player_0": {"kind": "external"}}
    assert config["players"] == {"player_0": {"kind": "human", "label": "You"}}
    assert "human_timeout_ms" not in config
    assert "max_steps" not in config


def test_four_player_local_config_covers_every_player_and_preserves_null_timeout(monkeypatch, tmp_path: Path):
    player_ids = ("player_0", "player_1", "player_2", "player_3")
    monkeypatch.setattr(play, "possible_players", lambda: player_ids)
    monkeypatch.setattr(play, "REPO_ROOT", tmp_path / "repo")

    config = play.local_config(
        seed=8,
        mode="human",
        player=2,
        recording_dir=tmp_path / "recordings",
        step_limit=52,
        human_timeout_ms=None,
    )

    assert set(config["player_bindings"]) == set(player_ids)
    assert set(config["players"]) == set(player_ids)
    assert config["player_bindings"]["player_2"] == {"kind": "external"}
    assert config["players"]["player_2"] == {"kind": "human", "label": "You"}
    assert config["human_timeout_ms"] is None
    assert config["max_steps"] == 52


def test_human_mode_rejects_a_player_excluded_from_metadata(monkeypatch, capsys):
    monkeypatch.setattr(play, "possible_players", lambda: ("player_0", "player_1"))
    monkeypatch.setattr(play, "META", replace(play.META, human_players=("player_0",)))

    with pytest.raises(SystemExit) as error:
        play.main(["human", "--player", "1"])

    assert error.value.code == 2
    assert "not human-playable" in capsys.readouterr().err


def test_headless_allows_a_valid_player_excluded_from_human_metadata(monkeypatch, capsys):
    monkeypatch.setattr(play, "possible_players", lambda: ("player_0", "player_1"))
    monkeypatch.setattr(play, "META", replace(play.META, human_players=("player_0",)))
    monkeypatch.setattr(play, "run_headless", lambda **kwargs: 3.5)

    assert play.main(["human", "--headless", "--player", "1", "--seed", "7"]) == 0
    assert capsys.readouterr().out == "seed 7: score 3.50\n"


def test_template_play_does_not_offer_unsupported_watch_mode():
    with pytest.raises(SystemExit) as error:
        play.main(["watch"])

    assert error.value.code == 2


def test_evaluate_forwards_the_selected_player(monkeypatch, capsys):
    calls: list[dict[str, object]] = []

    def run_headless(**kwargs: object) -> float:
        calls.append(kwargs)
        return 2.0

    monkeypatch.setattr(evaluate, "run_headless", run_headless)

    assert evaluate.main(["--episodes", "2", "--player", "1"]) == 0
    assert calls == [
        {"seed": 0, "max_steps": None, "player": 1},
        {"seed": 1, "max_steps": None, "player": 1},
    ]
    assert "mean over 2 episode(s): 2.00" in capsys.readouterr().out


def test_local_runner_passes_stdin_to_the_harness_run_seam(monkeypatch, tmp_path: Path):
    """The relocated harness, not this shim, starts stdin after client-ready state emits."""
    env = ModuleType("sandbox.env")
    env.META = SimpleNamespace(env_id="fake")
    env.default_action = lambda environment, player_id: 0
    env.extract_overlay = lambda environment: {}
    env.make_env = lambda _parameters: object()
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
        "parameters": {"players": 1},
        "seed": 0,
        "player_bindings": {"player_0": {"kind": "external"}},
        "players": {"player_0": {"kind": "human", "label": "You"}},
        "recording_dir": str(tmp_path / "recordings"),
        "recording_id": "local",
    }

    assert live_local.main([json.dumps(config)]) == 0
    assert captured["command_lines"] is sys.stdin
