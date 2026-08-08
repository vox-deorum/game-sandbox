"""Focused wrapper checks for Skirmish at Crane Reach's Stage 2 contract."""

from __future__ import annotations

import importlib.util
import inspect
import json
import sys
import types
import warnings
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from gymnasium import spaces
from pettingzoo.test import api_test

import skirmish_crane.naive
from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import EnvPreset, action_mask_problems, resolve_parameters
from game_sandbox_harness.manifest import load_agent
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import REASON_TERMINATED, REASON_TRUNCATED, AgentPlayer, run_episode
from game_sandbox_harness.state import json_default
from skirmish_crane import ENTRY, META
from skirmish_crane.ascii_runner import replay_jsonl
from skirmish_crane.combat import Strike, visible_units
from skirmish_crane.engine import Activation, Unit
from skirmish_crane.env import IllegalMoveError, default_action, make_env
from skirmish_crane.hexes import DIRECTIONS
from skirmish_crane.naive import Agent, _decode_path, _distance, _end
from skirmish_crane.observation_types import SkirmishObservation, SkirmishObservationData
from skirmish_crane.overlay import OVERLAY_VERSION, decode_overlay, extract_overlay
from skirmish_crane.paths import MAX_PATH_ID, MAX_PATH_STEPS, decode_path, encode_path
from skirmish_crane.scoring import Result

BUILTIN_SKIRMISH_CRANE_NAIVE_AGENT_DIR = (
    Path(__file__).resolve().parents[3]
    / "backend"
    / "images"
    / "session-base"
    / "deps-v1"
    / "builtin"
    / "skirmish_crane"
    / "naive"
)


def _parameters(**overrides: Any) -> dict[str, Any]:
    return resolve_parameters(META, overrides)


def _legal_action(observation: dict[str, Any]) -> dict[str, int]:
    mask = observation["action_mask"]
    return {
        "path": int(np.flatnonzero(mask["path"])[0]),
        "target": int(np.flatnonzero(mask["target"])[0]),
    }


class StandStillAgent:
    """Keep full recording fixtures deterministic and free of incidental combat."""

    def reset(self, seed: int) -> None:
        pass

    def act(self, observation: dict[str, Any]) -> dict[str, int]:
        return {"path": 0, "target": 0}


class RetreatAgent:
    """Take the legal path whose endpoint is farthest from the nearest visible enemy."""

    def reset(self, seed: int) -> None:
        pass

    def act(self, observation: dict[str, Any]) -> dict[str, int]:
        state = observation["observation"]
        unit = state["self"]
        position = (unit["position"]["q"], unit["position"]["r"])
        side = unit["unit_id"].split("_", 1)[0]
        enemies = [
            (other["position"]["q"], other["position"]["r"])
            for other in state["visible_units"]
            if other["side"] != side
        ]
        legal_paths = [path for path, allowed in enumerate(observation["action_mask"]["path"]) if allowed]
        if not enemies:
            return {"path": 0, "target": 0}
        path = max(
            legal_paths,
            key=lambda candidate: (
                min(_distance(_end(position, candidate), enemy) for enemy in enemies),
                -candidate,
            ),
        )
        return {"path": path, "target": 0}


def _naive_players(count: int) -> dict[str, AgentPlayer]:
    return {f"player_{index}": AgentPlayer(Agent()) for index in range(count)}


def _attribution(players: dict[str, AgentPlayer]) -> dict[str, dict[str, str]]:
    return {player: {"kind": "agent", "builtin_name": "naive", "label": "Naive"} for player in players}


def _turns(env: Any, count: int) -> Iterator[dict[str, Any]]:
    for _ in range(count):
        observation, _reward, terminated, truncated, _info = env.last()
        yield observation
        env.step(None if terminated or truncated else _legal_action(observation))


def _api_test_tolerating_1211(env: Any) -> None:
    """Run PettingZoo's smoke test with its known composite-observation dtype tolerance."""
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message="Observation is not a NumPy array")
        warnings.filterwarnings("ignore", message="Observation space for each agent probably should be")
        try:
            api_test(env, num_cycles=3, verbose_progress=False)
        except AttributeError as error:
            if "dtype" not in str(error):
                raise


