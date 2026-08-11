"""Compact, self-contained recording overlays for Days at Three Branches."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from copy import deepcopy
from functools import lru_cache
from typing import Any, cast

from .engine import Day, Expression
from .layout import BUILDING_ROSTER, Bridge, Building, Layout, Polyline, Prop, Scenery
from .perception import phase_at
from .prop_types import BELL_ID, BELL_RINGING, PROP_TYPE_BY_TOKEN, PROP_TYPES
from .rules import DAY_TICKS, EMOTES, GROUND_BY_TOKEN

OVERLAY_VERSION = 1

_BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"
_NONE_TARGET = "zz"
_MAX_PROPS = 36**2 - 1
_SCENERY_TYPE = re.compile(r"[a-z][a-z0-9_]*\Z")


def _base36(value: int, width: int) -> str:
    if type(value) is not int or not 0 <= value < 36**width:
        raise ValueError(f"overlay value does not fit in {width} base36 characters")
    digits = ["0"] * width
    for index in range(width - 1, -1, -1):
        value, digit = divmod(value, 36)
        digits[index] = _BASE36[digit]
    return "".join(digits)


def _decode_base36(value: str, width: int, name: str) -> int:
    if not isinstance(value, str) or len(value) != width or any(digit not in _BASE36 for digit in value):
        raise ValueError(f"overlay {name} must be {width} base36 characters")
    return int(value, 36)


def _centimeters(value: float, width: int, name: str) -> str:
    if not math.isfinite(value):
        raise ValueError(f"overlay {name} must be finite")
    return _base36(round(value * 100), width)


def _meters(value: str, width: int, name: str) -> float:
    return _decode_base36(value, width, name) / 100


def _heading(value: float) -> str:
    if not math.isfinite(value):
        raise ValueError("overlay heading must be finite")
    return _base36(round(value % 360 * 10) % 3600, 3)


def _decode_heading(value: str, name: str) -> float:
    heading = _decode_base36(value, 3, name)
    if heading >= 3600:
        raise ValueError(f"overlay {name} is outside 0 through 359.9 degrees")
    return heading / 10


def _point(value: tuple[float, float], name: str) -> str:
    return _centimeters(value[0], 3, f"{name} x") + _centimeters(value[1], 3, f"{name} y")


def _decode_point(value: str, name: str) -> dict[str, float]:
    if not isinstance(value, str) or len(value) != 6:
        raise ValueError(f"overlay {name} must be six characters")
    x, y = _meters(value[:3], 3, f"{name} x"), _meters(value[3:], 3, f"{name} y")
    if x > 100 or y > 100:
        raise ValueError(f"overlay {name} lies outside the village")
    return {"x": x, "y": y}


def _pack_polyline(line: Polyline) -> str:
    return (
        _centimeters(line.width, 2, "line width")
        + _base36(len(line.points), 1)
        + "".join(_point(point, "line point") for point in line.points)
    )


def _decode_polyline(value: object, name: str) -> dict[str, Any]:
    if not isinstance(value, str) or len(value) < 15:
        raise ValueError(f"overlay {name} is malformed")
    width = _meters(value[:2], 2, f"{name} width")
    count = _decode_base36(value[2], 1, f"{name} point count")
    if width <= 0 or count < 2 or len(value) != 3 + count * 6:
        raise ValueError(f"overlay {name} has an invalid width or point count")
    return {
        "width": width,
        "points": [
            _decode_point(value[index : index + 6], f"{name} point") for index in range(3, len(value), 6)
        ],
    }


def _pack_bridge(bridge: Bridge) -> str:
    return (
        _point(bridge.position, "bridge")
        + _heading(bridge.heading)
        + _centimeters(bridge.width, 2, "bridge width")
        + _centimeters(bridge.span, 2, "bridge span")
    )


def _decode_bridge(value: object) -> dict[str, Any]:
    if not isinstance(value, str) or len(value) != 13:
        raise ValueError("overlay bridge record must be 13 characters")
    width, span = _meters(value[9:11], 2, "bridge width"), _meters(value[11:], 2, "bridge span")
    if width <= 0 or span <= 0:
        raise ValueError("overlay bridge lengths must be positive")
    return {
        "position": _decode_point(value[:6], "bridge"),
        "heading": _decode_heading(value[6:9], "bridge heading"),
        "width": width,
        "span": span,
    }


def _pack_building(building: Building) -> str:
    return (
        _point(building.center, "building")
        + _centimeters(building.width, 2, "building width")
        + _centimeters(building.depth, 2, "building depth")
        + _heading(building.rotation)
        + _point(building.doorway.position, "doorway")
        + _centimeters(building.doorway.width, 2, "doorway width")
    )


def _decode_building(value: object, index: int) -> dict[str, Any]:
    if not isinstance(value, str) or len(value) != 21:
        raise ValueError("overlay building record must be 21 characters")
    width, depth, doorway_width = (
        _meters(value[6:8], 2, "building width"),
        _meters(value[8:10], 2, "building depth"),
        _meters(value[19:], 2, "doorway width"),
    )
    if min(width, depth, doorway_width) <= 0 or doorway_width > max(width, depth):
        raise ValueError("overlay building lengths are invalid")
    building_id, building_type = BUILDING_ROSTER[index]
    return {
        "id": building_id,
        "type": building_type,
        "center": _decode_point(value[:6], "building"),
        "width": width,
        "depth": depth,
        "rotation": _decode_heading(value[10:13], "building rotation"),
        "doorway": {"position": _decode_point(value[13:19], "doorway"), "width": doorway_width},
    }


def _pack_prop(prop: Prop) -> str:
    return _point(prop.position, "prop") + _heading(prop.rotation)


def _decode_prop(value: object, index: int, prop_ids: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(value, str) or len(value) != 9:
        raise ValueError("overlay prop record must be nine characters")
    prop_id = prop_ids[index]
    return {
        "id": prop_id,
        "type": prop_id.rsplit("_", 1)[0],
        "position": _decode_point(value[:6], "prop"),
        "rotation": _decode_heading(value[6:], "prop rotation"),
    }


def _pack_scenery(scenery: Scenery) -> str:
    if _SCENERY_TYPE.fullmatch(scenery.type) is None:
        raise ValueError("overlay scenery type must be lowercase snake_case")
    packed = _point(scenery.position, "scenery") + _centimeters(scenery.radius, 2, "scenery radius")
    return f"{scenery.type}:{packed}"


def _decode_scenery(value: object) -> dict[str, Any]:
    if not isinstance(value, str) or value.count(":") != 1:
        raise ValueError("overlay scenery record is malformed")
    kind, packed = value.split(":", 1)
    if _SCENERY_TYPE.fullmatch(kind) is None or len(packed) != 8:
        raise ValueError("overlay scenery record is malformed")
    radius = _meters(packed[6:], 2, "scenery radius")
    if radius <= 0:
        raise ValueError("overlay scenery radius must be positive")
    return {"type": kind, "position": _decode_point(packed[:6], "scenery"), "radius": radius}


def _pack_ground(layout: Layout) -> list[str]:
    rows: list[str] = []
    for y in range(100):
        row: list[tuple[str, int]] = []
        for x in range(100):
            code = GROUND_BY_TOKEN[layout.ground_at((x + 0.5, y + 0.5))].code
            if row and row[-1][0] == code:
                row[-1] = code, row[-1][1] + 1
            else:
                row.append((code, 1))
        rows.append("".join(code + _base36(count, 2) for code, count in row))
    return rows


def _decode_ground(rows: object) -> list[list[str]]:
    if not isinstance(rows, list) or len(rows) != 100:
        raise ValueError("overlay ground must contain exactly 100 rows")
    code_to_token = {ground.code: ground.token for ground in GROUND_BY_TOKEN.values()}
    decoded: list[list[str]] = []
    for row in rows:
        if not isinstance(row, str) or not row or len(row) % 3:
            raise ValueError("overlay ground row is malformed")
        cells: list[str] = []
        previous = None
        for index in range(0, len(row), 3):
            code = row[index]
            count = _decode_base36(row[index + 1 : index + 3], 2, "ground run")
            if code not in code_to_token or not 1 <= count <= 100 or code == previous:
                raise ValueError("overlay ground row has an invalid run")
            cells.extend([code_to_token[code]] * count)
            previous = code
        if len(cells) != 100:
            raise ValueError("overlay ground row must sum to 100 cells")
        decoded.append(cells)
    return decoded


@lru_cache
def _pack_static(layout: Layout, cast_size: int, daynight: bool) -> dict[str, Any]:
    """Encode immutable layout data once for every layout and gameplay setting."""
    prop_counts = tuple(
        sum(prop.type == prop_type.token for prop in layout.props) for prop_type in PROP_TYPES
    )
    if sum(prop_counts) > _MAX_PROPS:
        raise ValueError(f"overlay prop count cannot exceed {_MAX_PROPS}")
    return {
        "a": _base36(cast_size, 1) + ("1" if daynight else "0"),
        "c": [_pack_polyline(channel) for channel in layout.channels],
        "r": _pack_polyline(layout.road),
        "f": [_pack_polyline(path) for path in layout.footpaths],
        "b": [_pack_bridge(bridge) for bridge in layout.bridges],
        "h": [_pack_building(building) for building in layout.buildings],
        "q": "".join(_base36(count, 2) for count in prop_counts),
        "p": [_pack_prop(prop) for prop in layout.props],
        "n": [_pack_scenery(scenery) for scenery in layout.scenery],
        "x": _point(layout.spawn, "spawn"),
        "g": _pack_ground(layout),
    }


def _prop_ids(static: Mapping[str, Any]) -> tuple[str, ...]:
    packed_counts = static["q"]
    packed = static["p"]
    if not isinstance(packed_counts, str) or len(packed_counts) != len(PROP_TYPES) * 2:
        raise ValueError("overlay prop counts must contain two characters per catalog prop")
    counts = tuple(
        _decode_base36(packed_counts[index : index + 2], 2, "prop count")
        for index in range(0, len(packed_counts), 2)
    )
    for prop_type, count in zip(PROP_TYPES, counts, strict=True):
        if prop_type.count is not None and count != prop_type.count:
            raise ValueError(f"overlay fixed prop count for {prop_type.token} is invalid")
    total = sum(counts)
    if total > _MAX_PROPS:
        raise ValueError(f"overlay prop count cannot exceed {_MAX_PROPS}")
    if not isinstance(packed, list) or len(packed) != total:
        raise ValueError("overlay prop pose count does not match prop counts")
    ids: list[str] = []
    for prop_type, count in zip(PROP_TYPES, counts, strict=True):
        for index in range(count):
            ids.append(f"{prop_type.token}_{index}")
    return tuple(ids)


def _decode_static(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping) or set(value) != {
        "a",
        "c",
        "r",
        "f",
        "b",
        "h",
        "q",
        "p",
        "n",
        "x",
        "g",
    }:
        raise ValueError("overlay static layout has unexpected fields")
    setting = value["a"]
    if not isinstance(setting, str) or len(setting) != 2 or setting[1] not in "01":
        raise ValueError("overlay cast and daynight setting is malformed")
    cast_size = _decode_base36(setting[0], 1, "cast size")
    if cast_size not in {5, 10}:
        raise ValueError("overlay cast size must be 5 or 10")
    channels, paths, bridges = value["c"], value["f"], value["b"]
    buildings, props, scenery = value["h"], value["p"], value["n"]
    if not isinstance(channels, list) or len(channels) != 4:
        raise ValueError("overlay must contain exactly four channels")
    if not isinstance(paths, list) or not paths:
        raise ValueError("overlay must contain at least one footpath")
    if not isinstance(bridges, list):
        raise ValueError("overlay bridges must be a list")
    if not isinstance(buildings, list) or len(buildings) != 7:
        raise ValueError("overlay must contain exactly seven buildings")
    if not isinstance(scenery, list):
        raise ValueError("overlay scenery must be a list")
    prop_ids = _prop_ids(value)
    return {
        "cast_size": cast_size,
        "daynight": setting[1] == "1",
        "village": {
            "channels": [_decode_polyline(channel, "channel") for channel in channels],
            "road": _decode_polyline(value["r"], "road"),
            "footpaths": [_decode_polyline(path, "footpath") for path in paths],
            "bridges": [_decode_bridge(bridge) for bridge in bridges],
            "buildings": [_decode_building(building, index) for index, building in enumerate(buildings)],
            "props": [_decode_prop(prop, index, prop_ids) for index, prop in enumerate(props)],
            "scenery": [_decode_scenery(record) for record in scenery],
            "spawn": _decode_point(value["x"], "spawn"),
            "ground": _decode_ground(value["g"]),
        },
        "prop_ids": prop_ids,
    }


def _expression_code(expression: Expression, prop_index: Mapping[str, int]) -> tuple[str, str]:
    if expression.type == "none":
        return "0", _NONE_TARGET
    if expression.type == "use":
        if expression.target not in prop_index:
            raise ValueError("overlay use expression names an unknown prop")
        return _base36(10, 1), _base36(prop_index[expression.target], 2)
    if expression.type not in EMOTES:
        raise ValueError("overlay expression is unknown")
    return _base36(EMOTES.index(expression.type) + 1, 1), _NONE_TARGET


def _pack_dynamic(day: Day, static: Mapping[str, Any]) -> dict[str, Any]:
    prop_ids = _prop_ids(static)
    prop_index = {prop_id: index for index, prop_id in enumerate(prop_ids)}
    characters = []
    for character_id in (*tuple(f"npc_{index}" for index in range(day.config.cast_size)), "visitor"):
        state = day.characters[character_id]
        expression, target = _expression_code(state.expression, prop_index)
        characters.append(
            _point(state.position, "character")
            + _heading(state.heading)
            + _centimeters(state.moved, 2, "character movement")
            + expression
            + target
        )
    states = "".join(
        _base36(PROP_TYPE_BY_TOKEN[prop_id.rsplit("_", 1)[0]].states.index(day.prop_states[prop_id]), 1)
        for prop_id in prop_ids
    )
    return {"t": day.tick, "c": characters, "p": states, "z": "1" if day.terminal else "0"}


def encode_overlay_static(day: Day) -> dict[str, Any]:
    """Pack immutable layout data for a recording header without exposing the cached value."""
    static = _pack_static(day.layout, day.config.cast_size, day.config.daynight)
    return {"v": OVERLAY_VERSION, "s": deepcopy(static)}


def encode_overlay(day: Day) -> dict[str, Any]:
    """Pack one dynamic replay frame, paired with its separately recorded static layout."""
    static = _pack_static(day.layout, day.config.cast_size, day.config.daynight)
    return {"v": OVERLAY_VERSION, "d": _pack_dynamic(day, static)}


def extract_overlay(env: Any) -> dict[str, Any]:
    """Extract an overlay from the Three Branches environment's live engine day."""
    return encode_overlay(_overlay_day(env))


