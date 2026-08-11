"""Layer 1: the waterways, reed flats, and field terraces drawn on the seed's land."""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from random import Random

from ..geometry import Point, add, subtract
from ..layout import WORLD_SIZE, Polyline
from .walker import (
    _ABORT_SLACK,
    _angled,
    _Bounds,
    _coarse,
    _Field,
    _leg_limit,
    _lines_cross,
    _Polygons,
    _resample,
    _Segment,
    _self_intersects,
    _Terrain,
    _unit,
    _walk,
)

_MOUTH_EDGE_MARGIN = 10.0
_MOUTH_GAP_LOW = 22.0
_MOUTH_GAP_HIGH = 32.0


_TOPOLOGY_TRIES = 3
_COURSE_TRIES = 6


_REED_MOISTURE = 0.58


_SIBLING_CLEARANCE = 1.0


def _waterways(terrain: _Terrain, rng: Random) -> tuple[Polyline, ...] | None:
    """Draw the water topology and walk the trunk and channels through the terrain.

    The mouth targets are drawn constructively inside their feasibility bands. Each topology and
    each course has a local retry budget before the terrain layer asks for a whole redraw.
    """
    for _ in range(_TOPOLOGY_TRIES):
        entry = (rng.uniform(WORLD_SIZE / 3.0 + 1.0, WORLD_SIZE * 2.0 / 3.0 - 1.0), WORLD_SIZE)
        fork = (rng.uniform(25.0, 75.0), rng.uniform(40.0, 60.0))
        center_low = max(_MOUTH_EDGE_MARGIN + _MOUTH_GAP_LOW, fork[0] - 8.0)
        center_high = min(WORLD_SIZE - _MOUTH_EDGE_MARGIN - _MOUTH_GAP_LOW, fork[0] + 8.0)
        center_mouth = rng.uniform(center_low, center_high)
        west_mouth = center_mouth - rng.uniform(
            _MOUTH_GAP_LOW, min(_MOUTH_GAP_HIGH, center_mouth - _MOUTH_EDGE_MARGIN)
        )
        east_mouth = center_mouth + rng.uniform(
            _MOUTH_GAP_LOW, min(_MOUTH_GAP_HIGH, WORLD_SIZE - _MOUTH_EDGE_MARGIN - center_mouth)
        )
        weights = (rng.uniform(0.5, 0.85), rng.uniform(0.5, 1.2), rng.uniform(0.4, 0.65))

        trunk = None
        for _ in range(_COURSE_TRIES):
            heading = _angled((0.0, -1.0), rng.uniform(-45.0, 45.0))
            width = rng.uniform(5.0, 7.0)
            course = _walk(terrain, entry, fork, weights, heading, limit=_leg_limit(entry, fork))
            if course is None:
                continue
            candidate = Polyline(_resample(course), width)
            if not _self_intersects(candidate.points):
                trunk = candidate
                break
        if trunk is None:
            continue

        channels: list[Polyline] = [trunk]
        for mouth in (west_mouth, center_mouth, east_mouth):
            approach = (mouth, 6.0)
            prior = tuple(channels)
            avoid = _coarse(prior)
            channel = None
            for _ in range(_COURSE_TRIES):
                heading = _angled(_unit(subtract(approach, fork)), rng.uniform(-20.0, 20.0))
                width = rng.uniform(2.5, 4.0)
                clearances = tuple(
                    (width + existing.width) / 2.0 + _SIBLING_CLEARANCE + _ABORT_SLACK for existing in prior
                )
                course = _walk(
                    terrain,
                    fork,
                    approach,
                    weights,
                    heading,
                    avoid=avoid,
                    clearances=clearances,
                    exempt=(fork, 15.0),
                    limit=_leg_limit(fork, approach),
                )
                if course is None:
                    continue
                course.append((mouth, 0.0))
                candidate = Polyline(_resample(course), width)
                if _self_intersects(candidate.points):
                    continue
                if any(_lines_cross(existing.points, candidate.points) for existing in prior):
                    continue
                channel = candidate
                break
            if channel is None:
                break
            channels.append(channel)
        if len(channels) == 4:
            return tuple(channels)
    return None


def _normals(points: tuple[Point, ...]) -> list[tuple[Point, Point]]:
    """Each point of a polyline paired with its unit left normal."""
    result: list[tuple[Point, Point]] = []
    last = len(points) - 1
    for index, point in enumerate(points):
        before = points[max(0, index - 1)]
        after = points[min(last, index + 1)]
        direction = _unit(subtract(after, before))
        result.append((point, (-direction[1], direction[0])))
    return result


