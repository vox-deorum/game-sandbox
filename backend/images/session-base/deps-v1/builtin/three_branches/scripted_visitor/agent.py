"""A deterministic, standard-library-only visitor for Days at Three Branches."""

from __future__ import annotations

import math
import random
from collections.abc import Mapping, Sequence
from typing import Any

_TALK_DISTANCE = 2.75
_WALK_SPEED = 0.65
_WAYPOINT_DISTANCE = 0.5
_LINGER_TICKS = 3
_GREETING_COOLDOWN = 120
_DETOUR_TICKS = 1
_GRAPH_EPSILON = 1e-5
_GRAPH_COORD_DIGITS = 5
_GREETINGS = (
    "Good day. How fares the village?",
    "Well met. Is the road ahead clear?",
    "Hello there. What news from Three Branches?",
    "A fine day for walking. How are you?",
)
_REPLY = "Thank you. I should keep walking."

Position = tuple[float, float]


def _position(value: Mapping[str, Any]) -> Position:
    return float(value["x"]), float(value["y"])


def _distance(first: Position, second: Position) -> float:
    return math.hypot(second[0] - first[0], second[1] - first[1])


def _heading_to(first: Position, second: Position, fallback: float) -> float:
    if first == second:
        return fallback
    return math.degrees(math.atan2(second[1] - first[1], second[0] - first[0])) % 360.0


def _player_for_npc(character_id: str) -> str | None:
    if not character_id.startswith("npc_"):
        return None
    suffix = character_id.removeprefix("npc_")
    if not suffix.isdigit():
        return None
    return f"player_{int(suffix) + 1}"


def _route_graph(village: Mapping[str, Any]) -> tuple[list[Position], list[list[int]]]:
    """Turn the road and footpath centerlines into an undirected waypoint graph."""

    def graph_point(value: Mapping[str, Any]) -> Position:
        point = _position(value)
        return round(point[0], _GRAPH_COORD_DIGITS), round(point[1], _GRAPH_COORD_DIGITS)

    routes = [village["road"], *village["footpaths"]]
    doorways = {
        graph_point(building["center"]): graph_point(building["doorway"]["position"])
        for building in village.get("buildings", [])
    }
    nodes: list[Position] = []
    neighbors: list[list[int]] = []
    indices: dict[Position, int] = {}

    def node_index(point: Position) -> int:
        if point not in indices:
            indices[point] = len(nodes)
            nodes.append(point)
            neighbors.append([])
        return indices[point]

    segments = [
        (
            doorways.get(graph_point(first), graph_point(first)),
            doorways.get(graph_point(second), graph_point(second)),
        )
        for route in routes
        for first, second in zip(route["points"], route["points"][1:], strict=False)
    ]
    splits: list[dict[float, Position]] = [{0.0: first, 1.0: second} for first, second in segments]
    for index, (first_start, first_end) in enumerate(segments):
        first_vector = first_end[0] - first_start[0], first_end[1] - first_start[1]
        for other_index in range(index + 1, len(segments)):
            second_start, second_end = segments[other_index]
            second_vector = second_end[0] - second_start[0], second_end[1] - second_start[1]
            denominator = first_vector[0] * second_vector[1] - first_vector[1] * second_vector[0]
            if abs(denominator) < 1e-9:
                continue
            offset = second_start[0] - first_start[0], second_start[1] - first_start[1]
            first_fraction = (offset[0] * second_vector[1] - offset[1] * second_vector[0]) / denominator
            second_fraction = (offset[0] * first_vector[1] - offset[1] * first_vector[0]) / denominator
            if (
                not -_GRAPH_EPSILON <= first_fraction <= 1.0 + _GRAPH_EPSILON
                or not -_GRAPH_EPSILON <= second_fraction <= 1.0 + _GRAPH_EPSILON
            ):
                continue
            first_fraction = min(1.0, max(0.0, first_fraction))
            second_fraction = min(1.0, max(0.0, second_fraction))
            point = (
                round(first_start[0] + first_fraction * first_vector[0], _GRAPH_COORD_DIGITS),
                round(first_start[1] + first_fraction * first_vector[1], _GRAPH_COORD_DIGITS),
            )
            splits[index][first_fraction] = point
            splits[other_index][second_fraction] = point

    for segment_splits in splits:
        ordered_splits = sorted(segment_splits.items())
        for first, second in zip(ordered_splits, ordered_splits[1:], strict=False):
            first_index, second_index = node_index(first[1]), node_index(second[1])
            if second_index not in neighbors[first_index]:
                neighbors[first_index].append(second_index)
            if first_index not in neighbors[second_index]:
                neighbors[second_index].append(first_index)
    return nodes, neighbors


