"""Run one local browser session through the same live runner used by production.

``python -m sandbox.play`` opens local browser play. The selected seat is human by default; the
other seats run the repository's agent through explicit harness bindings. ``--headless`` is a small
test and evaluation escape hatch that drives the same ``Episode`` and default-action paths without a
relay or browser.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import webbrowser
from collections.abc import Mapping
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from sandbox.env import META, PLAYER_SLOT, default_action, extract_overlay, make_env
from sandbox.harness.environment import EnvironmentEntry, ParameterValue, resolve_parameters
from sandbox.harness.live import UNSET_TIMEOUT, UnsetTimeout
from sandbox.harness.local_server import LocalServer
from sandbox.harness.manifest import load_agent as _load_agent
from sandbox.harness.session import AgentPlayer, ExternalPlayer, run_episode

REPO_ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = Path(__file__).resolve().parent / "web"


class _DefaultSource:
    """An action source that lets ``ExternalPlayer`` select the environment's legal default."""

    def get_action(self, slot_id: str, observation: object, deadline_ms: int | None) -> None:
        return None


def load_agent(repo_root: Path) -> Any:
    """Load the manifest-selected agent through the same harness loader used by live sessions."""
    return _load_agent(str(repo_root))


def _entry(make: Any = make_env) -> EnvironmentEntry:
    return EnvironmentEntry(
        meta=META,
        make=make,
        default_action=default_action,
        overlay=extract_overlay,
    )


def possible_slots() -> tuple[str, ...]:
    """Read the environment's complete slot set instead of assuming every slot is human-capable."""
    env = make_env(resolve_parameters(META))
    try:
        return tuple(env.possible_agents)
    finally:
        env.close()


def play_episode(
    agent: Any,
    env: Any,
    *,
    seed: int,
    max_steps: int | None = None,
    slot: str = PLAYER_SLOT,
    parameters: Mapping[str, ParameterValue] | None = None,
) -> float:
    """Play one headless episode with one supplied agent and legal defaults for every other seat.

    ``env`` is already built, so the factory below returns it as-is and ignores the map the harness
    hands it. Pass the same ``parameters`` the environment was built from, otherwise the recording
    would describe settings the game did not actually run with. Omitting them means plain defaults,
    which is what ``make_env(resolve_parameters(META))`` produces.
    """
    slots = {
        slot_id: AgentPlayer(agent) if slot_id == slot else ExternalPlayer(_DefaultSource())
        for slot_id in possible_slots()
    }
    result = run_episode(
        _entry(lambda _parameters: env),
        slots,
        seed=seed,
        parameters=resolve_parameters(META) if parameters is None else parameters,
        max_steps=max_steps,
    )
    return result.scores[slot]


def run_headless(*, seed: int, max_steps: int | None, seat: int) -> float:
    """Run the selected seat through the harness without local networking or browser rendering."""
    slots = possible_slots()
    slot = slots[seat]
    # One resolution feeds both the environment and the episode, so the recorded parameters always
    # describe the environment that actually ran.
    parameters = resolve_parameters(META)
    env = make_env(parameters)
    try:
        return play_episode(
            load_agent(REPO_ROOT),
            env,
            seed=seed,
            max_steps=max_steps,
            slot=slot,
            parameters=parameters,
        )
    finally:
        env.close()


def local_config(
    *,
    seed: int,
    mode: str,
    seat: int,
    recording_dir: Path,
    step_limit: int | None,
    human_timeout_ms: int | None | UnsetTimeout = UNSET_TIMEOUT,
) -> dict[str, object]:
    """Build the complete runner config and header attribution for one local launch."""
    available_slots = possible_slots()
    human_slot = available_slots[seat] if mode == "human" else None
    slots: dict[str, dict[str, str]] = {}
    players: dict[str, dict[str, str]] = {}
    for slot_id in available_slots:
        if slot_id == human_slot:
            slots[slot_id] = {"kind": "external"}
            players[slot_id] = {"kind": "human", "label": "You"}
        else:
            slots[slot_id] = {"kind": "builtin-agent", "path": str(REPO_ROOT)}
            players[slot_id] = {"kind": "agent", "label": "Your agent"}
    config: dict[str, object] = {
        "env_id": META.env_id,
        "parameters": resolve_parameters(META),
        "seed": seed,
        "player_bindings": slots,
        "players": players,
        "recording_dir": str(recording_dir),
        "recording_id": "local",
        "human_timeout_ms": None,
        "llm": None,
        "start_paused": True,
    }
    # ``max_steps`` is the local runner's explicit step cap. Omit it for normal unlimited sessions.
    if step_limit is not None:
        config["max_steps"] = step_limit
    # Omission means the metadata default. JSON null is reserved for an explicit disabled timeout.
    if human_timeout_ms is not UNSET_TIMEOUT:
        config["human_timeout_ms"] = human_timeout_ms
    else:
        config.pop("human_timeout_ms")
    return config


def launch_browser(config: dict[str, object], *, port: int, open_browser: bool) -> int:
    """Serve the local bundle and runner until the player closes the command with Ctrl+C."""

    command = [sys.executable, "-m", "sandbox.live_local", json.dumps(config, separators=(",", ":"))]

    async def serve() -> None:
        async with LocalServer(
            _entry(),
            command=command,
            static_root=WEB_ROOT,
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Play your environment in a local browser session.")
    parser.add_argument("mode", nargs="?", choices=("human", "agent"), default="human")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--steps", type=int, help="cap headless steps")
    parser.add_argument("--seat", type=int, default=0, help="seat index (default 0)")
    parser.add_argument("--port", type=int, default=0, help="loopback port, or 0 for an available port")
    parser.add_argument("--no-browser", action="store_true", help="serve without opening a browser")
    parser.add_argument("--headless", action="store_true", help="run one harness episode without a browser")
    timeouts = parser.add_mutually_exclusive_group()
    timeouts.add_argument("--human-timeout-ms", type=int, help="override the human turn timeout")
    timeouts.add_argument(
        "--no-human-timeout",
        action="store_true",
        help="disable the turn timeout for turn-based local play",
    )
    args = parser.parse_args(argv)

    available_slots = possible_slots()
    if args.seat < 0 or args.seat >= len(available_slots):
        parser.error(f"--seat must name one of 0..{len(available_slots) - 1}")
    if args.mode == "human" and not args.headless and available_slots[args.seat] not in META.human_players:
        parser.error(f"seat {args.seat} is not human-playable in {META.env_id!r}")
    if args.headless:
        score = run_headless(seed=args.seed, max_steps=args.steps, seat=args.seat)
        print(f"seed {args.seed}: score {score:.2f}")
        return 0
    with TemporaryDirectory(prefix="game-sandbox-local-") as recording_dir:
        config = local_config(
            seed=args.seed,
            mode=args.mode,
            seat=args.seat,
            recording_dir=Path(recording_dir),
            step_limit=args.steps,
            human_timeout_ms=(
                None
                if args.no_human_timeout
                else args.human_timeout_ms
                if args.human_timeout_ms is not None
                else UNSET_TIMEOUT
            ),
        )
        return launch_browser(config, port=args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    raise SystemExit(main())
