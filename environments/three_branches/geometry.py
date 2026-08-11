"""Closed-form geometry shared by the village rules and future student helpers."""

from __future__ import annotations

from math import atan2, cos, degrees, hypot, radians, sin

type Point = tuple[float, float]
type Segment = tuple[Point, Point]

EPSILON = 1e-9


def wrap_heading(heading: float) -> float:
    """Return a heading in degrees in the half-open interval [0, 360)."""
    wrapped = heading % 360.0
    return 0.0 if abs(wrapped) < EPSILON else wrapped


def heading_vector(heading: float) -> Point:
    """Return the unit vector for a turtle heading measured from east."""
    angle = radians(wrap_heading(heading))
    return cos(angle), sin(angle)


def heading_to(start: Point, end: Point) -> float:
    """Return the turtle heading from ``start`` to ``end``."""
    return wrap_heading(degrees(atan2(end[1] - start[1], end[0] - start[0])))


def add(point: Point, vector: Point, scale: float = 1.0) -> Point:
    return point[0] + vector[0] * scale, point[1] + vector[1] * scale


def subtract(left: Point, right: Point) -> Point:
    return left[0] - right[0], left[1] - right[1]


def dot(left: Point, right: Point) -> float:
    return left[0] * right[0] + left[1] * right[1]


def cross(left: Point, right: Point) -> float:
    return left[0] * right[1] - left[1] * right[0]


def distance(first: Point, second: Point) -> float:
    return hypot(first[0] - second[0], first[1] - second[1])


def distance_to_segment(point: Point, start: Point, end: Point) -> float:
    """Return the shortest distance from a point to a finite segment."""
    segment = subtract(end, start)
    length_squared = dot(segment, segment)
    if length_squared <= EPSILON:
        return distance(point, start)
    fraction = max(0.0, min(1.0, dot(subtract(point, start), segment) / length_squared))
    return distance(point, add(start, segment, fraction))


def distance_to_rectangle(
    point: Point, center: Point, width: float, depth: float, heading: float = 0.0
) -> float:
    """Return the distance from a point to a rotated rectangle, zero inside it."""
    forward = heading_vector(heading)
    relative = subtract(point, center)
    along = abs(dot(relative, forward)) - width / 2
    across = abs(cross(forward, relative)) - depth / 2
    return hypot(max(0.0, along), max(0.0, across))


def nearest_point_on_rectangle(
    point: Point, center: Point, width: float, depth: float, heading: float = 0.0
) -> Point:
    """Return the nearest point on or inside a rotated rectangle."""
    forward = heading_vector(heading)
    normal = -forward[1], forward[0]
    relative = subtract(point, center)
    along = max(-width / 2, min(width / 2, dot(relative, forward)))
    across = max(-depth / 2, min(depth / 2, dot(relative, normal)))
    return add(add(center, forward, along), normal, across)


def in_cone(observer: Point, heading: float, target: Point, degrees_wide: float, reach: float) -> bool:
    """Return whether ``target`` lies in the inclusive range and vision cone."""
    offset = subtract(target, observer)
    target_distance = hypot(*offset)
    if target_distance > reach + EPSILON:
        return False
    if target_distance <= EPSILON:
        return True
    return dot(heading_vector(heading), offset) / target_distance >= cos(radians(degrees_wide / 2)) - EPSILON


def orientation(first: Point, second: Point, third: Point) -> float:
    return cross(subtract(second, first), subtract(third, first))


def on_segment(point: Point, start: Point, end: Point) -> bool:
    """Return whether a collinear point lies on the inclusive finite segment."""
    return (
        abs(orientation(start, end, point)) <= EPSILON
        and min(start[0], end[0]) - EPSILON <= point[0] <= max(start[0], end[0]) + EPSILON
        and min(start[1], end[1]) - EPSILON <= point[1] <= max(start[1], end[1]) + EPSILON
    )


def segments_intersect(first: Segment, second: Segment) -> bool:
    """Return whether two inclusive segments touch or cross."""
    a, b = first
    c, d = second
    first_c = orientation(a, b, c)
    first_d = orientation(a, b, d)
    second_a = orientation(c, d, a)
    second_b = orientation(c, d, b)
    if (first_c > EPSILON and first_d < -EPSILON or first_c < -EPSILON and first_d > EPSILON) and (
        second_a > EPSILON and second_b < -EPSILON or second_a < -EPSILON and second_b > EPSILON
    ):
        return True
    return any(
        (
            abs(value) <= EPSILON and on_segment(point, start, end)
            for value, point, start, end in (
                (first_c, c, a, b),
                (first_d, d, a, b),
                (second_a, a, c, d),
                (second_b, b, c, d),
            )
        )
    )


def point_in_polygon(point: Point, polygon: tuple[Point, ...]) -> bool:
    """Return whether a point is inside or on the boundary of a simple polygon."""
    if len(polygon) < 3:
        return False
    inside = False
    for start, end in zip(polygon, (*polygon[1:], polygon[0]), strict=True):
        if on_segment(point, start, end):
            return True
        if (start[1] > point[1]) != (end[1] > point[1]):
            crossing_x = (end[0] - start[0]) * (point[1] - start[1]) / (end[1] - start[1]) + start[0]
            if point[0] < crossing_x:
                inside = not inside
    return inside


def rectangle_corners(
    center: Point, width: float, depth: float, heading: float
) -> tuple[Point, Point, Point, Point]:
    """Return a rotated rectangle's corners counter-clockwise from southwest in local space."""
    forward = heading_vector(heading)
    left = -forward[1], forward[0]
    half_width = width / 2
    half_depth = depth / 2
    return tuple(
        add(add(center, forward, along), left, across)
        for along, across in (
            (-half_width, -half_depth),
            (half_width, -half_depth),
            (half_width, half_depth),
            (-half_width, half_depth),
        )
    )  # type: ignore[return-value]


def point_in_rectangle(point: Point, center: Point, width: float, depth: float, heading: float = 0.0) -> bool:
    return point_in_polygon(point, rectangle_corners(center, width, depth, heading))


def polyline_distance(point: Point, points: tuple[Point, ...]) -> float:
    """Return the distance from a point to a non-empty polyline."""
    if len(points) == 1:
        return distance(point, points[0])
    return min(distance_to_segment(point, start, end) for start, end in zip(points, points[1:], strict=False))
