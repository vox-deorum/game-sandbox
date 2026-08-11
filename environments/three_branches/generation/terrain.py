"""Layer 1: the waterways, reed flats, and field terraces drawn on the seed's land."""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from random import Random

from ..geometry import Point, add, subtract
from ..layout import WORLD_SIZE, Polyline
from .config import GENERATION_CONFIG
from .walker import (
    _ABORT_SLACK,
    _angled,
    _Bounds,
    _coarse,
    _draw_weights,
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

_MOUTH_EDGE_MARGIN = GENERATION_CONFIG.terrain.mouth_edge_margin
_MOUTH_GAP_LOW = GENERATION_CONFIG.terrain.mouth_gap.low
_MOUTH_GAP_HIGH = GENERATION_CONFIG.terrain.mouth_gap.high


_TOPOLOGY_TRIES = GENERATION_CONFIG.terrain.topology_tries
_COURSE_TRIES = GENERATION_CONFIG.terrain.course_tries


_REED_MOISTURE = GENERATION_CONFIG.terrain.reed_moisture


_SIBLING_CLEARANCE = GENERATION_CONFIG.terrain.sibling_clearance


def _waterways(terrain: _Terrain, rng: Random) -> tuple[Polyline, ...] | None:
    """Draw the water topology and walk the trunk and channels through the terrain.

    The mouth targets are drawn constructively inside their feasibility bands. Each topology and
    each course has a local retry budget before the terrain layer asks for a whole redraw.
    """
    for _ in range(_TOPOLOGY_TRIES):
        entry_margin = GENERATION_CONFIG.terrain.entry_x_margin
        entry = (
            rng.uniform(WORLD_SIZE / 3.0 + entry_margin, WORLD_SIZE * 2.0 / 3.0 - entry_margin),
            WORLD_SIZE,
        )
        fork = (
            rng.uniform(GENERATION_CONFIG.terrain.fork_x.low, GENERATION_CONFIG.terrain.fork_x.high),
            rng.uniform(GENERATION_CONFIG.terrain.fork_y.low, GENERATION_CONFIG.terrain.fork_y.high),
        )
        reach = GENERATION_CONFIG.terrain.mouth_center_fork_reach
        center_low = max(_MOUTH_EDGE_MARGIN + _MOUTH_GAP_LOW, fork[0] - reach)
        center_high = min(WORLD_SIZE - _MOUTH_EDGE_MARGIN - _MOUTH_GAP_LOW, fork[0] + reach)
        center_mouth = rng.uniform(center_low, center_high)
        west_mouth = center_mouth - rng.uniform(
            _MOUTH_GAP_LOW, min(_MOUTH_GAP_HIGH, center_mouth - _MOUTH_EDGE_MARGIN)
        )
        east_mouth = center_mouth + rng.uniform(
            _MOUTH_GAP_LOW, min(_MOUTH_GAP_HIGH, WORLD_SIZE - _MOUTH_EDGE_MARGIN - center_mouth)
        )
        weights = _draw_weights(rng, GENERATION_CONFIG.terrain.water_weights)

        trunk = None
        for _ in range(_COURSE_TRIES):
            heading = _angled(
                (0.0, -1.0),
                rng.uniform(
                    GENERATION_CONFIG.terrain.trunk_heading.low, GENERATION_CONFIG.terrain.trunk_heading.high
                ),
            )
            width = rng.uniform(
                GENERATION_CONFIG.terrain.trunk_width.low, GENERATION_CONFIG.terrain.trunk_width.high
            )
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
            approach = (mouth, GENERATION_CONFIG.terrain.channel_approach_y)
            prior = tuple(channels)
            avoid = _coarse(prior)
            channel = None
            for _ in range(_COURSE_TRIES):
                heading = _angled(
                    _unit(subtract(approach, fork)),
                    rng.uniform(
                        GENERATION_CONFIG.terrain.channel_heading.low,
                        GENERATION_CONFIG.terrain.channel_heading.high,
                    ),
                )
                width = rng.uniform(
                    GENERATION_CONFIG.terrain.channel_width.low, GENERATION_CONFIG.terrain.channel_width.high
                )
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
                    exempt=(fork, GENERATION_CONFIG.terrain.fork_exempt_radius),
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
        side = _moister_side(
            terrain,
            window,
            channel.width / 2.0 + GENERATION_CONFIG.terrain.reed_side_probe_offset,
        )
        return _strip(
            window,
            side,
            channel.width / 2.0 + GENERATION_CONFIG.terrain.reed_inner_offset,
            rng.uniform(GENERATION_CONFIG.terrain.reed_depth.low, GENERATION_CONFIG.terrain.reed_depth.high),
            terrain.moisture,
        )

    for channel in channels[1:]:
        window = channel.points[
            max(0, len(channel.points) - GENERATION_CONFIG.terrain.reed_mouth_window_points) : -1
        ]
        flat = _reed_flat(window, channel)
        if flat is not None:
            flats.append(flat)
    for channel in channels:
        placed = 0
        for start in range(
            GENERATION_CONFIG.terrain.bank_scan_start,
            len(channel.points) - GENERATION_CONFIG.terrain.bank_scan_end,
            GENERATION_CONFIG.terrain.reed_window_step,
        ):
            if placed >= GENERATION_CONFIG.terrain.maximum_bank_features:
                break
            window = channel.points[start : start + GENERATION_CONFIG.terrain.bank_window_points]
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
        for start in range(
            GENERATION_CONFIG.terrain.bank_scan_start,
            len(channel.points) - GENERATION_CONFIG.terrain.bank_scan_end,
            GENERATION_CONFIG.terrain.terrace_window_step,
        ):
            if placed == GENERATION_CONFIG.terrain.maximum_bank_features:
                break
            window = channel.points[start : start + GENERATION_CONFIG.terrain.bank_window_points]
            middle = window[1]
            if (
                middle[1] > GENERATION_CONFIG.terrain.terrace_y_max
                or terrain.elevation(middle) > GENERATION_CONFIG.terrain.terrace_elevation_max
            ):
                continue
            side = _moister_side(
                terrain,
                window,
                channel.width / 2.0 + GENERATION_CONFIG.terrain.terrace_side_probe_offset,
            )
            terrace = _strip(
                window,
                side,
                channel.width / 2.0 + GENERATION_CONFIG.terrain.terrace_inner_offset,
                rng.uniform(
                    GENERATION_CONFIG.terrain.terrace_depth.low, GENERATION_CONFIG.terrain.terrace_depth.high
                ),
                terrain.moisture,
            )
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
