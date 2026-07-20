"""Official LLM credential ownership and tick markers in the live harness."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import EnvironmentEntry, EnvironmentMeta
from game_sandbox_harness.live import (
    LiveConfig,
    LiveConfigError,
    LlmConfig,
    SlotBinding,
    build_slots,
    parse_config,
)
from game_sandbox_harness.live_io import PausableClock, SessionControl
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import Episode, run_episode


class _Sleeper:
    def sleep_ms(self, ms: int) -> None:
        pass


class _Response:
    def __init__(self, body: bytes = b"") -> None:
        self._body = body

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        pass

    def read(self) -> bytes:
        return self._body


class _AlternatingEnv:
    """A minimal two-seat AEC environment that ends after a fixed number of acting turns."""

    def __init__(self, turns: int) -> None:
        self._turns = turns
        self.possible_agents = ["player_0", "player_1"]

    def reset(self, seed: int | None = None, options: Any = None) -> None:
        self.agents = list(self.possible_agents)
        self.agent_selection = "player_0"
        self.rewards = {slot_id: 0.0 for slot_id in self.possible_agents}
        self.terminations = {slot_id: False for slot_id in self.possible_agents}
        self.truncations = {slot_id: False for slot_id in self.possible_agents}
        self._index = 0

    def last(self) -> tuple[int, float, bool, bool, dict[str, Any]]:
        slot_id = self.agent_selection
        return self._index, self.rewards[slot_id], False, False, {}

    def step(self, action: Any) -> None:
        self._index += 1
        if self._index == self._turns:
            for slot_id in self.possible_agents:
                self.terminations[slot_id] = True
            self.agents = []
            return
        self.agent_selection = self.possible_agents[self._index % 2]


def _entry(
    turns: int = 4,
    *,
    messaging: bool = True,
    step_limit_ms: int = 1000,
    episode_limit_ms: int = 120_000,
) -> EnvironmentEntry:
    return EnvironmentEntry(
        meta=EnvironmentMeta(
            env_id="fake",
            display_name="Fake",
            description="A deterministic LLM fixture.",
            min_slots=2,
            max_slots=2,
            human_slots=(),
            human_timeout_ms=None,
            recommended_episode_ticks=turns,
            pace_interval_ms=None,
            step_limit_ms=step_limit_ms,
            episode_limit_ms=episode_limit_ms,
            messaging=messaging,
            message_cap=100,
            llm=True,
            renderer="fake",
        ),
        make=lambda: _AlternatingEnv(turns),
        default_action=lambda env, slot_id: 0,
    )


def _payload(llm: object = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "env_id": "fake",
        "slots": {
            "player_0": {"kind": "builtin-agent", "path": "/agents/0"},
            "player_1": {"kind": "builtin-agent", "path": "/agents/1"},
            "human": {"kind": "external"},
        },
        "recording_dir": "/recordings",
    }
    if llm is not None:
        payload["llm"] = llm
    return payload


def _llm_block() -> dict[str, Any]:
    return {
        "base_url": "http://proxy.example/v1",
        "tick_url": "http://marker.example/internal/tick",
        "inflight_url": "http://marker.example/internal/inflight",
        "keys": {"player_0": "key-0", "player_1": "key-1"},
    }


def test_parse_config_accepts_strict_llm_block_with_exact_agent_key_coverage():
    config = parse_config([json.dumps(_payload(_llm_block()))])

    assert config.llm == LlmConfig(
        base_url="http://proxy.example/v1",
        tick_url="http://marker.example/internal/tick",
        inflight_url="http://marker.example/internal/inflight",
        keys={"player_0": "key-0", "player_1": "key-1"},
    )


def test_parse_config_matches_backend_llm_launch_fixture_exactly():
    fixture_path = (
        Path(__file__).resolve().parents[2] / "backend" / "test" / "fixtures" / "llm-launch-config.json"
    )
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    payload = _payload()
    payload["slots"] = {
        "player_0": {"kind": "builtin-agent", "path": "/agents/0"},
        "human": {"kind": "external"},
    }
    payload.update(fixture)

    config = parse_config([json.dumps(payload)])

    assert config.llm is not None
    assert {
        "base_url": config.llm.base_url,
        "tick_url": config.llm.tick_url,
        "inflight_url": config.llm.inflight_url,
        "keys": config.llm.keys,
    } == fixture["llm"]


@pytest.mark.parametrize(
    "llm",
    [
        [],
        {"base_url": "http://proxy/v1", "tick_url": "http://tick", "keys": []},
        {
            "base_url": "",
            "tick_url": "http://tick",
            "inflight_url": "http://inflight",
            "keys": {"player_0": "a", "player_1": "b"},
        },
        {
            "base_url": "http://proxy/v1",
            "tick_url": 7,
            "inflight_url": "http://inflight",
            "keys": {"player_0": "a", "player_1": "b"},
        },
        {
            "base_url": "http://proxy/v1",
            "tick_url": "http://tick",
            "inflight_url": "",
            "keys": {"player_0": "a", "player_1": "b"},
        },
        {
            "base_url": "http://proxy/v1",
            "tick_url": "http://tick",
            "inflight_url": "http://inflight",
            "keys": {"player_0": "a"},
        },
        {
            "base_url": "http://proxy/v1",
            "tick_url": "http://tick",
            "inflight_url": "http://inflight",
            "keys": {"player_0": "a", "player_1": "b", "human": "c"},
        },
        {
            "base_url": "http://proxy/v1",
            "tick_url": "http://tick",
            "inflight_url": "http://inflight",
            "keys": {"player_0": "a", "player_1": ""},
        },
        {
            "base_url": "http://proxy/v1",
            "tick_url": "http://tick",
            "inflight_url": "http://inflight",
            "keys": {"player_0": "a", "player_1": "b"},
            "derived_tick": True,
        },
    ],
)
def test_parse_config_rejects_malformed_llm_blocks(llm: object):
    with pytest.raises(LiveConfigError):
        parse_config([json.dumps(_payload(llm))])


def test_credentials_and_markers_cover_load_reset_and_every_acting_hook(monkeypatch):
    import game_sandbox_harness.live as live

    events: list[tuple[Any, ...]] = []

    def urlopen(request: Any, *, timeout: float) -> _Response:
        if request.full_url.endswith("/inflight"):
            return _Response(b'{"inflight_ms": 0}')
        events.append(
            (
                "marker",
                request.full_url,
                request.get_header("Authorization"),
                json.loads(request.data),
                timeout,
            )
        )
        return _Response()

    class Agent:
        def __init__(self, slot_id: str) -> None:
            self.slot_id = slot_id
            self.client_key = os.environ.get("OPENAI_API_KEY")
            events.append(
                (
                    "construct",
                    slot_id,
                    os.environ.get("OPENAI_BASE_URL"),
                    self.client_key,
                )
            )

        def _hook(self, name: str) -> None:
            events.append(
                (
                    "hook",
                    self.slot_id,
                    name,
                    os.environ.get("OPENAI_BASE_URL"),
                    os.environ.get("OPENAI_API_KEY"),
                    self.client_key,
                )
            )

        def reset(self, seed: int) -> None:
            self._hook("reset")

        def act(self, observation: Any) -> int:
            self._hook("act")
            return 0

        def chat(self, inbox: list[dict[str, Any]]) -> list[dict[str, Any]]:
            self._hook("chat")
            return []

        def learn(self, observation: Any, action: Any, reward: float, terminated: bool) -> None:
            self._hook("learn")

    def load_agent(path: str) -> Agent:
        slot_id = "player_0" if path.endswith("0") else "player_1"
        events.append(
            (
                "load",
                slot_id,
                os.environ.get("OPENAI_BASE_URL"),
                os.environ.get("OPENAI_API_KEY"),
            )
        )
        return Agent(slot_id)

    monkeypatch.setattr(live.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(live, "load_agent", load_agent)
    monkeypatch.setenv("OPENAI_BASE_URL", "before-base")
    monkeypatch.setenv("OPENAI_API_KEY", "before-key")
    config = parse_config([json.dumps(_payload(_llm_block()))])
    slots = build_slots(
        config,
        _entry(),
        SessionControl(),
        PausableClock(ManualClock()),
        _Sleeper(),
    )
    with Episode(_entry(), slots, seed=9, clock=ManualClock()) as episode:
        while not episode.done:
            episode.step_once()

    markers = [event for event in events if event[0] == "marker"]
    assert [event[3] for event in markers] == [
        {"phase": "setup"},
        {"phase": "setup"},
        {"phase": "setup"},
        {"phase": "setup"},
        {"tick": 0},
        {"tick": 1},
        {"tick": 2},
        {"tick": 3},
    ]
    assert all(event[1] == "http://marker.example/internal/tick" for event in markers)
    assert [event[2] for event in markers] == [
        "Bearer key-0",
        "Bearer key-1",
        "Bearer key-0",
        "Bearer key-1",
        "Bearer key-0",
        "Bearer key-1",
        "Bearer key-0",
        "Bearer key-1",
    ]
    assert all(event[4] == 2.0 for event in markers)

    participant_events = [event for event in events if event[0] in {"load", "construct", "hook"}]
    for event in participant_events:
        slot_id = event[1]
        expected_key = "key-0" if slot_id == "player_0" else "key-1"
        assert event[2 if event[0] != "hook" else 3] == "http://proxy.example/v1"
        assert event[3 if event[0] != "hook" else 4] == expected_key
        if event[0] == "hook":
            assert event[5] == expected_key

    # Reduce the trace to ownership boundaries and assert the full order. This proves every load,
    # reset, and turn marker is immediately before the participant work it describes.
    boundaries: list[tuple[Any, ...]] = []
    for event in events:
        if event[0] == "marker":
            slot_id = "player_0" if event[2] == "Bearer key-0" else "player_1"
            boundaries.append(("marker", slot_id, event[3]))
        elif event[0] in {"load", "construct"}:
            boundaries.append((event[0], event[1]))
        elif event[0] == "hook":
            boundaries.append(("hook", event[1], event[2]))

    expected_boundaries: list[tuple[Any, ...]] = [
        ("marker", "player_0", {"phase": "setup"}),
        ("load", "player_0"),
        ("construct", "player_0"),
        ("marker", "player_1", {"phase": "setup"}),
        ("load", "player_1"),
        ("construct", "player_1"),
        ("marker", "player_0", {"phase": "setup"}),
        ("hook", "player_0", "reset"),
        ("marker", "player_1", {"phase": "setup"}),
        ("hook", "player_1", "reset"),
    ]
    for tick in range(4):
        slot_id = f"player_{tick % 2}"
        expected_boundaries.extend(
            [
                ("marker", slot_id, {"tick": tick}),
                ("hook", slot_id, "act"),
                ("hook", slot_id, "chat"),
                ("hook", slot_id, "learn"),
            ]
        )
    assert boundaries == expected_boundaries

    turn_hooks = [event[1:3] for event in events if event[0] == "hook" and event[2] != "reset"]
    assert turn_hooks == [
        ("player_0", "act"),
        ("player_0", "chat"),
        ("player_0", "learn"),
        ("player_1", "act"),
        ("player_1", "chat"),
        ("player_1", "learn"),
        ("player_0", "act"),
        ("player_0", "chat"),
        ("player_0", "learn"),
        ("player_1", "act"),
        ("player_1", "chat"),
        ("player_1", "learn"),
    ]


def test_model_wait_in_act_is_discounted_from_step_and_episode_limits(monkeypatch, tmp_path: Path):
    import game_sandbox_harness.live as live

    clock = ManualClock()
    proxy_ms = {"player_0": 0, "player_1": 0}

    class WaitingAgent:
        def __init__(self, slot_id: str) -> None:
            self._slot_id = slot_id

        def reset(self, seed: int) -> None:
            pass

        def act(self, observation: Any) -> int:
            # This deterministic advance represents the blocking model/proxy request, including any
            # backend retry waits, that remains inside the participant's act hook.
            clock.advance(800)
            proxy_ms[self._slot_id] += 700
            return 0

    def urlopen(request: Any, *, timeout: float) -> _Response:
        if request.full_url.endswith("/inflight"):
            slot_id = "player_0" if request.headers["Authorization"] == "Bearer key-0" else "player_1"
            return _Response(json.dumps({"inflight_ms": proxy_ms[slot_id]}).encode())
        return _Response()

    monkeypatch.setattr(live.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(
        live,
        "load_agent",
        lambda path: WaitingAgent("player_0" if path.endswith("0") else "player_1"),
    )
    payload = _payload(_llm_block())
    del payload["slots"]["human"]
    config = parse_config([json.dumps(payload)])
    entry = _entry(turns=10, messaging=False, step_limit_ms=500, episode_limit_ms=1200)
    slots = build_slots(config, entry, SessionControl(), PausableClock(clock), _Sleeper())
    store = FolderRecordingStore(tmp_path)

    result = run_episode(
        entry,
        slots,
        seed=1,
        store=store,
        recording_id="model-wait",
        clock=clock,
    )

    steps = list(store.open("model-wait").steps())
    assert [next(iter(step["agents"].values()))["timing"]["decision_ms"] for step in steps] == [
        100,
        100,
        100,
        100,
        100,
        100,
        100,
        100,
        100,
        100,
    ]
    assert result.step_timeouts == {"player_0": 0, "player_1": 0}
    assert result.reason == "terminated"
    assert result.failed_slot is None
    assert result.ticks == 10


def test_marker_failure_logs_and_does_not_stop_agent_lifecycle(monkeypatch, capsys):
    import game_sandbox_harness.live as live

    calls: list[str] = []

    class Agent:
        def reset(self, seed: int) -> None:
            calls.append("reset")

        def act(self, observation: Any) -> int:
            calls.append("act")
            return 0

    def fail_marker(request: Any, *, timeout: float) -> _Response:
        raise OSError("proxy down")

    monkeypatch.setattr(live.urllib.request, "urlopen", fail_marker)
    monkeypatch.setattr(live, "load_agent", lambda path: Agent())
    config = LiveConfig(
        env_id="fake",
        seed=1,
        slots={"player_0": SlotBinding("builtin-agent", "/agents/0")},
        human_timeout_ms=None,
        recording_dir="/recordings",
        recording_id=None,
        llm=LlmConfig(
            "http://proxy/v1",
            "http://marker/tick",
            "http://marker/inflight",
            {"player_0": "key-0"},
        ),
    )
    one_seat_entry = _entry(turns=1, messaging=False)

    # This fixture environment still names two possible seats, but only the selected seat is needed
    # for the single completed turn under test.
    slots = build_slots(
        config,
        one_seat_entry,
        SessionControl(),
        PausableClock(ManualClock()),
        _Sleeper(),
    )
    with Episode(one_seat_entry, slots, seed=1, clock=ManualClock()) as episode:
        episode.step_once()

    assert calls == ["reset", "act"]
    diagnostic = capsys.readouterr().err
    assert "LLM marker failed for slot 'player_0': proxy down" in diagnostic
    assert "key-0" not in diagnostic


def test_proxy_snapshots_reuse_each_post_hook_baseline_and_exclude_setup(monkeypatch, tmp_path: Path):
    import game_sandbox_harness.live as live

    clock = ManualClock()

    class Agent:
        def reset(self, seed: int) -> None:
            # Setup proxy time is already present in the first hook's baseline and must not leak in.
            pass

        def act(self, observation: Any) -> int:
            clock.advance(70)
            return 0

        def chat(self, inbox: list[dict[str, Any]]) -> list[dict[str, Any]]:
            clock.advance(50)
            return []

        def learn(self, observation: Any, action: Any, reward: float, terminated: bool) -> None:
            clock.advance(20)

    snapshots = iter([100, 150, 180, 500])
    snapshot_calls = 0

    def urlopen(request: Any, *, timeout: float) -> _Response:
        nonlocal snapshot_calls
        if request.full_url.endswith("/inflight"):
            snapshot_calls += 1
            return _Response(json.dumps({"inflight_ms": next(snapshots)}).encode())
        return _Response()

    monkeypatch.setattr(live.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(live, "load_agent", lambda path: Agent())
    payload = _payload(
        {
            "base_url": "http://proxy/v1",
            "tick_url": "http://marker/tick",
            "inflight_url": "http://marker/inflight",
            "keys": {"player_0": "key-0"},
        }
    )
    payload["slots"] = {"player_0": {"kind": "builtin-agent", "path": "/agents/0"}}
    entry = _entry(turns=1, messaging=True)
    slots = build_slots(
        parse_config([json.dumps(payload)]),
        entry,
        SessionControl(),
        PausableClock(clock),
        _Sleeper(),
    )
    store = FolderRecordingStore(tmp_path)

    run_episode(
        entry,
        slots,
        seed=1,
        store=store,
        recording_id="separate-hooks",
        clock=clock,
        cpu_clock_ms=lambda: 0,
    )

    timing = next(store.open("separate-hooks").steps())["agents"]["player_0"]["timing"]
    # The final counter delta deliberately exceeds learn's raw duration, proving the clamp.
    assert timing == {"decision_ms": 20, "chat_ms": 20, "learn_ms": 0}
    assert snapshot_calls == 4


def test_failed_post_hook_snapshot_is_not_reused(monkeypatch, tmp_path: Path, capsys):
    import game_sandbox_harness.live as live

    clock = ManualClock()

    class Agent:
        def reset(self, seed: int) -> None:
            pass

        def act(self, observation: Any) -> int:
            clock.advance(70)
            return 0

        def chat(self, inbox: list[dict[str, Any]]) -> list[dict[str, Any]]:
            clock.advance(50)
            return []

        def learn(self, observation: Any, action: Any, reward: float, terminated: bool) -> None:
            clock.advance(20)

    snapshots = iter([100, 150, -1, 200, 210])

    def urlopen(request: Any, *, timeout: float) -> _Response:
        if request.full_url.endswith("/inflight"):
            return _Response(json.dumps({"inflight_ms": next(snapshots)}).encode())
        return _Response()

    monkeypatch.setattr(live.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(live, "load_agent", lambda path: Agent())
    payload = _payload(
        {
            "base_url": "http://proxy/v1",
            "tick_url": "http://marker/tick",
            "inflight_url": "http://marker/inflight",
            "keys": {"player_0": "key-0"},
        }
    )
    payload["slots"] = {"player_0": {"kind": "builtin-agent", "path": "/agents/0"}}
    entry = _entry(turns=1, messaging=True)
    slots = build_slots(
        parse_config([json.dumps(payload)]),
        entry,
        SessionControl(),
        PausableClock(clock),
        _Sleeper(),
    )
    store = FolderRecordingStore(tmp_path)

    run_episode(
        entry,
        slots,
        seed=1,
        store=store,
        recording_id="failed-snapshot",
        clock=clock,
        cpu_clock_ms=lambda: 0,
    )

    timing = next(store.open("failed-snapshot").steps())["agents"]["player_0"]["timing"]
    assert timing == {"decision_ms": 20, "chat_ms": 50, "learn_ms": 10}
    assert "LLM in-flight snapshot failed for slot 'player_0'" in capsys.readouterr().err


def test_proxy_discount_cannot_erase_overlapping_agent_cpu(monkeypatch, tmp_path: Path):
    import game_sandbox_harness.live as live

    clock = ManualClock()
    cpu_snapshots = iter([0.0, 60.0])
    proxy_snapshots = iter([0, 100])

    class Agent:
        def reset(self, seed: int) -> None:
            pass

        def act(self, observation: Any) -> int:
            # Represents a background proxy request overlapping 60 ms of local agent CPU.
            clock.advance(100)
            return 0

    def urlopen(request: Any, *, timeout: float) -> _Response:
        if request.full_url.endswith("/inflight"):
            return _Response(json.dumps({"inflight_ms": next(proxy_snapshots)}).encode())
        return _Response()

    monkeypatch.setattr(live.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(live, "load_agent", lambda path: Agent())
    payload = _payload(
        {
            "base_url": "http://proxy/v1",
            "tick_url": "http://marker/tick",
            "inflight_url": "http://marker/inflight",
            "keys": {"player_0": "key-0"},
        }
    )
    payload["slots"] = {"player_0": {"kind": "builtin-agent", "path": "/agents/0"}}
    entry = _entry(turns=1, messaging=False, step_limit_ms=50)
    slots = build_slots(
        parse_config([json.dumps(payload)]),
        entry,
        SessionControl(),
        PausableClock(clock),
        _Sleeper(),
    )
    store = FolderRecordingStore(tmp_path)

    result = run_episode(
        entry,
        slots,
        seed=1,
        store=store,
        recording_id="overlapping-cpu",
        clock=clock,
        cpu_clock_ms=lambda: next(cpu_snapshots),
    )

    timing = next(store.open("overlapping-cpu").steps())["agents"]["player_0"]["timing"]
    assert timing["decision_ms"] == 60
    assert result.step_timeouts == {"player_0": 1}


def test_bad_proxy_snapshot_fails_closed_to_full_hook_time(monkeypatch, tmp_path: Path, capsys):
    import game_sandbox_harness.live as live

    clock = ManualClock()

    class Agent:
        def reset(self, seed: int) -> None:
            pass

        def act(self, observation: Any) -> int:
            clock.advance(600)
            return 0

    def urlopen(request: Any, *, timeout: float) -> _Response:
        if request.full_url.endswith("/inflight"):
            return _Response(b'{"inflight_ms": -1}')
        return _Response()

    monkeypatch.setattr(live.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(live, "load_agent", lambda path: Agent())
    payload = _payload(
        {
            "base_url": "http://proxy/v1",
            "tick_url": "http://marker/tick",
            "inflight_url": "http://marker/inflight",
            "keys": {"player_0": "key-0"},
        }
    )
    payload["slots"] = {"player_0": {"kind": "builtin-agent", "path": "/agents/0"}}
    entry = _entry(turns=1, messaging=False, step_limit_ms=500)
    slots = build_slots(
        parse_config([json.dumps(payload)]),
        entry,
        SessionControl(),
        PausableClock(clock),
        _Sleeper(),
    )
    store = FolderRecordingStore(tmp_path)

    result = run_episode(entry, slots, seed=1, store=store, recording_id="bad-snapshot", clock=clock)

    timing = next(store.open("bad-snapshot").steps())["agents"]["player_0"]["timing"]
    assert timing["decision_ms"] == 600
    assert result.step_timeouts == {"player_0": 1}
    assert "LLM in-flight snapshot failed for slot 'player_0'" in capsys.readouterr().err


def test_non_llm_slots_do_not_touch_credentials_or_marker_transport(monkeypatch):
    import game_sandbox_harness.live as live

    seen: list[tuple[str | None, str | None]] = []

    class Agent:
        def reset(self, seed: int) -> None:
            seen.append((os.environ.get("OPENAI_BASE_URL"), os.environ.get("OPENAI_API_KEY")))

        def act(self, observation: Any) -> int:
            seen.append((os.environ.get("OPENAI_BASE_URL"), os.environ.get("OPENAI_API_KEY")))
            return 0

    def no_marker(*args: Any, **kwargs: Any) -> _Response:
        raise AssertionError("non-LLM path attempted a marker request")

    monkeypatch.setenv("OPENAI_BASE_URL", "student-base")
    monkeypatch.setenv("OPENAI_API_KEY", "student-key")
    monkeypatch.setattr(live.urllib.request, "urlopen", no_marker)
    monkeypatch.setattr(live, "load_agent", lambda path: Agent())
    config = LiveConfig(
        env_id="fake",
        seed=1,
        slots={"player_0": SlotBinding("builtin-agent", "/agents/0")},
        human_timeout_ms=None,
        recording_dir="/recordings",
        recording_id=None,
    )
    entry = _entry(turns=1, messaging=False)
    slots = build_slots(
        config,
        entry,
        SessionControl(),
        PausableClock(ManualClock()),
        _Sleeper(),
    )
    with Episode(entry, slots, seed=1, clock=ManualClock()) as episode:
        episode.step_once()

    assert seen == [("student-base", "student-key"), ("student-base", "student-key")]
