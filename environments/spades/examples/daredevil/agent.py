"""The 'daredevil' example agent: dare a nil, warn the table, and cover a partner who dared.

Its one idea is nil, out loud. When its hand is safe enough to take no tricks (nothing queen-high or
above, and only a few low spades) it bids nil (a promise to win zero tricks, worth a hundred points)
and **broadcasts** a warning to the whole table so its partner knows to protect it. And when its
partner broadcasts that warning, it covers: it grabs tricks it can win rather than ducking, so the
opponents cannot steer a trick onto the nil bidder. Absent a partner warning it plays its lowest
legal card, so the cover provably depends on the broadcast arriving.

A broadcast to the table is structurally different from a targeted partner signal (see the signaler
example): the whole table hears the dare. Everything is read through the ``sandbox.cards`` helpers,
so the agent never decodes the combined ``Discrete(66)`` action space or the observation arrays by
hand. Every message is recorded and shown in replays.
"""

from __future__ import annotations

from sandbox.cards import (
    NIL_BID,
    SPADES,
    Card,
    SpadesObservation,
    beats_current_winner,
    bid,
    hand_cards,
    is_bidding,
    legal_cards,
    partner_player,
    play,
    rank_of,
    suit_of,
)

NAME = "daredevil-spades"

#: The exact warning this agent broadcasts when it bids nil; its partner keys the cover off this text.
NIL_WARNING = "nil! cover me"

#: A card of this face rank or higher (queen, king, ace) is too likely to win a trick to risk a nil.
DANGER_RANK = 12
#: The ace is the top face rank in every suit.
ACE_RANK = 14
#: A spade of this face rank or higher (9 and up) is hard to duck under, so it disqualifies a nil.
HIGH_SPADE_RANK = 9
#: At most this many spades in hand keeps a nil plausible.
MAX_NIL_SPADES = 3


class Agent:
    """Bid nil when the hand is safe, broadcast the dare, and cover a partner who broadcast one."""

    def reset(self, seed, observation) -> None:
        # The player is restamped every turn from the observation so chat, which sees none, can name our
        # partner; the nil flags and whether we have warned persist across the hand.
        self._partner: int | None = None
        self._me_nil = False
        self._partner_nil = False
        self._warned = False

    def act(self, observation: SpadesObservation) -> int:
        self._partner = partner_player(observation)
        if is_bidding(observation):
            return self._bid(observation)
        return self._play(observation)

    def chat(self, inbox: list[dict]) -> list[dict]:
        # Only our partner's broadcast tells us to cover. Opponents sit on the other side, so a nil
        # warning from them is not ours to protect; keying the cover off the sender's player stops an
        # opponent shouting the same text from steering our play. Our partner is the player across.
        partner_player_id = f"player_{self._partner}"
        for item in inbox:
            from_partner = item.get("from") == partner_player_id
            if from_partner and item.get("to") is None and item.get("text") == NIL_WARNING:
                self._partner_nil = True
        if self._me_nil and not self._warned:
            self._warned = True
            return [{"to": None, "text": NIL_WARNING}]
        return []

    def _bid(self, observation: SpadesObservation) -> int:
        hand = hand_cards(observation)
        if self._qualifies_for_nil(hand):
            self._me_nil = True
            return bid(NIL_BID)
        # Otherwise an honest small count: high spades plus side aces, never nil, floored at one.
        high_spades = sum(1 for c in hand if suit_of(c) == SPADES and rank_of(c) >= HIGH_SPADE_RANK)
        side_aces = sum(1 for c in hand if suit_of(c) != SPADES and rank_of(c) == ACE_RANK)
        return bid(max(1, min(13, high_spades + side_aces)))

    def _qualifies_for_nil(self, hand: list[Card]) -> bool:
        """A hand safe to promise zero tricks: no card queen-high or above, and few, low spades."""
        if any(rank_of(c) >= DANGER_RANK for c in hand):
            return False
        spades = [c for c in hand if suit_of(c) == SPADES]
        if len(spades) > MAX_NIL_SPADES:
            return False
        return all(rank_of(c) < HIGH_SPADE_RANK for c in spades)

    def _play(self, observation: SpadesObservation) -> int:
        """Cover a nil-bidding partner by winning what we can; otherwise play the lowest legal card."""
        legal = legal_cards(observation)
        if self._partner_nil and not self._me_nil:
            winners = [c for c in legal if beats_current_winner(observation, c)]
            if winners:
                # Grab the trick with the highest winner, so a low card is saved for a later cover.
                return play(max(winners, key=lambda c: (rank_of(c), suit_of(c))))
        return play(min(legal, key=lambda c: (rank_of(c), suit_of(c))))