@pytest.mark.parametrize(
    "parameters",
    (
        _parameters(seat_plan="skirmish"),
        _parameters(seat_plan="army"),
        _parameters(
            seat_plan="skirmish",
            field_extent=5,
            terrain=False,
            unit_abilities=False,
            capture_zones=0,
            capture_target=10,
            round_cap=100,
        ),
        _parameters(
            seat_plan="army",
            field_extent=22,
            terrain=True,
            wasteland=True,
            unit_abilities=True,
            capture_zones=5,
            capture_target=10_000,
            round_cap=10_000,
        ),
    ),
    ids=("skirmish-default", "army-default", "minimums", "maximums"),
)
def test_pettingzoo_smoke_conformance_for_each_plan_and_parameter_extreme(
    parameters: dict[str, Any],
) -> None:
    env = make_env(parameters)
    _api_test_tolerating_1211(env)
    env.close()


def _assert_text_leaves(space: spaces.Space[Any], value: Any) -> None:
    if isinstance(space, spaces.Text):
        assert space.contains(value)
    elif isinstance(space, spaces.Dict):
        for key, child in space.spaces.items():
            _assert_text_leaves(child, value[key])
    elif isinstance(space, spaces.Tuple):
        for child, item in zip(space.spaces, value, strict=True):
            _assert_text_leaves(child, item)
    elif isinstance(space, spaces.Sequence):
        for item in value:
            _assert_text_leaves(space.feature_space, item)


def test_text_observation_fields_obey_the_declared_charset_and_json_round_trip() -> None:
    env = make_env(_parameters(terrain=True, wasteland=True, capture_zones=3))
    env.reset(seed=0)
    observation, *_ = env.last()
    # Verify the observation dict keys match the TypedDicts, catching drift between the runtime
    # shape and the annotations in observation_types.py.
    assert set(observation) == set(SkirmishObservation.__annotations__)
    state = observation["observation"]
    assert set(state) == set(SkirmishObservationData.__annotations__)
    strings = [state["self"]["unit_id"], state["self"]["type"], state["parameters"]["seat_plan"]]
    strings.extend(unit[field] for unit in state["visible_units"] for field in ("unit_id", "side", "type"))
    strings.extend(
        entry[field] for roster in state["rosters"].values() for entry in roster for field in entry
    )
    strings.extend(tile[field] for row in state["battlefield"]["tiles"] for tile in row for field in tile)
    assert all(value and set(value) <= set("abcdefghijklmnopqrstuvwxyz0123456789_") for value in strings)
    assert json.loads(json.dumps(state, allow_nan=False))
    unit_id_space = env.observation_space(env.agent_selection)["observation"]["self"]["unit_id"]
    assert isinstance(unit_id_space, spaces.Text)
    assert unit_id_space.contains("red_footman_0")
    assert not unit_id_space.contains("")
    assert not unit_id_space.contains("Red-footman")
    for player in env.possible_agents:
        emitted = env.observe(player)
        _assert_text_leaves(env.observation_space(player), emitted)
    env.close()


def test_metadata_chat_policy_and_factory_bounds_match_the_stage_contract() -> None:
    assert META.renderer == "crane-reach-field"
    assert META.messaging is True
    assert META.builtin_agents[0].name == "naive"
    env = make_env(_parameters())
    env.reset(seed=0)
    assert env.chat_policy("player_0")["default_recipient"] is None
    assert env.chat_policy("player_0")["target_recipients"] == ("player_1", "player_2")
    env.close()
    for name, value in (
        ("capture_target", 9),
        ("capture_target", 10_001),
        ("round_cap", 99),
        ("round_cap", 10_001),
    ):
        parameters = _parameters()
        parameters[name] = value
        with pytest.raises(ValueError):
            make_env(parameters)


