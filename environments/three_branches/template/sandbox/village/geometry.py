"""Pure village geometry and the fixed perception distances."""

from __future__ import annotations

from math import atan2, cos, degrees, hypot, radians, sin

from ._model import RULES

BODY_RADIUS = float(RULES["profile"]["body_radius"])
VISION_DEGREES = float(RULES["profile"]["vision_degrees"])
VISION_RANGE = float(RULES["profile"]["vision_range"])
HEARING_RANGE = float(RULES["profile"]["hearing_range"])
PROP_REACH = float(RULES["profile"]["prop_reach"])


def distance(first, second) -> float:
    return hypot(float(first["x"]) - float(second["x"]), float(first["y"]) - float(second["y"]))


def heading_to(start, end) -> float:
    return wrap(degrees(atan2(float(end["y"]) - float(start["y"]), float(end["x"]) - float(start["x"]))))


def wrap(heading: float) -> float:
    return float(heading) % 360.0


def in_cone(
    origin, heading: float, point, degrees_wide: float = VISION_DEGREES, reach: float = VISION_RANGE
) -> bool:
    dx, dy = float(point["x"]) - float(origin["x"]), float(point["y"]) - float(origin["y"])
    length = hypot(dx, dy)
    if length > reach:
        return False
    if length == 0:
        return True
    angle = radians(wrap(heading))
    return (cos(angle) * dx + sin(angle) * dy) / length >= cos(radians(degrees_wide / 2)) - 1e-12
