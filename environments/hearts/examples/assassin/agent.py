"""The 'assassin' example agent: a Hearts player that hunts down the queen of spades.

The queen of spades is worth thirteen of the twenty-six penalty points in a hand, so a policy built
entirely around it goes a long way. This agent's one idea is to get rid of the queen, and of the
only two cards that can be forced to capture it (the king and ace of spades), as early and as safely
as possible, and to draw the queen out of opponents' hands by leading spades:

- **Leading**, lead your lowest spade below the queen, dragging spades onto the table so the queen
  has to come down; if you hold no such spade, lead your lowest card instead.
- **Following suit**, shed your highest card that still stays under the card winning the trick
  (dumping the king or ace of spades safely when spades are led); if every card you hold would win,
  play your lowest so a later player can still overtake you.
- **Void** in the led suit, you cannot win, so unload your single most dangerous card: the queen of
  spades first, then the ace or king of spades, then your highest heart, then your highest card.

Leading spades while you may still hold the queen is a calculated risk, which is the point of the
agent: a sharp, one-idea policy rather than a balanced one. The example test asserts the signature
behaviour: given the lead, it opens with a low spade where ``duck`` would open with its lowest card
of any suit.
"""

from __future__ import annotations

from typing import Any

from sandbox.cards import (
    HEARTS,
    QUEEN_OF_SPADES,
    SPADES,
    current_trick,
    led_suit,
    legal_cards,
    make_card,
    play,
    rank_of,
    suit_of,
)

NAME = "assassin-hearts"

#: The two spades that can be forced to capture the queen (face ranks 13 and 14 are the king and ace).
KING_OF_SPADES = make_card(SPADES, 13)
ACE_OF_SPADES = make_card(SPADES, 14)


class Agent:
    """Flush out and dump the queen of spades and the high spades that can capture it."""

    def reset(self, seed: int) -> None:
        # Stateless heuristic: nothing to carry between or within games.
        pass

    def act(self, observation: Any) -> int:
        legal = legal_cards(observation)
        led = led_suit(observation)

        # Leading: drag spades out so the queen must fall, but never lead the queen or a high
        # spade ourselves; if we hold no safe low spade, lead our lowest card instead.
        if led is None:
            low_spades = [
                card for card in legal if suit_of(card) == SPADES and rank_of(card) < rank_of(QUEEN_OF_SPADES)
            ]
            if low_spades:
                return play(min(low_spades, key=rank_of))
            return play(min(legal, key=lambda card: (rank_of(card), suit_of(card))))

        followers = [card for card in legal if suit_of(card) == led]
        if followers:
            winning_rank = max(
                (rank_of(card) for _, card in current_trick(observation) if suit_of(card) == led),
                default=-1,
            )
            under = [card for card in followers if rank_of(card) < winning_rank]
            if under:
                # Stay under the winner, shedding our highest safe card (a high spade when led).
                return play(max(under, key=rank_of))
            # We cannot duck; keep our lowest so a later player can still overtake us.
            return play(min(followers, key=rank_of))

        # Void: dump the most dangerous card, queen and high spades first.
        for dangerous in (QUEEN_OF_SPADES, ACE_OF_SPADES, KING_OF_SPADES):
            if dangerous in legal:
                return play(dangerous)
        hearts = [card for card in legal if suit_of(card) == HEARTS]
        if hearts:
            return play(max(hearts, key=rank_of))
        return play(max(legal, key=rank_of))
