"""Official player credentials, attribution and verified proxy-time discounts."""

from __future__ import annotations

import json
import os
import sys
from dataclasses import replace
from pathlib import Path

import pytest
from support_parallel import make_entry as parallel_entry

import game_sandbox_harness.live as live
from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import BuiltinAgent, EnvironmentEntry, EnvironmentMeta, PlayerBounds
from game_sandbox_harness.live import LiveConfigError, build_players, parse_config
from game_sandbox_harness.live_io import PausableClock, SessionControl
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import run_episode


@pytest.fixture(autouse=True)
def _restore_credentials(monkeypatch):
    # Register the variables so the runner's direct writes are undone after each test.
    for name in ("OPENAI_BASE_URL", "OPENAI_API_KEY"):
        monkeypatch.setenv(name, os.environ.get(name, ""))


class _Sleeper:
    def sleep_ms(self, ms: int) -> None:
        pytest.fail("headless fixture tried to wait for input")


class _Response:
    def __init__(self, body: bytes = b"") -> None:
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self) -> bytes:
        return self._body


class _AlternatingEnv:
    def __init__(self, turns: int, player_count: int) -> None:
        self._turns = turns
        self.possible_agents = [f"player_{index}" for index in range(player_count)]

    def reset(self, seed=None, options=None):
        self.agents = self.possible_agents[:]
        self.agent_selection = "player_0"
        self.rewards = dict.fromkeys(self.agents, 0.0)
        self.terminations = dict.fromkeys(self.agents, False)
        self.truncations = dict.fromkeys(self.agents, False)
        self._index = 0

    def observe(self, player_id):
        return self._index

    def last(self):
        return self._index, self.rewards[self.agent_selection], False, False, {}

    def step(self, action):
        self._index += 1
        if self._index == self._turns:
            self.terminations = dict.fromkeys(self.possible_agents, True)
            self.agents = []
        else:
            self.agent_selection = self.possible_agents[self._index % len(self.possible_agents)]


def _entry(turns=4, *, messaging=True, step_limit_ms=1000, episode_limit_ms=120_000):
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


def _llm_block(count=2):
    return {
        "base_url": "http://proxy.example/v1",
        "tick_url": "http://marker.example/internal/tick",
        "inflight_url": "http://timing.example/internal/inflight",
        "keys": {f"player_{i}": f"key-{i}" for i in range(count)},
    }


def _payload(llm=None, *, count=2):
    return {
        "env_id": "fake",
        "seed": 9,
        "parameters": {"players": count},
        "player_bindings": {
            f"player_{i}": {"kind": "builtin-agent", "path": f"/agents/{i}"} for i in range(count)
        },
        "players": {
            f"player_{i}": {"kind": "agent", "submission_id": f"local-{i}", "label": f"Player {i}"}
            for i in range(count)
        },
        "recording_dir": "/recordings",
        "llm": llm,
    }


def _run(payload, entry, clock, tmp_path, *, cpu_clock_ms=lambda: 0):
    config = parse_config([json.dumps(payload)], entry=entry)
    players = build_players(config, entry, SessionControl(), PausableClock(clock), _Sleeper())
    store = FolderRecordingStore(tmp_path / "recordings")
    result = run_episode(
        entry,
        players,
        parameters=config.parameters,
        seed=config.seed,
        store=store,
        recording_id="episode",
        clock=clock,
        cpu_clock_ms=cpu_clock_ms,
        player_attribution=config.players,
    )
    return result, list(store.open("episode").steps())


def _reply_snapshots(monkeypatch, snapshots):
    readings = iter(snapshots)
    requests = []

    def urlopen(request, *, timeout):
        if request.full_url == "http://timing.example/internal/inflight":
            requests.append((request.get_method(), request.get_header("Authorization")))
            try:
                value = next(readings)
            except StopIteration:
                pytest.fail("unexpected extra proxy-time read")
            if isinstance(value, Exception):
                raise value
            body = value if isinstance(value, bytes) else json.dumps({"inflight_ms": value}).encode()
            return _Response(body)
        return _Response()

    monkeypatch.setattr(live.urllib.request, "urlopen", urlopen)
    return requests


