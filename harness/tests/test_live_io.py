"""The live-session transport primitives, on deterministic clocks.

Everything here runs on a :class:`ManualClock` (directly or under a :class:`PausableClock`) and
on hand-fed command lines, so there is no real sleeping and no wall-clock tolerance.

"""

from __future__ import annotations

from typing import Any

import pytest

import game_sandbox_harness.clock as clock_module
from game_sandbox_harness.clock import ManualClock, SystemClock
from game_sandbox_harness.live_io import (
    CHAT_QUEUE_LIMIT,
    PausableClock,
    SessionControl,
    TransportSource,
    result_envelope,
    session_envelope,
)
from game_sandbox_harness.session import EpisodeResult


def test_session_envelope_includes_awaiting_start_only_for_running_sessions() -> None:
    assert session_envelope("running", awaiting_start=True) == {
        "kind": "session",
        "status": "running",
        "awaiting_start": True,
    }
    assert session_envelope("running") == {
        "kind": "session",
        "status": "running",
        "awaiting_start": False,
    }
    assert session_envelope("ended", "completed") == {
        "kind": "session",
        "status": "ended",
        "reason": "completed",
    }


# --- PausableClock -----------------------------------------------------------------------


def test_system_clock_keeps_epoch_time_monotonic_when_the_wall_clock_moves_back(
    monkeypatch,
):
    wall_seconds = 1_700_000_000.0
    monotonic_ns = 10_000_000_000
    monkeypatch.setattr(clock_module.time, "time", lambda: wall_seconds)
    monkeypatch.setattr(clock_module.time, "monotonic_ns", lambda: monotonic_ns)
    clock = SystemClock()

    wall_seconds -= 2
    monotonic_ns += 25_000_000

    assert clock.now_ms() == 1_700_000_000_025


def test_pausable_clock_freezes_while_paused_and_excludes_the_gap():
    base = ManualClock(start_ms=1000)
    clock = PausableClock(base)

    # Running time passes through unchanged.
    assert clock.now_ms() == 1000
    base.advance(500)
    assert clock.now_ms() == 1500

    # The first paused gap is excluded, and a repeated pause does not re-anchor it.
    clock.pause()
    base.advance(400)
    clock.pause()
    base.advance(500)
    assert clock.now_ms() == 1500

    # A repeated resume is a no-op, and post-resume time advances normally.
    clock.resume()
    clock.resume()
    assert clock.now_ms() == 1500
    base.advance(200)
    assert clock.now_ms() == 1700

    # A second, independent gap is excluded too.
    clock.pause()
    base.advance(50)
    assert clock.now_ms() == 1700
    clock.resume()
    base.advance(300)
    assert clock.now_ms() == 2000


# --- SessionControl / the command envelope ----------------------------------------------


def test_input_command_latches_latest_and_take_clears():
    control = SessionControl()
    control.handle_line('{"kind": "input", "player": "player_0", "action": 1}')
    control.handle_line('{"kind": "input", "player": "player_0", "action": 0}')
    control.handle_line('{"kind": "input", "player": "player_1", "action": 9}')

    # Latest wins per player, and players never share a latch.
    assert control.take("player_1") == 9
    assert control.take("player_0") == 0
    # A take clears the latch, so an unrepeated input is a single input.
    assert control.take("player_0") is None
    assert control.take("player_1") is None


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


def test_clock_commands_latch_per_player():
    control = SessionControl()
    assert not control.clock_running("player_0")  # nobody holds the controls until a client says so

    control.handle_line('{"kind": "clock", "player": "player_0", "running": true}')
    assert control.clock_running("player_0")
    assert not control.clock_running("player_1")

    control.handle_line('{"kind": "clock", "player": "player_0", "running": false}')
    assert not control.clock_running("player_0")


