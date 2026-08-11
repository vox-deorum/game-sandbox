"""PettingZoo parallel surface for Days at Three Branches."""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, cast

import numpy as np
from gymnasium import spaces
from pettingzoo.utils.env import ParallelEnv

from .engine import Day, DayConfig, Order
from .geometry import distance
from .layout import WORLD_SIZE
from .rules import DAY_TICKS, EMOTES, PROFILE

if TYPE_CHECKING:
    from game_sandbox_harness.environment import ParameterValue

    from .observation_types import (
        Building,
        Character,
        NearbyCharacter,
        Position,
        RosterEntry,
        ThreeBranchesAction,
        ThreeBranchesObservation,
        Village,
    )


SEAT_PLAN_SPECS = (
    ("cast_5", "Five villagers", (tuple(range(1, 6)), (0,))),
    ("cast_10", "Ten villagers", (tuple(range(1, 11)), (0,))),
)

_TEXT_CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789_"


def player_for_character(character_id: str) -> str:
    """Return the fixed PettingZoo player id for one rules-level character id."""
    if character_id == "visitor":
        return "player_0"
    if character_id.startswith("npc_"):
        suffix = character_id.removeprefix("npc_")
        if suffix.isdigit() and str(int(suffix)) == suffix and 0 <= int(suffix) < 10:
            return f"player_{int(suffix) + 1}"
    raise ValueError(f"unknown character {character_id!r}")


def character_for_player(player_id: str) -> str:
    """Return the fixed rules-level character id for one PettingZoo player id."""
    if not player_id.startswith("player_") or not player_id.removeprefix("player_").isdigit():
        raise ValueError(f"unknown player {player_id!r}")
    index = int(player_id.removeprefix("player_"))
    if str(index) != player_id.removeprefix("player_") or not 0 <= index <= 10:
        raise ValueError(f"unknown player {player_id!r}")
    return "visitor" if index == 0 else f"npc_{index - 1}"


def _parameter(parameters: Mapping[str, ParameterValue], name: str, expected: type) -> Any:
    if name not in parameters:
        raise ValueError(f"missing environment parameter {name!r}")
    value = parameters[name]
    if type(value) is not expected:
        raise ValueError(f"{name} must be a {expected.__name__}")
    return value


def make_env(parameters: Mapping[str, ParameterValue]) -> ThreeBranchesEnv:
    """Construct a fresh environment from complete, resolved gameplay parameters."""
    if set(parameters) != {"seat_plan", "daynight"}:
        raise ValueError("three_branches requires exactly seat_plan and daynight parameters")
    seat_plan = _parameter(parameters, "seat_plan", str)
    if seat_plan not in {key for key, _title, _seats in SEAT_PLAN_SPECS}:
        raise ValueError("seat_plan must be cast_5 or cast_10")
    return ThreeBranchesEnv(seat_plan=seat_plan, daynight=_parameter(parameters, "daynight", bool))


def default_action(env: ThreeBranchesEnv, player_id: str) -> ThreeBranchesAction:
    """Return the always-legal stand-still action using the player's current heading."""
    if player_id not in env.agents:
        raise ValueError(f"inactive player {player_id!r} has no default action")
    character = character_for_player(player_id)
    return {"heading": float(env.day.characters[character].heading), "speed": 0.0, "action": 0}


def _scalar(low: float, high: float) -> spaces.Box:
    return spaces.Box(low=low, high=high, shape=(), dtype=np.float32)


def _text(max_length: int) -> spaces.Text:
    return spaces.Text(max_length=max_length, min_length=1, charset=_TEXT_CHARSET)


def _position_space() -> spaces.Dict:
    return spaces.Dict({"x": _scalar(0.0, WORLD_SIZE), "y": _scalar(0.0, WORLD_SIZE)})


