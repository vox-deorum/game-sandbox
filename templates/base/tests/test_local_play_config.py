"""The generic browser launcher always gives the live runner complete player attribution."""

from __future__ import annotations

import io
import json
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from sandbox import evaluate, live_local, play
from sandbox.harness.environment import (
    EnvParameter,
    EnvPreset,
    PlayerBounds,
    SeatDeclaration,
    SeatPlan,
    SeatPlans,
    resolve_parameters,
)
from sandbox.harness.live import parse_config
from sandbox.season import SeasonSettings


def _rival_repo(tmp_path: Path) -> Path:
    rival = tmp_path / "rivals" / "v1"
    rival.mkdir(parents=True)
    (rival / "manifest.json").write_text("{}", encoding="utf-8")
    return rival


def _use_partnership_layout(monkeypatch: pytest.MonkeyPatch) -> None:
    players = ("player_0", "player_1", "player_2", "player_3")
    monkeypatch.setattr(play, "possible_players", lambda parameters=None: players)
    plans = SeatPlans(
        (
            SeatPlan(
                "partnership",
                "Partnership",
                (SeatDeclaration((0, 2)), SeatDeclaration((1, 3))),
            ),
        )
    )
    monkeypatch.setattr(play, "META", replace(play.META, layout=plans, presets=()))


