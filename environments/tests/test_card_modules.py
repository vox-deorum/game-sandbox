"""Foundation proof for the shared semantic-card contract (Stage 11.1).

Three things are pinned here, before any production environment adopts the new observation shape:

* the dependency-free codec in :mod:`local_play.card_utils` round-trips every card and keeps the
  engine rank *index* (queen = 10) and the semantic face *value* (queen = 12) apart;
* the shared Gymnasium spaces in :mod:`local_play.card_spaces` accept the empty and populated
  sequences a real hand and trick produce; and
* a nested-composite observation of exactly the intended shape survives pinned PettingZoo's
  ``api_test`` — save for the known, open #1211 ``dtype`` bug, which CI tolerates behind the guard
  below — and satisfies ``observation_space.contains()`` across a full episode and the dead-step
  cycle.

The fixture :class:`SemanticCardEnv` is a throwaway four-seat AEC env that exists only to exercise
the contract; the real environments keep their v1 observation until Stage 11.2 converts them.
"""

from __future__ import annotations

import warnings
from typing import Any

import numpy as np
import pytest
from gymnasium import spaces
from pettingzoo.test import api_test
from pettingzoo.utils.env import AECEnv

from hearts import rules as hearts_rules
from local_play import card_spaces, card_utils
from spades import rules as spades_rules

# -- the shared codec ------------------------------------------------------------------------


def test_codec_round_trips_every_card():
    # Every one of the 52 cards survives card -> object -> card unchanged, and the semantic object is
    # always the platform shape: suit 0..3, face-value rank 2..14.
    for card in range(card_utils.NUM_CARDS):
        obj = card_utils.card_to_obj(card)
        assert obj["suit"] in range(card_utils.NUM_SUITS)
        assert 2 <= obj["rank"] <= 14
        assert card_utils.card_from_obj(obj) == card


def test_queen_of_spades_pins_both_rank_conventions():
    # The one example that pins engine index (10) against semantic face value (12) at once.
    queen = 36
    assert card_utils.suit_of(queen) == card_utils.SPADES == 2
    assert card_utils.rank_of(queen) == 10  # engine index the rules compare on
    assert card_utils.card_to_obj(queen) == {"suit": 2, "rank": 12}  # face value the agent sees
    assert card_utils.card_from_obj({"suit": 2, "rank": 12}) == queen


def test_suit_names_cover_every_suit():
    assert card_utils.SUIT_NAMES == ("clubs", "diamonds", "spades", "hearts")
    for card in range(card_utils.NUM_CARDS):
        assert card_utils.SUIT_NAMES[card_utils.suit_of(card)]


def test_rules_engines_keep_suit_and_rank_after_importing_shared_codec():
    # Both engines now re-export their suit/rank codec from card_utils; confirm the values did not
    # move — the same suit ids and the same engine rank index (queen still 10) for the whole deck.
    for rules in (hearts_rules, spades_rules):
        assert rules.suit_of is card_utils.suit_of
        assert rules.rank_of is card_utils.rank_of
        assert (rules.CLUBS, rules.DIAMONDS, rules.SPADES, rules.HEARTS) == (0, 1, 2, 3)
        assert rules.NUM_CARDS == card_utils.NUM_CARDS == 52
        for card in range(card_utils.NUM_CARDS):
            assert rules.suit_of(card) == card // 13
            assert rules.rank_of(card) == card % 13
    # The Hearts engine's landmark cards stay put under the shared codec.
    assert hearts_rules.suit_of(hearts_rules.QUEEN_OF_SPADES) == hearts_rules.SPADES
    assert hearts_rules.rank_of(hearts_rules.QUEEN_OF_SPADES) == 10


# -- the shared spaces -----------------------------------------------------------------------


def test_card_space_accepts_face_values_and_rejects_engine_index():
    assert card_spaces.CARD.contains({"suit": 2, "rank": 12})  # queen of spades, face value
    assert card_spaces.CARD.contains({"suit": 0, "rank": 2})  # two of clubs
    assert card_spaces.CARD.contains({"suit": 3, "rank": 14})  # ace of hearts
    # Rank is a face value 2..14, so the engine index 0 (and any raw rank below 2) is out of space.
    assert not card_spaces.CARD.contains({"suit": 2, "rank": 0})


def test_hand_space_accepts_empty_and_populated_sequences():
    assert card_spaces.HAND.contains(())  # an exhausted hand is a valid empty sequence
    populated = tuple(card_utils.card_to_obj(c) for c in (0, 36, 51))
    assert card_spaces.HAND.contains(populated)