@pytest.fixture
def probe_repos(monkeypatch, tmp_path):
    """Real modules report credentials and the marker accepted by the fake proxy."""
    monkeypatch.setattr(sys, "path", sys.path[:])
    monkeypatch.setenv("OPENAI_BASE_URL", "student-base")
    monkeypatch.setenv("OPENAI_API_KEY", "student-key")
    markers = tmp_path / "markers.json"
    markers.write_text("{}", encoding="utf-8")

    def create(player_id, *, tamper=False):
        root = tmp_path / player_id
        root.mkdir()
        (root / "manifest.json").write_text(
            json.dumps({"entry_point": "llm_audit_probe", "class_name": "Agent", "template_version": 1}),
            encoding="utf-8",
        )
        (root / "llm_audit_probe.py").write_text(
            f"""import json
import os
from pathlib import Path

LOG = Path({str(root / "trace.jsonl")!r})
MARKERS = Path({str(markers)!r})
CAPTURED = os.environ.get("OPENAI_API_KEY")

def report(phase, client=None):
    key = os.environ.get("OPENAI_API_KEY")
    row = [phase, os.environ.get("OPENAI_BASE_URL"), key, CAPTURED, client,
           json.loads(MARKERS.read_text(encoding="utf-8")).get(key)]
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\\n")

report("import")

class Agent:
    def __init__(self):
        self.client = os.environ.get("OPENAI_API_KEY")
        report("construct", self.client)

    def hook(self, name):
        report(name, self.client)
        if {tamper!r}:
            os.environ["OPENAI_BASE_URL"] = "tampered-base"
            os.environ["OPENAI_API_KEY"] = "tampered-key"

    def reset(self, seed, observation):
        self.hook("reset")

    def act(self, observation):
        self.hook("act")
        return 1

    def chat(self, inbox):
        self.hook("chat")
        return []

    def learn(self, observation, action, reward, terminated):
        self.hook("learn")
""",
            encoding="utf-8",
        )
        return root

    yield create, markers
    sys.modules.pop("llm_audit_probe", None)


@pytest.mark.parametrize("mode", ["inline", "file", "backend-fixture"])
def test_parse_config_matches_backend_llm_launch_fixture_exactly(mode, monkeypatch, tmp_path):
    payload = _payload(_llm_block())
    if mode != "inline":
        block = payload["llm"]
        if mode == "backend-fixture":
            fixture = Path(__file__).resolve().parents[2] / "backend/test/fixtures/llm-launch-config.json"
            block = json.loads(fixture.read_text(encoding="utf-8"))["llm"]
            payload["player_bindings"]["player_1"] = {"kind": "external"}
            payload["players"]["player_1"] = {"kind": "human", "label": "Human"}
            keys = {"player_0": "key-0"}
        else:
            keys = block.pop("keys")
        keys_file = tmp_path / "keys.json"
        keys_file.write_text(json.dumps(keys), encoding="utf-8")
        payload["llm"] = dict(block, keys_file=str(keys_file))

    observations = []

    def load_agent(path):
        observations.append((os.environ.get("OPENAI_BASE_URL"), os.environ.get("OPENAI_API_KEY")))
        return object()

    monkeypatch.setenv("OPENAI_BASE_URL", "before-base")
    monkeypatch.setenv("OPENAI_API_KEY", "before-key")
    monkeypatch.setattr(live, "load_agent", load_agent)
    requests = []
    monkeypatch.setattr(
        live.urllib.request, "urlopen", lambda request, **kw: requests.append(request) or _Response()
    )
    config = parse_config([json.dumps(payload)], entry=_entry())
    build_players(config, _entry(), SessionControl(), PausableClock(ManualClock()), _Sleeper())
    if mode == "backend-fixture":
        assert observations == [("http://llm-proxy:9472/v1", "key-0")]
        assert [(r.full_url, r.get_header("Authorization")) for r in requests] == [
            ("http://llm-proxy:9472/internal/tick", "Bearer key-0")
        ]
        assert config.llm.inflight_url == "http://llm-proxy:9472/internal/inflight"
    else:
        assert observations == [("http://proxy.example/v1", "key-0"), ("http://proxy.example/v1", "key-1")]
        assert [(r.full_url, r.get_header("Authorization")) for r in requests] == [
            ("http://marker.example/internal/tick", "Bearer key-0"),
            ("http://marker.example/internal/tick", "Bearer key-1"),
        ]
        assert config.llm.inflight_url == "http://timing.example/internal/inflight"


