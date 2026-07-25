"""Evaluate your agent over seeded headless harness episodes.

This command deliberately reuses ``sandbox.play.run_headless``. Evaluation therefore shares the
same injected environment entry, agent loader, timeout accounting, and legal default-action behavior
as browser local play without starting the loopback relay.
"""

from __future__ import annotations

import argparse

from sandbox.play import run_headless


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate the agent over seeded episodes.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--seeds", type=int, nargs="+", help="explicit list of seeds")
    group.add_argument("--episodes", type=int, default=5, help="run seeds 0..N-1 (default 5)")
    parser.add_argument("--player", type=int, default=0, help="player index to evaluate (default 0)")
    args = parser.parse_args(argv)

    seeds = args.seeds if args.seeds is not None else list(range(args.episodes))
    scores: list[float] = []
    for seed in seeds:
        score = run_headless(seed=seed, max_steps=None, player=args.player)
        scores.append(score)
        print(f"seed {seed}: score {score:.2f}")

    mean = sum(scores) / len(scores) if scores else 0.0
    print(f"mean over {len(scores)} episode(s): {mean:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
