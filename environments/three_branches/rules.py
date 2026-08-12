"""Validated static rules for Days at Three Branches."""

from __future__ import annotations

import json
from dataclasses import dataclass
from importlib import resources
from types import MappingProxyType
from typing import Any


@dataclass(frozen=True, slots=True)
class Frame:
    cells_x: int
    cells_y: int
    cell_size: float

    @property
    def width(self) -> float:
        return self.cells_x * self.cell_size

    @property
    def height(self) -> float:
        return self.cells_y * self.cell_size


@dataclass(frozen=True, slots=True)
class Ground:
    code: str
    name: str
    speed: float
    passable: bool
    blocks_sight: bool


@dataclass(frozen=True, slots=True)
class Profile:
    body_radius: float
    vision_degrees: float
    vision_range: float
    hearing_range: float
    prop_reach: float


@dataclass(frozen=True, slots=True)
class Phase:
    name: str
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class Rules:
    frame: Frame
    grounds: tuple[Ground, ...]
    fill: str
    emotes: tuple[str, ...]
    profile: Profile
    phases: tuple[Phase, ...]
    off_phase: str
    day_ticks: int
    physics_substeps: int

    @property
    def ground_by_code(self) -> MappingProxyType[str, Ground]:
        return MappingProxyType({ground.code: ground for ground in self.grounds})


def _object(value: Any, name: str, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"rules: {name} must be an object")
    unknown = set(value) - keys
    missing = keys - set(value)
    if unknown or missing:
        raise ValueError(f"rules: {name} has unknown or missing keys")
    return value


def _positive_int(value: Any, name: str) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError(f"rules: {name} must be a positive integer")
    return value


def _positive_number(value: Any, name: str) -> float:
    if type(value) not in (int, float) or value <= 0:
        raise ValueError(f"rules: {name} must be a positive number")
    return float(value)


def _nonnegative_number(value: Any, name: str) -> float:
    if type(value) not in (int, float) or value < 0:
        raise ValueError(f"rules: {name} must be a non-negative number")
    return float(value)


def _token(value: Any, name: str, length: int | None = None) -> str:
    if not isinstance(value, str) or not value or (length is not None and len(value) != length):
        raise ValueError(f"rules: {name} is invalid")
    return value


def load(data: Any) -> Rules:
    """Validate a decoded rules document without accepting unrecognised data."""
    root = _object(
        data,
        "root",
        {
            "frame",
            "grounds",
            "fill",
            "emotes",
            "profile",
            "phases",
            "off_phase",
            "day_ticks",
            "physics_substeps",
        },
    )
    frame_data = _object(root["frame"], "frame", {"cells_x", "cells_y", "cell_size"})
    frame = Frame(
        _positive_int(frame_data["cells_x"], "frame.cells_x"),
        _positive_int(frame_data["cells_y"], "frame.cells_y"),
        _positive_number(frame_data["cell_size"], "frame.cell_size"),
    )
    if not isinstance(root["grounds"], list) or not root["grounds"]:
        raise ValueError("rules: grounds must be a non-empty array")
    ground_entries = (
        _object(item, "ground", {"code", "name", "speed", "passable", "blocks_sight"})
        for item in root["grounds"]
    )
    grounds = tuple(
        Ground(
            _token(entry["code"], "ground.code", 1),
            _token(entry["name"], "ground.name"),
            _nonnegative_number(entry["speed"], "ground.speed"),
            entry["passable"],
            entry["blocks_sight"],
        )
        for entry in ground_entries
    )
    for ground in grounds:
        if type(ground.passable) is not bool or type(ground.blocks_sight) is not bool:
            raise ValueError("rules: ground flags must be boolean")
        if ground.speed < 0 or (ground.passable and ground.speed <= 0):
            raise ValueError("rules: ground speeds are invalid")
    if len({ground.code for ground in grounds}) != len(grounds):
        raise ValueError("rules: ground codes must be unique")
    fill = _token(root["fill"], "fill", 1)
    by_code = {ground.code: ground for ground in grounds}
    if fill not in by_code or not by_code[fill].passable:
        raise ValueError("rules: fill must name a passable ground")
    if not any(not ground.passable for ground in grounds):
        raise ValueError("rules: an impassable ground is required")
    emotes_data = root["emotes"]
    if not isinstance(emotes_data, list) or len(emotes_data) != 9:
        raise ValueError("rules: exactly nine emotes are required")
    emotes = tuple(_token(emote, "emote") for emote in emotes_data)
    if len(set(emotes)) != len(emotes):
        raise ValueError("rules: emotes must be unique")
    profile_data = _object(
        root["profile"],
        "profile",
        {"body_radius", "vision_degrees", "vision_range", "hearing_range", "prop_reach"},
    )
    profile = Profile(
        *(_positive_number(profile_data[key], f"profile.{key}") for key in Profile.__dataclass_fields__)
    )
    phases_data = root["phases"]
    if not isinstance(phases_data, list) or not phases_data:
        raise ValueError("rules: phases must be a non-empty array")
    phases = tuple(
        Phase(
            _token(entry["name"], "phase.name"),
            _positive_int(entry["start"], "phase.start"),
            _positive_int(entry["end"], "phase.end"),
        )
        for entry in (_object(item, "phase", {"name", "start", "end"}) for item in phases_data)
    )
    if len({phase.name for phase in phases}) != len(phases) or any(
        phase.end < phase.start for phase in phases
    ):
        raise ValueError("rules: phases are invalid")
    if phases[0].start != 1 or any(
        left.end + 1 != right.start for left, right in zip(phases, phases[1:], strict=False)
    ):
        raise ValueError("rules: phases must be contiguous from tick 1")
    day_ticks = _positive_int(root["day_ticks"], "day_ticks")
    if phases[-1].end != day_ticks:
        raise ValueError("rules: phases must end with the day")
    off_phase = _token(root["off_phase"], "off_phase")
    return Rules(
        frame,
        grounds,
        fill,
        emotes,
        profile,
        phases,
        off_phase,
        day_ticks,
        _positive_int(root["physics_substeps"], "physics_substeps"),
    )


RULES = load(json.loads(resources.files(__package__).joinpath("rules.json").read_text(encoding="utf-8")))
FRAME = RULES.frame
GROUNDS = RULES.grounds
GROUND_BY_CODE = RULES.ground_by_code
EMOTES = RULES.emotes
PROFILE = RULES.profile
