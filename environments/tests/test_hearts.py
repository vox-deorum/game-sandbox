"""Environment-level tests for Hearts: PettingZoo API conformance, the pure rules engine
(legality and scoring), the legal-mask/overlay/rules three-way agreement, seeded determinism,
the headless renderer, metadata serialization, and a full game driven through the harness.

The determinism test runs at the environment level — two resets with the same seed under the
same scripted policy must produce identical observation and overlay sequences, and the same
deal — so an environment-level seeding gap is caught here, at the wrapper, before any
harness-level recording determinism test runs and might misattribute it. The rule-enforcement
tests construct ``HeartsState`` instances directly so each Hearts rule (opening 2♣, follow
suit, hearts-not-led-until-broken with the all-hearts escape, and no-penalty-on-first-trick
with its escape valve) is exercised in isolation against both ``legal_moves`` and ``is_legal``.
"""

from __future__ import annotations

import json
import random

import numpy as np
import pytest
from pettingzoo.test import api_test

from game_sandbox_harness.session import REASON_TERMINATED, AgentSlot, run_episode
from hearts import ENTRY, rules
from hearts.env import AUTO_ACTION, IllegalMoveError, make_env
from hearts.overlay import extract_overlay


def test_passes_pettingzoo_api_test():
    api_test(make_env(), num_cycles=100)


# -- rule enforcement ------------------------------------------------------------------------


def test_opening_lead_must_be_two_of_clubs():
    state = rules.deal(random.Random(0))
    seat = state.turn
    assert rules.legal_moves(state, seat) == [rules.TWO_OF_CLUBS]
    assert rules.is_legal(state, seat, rules.TWO_OF_CLUBS)
    # Any other card the 2♣ holder owns is illegal as the opening play.
    for card in state.hands[seat]:
        if card != rules.TWO_OF_CLUBS:
            assert not rules.is_legal(state, seat, card)


def test_must_follow_suit_when_able():
    # Clubs (2♣) were led; seat 1 holds two clubs (3♣=1, 4♣=2) and two hearts (2♥=39, 3♥=40).
    state = rules.HeartsState(
        hands=[[], [1, 2, 39, 40], [], []],
        current_trick=[(0, rules.TWO_OF_CLUBS)],
        trick_leader=0,
        turn=1,
        hearts_broken=False,
        tricks_played=1,
        taken=[[], [], [], []],
        last_trick=None,
        last_trick_winner=None,
    )
    legal = rules.legal_moves(state, 1)
    assert legal == [1, 2]  # exactly the held clubs, no hearts
    assert rules.is_legal(state, 1, 1)
    assert not rules.is_legal(state, 1, 39)  # a held heart is illegal while clubs can follow


def test_hearts_not_led_until_broken():
    # Leading (no card in trick), past the first trick, hearts not yet broken, has a non-heart.
    base_kwargs = dict(
        current_trick=[],
        trick_leader=0,
        turn=0,
        tricks_played=2,
        taken=[[], [], [], []],
        last_trick=None,
        last_trick_winner=None,
    )
    state = rules.HeartsState(hands=[[5, 39, 40], [], [], []], hearts_broken=False, **base_kwargs)
    assert rules.legal_moves(state, 0) == [5]  # hearts barred from the lead
    assert not rules.is_legal(state, 0, 39)

    state.hearts_broken = True
    assert rules.legal_moves(state, 0) == [5, 39, 40]  # now hearts may be led
    assert rules.is_legal(state, 0, 39)


def test_all_hearts_hand_may_lead_hearts():
    # Leading with a hand of only hearts and hearts not broken: the escape valve makes them legal.
    state = rules.HeartsState(
        hands=[[39, 40, 41], [], [], []],
        current_trick=[],
        trick_leader=0,
        turn=0,
        hearts_broken=False,
        tricks_played=2,
        taken=[[], [], [], []],
        last_trick=None,
        last_trick_winner=None,
    )
    assert rules.legal_moves(state, 0) == [39, 40, 41]
    assert rules.is_legal(state, 0, 39)


