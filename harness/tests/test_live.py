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
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from support_parallel import ThreePlayerParallelEnv
from support_parallel import make_entry as make_parallel_entry

from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import (
    BuiltinAgent,
    EnvironmentEntry,
    EnvironmentMeta,
    PlayerBounds,
    ResolvedLayout,
    ResolvedSeat,
    SeatDeclaration,
    SeatPlan,
    SeatPlans,
    resolve_parameters,
)
from game_sandbox_harness.live import (
    LiveConfig,
    LiveConfigError,
    PlayerBinding,
    build_players,
    describe_failure,
    parse_config,
    run,
    run_live_loop,
)
from game_sandbox_harness.live_io import (
    PausableClock,
    ProtocolStream,
    SessionControl,
    TransportSource,
    build_tee_store,
)
from game_sandbox_harness.participant_runner import IllegalAgentActionError
from game_sandbox_harness.session import AgentPlayer, Episode, ExternalPlayer

DEFAULT_ACTION = -1
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

    def observe(self, player_id: str) -> Any:
        return self._obs

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
        stepping="sequential",
        builtin_agents=(BuiltinAgent("naive", "Naive agent"),),
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


def _payload(recording_dir="/r") -> dict[str, Any]:
    return {
        "env_id": "fake",
        "parameters": {"players": 1},
        "player_bindings": {"player_0": {"kind": "external"}},
        "players": {"player_0": {"kind": "human", "label": "Alice", "user": "alice"}},
        "recording_dir": str(recording_dir),
        "recording_id": "r",
    }


def _run_config(entry, config, *, base=None, clock=None, control=None, sleeper=None):
    base = base or ManualClock(0)
    clock = clock or PausableClock(base)
    control = control or SessionControl(clock)
    streamed = []
    protocol = ProtocolStream(_ListSink(streamed))
    exit_code = run(
        entry,
        config,
        protocol=protocol,
        control=control,
        clock=clock,
        sleeper=sleeper or AdvancingSleeper(base),
        store=build_tee_store(config.recording_dir, protocol),
    )
    assert exit_code == 0
    return (
        streamed,
        [json.loads(line) for line in "".join(streamed).splitlines()],
        Path(config.recording_dir) / "r" / "recording.jsonl",
    )


def _write_agent(path, source):
    (path / "manifest.json").write_text(
        json.dumps({"entry_point": "agent", "class_name": "A", "template_version": 1}), encoding="utf-8"
    )
    (path / "agent.py").write_text(source, encoding="utf-8")


def _subprocess_payload(tmp_path, agent):
    payload = _payload(tmp_path)
    payload.update(
        env_id="flappy_bird",
        parameters={"players": 1, "pipe_gap": 100},
        player_bindings={"player_0": {"kind": "builtin-agent", "path": str(agent)}},
        players={"player_0": {"kind": "agent", "submission_id": "local", "label": "Agent"}},
    )
    return payload


# --- parse_config -----------------------------------------------------------------------


@pytest.mark.parametrize(
    "overrides,seed",
    [
        ({}, 0),
        (
            {
                "seed": 7,
                "headless": True,
                "step_timeout_ms": 250,
                "episode_timeout_ms": 450,
                "messaging_enabled": False,
                "message_cap": 80,
            },
            7,
        ),
    ],
)
def test_parse_config_minimal_and_full(tmp_path, monkeypatch, overrides, seed):
    import game_sandbox_harness.live as live

    base = ManualClock(0)
    entry = make_entry(4 if overrides else 2, pace_interval_ms=50)
    payload = {**_payload(tmp_path), **overrides}
    if overrides:
        _write_agent(
            tmp_path,
            "class A:\n"
            "    def reset(self, seed, observation): pass\n"
            "    def act(self, observation):\n"
            "        self.clock.advance(300)\n"
            "        return 0\n",
        )
        load_agent = live.load_agent

        def load_timed_agent(path):
            agent = load_agent(path)
            agent.clock = base
            return agent

        monkeypatch.setattr(live, "load_agent", load_timed_agent)
        payload.update(
            player_bindings={"player_0": {"kind": "builtin-agent", "path": str(tmp_path)}},
            players={"player_0": {"kind": "agent", "submission_id": "local", "label": "Agent"}},
        )
    config = parse_config([json.dumps(payload)], entry=entry)
    assert config.layout == ResolvedLayout("solo", (ResolvedSeat("seat_0", ("player_0",)),), 1, 1)
    _, frames, recording = _run_config(entry, config, base=base)
    header = json.loads(recording.read_text().splitlines()[0])
    assert header["seed"] == seed
    assert header["players"] == (
        {"player_0": {"kind": "agent", "submission_id": "local", "label": "Agent"}}
        if overrides
        else {"player_0": {"kind": "human", "label": "Alice", "user": "alice"}}
    )
    assert header["parameters"] == {"players": 1}
    assert frames[-1]["ticks"] == 2
    states = [json.loads(line) for line in recording.read_text().splitlines()[1:]]
    assert [state["timing"]["started_at"] for state in states] == ([0, 300] if overrides else [50, 100])
    assert _recorded_actions(recording) == [-1, -1]
    assert frames[-1]["reason"] == ("episode_limit" if overrides else "terminated")
    assert frames[-1]["step_timeouts"] == {"player_0": 2 if overrides else 0}
    if overrides:
        assert [state["agents"]["player_0"]["timing"]["decision_ms"] for state in states] == [300, 300]


