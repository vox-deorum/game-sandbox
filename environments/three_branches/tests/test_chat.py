"""Speech-policy range, ordering, and wall pins for Days at Three Branches."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

import pytest

from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import resolve_parameters
from game_sandbox_harness.session import AgentPlayer, run_episode
from three_branches import ENTRY, META
from three_branches.env import ThreeBranchesEnv, make_env


def _place(env, character_id: str, position: tuple[float, float], heading: float = 0.0) -> None:
    character = env.day.characters[character_id]
    character.position = position
    character.heading = heading
    env.day.physics.bodies[character_id].position = position


def test_chat_policy_orders_talk_recipients_by_distance_then_roster_order() -> None:
    env = make_env({"seat_plan": "cast_5", "daynight": False})
    env.reset(seed=1)
    _place(env, "visitor", (30.0, 60.0))
    _place(env, "npc_0", (32.0, 60.0))
    _place(env, "npc_1", (28.0, 60.0))
    _place(env, "npc_2", (35.0, 60.0))

    policy = env.chat_policy("player_0")

    assert policy == {
        "target_recipients": ("player_1", "player_2"),
        "default_recipient": "player_1",
    }


def test_chat_policy_excludes_wall_blocked_targets() -> None:
    env = make_env({"seat_plan": "cast_5", "daynight": False})
    env.reset(seed=1)
    _place(env, "visitor", (8.0, 65.0))
    _place(env, "npc_0", (12.0, 65.0))

    assert env.chat_policy("player_0") == {"target_recipients": (), "default_recipient": None}


def test_npc_broadcast_uses_shout_range_and_visitor_uses_talk_range() -> None:
    env = make_env({"seat_plan": "cast_5", "daynight": False})
    env.reset(seed=1)
    _place(env, "npc_0", (30.0, 60.0))
    _place(env, "npc_1", (40.0, 60.0))
    _place(env, "visitor", (34.0, 60.0))

    assert env.broadcast_recipients("player_1") == ("player_2", "player_0")
    assert env.broadcast_recipients("player_0") == ()


def test_talk_policy_is_read_before_the_step_and_broadcast_audience_after_it() -> None:
    env = make_env({"seat_plan": "cast_5", "daynight": False})
    env.reset(seed=1)
    _place(env, "visitor", (30.0, 60.0), 180.0)
    _place(env, "npc_0", (33.0, 60.0))

    # The harness reads this before applying the joint action, while the visitor is in talk range.
    assert env.chat_policy("player_0")["target_recipients"] == ("player_1",)
    actions = {player_id: {"heading": 0.0, "speed": 0.0, "action": 0} for player_id in env.agents}
    actions["player_0"] = {"heading": 180.0, "speed": 1.0, "action": 0}
    env.step(actions)

    # Delivery resolves its broadcast audience after that transition, from the new position.
    assert env.broadcast_recipients("player_0") == ()


class _StandingAgent:
    """Use the normal legal stand-still order throughout a short harness run."""

    def reset(self, seed: int, observation: Any) -> None:
        del seed, observation

    def act(self, observation: dict[str, Any]) -> dict[str, float | int]:
        return {"heading": float(observation["self"]["heading"]), "speed": 0.0, "action": 0}


class _Sender(_StandingAgent):
    """Send one accepted message and one message one code point over the cap."""

    def __init__(self) -> None:
        self._sent = False

    def chat(self, inbox: list[dict[str, Any]]) -> list[dict[str, str]]:
        assert inbox == []
        if self._sent:
            return []
        self._sent = True
        return [
            {"to": "player_1", "text": "a" * 200},
            {"to": "player_1", "text": "b" * 201},
        ]


class _DelayedResponder(_StandingAgent):
    """Choose action 1 only after its chat hook has read the sender's message."""

    def __init__(self) -> None:
        self.actions: list[int] = []
        self.inboxes: list[list[dict[str, Any]]] = []
        self._message_seen = False

    def act(self, observation: dict[str, Any]) -> dict[str, float | int]:
        action = 1 if self._message_seen else 0
        self.actions.append(action)
        return {"heading": float(observation["self"]["heading"]), "speed": 0.0, "action": action}

    def chat(self, inbox: list[dict[str, Any]]) -> list[dict[str, str]]:
        self.inboxes.append(inbox)
        self._message_seen = bool(inbox)
        return []


def _talking_entry():
    """Make the visitor and first villager direct-message neighbors at reset."""

    def make(parameters: dict[str, str | bool]) -> ThreeBranchesEnv:
        env = make_env(parameters)
        reset = env.reset

        def reset_in_talk_range(*args: Any, **kwargs: Any):
            observations, infos = reset(*args, **kwargs)
            _place(env, "visitor", (30.0, 60.0))
            _place(env, "npc_0", (32.0, 60.0))
            return observations, infos

        env.reset = reset_in_talk_range  # type: ignore[method-assign]
        return env

    return replace(ENTRY, make=make)


def test_harness_delivers_chat_after_the_next_action_and_enforces_the_200_code_point_cap(
    capsys: pytest.CaptureFixture[str],
) -> None:
    entry = _talking_entry()
    sender = _Sender()
    responder = _DelayedResponder()
    players = {f"player_{index}": AgentPlayer(_StandingAgent()) for index in range(6)}
    players["player_0"] = AgentPlayer(sender)
    players["player_1"] = AgentPlayer(responder)

    result = run_episode(
        entry,
        players,
        parameters=resolve_parameters(META),
        seed=7,
        clock=ManualClock(),
        max_steps=3,
    )

    message = {"from": "player_0", "to": "player_1", "text": "a" * 200, "tick": 0}
    assert responder.inboxes == [[], [message], []]
    # The recipient selects its tick-1 action before the tick-0 message reaches its chat hook.
    # Its first message-dependent action is therefore tick 2.
    assert responder.actions == [0, 0, 1]
    assert result.ticks == 3
    assert "201 code points over the cap of 200" in capsys.readouterr().err
