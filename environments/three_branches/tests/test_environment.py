"""PettingZoo surface and metadata pins for Days at Three Branches."""

from __future__ import annotations

import pytest

from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import resolve_layout, resolve_parameters
from game_sandbox_harness.session import AgentPlayer, Episode
from three_branches import ENTRY, META, PUBLISHED_EXAMPLES
from three_branches.env import (
    ThreeBranchesEnv,
    character_for_player,
    default_action,
    make_env,
    player_for_character,
)
from three_branches.geometry import Point, add, distance, heading_vector
from three_branches.layout import Layout
from three_branches.rules import DAY_TICKS


def _actions(env: ThreeBranchesEnv) -> dict[str, dict[str, float | int]]:
    return {player: default_action(env, player) for player in env.agents}


def _standing_point_near(layout: Layout, target: Point) -> Point:
    """A body-clear point within 1.5 m of ``target``, or the plain west offset as a fallback."""
    for radius in (0.8, 1.0, 1.2):
        for step in range(16):
            candidate = add(target, heading_vector(step * 360.0 / 16), radius)
            if distance(candidate, target) <= 1.5 and layout.body_clear(candidate):
                return candidate
    return target[0] - 1.0, target[1]


@pytest.mark.parametrize(("seat_plan", "player_count"), (("cast_5", 6), ("cast_10", 11)))
def test_spaces_are_shared_and_cover_the_opening_roster(seat_plan: str, player_count: int) -> None:
    env = make_env({"seat_plan": seat_plan, "daynight": False})
    observations, infos = env.reset(seed=17)

    assert env.possible_agents == [f"player_{index}" for index in range(player_count)]
    assert env.observation_space("player_0") is env.observation_space(env.possible_agents[-1])
    assert env.action_space("player_0") is env.action_space(env.possible_agents[-1])
    assert list(observations) == env.possible_agents
    assert list(infos) == env.possible_agents
    assert all(
        env.observation_space(player).contains(observation) for player, observation in observations.items()
    )
    assert observations["player_0"]["tick"] == 1
    assert [entry["id"] for entry in observations["player_0"]["roster"]] == [
        *(f"npc_{index}" for index in range(player_count - 1)),
        "visitor",
    ]


def test_seat_plans_and_literal_season_presets_match_the_design() -> None:
    assert [[seat.players for seat in plan.seats] for plan in META.layout.plans] == [
        [tuple(range(1, 6)), (0,)],
        [tuple(range(1, 11)), (0,)],
    ]
    assert META.human_players == ("player_0",)
    assert [(preset.name, dict(preset.values)) for preset in META.presets] == [
        ("season_1", {"seat_plan": "cast_5", "daynight": False}),
        ("season_2", {"seat_plan": "cast_10", "daynight": False}),
        ("season_3", {"seat_plan": "cast_10", "daynight": False}),
        ("season_4", {"seat_plan": "cast_10", "daynight": True}),
        ("season_5", {"seat_plan": "cast_10", "daynight": True}),
        ("season_6", {"seat_plan": "cast_10", "daynight": True}),
    ]
    assert ENTRY.meta is META
    assert PUBLISHED_EXAMPLES == ()


def test_player_and_character_mapping_is_fixed_and_inverse() -> None:
    assert player_for_character("visitor") == "player_0"
    assert character_for_player("player_0") == "visitor"
    for index in range(10):
        assert player_for_character(f"npc_{index}") == f"player_{index + 1}"
        assert character_for_player(f"player_{index + 1}") == f"npc_{index}"
    with pytest.raises(ValueError, match="unknown player"):
        character_for_player("visitor")
    with pytest.raises(ValueError, match="unknown character"):
        player_for_character("npc_10")


def test_default_action_uses_the_current_heading_and_all_space_values_are_legal() -> None:
    env = make_env({"seat_plan": "cast_5", "daynight": False})
    env.reset(seed=3)
    env.day.characters["visitor"].heading = 271.5

    action = default_action(env, "player_0")

    assert action == {"heading": 271.5, "speed": 0.0, "action": 0}
    assert env.action_space("player_0").contains(action)


def test_out_of_space_actions_name_the_player_and_in_space_use_reaches_the_engine() -> None:
    env = make_env({"seat_plan": "cast_5", "daynight": False})
    env.reset(seed=3)
    actions = _actions(env)
    actions["player_0"] = {"heading": 0.0, "speed": 1.1, "action": 0}
    with pytest.raises(ValueError, match="player_0"):
        env.step(actions)

    env.reset(seed=3)
    bell = next(prop for prop in env.day.layout.props if prop.id == "bell_0")
    visitor = env.day.characters["visitor"]
    visitor.position = _standing_point_near(env.day.layout, bell.position)
    env.day.physics.bodies["visitor"].position = visitor.position
    actions = _actions(env)
    actions["player_0"] = {"heading": 0.0, "speed": 0.0, "action": 1}
    env.step(actions)

    assert env.day.characters["visitor"].expression.target == "bell_0"


def test_full_episode_keeps_terminal_observations_and_terminates_everyone() -> None:
    env = make_env({"seat_plan": "cast_5", "daynight": True})
    observations, _infos = env.reset(seed=11)
    while env.agents:
        active = list(env.agents)
        observations, rewards, terminations, truncations, infos = env.step(_actions(env))
        assert (
            set(observations)
            == set(rewards)
            == set(terminations)
            == set(truncations)
            == set(infos)
            == set(active)
        )
        assert all(env.observation_space(player).contains(observations[player]) for player in active)

    assert all(reward == 100.0 for reward in rewards.values())
    assert all(terminations.values())
    assert not any(truncations.values())
    assert all(observation["tick"] == DAY_TICKS for observation in observations.values())


def test_crashing_cast_member_marks_the_whole_cast_seat_for_the_zero_forfeit_floor() -> None:
    class StandingAgent:
        def reset(self, seed: int, observation: object) -> None:
            del seed, observation

        def act(self, observation: dict[str, object]) -> dict[str, float | int]:
            self_state = observation["self"]
            assert isinstance(self_state, dict)
            return {"heading": float(self_state["heading"]), "speed": 0.0, "action": 0}

    class CrashingAgent(StandingAgent):
        def act(self, observation: dict[str, object]) -> dict[str, float | int]:
            del observation
            raise RuntimeError("village worker crashed")

    parameters = resolve_parameters(META)
    players = {f"player_{index}": AgentPlayer(StandingAgent()) for index in range(6)}
    players["player_1"] = AgentPlayer(CrashingAgent())
    layout = resolve_layout(META, parameters)

    with Episode(ENTRY, players, parameters=parameters, seed=13, clock=ManualClock()) as episode:
        with pytest.raises(RuntimeError, match="village worker crashed"):
            episode.advance()
        result = episode.result()

    cast_seat = next(seat for seat in layout.seats if result.failed_player in seat.players)
    assert result.failed_player == "player_1"
    assert cast_seat.players == ("player_1", "player_2", "player_3", "player_4", "player_5")
    assert result.scores == {f"player_{index}": 0.0 for index in range(6)}
