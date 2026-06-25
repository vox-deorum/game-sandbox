"""Play a registered environment locally, with a window, bypassing the backend entirely.

    npm run play -- flappy_bird          # you play; space/up flaps
    npm run play -- flappy_bird agent    # watch the bundled example agent
    npm run play -- hearts               # click your legal cards; bots play the rest
    npm run play -- hearts watch         # all seats auto-play the built-in baseline
    npm run play -- <env> --agent-repo ./my-agent   # play your own manifest.json agent

This is the maintainer counterpart to the student template's local play: it resolves any
environment through the entry-point registry (so it works for every installed env), opens it in
``render_mode="human"``, and drives the same agent-environment cycle the server runs — with no
Docker, no session, no network. ``mode`` is ``human`` (default), ``agent``, or ``watch``.

Two loop shapes are selected by the env's ``pace_interval_ms``: a realtime env (Flappy Bird)
runs at a fixed cadence and samples human input non-blocking each tick, while a turn-based env
(Hearts) blocks for the human's move and gives bot moves a beat so they are followable. The only
per-environment piece is human input (keyboard vs. mouse), discovered by convention from each
env's ``<package>.human`` module (``make_human_controller``); an env without one simply cannot be
played as a human.
"""

from __future__ import annotations

import argparse
import importlib
import importlib.util
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

import pygame

from _paths import EXAMPLES_DIR
from game_sandbox_harness.environment import (
    EnvironmentEntry,
    EnvironmentLookupError,
    load_environment,
)
from game_sandbox_harness.manifest import load_agent

#: The play modes, in CLI order: human play, watch the example agent, watch the baseline.
MODES = ("human", "agent", "watch")

#: How long a bot move lingers on screen in a turn-based env, so a human can follow it.
_BOT_PAUSE_S = 0.6

#: env id -> (agent source file, class name) for the example agent ``agent`` mode plays. The
#: shipped examples are compose overlays without a manifest, so they are loaded by file path.
EXAMPLE_AGENTS: dict[str, tuple[Path, str]] = {
    "flappy_bird": (EXAMPLES_DIR / "flappy_bird" / "hello" / "agent.py", "Agent"),
}


def _load_example_agent(env_id: str) -> Any | None:
    """Instantiate the bundled example agent for ``env_id`` by file path, or ``None`` if none."""
    spec_entry = EXAMPLE_AGENTS.get(env_id)
    if spec_entry is None:
        return None
    path, class_name = spec_entry
    spec = importlib.util.spec_from_file_location(f"_example_agent_{env_id}", path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module, class_name)()


def _human_controller_factory(entry: EnvironmentEntry) -> Callable[[Any], Any] | None:
    """Return the env's ``make_human_controller`` by convention, or ``None`` if it ships none.

    The factory module is the ``human`` submodule of the package that defines the env factory
    (e.g. ``flappy_bird.human`` for a ``flappy_bird.env.make_env``). This keeps local pygame play
    out of the shared registry contract — only envs that want it provide a ``human.py``. We probe
    for the module with ``find_spec`` rather than catching ``ImportError`` around the import, so a
    real import failure *inside* an existing ``human.py`` surfaces instead of masquerading as "no
    human play".
    """
    module_name = f"{entry.make.__module__.split('.')[0]}.human"
    if importlib.util.find_spec(module_name) is None:
        return None
    module = importlib.import_module(module_name)
    return getattr(module, "make_human_controller", None)


def _quit_requested() -> bool:
    """True if the window was closed since the last check (non-human-controlled steps only).

    Filters just ``QUIT`` from the queue so any pending input events stay for the controller.
    """
    if not pygame.get_init():
        return False
    return bool(pygame.event.get(pygame.QUIT))