@pytest.mark.parametrize(
    ("line", "reason"),
    [
        pytest.param("", None, id="blank"),
        pytest.param("not json at all", "ignoring malformed command line", id="malformed-json"),
        pytest.param('{"no_kind": true}', "ignoring command without a kind", id="missing-kind"),
        pytest.param('{"kind": "frobnicate"}', "ignoring unknown command kind", id="unknown-kind"),
        pytest.param(
            '{"kind": "input", "action": 1}',
            "input command without a string player",
            id="input-missing-player",
        ),
        pytest.param(
            '{"kind": "clock", "running": true}',
            "clock command without a string player",
            id="clock-missing-player",
        ),
        pytest.param(
            '{"kind": "clock", "player": "player_0", "running": "yes"}',
            "clock command without a boolean running",
            id="clock-non-boolean-running",
        ),
        pytest.param(
            '{"kind": "clock", "player": "player_0"}',
            "clock command without a boolean running",
            id="clock-missing-running",
        ),
        pytest.param(
            '{"kind": "chat", "to": null, "text": "no player"}',
            "chat command without a string player",
            id="chat-missing-player",
        ),
        pytest.param(
            '{"kind": "chat", "player": "player_0", "to": null, "text": 42}',
            "chat command without string text",
            id="chat-non-string-text",
        ),
        pytest.param(
            '{"kind": "chat", "player": "player_0", "text": "no recipient"}',
            "chat command without a string or null to",
            id="chat-missing-to",
        ),
    ],
)
def test_malformed_and_unknown_commands_are_ignored(
    line: str,
    reason: str | None,
    capsys: Any,
) -> None:
    control = SessionControl()
    control.configure_chat("player_0")
    control.handle_line(line)

    err = capsys.readouterr().err
    if reason is None:
        assert err == ""
    else:
        assert reason in err
    assert not control.paused and not control.stopping
    assert not control.clock_running("player_0")
    assert control.take_chat("player_0") == []
    assert control.take("player_0") is None

    # The runner survives the garbage and still applies the next valid command.
    control.handle_line('{"kind": "input", "player": "player_0", "action": 1}')
    assert control.take("player_0") == 1
    assert capsys.readouterr().err == ""


def test_attach_preamble_and_fused_control_commands_still_apply(capsys: Any) -> None:
    """Docker attach prepends its options object to the first command with no newline between them.

    The pump must apply the command that follows the benign preamble rather than drop the fused
    line, and it must stay quiet about the preamble itself.
    """
    base = ManualClock(start_ms=100)
    clock = PausableClock(base)
    control = SessionControl(clock)
    preamble = '{"stream":true,"stdin":true,"stdout":true,"stderr":true,"hijack":true}'

    control.handle_line(preamble + '{"kind": "input", "player": "player_0", "action": 1}')
    assert control.take("player_0") == 1

    control.handle_line(preamble + '{"kind": "pause"}')
    assert control.paused
    base.advance(300)
    assert clock.now_ms() == 100  # the fused pause froze the injected clock

    control.handle_line(preamble + '{"kind": "resume"}')
    assert not control.paused
    assert clock.now_ms() == 100

    control.handle_line(preamble + '{"kind": "stop"}')
    assert control.stopping
    assert capsys.readouterr().err == ""  # the benign preamble is never noisy


# --- chat: the bounded designated-sender FIFO queue ------------------------------------


def test_chat_frames_queue_in_fifo_order_and_take_clears():
    control = SessionControl()
    control.configure_chat("player_0")
    clock = PausableClock(ManualClock())
    source = TransportSource(control, clock=clock, paced=True)

    control.handle_line('{"kind":"input","player":"player_0","action":5}')
    for command in (
        '{"kind":"chat","player":"player_0","to":null,"text":"one"}',
        '{"kind":"chat","player":"player_0","to":"player_1","text":"two"}',
        '{"kind":"chat","player":"player_0","to":null,"text":"three"}',
    ):
        control.handle_line(command)

    # The public source drains chat in arrival order and never touches the action latch.
    assert source.take_messages("player_0") == [
        {"to": None, "text": "one"},
        {"to": "player_1", "text": "two"},
        {"to": None, "text": "three"},
    ]
    assert source.take_messages("player_0") == []
    control.handle_line('{"kind":"chat","player":"player_0","to":null,"text":"later"}')
    assert source.get_action("player_0", observation=None, window_ms=None) == 5
    assert source.take_messages("player_0") == [{"to": None, "text": "later"}]


@pytest.mark.parametrize(
    ("designated", "sender"),
    [
        pytest.param(None, "player_0", id="messaging-disabled"),
        pytest.param("player_0", "player_9", id="unauthorized-sender"),
    ],
)
def test_chat_rejects_unconfigured_or_unauthorized_senders(
    designated: str | None,
    sender: str,
    capsys: Any,
) -> None:
    control = SessionControl()
    control.configure_chat(designated)
    control.handle_line(f'{{"kind":"chat","player":"{sender}","to":null,"text":"spoof"}}')

    assert control.take_chat(sender) == []
    assert control.take_chat("player_0") == []
    assert "dropping chat command" in capsys.readouterr().err

    # An authorized sender can still deliver once one is configured.
    control.configure_chat("player_0")
    control.handle_line('{"kind":"chat","player":"player_0","to":null,"text":"hello"}')
    assert control.take_chat("player_0") == [{"to": None, "text": "hello"}]


