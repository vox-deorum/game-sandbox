"""Rule constants shared by the Three Branches engine and renderer."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from importlib import resources
from typing import Any

_TOKEN = re.compile(r"[a-z][a-z0-9_]*\Z")


@dataclass(frozen=True)
class Ground:
    token: str
    code: str
    speed: float
    impassable: bool


@dataclass(frozen=True)
class Profile:
    body_radius: float
    vision_degrees: float
    vision_range: float
    hearing_range: float
    talk_range: float
    shout_range: float
    prop_reach: float
    running_threshold: float


@dataclass(frozen=True)
class Phase:
    name: str
    start: int
    end: int


@dataclass(frozen=True)
class Rules:
    emotes: tuple[str, ...]
    ground: tuple[Ground, ...]
    profile: Profile
    phases: tuple[Phase, ...]
    off_phase: str
    day_ticks: int


def _object(value: Any, owner: str, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f"rules: {owner} must have exactly {sorted(keys)}")
    return value


def _string(value: Any, owner: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"rules: {owner} must be a non-empty string")
    return value


def _token(value: Any, owner: str) -> str:
    value = _string(value, owner)
    if _TOKEN.fullmatch(value) is None:
        raise ValueError(f"rules: {owner} must be lowercase snake_case")
    return value


def _positive_number(value: Any, owner: str) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"rules: {owner} must be positive")
    return float(value)


def _positive_int(value: Any, owner: str) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError(f"rules: {owner} must be a positive integer")
    return value


def load(data: Any) -> Rules:
    """Validate a decoded rules document without reading global state."""
    document = _object(data, "document", {"emotes", "ground", "profile", "phases", "off_phase", "day_ticks"})
    emote_values = document["emotes"]
    if not isinstance(emote_values, list) or len(emote_values) != 9:
        raise ValueError("rules: emotes must contain exactly nine entries")
    emotes = tuple(_token(value, "an emote") for value in emote_values)
    if len(set(emotes)) != len(emotes):
        raise ValueError("rules: emotes must be unique")

    ground_values = document["ground"]
    if not isinstance(ground_values, list) or not ground_values:
        raise ValueError("rules: ground must be a non-empty array")
    ground: list[Ground] = []
    for entry in ground_values:
        keys = {"token", "code", "speed"}
        if isinstance(entry, dict) and "impassable" in entry:
            keys.add("impassable")
        entry = _object(entry, "a ground class", keys)
        token = _token(entry["token"], "a ground token")
        code = _string(entry["code"], "a ground code")
        if len(code) != 1:
            raise ValueError("rules: each ground code must be one character")
        impassable = entry.get("impassable", False)
        if type(impassable) is not bool:
            raise ValueError("rules: ground impassable must be a boolean")
        speed = entry["speed"]
        if impassable:
            if type(speed) not in (int, float) or speed != 0:
                raise ValueError("rules: impassable ground must have speed zero")
            speed = 0.0
        else:
            speed = _positive_number(speed, "a ground speed")
        ground.append(Ground(token, code, speed, impassable))
    if len({item.token for item in ground}) != len(ground):
        raise ValueError("rules: ground tokens must be unique")
    if len({item.code for item in ground}) != len(ground):
        raise ValueError("rules: ground codes must be unique")
    if {item.token for item in ground if item.impassable} != {"water"}:
        raise ValueError("rules: water must be the only impassable ground class")

    profile_values = _object(
        document["profile"],
        "profile",
        {
            "body_radius",
            "vision_degrees",
            "vision_range",
            "hearing_range",
            "talk_range",
            "shout_range",
            "prop_reach",
            "running_threshold",
        },
    )
    profile = Profile(
        **{name: _positive_number(value, f"profile {name}") for name, value in profile_values.items()}
    )

    day_ticks = _positive_int(document["day_ticks"], "day_ticks")
    phase_values = document["phases"]
    if not isinstance(phase_values, list) or not phase_values:
        raise ValueError("rules: phases must be a non-empty array")
    phases: list[Phase] = []
    expected_start = 1
    for entry in phase_values:
        entry = _object(entry, "a phase", {"name", "start", "end"})
        phase = Phase(
            _token(entry["name"], "a phase name"),
            _positive_int(entry["start"], "a phase start"),
            _positive_int(entry["end"], "a phase end"),
        )
        if phase.start != expected_start or phase.end < phase.start:
            raise ValueError("rules: phases must be contiguous from tick 1")
        expected_start = phase.end + 1
        phases.append(phase)
    if phases[-1].end != day_ticks:
        raise ValueError("rules: phases must end at day_ticks")
    if len({phase.name for phase in phases}) != len(phases):
        raise ValueError("rules: phase names must be unique")
    off_phase = _token(document["off_phase"], "off_phase")
    if off_phase in {phase.name for phase in phases}:
        raise ValueError("rules: off_phase must differ from every daynight phase")
    return Rules(emotes, tuple(ground), profile, tuple(phases), off_phase, day_ticks)


RULES = load(json.loads(resources.files(__package__).joinpath("rules.json").read_text(encoding="utf-8")))
EMOTES = RULES.emotes
GROUND = RULES.ground
GROUND_BY_TOKEN = {item.token: item for item in GROUND}
GROUND_BY_CODE = {item.code: item for item in GROUND}
PROFILE = RULES.profile
PHASES = RULES.phases
OFF_PHASE = RULES.off_phase
DAY_TICKS = RULES.day_ticks
