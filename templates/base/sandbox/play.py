"""Run one local browser session through the same live runner used by production.

``python -m sandbox.play`` opens local browser play. The selected player is human by default; the
other players run the repository's agent through explicit harness bindings. ``--vs`` rebinds the
players outside the selected player's seat to a saved rival agent. ``--headless`` is a small test
and evaluation escape hatch that drives the same ``Episode`` and default-action paths without a
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

from sandbox.env import META, PLAYER_ID, default_action, extract_overlay, make_env
from sandbox.harness.environment import (
    EnvironmentEntry,
    ParameterValue,
    resolve_layout,
    resolve_parameters,
)
from sandbox.harness.live import UNSET_TIMEOUT, UnsetTimeout
from sandbox.harness.local_server import LocalServer
from sandbox.harness.manifest import load_agent as _load_agent
from sandbox.harness.session import AgentPlayer, ExternalPlayer, run_episode

REPO_ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = Path(__file__).resolve().parent / "web"


class _DefaultSource:
    """An action source that lets ``ExternalPlayer`` select the environment's legal default."""

    def get_action(self, player_id: str, observation: object, deadline_ms: int | None) -> None:
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


def possible_players() -> tuple[str, ...]:
    """Read every environment player instead of assuming every player is human-capable."""
    env = make_env(resolve_parameters(META))
    try:
        return tuple(env.possible_agents)
    finally:
        env.close()


def rival_player_ids(player_id: str, parameters: Mapping[str, ParameterValue]) -> frozenset[str]:
    """Return the players a ``--vs`` rival fills: everyone seated outside the selected player's seat."""
    layout = resolve_layout(META, parameters)
    own = next((seat.players for seat in layout.seats if player_id in seat.players), (player_id,))
    return frozenset(player for seat in layout.seats for player in seat.players if player not in own)


def resolve_rival(raw: str) -> Path:
    """Resolve a ``--vs`` value to the rival's folder, accepting the folder or its manifest.json."""
    supplied = Path(raw)
    folder = (supplied.parent if supplied.name == "manifest.json" else supplied).resolve()
    if not folder.is_dir():
        raise ValueError(
            f"--vs could not find {folder}. Pass a folder that contains a manifest.json, "
            "or the manifest.json file itself."
        )
    if not (folder / "manifest.json").is_file():
        raise ValueError(
            f"--vs found no manifest.json in {folder}. Copy agent.py and manifest.json from "
            "the version you want to play against into that folder."
        )
    return folder


def parse_rival(parser: argparse.ArgumentParser, raw: str | None) -> Path | None:
    """Turn a ``--vs`` value into the rival's folder, reporting problems through the parser.

    A game whose layout resolves to one seat has no opposing seat for a rival to fill, whether that
    seat holds a single player or every player, so the flag is rejected rather than silently ignored.
    """
    if raw is None:
        return None
    layout = resolve_layout(META, resolve_parameters(META))
    if layout.seat_count == 1:
        reason = "it has only one player" if layout.player_count == 1 else "every player is on your team"
        parser.error(f"--vs is not available in this game: {reason}, so there are no opponents to replace")
    try:
        return resolve_rival(raw)
    except ValueError as error:
        parser.error(str(error))


def _rival_label(rival: Path) -> str:
    """Name the rival after its folder so two saved versions stay distinguishable in the viewer."""
    return f"Rival ({rival.name})" if rival.name else "Rival"


def play_episode(
    agent: Any,
    env: Any,
    *,
    seed: int,
    max_steps: int | None = None,
    player_id: str = PLAYER_ID,
    parameters: Mapping[str, ParameterValue] | None = None,
    other_agents: Mapping[str, Any] | None = None,
) -> float:
    """Play one headless episode with one selected agent and legal defaults for every other player.

    ``env`` is already built, so the factory below returns it as-is and ignores the map the harness
    hands it. Pass the same ``parameters`` the environment was built from, otherwise the recording
    would describe settings the game did not actually run with. Omitting them means plain defaults,
    which is what ``make_env(resolve_parameters(META))`` produces. ``other_agents`` names agent
    instances for specific other players; players it leaves out keep the legal default.
    """
    others: Mapping[str, Any] = {} if other_agents is None else other_agents

    def _player(candidate: str) -> AgentPlayer | ExternalPlayer:
        if candidate == player_id:
            return AgentPlayer(agent)
        if candidate in others:
            return AgentPlayer(others[candidate])
        return ExternalPlayer(_DefaultSource())

    players = {candidate: _player(candidate) for candidate in possible_players()}
    result = run_episode(
        _entry(lambda _parameters: env),
        players,
        seed=seed,
        parameters=resolve_parameters(META) if parameters is None else parameters,
        max_steps=max_steps,
    )
    return result.scores[player_id]