class Agent:
    """Wander the paths, greet a visible villager, then continue the visit."""

    def reset(self, seed: int, observation: Mapping[str, Any]) -> None:
        """Build the static path graph and reset all day-specific conversation state."""
        self._rng = random.Random(seed)
        self._nodes, self._neighbors = _route_graph(observation["village"])
        start = _position(observation["self"]["position"])
        self._route_node = min(
            range(len(self._nodes)), key=lambda index: _distance(start, self._nodes[index]), default=None
        )
        self._previous_route_node: int | None = None
        self._target_id: str | None = None
        self._replied_to_target = False
        self._linger_remaining = 0
        self._cooldown_until: dict[str, int] = {}
        self._pending_messages: list[dict[str, str]] = []
        self._last_commanded_speed = 0.0
        self._stalled_ticks = 0
        self._detour_remaining = 0
        self._detour_heading: float | None = None

    def act(self, observation: Mapping[str, Any]) -> dict[str, float | int]:
        """Choose the next movement or greeting action from the current public observation."""
        own = observation["self"]
        position = _position(own["position"])
        heading = float(own["heading"])
        tick = int(observation["tick"])
        self._notice_stall(float(own["moved"]), heading)

        if self._linger_remaining:
            self._linger_remaining -= 1
            if self._linger_remaining == 0 and self._target_id is not None:
                self._cooldown_until[self._target_id] = tick + _GREETING_COOLDOWN
                self._target_id = None
            return self._order(heading, 0.0, 0)

        nearest = self._nearest_npc(observation["seen"], position, tick)
        if nearest is not None:
            character_id, target, distance = nearest
            target_heading = _heading_to(position, target, heading)
            if distance <= _TALK_DISTANCE:
                self._target_id = character_id
                self._replied_to_target = False
                self._linger_remaining = _LINGER_TICKS
                recipient = _player_for_npc(character_id)
                if recipient is not None:
                    self._pending_messages.append({"to": recipient, "text": self._rng.choice(_GREETINGS)})
                return self._order(target_heading, 0.0, 2)
            return self._move(target_heading)

        return self._wander(position, heading)

    def chat(self, inbox: Sequence[Mapping[str, Any]]) -> list[dict[str, str]]:
        """Send the queued greeting and one short reply to the current conversation partner."""
        if self._target_id is not None:
            expected_sender = _player_for_npc(self._target_id)
            if expected_sender is not None and any(
                message.get("from") == expected_sender for message in inbox
            ):
                if not self._replied_to_target:
                    self._pending_messages.append({"to": expected_sender, "text": _REPLY})
                    self._replied_to_target = True
                self._linger_remaining = max(self._linger_remaining, 1)
        messages, self._pending_messages = self._pending_messages, []
        return messages

    def _notice_stall(self, moved: float, heading: float) -> None:
        if self._last_commanded_speed > 0.0 and moved == 0.0:
            self._stalled_ticks += 1
        else:
            self._stalled_ticks = 0
        if self._stalled_ticks >= 2 and self._detour_remaining == 0:
            self._detour_remaining = _DETOUR_TICKS
            self._detour_heading = (heading + self._rng.choice((-90.0, 90.0))) % 360.0
            self._stalled_ticks = 0

    def _nearest_npc(
        self, seen: Sequence[Mapping[str, Any]], position: Position, tick: int
    ) -> tuple[str, Position, float] | None:
        candidates = []
        for character in seen:
            character_id = str(character["id"])
            if not character_id.startswith("npc_") or tick < self._cooldown_until.get(character_id, 0):
                continue
            target = _position(character["position"])
            candidates.append((_distance(position, target), character_id, target))
        if not candidates:
            return None
        distance, character_id, target = min(candidates)
        return character_id, target, distance

    def _wander(self, position: Position, heading: float) -> dict[str, float | int]:
        if self._route_node is None:
            return self._order(heading, 0.0, 0)
        target = self._nodes[self._route_node]
        if _distance(position, target) <= _WAYPOINT_DISTANCE:
            choices = [
                node for node in self._neighbors[self._route_node] if node != self._previous_route_node
            ]
            choices = choices or self._neighbors[self._route_node]
            if choices:
                self._previous_route_node, self._route_node = self._route_node, self._rng.choice(choices)
                target = self._nodes[self._route_node]
        return self._move(_heading_to(position, target, heading))

    def _move(self, desired_heading: float) -> dict[str, float | int]:
        if self._detour_remaining:
            self._detour_remaining -= 1
            desired_heading = self._detour_heading if self._detour_heading is not None else desired_heading
        return self._order(desired_heading, _WALK_SPEED, 0)

    def _order(self, heading: float, speed: float, action: int) -> dict[str, float | int]:
        self._last_commanded_speed = speed
        return {"heading": heading, "speed": speed, "action": action}
