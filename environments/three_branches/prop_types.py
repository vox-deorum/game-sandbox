"""Prop catalog shared by the Three Branches engine and renderer."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from importlib import resources
from typing import Any

_TOKEN = re.compile(r"[a-z][a-z0-9_]*\Z")
_TRANSITIONS = frozenset({"toggle", "occupancy", "timed", "none"})


@dataclass(frozen=True)
class Transition:
    kind: str
    ticks: int | None


@dataclass(frozen=True)
class Footprint:
    width: float
    depth: float


@dataclass(frozen=True)
class PropType:
    token: str
    title: str
    activity: str
    states: tuple[str, ...]
    start: str
    transition: Transition
    footprint: Footprint
    count: int
    district: str


def _object(value: Any, owner: str, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f"props: {owner} must have exactly {sorted(keys)}")
    return value


def _string(value: Any, owner: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"props: {owner} must be a non-empty string")
    return value


def _token(value: Any, owner: str) -> str:
    value = _string(value, owner)
    if _TOKEN.fullmatch(value) is None:
        raise ValueError(f"props: {owner} must be lowercase snake_case")
    return value


def _positive_number(value: Any, owner: str) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"props: {owner} must be positive")
    return float(value)


def _positive_int(value: Any, owner: str) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError(f"props: {owner} must be a positive integer")
    return value


def _transition(value: Any) -> Transition:
    if not isinstance(value, dict) or "kind" not in value:
        raise ValueError("props: a transition must name its kind")
    kind = value["kind"]
    if kind not in _TRANSITIONS:
        raise ValueError("props: transition kind must be toggle, occupancy, timed, or none")
    expected = {"kind", "ticks"} if kind == "timed" else {"kind"}
    value = _object(value, "a transition", expected)
    ticks = _positive_int(value["ticks"], "transition ticks") if kind == "timed" else None
    return Transition(kind, ticks)


def load(data: Any) -> tuple[PropType, ...]:
    """Validate a decoded prop catalog without reading global state."""
    document = _object(data, "document", {"props"})
    entries = document["props"]
    if not isinstance(entries, list) or not entries:
        raise ValueError("props: props must be a non-empty array")
    props: list[PropType] = []
    for entry in entries:
        entry = _object(
            entry,
            "a prop",
            {"token", "title", "activity", "states", "start", "transition", "footprint", "count", "district"},
        )
        states_value = entry["states"]
        if not isinstance(states_value, list) or not states_value:
            raise ValueError("props: states must be a non-empty array")
        states = tuple(_token(state, "a prop state") for state in states_value)
        if len(set(states)) != len(states):
            raise ValueError("props: states must be unique")
        start = _token(entry["start"], "a prop start state")
        if start not in states:
            raise ValueError("props: start must be one of the states")
        transition = _transition(entry["transition"])
        # transition_states drives every stateful prop between an active states[0] and a resting
        # states[1], so the loader is where a catalog edit that breaks that shape must fail.
        if transition.kind != "none" and len(states) != 2:
            raise ValueError("props: a toggle, occupancy, or timed prop needs exactly two states")
        if transition.kind in {"occupancy", "timed"} and start != states[1]:
            raise ValueError("props: an occupancy or timed prop must start in its second, resting state")
        footprint = _object(entry["footprint"], "a footprint", {"width", "depth"})
        props.append(
            PropType(
                _token(entry["token"], "a prop token"),
                _string(entry["title"], "a prop title"),
                _string(entry["activity"], "a prop activity"),
                states,
                start,
                transition,
                Footprint(
                    _positive_number(footprint["width"], "footprint width"),
                    _positive_number(footprint["depth"], "footprint depth"),
                ),
                _positive_int(entry["count"], "prop count"),
                _token(entry["district"], "a prop district"),
            )
        )
    if len({prop.token for prop in props}) != len(props):
        raise ValueError("props: prop tokens must be unique")
    return tuple(props)


PROP_TYPES = load(json.loads(resources.files(__package__).joinpath("props.json").read_text(encoding="utf-8")))
PROP_TYPE_BY_TOKEN = {prop.token: prop for prop in PROP_TYPES}
PROP_TOTAL = sum(prop.count for prop in PROP_TYPES)

# The engine and overlay treat this one prop as the global beacon everyone perceives while it rings.
BELL_ID = "bell_0"
BELL_RINGING = "ringing"
_bell = PROP_TYPE_BY_TOKEN.get(BELL_ID.rsplit("_", 1)[0])
if _bell is None or _bell.count != 1 or BELL_RINGING not in _bell.states:
    raise ValueError("props: the catalog must keep a single beacon bell with a ringing state")