def test_no_penalty_cards_on_first_trick():
    # First trick, 2♣ led; seat 1 has no clubs but holds a safe diamond (2♦=13), Q♠ (36), 2♥ (39).
    state = rules.HeartsState(
        hands=[[], [13, 36, 39], [], []],
        current_trick=[(0, rules.TWO_OF_CLUBS)],
        trick_leader=0,
        turn=1,
        hearts_broken=False,
        tricks_played=0,
        taken=[[], [], [], []],
        last_trick=None,
        last_trick_winner=None,
    )
    legal = rules.legal_moves(state, 1)
    assert legal == [13]  # only the safe diamond
    assert rules.is_legal(state, 1, 13)
    assert not rules.is_legal(state, 1, rules.QUEEN_OF_SPADES)  # Q♠ barred on first trick
    assert not rules.is_legal(state, 1, 39)  # a heart barred on first trick


def test_first_trick_penalty_escape_valve():
    # First trick, 2♣ led; seat 1 holds ONLY penalty cards (Q♠ + hearts) -> they become legal.
    state = rules.HeartsState(
        hands=[[], [36, 39, 40], [], []],
        current_trick=[(0, rules.TWO_OF_CLUBS)],
        trick_leader=0,
        turn=1,
        hearts_broken=False,
        tricks_played=0,
        taken=[[], [], [], []],
        last_trick=None,
        last_trick_winner=None,
    )
    assert rules.legal_moves(state, 1) == [36, 39, 40]
    assert rules.is_legal(state, 1, rules.QUEEN_OF_SPADES)
    assert rules.is_legal(state, 1, 39)


def test_env_rejects_illegal_move():
    env = make_env()
    env.reset(seed=0)
    # At reset the only legal card is the 2♣; pick any other card the seat actually holds.
    seat = env.state.turn
    illegal = next(card for card in env.state.hands[seat] if card != rules.TWO_OF_CLUBS)
    with pytest.raises(IllegalMoveError):
        env.step(illegal)


def test_legal_mask_matches_overlay_and_rules():
    env = make_env()
    env.reset(seed=0)

    def agree() -> None:
        agent = env.agent_selection
        mask_idx = sorted(int(i) for i in np.flatnonzero(env.observe(agent)["action_mask"]))
        overlay_legal = extract_overlay(env)["legal_actions"]
        rules_legal = rules.legal_moves(env.state, env.state.turn)
        assert mask_idx == overlay_legal == rules_legal

    # At reset (opening lead).
    agree()

    # In a constructed mid-trick state.
    env.state = rules.HeartsState(
        hands=[[], [1, 2, 39, 40], [], []],
        current_trick=[(0, rules.TWO_OF_CLUBS)],
        trick_leader=0,
        turn=1,
        hearts_broken=False,
        tricks_played=1,
        taken=[[], [], [], []],
        last_trick=None,
        last_trick_winner=None,
    )
    env.agent_selection = env.possible_agents[env.state.turn]
    agree()


# -- scoring ---------------------------------------------------------------------------------


def test_scoring_normal_hand():
    # Hearts/Q♠ spread across seats (not all on one): no shoot-the-moon flip.
    taken = [
        [rules.QUEEN_OF_SPADES],  # 13 points
        [39, 40, 41, 42, 43],  # 5 hearts -> 5 points
        [44, 45, 46, 47, 48],  # 5 hearts -> 5 points
        [49, 50, 51],  # 3 hearts -> 3 points
    ]
    state = rules.HeartsState(
        hands=[[], [], [], []],
        current_trick=[],
        trick_leader=0,
        turn=0,
        hearts_broken=True,
        tricks_played=13,
        taken=taken,
        last_trick=None,
        last_trick_winner=None,
    )
    raw = rules.points_taken(state)
    assert raw == [13, 5, 5, 3]
    assert sum(raw) == 26
    assert rules.final_penalties(state) == raw  # no flip
    assert rules.penalty_scores(state) == raw  # terminal -> final
    assert rules.leaderboard_scores(state) == [-p for p in rules.penalty_scores(state)]