@pytest.mark.parametrize("human_timeout_ms", [None, 5000])
def test_parse_config_rejects_any_simultaneous_human_timeout_override(human_timeout_ms):
    sequential = make_entry(1, pace_interval_ms=50)
    entry = replace(sequential, meta=replace(sequential.meta, stepping="simultaneous"))
    payload = _payload()
    assert parse_config([json.dumps(payload)], entry=entry).env_id == "fake"
    payload["human_timeout_ms"] = human_timeout_ms
    with pytest.raises(LiveConfigError, match="simultaneous.*human_timeout_ms"):
        parse_config([json.dumps(payload)], entry=entry)


def test_parse_config_resolves_an_injected_wide_layout_and_rejects_missing_or_foreign_players():
    wide_entry = EnvironmentEntry(
        meta=EnvironmentMeta(
            env_id="wide",
            display_name="Wide",
            description="A synthetic wide layout.",
            stepping="sequential",
            builtin_agents=(BuiltinAgent("naive", "Naive agent"),),
            layout=SeatPlans(
                (
                    SeatPlan(
                        "uneven",
                        "Uneven",
                        (SeatDeclaration((0, 2)), SeatDeclaration((1,))),
                    ),
                )
            ),
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
            "player_0": {"kind": "builtin-agent", "name": "naive"},
            "player_1": {"kind": "builtin-agent", "name": "naive"},
            "player_2": {"kind": "builtin-agent", "name": "naive"},
        },
        "players": {
            "player_0": {"kind": "agent", "builtin_name": "naive", "label": "A"},
            "player_1": {"kind": "agent", "builtin_name": "naive", "label": "B"},
            "player_2": {"kind": "agent", "builtin_name": "naive", "label": "A"},
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
    payload["player_bindings"]["player_2"] = {"kind": "builtin-agent", "name": "naive"}
    payload["players"]["player_9"] = payload["players"].pop("player_2")
    with pytest.raises(LiveConfigError, match="unknown players"):
        parse_config([json.dumps(payload)], entry=wide_entry)


def test_parse_config_accepts_only_an_external_designated_chat_player():
    entry = EnvironmentEntry(
        meta=EnvironmentMeta(
            env_id="two-humans",
            display_name="Two humans",
            description="A parser-only two-external fixture.",
            stepping="sequential",
            builtin_agents=(BuiltinAgent("naive", "Naive agent"),),
            layout=PlayerBounds(2, 2),
            human_players=("player_0", "player_1"),
            human_timeout_ms=None,
            recommended_episode_ticks=1,
            pace_interval_ms=None,
            step_limit_ms=1000,
            episode_limit_ms=1000,
            messaging=True,
            message_cap=None,
            llm=False,
            renderer="fake",
        ),
        make=lambda _parameters: FakeEnv(1),
        default_action=lambda _env, _player_id: DEFAULT_ACTION,
    )
    payload = {
        "env_id": "two-humans",
        "parameters": {"players": 2},
        "player_bindings": {"player_0": {"kind": "external"}, "player_1": {"kind": "external"}},
        "players": {
            "player_0": {"kind": "human", "label": "A"},
            "player_1": {"kind": "human", "label": "B"},
        },
        "recording_dir": "/r",
        "external_chat_player": "player_1",
    }
    assert parse_config([json.dumps(payload)], entry=entry).external_chat_player == "player_1"

    payload["external_chat_player"] = None
    assert parse_config([json.dumps(payload)], entry=entry).external_chat_player is None

    payload["external_chat_player"] = "player_9"  # not a bound player at all
    with pytest.raises(LiveConfigError, match="external player binding"):
        parse_config([json.dumps(payload)], entry=entry)

    # Bound, but to an agent: chat authority belongs to a human seat, not merely to a named player.
    payload["player_bindings"]["player_1"] = {"kind": "builtin-agent", "name": "naive"}
    payload["players"]["player_1"] = {"kind": "agent", "builtin_name": "naive", "label": "B"}
    payload["external_chat_player"] = "player_1"
    with pytest.raises(LiveConfigError, match="external player binding"):
        parse_config([json.dumps(payload)], entry=entry)

    payload["external_chat_player"] = 7
    with pytest.raises(LiveConfigError, match="player id string or null"):
        parse_config([json.dumps(payload)], entry=entry)


@pytest.mark.parametrize(
    "player,cause",
    [
        (
            {"kind": "agent", "label": "Both", "submission_id": "sub-1", "builtin_name": "naive"},
            "exactly one",
        ),
        ({"kind": "agent", "label": "Anonymous"}, "exactly one"),
        ({"kind": "agent", "label": "Owned", "builtin_name": "naive", "user": "owner"}, "cannot carry"),
        ({"kind": "agent", "label": "Empty", "submission_id": ""}, "submission_id"),
        ({"kind": "agent", "label": "Null", "submission_id": None}, "submission_id"),
        ({"kind": "human", "label": "Alice", "builtin_name": "naive"}, "cannot carry"),
    ],
)
def test_parse_config_rejects_non_disjoint_player_attribution(player, cause):
    payload = _payload()
    if player["kind"] == "agent":
        payload["player_bindings"] = {"player_0": {"kind": "builtin-agent", "path": "/agent"}}
        payload["players"] = {"player_0": {"kind": "agent", "submission_id": "local", "label": "Agent"}}
    entry = make_entry(1, pace_interval_ms=None)
    parse_config([json.dumps(payload)], entry=entry)
    payload["players"] = {"player_0": player}
    with pytest.raises(LiveConfigError, match=cause):
        parse_config([json.dumps(payload)], entry=entry)


@pytest.mark.parametrize(
    "binding,identity,cause",
    [
        ({"kind": "builtin-agent"}, {"kind": "agent", "builtin_name": "naive", "label": "A"}, "must name"),
        (
            {"kind": "builtin-agent", "name": "unknown"},
            {"kind": "agent", "builtin_name": "unknown", "label": "A"},
            "does not declare",
        ),
        (
            {"kind": "builtin-agent", "name": "naive"},
            {"kind": "agent", "builtin_name": "other", "label": "A"},
            "match",
        ),
        (
            {"kind": "builtin-agent", "path": "/agent"},
            {"kind": "agent", "builtin_name": "naive", "label": "A"},
            "submission_id",
        ),
        ({"kind": "external", "name": "naive"}, {"kind": "human", "label": "A"}, "must not name"),
    ],
)
def test_parse_config_requires_a_name_for_a_pathless_builtin_binding(binding, identity, cause):
    entry = make_entry(1, pace_interval_ms=None)
    payload = _payload()
    parse_config([json.dumps(payload)], entry=entry)
    payload.update(player_bindings={"player_0": binding}, players={"player_0": identity})
    with pytest.raises(LiveConfigError, match=cause):
        parse_config([json.dumps(payload)], entry=entry)


@pytest.mark.parametrize(
    "field,value,cause",
    [
        ("env_id", None, "env_id"),
        ("player_bindings", None, "player_bindings"),
        ("player_bindings", {}, "player_bindings"),
        ("player_bindings", {"player_0": {"kind": "robot"}}, "kind"),
        ("recording_dir", None, "recording_dir"),
        ("seed", 1.5, "seed"),
        ("players", {"player_0": {"kind": "robot", "label": "x"}}, "kind"),
        ("players", {"player_0": {"kind": "human"}}, "label"),
        ("players", [], "players"),
        ("players", None, "players"),
        ("step_timeout_ms", "soon", "step_timeout_ms"),
        ("headless", "yes", "headless"),
        ("messaging_enabled", "on", "messaging_enabled"),
        ("message_cap", "lots", "message_cap"),
    ],
)
def test_parse_config_rejects_bad_payloads(field, value, cause):
    entry = make_entry(1, pace_interval_ms=50)
    payload = _payload()
    parse_config([json.dumps(payload)], entry=entry)
    if value is None:
        del payload[field]
    else:
        payload[field] = value
    with pytest.raises(LiveConfigError, match=cause):
        parse_config([json.dumps(payload)], entry=entry)


def test_parse_config_requires_exactly_one_argument():
    with pytest.raises(LiveConfigError):
        parse_config([])
    with pytest.raises(LiveConfigError):
        parse_config(["{}", "{}"])


# --- build_players ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "override,action,elapsed",
    [
        ({}, -1, 30),
        ({"human_timeout_ms": 10}, -1, 10),
        ({"human_timeout_ms": None}, 5, 50),
    ],
)
def test_build_players_external_resolves_timeout_override_then_metadata(tmp_path, override, action, elapsed):
    entry = make_entry(1, pace_interval_ms=None, human_timeout_ms=30)
    config = parse_config([json.dumps({**_payload(tmp_path), **override})], entry=entry)
    base = ManualClock(0)
    clock = PausableClock(base)
    control = SessionControl(clock)
    control.handle_line('{"kind":"clock","player":"player_0","running":true}')
    sleeper = AdvancingSleeper(
        base, at=10, do=lambda: control.handle_line('{"kind":"input","player":"player_0","action":5}')
    )
    _, _, recording = _run_config(entry, config, base=base, control=control, sleeper=sleeper)
    assert _recorded_actions(recording) == [action]
    assert base.now_ms() == elapsed
    assert entry.meta.human_timeout_ms == 30


def test_build_players_builtin_agent_loads_through_manifest(tmp_path):
    _write_agent(
        tmp_path,
        "class A:\n"
        "    def reset(self, seed, observation): self.n = seed\n"
        "    def act(self, observation):\n"
        "        self.n += 1\n"
        "        return self.n\n",
    )
    config = LiveConfig(
        "fake",
        0,
        {
            "player_0": PlayerBinding("builtin-agent", path=str(tmp_path)),
            "player_1": PlayerBinding("builtin-agent", path=str(tmp_path)),
        },
        None,
        "/r",
        None,
        {"players": 1},
    )
    base = ManualClock(0)
    players = build_players(
        config,
        make_entry(1, pace_interval_ms=None),
        SessionControl(),
        PausableClock(base),
        AdvancingSleeper(base),
    )
    left, right = players["player_0"], players["player_1"]
    assert isinstance(left, AgentPlayer) and isinstance(right, AgentPlayer)
    left.agent.reset(10, None)
    right.agent.reset(20, None)
    assert [left.agent.act(None), left.agent.act(None), right.agent.act(None)] == [11, 12, 21]
    left.agent.reset(0, None)
    assert [left.agent.act(None), right.agent.act(None)] == [1, 22]


@pytest.mark.parametrize("explicit_path", [False, True])
def test_build_players_builtin_agent_without_path_resolves_the_named_env_default(
    tmp_path, monkeypatch, explicit_path
):
    import game_sandbox_harness.live as live

    staged = tmp_path / "builtin"
    agent = staged / "fake" / "naive"
    agent.mkdir(parents=True)
    _write_agent(
        agent,
        "class A:\n    def reset(self, seed, observation): pass\n    def act(self, observation): return 42\n",
    )
    monkeypatch.setattr(live, "DEFAULT_BUILTIN_AGENT_BASE", str(staged))
    entry = make_entry(1, pace_interval_ms=None)
    payload = _payload(tmp_path)
    binding = {"kind": "builtin-agent", "name": "naive"}
    if explicit_path:
        binding["path"] = str(agent)
    payload.update(
        player_bindings={"player_0": binding},
        players={"player_0": {"kind": "agent", "builtin_name": "naive", "label": "A"}},
    )
    config = parse_config([json.dumps(payload)], entry=entry)
    _, _, recording = _run_config(entry, config)
    assert _recorded_actions(recording) == [42]


# --- the live loop ----------------------------------------------------------------------


@pytest.mark.parametrize("inputs,actions", [([], [-1, -1, -1]), ([0, 1], [1, -1, -1])])
def test_paced_latched_input_drives_the_player_then_defaults(tmp_path, inputs, actions):
    base = ManualClock(0)
    starts = []
    entry = make_entry(3, pace_interval_ms=20, on_step=lambda: starts.append(base.now_ms()))
    control = SessionControl(PausableClock(base))
    for action in inputs:
        control.handle_line(json.dumps({"kind": "input", "player": "player_0", "action": action}))
    config = parse_config([json.dumps(_payload(tmp_path))], entry=entry)
    _, _, recording = _run_config(entry, config, base=base, control=control)
    assert _recorded_actions(recording) == actions
    assert starts == [20, 40, 60]


class _LateFirstWakeSleeper(AdvancingSleeper):
    """Advances like :class:`AdvancingSleeper`, except the first sleep oversleeps to ``wake_at``."""

    def __init__(self, base: ManualClock, wake_at: int) -> None:
        super().__init__(base)
        self._wake_at = wake_at

    def sleep_ms(self, ms: int) -> None:
        if self.calls == 0:
            self.calls += 1
            self._base.advance(self._wake_at - self._base.now_ms())
            return
        super().sleep_ms(ms)


def _simultaneous_run(
    work_ms: list[int],
    *,
    interval_ms: int = 50,
    sleeper_for: Any = AdvancingSleeper,
    during_first_tick: Any = None,
) -> tuple[list[int], list[dict[str, int]]]:
    """Run the three-tick parallel fixture paced at ``interval_ms``, spending ``work_ms[i]`` inside
    tick ``i``. Returns each tick's start time and its action map."""
    base = ManualClock(0)
    clock = PausableClock(base)
    control = SessionControl(clock)
    starts: list[int] = []
    actions_seen: list[dict[str, int]] = []

    class TimedParallelEnv(ThreePlayerParallelEnv):
        def step(self, actions):
            starts.append(base.now_ms())
            actions_seen.append(dict(actions))
            if len(starts) == 1 and during_first_tick is not None:
                during_first_tick(control)
            base.advance(work_ms[len(starts) - 1])
            return super().step(actions)

    entry = replace(make_parallel_entry(), make=lambda _parameters: TimedParallelEnv())
    sleeper = sleeper_for(base)
    players = {
        player: ExternalPlayer(TransportSource(control, clock=clock, paced=True, sleeper=sleeper))
        for player in entry.meta.human_players
    }
    with Episode(entry, players, parameters=resolve_parameters(entry.meta), seed=1, clock=clock) as episode:
        assert episode.opening_state() is not None
        run_live_loop(
            episode, pace_interval_ms=interval_ms, control=control, clock=clock, sleeper=sleeper, slice_ms=1
        )
        assert episode.result().ticks == 3
    return starts, actions_seen


@pytest.mark.parametrize(
    "work,interval,wake,starts",
    [
        ([20, 20, 20], 50, None, [50, 100, 150]),
        ([70, 20, 20], 50, None, [50, 170, 220]),
        ([50, 20, 20], 50, None, [50, 150, 200]),
        ([49, 20, 20], 50, None, [50, 100, 150]),
        ([20, 20, 20], 250, 800, [800, 1070, 1320]),
    ],
)
def test_simultaneous_live_cadence_keeps_a_fixed_rate_despite_tick_work(work, interval, wake, starts):
    actual, _ = _simultaneous_run(
        work,
        interval_ms=interval,
        sleeper_for=(AdvancingSleeper if wake is None else lambda base: _LateFirstWakeSleeper(base, wake)),
    )
    assert actual == starts


def test_simultaneous_live_input_sent_during_a_tick_is_used_by_the_next_tick():
    def send(control: SessionControl) -> None:
        control.handle_line(json.dumps({"kind": "input", "player": "player_2", "action": 2}))

    _starts, actions = _simultaneous_run([20, 20, 20], during_first_tick=send)
    assert [tick["player_2"] for tick in actions] == [0, 2, 0]


@pytest.mark.parametrize(
    "mode,interval,starts",
    [("sequential", 20, [50, 70]), ("sequential", None, [30, 30]), ("simultaneous", 50, [80, 130, 180])],
)
def test_simultaneous_live_cadence_stays_paused_until_resume(mode, interval, starts):
    base = ManualClock(0)
    clock = PausableClock(base)
    control = SessionControl(clock)
    seen = []
    if mode == "simultaneous":

        class Observed(ThreePlayerParallelEnv):
            def step(self, actions):
                seen.append(base.now_ms())
                return super().step(actions)

        entry = make_parallel_entry(Observed)
    else:
        entry = make_entry(2, pace_interval_ms=interval, on_step=lambda: seen.append(base.now_ms()))
    control.pause()
    sleeper = AdvancingSleeper(base, at=6, do=control.resume)
    players = {
        p: ExternalPlayer(TransportSource(control, clock=clock, paced=True, sleeper=sleeper))
        for p in entry.meta.human_players
    }
    with Episode(entry, players, parameters=resolve_parameters(entry.meta), seed=1, clock=clock) as episode:
        run_live_loop(
            episode, pace_interval_ms=interval, control=control, clock=clock, sleeper=sleeper, slice_ms=5
        )
    assert seen == starts
    assert base.now_ms() - clock.now_ms() == 30
    assert episode.result().reason in ("terminated", "truncated")


@pytest.mark.parametrize("mode", ["sequential", "simultaneous"])
@pytest.mark.parametrize("when,ticks", [("before", 0), ("paused", 0), ("waiting", 0), ("hook", 1)])
def test_simultaneous_live_stop_prevents_the_next_joint_tick(tmp_path, monkeypatch, mode, when, ticks):
    import game_sandbox_harness.live as live

    base = ManualClock(0)
    clock = PausableClock(base)
    control = SessionControl(clock)

    def stop():
        control.handle_line('{"kind":"stop"}')

    entry = make_parallel_entry() if mode == "simultaneous" else make_entry(3, pace_interval_ms=20)
    if when == "before":
        stop()
    elif when == "paused":
        control.pause()
    sleeper = AdvancingSleeper(base, at=2, do=stop if when in ("paused", "waiting") else None)
    payload = _payload(tmp_path)
    if mode == "simultaneous":
        payload.update(
            env_id=entry.meta.env_id,
            parameters={"players": 3},
            player_bindings={p: {"kind": "external"} for p in entry.meta.human_players},
            players={p: {"kind": "human", "label": p} for p in entry.meta.human_players},
        )
    if when == "hook":
        _write_agent(
            tmp_path,
            "class A:\n"
            "    def reset(self, seed, observation): pass\n"
            "    def act(self, observation):\n"
            "        self.stop()\n"
            "        return 0\n",
        )
        load_agent = live.load_agent

        def load_stopping_agent(path):
            agent = load_agent(path)
            agent.stop = stop
            return agent

        monkeypatch.setattr(live, "load_agent", load_stopping_agent)
        payload["player_bindings"]["player_0"] = {"kind": "builtin-agent", "path": str(tmp_path)}
        payload["players"]["player_0"] = {"kind": "agent", "submission_id": "local", "label": "A"}
    config = parse_config([json.dumps(payload)], entry=entry)
    _, frames, recording = _run_config(
        entry, config, base=base, control=control, sleeper=sleeper, clock=clock
    )
    assert frames[-1]["ticks"] == ticks
    assert frames[-1]["reason"] == "stopped"
    assert len(recording.read_text().splitlines()) == ticks + 1
    if when == "hook":
        state = json.loads(recording.read_text().splitlines()[1])
        assert state["agents"]["player_0"]["action"] == 0
        assert list(state["agents"]) == (
            ["player_0", "player_1", "player_2"] if mode == "simultaneous" else ["player_0"]
        )


@pytest.mark.parametrize("mode", ["paced", "turn", "simultaneous"])
def test_streamed_bytes_equal_stored_bytes_and_result_is_not_recorded(tmp_path, mode):
    base = ManualClock(0)
    starts = []
    if mode == "simultaneous":

        class Observed(ThreePlayerParallelEnv):
            def step(self, actions):
                starts.append(base.now_ms())
                return super().step(actions)

        entry = make_parallel_entry(Observed)
    else:
        entry = make_entry(
            2, pace_interval_ms=20 if mode == "paced" else None, human_timeout_ms=5, with_overlay=True
        )
    payload = _payload(tmp_path)
    payload.update(
        env_id=entry.meta.env_id,
        parameters={"players": len(entry.meta.human_players)},
        player_bindings={p: {"kind": "external"} for p in entry.meta.human_players},
        players={p: {"kind": "human", "label": p} for p in entry.meta.human_players},
    )
    config = parse_config([json.dumps(payload)], entry=entry)
    clock = PausableClock(base)
    control = SessionControl(clock)
    for p in entry.meta.human_players:
        control.handle_line(json.dumps({"kind": "clock", "player": p, "running": True}))
    streamed = []

    class OpeningSink(_ListSink):
        def write(self, text):
            super().write(text)
            frame = json.loads(text)
            if "tick" in frame and frame["agents"] == {}:
                base.advance(30)

    protocol = ProtocolStream(OpeningSink(streamed))
    assert (
        run(
            entry,
            config,
            protocol=protocol,
            control=control,
            clock=clock,
            sleeper=AdvancingSleeper(base),
            store=build_tee_store(str(tmp_path), protocol),
        )
        == 0
    )
    wire = "".join(streamed).splitlines(keepends=True)
    disk = (tmp_path / "r" / "recording.jsonl").read_bytes().decode().splitlines(keepends=True)
    opening = mode != "paced"
    assert [wire[0], *wire[2:-1]] == disk if opening else wire[:-1] == disk
    if opening:
        assert json.loads(wire[1])["agents"] == {}
    ticks = 3 if mode == "simultaneous" else 2
    assert json.loads(wire[-1]) == {
        "kind": "result",
        "ticks": ticks,
        "scores": {p: 0.0 if mode == "simultaneous" else 2.0 for p in entry.meta.human_players},
        "reason": "truncated" if mode == "simultaneous" else "terminated",
        "step_timeouts": {p: 0 for p in entry.meta.human_players},
        "recording_id": "r",
        "failed_player": None,
        "error": None,
    }
    assert all("kind" not in json.loads(line) for line in disk)
    if mode == "simultaneous":
        assert starts == [80, 130, 180]


def test_turn_based_blocks_for_input_then_steps(tmp_path):
    base = ManualClock(0)
    clock = PausableClock(base)
    control = SessionControl(clock)
    sleeper = AdvancingSleeper(
        base, at=2, do=lambda: control.handle_line('{"kind":"input","player":"player_0","action":5}')
    )
    entry = make_entry(1, pace_interval_ms=None)
    config = parse_config([json.dumps(_payload(tmp_path))], entry=entry)
    _, frames, recording = _run_config(entry, config, base=base, control=control, sleeper=sleeper)
    assert _recorded_actions(recording) == [5]
    assert frames[-1]["ticks"] == 1
    assert base.now_ms() == 10


# --- end-to-end human chat over the transport -------------------------------------------


def _messaging_entry(n_steps: int, *, messaging: bool) -> EnvironmentEntry:
    meta = EnvironmentMeta(
        env_id="fake-chat",
        display_name="Fake Chat",
        description="A deterministic fake with messaging.",
        stepping="sequential",
        builtin_agents=(BuiltinAgent("naive", "Naive agent"),),
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


@pytest.mark.parametrize(
    "enabled,sender,cap,expected",
    [
        (True, "player_0", 80, [[{"from": "player_0", "to": None, "text": "hello table"}], []]),
        (False, "player_0", 80, [[], []]),
        (True, None, 80, [[], []]),
        (True, "player_0", 5, [[], []]),
    ],
)
def test_human_chat_frame_over_transport_lands_in_the_recording(tmp_path, enabled, sender, cap, expected):
    entry = _messaging_entry(2, messaging=True)
    payload = _payload(tmp_path)
    payload.update(
        env_id="fake-chat", messaging_enabled=enabled, external_chat_player=sender, message_cap=cap
    )
    config = parse_config([json.dumps(payload)], entry=entry)
    base = ManualClock(0)
    clock = PausableClock(base)
    control = SessionControl(clock)
    sleeper = AdvancingSleeper(
        base,
        at=1,
        do=lambda: control.handle_line('{"kind":"chat","player":"player_0","to":null,"text":"hello table"}'),
    )
    _, _, recording = _run_config(entry, config, base=base, control=control, sleeper=sleeper)
    assert _messages_in(recording) == expected


# --- stdout hygiene, as a real subprocess over a real environment -----------------------


def test_module_subprocess_keeps_stdout_clean_and_classifiable(tmp_path):
    agent = tmp_path / "agent"
    agent.mkdir()
    _write_agent(
        agent,
        "import os\n"
        "print('noise-import', flush=True)\n"
        "os.write(1, b'noise-fd\\n')\n"
        "class A:\n"
        "    def reset(self, seed, observation): print('noise-reset', flush=True)\n"
        "    def act(self, observation):\n"
        "        print('noise-act', flush=True)\n"
        "        return 0\n",
    )
    payload = _subprocess_payload(tmp_path, agent)
    payload.update(headless=True, max_steps=1)
    proc = subprocess.run(
        [sys.executable, "-m", "game_sandbox_harness.live", json.dumps(payload)],
        input="",
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    for sentinel in ("noise-import", "noise-fd", "noise-reset", "noise-act"):
        assert sentinel in proc.stderr
        assert sentinel not in proc.stdout
    frames = [json.loads(line) for line in proc.stdout.splitlines()]
    assert frames[0]["environment"] == "flappy_bird"
    assert frames[-1]["kind"] == "result"
    assert frames[-1]["ticks"] == 1
    assert all("kind" not in frame for frame in frames[:-1])


@pytest.mark.parametrize("hook", ["reset", "act", "learn"])
def test_module_subprocess_charges_a_crashing_agent_to_its_own_player(tmp_path, hook):
    agent = tmp_path / "agent"
    agent.mkdir()
    bodies = {"reset": "pass", "act": "return 0", "learn": "pass"}
    bodies[hook] = "raise RuntimeError('boom')"
    _write_agent(
        agent,
        "class A:\n"
        f"    def reset(self, seed, observation): {bodies['reset']}\n"
        f"    def act(self, observation): {bodies['act']}\n"
        f"    def learn(self, observation, action, reward, terminated): {bodies['learn']}\n",
    )
    payload = _subprocess_payload(tmp_path, agent)
    payload["headless"] = True
    proc = subprocess.run(
        [sys.executable, "-m", "game_sandbox_harness.live", json.dumps(payload)],
        input="",
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 1, proc.stderr
    frames = [json.loads(line) for line in proc.stdout.splitlines()]
    results = [f for f in frames if f.get("kind") == "result"]
    assert len(results) == 1
    result = results[0]
    assert result["failed_player"] == "player_0"
    assert result["reason"] == "error"
    assert result["error"].startswith("RuntimeError: boom (agent.py:")
    assert result["error"].endswith(f" in {hook})")
    assert "Traceback (most recent call last)" in proc.stderr
    header = json.loads((tmp_path / "r" / "recording.jsonl").read_text().splitlines()[0])
    assert header["environment"] == "flappy_bird"


def _raised(error: Exception) -> Exception:
    """Raise ``error`` from this file so it carries a traceback outside the harness package."""
    try:
        raise error
    except Exception as caught:  # noqa: BLE001 - the test inspects the caught exception
        return caught


def test_describe_failure_names_the_type_message_and_the_innermost_non_harness_line():
    description = describe_failure(_raised(KeyError("evening")))
    assert description.startswith("KeyError: 'evening' (test_live.py:")
    assert description.endswith(" in _raised)")
    assert (
        describe_failure(IllegalAgentActionError("player_1 returned an illegal action: 9"))
        == "IllegalAgentActionError: player_1 returned an illegal action: 9"
    )
    assert describe_failure(RuntimeError()) == "RuntimeError"
    assert describe_failure(RuntimeError("two\n  lines")) == "RuntimeError: two lines"
    message = describe_failure(RuntimeError("x" * 1000)).removeprefix("RuntimeError: ")
    assert message.startswith("x" * 290)
    assert len(message) <= 300
    assert "\n" not in message
