"""The session loop, as the exit criteria made executable, all on ManualClock.

A small deterministic fake AEC env keeps these tests independent of the environments package:
it advances a counter, hands out integer observations, and terminates after N steps. Only the
AEC surface ``run_episode`` actually uses is implemented.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from gymnasium.spaces import Discrete

from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import (
    BuiltinAgent,
    EnvironmentEntry,
    EnvironmentMeta,
    EnvParameter,
    EnvParameterValueError,
    PlayerBounds,
    resolve_parameters,
)
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import (
    AgentPlayer,
    Episode,
    ExternalPlayer,
    IllegalAgentActionError,
    NoopSource,
    ScriptedSource,
    run_episode,
)

DEFAULT_ACTION = -1


class FakeEnv:
    """A one-player AEC env that lives for ``n_steps`` and rewards 1.0 per step."""

    def __init__(self, n_steps: int) -> None:
        self._n = n_steps
        self.possible_agents = ["player_0"]

    def reset(self, seed: int | None = None, options: Any = None) -> None:
        self.seed = seed
        self.agents = ["player_0"]
        self.agent_selection = "player_0"
        self.rewards = {"player_0": 0.0}
        self.terminations = {"player_0": False}
        self.truncations = {"player_0": False}
        self._i = 0
        self._obs = 0

    def last(self) -> tuple[Any, float, bool, bool, dict[str, Any]]:
        a = self.agent_selection
        return self._obs, self.rewards[a], self.terminations[a], self.truncations[a], {}

    def observe(self, agent: str) -> Any:
        return self._obs

    def step(self, action: Any) -> None:
        a = self.agent_selection
        if self.terminations[a] or self.truncations[a]:
            self.agents.remove(a)
            return
        self.last_action = action
        self.rewards[a] = 1.0
        self._i += 1
        self._obs = self._i
        if self._i >= self._n:
            self.terminations[a] = True


class FakeResultEnv(FakeEnv):
    """A fake env that reports a final score only after its natural terminal transition."""

    def result_scores(self) -> dict[str, float] | None:
        return {"player_0": 99.0} if self._i >= self._n else None


class ProbedResultEnv(FakeEnv):
    """A result-hook fixture that can prove call timing and validation behavior."""

    def __init__(self, n_steps: int, reported: object) -> None:
        super().__init__(n_steps)
        self.reported = reported
        self.result_calls = 0

    def result_scores(self) -> object:
        self.result_calls += 1
        return self.reported


class CloseClearsResultEnv(FakeResultEnv):
    """Clear the state the score hook needs when the environment closes."""

    closed = False

    def close(self) -> None:
        self.closed = True
        self._i = 0


def make_entry(
    n_steps: int = 3,
    *,
    pace_interval_ms: int | None = None,
    human_timeout_ms: int | None = None,
    step_limit_ms: int = 1000,
    episode_limit_ms: int = 120_000,
    with_overlay: bool = False,
) -> EnvironmentEntry:
    meta = EnvironmentMeta(
        env_id="fake",
        display_name="Fake",
        description="A deterministic fake.",
        stepping="sequential",
        builtin_agents=(BuiltinAgent("naive", "Naive agent"),),
        layout=PlayerBounds(1, 1),
        human_players=("player_0",),
        human_timeout_ms=human_timeout_ms,
        recommended_episode_ticks=n_steps,
        pace_interval_ms=pace_interval_ms,
        step_limit_ms=step_limit_ms,
        episode_limit_ms=episode_limit_ms,
        messaging=False,
        message_cap=None,
        llm=False,
        renderer="fake",
    )
    overlay = (lambda env: {"i": env._i}) if with_overlay else None
    return EnvironmentEntry(
        meta=meta,
        make=lambda _parameters: FakeEnv(n_steps),
        default_action=lambda env, player_id: DEFAULT_ACTION,
        overlay=overlay,
    )


class ScriptedAgent:
    """Replays fixed actions; optionally advances a clock to simulate slowness."""

    def __init__(self, actions: list[int], clock: ManualClock | None = None, cost_ms: int = 0):
        self._actions = actions
        self._clock = clock
        self._cost = cost_ms

    def reset(self, seed: int, observation: Any) -> None:
        self._i = 0

    def act(self, observation: Any) -> int:
        if self._clock is not None and self._cost:
            self._clock.advance(self._cost)
        action = self._actions[self._i % len(self._actions)]
        self._i += 1
        return action


def test_same_seed_same_agent_byte_identical_recordings(tmp_path: Path):
    entry = make_entry(n_steps=4, with_overlay=True)

    def run(root: Path) -> bytes:
        run_episode(
            entry,
            {"player_0": AgentPlayer(ScriptedAgent([0, 1, 0, 1]))},
            parameters=resolve_parameters(entry.meta),
            seed=99,
            store=FolderRecordingStore(root),
            recording_id="r",
            clock=ManualClock(100),
            player_attribution={
                "player_0": {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}
            },
        )
        return (root / "r" / "recording.jsonl").read_bytes()

    a, b = run(tmp_path / "a"), run(tmp_path / "b")
    assert a == b
    states = [json.loads(line) for line in a.splitlines()[1:]]
    assert [(state["tick"], state["agents"], state["timing"], state["overlay"]) for state in states] == [
        (
            0,
            {"player_0": {"action": 0, "reward": 1.0, "score": 1.0, "timing": {"decision_ms": 0}}},
            {"started_at": 100, "duration_ms": 0},
            {"i": 1},
        ),
        (
            1,
            {"player_0": {"action": 1, "reward": 1.0, "score": 2.0, "timing": {"decision_ms": 0}}},
            {"started_at": 100, "duration_ms": 0},
            {"i": 2},
        ),
        (
            2,
            {"player_0": {"action": 0, "reward": 1.0, "score": 3.0, "timing": {"decision_ms": 0}}},
            {"started_at": 100, "duration_ms": 0},
            {"i": 3},
        ),
        (
            3,
            {"player_0": {"action": 1, "reward": 1.0, "score": 4.0, "timing": {"decision_ms": 0}}},
            {"started_at": 100, "duration_ms": 0},
            {"i": 4},
        ),
    ]


def test_players_attribution_lands_in_the_recording_header(tmp_path: Path):
    entry = make_entry(n_steps=2)
    store = FolderRecordingStore(tmp_path)
    run_episode(
        entry,
        {"player_0": AgentPlayer(ScriptedAgent([0, 1]))},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
        player_attribution={
            "player_0": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            }
        },
    )
    lines = (tmp_path / "r" / "recording.jsonl").read_text(encoding="utf-8").splitlines()
    header = json.loads(lines[0])
    assert header["players"] == {
        "player_0": {
            "kind": "agent",
            "builtin_name": "naive",
            "label": "Naive agent",
        }
    }
    assert header["parameters"] == {"players": 1}
    assert header["seats"] == {"seat_0": ["player_0"]}
    assert header["seat_plan"] == "solo"


def test_static_overlay_hook_runs_once_after_reset_without_changing_opening_state(tmp_path: Path):
    hook_calls: list[int] = []

    def overlay_static(env: FakeEnv) -> dict[str, Any]:
        hook_calls.append(env._i)
        return {"sprites": {"bird": "blue"}}

    entry = replace(make_entry(n_steps=2, with_overlay=True), overlay_static=overlay_static)
    store = FolderRecordingStore(tmp_path)
    with Episode(
        entry,
        {"player_0": AgentPlayer(ScriptedAgent([0]))},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        player_attribution={
            "player_0": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            }
        },
    ) as episode:
        opening = episode.opening_state()

    assert hook_calls == [0]
    assert opening is not None
    assert opening["overlay"] == {"i": 0}
    header = json.loads((tmp_path / "r" / "recording.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert header["overlay_static"] == {"sprites": {"bird": "blue"}}


@pytest.mark.parametrize(
    ("pace", "with_overlay", "expected"),
    [
        (
            None,
            True,
            {
                "schema_version": 1,
                "tick": 0,
                "agents": {},
                "timing": {"started_at": 0, "duration_ms": 0},
                "overlay": {"i": 0},
            },
        ),
        (16, True, None),
        (None, False, None),
    ],
)
def test_opening_state_returns_the_dealt_overlay_for_a_turn_based_env(pace, with_overlay, expected):
    entry = make_entry(pace_interval_ms=pace, with_overlay=with_overlay)
    with Episode(
        entry,
        {"player_0": AgentPlayer(ScriptedAgent([0]))},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=ManualClock(0),
    ) as episode:
        assert episode.opening_state() == expected


@pytest.mark.parametrize(
    ("cost", "override", "applied", "timeouts"),
    [(1000, None, 1, 0), (5000, None, -1, 3), (1200, 1500, 1, 0), (600, 500, -1, 3)],
)
def test_agent_per_step_timeout_discards_action_and_counts_overage(
    tmp_path: Path, cost, override, applied, timeouts
):
    clock = ManualClock()
    entry = make_entry(n_steps=3, step_limit_ms=1000)
    store = FolderRecordingStore(tmp_path)
    result = run_episode(
        entry,
        {"player_0": AgentPlayer(ScriptedAgent([1], clock=clock, cost_ms=cost))},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=clock,
        step_limit_ms=override,
        store=store,
        recording_id="r",
        player_attribution={"player_0": {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}},
    )
    steps = [state["agents"]["player_0"] for state in store.open("r").steps()]
    assert [step["action"] for step in steps] == [applied, applied, applied]
    assert [step["timing"] for step in steps] == [{"decision_ms": cost}] * 3
    assert result.step_timeouts == {"player_0": timeouts}
    assert result.reason == "terminated"
    assert result.failed_player is None


@pytest.mark.parametrize(
    ("learn_ms", "step_limit", "episode_limit", "length", "reason", "timeouts"),
    [
        (250, 300, 120_000, 3, "terminated", 3),
        (200, 300, 120_000, 3, "terminated", 0),
        (300, 1000, 1000, 10, "episode_limit", 0),
    ],
)
def test_learn_hook_time_counts_toward_per_step_overage(
    tmp_path: Path, learn_ms, step_limit, episode_limit, length, reason, timeouts
):
    clock = ManualClock()
    entry = make_entry(n_steps=length, step_limit_ms=step_limit, episode_limit_ms=episode_limit)

    class LearningAgent:
        def reset(self, seed: int, observation: Any) -> None: ...

        def act(self, observation: Any) -> int:
            clock.advance(100)
            return 0

        def learn(self, observation, action, reward, terminated) -> None:
            clock.advance(learn_ms)

    store = FolderRecordingStore(tmp_path)
    result = run_episode(
        entry,
        {"player_0": AgentPlayer(LearningAgent())},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=clock,
        store=store,
        recording_id="r",
        player_attribution={"player_0": {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}},
    )
    steps = [state["agents"]["player_0"] for state in store.open("r").steps()]
    assert [step["action"] for step in steps] == [0, 0, 0]
    assert [step["timing"] for step in steps] == [{"decision_ms": 100, "learn_ms": learn_ms}] * 3
    assert result.ticks == 3
    assert result.reason == reason
    assert result.step_timeouts == {"player_0": timeouts}
    assert result.failed_player == ("player_0" if reason == "episode_limit" else None)


def test_per_episode_budget_truncates():
    clock = ManualClock()
    # Each act costs 800ms (under the 1000ms step limit) but the cumulative budget is 2000ms.
    entry = make_entry(n_steps=10, step_limit_ms=1000, episode_limit_ms=2000)
    agent = ScriptedAgent([0], clock=clock, cost_ms=800)
    result = run_episode(
        entry,
        {"player_0": AgentPlayer(agent)},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=clock,
    )
    assert result.reason == "episode_limit"
    assert result.ticks == 3  # 800*3 = 2400 > 2000, tripped on the third step
    # The player that overran owns the overage, so it is named for per-player failure attribution.
    assert result.failed_player == "player_0"


@pytest.mark.parametrize(
    ("environment_timeout", "override", "expected_window"),
    [(None, None, None), (700, None, 700), (700, 200, 200)],
)
def test_external_scripted_source_drives_player(
    tmp_path: Path, environment_timeout, override, expected_window
):
    clock = ManualClock()
    entry = make_entry(n_steps=3, human_timeout_ms=environment_timeout, step_limit_ms=1, episode_limit_ms=1)
    seen: list[tuple[str, Any, int | None]] = []

    class Source(ScriptedSource):
        def get_action(self, player_id: str, observation: Any, window_ms: int | None) -> Any:
            seen.append((player_id, observation, window_ms))
            clock.advance(5)
            return super().get_action(player_id, observation, window_ms)

    store = FolderRecordingStore(tmp_path)
    result = run_episode(
        entry,
        {"player_0": ExternalPlayer(Source([0, 1]), timeout_ms=override)},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=clock,
        store=store,
        recording_id="r",
    )
    assert seen == [
        ("player_0", 0, expected_window),
        ("player_0", 1, expected_window),
        ("player_0", 2, expected_window),
    ]
    assert [state["agents"]["player_0"]["action"] for state in store.open("r").steps()] == [0, 1, -1]
    assert result.ticks == 3
    assert result.step_timeouts == {"player_0": 0}
    assert result.failed_player is None


def test_default_action_receives_live_env_and_player_and_records_result(tmp_path: Path):
    seen: list[str] = []

    def provider(env: Any, player_id: str) -> int:
        seen.append(player_id)
        return 100 + env._i

    entry = replace(make_entry(n_steps=2), default_action=provider)
    store = FolderRecordingStore(tmp_path)
    result = run_episode(
        entry,
        {"player_0": ExternalPlayer(NoopSource())},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
    )
    assert seen == ["player_0", "player_0"]
    assert [state["agents"]["player_0"]["action"] for state in store.open("r").steps()] == [100, 101]
    assert result.step_timeouts == {"player_0": 0}


@pytest.mark.parametrize(
    ("length", "cap", "ticks", "score", "reason"),
    [(100, 5, 5, 5.0, "truncated"), (3, 3, 3, 3.0, "terminated")],
)
def test_max_steps_caps_episode(length, cap, ticks, score, reason):
    entry = make_entry(n_steps=length)
    result = run_episode(
        entry,
        {"player_0": AgentPlayer(ScriptedAgent([0]))},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=ManualClock(),
        max_steps=cap,
    )
    assert (result.ticks, result.scores, result.reason) == (ticks, {"player_0": score}, reason)


class FakeTeamEnv:
    """A 3-player turn-based AEC env that pays every player a final reward on the last actor's step.

    This mirrors how Hearts settles: rewards stay 0 while players take turns, then on the final
    actor's step every player is assigned its terminal reward at once and all players terminate.
    The non-final players are then collected through AEC dead-steps. It exists to prove the loop
    credits all players' terminal rewards, not only the acting one.
    """

    def __init__(self, finals: dict[str, float]) -> None:
        self._finals = finals
        self.possible_agents = ["player_0", "player_1", "player_2"]

    def reset(self, seed: int | None = None, options: Any = None) -> None:
        self.agents = list(self.possible_agents)
        self._idx = 0
        self.agent_selection = self.agents[0]
        self.rewards = {a: 0.0 for a in self.agents}
        self.terminations = {a: False for a in self.agents}
        self.truncations = {a: False for a in self.agents}

    def last(self) -> tuple[Any, float, bool, bool, dict[str, Any]]:
        a = self.agent_selection
        return 0, self.rewards[a], self.terminations[a], self.truncations[a], {}

    def observe(self, agent: str) -> Any:
        return 0

    def step(self, action: Any) -> None:
        a = self.agent_selection
        if self.terminations[a] or self.truncations[a]:
            # Dead-step: collect the terminated player (PettingZoo would also _clear_rewards here,
            # which is exactly why a non-final player's terminal reward must be read earlier).
            self.agents.remove(a)
            self.rewards = {x: 0.0 for x in self.agents}
            if self.agents:
                self.agent_selection = self.agents[0]
            return
        self._idx += 1
        if self._idx >= len(self.possible_agents):
            # Final actor: pay out every player at once and terminate all of them.
            self.rewards = dict(self._finals)
            self.terminations = {x: True for x in self.possible_agents}
            self.agent_selection = self.possible_agents[0]
        else:
            self.rewards = {x: 0.0 for x in self.possible_agents}
            self.agent_selection = self.possible_agents[self._idx]


def _team_entry(finals: dict[str, float], *, make: Any = None) -> EnvironmentEntry:
    meta = EnvironmentMeta(
        env_id="team",
        display_name="Team",
        description="A deterministic 3-player fake with a terminal payout.",
        stepping="sequential",
        builtin_agents=(BuiltinAgent("naive", "Naive agent"),),
        layout=PlayerBounds(3, 3),
        human_players=("player_0", "player_1", "player_2"),
        human_timeout_ms=None,
        recommended_episode_ticks=3,
        pace_interval_ms=None,
        step_limit_ms=1000,
        episode_limit_ms=120_000,
        messaging=False,
        message_cap=None,
        llm=False,
        renderer="team",
        seat_order_matters=True,
    )
    return EnvironmentEntry(
        meta=meta,
        make=make if make is not None else (lambda _parameters: FakeTeamEnv(finals)),
        default_action=lambda env, player_id: DEFAULT_ACTION,
        overlay=None,
    )


def test_complete_result_scores_are_cached_before_environment_close():
    env = CloseClearsResultEnv(1)
    entry = replace(make_entry(n_steps=1), make=lambda _parameters: env)
    result = run_episode(
        entry,
        {"player_0": ExternalPlayer(ScriptedSource([0]))},
        parameters=resolve_parameters(entry.meta),
        seed=1,
    )
    assert env.closed is True
    assert result.scores == {"player_0": 99.0}


def test_partial_episode_does_not_consult_an_early_non_none_result_hook():
    env = ProbedResultEnv(3, {"player_0": 99.0})
    entry = replace(make_entry(), make=lambda _parameters: env)
    result = run_episode(
        entry,
        {"player_0": ExternalPlayer(ScriptedSource([0]))},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        max_steps=1,
    )
    assert env.result_calls == 0
    assert result.scores == {"player_0": 1.0}


def test_max_steps_on_the_natural_terminal_transition_keeps_complete_result_scores():
    env = ProbedResultEnv(1, {"player_0": 99.0})
    entry = replace(make_entry(n_steps=1), make=lambda _parameters: env)
    result = run_episode(
        entry,
        {"player_0": ExternalPlayer(ScriptedSource([0]))},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        max_steps=1,
    )
    assert env.result_calls == 1
    assert env.agents == []
    assert result.reason == "terminated"
    assert result.scores == {"player_0": 99.0}


def test_stopped_episode_does_not_consult_an_early_non_none_result_hook():
    env = ProbedResultEnv(3, {"player_0": 99.0})
    entry = replace(make_entry(), make=lambda _parameters: env)
    episode = Episode(
        entry,
        {"player_0": ExternalPlayer(ScriptedSource([0]))},
        parameters=resolve_parameters(entry.meta),
        seed=1,
    )
    with episode:
        episode.stop()
    assert env.result_calls == 0
    assert episode.result().scores == {"player_0": 0.0}


@pytest.mark.parametrize(
    ("reported", "error"),
    (
        ([99.0], TypeError),
        ({"wrong_player": 99.0}, ValueError),
        ({"player_0": True}, TypeError),
        ({"player_0": "99"}, TypeError),
        ({"player_0": float("nan")}, ValueError),
        ({"player_0": float("inf")}, ValueError),
    ),
)
def test_complete_result_scores_reject_malformed_reports(reported: object, error: type[Exception]):
    env = ProbedResultEnv(1, reported)
    entry = replace(make_entry(n_steps=1), make=lambda _parameters: env)
    with pytest.raises(error):
        run_episode(
            entry,
            {"player_0": ExternalPlayer(ScriptedSource([0]))},
            parameters=resolve_parameters(entry.meta),
            seed=1,
        )
    assert env.result_calls == 1


def test_aec_terminal_rewards_record_nonacting_players_without_synthetic_actions(tmp_path: Path):
    entry = _team_entry({"player_0": -13.0, "player_1": -3.0, "player_2": 0.0})
    store = FolderRecordingStore(tmp_path)
    result = run_episode(
        entry,
        {player: ExternalPlayer(ScriptedSource([0])) for player in ("player_0", "player_1", "player_2")},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=ManualClock(),
        store=store,
        recording_id="team",
    )
    states = list(store.open("team").steps())
    assert [state["tick"] for state in states] == [0, 1, 2]
    assert states[-1]["agents"] == {
        "player_2": {"action": 0, "reward": 0.0, "score": 0.0},
        "player_0": {"reward": -13.0, "score": -13.0},
        "player_1": {"reward": -3.0, "score": -3.0},
    }
    assert result.scores == {"player_0": -13.0, "player_1": -3.0, "player_2": 0.0}
    assert result.reason == "terminated"
    assert result.failed_player is None


class EarlyDepartureEnv:
    """Two-player AEC fixture where player_1 truncates before its first action."""

    possible_agents = ["player_0", "player_1"]

    def reset(self, seed: int | None = None, options: Any = None) -> None:
        self.agents = self.possible_agents[:]
        self.agent_selection = "player_0"
        self.rewards = {player: 0.0 for player in self.agents}
        self.terminations = {player: False for player in self.agents}
        self.truncations = {player: False for player in self.agents}
        self._first = True

    def last(self) -> tuple[int, float, bool, bool, dict[str, object]]:
        player = self.agent_selection
        return 0, self.rewards[player], self.terminations[player], self.truncations[player], {}

    def observe(self, player: str) -> int:
        return 0

    def step(self, action: object) -> None:
        player = self.agent_selection
        if self.terminations[player] or self.truncations[player]:
            self.agents.remove(player)
            self.rewards = {agent: 0.0 for agent in self.agents}
            if self.agents:
                self.agent_selection = self.agents[0]
            return
        if self._first:
            self._first = False
            self.rewards = {"player_0": 0.0, "player_1": 4.0}
            self.truncations["player_1"] = True
            self.agent_selection = "player_1"
            return
        self.rewards = {"player_0": 1.0}
        self.terminations["player_0"] = True


def _early_departure_entry() -> EnvironmentEntry:
    return EnvironmentEntry(
        meta=EnvironmentMeta(
            env_id="early-departure",
            display_name="Early departure",
            description="An AEC lifecycle fixture.",
            stepping="sequential",
            builtin_agents=(BuiltinAgent("naive", "Naive agent"),),
            layout=PlayerBounds(2, 2),
            human_players=("player_0", "player_1"),
            human_timeout_ms=None,
            recommended_episode_ticks=2,
            pace_interval_ms=None,
            step_limit_ms=1000,
            episode_limit_ms=120_000,
            messaging=False,
            message_cap=None,
            llm=False,
            renderer="early-departure",
        ),
        make=lambda _parameters: EarlyDepartureEnv(),
        default_action=lambda _env, _player: 0,
    )


def test_aec_individual_departure_records_reward_only_and_skips_every_later_hook(tmp_path: Path):
    calls: list[tuple[str, str]] = []

    class Agent:
        def __init__(self, player: str) -> None:
            self.player = player

        def reset(self, seed: int, observation: Any) -> None: ...

        def act(self, observation: int) -> int:
            calls.append((self.player, "act"))
            return 0

        def learn(self, observation: int, action: int, reward: float, terminated: bool) -> None:
            calls.append((self.player, "learn"))

    entry = _early_departure_entry()
    result = run_episode(
        entry,
        {"player_0": AgentPlayer(Agent("player_0")), "player_1": AgentPlayer(Agent("player_1"))},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=FolderRecordingStore(tmp_path),
        recording_id="early",
        player_attribution={
            player: {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}
            for player in ("player_0", "player_1")
        },
    )

    states = list(FolderRecordingStore(tmp_path).open("early").steps())
    assert [state["tick"] for state in states] == [0, 1]
    assert [list(state["agents"]) for state in states] == [["player_0", "player_1"], ["player_0"]]
    assert states[0]["agents"]["player_1"] == {"reward": 4.0, "score": 4.0}
    assert calls == [("player_0", "act"), ("player_0", "learn"), ("player_0", "act"), ("player_0", "learn")]
    assert result.reason == "truncated"
    assert result.scores == {"player_0": 1.0, "player_1": 4.0}


class MaskedEnv:
    """A 2-player AEC env that exposes a Discrete action space and a per-step ``action_mask``, the way
    Hearts does, and rejects an illegal card from ``step`` (its ``IllegalMoveError`` analogue).

    Legal moves are the masked-1 indices. ``step`` raises on a masked-0 or out-of-range action, so a
    loop that skipped the action boundary would let that raise smear the failure across the table.
    ``raise_on_legal`` makes ``step`` raise on an otherwise-legal action too, to model a genuine
    environment fault that the boundary must leave unowned. ``mask_in_info`` publishes the mask in the
    ``info`` dict instead of the observation, the way Shimmy's OpenSpiel wrapper does.
    """

    def __init__(
        self,
        *,
        n: int = 4,
        legal: tuple[int, ...] = (0, 1),
        raise_on_legal: int | None = None,
        mask_in_info: bool = False,
    ) -> None:
        self.possible_agents = ["player_0", "player_1"]
        self._n = n
        self._legal = set(legal)
        self._raise_on_legal = raise_on_legal
        self._mask_in_info = mask_in_info

    def action_space(self, agent: str) -> Discrete:
        return Discrete(self._n)

    def reset(self, seed: int | None = None, options: Any = None) -> None:
        self.agents = list(self.possible_agents)
        self._idx = 0
        self.agent_selection = self.agents[0]
        self.rewards = {a: 0.0 for a in self.agents}
        self.terminations = {a: False for a in self.agents}
        self.truncations = {a: False for a in self.agents}

    def _mask(self) -> list[int]:
        return [1 if i in self._legal else 0 for i in range(self._n)]

    def last(self) -> tuple[Any, float, bool, bool, dict[str, Any]]:
        a = self.agent_selection
        info = {"action_mask": self._mask()} if self._mask_in_info else {}
        return self.observe(a), self.rewards[a], self.terminations[a], self.truncations[a], info

    def observe(self, agent: str) -> dict[str, Any]:
        if self._mask_in_info:
            return {"observation": 0}
        return {"observation": 0, "action_mask": self._mask()}

    def step(self, action: Any) -> None:
        a = self.agent_selection
        if self.terminations[a] or self.truncations[a]:
            self.agents.remove(a)
            if self.agents:
                self.agent_selection = self.agents[0]
            return
        if action not in self._legal or action == self._raise_on_legal:
            raise ValueError(f"env rejects illegal action {action!r}")
        self._idx += 1
        self.rewards = {x: 0.0 for x in self.possible_agents}
        if self._idx >= len(self.possible_agents):
            self.terminations = {x: True for x in self.possible_agents}
            self.agent_selection = self.possible_agents[0]
        else:
            self.agent_selection = self.possible_agents[self._idx]


def _masked_entry(**kwargs: Any) -> EnvironmentEntry:
    meta = EnvironmentMeta(
        env_id="masked",
        display_name="Masked",
        description="A 2-player fake with an action mask and illegal-move rejection.",
        stepping="sequential",
        builtin_agents=(BuiltinAgent("naive", "Naive agent"),),
        layout=PlayerBounds(2, 2),
        human_players=("player_0", "player_1"),
        human_timeout_ms=None,
        recommended_episode_ticks=2,
        pace_interval_ms=None,
        step_limit_ms=1000,
        episode_limit_ms=120_000,
        messaging=False,
        message_cap=None,
        llm=False,
        renderer="masked",
        seat_order_matters=True,
    )
    return EnvironmentEntry(
        meta=meta,
        make=lambda _parameters: MaskedEnv(**kwargs),
        default_action=lambda env, player_id: 0,  # a legal move on every timeout path
        overlay=None,
    )


@pytest.mark.parametrize(
    ("in_info", "legal", "first_action", "second_action", "prior_steps", "failed", "diagnostic"),
    [
        (False, (0, 1), 0, 2, 1, "player_1", "legal-move mask"),
        (True, (0, 1), 0, 2, 1, "player_1", "legal-move mask"),
        (False, (0, 1, 2, 3), 9, 0, 0, "player_0", "action space"),
    ],
)
def test_illegal_masked_action_is_charged_to_the_acting_player(
    in_info, legal, first_action, second_action, prior_steps, failed, diagnostic
):
    entry = _masked_entry(legal=legal, mask_in_info=in_info)
    with Episode(
        entry,
        {
            "player_0": AgentPlayer(ScriptedAgent([first_action])),
            "player_1": AgentPlayer(ScriptedAgent([second_action])),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=ManualClock(),
    ) as episode:
        for _ in range(prior_steps):
            episode.step_once()
        with pytest.raises(IllegalAgentActionError, match=diagnostic):
            episode.step_once()
        assert episode.failed_player == failed
        assert episode.result().failed_player == failed


def test_illegal_external_action_defaults_instead_of_crashing_the_session(tmp_path: Path):
    entry = _masked_entry(legal=(0, 1))
    store = FolderRecordingStore(tmp_path)
    result = run_episode(
        entry,
        {"player_0": ExternalPlayer(ScriptedSource([2])), "player_1": AgentPlayer(ScriptedAgent([0]))},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=ManualClock(),
        store=store,
        recording_id="r",
        player_attribution={
            "player_0": {"kind": "human", "label": "Human"},
            "player_1": {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"},
        },
    )
    assert next(store.open("r").steps())["agents"]["player_0"]["action"] == 0
    assert result.ticks == 2
    assert result.failed_player is None
    assert result.step_timeouts == {"player_0": 0, "player_1": 0}


def test_environment_fault_on_a_legal_action_is_owned_by_no_player():
    # The agent returns a perfectly legal move, but the environment itself raises while applying it.
    # That is a genuine environment fault, not the agent's: it must propagate with no player charged,
    # so the orchestrator falls back to the whole-game fault rather than blaming the acting player.
    entry = _masked_entry(legal=(0, 1), raise_on_legal=0)
    players = {
        "player_0": AgentPlayer(ScriptedAgent([0])),  # legal, yet the env is rigged to raise on it
        "player_1": AgentPlayer(ScriptedAgent([1])),
    }
    episode = Episode(entry, players, parameters=resolve_parameters(entry.meta), seed=1, clock=ManualClock())
    episode.start()
    with pytest.raises(ValueError, match="env rejects"):
        episode.step_once()
    assert episode.failed_player is None
    assert episode.result().failed_player is None


@pytest.mark.parametrize(("hook", "ticks"), [("reset", 0), ("act", 1), ("learn", 1)])
def test_agent_hook_crash_preserves_attribution_recording_and_cleanup(tmp_path: Path, hook, ticks):
    error = RuntimeError("participant boom")

    def crash(*_args):
        raise error

    finals = {"player_0": 0.0, "player_1": 0.0, "player_2": 0.0}

    class ClosingTeamEnv(FakeTeamEnv):
        closed = False

        def close(self) -> None:
            self.closed = True

    env = ClosingTeamEnv(finals)
    entry = _team_entry(finals, make=lambda _parameters: env)
    broken = ScriptedAgent([0])
    setattr(broken, hook, crash)
    players = {
        "player_0": AgentPlayer(ScriptedAgent([0])),
        "player_1": AgentPlayer(broken),
        "player_2": AgentPlayer(ScriptedAgent([0])),
    }
    episode = Episode(
        entry,
        players,
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=FolderRecordingStore(tmp_path),
        recording_id="r",
        clock=ManualClock(),
        player_attribution={
            player: {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}
            for player in ("player_0", "player_1", "player_2")
        },
    )
    with pytest.raises(RuntimeError, match="participant boom") as caught, episode:
        while not episode.done:
            episode.advance()
    assert caught.value is error
    assert episode.tick == ticks
    assert episode.failed_player == "player_1"
    assert episode.result().failed_player == "player_1"
    assert env.closed is True
    header = json.loads((tmp_path / "r" / "recording.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert header["environment"] == "team"


@pytest.mark.parametrize(
    ("cost", "reason", "ticks", "failed"),
    [(10, "episode_limit", 0, "player_0"), (5, "terminated", 3, None)],
)
def test_reset_time_is_charged_and_stops_before_the_first_step_in_canonical_order(
    cost, reason, ticks, failed
):
    clock = ManualClock()
    reset_seeds: list[int] = []

    class SlowSetup:
        def reset(self, seed: int, observation: Any) -> None:
            reset_seeds.append(seed)
            clock.advance(cost)

        def act(self, observation: Any) -> int:
            return 0

    entry = _team_entry({"player_0": 0.0, "player_1": 0.0, "player_2": 0.0})
    with Episode(
        entry,
        {player: AgentPlayer(SlowSetup()) for player in ("player_2", "player_1", "player_0")},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=clock,
        step_limit_ms=1,
        episode_limit_ms=5,
    ) as episode:
        assert reset_seeds == [1, 1, 1]
        assert episode.tick == 0
        assert episode.done == (failed is not None)
        while not episode.done:
            episode.advance()
    result = episode.result()
    assert (result.reason, result.ticks, result.failed_player) == (reason, ticks, failed)
    assert result.step_timeouts == {"player_0": 0, "player_1": 0, "player_2": 0}


def test_sequential_setup_receives_each_agents_observe_value_and_skips_humans():
    class DistinctObservations(FakeTeamEnv):
        def reset(self, seed: int | None = None, options: Any = None) -> None:
            self.seed = seed
            super().reset(seed, options)

        def observe(self, player: str) -> dict[str, int]:
            return {"player": int(player.removeprefix("player_"))}

    seen: dict[str, object] = {}

    class Probe:
        def __init__(self, player: str) -> None:
            self.player = player

        def reset(self, seed: int, observation: object) -> None:
            seen[self.player] = (seed, observation)

        def act(self, observation: object) -> int:
            return 0

    finals = {"player_0": 0.0, "player_1": 0.0, "player_2": 0.0}
    env = DistinctObservations(finals)
    entry = _team_entry(finals, make=lambda _parameters: env)
    with Episode(
        entry,
        {
            "player_0": AgentPlayer(Probe("player_0")),
            "player_1": AgentPlayer(Probe("player_1")),
            "player_2": ExternalPlayer(ScriptedSource([])),
        },
        parameters=resolve_parameters(entry.meta),
        seed=23,
    ):
        assert env.seed == 23
        assert seen == {"player_0": (23, {"player": 0}), "player_1": (23, {"player": 1})}


def test_episode_normalizes_a_complete_parameter_map_before_constructing_the_environment():
    meta = replace(
        make_entry().meta,
        parameters=(EnvParameter("pace", "Pace", "A test parameter.", "float", 1.0, min=0.0, max=2.0),),
    )
    received: list[dict[str, object]] = []
    entry = EnvironmentEntry(
        meta=meta,
        make=lambda parameters: received.append(dict(parameters)) or FakeEnv(1),
        default_action=lambda _env, _player: 0,
    )

    with Episode(
        entry, {"player_0": ExternalPlayer(NoopSource())}, parameters={"players": 1, "pace": 2}, seed=1
    ) as episode:
        episode.step_once()

    assert received == [{"players": 1, "pace": 2.0}]


def test_episode_rejects_an_incomplete_or_unknown_parameter_map():
    """A launch configuration is produced by a caller that already resolved every value.

    Filling a missing name with its default here would let the game run on a value nobody chose and
    then stamp that value into the recording header as though it had been.
    """
    meta = replace(
        make_entry().meta,
        parameters=(EnvParameter("pace", "Pace", "A test parameter.", "float", 1.0, min=0.0, max=2.0),),
    )
    entry = EnvironmentEntry(
        meta=meta,
        make=lambda _parameters: FakeEnv(1),
        default_action=lambda _env, _player: 0,
    )
    players = {"player_0": ExternalPlayer(NoopSource())}

    with pytest.raises(EnvParameterValueError, match="missing environment parameter 'players'"):
        Episode(entry, players, parameters={"pace": 1.0}, seed=1)
    with pytest.raises(EnvParameterValueError, match="unknown environment parameter 'nope'"):
        Episode(entry, players, parameters={"players": 1, "pace": 1.0, "nope": 1}, seed=1)


def test_episode_rejects_a_factory_that_ignores_the_resolved_player_count():
    meta = replace(make_entry().meta, layout=PlayerBounds(2, 2))
    entry = EnvironmentEntry(
        meta=meta,
        make=lambda _parameters: FakeEnv(1),
        default_action=lambda _env, _player: 0,
    )

    with pytest.raises(ValueError, match=r"expected \['player_0', 'player_1'\]"):
        Episode(
            entry,
            {"player_0": ExternalPlayer(NoopSource())},
            parameters=resolve_parameters(entry.meta),
            seed=1,
        ).start()
