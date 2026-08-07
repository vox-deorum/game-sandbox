"""Direct checks for the unregistered three-player ParallelEnv test fixture."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import replace

import pytest
from pettingzoo.test import parallel_api_test
from support_parallel import ThreePlayerParallelEnv, default_action, extract_overlay, make_entry

from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import (
    EnvironmentContractError,
    discover_environments,
    resolve_parameters,
    validate_parallel_reset,
    validate_parallel_step,
)
from game_sandbox_harness.live import run_live_loop
from game_sandbox_harness.live_io import PausableClock, SessionControl
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import (
    REASON_EPISODE_LIMIT,
    REASON_TERMINATED,
    REASON_TRUNCATED,
    AgentPlayer,
    Episode,
    ExternalPlayer,
    IllegalAgentActionError,
    NoopSource,
    ScriptedSource,
    run_episode,
)

FIXTURE_META = make_entry().meta
ALL_PLAYERS = ["player_0", "player_1", "player_2"]


class NoopSleeper:
    def sleep_ms(self, ms: int) -> None: ...


def _agent_attribution() -> dict[str, dict[str, str]]:
    return {
        player: {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"} for player in ALL_PLAYERS
    }


class TraceAgent:
    """Small reusable parallel participant with observable action, chat, and learning phases."""

    def __init__(
        self,
        player_id: str,
        *,
        action: int = 0,
        clock: ManualClock | None = None,
        decision_cost: int = 0,
        chat_cost: int = 0,
        learn_cost: int = 0,
        outgoing: list[dict[str, object]] | None = None,
        log: list[tuple[object, ...]] | None = None,
    ) -> None:
        self.player_id = player_id
        self.action = action
        self.clock = clock
        self.decision_cost = decision_cost
        self.chat_cost = chat_cost
        self.learn_cost = learn_cost
        self.outgoing = outgoing or []
        self.log = log if log is not None else []

    def reset(self, seed: int) -> None: ...

    def act(self, observation: object) -> int:
        self.log.append(("act", self.player_id, observation))
        if self.clock is not None:
            self.clock.advance(self.decision_cost)
        return self.action

    def chat(self, inbox: list[dict[str, object]]) -> list[dict[str, object]]:
        self.log.append(("chat", self.player_id, list(inbox)))
        if self.clock is not None:
            self.clock.advance(self.chat_cost)
        return self.outgoing

    def learn(self, observation: object, action: int, reward: float, terminated: bool) -> None:
        self.log.append(("learn", self.player_id, observation, action, reward, terminated))
        if self.clock is not None:
            self.clock.advance(self.learn_cost)


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


def test_parallel_opening_state_exposes_the_reset_overlay_before_the_first_tick():
    entry = make_entry(messaging=True)
    with Episode(
        entry,
        {player: ExternalPlayer(NoopSource()) for player in entry.meta.human_players},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        external_chat_player="player_0",
        clock=ManualClock(100),
    ) as episode:
        assert episode.opening_state() == {
            "schema_version": 1,
            "tick": 0,
            "agents": {},
            "overlay": {
                "active_players": ALL_PLAYERS,
                "joint_action": 0,
                "last_actions": {},
                "tick": 0,
            },
            "chat_options": {
                "sender": "player_0",
                "target_recipients": ["player_1", "player_2"],
                "default_recipient": "player_1",
            },
            "timing": {"started_at": 100, "duration_ms": 0},
        }


def test_parallel_opening_state_exists_even_without_overlay_or_chat_options():
    entry = replace(make_entry(), overlay=None)
    with Episode(
        entry,
        {player: ExternalPlayer(NoopSource()) for player in entry.meta.human_players},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=ManualClock(100),
    ) as episode:
        assert episode.opening_state() == {
            "schema_version": 1,
            "tick": 0,
            "agents": {},
            "timing": {"started_at": 100, "duration_ms": 0},
        }


def test_parallel_external_actions_are_consumed_before_agent_action_hooks():
    entry = make_entry()
    selected: list[str] = []

    class MarkingSource:
        def get_action(self, player_id: str, observation: object, window_ms: int | None) -> int:
            selected.append(player_id)
            return 0

    class CheckingAgent:
        def reset(self, seed: int) -> None: ...

        def act(self, observation: object) -> int:
            assert selected == ["player_1", "player_2"]
            return 0

    with Episode(
        entry,
        {
            "player_0": AgentPlayer(CheckingAgent()),
            "player_1": ExternalPlayer(MarkingSource()),
            "player_2": ExternalPlayer(MarkingSource()),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
    ) as episode:
        episode.advance()


def test_headless_live_loop_advances_simultaneous_episodes_without_a_pace_interval():
    entry = make_entry()
    base = ManualClock()
    clock = PausableClock(base)
    with Episode(
        entry,
        {player: ExternalPlayer(NoopSource()) for player in entry.meta.human_players},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=clock,
    ) as episode:
        control = SessionControl(clock)
        run_live_loop(
            episode,
            pace_interval_ms=None,
            control=control,
            clock=clock,
            sleeper=NoopSleeper(),
        )
        assert episode.result().ticks == 3


def test_headless_simultaneous_loop_honors_pause_until_resume():
    created: list[ThreePlayerParallelEnv] = []

    def make_paused_env() -> ThreePlayerParallelEnv:
        env = ThreePlayerParallelEnv()
        created.append(env)
        return env

    entry = make_entry(make_paused_env)
    base = ManualClock()
    clock = PausableClock(base)
    control = SessionControl(clock)
    control.pause()

    class ResumeOnThirdSleep:
        def __init__(self) -> None:
            self.calls = 0

        def sleep_ms(self, ms: int) -> None:
            self.calls += 1
            assert created[0]._tick == 0
            if self.calls == 3:
                control.resume()

    sleeper = ResumeOnThirdSleep()
    with Episode(
        entry,
        {player: ExternalPlayer(NoopSource()) for player in entry.meta.human_players},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=clock,
    ) as episode:
        run_live_loop(
            episode,
            pace_interval_ms=None,
            control=control,
            clock=clock,
            sleeper=sleeper,
        )

    assert sleeper.calls == 3
    assert created[0]._tick == 3


def test_run_episode_dispatches_parallel_ticks_and_records_all_active_players(tmp_path):
    entry = make_entry()
    result = run_episode(
        entry,
        {
            "player_0": ExternalPlayer(ScriptedSource([1])),
            "player_1": ExternalPlayer(ScriptedSource([2, 2])),
            "player_2": ExternalPlayer(ScriptedSource([0, 1, 0])),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=FolderRecordingStore(tmp_path),
        recording_id="parallel",
    )

    assert result.ticks == 3
    assert result.reason == REASON_TRUNCATED
    assert result.scores == {"player_0": 3.0, "player_1": 6.0, "player_2": 6.0}
    states = list(FolderRecordingStore(tmp_path).open("parallel").steps())
    assert [list(state["agents"]) for state in states] == [
        ["player_0", "player_1", "player_2"],
        ["player_1", "player_2"],
        ["player_2"],
    ]
    assert states[0]["agents"] == {
        "player_0": {"action": 1, "reward": 3.0, "score": 3.0},
        "player_1": {"action": 2, "reward": 3.0, "score": 3.0},
        "player_2": {"action": 0, "reward": 3.0, "score": 3.0},
    }
    assert states[1]["agents"]["player_1"]["score"] == 6.0
    assert states[2]["agents"]["player_2"]["score"] == 6.0


def test_parallel_tick_snapshots_observations_times_each_hook_and_defaults_only_the_slow_player(tmp_path):
    clock = ManualClock()
    log: list[tuple[object, ...]] = []
    entry = replace(make_entry(messaging=True), meta=replace(FIXTURE_META, step_limit_ms=5, messaging=True))
    agents = {
        "player_0": TraceAgent(
            "player_0", action=1, clock=clock, decision_cost=10, chat_cost=2, learn_cost=3, log=log
        ),
        "player_1": TraceAgent(
            "player_1", action=2, clock=clock, decision_cost=1, chat_cost=2, learn_cost=3, log=log
        ),
        "player_2": TraceAgent(
            "player_2", action=1, clock=clock, decision_cost=1, chat_cost=2, learn_cost=3, log=log
        ),
    }
    with Episode(
        entry,
        {player: AgentPlayer(agent) for player, agent in agents.items()},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=clock,
        store=FolderRecordingStore(tmp_path),
        recording_id="timed",
        player_attribution=_agent_attribution(),
    ) as episode:
        episode.advance()
        assert episode.result().step_timeouts == {"player_0": 1, "player_1": 1, "player_2": 1}

    acts = [event for event in log if event[0] == "act"]
    assert [(event[1], event[2]) for event in acts] == [
        ("player_0", {"joint_action": 0, "tick": 0}),
        ("player_1", {"joint_action": 0, "tick": 0}),
        ("player_2", {"joint_action": 0, "tick": 0}),
    ]
    state = next(FolderRecordingStore(tmp_path).open("timed").steps())
    assert {player: step["action"] for player, step in state["agents"].items()} == {
        "player_0": 0,
        "player_1": 2,
        "player_2": 1,
    }
    assert state["agents"]["player_0"]["timing"] == {
        "decision_ms": 10,
        "chat_ms": 2,
        "learn_ms": 3,
    }
    assert state["agents"]["player_1"]["timing"] == {
        "decision_ms": 1,
        "chat_ms": 2,
        "learn_ms": 3,
    }


def test_parallel_illegal_agent_action_aborts_before_the_joint_environment_step():
    called = False

    class SpyEnv(ThreePlayerParallelEnv):
        def step(self, actions):
            nonlocal called
            called = True
            return super().step(actions)

    entry = replace(make_entry(), make=lambda _parameters: SpyEnv())
    with Episode(
        entry,
        {
            "player_0": AgentPlayer(TraceAgent("player_0", action=9)),
            "player_1": AgentPlayer(TraceAgent("player_1")),
            "player_2": AgentPlayer(TraceAgent("player_2")),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
    ) as episode:
        with pytest.raises(IllegalAgentActionError, match="player_0"):
            episode.advance()
        assert episode.failed_player == "player_0"
    assert called is False


def test_parallel_chat_delivers_a_boundary_batch_only_to_the_next_tick_and_cleans_departures():
    log: list[tuple[object, ...]] = []
    entry = make_entry(messaging=True)
    agents = {
        "player_0": TraceAgent("player_0", log=log),
        "player_1": TraceAgent("player_1", log=log, outgoing=[{"to": "player_2", "text": "next"}]),
        "player_2": TraceAgent("player_2", log=log),
    }
    with Episode(
        entry,
        {player: AgentPlayer(agent) for player, agent in agents.items()},
        parameters=resolve_parameters(entry.meta),
        seed=1,
    ) as episode:
        episode.advance()
        assert [event for event in log if event[0] == "chat"] == [
            ("chat", "player_0", []),
            ("chat", "player_1", []),
            ("chat", "player_2", []),
        ]
        episode.advance()

    chats = [event for event in log if event[0] == "chat"]
    assert chats[-2:] == [
        ("chat", "player_1", []),
        (
            "chat",
            "player_2",
            [{"from": "player_1", "to": "player_2", "text": "next", "tick": 0}],
        ),
    ]
    assert all(event[1] != "player_0" for event in chats[3:])


def test_parallel_terminal_learning_runs_once_and_result_keeps_the_departed_players_reward():
    log: list[tuple[object, ...]] = []
    entry = make_entry()
    with Episode(
        entry,
        {player: AgentPlayer(TraceAgent(player, action=1, log=log)) for player in ALL_PLAYERS},
        parameters=resolve_parameters(entry.meta),
        seed=1,
    ) as episode:
        episode.advance()
        hooks_after_departure = len(log)
        episode.advance()
        result = episode.result()

    p0_learns = [event for event in log if event[:2] == ("learn", "player_0")]
    assert p0_learns == [("learn", "player_0", {"joint_action": 0, "tick": 0}, 1, 3.0, True)]
    assert all(event[1] != "player_0" for event in log[hooks_after_departure:])
    assert result.scores["player_0"] == 3.0


def test_parallel_simultaneous_budget_overruns_choose_the_first_canonical_player_after_recording(tmp_path):
    clock = ManualClock()
    entry = replace(make_entry(), meta=replace(FIXTURE_META, episode_limit_ms=5))
    with Episode(
        entry,
        {player: AgentPlayer(TraceAgent(player, clock=clock, decision_cost=10)) for player in ALL_PLAYERS},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=clock,
        store=FolderRecordingStore(tmp_path),
        recording_id="budget",
        player_attribution=_agent_attribution(),
    ) as episode:
        episode.advance()
        assert episode.result().reason == REASON_EPISODE_LIMIT
        assert episode.result().failed_player == "player_0"
    assert len(list(FolderRecordingStore(tmp_path).open("budget").steps())) == 1


def test_parallel_natural_ending_wins_over_a_coincident_cap_and_active_cap_truncates():
    class AllTerminateEnv(ThreePlayerParallelEnv):
        def step(self, actions):
            observations, rewards, _terminations, _truncations, infos = super().step(actions)
            terminations = {player: True for player in actions}
            truncations = {player: False for player in actions}
            self.agents = []
            return observations, rewards, terminations, truncations, infos

    natural = replace(make_entry(), make=lambda _parameters: AllTerminateEnv())
    result = run_episode(
        natural,
        {player: ExternalPlayer(NoopSource()) for player in ALL_PLAYERS},
        parameters=resolve_parameters(natural.meta),
        seed=1,
        max_steps=1,
    )
    assert result.reason == REASON_TERMINATED

    active_cap = make_entry()
    result = run_episode(
        active_cap,
        {player: ExternalPlayer(NoopSource()) for player in ALL_PLAYERS},
        parameters=resolve_parameters(active_cap.meta),
        seed=1,
        max_steps=1,
    )
    assert result.reason == REASON_TRUNCATED


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
