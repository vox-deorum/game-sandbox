"""Manual dev/demo driver for the Spades environment.

This is a hand-run tool, not a CI test: it opens the ``human`` pygame window and is exercised by a
person watching (and optionally playing) a full hand, the bidding round and thirteen tricks. CI
never runs it because there is no interactive display; it lives here purely so a developer can
sanity-check the renderer and the play loop end to end.

Run it watch-only (all four seats are built-in default agents: a suggested bid, then lowest legal
card)::

    uv run python -m spades.demo

or take seat 0 and click your own bid chip and then your own cards against the built-in agents::

    uv run python -m spades.demo --play

The interactive seat is driven by :func:`spades.human.make_human_controller`, the same
click-to-bid/click-to-card controller the generic ``scripts/play.py`` launcher uses, so the demo and
the launcher play Spades through one shared input path.
"""

from __future__ import annotations

import argparse
import time

import pygame

from . import rules
from .env import AUTO_ACTION, SpadesEnv, make_env
from .human import make_human_controller


def main(argv: list[str] | None = None) -> int:
    """Run a full Spades hand in a window; return a process exit code."""
    parser = argparse.ArgumentParser(description="Manual Spades demo / play driver.")
    parser.add_argument(
        "--play",
        action="store_true",
        help="Take seat 0 and click your own bid and cards; otherwise just watch built-in agents.",
    )
    parser.add_argument("--seed", type=int, default=0, help="Deal seed (default 0).")
    parser.add_argument("--reveal", action="store_true", help="Reveal all hands (spectator mode).")
    parser.add_argument("--seat", type=int, default=0, help="Seat the human/view occupies (default 0).")
    args = parser.parse_args(argv)

    env = make_env("human")
    env.reset(seed=args.seed)
    env.view_seat = args.seat
    env.reveal_all = args.reveal
    # Render once so the renderer and its window exist before the loop touches them.
    env.render()

    human_agent = env.possible_agents[args.seat]
    controller = make_human_controller(env)

    try:
        while env.agents:
            agent = env.agent_selection
            _obs, _reward, term, trunc, _info = env.last()

            if term or trunc:
                env.step(None)
                continue

            # Drain pending events so a quit is honoured promptly on every iteration.
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    env.close()
                    return 0

            if args.play and agent == human_agent:
                action = controller.act(human_agent, _obs, blocking=True)
                if controller.quit:  # window closed
                    env.close()
                    return 0
                env.step(action)
            else:
                # Built-in seat (or watch mode): take the env default after a beat so the move is
                # followable: a suggested bid during bidding, the lowest legal card during play.
                env.render()
                time.sleep(0.6)
                env.step(AUTO_ACTION)

            env.render()
            # A just-completed trick clears current_trick (it briefly held all NUM_PLAYERS cards);
            # pause a touch longer so the full trick (drawn from last_trick) stays up.
            trick_in_progress = 0 < len(env.state.current_trick) < rules.NUM_PLAYERS
            if not trick_in_progress and env.state.last_trick is not None:
                time.sleep(1.0)

        # Game over: show the terminal frame, then wait for a quit or a few seconds.
        env.render()
        _wait_for_quit(env, timeout_s=5.0)
        return 0
    finally:
        env.close()


def _wait_for_quit(env: SpadesEnv, timeout_s: float) -> None:
    """Pump events until a ``QUIT`` arrives or ``timeout_s`` elapses, keeping the window live."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return
        env.render()
        time.sleep(0.02)


if __name__ == "__main__":
    raise SystemExit(main())
