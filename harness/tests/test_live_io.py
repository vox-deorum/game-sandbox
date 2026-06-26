"""The live-session transport primitives, on deterministic clocks.

Everything here runs on a :class:`ManualClock` (directly or under a :class:`PausableClock`) and
on hand-fed command lines, so there is no real sleeping and no wall-clock tolerance.
"""

from __future__ import annotations

import json
from importlib import resources
from pathlib import Path
from typing import Any

from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.live_io import (
    PausableClock,
    ProtocolStream,
    SessionControl,
    TransportSource,
    build_tee_store,
    result_envelope,
)
from game_sandbox_harness.session import EpisodeResult
from game_sandbox_harness.state import build_header, build_step_state

# --- PausableClock -----------------------------------------------------------------------


def test_pausable_clock_passes_through_when_never_paused():
    base = ManualClock(start_ms=1000)
    clock = PausableClock(base)
    assert clock.now_ms() == 1000
    base.advance(500)
    assert clock.now_ms() == 1500


def test_pausable_clock_freezes_while_paused_and_excludes_the_gap():
    base = ManualClock(start_ms=1000)
    clock = PausableClock(base)

    base.advance(100)  # now 1100
    clock.pause()
    base.advance(900)  # time passes while paused; now_ms must not move
    assert clock.now_ms() == 1100
    base.advance(50)
    assert clock.now_ms() == 1100

    clock.resume()
    assert clock.now_ms() == 1100  # the whole 950ms paused gap is excluded
    base.advance(200)
    assert clock.now_ms() == 1300  # post-resume time advances normally


def test_pausable_clock_pause_and_resume_are_idempotent():
    base = ManualClock(start_ms=0)
    clock = PausableClock(base)
    clock.pause()
    base.advance(100)
    clock.pause()  # a second pause is a no-op, not a re-anchor
    base.advance(100)
    clock.resume()
    clock.resume()  # a second resume is a no-op
    assert clock.now_ms() == 0
    base.advance(40)
    assert clock.now_ms() == 40


# --- SessionControl / the command envelope ----------------------------------------------


def test_input_command_latches_latest_and_take_clears():
    control = SessionControl()
    control.handle_line('{"kind": "input", "slot": "player_0", "action": 1}')
    control.handle_line('{"kind": "input", "slot": "player_0", "action": 0}')
    # Latest wins within the window...
    assert control.take("player_0") == 0
    # ...and a take clears it, so an unrepeated input is a single input.
    assert control.take("player_0") is None


def test_input_routes_per_slot():
    control = SessionControl()
    control.handle_line('{"kind": "input", "slot": "player_0", "action": 7}')
    control.handle_line('{"kind": "input", "slot": "player_1", "action": 9}')
    assert control.take("player_1") == 9
    assert control.take("player_0") == 7


def test_pause_resume_stop_commands_drive_flags_and_clock():
    base = ManualClock(start_ms=500)
    clock = PausableClock(base)
    control = SessionControl(clock)

    assert not control.paused and not control.stopping
    control.handle_line('{"kind": "pause"}')
    assert control.paused
    base.advance(300)
    assert clock.now_ms() == 500  # the command froze the injected clock

    control.handle_line('{"kind": "resume"}')
    assert not control.paused
    assert clock.now_ms() == 500

    control.handle_line('{"kind": "stop"}')
    assert control.stopping


def test_malformed_and_unknown_commands_are_ignored(capsys: Any):
    control = SessionControl()
    control.handle_line("not json at all")
    control.handle_line('{"no_kind": true}')
    control.handle_line('{"kind": "frobnicate"}')
    control.handle_line('{"kind": "input", "action": 1}')  # missing slot
    control.handle_line("")  # blank
    # None of that mutated state or raised.
    assert control.take("player_0") is None
    assert not control.paused and not control.stopping
    # The garbage went to diagnostics (stderr), never to the protocol stream.
    assert "ignoring" in capsys.readouterr().err


def test_attach_hijack_preamble_does_not_swallow_the_first_input(capsys: Any):
    """The Docker attach hijack prepends its options object to the first command with no newline
    between them (docker-modem writes the attach options as the request body, and on a hijacked
    stream those bytes head the container's stdin). The pump must still apply that first input
    rather than drop the whole fused line, and must not spam a diagnostic for the benign preamble."""
    control = SessionControl()
    # The exact preamble docker-modem emits, glued to the first real input with no separator —
    # this is the line shape from the live container log that motivated the fix.
    preamble = '{"stream":true,"stdin":true,"stdout":true,"stderr":true,"hijack":true}'
    command = '{"kind": "input", "slot": "player_0", "action": 1}'
    control.handle_line(preamble + command)

    # The real input survived the preamble instead of being dropped with it...
    assert control.take("player_0") == 1
    # ...and the benign transport preamble produced no diagnostic noise.
    assert capsys.readouterr().err == ""


def test_fused_control_commands_on_one_line_all_apply(capsys: Any):
    """Beyond input, any commands fused onto one line (e.g. a preamble before a pause) each apply,
    and the leading kind-less preamble stays quiet."""
    base = ManualClock(start_ms=100)
    clock = PausableClock(base)
    control = SessionControl(clock)
    preamble = '{"stream":true,"hijack":true}'
    control.handle_line(preamble + '{"kind": "pause"}')
    assert control.paused
    assert capsys.readouterr().err == ""


# --- TransportSource --------------------------------------------------------------------


