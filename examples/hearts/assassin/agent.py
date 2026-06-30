"""The 'assassin' example agent: a Hearts player that hunts down the queen of spades.

The queen of spades is worth thirteen of the twenty-six penalty points in a hand, so a policy built
entirely around it goes a long way. This agent's one idea is to get rid of the queen, and of the
only two cards that can be forced to capture it (the king and ace of spades), as early and as safely
as possible, and to draw the queen out of opponents' hands by leading spades:

- **Leading**, lead your lowest spade below the queen, dragging spades onto the table so the queen
  has to come down; if you hold no such spade, lead your lowest card instead.
- **Following suit**, shed your highest card that still stays under the card winning the trick
  (dumping the king or ace of spades safely when spades are led); if every card you hold would win,
  play your lowest so a later seat can still overtake you.
- **Void** in the led suit, you cannot win, so unload your single most dangerous card: the queen of
  spades first, then the ace or king of spades, then your highest heart, then your highest card.

Leading spades while you may still hold the queen is a calculated risk, which is the point of the
agent: a sharp, one-idea policy rather than a balanced one. The example test asserts the signature
behaviour: given the lead, it opens with a low spade where ``duck`` would open with its lowest card
of any suit.
"""

from __future__ import annotations

from typing import Any

NAME = "assassin-hearts"

#: Suit ids (the high bits of the 0..51 card encoding) and the dangerous high spades.
CLUBS, DIAMONDS, SPADES, HEARTS = 0, 1, 2, 3
QUEEN_OF_SPADES = 36
KING_OF_SPADES = 37
ACE_OF_SPADES = 38


def _suit(card: int) -> int:
    return card // 13


def _rank(card: int) -> int:
    return card % 13


class Agent:
    """Flush out and dump the queen of spades and the high spades that can capture it."""

    def reset(self, seed: int) -> None:
        # Stateless heuristic: nothing to carry between or within games.
        pass

    def act(self, observation: Any) -> int:
        mask = observation["action_mask"]
        legal = [card for card in range(52) if mask[card]]
        state = observation["observation"]
        led = int(state["led_suit"][0])
        trick = [int(card) for card in state["trick"]]

        # Leading: drag spades out so the queen must fall, but never lead the queen or a high
        # spade ourselves; if we hold no safe low spade, lead our lowest card instead.
        if led == -1:
            low_spades = [
                card for card in legal if _suit(card) == SPADES and _rank(card) < _rank(QUEEN_OF_SPADES)
            ]
            if low_spades:
                return min(low_spades, key=_rank)
            return min(legal, key=lambda card: (_rank(card), _suit(card)))

        followers = [card for card in legal if _suit(card) == led]
        if followers:
            winning_rank = max(
                (_rank(card) for card in trick if card != -1 and _suit(card) == led),
                default=-1,
            )
            under = [card for card in followers if _rank(card) < winning_rank]
            if under:
                # Stay under the winner, shedding our highest safe card (a high spade when led).
                return max(under, key=_rank)
            # We cannot duck; keep our lowest so a later seat can still overtake us.
            return min(followers, key=_rank)

        # Void: dump the most dangerous card, queen and high spades first.
        for dangerous in (QUEEN_OF_SPADES, ACE_OF_SPADES, KING_OF_SPADES):
            if dangerous in legal:
                return dangerous
        hearts = [card for card in legal if _suit(card) == HEARTS]
        if hearts:
            return max(hearts, key=_rank)
        return max(legal, key=_rank)
