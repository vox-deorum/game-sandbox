"""The session loop, as the exit criteria made executable, all on ManualClock.

A small deterministic fake AEC env keeps these tests independent of the environments package:
it advances a counter, hands out integer observations, and terminates after N steps. Only the
AEC surface ``run_episode`` actually uses is implemented.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import EnvironmentEntry, EnvironmentMeta
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import (
    REASON_EPISODE_LIMIT,
    REASON_TERMINATED,
    REASON_TRUNCATED,
    AgentSlot,
    Episode,
    ExternalSlot,
    NoopSource,
    ScriptedSource,
    run_episode,
)

DEFAULT_ACTION = -1


class FakeEnv:
    """A one-slot AEC env that lives for ``n_steps`` and rewards 1.0 per step."""

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
        min_slots=1,
        max_slots=1,
        human_slots=("player_0",),
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
        make=lambda: FakeEnv(n_steps),
        default_action=lambda slot_id: DEFAULT_ACTION,
        overlay=overlay,
    )


class ScriptedAgent:
    """Replays fixed actions; optionally advances a clock to simulate slowness."""

    def __init__(self, actions: list[int], clock: ManualClock | None = None, cost_ms: int = 0):
        self._actions = actions
        self._clock = clock
        self._cost = cost_ms

    def reset(self, seed: int) -> None:
        self._i = 0

    def act(self, observation: Any) -> int:
        if self._clock is not None and self._cost:
            self._clock.advance(self._cost)
        action = self._actions[self._i % len(self._actions)]
        self._i += 1
        return action


def test_same_seed_same_agent_byte_identical_recordings(tmp_path: Path):
    entry = make_entry(n_steps=4, with_overlay=True)

    def run(root: Path) -> Path:
        store = FolderRecordingStore(root)
        run_episode(
            entry,
            {"player_0": AgentSlot(ScriptedAgent([0, 1, 0, 1]))},
            seed=99,
            store=store,
            recording_id="r",
            clock=ManualClock(),
        )
        return root / "r" / "recording.jsonl"

    a = run(tmp_path / "a").read_bytes()
    b = run(tmp_path / "b").read_bytes()
    assert a == b
    # The recording carries the overlay and the per-step decision timing.
    assert b'"overlay"' in a
    assert b'"decision_ms"' in a


def test_players_attribution_lands_in_the_recording_header(tmp_path: Path):
    entry = make_entry(n_steps=2)
    store = FolderRecordingStore(tmp_path)
    run_episode(
        entry,
        {"player_0": AgentSlot(ScriptedAgent([0, 1]))},
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
        players={"player_0": {"kind": "agent", "label": "Naive agent"}},
    )
    lines = (tmp_path / "r" / "recording.jsonl").read_text(encoding="utf-8").splitlines()
    header = json.loads(lines[0])
    assert header["players"] == {"player_0": {"kind": "agent", "label": "Naive agent"}}


def test_opening_state_returns_the_dealt_overlay_for_a_turn_based_env():
    # A turn-based env with an overlay yields a pre-action opening frame: the dealt overlay, no agent
    # having acted, tick 0. The live runner streams this so a human who leads sees the table at once.
    entry = make_entry(n_steps=3, pace_interval_ms=None, with_overlay=True)
    with Episode(entry, {"player_0": AgentSlot(ScriptedAgent([0]))}, seed=1) as episode:
        opening = episode.opening_state()
    assert opening is not None
    assert opening["tick"] == 0
    assert opening["agents"] == {}
    assert opening["overlay"] == {"i": 0}  # the env's overlay at reset, before any step


def test_opening_state_is_none_for_paced_or_overlayless_envs():
    # A paced env renders its first frame within an interval, and an env with no overlay has nothing
    # to draw, so neither gets a streamed opening frame.
    paced = make_entry(n_steps=2, pace_interval_ms=16, with_overlay=True)
    with Episode(paced, {"player_0": AgentSlot(ScriptedAgent([0]))}, seed=1) as episode:
        assert episode.opening_state() is None
    overlayless = make_entry(n_steps=2, pace_interval_ms=None, with_overlay=False)
    with Episode(overlayless, {"player_0": AgentSlot(ScriptedAgent([0]))}, seed=1) as episode:
        assert episode.opening_state() is None


def test_agent_per_step_timeout_discards_action_and_counts_overage():
    clock = ManualClock()
    entry = make_entry(n_steps=3, step_limit_ms=1000)
    agent = ScriptedAgent([1, 1, 1], clock=clock, cost_ms=5000)  # 5s > 1s limit every step
    result = run_episode(entry, {"player_0": AgentSlot(agent)}, seed=1, clock=clock)
    assert result.step_timeouts["player_0"] == 3
    assert result.reason == REASON_TERMINATED


def test_learn_hook_time_counts_toward_per_step_overage():
    clock = ManualClock()
    entry = make_entry(n_steps=3, step_limit_ms=300, episode_limit_ms=120_000)

    class LearningAgent:
        def reset(self, seed: int) -> None: ...

        def act(self, observation: Any) -> int:
            clock.advance(100)
            return 0

        def learn(self, observation, action, reward, terminated) -> None:
            clock.advance(250)

    result = run_episode(entry, {"player_0": AgentSlot(LearningAgent())}, seed=1, clock=clock)
    assert result.step_timeouts["player_0"] == 3
    assert result.reason == REASON_TERMINATED


def test_per_episode_budget_truncates():
    clock = ManualClock()
    # Each act costs 800ms (under the 1000ms step limit) but the cumulative budget is 2000ms.
    entry = make_entry(n_steps=10, step_limit_ms=1000, episode_limit_ms=2000)
    agent = ScriptedAgent([0], clock=clock, cost_ms=800)
    result = run_episode(entry, {"player_0": AgentSlot(agent)}, seed=1, clock=clock)
    assert result.reason == REASON_EPISODE_LIMIT
    assert result.ticks == 3  # 800*3 = 2400 > 2000, tripped on the third step


def test_external_scripted_source_drives_slot():
    entry = make_entry(n_steps=3)
    source = ScriptedSource([0, 1, 0])
    result = run_episode(entry, {"player_0": ExternalSlot(source)}, seed=1, clock=ManualClock())
    assert result.ticks == 3
    # External slots never touch the agent-timeout machinery.
    assert result.step_timeouts["player_0"] == 0


def test_external_noop_source_falls_back_to_default(tmp_path: Path):
    entry = make_entry(n_steps=2)
    store = FolderRecordingStore(tmp_path)
    result = run_episode(
        entry,
        {"player_0": ExternalSlot(NoopSource())},
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
    )
    assert result.step_timeouts["player_0"] == 0
    # The default action was recorded (no agent input arrived).
    recording = store.open("r")
    actions = [s["agents"]["player_0"]["action"] for s in recording.steps()]
    assert actions == [DEFAULT_ACTION, DEFAULT_ACTION]


def test_max_steps_caps_episode():
    entry = make_entry(n_steps=100)
    result = run_episode(
        entry,
        {"player_0": AgentSlot(ScriptedAgent([0]))},
        seed=1,
        clock=ManualClock(),
        max_steps=5,
    )
    assert result.ticks == 5
    assert result.scores["player_0"] == 5.0
    assert result.reason == REASON_TRUNCATED


def test_max_steps_coinciding_with_termination_reports_terminated():
    # The env terminates on its 3rd step; capping at exactly 3 must not mask that natural
    # termination as a cap truncation.
    entry = make_entry(n_steps=3)
    result = run_episode(
        entry,
        {"player_0": AgentSlot(ScriptedAgent([0]))},
        seed=1,
        clock=ManualClock(),
        max_steps=3,
    )
    assert result.ticks == 3
    assert result.reason == REASON_TERMINATED


class FakeTeamEnv:
    """A 3-seat turn-based AEC env that pays every seat a final reward on the last actor's step.

    This mirrors how Hearts settles: rewards stay 0 while seats take turns, then on the final
    actor's step every seat is assigned its terminal reward at once and all seats terminate.
    The non-final seats are then collected through AEC dead-steps. It exists to prove the loop
    credits all seats' terminal rewards, not only the acting one.
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
            # Dead-step: collect the terminated seat (PettingZoo would also _clear_rewards here,
            # which is exactly why a non-final seat's terminal reward must be read earlier).
            self.agents.remove(a)
            self.rewards = {x: 0.0 for x in self.agents}
            if self.agents:
                self.agent_selection = self.agents[0]
            return
        self._idx += 1
        if self._idx >= len(self.possible_agents):
            # Final actor: pay out every seat at once and terminate all of them.
            self.rewards = dict(self._finals)
            self.terminations = {x: True for x in self.possible_agents}
            self.agent_selection = self.possible_agents[0]
        else:
            self.rewards = {x: 0.0 for x in self.possible_agents}
            self.agent_selection = self.possible_agents[self._idx]


