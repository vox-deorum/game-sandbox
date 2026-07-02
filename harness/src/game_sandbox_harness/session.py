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

import contextlib
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol, cast, runtime_checkable

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


class IllegalAgentActionError(RuntimeError):
    """Raised when an agent returns an action the environment would reject as an illegal move.

    The loop rejects it at the action boundary and charges the fault to the acting seat, instead of
    letting ``env.step`` raise with no attribution — which would smear the failure across every seat
    sharing the container. A move that passes the boundary but still makes ``env.step`` raise is a
    genuine environment fault, owned by no seat.
    """


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
    #: The one seat a failure is chargeable to: the slot whose agent raised, or whose own per-episode
    #: budget overran. ``None`` for a clean episode, or a container-level fault no single seat owns. The
    #: orchestrator reads it to charge a crash or budget overage to that seat alone, never to every
    #: competitor sharing the container.
    failed_slot: str | None = None


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
        self._failed_slot: str | None = None

    def start(self) -> None:
        """Reset the environment, open the recording, then reset the agents.

        The env is created here, not in ``__init__``, so a failure in ``env.reset`` or an
        agent's ``reset`` still leaves a constructed :class:`Episode` whose :meth:`close` can
        run; callers using the context-manager form get that for free.

        The recording header is opened *after* the environment resets but *before* the participants
        reset, and each participant ``reset`` is charged to its own seat. So an agent whose ``reset``
        raises is attributed to that one seat (:attr:`failed_slot`) over a readable recording, rather
        than looking like an unowned infrastructure fault that yields no recording at all. A failure
        in ``env.reset`` itself, before any seat has been touched, stays unowned by design.

        Any startup failure closes the half-opened recording writer and the constructed env before
        re-raising: a context-manager caller (``run_episode``) never reaches ``__exit__`` when
        ``__enter__`` raises, so without this the writer's file handle and the env would leak.
        :meth:`close` is idempotent and leaves :attr:`failed_slot` intact, so the live runner's own
        best-effort close and a charged reset crash both keep working.
        """
        try:
            env = self._entry.make()
            self._env = env
            env.reset(seed=self._seed)

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

            for slot_id, binding in self._slots.items():
                if isinstance(binding, AgentSlot):
                    try:
                        binding.agent.reset(self._seed)
                    except Exception:  # noqa: BLE001 - charge a reset crash to this seat, then re-raise
                        self._failed_slot = slot_id
                        raise
        except Exception:  # noqa: BLE001 - release the half-opened recording/env, then re-raise as-is
            # Suppress any close fault so it never masks the original startup error (which the headless
            # caller still receives and which carries the seat attribution set just above).
            with contextlib.suppress(Exception):
                self.close()
            raise

    @property
    def done(self) -> bool:
        """Whether the loop should stop: the env has no acting agents, or a check tripped."""
        return self._stopped or not self._env.agents

    @property
    def tick(self) -> int:
        """The number of steps recorded so far."""
        return self._tick

    @property
    def failed_slot(self) -> str | None:
        """The seat at fault, or ``None``: the slot whose agent raised, or whose budget overran.

        Set the instant a seat is to blame so the live runner can name it in the result envelope even
        while a crashing agent's exception is propagating out of the loop. The orchestrator charges the
        failure to that one seat instead of to every competitor sharing the container.
        """
        return self._failed_slot

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
        observation, _reward, termination, truncation, info = env.last()

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
            try:
                action = binding.agent.act(observation)
            except Exception:  # noqa: BLE001 - charge the crash to this seat, then re-raise unchanged
                self._failed_slot = slot_id
                raise
            decision_ms = self._clock.now_ms() - step_start
            agent_compute_ms += decision_ms
            slot.budget_used_ms += decision_ms
            if decision_ms > self._step_limit:
                action = self._entry.default_action(slot_id)
            else:
                # The agent supplied this action itself (within budget, not a timeout default). If the
                # environment would reject it as an illegal move, that is this seat's fault: name the
                # seat and refuse the action here, so a raise from env.step does not smear the failure
                # across every competitor in the container. A move that clears this gate but still
                # makes env.step raise is a genuine environment fault, left owned by no seat.
                reason = _illegal_action_reason(env, slot_id, observation, info, action)
                if reason is not None:
                    self._failed_slot = slot_id
                    raise IllegalAgentActionError(f"{slot_id} returned an illegal action: {reason}")
        else:
            deadline_ms = _external_deadline(self._entry, binding, self._clock)
            action = binding.source.get_action(slot_id, observation, deadline_ms)
            # A human seat is never charged the way an agent is. Both no input in time (``None``) and an
            # action the environment would reject as illegal fall back to the environment default rather
            # than reaching env.step and crashing the shared session. The UI only ever sends legal cards,
            # but a hand-rolled transport client could send an out-of-space or masked-out action; that
            # must not take down every other seat in the container.
            if action is None:
                logging.info(f"human slot {slot_id} defaulted due to no input in time")
                action = self._entry.default_action(slot_id)
            else:
                illegal_reason = _illegal_action_reason(env, slot_id, observation, info, action)
                if illegal_reason is not None:
                    logging.info(f"human slot {slot_id} defaulted due to illegal input: {illegal_reason}")
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
            try:
                binding.agent.learn(observation, action, reward, terminated_now)
            except Exception:  # noqa: BLE001 - charge the crash to this seat, then re-raise unchanged
                self._failed_slot = slot_id
                raise
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
            # The slot that overran owns the overage, so the orchestrator charges it to this seat alone.
            self._failed_slot = slot_id
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
            failed_slot=self._failed_slot,
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


