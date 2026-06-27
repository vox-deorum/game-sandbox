"""Transport primitives for the live session runner.

These are the container-side halves of the Stage 3 transport: the inbound command pump and
its shared control state, the :class:`PausableClock` that freezes time on pause, the
:class:`TransportSource` that feeds an external slot from latched inputs, the protocol output
stream, and the tee that mirrors recording bytes onto that stream. The runner that wires them
together lives in :mod:`game_sandbox_harness.live`; everything here is independently testable
on a :class:`~game_sandbox_harness.clock.ManualClock`.

The line shapes are defined in the Stage 3 transport plan. Outbound: recording lines
(header + per-step states, never carrying a top-level ``kind``) and event envelopes (a
top-level ``kind``; this stage emits one, ``result``). Inbound command envelopes carry a
``kind`` and, where applicable, a ``slot`` and ``action``: ``input``, ``pause``, ``resume``,
``stop``. Unknown kinds and malformed lines are logged and ignored — the container must never
die because a client sent garbage.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from collections.abc import Iterable, Mapping
from typing import IO, TYPE_CHECKING, Any, Protocol, cast, runtime_checkable

from game_sandbox_harness.clock import Clock
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import EpisodeResult

#: The single outbound event-envelope kind this stage defines.
RESULT_KIND = "result"
_DEFAULT_SLICE_MS = 5


def _diag(message: str) -> None:
    """Write a diagnostic line to stderr; it is never part of the protocol stream."""
    print(message, file=sys.stderr, flush=True)


class PausableClock:
    """A :class:`~game_sandbox_harness.clock.Clock` that subtracts accumulated paused time.

    Wraps any base clock (including ``ManualClock``, so the suites stay deterministic) and
    reports ``base - total_paused``. Injected as the episode clock, it freezes the decision
    clock and the realtime cadence together: while paused, ``now_ms`` does not advance, so
    every duration measured as a difference of two readings — a step's ``decision_ms``, the
    budget, the next cadence instant — freezes with it, and the spec'd pause semantics need no
    special case in the loop. Thread-safe: the stepping thread reads ``now_ms`` while the
    command pump calls :meth:`pause`/:meth:`resume`.
    """

    def __init__(self, base: Clock) -> None:
        self._base = base
        self._lock = threading.Lock()
        self._paused_total_ms = 0
        self._paused_at: int | None = None

    def now_ms(self) -> int:
        with self._lock:
            base = self._base.now_ms()
            paused = self._paused_total_ms
            if self._paused_at is not None:
                paused += base - self._paused_at
            return base - paused

    def pause(self) -> None:
        with self._lock:
            if self._paused_at is None:
                self._paused_at = self._base.now_ms()

    def resume(self) -> None:
        with self._lock:
            if self._paused_at is not None:
                self._paused_total_ms += self._base.now_ms() - self._paused_at
                self._paused_at = None


class SessionControl:
    """Thread-safe control state updated by inbound commands and read by the stepping thread.

    The command pump calls :meth:`handle_line` for each inbound line; the stepping thread reads
    :attr:`paused`, :attr:`stopping`, and :meth:`take`. Pause and resume drive the injected
    :class:`PausableClock` so the freeze takes effect the instant the command arrives, not on
    the next step boundary.
    """

    def __init__(self, clock: PausableClock | None = None) -> None:
        self._lock = threading.Lock()
        self._latched: dict[str, Any] = {}
        self._paused = False
        self._stopping = False
        self._clock = clock

    def handle_line(self, raw: str) -> None:
        """Parse and dispatch the inbound command(s) on one line; malformed/unknown lines are ignored.

        Normally a line is exactly one JSON command. The Docker attach hijack is the exception: it
        prepends its options object to the very first command with no separating newline. docker-modem
        carries a hijacked attach by writing the attach options as the request body, and that body is
        also the only thing that flushes the upgrade — so it cannot be suppressed; on the hijacked
        stream those bytes land at the head of the container's stdin (see ``DockerSessionProcess``).
        A line may therefore carry more than one JSON value. Decode them all and dispatch each instead
        of dropping the whole line — that is what stops the first real input from being lost with the
        transport preamble. A multi-value line is, in practice, only ever that preamble fused with the
        real command, so its leading kind-less object is skipped quietly; a lone kind-less line is a
        client error and still earns a diagnostic.
        """
        text = raw.strip()
        if not text:
            return
        decoder = json.JSONDecoder()
        values: list[object] = []
        index = 0
        while index < len(text):
            try:
                parsed, end = decoder.raw_decode(text, index)
            except json.JSONDecodeError:
                _diag(f"live: ignoring malformed command line: {text[index:]!r}")
                break
            values.append(parsed)
            index = end
            while index < len(text) and text[index].isspace():
                index += 1
        # A multi-value line is the attach-hijack preamble fused with the real command; its leading
        # kind-less object is expected transport noise, not client garbage, so do not log it.
        quiet_missing_kind = len(values) > 1
        for value in values:
            self._dispatch_command(value, text, quiet_missing_kind=quiet_missing_kind)

    def _dispatch_command(self, parsed: object, source: str, *, quiet_missing_kind: bool = False) -> None:
        """Apply one already-decoded command value; malformed/unknown ones are ignored."""
        if not isinstance(parsed, dict) or "kind" not in parsed:
            if not quiet_missing_kind:
                _diag(f"live: ignoring command without a kind: {source!r}")
            return
        command = cast("dict[str, Any]", parsed)
        kind = command.get("kind")
        if kind == "input":
            slot = command.get("slot")
            if not isinstance(slot, str):
                _diag(f"live: ignoring input command without a string slot: {source!r}")
                return
            with self._lock:
                self._latched[slot] = command.get("action")
        elif kind == "pause":
            self.pause()
        elif kind == "resume":
            self.resume()
        elif kind == "stop":
            with self._lock:
                self._stopping = True
        else:
            _diag(f"live: ignoring unknown command kind {kind!r}")

    def take(self, slot: str) -> Any | None:
        """Return and clear the latest input latched for ``slot`` since the last call.

        Latching is per step, per [interaction.md]: a step uses the most recent input that
        arrived since the previous step, or ``None`` (the loop applies the default action) when
        none did. Clearing on read is what makes an unrepeated Flappy Bird flap a single flap.
        """
        with self._lock:
            return self._latched.pop(slot, None)

    def pause(self) -> None:
        with self._lock:
            if not self._paused:
                self._paused = True
                if self._clock is not None:
                    self._clock.pause()

    def resume(self) -> None:
        with self._lock:
            if self._paused:
                self._paused = False
                if self._clock is not None:
                    self._clock.resume()

    @property
    def paused(self) -> bool:
        with self._lock:
            return self._paused

    @property
    def stopping(self) -> bool:
        with self._lock:
            return self._stopping


@runtime_checkable
class Sleeper(Protocol):
    """A cooperative sleep, sliced so pause and stop stay responsive while waiting."""

    def sleep_ms(self, ms: int) -> None: ...


class RealSleeper:
    """A :class:`Sleeper` backed by ``time.sleep`` for live container runs."""

    def sleep_ms(self, ms: int) -> None:
        if ms > 0:
            time.sleep(ms / 1000)


class TransportSource:
    """An :class:`~game_sandbox_harness.session.ActionSource` over latched transport inputs.

    With a pace interval set, the cadence is the world clock and the deadline handed down is the
    cadence instant, so the source returns the latched input (or ``None``) immediately and the
    loop's pacing does the waiting. With no pace interval the slot is turn-based: the source
    blocks in short slices until an input arrives, the human-slot deadline passes, or a stop is
    requested. Either way a ``None`` return routes through ``ExternalSlot``'s existing default —
    noop for Flappy Bird — with no agent-timeout accounting.
    """

    def __init__(
        self,
        control: SessionControl,
        *,
        clock: Clock,
        paced: bool,
        sleeper: Sleeper | None = None,
        slice_ms: int = _DEFAULT_SLICE_MS,
    ) -> None:
        self._control = control
        self._clock = clock
        self._paced = paced
        self._sleeper = sleeper or RealSleeper()
        self._slice_ms = slice_ms

    def get_action(self, slot_id: str, observation: Any, deadline_ms: int | None) -> Any:
        if self._paced:
            return self._control.take(slot_id)
        while True:
            if self._control.stopping:
                return None
            if self._control.paused:
                self._sleeper.sleep_ms(self._slice_ms)
                continue
            value = self._control.take(slot_id)
            if value is not None:
                return value
            if deadline_ms is not None and self._clock.now_ms() >= deadline_ms:
                return None
            self._sleeper.sleep_ms(self._slice_ms)


class ProtocolStream:
    """The single-writer outbound protocol sink, owned by the stepping thread.

    Recording lines reach it pre-serialized through :meth:`emit_raw` (the tee mirror), and event
    envelopes through :meth:`emit_envelope`. Only the stepping thread writes here — the command
    pump reads stdin and never touches this — so no lock is needed.
    """

    def __init__(self, handle: IO[str]) -> None:
        self._handle = handle

    def emit_raw(self, line: str) -> None:
        """Write an already-serialized line (the recording serializer's exact bytes)."""
        self._handle.write(line if line.endswith("\n") else line + "\n")
        self._handle.flush()

    def emit_envelope(self, obj: Mapping[str, Any]) -> None:
        """Serialize and write one event envelope (for example the ``result`` line)."""
        self._handle.write(json.dumps(obj, separators=(",", ":"), sort_keys=True) + "\n")
        self._handle.flush()


def build_tee_store(recordings_root: str, protocol: ProtocolStream) -> FolderRecordingStore:
    """A recording store that mirrors every serialized line onto ``protocol``.

    Wraps :class:`FolderRecordingStore` by handing it the protocol's
    :meth:`~ProtocolStream.emit_raw` as the store's ``on_line`` mirror: each header and state
    line is serialized once and written to both the recording on the mounted volume and the
    protocol stream, so the streamed bytes and the stored bytes cannot differ.
    """
    return FolderRecordingStore(recordings_root, on_line=protocol.emit_raw)


def result_envelope(result: EpisodeResult) -> dict[str, Any]:
    """Build the outbound ``result`` envelope from an :class:`EpisodeResult`.

    Emitted once at session end. Never written to the recording — it carries a top-level
    ``kind``, which the state schema forbids, so the classification rule keeps it out.
    """
    return {
        "kind": RESULT_KIND,
        "ticks": result.ticks,
        "scores": result.scores,
        "reason": result.reason,
        "step_timeouts": result.step_timeouts,
        "recording_id": result.recording_id,
    }


def start_command_pump(lines: Iterable[str], control: SessionControl) -> threading.Thread:
    """Start a daemon thread that pumps ``lines`` (typically stdin) into ``control``.

    The thread owns the only blocking read in the runner, so the stepping thread never stalls on
    input. It swallows its own errors to a diagnostic line: a broken inbound channel must not
    take the session down, since the episode can still run to its natural end.
    """

    def run() -> None:
        try:
            for raw in lines:
                control.handle_line(raw)
        except Exception as error:  # noqa: BLE001 - the pump must never crash the container
            _diag(f"live: command pump stopped: {error!r}")

    thread = threading.Thread(target=run, name="command-pump", daemon=True)
    thread.start()
    return thread


# Structural conformance: TransportSource must satisfy the ActionSource protocol. Checked by
# pyright under TYPE_CHECKING only (this block never runs).
if TYPE_CHECKING:
    from game_sandbox_harness.clock import SystemClock
    from game_sandbox_harness.session import ActionSource

    _source: ActionSource = TransportSource(SessionControl(), clock=SystemClock(), paced=True)
