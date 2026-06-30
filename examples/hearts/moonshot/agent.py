"""The 'moonshot' example agent: an aggressive Hearts player that tries to shoot the moon.

Shooting the moon means taking *every* penalty card in a hand, all thirteen hearts and the queen
of spades. Instead of the usual 26 penalty points that wrecks a score, the seat that takes all of
them scores 0 and each of the other three takes 26. This agent commits to that high-risk line: it
tries to win every trick it can so the points flow to it rather than away from it. It is the
deliberate opposite of the points-avoiding ``duck``:

- **Leading**, play your highest legal card, so the trick you open is hard for a later seat to beat.
- **Following suit**, if you can still beat the card winning the trick, play your highest card of
  the led suit and take it; if you cannot beat it you cannot win this trick, so play your lowest
  card of the suit and keep your high cards for a trick you can win.
- **Void** in the led suit, you cannot win this trick, so do not spill points into it: play your
  lowest non-point card, hoarding your hearts and the queen for tricks you take yourself.

The moon rarely comes off against careful opponents, since a single stray point card landing on
another seat ruins it, so this is a showcase of an aggressive idea rather than a strong policy. The
example test asserts the signature behaviour: when it can win a trick by following suit it plays
high to take it, where ``duck`` would shed low.
"""

from __future__ import annotations

from typing import Any

NAME = "moonshot-hearts"

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


class Agent:
    """Try to win every trick and collect all the points, shooting for the moon."""

    def reset(self, seed: int) -> None:
        # Stateless heuristic: nothing to carry between or within games.
        pass

    def act(self, observation: Any) -> int:
        mask = observation["action_mask"]
        legal = [card for card in range(52) if mask[card]]
        state = observation["observation"]
        led = int(state["led_suit"][0])
        trick = [int(card) for card in state["trick"]]

        # Leading: open with our highest card, hard for a later seat to overtake.
        if led == -1:
            return max(legal, key=lambda card: (_rank(card), _suit(card)))

        followers = [card for card in legal if _suit(card) == led]
        if followers:
            winning_rank = max(
                (_rank(card) for card in trick if card != -1 and _suit(card) == led),
                default=-1,
            )
            winners = [card for card in followers if _rank(card) > winning_rank]
            if winners:
                # We can take the trick: play the highest card of the suit and win it.
                return max(winners, key=_rank)
            # We cannot beat the current winner; lose cheaply and keep our high cards.
            return min(followers, key=_rank)

        # Void: we cannot win this trick, so refuse to feed it points.
        non_points = [card for card in legal if _points(card) == 0]
        pool = non_points if non_points else legal
        return min(pool, key=lambda card: (_rank(card), _suit(card)))
