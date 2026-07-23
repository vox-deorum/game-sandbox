"""Render-data extraction for Spades.

The renderer never sees the live :class:`~spades.env.SpadesEnv`; it draws from the per-step overlay
produced here. This module reaches into ``env.state`` (a :class:`spades.rules.SpadesState`) and
flattens it into a plain JSON-serializable dict (ints, bools, lists, dicts and ``None`` only), with
every card turned into a semantic ``{"suit","rank"}`` object and every ``(seat, card)`` trick pair
turned into a ``{"seat","card"}`` object, in play order. No numpy and no tuples survive, so the
result round-trips through ``json`` unchanged. All scoring questions are delegated to
:mod:`spades.rules` so the overlay never disagrees with the environment.
"""

from __future__ import annotations

import importlib
from typing import TYPE_CHECKING, Any

from . import rules


def _shared_card_utils() -> Any:
    """Return the shared :mod:`card_utils` under whichever name this file runs as.

    One source syncs into two layouts: :mod:`local_play.card_utils` inside the environments package,
    ``sandbox.card_utils`` in a composed template. Mirrors ``spades.rules._shared_card_utils`` /
    ``spades.env._shared_card_modules``.
    """
    for candidate in ("local_play.card_utils", "sandbox.card_utils"):
        try:
            return importlib.import_module(candidate)
        except ModuleNotFoundError as exc:
            missing = exc.name or ""
            if missing == candidate or candidate.startswith(f"{missing}."):
                continue
            raise
    raise ModuleNotFoundError("no shared card_utils found (tried local_play.card_utils, sandbox.card_utils)")


if TYPE_CHECKING:  # pyright sees the real module; this branch never executes at runtime
    from local_play import card_utils as _cu
else:
    _cu = _shared_card_utils()

card_to_obj = _cu.card_to_obj


def _trick_objs(trick: list[tuple[int, int]]) -> list[dict[str, Any]]:
    """Return ``trick`` (``(seat, card)`` pairs) as play-ordered ``{"seat","card"}`` objects."""
    return [{"seat": int(s), "card": card_to_obj(c)} for s, c in trick]


def extract_overlay(env: Any) -> dict[str, Any]:
    """Return the per-step overlay dict from a live :class:`~spades.env.SpadesEnv`.

    The returned dict is fully JSON-serializable (ints, bools, lists, dicts, ``None``): cards
    become ``{"suit","rank"}`` objects and trick pairs become play-ordered ``{"seat","card"}``
    objects. It carries both the play state and everything the badges/score line draw: per-seat
    ``bids`` (``-1`` until a seat has bid) and ``tricks_won``, and three views of the score for two
    surfaces. The two-element ``team_scores`` feeds the browser renderer. The per-seat
    ``display_scores`` and ``leaderboard_scores``
    (each seat carrying its team's score, so partners share) feed the browser game-over standings,
    which ranks seats by ``leaderboard_scores`` and shows ``display_scores``; the two are equal for
    Spades, kept as a pair so the overlay matches the Hearts shape that surface also consumes.
    ``legal_cards``/``legal_bids`` are the phase-legal sets for the seat on turn, both empty once
    the hand is terminal, and are what the browser renderer greys from.
    """
    state = env.state
    terminal = rules.is_terminal(state)
    bidding = rules.in_bidding(state)

    return {
        "phase": "bidding" if bidding else "play",
        "hands": [[card_to_obj(c) for c in state.hands[s]] for s in range(rules.NUM_PLAYERS)],
        # The overlay keeps the engine's raw sentinels (bids -1 = unbid, led_suit None = none led);
        # the agent OBSERVATION remaps these to in-range Discrete values (spades.env.UNBID = 14,
        # led_suit = 4). Same facts, two encodings for two different consumers.
        "bids": [int(b) for b in state.bids],
        "current_trick": _trick_objs(state.current_trick),
        "last_trick": (None if state.last_trick is None else _trick_objs(state.last_trick)),
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
        "legal_cards": (
            [] if terminal or bidding else [card_to_obj(c) for c in rules.legal_plays(state, state.turn)]
        ),
        "legal_bids": ([] if terminal or not bidding else list(rules.legal_bids(state, state.turn))),
        "terminal": terminal,
    }
