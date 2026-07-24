"""The live session runner: ``python -m game_sandbox_harness.live``.

This is the container side of a Stage 3 live session. It reads a single JSON config from argv,
resolves the environment from the in-image registry, binds each slot to either the transport
(an external/human slot) or a built-in agent, and drives the Stage 2 :class:`Episode` machinery
under wall-clock pacing with pause and stop. State lines stream out on the protocol stdout and
are simultaneously written to the recording on the mounted volume; one ``result`` envelope is
emitted at the end.

The live loop is a second thin loop over the very same :meth:`Episode.step_once` that the
headless ``run_episode`` uses. The only realtime-versus-turn-based difference is one conditional
on the environment's pace interval: a paced environment waits for the next cadence instant before
each step; a turn-based one does not, and its external source blocks for input instead. Pause is a
cooperative wait shared by both, and because the injected :class:`PausableClock` freezes while
paused, the cadence instant and every measured duration freeze with it.

Module-level imports stay free of environment packages so :func:`main` can claim stdout
*before* anything imports a game; the environment is loaded only inside :func:`main`,
after that redirection is in place.
"""

from __future__ import annotations

import contextlib
import json
import math
import os
import sys
import urllib.request
from collections.abc import Iterable
from dataclasses import dataclass
from typing import IO, Any, cast

from .clock import SystemClock
from .environment import EnvironmentEntry, ParameterValue, load_environment
from .live_io import (
    PausableClock,
    ProtocolStream,
    RealSleeper,
    SessionControl,
    Sleeper,
    TransportSource,
    build_tee_store,
    result_envelope,
    start_command_pump,
)
from .manifest import load_agent
from .recording import RecordingStore
from .session import REASON_STOPPED, AgentSlot, Episode, ExternalSlot, Slot
from .state import PlayerAttribution

#: Where the session base image stages the built-in agents the watch-style runs load, one
#: per-environment directory beneath this base (``/opt/agents/builtin/<env_id>``). A slot with no
#: explicit overlay path takes the baseline for the session's own environment, since the Naive
#: policy is environment-specific (see each baseline's ``agent.py``).
DEFAULT_BUILTIN_AGENT_BASE = "/opt/agents/builtin"
#: Cooperative wait granularity. Small enough that stop and resume stay responsive.
_SLICE_MS = 5
#: Tick markers are local control-plane requests and must never hold the participant loop open for
#: an unbounded period when the proxy is unavailable.
_MARKER_TIMEOUT_SECONDS = 2.0


class LiveConfigError(ValueError):
    """Raised when the session config argument is missing, malformed, or self-inconsistent."""


class UnsetTimeout:
    """The absent timeout wire state, distinct from JSON null (which disables it)."""


UNSET_TIMEOUT = UnsetTimeout()


@dataclass(frozen=True)
class SlotBinding:
    """How one slot is driven: ``external`` (transport) or ``builtin-agent`` (a loaded agent)."""

    kind: str
    path: str | None = None


@dataclass(frozen=True)
class LlmConfig:
    """OpenAI-compatible endpoint and per-agent credentials for an official LLM session."""

    base_url: str
    tick_url: str
    inflight_url: str
    keys: dict[str, str]


@dataclass(frozen=True)
class LiveConfig:
    """The parsed session config carried in argv.

    Environment facts — pace interval, time limits, the default human timeout — come from the
    in-image registry, so this config carries only the session's own choices and overrides:
    which environment and seed, how each slot is driven, the resolved human-slot timeout (an
    override, or ``None`` to take the metadata default), and where to record.
    """

    env_id: str
    seed: int
    slots: dict[str, SlotBinding]
    human_timeout_ms: int | None | UnsetTimeout
    recording_dir: str
    recording_id: str | None
    #: Complete resolved parameter map required by every launch path.
    parameters: dict[str, ParameterValue]
    #: Per-slot attribution copied verbatim into the recording header (slot id -> attribution
    #: object). It exactly covers the configured slots and agrees with each binding kind.
    players: dict[str, PlayerAttribution] | None = None
    #: Optional per-step/per-episode time-limit overrides (the Stage 6 season overrides).
    #: ``None`` takes the environment's metadata default, as a session with no override does.
    step_timeout_ms: int | None = None
    episode_timeout_ms: int | None = None
    #: Effective session-level messaging config from the backend (metadata AND override). ``None``
    #: leaves the environment metadata to decide; the harness combines defensively, so a value here
    #: can only disable or tighten, never enable messaging on an environment that opted out.
    messaging_enabled: bool | None = None
    message_cap: int | None = None
    #: Workflow containers set this to run as fast as the agents compute, without live pacing.
    headless: bool = False
    #: Absent for ordinary sessions. The key map covers agent slots exactly and excludes humans.
    llm: LlmConfig | None = None
    #: Emit the header and opening state, then wait for a resume command before the first step.
    start_paused: bool = False
    #: Optional local-play step cap. Production launch configs omit it.
    max_steps: int | None = None