def extract_overlay_static(env: Any) -> dict[str, Any]:
    """Extract immutable overlay data from the Three Branches environment's live engine day."""
    return encode_overlay_static(_overlay_day(env))


def _overlay_day(env: Any) -> Day:
    """Return the live day from a compatible Three Branches environment."""
    day = getattr(env, "day", None)
    if day is None or not all(
        hasattr(day, field) for field in ("layout", "config", "characters", "prop_states", "tick", "terminal")
    ):
        raise TypeError("Three Branches overlay requires an environment with a Day at .day")
    return cast("Day", day)


def decode_overlay(compact: Mapping[str, Any], static: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Strictly validate and decode one compact replay frame with its header static data."""
    if isinstance(compact, Mapping) and "s" in compact:
        raise ValueError("overlay dynamic frame must not contain static layout data")
    if static is None:
        raise ValueError("overlay static data is required")
    if not isinstance(static, Mapping) or set(static) != {"v", "s"}:
        raise ValueError("overlay static data has unexpected fields")
    if type(static["v"]) is not int or static["v"] != OVERLAY_VERSION:
        raise ValueError("overlay static data has an unsupported version")
    if not isinstance(compact, Mapping) or set(compact) != {"v", "d"}:
        raise ValueError("overlay dynamic frame has unexpected fields")
    if type(compact["v"]) is not int or compact["v"] != OVERLAY_VERSION:
        raise ValueError("overlay dynamic frame has an unsupported version")
    static_data = _decode_static(static["s"])
    dynamic = compact["d"]
    if not isinstance(dynamic, Mapping) or set(dynamic) != {"t", "c", "p", "z"}:
        raise ValueError("overlay dynamic state has unexpected fields")
    tick = dynamic["t"]
    if type(tick) is not int or not 1 <= tick <= DAY_TICKS:
        raise ValueError("overlay tick must be within the day")
    terminal = dynamic["z"]
    if not isinstance(terminal, str) or terminal not in {"0", "1"}:
        raise ValueError("overlay terminal flag must be 0 or 1")
    if terminal == "1" and tick != DAY_TICKS:
        raise ValueError("overlay terminal flag may occur only on the final tick")

    records = dynamic["c"]
    expected_characters = static_data["cast_size"] + 1
    if not isinstance(records, list) or len(records) != expected_characters:
        raise ValueError("overlay character records must follow roster order")
    prop_ids = static_data["prop_ids"]
    holders: set[str] = set()
    characters = []
    for index, record in enumerate(records):
        if not isinstance(record, str) or len(record) != 14:
            raise ValueError("overlay character record must be 14 characters")
        moved = _meters(record[9:11], 2, "character movement")
        if moved > 1.0:
            raise ValueError("overlay character movement cannot exceed one meter")
        expression_code = _decode_base36(record[11], 1, "expression")
        target_code = record[12:]
        target = "none"
        if expression_code == 10:
            target_index = _decode_base36(target_code, 2, "use target")
            if target_index >= len(prop_ids) or moved != 0:
                raise ValueError("overlay use target or movement is invalid")
            target = prop_ids[target_index]
            if target in holders:
                raise ValueError("overlay prop has multiple holders")
            holders.add(target)
            expression = "use"
        else:
            if target_code != _NONE_TARGET or not 0 <= expression_code <= len(EMOTES):
                raise ValueError("overlay expression and target do not agree")
            expression = "none" if expression_code == 0 else EMOTES[expression_code - 1]
        character_id = f"npc_{index}" if index < static_data["cast_size"] else "visitor"
        characters.append(
            {
                "id": character_id,
                "position": _decode_point(record[:6], "character"),
                "heading": _decode_heading(record[6:9], "character heading"),
                "moved": moved,
                "expression": expression,
                "target": target,
            }
        )

    prop_states = dynamic["p"]
    if not isinstance(prop_states, str) or len(prop_states) != len(prop_ids):
        raise ValueError(f"overlay prop states must contain exactly {len(prop_ids)} characters")
    decoded_states: dict[str, str] = {}
    for prop_id, code in zip(prop_ids, prop_states, strict=True):
        prop_type = PROP_TYPE_BY_TOKEN[prop_id.rsplit("_", 1)[0]]
        state_index = _decode_base36(code, 1, "prop state")
        if state_index >= len(prop_type.states):
            raise ValueError("overlay prop state is out of range")
        decoded_states[prop_id] = prop_type.states[state_index]
    bell = decoded_states[BELL_ID] == BELL_RINGING
    return {
        "version": OVERLAY_VERSION,
        "village": static_data["village"],
        "tick": tick,
        "characters": characters,
        "prop_states": decoded_states,
        "bell": bell,
        "phase": phase_at(tick, static_data["daynight"]),
        "terminal": terminal == "1",
    }
