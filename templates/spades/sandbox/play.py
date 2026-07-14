"""Play one game of Spades locally, against vanilla PettingZoo.

    python -m sandbox.play               # watch YOUR agent play a seat against the built-in bots
    python -m sandbox.play --headless    # no window: play it out and print the final team scores
    python -m sandbox.play --human       # take a seat yourself: click a bid chip, then legal cards
    python -m sandbox.play --seat 2      # sit in a different seat (0..3)
    python -m sandbox.play --seed 7      # pick the deal

Spades is turn-based with four seats across two phases — a bidding round, then thirteen tricks — so it
does not fit the single-slot realtime loop the base template ships; this env-layer file overrides
``sandbox/play.py`` whole-file. It keeps the same surface the provided tooling reads — ``load_agent``,
``play_episode``, and a ``main`` driving the same observation/action cycle the server runs — but seats
your one agent (or you) among three built-in opponents and steps the table a turn at a time through
the provided ``sandbox.env``.

The built-in opponent is the environment's own timeout default: it bids a never-nil suggested count,
then plays its lowest legal card. It is a fine, low-risk baseline to measure your agent against;
clearing it is the example's bar.

When there is a window the game begins on a manual interaction (any key or click) and holds the final
scores until you dismiss them; ``--headless`` opens no window — it (and ``evaluate`` and the tests)
just plays the deal out and reports the result. This loop is the contract: the server wraps this
exact stepping with timeouts, recording, and the move clock for the human seat.
"""

from __future__ import annotations

import argparse
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pygame
from sandbox.env import PLAYER_SLOT, default_action, extract_overlay, make_env, make_human_controller
from sandbox.hidpi import display_scale, enable_hidpi
from sandbox.multiseat_play import load_agent
from sandbox.multiseat_play import play_episode as _play_episode

#: The banner shown over the frozen first frame until you begin the game.
START_PROMPT = "Press any key or click to start"

#: How long a bot's move lingers on screen before the next turn, so the table is followable.
BOT_PAUSE_S = 0.6

#: The repository root (this file is ``sandbox/play.py``), where ``manifest.json`` lives.
REPO_ROOT = Path(__file__).resolve().parent.parent


def play_episode(
    agent: Any,
    env: Any,
    *,
    seed: int,
    max_steps: int | None = None,
    on_frame: Callable[[], None] | None = None,
) -> float:
    """Play one game with ``agent`` in ``PLAYER_SLOT`` and the built-in baseline elsewhere.

    Returns ``PLAYER_SLOT``'s cumulative reward — for Spades that is its final leaderboard score, the
    raw team hand score (higher is better; both partners share it, so it is your *team*'s result). A
    made contract is positive, a set one negative, and the floor is minus 260. The shared stepping
    contract: headless ``evaluate`` and the inherited tests call this with no ``on_frame``, while the
    windowed run passes one to draw each frame.

    ``max_steps`` caps how many decisions *your* agent makes (not table turns), mirroring the base
    template's "drive a few steps" contract — so the bare template, whose ``act`` raises until you
    implement it, still fails here, and a partial run still exercises your agent.
    """
    return _play_episode(
        agent,
        env,
        seed=seed,
        player_slot=PLAYER_SLOT,
        default_action=default_action,
        max_steps=max_steps,
        on_frame=on_frame,
    )


def play_table(
    env: Any,
    *,
    seed: int,
    seat: int,
    agent: Any | None = None,
    controller: Any | None = None,
) -> dict[str, float]:
    """Run one windowed game: ``seat`` is played by you (``controller``) or your ``agent``; the
    other three seats auto-play the built-in baseline. Returns each seat's cumulative reward.

    Turn-based across both phases: on your turn the human controller blocks until you click a bid chip
    (bidding) or a legal card (play); every other move lingers a beat so the table is followable. The
    window begins paused on the first frame and holds the final scores until dismissed. Closing the
    window stops the game and returns early.
    """
    env.reset(seed=seed)
    # Spades shows the chosen seat at the bottom of the table and fans its hand for clicking.
    if hasattr(env, "view_seat"):
        env.view_seat = seat
    if agent is not None:
        agent.reset(seed)
    your_slot = f"player_{seat}"

    env.render()  # build the renderer / open the window before the loop touches it
    if not wait_for_start():
        return {}

    scores: dict[str, float] = {}
    while env.agents:
        agent_id = env.agent_selection
        observation, _reward, termination, truncation, _info = env.last()
        if termination or truncation:
            env.step(None)
            continue

        if controller is not None and agent_id == your_slot:
            action = controller.act(agent_id, observation, blocking=True)
            if controller.quit:  # window closed mid-move
                return scores
        else:
            if _quit_requested():
                return scores
            # Show the table a beat before the move so the play that follows is followable.
            env.render()
            time.sleep(BOT_PAUSE_S)
            watched = agent is not None and agent_id == your_slot
            action = agent.act(observation) if watched else default_action(env, agent_id)

        env.step(action)
        for slot, reward in env.rewards.items():
            scores[slot] = scores.get(slot, 0.0) + float(reward)
        env.render()

    _hold_final_frame(env)
    return scores


