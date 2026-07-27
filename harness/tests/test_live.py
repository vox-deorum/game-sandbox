"""The live runner: config parsing, player binding, and the paced/pausable loop.

The loop tests run a one-player fake AEC env under a :class:`PausableClock` over a
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
from game_sandbox_harness.environment import (
    EnvironmentEntry,
    EnvironmentMeta,
    PlayerBounds,
    SeatPlan,
    SeatPlans,
    resolve_parameters,
)
from game_sandbox_harness.live import (
    UNSET_TIMEOUT,
    LiveConfig,
    LiveConfigError,
    PlayerBinding,
    build_players,
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
from game_sandbox_harness.session import AgentPlayer, Episode, ExternalPlayer

DEFAULT_ACTION = -1
FLAP = 1
PARAMETERS = {"players": 1}


# --- fakes ------------------------------------------------------------------------------


class FakeEnv:
    """A one-player AEC env living for ``n_steps``, rewarding 1.0 a step, recording nothing the
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
    with_overlay: bool = False,
) -> EnvironmentEntry:
    meta = EnvironmentMeta(
        env_id="fake",
        display_name="Fake",
        description="A deterministic fake.",
        layout=PlayerBounds(1, 1),
        human_players=("player_0",),
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
        make=lambda _parameters: FakeEnv(n_steps, on_step=on_step),
        default_action=lambda env, player_id: DEFAULT_ACTION,
        overlay=(lambda env: {"i": env._i}) if with_overlay else None,
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
                    "parameters": {"players": 1, "pipe_gap": 100},
                    "seed": 7,
                    "player_bindings": {"player_0": {"kind": "external"}},
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
        player_bindings={"player_0": PlayerBinding(kind="external")},
        human_timeout_ms=5000,
        recording_dir="/recordings",
        recording_id="abc",
        parameters={"players": 1, "pipe_gap": 100},
        players={"player_0": {"kind": "human", "label": "alice", "user": "alice"}},
        layout=cfg.layout,
    )


def test_parse_config_requires_players():
    payload = {
        "env_id": "fake",
        "parameters": PARAMETERS,
        "player_bindings": {"p": {"kind": "external"}},
        "recording_dir": "/r",
    }
    with pytest.raises(LiveConfigError):
        parse_config([json.dumps(payload)])


def test_parse_config_resolves_an_injected_wide_layout_and_rejects_missing_or_foreign_players():
    wide_entry = EnvironmentEntry(
        meta=EnvironmentMeta(
            env_id="wide",
            display_name="Wide",
            description="A synthetic wide layout.",
            layout=SeatPlans((SeatPlan("uneven", "Uneven", ((0, 2), (1,))),)),
            human_players=("player_0",),
            human_timeout_ms=None,
            recommended_episode_ticks=1,
            pace_interval_ms=None,
            step_limit_ms=1000,
            episode_limit_ms=1000,
            messaging=False,
            message_cap=None,
            llm=False,
            renderer="fake",
        ),
        make=lambda _parameters: FakeEnv(1),
        default_action=lambda _env, _player_id: DEFAULT_ACTION,
    )
    payload = {
        "env_id": "wide",
        "parameters": {"seat_plan": "uneven"},
        "player_bindings": {
            "player_0": {"kind": "builtin-agent"},
            "player_1": {"kind": "builtin-agent"},
            "player_2": {"kind": "builtin-agent"},
        },
        "players": {
            "player_0": {"kind": "agent", "label": "A"},
            "player_1": {"kind": "agent", "label": "B"},
            "player_2": {"kind": "agent", "label": "A"},
        },
        "recording_dir": "/r",
    }
    config = parse_config([json.dumps(payload)], entry=wide_entry)
    assert config.layout is not None
    assert config.layout.plan_key == "uneven"
    assert config.layout.seats[0].players == ("player_0", "player_2")

    payload["player_bindings"].pop("player_2")
    with pytest.raises(LiveConfigError, match="missing players"):
        parse_config([json.dumps(payload)], entry=wide_entry)
    payload["player_bindings"]["player_2"] = {"kind": "builtin-agent"}
    payload["players"]["player_9"] = payload["players"].pop("player_2")
    with pytest.raises(LiveConfigError, match="unknown players"):
        parse_config([json.dumps(payload)], entry=wide_entry)