def test_paced_source_returns_latched_or_none_immediately():
    control = SessionControl()
    clock = PausableClock(ManualClock())
    source = TransportSource(control, clock=clock, paced=True)

    # No input yet → None immediately (the loop applies the default action).
    assert source.get_action("player_0", observation=None, deadline_ms=None) is None
    control.handle_line('{"kind": "input", "slot": "player_0", "action": 1}')
    assert source.get_action("player_0", observation=None, deadline_ms=123) == 1
    # Consumed: the next step with no fresh input defaults again.
    assert source.get_action("player_0", observation=None, deadline_ms=123) is None


def test_turn_based_source_blocks_until_input_arrives():
    base = ManualClock(start_ms=0)
    clock = PausableClock(base)
    control = SessionControl()

    class FeedingSleeper:
        def __init__(self) -> None:
            self.calls = 0

        def sleep_ms(self, ms: int) -> None:
            self.calls += 1
            base.advance(ms)
            if self.calls == 2:  # input arrives mid-wait
                control.handle_line('{"kind": "input", "slot": "p", "action": 42}')

    sleeper = FeedingSleeper()
    source = TransportSource(control, clock=clock, paced=False, sleeper=sleeper, slice_ms=5)
    action = source.get_action("p", observation=None, deadline_ms=1000)
    assert action == 42
    assert sleeper.calls == 2


def test_turn_based_source_holds_latched_input_until_resume():
    base = ManualClock(start_ms=0)
    clock = PausableClock(base)
    control = SessionControl(clock)

    class PausingSleeper:
        def __init__(self) -> None:
            self.calls = 0

        def sleep_ms(self, ms: int) -> None:
            self.calls += 1
            base.advance(ms)
            if self.calls == 1:
                control.handle_line('{"kind": "pause"}')
            elif self.calls == 2:
                control.handle_line('{"kind": "input", "slot": "p", "action": 42}')
            elif self.calls == 4:
                control.handle_line('{"kind": "resume"}')

    sleeper = PausingSleeper()
    source = TransportSource(control, clock=clock, paced=False, sleeper=sleeper, slice_ms=5)
    action = source.get_action("p", observation=None, deadline_ms=1000)
    assert action == 42
    assert sleeper.calls == 4


def test_turn_based_source_times_out_to_none_at_deadline():
    base = ManualClock(start_ms=0)
    clock = PausableClock(base)
    control = SessionControl()

    class AdvancingSleeper:
        def sleep_ms(self, ms: int) -> None:
            base.advance(ms)

    source = TransportSource(control, clock=clock, paced=False, sleeper=AdvancingSleeper(), slice_ms=5)
    # No input ever arrives; the deadline at 12ms is reached after a few slices → None.
    assert source.get_action("p", observation=None, deadline_ms=12) is None


def test_turn_based_source_returns_none_on_stop():
    control = SessionControl()
    control.handle_line('{"kind": "stop"}')
    clock = PausableClock(ManualClock())

    class ExplodingSleeper:
        def sleep_ms(self, ms: int) -> None:
            raise AssertionError("must not sleep once stop is set")

    source = TransportSource(control, clock=clock, paced=False, sleeper=ExplodingSleeper())
    assert source.get_action("p", observation=None, deadline_ms=None) is None


# --- The tee store: stream/stored byte parity -------------------------------------------


def test_tee_store_streams_the_exact_bytes_it_stores(tmp_path: Path):
    streamed: list[str] = []

    class _Sink:
        def write(self, text: str) -> None:
            streamed.append(text)

        def flush(self) -> None:  # ProtocolStream flushes after each write
            pass

    protocol = ProtocolStream(_Sink())  # type: ignore[arg-type]
    store = build_tee_store(str(tmp_path), protocol)

    header = build_header(environment="fake", seed=1)
    with store.create("r", header) as writer:
        writer.write_step(build_step_state(tick=0, agents={}, started_at=0, duration_ms=1))
        writer.write_step(build_step_state(tick=1, agents={}, started_at=1, duration_ms=1))

    on_disk = (tmp_path / "r" / "recording.jsonl").read_bytes()
    streamed_bytes = "".join(streamed).encode("utf-8")
    assert streamed_bytes == on_disk
    # And it really is the header plus two states, no result envelope mixed in.
    assert on_disk.count(b"\n") == 3


# --- The result envelope ----------------------------------------------------------------


def test_result_envelope_carries_episode_result_fields():
    result = EpisodeResult(
        ticks=12,
        scores={"player_0": 3.0},
        reason="terminated",
        step_timeouts={"player_0": 0},
        recording_id="rec-1",
    )
    envelope = result_envelope(result)
    assert envelope == {
        "kind": "result",
        "ticks": 12,
        "scores": {"player_0": 3.0},
        "reason": "terminated",
        "step_timeouts": {"player_0": 0},
        "recording_id": "rec-1",
    }


# --- The line-classification rule, asserted against the packaged schema ------------------


def test_state_schema_forbids_a_top_level_kind_field():
    """Recording lines never carry a top-level ``kind`` — that is what separates them from event
    envelopes, on both the container channel and the WebSocket. The guarantee lives in the
    packaged step-state schema, so assert it here; if the schema ever grew a ``kind`` property or
    opened its top level, the classifier would silently break and this test would catch it."""
    raw = (
        resources.files("game_sandbox_harness.schema_data")
        .joinpath("step-state.schema.json")
        .read_text(encoding="utf-8")
    )
    schema = json.loads(raw)
    assert schema["additionalProperties"] is False
    assert "kind" not in schema["properties"]
