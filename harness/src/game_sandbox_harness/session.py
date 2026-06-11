"""The single session loop.

One loop serves realtime and turn-based environments alike: each step asks the acting slot
for an action under a deadline and applies the environment-provided default action if the
deadline passes. The realtime-versus-turn-based difference is the environment's pace
interval, which is a Stage 3 live-session pacing concern; this loop has no pacing and steps
as fast as the acting slot produces actions. Stage 3 drives this same ``run_episode`` from
inside the session container; the CLI is a development front end over it.

A slot is bound either to a loaded agent (:class:`AgentSlot`, governed by the cooperative
agent-timeout machinery) or to an external action source (:class:`ExternalSlot`, which is
what "human" means to the harness). The two paths are deliberately separate: external slots
never consult the per-step agent limit and their ``None`` fallback involves no measurement
or overage accounting.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol, runtime_checkable

from game_sandbox_harness.agent import has_learn
from game_sandbox_harness.clock import Clock, SystemClock
from game_sandbox_harness.environment import EnvironmentEntry
from game_sandbox_harness.recording import RecordingStore
from game_sandbox_harness.state import build_agent_step, build_header, build_step_state

# Termination reasons reported in EpisodeResult.
REASON_TERMINATED = "terminated"
REASON_TRUNCATED = "truncated"
REASON_EPISODE_LIMIT = "episode_limit"


@runtime_checkable
class ActionSource(Protocol):
    """A source of actions for an external (human-controlled) slot.

    ``get_action`` may block up to ``deadline_ms`` (Stage 3's transport-backed source will);
    ``deadline_ms`` is ``None`` when no deadline applies. Returning ``None`` means no input
    arrived in time, and the loop applies the environment's default action for the slot.
    """

    def get_action(self, slot_id: str, observation: Any, deadline_ms: int | None) -> Any: ...


class NoopSource:
    """An :class:`ActionSource` that never supplies input; the loop always defaults."""

    def get_action(self, slot_id: str, observation: Any, deadline_ms: int | None) -> Any:
        return None


class ScriptedSource:
    """An :class:`ActionSource` that replays a fixed list of actions, then yields ``None``."""

    def __init__(self, actions: list[Any]) -> None:
        self._actions = list(actions)
        self._index = 0

    def get_action(self, slot_id: str, observation: Any, deadline_ms: int | None) -> Any:
        if self._index >= len(self._actions):
            return None
        action = self._actions[self._index]
        self._index += 1
        return action


@dataclass(frozen=True)
class AgentSlot:
    """A slot driven by a loaded agent, under the agent-timeout machinery."""

    agent: Any


@dataclass(frozen=True)
class ExternalSlot:
    """A slot fed from outside the harness — the "human" slot.

    ``timeout_ms`` defaults to the environment's ``human_timeout_ms``; when the environment
    has a pace interval, the interval is the deadline instead.
    """

    source: ActionSource
    timeout_ms: int | None = None


Slot = AgentSlot | ExternalSlot


@dataclass(frozen=True)
class EpisodeResult:
    """The outcome of one episode."""

    ticks: int
    scores: dict[str, float]
    reason: str
    step_timeouts: dict[str, int]
    recording_id: str | None = None


@dataclass
class _SlotState:
    """Per-slot mutable accounting for one episode."""

    score: float = 0.0
    budget_used_ms: float = 0.0
    step_timeouts: int = 0


def _iso_utc(ms: int) -> str:
    """Render epoch milliseconds as an ISO-8601 UTC date-time string."""
    return datetime.fromtimestamp(ms / 1000, tz=UTC).isoformat()


def run_episode(
    entry: EnvironmentEntry,
    slots: Mapping[str, Slot],
    *,
    seed: int,
    store: RecordingStore | None = None,
    recording_id: str | None = None,
    clock: Clock | None = None,
    step_limit_ms: int | None = None,
    episode_limit_ms: int | None = None,
    max_steps: int | None = None,
) -> EpisodeResult:
    """Play one seeded episode of ``entry`` with the given slot bindings.

    Reset seeds everything: the environment via ``reset(seed=seed)`` and every agent via its
    own ``reset(seed)``. The loop is PettingZoo's agent-environment cycle; for each acting
    slot it obtains an action (agent or external path), steps the environment, calls the
    optional ``learn`` hook, assembles one per-step state, and writes it through the store
    when one is given. Recording is optional so the evaluation pattern (run many seeds, keep
    scores, store nothing) shares this exact code path.
    """
    clock = clock or SystemClock()
    step_limit = step_limit_ms if step_limit_ms is not None else entry.meta.step_limit_ms
    episode_limit = (
        episode_limit_ms if episode_limit_ms is not None else entry.meta.episode_limit_ms
    )

    env = entry.make()
    env.reset(seed=seed)
    for binding in slots.values():
        if isinstance(binding, AgentSlot):
            binding.agent.reset(seed)

    state = {slot_id: _SlotState() for slot_id in slots}

    created_at_ms = clock.now_ms()
    writer = None
    writer_cm = None
    if store is not None:
        if recording_id is None:
            recording_id = f"{entry.meta.env_id}-seed{seed}-{created_at_ms}"
        header = build_header(
            environment=entry.meta.env_id, seed=seed, created_at=_iso_utc(created_at_ms)
        )
        writer_cm = store.create(recording_id, header)
        writer = writer_cm.__enter__()

    reason = REASON_TERMINATED
    tick = 0
    try:
        while env.agents:
            slot_id = env.agent_selection
            observation, _reward, termination, truncation, _info = env.last()

            if termination or truncation:
                reason = REASON_TRUNCATED if truncation else REASON_TERMINATED
                env.step(None)
                continue

            binding = slots[slot_id]
            slot = state[slot_id]
            step_start = clock.now_ms()
            decision_ms: float | None = None

            if isinstance(binding, AgentSlot):
                action = binding.agent.act(observation)
                decision_ms = clock.now_ms() - step_start
                slot.budget_used_ms += decision_ms
                if decision_ms > step_limit:
                    slot.step_timeouts += 1
                    action = entry.default_action(slot_id)
            else:
                deadline_ms = _external_deadline(entry, binding, clock)
                action = binding.source.get_action(slot_id, observation, deadline_ms)
                if action is None:
                    action = entry.default_action(slot_id)

            env.step(action)
            reward = float(env.rewards[slot_id])
            slot.score += reward

            learn_ms: float | None = None
            if isinstance(binding, AgentSlot) and has_learn(binding.agent):
                terminated_now = bool(env.terminations[slot_id] or env.truncations[slot_id])
                learn_start = clock.now_ms()
                binding.agent.learn(observation, action, reward, terminated_now)
                learn_ms = clock.now_ms() - learn_start
                slot.budget_used_ms += learn_ms

            if writer is not None:
                overlay = entry.overlay(env) if entry.overlay is not None else None
                agent_step = build_agent_step(
                    reward=reward,
                    score=slot.score,
                    action=action,
                    decision_ms=decision_ms,
                    learn_ms=learn_ms,
                )
                writer.write_step(
                    build_step_state(
                        tick=tick,
                        agents={slot_id: agent_step},
                        started_at=step_start,
                        duration_ms=clock.now_ms() - step_start,
                        overlay=overlay,
                    )
                )
            tick += 1

            if slot.budget_used_ms > episode_limit:
                reason = REASON_EPISODE_LIMIT
                break
            if max_steps is not None and tick >= max_steps:
                reason = REASON_TRUNCATED
                break
    finally:
        if writer_cm is not None:
            writer_cm.__exit__(None, None, None)

    return EpisodeResult(
        ticks=tick,
        scores={slot_id: state[slot_id].score for slot_id in slots},
        reason=reason,
        step_timeouts={slot_id: state[slot_id].step_timeouts for slot_id in slots},
        recording_id=recording_id if store is not None else None,
    )


def _external_deadline(entry: EnvironmentEntry, binding: ExternalSlot, clock: Clock) -> int | None:
    """Compute the wall-clock deadline for an external slot, or ``None`` for no deadline.

    A set pace interval is itself the human deadline; otherwise the slot's own ``timeout_ms``
    applies, defaulting from the environment's ``human_timeout_ms``.
    """
    if entry.meta.pace_interval_ms is not None:
        window = entry.meta.pace_interval_ms
    elif binding.timeout_ms is not None:
        window = binding.timeout_ms
    else:
        window = entry.meta.human_timeout_ms
    if window is None:
        return None
    return clock.now_ms() + window
