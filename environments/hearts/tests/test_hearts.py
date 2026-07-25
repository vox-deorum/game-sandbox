"""Environment-level tests for Hearts: PettingZoo API conformance, the pure rules engine
(legality and scoring), the legal-mask/overlay/rules three-way agreement, seeded determinism,
metadata serialization, and a full game driven through the harness.

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
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from game_sandbox_harness.environment import resolve_parameters
from game_sandbox_harness.manifest import load_agent
from game_sandbox_harness.session import REASON_TERMINATED, AgentPlayer, run_episode
from hearts import ENTRY, rules
from hearts.env import IllegalMoveError, card_to_obj, default_action, make_env
from hearts.overlay import extract_overlay

#: The frozen v1 built-in Hearts baseline the session image stages and the harness loads for every
#: Naive player (``backend/images/session-base/deps-v1/builtin/hearts``), from this repo's root.
BUILTIN_HEARTS_AGENT_DIR = (
    Path(__file__).resolve().parents[3] / "backend/images/session-base/deps-v1/builtin/hearts"
)


@pytest.mark.parametrize(
    "parameters",
    [
        {},
        {"players": True},
        {"players": "4"},
        {"players": 4.0},
        {"players": 2**53},
        {"players": 3},
    ],
)
def test_factory_rejects_invalid_players(parameters):
    with pytest.raises(ValueError):
        make_env(parameters)


def test_factory_rejects_wrong_player_count_under_optimized_python():
    script = """
from hearts.env import make_env

try:
    make_env({"players": 3})
except ValueError:
    pass
else:
    raise SystemExit("Hearts factory accepted an invalid player count")