class ThreeBranchesEnv(ParallelEnv[str, dict[str, Any], dict[str, Any]]):
    """A simultaneous, full-roster village day with no state-dependent illegal actions."""

    metadata = {"name": "three_branches_v0", "render_modes": []}

    def __init__(self, *, seat_plan: str = "cast_5", daynight: bool = False) -> None:
        if seat_plan not in {key for key, _title, _seats in SEAT_PLAN_SPECS}:
            raise ValueError("seat_plan must be cast_5 or cast_10")
        self.seat_plan = seat_plan
        self.daynight = daynight
        self.cast_size = 5 if seat_plan == "cast_5" else 10
        self.possible_agents = [f"player_{index}" for index in range(self.cast_size + 1)]
        self.agents: list[str] = []
        self.day: Day
        self._village: Village
        self._roster: tuple[RosterEntry, ...]

        position = _position_space()
        expression = spaces.Dict({"type": _text(10), "target": _text(16)})
        character = spaces.Dict(
            {
                "id": _text(8),
                "position": position,
                "heading": _scalar(0.0, 360.0),
                "moved": _scalar(0.0, 1.0),
                "expression": expression,
            }
        )
        nearby = spaces.Dict({"id": _text(8), "position": position})
        route = spaces.Dict({"points": spaces.Sequence(position), "width": _scalar(0.0, WORLD_SIZE)})
        bridge = spaces.Dict(
            {
                "position": position,
                "heading": _scalar(0.0, 360.0),
                "width": _scalar(0.0, WORLD_SIZE),
                "span": _scalar(0.0, WORLD_SIZE),
            }
        )
        building = spaces.Dict(
            {
                "id": _text(16),
                "type": _text(12),
                "center": position,
                "width": _scalar(0.0, WORLD_SIZE),
                "depth": _scalar(0.0, WORLD_SIZE),
                "rotation": _scalar(0.0, 360.0),
                "doorway": spaces.Dict({"position": position, "width": _scalar(0.0, WORLD_SIZE)}),
            }
        )
        prop = spaces.Dict(
            {
                "id": _text(16),
                "type": _text(12),
                "position": position,
                "footprint": spaces.Dict(
                    {"width": _scalar(0.0, WORLD_SIZE), "depth": _scalar(0.0, WORLD_SIZE)}
                ),
                "rotation": _scalar(0.0, 360.0),
            }
        )
        scenery = spaces.Dict({"type": _text(12), "position": position, "radius": _scalar(0.0, WORLD_SIZE)})
        village = spaces.Dict(
            {
                "channels": spaces.Tuple([route] * 4),
                "road": route,
                "footpaths": spaces.Sequence(route),
                "bridges": spaces.Sequence(bridge),
                "buildings": spaces.Tuple([building] * 7),
                "fields": spaces.Sequence(spaces.Sequence(position)),
                "reed_banks": spaces.Sequence(spaces.Sequence(position)),
                "props": spaces.Sequence(prop),
                "scenery": spaces.Sequence(scenery),
                "spawn": position,
            }
        )
        roster_entry = spaces.Dict({"id": _text(8), "home": _text(16)})
        observation = spaces.Dict(
            {
                "self": character,
                "seen": spaces.Sequence(character),
                "nearby": spaces.Sequence(nearby),
                "props": spaces.Sequence(spaces.Dict({"prop": _text(16), "state": _text(9)})),
                "bell": spaces.Discrete(2),
                "tick": spaces.Discrete(DAY_TICKS, start=1),
                "phase": _text(7),
                "village": village,
                "roster": spaces.Tuple([roster_entry] * (self.cast_size + 1)),
                "parameters": spaces.Dict({"seat_plan": _text(7), "daynight": spaces.Discrete(2)}),
            }
        )
        action = spaces.Dict(
            {
                "heading": _scalar(0.0, 360.0),
                "speed": _scalar(0.0, 1.0),
                "action": spaces.Discrete(11),
            }
        )
        self._observation_spaces = {agent: observation for agent in self.possible_agents}
        self._action_spaces = {agent: action for agent in self.possible_agents}

    def observation_space(self, agent: str) -> spaces.Dict:
        self._require_known_agent(agent)
        return self._observation_spaces[agent]

    def action_space(self, agent: str) -> spaces.Dict:
        self._require_known_agent(agent)
        return self._action_spaces[agent]

    def reset(
        self, seed: int | None = None, options: dict[str, object] | None = None
    ) -> tuple[dict[str, ThreeBranchesObservation], dict[str, dict[str, object]]]:
        """Start a seeded day at tick one. The harness always seeds; an omitted seed replays seed 0."""
        self.day = Day(
            DayConfig(seed=0 if seed is None else seed, cast_size=self.cast_size, daynight=self.daynight)
        )
        self._village = self._village_observation()
        start_poses = self.day.layout.start_poses(self.cast_size)
        self._roster = tuple(
            {"id": character_id, "home": start_poses[character_id].home}
            for character_id in self.day.character_order
        )
        self.agents = list(self.possible_agents)
        return self._observations(self.agents), {agent: {} for agent in self.agents}

    def step(
        self, actions: Mapping[str, Any]
    ) -> tuple[
        dict[str, ThreeBranchesObservation],
        dict[str, float],
        dict[str, bool],
        dict[str, bool],
        dict[str, dict[str, object]],
    ]:
        """Apply one complete joint order and return the same pre-step roster in every mapping."""
        active_agents = list(self.agents)
        if set(actions) != set(active_agents):
            raise ValueError("parallel steps require one action for every active player")
        orders: dict[str, Order] = {}
        for player_id in active_agents:
            action = actions[player_id]
            if not self.action_space(player_id).contains(action):
                raise ValueError(f"invalid action for {player_id!r}")
            orders[character_for_player(player_id)] = self._order(action)
        self.day.step(orders)
        terminal = self.day.terminal
        rewards = {agent: 100.0 if terminal else 0.0 for agent in active_agents}
        terminations = {agent: terminal for agent in active_agents}
        truncations = {agent: False for agent in active_agents}
        observations = self._observations(active_agents)
        self.agents = [] if terminal else active_agents
        return observations, rewards, terminations, truncations, {agent: {} for agent in active_agents}

    def chat_policy(self, sender: str) -> dict[str, object]:
        """List direct talk recipients by pre-step distance, then stable roster order."""
        self._require_active_agent(sender)
        speaker = self.day.characters[character_for_player(sender)]
        recipients = sorted(
            (
                (distance(speaker.position, other.position), index, player_for_character(other_id))
                for index, other_id in enumerate(self.day.character_order)
                if other_id != speaker.id
                for other in (self.day.characters[other_id],)
                if self.day.layout.reaches(speaker.position, other.position, PROFILE.talk_range)
            ),
            key=lambda item: item[:2],
        )
        ordered = tuple(player for _distance, _index, player in recipients)
        return {"target_recipients": ordered, "default_recipient": ordered[0] if ordered else None}

    def broadcast_recipients(self, sender: str) -> tuple[str, ...]:
        """Return post-step shout audiences, using talk range for the visitor."""
        self._require_active_agent(sender)
        speaker = self.day.characters[character_for_player(sender)]
        limit = PROFILE.talk_range if speaker.id == "visitor" else PROFILE.shout_range
        return tuple(
            player_for_character(other_id)
            for other_id in self.day.character_order
            if other_id != speaker.id
            and self.day.layout.reaches(speaker.position, self.day.characters[other_id].position, limit)
        )

    def render(self) -> None:
        """Renderers consume the separately extracted semantic overlay."""
        return None

    def close(self) -> None:
        """The in-memory physics space needs no explicit release."""

    def _order(self, action: Mapping[str, Any]) -> Order:
        expression = int(action["action"])
        return Order(
            heading=float(action["heading"]),
            speed=float(action["speed"]),
            action="none" if expression == 0 else "use" if expression == 1 else EMOTES[expression - 2],
        )

    def _observations(self, agents: list[str]) -> dict[str, ThreeBranchesObservation]:
        return {agent: self._observation(agent) for agent in agents}

    def _observation(self, player_id: str) -> ThreeBranchesObservation:
        perception = self.day.perception(character_for_player(player_id))
        return {
            "self": self._character(perception.self),
            "seen": tuple(self._character(character) for character in perception.seen),
            "nearby": tuple(self._nearby(character) for character in perception.nearby),
            "props": tuple({"prop": prop.id, "state": prop.state} for prop in perception.props),
            "bell": int(perception.bell),
            "tick": perception.tick,
            "phase": perception.phase,
            "village": self._village,
            "roster": self._roster,
            "parameters": {"seat_plan": self.seat_plan, "daynight": int(self.daynight)},
        }

    def _village_observation(self) -> Village:
        layout = self.day.layout
        return cast(
            "Village",
            {
                "channels": tuple(self._route(route) for route in layout.channels),
                "road": self._route(layout.road),
                "footpaths": tuple(self._route(route) for route in layout.footpaths),
                "bridges": tuple(
                    {
                        "position": self._position(bridge.position),
                        "heading": self._float(bridge.heading),
                        "width": self._float(bridge.width),
                        "span": self._float(bridge.span),
                    }
                    for bridge in layout.bridges
                ),
                "buildings": tuple(self._building(building) for building in layout.buildings),
                "fields": tuple(tuple(self._position(point) for point in field) for field in layout.fields),
                "reed_banks": tuple(
                    tuple(self._position(point) for point in bank) for bank in layout.reed_banks
                ),
                "props": tuple(
                    {
                        "id": prop.id,
                        "type": prop.type,
                        "position": self._position(prop.position),
                        "footprint": {
                            "width": self._float(prop.footprint[0]),
                            "depth": self._float(prop.footprint[1]),
                        },
                        "rotation": self._float(prop.rotation),
                    }
                    for prop in layout.props
                ),
                "scenery": tuple(
                    {
                        "type": scenery.type,
                        "position": self._position(scenery.position),
                        "radius": self._float(scenery.radius),
                    }
                    for scenery in layout.scenery
                ),
                "spawn": self._position(layout.spawn),
            },
        )

    def _character(self, character: Any) -> Character:
        return cast(
            "Character",
            {
                "id": character.id,
                "position": self._position(character.position),
                "heading": self._float(character.heading),
                "moved": self._float(character.moved),
                "expression": {"type": character.expression.type, "target": character.expression.target},
            },
        )

    def _nearby(self, character: Any) -> NearbyCharacter:
        return {"id": character.id, "position": self._position(character.position)}

    def _route(self, route: Any) -> dict[str, Any]:
        return {
            "points": tuple(self._position(point) for point in route.points),
            "width": self._float(route.width),
        }

    def _building(self, building: Any) -> Building:
        return cast(
            "Building",
            {
                "id": building.id,
                "type": building.type,
                "center": self._position(building.center),
                "width": self._float(building.width),
                "depth": self._float(building.depth),
                "rotation": self._float(building.rotation),
                "doorway": {
                    "position": self._position(building.doorway.position),
                    "width": self._float(building.doorway.width),
                },
            },
        )

    def _position(self, point: tuple[float, float]) -> Position:
        return cast("Position", {"x": self._float(point[0]), "y": self._float(point[1])})

    def _float(self, value: float) -> np.ndarray:
        return np.asarray(value, dtype=np.float32)

    def _require_known_agent(self, agent: str) -> None:
        if agent not in self.possible_agents:
            raise ValueError(f"unknown player {agent!r}")

    def _require_active_agent(self, agent: str) -> None:
        self._require_known_agent(agent)
        if agent not in self.agents:
            raise ValueError(f"inactive player {agent!r} cannot send chat")