def parse_config(argv: list[str]) -> LiveConfig:
    """Parse and validate the single-JSON-argument session config from ``argv``."""
    if len(argv) != 1:
        raise LiveConfigError(f"expected exactly one JSON config argument, got {len(argv)} argument(s)")
    try:
        raw: object = json.loads(argv[0])
    except json.JSONDecodeError as error:
        raise LiveConfigError(f"config is not valid JSON: {error}") from error
    if not isinstance(raw, dict):
        raise LiveConfigError(f"config must be a JSON object, got {type(raw).__name__}")
    config = cast("dict[str, Any]", raw)

    env_id = config.get("env_id")
    if not isinstance(env_id, str) or not env_id:
        raise LiveConfigError("config 'env_id' must be a non-empty string")

    seed = config.get("seed", 0)
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise LiveConfigError("config 'seed' must be an integer")

    raw_slots = config.get("slots")
    if not isinstance(raw_slots, dict) or not raw_slots:
        raise LiveConfigError("config 'slots' must be a non-empty object keyed by slot id")
    slots: dict[str, SlotBinding] = {}
    for slot_id, raw_binding in cast("dict[str, Any]", raw_slots).items():
        if not isinstance(raw_binding, dict):
            raise LiveConfigError(f"config slot {slot_id!r} must be an object")
        binding = cast("dict[str, Any]", raw_binding)
        kind = binding.get("kind")
        if kind not in ("external", "builtin-agent"):
            raise LiveConfigError(
                f"config slot {slot_id!r} has kind {kind!r}; expected 'external' or 'builtin-agent'"
            )
        path = binding.get("path")
        if path is not None and not isinstance(path, str):
            raise LiveConfigError(f"config slot {slot_id!r} 'path' must be a string when present")
        slots[slot_id] = SlotBinding(kind=kind, path=path)

    if "human_timeout_ms" not in config:
        human_timeout_ms: int | None | UnsetTimeout = UNSET_TIMEOUT
    else:
        human_timeout_ms = config["human_timeout_ms"]
        if human_timeout_ms is not None and (
            not isinstance(human_timeout_ms, int) or isinstance(human_timeout_ms, bool)
        ):
            raise LiveConfigError("config 'human_timeout_ms' must be an integer or null")

    recording_dir = config.get("recording_dir")
    if not isinstance(recording_dir, str) or not recording_dir:
        raise LiveConfigError("config 'recording_dir' must be a non-empty string")

    recording_id = config.get("recording_id")
    if recording_id is not None and not isinstance(recording_id, str):
        raise LiveConfigError("config 'recording_id' must be a string or null")

    if "parameters" not in config:
        raise LiveConfigError("config 'parameters' must be an object")
    raw_parameters = config["parameters"]
    parameter_items = cast("dict[object, object]", raw_parameters)
    if not isinstance(raw_parameters, dict) or not all(
        isinstance(name, str) and _is_parameter_value(value) for name, value in parameter_items.items()
    ):
        raise LiveConfigError(
            "config 'parameters' must contain booleans, finite numbers, strings, or string lists"
        )
    parameters = cast("dict[str, ParameterValue]", raw_parameters)

    players = _parse_players(config.get("players"), slots)
    step_timeout_ms = _parse_optional_int(config, "step_timeout_ms")
    episode_timeout_ms = _parse_optional_int(config, "episode_timeout_ms")
    message_cap = _parse_optional_int(config, "message_cap")
    max_steps = _parse_max_steps(config.get("max_steps"))
    messaging_enabled = config.get("messaging_enabled")
    if messaging_enabled is not None and not isinstance(messaging_enabled, bool):
        raise LiveConfigError("config 'messaging_enabled' must be a boolean or null")
    headless = config.get("headless", False)
    if not isinstance(headless, bool):
        raise LiveConfigError("config 'headless' must be a boolean")
    start_paused = config.get("start_paused", False)
    if not isinstance(start_paused, bool):
        raise LiveConfigError("config 'start_paused' must be a boolean")
    llm = _parse_llm(config.get("llm"), slots)

    return LiveConfig(
        env_id=env_id,
        seed=seed,
        slots=slots,
        human_timeout_ms=human_timeout_ms,
        recording_dir=recording_dir,
        recording_id=recording_id,
        parameters=parameters,
        players=players,
        step_timeout_ms=step_timeout_ms,
        episode_timeout_ms=episode_timeout_ms,
        messaging_enabled=messaging_enabled,
        message_cap=message_cap,
        headless=headless,
        llm=llm,
        start_paused=start_paused,
        max_steps=max_steps,
    )


