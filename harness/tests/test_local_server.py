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
                await asyncio.sleep(0.05)
                async with websockets.connect(
                    f"ws://127.0.0.1:{server.port}/api/sessions/local/ws"
                ) as socket:
                    frames = [await socket.recv() for _ in range(4)]
                assert frames[0].startswith('{"schema_version":1')
                assert frames[2] == '{"kind":"session","status":"running"}'
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
        assert frames[1] == '{"kind":"session","status":"running"}'
        assert frames[2] == '{"kind":"pause"}'

    asyncio.run(exercise())


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
                "import sys\n"
                'print(\'{\\"schema_version\\":1,\\"environment\\":\\"fake\\"}\', flush=True)\n'
                "for raw in sys.stdin:\n"
                '    if raw.strip() == \'{\\"kind\\":\\"stop\\"}\':\n'
                "        break\n"
                "    print(raw.strip(), flush=True)\n"
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
                    assert first_frames[1] == '{"kind":"session","status":"running"}'
                    await first.send('{"kind":"pause"}')
                    assert await first.recv() == '{"kind":"pause"}'
                    assert await second.recv() == '{"kind":"pause"}'
                    await first.send('{"kind":"resume"}')
                    assert await first.recv() == '{"kind":"resume"}'
                    await first.send('{"kind":"stop"}')
                    terminal = [await first.recv(), await first.recv()]
                    assert terminal[0] == '{"kind":"result","reason":"stopped"}'
                    assert terminal[1] == '{"kind":"session","status":"ended","reason":"stopped"}'
                await server.wait()

    asyncio.run(exercise())
