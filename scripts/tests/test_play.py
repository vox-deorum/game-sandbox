"""Tests for the local play launcher's game-over standings (``scripts/play.py``).

The one behaviour pinned here is the dense, tie-aware medal ranking: in a partnership game both
partners share a leaderboard score by construction, so the winning pair must both show gold and the
losing pair both silver, rather than being split by row position.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import cast

from game_sandbox_harness.environment import EnvironmentEntry

# The dev scripts are run as top-level modules (scripts/ on sys.path), so mirror that here.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import play  # noqa: E402


class _FakeEntry:
    """Minimal stand-in exposing only the ``overlay`` hook ``_standings`` reads.

    ``_standings`` touches nothing else on the entry, so the tests pass this (via ``cast``) where a
    full :class:`EnvironmentEntry` is annotated rather than building one with a real meta/make.
    """

    def __init__(self, display_scores: list[int]) -> None:
        self._display_scores = display_scores

    def overlay(self, env: object) -> dict:
        return {"display_scores": self._display_scores}


def test_standings_award_dense_tie_aware_medals_to_a_partnership():
    # Team 0 (seats 0 & 2) both scored 52; team 1 (seats 1 & 3) both scored -70.
    scores = {"player_0": 52.0, "player_1": -70.0, "player_2": 52.0, "player_3": -70.0}
    display = [52, -70, 52, -70]

    rows = play._standings(cast(EnvironmentEntry, _FakeEntry(display)), object(), scores)

    labels = [label for label, _value, _cup in rows]
    cups = [cup for _label, _value, cup in rows]
    values = [value for _label, value, _cup in rows]

    # Best-first: the winning partnership, then the losing one.
    assert set(labels[:2]) == {"P0", "P2"}
    assert set(labels[2:]) == {"P1", "P3"}
    # Dense ranking: the tied winners share gold (rank 0), the tied losers share silver (rank 1).
    assert cups == [0, 0, 1, 1]
    # The displayed value is each seat's team score, read from the overlay.
    assert values == ["52", "52", "-70", "-70"]


def test_standings_rank_distinct_scores_without_gaps():
    # Four distinct scores: dense ranks 0,1,2,3, and only the top three (0,1,2) get a trophy.
    scores = {"player_0": 5.0, "player_1": 3.0, "player_2": 1.0, "player_3": -2.0}
    display = [5, 3, 1, -2]

    rows = play._standings(cast(EnvironmentEntry, _FakeEntry(display)), object(), scores)

    assert [label for label, _v, _c in rows] == ["P0", "P1", "P2", "P3"]
    assert [cup for _l, _v, cup in rows] == [0, 1, 2, None]