def test_one_chat_frame_beyond_the_queue_limit_is_dropped(capsys: Any) -> None:
    control = SessionControl()
    control.configure_chat("player_0")
    # The public capacity sizes the flood; no expected queue length is taken from it.
    for i in range(CHAT_QUEUE_LIMIT):
        control.handle_line(f'{{"kind":"chat","player":"player_0","to":null,"text":"m{i}"}}')
    control.handle_line('{"kind":"chat","player":"player_0","to":null,"text":"overflow"}')

    texts = [message["text"] for message in control.take_chat("player_0")]
    assert "overflow" not in texts
    assert texts
    assert "queue full" in capsys.readouterr().err

    # A drained queue accepts new frames again.
    control.handle_line('{"kind":"chat","player":"player_0","to":null,"text":"after"}')
    assert control.take_chat("player_0") == [{"to": None, "text": "after"}]


# --- TransportSource --------------------------------------------------------------------


def test_paced_source_returns_latched_or_none_immediately():
    control = SessionControl()
    clock = PausableClock(ManualClock())
    source = TransportSource(control, clock=clock, paced=True)

    # No input yet → None immediately (the loop applies the default action).
    assert source.get_action("player_0", observation=None, window_ms=None) is None
    control.handle_line('{"kind": "input", "player": "player_0", "action": 1}')
    assert source.get_action("player_0", observation=None, window_ms=123) == 1
    # Consumed: the next step with no fresh input defaults again.
    assert source.get_action("player_0", observation=None, window_ms=123) is None


def test_turn_based_source_blocks_until_input_arrives():
    base = ManualClock(start_ms=0)
    clock = PausableClock(base)
    control = SessionControl()

    class DelayedInputSleeper:
        def sleep_ms(self, ms: int) -> None:
            base.advance(ms)
            if base.now_ms() >= 10:
                control.handle_line('{"kind": "input", "player": "p", "action": 42}')

    source = TransportSource(control, clock=clock, paced=False, sleeper=DelayedInputSleeper(), slice_ms=5)
    assert source.get_action("p", observation=None, window_ms=1000) == 42
    # The wait lasted exactly two slices on the manual clock.
    assert base.now_ms() == 10
    assert clock.now_ms() == 10


def test_turn_based_source_holds_latched_input_until_resume():
    base = ManualClock(start_ms=0)
    clock = PausableClock(base)
    control = SessionControl(clock)
    control.handle_line('{"kind": "clock", "player": "p", "running": true}')

    class PausingSleeper:
        def sleep_ms(self, ms: int) -> None:
            base.advance(ms)
            now = base.now_ms()
            if now == 10:
                control.handle_line('{"kind": "pause"}')
                return
            if now == 30:
                control.handle_line('{"kind": "input", "player": "p", "action": 42}')
            if now == 110:
                control.handle_line('{"kind": "resume"}')

    source = TransportSource(control, clock=clock, paced=False, sleeper=PausingSleeper(), slice_ms=5)
    assert source.get_action("p", observation=None, window_ms=12) == 42
    # The pause hid 100ms, far beyond the 12ms budget, so the input survived it and the clock
    # charged only the 10ms before the pause.
    assert base.now_ms() == 110
    assert clock.now_ms() == 10


def test_turn_based_source_times_out_at_the_held_budget_and_renews_it_each_turn():
    base = ManualClock(start_ms=0)
    clock = PausableClock(base)
    control = SessionControl()
    control.handle_line('{"kind": "clock", "player": "p", "running": true}')

    class AdvancingSleeper:
        def sleep_ms(self, ms: int) -> None:
            base.advance(ms)

    source = TransportSource(control, clock=clock, paced=False, sleeper=AdvancingSleeper(), slice_ms=4)
    # No input ever arrives, so the full 12ms budget is spent before the timeout.
    assert source.get_action("p", observation=None, window_ms=12) is None
    assert base.now_ms() == 12
    # Every turn starts with the full budget again while the controls stay held.
    assert source.get_action("p", observation=None, window_ms=12) is None
    assert base.now_ms() == 24


