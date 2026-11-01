"""Focused safety and lifecycle coverage for the loopback local relay."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

import pytest
import websockets
from support_parallel import make_entry as make_parallel_entry
from websockets.exceptions import ConnectionClosed

from game_sandbox_harness.environment import (
    BuiltinAgent,
    EnvironmentEntry,
    EnvironmentMeta,
    PlayerBounds,
    load_environment,
)
from game_sandbox_harness.local_server import LocalServer

_HTTP_TIMEOUT = 5.0
_SERVER_TIMEOUT = 5.0
_STATE_HEADER = '{"schema_version":1,"environment":"fake"}'


def _entry() -> EnvironmentEntry:
    meta = EnvironmentMeta(
        env_id="fake",
        display_name="Fake",
        description="fake",
        stepping="sequential",
        builtin_agents=(BuiltinAgent("naive", "Naive agent"),),
        layout=PlayerBounds(1, 1),
        human_players=("player_0",),
        human_timeout_ms=None,
        recommended_episode_ticks=1,
        pace_interval_ms=1,
        step_limit_ms=1,
        episode_limit_ms=1,
        messaging=False,
        message_cap=None,
        llm=False,
        renderer="fake",
    )
    return EnvironmentEntry(meta, lambda: object(), lambda _env, _player: 0)


def _static_root(tmp_path: Path) -> Path:
    root = tmp_path / "static"
    root.mkdir()
    (root / "local.html").write_text("local", encoding="utf-8")
    return root


async def _http(port: int, method: str, path: str) -> tuple[str, dict[str, str], bytes]:
    reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), timeout=_HTTP_TIMEOUT)
    try:
        request = f"{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        writer.write(request.encode())
        await asyncio.wait_for(writer.drain(), timeout=_HTTP_TIMEOUT)
        raw = await asyncio.wait_for(reader.read(), timeout=_HTTP_TIMEOUT)
    finally:
        writer.close()
        await asyncio.wait_for(writer.wait_closed(), timeout=_HTTP_TIMEOUT)
    if b"\r\n\r\n" not in raw:
        return raw.decode(), {}, b""
    head, body = raw.split(b"\r\n\r\n", 1)
    lines = head.decode().split("\r\n")
    headers = dict(line.split(": ", 1) for line in lines[1:] if ": " in line)
    return lines[0], headers, body


async def _recv(socket):
    return await asyncio.wait_for(socket.recv(), timeout=5)


async def _attach(socket, *, paused=False, state=False, awaiting_start=False):
    required = {"header", "session"}
    if paused:
        required.add("pause")
    if state:
        required.add("state")
    frames = {}
    async with asyncio.timeout(5):
        while not required <= frames.keys():
            raw = await socket.recv()
            frame = json.loads(raw)
            kind = "header" if "environment" in frame else "state" if "tick" in frame else frame["kind"]
            frames[kind] = raw
    assert json.loads(frames["session"]) == {
        "kind": "session",
        "status": "running",
        "awaiting_start": awaiting_start,
    }
    if paused:
        assert json.loads(frames["pause"]) == {"kind": "pause"}
    return frames


async def _until_closed(socket):
    frames = []
    async with asyncio.timeout(5):
        try:
            while True:
                frames.append(json.loads(await socket.recv()))
        except ConnectionClosed:
            return frames


def test_local_server_receives_real_paused_runner_header_before_any_command(tmp_path: Path) -> None:
    """A paused local runner announces itself before the browser writes to stdin.

    Windows can block the child main thread when its stdin reader starts too early. This real
    subprocess regression keeps the socket idle until the header, running status, and pause event
    are all received.
    """
    pytest.importorskip("flappy_bird", reason="environments package not installed")

    async def exercise() -> None:
        static_root = _static_root(tmp_path)
        config = {
            "env_id": "flappy_bird",
            "parameters": {"players": 1, "pipe_gap": 100},
            "seed": 0,
            "player_bindings": {"player_0": {"kind": "external"}},
            "players": {"player_0": {"kind": "human", "label": "Human"}},
            "recording_dir": str(tmp_path / "recordings"),
            "recording_id": "local",
            "start_paused": True,
        }
        command = [
            sys.executable,
            "-m",
            "game_sandbox_harness.live",
            json.dumps(config, separators=(",", ":")),
        ]
        async with LocalServer(
            load_environment("flappy_bird"),
            command=command,
            static_root=static_root,
            start_paused=True,
        ) as server:
            uri = f"ws://127.0.0.1:{server.port}/api/sessions/local/ws"
            async with websockets.connect(uri, close_timeout=1) as socket:
                frames = await _attach(socket, paused=True, awaiting_start=True)
                header = json.loads(frames["header"])
                assert header["environment"] == "flappy_bird"
                assert header["schema_version"] == 1

    asyncio.run(exercise())


def test_local_server_consumes_start_gate_and_replays_later_pause_on_attach(tmp_path: Path) -> None:
    async def exercise() -> None:
        static_root = _static_root(tmp_path)
        child = (
            "import json\n"
            "import sys\n"
            'print(\'{"schema_version":1,"environment":"fake"}\', flush=True)\n'
            'print(\'{"schema_version":1,"tick":0,"agents":{},"timing":{}}\', flush=True)\n'
            "for raw in sys.stdin:\n"
            "    command = json.loads(raw)\n"
            '    if command.get("kind") == "stop":\n'
            '        print(\'{"kind":"result","reason":"stopped"}\', flush=True)\n'
            "        break\n"
            '    if command.get("kind") in ("input", "chat", "clock"):\n'
            '        print(json.dumps({"schema_version": 1, "tick": 1, "agents": {}, "timing": {}, '
            '"received": command}), flush=True)\n'
        )
        async with LocalServer(
            _entry(),
            command=[sys.executable, "-c", child],
            static_root=static_root,
            start_paused=True,
        ) as server:
            uri = f"ws://127.0.0.1:{server.port}/api/sessions/local/ws"
            async with websockets.connect(uri, close_timeout=1) as first:
                await _attach(first, paused=True, state=True, awaiting_start=True)
                await first.send('{"kind":"input","player":"player_0","action":1}')
                await first.send('{"kind":"chat","player":"player_0","to":null,"text":"hello"}')
                await first.send('{"kind":"clock","player":"player_0","running":true}')
                await first.send('{"kind":"resume"}')
                assert json.loads(await _recv(first)) == {"kind": "resume"}
                await first.send('{"kind":"input","player":"player_0","action":2}')
                forwarded = json.loads(await _recv(first))
                assert forwarded["received"] == {"kind": "input", "player": "player_0", "action": 2}
                await first.send('{"kind":"pause"}')
                assert json.loads(await _recv(first)) == {"kind": "pause"}

            async with websockets.connect(uri, close_timeout=1) as second:
                replay = await _attach(second, paused=True, state=True)
                assert json.loads(replay["state"])["received"] == {
                    "kind": "input",
                    "player": "player_0",
                    "action": 2,
                }
                await second.send('{"kind":"stop"}')
                assert await _until_closed(second) == [
                    {"kind": "result", "reason": "stopped"},
                    {"kind": "session", "reason": "stopped", "status": "ended"},
                ]

    asyncio.run(exercise())


def test_local_server_runs_the_injected_parallel_fixture_through_the_live_runner(
    tmp_path: Path,
) -> None:
    async def exercise() -> None:
        static_root = _static_root(tmp_path)
        recording_dir = tmp_path / "recordings"
        config = {
            "env_id": "three_player_parallel_test",
            "parameters": {"players": 3},
            "seed": 1,
            "player_bindings": {
                player: {"kind": "external"} for player in ("player_0", "player_1", "player_2")
            },
            "players": {
                player: {"kind": "human", "label": f"Human {index}"}
                for index, player in enumerate(("player_0", "player_1", "player_2"))
            },
            "recording_dir": str(recording_dir),
            "recording_id": "parallel-local",
            "start_paused": True,
        }
        tests_dir = str(Path(__file__).parent)
        child = (
            "import sys\n"
            f"sys.path.insert(0, {tests_dir!r})\n"
            "from support_parallel import make_entry\n"
            "from game_sandbox_harness.clock import SystemClock\n"
            "from game_sandbox_harness.live import parse_config, run\n"
            "from game_sandbox_harness.live_io import "
            "PausableClock, ProtocolStream, RealSleeper, SessionControl, build_tee_store\n"
            "entry = make_entry()\n"
            "config = parse_config([sys.argv[1]], entry=entry)\n"
            "clock = PausableClock(SystemClock())\n"
            "control = SessionControl(clock)\n"
            "protocol = ProtocolStream(sys.stdout)\n"
            "raise SystemExit(run(\n"
            "    entry, config, protocol=protocol, control=control,\n"
            "    clock=clock, sleeper=RealSleeper(),\n"
            "    store=build_tee_store(config.recording_dir, protocol), command_lines=sys.stdin,\n"
            "))\n"
        )
        command = [
            sys.executable,
            "-c",
            child,
            json.dumps(config, separators=(",", ":")),
        ]

        async with LocalServer(
            make_parallel_entry(),
            command=command,
            static_root=static_root,
            start_paused=True,
        ) as server:
            uri = f"ws://127.0.0.1:{server.port}/api/sessions/local/ws"
            async with websockets.connect(uri, close_timeout=1) as socket:
                initial = await _attach(socket, paused=True, state=True, awaiting_start=True)
                assert json.loads(initial["state"])["agents"] == {}
                await socket.send('{"kind":"resume"}')
                assert json.loads(await _recv(socket)) == {"kind": "resume"}
                states = [await _recv(socket) for _ in range(3)]
                result = json.loads(await _recv(socket))
                assert await _until_closed(socket) == [
                    {"kind": "session", "status": "ended", "reason": "truncated"},
                ]
            await asyncio.wait_for(server.wait(), timeout=5)

        recording = recording_dir / "parallel-local" / "recording.jsonl"
        assert recording.read_bytes() == ("\n".join([initial["header"], *states]) + "\n").encode()
        assert [list(json.loads(line)["agents"]) for line in states] == [
            ["player_0", "player_1", "player_2"],
            ["player_1", "player_2"],
            ["player_2"],
        ]
        assert result == {
            "kind": "result",
            "ticks": 3,
            "scores": {"player_0": 0.0, "player_1": 0.0, "player_2": 0.0},
            "reason": "truncated",
            "step_timeouts": {"player_0": 0, "player_1": 0, "player_2": 0},
            "recording_id": "parallel-local",
            "failed_player": None,
            "error": None,
        }

    asyncio.run(exercise())


_FULL_MESSAGES: list[dict[str, Any]] = [
    {"from": "player_1", "to": None, "text": "near", "recipients": ["player_0"]},
    {"from": "player_1", "to": None, "text": "far", "recipients": ["player_2"]},
    {"from": "player_0", "to": None, "text": "mine", "recipients": ["player_2"]},
    {"from": "player_1", "to": None, "text": "open"},
    {"from": "player_3", "to": "player_5", "text": "npc chatter"},
    {"from": "player_0", "to": "player_5", "text": "from controller"},
    {"from": "player_3", "to": "player_0", "text": "to controller"},
]
_ONE_CONTROLLER_EXPECTED: list[dict[str, Any]] = [
    {"from": "player_1", "to": None, "text": "near"},
    {"from": "player_0", "to": None, "text": "mine"},
    {"from": "player_1", "to": None, "text": "open"},
    {"from": "player_0", "to": "player_5", "text": "from controller"},
    {"from": "player_3", "to": "player_0", "text": "to controller"},
]
_TWO_CONTROLLERS_EXPECTED: list[dict[str, Any]] = [
    {"from": "player_1", "to": None, "text": "near"},
    {"from": "player_1", "to": None, "text": "far"},
    {"from": "player_0", "to": None, "text": "mine"},
    {"from": "player_1", "to": None, "text": "open"},
    {"from": "player_0", "to": "player_5", "text": "from controller"},
    {"from": "player_3", "to": "player_0", "text": "to controller"},
]
_WATCHER_EXPECTED: list[dict[str, Any]] = [
    {"from": "player_1", "to": None, "text": "near"},
    {"from": "player_1", "to": None, "text": "far"},
    {"from": "player_0", "to": None, "text": "mine"},
    {"from": "player_1", "to": None, "text": "open"},
    {"from": "player_3", "to": "player_5", "text": "npc chatter"},
    {"from": "player_0", "to": "player_5", "text": "from controller"},
    {"from": "player_3", "to": "player_0", "text": "to controller"},
]
_UNFILTERED_MESSAGES: list[dict[str, Any]] = [
    {"from": "player_1", "to": None, "text": "open"},
    {"from": "player_0", "to": "player_5", "text": "direct"},
]
_FILTERED_MESSAGES: list[dict[str, Any]] = [
    {"from": "player_1", "to": None, "text": "far", "recipients": ["player_2"]},
    {"from": "player_3", "to": "player_5", "text": "npc chatter"},
]


def _state_line(messages: list[dict[str, Any]]) -> str:
    return json.dumps(
        {
            "schema_version": 1,
            "tick": 3,
            "agents": {},
            "timing": {"started_at": 0, "duration_ms": 1},
            "messages": messages,
        },
        separators=(",", ":"),
    )


@pytest.mark.parametrize(
    ("controllers", "messages", "expected", "hidden", "exact"),
    [
        pytest.param(
            ("player_0",),
            _FULL_MESSAGES,
            _ONE_CONTROLLER_EXPECTED,
            ("far", "npc chatter"),
            False,
            id="one-controller",
        ),
        pytest.param(
            ("player_0", "player_2"),
            _FULL_MESSAGES,
            _TWO_CONTROLLERS_EXPECTED,
            ("npc chatter",),
            False,
            id="two-controllers",
        ),
        pytest.param(
            None,
            _FULL_MESSAGES,
            _WATCHER_EXPECTED,
            (),
            False,
            id="watcher",
        ),
        pytest.param(
            ("player_0",),
            _UNFILTERED_MESSAGES,
            _UNFILTERED_MESSAGES,
            (),
            True,
            id="unfiltered-bytes",
        ),
        pytest.param(
            ("player_0",),
            _FILTERED_MESSAGES,
            [],
            ("far", "npc chatter"),
            False,
            id="fully-filtered",
        ),
    ],
)
def test_local_server_filters_annotated_broadcasts_for_the_controller_and_strips_for_watchers(
    tmp_path: Path,
    controllers: tuple[str, ...] | None,
    messages: list[dict[str, Any]],
    expected: list[dict[str, Any]],
    hidden: tuple[str, ...],
    exact: bool,
) -> None:
    async def exercise() -> None:
        static_root = _static_root(tmp_path)
        state_line = _state_line(messages)
        child = (
            "import json\n"
            "import sys\n"
            f"print({_STATE_HEADER!r}, flush=True)\n"
            "for raw in sys.stdin:\n"
            '    if json.loads(raw).get("kind") == "resume":\n'
            f"        print({state_line!r}, flush=True)\n"
        )
        async with LocalServer(
            _entry(),
            command=[sys.executable, "-c", child],
            static_root=static_root,
            controller_players=controllers,
        ) as server:
            uri = f"ws://127.0.0.1:{server.port}/api/sessions/local/ws"
            async with websockets.connect(uri, close_timeout=1) as live:
                await _attach(live)
                await live.send('{"kind":"resume"}')
                assert json.loads(await _recv(live)) == {"kind": "resume"}
                live_state = await _recv(live)
            async with websockets.connect(uri, close_timeout=1) as late:
                replay = await _attach(late, state=True)

        assert live_state == replay["state"]
        assert "recipients" not in live_state
        presented = json.loads(live_state)
        assert presented.get("messages", []) == expected
        presented.pop("messages", None)
        assert presented == {
            "schema_version": 1,
            "tick": 3,
            "agents": {},
            "timing": {"started_at": 0, "duration_ms": 1},
        }
        for text in hidden:
            assert text not in live_state
        if exact:
            assert live_state == state_line

    asyncio.run(exercise())


@pytest.mark.parametrize("case", ["asset", "metadata", "unsupported", "traversal", "symlink"])
def test_local_server_http_routes_and_metadata_are_safe(tmp_path: Path, case: str) -> None:
    static_root = _static_root(tmp_path)
    (static_root / "app.js").write_text("console.log(1)", encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    if case == "symlink":
        try:
            os.symlink(outside, static_root / "escape.js")
        except (NotImplementedError, OSError):
            pytest.skip("symlink creation is unavailable on this platform")

    async def exercise() -> None:
        child = [sys.executable, "-c", "import sys; sys.stdin.read()"]
        async with LocalServer(_entry(), command=child, static_root=static_root) as server:
            assert server._server is not None  # noqa: SLF001 - loopback is a server boundary
            assert server._server.sockets[0].getsockname()[0] == "127.0.0.1"  # noqa: SLF001

            if case == "asset":
                status, headers, body = await _http(server.port, "GET", "/local.html")
                assert status == "HTTP/1.1 200 OK"
                assert headers["Content-Type"] == "text/html"
                assert headers["Content-Length"] == "5"
                assert headers["Cache-Control"] == "no-store"
                assert headers["Connection"] == "close"
                assert body == b"local"

                status, headers, body = await _http(server.port, "GET", "/app.js")
                assert status == "HTTP/1.1 200 OK"
                assert headers["Content-Type"] in {"text/javascript", "application/javascript"}
                assert headers["Content-Length"] == "14"
                assert headers["Cache-Control"] == "no-store"
                assert headers["Connection"] == "close"
                assert body == b"console.log(1)"

                head_status, head_headers, head_body = await _http(server.port, "HEAD", "/app.js")
                assert head_status == "HTTP/1.1 200 OK"
                assert head_headers["Content-Length"] == "14"
                assert head_body == b""

                missing_status, _missing_headers, missing_body = await _http(
                    server.port, "GET", "/missing.js"
                )
                assert missing_status == "HTTP/1.1 404 Not Found"
                assert missing_body == b""

            elif case == "metadata":
                status, headers, body = await _http(server.port, "GET", "/api/environments")
                assert status == "HTTP/1.1 200 OK"
                assert headers["Content-Type"] == "application/json"
                assert headers["Content-Length"] == str(len(body))
                assert headers["Cache-Control"] == "no-store"
                (metadata,) = json.loads(body)
                assert {
                    key: metadata[key] for key in ("env_id", "display_name", "human_players", "renderer")
                } == {
                    "env_id": "fake",
                    "display_name": "Fake",
                    "human_players": ["player_0"],
                    "renderer": "fake",
                }

                head_status, head_headers, head_body = await _http(server.port, "HEAD", "/api/environments")
                assert head_status == "HTTP/1.1 200 OK"
                assert head_headers["Content-Length"] == str(len(body))
                assert head_body == b""

            elif case == "unsupported":
                for method, path in (("POST", "/app.js"), ("DELETE", "/api/environments")):
                    status, headers, body = await _http(server.port, method, path)
                    assert status == "HTTP/1.1 405 Method Not Allowed"
                    assert headers["Allow"] == "GET, HEAD"
                    assert body == b""

            elif case == "traversal":
                for path in (
                    "/outside.txt",
                    "/%2e%2e/outside.txt",
                    "/..%2foutside.txt",
                    "/%2e%2e%5coutside.txt",
                ):
                    status, _headers, body = await _http(server.port, "GET", path)
                    assert status == "HTTP/1.1 404 Not Found"
                    assert body == b""
                    assert b"secret" not in body

            else:
                status, _headers, body = await _http(server.port, "GET", "/escape.js")
                assert status == "HTTP/1.1 404 Not Found"
                assert body == b""

    asyncio.run(exercise())


def test_local_server_ends_once_for_clean_and_failed_child_exit(tmp_path: Path) -> None:
    async def exercise() -> None:
        static_root = _static_root(tmp_path)
        for code, reason in ((0, "terminated"), (3, "error")):
            child = (
                "import sys\n"
                'print(\'{"schema_version":1,"environment":"fake"}\', flush=True)\n'
                "sys.stdin.readline()\n"
                f"raise SystemExit({code})\n"
            )
            async with LocalServer(
                _entry(),
                command=[sys.executable, "-c", child],
                static_root=static_root,
            ) as server:
                uri = f"ws://127.0.0.1:{server.port}/api/sessions/local/ws"
                async with websockets.connect(uri, close_timeout=1) as live:
                    await _attach(live)
                    await live.send('{"kind":"resume"}')
                    assert await _until_closed(live) == [
                        {"kind": "resume"},
                        {"kind": "session", "reason": reason, "status": "ended"},
                    ]
                await asyncio.wait_for(server.wait(), timeout=5)
                async with websockets.connect(uri, close_timeout=1) as late:
                    assert json.loads(await _recv(late)) == {"schema_version": 1, "environment": "fake"}
                    assert json.loads(await _recv(late)) == {
                        "kind": "session",
                        "reason": reason,
                        "status": "ended",
                    }

    asyncio.run(exercise())


def test_local_server_drains_runner_output_before_child_exit_fallback(tmp_path: Path) -> None:
    class DelayedOutputServer(LocalServer):
        async def _pump_output(self) -> None:
            # Force child exit before draining its buffered output.
            assert self._child is not None
            await self._child.wait()
            await super()._pump_output()

    async def exercise() -> None:
        static_root = _static_root(tmp_path)
        child = (
            'print(\'{"schema_version":1,"environment":"fake"}\', flush=True)\n'
            'print(\'{"schema_version":1,"tick":3,"agents":{},"timing":{}}\', flush=True)\n'
            'print(\'{"kind":"result","reason":"completed"}\', flush=True)\n'
        )
        async with DelayedOutputServer(
            _entry(), command=[sys.executable, "-c", child], static_root=static_root
        ) as server:
            await asyncio.wait_for(server.wait(), timeout=_SERVER_TIMEOUT)
            uri = f"ws://127.0.0.1:{server.port}/api/sessions/local/ws"
            async with websockets.connect(uri, close_timeout=1) as late:
                replay = [json.loads(await _recv(late)) for _ in range(3)]
                assert replay == [
                    {"schema_version": 1, "environment": "fake"},
                    {"schema_version": 1, "tick": 3, "agents": {}, "timing": {}},
                    {"kind": "session", "reason": "completed", "status": "ended"},
                ]

    asyncio.run(exercise())


def test_local_server_forwards_commands_and_orders_terminal_frames(tmp_path: Path) -> None:
    async def exercise() -> None:
        static_root = _static_root(tmp_path)
        child = (
            "import json\n"
            "import sys\n"
            'print(\'{"schema_version":1,"environment":"fake"}\', flush=True)\n'
            "for raw in sys.stdin:\n"
            "    command = json.loads(raw)\n"
            '    if command.get("kind") == "stop":\n'
            "        break\n"
            '    if command.get("kind") in ("chat", "input"):\n'
            '        print(json.dumps({"schema_version": 1, "tick": 0, "agents": {}, "timing": {}, '
            '"chat": command}), flush=True)\n'
            'print(\'{"kind":"result","reason":"stopped"}\', flush=True)\n'
        )
        async with LocalServer(
            _entry(), command=[sys.executable, "-c", child], static_root=static_root
        ) as server:
            uri = f"ws://127.0.0.1:{server.port}/api/sessions/local/ws"
            async with (
                websockets.connect(uri, close_timeout=1) as first,
                websockets.connect(uri, close_timeout=1) as second,
            ):
                first_initial = await _attach(first)
                second_initial = await _attach(second)
                assert first_initial == second_initial
                for kind in ("pause", "resume"):
                    await first.send(json.dumps({"kind": kind}))
                    for socket in (first, second):
                        assert json.loads(await _recv(socket)) == {"kind": kind}

                await first.send("not json")
                await first.send('{"kind":"input","player":1}')
                await first.send('{"kind":"chat","player":"player_0","to":null,"text":"hello"}')
                first_state, second_state = await _recv(first), await _recv(second)
                assert json.loads(first_state)["chat"] == {
                    "kind": "chat",
                    "player": "player_0",
                    "to": None,
                    "text": "hello",
                }
                assert first_state == second_state
                await first.send('{"kind":"stop"}')
                for socket in (first, second):
                    assert await _until_closed(socket) == [
                        {"kind": "result", "reason": "stopped"},
                        {"kind": "session", "reason": "stopped", "status": "ended"},
                    ]
            await asyncio.wait_for(server.wait(), timeout=5)

    asyncio.run(exercise())
