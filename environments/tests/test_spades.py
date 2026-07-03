"""Environment-level tests for Spades: PettingZoo API conformance, the pure rules engine (bidding
and play legality, trick resolution, and the scoring matrix), the legal-action/overlay/rules
three-way agreement, seeded determinism, the headless renderer, metadata serialization, and a full
game driven through the harness.

The determinism test runs at the environment level (two resets with the same seed under the same
scripted policy must produce identical observation and overlay sequences, and the same deal), so an
environment-level seeding gap is caught here, at the wrapper. The rule-enforcement tests construct
``SpadesState`` instances directly so each rule (bidding order, follow-suit, spades-not-led-until-
broken with its all-spades escape, trick-winner resolution) and each scoring case (made/failed
contract, bags, made/set nil, the set-nil cross-case, double nil, the worst-case floor, and the
omitted ten-bag penalty) is exercised in isolation.
"""

from __future__ import annotations

import json
import random
from pathlib import Path

import numpy as np
import pytest
from pettingzoo.test import api_test

from game_sandbox_harness.session import REASON_TERMINATED, AgentSlot, run_episode
from spades import ENTRY, rules
from spades.env import AUTO_ACTION, IllegalMoveError, make_env
from spades.overlay import extract_overlay
from spades.render import HEIGHT, WIDTH


def test_passes_pettingzoo_api_test():
    api_test(make_env(), num_cycles=100)


# -- bidding legality ------------------------------------------------------------------------


def test_seat_zero_bids_first_and_leads():
    # The fixed convention the scheduler, examples, and e2e journeys rely on: seat 0 opens the
    # bidding, and once bidding is done seat 0 leads the first trick.
    env = make_env()
    env.reset(seed=0)
    assert env.agent_selection == "player_0"
    assert env.state.turn == 0
    for _ in range(rules.NUM_PLAYERS):
        env.step(AUTO_ACTION)
    assert not rules.in_bidding(env.state)
    assert env.state.turn == 0
    assert env.state.trick_leader == 0


def test_each_seat_bids_once_in_order_and_card_actions_are_illegal():
    env = make_env()
    env.reset(seed=0)
    for seat in range(rules.NUM_PLAYERS):
        assert env.state.turn == seat  # strict seat order 0, 1, 2, 3
        legal = rules.legal_actions(env.state, seat)
        assert legal == [rules.bid_to_action(k) for k in range(rules.NUM_BIDS)]
        assert all(action >= rules.BID_OFFSET for action in legal)
        # A card action is illegal during bidding.
        assert not rules.is_legal_action(env.state, seat, env.state.hands[seat][0])
        env.step(rules.bid_to_action(2))
    # Every seat has bid exactly once.
    assert all(bid == 2 for bid in env.state.bids)


def test_bid_actions_are_illegal_during_play():
    env = make_env()
    env.reset(seed=0)
    for _ in range(rules.NUM_PLAYERS):
        env.step(AUTO_ACTION)
    # In the play phase, a bid action is illegal and a legal card is legal.
    assert not rules.is_legal_action(env.state, env.state.turn, rules.bid_to_action(3))
    legal = rules.legal_actions(env.state, env.state.turn)
    assert legal and all(action < rules.NUM_CARDS for action in legal)


def test_env_rejects_card_action_during_bidding():
    env = make_env()
    env.reset(seed=0)
    with pytest.raises(IllegalMoveError):
        env.step(env.state.hands[0][0])  # a card while still bidding


def test_env_rejects_bid_action_during_play():
    env = make_env()
    env.reset(seed=0)
    for _ in range(rules.NUM_PLAYERS):
        env.step(AUTO_ACTION)
    with pytest.raises(IllegalMoveError):
        env.step(rules.bid_to_action(3))  # a bid once play has begun


# -- play legality ---------------------------------------------------------------------------


def _play_state(hands, current_trick=(), turn=0, spades_broken=False, tricks_played=1):
    """A play-phase ``SpadesState`` (all seats bid) for isolating a single legality rule."""
    return rules.SpadesState(
        hands=[list(h) for h in hands],
        bids=[3, 3, 3, 3],
        current_trick=[tuple(pair) for pair in current_trick],
        trick_leader=0,
        turn=turn,
        spades_broken=spades_broken,
        tricks_played=tricks_played,
        tricks_won=[0, 0, 0, 0],
    )