def test_turn_based_source_waits_indefinitely_while_nobody_holds_the_controls():
    """The browser animates agent turns before handing over, so the loop can reach a human long
    before their controls open. None of that gap is theirs to lose."""
    base = ManualClock(start_ms=0)
    clock = PausableClock(base)
    control = SessionControl()

    class LateHandoverSleeper:
        def __init__(self) -> None:
            self.calls = 0

        def sleep_ms(self, ms: int) -> None:
            self.calls += 1
            base.advance(1000)  # far past the budget on every slice
            if self.calls == 5:
                control.handle_line('{"kind": "input", "player": "p", "action": 42}')

    sleeper = LateHandoverSleeper()
    source = TransportSource(control, clock=clock, paced=False, sleeper=sleeper, slice_ms=5)
    assert source.get_action("p", observation=None, window_ms=12) == 42


def test_turn_based_budget_spends_only_the_time_the_controls_were_held():
    base = ManualClock(start_ms=0)
    clock = PausableClock(base)
    control = SessionControl()
    control.handle_line('{"kind": "clock", "player": "p", "running": true}')

    class TogglingSleeper:
        def sleep_ms(self, ms: int) -> None:
            base.advance(ms)
            now = base.now_ms()
            if now == 20:
                control.handle_line('{"kind": "clock", "player": "p", "running": false}')
            elif now == 1020:
                control.handle_line('{"kind": "clock", "player": "p", "running": true}')

    source = TransportSource(control, clock=clock, paced=False, sleeper=TogglingSleeper(), slice_ms=10)
    assert source.get_action("p", observation=None, window_ms=50) is None
    # Only 10ms was charged before release, the 1000ms release cost nothing, and the rest of the
    # budget was spent after the controls came back, so it ended at 1050ms of wall time.
    assert base.now_ms() == 1050
    assert control.clock_running("p")


def test_turn_based_source_returns_input_that_arrives_while_the_controls_are_released():
    """A dropped or late clock command must never swallow an action the person really sent."""
    base = ManualClock(start_ms=0)
    clock = PausableClock(base)
    control = SessionControl()
    control.handle_line('{"kind": "input", "player": "p", "action": 7}')

    class ExplodingSleeper:
        def sleep_ms(self, ms: int) -> None:
            raise AssertionError("the latched input should return before any wait")

    source = TransportSource(control, clock=clock, paced=False, sleeper=ExplodingSleeper())
    assert source.get_action("p", observation=None, window_ms=12) == 7


@pytest.mark.parametrize("when,elapsed", [("before", 0), ("waiting", 10), ("paused", 105)])
def test_turn_based_source_returns_none_on_stop(when, elapsed):
    base = ManualClock(0)
    clock = PausableClock(base)
    control = SessionControl(clock)
    if when == "before":
        control.handle_line('{"kind":"stop"}')

    class StoppingSleeper:
        def sleep_ms(self, ms):
            assert when != "before", "a stopped source must not wait"
            base.advance(ms)
            if when == "paused" and base.now_ms() == 5:
                control.pause()
            if base.now_ms() == (105 if when == "paused" else 10):
                control.handle_line('{"kind":"stop"}')

    source = TransportSource(control, clock=clock, paced=False, sleeper=StoppingSleeper(), slice_ms=5)
    assert source.get_action("p", observation=None, window_ms=None) is None
    assert base.now_ms() == elapsed


# --- The result envelope ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("result", "expected"),
    [
        pytest.param(
            EpisodeResult(
                ticks=12,
                scores={"player_0": 3.0, "player_1": -1.0},
                reason="error",
                step_timeouts={"player_0": 0},
                recording_id="rec-1",
                failed_player="player_1",
                error="KeyError: 'evening' (agent.py:88 in assign)",
            ),
            {
                "kind": "result",
                "ticks": 12,
                "scores": {"player_0": 3.0, "player_1": -1.0},
                "reason": "error",
                "step_timeouts": {"player_0": 0},
                "recording_id": "rec-1",
                "failed_player": "player_1",
                "error": "KeyError: 'evening' (agent.py:88 in assign)",
            },
            id="failed-episode",
        ),
        pytest.param(
            EpisodeResult(ticks=3, scores={"player_0": 1.0}, reason="terminated", step_timeouts={}),
            {
                "kind": "result",
                "ticks": 3,
                "scores": {"player_0": 1.0},
                "reason": "terminated",
                "step_timeouts": {},
                "recording_id": None,
                "failed_player": None,
                "error": None,
            },
            id="clean-episode",
        ),
    ],
)
def test_result_envelope_reports_the_complete_episode(
    result: EpisodeResult,
    expected: dict[str, Any],
) -> None:
    assert result_envelope(result) == expected