@pytest.mark.parametrize(
    ("seat_plan", "overrides"),
    (("skirmish", {"field_extent": 5, "round_cap": 100}), ("army", {"field_extent": 22, "round_cap": 100})),
)
def test_full_naive_episodes_keep_observations_masks_and_json_safe(
    seat_plan: str, overrides: dict[str, Any]
) -> None:
    env = make_env(_parameters(seat_plan=seat_plan, **overrides))
    env.reset(seed=19)
    agents = {player: Agent() for player in env.possible_agents}
    for agent in agents.values():
        agent.reset(19)

    while env.agents:
        observation, _reward, terminated, truncated, _info = env.last()
        assert env.observation_space(env.agent_selection).contains(observation)
        assert action_mask_problems(env.action_space(env.agent_selection), observation["action_mask"]) == []
        assert observation["action_mask"]["path"][0] == 1
        assert observation["action_mask"]["target"][0] == 1
        _assert_text_leaves(env.observation_space(env.agent_selection), observation)
        assert json.loads(json.dumps(observation, default=json_default, allow_nan=False))
        assert json.loads(json.dumps(extract_overlay(env), allow_nan=False))
        action = None if terminated or truncated else agents[env.agent_selection].act(observation)
        if action is not None:
            assert env.action_space(env.agent_selection).contains(action)
            assert observation["action_mask"]["path"][action["path"]] == 1
            assert observation["action_mask"]["target"][action["target"]] == 1
        env.step(action)

    env.close()


def test_capture_state_is_all_zero_when_capture_play_is_disabled() -> None:
    env = make_env(_parameters(capture_zones=0))
    env.reset(seed=0)
    observation, *_ = env.last()
    assert observation["observation"]["capture"] == {"red": 0, "blue": 0, "target": 0}
    assert decode_overlay(extract_overlay(env))["capture"] == {"red": 0, "blue": 0, "target": 0}
    env.close()


def test_default_action_is_legal_and_harness_reports_complete_team_scores() -> None:
    parameters = _parameters(round_cap=100)
    env = make_env(parameters)
    env.reset(seed=3)
    action = default_action(env, env.agent_selection)
    assert env.action_space(env.agent_selection).contains(action)
    assert action == {"path": 0, "target": 0}
    env.close()

    result = run_episode(
        ENTRY,
        _naive_players(6),
        parameters=parameters,
        seed=3,
    )
    assert result.reason in (REASON_TERMINATED, REASON_TRUNCATED)
    assert result.scores.keys() == {f"player_{player}" for player in range(6)}
    assert all(0.0 <= score <= 100.0 for score in result.scores.values())


def test_staged_builtin_naive_agent_plays_a_full_legal_skirmish() -> None:
    """The session image's copied baseline loads and finishes a normal six-unit game."""
    players = {
        f"player_{index}": AgentPlayer(load_agent(BUILTIN_SKIRMISH_CRANE_NAIVE_AGENT_DIR))
        for index in range(6)
    }
    result = run_episode(ENTRY, players, parameters=_parameters(), seed=4)
    assert result.reason in (REASON_TERMINATED, REASON_TRUNCATED)
    assert result.ticks > 0


def test_staged_builtin_naive_agent_matches_the_package_copy() -> None:
    """The package copy drives fixtures while the image copy runs sessions, so they must not drift."""
    package_copy = Path(inspect.getfile(skirmish_crane.naive)).read_bytes()
    staged_copy = (BUILTIN_SKIRMISH_CRANE_NAIVE_AGENT_DIR / "agent.py").read_bytes()
    assert package_copy == staged_copy, (
        "environments/skirmish_crane/naive.py and the staged builtin agent.py have diverged; "
        "copy the package version into backend/images/session-base/deps-v1/builtin/skirmish_crane/naive/"
    )


def test_overlay_is_deterministic_for_a_seeded_scripted_rollout() -> None:
    def rollout() -> list[dict[str, Any]]:
        env = make_env(_parameters(round_cap=100, terrain=True, wasteland=True, capture_zones=2))
        env.reset(seed=11)
        states = []
        for observation in _turns(env, 18):
            states.append(extract_overlay(env))
            assert env.action_space(env.agent_selection).contains(_legal_action(observation))
        env.close()
        return states

    assert rollout() == rollout()