@pytest.mark.parametrize(
    "field,value,cause",
    [
        (None, [], "must be an object"),
        ("keys", [], "keys.*must be an object"),
        ("base_url", "", "base_url.*non-empty string"),
        ("tick_url", 7, "tick_url.*non-empty string"),
        ("inflight_url", "", "inflight_url.*non-empty string"),
        ("inflight_url", "DELETE", "missing.*inflight_url"),
        ("keys", {"player_0": "a"}, "missing agent players.*player_1"),
        ("keys", {"player_0": "a", "player_1": "b", "human": "c"}, "unknown or non-agent.*human"),
        ("keys", {"player_0": "a", "player_1": ""}, "player_1.*non-empty string"),
        ("derived_tick", True, "unknown.*derived_tick"),
        ("keys_file", "/run/llm-keys.json", "exactly one.*both"),
        ("keys", "DELETE", "exactly one.*neither"),
    ],
)
def test_parse_config_rejects_malformed_llm_blocks(field, value, cause):
    payload = _payload(_llm_block())
    parse_config([json.dumps(payload)], entry=_entry())
    if field is None:
        payload["llm"] = value
    elif value == "DELETE":
        del payload["llm"][field]
    else:
        payload["llm"][field] = value
    with pytest.raises(LiveConfigError, match=cause):
        parse_config([json.dumps(payload)], entry=_entry())


@pytest.mark.parametrize(
    "contents,empty_path,cause",
    [
        (None, False, "could not be read"),
        ("", False, "must contain a JSON object"),
        ("not json", False, "must contain a JSON object"),
        ("[]", False, "must contain a JSON object"),
        ('{"player_0":"key-0","player_1":""}', False, "non-empty key strings"),
        ('{"player_0":"key-0"}', False, "missing agent players.*player_1"),
        (None, True, "keys_file.*non-empty path"),
    ],
)
def test_parse_config_rejects_an_unreadable_or_empty_keys_file(contents, empty_path, cause, tmp_path):
    path = tmp_path / "keys.json"
    block = _llm_block()
    keys = block.pop("keys")
    path.write_text(json.dumps(keys), encoding="utf-8")
    block["keys_file"] = str(path)
    parse_config([json.dumps(_payload(block))], entry=_entry())
    path.unlink()
    if contents is not None:
        path.write_text(contents, encoding="utf-8")
    if empty_path:
        block["keys_file"] = ""
    with pytest.raises(LiveConfigError, match=cause):
        parse_config([json.dumps(_payload(block))], entry=_entry())


