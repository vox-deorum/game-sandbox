"""The 'duck' example agent: a points-avoiding Hearts player.

It overrides the template's placeholder ``agent.py``. The policy is one idea — never take points
you can avoid — turned into three rules over the legal-move mask:

- **Leading**, play your lowest card, so you are unlikely to win the trick.
- **Following suit**, "duck": play the highest card that still stays *under* the card currently
  winning the trick (shedding a high card safely). If every card you could follow with would win,
  play your lowest so a later player can still overtake you.
- **Void** in the led suit, you cannot win the trick, so unload your most dangerous card — the
  queen of spades first, then your highest heart, then your highest card.

That last rule is the clear win over the built-in baseline, which always plays its lowest legal
card and so clings to the queen and high hearts until they are forced onto it. The example test
asserts this agent takes fewer points than that baseline across seeds.

It also uses the extra pinned dependency ``wcwidth`` (declared in ``requirements.extra.txt``) in a
trivial display helper, so the dependency-set extension path stays exercised end to end.
"""

from __future__ import annotations

from sandbox.cards import (
    HEARTS,
    QUEEN_OF_SPADES,
    HeartsObservation,
    current_trick,
    led_suit,
    legal_cards,
    play,
    rank_of,
    suit_of,
)
from wcwidth import wcswidth

NAME = "duck-hearts"


class Agent:
    """Avoid taking points: duck under tricks, and when void dump the most dangerous card."""

    def reset(self, seed, observation) -> None:
        # Stateless heuristic: nothing to carry between or within games.
        pass

    def act(self, observation: HeartsObservation) -> int:
        legal = legal_cards(observation)
        led = led_suit(observation)

        # Leading: play the lowest card so we are unlikely to win this trick.
        if led is None:
            return play(min(legal, key=lambda card: (rank_of(card), suit_of(card))))

        followers = [card for card in legal if suit_of(card) == led]
        if followers:
            played = [card for _, card in current_trick(observation) if suit_of(card) == led]
            winning_rank = max((rank_of(card) for card in played), default=-1)
            under = [card for card in followers if rank_of(card) < winning_rank]
            if under:
                # Stay under the current winner, shedding our highest safe card of the suit.
                return play(max(under, key=rank_of))
            # We cannot duck. Keep our lowest so a later player can still overtake us.
            return play(min(followers, key=rank_of))

        # Void in the led suit: we cannot win this trick, so unload the most dangerous card.
        if QUEEN_OF_SPADES in legal:
            return play(QUEEN_OF_SPADES)
        hearts = [card for card in legal if suit_of(card) == HEARTS]
        if hearts:
            return play(max(hearts, key=rank_of))
        return play(max(legal, key=rank_of))


def display_width(text: str = NAME) -> int:
    """Display width of ``text``, computed via the extra dependency (wcwidth)."""
    return wcswidth(text)