def test_naive_actions_follow_the_published_masks_and_never_name_targets() -> None:
    env = make_env(_parameters(round_cap=100))
    agent = Agent()
    agent.reset(7)
    env.reset(seed=7)

    for observation in _turns(env, 24):
        action = agent.act(observation)
        mask = observation["action_mask"]
        assert mask["path"][action["path"]] == 1
        assert mask["target"][action["target"]] == 1
        assert action["target"] == 0

    env.close()


def test_masked_actions_are_accepted_and_masked_out_components_are_rejected() -> None:
    env = make_env(_parameters())
    env.reset(seed=5)
    observation, *_ = env.last()
    action = _legal_action(observation)
    env.step(action)
    env.close()

    probe = make_env(_parameters())
    probe.reset(seed=5)
    observation, *_ = probe.last()
    legal_paths = np.flatnonzero(observation["action_mask"]["path"])[1:4]
    probe.close()
    for path in legal_paths:
        env = make_env(_parameters())
        env.reset(seed=5)
        env.step({"path": int(path), "target": 0})
        env.close()

    for component in ("path", "target"):
        env = make_env(_parameters())
        env.reset(seed=5)
        observation, *_ = env.last()
        forbidden = next(
            index for index, allowed in enumerate(observation["action_mask"][component]) if not allowed
        )
        action = _legal_action(observation)
        action[component] = forbidden
        with pytest.raises(IllegalMoveError):
            env.step(action)
        env.close()


def test_early_death_gets_a_dead_step_and_the_final_score_map_is_complete() -> None:
    env = make_env(_parameters())
    env.reset(seed=0)
    killer = Unit("red_archer_0", "red", "archer", (7, 7), 6)
    victim = Unit("blue_footman_0", "blue", "footman", (8, 7), 1)
    survivor = Unit("blue_archer_0", "blue", "archer", (0, 7), 6)
    env.match.units = {killer.unit_id: killer, victim.unit_id: victim, survivor.unit_id: survivor}
    env.match.starting_hit_points = {"red": 6, "blue": 7}
    env.match.activation_order = [killer.unit_id, victim.unit_id, survivor.unit_id]
    env.match.activation_index = 0
    env.agent_selection = env.agent_by_unit[killer.unit_id]

    env.step({"path": 0, "target": 1})
    dead_player = env.agent_by_unit[victim.unit_id]
    assert env.terminations[dead_player]
    assert env.agent_selection == dead_player
    env.step(None)
    assert dead_player not in env.agents
    env.match.result = Result(100.0, 0.0, "red", "elimination")
    assert set(env.result_scores() or ()) == set(env.possible_agents)
    env.close()


def test_round_cap_is_reported_as_a_harness_truncation() -> None:
    parameters = _parameters(round_cap=100)
    players = {f"player_{index}": AgentPlayer(StandStillAgent()) for index in range(6)}
    result = run_episode(ENTRY, players, parameters=parameters, seed=19)
    assert result.reason == REASON_TRUNCATED
    assert len(result.scores) == 6


@pytest.mark.parametrize("seat_plan", ("skirmish", "army"))
def test_seeded_harness_recordings_are_identical(seat_plan: str, tmp_path: Any) -> None:
    parameters = _parameters(seat_plan=seat_plan, round_cap=100)
    count = 6 if seat_plan == "skirmish" else 40
    recordings: list[list[dict[str, Any]]] = []
    ticks = 0
    for recording_id in ("first", "second"):
        store = FolderRecordingStore(tmp_path)
        players = {f"player_{index}": AgentPlayer(StandStillAgent()) for index in range(count)}
        result = run_episode(
            ENTRY,
            players,
            parameters=parameters,
            seed=23,
            store=store,
            recording_id=recording_id,
            player_attribution=_attribution(players),
            clock=ManualClock(),
        )
        ticks = result.ticks
        lines = [
            json.loads(line)
            for line in (tmp_path / recording_id / "recording.jsonl").read_text().splitlines()
        ]
        for line in lines:
            line.pop("created_at", None)
            line.pop("timing", None)
            for agent in line.get("agents", {}).values():
                agent.pop("timing", None)
        recordings.append(lines)
    assert recordings[0] == recordings[1]
    transcript = replay_jsonl(tmp_path / "first" / "recording.jsonl")
    assert transcript.count("round ") == ticks


