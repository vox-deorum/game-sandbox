"""Focused seams for the maintainer local browser launcher."""

from __future__ import annotations

import json
import sys
from dataclasses import replace
from pathlib import Path

import pytest

from game_sandbox_harness.environment import (
    BuiltinAgent,
    EnvironmentEntry,
    EnvironmentMeta,
    EnvParameter,
    EnvPreset,
    PlayerBounds,
    SeatDeclaration,
    SeatPlan,
    SeatPlans,
    load_environment,
)
from game_sandbox_harness.live import parse_config

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
            stepping="sequential",
            builtin_agents=(BuiltinAgent("naive", "Naive agent"),),
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
            stepping="sequential",
            builtin_agents=(BuiltinAgent("naive", "Naive agent"),),
            layout=SeatPlans(
                (
                    SeatPlan(
                        "partnership",
                        "Partnership",
                        (SeatDeclaration((0, 2)), SeatDeclaration((1, 3))),
                    ),
                    SeatPlan(
                        "solo",
                        "Solo",
                        (
                            SeatDeclaration((0,)),
                            SeatDeclaration((1,)),
                            SeatDeclaration((2,)),
                            SeatDeclaration((3,)),
                        ),
                    ),
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
    (play.BUILTIN_AGENT_ROOT / "fixture" / "naive").mkdir(parents=True)
    config = play.local_config(
        _entry(),
        mode="human",
        seat=1,
        seed=7,
        max_steps=3,
        recording_dir=tmp_path,
    )

    assert config["player_bindings"] == {
        "player_0": {
            "kind": "builtin-agent",
            "path": str(play.BUILTIN_AGENT_ROOT / "fixture" / "naive"),
            "name": "naive",
        },
        "player_1": {"kind": "external"},
    }
    assert config["external_chat_player"] == "player_1"
    players = config["players"]
    assert isinstance(players, dict)
    assert set(players) == {"player_0", "player_1"}
    assert config["llm"] is None
    assert config["start_paused"] is True
    parse_config([json.dumps(config)], entry=_entry())


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
    path = Path(play.builtin_agent_path("hearts", "naive"))
    assert path.is_relative_to(play.REPO_ROOT)
    assert (path / "manifest.json").is_file()


def test_watch_mode_honors_a_seat_restricted_builtin(tmp_path: Path):
    entry = load_environment("three_branches")

    config = play.local_config(
        entry,
        mode="watch",
        seat=0,
        seed=0,
        max_steps=None,
        recording_dir=tmp_path,
    )

    bindings = config["player_bindings"]
    players = config["players"]
    assert bindings["player_0"] == {  # type: ignore[index]
        "kind": "builtin-agent",
        "path": play.builtin_agent_path("three_branches", "scripted_visitor"),
        "name": "scripted_visitor",
    }
    assert players["player_0"] == {  # type: ignore[index]
        "kind": "agent",
        "builtin_name": "scripted_visitor",
        "label": "Scripted visitor",
    }
    assert bindings["player_1"]["name"] == "naive"  # type: ignore[index]
    assert players["player_1"]["builtin_name"] == "naive"  # type: ignore[index]


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
    assert captured["external_chat_player"] is None


def test_human_cli_routes_the_selected_seat_to_its_player(monkeypatch):
    monkeypatch.setattr(play, "load_environment", lambda _env_id: _entry())
    monkeypatch.setattr(play, "builtin_agent_path", lambda _env_id, _name: "builtin")
    captured: dict[str, object] = {}

    def launch(_entry: EnvironmentEntry, config: dict[str, object], **_kwargs: object) -> int:
        captured.update(config)
        return 0

    monkeypatch.setattr(play, "launch_browser", launch)

    assert play.main(["fixture", "human", "--seat", "1", "--no-browser"]) == 0
    assert captured["player_bindings"] == {
        "player_0": {"kind": "builtin-agent", "path": "builtin", "name": "naive"},
        "player_1": {"kind": "external"},
    }
    assert captured["external_chat_player"] == "player_1"


def test_wide_human_seat_defaults_to_naive_and_preserves_an_explicit_companion(
    monkeypatch,
    tmp_path: Path,
):
    entry = _wide_entry()
    monkeypatch.setattr(play, "BUILTIN_AGENT_ROOT", tmp_path / "builtin")
    (play.BUILTIN_AGENT_ROOT / "fixture" / "naive").mkdir(parents=True)

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
            "path": str(play.BUILTIN_AGENT_ROOT / "fixture" / "naive"),
            "name": "naive",
        },
        "player_1": {
            "kind": "builtin-agent",
            "path": str(play.BUILTIN_AGENT_ROOT / "fixture" / "naive"),
            "name": "naive",
        },
        "player_3": {
            "kind": "builtin-agent",
            "path": str(play.BUILTIN_AGENT_ROOT / "fixture" / "naive"),
            "name": "naive",
        },
    }
    assert config["external_chat_player"] == "player_0"
    assert config["players"]["player_2"] == {  # type: ignore[index]
        "kind": "agent",
        "builtin_name": "naive",
        "label": "Naive agent",
    }

    defaulted = play.local_config(
        entry,
        mode="human",
        seat=0,
        seed=1,
        max_steps=None,
        recording_dir=tmp_path,
    )
    assert defaulted["player_bindings"] == config["player_bindings"]
    assert defaulted["external_chat_player"] == "player_0"


