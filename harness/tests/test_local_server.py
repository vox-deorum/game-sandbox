"""Focused safety and lifecycle coverage for the loopback local relay."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
import websockets
from support_parallel import make_entry as make_parallel_entry

from game_sandbox_harness.environment import (
    BuiltinAgent,
    EnvironmentEntry,
    EnvironmentMeta,
    PlayerBounds,
    load_environment,
)
from game_sandbox_harness.local_server import LocalServer


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


async def _http(port: int, method: str, path: str) -> tuple[str, dict[str, str], bytes]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(f"{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".encode())
    await writer.drain()
    raw = await reader.read()
    writer.close()
    await writer.wait_closed()
    if b"\r\n\r\n" not in raw:
        return raw.decode(), {}, b""
    head, body = raw.split(b"\r\n\r\n", 1)
    lines = head.decode().split("\r\n")
    headers = dict(line.split(": ", 1) for line in lines[1:] if ": " in line)
    return lines[0], headers, body


def test_local_server_replays_paused_attach_state_and_rejects_traversal() -> None:
    async def exercise() -> None:
        with TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "local.html").write_text("local", encoding="utf-8")
            child = (
                "import time; "
                'print(\'{\\"schema_version\\":1,\\"environment\\":\\"fake\\"}\', flush=True); '
                'print(\'{\\"schema_version\\":1,\\"tick\\":0,\\"agents\\":{},\\"timing\\":{}}\', flush=True); '  # noqa: E501
                "time.sleep(1)"
            )
            async with LocalServer(
                _entry(), command=[sys.executable, "-c", child], static_root=root, start_paused=True
            ) as server:
                assert server._server is not None  # noqa: SLF001 - loopback is a server boundary
                assert server._server.sockets[0].getsockname()[0] == "127.0.0.1"  # noqa: SLF001
                # Attach only once the server has both lines from the child. A socket that connects
                # first is served by the live broadcast instead, which sends the same frames in a
                # different order, so waiting on a fixed delay makes this assertion a race.
                for _ in range(500):
                    if server._header is not None and server._latest_state is not None:  # noqa: SLF001
                        break
                    await asyncio.sleep(0.01)
                assert server._latest_state is not None  # noqa: SLF001 - the state attach replays
                async with websockets.connect(
                    f"ws://127.0.0.1:{server.port}/api/sessions/local/ws"
                ) as socket:
                    frames = [await socket.recv() for _ in range(4)]
                assert frames[0].startswith('{"schema_version":1')
                assert frames[2] == '{"awaiting_start":true,"kind":"session","status":"running"}'
                assert frames[3] == '{"kind":"pause"}'
                assert server._asset("/%2e%2e/secret") is None  # noqa: SLF001 - safety boundary

    asyncio.run(exercise())


def test_local_server_receives_real_paused_runner_header_before_any_command(tmp_path: Path) -> None:
    """A paused local runner announces itself before the browser writes to stdin.

    Windows can block the child main thread when its stdin reader starts too early. This real
    subprocess regression keeps the socket idle until the header, running status, and pause event
    are all received.
    """
    pytest.importorskip("flappy_bird", reason="environments package not installed")

    async def exercise() -> None:
        (tmp_path / "local.html").write_text("local", encoding="utf-8")
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
            static_root=tmp_path,
            start_paused=True,
        ) as server:
            uri = f"ws://127.0.0.1:{server.port}/api/sessions/local/ws"
            async with websockets.connect(uri) as socket:
                frames = [await asyncio.wait_for(socket.recv(), timeout=5) for _ in range(3)]

        assert json.loads(frames[0])["environment"] == "flappy_bird"
        assert frames[1] == '{"awaiting_start":true,"kind":"session","status":"running"}'
        assert frames[2] == '{"kind":"pause"}'

    asyncio.run(exercise())


def test_local_server_consumes_start_gate_and_replays_later_pause_on_attach() -> None:
    async def exercise() -> None:
        with TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "local.html").write_text("local", encoding="utf-8")
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
                '        print(json.dumps({"schema_version": 1, "tick": 1, "agents": {}, '
                '"received": command}), flush=True)\n'
            )
            async with LocalServer(
                _entry(),
                command=[sys.executable, "-c", child],
                static_root=root,
                start_paused=True,
            ) as server:
                for _ in range(500):
                    if server._header is not None and server._latest_state is not None:  # noqa: SLF001
                        break
                    await asyncio.sleep(0.01)
                uri = f"ws://127.0.0.1:{server.port}/api/sessions/local/ws"
                async with websockets.connect(uri) as first:
                    initial = [await asyncio.wait_for(first.recv(), timeout=5) for _ in range(4)]
                    assert json.loads(initial[2]) == {
                        "kind": "session",
                        "status": "running",
                        "awaiting_start": True,
                    }
                    assert initial[3] == '{"kind":"pause"}'

                    await first.send('{"kind":"input","player":"player_0","action":1}')
                    await first.send('{"kind":"chat","player":"player_0","to":null,"text":"hello"}')
                    await first.send('{"kind":"clock","player":"player_0","running":true}')
                    with pytest.raises(TimeoutError):
                        await asyncio.wait_for(first.recv(), timeout=0.1)

                    await first.send('{"kind":"resume"}')
                    assert await asyncio.wait_for(first.recv(), timeout=5) == '{"kind":"resume"}'
                    await first.send('{"kind":"input","player":"player_0","action":1}')
                    forwarded = json.loads(await asyncio.wait_for(first.recv(), timeout=5))
                    assert forwarded["received"] == {
                        "kind": "input",
                        "player": "player_0",
                        "action": 1,
                    }
                    await first.send('{"kind":"pause"}')
                    assert await asyncio.wait_for(first.recv(), timeout=5) == '{"kind":"pause"}'

                async with websockets.connect(uri) as second:
                    replay = [await asyncio.wait_for(second.recv(), timeout=5) for _ in range(4)]
                    assert json.loads(replay[2]) == {
                        "kind": "session",
                        "status": "running",
                        "awaiting_start": False,
                    }
                    assert replay[3] == '{"kind":"pause"}'
                    await second.send('{"kind":"stop"}')
                    assert json.loads(await asyncio.wait_for(second.recv(), timeout=5))["kind"] == "result"
                    assert json.loads(await asyncio.wait_for(second.recv(), timeout=5))["status"] == "ended"

    asyncio.run(exercise())


def test_local_server_runs_the_injected_parallel_fixture_through_the_live_runner(
    tmp_path: Path,
) -> None:
    async def exercise() -> None:
        (tmp_path / "local.html").write_text("local", encoding="utf-8")
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
            static_root=tmp_path,
            start_paused=True,
        ) as server:
            uri = f"ws://127.0.0.1:{server.port}/api/sessions/local/ws"
            async with websockets.connect(uri) as socket:
                initial = [await asyncio.wait_for(socket.recv(), timeout=5) for _ in range(4)]
                assert json.loads(initial[0])["environment"] == "three_player_parallel_test"
                assert initial[1] == '{"awaiting_start":true,"kind":"session","status":"running"}'
                assert initial[2] == '{"kind":"pause"}'
                assert json.loads(initial[3])["agents"] == {}

                await socket.send('{"kind":"resume"}')
                assert await asyncio.wait_for(socket.recv(), timeout=5) == '{"kind":"resume"}'
                states = [json.loads(await asyncio.wait_for(socket.recv(), timeout=5)) for _ in range(3)]
                assert [list(state["agents"]) for state in states] == [
                    ["player_0", "player_1", "player_2"],
                    ["player_1", "player_2"],
                    ["player_2"],
                ]
                result = json.loads(await asyncio.wait_for(socket.recv(), timeout=5))
                ended = json.loads(await asyncio.wait_for(socket.recv(), timeout=5))
                assert result["kind"] == "result"
                assert result["ticks"] == 3
                assert ended == {
                    "kind": "session",
                    "status": "ended",
                    "reason": "truncated",
                }
            await asyncio.wait_for(server.wait(), timeout=5)

        recording = recording_dir / "parallel-local" / "recording.jsonl"
        lines = [json.loads(line) for line in recording.read_text(encoding="utf-8").splitlines()]
        assert len(lines) == 4
        assert all("kind" not in line for line in lines)

    asyncio.run(exercise())


def test_local_server_filters_annotated_broadcasts_for_the_controller_and_strips_for_watchers() -> None:
    # A human-mode relay (controller players named) keeps a bounded broadcast only when a controlled
    # player sent or heard it; a watch-style relay keeps every line. Both strip the live-only
    # `recipients` annotation, and the stashed catch-up line a late socket receives is the same view.
    header_line = '{"schema_version":1,"environment":"fake"}'
    state = {
        "schema_version": 1,
        "tick": 0,
        "agents": {},
        "timing": {"started_at": 0, "duration_ms": 1},
        "messages": [
            {"from": "player_1", "to": None, "text": "near", "recipients": ["player_0"]},
            {"from": "player_1", "to": None, "text": "far", "recipients": ["player_2"]},
            {"from": "player_0", "to": None, "text": "mine", "recipients": ["player_2"]},
            {"from": "player_1", "to": None, "text": "open"},
        ],
    }
    state_line = json.dumps(state, separators=(",", ":"))
    child = (
        f"import time; print({header_line!r}, flush=True); print({state_line!r}, flush=True); time.sleep(1)"
    )

    async def state_seen(controller_players: tuple[str, ...] | None) -> dict:
        with TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "local.html").write_text("local", encoding="utf-8")
            async with LocalServer(
                _entry(),
                command=[sys.executable, "-c", child],
                static_root=root,
                controller_players=controller_players,
            ) as server:
                for _ in range(500):
                    if server._latest_state is not None:  # noqa: SLF001 - the attach replays it
                        break
                    await asyncio.sleep(0.01)
                assert server._latest_state is not None  # noqa: SLF001
                async with websockets.connect(
                    f"ws://127.0.0.1:{server.port}/api/sessions/local/ws"
                ) as socket:
                    frames = [str(await socket.recv()) for _ in range(2)]
        return json.loads(frames[1])

    async def exercise() -> None:
        controller_state = await state_seen(("player_0",))
        assert controller_state["messages"] == [
            {"from": "player_1", "to": None, "text": "near"},
            {"from": "player_0", "to": None, "text": "mine"},
            {"from": "player_1", "to": None, "text": "open"},
        ]
        watcher_state = await state_seen(None)
        assert watcher_state["messages"] == [
            {"from": "player_1", "to": None, "text": "near"},
            {"from": "player_1", "to": None, "text": "far"},
            {"from": "player_0", "to": None, "text": "mine"},
            {"from": "player_1", "to": None, "text": "open"},
        ]

    asyncio.run(exercise())


def _unstarted_server(controller_players: tuple[str, ...] | None) -> LocalServer:
    # `_present_state` and `__init__` never touch the filesystem or spawn the child, so a server
    # built this way is safe to exercise without starting it.
    return LocalServer(
        _entry(),
        command=[sys.executable, "-c", "pass"],
        static_root=Path("."),
        controller_players=controller_players,
    )


def test_present_state_returns_the_identical_string_for_an_unfiltered_line() -> None:
    # A line with nothing to filter and nothing to strip is handed back as the same string object,
    # pinning the passthrough fast path the docstring promises.
    state = {
        "schema_version": 1,
        "tick": 0,
        "agents": {},
        "timing": {"started_at": 0, "duration_ms": 1},
        "messages": [{"from": "player_1", "to": None, "text": "open"}],
    }
    line = json.dumps(state, separators=(",", ":"))
    server = _unstarted_server(("player_0",))
    assert server._present_state(line, state) is line  # noqa: SLF001


def test_present_state_filters_targeted_messages_for_the_controller_and_keeps_them_for_watchers() -> None:
    # A targeted line between two players neither controlled is invisible to the human-mode
    # controller, matching the backend's own audience rule, but stays visible to a watch-style
    # viewer. A targeted line to or from the controller stays visible either way.
    state = {
        "schema_version": 1,
        "tick": 0,
        "agents": {},
        "timing": {"started_at": 0, "duration_ms": 1},
        "messages": [
            {"from": "player_3", "to": "player_5", "text": "npc chatter"},
            {"from": "player_0", "to": "player_5", "text": "from controller"},
            {"from": "player_3", "to": "player_0", "text": "to controller"},
        ],
    }
    line = json.dumps(state, separators=(",", ":"))

    controller_view = json.loads(_unstarted_server(("player_0",))._present_state(line, state))  # noqa: SLF001
    assert controller_view["messages"] == [
        {"from": "player_0", "to": "player_5", "text": "from controller"},
        {"from": "player_3", "to": "player_0", "text": "to controller"},
    ]

    assert _unstarted_server(None)._present_state(line, state) is line  # noqa: SLF001


def test_present_state_omits_the_messages_key_when_every_message_is_filtered() -> None:
    # Once the controller filter empties the messages list, "messages" itself must be absent rather
    # than present as an empty list, matching the recording format and the backend's own filter.
    state = {
        "schema_version": 1,
        "tick": 0,
        "agents": {},
        "timing": {"started_at": 0, "duration_ms": 1},
        "messages": [{"from": "player_3", "to": "player_5", "text": "npc chatter"}],
    }
    line = json.dumps(state, separators=(",", ":"))
    presented = json.loads(_unstarted_server(("player_0",))._present_state(line, state))  # noqa: SLF001
    assert "messages" not in presented


def test_local_server_http_routes_and_metadata_are_safe() -> None:
    async def exercise() -> None:
        with TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "local.html").write_text("local", encoding="utf-8")
            (root / "app.js").write_text("console.log(1)", encoding="utf-8")
            outside = root.parent / "outside-local-server-test.txt"
            outside.write_text("secret", encoding="utf-8")
            link = root / "escape.js"
            try:
                os.symlink(outside, link)
            except OSError:
                link = root / "missing-link.js"
            child = [sys.executable, "-c", "import time; time.sleep(1)"]
            async with LocalServer(_entry(), command=child, static_root=root) as server:
                status, headers, body = await _http(server.port, "GET", "/app.js")
                assert status.startswith("HTTP/1.1 200")
                assert headers["Content-Type"].startswith(("text/javascript", "application/javascript"))
                assert headers["Content-Length"] == str(len(body))
                assert headers["Cache-Control"] == "no-store"

                head_status, head_headers, head_body = await _http(server.port, "HEAD", "/app.js")
                assert head_status.startswith("HTTP/1.1 200")
                assert head_headers["Content-Length"] == str(len(body))
                assert head_body == b""

                get_status, get_headers, get_body = await _http(server.port, "GET", "/api/environments")
                assert get_status.startswith("HTTP/1.1 200")
                assert get_headers["Content-Length"] == str(len(get_body))
                assert json.loads(get_body) == [_entry().meta.to_json()]

                env_head_status, env_head_headers, env_head_body = await _http(
                    server.port, "HEAD", "/api/environments"
                )
                assert env_head_status.startswith("HTTP/1.1 200")
                assert env_head_headers["Content-Length"] == str(len(get_body))
                assert env_head_body == b""

                for method, path in (("POST", "/app.js"), ("GET", "/%2e%2e/secret"), ("GET", "/escape.js")):
                    rejected, _headers, _body = await _http(server.port, method, path)
                    assert not rejected.startswith("HTTP/1.1 200")
            outside.unlink(missing_ok=True)

    asyncio.run(exercise())


def test_local_server_ends_once_for_clean_and_failed_child_exit() -> None:
    async def exercise() -> None:
        with TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "local.html").write_text("local", encoding="utf-8")
            for code, reason in ((0, "terminated"), (3, "error")):
                async with LocalServer(
                    _entry(),
                    command=[sys.executable, "-c", f"import sys; sys.exit({code})"],
                    static_root=root,
                ) as server:
                    await asyncio.wait_for(server.wait(), timeout=1)
                    assert server._ended  # noqa: SLF001 - exactly-once lifecycle state
                    assert server._status == "ended"  # noqa: SLF001
                    assert server._end_reason == reason  # noqa: SLF001

    asyncio.run(exercise())


def test_local_server_drains_runner_output_before_child_exit_fallback() -> None:
    class DelayedOutputServer(LocalServer):
        async def _pump_output(self) -> None:
            await asyncio.sleep(0.05)
            await super()._pump_output()

    async def exercise() -> None:
        with TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "local.html").write_text("local", encoding="utf-8")
            child = (
                'print(\'{"schema_version":1,"environment":"fake"}\', flush=True); '
                'print(\'{"schema_version":1,"tick":3,"agents":{},"timing":{}}\', flush=True); '
                'print(\'{"kind":"result","reason":"completed"}\', flush=True)'
            )
            async with DelayedOutputServer(
                _entry(), command=[sys.executable, "-c", child], static_root=root
            ) as server:
                await asyncio.wait_for(server.wait(), timeout=1)
                assert server._header is not None  # noqa: SLF001 - output-drain lifecycle boundary
                assert server._latest_state is not None  # noqa: SLF001
                assert server._end_reason == "completed"  # noqa: SLF001

    asyncio.run(exercise())


def test_local_server_forwards_commands_and_orders_terminal_frames() -> None:
    async def exercise() -> None:
        with TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "local.html").write_text("local", encoding="utf-8")
            child = (
                "import json\n"
                "import sys\n"
                'print(\'{\\"schema_version\\":1,\\"environment\\":\\"fake\\"}\', flush=True)\n'
                "for raw in sys.stdin:\n"
                '    if raw.strip() == \'{\\"kind\\":\\"stop\\"}\':\n'
                "        break\n"
                '    if json.loads(raw).get("kind") == "chat":\n'
                '        message = {"schema_version": 1, "tick": 0, "agents": {},\n'
                '                   "chat": json.loads(raw)}\n'
                "        print(json.dumps(message), flush=True)\n"
                'print(\'{\\"kind\\":\\"result\\",\\"reason\\":\\"stopped\\"}\', flush=True)\n'
            )
            async with LocalServer(
                _entry(), command=[sys.executable, "-c", child], static_root=root
            ) as server:
                await asyncio.sleep(0.05)
                uri = f"ws://127.0.0.1:{server.port}/api/sessions/local/ws"
                async with websockets.connect(uri) as first, websockets.connect(uri) as second:
                    first_frames = [await first.recv() for _ in range(2)]
                    second_frames = [await second.recv() for _ in range(2)]
                    assert first_frames == second_frames
                    assert first_frames[0].startswith('{"schema_version":1')
                    assert first_frames[1] == '{"awaiting_start":false,"kind":"session","status":"running"}'
                    await first.send('{"kind":"pause"}')
                    assert await first.recv() == '{"kind":"pause"}'
                    assert await second.recv() == '{"kind":"pause"}'
                    await first.send('{"kind":"resume"}')
                    assert await first.recv() == '{"kind":"resume"}'
                    await first.send('{"kind":"chat","player":"player_0","to":null,"text":"hello"}')
                    forwarded = json.loads(await first.recv())
                    assert forwarded["chat"] == {
                        "kind": "chat",
                        "player": "player_0",
                        "to": None,
                        "text": "hello",
                    }
                    await first.send('{"kind":"stop"}')
                    terminal = [await first.recv(), await first.recv()]
                    assert terminal[0] == '{"kind":"result","reason":"stopped"}'
                    assert terminal[1] == '{"kind":"session","reason":"stopped","status":"ended"}'
                await server.wait()

    asyncio.run(exercise())