def test_shoot_the_moon_flip():
    # Seat 0 takes all 13 hearts (39..51) plus the Q♠ (36): raw 26, others 0.
    taken = [list(range(39, 52)) + [rules.QUEEN_OF_SPADES], [], [], []]
    state = rules.HeartsState(
        hands=[[], [], [], []],
        current_trick=[],
        trick_leader=0,
        turn=0,
        hearts_broken=True,
        tricks_played=13,
        taken=taken,
        last_trick=None,
        last_trick_winner=None,
    )
    assert rules.points_taken(state) == [26, 0, 0, 0]
    assert rules.final_penalties(state) == [0, 26, 26, 26]  # the shooter flips to 0
    assert rules.penalty_scores(state) == [0, 26, 26, 26]  # terminal -> final
    leaderboard = rules.leaderboard_scores(state)
    assert leaderboard == [0, -26, -26, -26]
    assert leaderboard[0] == max(leaderboard)  # the shooter is best off


# -- renderer --------------------------------------------------------------------------------


def test_renderer_headless_frame_and_hittest():
    env = make_env("rgb_array")
    env.reset(seed=1)
    frame = env.render()
    assert frame.ndim == 3
    assert frame.shape[2] == 3
    assert frame.dtype == np.uint8

    assert set(make_env().metadata["render_modes"]) >= {"human", "rgb_array"}

    card = env.state.hands[0][0]
    rect = env._renderer.card_rect(card)
    assert rect is not None
    assert env._renderer.card_at_pos(rect.center) == card
    env.close()


# -- metadata --------------------------------------------------------------------------------


def test_metadata_round_trips_through_json():
    blob = json.dumps(ENTRY.meta.to_json())
    parsed = json.loads(blob)
    assert parsed["env_id"] == "hearts"
    assert parsed["renderer"] == "hearts"
    assert parsed["seat_order_matters"] is True
    assert parsed["min_slots"] == parsed["max_slots"] == 4
    assert parsed["human_slots"] == ["player_0", "player_1", "player_2", "player_3"]
    assert parsed["pace_interval_ms"] is None
    assert parsed["messaging"] is False


# -- default action --------------------------------------------------------------------------


def test_default_action_is_sentinel_and_plays_lowest_legal():
    assert ENTRY.default_action("player_0") == AUTO_ACTION

    env = make_env()
    env.reset(seed=0)
    # Leading seat 0 with several legal cards (hearts broken so the lead is unrestricted).
    state = rules.HeartsState(
        hands=[[8, 5, 20, 30], [], [], []],  # 10♣, 7♣, 9♦, 6♠
        current_trick=[],
        trick_leader=0,
        turn=0,
        hearts_broken=True,
        tricks_played=3,
        taken=[[], [], [], []],
        last_trick=None,
        last_trick_winner=None,
    )
    env.state = state
    env.agent_selection = env.possible_agents[state.turn]
    seat = state.turn
    expected = rules.lowest_legal_card(state, seat)
    assert len(rules.legal_moves(state, seat)) > 1  # genuinely a choice

    env.step(AUTO_ACTION)
    # The lowest legal card left the seat's hand and is the last card played this trick.
    assert expected not in env.state.hands[seat]
    assert env.state.current_trick[-1][1] == expected


# -- determinism -----------------------------------------------------------------------------


def _rollout(seed: int) -> tuple[list, list, list]:
    """Reset a fresh env and play lowest-legal until terminal, snapshotting observations and
    overlays each turn. Returns (observation snapshots, overlay dicts, the deal's hands)."""
    env = make_env()
    env.reset(seed=seed)
    deal = [list(hand) for hand in env.state.hands]
    observations: list = []
    overlays: list = []
    while env.agents:
        agent = env.agent_selection
        _obs, _r, term, trunc, _i = env.last()
        if term or trunc:
            env.step(None)
            continue
        observed = env.observe(agent)
        snapshot = {
            "hand": np.array(observed["observation"]["hand"], copy=True),
            "trick": np.array(observed["observation"]["trick"], copy=True),
            "led_suit": np.array(observed["observation"]["led_suit"], copy=True),
            "hearts_broken": np.array(observed["observation"]["hearts_broken"], copy=True),
            "position": np.array(observed["observation"]["position"], copy=True),
            "trick_leader": np.array(observed["observation"]["trick_leader"], copy=True),
            "scores": np.array(observed["observation"]["scores"], copy=True),
            "action_mask": np.array(observed["action_mask"], copy=True),
        }
        observations.append(snapshot)
        overlays.append(extract_overlay(env))
        env.step(AUTO_ACTION)
    env.close()
    return observations, overlays, deal


