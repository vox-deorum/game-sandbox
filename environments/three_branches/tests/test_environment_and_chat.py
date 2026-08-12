from __future__ import annotations

import numpy as np
import pytest

from game_sandbox_harness.environment import resolve_parameters
from game_sandbox_harness.session import AgentPlayer, Episode
from three_branches import ENTRY
from three_branches.env import default_action, make_env


class _StillAgent:
    def reset(self, seed, observation) -> None:
        del seed, observation

    def act(self, observation):
        return {
            "heading": np.array(observation["self"]["heading"], dtype=np.float32),
            "speed": np.array(0, dtype=np.float32),
            "action": 0,
        }


class _Sender(_StillAgent):
    def __init__(self) -> None:
        self.sent = False

    def chat(self, inbox):
        del inbox
        if self.sent:
            return []
        self.sent = True
        return [{"to": "player_6", "text": "hello"}]


class _Recipient(_StillAgent):
    def __init__(self) -> None:
        self.received = False
        self.action_saw_message: list[bool] = []

    def act(self, observation):
        self.action_saw_message.append(self.received)
        return super().act(observation)

    def chat(self, inbox):
        if inbox:
            self.received = True
        return []


@pytest.mark.parametrize("seat_plan, players", [("cast_5", 6), ("cast_10", 11)])
def test_parallel_environment_plans_spaces_and_chat(seat_plan: str, players: int) -> None:
    env = make_env({"seat_plan": seat_plan, "daynight": False})
    observations, _ = env.reset(seed=4)
    assert list(observations) == env.possible_agents and len(observations) == players
    assert [observation["self"]["id"] for observation in observations.values()] == [
        "visitor",
        *(f"npc_{index}" for index in range(players - 1)),
    ]
    assert all(env.observation_space(agent).contains(observations[agent]) for agent in env.agents)
    actions = {agent: default_action(env, agent) for agent in env.agents}
    assert all(env.action_space(agent).contains(action) for agent, action in actions.items())
    observations, rewards, terms, truncations, _ = env.step(actions)
    assert observations["player_0"]["tick"] == 2
    assert all(reward == 0 for reward in rewards.values())
    assert not any(terms.values()) and not any(truncations.values())
    assert env.chat_policy("player_0")["default_recipient"] is None
    assert env.broadcast_recipients("player_0") == env.chat_policy("player_0")["target_recipients"]


def test_observations_do_not_share_mutable_village_data() -> None:
    env = make_env({"seat_plan": "cast_5", "daynight": False})
    observations, _ = env.reset(seed=4)
    visitor_village = observations["player_0"]["village"]
    npc_village = observations["player_1"]["village"]
    visitor_village["spawn"]["x"] = np.array(99, dtype=np.float32)
    visitor_village["props"][0]["cell"]["x"] = 99
    assert float(npc_village["spawn"]["x"]) != 99
    assert npc_village["props"][0]["cell"]["x"] != 99

    actions = {agent: default_action(env, agent) for agent in env.agents}
    later, _, _, _, _ = env.step(actions)
    assert float(later["player_0"]["village"]["spawn"]["x"]) != 99
    assert later["player_0"]["village"]["props"][0]["cell"]["x"] != 99


def test_parallel_environment_rejects_missing_and_outside_actions() -> None:
    env = make_env({"seat_plan": "cast_5", "daynight": False})
    env.reset()
    with pytest.raises(ValueError, match="exactly"):
        env.step({})
    actions = {agent: default_action(env, agent) for agent in env.agents}
    actions["player_0"] = {
        "heading": np.array(0, dtype=np.float32),
        "speed": np.array(2, dtype=np.float32),
        "action": 0,
    }
    with pytest.raises(ValueError, match="outside"):
        env.step(actions)


def test_direct_policy_is_pre_step_but_broadcast_audience_is_post_step() -> None:
    env = make_env({"seat_plan": "cast_5", "daynight": False})
    env.reset()
    env.day.characters["visitor"].position = (15.0, 50.5)
    env.day.physics._bodies["visitor"].position = (15.0, 50.5)
    env.day.characters["npc_0"].position = (20.9, 50.5)
    env.day.physics._bodies["npc_0"].position = (20.9, 50.5)
    assert "player_1" in env.chat_policy("player_0")["target_recipients"]

    actions = {agent: default_action(env, agent) for agent in env.agents}
    actions["player_0"] = {
        "heading": np.array(180, dtype=np.float32),
        "speed": np.array(1, dtype=np.float32),
        "action": 0,
    }
    env.step(actions)
    assert "player_1" not in env.broadcast_recipients("player_0")


def test_a_message_sent_on_t_is_first_actionable_on_t_plus_two() -> None:
    recipient = _Recipient()
    players = {player: AgentPlayer(_StillAgent()) for player in (f"player_{i}" for i in range(11))}
    players["player_1"] = AgentPlayer(_Sender())
    players["player_6"] = AgentPlayer(recipient)
    with Episode(
        ENTRY,
        players,
        parameters=resolve_parameters(ENTRY.meta, {"seat_plan": "cast_10"}),
        seed=3,
        max_steps=3,
    ) as episode:
        while not episode.done:
            episode.advance()
    assert recipient.action_saw_message == [False, False, True]
