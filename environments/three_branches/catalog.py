"""Validated building and object definitions for Days at Three Branches."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from importlib import resources
from types import MappingProxyType
from typing import Any

from .rules import GROUND_BY_CODE

_TOKEN = re.compile(r"^[a-z][a-z0-9_]*$")
_SHAPES = {"box", "circle"}
_TRANSITIONS = {"toggle", "occupancy", "timed", "none"}


@dataclass(frozen=True, slots=True)
class BuildingType:
    token: str
    width: int
    height: int
    count: int
    door_width: int
    interior_props: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class PropType:
    token: str
    width: int
    height: int
    shape: str
    activity: str
    states: tuple[str, ...]
    start: str
    transition: str
    duration: int | None


@dataclass(frozen=True, slots=True)
class SceneryType:
    token: str
    width: int
    height: int
    shape: str


@dataclass(frozen=True, slots=True)
class Catalog:
    buildings: tuple[BuildingType, ...]
    props: tuple[PropType, ...]
    scenery: tuple[SceneryType, ...]

    @property
    def building_by_token(self) -> MappingProxyType[str, BuildingType]:
        return MappingProxyType({item.token: item for item in self.buildings})

    @property
    def prop_by_token(self) -> MappingProxyType[str, PropType]:
        return MappingProxyType({item.token: item for item in self.props})

    @property
    def scenery_by_token(self) -> MappingProxyType[str, SceneryType]:
        return MappingProxyType({item.token: item for item in self.scenery})


def _object(value: Any, name: str, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f"catalog: {name} has unknown or missing keys")
    return value


def _token(value: Any, name: str, *, max_length: int = 16) -> str:
    if not isinstance(value, str) or len(value) > max_length or not _TOKEN.fullmatch(value):
        raise ValueError(f"catalog: {name} must be a lowercase snake-case token")
    return value


def _positive(value: Any, name: str) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError(f"catalog: {name} must be a positive integer")
    return value


def load(data: Any) -> Catalog:
    """Validate the compact catalog document and return immutable tables."""
    root = _object(data, "root", {"buildings", "props", "scenery"})
    if any(not isinstance(root[key], list) or not root[key] for key in root):
        raise ValueError("catalog: each section must be a non-empty array")
    buildings = tuple(
        BuildingType(
            _token(entry["token"], "building token"),
            _positive(entry["width"], "building width"),
            _positive(entry["height"], "building height"),
            _positive(entry["count"], "building count"),
            _positive(entry["door_width"], "building door width"),
            tuple(_token(token, "interior prop", max_length=12) for token in entry["interior_props"]),
        )
        for entry in (
            _object(item, "building", {"token", "width", "height", "count", "door_width", "interior_props"})
            for item in root["buildings"]
        )
    )
    props = tuple(
        PropType(
            _token(entry["token"], "prop token", max_length=12),
            _positive(entry["width"], "prop width"),
            _positive(entry["height"], "prop height"),
            entry["shape"],
            _token(entry["activity"], "activity"),
            tuple(_token(state, "state", max_length=9) for state in entry["states"]),
            _token(entry["start"], "start state", max_length=9),
            entry["transition"],
            entry["duration"],
        )
        for entry in (
            _object(
                item,
                "prop",
                {
                    "token",
                    "width",
                    "height",
                    "shape",
                    "activity",
                    "states",
                    "start",
                    "transition",
                    "duration",
                },
            )
            for item in root["props"]
        )
    )
    scenery = tuple(
        SceneryType(
            _token(entry["token"], "scenery token", max_length=12),
            _positive(entry["width"], "scenery width"),
            _positive(entry["height"], "scenery height"),
            entry["shape"],
        )
        for entry in (
            _object(item, "scenery", {"token", "width", "height", "shape"}) for item in root["scenery"]
        )
    )
    tokens = [item.token for item in (*buildings, *props, *scenery)]
    if len(set(tokens)) != len(tokens):
        raise ValueError("catalog: tokens must be unique")
    prop_tokens = {item.token for item in props}
    for building in buildings:
        if building.door_width > max(building.width, building.height):
            raise ValueError("catalog: building doorway does not fit")
        if any(token not in prop_tokens for token in building.interior_props):
            raise ValueError("catalog: building names an unknown interior prop")
    for prop in props:
        if prop.shape not in _SHAPES or prop.transition not in _TRANSITIONS:
            raise ValueError("catalog: prop shape or transition is invalid")
        if not prop.states or prop.start not in prop.states or len(set(prop.states)) != len(prop.states):
            raise ValueError("catalog: prop states are invalid")
        if prop.transition == "timed":
            if type(prop.duration) is not int or prop.duration <= 0:
                raise ValueError("catalog: timed props need a positive duration")
        elif prop.duration is not None:
            raise ValueError("catalog: only timed props have a duration")
    if any(item.shape not in _SHAPES for item in scenery):
        raise ValueError("catalog: scenery shape is invalid")
    if not {"i", "d", "x"} <= set(GROUND_BY_CODE):
        raise ValueError("catalog: rules lack building ground classes")
    return Catalog(buildings, props, scenery)


CATALOG = load(json.loads(resources.files(__package__).joinpath("catalog.json").read_text(encoding="utf-8")))
BUILDINGS = CATALOG.buildings
PROP_TYPES = CATALOG.props
SCENERY_TYPES = CATALOG.scenery
BUILDING_BY_TOKEN = CATALOG.building_by_token
PROP_BY_TOKEN = CATALOG.prop_by_token
SCENERY_BY_TOKEN = CATALOG.scenery_by_token