def test_trick_space_accepts_empty_and_populated_play_ordered_records():
    assert card_spaces.TRICK.contains(())  # between tricks
    trick = (
        {"seat": 2, "card": card_utils.card_to_obj(0)},
        {"seat": 3, "card": card_utils.card_to_obj(36)},
    )
    assert card_spaces.TRICK.contains(trick)


# -- the nested-composite fixture and the PettingZoo #1211 guard ------------------------------

N_SEATS = 4
HAND_SIZE = 3  # a short deal so a full episode is a handful of steps


class SemanticCardEnv(AECEnv):
    """A minimal four-seat AEC env carrying the intended nested-composite semantic observation.

    Existence is limited to this proof: it publishes an object-shaped inner ``observation`` Dict (the
    semantic ``Discrete`` / ``Sequence`` / ``Box`` fields) beside a top-level ``action_mask``, exactly
    the shape Stage 11.2 gives Hearts and Spades, so the contract is validated against pinned
    PettingZoo before a production environment adopts it.
    """

    metadata = {"name": "semantic_card_fixture_v0", "is_parallelizable": False, "render_modes": []}

    def __init__(self) -> None:
        super().__init__()
        self.render_mode = None
        self.possible_agents = [f"player_{i}" for i in range(N_SEATS)]
        obs_space = spaces.Dict(
            {
                "observation": spaces.Dict(
                    {
                        "seat": spaces.Discrete(N_SEATS),
                        "hand": card_spaces.HAND,
                        "current_trick": card_spaces.TRICK,
                        "led_suit": spaces.Discrete(5),
                        "scores": spaces.Box(0, 26, shape=(N_SEATS,), dtype=np.int64),
                    }
                ),
                "action_mask": spaces.Box(0, 1, shape=(card_utils.NUM_CARDS,), dtype=np.int8),
            }
        )
        # Cache one instance per accessor so api_test's space-identity assertion holds.
        self.observation_spaces = {agent: obs_space for agent in self.possible_agents}
        self.action_spaces = {agent: spaces.Discrete(card_utils.NUM_CARDS) for agent in self.possible_agents}

    def observation_space(self, agent: str) -> spaces.Space:
        return self.observation_spaces[agent]

    def action_space(self, agent: str) -> spaces.Space:
        return self.action_spaces[agent]

    def _seat(self, agent: str) -> int:
        return self.possible_agents.index(agent)

    def reset(self, seed: int | None = None, options: Any = None) -> None:
        deck = list(range(card_utils.NUM_CARDS))
        self.hands = {
            agent: sorted(deck[i * HAND_SIZE : (i + 1) * HAND_SIZE])
            for i, agent in enumerate(self.possible_agents)
        }
        self.trick: list[tuple[int, int]] = []
        self.agents = list(self.possible_agents)
        self.rewards = {agent: 0.0 for agent in self.agents}
        self._cumulative_rewards = {agent: 0.0 for agent in self.agents}
        self.terminations = {agent: False for agent in self.agents}
        self.truncations = {agent: False for agent in self.agents}
        self.infos = {agent: {} for agent in self.agents}
        self.agent_selection = self.agents[0]

    def observe(self, agent: str) -> dict[str, Any]:
        seat = self._seat(agent)
        hand = tuple(card_utils.card_to_obj(card) for card in self.hands[agent])
        trick = tuple(
            {"seat": played_seat, "card": card_utils.card_to_obj(card)} for played_seat, card in self.trick
        )
        led = card_utils.suit_of(self.trick[0][1]) if self.trick else 4  # 4 == no suit led
        mask = np.zeros(card_utils.NUM_CARDS, np.int8)
        if agent == self.agent_selection:
            for card in self.hands[agent]:
                mask[card] = 1
        return {
            "observation": {
                "seat": seat,
                "hand": hand,
                "current_trick": trick,
                "led_suit": led,
                "scores": np.zeros(N_SEATS, np.int64),
            },
            "action_mask": mask,
        }

    def step(self, action: Any) -> None:
        if self.terminations[self.agent_selection] or self.truncations[self.agent_selection]:
            return self._was_dead_step(action)
        agent = self.agent_selection
        seat = self._seat(agent)
        card = int(action)
        self.hands[agent].remove(card)
        self.trick.append((seat, card))
        if len(self.trick) == N_SEATS:
            self.trick = []  # a completed trick clears the centre
        index = self.agents.index(agent)
        self.agent_selection = self.agents[(index + 1) % len(self.agents)]
        if all(not hand for hand in self.hands.values()):
            self.terminations = {agent: True for agent in self.agents}
        self.rewards = {agent: 0.0 for agent in self.agents}
        self._cumulative_rewards[agent] = 0
        self._accumulate_rewards()
        self._deads_step_first()

    def render(self) -> Any:
        return None

    def close(self) -> None:
        pass


