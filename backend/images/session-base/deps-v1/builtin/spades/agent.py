"""The frozen v1 built-in Spades agent: the Naive baseline.

It plays exactly the move the environment's own timeout default applies (``spades.rules`` — a
never-nil ``suggested_bid`` during the bidding round, the lowest legal card during play), so a
Naive-filled table behaves identically to a table of timed-out seats. The bid is a plain high-card
count: the high spades (queen, king, ace) plus extra spade length, off-suit aces, and guarded
off-suit kings, floored at one so it never silently commits the partnership to a nil. In play it
clings to its lowest card every turn, the weak baseline a submitted agent is expected to beat (see
``environments/spades/examples/counter``).

It reads the Spades observation dict's ``action_mask`` and its semantic ``hand`` (a sequence of
``{"suit", "rank"}`` card objects, rank a face value 2..14), so it needs no dependency beyond the
standard library. The bid estimate below compares on the *engine* rank index (queen = 10), so the
object hand is decoded back to the ``suit * 13 + (rank - 2)`` engine card id before it is counted.
"""

from __future__ import annotations

from typing import Any

#: Action layout of the combined Discrete(66) space: cards 0..51, then bids as 52 + k.
_NUM_CARDS = 52
#: Suit ids are the high bits of the card encoding: card = suit * 13 + rank.
_SPADES = 2


def _suit(card: int) -> int:
    return card // 13


def _rank(card: int) -> int:
    return card % 13


class Agent:
    """Bid a never-nil suggested count, then play the lowest legal card (the env's timeout default)."""

    def reset(self, seed: int) -> None:
        # Stateless: every legality question is answered by the per-step action mask.
        pass

    def act(self, observation: Any) -> int:
        mask = observation["action_mask"]
        # Any legal bid action (index >= 52) means it is the bidding round; otherwise it is play.
        if any(mask[action] for action in range(_NUM_CARDS, len(mask))):
            # The observation hand is a sequence of {"suit", "rank"} objects (face-value rank); decode
            # each back to its engine card id so _suggested_bid counts on the engine rank index.
            hand = [c["suit"] * 13 + (c["rank"] - 2) for c in observation["observation"]["hand"]]
            return _NUM_CARDS + _suggested_bid(hand)
        # Play: the lowest legal card (lowest rank, ties broken by the lower suit id).
        return min((card for card in range(_NUM_CARDS) if mask[card]), key=lambda c: (_rank(c), _suit(c)))


def _suggested_bid(hand: list[int]) -> int:
    """A deterministic, never-nil trick estimate for ``hand`` (mirrors ``spades.rules.suggested_bid``).

    High spades (queen, king, ace) and off-suit aces are near-certain tricks, guarded off-suit kings
    usually are, and every spade beyond a holding of three tends to win by length. Floored at one so a
    timeout never commits a partnership to a nil, and capped at thirteen.

    This image cannot import ``spades.rules``, so the estimate is vendored verbatim. It is pinned to
    its source over many hands by ``test_builtin_suggested_bid_matches_the_rules_engine`` in
    ``environments/spades/tests/test_spades.py``, which fails if this copy drifts from ``suggested_bid``.
    """
    estimate = 0
    spades = [card for card in hand if _suit(card) == _SPADES]
    estimate += sum(1 for card in spades if _rank(card) >= 10)
    estimate += max(0, len(spades) - 3)
    for suit in (0, 1, 3):
        suited = [card for card in hand if _suit(card) == suit]
        estimate += sum(1 for card in suited if _rank(card) == 12)
        estimate += sum(1 for card in suited if _rank(card) == 11 and len(suited) >= 2)
    return max(1, min(13, estimate))
