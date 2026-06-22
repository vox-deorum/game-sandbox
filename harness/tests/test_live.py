"""The live runner: config parsing, slot binding, and the paced/pausable loop.

The loop tests run a one-slot fake AEC env under a :class:`PausableClock` over a
:class:`ManualClock`, with an injected sleeper that advances that clock instead of really
sleeping, so cadence, pause, and stop are all deterministic. Each test asserts behaviour
(which actions reached the env, that stepping is blocked while paused, that the streamed bytes
equal the stored bytes) rather than wall-clock timing.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import EnvironmentEntry, EnvironmentMeta
from game_sandbox_harness.live import (
    LiveConfig,
    LiveConfigError,
    SlotBinding,
    build_slots,
    parse_config,
    run_live_loop,
)
from game_sandbox_harness.live_io import (
    PausableClock,
    ProtocolStream,
    SessionControl,
    TransportSource,
    result_envelope,
)
from game_sandbox_harness.session import AgentSlot, Episode, ExternalSlot

DEFAULT_ACTION = -1
FLAP = 1


# --- fakes ------------------------------------------------------------------------------


class FakeEnv:
    """A one-slot AEC env living for ``n_steps``, rewarding 1.0 a step, recording nothing the
    harness does not already record. ``on_step`` fires just before each accepted step."""

    def __init__(self, n_steps: int, on_step: Any = None) -> None:
        self._n = n_steps
        self.possible_agents = ["player_0"]
        self._on_step = on_step

    def reset(self, seed: int | None = None, options: Any = None) -> None:
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

    def step(self, action: Any) -> None:
        a = self.agent_selection
        if self.terminations[a] or self.truncations[a]:
            self.agents.remove(a)
            return
        if self._on_step is not None:
            self._on_step()
        self.rewards[a] = 1.0
        self._i += 1
        self._obs = self._i
        if self._i >= self._n:
            self.terminations[a] = True


def make_entry(
    n_steps: int,
    *,
    pace_interval_ms: int | None,
    human_timeout_ms: int | None = None,
    on_step: Any = None,
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
        step_limit_ms=1000,
        episode_limit_ms=120_000,
        messaging=False,
        message_cap=None,
        llm=False,
        renderer="fake",
    )
    return EnvironmentEntry(
        meta=meta,
        make=lambda: FakeEnv(n_steps, on_step=on_step),
        default_action=lambda slot_id: DEFAULT_ACTION,
    )


class AdvancingSleeper:
    """A sleeper that advances the base clock instead of really sleeping. Optionally runs a
    callback on a chosen call so a test can inject a command mid-wait deterministically."""

    def __init__(self, base: ManualClock, *, at: int | None = None, do: Any = None) -> None:
        self._base = base
        self._at = at
        self._do = do
        self.calls = 0

    def sleep_ms(self, ms: int) -> None:
        self.calls += 1
        self._base.advance(ms if ms > 0 else 1)
        if self._at is not None and self.calls == self._at and self._do is not None:
            self._do()


class _ListSink:
    def __init__(self, out: list[str]) -> None:
        self._out = out

    def write(self, text: str) -> None:
        self._out.append(text)

    def flush(self) -> None:
        pass


def _recorded_actions(recording_path: Path) -> list[Any]:
    actions: list[Any] = []
    for line in recording_path.read_text(encoding="utf-8").splitlines()[1:]:  # skip header
        actions.append(json.loads(line)["agents"]["player_0"]["action"])
    return actions


# --- parse_config -----------------------------------------------------------------------


def test_parse_config_minimal_and_full():
    cfg = parse_config(
        [
            json.dumps(
                {
                    "env_id": "flappy_bird",
                    "seed": 7,
                    "slots": {"player_0": {"kind": "external"}},
                    "human_timeout_ms": 5000,
                    "recording_dir": "/recordings",
                    "recording_id": "abc",
                    "players": {"player_0": {"kind": "human", "label": "alice", "user": "alice"}},
                }
            )
        ]
    )
    assert cfg == LiveConfig(
        env_id="flappy_bird",
        seed=7,
        slots={"player_0": SlotBinding(kind="external")},
        human_timeout_ms=5000,
        recording_dir="/recordings",
        recording_id="abc",
        players={"player_0": {"kind": "human", "label": "alice", "user": "alice"}},
    )


def test_parse_config_players_defaults_to_none():
    payload = {"env_id": "fake", "slots": {"p": {"kind": "external"}}, "recording_dir": "/r"}
    assert parse_config([json.dumps(payload)]).players is None


def test_parse_config_defaults_seed_and_optional_fields():
    payload = {"env_id": "fake", "slots": {"p": {"kind": "external"}}, "recording_dir": "/r"}
    cfg = parse_config([json.dumps(payload)])
    assert cfg.seed == 0
    assert cfg.human_timeout_ms is None
    assert cfg.recording_id is None
    # The Stage 6 timeout overrides default to None (take the environment metadata default).
    assert cfg.step_timeout_ms is None
    assert cfg.episode_timeout_ms is None
    assert cfg.headless is False


def test_parse_config_reads_workflow_overrides():
    payload = {
        "env_id": "fake",
        "slots": {"p": {"kind": "builtin-agent"}},
        "recording_dir": "/r",
        "step_timeout_ms": 250,
        "episode_timeout_ms": 60_000,
        "headless": True,
    }
    cfg = parse_config([json.dumps(payload)])
    assert cfg.step_timeout_ms == 250
    assert cfg.episode_timeout_ms == 60_000
    assert cfg.headless is True


@pytest.mark.parametrize(
    "payload",
    [
        {"slots": {"p": {"kind": "external"}}, "recording_dir": "/r"},  # no env_id
        {"env_id": "fake", "recording_dir": "/r"},  # no slots
        {"env_id": "fake", "slots": {}, "recording_dir": "/r"},  # empty slots
        {"env_id": "fake", "slots": {"p": {"kind": "robot"}}, "recording_dir": "/r"},  # bad kind
        {"env_id": "fake", "slots": {"p": {"kind": "external"}}},  # no recording_dir
        {"env_id": "fake", "slots": {"p": {"kind": "ext"}}, "recording_dir": "/r", "seed": 1.5},
        # players: bad kind, missing label, and a non-object map.
        {
            "env_id": "fake",
            "slots": {"p": {"kind": "external"}},
            "recording_dir": "/r",
            "players": {"p": {"kind": "robot", "label": "x"}},
        },
        {
            "env_id": "fake",
            "slots": {"p": {"kind": "external"}},
            "recording_dir": "/r",
            "players": {"p": {"kind": "human"}},
        },
        {
            "env_id": "fake",
            "slots": {"p": {"kind": "external"}},
            "recording_dir": "/r",
            "players": [],
        },
        {  # a non-integer timeout override is rejected
            "env_id": "fake",
            "slots": {"p": {"kind": "external"}},
            "recording_dir": "/r",
            "step_timeout_ms": "soon",
        },
        {  # a non-boolean headless flag is rejected
            "env_id": "fake",
            "slots": {"p": {"kind": "external"}},
            "recording_dir": "/r",
            "headless": "yes",
        },
    ],
)
def test_parse_config_rejects_bad_payloads(payload: dict[str, Any]):
    with pytest.raises(LiveConfigError):
        parse_config([json.dumps(payload)])


def test_parse_config_requires_exactly_one_argument():
    with pytest.raises(LiveConfigError):
        parse_config([])
    with pytest.raises(LiveConfigError):
        parse_config(["{}", "{}"])


# --- build_slots ------------------------------------------------------------------------


def test_build_slots_external_resolves_timeout_override_then_metadata():
    control = SessionControl()
    clock = PausableClock(ManualClock())
    sleeper = AdvancingSleeper(ManualClock())
    entry = make_entry(3, pace_interval_ms=None, human_timeout_ms=8000)

    # No override → metadata default.
    cfg = LiveConfig("fake", 0, {"player_0": SlotBinding("external")}, None, "/r", None)
    slots = build_slots(cfg, entry, control, clock, sleeper)
    slot = slots["player_0"]
    assert isinstance(slot, ExternalSlot)
    assert slot.timeout_ms == 8000
    assert isinstance(slot.source, TransportSource)

    # Override wins.
    cfg = LiveConfig("fake", 0, {"player_0": SlotBinding("external")}, 2000, "/r", None)
    slots = build_slots(cfg, entry, control, clock, sleeper)
    assert isinstance(slots["player_0"], ExternalSlot)
    assert slots["player_0"].timeout_ms == 2000


def test_build_slots_builtin_agent_loads_through_manifest(tmp_path: Path):
    (tmp_path / "manifest.json").write_text(
        json.dumps({"entry_point": "agent", "class_name": "A", "template_version": 1}),
        encoding="utf-8",
    )
    (tmp_path / "agent.py").write_text(
        "class A:\n    def reset(self, seed): pass\n    def act(self, observation): return 0\n",
        encoding="utf-8",
    )
    control = SessionControl()
    clock = PausableClock(ManualClock())
    sleeper = AdvancingSleeper(ManualClock())
    entry = make_entry(3, pace_interval_ms=16)
    cfg = LiveConfig(
        "fake", 0, {"player_0": SlotBinding("builtin-agent", path=str(tmp_path))}, None, "/r", None
    )
    slots = build_slots(cfg, entry, control, clock, sleeper)
    assert isinstance(slots["player_0"], AgentSlot)


# --- the live loop ----------------------------------------------------------------------


def _run_external(
    tmp_path: Path,
    n_steps: int,
    pace_interval_ms: int | None,
    *,
    preload: list[str] | None = None,
    sleeper: Any = None,
    base: ManualClock | None = None,
    on_step: Any = None,
    human_timeout_ms: int | None = None,
) -> tuple[Any, list[str], Path]:
    """Wire a one external slot live session over the tee store, run the loop, and emit the
    result envelope exactly as ``main`` does. Returns (result, streamed_lines, recording_path)."""
    base = base or ManualClock()
    clock = PausableClock(base)
    control = SessionControl(clock)
    for line in preload or []:
        control.handle_line(line)
    streamed: list[str] = []
    protocol = ProtocolStream(_ListSink(streamed))  # type: ignore[arg-type]
    from game_sandbox_harness.live_io import build_tee_store

    store = build_tee_store(str(tmp_path), protocol)
    entry = make_entry(n_steps, pace_interval_ms=pace_interval_ms, on_step=on_step)
    paced = pace_interval_ms is not None
    sleeper = sleeper or AdvancingSleeper(base)
    source = TransportSource(control, clock=clock, paced=paced, sleeper=sleeper)
    slot = ExternalSlot(source, timeout_ms=human_timeout_ms)
    with Episode(entry, {"player_0": slot}, seed=1, store=store, recording_id="r", clock=clock) as episode:
        run_live_loop(
            episode,
            pace_interval_ms=pace_interval_ms,
            control=control,
            clock=clock,
            sleeper=sleeper,
        )
    result = episode.result()
    protocol.emit_envelope(result_envelope(result))
    return result, streamed, tmp_path / "r" / "recording.jsonl"


def test_paced_latched_input_drives_the_slot_then_defaults(tmp_path: Path):
    # One flap latched before the run: the first step takes it, later steps default (noop).
    result, _streamed, recording = _run_external(
        tmp_path,
        n_steps=3,
        pace_interval_ms=16,
        preload=['{"kind": "input", "slot": "player_0", "action": 1}'],
    )
    assert result.ticks == 3
    assert result.reason == "terminated"
    assert _recorded_actions(recording) == [FLAP, DEFAULT_ACTION, DEFAULT_ACTION]


def test_paced_with_no_input_keeps_moving_on_defaults(tmp_path: Path):
    result, _streamed, recording = _run_external(tmp_path, n_steps=4, pace_interval_ms=16)
    assert result.ticks == 4
    assert result.reason == "terminated"
    assert _recorded_actions(recording) == [DEFAULT_ACTION] * 4


def test_streamed_bytes_equal_stored_bytes_and_result_is_not_recorded(tmp_path: Path):
    result, streamed, recording = _run_external(tmp_path, n_steps=2, pace_interval_ms=16)

    # Every state line streamed is exactly the line on disk; the trailing result envelope is the
    # only streamed line beyond the recording.
    recording_bytes = recording.read_bytes()
    streamed_text = "".join(streamed)
    assert streamed_text.encode("utf-8").startswith(recording_bytes)

    tail = streamed_text[len(recording_bytes.decode("utf-8")) :].strip()
    envelope = json.loads(tail)
    assert envelope["kind"] == "result"
    assert envelope["ticks"] == result.ticks == 2
    assert envelope["recording_id"] == "r"
    # No recording line carries a kind.
    for line in recording.read_text(encoding="utf-8").splitlines():
        assert "kind" not in json.loads(line)


def test_stop_command_ends_the_session_with_reason_stopped(tmp_path: Path):
    result, streamed, _recording = _run_external(
        tmp_path,
        n_steps=100,
        pace_interval_ms=16,
        preload=['{"kind": "stop"}'],
    )
    assert result.ticks == 0
    assert result.reason == "stopped"
    # The result envelope still goes out.
    assert json.loads("".join(streamed).strip().splitlines()[-1])["reason"] == "stopped"


def test_pause_blocks_stepping_until_resume(tmp_path: Path):
    base = ManualClock()
    paused_samples: list[bool] = []
    control_box: dict[str, SessionControl] = {}

    def sample() -> None:
        paused_samples.append(control_box["control"].paused)

    # The sleeper resumes on its 3rd call, so the pause-wait holds for two slices first.
    # We reach into the live wiring by reconstructing it here rather than via _run_external,
    # because the resume has to call the same control the loop reads.
    clock = PausableClock(base)
    control = SessionControl(clock)
    control_box["control"] = control
    control.handle_line('{"kind": "pause"}')
    sleeper = AdvancingSleeper(base, at=3, do=lambda: control.resume())

    from game_sandbox_harness.live_io import build_tee_store

    streamed: list[str] = []
    store = build_tee_store(str(tmp_path), ProtocolStream(_ListSink(streamed)))  # type: ignore[arg-type]
    entry = make_entry(2, pace_interval_ms=16, on_step=sample)
    source = TransportSource(control, clock=clock, paced=True, sleeper=sleeper)
    slots = {"player_0": ExternalSlot(source)}
    with Episode(entry, slots, seed=1, store=store, recording_id="r", clock=clock) as episode:
        run_live_loop(episode, pace_interval_ms=16, control=control, clock=clock, sleeper=sleeper)

    assert episode.result().ticks == 2
    # No step ran while paused: every sampled pause-state at step time is False.
    assert paused_samples == [False, False]
    # The pause-wait actually waited before the first step (sleeper ran at least its 3 calls).
    assert sleeper.calls >= 3


def test_turn_based_blocks_for_input_then_steps(tmp_path: Path):
    # No pace interval: the source blocks until an input arrives. Feed one mid-wait, then the
    # env terminates after a single step.
    base = ManualClock()
    control_holder: dict[str, SessionControl] = {}
    input_line = '{"kind": "input", "slot": "player_0", "action": 5}'
    sleeper = AdvancingSleeper(
        base,
        at=2,
        do=lambda: control_holder["c"].handle_line(input_line),
    )
    clock = PausableClock(base)
    control = SessionControl(clock)
    control_holder["c"] = control

    from game_sandbox_harness.live_io import build_tee_store

    streamed: list[str] = []
    store = build_tee_store(str(tmp_path), ProtocolStream(_ListSink(streamed)))  # type: ignore[arg-type]
    entry = make_entry(1, pace_interval_ms=None, human_timeout_ms=10_000)
    source = TransportSource(control, clock=clock, paced=False, sleeper=sleeper, slice_ms=5)
    with Episode(
        entry,
        {"player_0": ExternalSlot(source, timeout_ms=10_000)},
        seed=1,
        store=store,
        recording_id="r",
        clock=clock,
    ) as episode:
        run_live_loop(episode, pace_interval_ms=None, control=control, clock=clock, sleeper=sleeper)

    assert episode.result().ticks == 1
    assert _recorded_actions(tmp_path / "r" / "recording.jsonl") == [5]


# --- stdout hygiene, as a real subprocess over a real environment -----------------------


def test_module_subprocess_keeps_stdout_clean_and_classifiable(tmp_path: Path):
    """Run ``python -m game_sandbox_harness.live`` against Flappy Bird, which imports PyGame and
    prints a banner. The banner and any stray prints must land on stderr; stdout must carry only
    classifiable protocol lines — the header and states (no top-level ``kind``) and the trailing
    ``result`` envelope. A ``stop`` on stdin ends the run promptly."""
    pytest.importorskip("game_sandbox_environments", reason="environments package not installed")

    config = {
        "env_id": "flappy_bird",
        "seed": 0,
        "slots": {"player_0": {"kind": "external"}},
        "recording_dir": str(tmp_path),
        "recording_id": "r",
    }
    proc = subprocess.run(
        [sys.executable, "-m", "game_sandbox_harness.live", json.dumps(config)],
        input='{"kind": "stop"}\n',
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert proc.returncode == 0, proc.stderr
    out_lines = [line for line in proc.stdout.splitlines() if line.strip()]
    assert out_lines, "the protocol stream should carry at least the header"

    kinds: list[str | None] = []
    for line in out_lines:
        obj = json.loads(line)  # every stdout line must be valid JSON, never a banner
        kinds.append(obj.get("kind"))
    # Exactly one envelope, the trailing result; everything before it is a recording line.
    assert kinds[-1] == "result"
    assert all(kind is None for kind in kinds[:-1])
    # The first protocol line is the recording header.
    assert json.loads(out_lines[0])["environment"] == "flappy_bird"
    # The PyGame banner, if any, went to diagnostics — never to the protocol stream.
    assert "pygame" not in proc.stdout.lower()
