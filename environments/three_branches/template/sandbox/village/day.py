"""Read the current point in the village day."""

from __future__ import annotations

from collections.abc import Mapping
from typing import cast


def tick(observation: Mapping[str, object]) -> int:
    return cast(int, observation["tick"])


def phase(observation: Mapping[str, object]):
    return observation["phase"]


def bell_ringing(observation: Mapping[str, object]) -> bool:
    return bool(observation["bell"])


def parameters(observation: Mapping[str, object]):
    return observation["parameters"]