def _illegal_action_reason(env: Any, slot_id: str, observation: Any, info: Any, action: Any) -> str | None:
    """Why ``action`` is an illegal move for ``slot_id``, or ``None`` if it is acceptable.

    Environment-agnostic, built only on the two standard PettingZoo legality signals and never on any
    environment-specific knowledge:

    * the slot's action space decides membership — an action the space does not contain is illegal,
      since the agent contract is that ``act`` returns an action in the environment's action space; and
    * for an environment that follows the AEC illegal-move convention, the ``action_mask`` decides
      per-action legality — an in-range index the mask flags ``0`` is illegal.

    Anything this cannot disprove — an environment exposing no action space or publishing no mask, or
    an action that does not index the mask — is deliberately left for ``env.step`` to judge, so a
    genuine fault on an otherwise-legal action stays owned by no seat rather than blamed on this one.
    """
    space_fn: Any = getattr(env, "action_space", None)
    if space_fn is not None:
        try:
            contained = bool(space_fn(slot_id).contains(action))
        except Exception:  # noqa: BLE001 - a space that cannot judge the action does not get to veto it
            contained = True
        if not contained:
            return f"action {action!r} is outside the slot's action space"
    mask = _action_mask(info, observation)
    if mask is not None:
        try:
            index = int(action)
        except (TypeError, ValueError):
            index = None
        if index is not None and 0 <= index < len(mask) and not mask[index]:
            return f"action {action!r} is not in the legal-move mask"
    return None


def _action_mask(info: Any, observation: Any) -> Any:
    """The per-action legality mask for this step, or ``None`` when the environment publishes none.

    The AEC API permits the mask in either the ``info`` or the ``observation`` dict, by environment:
    PettingZoo's Classic games carry it as ``observation["action_mask"]`` while Shimmy's OpenSpiel
    wrapper carries it as ``info["action_mask"]``. The canonical AEC loop consults ``info`` first and
    falls back to the observation, so this does the same; otherwise an OpenSpiel illegal move would slip
    past the boundary unattributed (https://pettingzoo.farama.org/api/aec/#action-masking).
    """
    if isinstance(info, Mapping):
        mask: Any = cast("Mapping[Any, Any]", info).get("action_mask")
        if mask is not None:
            return mask
    if isinstance(observation, Mapping):
        return cast("Mapping[Any, Any]", observation).get("action_mask")
    return None


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