def run_headless(*, seed: int, max_steps: int | None, player: int, vs: Path | None = None) -> float:
    """Run the selected player through the harness without local networking or browser rendering.

    With ``vs``, the players outside the selected player's seat run the rival saved in that folder,
    and seatmates run this repository's agent, each as its own separately constructed instance.
    """
    player_ids = possible_players()
    player_id = player_ids[player]
    # One resolution feeds both the environment and the episode, so the recorded parameters always
    # describe the environment that actually ran.
    parameters = resolve_parameters(META)
    other_agents: dict[str, Any] | None = None
    if vs is not None:
        rivals = rival_player_ids(player_id, parameters)
        other_agents = {
            candidate: load_agent(vs if candidate in rivals else REPO_ROOT)
            for candidate in player_ids
            if candidate != player_id
        }
    env = make_env(parameters)
    try:
        return play_episode(
            load_agent(REPO_ROOT),
            env,
            seed=seed,
            max_steps=max_steps,
            player_id=player_id,
            parameters=parameters,
            other_agents=other_agents,
        )
    finally:
        env.close()


def local_config(
    *,
    seed: int,
    mode: str,
    player: int,
    recording_dir: Path,
    step_limit: int | None,
    human_timeout_ms: int | None | UnsetTimeout = UNSET_TIMEOUT,
    vs: Path | None = None,
) -> dict[str, object]:
    """Build the complete runner config and header attribution for one local launch.

    With ``vs``, the players outside the selected player's seat bind to the rival saved in that
    folder instead of this repository.
    """
    player_ids = possible_players()
    parameters = resolve_parameters(META)
    human_player = player_ids[player] if mode == "human" else None
    rivals = rival_player_ids(player_ids[player], parameters) if vs is not None else frozenset()
    bindings: dict[str, dict[str, str]] = {}
    players: dict[str, dict[str, str]] = {}
    for player_id in player_ids:
        if player_id == human_player:
            bindings[player_id] = {"kind": "external"}
            players[player_id] = {"kind": "human", "label": "You"}
        elif vs is not None and player_id in rivals:
            bindings[player_id] = {"kind": "builtin-agent", "path": str(vs)}
            players[player_id] = {
                "kind": "agent",
                "submission_id": "local-rival",
                "label": _rival_label(vs),
            }
        else:
            bindings[player_id] = {"kind": "builtin-agent", "path": str(REPO_ROOT)}
            players[player_id] = {
                "kind": "agent",
                "submission_id": "local",
                "label": "Your agent",
            }
    config: dict[str, object] = {
        "env_id": META.env_id,
        "parameters": parameters,
        "seed": seed,
        "player_bindings": bindings,
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
    parser.add_argument("--player", type=int, default=0, help="player index (default 0)")
    parser.add_argument(
        "--vs",
        metavar="PATH",
        help="play against the agent saved in PATH, a folder holding that agent's manifest.json",
    )
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

    player_ids = possible_players()
    if args.player < 0 or args.player >= len(player_ids):
        parser.error(f"--player must name one of 0..{len(player_ids) - 1}")
    if args.mode == "human" and not args.headless and player_ids[args.player] not in META.human_players:
        parser.error(f"player {args.player} is not human-playable in {META.env_id!r}")
    rival = parse_rival(parser, args.vs)
    if args.headless:
        score = run_headless(seed=args.seed, max_steps=args.steps, player=args.player, vs=rival)
        print(f"seed {args.seed}: score {score:.2f}")
        return 0
    with TemporaryDirectory(prefix="game-sandbox-local-") as recording_dir:
        config = local_config(
            seed=args.seed,
            mode=args.mode,
            player=args.player,
            recording_dir=Path(recording_dir),
            step_limit=args.steps,
            vs=rival,
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
