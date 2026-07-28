"""Launch a registered environment through the production local browser protocol."""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
import webbrowser
from collections.abc import Mapping
from pathlib import Path
from tempfile import TemporaryDirectory

from _paths import FRONTEND_LOCAL_DIST_DIR, REPO_ROOT
from game_sandbox_harness import canonical_player_order
from game_sandbox_harness.environment import (
    EnvironmentEntry,
    EnvironmentLookupError,
    EnvParameter,
    ParameterValue,
    ResolvedLayout,
    effective_parameters,
    load_environment,
    resolve_layout,
    resolve_parameters,
)
from game_sandbox_harness.live import UNSET_TIMEOUT, UnsetTimeout
from game_sandbox_harness.local_server import LocalServer

MODES = ("human", "agent", "watch")
NPM_COMMAND = "npm.cmd" if sys.platform == "win32" else "npm"
BUILTIN_AGENT_ROOT = REPO_ROOT / "backend" / "images" / "session-base" / "deps-v1" / "builtin"


def default_layout(
    entry: EnvironmentEntry,
    parameters: Mapping[str, ParameterValue] | None = None,
) -> ResolvedLayout:
    """Resolve the environment's assignment layout, using defaults when values are omitted."""
    values = resolve_parameters(entry.meta) if parameters is None else parameters
    return resolve_layout(entry.meta, values)


def possible_players(
    entry: EnvironmentEntry,
    parameters: Mapping[str, ParameterValue] | None = None,
) -> tuple[str, ...]:
    """Return the player ids in the resolved layout without constructing an environment."""
    layout = default_layout(entry, parameters)
    players = (player for seat in layout.seats for player in seat.players)
    return canonical_player_order(players)


def player_for_seat(
    entry: EnvironmentEntry,
    seat: int,
    parameters: Mapping[str, ParameterValue] | None = None,
) -> str:
    """Return the first human-capable player in a resolved seat."""
    players = default_layout(entry, parameters).seats[seat].players
    human_players = frozenset(entry.meta.human_players)
    try:
        return next(player for player in players if player in human_players)
    except StopIteration:
        raise RuntimeError(f"seat {seat} is not human-playable in {entry.meta.env_id!r}") from None


def _parse_parameter_value(declaration: EnvParameter, raw: str) -> ParameterValue:
    """Parse one CLI value into the JSON-shaped type its declaration validates."""
    if declaration.type in {"string", "choice"}:
        value: object = raw
    else:
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ValueError(
                f"--parameter {declaration.name} needs a valid {declaration.type} value"
            ) from error
    return declaration.validate_value(value)


def resolve_cli_parameters(entry: EnvironmentEntry, raw_parameters: list[str]) -> dict[str, ParameterValue]:
    """Apply repeatable ``NAME=VALUE`` CLI overrides through the environment declarations."""
    declarations = {declaration.name: declaration for declaration in effective_parameters(entry.meta)}
    overrides: dict[str, ParameterValue] = {}
    for raw in raw_parameters:
        name, separator, value = raw.partition("=")
        if not separator or not name:
            raise ValueError("--parameter must use NAME=VALUE")
        declaration = declarations.get(name)
        if declaration is None:
            raise ValueError(f"unknown environment parameter {name!r}")
        overrides[name] = _parse_parameter_value(declaration, value)
    return resolve_parameters(entry.meta, overrides)


def builtin_agent_path(env_id: str, name: str = "naive") -> str:
    """Return the host copy of one named production builtin."""
    path = BUILTIN_AGENT_ROOT / env_id / name
    if not path.is_dir():
        raise RuntimeError(f"no built-in agent {name!r} for {env_id!r} at {path}")
    return str(path)


def builtin_agent_label(entry: EnvironmentEntry, name: str = "naive") -> str:
    """Return a builtin's snapshotted display label from installed metadata."""
    for agent in entry.meta.builtin_agents:
        if agent.name == name:
            return agent.label
    raise RuntimeError(f"environment {entry.meta.env_id!r} does not declare built-in agent {name!r}")