def test_must_follow_suit_when_able():
    # Clubs (2♣ = 0) led; seat 1 holds two clubs (3♣=1, 4♣=2) and two hearts (2♥=39, 3♥=40).
    state = _play_state([[], [1, 2, 39, 40], [], []], current_trick=[(0, 0)], turn=1)
    assert rules.legal_plays(state, 1) == [1, 2]  # exactly the held clubs
    assert rules.legal_actions(state, 1) == [1, 2]
    assert rules.is_legal_action(state, 1, 1)
    assert not rules.is_legal_action(state, 1, 39)  # a held heart is illegal while clubs can follow


def test_spades_not_led_until_broken():
    # Leading, spades not yet broken, holds a non-spade (7♣=5) and spades (2♠=26, 3♠=27).
    state = _play_state([[5, 26, 27], [], [], []], turn=0, tricks_played=2)
    assert rules.legal_plays(state, 0) == [5]  # spades barred from the lead
    assert not rules.is_legal_action(state, 0, 26)

    state.spades_broken = True
    assert rules.legal_plays(state, 0) == [5, 26, 27]  # now spades may be led
    assert rules.is_legal_action(state, 0, 26)


def test_all_spades_hand_may_lead_spades():
    # Leading with a hand of only spades and spades not broken: the escape valve makes them legal.
    state = _play_state([[26, 27, 28], [], [], []], turn=0, tricks_played=2)
    assert rules.legal_plays(state, 0) == [26, 27, 28]
    assert rules.is_legal_action(state, 0, 26)


def test_trick_winner_highest_of_led_suit_when_no_spade():
    # Clubs led, no spade played: the highest club wins. Clubs 2,5,3,4 -> seat 1 (5♣) wins.
    trick = [(0, 0), (1, 3), (2, 1), (3, 2)]
    assert rules.trick_winner(trick) == 1


def test_trick_winner_lowest_spade_trumps_high_led_suit():
    # Clubs A/K/Q led around a lone 2♠ (26): the spade trumps despite its low rank -> seat 2 wins.
    trick = [(0, 12), (1, 11), (2, 26), (3, 10)]
    assert rules.trick_winner(trick) == 2


def test_trick_winner_highest_spade_among_several():
    # Spades led; among 2♠(26), A♠(38), 6♠(30) plus a club, the ace of spades wins -> seat 1.
    trick = [(0, 26), (1, 38), (2, 30), (3, 0)]
    assert rules.trick_winner(trick) == 1


def test_playing_a_spade_breaks_spades():
    state = _play_state([[], [26], [], []], current_trick=[(0, 0)], turn=1)
    assert state.spades_broken is False
    rules.play_card(state, 26)  # follow-fails: no club, plays a spade
    assert state.spades_broken is True


def test_legal_actions_match_emitted_mask_in_both_phases():
    env = make_env()
    env.reset(seed=0)

    def agree() -> None:
        agent = env.agent_selection
        mask_idx = sorted(int(i) for i in np.flatnonzero(env.observe(agent)["action_mask"]))
        overlay_legal = extract_overlay(env)["legal_actions"]
        rules_legal = rules.legal_actions(env.state, env.state.turn)
        assert mask_idx == overlay_legal == rules_legal

    agree()  # bidding, at reset
    for _ in range(rules.NUM_PLAYERS):
        env.step(AUTO_ACTION)
    agree()  # play, first lead


def test_observe_masks_only_the_acting_seat():
    env = make_env()
    env.reset(seed=0)
    acting = env.agent_selection
    assert int(env.observe(acting)["action_mask"].sum()) > 0
    for agent in env.possible_agents:
        if agent != acting:
            assert int(env.observe(agent)["action_mask"].sum()) == 0


def test_last_trick_is_empty_until_the_first_trick_completes():
    # Before any trick resolves (through bidding and into the first, still-incomplete trick) the
    # last_trick leaf is all -1 and its winner is -1, so a seat cannot mistake "no trick yet" for a
    # real completed trick.
    env = make_env()
    env.reset(seed=0)
    obs = env.observe(env.agent_selection)["observation"]
    assert list(obs["last_trick"]) == [-1, -1, -1, -1]
    assert int(obs["last_trick_winner"][0]) == -1

    for _ in range(rules.NUM_PLAYERS):
        env.step(AUTO_ACTION)  # finish bidding; seat 0 leads, current trick empty
    env.step(AUTO_ACTION)  # one card played, the trick is underway but not complete
    obs = env.observe(env.agent_selection)["observation"]
    assert list(obs["last_trick"]) == [-1, -1, -1, -1]
    assert int(obs["last_trick_winner"][0]) == -1


