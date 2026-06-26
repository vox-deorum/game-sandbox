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
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
import pygame

from sandbox.env import PLAYER_SLOT, make_env
from sandbox.hidpi import display_scale, enable_hidpi

#: The banner shown over the frozen first frame until you begin the episode.
START_PROMPT = "Press any key or click to start"

#: Frames per second for windowed local play. The env is realtime, so we pace the loop ourselves so
#: it is followable; the server paces live play on its own side, separately from this local loop.
WINDOW_FPS = 30

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


class HiDpiWindow:
    """A window that upscales the env's rgb frames to crisp pixels on a high-DPI display.

    This environment renders at a fixed resolution, so on a 150% / 200% display its own window
    would be bitmap-stretched by the OS and look blurry. Instead we render to an rgb array and blit
    it, magnified by an integer factor, into a DPI-aware window (see :mod:`sandbox.hidpi`).
    Nearest-neighbour scaling keeps the pixel-art sprites crisp; the window opens on the first frame.
    """

    def __init__(self) -> None:
        self._screen: pygame.Surface | None = None
        self._factor = max(1, round(display_scale()))

    def present(self, env: Any) -> None:
        """Draw the env's current frame, magnified, into the window (opening it on first call)."""
        frame = env.render()
        if frame is None:
            return
        height, width = int(frame.shape[0]), int(frame.shape[1])
        if self._screen is None:
            if not pygame.get_init():
                pygame.init()
            self._screen = pygame.display.set_mode((width * self._factor, height * self._factor))
        surface = pygame.surfarray.make_surface(np.transpose(frame, (1, 0, 2)))
        pygame.transform.scale(surface, self._screen.get_size(), self._screen)
        pygame.display.flip()


def play_episode(
    agent: Any,
    env: Any,
    *,
    seed: int,
    max_steps: int | None = None,
    on_frame: Callable[[], None] | None = None,
) -> float:
    """Run one episode, returning the cumulative score. Shared by play, evaluate, and tests.

    The pure stepping contract. ``on_frame`` is an optional per-step callback the windowed ``play``
    path uses to draw and pace the frame; headless ``evaluate`` and the tests pass nothing and reuse
    the loop unchanged.
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
        if on_frame is not None:
            on_frame()
        tick += 1
        if max_steps is not None and tick >= max_steps:
            break
    return score


def play_human(
    env: Any, controller: Any, window: HiDpiWindow, *, seed: int, max_steps: int | None = None
) -> float:
    """Run one episode you control yourself, returning the cumulative score.

    The episode begins on a manual interaction (any key or click), not the moment the window
    opens. Realtime: each tick samples the controller non-blocking (a flap-key tap or click flaps),
    then we draw the frame upscaled into the HiDPI window and pace the loop. Closing the window
    stops it.
    """
    env.reset(seed=seed)
    score = 0.0
    tick = 0
    clock = pygame.time.Clock()
    window.present(env)  # open the window on the first frame
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
        window.present(env)
        clock.tick(WINDOW_FPS)
        tick += 1
        if max_steps is not None and tick >= max_steps:
            break
    return score


def main(argv: list[str] | None = None) -> int:
    # Make the process DPI-aware before any window opens, so a high-DPI display renders the window
    # at physical pixels (crisp) instead of bitmap-stretching it (blurry).
    enable_hidpi()
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
        # rgb_array, not "human": we own the window so we can upscale the fixed-resolution frame
        # to a crisp, sensible size on a high-DPI display (the env's own window can't be enlarged).
        env = make_env(render_mode="rgb_array")
        controller = make_human_controller(env)
        try:
            score = play_human(env, controller, HiDpiWindow(), seed=args.seed, max_steps=args.steps)
        finally:
            env.close()
    else:
        agent = load_agent(REPO_ROOT)
        env = make_env(render_mode=None if args.headless else "rgb_array")
        try:
            if args.headless:
                score = play_episode(agent, env, seed=args.seed, max_steps=args.steps)
            else:
                # Windowed agent run: draw the first frame and wait for a manual interaction before
                # stepping, just like human play. play_episode resets again with the same seed
                # (deterministic), so this pre-roll changes nothing about the episode.
                window = HiDpiWindow()
                clock = pygame.time.Clock()
                env.reset(seed=args.seed)
                window.present(env)
                if not wait_for_start():
                    return 0

                def show_frame() -> None:
                    window.present(env)
                    clock.tick(WINDOW_FPS)

                score = play_episode(
                    agent, env, seed=args.seed, max_steps=args.steps, on_frame=show_frame
                )
        finally:
            env.close()

    print(f"seed {args.seed}: score {score:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
