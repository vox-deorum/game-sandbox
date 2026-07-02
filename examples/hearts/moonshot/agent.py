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

from sandbox.cards import card_points, current_trick, led_suit, legal_cards, rank_of, suit_of

NAME = "moonshot-hearts"


class Agent:
    """Try to win every trick and collect all the points, shooting for the moon."""

    def reset(self, seed: int) -> None:
        # Stateless heuristic: nothing to carry between or within games.
        pass

    def act(self, observation: Any) -> int:
        legal = legal_cards(observation)
        led = led_suit(observation)

        # Leading: open with our highest card, hard for a later seat to overtake.
        if led is None:
            return max(legal, key=lambda card: (rank_of(card), suit_of(card)))

        followers = [card for card in legal if suit_of(card) == led]
        if followers:
            winning_rank = max(
                (rank_of(card) for _, card in current_trick(observation) if suit_of(card) == led),
                default=-1,
            )
            winners = [card for card in followers if rank_of(card) > winning_rank]
            if winners:
                # We can take the trick: play the highest card of the suit and win it.
                return max(winners, key=rank_of)
            # We cannot beat the current winner; lose cheaply and keep our high cards.
            return min(followers, key=rank_of)

        # Void: we cannot win this trick, so refuse to feed it points.
        non_points = [card for card in legal if card_points(card) == 0]
        pool = non_points if non_points else legal
        return min(pool, key=lambda card: (rank_of(card), suit_of(card)))