def test_completed_trick_is_observable_to_every_seat_including_the_next_leader():
    # The core fix: rules clears current_trick when a trick completes, so a seat that leads the next
    # trick was off turn for the plays after its own and would otherwise never see those cards. After
    # a full trick, every seat observes the completed trick (seat -> card) and its winner, and the
    # winner (who leads next) does see the card played after its own move.
    env = make_env()
    env.reset(seed=0)
    for _ in range(rules.NUM_PLAYERS):
        env.step(AUTO_ACTION)

    played = {}
    order = []
    for _ in range(rules.NUM_PLAYERS):
        seat = env.state.turn
        order.append(seat)
        played[seat] = rules.resolve_auto_action(env.state, seat)  # the card AUTO_ACTION will play
        env.step(AUTO_ACTION)

    winner = env.state.last_trick_winner
    assert winner is not None
    assert env.state.turn == winner  # the winner leads the next trick
    assert env.state.current_trick == []  # the live trick is cleared, so only last_trick carries it

    for agent in env.possible_agents:
        obs = env.observe(agent)["observation"]
        assert {s: int(obs["last_trick"][s]) for s in range(rules.NUM_PLAYERS)} == played
        assert int(obs["last_trick_winner"][0]) == winner
    # The winner leads the next trick but was on turn before the seats that played after it, so it
    # never saw their cards live; the fix is precisely that it now observes them. Assert the winner's
    # last_trick carries every card played strictly after its own turn (the information the fix adds).
    leader_obs = env.observe(env.possible_agents[winner])["observation"]
    played_after_winner = order[order.index(winner) + 1 :]
    assert played_after_winner  # seed 0: the winner is not the last to play, so this is non-empty
    for seat in played_after_winner:
        assert int(leader_obs["last_trick"][seat]) == played[seat]


# -- scoring matrix --------------------------------------------------------------------------


def _terminal_state(bids, tricks_won):
    """A terminal ``SpadesState`` carrying the given final bids and per-seat trick counts."""
    return rules.SpadesState(
        hands=[[], [], [], []],
        bids=list(bids),
        current_trick=[],
        trick_leader=0,
        turn=0,
        spades_broken=True,
        tricks_played=rules.NUM_TRICKS,
        tricks_won=list(tricks_won),
    )


def test_scoring_made_contract_without_bags():
    # Team 0 bids 3 + 2 = 5 and takes exactly 5: ten per bid trick, no overtricks.
    assert rules.team_score([3, 0, 2, 0], [3, 0, 2, 0], 0) == 50


def test_scoring_made_contract_with_bags():
    # Bids 5, takes 7: 50 plus one point per overtrick (2 bags).
    assert rules.team_score([3, 0, 2, 0], [4, 0, 3, 0], 0) == 52


def test_scoring_failed_contract():
    # Bids 5, takes 3: minus ten per bid trick.
    assert rules.team_score([3, 0, 2, 0], [1, 0, 2, 0], 0) == -50


def test_scoring_made_nil():
    # Seat 0 bids 3 and takes 3 (contract made, +30); seat 2 makes nil (0 tricks, +100).
    assert rules.team_score([3, 0, 0, 0], [3, 0, 0, 0], 0) == 130


def test_scoring_set_nil_cross_case_is_minus_59():
    # The worked cross-case: seat 0 bid 4 took 3, seat 2 bid nil took 2 (set). The nil's 2 tricks
    # count for the team, so the contract of 4 is made with 5 team tricks: 40 + 1 bag - 100 = -59.
    assert rules.team_score([4, 0, 0, 0], [3, 0, 2, 0], 0) == -59


def test_scoring_double_nil_every_trick_is_a_bag():
    # Both partners bid nil: contract 0, trivially made, so every trick either takes lands as a bag.
    # Both set (2 and 3 tricks): 5 bags - 200 nil = -195.
    assert rules.team_score([0, 0, 0, 0], [2, 0, 3, 0], 0) == -195
    # One made, one set (0 and 3 tricks): 3 bags + 100 - 100 = 3.
    assert rules.team_score([0, 0, 0, 0], [0, 0, 3, 0], 0) == 3


def test_ten_bag_penalty_is_omitted():
    # Eleven bags in one hand carry no penalty (the ten-bag rule is meaningless in a single hand):
    # bid 2, take all 13 -> 20 + 11 bags = 31, with no -100 correction.
    assert rules.team_score([1, 0, 1, 0], [7, 0, 6, 0], 0) == 31