def wait_for_start(prompt: str = START_PROMPT) -> bool:
    """Block until you press a key or click; return ``False`` if you close the window instead.

    The game begins on a manual interaction, not the moment the window opens, so you have time to
    read your hand. Draws a banner over the frozen first frame the renderer already presented. A
    no-op (returns ``True``) when there is no window, so ``--headless`` and the tests never block.
    """
    if not pygame.display.get_init():
        return True
    surface = pygame.display.get_surface()
    if surface is None:
        return True
    print(prompt)
    pygame.font.init()
    scale = max(1.0, display_scale())
    overlay = pygame.Surface(surface.get_size(), pygame.SRCALPHA)
    overlay.fill((0, 0, 0, 120))
    label = pygame.font.Font(None, round(40 * scale)).render(prompt, True, (255, 255, 255))
    overlay.blit(label, label.get_rect(center=surface.get_rect().center))
    surface.blit(overlay, (0, 0))
    pygame.display.flip()
    return _wait_for_dismiss()


def _wait_for_dismiss() -> bool:
    """Block until a key/click (returns ``True``) or a window close (returns ``False``)."""
    while True:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return False
            if event.type in (pygame.KEYDOWN, pygame.MOUSEBUTTONDOWN):
                return True
        time.sleep(0.02)


def _quit_requested() -> bool:
    """True if the window was closed since the last check; drains only ``QUIT`` from the queue."""
    if not pygame.get_init():
        return False
    return bool(pygame.event.get(pygame.QUIT))


def _hold_final_frame(env: Any, timeout_s: float = 8.0) -> None:
    """Keep the game-over frame (drawn by the renderer) up until dismissed or ``timeout_s`` passes.

    A no-op without a window, so headless runs are never blocked. The renderer already drew the
    terminal frame with the final per-seat bids, tricks, and team scores on the last step; we just
    keep it live.
    """
    if not pygame.display.get_init():
        return
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return
            if event.type in (pygame.KEYDOWN, pygame.MOUSEBUTTONDOWN):
                return
        env.render()
        time.sleep(0.02)


def _print_scoreboard(env: Any, seat: int) -> None:
    """Print the final per-seat ``bid/won`` lines and the two team scores from the overlay.

    Reads the same per-step overlay the renderer draws (``extract_overlay``), so the printed result
    matches the window: each seat's bid and tricks taken, then each partnership's hand score (higher
    is better). ``env.state`` survives ``env.close()``, so this is safe to call after the game.
    """
    overlay = extract_overlay(env)
    bids = overlay["bids"]
    won = overlay["tricks_won"]
    team_scores = overlay["team_scores"]
    for slot in range(4):
        bid = "nil" if bids[slot] == 0 else bids[slot]
        you = "  <- you" if slot == seat else ""
        print(f"  player_{slot}: bid {bid}, took {won[slot]}{you}")
    your_team = seat % 2
    for team in range(2):
        a, b = team, team + 2
        mine = "  (your team)" if team == your_team else ""
        print(f"  team player_{a}+player_{b}: {team_scores[team]}{mine}")
    print(f"your team's leaderboard score: {team_scores[your_team]} (higher is better)")


def _report(env: Any, seat: int, scores: dict[str, float]) -> None:
    """Print the final result of a windowed game, or note an early close."""
    if not scores:
        print("no result (the window was closed early)")
        return
    _print_scoreboard(env, seat)


def main(argv: list[str] | None = None) -> int:
    # Make the process DPI-aware before any window opens, so a high-DPI display renders it at
    # physical pixels (crisp) instead of bitmap-stretching it (blurry).
    enable_hidpi()
    parser = argparse.ArgumentParser(description="Play one game of Spades locally.")
    parser.add_argument("--seed", type=int, default=0, help="the deal to play")
    parser.add_argument("--seat", type=int, default=0, choices=range(4), help="your seat (0..3)")
    parser.add_argument("--headless", action="store_true", help="run without a render window")
    parser.add_argument("--human", action="store_true", help="play a seat yourself: click a bid, then cards")
    parser.add_argument("--steps", type=int, help="cap a headless run at this many of your decisions")
    args = parser.parse_args(argv)

    if args.human:
        # The renderer opens its own DPI-aware window in "human" mode; the controller hit-tests
        # clicks against the bid chips (bidding) and the hand it draws (play).
        env = make_env(render_mode="human")
        controller = make_human_controller(env)
        try:
            scores = play_table(env, seed=args.seed, seat=args.seat, controller=controller)
            _report(env, args.seat, scores)
        finally:
            env.close()
    elif args.headless:
        # No window, but still drive the renderer (rgb_array) each step so the local play path —
        # loop plus renderer — is exercised end to end, then report the final team scores.
        agent = load_agent(REPO_ROOT)
        env = make_env(render_mode="rgb_array")
        try:
            play_episode(agent, env, seed=args.seed, max_steps=args.steps, on_frame=lambda: env.render())
            print(f"seed {args.seed}:")
            _print_scoreboard(env, args.seat)
        finally:
            env.close()
    else:
        agent = load_agent(REPO_ROOT)
        env = make_env(render_mode="human")
        try:
            scores = play_table(env, seed=args.seed, seat=args.seat, agent=agent)
            _report(env, args.seat, scores)
        finally:
            env.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