def _strip(
    points: tuple[Point, ...], side: float, inner: float, depth: float, wobble: _Field
) -> tuple[Point, ...] | None:
    """A bank-following quad strip polygon, or None when it folds or leaves the frame."""
    if len(points) < 2:
        return None
    inner_edge: list[Point] = []
    outer_edge: list[Point] = []
    for point, normal in _normals(points):
        offset = (normal[0] * side, normal[1] * side)
        reach = depth + 2.0 * wobble(point) - 1.0
        inner_edge.append(add(point, offset, inner))
        outer_edge.append(add(point, offset, inner + max(1.0, reach)))
    polygon = tuple(inner_edge + outer_edge[::-1])
    for x, y in polygon:
        if not (0.0 <= x <= WORLD_SIZE and 0.0 <= y <= WORLD_SIZE):
            return None
    if _self_intersects(polygon, closed=True):
        return None
    return polygon


def _moister_side(terrain: _Terrain, points: tuple[Point, ...], reach: float) -> float:
    """The sign of the bank side with more moisture around the window's middle."""
    middle, normal = _normals(points)[len(points) // 2]
    left = terrain.moisture(add(middle, normal, reach))
    right = terrain.moisture(add(middle, normal, -reach))
    return 1.0 if left >= right else -1.0


def _reed_banks(
    terrain: _Terrain, rng: Random, channels: tuple[Polyline, ...]
) -> tuple[tuple[Point, ...], ...]:
    """Reed flats at every channel mouth and on the wettest bank stretches."""
    flats: list[tuple[Point, ...]] = []

    def _reed_flat(window: tuple[Point, ...], channel: Polyline) -> tuple[Point, ...] | None:
        side = _moister_side(terrain, window, channel.width / 2.0 + 2.0)
        return _strip(window, side, channel.width / 2.0 - 0.2, rng.uniform(2.0, 4.0), terrain.moisture)

    for channel in channels[1:]:
        window = channel.points[max(0, len(channel.points) - 5) : -1]
        flat = _reed_flat(window, channel)
        if flat is not None:
            flats.append(flat)
    for channel in channels:
        placed = 0
        for start in range(2, len(channel.points) - 6, 4):
            if placed >= 2:
                break
            window = channel.points[start : start + 4]
            if terrain.moisture(window[1]) <= _REED_MOISTURE:
                continue
            flat = _reed_flat(window, channel)
            if flat is not None:
                flats.append(flat)
                placed += 1
    return tuple(flats)


def _terraces(
    terrain: _Terrain, rng: Random, channels: tuple[Polyline, ...]
) -> tuple[tuple[Point, ...], ...]:
    """Field terraces on the low stretches of the lower channel banks."""
    terraces: list[tuple[Point, ...]] = []
    for channel in channels[1:]:
        placed = 0
        for start in range(2, len(channel.points) - 6, 5):
            if placed == 2:
                break
            window = channel.points[start : start + 4]
            middle = window[1]
            if middle[1] > 35.0 or terrain.elevation(middle) > 0.5:
                continue
            side = _moister_side(terrain, window, channel.width / 2.0 + 4.0)
            terrace = _strip(window, side, channel.width / 2.0 + 1.5, rng.uniform(5.0, 8.0), terrain.moisture)
            if terrace is not None:
                terraces.append(terrace)
                placed += 1
    return tuple(terraces)


def _terrain_layer(rng: Random) -> tuple[_Terrain, tuple[Polyline, ...], _Polygons, _Polygons] | None:
    """The terrain layer: the land, its waterways, its field terraces, and its reed flats.

    The terrain comes back with the parts because every later layer scores against the same land.
    Returns None to redraw the village.
    """
    terrain = _Terrain(rng)
    channels = _waterways(terrain, rng)
    if channels is None:
        return None
    return terrain, channels, _terraces(terrain, rng, channels), _reed_banks(terrain, rng, channels)


@dataclass(frozen=True)
class _Water:
    """The channels and the confluence geometry shared by later village layers."""

    channels: tuple[Polyline, ...]
    fork: Point
    cap_radius: float
    segments: tuple[tuple[_Segment, ...], ...] = field(init=False, repr=False)
    bounds: tuple[tuple[_Bounds, ...], ...] = field(init=False, repr=False)
    extents: tuple[_Bounds, ...] = field(init=False, repr=False)

    @classmethod
    def of(cls, channels: tuple[Polyline, ...]) -> _Water:
        """Capture the channels' shared fork and maximum confluence cap."""
        return cls(channels, channels[0].points[-1], max(channel.width for channel in channels) / 2.0)

    def __post_init__(self) -> None:
        segments = tuple(tuple(itertools.pairwise(channel.points)) for channel in self.channels)
        bounds = tuple(
            tuple(
                (
                    min(start[0], end[0]),
                    min(start[1], end[1]),
                    max(start[0], end[0]),
                    max(start[1], end[1]),
                )
                for start, end in pieces
            )
            for pieces in segments
        )
        extents = tuple(
            (
                min(point[0] for point in channel.points),
                min(point[1] for point in channel.points),
                max(point[0] for point in channel.points),
                max(point[1] for point in channel.points),
            )
            for channel in self.channels
        )
        object.__setattr__(self, "segments", segments)
        object.__setattr__(self, "bounds", bounds)
        object.__setattr__(self, "extents", extents)
