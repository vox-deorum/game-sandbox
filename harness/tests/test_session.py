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

from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import (
    EnvironmentEntry,
    EnvironmentMeta,
    EnvParameter,
    resolve_parameters,
)
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import (
    REASON_EPISODE_LIMIT,
    REASON_TERMINATED,
    REASON_TRUNCATED,
    AgentSlot,
    Episode,
    ExternalSlot,
    IllegalAgentActionError,
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
        make=lambda _parameters: FakeEnv(n_steps),
        default_action=lambda env, slot_id: DEFAULT_ACTION,
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
            parameters=resolve_parameters(entry.meta),
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
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
        players={"player_0": {"kind": "agent", "label": "Naive agent"}},
    )
    lines = (tmp_path / "r" / "recording.jsonl").read_text(encoding="utf-8").splitlines()
    header = json.loads(lines[0])
    assert header["players"] == {"player_0": {"kind": "agent", "label": "Naive agent"}}
    assert header["parameters"] == {"seats": 1}


def test_opening_state_returns_the_dealt_overlay_for_a_turn_based_env():
    # A turn-based env with an overlay yields a pre-action opening frame: the dealt overlay, no agent
    # having acted, tick 0. The live runner streams this so a human who leads sees the table at once.
    entry = make_entry(n_steps=3, pace_interval_ms=None, with_overlay=True)
    with Episode(
        entry, {"player_0": AgentSlot(ScriptedAgent([0]))}, parameters=resolve_parameters(entry.meta), seed=1
    ) as episode:
        opening = episode.opening_state()
    assert opening is not None
    assert opening["tick"] == 0
    assert opening["agents"] == {}
    assert opening["overlay"] == {"i": 0}  # the env's overlay at reset, before any step


def test_opening_state_is_none_for_paced_or_overlayless_envs():
    # A paced env renders its first frame within an interval, and an env with no overlay has nothing
    # to draw, so neither gets a streamed opening frame.
    paced = make_entry(n_steps=2, pace_interval_ms=16, with_overlay=True)
    with Episode(
        paced, {"player_0": AgentSlot(ScriptedAgent([0]))}, parameters=resolve_parameters(paced.meta), seed=1
    ) as episode:
        assert episode.opening_state() is None
    overlayless = make_entry(n_steps=2, pace_interval_ms=None, with_overlay=False)
    with Episode(
        overlayless,
        {"player_0": AgentSlot(ScriptedAgent([0]))},
        parameters=resolve_parameters(overlayless.meta),
        seed=1,
    ) as episode:
        assert episode.opening_state() is None


def test_agent_per_step_timeout_discards_action_and_counts_overage():
    clock = ManualClock()
    entry = make_entry(n_steps=3, step_limit_ms=1000)
    agent = ScriptedAgent([1, 1, 1], clock=clock, cost_ms=5000)  # 5s > 1s limit every step
    result = run_episode(
        entry, {"player_0": AgentSlot(agent)}, parameters=resolve_parameters(entry.meta), seed=1, clock=clock
    )
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

    result = run_episode(
        entry,
        {"player_0": AgentSlot(LearningAgent())},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=clock,
    )
    assert result.step_timeouts["player_0"] == 3
    assert result.reason == REASON_TERMINATED


def test_per_episode_budget_truncates():
    clock = ManualClock()
    # Each act costs 800ms (under the 1000ms step limit) but the cumulative budget is 2000ms.
    entry = make_entry(n_steps=10, step_limit_ms=1000, episode_limit_ms=2000)
    agent = ScriptedAgent([0], clock=clock, cost_ms=800)
    result = run_episode(
        entry, {"player_0": AgentSlot(agent)}, parameters=resolve_parameters(entry.meta), seed=1, clock=clock
    )
    assert result.reason == REASON_EPISODE_LIMIT
    assert result.ticks == 3  # 800*3 = 2400 > 2000, tripped on the third step
    # The seat that overran owns the overage, so it is named for per-seat failure attribution.
    assert result.failed_slot == "player_0"


def test_external_scripted_source_drives_slot():
    entry = make_entry(n_steps=3)
    source = ScriptedSource([0, 1, 0])
    result = run_episode(
        entry,
        {"player_0": ExternalSlot(source)},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=ManualClock(),
    )
    assert result.ticks == 3
    # External slots never touch the agent-timeout machinery.
    assert result.step_timeouts["player_0"] == 0


