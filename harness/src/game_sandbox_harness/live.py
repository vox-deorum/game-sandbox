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

Module-level imports stay free of the environment/PyGame packages so :func:`main` can claim
stdout *before* anything imports a game; the environment is loaded only inside :func:`main`,
after that redirection is in place.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from typing import IO, Any, cast

from game_sandbox_harness.clock import SystemClock
from game_sandbox_harness.environment import EnvironmentEntry, load_environment
from game_sandbox_harness.live_io import (
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
from game_sandbox_harness.manifest import load_agent
from game_sandbox_harness.session import REASON_STOPPED, AgentSlot, Episode, ExternalSlot, Slot
from game_sandbox_harness.state import PlayerAttribution

#: Where the session base image stages the built-in agents the watch-style runs load, one
#: per-environment directory beneath this base (``/opt/agents/builtin/<env_id>``). A slot with no
#: explicit overlay path takes the baseline for the session's own environment, since the Naive
#: policy is environment-specific (see each baseline's ``agent.py``).
DEFAULT_BUILTIN_AGENT_BASE = "/opt/agents/builtin"
#: Cooperative wait granularity. Small enough that stop and resume stay responsive.
_SLICE_MS = 5


class LiveConfigError(ValueError):
    """Raised when the session config argument is missing, malformed, or self-inconsistent."""


@dataclass(frozen=True)
class SlotBinding:
    """How one slot is driven: ``external`` (transport) or ``builtin-agent`` (a loaded agent)."""

    kind: str
    path: str | None = None


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
    human_timeout_ms: int | None
    recording_dir: str
    recording_id: str | None
    #: Per-slot attribution copied verbatim into the recording header (slot id -> attribution
    #: object). Computed by the backend, opaque to the harness; ``None`` when not supplied.
    players: dict[str, PlayerAttribution] | None = None
    #: Optional per-step/per-episode time-limit overrides (the Stage 6 season overrides).
    #: ``None`` takes the environment's metadata default, as a session with no override does.
    step_timeout_ms: int | None = None
    episode_timeout_ms: int | None = None
    #: Workflow containers set this to run as fast as the agents compute, without live pacing.
    headless: bool = False


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

    human_timeout_ms = config.get("human_timeout_ms")
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

    players = _parse_players(config.get("players"))
    step_timeout_ms = _parse_optional_int(config, "step_timeout_ms")
    episode_timeout_ms = _parse_optional_int(config, "episode_timeout_ms")
    headless = config.get("headless", False)
    if not isinstance(headless, bool):
        raise LiveConfigError("config 'headless' must be a boolean")

    return LiveConfig(
        env_id=env_id,
        seed=seed,
        slots=slots,
        human_timeout_ms=human_timeout_ms,
        recording_dir=recording_dir,
        recording_id=recording_id,
        players=players,
        step_timeout_ms=step_timeout_ms,
        episode_timeout_ms=episode_timeout_ms,
        headless=headless,
    )


def _parse_optional_int(config: dict[str, Any], key: str) -> int | None:
    """Validate an optional positive-integer config value, defaulting to ``None`` when absent."""
    value = config.get(key)
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool):
        raise LiveConfigError(f"config {key!r} must be an integer or null")
    return value


def _parse_players(raw: object) -> dict[str, PlayerAttribution] | None:
    """Validate the optional per-slot ``players`` attribution map from the config.

    Each entry must name a ``kind`` of ``human`` or ``agent`` and a non-empty ``label``; ``user``
    and ``submission_id`` are optional strings. The validated entries are passed through verbatim
    into the recording header, so the harness keeps no opinion on their meaning beyond being
    well-formed.
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise LiveConfigError("config 'players' must be an object keyed by slot id or null")
    players: dict[str, PlayerAttribution] = {}
    for slot_id, raw_entry in cast("dict[str, Any]", raw).items():
        if not isinstance(raw_entry, dict):
            raise LiveConfigError(f"config player {slot_id!r} must be an object")
        entry = cast("dict[str, Any]", raw_entry)
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
        players[slot_id] = cast("PlayerAttribution", entry)
    return players


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
    resolved_timeout = (
        config.human_timeout_ms if config.human_timeout_ms is not None else entry.meta.human_timeout_ms
    )
    slots: dict[str, Slot] = {}
    for slot_id, binding in config.slots.items():
        if binding.kind == "external":
            source = TransportSource(control, clock=clock, paced=paced, sleeper=sleeper)
            slots[slot_id] = ExternalSlot(source, timeout_ms=resolved_timeout)
        else:  # "builtin-agent" — parse_config rejects any other kind.
            agent_path = binding.path or f"{DEFAULT_BUILTIN_AGENT_BASE}/{config.env_id}"
            agent = load_agent(agent_path)
            slots[slot_id] = AgentSlot(agent)
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

    Protocol lines must own stdout, but importing a game (PyGame) prints a banner to it. Done as
    the first thing in :func:`main`, before any environment import: ``dup`` the real stdout for
    the protocol writer, then ``dup2`` stderr over fd 1 so every later ``print`` — banners, stray
    environment chatter — lands in the diagnostics stream instead of corrupting the protocol.
    """
    sys.stdout.flush()
    protocol_fd = os.dup(1)
    os.dup2(2, 1)
    return os.fdopen(protocol_fd, "w", encoding="utf-8", newline="\n")


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
    start_command_pump(sys.stdin, control)

    try:
        entry = load_environment(config.env_id)
        slots = build_slots(config, entry, control, clock, sleeper)
        store = build_tee_store(config.recording_dir, protocol)
        with Episode(
            entry,
            slots,
            seed=config.seed,
            store=store,
            recording_id=config.recording_id,
            clock=clock,
            step_limit_ms=config.step_timeout_ms,
            episode_limit_ms=config.episode_timeout_ms,
            players=config.players,
        ) as episode:
            # Stream the opening deal frame (turn-based envs only) so a human who must act first sees
            # the table before the loop blocks for their move. It is streamed, never recorded.
            if not config.headless:
                opening = episode.opening_state()
                if opening is not None:
                    protocol.emit_state(opening)
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
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
