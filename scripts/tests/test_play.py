"""Focused seams for the maintainer local browser launcher."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from game_sandbox_harness.environment import (
    EnvironmentEntry,
    EnvironmentMeta,
    EnvParameter,
    PlayerBounds,
    SeatPlan,
    SeatPlans,
)

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
            layout=PlayerBounds(2, 2),
            human_players=("player_0", "player_1"),
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
        default_action=lambda _env, _player: 0,
    )


def _wide_entry(*, human_players: tuple[str, ...] = ("player_0", "player_1", "player_2", "player_3")):
    entry = _entry()
    return EnvironmentEntry(
        meta=EnvironmentMeta(
            env_id="fixture",
            display_name="Fixture",
            description="fixture",
            layout=SeatPlans(
                (
                    SeatPlan("partnership", "Partnership", ((0, 2), (1, 3))),
                    SeatPlan("solo", "Solo", ((0,), (1,), (2,), (3,))),
                )
            ),
            human_players=human_players,
            human_timeout_ms=1000,
            recommended_episode_ticks=1,
            pace_interval_ms=None,
            step_limit_ms=1000,
            episode_limit_ms=1000,
            messaging=False,
            message_cap=None,
            llm=False,
            renderer="fixture",
            parameters=(
                EnvParameter(
                    name="speed",
                    title="Speed",
                    description="Fixture speed.",
                    type="int",
                    default=1,
                    min=1,
                    max=3,
                ),
            ),
        ),
        make=entry.make,
        default_action=entry.default_action,
    )


def test_local_config_resolves_the_selected_seat_to_its_player(tmp_path: Path, monkeypatch):
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

    assert config["player_bindings"] == {
        "player_0": {"kind": "builtin-agent", "path": str(play.BUILTIN_AGENT_ROOT / "fixture")},
        "player_1": {"kind": "external"},
    }
    players = config["players"]
    assert isinstance(players, dict)
    assert set(players) == {"player_0", "player_1"}
    assert config["llm"] is None
    assert config["start_paused"] is True


def test_default_layout_exposes_players_and_singleton_seats():
    entry = _entry()

    assert play.possible_players(entry) == ("player_0", "player_1")
    assert play.player_for_seat(entry, 1) == "player_1"


def test_wide_layout_players_come_from_seat_membership_in_canonical_order():
    entry = _wide_entry()
    assert tuple(player for seat in play.default_layout(entry).seats for player in seat.players) == (
        "player_0",
        "player_2",
        "player_1",
        "player_3",
    )
    assert play.possible_players(entry) == ("player_0", "player_1", "player_2", "player_3")


def test_wide_layout_uses_the_first_human_capable_member_in_declared_order():
    entry = _wide_entry(human_players=("player_2",))
    assert play.player_for_seat(entry, 0) == "player_2"


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
    assert captured["player_bindings"] == {
        "player_0": {"kind": "builtin-agent", "path": str(tmp_path / "agent")},
        "player_1": {"kind": "builtin-agent", "path": str(tmp_path / "agent")},
    }


def test_human_cli_routes_the_selected_seat_to_its_player(monkeypatch):
    monkeypatch.setattr(play, "load_environment", lambda _env_id: _entry())
    monkeypatch.setattr(play, "builtin_agent_path", lambda _env_id: "builtin")
    captured: dict[str, object] = {}

    def launch(_entry: EnvironmentEntry, config: dict[str, object], **_kwargs: object) -> int:
        captured.update(config)
        return 0

    monkeypatch.setattr(play, "launch_browser", launch)

    assert play.main(["fixture", "human", "--seat", "1", "--no-browser"]) == 0
    assert captured["player_bindings"] == {
        "player_0": {"kind": "builtin-agent", "path": "builtin"},
        "player_1": {"kind": "external"},
    }


def test_wide_human_seat_requires_and_expands_an_explicit_companion(
    monkeypatch,
    tmp_path: Path,
):
    entry = _wide_entry()
    monkeypatch.setattr(play, "BUILTIN_AGENT_ROOT", tmp_path / "builtin")
    (play.BUILTIN_AGENT_ROOT / "fixture").mkdir(parents=True)

    with pytest.raises(RuntimeError, match="requires --companion"):
        play.local_config(
            entry,
            mode="human",
            seat=0,
            seed=1,
            max_steps=None,
            recording_dir=tmp_path,
        )

    config = play.local_config(
        entry,
        mode="human",
        seat=0,
        seed=1,
        max_steps=None,
        companion="naive",
        recording_dir=tmp_path,
    )
    assert config["parameters"] == {"seat_plan": "partnership", "speed": 1}
    assert config["player_bindings"] == {
        "player_0": {"kind": "external"},
        "player_2": {
            "kind": "builtin-agent",
            "path": str(play.BUILTIN_AGENT_ROOT / "fixture"),
        },
        "player_1": {
            "kind": "builtin-agent",
            "path": str(play.BUILTIN_AGENT_ROOT / "fixture"),
        },
        "player_3": {
            "kind": "builtin-agent",
            "path": str(play.BUILTIN_AGENT_ROOT / "fixture"),
        },
    }
    assert config["players"]["player_2"]["label"] == "Companion"  # type: ignore[index]


def test_repeatable_typed_parameters_select_the_layout_and_validate_values():
    entry = _wide_entry()
    values = play.resolve_cli_parameters(
        entry,
        ["seat_plan=solo", "speed=2", "speed=3"],
    )
    assert values == {"seat_plan": "solo", "speed": 3}
    assert len(play.default_layout(entry, values).seats) == 4

    with pytest.raises(ValueError, match="between 1 and 3"):
        play.resolve_cli_parameters(entry, ["speed=4"])
    with pytest.raises(ValueError, match="unknown environment parameter"):
        play.resolve_cli_parameters(entry, ["missing=1"])


def test_companion_accepts_a_manifest_path(monkeypatch, tmp_path: Path):
    entry = _wide_entry()
    monkeypatch.setattr(play, "BUILTIN_AGENT_ROOT", tmp_path / "builtin")
    (play.BUILTIN_AGENT_ROOT / "fixture").mkdir(parents=True)
    companion_repo = tmp_path / "companion"
    companion_repo.mkdir()
    manifest = companion_repo / "manifest.json"
    manifest.write_text("{}", encoding="utf-8")

    config = play.local_config(
        entry,
        mode="human",
        seat=0,
        seed=1,
        max_steps=None,
        companion=str(manifest),
        recording_dir=tmp_path,
    )
    assert config["player_bindings"]["player_2"]["path"] == str(companion_repo)  # type: ignore[index]


def test_cli_applies_plan_parameter_before_validating_seat_and_companion(
    monkeypatch,
    tmp_path: Path,
):
    entry = _wide_entry()
    monkeypatch.setattr(play, "load_environment", lambda _env_id: entry)
    monkeypatch.setattr(play, "builtin_agent_path", lambda _env_id: "builtin")
    captured: dict[str, object] = {}

    def launch(_entry: EnvironmentEntry, config: dict[str, object], **_kwargs: object) -> int:
        captured.update(config)
        return 0

    monkeypatch.setattr(play, "launch_browser", launch)
    assert (
        play.main(
            [
                "fixture",
                "human",
                "--parameter",
                "seat_plan=solo",
                "--parameter",
                "speed=2",
                "--seat",
                "3",
                "--no-browser",
            ]
        )
        == 0
    )
    assert captured["parameters"] == {"seat_plan": "solo", "speed": 2}
    assert captured["player_bindings"]["player_3"] == {"kind": "external"}  # type: ignore[index]


def test_cli_requires_companion_for_default_wide_plan(monkeypatch, capsys):
    monkeypatch.setattr(play, "load_environment", lambda _env_id: _wide_entry())
    with pytest.raises(SystemExit) as error:
        play.main(["fixture", "human", "--no-browser"])
    assert error.value.code == 2
    assert "requires --companion" in capsys.readouterr().err
