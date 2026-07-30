"""Direct checks for the unregistered three-player ParallelEnv test fixture."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import replace

import pytest
from pettingzoo.test import parallel_api_test
from support_parallel import ThreePlayerParallelEnv, default_action, extract_overlay, make_entry

from game_sandbox_harness.environment import (
    EnvironmentContractError,
    discover_environments,
    resolve_parameters,
    validate_parallel_reset,
    validate_parallel_step,
)
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import AgentPlayer, Episode, ExternalPlayer, NoopSource

FIXTURE_META = make_entry().meta
ALL_PLAYERS = ["player_0", "player_1", "player_2"]


def _json_bytes(value: object) -> str:
    return json.dumps(value, allow_nan=False, sort_keys=True, separators=(",", ":"))


@pytest.fixture
def env() -> Iterator[ThreePlayerParallelEnv]:
    """Hand out a fresh fixture environment and close it however the test ends."""
    fixture_env = ThreePlayerParallelEnv()
    try:
        yield fixture_env
    finally:
        fixture_env.close()


def test_fixture_passes_pettingzoo_parallel_api_test(env: ThreePlayerParallelEnv):
    parallel_api_test(env, num_cycles=4)


def test_fixture_is_not_a_registered_environment():
    assert "three_player_parallel_test" not in discover_environments()


def test_fixture_has_deterministic_joint_actions_departures_and_json_overlay(
    env: ThreePlayerParallelEnv,
):
    observations, _ = env.reset(seed=17)
    assert observations == {
        "player_0": {"joint_action": 0, "tick": 0},
        "player_1": {"joint_action": 0, "tick": 0},
        "player_2": {"joint_action": 0, "tick": 0},
    }
    assert extract_overlay(env) == {
        "active_players": ["player_0", "player_1", "player_2"],
        "joint_action": 0,
        "last_actions": {},
        "tick": 0,
    }
    assert default_action(env, "player_1") == 0

    observations, rewards, terminated, truncated, _ = env.step({"player_0": 1, "player_1": 2, "player_2": 0})
    assert observations == {
        "player_0": {"joint_action": 3, "tick": 1},
        "player_1": {"joint_action": 3, "tick": 1},
        "player_2": {"joint_action": 3, "tick": 1},
    }
    assert rewards == {"player_0": 3.0, "player_1": 3.0, "player_2": 3.0}
    assert terminated == {"player_0": True, "player_1": False, "player_2": False}
    assert truncated == {"player_0": False, "player_1": False, "player_2": False}
    assert _json_bytes(extract_overlay(env)) == (
        '{"active_players":["player_1","player_2"],"joint_action":3,'
        '"last_actions":{"player_0":1,"player_1":2,"player_2":0},"tick":1}'
    )
    assert env.chat_policy("player_1") == {
        "target_recipients": ["player_2"],
        "default_recipient": "player_2",
    }
    with pytest.raises(ValueError, match="inactive"):
        env.chat_policy("player_0")

    _, rewards, terminated, truncated, _ = env.step({"player_1": 2, "player_2": 1})
    assert rewards == {"player_1": 3.0, "player_2": 3.0}
    assert terminated == {"player_1": False, "player_2": False}
    assert truncated == {"player_1": True, "player_2": False}
    assert env.agents == ["player_2"]


def test_parallel_episode_start_uses_reset_agents_for_messaging_policy():
    entry = make_entry(messaging=True)
    with Episode(
        entry,
        {player: ExternalPlayer(NoopSource()) for player in entry.meta.human_players},
        parameters=resolve_parameters(entry.meta),
        seed=1,
    ) as episode:
        assert episode.external_chat_sender is None


def test_episode_rejects_a_declared_sequential_factory_returning_parallel():
    class ClosingParallel(ThreePlayerParallelEnv):
        def __init__(self) -> None:
            super().__init__()
            self.closed = False

        def close(self) -> None:
            self.closed = True

    made: list[ClosingParallel] = []
    received: list[dict[str, object]] = []
    entry = replace(
        make_entry(stepping="sequential"),
        make=lambda parameters: (
            received.append(dict(parameters)) or made.append(ClosingParallel()) or made[-1]
        ),
    )
    with pytest.raises(EnvironmentContractError, match="reset leaves out AEC"):
        Episode(
            entry,
            {player: ExternalPlayer(NoopSource()) for player in entry.meta.human_players},
            parameters=resolve_parameters(entry.meta),
            seed=1,
        ).start()
    assert made[0].closed is True
    assert received == [{"players": 3}]


def test_parallel_contract_failure_closes_before_recording_or_participant_reset(tmp_path):
    class AecShaped:
        def __init__(self) -> None:
            self.closed = False
            self.possible_agents = ALL_PLAYERS[:]

        def reset(self, seed=None, options=None):
            self.agents = self.possible_agents[:]
            self.rewards = {player: 0.0 for player in self.possible_agents}
            self.terminations = {player: False for player in self.possible_agents}
            self.truncations = {player: False for player in self.possible_agents}
            self.agent_selection = "player_0"
            return None

        def last(self):
            return None, 0.0, False, False, {}

        def step(self, action):
            pass

        def close(self) -> None:
            self.closed = True

    class ResetMarker:
        reset_called = False

        def reset(self, seed: int) -> None:
            self.reset_called = True

        def act(self, observation):
            return 0

    made: list[AecShaped] = []
    marker = ResetMarker()
    entry = make_entry(lambda: made.append(AecShaped()) or made[-1])
    players = {
        "player_0": AgentPlayer(marker),
        "player_1": ExternalPlayer(NoopSource()),
        "player_2": ExternalPlayer(NoopSource()),
    }
    with pytest.raises(EnvironmentContractError, match="reset.*observations and infos"):
        Episode(
            entry,
            players,
            parameters=resolve_parameters(entry.meta),
            seed=1,
            store=FolderRecordingStore(tmp_path),
            recording_id="contract-failure",
        ).start()
    assert made[0].closed is True
    assert marker.reset_called is False
    assert not (tmp_path / "contract-failure").exists()


@pytest.mark.parametrize(
    "agents",
    [
        ["player_1", "player_0", "player_2"],
        ["player_0", "player_1"],
        ["player_0", "player_1", "player_2", "player_3"],
    ],
)
def test_parallel_reset_rejects_reordered_missing_and_new_active_players(
    env: ThreePlayerParallelEnv, agents: list[str]
):
    observations, infos = env.reset(seed=1)
    env.agents = agents
    with pytest.raises(EnvironmentContractError):
        validate_parallel_reset(FIXTURE_META, env, ALL_PLAYERS, (observations, infos))


def test_parallel_reset_rejects_possible_agents_that_disagree_with_resolved_layout(
    env: ThreePlayerParallelEnv,
):
    observations, infos = env.reset(seed=1)
    env.possible_agents = ["player_0", "player_2", "player_1"]
    with pytest.raises(EnvironmentContractError, match="possible_agents"):
        validate_parallel_reset(FIXTURE_META, env, ALL_PLAYERS, (observations, infos))


@pytest.mark.parametrize("mapping_index", [0, 1])
@pytest.mark.parametrize("mutation", ["missing", "extra", "reordered"])
def test_parallel_reset_rejects_every_observation_and_info_key_failure(
    env: ThreePlayerParallelEnv, mapping_index: int, mutation: str
):
    observations, infos = env.reset(seed=1)
    mappings = [observations, infos]
    mapping = dict(mappings[mapping_index])
    if mutation == "missing":
        mapping.pop("player_2")
    elif mutation == "extra":
        mapping["player_3"] = {}
    else:
        mapping = {"player_1": mapping["player_1"], **mapping}
    mappings[mapping_index] = mapping
    with pytest.raises(EnvironmentContractError):
        validate_parallel_reset(FIXTURE_META, env, ALL_PLAYERS, (mappings[0], mappings[1]))


@pytest.mark.parametrize("mapping_index", range(5))
@pytest.mark.parametrize("mutation", ["missing", "extra"])
def test_parallel_step_rejects_missing_and_extra_keys_in_every_return_mapping(
    env: ThreePlayerParallelEnv, mapping_index: int, mutation: str
):
    env.reset(seed=1)
    actions = {player: 0 for player in ALL_PLAYERS}
    result = env.step(actions)
    mappings = [dict(mapping) for mapping in result]
    if mutation == "missing":
        mappings[mapping_index].pop("player_2")
    else:
        mappings[mapping_index]["player_3"] = {}
    with pytest.raises(EnvironmentContractError):
        validate_parallel_step(FIXTURE_META, env, ALL_PLAYERS, actions, tuple(mappings))


@pytest.mark.parametrize(
    "actions",
    [
        {"player_0": 0, "player_1": 0},
        {"player_0": 0, "player_1": 0, "player_2": 0, "player_3": 0},
    ],
)
def test_parallel_step_rejects_missing_and_extra_action_keys(
    env: ThreePlayerParallelEnv, actions: dict[str, int]
):
    env.reset(seed=1)
    result = env.step({player: 0 for player in ALL_PLAYERS})
    with pytest.raises(EnvironmentContractError):
        validate_parallel_step(FIXTURE_META, env, ALL_PLAYERS, actions, result)


def test_parallel_step_rejects_a_duplicated_pre_step_active_player(env: ThreePlayerParallelEnv):
    env.reset(seed=1)
    actions = {player: 0 for player in ALL_PLAYERS}
    result = env.step(actions)
    with pytest.raises(EnvironmentContractError, match="actions"):
        validate_parallel_step(FIXTURE_META, env, ["player_0", *ALL_PLAYERS], actions, result)


def test_parallel_step_accepts_reordered_action_and_return_mappings(env: ThreePlayerParallelEnv):
    env.reset(seed=1)
    actions = {"player_2": 0, "player_0": 0, "player_1": 0}
    result = env.step(actions)
    reordered_result = tuple(dict(reversed(list(mapping.items()))) for mapping in result)

    validate_parallel_step(FIXTURE_META, env, ALL_PLAYERS, actions, reordered_result)


@pytest.mark.parametrize(
    "agents",
    [
        ["player_0", "player_1", "player_2"],
        ["player_1", "player_2", "player_3"],
        ["player_2", "player_1"],
    ],
)
def test_parallel_step_rejects_revival_new_players_and_terminal_flag_conflicts(
    env: ThreePlayerParallelEnv, agents: list[str]
):
    env.reset(seed=1)
    actions = {player: 0 for player in ALL_PLAYERS}
    result = env.step(actions)
    env.agents = agents
    with pytest.raises(EnvironmentContractError):
        validate_parallel_step(FIXTURE_META, env, ALL_PLAYERS, actions, result)
