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