def test_ascii_runner_replays_a_harness_jsonl_recording(tmp_path: Any) -> None:
    parameters = _parameters(round_cap=100)
    players = {f"player_{index}": AgentPlayer(StandStillAgent()) for index in range(6)}
    run_episode(
        ENTRY,
        players,
        parameters=parameters,
        seed=23,
        store=FolderRecordingStore(tmp_path),
        recording_id="ascii",
        player_attribution=_attribution(players),
        max_steps=3,
    )
    transcript = replay_jsonl(tmp_path / "ascii" / "recording.jsonl")
    assert transcript.count("round 1") == 3
    assert "red=0 blue=0" in transcript


def test_compact_overlay_decodes_every_state_field() -> None:
    env = make_env(
        _parameters(
            seat_plan="army",
            field_extent=10,
            terrain=True,
            wasteland=True,
            unit_abilities=True,
            capture_zones=3,
        )
    )
    env.reset(seed=4)
    compact = extract_overlay(env)
    decoded = decode_overlay(compact)

    assert compact["k"] == OVERLAY_VERSION
    # The full variant exercises every wire code the renderer has to read back.
    assert any(tile["feature"] == "waste" for row in decoded["battlefield"]["tiles"] for tile in row)
    assert all(len(row) == env.match.battlefield.side for row in compact["b"]["t"])
    assert all(len(zone) == 4 for zone in compact["b"]["z"])
    assert all(len(unit) == 7 for unit in compact["u"])
    assert decoded["battlefield"]["side"] == env.match.battlefield.side
    assert decoded["battlefield"]["tiles"] == [
        [{"terrain": tile.terrain, "feature": tile.feature} for tile in row]
        for row in env.match.battlefield.tiles
    ]
    assert decoded["battlefield"]["zones"] == [
        {
            "center": {"q": zone.center[0], "r": zone.center[1]},
            "tiles": [{"q": q, "r": r} for q, r in zone.tiles],
        }
        for zone in env.match.battlefield.zones
    ]
    decoded_units = {unit["unit_id"]: unit for unit in decoded["units"]}
    for unit_id, unit in env.match.units.items():
        assert decoded_units[unit_id]["player"] == env.agent_by_unit[unit_id]
        assert decoded_units[unit_id]["side"] == unit.side
        assert decoded_units[unit_id]["type"] == unit.kind
        assert decoded_units[unit_id]["position"] == {"q": unit.position[0], "r": unit.position[1]}
        assert decoded_units[unit_id]["hit_points"] == unit.hit_points
        expected_visible = tuple(
            visible.unit_id for visible in visible_units(unit, env.match.units, env.match.battlefield)
        )
        assert decoded["visible_units"][env.agent_by_unit[unit_id]] == expected_visible
    current = env.match.current_unit_id
    assert current is not None
    assert decoded["current_activation"] == env.agent_by_unit[current]
    assert decoded["event"] is None
    assert decoded["terminal"] is False
    assert decoded["outcome"] is None
    env.close()


def test_compact_overlay_decodes_event_capture_death_and_terminal_outcome() -> None:
    env = make_env(_parameters())
    env.reset(seed=2)
    actor_id = "red_archer_0"
    target_id = "blue_footman_0"
    target = env.match.units.pop(target_id)
    start = (7, 7)
    end = (8, 8)
    env.last_activation = Activation(
        actor_id,
        start,
        end,
        Strike(actor_id, target_id, 2, True),
        target_id,
        (2, 3),
    )
    env.last_capture_changes = {"red": 1, "blue": 0}
    env.match.result = Result(100.0, 0.0, "red", "elimination")

    compact = extract_overlay(env)
    assert compact["e"] == [
        1,
        start[0],
        start[1],
        end[0],
        end[1],
        3,
        2,
        True,
        3,
        1,
        0,
        encode_path((2, 3)),
    ]
    decoded = decode_overlay(compact)
    assert target.unit_id not in {unit["unit_id"] for unit in decoded["units"]}
    assert decoded["current_activation"] is None
    assert decoded["event"] == {
        "unit_id": actor_id,
        "from": {"q": start[0], "r": start[1]},
        "to": {"q": end[0], "r": end[1]},
        "path": (2, 3),
        "attack": {"target_id": target_id, "damage": 2, "automatic": True},
        "death": target_id,
        "capture": {"red": 1, "blue": 0},
    }
    assert decoded["terminal"] is True
    assert decoded["outcome"] == [100.0, 0.0]
    env.close()


