"""Shared garden-plot geometry for home placement, paths, and accessories."""

from __future__ import annotations

from ..geometry import Point, add, heading_to, heading_vector, rectangle_corners
from ..layout import Building
from ..prop_types import PROP_TYPE_BY_TOKEN

type Rectangle = tuple[Point, float, float, float]


def plot_rectangle(home: Building) -> Rectangle:
    """Return the fixed garden footprint opposite a home's doorway."""
    return plot_rectangle_at(home, home.doorway.position)


def plot_rectangle_at(home: Building, doorway: Point) -> Rectangle:
    """Return the fixed garden footprint opposite one doorway position on a home."""
    footprint = PROP_TYPE_BY_TOKEN["plot"].footprint
    doorway_outward = heading_vector(heading_to(home.center, doorway))
    forward = heading_vector(home.rotation)
    wall_span = (
        home.width
        if abs(doorway_outward[0] * forward[0] + doorway_outward[1] * forward[1]) > 0.5
        else home.depth
    )
    center = add(
        home.center,
        doorway_outward,
        -(wall_span / 2.0 + footprint.depth / 2.0),
    )
    rotation = heading_to((0.0, 0.0), (-doorway_outward[1], doorway_outward[0]))
    return center, footprint.width, footprint.depth, rotation


def plot_reservations(home: Building) -> tuple[Rectangle, ...]:
    """Return one garden footprint for each wall a later path could select as the doorway wall."""
    corners = rectangle_corners(home.center, home.width, home.depth, home.rotation)
    doorway_positions = tuple(
        ((start[0] + end[0]) / 2.0, (start[1] + end[1]) / 2.0)
        for start, end in zip(corners, (*corners[1:], corners[0]), strict=True)
    )
    return tuple(plot_rectangle_at(home, doorway) for doorway in doorway_positions)


def plot_rectangles(buildings: tuple[Building, ...]) -> tuple[Rectangle, ...]:
    """Return the garden footprint reserved by every home."""
    return tuple(plot_rectangle(building) for building in buildings if building.type == "home")
