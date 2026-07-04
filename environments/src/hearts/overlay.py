"""Render-data extraction for Hearts.

The renderer never sees the live :class:`~hearts.env.HeartsEnv`; it draws from the per-step
overlay produced here. This module reaches into ``env.state`` (a :class:`hearts.rules.HeartsState`)
and flattens it into a plain JSON-serializable dict — ints, bools, lists and ``None`` only, with
every ``(seat, card)`` trick pair turned into a ``[seat, card]`` list. No numpy and no tuples
survive, so the result round-trips through ``json`` unchanged. All scoring questions are
delegated to :mod:`hearts.rules` so the overlay never disagrees with the environment.
"""

from __future__ import annotations

from typing import Any

from . import rules


def extract_overlay(env: Any) -> dict[str, Any]:
    """Return the per-step overlay dict from a live :class:`~hearts.env.HeartsEnv`.

    The returned dict is fully JSON-serializable (ints, bools, lists, ``None``): trick pairs
    become ``[seat, card]`` lists. ``display_scores`` are penalties (lower better), read by the
    local pygame renderer and shown per seat by the browser game-over standings;
    ``leaderboard_scores`` are their negation (higher better), which that browser standings ranks
    seats by. ``legal_actions`` is empty once the hand is terminal.
    """
    state = env.state

    return {
        "hands": [[int(c) for c in state.hands[s]] for s in range(rules.NUM_PLAYERS)],
        "current_trick": [[int(s), int(c)] for s, c in state.current_trick],
        "last_trick": (None if state.last_trick is None else [[int(s), int(c)] for s, c in state.last_trick]),
        "last_trick_winner": state.last_trick_winner,
        "turn": int(state.turn),
        "turn_slot": env.possible_agents[state.turn],
        "trick_leader": int(state.trick_leader),
        "led_suit": rules.led_suit(state),
        "hearts_broken": bool(state.hearts_broken),
        "tricks_played": int(state.tricks_played),
        "display_scores": rules.penalty_scores(state),
        "leaderboard_scores": rules.leaderboard_scores(state),
        "legal_actions": ([] if rules.is_terminal(state) else rules.legal_moves(state, state.turn)),
        "terminal": rules.is_terminal(state),
    }