def test_compact_overlay_rejects_unknown_versions() -> None:
    env = make_env(_parameters())
    env.reset(seed=0)
    compact = extract_overlay(env)
    compact["k"] = OVERLAY_VERSION + 1
    with pytest.raises(ValueError, match="unsupported version"):
        decode_overlay(compact)
    env.close()


def test_compact_overlay_version_one_event_remains_compatible() -> None:
    env = make_env(_parameters())
    env.reset(seed=2)
    actor_id = "red_archer_0"
    actor = env.match.units[actor_id]
    env.last_activation = Activation(actor_id, actor.position, actor.position, None, None, (2,))
    compact = extract_overlay(env)
    compact["k"] = 1
    compact["e"] = compact["e"][:11]

    assert decode_overlay(compact)["event"]["path"] is None
    env.close()


def test_compact_overlay_rejects_a_malformed_version_two_path_id() -> None:
    env = make_env(_parameters())
    env.reset(seed=2)
    actor_id = "red_archer_0"
    actor = env.match.units[actor_id]
    env.last_activation = Activation(actor_id, actor.position, actor.position, None, None, (2,))
    compact = extract_overlay(env)
    compact["e"][11] = MAX_PATH_ID + 1

    with pytest.raises(ValueError, match="path id"):
        decode_overlay(compact)
    env.close()


def test_compact_overlay_rejects_a_version_two_path_endpoint_mismatch() -> None:
    env = make_env(_parameters())
    env.reset(seed=2)
    actor_id = "red_archer_0"
    env.last_activation = Activation(actor_id, (7, 7), (7, 7), None, None, (2,))
    compact = extract_overlay(env)

    with pytest.raises(ValueError, match="does not reach its endpoint"):
        decode_overlay(compact)
    env.close()


def test_compact_overlay_rejects_event_coordinates_outside_the_field() -> None:
    env = make_env(_parameters())
    env.reset(seed=2)
    actor_id = "red_archer_0"
    env.last_activation = Activation(actor_id, (0, 0), (0, 0), None, None, ())
    compact = extract_overlay(env)

    with pytest.raises(ValueError, match="coordinates are outside the battlefield"):
        decode_overlay(compact)
    env.close()


def test_compact_overlay_rejects_a_version_two_path_that_leaves_the_field() -> None:
    env = make_env(_parameters())
    env.reset(seed=2)
    actor_id = "red_archer_0"
    env.last_activation = Activation(actor_id, (0, 7), (0, 7), None, None, (5,))
    compact = extract_overlay(env)

    with pytest.raises(ValueError, match="leaves the battlefield"):
        decode_overlay(compact)
    env.close()


def test_full_army_recording_stays_under_ten_megabytes(tmp_path: Any) -> None:
    parameters = _parameters(
        seat_plan="army", field_extent=10, terrain=True, unit_abilities=True, capture_zones=3, round_cap=150
    )
    store = FolderRecordingStore(tmp_path)
    players = {f"player_{index}": AgentPlayer(RetreatAgent()) for index in range(40)}
    result = run_episode(
        ENTRY,
        players,
        parameters=parameters,
        seed=4,
        store=store,
        recording_id="army",
        player_attribution=_attribution(players),
        clock=ManualClock(),
    )
    assert result.ticks == 6000
    assert (tmp_path / "army" / "recording.jsonl").stat().st_size <= 10 * 1024 * 1024


