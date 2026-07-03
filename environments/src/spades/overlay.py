"""Render-data extraction for Spades.

The renderer never sees the live :class:`~spades.env.SpadesEnv`; it draws from the per-step overlay
produced here. This module reaches into ``env.state`` (a :class:`spades.rules.SpadesState`) and
flattens it into a plain JSON-serializable dict (ints, bools, lists and ``None`` only), with every
``(seat, card)`` trick pair turned into a ``[seat, card]`` list. No numpy and no tuples survive, so
the result round-trips through ``json`` unchanged. All scoring questions are delegated to
:mod:`spades.rules` so the overlay never disagrees with the environment.
"""

from __future__ import annotations

from typing import Any

from . import rules


def extract_overlay(env: Any) -> dict[str, Any]:
    """Return the per-step overlay dict from a live :class:`~spades.env.SpadesEnv`.

    The returned dict is fully JSON-serializable (ints, bools, lists, ``None``): trick pairs become
    ``[seat, card]`` lists. It carries both the play state and everything the badges/score line
    draw: per-seat ``bids`` (``-1`` until a seat has bid) and ``tricks_won``, the two
    ``team_scores``, and the per-seat ``display_scores`` / ``leaderboard_scores`` (each seat's team
    score, so partners share). ``legal_actions`` is the phase-legal action set for the seat on turn,
    empty once the hand is terminal, and it is what both renderers grey from.
    """
    state = env.state

    return {
        "phase": "bidding" if rules.in_bidding(state) else "play",
        "hands": [[int(c) for c in state.hands[s]] for s in range(rules.NUM_PLAYERS)],
        "bids": [int(b) for b in state.bids],
        "current_trick": [[int(s), int(c)] for s, c in state.current_trick],
        "last_trick": (None if state.last_trick is None else [[int(s), int(c)] for s, c in state.last_trick]),
        "last_trick_winner": state.last_trick_winner,
        "turn": int(state.turn),
        "turn_slot": env.possible_agents[state.turn],
        "trick_leader": int(state.trick_leader),
        "led_suit": rules.led_suit(state),
        "spades_broken": bool(state.spades_broken),
        "tricks_played": int(state.tricks_played),
        "tricks_won": [int(t) for t in state.tricks_won],
        "team_scores": rules.hand_team_scores(state),
        "display_scores": rules.display_scores(state),
        "leaderboard_scores": rules.leaderboard_scores(state),
        "legal_actions": ([] if rules.is_terminal(state) else rules.legal_actions(state, state.turn)),
        "terminal": rules.is_terminal(state),
    }
