"""Tests for the provided ``sandbox.cards`` helpers.

These pin the two guarantees the helpers rely on: that their action encoding matches the synced
rules engine exactly (so the helpers never drift from the real game), and that their observation
accessors agree with the raw observation the environment produces across both phases of a hand. A
final check confirms that importing the helpers does not drag in the heavy rendering stack, which is
why an agent may import them at module top without slowing down loading.
"""

from __future__ import annotations

import subprocess
import sys

from sandbox.card_utils import card_to_obj
from sandbox.cards import (
    BID_OFFSET,
    NIL_BID,
    NUM_BIDS,
    NUM_CARDS,
    action_to_bid,
    beats_current_winner,
    bid,
    bid_to_action,
    bids,
    current_trick,
    is_bidding,
    last_trick,
    last_trick_winner,
    led_suit,
    legal_bids,
    legal_cards,
    make_card,
    my_seat,
    partner_of,
    partner_seat,
    play,
    rank_of,
    spades_broken,
    suit_of,
    trick_winner_so_far,
    tricks_won,
)
from sandbox.env import default_action, make_env
from sandbox.env.spades import rules


def test_encoding_matches_the_rules_engine():
    # The helpers restate the fixed card and bid encoding over semantic OBJECTS; the rules engine
    # is the source of truth for the underlying integer encoding (engine rank index, queen=10).
    assert BID_OFFSET == rules.BID_OFFSET
    assert NIL_BID == rules.NIL_BID
    assert NUM_CARDS == rules.NUM_CARDS
    assert NUM_BIDS == rules.NUM_BIDS
    for card in range(52):
        obj = card_to_obj(card)
        assert suit_of(obj) == rules.suit_of(card)
        assert rank_of(obj) == rules.rank_of(card) + 2  # helper rank is FACE value
        assert make_card(suit_of(obj), rank_of(obj)) == obj
        assert play(obj) == card
    for n in range(NUM_BIDS):
        assert bid(n) == BID_OFFSET + n
        assert bid_to_action(n) == rules.bid_to_action(n)
        assert action_to_bid(bid_to_action(n)) == n
    # Partners sit across the table and share a team; the seat itself never partners itself.
    for seat in range(4):
        partner = partner_of(seat)
        assert partner != seat
        assert rules.team_of(partner) == rules.team_of(seat)


def test_observation_accessors_match_the_raw_observation():
    env = make_env(render_mode=None)
    try:
        env.reset(seed=0)
        # March the whole hand with the environment default (a suggested bid, then lowest legal
        # card), asserting every accessor against the live rules state at each turn: the bidding
        # round, then thirteen tricks, then the terminal dead-steps.
        while env.agents:
            agent = env.agent_selection
            observation, _reward, termination, truncation, _info = env.last()
            if termination or truncation:
                env.step(None)
                continue
            state = env.state
            seat = my_seat(observation)
            assert seat == env.possible_agents.index(agent)
            assert partner_seat(observation) == (seat + 2) % 4

            # Phase, and the phase-split legal sets, agree with the rules engine.
            assert is_bidding(observation) is rules.in_bidding(state)
            if rules.in_bidding(state):
                assert legal_bids(observation) == rules.legal_bids(state, seat)
                assert legal_cards(observation) == []
            else:
                assert legal_cards(observation) == [card_to_obj(c) for c in rules.legal_actions(state, seat)]
                assert legal_bids(observation) == []

            # Scalar / list state accessors match the raw observation. The engine's bids already use
            # -1 for "not yet bid"; the observation remaps that to 14 and the helper remaps it back.
            assert bids(observation) == list(state.bids)
            assert tricks_won(observation) == list(state.tricks_won)
            assert spades_broken(observation) is bool(state.spades_broken)
            assert led_suit(observation) == rules.led_suit(state)

            # The live trick reproduces the rules' play-order pairs (as card objects), and the
            # winner-so-far and the would-this-card-win predicate agree with rules.trick_winner
            # over the same cards.
            played = current_trick(observation)
            assert played == [(s, card_to_obj(c)) for s, c in state.current_trick]
            if played:
                assert trick_winner_so_far(observation)[0] == rules.trick_winner(list(state.current_trick))
                if not rules.in_bidding(state):
                    for card in legal_cards(observation):
                        raw_card = play(card)
                        expected = rules.trick_winner([*state.current_trick, (seat, raw_card)]) == seat
                        assert beats_current_winner(observation, card) is expected
            else:
                assert trick_winner_so_far(observation) is None

            # The completed-trick readers mirror the recorded last trick (seat -> card object) and
            # winner.
            if state.last_trick is None:
                assert last_trick(observation) == []
                assert last_trick_winner(observation) is None
            else:
                assert dict(last_trick(observation)) == {s: card_to_obj(c) for s, c in state.last_trick}
                assert last_trick_winner(observation) == state.last_trick_winner

            env.step(default_action(env, agent))
    finally:
        env.close()


def test_importing_the_helpers_stays_light():
    # An agent imports sandbox.cards at module top, so it must not pull in pygame or the rest of the
    # rendering stack. Check in a fresh interpreter, since this test process has already loaded them.
    code = "import sys; from sandbox import cards; assert 'pygame' not in sys.modules"
    subprocess.run([sys.executable, "-c", code], check=True)