def test_season_presets_match_the_published_schedule():
    expected = (
        (
            "season_1",
            "Season 1: The Skirmish",
            {
                "seat_plan": "skirmish",
                "field_extent": 7,
                "terrain": False,
                "wasteland": False,
                "unit_abilities": False,
                "capture_zones": 0,
            },
        ),
        (
            "season_2",
            "Season 2: The March",
            {
                "seat_plan": "skirmish",
                "field_extent": 7,
                "terrain": True,
                "wasteland": False,
                "unit_abilities": False,
                "capture_zones": 0,
            },
        ),
        (
            "season_3",
            "Season 3: The Army",
            {
                "seat_plan": "army",
                "field_extent": 10,
                "terrain": True,
                "wasteland": False,
                "unit_abilities": True,
                "capture_zones": 0,
            },
        ),
        (
            "season_4",
            "Season 4: The Commander",
            {
                "seat_plan": "army",
                "field_extent": 10,
                "terrain": True,
                "wasteland": False,
                "unit_abilities": True,
                "capture_zones": 1,
            },
        ),
        (
            "season_5",
            "Season 5: The General",
            {
                "seat_plan": "army",
                "field_extent": 10,
                "terrain": True,
                "wasteland": False,
                "unit_abilities": True,
                "capture_zones": 3,
            },
        ),
        (
            "season_6",
            "Season 6: The Rivals",
            {
                "seat_plan": "army",
                "field_extent": 10,
                "terrain": True,
                "wasteland": True,
                "unit_abilities": True,
                "capture_zones": 3,
            },
        ),
    )
    assert (
        tuple(
            (
                preset.name,
                preset.title,
                {
                    name: resolve_parameters(META, preset.values)[name]
                    for name in (
                        "seat_plan",
                        "field_extent",
                        "terrain",
                        "wasteland",
                        "unit_abilities",
                        "capture_zones",
                    )
                },
            )
            for preset in META.presets
        )
        == expected
    )


@pytest.mark.parametrize("preset", META.presets, ids=lambda preset: preset.name)
def test_every_season_preset_resolves_to_a_valid_environment(preset: EnvPreset) -> None:
    parameters = resolve_parameters(META, preset.values)
    assert parameters["capture_target"] == 200
    assert parameters["round_cap"] == 1000
    assert parameters["wasteland"] is (preset.name == "season_6")
    env = make_env(parameters)
    env.reset(seed=0)
    env.close()


def _synthetic_observation(
    position: tuple[int, int], paths: tuple[int, ...], visible: list[dict[str, Any]]
) -> dict[str, Any]:
    return {
        "observation": {
            "self": {"unit_id": "red_footman_0", "position": {"q": position[0], "r": position[1]}},
            "visible_units": visible,
            "battlefield": {"side": 11},
            "rosters": {"red": ({"unit_id": "red_footman_0", "side": "red"},), "blue": ()},
        },
        "action_mask": {
            "path": np.array([int(index in paths) for index in range(1555)]),
            "target": np.array([1]),
        },
    }


def test_naive_pursues_unseen_goals_and_visible_enemies_without_naming_targets() -> None:
    agent = Agent()
    agent.reset(1)
    unseen = _synthetic_observation((3, 3), (0, encode_path((2,))), [])
    unseen_action = agent.act(unseen)
    assert len(decode_path(unseen_action["path"])) == 1
    assert unseen_action["target"] == 0

    visible = _synthetic_observation(
        (3, 3),
        (0, encode_path((1,)), encode_path((2,))),
        [{"side": "blue", "position": {"q": 6, "r": 3}}],
    )
    visible_action = agent.act(visible)
    assert _distance(_end((3, 3), visible_action["path"]), (6, 3)) < _distance((3, 3), (6, 3))
    assert visible_action["target"] == 0


def test_naive_is_seeded_and_different_seeds_diverge_when_choices_tie() -> None:
    observation = _synthetic_observation((3, 3), (0, encode_path((2,)), encode_path((3,))), [])

    def choices(seed: int) -> list[dict[str, int]]:
        agent = Agent()
        agent.reset(seed)
        return [agent.act(observation) for _ in range(16)]

    assert choices(8) == choices(8)
    assert choices(8) != choices(9)


def test_naive_standalone_path_decoder_matches_the_package_codec() -> None:
    assert all(_decode_path(path_id) == decode_path(path_id) for path_id in range(MAX_PATH_ID + 1))


