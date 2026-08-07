"""The 'closer' example agent: a Hearts player that exploits the last player in a trick.

When you play last in a trick you have perfect information: all three other cards are already on the
table, so you know exactly which card is winning and whether the trick is safe to win. This agent
turns that into its one idea, playing very differently in the last player position than in any other:

- **Playing last** (three cards already down), read the trick. If you can still duck under the
  winner, shed your highest safe card. If every card you could follow with would win, winning is now
  unavoidable, so look at what you would take: a trick with no hearts and no queen is harmless and
  you should dump your *highest* card into it (offloading a dangerous king or ace for free); a trick
  that already holds points should be taken with your lowest winning card.
- **Playing earlier** (a card is still to come after you), fall back to safe, ``duck``-style play:
  lead low, duck under the winner when following, and unload your most dangerous card when void.

Reading the last player position is where Hearts points are quietly saved or spent, so concentrating the whole
policy there is a clean, legible idea. The example test asserts the signature behaviour: in the last
player, forced to win a trick that carries no points, it dumps its highest card where ``duck`` clings
to its lowest.
"""

from __future__ import annotations

from sandbox.cards import (
    HEARTS,
    QUEEN_OF_SPADES,
    Card,
    HeartsObservation,
    card_points,
    current_trick,
    led_suit,
    legal_cards,
    play,
    rank_of,
    suit_of,
)

NAME = "closer-hearts"


def _dump(legal: list[Card]) -> int:
    """Unload the most dangerous legal card when we cannot win the trick: queen, then high hearts."""
    if QUEEN_OF_SPADES in legal:
        return play(QUEEN_OF_SPADES)
    hearts = [card for card in legal if suit_of(card) == HEARTS]
    if hearts:
        return play(max(hearts, key=rank_of))
    return play(max(legal, key=rank_of))


class Agent:
    """Play safe early; in the last player position, use full information to shed optimally."""

    def reset(self, seed: int) -> None:
        # Stateless heuristic: nothing to carry between or within games.
        pass

    def act(self, observation: HeartsObservation) -> int:
        legal = legal_cards(observation)
        led = led_suit(observation)
        played = [card for _, card in current_trick(observation)]

        # Last player: three cards are down, so we see the whole trick before we commit.
        if led is not None and len(played) == 3:
            followers = [card for card in legal if suit_of(card) == led]
            if followers:
                winning_rank = max(rank_of(card) for card in played if suit_of(card) == led)
                under = [card for card in followers if rank_of(card) < winning_rank]
                if under:
                    return play(max(under, key=rank_of))
                # We must win this trick. If it carries no points, winning is free: dump our
                # highest card; otherwise take it with the lowest winning card.
                if all(card_points(card) == 0 for card in played):
                    return play(max(followers, key=rank_of))
                return play(min(followers, key=rank_of))
            # Void in the last player position: we cannot win, so unload our most dangerous card.
            return _dump(legal)

        # Not last: play it safe, the duck way.
        if led is None:
            return play(min(legal, key=lambda card: (rank_of(card), suit_of(card))))
        followers = [card for card in legal if suit_of(card) == led]
        if followers:
            winning_rank = max((rank_of(card) for card in played if suit_of(card) == led), default=-1)
            under = [card for card in followers if rank_of(card) < winning_rank]
            if under:
                return play(max(under, key=rank_of))
            return play(min(followers, key=rank_of))
        return _dump(legal)
