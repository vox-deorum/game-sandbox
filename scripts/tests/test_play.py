"""Focused seams for the maintainer local browser launcher."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from game_sandbox_harness.environment import EnvironmentEntry, EnvironmentMeta

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import play  # noqa: E402


def _entry() -> EnvironmentEntry:
    class Env:
        possible_agents = ["player_0", "player_1"]

        def __init__(self, _parameters: object) -> None:
            pass

        def close(self) -> None:
            pass

    return EnvironmentEntry(
        meta=EnvironmentMeta(
            env_id="fixture",
            display_name="Fixture",
            description="fixture",
            min_slots=2,
            max_slots=2,
            human_slots=("player_0", "player_1"),
            human_timeout_ms=1000,
            recommended_episode_ticks=1,
            pace_interval_ms=None,
            step_limit_ms=1000,
            episode_limit_ms=1000,
            messaging=False,
            message_cap=None,
            llm=False,
            renderer="fixture",
        ),
        make=Env,
        default_action=lambda _env, _slot: 0,
    )


def test_local_config_has_complete_slots_and_players(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(play, "BUILTIN_AGENT_ROOT", tmp_path / "builtin")
    (play.BUILTIN_AGENT_ROOT / "fixture").mkdir(parents=True)
    config = play.local_config(
        _entry(),
        mode="human",
        seat=1,
        seed=7,
        max_steps=3,
        recording_dir=tmp_path,
    )

    assert config["slots"] == {
        "player_0": {"kind": "builtin-agent", "path": str(play.BUILTIN_AGENT_ROOT / "fixture")},
        "player_1": {"kind": "external"},
    }
    players = config["players"]
    assert isinstance(players, dict)
    assert set(players) == {"player_0", "player_1"}
    assert config["llm"] is None
    assert config["start_paused"] is True


def test_local_bundle_rebuilds_every_time(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(play, "FRONTEND_LOCAL_DIST_DIR", tmp_path)
    calls: list[tuple[list[str], Path]] = []

    def build(command: list[str], *, cwd: Path, check: bool) -> None:
        calls.append((command, cwd))
        (tmp_path / "local.html").write_text("ok", encoding="utf-8")

    monkeypatch.setattr(play.subprocess, "run", build)
    assert play.ensure_local_bundle() == tmp_path
    assert calls == [([play.NPM_COMMAND, "run", "build:local"], play.REPO_ROOT / "frontend")]
    assert play.ensure_local_bundle() == tmp_path
    assert calls == [
        ([play.NPM_COMMAND, "run", "build:local"], play.REPO_ROOT / "frontend"),
        ([play.NPM_COMMAND, "run", "build:local"], play.REPO_ROOT / "frontend"),
    ]


def test_launch_browser_uses_the_local_server_and_browser_seam(monkeypatch, tmp_path: Path):
    events: list[object] = []

    class Server:
        url = "http://127.0.0.1:1234/local.html"

        def __init__(self, *args, **kwargs) -> None:
            events.append((args, kwargs))

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args) -> None:
            pass

        async def wait(self) -> None:
            events.append("wait")

    monkeypatch.setattr(play, "LocalServer", Server)
    monkeypatch.setattr(play.webbrowser, "open", events.append)
    assert (
        play.launch_browser(_entry(), {"env_id": "fixture"}, port=12, open_browser=True, static_root=tmp_path)
        == 0
    )
    assert events[-2:] == ["http://127.0.0.1:1234/local.html", "wait"]


def test_builtin_agent_path_resolves_inside_this_checkout():
    path = Path(play.builtin_agent_path("hearts"))
    assert path.is_relative_to(play.REPO_ROOT)
    assert (path / "manifest.json").is_file()


def test_agent_repo_rejects_an_explicit_conflicting_mode(monkeypatch, tmp_path: Path, capsys):
    monkeypatch.setattr(play, "load_environment", lambda _env_id: _entry())

    with pytest.raises(SystemExit) as error:
        play.main(["fixture", "human", "--agent-repo", str(tmp_path / "agent")])

    assert error.value.code == 2
    assert "requires agent mode" in capsys.readouterr().err


def test_agent_repo_without_a_mode_selects_agent_mode(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(play, "load_environment", lambda _env_id: _entry())
    captured: dict[str, object] = {}

    def launch(_entry: EnvironmentEntry, config: dict[str, object], **_kwargs: object) -> int:
        captured.update(config)
        return 0

    monkeypatch.setattr(play, "launch_browser", launch)

    assert play.main(["fixture", "--agent-repo", str(tmp_path / "agent"), "--no-browser"]) == 0
    assert captured["slots"] == {
        "player_0": {"kind": "builtin-agent", "path": str(tmp_path / "agent")},
        "player_1": {"kind": "builtin-agent", "path": str(tmp_path / "agent")},
    }