def test_self_companion_binds_every_seat_member_as_externally_controlled(
    monkeypatch,
    tmp_path: Path,
):
    entry = _wide_entry()
    monkeypatch.setattr(play, "BUILTIN_AGENT_ROOT", tmp_path / "builtin")
    (play.BUILTIN_AGENT_ROOT / "fixture" / "naive").mkdir(parents=True)

    config = play.local_config(
        entry,
        mode="human",
        seat=0,
        seed=1,
        max_steps=None,
        companion="self",
        recording_dir=tmp_path,
    )
    assert config["player_bindings"] == {
        "player_0": {"kind": "external"},
        "player_2": {"kind": "external"},
        "player_1": {
            "kind": "builtin-agent",
            "path": str(play.BUILTIN_AGENT_ROOT / "fixture" / "naive"),
            "name": "naive",
        },
        "player_3": {
            "kind": "builtin-agent",
            "path": str(play.BUILTIN_AGENT_ROOT / "fixture" / "naive"),
            "name": "naive",
        },
    }
    assert config["players"]["player_2"] == {"kind": "human", "label": "You"}  # type: ignore[index]
    # One connected person still sends chat, as the seat's first human-capable member.
    assert config["external_chat_player"] == "player_0"


def test_self_companion_needs_a_human_capable_seat(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(play, "BUILTIN_AGENT_ROOT", tmp_path / "builtin")
    (play.BUILTIN_AGENT_ROOT / "fixture" / "naive").mkdir(parents=True)

    # A seat holding a player nobody may steer cannot be played whole.
    with pytest.raises(RuntimeError, match="human-capable"):
        play.local_config(
            _wide_entry(human_players=("player_0", "player_1")),
            mode="human",
            seat=0,
            seed=1,
            max_steps=None,
            companion="self",
            recording_dir=tmp_path,
        )


@pytest.mark.parametrize("env_id", ["spades", "skirmish_crane"])
def test_self_companion_plays_a_real_wide_seat_whole(env_id: str, monkeypatch, tmp_path: Path):
    """Cover the shipped wide-seat environments, not only the fixture layout."""
    entry = load_environment(env_id)
    monkeypatch.setattr(play, "BUILTIN_AGENT_ROOT", tmp_path / "builtin")
    (play.BUILTIN_AGENT_ROOT / env_id / "naive").mkdir(parents=True)

    seat_players = play.default_layout(entry).seats[0].players
    assert len(seat_players) > 1
    config = play.local_config(
        entry,
        mode="human",
        seat=0,
        seed=1,
        max_steps=None,
        companion="self",
        recording_dir=tmp_path,
    )

    bindings = config["player_bindings"]
    assert all(bindings[player] == {"kind": "external"} for player in seat_players)  # type: ignore[index]
    assert config["external_chat_player"] == seat_players[0]
    others = [player for player in bindings if player not in seat_players]  # type: ignore[operator]
    assert others and all(bindings[player]["kind"] == "builtin-agent" for player in others)  # type: ignore[index]


def test_skirmish_crane_wide_preset_defaults_the_companion_to_naive(tmp_path: Path):
    entry = load_environment("skirmish_crane")
    parameters = play.resolve_cli_parameters(entry, [], preset="season_6")
    seat_players = play.default_layout(entry, parameters).seats[0].players

    config = play.local_config(
        entry,
        mode="human",
        seat=0,
        seed=1,
        max_steps=None,
        parameters=parameters,
        recording_dir=tmp_path,
    )

    bindings = config["player_bindings"]
    human_player = play.player_for_seat(entry, 0, parameters)
    assert bindings[human_player] == {"kind": "external"}  # type: ignore[index]
    assert all(
        bindings[player]["name"] == "naive"  # type: ignore[index]
        for player in seat_players
        if player != human_player
    )


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


def test_preset_parameters_apply_without_cli_overrides():
    entry = _wide_entry()
    entry = EnvironmentEntry(
        meta=replace(
            entry.meta,
            presets=(EnvPreset("solo_fast", "Solo fast", {"seat_plan": "solo", "speed": 2}),),
        ),
        make=entry.make,
        default_action=entry.default_action,
    )

    values = play.resolve_cli_parameters(entry, [], preset="solo_fast")

    assert values == {"seat_plan": "solo", "speed": 2}


def test_cli_parameter_overrides_a_preset_value():
    entry = _wide_entry()
    entry = EnvironmentEntry(
        meta=replace(
            entry.meta,
            presets=(EnvPreset("solo_fast", "Solo fast", {"seat_plan": "solo", "speed": 2}),),
        ),
        make=entry.make,
        default_action=entry.default_action,
    )

    values = play.resolve_cli_parameters(entry, ["speed=3"], preset="solo_fast")

    assert values == {"seat_plan": "solo", "speed": 3}


def test_unknown_preset_names_the_sorted_available_choices():
    entry = _wide_entry()
    named = EnvironmentEntry(
        meta=replace(
            entry.meta,
            presets=(EnvPreset("zeta", "Zeta", {}), EnvPreset("alpha", "Alpha", {})),
        ),
        make=entry.make,
        default_action=entry.default_action,
    )

    with pytest.raises(ValueError, match="unknown environment preset 'missing'; available: alpha, zeta"):
        play.resolve_cli_parameters(named, [], preset="missing")

    with pytest.raises(ValueError, match="available: none"):
        play.resolve_cli_parameters(entry, [], preset="missing")


def test_companion_accepts_a_manifest_path(monkeypatch, tmp_path: Path):
    entry = _wide_entry()
    monkeypatch.setattr(play, "BUILTIN_AGENT_ROOT", tmp_path / "builtin")
    (play.BUILTIN_AGENT_ROOT / "fixture" / "naive").mkdir(parents=True)
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
    monkeypatch.setattr(play, "builtin_agent_path", lambda _env_id, _name: "builtin")
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


def test_cli_applies_preset_plan_before_validating_the_seat(monkeypatch):
    entry = _wide_entry()
    entry = EnvironmentEntry(
        meta=replace(
            entry.meta,
            presets=(EnvPreset("solo", "Solo", {"seat_plan": "solo"}),),
        ),
        make=entry.make,
        default_action=entry.default_action,
    )
    monkeypatch.setattr(play, "load_environment", lambda _env_id: entry)
    monkeypatch.setattr(play, "builtin_agent_path", lambda _env_id, _name: "builtin")
    captured: dict[str, object] = {}

    def launch(_entry: EnvironmentEntry, config: dict[str, object], **_kwargs: object) -> int:
        captured.update(config)
        return 0

    monkeypatch.setattr(play, "launch_browser", launch)

    assert play.main(["fixture", "human", "--preset", "solo", "--seat", "3", "--no-browser"]) == 0
    assert captured["parameters"] == {"seat_plan": "solo", "speed": 1}
    assert captured["player_bindings"]["player_3"] == {"kind": "external"}  # type: ignore[index]


def test_cli_defaults_a_wide_human_seat_to_naive(monkeypatch):
    monkeypatch.setattr(play, "load_environment", lambda _env_id: _wide_entry())
    monkeypatch.setattr(play, "builtin_agent_path", lambda _env_id, _name: "builtin")
    captured: dict[str, object] = {}

    def launch(_entry: EnvironmentEntry, config: dict[str, object], **_kwargs: object) -> int:
        captured.update(config)
        return 0

    monkeypatch.setattr(play, "launch_browser", launch)

    assert play.main(["fixture", "human", "--no-browser"]) == 0
    assert captured["player_bindings"] == {
        "player_0": {"kind": "external"},
        "player_2": {"kind": "builtin-agent", "path": "builtin", "name": "naive"},
        "player_1": {"kind": "builtin-agent", "path": "builtin", "name": "naive"},
        "player_3": {"kind": "builtin-agent", "path": "builtin", "name": "naive"},
    }