def _team_entry(finals: dict[str, float]) -> EnvironmentEntry:
    meta = EnvironmentMeta(
        env_id="team",
        display_name="Team",
        description="A deterministic 3-seat fake with a terminal payout.",
        min_slots=3,
        max_slots=3,
        human_slots=("player_0", "player_1", "player_2"),
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
        make=lambda: FakeTeamEnv(finals),
        default_action=lambda slot_id: DEFAULT_ACTION,
        overlay=None,
    )


def test_terminal_rewards_credited_to_every_seat_not_just_the_actor():
    # Only player_2 acts last, but all three seats are paid at the terminal step. A loop that
    # read only the acting slot would leave player_0/player_1 at 0.0 and mis-rank the episode.
    finals = {"player_0": -13.0, "player_1": -3.0, "player_2": 0.0}
    entry = _team_entry(finals)
    slots = {p: AgentSlot(ScriptedAgent([0])) for p in ("player_0", "player_1", "player_2")}
    result = run_episode(entry, slots, seed=1, clock=ManualClock())
    assert result.reason == REASON_TERMINATED
    assert result.scores == finals


def test_learn_hook_time_counts_against_budget():
    clock = ManualClock()
    entry = make_entry(n_steps=10, episode_limit_ms=1000)

    class LearningAgent:
        def reset(self, seed: int) -> None: ...

        def act(self, observation: Any) -> int:
            clock.advance(100)
            return 0

        def learn(self, observation, action, reward, terminated) -> None:
            clock.advance(300)

    result = run_episode(entry, {"player_0": AgentSlot(LearningAgent())}, seed=1, clock=clock)
    # Each step costs 100 (act) + 300 (learn) = 400ms; budget 1000 trips on the third step.
    assert result.reason == REASON_EPISODE_LIMIT
    assert result.ticks == 3
