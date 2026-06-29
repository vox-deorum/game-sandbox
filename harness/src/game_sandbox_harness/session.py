"""The single session loop and the step machinery beneath it.

One loop serves realtime and turn-based environments alike: each step asks the acting slot
for an action under a deadline and applies the environment-provided default action if the
deadline passes. The realtime-versus-turn-based difference is the environment's pace
interval, which is a Stage 3 live-session pacing concern; the machinery here has no pacing
and steps as fast as the acting slot produces actions.

The machinery is exposed as an :class:`Episode`: it owns the reset env, the recording writer,
and the per-slot accounting, and advances exactly one PettingZoo cycle per
:meth:`Episode.step_once`. :func:`run_episode` is a thin loop over it
(``while not episode.done: episode.step_once()``),
and Stage 3's live runner is a second thin loop over the *same* ``step_once`` that adds wall-clock
pacing and pause/stop handling around it — one code path, the pace interval the only branch. The
Stage 2 determinism fixtures are the regression gate for this split: a recording produced through
:class:`Episode` is byte-identical to the pre-refactor loop.

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
from game_sandbox_harness.state import (
    PlayerAttribution,
    StepState,
    build_agent_step,
    build_header,
    build_step_state,
)

# Termination reasons reported in EpisodeResult.
REASON_TERMINATED = "terminated"
REASON_TRUNCATED = "truncated"
REASON_EPISODE_LIMIT = "episode_limit"
#: Reported when a live session is ended by an external ``stop`` command rather than by the
#: episode reaching its own end. Only the live loop sets it (via :meth:`Episode.stop`); the
#: headless ``run_episode`` never stops early this way.
REASON_STOPPED = "stopped"


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


class Episode:
    """One seeded episode's worth of step machinery, advanced one cycle at a time.

    Construct, :meth:`start` (reset the env and the agents, open the recording), then drive
    ``while not episode.done: episode.step_once()`` and read :meth:`result`. :meth:`close`
    flushes the recording and closes the env; the context-manager form pairs ``start`` with it.

    Each :meth:`step_once` runs exactly one PettingZoo agent-environment cycle: it obtains an
    action for the acting slot (agent or external path), steps the environment, calls the
    optional ``learn`` hook, assembles one per-step state, writes it through the store when one
    is given, and applies the budget and step-cap termination checks. The live runner shares
    this method verbatim and only wraps pacing and pause/stop around the loop.
    """

    def __init__(
        self,
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
        players: Mapping[str, PlayerAttribution] | None = None,
    ) -> None:
        self._entry = entry
        self._slots = slots
        self._seed = seed
        self._store = store
        self._recording_id = recording_id
        self._players = players
        self._clock = clock or SystemClock()
        self._step_limit = step_limit_ms if step_limit_ms is not None else entry.meta.step_limit_ms
        self._episode_limit = (
            episode_limit_ms if episode_limit_ms is not None else entry.meta.episode_limit_ms
        )
        self._max_steps = max_steps

        self._state = {slot_id: _SlotState() for slot_id in slots}
        self._env: Any = None
        self._writer: Any = None
        self._writer_cm: Any = None
        self._reason = REASON_TERMINATED
        self._tick = 0
        self._stopped = False

    def start(self) -> None:
        """Reset the environment and agents and open the recording.

        The env is created here, not in ``__init__``, so a failure in ``env.reset`` or an
        agent's ``reset`` still leaves a constructed :class:`Episode` whose :meth:`close` can
        run; callers using the context-manager form get that for free.
        """
        env = self._entry.make()
        self._env = env
        env.reset(seed=self._seed)
        for binding in self._slots.values():
            if isinstance(binding, AgentSlot):
                binding.agent.reset(self._seed)

        if self._store is not None:
            created_at_ms = self._clock.now_ms()
            if self._recording_id is None:
                self._recording_id = f"{self._entry.meta.env_id}-seed{self._seed}-{created_at_ms}"
            header = build_header(
                environment=self._entry.meta.env_id,
                seed=self._seed,
                created_at=_iso_utc(created_at_ms),
                players=dict(self._players) if self._players is not None else None,
            )
            self._writer_cm = self._store.create(self._recording_id, header)
            self._writer = self._writer_cm.__enter__()

    @property
    def done(self) -> bool:
        """Whether the loop should stop: the env has no acting agents, or a check tripped."""
        return self._stopped or not self._env.agents

    @property
    def tick(self) -> int:
        """The number of steps recorded so far."""
        return self._tick

    def opening_state(self) -> StepState | None:
        """The pre-action "opening" frame: the dealt overlay with no agent having acted yet.

        A turn-based environment can require the first acting slot, possibly a connected human
        (Hearts' 2♣ leader), to act before any :meth:`step_once` has produced a frame, leaving the
        client with an empty table and nothing to render. The live runner streams this one frame
        right after :meth:`start`, so the table (and the human's own hand) is visible immediately and
        the human can play. Returns ``None`` for a paced environment, which steps on its own cadence
        and renders its first frame within an interval, or one with no overlay to draw.

        This is a live-presentation aid only and is never written through the recording: recordings
        and the headless path are byte-for-byte unchanged, so a replay still begins at the first play.
        Valid only after :meth:`start` (the env must be reset); the live runner calls it there.
        """
        if self._entry.meta.pace_interval_ms is not None or self._entry.overlay is None:
            return None
        return build_step_state(
            tick=0,
            agents={},
            started_at=self._clock.now_ms(),
            duration_ms=0,
            overlay=self._entry.overlay(self._env),
        )

    def stop(self, reason: str = REASON_STOPPED) -> None:
        """Mark the episode finished from outside (the live ``stop`` command).

        Sets ``done`` so the next loop check ends the run, and records ``reason`` for the
        result. Headless ``run_episode`` never calls this; only the live loop does.
        """
        self._reason = reason
        self._stopped = True

    def step_once(self) -> None:
        """Advance the acting slot by exactly one PettingZoo cycle. See the class docstring."""
        env = self._env
        slot_id = env.agent_selection
        observation, _reward, termination, truncation, _info = env.last()

        if termination or truncation:
            self._reason = REASON_TRUNCATED if truncation else REASON_TERMINATED
            env.step(None)
            return

        binding = self._slots[slot_id]
        slot = self._state[slot_id]
        step_start = self._clock.now_ms()
        decision_ms: float | None = None
        agent_compute_ms = 0.0

        if isinstance(binding, AgentSlot):
            action = binding.agent.act(observation)
            decision_ms = self._clock.now_ms() - step_start
            agent_compute_ms += decision_ms
            slot.budget_used_ms += decision_ms
            if decision_ms > self._step_limit:
                action = self._entry.default_action(slot_id)
        else:
            deadline_ms = _external_deadline(self._entry, binding, self._clock)
            action = binding.source.get_action(slot_id, observation, deadline_ms)
            if action is None:
                action = self._entry.default_action(slot_id)

        env.step(action)
        reward = float(env.rewards[slot_id])
        # Credit every agent this step rewarded, not just the acting slot. A turn-based env
        # (e.g. Hearts) assigns terminal rewards to all seats on the final actor's step, and
        # those rewards live in env.rewards for this one cycle only — the AEC dead-steps that
        # follow clear them (PettingZoo's _was_dead_step calls _clear_rewards). Reading just
        # the acting slot would drop every non-final seat's terminal score, mis-ranking the
        # episode. Single-agent envs are unaffected: env.rewards then holds only the actor, so
        # this stays byte-identical to the prior loop for them (and for the determinism gate).
        for rewarded_slot, slot_reward in env.rewards.items():
            rewarded_state = self._state.get(rewarded_slot)
            if rewarded_state is not None:
                rewarded_state.score += float(slot_reward)

        learn_ms: float | None = None
        if isinstance(binding, AgentSlot) and has_learn(binding.agent):
            terminated_now = bool(env.terminations[slot_id] or env.truncations[slot_id])
            learn_start = self._clock.now_ms()
            binding.agent.learn(observation, action, reward, terminated_now)
            learn_ms = self._clock.now_ms() - learn_start
            agent_compute_ms += learn_ms
            slot.budget_used_ms += learn_ms

        if isinstance(binding, AgentSlot) and agent_compute_ms > self._step_limit:
            slot.step_timeouts += 1

        if self._writer is not None:
            overlay = self._entry.overlay(env) if self._entry.overlay is not None else None
            # The display `observation` is intentionally not recorded: Flappy Bird's
            # renderer reconstructs frames from the overlay, so the (large, per-step)
            # observation array would only bloat recordings. build_agent_step and the
            # schema both already support an `observation` field — if a future
            # environment needs the renderer to see the raw observation, supply it here
            # (likely via a new EnvironmentEntry hook) rather than re-deriving it.
            agent_step = build_agent_step(
                reward=reward,
                score=slot.score,
                action=action,
                decision_ms=decision_ms,
                learn_ms=learn_ms,
            )
            self._writer.write_step(
                build_step_state(
                    tick=self._tick,
                    agents={slot_id: agent_step},
                    started_at=step_start,
                    duration_ms=self._clock.now_ms() - step_start,
                    overlay=overlay,
                )
            )
        self._tick += 1

        if slot.budget_used_ms > self._episode_limit:
            self._reason = REASON_EPISODE_LIMIT
            self._stopped = True
            return
        if self._max_steps is not None and self._tick >= self._max_steps:
            # A natural termination/truncation can land on the very tick the cap is hit; the
            # next cycle would have labeled it, but we are cutting the loop short. Preserve
            # that outcome rather than masking it as a cap truncation.
            self._reason = REASON_TERMINATED if env.terminations[slot_id] else REASON_TRUNCATED
            self._stopped = True

    def close(self) -> None:
        """Flush and close the recording, then close the environment. Idempotent."""
        if self._writer_cm is not None:
            self._writer_cm.__exit__(None, None, None)
            self._writer_cm = None
            self._writer = None
        if self._env is not None:
            close = getattr(self._env, "close", None)
            if callable(close):
                close()

    def result(self) -> EpisodeResult:
        """The outcome accumulated so far. Valid after the loop ends; safe after :meth:`close`."""
        return EpisodeResult(
            ticks=self._tick,
            scores={slot_id: self._state[slot_id].score for slot_id in self._slots},
            reason=self._reason,
            step_timeouts={slot_id: self._state[slot_id].step_timeouts for slot_id in self._slots},
            recording_id=self._recording_id if self._store is not None else None,
        )

    def __enter__(self) -> Episode:
        self.start()
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.close()


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
    players: Mapping[str, PlayerAttribution] | None = None,
) -> EpisodeResult:
    """Play one seeded episode of ``entry`` with the given slot bindings.

    A thin headless loop over :class:`Episode`: reset seeds everything (the environment via
    ``reset(seed=seed)`` and every agent via its own ``reset(seed)``), then drive PettingZoo's
    agent-environment cycle to its end, recording through the store when one is given.
    Recording is optional so the evaluation pattern (run many seeds, keep scores, store
    nothing) shares this exact code path. This loop never paces and never pauses; that is the
    live runner's job, layered around the same :meth:`Episode.step_once`.
    """
    with Episode(
        entry,
        slots,
        seed=seed,
        store=store,
        recording_id=recording_id,
        clock=clock,
        step_limit_ms=step_limit_ms,
        episode_limit_ms=episode_limit_ms,
        max_steps=max_steps,
        players=players,
    ) as episode:
        while not episode.done:
            episode.step_once()
    return episode.result()


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