def test_parse_config_defaults_seed_and_optional_fields():
    payload = {
        "env_id": "flappy_bird",
        "parameters": {"players": 1, "pipe_gap": 100},
        "player_bindings": {"player_0": {"kind": "external"}},
        "players": {"player_0": {"kind": "human", "label": "Human"}},
        "recording_dir": "/r",
    }
    cfg = parse_config([json.dumps(payload)])
    assert cfg.seed == 0
    assert cfg.human_timeout_ms is UNSET_TIMEOUT
    assert cfg.recording_id is None
    # The Stage 6 timeout overrides default to None (take the environment metadata default).
    assert cfg.step_timeout_ms is None
    assert cfg.episode_timeout_ms is None
    # The Stage 8 messaging keys default to None (let the environment metadata decide).
    assert cfg.messaging_enabled is None
    assert cfg.message_cap is None
    assert cfg.headless is False


def test_parse_config_reads_workflow_overrides():
    payload = {
        "env_id": "flappy_bird",
        "parameters": {"players": 1, "pipe_gap": 100},
        "player_bindings": {"player_0": {"kind": "builtin-agent"}},
        "players": {"player_0": {"kind": "agent", "label": "Agent"}},
        "recording_dir": "/r",
        "step_timeout_ms": 250,
        "episode_timeout_ms": 60_000,
        "headless": True,
    }
    cfg = parse_config([json.dumps(payload)])
    assert cfg.step_timeout_ms == 250
    assert cfg.episode_timeout_ms == 60_000
    assert cfg.headless is True


def test_parse_config_reads_messaging_keys():
    payload = {
        "env_id": "flappy_bird",
        "parameters": {"players": 1, "pipe_gap": 100},
        "player_bindings": {"player_0": {"kind": "builtin-agent"}},
        "players": {"player_0": {"kind": "agent", "label": "Agent"}},
        "recording_dir": "/r",
        "messaging_enabled": False,
        "message_cap": 80,
    }
    cfg = parse_config([json.dumps(payload)])
    assert cfg.messaging_enabled is False
    assert cfg.message_cap == 80


