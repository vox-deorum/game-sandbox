"""The 'counter' example agent: an honest Spades bidder that plays to make its bid.

Its one idea is to bid what its hand is actually worth and then take exactly the tricks it promised.
It has two phases, matching the game:

- **Bidding.** Count the tricks the hand is most likely to win — the high spades (ace, king, queen,
  which win almost any trick once spades are trump) and the side-suit aces (the top card of clubs,
  diamonds, or hearts). Bid that count. It never bids nil (a deliberate gamble a plain counter has no
  business making), so a thin hand still bids one.
- **Play.** Read the team's combined contract from the bids, and count how many tricks the
  partnership has already taken. While the team still needs tricks, win the ones it can, as cheaply
  as possible; once the contract is safe, duck — play the lowest legal card and avoid taking bags it
  did not need.

It reads everything through the ``sandbox.cards`` helpers, so it never decodes the combined
``Discrete(66)`` action space or the observation arrays by hand. It is deliberately chat-less: a
Spades agent needs nothing beyond the standard ``reset``/``act`` interface.
"""

from __future__ import annotations

from typing import Any

from sandbox.cards import (
    SPADES,
    beats_current_winner,
    bid,
    bids,
    hand_cards,
    is_bidding,
    legal_cards,
    my_player,
    partner_player,
    play,
    rank_of,
    suit_of,
    tricks_won,
)

NAME = "counter-spades"

#: A spade of this face rank or higher (queen, king, ace) is a near-certain winner once spades are trump.
HIGH_SPADE_RANK = 12
#: The ace is the top face rank in every suit.
ACE_RANK = 14


class Agent:
    """Bid the tricks the hand is worth (high spades + side aces), then play to make that bid."""

    def reset(self, seed: int) -> None:
        # Stateless: the bid is a pure function of the hand, and play reads the contract and the
        # tricks taken straight from each observation, so nothing is carried between turns or games.
        pass

    def act(self, observation: Any) -> int:
        if is_bidding(observation):
            return bid(self._honest_bid(observation))
        return self._play(observation)

    def _honest_bid(self, observation: Any) -> int:
        """Count likely tricks: high spades plus side-suit aces. Never nil, so floored at one."""
        hand = hand_cards(observation)
        high_spades = sum(1 for card in hand if suit_of(card) == SPADES and rank_of(card) >= HIGH_SPADE_RANK)
        side_aces = sum(1 for card in hand if suit_of(card) != SPADES and rank_of(card) == ACE_RANK)
        return max(1, min(13, high_spades + side_aces))

    def _play(self, observation: Any) -> int:
        """Win a trick while the team still needs one; otherwise duck with the lowest legal card."""
        legal = legal_cards(observation)
        if self._team_still_needs_tricks(observation):
            winners = [card for card in legal if beats_current_winner(observation, card)]
            if winners:
                # Win as cheaply as possible, so high cards are saved for tricks we still need.
                return play(min(winners, key=lambda card: (rank_of(card), suit_of(card))))
        return play(min(legal, key=lambda card: (rank_of(card), suit_of(card))))

    def _team_still_needs_tricks(self, observation: Any) -> bool:
        """True while the partnership has taken fewer tricks than its combined (non-nil) contract."""
        player = my_player(observation)
        partner = partner_player(observation)
        placed = bids(observation)
        contract = sum(placed[p] for p in (player, partner) if placed[p] > 0)
        won = tricks_won(observation)
        return won[player] + won[partner] < contract