def test_scoring_worst_case_floor_is_minus_260():
    # Both partners bidding 13 makes a contract of 26 that 13 tricks can never satisfy: minus 260,
    # the floor beneath every honest outcome, whatever the trick split.
    assert rules.hand_team_scores(_terminal_state([13, 0, 13, 0], [7, 0, 6, 0]))[0] == -260
    for taken in range(rules.NUM_TRICKS + 1):
        assert rules.team_score([13, 0, 13, 0], [taken, 0, 13 - taken, 0], 0) == -260


def test_leaderboard_scores_partner_identical_higher_better_and_int16():
    # Seat 0 bid 4 took 3 + seat 2 nil took 2 -> team 0 = -59; seat 1 bid 2 took 4 + seat 3 bid 3
    # took 4 -> team 1 = 50 + 3 bags = 53.
    state = _terminal_state([4, 2, 0, 3], [3, 4, 2, 4])
    team = rules.hand_team_scores(state)
    assert team == [-59, 53]
    lb = rules.leaderboard_scores(state)
    assert lb == [team[0], team[1], team[0], team[1]]  # a seat is ranked by how its team fared
    assert lb[0] == lb[2] and lb[1] == lb[3]  # partners share exactly
    assert max(lb) == 53  # higher is better; the making team is best off
    # The -260 floor exceeds int8's -128, so score leaves are int16, not the int8 Hearts uses;
    # every reachable score still fits int16.
    assert not (-128 <= -260 <= 127)
    assert all(-32768 <= score <= 32767 for score in [*lb, -260])


def test_display_scores_equal_leaderboard_scores():
    state = _terminal_state([4, 2, 0, 3], [3, 4, 2, 4])
    assert rules.display_scores(state) == rules.leaderboard_scores(state)


# -- default action --------------------------------------------------------------------------


def test_default_action_is_sentinel_resolving_to_suggested_bid_then_lowest_card():
    assert ENTRY.default_action("player_0") == AUTO_ACTION

    env = make_env()
    env.reset(seed=0)
    # Bidding: the sentinel resolves to the deterministic suggested bid, which is never nil.
    seat = env.state.turn
    expected_bid = rules.suggested_bid(env.state.hands[seat])
    assert expected_bid >= 1
    env.step(AUTO_ACTION)
    assert env.state.bids[seat] == expected_bid

    # Play: the sentinel resolves to the lowest legal card.
    while rules.in_bidding(env.state):
        env.step(AUTO_ACTION)
    seat = env.state.turn
    expected_card = rules.lowest_legal_card(env.state, seat)
    assert len(rules.legal_plays(env.state, seat)) >= 1
    env.step(AUTO_ACTION)
    assert expected_card not in env.state.hands[seat]
    assert env.state.current_trick[-1] == (seat, expected_card)


def test_suggested_bid_is_never_nil_across_many_deals():
    for seed in range(60):
        state = rules.deal(random.Random(seed))
        for seat in range(rules.NUM_PLAYERS):
            assert rules.suggested_bid(state.hands[seat]) >= 1


# -- determinism -----------------------------------------------------------------------------


