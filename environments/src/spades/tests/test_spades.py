"""Environment-level tests for Spades: PettingZoo API conformance, the pure rules engine (bidding
and play legality, trick resolution, and the scoring matrix), the legal-action/overlay/rules
three-way agreement, seeded determinism, metadata serialization, and a full
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

import importlib.util
import json
import random
from pathlib import Path

import numpy as np
import pytest

from game_sandbox_harness.manifest import load_agent
from game_sandbox_harness.session import REASON_TERMINATED, AgentSlot, run_episode
from spades import ENTRY, rules
from spades.env import IllegalMoveError, card_to_obj, default_action, make_env
from spades.overlay import extract_overlay

#: The frozen v1 built-in Spades baseline the session image stages and the harness loads for every
#: Naive seat (``backend/images/session-base/deps-v1/builtin/spades``), from this repo's root.
BUILTIN_SPADES_AGENT_DIR = (
    Path(__file__).resolve().parents[4] / "backend/images/session-base/deps-v1/builtin/spades"
)

# -- bidding legality ------------------------------------------------------------------------


def test_seat_zero_bids_first_and_leads():
    # The fixed convention the scheduler, examples, and e2e journeys rely on: seat 0 opens the
    # bidding, and once bidding is done seat 0 leads the first trick.
    env = make_env()
    env.reset(seed=0)
    assert env.agent_selection == "player_0"
    assert env.state.turn == 0
    for _ in range(rules.NUM_PLAYERS):
        env.step(default_action(env, env.agent_selection))
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
        env.step(default_action(env, env.agent_selection))
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
        env.step(default_action(env, env.agent_selection))
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
        rules_legal = rules.legal_actions(env.state, env.state.turn)
        assert mask_idx == rules_legal

        overlay = extract_overlay(env)
        if rules.in_bidding(env.state):
            assert overlay["legal_bids"] == list(rules.legal_bids(env.state, env.state.turn))
            assert overlay["legal_cards"] == []
        else:
            assert overlay["legal_cards"] == [
                card_to_obj(c) for c in rules.legal_plays(env.state, env.state.turn)
            ]
            assert overlay["legal_bids"] == []

    agree()  # bidding, at reset
    for _ in range(rules.NUM_PLAYERS):
        env.step(default_action(env, env.agent_selection))
    agree()  # play, first lead


def test_observe_masks_only_the_acting_seat():
    env = make_env()
    env.reset(seed=0)
    acting = env.agent_selection
    assert int(env.observe(acting)["action_mask"].sum()) > 0
    for agent in env.possible_agents:
        if agent != acting:
            assert int(env.observe(agent)["action_mask"].sum()) == 0


def test_observation_partnership_bids_and_phase_fields():
    # Pins the object observation contract: partner_seat (not partner arithmetic in the agent),
    # phase 0/1, hand as face-value card objects, and bids using 14 as the "unbid" sentinel.
    env = make_env()
    env.reset(seed=0)
    seat = env.state.turn
    inner = env.observe(env.agent_selection)["observation"]

    assert inner["seat"] == seat
    assert inner["partner_seat"] == (seat + 2) % 4
    assert inner["phase"] == 0  # bidding, nothing bid yet
    assert inner["bids"] == (14, 14, 14, 14)  # UNBID sentinel before anyone has bid
    assert inner["hand"] == tuple(card_to_obj(c) for c in env.state.hands[seat])
    assert inner["led_suit"] == 4  # no trick underway during bidding
    assert inner["last_trick_winner"] == 4

    # After one bid, that seat's bids entry is the real value; the rest stay 14 (unbid).
    bid_action = ENTRY.default_action(env, env.agent_selection)
    env.step(bid_action)
    inner = env.observe(env.agent_selection)["observation"]
    assert inner["bids"][seat] == rules.action_to_bid(bid_action)
    assert inner["bids"].count(14) == 3

    # Finish bidding: phase flips to 1 (play) and every bids entry is a real 0..13 value.
    while rules.in_bidding(env.state):
        env.step(ENTRY.default_action(env, env.agent_selection))
    inner = env.observe(env.agent_selection)["observation"]
    assert inner["phase"] == 1
    assert all(0 <= b <= 13 for b in inner["bids"])
    assert inner["bids"] == tuple(env.state.bids)


def test_last_trick_is_empty_until_the_first_trick_completes():
    # Before any trick resolves (through bidding and into the first, still-incomplete trick) the
    # last_trick leaf is an empty tuple and its winner is 4 (the "none" sentinel), so a seat cannot
    # mistake "no trick yet" for a real completed trick.
    env = make_env()
    env.reset(seed=0)
    obs = env.observe(env.agent_selection)["observation"]
    assert obs["last_trick"] == ()
    assert obs["last_trick_winner"] == 4

    for _ in range(rules.NUM_PLAYERS):
        env.step(default_action(env, env.agent_selection))  # finish bidding; seat 0 leads
    env.step(default_action(env, env.agent_selection))  # one card played, trick underway but incomplete
    obs = env.observe(env.agent_selection)["observation"]
    assert obs["last_trick"] == ()
    assert obs["last_trick_winner"] == 4


def test_completed_trick_is_observable_to_every_seat_including_the_next_leader():
    # The core fix: rules clears current_trick when a trick completes, so a seat that leads the next
    # trick was off turn for the plays after its own and would otherwise never see those cards. After
    # a full trick, every seat observes the completed trick (seat -> card) and its winner, and the
    # winner (who leads next) does see the card played after its own move.
    env = make_env()
    env.reset(seed=0)
    for _ in range(rules.NUM_PLAYERS):
        env.step(default_action(env, env.agent_selection))

    played = {}
    order = []
    for _ in range(rules.NUM_PLAYERS):
        seat = env.state.turn
        order.append(seat)
        played[seat] = rules.resolve_auto_action(env.state, seat)  # the card default_action will play
        env.step(default_action(env, env.agent_selection))

    winner = env.state.last_trick_winner
    assert winner is not None
    assert env.state.turn == winner  # the winner leads the next trick
    assert env.state.current_trick == []  # the live trick is cleared, so only last_trick carries it

    expected_last_trick = tuple({"seat": s, "card": card_to_obj(played[s])} for s in order)
    for agent in env.possible_agents:
        obs = env.observe(agent)["observation"]
        assert obs["last_trick"] == expected_last_trick
        assert obs["last_trick_winner"] == winner
    # The winner leads the next trick but was on turn before the seats that played after it, so it
    # never saw their cards live; the fix is precisely that it now observes them. Assert the winner's
    # last_trick carries every card played strictly after its own turn (the information the fix adds).
    leader_obs = env.observe(env.possible_agents[winner])["observation"]
    played_after_winner = order[order.index(winner) + 1 :]
    assert played_after_winner  # seed 0: the winner is not the last to play, so this is non-empty
    by_seat = {entry["seat"]: entry["card"] for entry in leader_obs["last_trick"]}
    for seat in played_after_winner:
        assert by_seat[seat] == card_to_obj(played[seat])


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


def test_default_action_returns_real_bid_then_lowest_card():
    # The timeout hook now receives the live env and slot id and returns the concrete action that
    # will be applied — a never-nil suggested bid during bidding, the lowest legal card during play
    # — rather than a sentinel, so a timeout recording holds the real action. default_action is a
    # module-level function in env.py and is the same callable as ENTRY.default_action.
    env = make_env()
    env.reset(seed=0)
    assert ENTRY.default_action is default_action

    # Bidding: the hook returns the deterministic suggested bid (never nil) as a bid action.
    seat = env.state.turn
    expected_bid = rules.suggested_bid(env.state.hands[seat])
    assert expected_bid >= 1
    action = ENTRY.default_action(env, env.agent_selection)
    assert action == rules.bid_to_action(expected_bid)
    assert isinstance(action, int)
    env.step(action)
    assert env.state.bids[seat] == expected_bid

    # Finish bidding through the hook, then play: the hook returns the lowest legal card.
    while rules.in_bidding(env.state):
        env.step(ENTRY.default_action(env, env.agent_selection))
    seat = env.state.turn
    expected_card = rules.lowest_legal_card(env.state, seat)
    assert len(rules.legal_plays(env.state, seat)) >= 1
    action = ENTRY.default_action(env, env.agent_selection)
    assert action == expected_card
    env.step(action)
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
        snapshot = {
            key: (np.array(value, copy=True) if isinstance(value, np.ndarray) else value)
            for key, value in leaves.items()
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


def test_generated_environments_json_includes_spades():
    path = Path(__file__).resolve().parents[4] / "backend" / "src" / "generated" / "environments.json"
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
    _drive_to_terminal(env, lambda e: default_action(e, e.agent_selection))
    overlay = extract_overlay(env)
    assert overlay["terminal"] is True
    assert sum(overlay["tricks_won"]) == rules.NUM_TRICKS
    team0 = rules.team_score(overlay["bids"], overlay["tricks_won"], 0)
    team1 = rules.team_score(overlay["bids"], overlay["tricks_won"], 1)
    assert overlay["team_scores"] == [team0, team1]
    assert overlay["leaderboard_scores"] == [team0, team1, team0, team1]
    env.close()


# -- the frozen on-disk built-in baseline ----------------------------------------------------


def _load_builtin_agent_module(agent_dir: Path):
    """Import a builtin agent module straight from its on-disk ``agent.py``.

    The builtin baselines ship in a separate deployment image and import only the standard library,
    so exec-loading one in isolation is safe and lets a test reach its module-level helpers (here the
    vendored ``_suggested_bid``) to pin them to the rules engine they copy.
    """
    spec = importlib.util.spec_from_file_location(f"_builtin_{agent_dir.name}", agent_dir / "agent.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_builtin_suggested_bid_matches_the_rules_engine():
    # The builtin Naive baseline cannot import spades.rules (it lives in a separate image), so it
    # vendors a copy of suggested_bid. Nothing else pins the copy to the source, so this does: over
    # many dealt hands the two must agree exactly. If a future tune of rules.suggested_bid is not
    # mirrored into the builtin, the "a Naive-filled table behaves identically to a table of timed-out
    # seats" promise silently breaks, and this catches it.
    builtin = _load_builtin_agent_module(BUILTIN_SPADES_AGENT_DIR)
    for seed in range(200):
        state = rules.deal(random.Random(seed))
        for seat in range(rules.NUM_PLAYERS):
            hand = list(state.hands[seat])
            assert builtin._suggested_bid(hand) == rules.suggested_bid(hand)


def test_builtin_spades_agent_plays_a_full_legal_game():
    # The session image stages a per-environment Naive baseline at /opt/agents/builtin/<env_id>, and
    # the harness loads it (through the manifest loader, as the container does) for every Naive seat.
    # Driving four copies to a clean terminal guards that the per-environment baseline exists, loads,
    # and plays only legal bids and cards to the end of the hand.
    slots = {f"player_{i}": AgentSlot(load_agent(BUILTIN_SPADES_AGENT_DIR)) for i in range(rules.NUM_PLAYERS)}
    result = run_episode(ENTRY, slots, seed=0)
    assert result.reason == REASON_TERMINATED
    assert result.ticks == 56  # four bids plus fifty-two plays

    # The baseline plays the env's own timeout default (a never-nil suggested bid, then the lowest
    # legal card), so a hand driven by that default must reach the identical deterministic finals.
    env = make_env()
    env.reset(seed=0)
    _drive_to_terminal(env, lambda e: default_action(e, e.agent_selection))
    expected = rules.leaderboard_scores(env.state)
    env.close()
    assert result.scores == {f"player_{i}": float(expected[i]) for i in range(rules.NUM_PLAYERS)}
