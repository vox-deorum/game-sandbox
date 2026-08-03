"""A tiny command-line replay surface for the pure tactical rules engine."""

from __future__ import annotations

import argparse
from collections.abc import Callable

from .engine import Match, MatchConfig, Order


def render(match: Match, *, round_number: int | None = None) -> str:
    marks = {unit.position: unit.side[0].upper() for unit in match.units.values()}
    rows: list[str] = [
        f"round {round_number or match.round}  red={match.capture_scores['red']} "
        f"blue={match.capture_scores['blue']}"
    ]
    for r, row in enumerate(match.battlefield.array):
        cells = []
        for q, tile in enumerate(row):
            position = (q, r)
            if position in marks:
                cells.append(marks[position])
            elif tile.terrain == "void":
                cells.append(" ")
            elif tile.terrain == "water":
                cells.append("~")
            elif tile.terrain == "hill":
                cells.append("^")
            elif tile.feature == "forest":
                cells.append("f")
            elif tile.feature == "marsh":
                cells.append("m")
            else:
                cells.append(".")
        rows.append("".join(cells).rstrip())
    return "\n".join(rows)


def run_scripted_match(
    config: MatchConfig,
    orders: Callable[[Match, str], Order] | dict[str, Order] | None = None,
) -> tuple[Match, str]:
    """Run to completion and render exactly once after each completed round."""
    match = Match(config)
    frames: list[str] = []
    source = orders or {}
    while match.result is None:
        completed_round = match.round
        while match.result is None and match.round == completed_round:
            unit_id = match.current_unit_id
            assert unit_id is not None
            order = source(match, unit_id) if callable(source) else source.get(unit_id, Order())
            match.apply_order(order)
        frames.append(render(match, round_number=completed_round))
    return match, "\n\n".join(frames)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a deterministic tactical replay.")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--seat-plan", choices=("skirmish", "army"), default="skirmish")
    parser.add_argument("--round-cap", type=int, default=100)
    arguments = parser.parse_args()
    config = MatchConfig(
        seed=arguments.seed,
        seat_plan=arguments.seat_plan,
        terrain=True,
        unit_abilities=True,
        messages=True,
        capture_zones=3,
        round_cap=arguments.round_cap,
    )
    match, transcript = run_scripted_match(config)
    print(transcript)
    print(match.result)


if __name__ == "__main__":
    main()
