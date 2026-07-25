"""The single session loop and the step machinery beneath it.

One loop serves realtime and turn-based environments alike: each step asks the acting player
for an action under a deadline and applies the environment-provided default action if the
deadline passes. The realtime-versus-turn-based difference is the environment's pace
interval, which is a Stage 3 live-session pacing concern; the machinery here has no pacing
and steps as fast as the acting player produces actions.

The machinery is exposed as an :class:`Episode`: it owns the reset env, the recording writer,
and the per-player accounting, and advances exactly one PettingZoo cycle per
:meth:`Episode.step_once`. :func:`run_episode` is a thin loop over it
(``while not episode.done: episode.step_once()``),
and Stage 3's live runner is a second thin loop over the *same* ``step_once`` that adds wall-clock
pacing and pause/stop handling around it — one code path, the pace interval the only branch. The
Stage 2 determinism fixtures are the regression gate for this split: a recording produced through
:class:`Episode` is byte-identical to the pre-refactor loop.

A player is bound either to a loaded agent (:class:`AgentPlayer`, governed by the cooperative
agent-timeout machinery) or to an external action source (:class:`ExternalPlayer`, which is
what "human" means to the harness). The two paths are deliberately separate: external players
never consult the per-step agent limit and their ``None`` fallback involves no measurement
or overage accounting.
"""

from __future__ import annotations

import contextlib
import sys
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol, cast, runtime_checkable

