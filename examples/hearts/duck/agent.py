"""The 'duck' example agent: a points-avoiding Hearts player.

It overrides the template's placeholder ``agent.py``. The policy is one idea — never take points
you can avoid — turned into three rules over the legal-move mask:

- **Leading**, play your lowest card, so you are unlikely to win the trick.
- **Following suit**, "duck": play the highest card that still stays *under* the card currently
  winning the trick (shedding a high card safely). If every card you could follow with would win,
  play your lowest so a later seat can still overtake you.
- **Void** in the led suit, you cannot win the trick, so unload your most dangerous card — the
  queen of spades first, then your highest heart, then your highest card.

That last rule is the clear win over the built-in baseline, which always plays its lowest legal
card and so clings to the queen and high hearts until they are forced onto it. The example test
asserts this agent takes fewer points than that baseline across seeds.

It also uses the extra pinned dependency ``wcwidth`` (declared in ``requirements.extra.txt``) in a
trivial display helper, so the dependency-set extension path stays exercised end to end.
"""

from __future__ import annotations

from typing import Any

from wcwidth import wcswidth

NAME = "duck-hearts"

#: Suit ids (the high bits of the 0..51 card encoding) and the one 13-point card.
CLUBS, DIAMONDS, SPADES, HEARTS = 0, 1, 2, 3
QUEEN_OF_SPADES = 36


def _suit(card: int) -> int:
    return card // 13


def _rank(card: int) -> int:
    return card % 13


class Agent:
    """Avoid taking points: duck under tricks, and when void dump the most dangerous card."""

    def reset(self, seed: int) -> None:
        # Stateless heuristic: nothing to carry between or within games.
        pass

    def act(self, observation: Any) -> int:
        mask = observation["action_mask"]
        legal = [card for card in range(52) if mask[card]]
        state = observation["observation"]
        led = int(state["led_suit"][0])
        trick = [int(card) for card in state["trick"]]

        # Leading: play the lowest card so we are unlikely to win this trick.
        if led == -1:
            return min(legal, key=lambda card: (_rank(card), _suit(card)))

        followers = [card for card in legal if _suit(card) == led]
        if followers:
            played = [card for card in trick if card != -1 and _suit(card) == led]
            winning_rank = max((_rank(card) for card in played), default=-1)
            under = [card for card in followers if _rank(card) < winning_rank]
            if under:
                # Stay under the current winner, shedding our highest safe card of the suit.
                return max(under, key=_rank)
            # We cannot duck — keep our lowest so a later seat can still overtake us.
            return min(followers, key=_rank)

        # Void in the led suit: we cannot win this trick, so unload the most dangerous card.
        if QUEEN_OF_SPADES in legal:
            return QUEEN_OF_SPADES
        hearts = [card for card in legal if _suit(card) == HEARTS]
        if hearts:
            return max(hearts, key=_rank)
        return max(legal, key=_rank)


def display_width(text: str = NAME) -> int:
    """Display width of ``text``, computed via the extra dependency (wcwidth)."""
    return wcswidth(text)