def _play(
    entry: EnvironmentEntry,
    *,
    mode: str,
    seat: int,
    seed: int,
    max_steps: int | None,
    agent_override: Any | None,
) -> tuple[dict[str, float], int, str]:
    """Run one episode in a window; return ``(per-slot scores, ticks, stop reason)``."""
    make = cast("Callable[..., Any]", entry.make)
    env = make(render_mode="human")

    human_slots = entry.meta.human_slots
    human_slot = human_slots[seat] if (mode == "human" and human_slots) else None

    controller = None
    if mode == "human":
        factory = _human_controller_factory(entry)
        if factory is None:
            raise SystemExit(f"environment {entry.meta.env_id!r} does not support human play")
        controller = factory(env)

    example_agent = agent_override
    if example_agent is None and mode == "agent":
        example_agent = _load_example_agent(entry.meta.env_id)
        if example_agent is None:
            print(f"note: {entry.meta.env_id!r} ships no example agent; using the built-in baseline")

    def action_for(agent_id: str, observation: Any) -> Any:
        """The action for a non-human seat: the example agent if present, else the baseline."""
        if example_agent is not None:
            return example_agent.act(observation)
        return entry.default_action(agent_id)

    env.reset(seed=seed)
    # Hearts (and any seat-aware env) shows the chosen seat at the bottom; reveal hands when no
    # one is playing it by hand, so a watcher can see the whole table.
    if hasattr(env, "view_seat"):
        env.view_seat = seat
    if mode != "human" and hasattr(env, "reveal_all"):
        env.reveal_all = True
    if example_agent is not None and hasattr(example_agent, "reset"):
        example_agent.reset(seed)

    turn_based = entry.meta.pace_interval_ms is None
    scores: dict[str, float] = {}
    tick = 0
    try:
        env.render()  # open the window / build the renderer before the loop touches it
        while env.agents:
            agent_id = env.agent_selection
            observation, _reward, termination, truncation, _info = env.last()
            if termination or truncation:
                env.step(None)
                continue

            if controller is not None and agent_id == human_slot:
                action = controller.act(agent_id, observation, blocking=turn_based)
                if controller.quit:
                    return scores, tick, "quit"
            else:
                if _quit_requested():
                    return scores, tick, "quit"
                if turn_based:
                    # Let the bot's move sit on screen a beat so it is followable.
                    env.render()
                    time.sleep(_BOT_PAUSE_S)
                action = action_for(agent_id, observation)

            env.step(action)
            for rewarded_slot, reward in env.rewards.items():
                scores[rewarded_slot] = scores.get(rewarded_slot, 0.0) + float(reward)
            # A realtime env auto-renders (and paces) inside step; a turn-based one needs a draw.
            if turn_based:
                env.render()

            tick += 1
            if max_steps is not None and tick >= max_steps:
                return scores, tick, "max_steps"
        return scores, tick, "terminal"
    finally:
        env.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="npm run play --",
        description="Play a registered environment locally, in a window, without the backend.",
    )
    parser.add_argument("env_id", help="environment id, for example flappy_bird or hearts")
    parser.add_argument(
        "mode",
        nargs="?",
        default="human",
        choices=MODES,
        help="human (default), agent (example agent), or watch (built-in baseline)",
    )
    parser.add_argument("--seat", type=int, default=0, help="human seat index for multi-slot envs")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--steps", type=int, help="cap the episode at this many steps")
    parser.add_argument(
        "--agent-repo",
        metavar="PATH",
        help="play a manifest.json agent repo in every seat (implies agent mode)",
    )
    args = parser.parse_args(argv)

    try:
        entry = load_environment(args.env_id)
    except EnvironmentLookupError as error:
        print(error, file=sys.stderr)
        return 2

    mode = "agent" if args.agent_repo else args.mode
    agent_override = load_agent(args.agent_repo) if args.agent_repo else None

    human_slots = entry.meta.human_slots
    if mode == "human" and not human_slots:
        print(f"environment {args.env_id!r} has no human-playable slots", file=sys.stderr)
        return 2
    if human_slots and not 0 <= args.seat < len(human_slots):
        print(
            f"--seat must be in [0, {len(human_slots)}) for {args.env_id!r}",
            file=sys.stderr,
        )
        return 2

    scores, ticks, reason = _play(
        entry,
        mode=mode,
        seat=args.seat,
        seed=args.seed,
        max_steps=args.steps,
        agent_override=agent_override,
    )

    rounded = {slot: round(score, 2) for slot, score in scores.items()}
    print(f"environment : {args.env_id}")
    print(f"mode        : {mode}")
    print(f"seed        : {args.seed}")
    print(f"ticks       : {ticks}")
    print(f"reason      : {reason}")
    print(f"scores      : {rounded}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
