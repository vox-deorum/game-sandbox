"""Deterministic loopback bridge used by the local-play Playwright journey."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from contextlib import suppress
from pathlib import Path
from typing import Any

from game_sandbox_harness.environment import BuiltinAgent, EnvironmentEntry, EnvironmentMeta, PlayerBounds
from game_sandbox_harness.local_server import LocalServer

REPO_ROOT = Path(__file__).resolve().parents[2]
STATIC_ROOT = REPO_ROOT / "frontend" / "dist-local"

META = EnvironmentMeta(
    env_id="flappy_bird",
    display_name="Flappy Bird",
    description="A deterministic local browser test environment.",
    builtin_agents=(BuiltinAgent("naive", "Naive agent"),),
    layout=PlayerBounds(min=1, max=1),
    human_players=("player_0",),
    human_timeout_ms=None,
    recommended_episode_ticks=10,
    pace_interval_ms=50,
    step_limit_ms=1000,
    episode_limit_ms=120_000,
    messaging=False,
    message_cap=None,
    llm=False,
    renderer="flappy-bird",
)


def _unused_make() -> Any:
    raise AssertionError("the scripted bridge never constructs an environment")


ENTRY = EnvironmentEntry(
    meta=META,
    make=_unused_make,
    default_action=lambda _env, _player: 0,
    overlay=None,
)


def _state(tick: int, action: int | None = None) -> dict[str, Any]:
    """Build one stable Flappy frame, with an empty agent map before the first resume."""
    agents: dict[str, Any] = {}
    if tick > 0:
        agent: dict[str, Any] = {"reward": 0.0, "score": float(tick)}
        if action is not None:
            agent["action"] = action
        agents["player_0"] = agent
    return {
        "schema_version": 1,
        "tick": tick,
        "agents": agents,
        "overlay": {
            "player": {"x": 56.0, "y": 220.0 - tick, "vel_y": -2.0, "rot": -5.0},
            "pipes": [{"x": 210.0, "gap_top": 170.0, "gap_bottom": 290.0}],
            "pipes_passed": tick,
            "width": 288,
            "height": 512,
        },
        "timing": {"started_at": 1_700_000_000_000 + tick, "duration_ms": 1.0},
    }


def _write(value: dict[str, Any]) -> None:
    print(json.dumps(value, separators=(",", ":")), flush=True)


def run_scripted_runner() -> int:
    """Speak the live JSON-lines protocol while making every browser command observable."""
    _write(
        {
            "schema_version": 1,
            "environment": META.env_id,
            "parameters": {"players": 1},
            "seed": 0,
            "players": {"player_0": {"kind": "human", "label": "Local player"}},
            "seats": {"seat_0": ["player_0"]},
            "seat_plan": "solo",
        }
    )
    _write(_state(0))
    tick = 0
    for raw in sys.stdin:
        try:
            command = json.loads(raw)
        except json.JSONDecodeError:
            continue
        kind = command.get("kind")
        if kind == "resume" and tick == 0:
            tick = 1
            _write(_state(tick, 0))
        elif kind == "input":
            tick += 1
            _write(_state(tick, command.get("action")))
        elif kind == "stop":
            _write(
                {
                    "kind": "result",
                    "scores": {"player_0": float(tick)},
                    "ticks": tick,
                    "reason": "stopped",
                }
            )
            return 0
    return 0


async def serve(port: int) -> None:
    """Serve the built local bundle and scripted runner until Playwright stops the process."""
    command = [sys.executable, str(Path(__file__).resolve()), "--runner"]
    async with LocalServer(
        ENTRY,
        command=command,
        static_root=STATIC_ROOT,
        start_paused=True,
        port=port,
    ) as server:
        print(f"local e2e bridge: {server.url}", flush=True)
        await server.wait()
        # Keep the web-server process alive after the scripted terminal result. Playwright owns the
        # process lifetime and may still be running its backend journeys after this focused test.
        await asyncio.Event().wait()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8091)
    parser.add_argument("--runner", action="store_true")
    args = parser.parse_args(argv)
    if args.runner:
        return run_scripted_runner()
    with suppress(KeyboardInterrupt):
        asyncio.run(serve(args.port))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