# The two UserWarnings pinned PettingZoo emits for a non-array composite observation; incidental to
# the #1211 bug, so the guard filters them rather than failing on them. Each is a message *prefix*:
# warnings.filterwarnings matches the regex against the start of the message.
_1211_WARNINGS = (
    "Observation is not a NumPy array",
    "Observation space for each agent probably should be",
)


def _api_test_tolerating_1211(env: AECEnv, num_cycles: int = 10) -> bool:
    """Run ``api_test`` and swallow *only* the known PettingZoo #1211 failure. Return whether it hit.

    Pinned PettingZoo 1.26.1 has an open bug
    (https://github.com/Farama-Foundation/PettingZoo/issues/1211): for a composite inner
    ``observation`` Dict, ``api_test`` recurses the declared space and evaluates ``seen.dtype`` on a
    semantic leaf (a plain ``int`` / ``tuple`` / ``dict``, whichever it reaches first), raising
    ``AttributeError: '<type>' object has no attribute 'dtype'``. That single error — and its two
    UserWarnings — is expected and tolerated; every other failure is a real conformance break and is
    re-raised unchanged. If a future, fixed PettingZoo stops raising, this returns ``False`` and the
    call still passes.

    TODO(#1211): delete this guard and call ``api_test`` directly once a PettingZoo release fixes
    the composite-observation ``dtype`` recursion.
    """
    with warnings.catch_warnings():
        for message in _1211_WARNINGS:
            warnings.filterwarnings("ignore", message=message)
        try:
            api_test(env, num_cycles=num_cycles)
        except AttributeError as exc:
            if "dtype" not in str(exc):
                raise  # a different AttributeError is a genuine failure
            return True
    return False


def test_fixture_passes_api_test_except_tolerated_1211():
    # The nested-composite observation conforms to pinned PettingZoo save for the tolerated #1211
    # dtype bug, which the guard absorbs. (When PettingZoo fixes it, the guard returns False and this
    # still passes, flagging that the guard can be removed.)
    _api_test_tolerating_1211(SemanticCardEnv())


def test_observation_space_contains_empty_and_populated_sequences_through_an_episode():
    # observation_space.contains() is the real conformance check the platform relies on. Walk a full
    # episode and assert every observation is in space, covering the empty trick (between tricks), a
    # populated trick (mid-trick), a populated hand, and an exhausted (empty) hand.
    env = SemanticCardEnv()
    env.reset(seed=0)
    space = env.observation_space("player_0")

    saw_empty_trick = saw_populated_trick = saw_empty_hand = saw_populated_hand = False
    while env.agents:
        obs, _reward, terminated, truncated, _info = env.last()
        assert space.contains(obs), f"observation out of space: {obs}"
        inner = obs["observation"]
        saw_empty_trick |= inner["current_trick"] == ()
        saw_populated_trick |= len(inner["current_trick"]) > 0
        saw_empty_hand |= inner["hand"] == ()
        saw_populated_hand |= len(inner["hand"]) > 0
        if terminated or truncated:
            env.step(None)  # the terminal dead step drains this agent
        else:
            legal = [card for card, bit in enumerate(obs["action_mask"]) if bit]
            env.step(legal[0])

    assert saw_empty_trick and saw_populated_trick
    assert saw_populated_hand and saw_empty_hand
    assert env.agents == []  # every agent drained cleanly through the dead-step cycle


def test_dead_step_cycle_is_idempotent_and_reports_terminated():
    # After the last real move every seat is terminated; each then takes exactly one None dead step
    # and is removed, with last() reporting termination throughout.
    env = SemanticCardEnv()
    env.reset(seed=0)
    while env.agents and not all(env.terminations.values()):
        agent = env.agent_selection
        obs, *_ = env.last()
        if env.terminations[agent] or env.truncations[agent]:
            env.step(None)
        else:
            legal = [card for card, bit in enumerate(obs["action_mask"]) if bit]
            env.step(legal[0])

    assert env.agents and all(env.terminations.values())
    drained = 0
    while env.agents:
        _obs, _reward, terminated, truncated, _info = env.last()
        assert terminated or truncated
        env.step(None)
        drained += 1
    assert drained == N_SEATS


if __name__ == "__main__":  # pragma: no cover - convenience for a direct run
    raise SystemExit(pytest.main([__file__, "-q"]))
