"""Play one episode of your environment with your agent, locally, against vanilla PettingZoo.

    python play.py                 # render in a window
    python play.py --headless      # no window, just the score
    python play.py --seed 7        # pick the episode seed

This script touches nothing of the sandbox backend: it loads your agent through
``manifest.json``, builds the environment from the synced ``sandbox_env`` package, and runs
the same agent-environment cycle the server runs. The loop here is the contract — the server
wraps this exact stepping with timeouts, recording, and (for live play) pacing. It is
environment-agnostic: ``sandbox_env`` exports ``make_env`` and ``PLAYER_SLOT`` for whichever
environment this template targets.
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from pathlib import Path
from typing import Any

from sandbox_env import PLAYER_SLOT, make_env


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


def play_episode(agent: Any, env: Any, *, seed: int, max_steps: int | None = None) -> float:
    """Run one episode, returning the cumulative score. Shared by play, evaluate, and tests."""
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Play one episode locally.")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--headless", action="store_true", help="run without a render window")
    parser.add_argument("--steps", type=int, help="cap the episode at this many steps")
    args = parser.parse_args(argv)

    repo_root = Path(__file__).resolve().parent
    agent = load_agent(repo_root)
    env = make_env(render_mode=None if args.headless else "human")
    try:
        score = play_episode(agent, env, seed=args.seed, max_steps=args.steps)
    finally:
        env.close()

    print(f"seed {args.seed}: score {score:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