def _is_parameter_value(value: object) -> bool:
    """Check the shallow JSON shape before environment-aware resolution in ``Episode``."""
    if isinstance(value, (bool, str)):
        return True
    if isinstance(value, (int, float)):
        return math.isfinite(value)
    return isinstance(value, list) and all(isinstance(item, str) for item in cast("list[object]", value))


def _parse_optional_int(config: dict[str, Any], key: str) -> int | None:
    """Validate an optional positive-integer config value, defaulting to ``None`` when absent."""
    value = config.get(key)
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool):
        raise LiveConfigError(f"config {key!r} must be an integer or null")
    return value


def _parse_max_steps(value: object) -> int | None:
    """Parse an optional positive local-play step cap."""
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise LiveConfigError("config 'max_steps' must be a positive integer or null")
    return value


def _parse_players(raw: object, slots: dict[str, SlotBinding]) -> dict[str, PlayerAttribution]:
    """Validate the required, binding-aligned per-slot ``players`` attribution map.

    Each entry must name a ``kind`` of ``human`` or ``agent`` and a non-empty ``label``; ``user``
    and ``submission_id`` are optional strings. The validated entries are passed through verbatim
    into the recording header, so the harness keeps no opinion on their meaning beyond being
    well-formed.
    """
    if not isinstance(raw, dict):
        raise LiveConfigError("config 'players' must be an object keyed by slot id")
    raw_players = cast("dict[str, object]", raw)
    if set(raw_players) != set(slots):
        missing = sorted(set(slots) - set(raw_players))
        unknown = sorted(set(raw_players) - set(slots))
        details: list[str] = []
        if missing:
            details.append(f"missing slots {missing!r}")
        if unknown:
            details.append(f"unknown slots {unknown!r}")
        raise LiveConfigError(f"config 'players' must exactly cover configured slots ({'; '.join(details)})")
    players: dict[str, PlayerAttribution] = {}
    for slot_id, raw_entry in raw_players.items():
        if not isinstance(raw_entry, dict):
            raise LiveConfigError(f"config player {slot_id!r} must be an object")
        entry = cast("dict[str, object]", raw_entry)
        kind = entry.get("kind")
        if kind not in ("human", "agent"):
            raise LiveConfigError(f"config player {slot_id!r} has kind {kind!r}; expected 'human' or 'agent'")
        label = entry.get("label")
        if not isinstance(label, str) or not label:
            raise LiveConfigError(f"config player {slot_id!r} 'label' must be a non-empty string")
        for optional in ("user", "submission_id"):
            value = entry.get(optional)
            if value is not None and not isinstance(value, str):
                raise LiveConfigError(f"config player {slot_id!r} {optional!r} must be a string when present")
        expected_kind = "human" if slots[slot_id].kind == "external" else "agent"
        if kind != expected_kind:
            raise LiveConfigError(
                f"config player {slot_id!r} has kind {kind!r}; expected {expected_kind!r} for its slot"
            )
        players[slot_id] = cast("PlayerAttribution", entry)
    return players