def test_same_seed_produces_identical_sequences():
    obs_a, ov_a, deal_a = _rollout(7)
    obs_b, ov_b, deal_b = _rollout(7)

    assert deal_a == deal_b  # identical deal under the same seed
    assert len(obs_a) == len(obs_b)
    for a, b in zip(obs_a, obs_b, strict=True):
        assert a.keys() == b.keys()
        for key in a:
            assert np.array_equal(a[key], b[key])
    assert json.dumps(ov_a, sort_keys=True) == json.dumps(ov_b, sort_keys=True)


def test_different_seeds_diverge():
    _obs_a, ov_a, _deal_a = _rollout(1)
    _obs_b, ov_b, _deal_b = _rollout(2)
    assert json.dumps(ov_a, sort_keys=True) != json.dumps(ov_b, sort_keys=True)


# -- full game through the harness -----------------------------------------------------------


class LowestLegalAgent:
    """A trivial agent that always plays the lowest-id legal card (first set mask bit)."""

    def reset(self, seed):
        pass

    def act(self, observation):
        mask = observation["action_mask"]
        return int(np.argmax(mask))  # first (lowest-id) legal card


def test_full_game_completes_via_run_episode():
    slots = {f"player_{i}": AgentSlot(LowestLegalAgent()) for i in range(rules.NUM_PLAYERS)}
    result = run_episode(ENTRY, slots, seed=0)
    assert result.reason == REASON_TERMINATED
    assert result.ticks == 52

    # Separately drive a manual rollout to inspect the terminal overlay before closing.
    env = make_env()
    env.reset(seed=0)
    while env.agents:
        _obs, _r, term, trunc, _i = env.last()
        if term or trunc:
            env.step(None)
            continue
        env.step(AUTO_ACTION)
    ov = extract_overlay(env)
    assert ov["terminal"] is True
    assert sum(ov["display_scores"]) in (26, 78)  # 26 normal, 78 after a moon flip
    assert ov["leaderboard_scores"] == [-p for p in ov["display_scores"]]
    assert ov["display_scores"] == rules.penalty_scores(env.state)
    env.close()


def test_run_episode_scores_credit_every_seat():
    # The harness must record each seat's final leaderboard score, not only whoever played the
    # last card. Drive a full game through run_episode, then replay the identical deterministic
    # policy by hand to recover the per-seat final leaderboard, and assert they match. This is
    # the regression guard for terminal-reward accumulation across all four seats.
    slots = {f"player_{i}": AgentSlot(LowestLegalAgent()) for i in range(rules.NUM_PLAYERS)}
    result = run_episode(ENTRY, slots, seed=0)

    env = make_env()
    env.reset(seed=0)
    while env.agents:
        agent = env.agent_selection
        _obs, _r, term, trunc, _i = env.last()
        if term or trunc:
            env.step(None)
            continue
        mask = env.observe(agent)["action_mask"]
        env.step(int(np.argmax(mask)))  # the same policy LowestLegalAgent uses
    expected = rules.leaderboard_scores(env.state)
    env.close()

    assert result.scores == {f"player_{i}": float(expected[i]) for i in range(rules.NUM_PLAYERS)}
    # Sanity: seats are genuinely differentiated (not the all-zero mis-ranking), and the
    # leaderboard sums to the negated total penalty (-26 normal, -78 after a moon flip).
    assert sum(result.scores.values()) in (-26.0, -78.0)
    assert any(score != 0.0 for score in result.scores.values())