def test_external_noop_source_falls_back_to_default(tmp_path: Path):
    entry = make_entry(n_steps=2)
    store = FolderRecordingStore(tmp_path)
    result = run_episode(
        entry,
        {"player_0": ExternalSlot(NoopSource())},
        parameters=resolve_parameters(entry.meta),
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


def test_default_action_receives_live_env_and_slot_and_records_result(tmp_path: Path):
    # The timeout hook is handed the *live* env and the acting slot id, so it can read the current
    # state and return a concrete action; that returned integer is exactly what the recording stores.
    seen: list[tuple[Any, str]] = []

    def provider(env: Any, slot_id: str) -> int:
        seen.append((env, slot_id))
        # A value read off the live env (its step counter, 0 before the first step, 1 before the
        # second) proves the hook truly received the live instance, and it lands in the recording.
        return 100 + env._i

    entry = replace(make_entry(n_steps=2), default_action=provider)
    store = FolderRecordingStore(tmp_path)
    result = run_episode(
        entry,
        {"player_0": ExternalSlot(NoopSource())},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
    )
    assert result.step_timeouts["player_0"] == 0
    # Called once per step with the live env instance and the acting slot id.
    assert [slot for _env, slot in seen] == ["player_0", "player_0"]
    assert all(env is not None and hasattr(env, "_i") for env, _slot in seen)
    # The integer the hook returned, derived from live env state, is what the recording stored.
    recording = store.open("r")
    actions = [s["agents"]["player_0"]["action"] for s in recording.steps()]
    assert actions == [100, 101]


def test_max_steps_caps_episode():
    entry = make_entry(n_steps=100)
    result = run_episode(
        entry,
        {"player_0": AgentSlot(ScriptedAgent([0]))},
        parameters=resolve_parameters(entry.meta),
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
        parameters=resolve_parameters(entry.meta),
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


def _team_entry(finals: dict[str, float], *, make: Any = None) -> EnvironmentEntry:
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
        make=make if make is not None else (lambda _parameters: FakeTeamEnv(finals)),
        default_action=lambda env, slot_id: DEFAULT_ACTION,
        overlay=None,
    )


def test_terminal_rewards_credited_to_every_seat_not_just_the_actor():
    # Only player_2 acts last, but all three seats are paid at the terminal step. A loop that
    # read only the acting slot would leave player_0/player_1 at 0.0 and mis-rank the episode.
    finals = {"player_0": -13.0, "player_1": -3.0, "player_2": 0.0}
    entry = _team_entry(finals)
    slots = {p: AgentSlot(ScriptedAgent([0])) for p in ("player_0", "player_1", "player_2")}
    result = run_episode(entry, slots, parameters=resolve_parameters(entry.meta), seed=1, clock=ManualClock())
    assert result.reason == REASON_TERMINATED
    assert result.scores == finals
    assert result.failed_slot is None  # a clean episode charges no seat


def test_agent_crash_charges_the_failure_to_its_own_seat():
    # In a three-seat game only player_1's agent raises. The crash must be charged to player_1 alone,
    # so the orchestrator never marks player_0 or player_2 failed for a competitor's bug. The exception
    # still propagates (the container exits non-zero); the loop only records which seat was at fault.
    class Crashing:
        def reset(self, seed: int) -> None: ...

        def act(self, observation: Any) -> int:
            raise RuntimeError("boom")

    entry = _team_entry({"player_0": 0.0, "player_1": -13.0, "player_2": -3.0})
    slots = {
        "player_0": AgentSlot(ScriptedAgent([0])),
        "player_1": AgentSlot(Crashing()),
        "player_2": AgentSlot(ScriptedAgent([0])),
    }
    episode = Episode(entry, slots, parameters=resolve_parameters(entry.meta), seed=1, clock=ManualClock())
    episode.start()
    episode.step_once()  # player_0 acts cleanly
    with pytest.raises(RuntimeError, match="boom"):
        episode.step_once()  # player_1 raises on its turn
    assert episode.failed_slot == "player_1"
    assert episode.result().failed_slot == "player_1"


class _Discrete:
    """A minimal stand-in for a Gymnasium ``Discrete`` action space: membership over ``0..n-1``.

    Mirrors ``Discrete.contains`` closely enough for the action boundary (an integer in range, never
    a bool), so the loop's legality check can be exercised without depending on the Gymnasium types.
    """

    def __init__(self, n: int) -> None:
        self.n = n

    def contains(self, action: Any) -> bool:
        return isinstance(action, int) and not isinstance(action, bool) and 0 <= action < self.n


class MaskedEnv:
    """A 2-seat AEC env that exposes a Discrete action space and a per-step ``action_mask``, the way
    Hearts does, and rejects an illegal card from ``step`` (its ``IllegalMoveError`` analogue).

    Legal moves are the masked-1 indices. ``step`` raises on a masked-0 or out-of-range action — so a
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

    def action_space(self, agent: str) -> _Discrete:
        return _Discrete(self._n)

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
        description="A 2-seat fake with an action mask and illegal-move rejection.",
        min_slots=2,
        max_slots=2,
        human_slots=("player_0", "player_1"),
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
        default_action=lambda env, slot_id: 0,  # a legal move on every timeout path
        overlay=None,
    )


def test_illegal_masked_action_is_charged_to_the_acting_seat():
    # player_1 returns a card the action mask flags illegal. The loop must reject it at the boundary
    # and charge player_1 alone, so a co-seat is never marked failed for player_1's illegal move. The
    # rejection still aborts the episode (an illegal action is a fault), it just owns the right seat.
    entry = _masked_entry(legal=(0, 1))
    slots = {
        "player_0": AgentSlot(ScriptedAgent([0])),  # legal
        "player_1": AgentSlot(ScriptedAgent([2])),  # masked illegal
    }
    episode = Episode(entry, slots, parameters=resolve_parameters(entry.meta), seed=1, clock=ManualClock())
    episode.start()
    episode.step_once()  # player_0 plays a legal card
    with pytest.raises(IllegalAgentActionError, match="legal-move mask"):
        episode.step_once()  # player_1's illegal card is refused at the boundary
    assert episode.failed_slot == "player_1"
    assert episode.result().failed_slot == "player_1"


def test_illegal_action_masked_via_info_is_charged_to_the_acting_seat():
    # Some environments (Shimmy's OpenSpiel wrapper) publish the action mask in env.last()'s `info`
    # rather than the observation. The boundary must consult both, or an OpenSpiel illegal move slips
    # past unattributed and marks every seat failed. Same outcome as the observation-masked case.
    entry = _masked_entry(legal=(0, 1), mask_in_info=True)
    slots = {
        "player_0": AgentSlot(ScriptedAgent([0])),  # legal
        "player_1": AgentSlot(ScriptedAgent([2])),  # illegal per the info-supplied mask
    }
    episode = Episode(entry, slots, parameters=resolve_parameters(entry.meta), seed=1, clock=ManualClock())
    episode.start()
    episode.step_once()  # player_0 plays a legal card
    with pytest.raises(IllegalAgentActionError, match="legal-move mask"):
        episode.step_once()  # player_1's illegal card is refused via the info mask
    assert episode.failed_slot == "player_1"
    assert episode.result().failed_slot == "player_1"


def test_illegal_external_action_defaults_instead_of_crashing_the_session():
    # A human seat is not charged like an agent. An illegal action from a hand-rolled transport client
    # (the UI only sends legal cards) must fall back to the environment default rather than reaching
    # env.step and taking down every co-seat in the container. player_0 (external) sends a masked-out
    # card; the loop swaps in the legal default (0) so the step lands cleanly and no seat is charged.
    entry = _masked_entry(legal=(0, 1))
    slots = {
        "player_0": ExternalSlot(ScriptedSource([2])),  # 2 is masked illegal for a human seat
        "player_1": AgentSlot(ScriptedAgent([0])),  # legal
    }
    episode = Episode(entry, slots, parameters=resolve_parameters(entry.meta), seed=1, clock=ManualClock())
    episode.start()
    # Without the external-path legality check this would raise the env's illegal-move error; with it,
    # the action is defaulted and the step is applied.
    episode.step_once()
    assert episode.tick == 1
    assert episode.failed_slot is None


def test_out_of_action_space_action_is_charged_to_the_acting_seat():
    # An action outside the slot's Discrete space (the agent contract is an in-space action) is the
    # agent's fault, named even when the env publishes no per-card mask reason for it.
    entry = _masked_entry(n=4, legal=(0, 1, 2, 3))
    slots = {
        "player_0": AgentSlot(ScriptedAgent([9])),  # 9 is outside Discrete(4)
        "player_1": AgentSlot(ScriptedAgent([0])),
    }
    episode = Episode(entry, slots, parameters=resolve_parameters(entry.meta), seed=1, clock=ManualClock())
    episode.start()
    with pytest.raises(IllegalAgentActionError, match="action space"):
        episode.step_once()
    assert episode.failed_slot == "player_0"


def test_environment_fault_on_a_legal_action_is_owned_by_no_seat():
    # The agent returns a perfectly legal move, but the environment itself raises while applying it.
    # That is a genuine environment fault, not the agent's: it must propagate with no seat charged,
    # so the orchestrator falls back to the whole-game fault rather than blaming the acting seat.
    entry = _masked_entry(legal=(0, 1), raise_on_legal=0)
    slots = {
        "player_0": AgentSlot(ScriptedAgent([0])),  # legal, yet the env is rigged to raise on it
        "player_1": AgentSlot(ScriptedAgent([1])),
    }
    episode = Episode(entry, slots, parameters=resolve_parameters(entry.meta), seed=1, clock=ManualClock())
    episode.start()
    with pytest.raises(ValueError, match="env rejects"):
        episode.step_once()
    assert episode.failed_slot is None
    assert episode.result().failed_slot is None


def test_agent_reset_crash_is_charged_to_its_seat_over_a_written_recording(tmp_path: Path):
    # An agent whose reset() raises must be charged to its own seat, not reported as an unowned
    # infrastructure fault. The header is opened before the participants reset, so the crash still
    # leaves a readable recording for the orchestrator to attribute over (instead of no result row).
    class ResetCrashing:
        def reset(self, seed: int) -> None:
            raise RuntimeError("reset boom")

        def act(self, observation: Any) -> int:
            return 0

    entry = _team_entry({"player_0": 0.0, "player_1": 0.0, "player_2": 0.0})
    store = FolderRecordingStore(tmp_path)
    slots = {
        "player_0": AgentSlot(ScriptedAgent([0])),
        "player_1": AgentSlot(ResetCrashing()),
        "player_2": AgentSlot(ScriptedAgent([0])),
    }
    episode = Episode(
        entry,
        slots,
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
    )
    with pytest.raises(RuntimeError, match="reset boom"):
        episode.start()
    assert episode.failed_slot == "player_1"
    assert episode.result().failed_slot == "player_1"

    episode.close()
    # The recording exists with its header, so this reads as an attributable crash, not a missing run.
    header = json.loads((tmp_path / "r" / "recording.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert header["environment"] == "team"


def test_start_failure_through_context_manager_closes_recording_and_env(tmp_path: Path):
    # run_episode drives Episode as a context manager. When start() raises (here an agent reset crash)
    # __enter__ propagates before the `with` body, so __exit__ never runs — start() itself must close
    # the half-opened recording writer and the constructed env, or both leak. Proof: the env's close()
    # is called and the recording stays readable (its header was flushed on open).
    class ResetCrashing:
        def reset(self, seed: int) -> None:
            raise RuntimeError("reset boom")

        def act(self, observation: Any) -> int:
            return 0

    finals = {"player_0": 0.0, "player_1": 0.0, "player_2": 0.0}

    class ClosingTeamEnv(FakeTeamEnv):
        def __init__(self) -> None:
            super().__init__(finals)
            self.closed = False

        def close(self) -> None:
            self.closed = True

    made: list[ClosingTeamEnv] = []

    def make(_parameters: object) -> ClosingTeamEnv:
        env = ClosingTeamEnv()
        made.append(env)
        return env

    entry = _team_entry(finals, make=make)
    store = FolderRecordingStore(tmp_path)
    slots = {
        "player_0": AgentSlot(ScriptedAgent([0])),
        "player_1": AgentSlot(ResetCrashing()),
        "player_2": AgentSlot(ScriptedAgent([0])),
    }
    with pytest.raises(RuntimeError, match="reset boom"):
        run_episode(
            entry,
            slots,
            parameters=resolve_parameters(entry.meta),
            seed=1,
            store=store,
            recording_id="r",
            clock=ManualClock(),
        )

    assert len(made) == 1
    assert made[0].closed is True  # start() closed the env even though __exit__ never ran
    header = json.loads((tmp_path / "r" / "recording.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert header["environment"] == "team"


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

    result = run_episode(
        entry,
        {"player_0": AgentSlot(LearningAgent())},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=clock,
    )
    # Each step costs 100 (act) + 300 (learn) = 400ms; budget 1000 trips on the third step.
    assert result.reason == REASON_EPISODE_LIMIT
    assert result.ticks == 3


def test_episode_defensively_resolves_parameters_before_constructing_the_environment():
    meta = replace(
        make_entry().meta,
        parameters=(EnvParameter("pace", "Pace", "A test parameter.", "float", 1.0, min=0.0, max=2.0),),
    )
    received: list[dict[str, object]] = []
    entry = EnvironmentEntry(
        meta=meta,
        make=lambda parameters: received.append(dict(parameters)) or FakeEnv(1),
        default_action=lambda _env, _slot: 0,
    )

    with Episode(entry, {"player_0": ExternalSlot(NoopSource())}, parameters={"pace": 2}, seed=1) as episode:
        episode.step_once()

    assert received == [{"seats": 1, "pace": 2.0}]


def test_episode_rejects_a_factory_that_ignores_the_resolved_seat_count():
    meta = replace(make_entry().meta, min_slots=2, max_slots=2)
    entry = EnvironmentEntry(
        meta=meta,
        make=lambda _parameters: FakeEnv(1),
        default_action=lambda _env, _slot: 0,
    )

    with pytest.raises(ValueError, match="possible agents, expected 2"):
        Episode(
            entry, {"player_0": ExternalSlot(NoopSource())}, parameters=resolve_parameters(entry.meta), seed=1
        ).start()