def _rollout(seed: int):
    """Reset a fresh env and play the env default until terminal, snapshotting observations and
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
        leaves = {**observed["observation"], "action_mask": observed["action_mask"]}
        observations.append({key: np.array(value, copy=True) for key, value in leaves.items()})
        overlays.append(extract_overlay(env))
        env.step(AUTO_ACTION)
    env.close()
    return observations, overlays, deal


def test_same_seed_produces_identical_sequences():
    obs_a, ov_a, deal_a = _rollout(7)
    obs_b, ov_b, deal_b = _rollout(7)

    assert deal_a == deal_b
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


def test_overlay_round_trips_through_json():
    env = make_env()
    env.reset(seed=3)
    for _ in range(12):  # partway through: bids placed and a trick or two underway
        if env.agents:
            env.step(AUTO_ACTION)
    overlay = extract_overlay(env)
    assert json.loads(json.dumps(overlay)) == overlay
    env.close()


# -- renderer --------------------------------------------------------------------------------


def test_renderer_headless_frame_and_hittests_for_both_phases():
    env = make_env("rgb_array")
    env.reset(seed=1)

    # Bidding-phase frame, and a bid-chip click maps to the 52 + k action.
    frame = env.render()
    assert frame.ndim == 3
    assert frame.shape[2] == 3
    assert frame.dtype == np.uint8
    renderer = env._renderer
    chip = renderer.bid_rect(5)
    assert chip is not None
    assert renderer.bid_action_at_pos(chip.center) == rules.bid_to_action(5)  # 57

    # Advance to the play phase and check a card click maps to the expected card.
    for _ in range(rules.NUM_PLAYERS):
        env.step(AUTO_ACTION)
    env.view_seat = 0
    play_frame = env.render()
    assert play_frame.ndim == 3
    card = env.state.hands[0][0]
    rect = renderer.card_rect(card)
    assert rect is not None
    assert renderer.card_at_pos(rect.center) == card
    # No bid chips are drawn during play, so a centre click yields no bid.
    assert renderer.bid_action_at_pos((WIDTH // 2, HEIGHT // 2)) is None

    assert set(make_env().metadata["render_modes"]) >= {"human", "rgb_array"}
    env.close()


# -- metadata --------------------------------------------------------------------------------


def test_metadata_round_trips_through_json():
    parsed = json.loads(json.dumps(ENTRY.meta.to_json()))
    assert parsed["env_id"] == "spades"
    assert parsed["renderer"] == "spades"
    assert parsed["seat_order_matters"] is True
    assert parsed["messaging"] is True
    assert parsed["message_cap"] == 120
    assert parsed["min_slots"] == parsed["max_slots"] == 4
    assert parsed["human_slots"] == ["player_0", "player_1", "player_2", "player_3"]
    assert parsed["pace_interval_ms"] is None
    assert parsed["view_interval_ms"] == 3000
    assert parsed["live_interval_ms"] == 900
    assert parsed["recommended_episode_ticks"] == 56


def test_generated_environments_json_includes_spades():
    path = Path(__file__).resolve().parents[2] / "backend" / "src" / "generated" / "environments.json"
    entries = json.loads(path.read_text(encoding="utf-8"))
    spades = next((entry for entry in entries if entry["env_id"] == "spades"), None)
    assert spades is not None
    assert spades["messaging"] is True
    assert spades["message_cap"] == 120
    assert spades["seat_order_matters"] is True
    assert spades["human_slots"] == ["player_0", "player_1", "player_2", "player_3"]


# -- full game through the harness -----------------------------------------------------------


class FirstLegalAgent:
    """A trivial agent that always takes the first legal action (lowest set mask bit).

    During bidding the lowest legal action is bid 0 (nil); during play it is the lowest-id legal
    card. Deterministic, so a hand-driven replay of the same policy recovers identical scores.
    """

    def reset(self, seed):
        pass

    def act(self, observation):
        return int(np.argmax(observation["action_mask"]))


def _drive_to_terminal(env, choose):
    """Step ``env`` to the end of the hand, playing ``choose(env)`` on a live turn and the env
    default (``None``) on a dead one."""
    while env.agents:
        _obs, _reward, term, trunc, _info = env.last()
        env.step(None if (term or trunc) else choose(env))


def test_full_game_completes_via_run_episode():
    slots = {f"player_{i}": AgentSlot(FirstLegalAgent()) for i in range(rules.NUM_PLAYERS)}
    result = run_episode(ENTRY, slots, seed=0)
    assert result.reason == REASON_TERMINATED
    assert result.ticks == 56  # four bids plus fifty-two plays


def test_run_episode_credits_every_seat_and_partners_share():
    # The harness must record each seat's final leaderboard score, not only whoever played the last
    # card. Drive a full game, then replay the identical deterministic policy by hand and assert the
    # per-seat finals match, and that partners carry the identical team score.
    slots = {f"player_{i}": AgentSlot(FirstLegalAgent()) for i in range(rules.NUM_PLAYERS)}
    result = run_episode(ENTRY, slots, seed=0)

    env = make_env()
    env.reset(seed=0)
    _drive_to_terminal(env, lambda e: int(np.argmax(e.observe(e.agent_selection)["action_mask"])))
    expected = rules.leaderboard_scores(env.state)
    env.close()

    assert result.scores == {f"player_{i}": float(expected[i]) for i in range(rules.NUM_PLAYERS)}
    assert result.scores["player_0"] == result.scores["player_2"]
    assert result.scores["player_1"] == result.scores["player_3"]


def test_full_game_via_defaults_matches_hand_worked_scores():
    env = make_env()
    env.reset(seed=0)
    _drive_to_terminal(env, lambda _env: AUTO_ACTION)
    overlay = extract_overlay(env)
    assert overlay["terminal"] is True
    assert sum(overlay["tricks_won"]) == rules.NUM_TRICKS
    team0 = rules.team_score(overlay["bids"], overlay["tricks_won"], 0)
    team1 = rules.team_score(overlay["bids"], overlay["tricks_won"], 1)
    assert overlay["team_scores"] == [team0, team1]
    assert overlay["leaderboard_scores"] == [team0, team1, team0, team1]
    env.close()