from .agent import has_chat, has_learn
from .chat import ChatRouter
from .clock import Clock, SystemClock
from .environment import (
    EnvironmentEntry,
    ParameterValue,
    resolve_layout,
    validate_complete_parameters,
)
from .recording import RecordingStore
from .state import (
    Message,
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
    """A source of actions for an external (human-controlled) player.

    ``get_action`` may block up to ``deadline_ms`` (Stage 3's transport-backed source will);
    ``deadline_ms`` is ``None`` when no deadline applies. Returning ``None`` means no input
    arrived in time, and the loop applies the environment's default action for the player.
    """

    def get_action(self, player_id: str, observation: Any, deadline_ms: int | None) -> Any: ...


@runtime_checkable
class MessageSource(Protocol):
    """A source of queued outgoing messages for an external player."""

    def take_messages(self, player_id: str) -> list[dict[str, Any]]: ...


@runtime_checkable
class AgentExecutionScope(Protocol):
    """Activate one agent's execution scope at setup and turn ownership boundaries.

    Live LLM sessions use this seam to select player credentials and publish tick markers. Keeping
    the scope optional on :class:`AgentPlayer` leaves headless and non-LLM callers on their existing
    path without environment changes or network operations.
    """

    def setup(self, player_id: str) -> None: ...

    def turn(self, player_id: str, tick: int) -> None: ...

    def inflight_ms(self, player_id: str) -> int | None: ...


class NoopSource:
    """An :class:`ActionSource` that never supplies input; the loop always defaults."""

    def get_action(self, player_id: str, observation: Any, deadline_ms: int | None) -> Any:
        return None


class ScriptedSource:
    """An :class:`ActionSource` that replays a fixed list of actions, then yields ``None``."""

    def __init__(self, actions: list[Any]) -> None:
        self._actions = list(actions)
        self._index = 0

    def get_action(self, player_id: str, observation: Any, deadline_ms: int | None) -> Any:
        if self._index >= len(self._actions):
            return None
        action = self._actions[self._index]
        self._index += 1
        return action


@dataclass(frozen=True)
class AgentPlayer:
    """A PettingZoo player driven by a loaded agent, under agent-timeout machinery."""

    agent: Any
    execution_scope: AgentExecutionScope | None = None


@dataclass(frozen=True)
class ExternalPlayer:
    """A PettingZoo player fed from outside the harness, usually a human player.

    ``timeout_ms`` defaults to the environment's ``human_timeout_ms``; when the environment
    has a pace interval, the interval is the deadline instead. ``message_source`` is explicit
    and optional so an action transport is not implicitly treated as a chat transport merely
    because it happens to expose a similarly named method.
    """

    source: ActionSource
    timeout_ms: int | None = None
    message_source: MessageSource | None = None


Player = AgentPlayer | ExternalPlayer


@dataclass(frozen=True)
class EpisodeResult:
    """The outcome of one episode."""

    ticks: int
    scores: dict[str, float]
    reason: str
    step_timeouts: dict[str, int]
    recording_id: str | None = None
    #: The one player a failure is chargeable to: the player whose agent raised, or whose own per-episode
    #: budget overran. ``None`` for a clean episode, or a container-level fault no single seat owns. The
    #: orchestrator reads it to charge a crash or budget overage to that seat alone, never to every
    #: competitor sharing the container.
    failed_player: str | None = None


@dataclass
class _PlayerState:
    """Per-player mutable accounting for one episode."""

    score: float = 0.0
    budget_used_ms: float = 0.0
    step_timeouts: int = 0


@dataclass
class _StepContext:
    """Mutable values carried through one ordered :meth:`Episode.step_once` cycle."""

    env: Any
    player_id: str
    observation: Any
    info: Any
    binding: Player
    player: _PlayerState
    started_at: int
    action: Any = None
    decision_ms: float | None = None
    agent_compute_ms: float = 0.0
    chat_ms: float | None = None
    messages: list[Message] = field(default_factory=list[Message])
    reward: float = 0.0
    learn_ms: float | None = None


def _iso_utc(ms: int) -> str:
    """Render epoch milliseconds as an ISO-8601 UTC date-time string."""
    return datetime.fromtimestamp(ms / 1000, tz=UTC).isoformat()


class Episode:
    """One seeded episode's worth of step machinery, advanced one cycle at a time.

    Construct, :meth:`start` (reset the env and the agents, open the recording), then drive
    ``while not episode.done: episode.step_once()`` and read :meth:`result`. :meth:`close`
    flushes the recording and closes the env; the context-manager form pairs ``start`` with it.

    Each :meth:`step_once` runs exactly one PettingZoo agent-environment cycle: it obtains an
    action for the acting player (agent or external path), steps the environment, calls the
    optional ``learn`` hook, assembles one per-step state, writes it through the store when one
    is given, and applies the budget and step-cap termination checks. The live runner shares
    this method verbatim and only wraps pacing and pause/stop around the loop.
    """

    def __init__(
        self,
        entry: EnvironmentEntry,
        players: Mapping[str, Player],
        *,
        seed: int,
        parameters: Mapping[str, ParameterValue],
        store: RecordingStore | None = None,
        recording_id: str | None = None,
        clock: Clock | None = None,
        cpu_clock_ms: Callable[[], float] | None = None,
        step_limit_ms: int | None = None,
        episode_limit_ms: int | None = None,
        max_steps: int | None = None,
        player_attribution: Mapping[str, PlayerAttribution] | None = None,
        messaging: bool | None = None,
        message_cap: int | None = None,
    ) -> None:
        self._entry = entry
        self._players = players
        self._seed = seed
        self._store = store
        self._recording_id = recording_id
        self._player_attribution = player_attribution
        self._clock = clock or SystemClock()
        self._cpu_clock_ms = cpu_clock_ms or (lambda: time.thread_time_ns() / 1_000_000)
        self._step_limit = step_limit_ms if step_limit_ms is not None else entry.meta.step_limit_ms
        self._episode_limit = (
            episode_limit_ms if episode_limit_ms is not None else entry.meta.episode_limit_ms
        )
        self._max_steps = max_steps
        # The launch configuration is produced by a caller that already resolved every value, so a
        # missing name is an upstream bug rather than a request to substitute a default.
        self._parameters = validate_complete_parameters(entry.meta, parameters)

        # Messaging is enabled only when the environment metadata AND the session config agree, and
        # the effective cap is the minimum of the two, so a config override can disable or tighten but
        # never enable messaging on an environment that opted out. Combined once here, the single
        # authority; live.py reads the result back through ``messaging_enabled``. With messaging off no
        # router exists and the loop is byte-identical to a pre-chat run.
        self._messaging = entry.meta.messaging and (messaging if messaging is not None else True)
        caps = [c for c in (entry.meta.message_cap, message_cap) if c is not None]
        self._message_cap = min(caps) if caps else None
        self._chat: ChatRouter | None = (
            ChatRouter(players.keys(), self._message_cap) if self._messaging else None
        )

        self._state = {player_id: _PlayerState() for player_id in players}
        self._env: Any = None
        self._writer: Any = None
        self._writer_cm: Any = None
        self._reason = REASON_TERMINATED
        self._tick = 0
        self._stopped = False
        self._failed_player: str | None = None
        self._inflight_snapshots: dict[str, int] = {}

    def start(self) -> None:
        """Reset the environment, open the recording, then reset the agents.

        The env is created here, not in ``__init__``, so a failure in ``env.reset`` or an
        agent's ``reset`` still leaves a constructed :class:`Episode` whose :meth:`close` can
        run; callers using the context-manager form get that for free.

        The recording header is opened *after* the environment resets but *before* the participants
        reset, and each participant ``reset`` is charged to its own seat. So an agent whose ``reset``
        raises is attributed to that one seat (:attr:`failed_player`) over a readable recording, rather
        than looking like an unowned infrastructure fault that yields no recording at all. A failure
        in ``env.reset`` itself, before any seat has been touched, stays unowned by design.

        Any startup failure closes the half-opened recording writer and the constructed env before
        re-raising: a context-manager caller (``run_episode``) never reaches ``__exit__`` when
        ``__enter__`` raises, so without this the writer's file handle and the env would leak.
        :meth:`close` is idempotent and leaves :attr:`failed_player` intact, so the live runner's own
        best-effort close and a charged reset crash both keep working.
        """
        try:
            env = self._entry.make(self._parameters)
            self._env = env
            env.reset(seed=self._seed)
            layout = resolve_layout(self._entry.meta, self._parameters)
            expected_players = [f"player_{index}" for index in range(layout.player_count)]
            if env.possible_agents != expected_players:
                raise ValueError(
                    "environment factory produced possible_agents "
                    f"{env.possible_agents!r}, expected {expected_players!r} from resolved layout"
                )

            if self._store is not None:
                created_at_ms = self._clock.now_ms()
                if self._recording_id is None:
                    self._recording_id = f"{self._entry.meta.env_id}-seed{self._seed}-{created_at_ms}"
                header = build_header(
                    environment=self._entry.meta.env_id,
                    seed=self._seed,
                    created_at=_iso_utc(created_at_ms),
                    parameters=self._parameters,
                    players=dict(self._player_attribution) if self._player_attribution is not None else None,
                )
                self._writer_cm = self._store.create(self._recording_id, header)
                self._writer = self._writer_cm.__enter__()

            for player_id, binding in self._players.items():
                if isinstance(binding, AgentPlayer):
                    try:
                        if binding.execution_scope is not None:
                            binding.execution_scope.setup(player_id)
                        binding.agent.reset(self._seed)
                    except Exception:  # noqa: BLE001 - charge a reset crash to this seat, then re-raise
                        self._failed_player = player_id
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
    def failed_player(self) -> str | None:
        """The seat at fault, or ``None``: the player whose agent raised, or whose budget overran.

        Set the instant a seat is to blame so the live runner can name it in the result envelope even
        while a crashing agent's exception is propagating out of the loop. The orchestrator charges the
        failure to that one seat instead of to every competitor sharing the container.
        """
        return self._failed_player

    @property
    def messaging_enabled(self) -> bool:
        """Whether messaging is effectively on (metadata AND config), resolved once in ``__init__``.

        The live runner reuses this to gate the human chat queue, so the AND/min combination has a
        single authority rather than being recomputed.
        """
        return self._messaging

    def opening_state(self) -> StepState | None:
        """The pre-action "opening" frame: the dealt overlay with no agent having acted yet.

        A turn-based environment can require the first acting player, possibly a connected human
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
        """Advance the acting player by exactly one PettingZoo cycle. See the class docstring."""
        env = self._env
        player_id = env.agent_selection
        observation, _reward, termination, truncation, info = env.last()

        if termination or truncation:
            self._reason = REASON_TRUNCATED if truncation else REASON_TERMINATED
            env.step(None)
            return

        binding = self._players[player_id]
        if isinstance(binding, AgentPlayer) and binding.execution_scope is not None:
            binding.execution_scope.turn(player_id, self._tick)

        context = _StepContext(
            env=env,
            player_id=player_id,
            observation=observation,
            info=info,
            binding=binding,
            player=self._state[player_id],
            started_at=self._clock.now_ms(),
        )
        self._select_action(context)

        self._collect_messages(context)
        self._apply_environment_step(context)
        self._run_learning(context)

        self._record_step(context)
        self._deliver_messages(context)
        self._finish_step(context)

    def _select_action(self, context: _StepContext) -> None:
        """Obtain and validate the action, applying defaults under the existing timeout rules."""
        binding = context.binding
        if isinstance(binding, AgentPlayer):
            try:
                context.action, context.decision_ms = self._timed_llm_hook(
                    binding.execution_scope,
                    context.player_id,
                    lambda: binding.agent.act(context.observation),
                )
            except Exception:  # noqa: BLE001 - charge the crash to this seat, then re-raise unchanged
                self._failed_player = context.player_id
                raise
            context.agent_compute_ms += context.decision_ms
            context.player.budget_used_ms += context.decision_ms
            if context.decision_ms > self._step_limit:
                context.action = self._entry.default_action(context.env, context.player_id)
                return
            reason = _illegal_action_reason(
                context.env,
                context.player_id,
                context.observation,
                context.info,
                context.action,
            )
            if reason is not None:
                self._failed_player = context.player_id
                raise IllegalAgentActionError(f"{context.player_id} returned an illegal action: {reason}")
            return

        deadline_ms = _external_deadline(self._entry, binding, self._clock)
        context.action = binding.source.get_action(context.player_id, context.observation, deadline_ms)
        if context.action is None:
            print(
                f"human player {context.player_id} defaulted due to no input in time",
                file=sys.stderr,
                flush=True,
            )
            context.action = self._entry.default_action(context.env, context.player_id)
            return
        illegal_reason = _illegal_action_reason(
            context.env,
            context.player_id,
            context.observation,
            context.info,
            context.action,
        )
        if illegal_reason is not None:
            print(
                f"human player {context.player_id} defaulted due to illegal input: {illegal_reason}",
                file=sys.stderr,
                flush=True,
            )
            context.action = self._entry.default_action(context.env, context.player_id)

    def _collect_messages(self, context: _StepContext) -> None:
        """Drain and validate chat after action selection but before the environment step."""
        if self._chat is None:
            return
        inbox = self._chat.drain(context.player_id)
        binding = context.binding
        if isinstance(binding, AgentPlayer) and has_chat(binding.agent):
            try:
                outgoing, context.chat_ms = self._timed_llm_hook(
                    binding.execution_scope,
                    context.player_id,
                    lambda: binding.agent.chat(inbox),
                )
            except Exception:  # noqa: BLE001 - charge the crash to this seat, then re-raise unchanged
                self._failed_player = context.player_id
                raise
            context.agent_compute_ms += context.chat_ms
            context.player.budget_used_ms += context.chat_ms
            context.messages.extend(self._chat.validate_outgoing(context.player_id, outgoing))

        for other_id, other_binding in self._players.items():
            if isinstance(other_binding, ExternalPlayer) and other_binding.message_source is not None:
                outgoing = other_binding.message_source.take_messages(other_id)
                context.messages.extend(self._chat.validate_outgoing(other_id, outgoing))

    def _apply_environment_step(self, context: _StepContext) -> None:
        """Apply the selected action and credit every reward published for the cycle."""
        context.env.step(context.action)
        context.reward = float(context.env.rewards[context.player_id])
        # Terminal rewards in an AEC environment can be published for every seat on the final
        # actor's step and then cleared by dead steps, so credit the entire reward mapping here.
        for rewarded_player, player_reward in context.env.rewards.items():
            rewarded_state = self._state.get(rewarded_player)
            if rewarded_state is not None:
                rewarded_state.score += float(player_reward)

    def _run_learning(self, context: _StepContext) -> None:
        """Run the post-step learning hook and finish per-step compute accounting."""
        binding = context.binding
        if isinstance(binding, AgentPlayer) and has_learn(binding.agent):
            terminated_now = bool(
                context.env.terminations[context.player_id] or context.env.truncations[context.player_id]
            )
            try:
                _, context.learn_ms = self._timed_llm_hook(
                    binding.execution_scope,
                    context.player_id,
                    lambda: binding.agent.learn(
                        context.observation,
                        context.action,
                        context.reward,
                        terminated_now,
                    ),
                )
            except Exception:  # noqa: BLE001 - charge the crash to this seat, then re-raise unchanged
                self._failed_player = context.player_id
                raise
            context.agent_compute_ms += context.learn_ms
            context.player.budget_used_ms += context.learn_ms

        if isinstance(binding, AgentPlayer) and context.agent_compute_ms > self._step_limit:
            context.player.step_timeouts += 1

    def _timed_llm_hook(
        self,
        scope: AgentExecutionScope | None,
        player_id: str,
        callback: Callable[[], Any],
    ) -> tuple[Any, float]:
        """Measure a hook while discounting verified official proxy request time.

        A valid post-hook snapshot becomes the next hook's baseline. Failed reads and hook errors
        clear that cache, so no discount crosses an unknown interval. Calling-thread CPU is always
        a lower bound.
        """
        if scope is None:
            started = self._clock.now_ms()
            return callback(), self._clock.now_ms() - started

        before = self._inflight_snapshots.pop(player_id, None)
        if before is None:
            before = scope.inflight_ms(player_id)
        started = self._clock.now_ms()
        cpu_started = self._cpu_clock_ms()
        try:
            value = callback()
        except Exception:
            self._inflight_snapshots.pop(player_id, None)
            raise
        # Thread CPU is independent of the pausable wall clock, so local work remains chargeable.
        cpu_ms = max(0.0, self._cpu_clock_ms() - cpu_started)
        raw_ms = self._clock.now_ms() - started
        after = scope.inflight_ms(player_id)
        if after is not None:
            self._inflight_snapshots[player_id] = after
        else:
            self._inflight_snapshots.pop(player_id, None)
        if before is None or after is None:
            return value, max(cpu_ms, raw_ms)
        # A background request can overlap the hook's own computation. Never let proxy wall time
        # erase CPU consumed by the calling agent thread while the request was in flight. Thread CPU
        # avoids charging the acting player for an opponent's background work in this shared process.
        return value, max(cpu_ms, raw_ms - max(0, after - before))

    def _record_step(self, context: _StepContext) -> None:
        """Persist the completed cycle before accepted messages mutate recipient inboxes."""
        if self._writer is None:
            return
        overlay = self._entry.overlay(context.env) if self._entry.overlay is not None else None
        agent_step = build_agent_step(
            reward=context.reward,
            score=context.player.score,
            action=context.action,
            decision_ms=context.decision_ms,
            learn_ms=context.learn_ms,
            chat_ms=context.chat_ms,
        )
        self._writer.write_step(
            build_step_state(
                tick=self._tick,
                agents={context.player_id: agent_step},
                started_at=context.started_at,
                duration_ms=self._clock.now_ms() - context.started_at,
                overlay=overlay,
                messages=context.messages or None,
            )
        )

    def _deliver_messages(self, context: _StepContext) -> None:
        """Deliver this tick's accepted messages strictly after the environment step."""
        if self._chat is not None and context.messages:
            self._chat.deliver(context.messages, tick=self._tick)

    def _finish_step(self, context: _StepContext) -> None:
        """Advance the tick and apply episode-budget and step-cap checks last."""
        self._tick += 1
        if context.player.budget_used_ms > self._episode_limit:
            self._reason = REASON_EPISODE_LIMIT
            self._failed_player = context.player_id
            self._stopped = True
            return
        if self._max_steps is not None and self._tick >= self._max_steps:
            # Preserve a natural terminal outcome when it lands on the tick that reaches the cap.
            self._reason = (
                REASON_TERMINATED if context.env.terminations[context.player_id] else REASON_TRUNCATED
            )
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
            scores={player_id: self._state[player_id].score for player_id in self._players},
            reason=self._reason,
            step_timeouts={player_id: self._state[player_id].step_timeouts for player_id in self._players},
            recording_id=self._recording_id if self._store is not None else None,
            failed_player=self._failed_player,
        )

    def __enter__(self) -> Episode:
        self.start()
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.close()


