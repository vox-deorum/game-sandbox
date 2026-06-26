"""Play one episode of your environment locally, against vanilla PettingZoo.

    python -m sandbox.play                 # run YOUR agent in a window
    python -m sandbox.play --headless      # run YOUR agent, no window, just the score
    python -m sandbox.play --human         # play it yourself (space/up or click flaps)
    python -m sandbox.play --seed 7        # pick the episode seed

This script touches nothing of the sandbox backend: it loads your agent through
``manifest.json``, builds the environment from the provided ``sandbox.env`` package, and runs
the same agent-environment cycle the server runs. The loop here is the contract — the server
wraps this exact stepping with timeouts, recording, and (for live play) pacing. It is
environment-agnostic: ``sandbox.env`` exports ``make_env`` and ``PLAYER_SLOT`` for whichever
environment this template targets, and ``make_human_controller`` for playing it by hand.

When there is a window, every run begins on a manual interaction (any key or click) rather than
the instant it opens; ``--headless`` has no window, so it (and ``evaluate`` and the tests) starts
immediately and the server-side contract is unchanged.
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
import time
from pathlib import Path
from typing import Any

import pygame

from sandbox.env import PLAYER_SLOT, make_env

#: The banner shown over the frozen first frame until you begin the episode.
START_PROMPT = "Press any key or click to start"

#: The repository root (this file is ``sandbox/play.py``), where ``manifest.json`` lives.
REPO_ROOT = Path(__file__).resolve().parent.parent


def load_agent(repo_root: Path) -> Any:
    """Load and instantiate the agent named by ``manifest.json`` (a local mini-loader).

    Mirrors what the server's harness does: read the manifest, put the repo root on the path,
    import the entry-point module, and construct the named class with no arguments.
    """
    manifest = json.loads((repo_root / "manifest.json").read_text(encoding="utf-8"))
    root_str = str(repo_root)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)
    module = importlib.import_module(manifest["entry_point"])
    return getattr(module, manifest["class_name"])()


def wait_for_start(prompt: str = START_PROMPT) -> bool:
    """Block until you press a key or click; return ``False`` if you close the window instead.

    The game begins on a manual interaction, not the moment the window opens, so a realtime game
    is not already falling before you are ready. It draws a banner over the frozen first frame and
    waits there. A no-op (returns ``True``) when there is no window, so ``--headless`` runs,
    ``evaluate``, and the tests are never blocked.
    """
    if not pygame.display.get_init():
        return True
    surface = pygame.display.get_surface()
    if surface is None:
        return True
    print(prompt)
    # Dim the frozen first frame and center the prompt over it.
    overlay = pygame.Surface(surface.get_size(), pygame.SRCALPHA)
    overlay.fill((0, 0, 0, 110))
    pygame.font.init()
    label = pygame.font.Font(None, 36).render(prompt, True, (255, 255, 255))
    overlay.blit(label, label.get_rect(center=surface.get_rect().center))
    surface.blit(overlay, (0, 0))
    pygame.display.flip()
    while True:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return False
            if event.type in (pygame.KEYDOWN, pygame.MOUSEBUTTONDOWN):
                return True
        time.sleep(0.02)


def play_episode(agent: Any, env: Any, *, seed: int, max_steps: int | None = None) -> float:
    """Run one episode, returning the cumulative score. Shared by play, evaluate, and tests.

    The pure stepping contract — no window concerns, so headless ``evaluate`` and the tests reuse
    it unchanged. The windowed ``play`` path shows the start gate in ``main`` before calling this.
    """
    env.reset(seed=seed)
    agent.reset(seed)
    score = 0.0
    tick = 0
    while env.agents:
        observation, _reward, termination, truncation, _info = env.last()
        if termination or truncation:
            env.step(None)
            continue
        action = agent.act(observation)
        env.step(action)
        score += float(env.rewards[PLAYER_SLOT])
        tick += 1
        if max_steps is not None and tick >= max_steps:
            break
    return score


def play_human(env: Any, controller: Any, *, seed: int, max_steps: int | None = None) -> float:
    """Run one episode you control yourself, returning the cumulative score.

    The episode begins on a manual interaction (any key or click), not the moment the window
    opens. Realtime: each tick samples the controller non-blocking (a flap-key tap or click
    flaps) while the env auto-renders and paces inside ``step``. Closing the window stops it.
    """
    env.reset(seed=seed)
    score = 0.0
    tick = 0
    env.render()  # open the window before the loop reads input
    if not wait_for_start():  # begin on a manual interaction, not on window open
        return score
    while env.agents:
        observation, _reward, termination, truncation, _info = env.last()
        if termination or truncation:
            env.step(None)
            continue
        action = controller.act(PLAYER_SLOT, observation, blocking=False)
        if controller.quit:
            break
        env.step(action)
        score += float(env.rewards[PLAYER_SLOT])
        tick += 1
        if max_steps is not None and tick >= max_steps:
            break
    return score


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Play one episode locally.")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--headless", action="store_true", help="run without a render window")
    parser.add_argument("--human", action="store_true", help="play it yourself instead of the agent")
    parser.add_argument("--steps", type=int, help="cap the episode at this many steps")
    args = parser.parse_args(argv)

    if args.human:
        try:
            from sandbox.env import make_human_controller
        except ImportError:
            print("this environment does not support playing by hand", file=sys.stderr)
            return 2
        env = make_env(render_mode="human")
        controller = make_human_controller(env)
        try:
            score = play_human(env, controller, seed=args.seed, max_steps=args.steps)
        finally:
            env.close()
    else:
        agent = load_agent(REPO_ROOT)
        env = make_env(render_mode=None if args.headless else "human")
        try:
            if not args.headless:
                # Windowed agent run: draw the first frame and wait for a manual interaction
                # before stepping, just like human play. play_episode resets again with the same
                # seed (deterministic), so this pre-roll changes nothing about the episode.
                env.reset(seed=args.seed)
                env.render()
                if not wait_for_start():
                    return 0
            score = play_episode(agent, env, seed=args.seed, max_steps=args.steps)
        finally:
            env.close()

    print(f"seed {args.seed}: score {score:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
