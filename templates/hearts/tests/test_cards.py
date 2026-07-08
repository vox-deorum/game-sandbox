"""Tests for the provided ``sandbox.cards`` helpers.

These pin the two guarantees the helpers rely on: that their card encoding matches the synced
rules engine exactly (so the helpers never drift from the real game), and that their observation
accessors agree with the raw observation the environment produces. A final check confirms that
importing the helpers does not drag in the heavy rendering stack, which is why an agent may import
them at module top without slowing down loading.
"""

from __future__ import annotations

import subprocess
import sys

from sandbox.card_utils import card_to_obj
from sandbox.cards import (
    QUEEN_OF_SPADES,
    TWO_OF_CLUBS,
    card_points,
    current_trick,
    hearts_broken,
    led_suit,
    legal_cards,
    make_card,
    my_seat,
    play,
    rank_of,
    scores,
    suit_of,
    trick_winner_so_far,
)
from sandbox.env import make_env
from sandbox.env.hearts import rules


def test_encoding_matches_the_rules_engine():
    # The helpers restate the fixed card encoding over semantic OBJECTS; the rules engine is the
    # source of truth for the underlying integer encoding (engine rank index, queen=10). Walking
    # every engine card through card_to_obj and back through the helpers catches drift between the
    # two either way.
    assert card_to_obj(rules.QUEEN_OF_SPADES) == QUEEN_OF_SPADES
    assert card_to_obj(rules.TWO_OF_CLUBS) == TWO_OF_CLUBS
    for card in range(52):
        obj = card_to_obj(card)
        assert suit_of(obj) == rules.suit_of(card)
        assert rank_of(obj) == rules.rank_of(card) + 2  # helper rank is FACE value
        assert card_points(obj) == rules.card_points(card)
        assert make_card(suit_of(obj), rank_of(obj)) == obj
        assert play(obj) == card


def test_observation_accessors_match_the_raw_observation():
    env = make_env(render_mode=None)
    try:
        env.reset(seed=0)
        for _ in range(12):
            agent = env.agent_selection
            observation = env.observe(agent)
            raw = observation["observation"]

            # legal_cards is exactly the set bits of the action mask, mapped to card objects.
            mask = observation["action_mask"]
            assert legal_cards(observation) == [card_to_obj(card) for card in range(52) if mask[card]]

            # The scalar accessors match the raw observation fields.
            assert my_seat(observation) == int(raw["seat"])
            assert scores(observation) == [int(points) for points in raw["scores"]]
            assert hearts_broken(observation) is bool(raw["hearts_broken"])
            expected_led = int(raw["led_suit"])
            assert led_suit(observation) == (None if expected_led == 4 else expected_led)

            # current_trick reproduces the seat/card mapping, leader first, in play order.
            played = current_trick(observation)
            raw_trick = [(int(entry["seat"]), entry["card"]) for entry in raw["current_trick"]]
            assert played == raw_trick
            if played:
                assert played[0][0] == int(raw["trick_leader"])
                assert trick_winner_so_far(observation) in played
            else:
                assert trick_winner_so_far(observation) is None

            legal = legal_cards(observation)
            if not legal:
                break
            env.step(play(min(legal, key=rank_of)))
    finally:
        env.close()


def test_importing_the_helpers_stays_light():
    # An agent imports sandbox.cards at module top, so it must not pull in pygame or the rest of the
    # rendering stack. Check in a fresh interpreter, since this test process has already loaded them.
    code = "import sys; from sandbox import cards; assert 'pygame' not in sys.modules"
    subprocess.run([sys.executable, "-c", code], check=True)