def test_naive_loads_as_a_standalone_builtin_module() -> None:
    path = Path(__file__).parents[1] / "naive.py"
    spec = importlib.util.spec_from_file_location("skirmish_crane_naive_builtin", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    agent = module.Agent()
    agent.reset(1)


def test_template_crane_helper_never_drifts_from_the_package_codec() -> None:
    # The student template's sandbox/crane.py deliberately duplicates the path codec so a student
    # never imports the engine. Loading it standalone here, the way a composed template does,
    # pins that its copy never drifts from the real one.
    path = Path(__file__).parents[1] / "template" / "sandbox" / "crane.py"
    spec = importlib.util.spec_from_file_location("skirmish_crane_template_crane_builtin", path)
    assert spec is not None and spec.loader is not None
    crane = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(crane)

    assert crane.DIRECTIONS == DIRECTIONS
    assert crane.MAX_PATH_ID == MAX_PATH_ID
    assert crane.MAX_PATH_STEPS == MAX_PATH_STEPS
    for path_id in range(MAX_PATH_ID + 1):
        digits = crane.decode_path(path_id)
        assert digits == decode_path(path_id)
        assert crane.encode_path(digits) == path_id
        assert encode_path(digits) == path_id

    # The happy path above would still pass if the template copy dropped a guard clause, so pin
    # the invalid-value rejections against both codecs too.
    for invalid_directions in ([0], [7], [1, 1, 1, 1, 1], (True,)):
        with pytest.raises(ValueError):
            crane.encode_path(invalid_directions)
        with pytest.raises(ValueError):
            encode_path(invalid_directions)

    for invalid_path_id in (-1, 1555, True, "3"):
        with pytest.raises(ValueError):
            crane.decode_path(invalid_path_id)
        with pytest.raises(ValueError):
            decode_path(invalid_path_id)


def _load_standalone_module(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class _RecordingAgent:
    """Wrap one starter agent instance and record every action its act() returns."""

    def __init__(self, agent: Any, actions: list[dict[str, int]]) -> None:
        self._agent = agent
        self._actions = actions

    def reset(self, seed: int) -> None:
        self._agent.reset(seed)

    def act(self, observation: Any) -> dict[str, int]:
        action = self._agent.act(observation)
        self._actions.append(action)
        return action


def test_template_starter_agent_marches_and_names_targets_over_a_full_episode() -> None:
    """Load the student starter standalone, under fabricated sandbox modules, the way a composed
    template sees it, then run six separately constructed copies through a full match. This is the
    only test that actually exercises both of its branches: marching blind toward the mirrored
    spawn tile with no enemy visible, and stepping at a nameable enemy once one is."""
    package_dir = Path(__file__).parents[1]
    template_dir = package_dir / "template"
    fabricated_names = ("sandbox", "sandbox.observation_types", "sandbox.crane")
    saved_modules = {name: sys.modules.get(name) for name in fabricated_names}
    try:
        sandbox_pkg = types.ModuleType("sandbox")
        sandbox_pkg.__path__ = []
        sys.modules["sandbox"] = sandbox_pkg
        sandbox_pkg.observation_types = _load_standalone_module(
            "sandbox.observation_types", package_dir / "observation_types.py"
        )
        sandbox_pkg.crane = _load_standalone_module("sandbox.crane", template_dir / "sandbox" / "crane.py")
        starter = _load_standalone_module("skirmish_crane_template_agent_builtin", template_dir / "agent.py")

        actions: list[dict[str, int]] = []
        players = {
            f"player_{index}": AgentPlayer(_RecordingAgent(starter.Agent(), actions)) for index in range(6)
        }
        result = run_episode(ENTRY, players, parameters=resolve_parameters(ENTRY.meta), seed=0)
    finally:
        sys.modules.pop("skirmish_crane_template_agent_builtin", None)
        for name, module in saved_modules.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    # Elimination, not the round cap: measured at 40-46 ticks across several seeds, so 500 is a
    # generous ceiling that still fails loudly if the starter regresses into stalling.
    assert result.reason == REASON_TERMINATED
    assert result.ticks < 500
    assert any(action["path"] != 0 for action in actions)
    assert any(action["target"] != 0 for action in actions)
