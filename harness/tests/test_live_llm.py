"""Official LLM credential ownership and tick markers in the live harness."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import (
    BuiltinAgent,
    EnvironmentEntry,
    EnvironmentMeta,
    PlayerBounds,
    resolve_parameters,
)
from game_sandbox_harness.live import (
    LiveConfig,
    LiveConfigError,
    LlmConfig,
    PlayerBinding,
    build_players,
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
    """A minimal two-player AEC environment that ends after a fixed number of acting turns."""

    def __init__(self, turns: int, player_count: int = 2) -> None:
        self._turns = turns
        self.possible_agents = [f"player_{index}" for index in range(player_count)]

    def reset(self, seed: int | None = None, options: Any = None) -> None:
        self.agents = list(self.possible_agents)
        self.agent_selection = "player_0"
        self.rewards = {player_id: 0.0 for player_id in self.possible_agents}
        self.terminations = {player_id: False for player_id in self.possible_agents}
        self.truncations = {player_id: False for player_id in self.possible_agents}
        self._index = 0

    def last(self) -> tuple[int, float, bool, bool, dict[str, Any]]:
        player_id = self.agent_selection
        return self._index, self.rewards[player_id], False, False, {}

    def observe(self, player_id: str) -> int:
        return self._index

    def step(self, action: Any) -> None:
        self._index += 1
        if self._index == self._turns:
            for player_id in self.possible_agents:
                self.terminations[player_id] = True
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
            stepping="sequential",
            builtin_agents=(BuiltinAgent("naive", "Naive agent"),),
            layout=PlayerBounds(1, 2),
            human_players=(),
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
        make=lambda parameters: _AlternatingEnv(turns, int(parameters["players"])),
        default_action=lambda env, player_id: 0,
    )


def _payload(llm: object = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "env_id": "fake",
        "parameters": {"players": 2},
        "player_bindings": {
            "player_0": {"kind": "builtin-agent", "path": "/agents/0"},
            "player_1": {"kind": "builtin-agent", "path": "/agents/1"},
        },
        "players": {
            "player_0": {"kind": "agent", "submission_id": "local-0", "label": "Player 0"},
            "player_1": {"kind": "agent", "submission_id": "local-1", "label": "Player 1"},
        },
        "recording_dir": "/recordings",
    }
    if llm is not None:
        payload["llm"] = llm
    return payload


@pytest.fixture(autouse=True)
def _resolve_fake_environment(monkeypatch: pytest.MonkeyPatch):
    import game_sandbox_harness.live as live

    monkeypatch.setattr(live, "load_environment", lambda _env_id: _entry())


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
    payload["player_bindings"] = {
        "player_0": {"kind": "builtin-agent", "path": "/agents/0"},
        "player_1": {"kind": "external"},
    }
    payload["players"] = {
        "player_0": {"kind": "agent", "submission_id": "local-0", "label": "Player 0"},
        "player_1": {"kind": "human", "label": "Human"},
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
        def __init__(self, player_id: str) -> None:
            self.player_id = player_id
            self.client_key = os.environ.get("OPENAI_API_KEY")
            events.append(
                (
                    "construct",
                    player_id,
                    os.environ.get("OPENAI_BASE_URL"),
                    self.client_key,
                )
            )

        def _hook(self, name: str) -> None:
            events.append(
                (
                    "hook",
                    self.player_id,
                    name,
                    os.environ.get("OPENAI_BASE_URL"),
                    os.environ.get("OPENAI_API_KEY"),
                    self.client_key,
                )
            )

        def reset(self, seed: int, observation: Any) -> None:
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
        player_id = "player_0" if path.endswith("0") else "player_1"
        events.append(
            (
                "load",
                player_id,
                os.environ.get("OPENAI_BASE_URL"),
                os.environ.get("OPENAI_API_KEY"),
            )
        )
        return Agent(player_id)

    monkeypatch.setattr(live.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(live, "load_agent", load_agent)
    monkeypatch.setenv("OPENAI_BASE_URL", "before-base")
    monkeypatch.setenv("OPENAI_API_KEY", "before-key")
    config = parse_config([json.dumps(_payload(_llm_block()))])
    players = build_players(
        config,
        _entry(),
        SessionControl(),
        PausableClock(ManualClock()),
        _Sleeper(),
    )
    with Episode(
        _entry(), players, parameters=resolve_parameters(_entry().meta), seed=9, clock=ManualClock()
    ) as episode:
        while not episode.done:
            episode.step_once()

    markers = [event for event in events if event[0] == "marker"]
    assert [event[3] for event in markers] == [
        {"phase": "setup"},
        {"phase": "setup"},
        *({"tick": tick} for tick in range(4)),
    ]
    assert all(event[1] == "http://marker.example/internal/tick" for event in markers)
    assert [event[2] for event in markers] == [
        "Bearer key-0",
        "Bearer key-1",
        *(f"Bearer key-{tick % 2}" for tick in range(4)),
    ]
    assert all(event[4] == 2.0 for event in markers)

    participant_events = [event for event in events if event[0] in {"load", "construct", "hook"}]
    for event in participant_events:
        player_id = event[1]
        expected_key = "key-0" if player_id == "player_0" else "key-1"
        assert event[2 if event[0] != "hook" else 3] == "http://proxy.example/v1"
        assert event[3 if event[0] != "hook" else 4] == expected_key
        if event[0] == "hook":
            assert event[5] == expected_key

    # Reduce the trace to ownership boundaries and assert the full order. Credential activation runs
    # before every hook, while each marker posts only before the first hook for its player and tick.
    boundaries: list[tuple[Any, ...]] = []
    for event in events:
        if event[0] == "marker":
            player_id = "player_0" if event[2] == "Bearer key-0" else "player_1"
            boundaries.append(("marker", player_id, event[3]))
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
        ("hook", "player_0", "reset"),
        ("hook", "player_1", "reset"),
    ]
    for tick in range(4):
        player_id = f"player_{tick % 2}"
        expected_boundaries.append(("marker", player_id, {"tick": tick}))
        expected_boundaries.extend(("hook", player_id, hook) for hook in ("act", "chat", "learn"))
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


def test_marker_scope_memoizes_per_player_across_interleaved_hook_phases(monkeypatch):
    import game_sandbox_harness.live as live

    posts: list[tuple[str, dict[str, object]]] = []

    def urlopen(request: Any, *, timeout: float) -> _Response:
        posts.append((request.get_header("Authorization"), json.loads(request.data)))
        return _Response()

    monkeypatch.setattr(live.urllib.request, "urlopen", urlopen)
    scope = live._LlmExecutionScope(
        LlmConfig(
            "http://proxy.example/v1",
            "http://marker.example/internal/tick",
            "http://marker.example/internal/inflight",
            {"player_0": "key-0", "player_1": "key-1"},
        )
    )

    # Parallel ticks can interleave players across phase boundaries. Each distinct player and tick
    # posts once, even though turn() still restores credentials before every simulated hook.
    scope.turn("player_0", 0)  # act
    scope.turn("player_1", 0)  # act
    scope.turn("player_0", 0)  # chat
    scope.turn("player_1", 0)  # chat
    scope.turn("player_0", 0)  # learn
    scope.turn("player_1", 0)  # learn
    scope.turn("player_0", 1)  # act

    assert posts == [
        ("Bearer key-0", {"tick": 0}),
        ("Bearer key-1", {"tick": 0}),
        ("Bearer key-0", {"tick": 1}),
    ]


def test_marker_scope_retries_a_failed_post_on_the_next_hook(monkeypatch):
    import game_sandbox_harness.live as live

    attempts = 0

    def urlopen(request: Any, *, timeout: float) -> _Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise OSError("proxy down")
        return _Response()

    monkeypatch.setattr(live.urllib.request, "urlopen", urlopen)
    scope = live._LlmExecutionScope(
        LlmConfig(
            "http://proxy.example/v1",
            "http://marker.example/internal/tick",
            "http://marker.example/internal/inflight",
            {"player_0": "key-0", "player_1": "key-1"},
        )
    )

    scope.turn("player_0", 0)
    scope.turn("player_0", 0)

    assert attempts == 2


def test_model_wait_in_act_is_discounted_from_step_and_episode_limits(monkeypatch, tmp_path: Path):
    import game_sandbox_harness.live as live

    clock = ManualClock()
    proxy_ms = {"player_0": 0, "player_1": 0}
    inflight_reads = 0

    class WaitingAgent:
        def __init__(self, player_id: str) -> None:
            self._player_id = player_id

        def reset(self, seed: int, observation: Any) -> None:
            pass

        def act(self, observation: Any) -> int:
            # This deterministic advance represents the blocking model/proxy request, including any
            # backend retry waits, that remains inside the participant's act hook.
            clock.advance(800)
            proxy_ms[self._player_id] += 700
            return 0

    def urlopen(request: Any, *, timeout: float) -> _Response:
        nonlocal inflight_reads
        if request.full_url.endswith("/inflight"):
            inflight_reads += 1
            player_id = "player_0" if request.headers["Authorization"] == "Bearer key-0" else "player_1"
            return _Response(json.dumps({"inflight_ms": proxy_ms[player_id]}).encode())
        return _Response()

    monkeypatch.setattr(live.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(
        live,
        "load_agent",
        lambda path: WaitingAgent("player_0" if path.endswith("0") else "player_1"),
    )
    payload = _payload(_llm_block())
    config = parse_config([json.dumps(payload)])
    entry = _entry(turns=10, messaging=False, step_limit_ms=500, episode_limit_ms=1200)
    players = build_players(config, entry, SessionControl(), PausableClock(clock), _Sleeper())
    store = FolderRecordingStore(tmp_path)

    result = run_episode(
        entry,
        players,
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="model-wait",
        clock=clock,
        player_attribution={
            "player_0": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            },
            "player_1": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            },
        },
    )

    steps = list(store.open("model-wait").steps())
    decision_ms = [
        agent["timing"]["decision_ms"]
        for step in steps
        for agent in step["agents"].values()
        if "timing" in agent
    ]
    assert decision_ms == [
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
    assert result.failed_player is None
    assert result.ticks == 10
    # Setup now records each agent's initial baseline, then every action reuses its post-hook read.
    assert inflight_reads == 14


def test_marker_failure_logs_and_does_not_stop_agent_lifecycle(monkeypatch, capsys):
    import game_sandbox_harness.live as live

    calls: list[str] = []

    class Agent:
        def reset(self, seed: int, observation: Any) -> None:
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
        player_bindings={"player_0": PlayerBinding("builtin-agent", "/agents/0")},
        human_timeout_ms=None,
        recording_dir="/recordings",
        recording_id=None,
        parameters={"players": 1},
        llm=LlmConfig(
            "http://proxy/v1",
            "http://marker/tick",
            "http://marker/inflight",
            {"player_0": "key-0"},
        ),
    )
    one_player_entry = _entry(turns=1, messaging=False)

    # This fixture environment still names two possible players, but only the selected player is needed
    # for the single completed turn under test.
    players = build_players(
        config,
        one_player_entry,
        SessionControl(),
        PausableClock(ManualClock()),
        _Sleeper(),
    )
    with Episode(
        one_player_entry,
        players,
        parameters=resolve_parameters(one_player_entry.meta),
        seed=1,
        clock=ManualClock(),
    ) as episode:
        episode.step_once()

    assert calls == ["reset", "act"]
    diagnostic = capsys.readouterr().err
    assert "LLM marker failed for player 'player_0': proxy down" in diagnostic
    assert "key-0" not in diagnostic


def test_proxy_snapshots_reuse_each_post_hook_baseline(monkeypatch, tmp_path: Path):
    import game_sandbox_harness.live as live

    clock = ManualClock()

    class Agent:
        def reset(self, seed: int, observation: Any) -> None:
            pass

        def act(self, observation: Any) -> int:
            clock.advance(70)
            return 0

        def chat(self, inbox: list[dict[str, Any]]) -> list[dict[str, Any]]:
            clock.advance(50)
            return []

        def learn(self, observation: Any, action: Any, reward: float, terminated: bool) -> None:
            clock.advance(20)

    snapshots = iter([0, 100, 150, 180, 500])
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
    payload["parameters"] = {"players": 1}
    payload["player_bindings"] = {"player_0": {"kind": "builtin-agent", "path": "/agents/0"}}
    payload["players"] = {"player_0": {"kind": "agent", "submission_id": "local-0", "label": "Player 0"}}
    entry = _entry(turns=1, messaging=True)
    players = build_players(
        parse_config([json.dumps(payload)]),
        entry,
        SessionControl(),
        PausableClock(clock),
        _Sleeper(),
    )
    store = FolderRecordingStore(tmp_path)

    run_episode(
        entry,
        players,
        parameters={"players": 1},
        seed=1,
        store=store,
        recording_id="separate-hooks",
        clock=clock,
        cpu_clock_ms=lambda: 0,
        player_attribution={
            "player_0": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            },
        },
    )

    timing = next(store.open("separate-hooks").steps())["agents"]["player_0"]["timing"]
    assert timing == {"decision_ms": 20, "chat_ms": 20, "learn_ms": 0}
    assert snapshot_calls == 5


def test_failed_post_hook_snapshot_is_not_reused(monkeypatch, tmp_path: Path, capsys):
    import game_sandbox_harness.live as live

    clock = ManualClock()

    class Agent:
        def reset(self, seed: int, observation: Any) -> None:
            pass

        def act(self, observation: Any) -> int:
            clock.advance(70)
            return 0

        def chat(self, inbox: list[dict[str, Any]]) -> list[dict[str, Any]]:
            clock.advance(50)
            return []

        def learn(self, observation: Any, action: Any, reward: float, terminated: bool) -> None:
            clock.advance(20)

    snapshots = iter([0, 100, 150, -1, 200, 210])

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
    payload["parameters"] = {"players": 1}
    payload["player_bindings"] = {"player_0": {"kind": "builtin-agent", "path": "/agents/0"}}
    payload["players"] = {"player_0": {"kind": "agent", "submission_id": "local-0", "label": "Player 0"}}
    entry = _entry(turns=1, messaging=True)
    players = build_players(
        parse_config([json.dumps(payload)]),
        entry,
        SessionControl(),
        PausableClock(clock),
        _Sleeper(),
    )
    store = FolderRecordingStore(tmp_path)

    run_episode(
        entry,
        players,
        parameters={"players": 1},
        seed=1,
        store=store,
        recording_id="failed-snapshot",
        clock=clock,
        cpu_clock_ms=lambda: 0,
        player_attribution={
            "player_0": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            },
        },
    )

    timing = next(store.open("failed-snapshot").steps())["agents"]["player_0"]["timing"]
    assert timing == {"decision_ms": 20, "chat_ms": 50, "learn_ms": 10}
    assert "LLM in-flight snapshot failed for player 'player_0'" in capsys.readouterr().err


@pytest.mark.parametrize(
    ("snapshots", "expected_decision_ms", "expected_timeouts"),
    [((0, 0, -1), 600, 1), ((0, 0, 1_000), 0, 0)],
)
def test_proxy_discount_fails_closed_and_is_nonnegative(
    monkeypatch,
    tmp_path: Path,
    snapshots: tuple[int, int],
    expected_decision_ms: int,
    expected_timeouts: int,
):
    import game_sandbox_harness.live as live

    clock = ManualClock()

    class Agent:
        def reset(self, seed: int, observation: Any) -> None:
            pass

        def act(self, observation: Any) -> int:
            clock.advance(600)
            return 0

    snapshots = iter(snapshots)

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
    payload["parameters"] = {"players": 1}
    payload["player_bindings"] = {"player_0": {"kind": "builtin-agent", "path": "/agents/0"}}
    payload["players"] = {"player_0": {"kind": "agent", "submission_id": "local-0", "label": "Player 0"}}
    entry = _entry(turns=1, messaging=False, step_limit_ms=500)
    players = build_players(
        parse_config([json.dumps(payload)]),
        entry,
        SessionControl(),
        PausableClock(clock),
        _Sleeper(),
    )
    store = FolderRecordingStore(tmp_path)

    result = run_episode(
        entry,
        players,
        parameters={"players": 1},
        seed=1,
        store=store,
        recording_id="proxy-discount",
        clock=clock,
        cpu_clock_ms=lambda: 0,
        player_attribution={
            "player_0": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            },
        },
    )

    timing = next(store.open("proxy-discount").steps())["agents"]["player_0"]["timing"]
    assert timing["decision_ms"] == expected_decision_ms
    assert result.step_timeouts == {"player_0": expected_timeouts}


def test_proxy_discount_cannot_erase_overlapping_agent_cpu(monkeypatch, tmp_path: Path):
    import game_sandbox_harness.live as live

    clock = ManualClock()
    cpu_snapshots = iter([0.0, 0.0, 0.0, 60.0])
    proxy_snapshots = iter([0, 0, 100])

    class Agent:
        def reset(self, seed: int, observation: Any) -> None:
            pass

        def act(self, observation: Any) -> int:
            # Represents a background proxy request overlapping 60 ms of local agent CPU.
            clock.advance(100)
            return 1

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
    payload["parameters"] = {"players": 1}
    payload["player_bindings"] = {"player_0": {"kind": "builtin-agent", "path": "/agents/0"}}
    payload["players"] = {"player_0": {"kind": "agent", "submission_id": "local-0", "label": "Player 0"}}
    entry = _entry(turns=1, messaging=False, step_limit_ms=50)
    players = build_players(
        parse_config([json.dumps(payload)]),
        entry,
        SessionControl(),
        PausableClock(clock),
        _Sleeper(),
    )
    store = FolderRecordingStore(tmp_path)

    result = run_episode(
        entry,
        players,
        parameters={"players": 1},
        seed=1,
        store=store,
        recording_id="overlapping-cpu",
        clock=clock,
        cpu_clock_ms=lambda: next(cpu_snapshots),
        episode_limit_ms=50,
        player_attribution={
            "player_0": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            },
        },
    )

    step = next(store.open("overlapping-cpu").steps())
    timing = step["agents"]["player_0"]["timing"]
    assert timing["decision_ms"] == 60
    assert step["agents"]["player_0"]["action"] == 0
    assert result.step_timeouts == {"player_0": 1}
    assert result.reason == "episode_limit"
    assert result.failed_player == "player_0"


def test_non_llm_players_do_not_touch_credentials_or_marker_transport(monkeypatch):
    import game_sandbox_harness.live as live

    seen: list[tuple[str | None, str | None]] = []

    class Agent:
        def reset(self, seed: int, observation: Any) -> None:
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
        player_bindings={"player_0": PlayerBinding("builtin-agent", "/agents/0")},
        human_timeout_ms=None,
        recording_dir="/recordings",
        recording_id=None,
        parameters={"players": 1},
    )
    entry = _entry(turns=1, messaging=False)
    players = build_players(
        config,
        entry,
        SessionControl(),
        PausableClock(ManualClock()),
        _Sleeper(),
    )
    with Episode(
        entry, players, parameters=resolve_parameters(entry.meta), seed=1, clock=ManualClock()
    ) as episode:
        episode.step_once()

    assert seen == [("student-base", "student-key"), ("student-base", "student-key")]