@pytest.mark.parametrize("stepping", ["sequential", "simultaneous"])
def test_credentials_and_markers_cover_load_reset_and_every_acting_hook(
    stepping, probe_repos, monkeypatch, tmp_path
):
    create, markers_file = probe_repos
    entry = _entry() if stepping == "sequential" else parallel_entry(messaging=True)
    entry = replace(entry, meta=replace(entry.meta, llm=True))
    count = 2 if stepping == "sequential" else 3
    payload = _payload(_llm_block(count), count=count)
    payload["env_id"] = entry.meta.env_id
    roots = [create(f"player_{i}", tamper=True) for i in range(count)]
    for binding, root in zip(payload["player_bindings"].values(), roots, strict=True):
        binding["path"] = str(root)
    posts = []
    markers = {}

    def urlopen(request, *, timeout):
        if request.full_url == "http://timing.example/internal/inflight":
            return _Response(b'{"inflight_ms":0}')
        key = request.get_header("Authorization").removeprefix("Bearer ")
        marker = json.loads(request.data)
        posts.append((request.full_url, request.get_method(), key, marker))
        markers[key] = marker
        markers_file.write_text(json.dumps(markers), encoding="utf-8")
        return _Response()

    monkeypatch.setattr(live.urllib.request, "urlopen", urlopen)
    result, steps = _run(payload, entry, ManualClock(), tmp_path)
    expected_markers = (
        [[{"tick": 0}, {"tick": 2}], [{"tick": 1}, {"tick": 3}]]
        if stepping == "sequential"
        else [[{"tick": 0}], [{"tick": 0}, {"tick": 1}], [{"tick": 0}, {"tick": 1}, {"tick": 2}]]
    )
    for root, key, ticks in zip(roots, ("key-0", "key-1", "key-2")[:count], expected_markers, strict=True):
        trace = [json.loads(line) for line in (root / "trace.jsonl").read_text(encoding="utf-8").splitlines()]
        assert trace[:3] == [
            ["import", "http://proxy.example/v1", key, key, None, {"phase": "setup"}],
            ["construct", "http://proxy.example/v1", key, key, key, {"phase": "setup"}],
            ["reset", "http://proxy.example/v1", key, key, key, {"phase": "setup"}],
        ]
        assert trace[3:] == [
            [hook, "http://proxy.example/v1", key, key, key, marker]
            for marker in ticks
            for hook in ("act", "chat", "learn")
        ]
        assert [post for post in posts if post[2] == key] == [
            ("http://marker.example/internal/tick", "POST", key, marker)
            for marker in [{"phase": "setup"}, *ticks]
        ]
    assert result.ticks == (4 if stepping == "sequential" else 3)
    assert result.reason == ("terminated" if stepping == "sequential" else "truncated")
    assert [agent["action"] for step in steps for agent in step["agents"].values() if "action" in agent] == (
        [1, 1, 1, 1] if stepping == "sequential" else [1, 1, 1, 1, 1, 1]
    )


def test_model_wait_in_act_is_discounted_from_step_and_episode_limits(monkeypatch, tmp_path):
    clock = ManualClock()
    proxy_ms = {"Bearer key-0": 1000, "Bearer key-1": 2000}

    class WaitingAgent:
        def __init__(self, key, proxy_work):
            self.key, self.proxy_work = key, proxy_work

        def reset(self, seed, observation):
            pass

        def act(self, observation):
            clock.advance(800)
            proxy_ms[self.key] += self.proxy_work
            return 1

    def urlopen(request, *, timeout):
        if request.full_url == "http://timing.example/internal/inflight":
            return _Response(
                json.dumps({"inflight_ms": proxy_ms[request.get_header("Authorization")]}).encode()
            )
        return _Response()

    monkeypatch.setattr(live.urllib.request, "urlopen", urlopen)
    agents = {"/agents/0": WaitingAgent("Bearer key-0", 700), "/agents/1": WaitingAgent("Bearer key-1", 600)}
    monkeypatch.setattr(live, "load_agent", agents.__getitem__)
    result, steps = _run(
        _payload(_llm_block()),
        _entry(turns=10, messaging=False, step_limit_ms=500, episode_limit_ms=1200),
        clock,
        tmp_path,
    )
    assert [
        agent["timing"]["decision_ms"]
        for step in steps
        for agent in step["agents"].values()
        if "timing" in agent
    ] == [
        100,
        200,
        100,
        200,
        100,
        200,
        100,
        200,
        100,
        200,
    ]
    assert [agent["action"] for step in steps for agent in step["agents"].values() if "action" in agent] == [
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
    ]
    assert (result.ticks, result.reason, result.failed_player) == (10, "terminated", None)
    assert result.step_timeouts == {"player_0": 0, "player_1": 0}


