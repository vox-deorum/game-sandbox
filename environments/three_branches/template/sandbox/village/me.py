"""Read your villager's current state."""

# pyright: reportGeneralTypeIssues=false, reportIndexIssue=false

from __future__ import annotations

import random
from collections.abc import Mapping


def player_id(observation: Mapping[str, object]) -> str:
    return str(_self(observation)["id"])


def position(observation: Mapping[str, object]):
    return _self(observation)["position"]


def heading(observation: Mapping[str, object]):
    return _self(observation)["heading"]


def moved(observation: Mapping[str, object]):
    return _self(observation)["moved"]


def expression(observation: Mapping[str, object]):
    return _self(observation)["expression"]


def home(observation: Mapping[str, object]) -> str:
    own_id = player_id(observation)
    for entry in observation["roster"]:
        if entry["id"] == own_id:
            return str(entry["home"])
    raise KeyError(own_id)


def rng(observation: Mapping[str, object], session_seed: object) -> random.Random:
    """Return the stable private stream for this seed and player id."""
    return random.Random(f"three_branches:{session_seed!r}:{player_id(observation)}")


def _self(observation: Mapping[str, object]):
    return observation["self"]
