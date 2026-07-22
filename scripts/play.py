"""Launch a registered environment through the production local browser protocol."""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
import webbrowser
from pathlib import Path
from tempfile import TemporaryDirectory

from _paths import FRONTEND_LOCAL_DIST_DIR, REPO_ROOT
from game_sandbox_harness.environment import EnvironmentEntry, EnvironmentLookupError, load_environment
from game_sandbox_harness.live import UNSET_TIMEOUT, UnsetTimeout
from game_sandbox_harness.local_server import LocalServer

MODES = ("human", "agent", "watch")
NPM_COMMAND = "npm.cmd" if sys.platform == "win32" else "npm"
BUILTIN_AGENT_ROOT = REPO_ROOT / "backend" / "images" / "session-base" / "deps-v1" / "builtin"


def possible_slots(entry: EnvironmentEntry) -> tuple[str, ...]:
    """Return every possible slot from a fresh environment, not only the human-capable ones."""
    env = entry.make()
    try:
        return tuple(env.possible_agents)
    finally:
        env.close()


def builtin_agent_path(env_id: str) -> str:
    """Return the host copy of the environment-specific production baseline."""
    path = BUILTIN_AGENT_ROOT / env_id
    if not path.is_dir():
        raise RuntimeError(f"no built-in baseline for {env_id!r} at {path}")
    return str(path)


def local_config(
    entry: EnvironmentEntry,
    *,
    mode: str,
    seat: int,
    seed: int,
    max_steps: int | None,
    human_timeout_ms: int | None | UnsetTimeout = UNSET_TIMEOUT,
    agent_repo: Path | None = None,
    recording_dir: Path,
) -> dict[str, object]:
    """Build the complete live-runner config for one browser session."""
    slots = possible_slots(entry)
    human_slot = slots[seat] if mode == "human" else None
    bindings: dict[str, dict[str, str]] = {}
    players: dict[str, dict[str, str]] = {}
    for slot_id in slots:
        if slot_id == human_slot:
            bindings[slot_id] = {"kind": "external"}
            players[slot_id] = {"kind": "human", "label": "You"}
            continue
        path = str(agent_repo) if mode == "agent" else builtin_agent_path(entry.meta.env_id)
        bindings[slot_id] = {"kind": "builtin-agent", "path": path}
        players[slot_id] = {
            "kind": "agent",
            "label": "Selected agent" if mode == "agent" else "Built-in baseline",
        }
    config: dict[str, object] = {
        "env_id": entry.meta.env_id,
        "seed": seed,
        "slots": bindings,
        "players": players,
        "recording_dir": str(recording_dir),
        "recording_id": "local",
        "llm": None,
        "start_paused": True,
    }
    if max_steps is not None:
        config["max_steps"] = max_steps
    if human_timeout_ms is not UNSET_TIMEOUT:
        config["human_timeout_ms"] = human_timeout_ms
    return config


def ensure_local_bundle() -> Path:
    """Return the local frontend bundle, building it only when it is absent."""
    if (FRONTEND_LOCAL_DIST_DIR / "local.html").is_file():
        return FRONTEND_LOCAL_DIST_DIR
    subprocess.run([NPM_COMMAND, "run", "build:local"], cwd=REPO_ROOT / "frontend", check=True)
    if not (FRONTEND_LOCAL_DIST_DIR / "local.html").is_file():
        raise RuntimeError("local frontend build did not produce dist-local/local.html")
    return FRONTEND_LOCAL_DIST_DIR


def launch_browser(
    entry: EnvironmentEntry,
    config: dict[str, object],
    *,
    port: int,
    open_browser: bool,
    static_root: Path | None = None,
) -> int:
    """Run the local relay until its live runner finishes."""
    command = [
        sys.executable,
        "-m",
        "game_sandbox_harness.live",
        json.dumps(config, separators=(",", ":")),
    ]

    async def serve() -> None:
        async with LocalServer(
            entry,
            command=command,
            static_root=static_root or ensure_local_bundle(),
            start_paused=True,
            port=port,
        ) as server:
            print(f"local play: {server.url}", flush=True)
            if open_browser:
                webbrowser.open(server.url)
            await server.wait()

    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        return 0
    return 0


def build_parser() -> argparse.ArgumentParser:
    """Build the maintainer launcher CLI."""
    parser = argparse.ArgumentParser(description="Play a registered environment in a local browser.")
    parser.add_argument("env_id", help="registered environment id, for example hearts")
    parser.add_argument("mode", nargs="?", choices=MODES, default=None)
    parser.add_argument("--agent-repo", type=Path, help="manifest.json agent repository for agent mode")
    parser.add_argument("--seat", type=int, default=0, help="human seat index")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--steps", type=int, help="positive local episode step cap")
    parser.add_argument("--port", type=int, default=0, help="loopback port, or 0 for an available port")
    parser.add_argument("--no-browser", action="store_true", help="serve without opening a browser")
    timeout = parser.add_mutually_exclusive_group()
    timeout.add_argument("--human-timeout-ms", type=int, help="override the human turn timeout")
    timeout.add_argument("--no-human-timeout", action="store_true", help="disable the human turn timeout")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        entry = load_environment(args.env_id)
    except EnvironmentLookupError as error:
        parser.error(str(error))

    if args.agent_repo is not None and args.mode not in (None, "agent"):
        parser.error("--agent-repo PATH requires agent mode, so omit mode or pass 'agent'")
    mode = "agent" if args.agent_repo is not None else args.mode or "human"
    if mode == "agent" and args.agent_repo is None:
        parser.error("agent mode requires --agent-repo PATH")
    if args.steps is not None and args.steps <= 0:
        parser.error("--steps must be positive")
    if args.human_timeout_ms is not None and args.human_timeout_ms <= 0:
        parser.error("--human-timeout-ms must be positive")
    slots = possible_slots(entry)
    if not 0 <= args.seat < len(slots):
        parser.error(f"--seat must name one of 0..{len(slots) - 1}")
    if mode == "human" and slots[args.seat] not in entry.meta.human_slots:
        parser.error(f"seat {args.seat} is not human-playable in {entry.meta.env_id!r}")

    timeout: int | None | UnsetTimeout
    if args.no_human_timeout:
        timeout = None
    elif args.human_timeout_ms is not None:
        timeout = args.human_timeout_ms
    else:
        timeout = UNSET_TIMEOUT
    with TemporaryDirectory(prefix="game-sandbox-local-") as scratch:
        config = local_config(
            entry,
            mode=mode,
            seat=args.seat,
            seed=args.seed,
            max_steps=args.steps,
            human_timeout_ms=timeout,
            agent_repo=args.agent_repo,
            recording_dir=Path(scratch),
        )
        return launch_browser(entry, config, port=args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    raise SystemExit(main())