def test_marker_failure_logs_and_does_not_stop_agent_lifecycle(monkeypatch, tmp_path, capsys):
    marker = {"phase": "setup"}
    observed = []
    failed = False

    class Agent:
        def reset(self, seed, observation):
            observed.append(("reset", dict(marker)))

        def act(self, observation):
            observed.append(("act", dict(marker)))
            return 1

        def chat(self, inbox):
            observed.append(("chat", dict(marker)))
            return []

        def learn(self, observation, action, reward, terminated):
            observed.append(("learn", dict(marker)))

    requests = []

    def urlopen(request, *, timeout):
        nonlocal marker, failed
        if request.full_url == "http://timing.example/internal/inflight":
            return _Response(b'{"inflight_ms":0}')
        payload = json.loads(request.data)
        requests.append((request.get_header("Authorization"), payload))
        if payload == {"tick": 0} and not failed:
            failed = True
            raise OSError("proxy down")
        marker = payload
        return _Response()

    monkeypatch.setattr(live.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(live, "load_agent", lambda path: Agent())
    result, steps = _run(_payload(_llm_block(1), count=1), _entry(turns=1), ManualClock(), tmp_path)
    assert observed == [
        ("reset", {"phase": "setup"}),
        ("act", {"phase": "setup"}),
        ("chat", {"tick": 0}),
        ("learn", {"tick": 0}),
    ]
    assert requests == [
        ("Bearer key-0", {"phase": "setup"}),
        ("Bearer key-0", {"tick": 0}),
        ("Bearer key-0", {"tick": 0}),
    ]
    assert (result.ticks, result.reason, steps[0]["agents"]["player_0"]["action"]) == (1, "terminated", 1)
    diagnostic = capsys.readouterr().err
    assert "LLM marker failed" in diagnostic and "player_0" in diagnostic and "proxy down" in diagnostic
    assert "snapshot failed" not in diagnostic and "key-0" not in diagnostic


@pytest.mark.parametrize(
    "snapshots,work,cpu_ms,limits,timing,outcome",
    [
        pytest.param(
            (0, 100, 150, 180, 500),
            (70, 50, 20),
            0,
            (500, 120_000),
            {"decision_ms": 20, "chat_ms": 20, "learn_ms": 0},
            (1, 0, "terminated", None, False),
            id="reuse-across-hooks",
        ),
        pytest.param(
            (0, 100, 150, -1, 200, 210),
            (70, 50, 20),
            0,
            (500, 120_000),
            {"decision_ms": 20, "chat_ms": 50, "learn_ms": 10},
            (1, 0, "terminated", None, True),
            id="failed-post-read-recovers",
        ),
        pytest.param(
            (0, -1, -1, 100, 130, 140),
            (70, 50, 20),
            0,
            (500, 120_000),
            {"decision_ms": 70, "chat_ms": 20, "learn_ms": 10},
            (1, 0, "terminated", None, True),
            id="failed-required-baseline",
        ),
        pytest.param(
            (0, 100, 90, 90, 90),
            (70, 50, 20),
            0,
            (500, 120_000),
            {"decision_ms": 70, "chat_ms": 50, "learn_ms": 20},
            (1, 0, "terminated", None, False),
            id="decreasing-counter",
        ),
        pytest.param(
            (0, 0, 1000, 1000, 1000),
            (600, 0, 0),
            0,
            (500, 120_000),
            {"decision_ms": 0, "chat_ms": 0, "learn_ms": 0},
            (1, 0, "terminated", None, False),
            id="discount-cannot-be-negative",
        ),
        pytest.param(
            (0, 0, 100, 100, 100),
            (100, 0, 0),
            60,
            (50, 50),
            {"decision_ms": 60, "chat_ms": 0, "learn_ms": 0},
            (0, 1, "episode_limit", "player_0", False),
            id="cpu-floor",
        ),
        *[
            pytest.param(
                (0, 0, bad, 0, 0, 0),
                (600, 0, 0),
                0,
                (500, 120_000),
                {"decision_ms": 600, "chat_ms": 0, "learn_ms": 0},
                (0, 1, "terminated", None, True),
                id=label,
            )
            for label, bad in [
                ("negative", -1),
                ("transport-failure", OSError("counter unavailable")),
                ("malformed-json", b"not json"),
                ("non-object", b"[]"),
                ("missing-counter", b"{}"),
                ("boolean-counter", b'{"inflight_ms":true}'),
                ("fractional-counter", b'{"inflight_ms":1.5}'),
            ]
        ],
    ],
)
def test_proxy_snapshots_reuse_each_post_hook_baseline(
    snapshots, work, cpu_ms, limits, timing, outcome, monkeypatch, tmp_path, capsys
):
    clock, cpu = ManualClock(), ManualClock()

    class Agent:
        def reset(self, seed, observation):
            pass

        def act(self, observation):
            clock.advance(work[0])
            cpu.advance(cpu_ms)
            return 1

        def chat(self, inbox):
            clock.advance(work[1])
            return []

        def learn(self, observation, action, reward, terminated):
            clock.advance(work[2])

    requests = _reply_snapshots(monkeypatch, snapshots)
    monkeypatch.setattr(live, "load_agent", lambda path: Agent())
    result, steps = _run(
        _payload(_llm_block(1), count=1),
        _entry(turns=1, step_limit_ms=limits[0], episode_limit_ms=limits[1]),
        clock,
        tmp_path,
        cpu_clock_ms=cpu.now_ms,
    )
    action, timeouts, reason, failed_player, diagnostic = outcome
    assert steps[0]["agents"]["player_0"]["timing"] == timing
    assert steps[0]["agents"]["player_0"]["action"] == action
    assert (result.ticks, result.reason, result.failed_player) == (1, reason, failed_player)
    assert result.step_timeouts == {"player_0": timeouts}
    assert set(requests) == {("POST", "Bearer key-0")}
    stderr = capsys.readouterr().err
    assert ("LLM in-flight snapshot failed for player 'player_0'" in stderr) is diagnostic
    assert "key-0" not in stderr


def test_non_llm_players_do_not_touch_credentials_or_marker_transport(probe_repos, monkeypatch, tmp_path):
    create, _ = probe_repos
    root = create("player_0")
    payload = _payload(count=1)
    payload["player_bindings"]["player_0"]["path"] = str(root)
    requests = []

    def no_transport(request, **kwargs):
        requests.append(request.full_url)
        raise OSError("non-LLM session attempted a request")

    monkeypatch.setattr(live.urllib.request, "urlopen", no_transport)
    result, steps = _run(payload, _entry(turns=1), ManualClock(), tmp_path)
    trace = [json.loads(line) for line in (root / "trace.jsonl").read_text(encoding="utf-8").splitlines()]
    assert trace == [
        [phase, "student-base", "student-key", "student-key", client, None]
        for phase, client in [
            ("import", None),
            ("construct", "student-key"),
            ("reset", "student-key"),
            ("act", "student-key"),
            ("chat", "student-key"),
            ("learn", "student-key"),
        ]
    ]
    assert requests == []
    assert (os.environ["OPENAI_BASE_URL"], os.environ["OPENAI_API_KEY"]) == ("student-base", "student-key")
    assert (result.reason, steps[0]["agents"]["player_0"]["action"]) == ("terminated", 1)


@pytest.mark.parametrize(
    "snapshots,cpu_ms,budget,expected",
    [
        pytest.param(
            (0, 90, 90, 90), 0, 10, (2, "episode_limit", "player_0", [1, 1]), id="discount-boundary"
        ),
        pytest.param((0, -1), 0, 10, (0, "episode_limit", "player_0", []), id="unavailable-reading"),
        pytest.param((0, 100), 60, 50, (0, "episode_limit", "player_0", []), id="reset-cpu-floor"),
    ],
)
def test_reset_proxy_discount_obeys_the_episode_budget(
    snapshots, cpu_ms, budget, expected, monkeypatch, tmp_path, capsys
):
    clock, cpu = ManualClock(), ManualClock()

    class Agent:
        def reset(self, seed, observation):
            self.actions = 0
            clock.advance(100)
            cpu.advance(cpu_ms)

        def act(self, observation):
            self.actions += 1
            if self.actions == 2:
                clock.advance(1)
                cpu.advance(1)
            return 1

    _reply_snapshots(monkeypatch, snapshots)
    monkeypatch.setattr(live, "load_agent", lambda path: Agent())
    result, steps = _run(
        _payload(_llm_block(1), count=1),
        _entry(turns=2, messaging=False, episode_limit_ms=budget),
        clock,
        tmp_path,
        cpu_clock_ms=cpu.now_ms,
    )
    assert (result.ticks, result.reason, result.failed_player) == expected[:3]
    assert result.step_timeouts == {"player_0": 0}
    assert [step["agents"]["player_0"]["action"] for step in steps] == expected[3]
    diagnostic = capsys.readouterr().err
    assert ("snapshot failed" in diagnostic) is (snapshots[1] == -1)