@pytest.mark.parametrize(
    "payload",
    [
        {"player_bindings": {"p": {"kind": "external"}}, "recording_dir": "/r"},  # no env_id
        {"env_id": "fake", "parameters": PARAMETERS, "recording_dir": "/r"},  # no players
        {
            "env_id": "fake",
            "parameters": PARAMETERS,
            "player_bindings": {},
            "recording_dir": "/r",
        },  # empty players
        {
            "env_id": "fake",
            "parameters": PARAMETERS,
            "player_bindings": {"p": {"kind": "robot"}},
            "recording_dir": "/r",
        },  # bad kind
        {
            "env_id": "fake",
            "parameters": PARAMETERS,
            "player_bindings": {"p": {"kind": "external"}},
        },  # no recording_dir
        {
            "env_id": "fake",
            "parameters": PARAMETERS,
            "player_bindings": {"p": {"kind": "ext"}},
            "recording_dir": "/r",
            "seed": 1.5,
        },
        # players: bad kind, missing label, and a non-object map.
        {
            "env_id": "fake",
            "parameters": PARAMETERS,
            "player_bindings": {"p": {"kind": "external"}},
            "recording_dir": "/r",
            "players": {"p": {"kind": "robot", "label": "x"}},
        },
        {
            "env_id": "fake",
            "parameters": PARAMETERS,
            "player_bindings": {"p": {"kind": "external"}},
            "recording_dir": "/r",
            "players": {"p": {"kind": "human"}},
        },
        {
            "env_id": "fake",
            "parameters": PARAMETERS,
            "player_bindings": {"p": {"kind": "external"}},
            "recording_dir": "/r",
            "players": [],
        },
        {  # a non-integer timeout override is rejected
            "env_id": "fake",
            "parameters": PARAMETERS,
            "player_bindings": {"p": {"kind": "external"}},
            "recording_dir": "/r",
            "step_timeout_ms": "soon",
        },
        {  # a non-boolean headless flag is rejected
            "env_id": "fake",
            "parameters": PARAMETERS,
            "player_bindings": {"p": {"kind": "external"}},
            "recording_dir": "/r",
            "headless": "yes",
        },
        {  # a non-boolean messaging_enabled is rejected
            "env_id": "fake",
            "parameters": PARAMETERS,
            "player_bindings": {"p": {"kind": "external"}},
            "recording_dir": "/r",
            "messaging_enabled": "on",
        },
        {  # a non-integer message_cap is rejected
            "env_id": "fake",
            "parameters": PARAMETERS,
            "player_bindings": {"p": {"kind": "external"}},
            "recording_dir": "/r",
            "message_cap": "lots",
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


# --- build_players ------------------------------------------------------------------------


def test_build_players_external_resolves_timeout_override_then_metadata():
    control = SessionControl()
    clock = PausableClock(ManualClock())
    sleeper = AdvancingSleeper(ManualClock())
    entry = make_entry(3, pace_interval_ms=None, human_timeout_ms=8000)

    # No override → metadata default.
    cfg = LiveConfig(
        "fake", 0, {"player_0": PlayerBinding("external")}, UNSET_TIMEOUT, "/r", None, {"players": 1}
    )
    players = build_players(cfg, entry, control, clock, sleeper)
    player = players["player_0"]
    assert isinstance(player, ExternalPlayer)
    assert player.timeout_ms == 8000
    assert isinstance(player.source, TransportSource)

    # Override wins.
    cfg = LiveConfig("fake", 0, {"player_0": PlayerBinding("external")}, 2000, "/r", None, {"players": 1})
    players = build_players(cfg, entry, control, clock, sleeper)
    assert isinstance(players["player_0"], ExternalPlayer)
    assert players["player_0"].timeout_ms == 2000

    # An explicit null disables the metadata timeout. It is distinct from the absent override.
    cfg = LiveConfig("fake", 0, {"player_0": PlayerBinding("external")}, None, "/r", None, {"players": 1})
    players = build_players(cfg, entry, control, clock, sleeper)
    assert isinstance(players["player_0"], ExternalPlayer)
    assert players["player_0"].timeout_ms is None


def test_build_players_builtin_agent_loads_through_manifest(tmp_path: Path):
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
        "fake",
        0,
        {"player_0": PlayerBinding("builtin-agent", path=str(tmp_path))},
        None,
        "/r",
        None,
        {"players": 1},
    )
    players = build_players(cfg, entry, control, clock, sleeper)
    assert isinstance(players["player_0"], AgentPlayer)


def test_build_players_builtin_agent_without_path_resolves_per_env_default(monkeypatch):
    # A builtin-agent player with no explicit overlay path loads the per-environment baseline staged at
    # /opt/agents/builtin/<env_id>. The directory is env-keyed because the Naive policy differs per
    # environment (Hearts reads the legal-action mask; Flappy Bird reads a flat array), so a flat
    # default would load the wrong baseline into a Hearts seat.
    import game_sandbox_harness.live as live

    captured: list[str] = []
    monkeypatch.setattr(live, "load_agent", lambda path: captured.append(path) or object())
    control = SessionControl()
    clock = PausableClock(ManualClock())
    sleeper = AdvancingSleeper(ManualClock())
    entry = make_entry(3, pace_interval_ms=None)
    cfg = LiveConfig(
        "hearts", 0, {"player_0": PlayerBinding("builtin-agent")}, None, "/r", None, {"players": 1}
    )
    players = build_players(cfg, entry, control, clock, sleeper)
    assert captured == ["/opt/agents/builtin/hearts"]
    assert isinstance(players["player_0"], AgentPlayer)


def test_build_players_constructs_distinct_agents_for_repeated_paths(monkeypatch):
    import game_sandbox_harness.live as live

    constructed: list[object] = []
    monkeypatch.setattr(live, "load_agent", lambda _path: constructed.append(object()) or constructed[-1])
    entry = make_entry(1, pace_interval_ms=None)
    config = LiveConfig(
        "fake",
        0,
        {
            "player_0": PlayerBinding("builtin-agent", "/agents/seat_0"),
            "player_1": PlayerBinding("builtin-agent", "/agents/seat_0"),
        },
        None,
        "/r",
        None,
        {"players": 1},
    )
    players = build_players(
        config,
        entry,
        SessionControl(),
        PausableClock(ManualClock()),
        AdvancingSleeper(ManualClock()),
    )
    assert len(constructed) == 2
    assert isinstance(players["player_0"], AgentPlayer)
    assert isinstance(players["player_1"], AgentPlayer)
    assert players["player_0"].agent is not players["player_1"].agent


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
    with_overlay: bool = False,
) -> tuple[Any, list[str], Path]:
    """Wire a one external player live session over the tee store, run the loop, and emit the
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
    entry = make_entry(n_steps, pace_interval_ms=pace_interval_ms, on_step=on_step, with_overlay=with_overlay)
    paced = pace_interval_ms is not None
    sleeper = sleeper or AdvancingSleeper(base)
    source = TransportSource(control, clock=clock, paced=paced, sleeper=sleeper)
    player = ExternalPlayer(source, timeout_ms=human_timeout_ms)
    with Episode(
        entry,
        {"player_0": player},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=clock,
    ) as episode:
        # The same opening-frame stream main does: turn-based only, streamed but never recorded.
        opening = episode.opening_state()
        if opening is not None:
            protocol.emit_state(opening)
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


def test_paced_latched_input_drives_the_player_then_defaults(tmp_path: Path):
    # One flap latched before the run: the first step takes it, later steps default (noop).
    result, _streamed, recording = _run_external(
        tmp_path,
        n_steps=3,
        pace_interval_ms=16,
        preload=['{"kind": "input", "player": "player_0", "action": 1}'],
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


def test_turn_based_opening_frame_streams_before_the_loop_but_is_not_recorded(tmp_path: Path):
    # A turn-based env streams a pre-action opening frame (the deal) so a human who must act first
    # sees the table; it is streamed only, never persisted, so the recording still begins at step 0.
    result, streamed, recording = _run_external(
        tmp_path, n_steps=2, pace_interval_ms=None, human_timeout_ms=10, with_overlay=True
    )
    assert result.ticks == 2

    recording_lines = recording.read_text(encoding="utf-8").splitlines()
    streamed_lines = "".join(streamed).strip().splitlines()
    # Recording: header + 2 step frames. Stream: header + opening + 2 step frames + result envelope.
    assert len(recording_lines) == 3
    assert len(streamed_lines) == len(recording_lines) + 2

    # The streamed opening frame sits right after the header: the dealt overlay, with no agent acted.
    opening = json.loads(streamed_lines[1])
    assert opening["tick"] == 0
    assert opening["agents"] == {}
    assert opening["overlay"] == {"i": 0}
    # No recorded line is an actionless opening frame: every recorded state carries its acting agent.
    for line in recording_lines[1:]:
        assert json.loads(line)["agents"] != {}


def test_run_starts_command_pump_after_header_and_turn_opening(monkeypatch, tmp_path: Path):
    """The stdin reader begins only after a local client can render the opening table."""
    import game_sandbox_harness.live as live
    from game_sandbox_harness.live_io import build_tee_store

    base = ManualClock()
    clock = PausableClock(base)
    control = SessionControl(clock)
    streamed: list[str] = []
    seen_when_pump_started: list[str] = []

    def fake_command_pump(lines, received_control):
        seen_when_pump_started.extend(streamed)
        received_control.handle_line('{"kind":"stop"}')

    monkeypatch.setattr(live, "start_command_pump", fake_command_pump)
    config = LiveConfig(
        "fake",
        0,
        {"player_0": PlayerBinding("external")},
        None,
        str(tmp_path),
        "r",
        {"players": 1},
        players={"player_0": {"kind": "human", "label": "Human"}},
    )
    protocol = ProtocolStream(_ListSink(streamed))  # type: ignore[arg-type]

    assert (
        live.run(
            make_entry(1, pace_interval_ms=None, with_overlay=True),
            config,
            protocol=protocol,
            control=control,
            clock=clock,
            sleeper=AdvancingSleeper(base),
            store=build_tee_store(str(tmp_path), protocol),
            command_lines=(),
        )
        == 0
    )

    assert len(seen_when_pump_started) == 2
    assert json.loads(seen_when_pump_started[0])["environment"] == "fake"
    opening = json.loads(seen_when_pump_started[1])
    assert opening["tick"] == 0
    assert opening["agents"] == {}


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
    players = {"player_0": ExternalPlayer(source)}
    with Episode(
        entry,
        players,
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=clock,
    ) as episode:
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
    input_line = '{"kind": "input", "player": "player_0", "action": 5}'
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
        {"player_0": ExternalPlayer(source, timeout_ms=10_000)},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=clock,
    ) as episode:
        run_live_loop(episode, pace_interval_ms=None, control=control, clock=clock, sleeper=sleeper)

    assert episode.result().ticks == 1
    assert _recorded_actions(tmp_path / "r" / "recording.jsonl") == [5]


# --- end-to-end human chat over the transport -------------------------------------------


def _messaging_entry(n_steps: int, *, messaging: bool) -> EnvironmentEntry:
    meta = EnvironmentMeta(
        env_id="fake-chat",
        display_name="Fake Chat",
        description="A deterministic fake with messaging.",
        layout=PlayerBounds(1, 1),
        human_players=("player_0",),
        human_timeout_ms=None,
        recommended_episode_ticks=n_steps,
        pace_interval_ms=16,
        step_limit_ms=1000,
        episode_limit_ms=120_000,
        messaging=messaging,
        message_cap=120,
        llm=False,
        renderer="fake",
    )
    return EnvironmentEntry(
        meta=meta,
        make=lambda _parameters: FakeEnv(n_steps),
        default_action=lambda env, player_id: DEFAULT_ACTION,
        overlay=None,
    )


def _messages_in(recording_path: Path) -> list[list[dict]]:
    out: list[list[dict]] = []
    for line in recording_path.read_text(encoding="utf-8").splitlines()[1:]:  # skip header
        out.append(json.loads(line).get("messages", []))
    return out


def test_human_chat_frame_over_transport_lands_in_the_recording(tmp_path: Path):
    # The full wiring: parse config, build the external player's TransportSource, configure the chat
    # gate from the effective messaging decision, feed a chat frame on stdin, and see it recorded.
    base = ManualClock()
    clock = PausableClock(base)
    control = SessionControl(clock)
    sleeper = AdvancingSleeper(base)
    from game_sandbox_harness.live_io import build_tee_store

    streamed: list[str] = []
    store = build_tee_store(str(tmp_path), ProtocolStream(_ListSink(streamed)))  # type: ignore[arg-type]
    entry = _messaging_entry(2, messaging=True)
    source = TransportSource(control, clock=clock, paced=True, sleeper=sleeper)
    with Episode(
        entry,
        {"player_0": ExternalPlayer(source, message_source=source)},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=clock,
        messaging=None,
    ) as episode:
        control.configure_chat(episode.messaging_enabled)
        control.handle_line('{"kind":"chat","player":"player_0","tick":0,"to":null,"text":"hello table"}')
        run_live_loop(episode, pace_interval_ms=16, control=control, clock=clock, sleeper=sleeper)

    # The broadcast the human queued was validated and recorded on the first stepped tick.
    per_tick = _messages_in(tmp_path / "r" / "recording.jsonl")
    assert per_tick[0] == [{"from": "player_0", "to": None, "text": "hello table"}]


def test_human_chat_frame_is_dropped_when_messaging_disabled_by_config(tmp_path: Path):
    base = ManualClock()
    clock = PausableClock(base)
    control = SessionControl(clock)
    sleeper = AdvancingSleeper(base)
    from game_sandbox_harness.live_io import build_tee_store

    streamed: list[str] = []
    store = build_tee_store(str(tmp_path), ProtocolStream(_ListSink(streamed)))  # type: ignore[arg-type]
    entry = _messaging_entry(2, messaging=True)
    source = TransportSource(control, clock=clock, paced=True, sleeper=sleeper)
    with Episode(
        entry,
        {"player_0": ExternalPlayer(source, message_source=source)},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=clock,
        messaging=False,  # config disables what the metadata allowed
    ) as episode:
        control.configure_chat(episode.messaging_enabled)
        control.handle_line('{"kind":"chat","player":"player_0","tick":0,"to":null,"text":"hello"}')
        run_live_loop(episode, pace_interval_ms=16, control=control, clock=clock, sleeper=sleeper)

    # Messaging off: no message line was ever written.
    assert all(msgs == [] for msgs in _messages_in(tmp_path / "r" / "recording.jsonl"))


# --- stdout hygiene, as a real subprocess over a real environment -----------------------


def test_module_subprocess_keeps_stdout_clean_and_classifiable(tmp_path: Path):
    """Run the live module against a real environment and classify every stdout protocol line.

    Any stray prints from imported environment or agent code must land on stderr. Stdout carries
    only the header and states, which have no top-level ``kind``, plus the trailing result envelope.
    A ``stop`` on stdin ends the run promptly.
    """
    pytest.importorskip("flappy_bird", reason="environments package not installed")

    config = {
        "env_id": "flappy_bird",
        "parameters": {"players": 1, "pipe_gap": 100},
        "seed": 0,
        "player_bindings": {"player_0": {"kind": "external"}},
        "players": {"player_0": {"kind": "human", "label": "Human"}},
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


def test_module_subprocess_charges_a_crashing_agent_to_its_own_player(tmp_path: Path):
    """A builtin-agent player whose ``act`` raises makes the container exit non-zero AND emit a final
    ``result`` envelope naming the offending player, so workflow reduction charges the crash to that
    player's seat instead of to every competitor sharing the container."""
    pytest.importorskip("flappy_bird", reason="environments package not installed")

    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    (agent_dir / "manifest.json").write_text(
        json.dumps({"entry_point": "agent", "class_name": "A", "template_version": 1}),
        encoding="utf-8",
    )
    (agent_dir / "agent.py").write_text(
        "class A:\n"
        "    def reset(self, seed): pass\n"
        "    def act(self, observation):\n"
        "        raise RuntimeError('boom')\n",
        encoding="utf-8",
    )
    config = {
        "env_id": "flappy_bird",
        "parameters": {"players": 1, "pipe_gap": 100},
        "seed": 0,
        "player_bindings": {"player_0": {"kind": "builtin-agent", "path": str(agent_dir)}},
        "players": {"player_0": {"kind": "agent", "label": "Agent"}},
        "recording_dir": str(tmp_path),
        "recording_id": "r",
    }
    proc = subprocess.run(
        [sys.executable, "-m", "game_sandbox_harness.live", json.dumps(config)],
        input="",
        capture_output=True,
        text=True,
        timeout=60,
    )

    # A crashing agent fails the container (non-zero exit), but still names its player in a result line.
    assert proc.returncode == 1, proc.stderr
    results = [
        obj
        for line in proc.stdout.splitlines()
        if line.strip()
        for obj in [json.loads(line)]
        if obj.get("kind") == "result"
    ]
    assert len(results) == 1, proc.stdout
    assert results[0]["failed_player"] == "player_0"


def test_module_subprocess_charges_a_reset_crash_to_its_own_player(tmp_path: Path):
    """A builtin-agent player whose ``reset`` raises (the failure happens during ``start``, before the
    loop) must still name its player and leave a readable recording, not look like an unowned
    infrastructure fault with no result. The header is opened before participants reset, so the
    container exits non-zero, emits a final ``result`` naming the player, and persists the recording."""
    pytest.importorskip("flappy_bird", reason="environments package not installed")

    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    (agent_dir / "manifest.json").write_text(
        json.dumps({"entry_point": "agent", "class_name": "A", "template_version": 1}),
        encoding="utf-8",
    )
    (agent_dir / "agent.py").write_text(
        "class A:\n"
        "    def reset(self, seed):\n"
        "        raise RuntimeError('reset boom')\n"
        "    def act(self, observation):\n"
        "        return 0\n",
        encoding="utf-8",
    )
    config = {
        "env_id": "flappy_bird",
        "parameters": {"players": 1, "pipe_gap": 100},
        "seed": 0,
        "player_bindings": {"player_0": {"kind": "builtin-agent", "path": str(agent_dir)}},
        "players": {"player_0": {"kind": "agent", "label": "Agent"}},
        "recording_dir": str(tmp_path),
        "recording_id": "r",
    }
    proc = subprocess.run(
        [sys.executable, "-m", "game_sandbox_harness.live", json.dumps(config)],
        input="",
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert proc.returncode == 1, proc.stderr
    results = [
        obj
        for line in proc.stdout.splitlines()
        if line.strip()
        for obj in [json.loads(line)]
        if obj.get("kind") == "result"
    ]
    assert len(results) == 1, proc.stdout
    assert results[0]["failed_player"] == "player_0"
    # The recording was opened before the reset crash, so a readable header is on disk: the
    # orchestrator sees an attributable crash, not a recording-less infrastructure fault.
    header = json.loads((tmp_path / "r" / "recording.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert header["environment"] == "flappy_bird"