def test_single_player_local_config_uses_metadata_timeout_when_omitted(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(play, "possible_players", lambda parameters=None: ("player_0",))
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
    monkeypatch.setattr(play, "possible_players", lambda parameters=None: player_ids)
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
    monkeypatch.setattr(play, "possible_players", lambda parameters=None: ("player_0", "player_1"))
    monkeypatch.setattr(play, "META", replace(play.META, human_players=("player_0",)))

    with pytest.raises(SystemExit) as error:
        play.main(["human", "--player", "1"])

    assert error.value.code == 2
    assert "not human-playable" in capsys.readouterr().err


def test_headless_allows_a_valid_player_excluded_from_human_metadata(monkeypatch, capsys):
    monkeypatch.setattr(play, "possible_players", lambda parameters=None: ("player_0", "player_1"))
    monkeypatch.setattr(play, "META", replace(play.META, human_players=("player_0",)))
    monkeypatch.setattr(play, "run_headless", lambda **kwargs: 3.5)

    assert play.main(["human", "--headless", "--player", "1", "--seed", "7"]) == 0
    assert capsys.readouterr().out == "seed 7: score 3.50\n"


def test_template_play_does_not_offer_unsupported_watch_mode():
    with pytest.raises(SystemExit) as error:
        play.main(["watch"])

    assert error.value.code == 2


def test_preset_replaces_season_parameters_even_when_its_values_are_empty(monkeypatch, capsys):
    monkeypatch.setattr(play, "META", replace(play.META, presets=(EnvPreset("season_1", "Season 1", {}),)))
    monkeypatch.setattr(
        play,
        "load_season_settings",
        lambda _root, _meta: SeasonSettings("Downloaded season", {"round_cap": 150}, 123, 456),
    )
    captured: dict[str, object] = {}

    def run_headless(**kwargs: object) -> float:
        captured.update(kwargs)
        return 2.0

    monkeypatch.setattr(play, "run_headless", run_headless)

    assert play.main(["agent", "--headless", "--preset", "season_1"]) == 0
    assert captured["parameters"] == resolve_parameters(play.META)
    assert captured["decision_limit_ms"] == 123
    assert captured["game_limit_ms"] == 456
    assert capsys.readouterr().out == (
        "Using the season_1 preset with the time limits from season.json.\nseed 0: score 2.00\n"
    )


def test_preset_parameters_yield_to_explicit_parameter_overrides(monkeypatch):
    # Declare a test-only parameter on the metadata so the preset and the override validate in
    # every environment, whatever its real parameters are.
    knob = EnvParameter(
        name="trial_knob",
        title="Trial knob",
        description="Test-only tuning parameter.",
        type="int",
        default=100,
        min=1,
        max=1000,
    )
    monkeypatch.setattr(
        play,
        "META",
        replace(
            play.META,
            parameters=(*play.META.parameters, knob),
            presets=(EnvPreset("short", "Short", {"trial_knob": 150}),),
        ),
    )
    captured: dict[str, object] = {}

    def run_headless(**kwargs: object) -> float:
        captured.update(kwargs)
        return 2.0

    monkeypatch.setattr(play, "run_headless", run_headless)

    assert play.main(["agent", "--headless", "--preset", "short", "--parameter", "trial_knob=200"]) == 0
    assert captured["parameters"] == resolve_parameters(play.META, {"trial_knob": 200})


def test_unknown_preset_reports_the_available_names(monkeypatch, capsys):
    monkeypatch.setattr(
        play,
        "META",
        replace(play.META, presets=(EnvPreset("season_1", "Season 1", {}),)),
    )

    with pytest.raises(SystemExit) as error:
        play.main(["agent", "--preset", "missing"])

    assert error.value.code == 2
    assert "unknown environment preset 'missing'; available: season_1" in capsys.readouterr().err


def test_evaluate_forwards_the_selected_player(monkeypatch, capsys):
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(evaluate.play, "possible_players", lambda parameters: ("player_0", "player_1"))
    parameters = resolve_parameters(evaluate.play.META)

    def run_headless(**kwargs: object) -> float:
        calls.append(kwargs)
        return 2.0

    monkeypatch.setattr(evaluate, "run_headless", run_headless)

    assert evaluate.main(["--episodes", "2", "--player", "1"]) == 0
    assert calls == [
        {
            "seed": 0,
            "max_steps": None,
            "player": 1,
            "vs": None,
            "parameters": parameters,
            "decision_limit_ms": None,
            "game_limit_ms": None,
        },
        {
            "seed": 1,
            "max_steps": None,
            "player": 1,
            "vs": None,
            "parameters": parameters,
            "decision_limit_ms": None,
            "game_limit_ms": None,
        },
    ]
    assert "mean over 2 episode(s): 2.00" in capsys.readouterr().out


def test_local_runner_passes_stdin_to_the_harness_run_seam(monkeypatch, tmp_path: Path):
    """The relocated harness, not this shim, starts stdin after client-ready state emits."""
    captured: dict[str, object] = {}

    def fake_run(*args: object, **kwargs: object) -> int:
        captured.update(kwargs)
        return 0

    monkeypatch.setattr(live_local, "_claim_stdout", lambda: io.StringIO())
    monkeypatch.setattr(live_local, "run", fake_run)
    config = play.local_config(
        seed=0,
        mode="human",
        player=0,
        recording_dir=tmp_path / "recordings",
        step_limit=None,
    )

    assert live_local.main([json.dumps(config)]) == 0
    assert captured["command_lines"] is sys.stdin


def test_resolve_rival_accepts_a_folder_and_its_manifest_path(monkeypatch, tmp_path: Path):
    rival = _rival_repo(tmp_path)

    assert play.resolve_rival(str(rival)) == rival.resolve()
    assert play.resolve_rival(str(rival / "manifest.json")) == rival.resolve()

    monkeypatch.chdir(tmp_path)
    assert play.resolve_rival("rivals/v1") == rival.resolve()


def test_resolve_rival_rejects_missing_and_manifestless_paths(tmp_path: Path):
    with pytest.raises(ValueError, match="could not find"):
        play.resolve_rival(str(tmp_path / "missing"))

    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(ValueError, match="no manifest.json"):
        play.resolve_rival(str(empty))


def test_vs_fills_every_opposing_player_in_a_one_player_per_seat_layout(monkeypatch, tmp_path: Path):
    player_ids = ("player_0", "player_1", "player_2", "player_3")
    monkeypatch.setattr(play, "possible_players", lambda parameters=None: player_ids)
    monkeypatch.setattr(play, "META", replace(play.META, layout=PlayerBounds(min=4, max=4), presets=()))
    monkeypatch.setattr(play, "REPO_ROOT", tmp_path / "repo")
    rival = _rival_repo(tmp_path)

    config = play.local_config(
        seed=1, mode="agent", player=0, recording_dir=tmp_path / "recordings", step_limit=None, vs=rival
    )

    bindings = config["player_bindings"]
    assert bindings["player_0"] == {"kind": "builtin-agent", "path": str(tmp_path / "repo")}
    for other in ("player_1", "player_2", "player_3"):
        assert bindings[other] == {"kind": "builtin-agent", "path": str(rival)}
    assert config["players"]["player_0"] == {
        "kind": "agent",
        "submission_id": "local",
        "label": "Your agent",
    }
    assert config["players"]["player_1"] == {
        "kind": "agent",
        "submission_id": "local-rival",
        "label": "Rival (v1)",
    }
    parse_config([json.dumps(config)], entry=play._entry())


def test_vs_keeps_the_selected_seat_on_your_agent_in_a_partnership_layout(monkeypatch, tmp_path: Path):
    _use_partnership_layout(monkeypatch)
    monkeypatch.setattr(play, "REPO_ROOT", tmp_path / "repo")
    rival = _rival_repo(tmp_path)

    config = play.local_config(
        seed=1, mode="agent", player=2, recording_dir=tmp_path / "recordings", step_limit=None, vs=rival
    )

    bindings = config["player_bindings"]
    assert bindings["player_0"]["path"] == str(tmp_path / "repo")
    assert bindings["player_2"]["path"] == str(tmp_path / "repo")
    assert bindings["player_1"]["path"] == str(rival)
    assert bindings["player_3"]["path"] == str(rival)


def test_human_mode_vs_gives_the_partner_your_agent(monkeypatch, tmp_path: Path):
    _use_partnership_layout(monkeypatch)
    monkeypatch.setattr(play, "REPO_ROOT", tmp_path / "repo")
    rival = _rival_repo(tmp_path)

    config = play.local_config(
        seed=1, mode="human", player=0, recording_dir=tmp_path / "recordings", step_limit=None, vs=rival
    )

    assert config["player_bindings"]["player_0"] == {"kind": "external"}
    assert config["player_bindings"]["player_2"]["path"] == str(tmp_path / "repo")
    assert config["players"]["player_2"] == {
        "kind": "agent",
        "submission_id": "local",
        "label": "Your agent",
    }
    assert config["player_bindings"]["player_1"]["path"] == str(rival)
    assert config["player_bindings"]["player_3"]["path"] == str(rival)


def test_self_companion_makes_every_teammate_yours_to_play(monkeypatch, tmp_path: Path):
    _use_partnership_layout(monkeypatch)
    monkeypatch.setattr(play, "REPO_ROOT", tmp_path / "repo")

    config = play.local_config(
        seed=1,
        mode="human",
        player=0,
        recording_dir=tmp_path / "recordings",
        step_limit=None,
        companion="self",
    )

    assert config["player_bindings"]["player_0"] == {"kind": "external"}
    assert config["player_bindings"]["player_2"] == {"kind": "external"}
    assert config["players"]["player_2"] == {"kind": "human", "label": "You"}
    # The opposing team is untouched; only your own is yours.
    assert config["player_bindings"]["player_1"]["path"] == str(tmp_path / "repo")
    assert config["player_bindings"]["player_3"]["path"] == str(tmp_path / "repo")
    assert config["external_chat_player"] == "player_0"


def test_self_companion_keeps_the_first_human_capable_teammate_as_the_chat_sender(
    monkeypatch,
    tmp_path: Path,
):
    _use_partnership_layout(monkeypatch)
    monkeypatch.setattr(play, "META", replace(play.META, human_players=("player_2",)))
    monkeypatch.setattr(play, "REPO_ROOT", tmp_path / "repo")

    config = play.local_config(
        seed=1,
        mode="human",
        player=0,
        recording_dir=tmp_path / "recordings",
        step_limit=None,
        companion="self",
    )

    assert config["external_chat_player"] == "player_2"
    assert config["player_bindings"]["player_2"] == {"kind": "external"}


def test_local_config_emits_the_chat_sender_without_a_companion(monkeypatch, tmp_path: Path):
    _use_partnership_layout(monkeypatch)
    monkeypatch.setattr(play, "REPO_ROOT", tmp_path / "repo")

    config = play.local_config(
        seed=1, mode="human", player=2, recording_dir=tmp_path / "recordings", step_limit=None
    )

    # Without --companion self the one external player is both the player and the chat sender.
    assert config["external_chat_player"] == "player_2"
    assert config["player_bindings"]["player_0"]["path"] == str(tmp_path / "repo")


def test_local_config_without_vs_is_unchanged_in_a_partnership_layout(monkeypatch, tmp_path: Path):
    _use_partnership_layout(monkeypatch)
    monkeypatch.setattr(play, "REPO_ROOT", tmp_path / "repo")

    config = play.local_config(
        seed=1, mode="agent", player=0, recording_dir=tmp_path / "recordings", step_limit=None
    )

    for player_id in ("player_0", "player_1", "player_2", "player_3"):
        assert config["player_bindings"][player_id] == {
            "kind": "builtin-agent",
            "path": str(tmp_path / "repo"),
        }
        assert config["players"][player_id] == {
            "kind": "agent",
            "submission_id": "local",
            "label": "Your agent",
        }


def test_vs_errors_in_a_single_player_game(monkeypatch, capsys, tmp_path: Path):
    monkeypatch.setattr(play, "possible_players", lambda parameters=None: ("player_0",))
    monkeypatch.setattr(play, "META", replace(play.META, layout=PlayerBounds(min=1, max=1), presets=()))

    with pytest.raises(SystemExit) as error:
        play.main(["agent", "--vs", str(tmp_path)])
    assert error.value.code == 2
    assert "only one player" in capsys.readouterr().err

    with pytest.raises(SystemExit) as error:
        evaluate.main(["--vs", str(tmp_path)])
    assert error.value.code == 2
    assert "only one player" in capsys.readouterr().err


def test_vs_errors_when_one_seat_covers_every_player(monkeypatch, capsys, tmp_path: Path):
    players = ("player_0", "player_1", "player_2")
    monkeypatch.setattr(play, "possible_players", lambda parameters=None: players)
    plans = SeatPlans((SeatPlan("coop", "Cooperative", (SeatDeclaration((0, 1, 2)),)),))
    monkeypatch.setattr(play, "META", replace(play.META, layout=plans, presets=()))

    with pytest.raises(SystemExit) as error:
        play.main(["agent", "--vs", str(tmp_path)])
    assert error.value.code == 2
    assert "every player is on your team" in capsys.readouterr().err

    with pytest.raises(SystemExit) as error:
        evaluate.main(["--vs", str(tmp_path)])
    assert error.value.code == 2
    assert "every player is on your team" in capsys.readouterr().err


def test_self_companion_is_rejected_where_it_cannot_apply(monkeypatch, capsys, tmp_path: Path):
    monkeypatch.setattr(play, "possible_players", lambda parameters=None: ("player_0",))
    monkeypatch.setattr(play, "META", replace(play.META, layout=PlayerBounds(min=1, max=1), presets=()))

    # A team of one has nobody else to play.
    with pytest.raises(SystemExit) as error:
        play.main(["human", "--companion", "self"])
    assert error.value.code == 2
    assert "more than one player" in capsys.readouterr().err

    _use_partnership_layout(monkeypatch)
    monkeypatch.setattr(play, "META", replace(play.META, human_players=("player_0",)))

    # A teammate nobody may steer cannot be played by hand either.
    with pytest.raises(SystemExit) as error:
        play.main(["human", "--companion", "self"])
    assert error.value.code == 2
    assert "human-playable" in capsys.readouterr().err

    # Watching your own agent is not playing it.
    with pytest.raises(SystemExit) as error:
        play.main(["agent", "--companion", "self"])
    assert error.value.code == 2
    assert "human mode" in capsys.readouterr().err

    # Only `self` is a companion here; the template has no other companion agent to offer.
    with pytest.raises(SystemExit) as error:
        play.main(["human", "--companion", str(tmp_path)])
    assert error.value.code == 2


def test_run_headless_vs_loads_a_separate_agent_for_every_other_player(monkeypatch, tmp_path: Path):
    _use_partnership_layout(monkeypatch)
    monkeypatch.setattr(play, "REPO_ROOT", tmp_path / "repo")
    monkeypatch.setattr(play, "make_env", lambda parameters: SimpleNamespace(close=lambda: None))
    loads: list[Path] = []

    def fake_load(root: Path) -> object:
        loads.append(Path(root))
        return object()

    monkeypatch.setattr(play, "load_agent", fake_load)
    captured: dict[str, object] = {}

    def fake_episode(agent: object, env: object, **kwargs: object) -> float:
        captured.update(kwargs)
        captured["agent"] = agent
        return 1.5

    monkeypatch.setattr(play, "play_episode", fake_episode)
    rival = _rival_repo(tmp_path)

    assert play.run_headless(seed=3, max_steps=None, player=0, vs=rival) == 1.5

    other_agents = captured["other_agents"]
    assert isinstance(other_agents, dict)
    assert set(other_agents) == {"player_1", "player_2", "player_3"}
    assert loads.count(rival) == 2
    assert loads.count(tmp_path / "repo") == 2
    instances = [captured["agent"], *other_agents.values()]
    assert len({id(instance) for instance in instances}) == 4


def test_run_headless_without_vs_keeps_the_default_action_opponents(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(play, "possible_players", lambda parameters=None: ("player_0", "player_1"))
    monkeypatch.setattr(play, "REPO_ROOT", tmp_path / "repo")
    monkeypatch.setattr(play, "make_env", lambda parameters: SimpleNamespace(close=lambda: None))
    loads: list[Path] = []
    monkeypatch.setattr(play, "load_agent", lambda root: loads.append(Path(root)) or object())
    captured: dict[str, object] = {}

    def fake_episode(agent: object, env: object, **kwargs: object) -> float:
        captured.update(kwargs)
        return 0.0

    monkeypatch.setattr(play, "play_episode", fake_episode)

    assert play.run_headless(seed=0, max_steps=None, player=0) == 0.0
    assert captured["other_agents"] is None
    assert loads == [tmp_path / "repo"]


def test_play_episode_binds_other_agents_and_defaults(monkeypatch):
    players = ("player_0", "player_1", "player_2")
    monkeypatch.setattr(play, "possible_players", lambda parameters=None: players)
    captured: dict[str, object] = {}

    def fake_run_episode(entry: object, players: object, **kwargs: object) -> SimpleNamespace:
        captured["players"] = players
        return SimpleNamespace(scores={"player_0": 4.0})

    monkeypatch.setattr(play, "run_episode", fake_run_episode)
    mine, rival_agent = object(), object()

    score = play.play_episode(
        mine, object(), seed=0, player_id="player_0", other_agents={"player_2": rival_agent}
    )

    assert score == 4.0
    players = captured["players"]
    assert isinstance(players, dict)
    assert isinstance(players["player_0"], play.AgentPlayer)
    assert players["player_0"].agent is mine
    assert isinstance(players["player_2"], play.AgentPlayer)
    assert players["player_2"].agent is rival_agent
    assert isinstance(players["player_1"], play.ExternalPlayer)


def test_evaluate_forwards_vs_to_every_episode(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(play, "META", replace(play.META, layout=PlayerBounds(min=2, max=2), presets=()))
    monkeypatch.setattr(evaluate.play, "possible_players", lambda parameters: ("player_0", "player_1"))
    parameters = resolve_parameters(evaluate.play.META)
    rival = _rival_repo(tmp_path)
    calls: list[dict[str, object]] = []

    def run_headless(**kwargs: object) -> float:
        calls.append(kwargs)
        return 1.0

    monkeypatch.setattr(evaluate, "run_headless", run_headless)

    assert evaluate.main(["--seeds", "5", "--vs", str(rival)]) == 0
    assert calls == [
        {
            "seed": 5,
            "max_steps": None,
            "player": 0,
            "vs": rival.resolve(),
            "parameters": parameters,
            "decision_limit_ms": None,
            "game_limit_ms": None,
        }
    ]