def _parse_llm(raw: object, slots: dict[str, SlotBinding]) -> LlmConfig | None:
    """Validate the optional LLM launch block and its agent-slot key coverage."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise LiveConfigError("config 'llm' must be an object or null")
    llm = cast("dict[str, Any]", raw)
    expected_fields = {"base_url", "tick_url", "inflight_url", "keys"}
    if set(llm) != expected_fields:
        missing = sorted(expected_fields - set(llm))
        unknown = sorted(set(llm) - expected_fields)
        details: list[str] = []
        if missing:
            details.append(f"missing {missing!r}")
        if unknown:
            details.append(f"unknown {unknown!r}")
        raise LiveConfigError(
            "config 'llm' must contain exactly base_url, tick_url, inflight_url, and keys "
            f"({'; '.join(details)})"
        )

    for field_name in ("base_url", "tick_url", "inflight_url"):
        value = llm[field_name]
        if not isinstance(value, str) or not value:
            raise LiveConfigError(f"config 'llm' {field_name!r} must be a non-empty string")
    raw_keys = llm["keys"]
    if not isinstance(raw_keys, dict):
        raise LiveConfigError("config 'llm' 'keys' must be an object keyed by agent slot id")
    keys = cast("dict[str, Any]", raw_keys)
    for slot_id, key in keys.items():
        if not isinstance(key, str) or not key:
            raise LiveConfigError(f"config 'llm' key for {slot_id!r} must be a non-empty string")

    agent_slots = {slot_id for slot_id, binding in slots.items() if binding.kind == "builtin-agent"}
    supplied_slots = set(keys)
    if supplied_slots != agent_slots:
        missing = sorted(agent_slots - supplied_slots)
        unknown = sorted(supplied_slots - agent_slots)
        details: list[str] = []
        if missing:
            details.append(f"missing agent slots {missing!r}")
        if unknown:
            details.append(f"unknown or non-agent slots {unknown!r}")
        raise LiveConfigError(
            f"config 'llm' keys must exactly cover configured agent slots ({'; '.join(details)})"
        )

    return LlmConfig(
        base_url=cast("str", llm["base_url"]),
        tick_url=cast("str", llm["tick_url"]),
        inflight_url=cast("str", llm["inflight_url"]),
        keys=cast("dict[str, str]", dict(keys)),
    )


class _LlmExecutionScope:
    """Select a slot credential and best-effort marker immediately before participant work."""

    def __init__(self, config: LlmConfig) -> None:
        self._config = config

    def setup(self, slot_id: str) -> None:
        self._activate(slot_id)
        self._post_marker(slot_id, {"phase": "setup"})

    def turn(self, slot_id: str, tick: int) -> None:
        self._activate(slot_id)
        self._post_marker(slot_id, {"tick": tick})

    def inflight_ms(self, slot_id: str) -> int | None:
        """Read the slot's proxy time, including a capped active partial, without making it fatal."""
        try:
            request = urllib.request.Request(
                self._config.inflight_url,
                headers={"Authorization": f"Bearer {self._config.keys[slot_id]}"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=_MARKER_TIMEOUT_SECONDS) as response:
                raw_payload: object = json.loads(response.read())
            if not isinstance(raw_payload, dict):
                raise ValueError("response must contain one non-negative integer inflight_ms")
            payload = cast("dict[str, object]", raw_payload)
            inflight_ms = payload.get("inflight_ms")
            if (
                set(payload) != {"inflight_ms"}
                or not isinstance(inflight_ms, int)
                or isinstance(inflight_ms, bool)
                or inflight_ms < 0
            ):
                raise ValueError("response must contain one non-negative integer inflight_ms")
            return inflight_ms
        except Exception as error:  # noqa: BLE001 - timing discount must never stop agent lifecycle
            print(
                f"live: LLM in-flight snapshot failed for slot {slot_id!r}: {error}",
                file=sys.stderr,
                flush=True,
            )
            return None

    def _activate(self, slot_id: str) -> None:
        os.environ["OPENAI_BASE_URL"] = self._config.base_url
        os.environ["OPENAI_API_KEY"] = self._config.keys[slot_id]

    def _post_marker(self, slot_id: str, payload: dict[str, str | int]) -> None:
        try:
            request = urllib.request.Request(
                self._config.tick_url,
                data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {self._config.keys[slot_id]}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            # The response body is unused. Closing after the headers arrive avoids draining a slow
            # body beyond the local marker timeout.
            with urllib.request.urlopen(request, timeout=_MARKER_TIMEOUT_SECONDS):
                pass
        except Exception as error:  # noqa: BLE001 - marker telemetry is deliberately best-effort
            print(
                f"live: LLM marker failed for slot {slot_id!r}: {error}",
                file=sys.stderr,
                flush=True,
            )


def build_slots(
    config: LiveConfig,
    entry: EnvironmentEntry,
    control: SessionControl,
    clock: PausableClock,
    sleeper: Sleeper,
) -> dict[str, Slot]:
    """Bind every configured slot to a harness :class:`Slot`.

    External slots get a :class:`TransportSource` over the command pump and carry the resolved
    human-slot timeout — the config override when given, otherwise the environment metadata
    default. Built-in-agent slots are loaded through the same manifest loader Stage 5 uses for
    submissions, from ``path`` or the image's default built-in agent location.
    """
    paced = not config.headless and entry.meta.pace_interval_ms is not None
    configured_timeout = config.human_timeout_ms
    resolved_timeout = (
        entry.meta.human_timeout_ms if isinstance(configured_timeout, UnsetTimeout) else configured_timeout
    )
    slots: dict[str, Slot] = {}
    execution_scope = _LlmExecutionScope(config.llm) if config.llm is not None else None
    for slot_id, binding in config.slots.items():
        if binding.kind == "external":
            source = TransportSource(control, clock=clock, paced=paced, sleeper=sleeper)
            slots[slot_id] = ExternalSlot(
                source,
                timeout_ms=resolved_timeout,
                message_source=source,
            )
        else:  # "builtin-agent" — parse_config rejects any other kind.
            agent_path = binding.path or f"{DEFAULT_BUILTIN_AGENT_BASE}/{config.env_id}"
            if execution_scope is not None:
                # Manifest loading imports the participant module and constructs its agent, so this
                # boundary must be activated before either operation can capture a client.
                execution_scope.setup(slot_id)
            agent = load_agent(agent_path)
            slots[slot_id] = AgentSlot(agent, execution_scope=execution_scope)
    return slots


def run_live_loop(
    episode: Episode,
    *,
    pace_interval_ms: int | None,
    control: SessionControl,
    clock: PausableClock,
    sleeper: Sleeper,
    slice_ms: int = _SLICE_MS,
) -> None:
    """Drive ``episode`` to its end under pacing, pause, and stop.

    A second thin loop over :meth:`Episode.step_once`. Before each step it waits out any pause
    (a frozen clock means the wait and the cadence below both freeze), then — the one pace-interval
    conditional — waits for the next cadence instant when the environment is realtime and not at
    all when it is turn-based. A ``stop`` command ends the run with reason ``stopped``.
    """
    next_instant = clock.now_ms()
    while not episode.done:
        # Pause is a cooperative wait shared by both cadences; the frozen clock does the rest.
        while control.paused and not control.stopping:
            sleeper.sleep_ms(slice_ms)
        if pace_interval_ms is not None:
            next_instant += pace_interval_ms
            while clock.now_ms() < next_instant and not control.stopping:
                sleeper.sleep_ms(slice_ms)
        if control.stopping:
            episode.stop(REASON_STOPPED)
            break
        episode.step_once()


def _claim_stdout() -> IO[str]:
    """Hand the real stdout to the protocol writer and redirect fd 1 onto stderr.

    Protocol lines must own stdout, while imported game or agent code may print to it. Done as the
    first thing in :func:`main`, before any environment import: ``dup`` the real stdout for the
    protocol writer, then ``dup2`` stderr over fd 1 so later diagnostic chatter lands in stderr
    instead of corrupting the protocol.
    """
    sys.stdout.flush()
    protocol_fd = os.dup(1)
    os.dup2(2, 1)
    return os.fdopen(protocol_fd, "w", encoding="utf-8", newline="\n")


def run(
    entry: EnvironmentEntry,
    config: LiveConfig,
    *,
    protocol: ProtocolStream,
    control: SessionControl,
    clock: PausableClock,
    sleeper: Sleeper,
    store: RecordingStore,
    command_lines: Iterable[str] | None = None,
) -> int:
    """Run one injected live episode without discovery or stdout ownership.

    When ``command_lines`` is supplied, its blocking command pump starts after :class:`Episode`
    has entered, emitted the recording header, and streamed any live-only opening state, but before
    the live loop begins. Keeping that boundary here leaves the loop directly testable without a
    stdin reader and lets local clients attach before Windows starts the blocking reader thread.
    """
    if config.start_paused:
        control.pause()
    episode: Episode | None = None
    try:
        slots = build_slots(config, entry, control, clock, sleeper)
        episode = Episode(
            entry,
            slots,
            seed=config.seed,
            store=store,
            recording_id=config.recording_id,
            clock=clock,
            step_limit_ms=config.step_timeout_ms,
            episode_limit_ms=config.episode_timeout_ms,
            players=config.players,
            messaging=config.messaging_enabled,
            message_cap=config.message_cap,
            max_steps=config.max_steps,
            parameters=config.parameters,
        )
        # The effective messaging decision (metadata AND config) is resolved once inside the episode;
        # reuse it to gate the human chat queue, so a frame is accepted only when the loop will route
        # it. The command pump starts only after this gate has been configured.
        control.configure_chat(episode.messaging_enabled)
        with episode:
            # Stream the opening deal frame (turn-based envs only) so a human who must act first sees
            # the table before the loop blocks for their move. It is streamed, never recorded.
            if not config.headless:
                opening = episode.opening_state()
                if opening is not None:
                    protocol.emit_state(opening)
            if command_lines is not None:
                start_command_pump(command_lines, control)
            run_live_loop(
                episode,
                pace_interval_ms=None if config.headless else entry.meta.pace_interval_ms,
                control=control,
                clock=clock,
                sleeper=sleeper,
            )
        protocol.emit_envelope(result_envelope(episode.result()))
    except Exception as error:  # noqa: BLE001 - surfaced to diagnostics; the orchestrator records it
        print(f"live: session failed: {error!r}", file=sys.stderr, flush=True)
        # Emit the partial result so the orchestrator can charge a crashing agent to its own seat
        # (episode.failed_slot) instead of to every competitor sharing the container. Best-effort: this
        # advisory note must never mask the original error or change the exit code. The close is
        # idempotent belt-and-suspenders — Episode.start and the `with` already flush the recording on
        # their own failures — and guarantees the writer is closed before result() reads it back.
        if episode is not None:
            with contextlib.suppress(Exception):
                episode.close()
            with contextlib.suppress(Exception):
                protocol.emit_envelope(result_envelope(episode.result()))
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    # Claim stdout before anything can import a game and print to it.
    protocol = ProtocolStream(_claim_stdout())
    try:
        config = parse_config(argv)
    except LiveConfigError as error:
        print(f"live: invalid config: {error}", file=sys.stderr, flush=True)
        return 2

    clock = PausableClock(SystemClock())
    control = SessionControl(clock)
    sleeper = RealSleeper()
    try:
        entry = load_environment(config.env_id)
    except Exception as error:  # noqa: BLE001 - keeps startup failures on diagnostics like run failures
        print(f"live: session failed: {error!r}", file=sys.stderr, flush=True)
        return 1
    return run(
        entry,
        config,
        protocol=protocol,
        control=control,
        clock=clock,
        sleeper=sleeper,
        store=build_tee_store(config.recording_dir, protocol),
        command_lines=sys.stdin,
    )


if __name__ == "__main__":
    sys.exit(main())
