"""Evaluate your agent over seeded headless episodes.

This command deliberately reuses ``sandbox.play.run_headless``. Evaluation therefore shares the
same injected environment entry, agent loader, timeout accounting, and legal default-action behavior
as browser local play without starting the loopback relay. ``--vs`` flows through to the same seat
filling as ``python -m sandbox play``.
"""

from __future__ import annotations

import argparse

from sandbox import play
from sandbox.harness.environment import resolve_parameters
from sandbox.play import parse_rival, run_headless
from sandbox.season import announce, load_season_settings, parse_parameter_overrides


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate the agent over seeded episodes.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--seeds", type=int, nargs="+", help="explicit list of seeds")
    group.add_argument("--episodes", type=int, default=5, help="run seeds 0..N-1 (default 5)")
    parser.add_argument("--player", type=int, default=0, help="player index to evaluate (default 0)")
    parser.add_argument(
        "--vs",
        metavar="PATH",
        help="play against the agent saved in PATH, a folder holding that agent's manifest.json",
    )
    parser.add_argument(
        "--parameter",
        action="append",
        default=[],
        metavar="NAME=VALUE",
        help="typed environment parameter override; repeat for several values",
    )
    parser.add_argument("--decision-limit-ms", type=int, help="override the agent decision limit")
    parser.add_argument("--game-limit-ms", type=int, help="override the game time limit")
    args = parser.parse_args(argv)
    try:
        season = load_season_settings(play.REPO_ROOT, play.META)
        parameter_overrides = parse_parameter_overrides(play.META, args.parameter)
        parameters = resolve_parameters(
            play.META, {} if season is None else season.parameters, parameter_overrides
        )
    except ValueError as error:
        parser.error(str(error))
    if args.decision_limit_ms is not None and args.decision_limit_ms <= 0:
        parser.error("--decision-limit-ms must be positive")
    if args.game_limit_ms is not None and args.game_limit_ms <= 0:
        parser.error("--game-limit-ms must be positive")
    decision_limit_ms = (
        args.decision_limit_ms
        if args.decision_limit_ms is not None
        else None
        if season is None
        else season.decision_limit_ms
    )
    game_limit_ms = (
        args.game_limit_ms
        if args.game_limit_ms is not None
        else None
        if season is None
        else season.game_limit_ms
    )
    announce(season)
    player_ids = play.possible_players(parameters)
    if args.player < 0 or args.player >= len(player_ids):
        parser.error(f"--player must name one of 0..{len(player_ids) - 1}")
    rival = parse_rival(parser, args.vs, parameters)

    seeds = args.seeds if args.seeds is not None else list(range(args.episodes))
    scores: list[float] = []
    for seed in seeds:
        score = run_headless(
            seed=seed,
            max_steps=None,
            player=args.player,
            vs=rival,
            parameters=parameters,
            decision_limit_ms=decision_limit_ms,
            game_limit_ms=game_limit_ms,
        )
        scores.append(score)
        print(f"seed {seed}: score {score:.2f}")

    mean = sum(scores) / len(scores) if scores else 0.0
    print(f"mean over {len(scores)} episode(s): {mean:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