"""
    subprocess.run([sys.executable, "-O", "-c", script], check=True)


# -- rule enforcement ------------------------------------------------------------------------


def test_opening_lead_must_be_two_of_clubs():
    state = rules.deal(random.Random(0))
    player = state.turn
    assert rules.legal_moves(state, player) == [rules.TWO_OF_CLUBS]
    assert rules.is_legal(state, player, rules.TWO_OF_CLUBS)
    # Any other card the 2♣ holder owns is illegal as the opening play.
    for card in state.hands[player]:
        if card != rules.TWO_OF_CLUBS:
            assert not rules.is_legal(state, player, card)


def test_must_follow_suit_when_able():
    # Clubs (2♣) were led; player 1 holds two clubs (3♣=1, 4♣=2) and two hearts (2♥=39, 3♥=40).
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
    # First trick, 2♣ led; player 1 has no clubs but holds a safe diamond (2♦=13), Q♠ (36), 2♥ (39).
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
    # First trick, 2♣ led; player 1 holds ONLY penalty cards (Q♠ + hearts) -> they become legal.
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


def test_queen_of_spades_does_not_break_hearts():
    # Variant pin: only a heart breaks hearts. Player 1 follows a led spade with the Q♠ (the 13-point
    # card); afterwards hearts stay unbroken, so a later leader still may not open with a heart. The
    # contrast case — playing a heart — flips the flag, proving the test exercises the real transition.
    two_of_spades = rules.SPADES * 13  # 26
    state = rules.HeartsState(
        hands=[[], [rules.QUEEN_OF_SPADES], [], []],
        current_trick=[(0, two_of_spades)],
        trick_leader=0,
        turn=1,
        hearts_broken=False,
        tricks_played=3,
        taken=[[], [], [], []],
        last_trick=None,
        last_trick_winner=None,
    )
    rules.play(state, rules.QUEEN_OF_SPADES)
    assert state.hearts_broken is False

    # A heart, by contrast, does break hearts.
    heart = rules.HEARTS * 13  # 2♥ = 39
    state.hands[2] = [heart]
    state.turn = 2
    rules.play(state, heart)
    assert state.hearts_broken is True


def test_observe_masks_only_the_acting_player():
    # The action mask belongs to the player on turn; an off-turn player gets an all-zero mask so it never
    # looks like it may act. Only the acting player's mask carries its legal cards.
    env = make_env({"players": 4})
    env.reset(seed=0)
    acting = env.agent_selection
    acting_mask = env.observe(acting)["action_mask"]
    assert int(acting_mask.sum()) > 0
    for agent in env.possible_agents:
        if agent != acting:
            assert int(env.observe(agent)["action_mask"].sum()) == 0


def test_terminal_observation_scores_match_the_overlay_after_a_moon_flip():
    # The observation's score leaf must agree with the overlay's display_scores at terminal, including
    # the shoot-the-moon flip. A raw points_taken leaf would disagree with the flipped overlay on the
    # last step of a moon-shot hand; penalty_scores keeps them equal.
    taken = [list(range(39, 52)) + [rules.QUEEN_OF_SPADES], [], [], []]  # player 0 shoots the moon
    env = make_env({"players": 4})
    env.reset(seed=0)
    env.state = rules.HeartsState(
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
    observed = env.observe("player_0")["observation"]["scores"]
    assert list(int(s) for s in observed) == extract_overlay(env)["display_scores"] == [0, 26, 26, 26]


def test_env_rejects_illegal_move():
    env = make_env({"players": 4})
    env.reset(seed=0)
    # At reset the only legal card is the 2♣; pick any other card the player actually holds.
    player = env.state.turn
    illegal = next(card for card in env.state.hands[player] if card != rules.TWO_OF_CLUBS)
    with pytest.raises(IllegalMoveError):
        env.step(illegal)


def test_legal_mask_matches_overlay_and_rules():
    env = make_env({"players": 4})
    env.reset(seed=0)

    def agree() -> None:
        agent = env.agent_selection
        mask_idx = sorted(int(i) for i in np.flatnonzero(env.observe(agent)["action_mask"]))
        overlay_legal_cards = extract_overlay(env)["legal_cards"]
        rules_legal = rules.legal_moves(env.state, env.state.turn)
        assert mask_idx == rules_legal
        assert overlay_legal_cards == [card_to_obj(c) for c in rules_legal]

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


def test_observation_shape_and_led_suit_none_encoding():
    # Pins the object observation contract: player (not position), hand as a tuple of face-value
    # card objects, current_trick as play-ordered {"player","card"} objects, and led_suit == 4 (not
    # -1) when no card has been played yet in the trick.
    env = make_env({"players": 4})
    env.reset(seed=0)
    player = env.state.turn
    inner = env.observe(env.agent_selection)["observation"]

    assert inner["player"] == player
    assert inner["current_trick"] == ()
    assert inner["led_suit"] == 4  # no card led yet in this trick
    assert inner["hand"] == tuple(card_to_obj(c) for c in env.state.hands[player])
    for card in inner["hand"]:
        assert set(card) == {"suit", "rank"}
        assert card["suit"] in range(4)
        assert 2 <= card["rank"] <= 14

    # The queen of spades pins both rank conventions at once: engine card 36, face-value object.
    queen_holder = next(s for s in range(4) if rules.QUEEN_OF_SPADES in env.state.hands[s])
    queen_obj = card_to_obj(rules.QUEEN_OF_SPADES)
    assert queen_obj == {"suit": 2, "rank": 12}
    holder_hand = env.observe(env.possible_agents[queen_holder])["observation"]["hand"]
    assert queen_obj in holder_hand

    # Once a card is led (the forced opening 2♣), current_trick carries a play-ordered
    # {"player","card"} object and led_suit is the real suit (not the "none" sentinel).
    env.step(rules.TWO_OF_CLUBS)
    next_agent = env.agent_selection
    next_inner = env.observe(next_agent)["observation"]
    assert next_inner["current_trick"] == ({"player": player, "card": card_to_obj(rules.TWO_OF_CLUBS)},)
    assert next_inner["led_suit"] == rules.CLUBS


# -- scoring ---------------------------------------------------------------------------------


def test_scoring_normal_hand():
    # Hearts/Q♠ spread across players (not all on one): no shoot-the-moon flip.
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
    # Player 0 takes all 13 hearts (39..51) plus the Q♠ (36): raw 26, others 0.
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


# -- default action --------------------------------------------------------------------------


def _lead_choice_state() -> rules.HeartsState:
    """Player 0 leading with several legal cards (hearts broken, so the lead is unrestricted)."""
    return rules.HeartsState(
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


def test_default_action_returns_real_lowest_legal_card():
    # The timeout hook now receives the live env and player id and returns the concrete lowest legal
    # card (a real Discrete(52) action), not a sentinel, so a timeout recording holds the real move.
    # default_action is a module-level function in env.py and is the same callable as ENTRY.default_action.
    env = make_env({"players": 4})
    env.reset(seed=0)
    state = _lead_choice_state()
    env.state = state
    env.agent_selection = env.possible_agents[state.turn]
    player = state.turn
    expected = rules.lowest_legal_card(state, player)
    assert len(rules.legal_moves(state, player)) > 1  # genuinely a choice

    assert ENTRY.default_action is default_action
    action = ENTRY.default_action(env, "player_0")
    assert action == expected
    assert isinstance(action, int)

    env.step(action)
    # The lowest legal card left the player's hand and is the last card played this trick.
    assert expected not in env.state.hands[player]
    assert env.state.current_trick[-1][1] == expected


# -- determinism -----------------------------------------------------------------------------


def _rollout(seed: int) -> tuple[list, list, list]:
    """Reset a fresh env and play the env default until terminal, snapshotting observations and
    overlays each turn. Returns (observation snapshots, overlay dicts, the deal's hands)."""
    env = make_env({"players": 4})
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
        inner = observed["observation"]
        snapshot = {
            "player": inner["player"],
            "hand": inner["hand"],
            "current_trick": inner["current_trick"],
            "led_suit": inner["led_suit"],
            "hearts_broken": inner["hearts_broken"],
            "trick_leader": inner["trick_leader"],
            "scores": np.array(inner["scores"], copy=True),
            "action_mask": np.array(observed["action_mask"], copy=True),
        }
        observations.append(snapshot)
        overlays.append(extract_overlay(env))
        env.step(default_action(env, agent))
    env.close()
    return observations, overlays, deal


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


def _drive_to_terminal(env, choose):
    """Step ``env`` to the end of the hand, playing ``choose(env)`` on a live turn and the env
    default (``None``) on a dead one. The shared rollout the terminal-state assertions below reuse."""
    while env.agents:
        _obs, _reward, term, trunc, _info = env.last()
        env.step(None if (term or trunc) else choose(env))


def test_full_game_completes_via_run_episode():
    players = {f"player_{i}": AgentPlayer(LowestLegalAgent()) for i in range(rules.NUM_PLAYERS)}
    result = run_episode(ENTRY, players, parameters=resolve_parameters(ENTRY.meta), seed=0)
    assert result.reason == REASON_TERMINATED
    assert result.ticks == 52

    # Separately drive a manual rollout to inspect the terminal overlay before closing.
    env = make_env({"players": 4})
    env.reset(seed=0)
    _drive_to_terminal(env, lambda e: default_action(e, e.agent_selection))
    ov = extract_overlay(env)
    assert ov["terminal"] is True
    assert sum(ov["display_scores"]) in (26, 78)  # 26 normal, 78 after a moon flip
    assert ov["leaderboard_scores"] == [-p for p in ov["display_scores"]]
    assert ov["display_scores"] == rules.penalty_scores(env.state)
    env.close()


def test_run_episode_scores_credit_every_player():
    # The harness must record each player's final leaderboard score, not only whoever played the
    # last card. Drive a full game through run_episode, then replay the identical deterministic
    # policy by hand to recover the per-player final leaderboard, and assert they match. This is
    # the regression guard for terminal-reward accumulation across all four players.
    players = {f"player_{i}": AgentPlayer(LowestLegalAgent()) for i in range(rules.NUM_PLAYERS)}
    result = run_episode(ENTRY, players, parameters=resolve_parameters(ENTRY.meta), seed=0)

    env = make_env({"players": 4})
    env.reset(seed=0)
    # The same policy LowestLegalAgent uses: the first (lowest-id) set mask bit.
    _drive_to_terminal(env, lambda e: int(np.argmax(e.observe(e.agent_selection)["action_mask"])))
    expected = rules.leaderboard_scores(env.state)
    env.close()

    assert result.scores == {f"player_{i}": float(expected[i]) for i in range(rules.NUM_PLAYERS)}
    # Sanity: players are genuinely differentiated (not the all-zero mis-ranking), and the
    # leaderboard sums to the negated total penalty (-26 normal, -78 after a moon flip).
    assert sum(result.scores.values()) in (-26.0, -78.0)
    assert any(score != 0.0 for score in result.scores.values())


# -- the frozen on-disk built-in baseline ----------------------------------------------------


def test_builtin_hearts_agent_plays_a_full_legal_game():
    # The session image stages a per-environment Naive baseline at /opt/agents/builtin/<env_id>, and
    # the harness loads it (through the manifest loader, as the container does) for every Naive player.
    # Driving four copies to a clean terminal is the regression guard for the KeyError the Flappy Bird
    # baseline raised when loaded into Hearts players: the per-environment baseline must exist, load, and
    # play only legal cards to the end of the hand.
    players = {
        f"player_{i}": AgentPlayer(load_agent(BUILTIN_HEARTS_AGENT_DIR)) for i in range(rules.NUM_PLAYERS)
    }
    result = run_episode(ENTRY, players, parameters=resolve_parameters(ENTRY.meta), seed=0)
    assert result.reason == REASON_TERMINATED
    assert result.ticks == 52

    # The baseline plays the env's own lowest-legal default (default_action / rules.lowest_legal_card),
    # so a hand driven by that default must reach the identical deterministic terminal scores.
    env = make_env({"players": 4})
    env.reset(seed=0)
    _drive_to_terminal(env, lambda e: default_action(e, e.agent_selection))
    expected = rules.leaderboard_scores(env.state)
    env.close()
    assert result.scores == {f"player_{i}": float(expected[i]) for i in range(rules.NUM_PLAYERS)}
