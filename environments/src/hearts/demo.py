"""Manual dev/demo driver for the Hearts environment.

This is a hand-run tool, not a CI test: it opens the ``human`` pygame window and is exercised
by a person watching (and optionally playing) a full hand. CI never runs it because there is no
interactive display; it lives here purely so a developer can sanity-check the renderer and the
play loop end to end.

Run it watch-only (all four seats are built-in lowest-legal-card agents)::

    uv run python -m hearts.demo

or take seat 0 and click your own cards against the built-in agents::

    uv run python -m hearts.demo --play

Step 2 of the plan later formalizes this exact flow inside the template's ``play.py``, reusing
the same renderer primitives (``card_at_pos``/``is_legal_card``) that this demo drives by hand.
"""

from __future__ import annotations

import argparse
import time
from typing import Any

import pygame

from . import rules
from .env import AUTO_ACTION, HeartsEnv, make_env


def main(argv: list[str] | None = None) -> int:
    """Run a full Hearts hand in a window; return a process exit code."""
    parser = argparse.ArgumentParser(description="Manual Hearts demo / play driver.")
    parser.add_argument(
        "--play",
        action="store_true",
        help="Take seat 0 and click your own cards; otherwise just watch built-in agents.",
    )
    parser.add_argument("--seed", type=int, default=0, help="Deal seed (default 0).")
    parser.add_argument(
        "--reveal",
        action="store_true",
        help="Reveal all hands (spectator mode).",
    )
    parser.add_argument(
        "--seat",
        type=int,
        default=0,
        help="Seat the human/view occupies (default 0).",
    )
    args = parser.parse_args(argv)

    env = make_env("human")
    env.reset(seed=args.seed)
    env.view_seat = args.seat
    env.reveal_all = args.reveal
    # Render once so the renderer and its window exist before the loop touches them.
    env.render()
    renderer = env._renderer

    human_agent = env.possible_agents[args.seat]

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
                card = _wait_for_human_card(env, renderer)
                if card is None:  # window closed
                    env.close()
                    return 0
                env.step(card)
            else:
                # Built-in seat (or watch mode): play the lowest legal card after a beat so
                # the move is followable.
                env.render()
                time.sleep(0.6)
                env.step(AUTO_ACTION)

            env.render()
            # A just-completed trick clears current_trick (it briefly held all NUM_PLAYERS
            # cards); pause a touch longer so the full trick (drawn from last_trick) stays up.
            trick_in_progress = 0 < len(env.state.current_trick) < rules.NUM_PLAYERS
            if not trick_in_progress and env.state.last_trick is not None:
                time.sleep(1.0)

        # Game over: show the terminal frame, then wait for a quit or a few seconds.
        env.render()
        _wait_for_quit(env, timeout_s=5.0)
        return 0
    finally:
        env.close()


def _wait_for_human_card(env: HeartsEnv, renderer: Any) -> int | None:
    """Block until the human left-clicks a legal card; return it, or ``None`` if the window closed.

    Illegal clicks are ignored. The window is kept live with periodic re-renders so it stays
    responsive while we wait.
    """
    while True:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return None
            if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                card = renderer.card_at_pos(event.pos)
                if card is not None and renderer.is_legal_card(card):
                    return card
        env.render()
        time.sleep(0.02)


def _wait_for_quit(env: HeartsEnv, timeout_s: float) -> None:
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
