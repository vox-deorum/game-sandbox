"""The 'closer' example agent: a Hearts player that exploits the last seat in a trick.

When you play last in a trick you have perfect information: all three other cards are already on the
table, so you know exactly which card is winning and whether the trick is safe to win. This agent
turns that into its one idea, playing very differently in the last seat than in any other:

- **Playing last** (three cards already down), read the trick. If you can still duck under the
  winner, shed your highest safe card. If every card you could follow with would win, winning is now
  unavoidable, so look at what you would take: a trick with no hearts and no queen is harmless and
  you should dump your *highest* card into it (offloading a dangerous king or ace for free); a trick
  that already holds points should be taken with your lowest winning card.
- **Playing earlier** (a card is still to come after you), fall back to safe, ``duck``-style play:
  lead low, duck under the winner when following, and unload your most dangerous card when void.

Reading the last seat is where Hearts points are quietly saved or spent, so concentrating the whole
policy there is a clean, legible idea. The example test asserts the signature behaviour: in the last
seat, forced to win a trick that carries no points, it dumps its highest card where ``duck`` clings
to its lowest.
"""

from __future__ import annotations

from typing import Any

NAME = "closer-hearts"

#: Suit ids (the high bits of the 0..51 card encoding) and the one 13-point card.
CLUBS, DIAMONDS, SPADES, HEARTS = 0, 1, 2, 3
QUEEN_OF_SPADES = 36


def _suit(card: int) -> int:
    return card // 13


def _rank(card: int) -> int:
    return card % 13


def _points(card: int) -> int:
    """Penalty points a card carries: 13 for the queen of spades, 1 per heart, else 0."""
    if card == QUEEN_OF_SPADES:
        return 13
    if _suit(card) == HEARTS:
        return 1
    return 0


def _dump(legal: list[int]) -> int:
    """Unload the most dangerous legal card when we cannot win the trick: queen, then high hearts."""
    if QUEEN_OF_SPADES in legal:
        return QUEEN_OF_SPADES
    hearts = [card for card in legal if _suit(card) == HEARTS]
    if hearts:
        return max(hearts, key=_rank)
    return max(legal, key=_rank)


class Agent:
    """Play safe in early seats; in the last seat, use full information to shed optimally."""

    def reset(self, seed: int) -> None:
        # Stateless heuristic: nothing to carry between or within games.
        pass

    def act(self, observation: Any) -> int:
        mask = observation["action_mask"]
        legal = [card for card in range(52) if mask[card]]
        state = observation["observation"]
        led = int(state["led_suit"][0])
        trick = [int(card) for card in state["trick"]]
        played = [card for card in trick if card != -1]

        # Last seat: three cards are down, so we see the whole trick before we commit.
        if led != -1 and len(played) == 3:
            followers = [card for card in legal if _suit(card) == led]
            if followers:
                winning_rank = max(_rank(card) for card in played if _suit(card) == led)
                under = [card for card in followers if _rank(card) < winning_rank]
                if under:
                    return max(under, key=_rank)
                # We must win this trick. If it carries no points, winning is free: dump our
                # highest card; otherwise take it with the lowest winning card.
                if all(_points(card) == 0 for card in played):
                    return max(followers, key=_rank)
                return min(followers, key=_rank)
            # Void in the last seat: we cannot win, so unload our most dangerous card.
            return _dump(legal)

        # Not last: play it safe, the duck way.
        if led == -1:
            return min(legal, key=lambda card: (_rank(card), _suit(card)))
        followers = [card for card in legal if _suit(card) == led]
        if followers:
            winning_rank = max((_rank(card) for card in played if _suit(card) == led), default=-1)
            under = [card for card in followers if _rank(card) < winning_rank]
            if under:
                return max(under, key=_rank)
            return min(followers, key=_rank)
        return _dump(legal)
