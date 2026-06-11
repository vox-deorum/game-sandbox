"""Evaluate your agent over several seeded episodes, headless, and print the scores.

    python evaluate.py                  # default seeds
    python evaluate.py --seeds 0 1 2 3  # pick the seeds
    python evaluate.py --episodes 10    # seeds 0..9

This is the same controlled-repetition shape the leaderboard uses: every episode is seeded,
so your local mean predicts your board number. It never renders and never touches the
backend.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from play import load_agent, play_episode
from sandbox_env import make_env


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate the agent over seeded episodes.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--seeds", type=int, nargs="+", help="explicit list of seeds")
    group.add_argument("--episodes", type=int, default=5, help="run seeds 0..N-1 (default 5)")
    args = parser.parse_args(argv)

    seeds = args.seeds if args.seeds is not None else list(range(args.episodes))
    repo_root = Path(__file__).resolve().parent
    agent = load_agent(repo_root)

    scores: list[float] = []
    for seed in seeds:
        env = make_env(render_mode=None)
        try:
            score = play_episode(agent, env, seed=seed)
        finally:
            env.close()
        scores.append(score)
        print(f"seed {seed}: score {score:.2f}")

    mean = sum(scores) / len(scores) if scores else 0.0
    print(f"mean over {len(scores)} episode(s): {mean:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
