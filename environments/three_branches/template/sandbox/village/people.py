"""Read villagers in sight, nearby, and in the roster."""

from __future__ import annotations

import re
from collections.abc import Mapping

_NPC_ID = re.compile(r"player_[1-9][0-9]*\Z")


def seen(observation: Mapping[str, object]):
    return observation["seen"]


def nearby(observation: Mapping[str, object]):
    return observation["nearby"]


def roster(observation: Mapping[str, object]):
    return observation["roster"]


def is_visitor(player_id: str) -> bool:
    """Return whether an id is exactly the visitor's player id."""
    return player_id == "player_0"


def is_npc(player_id: str) -> bool:
    """Return whether an id has the canonical positive player-number form."""
    return _NPC_ID.fullmatch(player_id) is not None