def run_episode(
    entry: EnvironmentEntry,
    players: Mapping[str, Player],
    *,
    seed: int,
    parameters: Mapping[str, ParameterValue],
    store: RecordingStore | None = None,
    recording_id: str | None = None,
    clock: Clock | None = None,
    cpu_clock_ms: Callable[[], float] | None = None,
    step_limit_ms: int | None = None,
    episode_limit_ms: int | None = None,
    max_steps: int | None = None,
    player_attribution: Mapping[str, PlayerAttribution] | None = None,
    messaging: bool | None = None,
    message_cap: int | None = None,
) -> EpisodeResult:
    """Play one seeded episode of ``entry`` with the given player bindings.

    A thin headless loop over :class:`Episode`: reset seeds everything (the environment via
    ``reset(seed=seed)`` and every agent via its own ``reset(seed)``), then drive PettingZoo's
    agent-environment cycle to its end, recording through the store when one is given.
    Recording is optional so the evaluation pattern (run many seeds, keep scores, store
    nothing) shares this exact code path. This loop never paces and never pauses; that is the
    live runner's job, layered around the same :meth:`Episode.step_once`.
    """
    with Episode(
        entry,
        players,
        seed=seed,
        store=store,
        recording_id=recording_id,
        clock=clock,
        cpu_clock_ms=cpu_clock_ms,
        step_limit_ms=step_limit_ms,
        episode_limit_ms=episode_limit_ms,
        max_steps=max_steps,
        player_attribution=player_attribution,
        messaging=messaging,
        message_cap=message_cap,
        parameters=parameters,
    ) as episode:
        while not episode.done:
            episode.step_once()
    return episode.result()


def _illegal_action_reason(env: Any, player_id: str, observation: Any, info: Any, action: Any) -> str | None:
    """Why ``action`` is an illegal move for ``player_id``, or ``None`` if it is acceptable.

    Environment-agnostic, built only on the two standard PettingZoo legality signals and never on any
    environment-specific knowledge:

    * the player's action space decides membership — an action the space does not contain is illegal,
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
            contained = bool(space_fn(player_id).contains(action))
        except Exception:  # noqa: BLE001 - a space that cannot judge the action does not get to veto it
            contained = True
        if not contained:
            return f"action {action!r} is outside the player's action space"
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


def _external_deadline(entry: EnvironmentEntry, binding: ExternalPlayer, clock: Clock) -> int | None:
    """Compute the wall-clock deadline for an external player, or ``None`` for no deadline.

    A set pace interval is itself the human deadline; otherwise the player's own ``timeout_ms``
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