def local_config(
    entry: EnvironmentEntry,
    *,
    mode: str,
    seat: int,
    seed: int,
    max_steps: int | None,
    human_timeout_ms: int | None | UnsetTimeout = UNSET_TIMEOUT,
    agent_repo: Path | None = None,
    companion: str | None = None,
    parameters: Mapping[str, ParameterValue] | None = None,
    recording_dir: Path,
) -> dict[str, object]:
    """Build the complete live-runner config for one browser session."""
    resolved_parameters = resolve_parameters(entry.meta) if parameters is None else dict(parameters)
    layout = default_layout(entry, resolved_parameters)
    player_ids = possible_players(entry, resolved_parameters)
    selected_players = layout.seats[seat].players
    human_player = player_for_seat(entry, seat, resolved_parameters) if mode == "human" else None
    if mode == "human" and len(selected_players) > 1 and companion is None:
        raise RuntimeError("a wide human seat requires --companion naive or a local agent manifest path")
    if companion is not None and (mode != "human" or len(selected_players) == 1):
        raise RuntimeError("--companion is only valid for a wide human seat")
    companion_path: str | None = None
    companion_builtin = False
    if companion is not None:
        if companion == "naive":
            companion_path = builtin_agent_path(entry.meta.env_id, "naive")
            companion_builtin = True
        else:
            supplied = Path(companion)
            repo = supplied.parent if supplied.name == "manifest.json" else supplied
            if not (repo / "manifest.json").is_file():
                raise RuntimeError(f"companion agent has no manifest.json at {repo}")
            companion_path = str(repo)
    bindings: dict[str, dict[str, str]] = {}
    players: dict[str, dict[str, str]] = {}
    for player_id in player_ids:
        if player_id == human_player:
            bindings[player_id] = {"kind": "external"}
            players[player_id] = {"kind": "human", "label": "You"}
            continue
        is_companion = mode == "human" and player_id in selected_players and player_id != human_player
        if is_companion:
            path = companion_path
            label = builtin_agent_label(entry, "naive") if companion_builtin else "Companion"
            attribution = (
                {"kind": "agent", "builtin_name": "naive", "label": label}
                if companion_builtin
                else {"kind": "agent", "submission_id": "local", "label": label}
            )
        elif mode == "agent":
            path, label = str(agent_repo), "Selected agent"
            attribution = {"kind": "agent", "submission_id": "local", "label": label}
        else:
            path, label = builtin_agent_path(entry.meta.env_id, "naive"), builtin_agent_label(entry, "naive")
            attribution = {"kind": "agent", "builtin_name": "naive", "label": label}
        assert path is not None
        binding = {"kind": "builtin-agent", "path": path}
        if "builtin_name" in attribution:
            binding["name"] = "naive"
        bindings[player_id] = binding
        players[player_id] = attribution
    config: dict[str, object] = {
        "env_id": entry.meta.env_id,
        "parameters": resolved_parameters,
        "seed": seed,
        "player_bindings": bindings,
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
    """Rebuild and return the local frontend bundle."""
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
    parser.add_argument(
        "--companion",
        help="wide-seat companion: naive, a manifest.json path, or its repository directory",
    )
    parser.add_argument(
        "--parameter",
        action="append",
        default=[],
        metavar="NAME=VALUE",
        help="typed environment parameter override; repeat for several values",
    )
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
    try:
        parameters = resolve_cli_parameters(entry, args.parameter)
        layout = default_layout(entry, parameters)
    except ValueError as error:
        parser.error(str(error))
    if not 0 <= args.seat < len(layout.seats):
        parser.error(f"--seat must name one of 0..{len(layout.seats) - 1}")

    timeout: int | None | UnsetTimeout
    if args.no_human_timeout:
        timeout = None
    elif args.human_timeout_ms is not None:
        timeout = args.human_timeout_ms
    else:
        timeout = UNSET_TIMEOUT
    with TemporaryDirectory(prefix="game-sandbox-local-") as scratch:
        try:
            config = local_config(
                entry,
                mode=mode,
                seat=args.seat,
                seed=args.seed,
                max_steps=args.steps,
                human_timeout_ms=timeout,
                agent_repo=args.agent_repo,
                companion=args.companion,
                parameters=parameters,
                recording_dir=Path(scratch),
            )
        except RuntimeError as error:
            parser.error(str(error))
        return launch_browser(entry, config, port=args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    raise SystemExit(main())
