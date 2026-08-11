"""Seeded village generation: the terrain, site, and road network layers over fixture props."""

from __future__ import annotations

import itertools
import math
from collections.abc import Iterator
from dataclasses import dataclass, field, replace
from random import Random
from typing import NamedTuple

from .fixture import FIXTURE_VILLAGE
from .geometry import (
    EPSILON,
    Point,
    add,
    distance,
    distance_to_rectangle,
    distance_to_segment,
    heading_to,
    heading_vector,
    polyline_distance,
    rectangle_corners,
    segments_intersect,
    subtract,
)
from .layout import WORLD_SIZE, Bridge, Building, Doorway, Layout, Polyline

type _Polygons = tuple[tuple[Point, ...], ...]
type _Segment = tuple[Point, Point]
type _Bounds = tuple[float, float, float, float]

MAX_REDRAWS = 64
MAX_POLYLINE_POINTS = 35
BUILDING_GAP = 2.0
WATER_CLEARANCE = 2.0
BOUNDARY_MARGIN = 2.0
HOME_CLUSTER_RADIUS = 7.0
HOME_CLUSTER_SEPARATION = 32.0
SPAWN_CLEARANCE = 2.0

_OCTAVE_SPACINGS = (25.0, 12.5, 6.25)
_WALK_STEP = 2.0
_MAX_WALK_STEPS = 300
_SAMPLE_SPACING = 3.0
_MOUTH_EDGE_MARGIN = 10.0
_MOUTH_GAP_LOW = 22.0
_MOUTH_GAP_HIGH = 32.0
_SIBLING_CLEARANCE = 1.0
_REPEL_RADIUS = 12.0
_REPEL_WEIGHT = 1.5
_EDGE_RADIUS = 6.0
_EDGE_WEIGHT = 1.2
_EDGE_FADE = 15.0
_ABORT_SLACK = 0.5
_PLACEMENT_BUDGET = 300
_ANCHOR_BUDGET = 150
_HOME_SIZE = (6.0, 5.0)
_INN_SIZE = (10.0, 8.0)
_SHED_SIZE = (6.0, 6.0)
_PLAZA_CLEARANCE = 5.0
_DECK_APRON = 1.0
_DRY_MARGIN = 0.6
_CROSSING_BAND = 8.0
_CROSSING_FORK_GAP = 12.0
_JUNCTION_DECK_GAP = 3.0
_ROUTE_GAP = 0.3
_ROAD_TRIES = 10
_TOPOLOGY_TRIES = 3
_COURSE_TRIES = 6
_SITES_TRIES = 3
_NETWORK_TRIES = 2
_FOOTPATH_TRIES = 4
_FOOTPATH_REDRAWS = 3
_SHRINE_CLEARANCE = 2.5
_SHRINE_SEPARATION = 15.0
_WEDGE_HALF_OPENING = 4.0
_CLUSTER_RADIUS_LOW = 6.5
_CLUSTER_RING_DEPTH = 2.0
_CLUSTER_WATER_MIN = 10.0
_REED_MOISTURE = 0.58
_WEDGE_SLIDE_LIMIT = 36.0


def _fade(t: float) -> float:
    """Smoothstep fade for lattice interpolation."""
    return t * t * (3.0 - 2.0 * t)


class _Field:
    """Fractal value noise over seeded lattices, sampled in the unit interval.

    Roughness scales the finer octaves, so a rough seed's land changes character over a few
    meters while a smooth seed rolls gently. The lattices cover two node rings beyond the
    frame, since bank probes sample the fields a few meters outside it.
    """

    def __init__(self, rng: Random, roughness: float) -> None:
        amplitudes = (1.0, 0.5 * roughness, 0.25 * roughness)
        self._total = sum(amplitudes)
        self._lattices: list[tuple[float, float, list[list[float]]]] = []
        for spacing, amplitude in zip(_OCTAVE_SPACINGS, amplitudes, strict=True):
            nodes = math.ceil(WORLD_SIZE / spacing) + 3
            lattice = [[0.0] * (nodes + 2) for _ in range(nodes + 2)]
            for column in range(-2, nodes):
                for row in range(-2, nodes):
                    lattice[row + 2][column + 2] = rng.random()
            self._lattices.append((spacing, amplitude, lattice))

    def __call__(self, point: Point) -> float:
        total = 0.0
        for spacing, amplitude, lattice in self._lattices:
            u = point[0] / spacing
            v = point[1] / spacing
            column = math.floor(u)
            row = math.floor(v)
            fu = _fade(u - column)
            fv = _fade(v - row)
            lower = lattice[row + 2]
            upper = lattice[row + 3]
            lower_left = lower[column + 2]
            lower_right = lower[column + 3]
            upper_left = upper[column + 2]
            upper_right = upper[column + 3]
            low = lower_left + (lower_right - lower_left) * fu
            high = upper_left + (upper_right - upper_left) * fu
            total += amplitude * (low + (high - low) * fv)
        return total / self._total


class _Terrain:
    """The seed's land: elevation with a southward fall, and a moisture field."""

    def __init__(self, rng: Random) -> None:
        roughness = rng.uniform(0.5, 1.6)
        self._relief = _Field(rng, roughness)
        self.moisture = _Field(rng, roughness)
        self._slope = rng.uniform(0.35, 0.55)

    def elevation(self, point: Point) -> float:
        return (1.0 - self._slope) * self._relief(point) + self._slope * (point[1] / WORLD_SIZE)

    def downhill(self, point: Point) -> Point:
        """The direction water wants to take, from a central-difference elevation gradient."""
        x, y = point
        east = self.elevation((x + 1.0, y)) - self.elevation((x - 1.0, y))
        north = self.elevation((x, y + 1.0)) - self.elevation((x, y - 1.0))
        return (-east, -north)


def _unit(vector: Point) -> Point:
    length = math.hypot(vector[0], vector[1])
    if length < 1e-9:
        return (0.0, 0.0)
    return (vector[0] / length, vector[1] / length)


def _nearest_on(point: Point, polyline: tuple[Point, ...]) -> tuple[Point, float]:
    """The nearest point of a polyline, with the projection inlined for the walker's hot loop."""
    px, py = point
    best_span = math.inf
    best = polyline[0]
    ax, ay = polyline[0]
    for bx, by in polyline[1:]:
        rx, ry = bx - ax, by - ay
        length_squared = rx * rx + ry * ry
        if length_squared > 0.0:
            t = ((px - ax) * rx + (py - ay) * ry) / length_squared
            t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
            nx, ny = ax + rx * t, ay + ry * t
        else:
            nx, ny = ax, ay
        dx, dy = px - nx, py - ny
        span = dx * dx + dy * dy
        if span < best_span:
            best_span = span
            best = (nx, ny)
        ax, ay = bx, by
    return best, best_span


def _coarse(channels: tuple[Polyline, ...] | list[Polyline]) -> tuple[tuple[Point, ...], ...]:
    """Channel centerlines thinned for the walker's repel checks, endpoints kept."""
    return tuple((*channel.points[::2], channel.points[-1]) for channel in channels)


def _walk(
    terrain: _Terrain,
    start: Point,
    target: Point,
    weights: tuple[float, float, float],
    start_heading: Point,
    avoid: tuple[tuple[Point, ...], ...] = (),
    repel_radius: float = _REPEL_RADIUS,
    clearances: tuple[float, ...] | None = None,
    exempt: tuple[Point, float] | None = None,
    *,
    limit: int,
) -> list[Point] | None:
    """Trace a course from start to target as a blend of momentum, downhill flow, and target pull.

    Geometry already on the map pushes the course away with the given repel radius and weight, so
    water spreads from siblings and routes bend around buildings. The pull ramps up as the target
    nears so every course arrives, and the final point is the target verbatim. Returns None when
    the course leaves the frame or fails to arrive inside the step limit.
    """
    momentum_weight, downhill_weight, pull_weight = weights
    if clearances is not None and len(clearances) != len(avoid):
        raise ValueError("clearances must align with avoid lines")
    clearance_squares = tuple(clearance * clearance for clearance in clearances) if clearances else ()
    avoid_checks: list[tuple[tuple[Point, ...], _Bounds, float]] = []
    for index, line in enumerate(avoid):
        minimum_x = maximum_x = line[0][0]
        minimum_y = maximum_y = line[0][1]
        for x, y in line[1:]:
            if x < minimum_x:
                minimum_x = x
            if maximum_x < x:
                maximum_x = x
            if y < minimum_y:
                minimum_y = y
            if maximum_y < y:
                maximum_y = y
        avoid_checks.append(
            (
                line,
                (minimum_x, minimum_y, maximum_x, maximum_y),
                max(repel_radius, clearances[index]) if clearances else repel_radius,
            )
        )
    repel_radius_squared = repel_radius * repel_radius
    points = [start]
    heading = start_heading
    for _ in range(limit):
        position = points[-1]
        remaining = distance(position, target)
        if remaining <= _WALK_STEP * 1.5:
            points.append(target)
            return points
        toward = _unit(subtract(target, position))
        slope = _unit(terrain.downhill(position))
        along = slope[0] * toward[0] + slope[1] * toward[1]
        lateral = (slope[0] - along * toward[0], slope[1] - along * toward[1])
        repulsion = (0.0, 0.0)
        for index, (line, bounds, check_radius) in enumerate(avoid_checks):
            if (
                position[0] < bounds[0] - check_radius
                or bounds[2] + check_radius < position[0]
                or position[1] < bounds[1] - check_radius
                or bounds[3] + check_radius < position[1]
            ):
                continue
            nearest, span_squared = _nearest_on(position, line)
            if (
                clearances is not None
                and span_squared < clearance_squares[index]
                and (exempt is None or distance(position, exempt[0]) > exempt[1])
            ):
                return None
            if span_squared < repel_radius_squared:
                span = math.hypot(position[0] - nearest[0], position[1] - nearest[1])
                away = _unit(subtract(position, nearest))
                push = _REPEL_WEIGHT * (1.0 - span / repel_radius)
                repulsion = (repulsion[0] + away[0] * push, repulsion[1] + away[1] * push)
        edge_fade = _EDGE_WEIGHT * min(1.0, remaining / _EDGE_FADE)
        if position[0] < _EDGE_RADIUS:
            repulsion = (repulsion[0] + edge_fade * (1.0 - position[0] / _EDGE_RADIUS), repulsion[1])
        if WORLD_SIZE - position[0] < _EDGE_RADIUS:
            repulsion = (
                repulsion[0] - edge_fade * (1.0 - (WORLD_SIZE - position[0]) / _EDGE_RADIUS),
                repulsion[1],
            )
        if position[1] < _EDGE_RADIUS:
            repulsion = (repulsion[0], repulsion[1] + edge_fade * (1.0 - position[1] / _EDGE_RADIUS))
        if WORLD_SIZE - position[1] < _EDGE_RADIUS:
            repulsion = (
                repulsion[0],
                repulsion[1] - edge_fade * (1.0 - (WORLD_SIZE - position[1]) / _EDGE_RADIUS),
            )
        arrival = max(0.0, 1.0 - remaining / 20.0)
        blended = _unit(
            (
                momentum_weight * heading[0]
                + downhill_weight * lateral[0]
                + repulsion[0]
                + (pull_weight + arrival) * toward[0],
                momentum_weight * heading[1]
                + downhill_weight * lateral[1]
                + repulsion[1]
                + (pull_weight + arrival) * toward[1],
            )
        )
        heading = toward if blended == (0.0, 0.0) else blended
        candidate = add(position, heading, _WALK_STEP)
        if not (0.0 <= candidate[0] <= WORLD_SIZE and 0.0 <= candidate[1] <= WORLD_SIZE):
            return None
        points.append(candidate)
    return None


def _leg_limit(start: Point, end: Point) -> int:
    """A step budget that lets a course triple its straight length before giving up."""
    return min(_MAX_WALK_STEPS, math.ceil(distance(start, end) / _WALK_STEP) * 3 + 25)


def _course_length(points: list[Point] | tuple[Point, ...]) -> float:
    return sum(distance(previous, current) for previous, current in itertools.pairwise(points))


def _resample_to(points: list[Point] | tuple[Point, ...], count: int) -> tuple[Point, ...]:
    """Even arc-length resampling to the given point count, keeping both endpoints exact."""
    if len(points) <= count:
        return tuple(points)
    lengths = [0.0]
    for previous, current in itertools.pairwise(points):
        lengths.append(lengths[-1] + distance(previous, current))
    total = lengths[-1]
    resampled: list[Point] = [points[0]]
    cursor = 1
    for index in range(1, count - 1):
        goal = total * index / (count - 1)
        while lengths[cursor] < goal:
            cursor += 1
        span = lengths[cursor] - lengths[cursor - 1]
        fraction = 0.0 if span <= 0.0 else (goal - lengths[cursor - 1]) / span
        (ax, ay), (bx, by) = points[cursor - 1], points[cursor]
        resampled.append((ax + (bx - ax) * fraction, ay + (by - ay) * fraction))
    resampled.append(points[-1])
    return tuple(resampled)


def _resample(points: list[Point]) -> tuple[Point, ...]:
    """Even arc-length resampling under the overlay point cap, keeping both endpoints exact."""
    total = _course_length(points)
    count = min(MAX_POLYLINE_POINTS, max(2, math.ceil(total / _SAMPLE_SPACING) + 1))
    return _resample_to(points, count)


def _thread(legs: list[list[Point]], joints: list[Point]) -> tuple[Point, ...] | None:
    """Join walker legs and their crossing joints into one polyline under the overlay point cap.

    The legs share the point budget, longest legs giving up points first, and every leg endpoint
    and joint stays verbatim, so a crossing's straight run stays exactly on its deck axis.
    """
    budget = MAX_POLYLINE_POINTS - len(joints)
    if 2 * len(legs) > budget:
        return None
    counts = [max(2, math.ceil(_course_length(leg) / _SAMPLE_SPACING) + 1) for leg in legs]
    while sum(counts) > budget:
        largest = max(range(len(counts)), key=lambda index: counts[index])
        counts[largest] -= 1
    course: list[Point] = []
    for index, leg in enumerate(legs):
        course.extend(_resample_to(leg, counts[index]))
        if index < len(joints):
            course.append(joints[index])
    return tuple(course)


def _segments(points: tuple[Point, ...], closed: bool) -> list[tuple[Point, Point]]:
    segments = list(itertools.pairwise(points))
    if closed:
        segments.append((points[-1], points[0]))
    return segments


def _cross_off_ends(first: _Segment, second: _Segment) -> bool:
    """Whether segments cross anywhere other than a shared endpoint."""
    if first[0] in second or first[1] in second:
        return False
    (first_start_x, first_start_y), (first_end_x, first_end_y) = first
    (second_start_x, second_start_y), (second_end_x, second_end_y) = second
    if (
        first_start_x + EPSILON < second_start_x
        and first_start_x + EPSILON < second_end_x
        and first_end_x + EPSILON < second_start_x
        and first_end_x + EPSILON < second_end_x
    ) or (
        second_start_x + EPSILON < first_start_x
        and second_start_x + EPSILON < first_end_x
        and second_end_x + EPSILON < first_start_x
        and second_end_x + EPSILON < first_end_x
    ):
        return False
    if (
        first_start_y + EPSILON < second_start_y
        and first_start_y + EPSILON < second_end_y
        and first_end_y + EPSILON < second_start_y
        and first_end_y + EPSILON < second_end_y
    ) or (
        second_start_y + EPSILON < first_start_y
        and second_start_y + EPSILON < first_end_y
        and second_end_y + EPSILON < first_start_y
        and second_end_y + EPSILON < first_end_y
    ):
        return False
    return segments_intersect(first, second)


def _self_intersects(points: tuple[Point, ...], closed: bool = False) -> bool:
    """Whether a polyline or polygon crosses itself, ignoring segments that share an endpoint."""
    segments = _segments(points, closed)
    return any(
        _cross_off_ends(first, second)
        for index, first in enumerate(segments)
        for second in segments[index + 1 :]
    )


def _lines_cross(first: tuple[Point, ...], second: tuple[Point, ...]) -> bool:
    """Whether two polylines cross anywhere away from a shared endpoint like the fork."""
    return any(_cross_off_ends(a, b) for a in itertools.pairwise(first) for b in itertools.pairwise(second))


def _angled(base: Point, degrees: float) -> Point:
    """The base direction rotated by the drawn angle."""
    radians = math.radians(degrees)
    cosine, sine = math.cos(radians), math.sin(radians)
    return (base[0] * cosine - base[1] * sine, base[0] * sine + base[1] * cosine)


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


@dataclass(frozen=True)
class _Sites:
    """The settlement's anchors and its buildings.

    Only the buildings are emitted now. The plaza, the corridor line, the bell, market, stall, and
    board spots, and the cluster centers are what the road network and accessories layers build on.
    """

    plaza: Point
    corridor_y: float
    bell: Point
    market: Point
    stalls: tuple[Point, ...]
    board: Point
    clusters: tuple[Point, ...]
    buildings: tuple[Building, ...]


@dataclass(frozen=True)
class _Clearances:
    """The fixed things every building candidate has to stand clear of."""

    water: _Water
    plaza: Point


def _drawn_side(rng: Random) -> float:
    """One side of the corridor, north or south."""
    return 1.0 if rng.random() < 0.5 else -1.0


def _polar(rng: Random, low: float, high: float) -> Point:
    """A drawn offset vector, radius first and then angle."""
    radius = rng.uniform(low, high)
    angle = math.radians(rng.uniform(0.0, 360.0))
    return (radius * math.cos(angle), radius * math.sin(angle))


def _midpoint(first: Point, second: Point) -> Point:
    return ((first[0] + second[0]) / 2.0, (first[1] + second[1]) / 2.0)


def _edges(corners: tuple[Point, ...]) -> tuple[_Segment, ...]:
    return tuple(zip(corners, (*corners[1:], corners[0]), strict=True))


def _water_gap(point: Point, channel: Polyline) -> float:
    """The distance from a point to a channel's water edge."""
    nearest, _span_squared = _nearest_on(point, channel.points)
    return math.hypot(point[0] - nearest[0], point[1] - nearest[1]) - channel.width / 2.0


def _inside_frame(point: Point, margin: float) -> bool:
    return all(margin <= value <= WORLD_SIZE - margin for value in point)


_RAW_OBSTACLES: tuple[tuple[float, float, float], ...] = (
    *(
        (prop.position[0], prop.position[1], math.hypot(*prop.footprint) / 2.0)
        for prop in FIXTURE_VILLAGE.props
    ),
    *((item.position[0], item.position[1], item.radius) for item in FIXTURE_VILLAGE.scenery),
)

_PADDED_OBSTACLES: tuple[tuple[Point, float], ...] = tuple(
    ((x, y), radius + BUILDING_GAP) for x, y, radius in _RAW_OBSTACLES
)


def _padded_room(point: Point, needed: float) -> bool:
    """Whether a point keeps the needed room from every padded fixture object."""
    for x, y, radius in _RAW_OBSTACLES:
        dx = point[0] - x
        dy = point[1] - y
        reach = radius + needed
        if dx * dx + dy * dy < reach * reach:
            return False
    return True


_CLUSTER_GRID = tuple(
    (float(x), float(y))
    for x in range(12, 89, 6)
    for y in range(12, 89, 6)
    if _padded_room((float(x), float(y)), HOME_CLUSTER_RADIUS + BUILDING_GAP)
)


def _well_plaza(rng: Random, water: _Water) -> Point | None:
    """Slide out from the fork along a crook bisector until the wedge between its channels opens.

    A crook is the wedge between an adjacent channel pair, west with center or center with east,
    and which one is tried first is drawn. Returns None when neither crook ever opens.
    """
    crooks = ((water.channels[1], water.channels[2]), (water.channels[2], water.channels[3]))
    for first, second in crooks if rng.random() < 0.5 else crooks[::-1]:
        left = _unit(subtract(first.points[2], water.fork))
        right = _unit(subtract(second.points[2], water.fork))
        bisector = _unit((left[0] + right[0], left[1] + right[1]))
        if bisector == (0.0, 0.0):
            continue
        reach = water.cap_radius + 3.0
        while reach <= _WEDGE_SLIDE_LIMIT:
            candidate = add(water.fork, bisector, reach)
            opening = min(_water_gap(candidate, first), _water_gap(candidate, second))
            if opening >= _WEDGE_HALF_OPENING and _inside_frame(candidate, BOUNDARY_MARGIN):
                return candidate
            reach += 1.0
    return None


def _corridor_anchor(
    rng: Random,
    water: _Water,
    corridor_y: float,
    band: tuple[float, float],
    size: tuple[float, float],
) -> Point | None:
    """Draw a spot off one side of the corridor that already has room for its building.

    The pre-clearance keeps the placement budget off anchors that could never work: the building's
    longer side plus the bank margin away from the water, its half diagonal away from the frame and
    from the padded fixture objects. Returns None when the anchor budget runs out.
    """
    half_diagonal = math.hypot(size[0], size[1]) / 2.0
    room = max(size) / 2.0 + WATER_CLEARANCE
    for _ in range(_ANCHOR_BUDGET):
        x = rng.uniform(*band)
        side = _drawn_side(rng)
        candidate = (x, corridor_y + side * rng.uniform(6.0, 10.0))
        if (
            all(
                candidate[0] < extent[0] - channel.width / 2.0 - room - EPSILON
                or extent[2] + channel.width / 2.0 + room + EPSILON < candidate[0]
                or candidate[1] < extent[1] - channel.width / 2.0 - room - EPSILON
                or extent[3] + channel.width / 2.0 + room + EPSILON < candidate[1]
                or _water_gap(candidate, channel) >= room
                for channel, extent in zip(water.channels, water.extents, strict=True)
            )
            and _inside_frame(candidate, BOUNDARY_MARGIN + half_diagonal)
            and _padded_room(candidate, half_diagonal)
        ):
            return candidate
    return None


def _cluster_scores(terrain: _Terrain, water: _Water, plaza: Point) -> list[tuple[float, Point]]:
    """Score every feasible home cluster center without consuming the generation stream.

    A fixed 6 m grid is scored on bank proximity, flatness, and dryness, and the coarse channel
    polylines keep the water term cheap. A grid point only enters the running when its homes have a
    ring to stand on, clear of the water, the plaza clearing, and the padded fixture objects, so a
    cluster does not seed where its homes cannot follow.
    """
    coarse = tuple(
        ((*channel.points[::3], channel.points[-1]), channel.width / 2.0) for channel in water.channels
    )
    scored: list[tuple[float, Point]] = []
    for point in _CLUSTER_GRID:
        water_gap = math.inf
        for points, half in coarse:
            nearest, _span_squared = _nearest_on(point, points)
            water_gap = min(water_gap, math.hypot(point[0] - nearest[0], point[1] - nearest[1]) - half)
        if water_gap < _CLUSTER_WATER_MIN:
            continue
        if distance(point, plaza) < HOME_CLUSTER_RADIUS + _PLAZA_CLEARANCE:
            continue
        bank = 1.0 - min(abs(water_gap - 10.0) / 12.0, 1.0)
        flat = 1.0 - min(math.hypot(*terrain.downhill(point)) * 25.0, 1.0)
        dry = 1.0 - terrain.moisture(point)
        scored.append((1.2 * bank + 0.8 * flat + 0.6 * dry, point))
    scored.sort(key=lambda entry: (-entry[0], entry[1]))
    return scored


def _pick_clusters(
    rng: Random, scored: list[tuple[float, Point]]
) -> tuple[tuple[Point, ...], tuple[float, ...]] | None:
    """Draw two or three separated cluster centers, falling back from three to two when possible."""
    count = rng.choice((2, 3))
    centers: list[Point] = []
    for _score, point in scored:
        if len(centers) == count:
            break
        if all(distance(point, taken) >= HOME_CLUSTER_SEPARATION for taken in centers):
            centers.append(point)
    if len(centers) < 2:
        return None
    return tuple(centers), tuple(rng.uniform(_CLUSTER_RADIUS_LOW, HOME_CLUSTER_RADIUS) for _ in centers)


def _clear_of_water(
    placement: _Placement,
    water: _Water,
) -> bool:
    """Whether a rectangle keeps the bank margin from every channel.

    A channel whose centerline is a rectangle diagonal away needs no further work, so the exact
    crossing and distance tests only run on the water that is actually nearby.
    """
    center, width, depth, rotation = placement.rectangle
    rectangle_bounds = (
        min(corner[0] for corner in placement.corners),
        min(corner[1] for corner in placement.corners),
        max(corner[0] for corner in placement.corners),
        max(corner[1] for corner in placement.corners),
    )
    for channel, channel_segments, channel_bounds in zip(
        water.channels, water.segments, water.bounds, strict=True
    ):
        margin = channel.width / 2.0 + WATER_CLEARANCE
        for segment, segment_bounds in zip(channel_segments, channel_bounds, strict=True):
            if (
                segment_bounds[2] + margin + EPSILON < rectangle_bounds[0]
                or rectangle_bounds[2] + EPSILON < segment_bounds[0] - margin
                or segment_bounds[3] + margin + EPSILON < rectangle_bounds[1]
                or rectangle_bounds[3] + EPSILON < segment_bounds[1] - margin
            ):
                continue
            if any(segments_intersect(segment, edge) for edge in placement.edges):
                return False
            if any(distance_to_segment(corner, *segment) < margin for corner in placement.corners):
                return False
        for point in channel.points:
            if (
                point[0] < rectangle_bounds[0] - margin
                or rectangle_bounds[2] + margin < point[0]
                or point[1] < rectangle_bounds[1] - margin
                or rectangle_bounds[3] + margin < point[1]
            ):
                continue
            if distance_to_rectangle(point, center, width, depth, rotation) < margin:
                return False
    return True


def _clear_of_padding(center: Point, size: tuple[float, float], rotation: float) -> bool:
    """Whether a rectangle keeps clear of the fixture objects still padding the layout.

    This rule leaves with the padding: the accessories layer replaces these objects, and until then
    the padded suites derive their standing points from them. The rectangle distance is inlined
    with the heading computed once, because the placement budget hammers this check.
    """
    fx, fy = heading_vector(rotation)
    cx, cy = center
    half_width = size[0] / 2.0
    half_depth = size[1] / 2.0
    for (px, py), margin in _PADDED_OBSTACLES:
        rx, ry = px - cx, py - cy
        along = abs(rx * fx + ry * fy) - half_width
        across = abs(fx * ry - fy * rx) - half_depth
        dx = along if along > 0.0 else 0.0
        dy = across if across > 0.0 else 0.0
        if dx * dx + dy * dy < margin * margin:
            return False
    return True


class _Placement(NamedTuple):
    """Cached geometry for one placed building rectangle."""

    rectangle: tuple[Point, float, float, float]
    corners: tuple[Point, ...]
    edges: tuple[_Segment, ...]
    half_diagonal: float


def _placement(center: Point, size: tuple[float, float], rotation: float) -> _Placement:
    """Build the rectangle geometry a placement needs across every later clearance check."""
    corners = rectangle_corners(center, *size, rotation)
    return _Placement((center, *size, rotation), corners, _edges(corners), math.hypot(*size) / 2.0)


def _clears(
    placement: _Placement,
    clearances: _Clearances,
    placed: list[_Placement],
) -> bool:
    """Whether a candidate rectangle clears the frame, the water, the clearings, and every solid."""
    center, width, depth, rotation = placement.rectangle
    if not all(_inside_frame(corner, BOUNDARY_MARGIN) for corner in placement.corners):
        return False
    cap = distance_to_rectangle(clearances.water.fork, center, width, depth, rotation)
    if cap < clearances.water.cap_radius + WATER_CLEARANCE:
        return False
    if distance_to_rectangle(clearances.plaza, center, width, depth, rotation) < _PLAZA_CLEARANCE:
        return False
    if not _clear_of_padding(center, (width, depth), rotation):
        return False
    if not _clear_of_water(placement, clearances.water):
        return False
    for other in placed:
        other_center, other_width, other_depth, other_rotation = other.rectangle
        if distance(center, other_center) >= placement.half_diagonal + other.half_diagonal + BUILDING_GAP:
            continue
        if any(
            segments_intersect(edge, other_edge) for edge in placement.edges for other_edge in other.edges
        ):
            return False
        if any(
            distance_to_rectangle(corner, other_center, other_width, other_depth, other_rotation)
            < BUILDING_GAP
            for corner in placement.corners
        ):
            return False
        if any(
            distance_to_rectangle(corner, center, width, depth, rotation) < BUILDING_GAP
            for corner in other.corners
        ):
            return False
    return True


def _draw_placement(
    rng: Random,
    size: tuple[float, float],
    anchor: Point,
    reach: tuple[float, float],
    spin: tuple[float, float],
    clearances: _Clearances,
    placed: list[_Placement],
) -> _Placement | None:
    """Draw centers and rotations around an anchor until one clears, or None when the budget runs out.

    Channels that no candidate around this anchor can possibly reach are dropped once up front, so
    the budget's water checks only scan the water that is actually in play.
    """
    farthest = reach[1] + math.hypot(*size) / 2.0 + WATER_CLEARANCE + 0.5
    nearby = replace(
        clearances,
        water=replace(
            clearances.water,
            channels=tuple(
                channel
                for channel, extent in zip(clearances.water.channels, clearances.water.extents, strict=True)
                if not (
                    anchor[0] < extent[0] - channel.width / 2.0 - farthest - EPSILON
                    or extent[2] + channel.width / 2.0 + farthest + EPSILON < anchor[0]
                    or anchor[1] < extent[1] - channel.width / 2.0 - farthest - EPSILON
                    or extent[3] + channel.width / 2.0 + farthest + EPSILON < anchor[1]
                )
                and _water_gap(anchor, channel) <= farthest
            ),
        ),
    )
    for _ in range(_PLACEMENT_BUDGET):
        center = add(anchor, _polar(rng, *reach))
        rotation = rng.uniform(*spin) % 360.0
        candidate = _placement(center, size, rotation)
        if _clears(candidate, nearby, placed):
            return candidate
    return None


def _doorway(center: Point, size: tuple[float, float], rotation: float, aim: Point) -> Doorway:
    """Open the wall whose middle faces the aim point; the network layer re-aims at the paths."""
    edges = _edges(rectangle_corners(center, size[0], size[1], rotation))
    start, end = min(edges, key=lambda edge: distance(_midpoint(*edge), aim))
    return Doorway(_midpoint(start, end))


def _sites_layer(rng: Random, terrain: _Terrain, water: _Water) -> _Sites | None:
    """Anchor the settlement on the terrain and stand its buildings, or None to redraw.

    The well plaza is drawn once, then the fixed cluster score runs once. Each site round draws the
    corridor, anchors, landmark spots, cluster count and radii, then inn, shed, and home placements
    in that order. Homes take their clusters round robin. A failed round consumes its draws before
    the next round starts.
    """
    plaza = _well_plaza(rng, water)
    if plaza is None:
        return None
    scored = _cluster_scores(terrain, water, plaza)
    clearances = _Clearances(water, plaza)
    for _ in range(_SITES_TRIES):
        corridor_y = water.fork[1] - rng.uniform(14.0, 24.0)

        shed_anchor = _corridor_anchor(rng, water, corridor_y, (10.0, 30.0), _SHED_SIZE)
        if shed_anchor is None:
            continue
        bell_x = rng.uniform(8.0, 26.0)
        bell_side = _drawn_side(rng)
        bell = (bell_x, corridor_y + bell_side * rng.uniform(2.0, 4.0))

        market = (rng.uniform(42.0, 58.0), corridor_y)
        stall_side = _drawn_side(rng)
        stalls: list[Point] = []
        for _ in range(5):
            stall_x = market[0] + rng.uniform(-10.0, 10.0)
            stalls.append((stall_x, corridor_y + stall_side * rng.uniform(2.5, 5.5)))
            stall_side = -stall_side
        host = stalls[rng.randrange(5)]
        board = (host[0] + rng.uniform(-2.0, 2.0), host[1] + rng.uniform(-2.0, 2.0))

        inn_anchor = _corridor_anchor(rng, water, corridor_y, (70.0, 90.0), _INN_SIZE)
        if inn_anchor is None:
            continue
        seeded = _pick_clusters(rng, scored)
        if seeded is None:
            continue
        clusters, radii = seeded

        placed: list[_Placement] = []
        corridor_buildings: list[Building] = []
        for identifier, size, anchor in (("inn", _INN_SIZE, inn_anchor), ("shed", _SHED_SIZE, shed_anchor)):
            placement = _draw_placement(rng, size, anchor, (0.0, 4.0), (-15.0, 15.0), clearances, placed)
            if placement is None:
                break
            center, width, depth, rotation = placement.rectangle
            aim = (center[0], corridor_y)
            building = Building(
                identifier,
                identifier,
                center,
                width,
                depth,
                rotation,
                _doorway(center, (width, depth), rotation, aim),
            )
            placed.append(placement)
            corridor_buildings.append(building)
        else:
            homes: list[Building] = []
            for index in range(5):
                cluster = clusters[index % len(clusters)]
                radius = radii[index % len(clusters)]
                spread = (radius - _CLUSTER_RING_DEPTH, radius)
                placement = _draw_placement(
                    rng, _HOME_SIZE, cluster, spread, (0.0, 360.0), clearances, placed
                )
                if placement is None:
                    break
                center, width, depth, rotation = placement.rectangle
                doorway = _doorway(center, (width, depth), rotation, cluster)
                home = Building(f"home_{index}", "home", center, width, depth, rotation, doorway)
                placed.append(placement)
                homes.append(home)
            else:
                return _Sites(
                    plaza=plaza,
                    corridor_y=corridor_y,
                    bell=bell,
                    market=market,
                    stalls=tuple(stalls),
                    board=board,
                    clusters=clusters,
                    buildings=(*homes, *corridor_buildings),
                )
    return None


@dataclass(frozen=True)
class _Network:
    """The road network layer's output.

    The shrine spots ride along for the accessories layer, which stands the shrine props and their
    roof posts on them. The buildings come back re-aimed at the finished paths.
    """

    road: Polyline
    footpaths: tuple[Polyline, ...]
    bridges: tuple[Bridge, ...]
    spawn: Point
    shrine_spots: tuple[Point, ...]
    buildings: tuple[Building, ...]


def _rings(buildings: tuple[Building, ...]) -> tuple[tuple[Point, ...], ...]:
    """Closed building corner rings the walker steers around."""
    rings: list[tuple[Point, ...]] = []
    for building in buildings:
        corners = rectangle_corners(building.center, building.width, building.depth, building.rotation)
        rings.append((*corners, corners[0]))
    return tuple(rings)


def _water_reach(origin: Point, direction: Point, channel: Polyline) -> float | None:
    """How far a channel's water band extends from a centerline point along a crossing direction."""
    half = channel.width / 2.0
    low = 0.0
    high = 1.0
    while high <= 12.0 and polyline_distance(add(origin, direction, high), channel.points) <= half:
        low = high
        high += 1.0
    if high > 12.0:
        return None
    for _ in range(2):
        middle = (low + high) / 2.0
        if polyline_distance(add(origin, direction, middle), channel.points) > half:
            high = middle
        else:
            low = middle
    return high


def _crossing(
    rng: Random, channel: Polyline, corridor_y: float, fork: Point, minimum_x: float
) -> tuple[Point, Point] | None:
    """Draw a crossing vertex near the corridor and the eastward unit direction square across it.

    The band around the corridor doubles when it holds no candidate, so a channel that dives away
    from the corridor still gets crossed rather than redrawing the village.
    """
    for band in (_CROSSING_BAND, 2.0 * _CROSSING_BAND):
        candidates: list[tuple[Point, Point]] = []
        for index in range(1, len(channel.points) - 1):
            point = channel.points[index]
            if abs(point[1] - corridor_y) > band:
                continue
            if not max(8.0, minimum_x) <= point[0] <= WORLD_SIZE - 8.0:
                continue
            if distance(point, fork) < _CROSSING_FORK_GAP:
                continue
            along = _unit(subtract(channel.points[index + 1], channel.points[index - 1]))
            normal = (-along[1], along[0])
            if normal[0] < 0.0:
                normal = (-normal[0], -normal[1])
            if normal[0] < 0.3:
                continue
            candidates.append((point, normal))
        if candidates:
            return rng.choice(candidates)
    return None


def _deck(
    rng: Random,
    channel: Polyline,
    water: _Water,
    vertex: Point,
    axis: Point,
) -> tuple[Bridge, Point, Point] | None:
    """Span the water at a crossing: the deck plus its dry near and far endpoints along the axis.

    The endpoints sit one apron past the banks and dry against every channel, the axis crosses only
    the crossed channel's centerline, and the deck keeps off the sibling bands, because the layout
    splits every bank around every deck and a stray overlap would punch a phantom gap.
    """
    ahead = _water_reach(vertex, axis, channel)
    behind = _water_reach(vertex, (-axis[0], -axis[1]), channel)
    if ahead is None or behind is None:
        return None
    near = add(vertex, axis, -(behind + _DECK_APRON))
    far = add(vertex, axis, ahead + _DECK_APRON)
    for endpoint in (near, far):
        if not _inside_frame(endpoint, 1.0):
            return None
        if any(
            not (
                endpoint[0] < extent[0] - other.width / 2.0 - _DRY_MARGIN - EPSILON
                or extent[2] + other.width / 2.0 + _DRY_MARGIN + EPSILON < endpoint[0]
                or endpoint[1] < extent[1] - other.width / 2.0 - _DRY_MARGIN - EPSILON
                or extent[3] + other.width / 2.0 + _DRY_MARGIN + EPSILON < endpoint[1]
            )
            and _water_gap(endpoint, other) <= _DRY_MARGIN
            for other, extent in zip(water.channels, water.extents, strict=True)
        ):
            return None
    deck_bounds = (
        min(near[0], far[0]),
        min(near[1], far[1]),
        max(near[0], far[0]),
        max(near[1], far[1]),
    )
    for other, segments, channel_bounds in zip(water.channels, water.segments, water.bounds, strict=True):
        crossed = any(
            segments_intersect((near, far), segment)
            for segment, segment_bounds in zip(segments, channel_bounds, strict=True)
            if not (
                deck_bounds[2] + EPSILON < segment_bounds[0]
                or segment_bounds[2] + EPSILON < deck_bounds[0]
                or deck_bounds[3] + EPSILON < segment_bounds[1]
                or segment_bounds[3] + EPSILON < deck_bounds[1]
            )
        )
        if crossed != (other is channel):
            return None
    bridge = Bridge(_midpoint(near, far), heading_to(near, far), rng.uniform(2.0, 3.0), distance(near, far))
    if bridge.distance_to(water.fork) <= water.cap_radius + 0.5:
        return None
    corners = rectangle_corners(bridge.position, bridge.span, bridge.width, bridge.heading)
    bridge_bounds = (
        min(corner[0] for corner in corners),
        min(corner[1] for corner in corners),
        max(corner[0] for corner in corners),
        max(corner[1] for corner in corners),
    )
    for other, segments, channel_bounds in zip(water.channels, water.segments, water.bounds, strict=True):
        if other is channel:
            continue
        margin = other.width / 2.0 + 1.0
        if any(
            distance_to_segment(corner, *segment) < margin
            for corner in corners
            for segment, segment_bounds in zip(segments, channel_bounds, strict=True)
            if not (
                bridge_bounds[2] + EPSILON < segment_bounds[0] - margin
                or segment_bounds[2] + margin + EPSILON < bridge_bounds[0]
                or bridge_bounds[3] + EPSILON < segment_bounds[1] - margin
                or segment_bounds[3] + margin + EPSILON < bridge_bounds[1]
            )
        ):
            return None
    return bridge, near, far


def _wet_off_deck(
    points: tuple[Point, ...],
    water: _Water,
    decks: list[Bridge],
) -> bool:
    """Whether a course touches water or the confluence cap anywhere a deck does not carry it.

    Clearance to water shrinks by at most a meter per meter walked, so a segment whose endpoint
    clearances already cover its length is skipped whole and the fine sampling only runs where the
    course actually approaches water.
    """
    for start, end in itertools.pairwise(points):
        length = distance(start, end)
        run = subtract(end, start)
        segment_bounds = (
            min(start[0], end[0]),
            min(start[1], end[1]),
            max(start[0], end[0]),
            max(start[1], end[1]),
        )
        steps = max(1, math.ceil(length / 0.5))
        cap_nearby = (
            distance(start, water.fork) + distance(end, water.fork) - length
        ) / 2.0 <= water.cap_radius + _DRY_MARGIN
        nearby = tuple(
            channel
            for channel, extent in zip(water.channels, water.extents, strict=True)
            if not (
                segment_bounds[2] + channel.width / 2.0 + _DRY_MARGIN + EPSILON < extent[0]
                or extent[2] + channel.width / 2.0 + _DRY_MARGIN + EPSILON < segment_bounds[0]
                or segment_bounds[3] + channel.width / 2.0 + _DRY_MARGIN + EPSILON < extent[1]
                or extent[3] + channel.width / 2.0 + _DRY_MARGIN + EPSILON < segment_bounds[1]
            )
            if (_water_gap(start, channel) + _water_gap(end, channel) - length) / 2.0 <= _DRY_MARGIN
        )
        if not cap_nearby and not nearby:
            continue
        samples = [add(start, run, step / steps) for step in range(steps + 1)]
        if cap_nearby and any(
            distance(sample, water.fork) <= water.cap_radius + _DRY_MARGIN for sample in samples
        ):
            return True
        for channel in nearby:
            for sample in samples:
                if _water_gap(sample, channel) <= _DRY_MARGIN and not any(
                    deck.contains(sample) for deck in decks
                ):
                    return True
    return False


def _pierces_building(points: tuple[Point, ...], buildings: tuple[Building, ...]) -> bool:
    """Whether a course crosses into any building rectangle."""
    segments = tuple(itertools.pairwise(points))
    segment_bounds = tuple(
        (min(start[0], end[0]), min(start[1], end[1]), max(start[0], end[0]), max(start[1], end[1]))
        for start, end in segments
    )
    for building in buildings:
        corners = rectangle_corners(building.center, building.width, building.depth, building.rotation)
        rectangle_bounds = (
            min(corner[0] for corner in corners),
            min(corner[1] for corner in corners),
            max(corner[0] for corner in corners),
            max(corner[1] for corner in corners),
        )
        edges = _edges(corners)
        for segment, bounds in zip(segments, segment_bounds, strict=True):
            if (
                bounds[2] + EPSILON < rectangle_bounds[0]
                or rectangle_bounds[2] + EPSILON < bounds[0]
                or bounds[3] + EPSILON < rectangle_bounds[1]
                or rectangle_bounds[3] + EPSILON < bounds[1]
            ):
                continue
            if any(segments_intersect(segment, edge) for edge in edges):
                return True
    return False


def _road_clears_buildings(
    points: tuple[Point, ...], half_width: float, buildings: tuple[Building, ...]
) -> bool:
    """Whether every building keeps its rectangle off the road surface."""
    margin = half_width + _ROUTE_GAP
    segments = tuple(itertools.pairwise(points))
    segment_bounds = tuple(
        (min(start[0], end[0]), min(start[1], end[1]), max(start[0], end[0]), max(start[1], end[1]))
        for start, end in segments
    )
    for building in buildings:
        rectangle = (building.center, building.width, building.depth, building.rotation)
        corners = rectangle_corners(*rectangle)
        rectangle_bounds = (
            min(corner[0] for corner in corners),
            min(corner[1] for corner in corners),
            max(corner[0] for corner in corners),
            max(corner[1] for corner in corners),
        )
        edges = _edges(corners)
        for segment, bounds in zip(segments, segment_bounds, strict=True):
            if (
                bounds[2] + EPSILON < rectangle_bounds[0] - margin
                or rectangle_bounds[2] + margin + EPSILON < bounds[0]
                or bounds[3] + EPSILON < rectangle_bounds[1] - margin
                or rectangle_bounds[3] + margin + EPSILON < bounds[1]
            ):
                continue
            if any(segments_intersect(segment, edge) for edge in edges):
                return False
            if any(distance_to_segment(corner, *segment) < margin for corner in corners):
                return False
            if any(distance_to_rectangle(endpoint, *rectangle) < margin for endpoint in segment):
                return False
    return True


def _straight_crossings(segment: _Segment, water: _Water) -> list[int]:
    """The channel indices whose centerline the straight segment crosses, with multiplicity."""
    segment_bounds = (
        min(segment[0][0], segment[1][0]),
        min(segment[0][1], segment[1][1]),
        max(segment[0][0], segment[1][0]),
        max(segment[0][1], segment[1][1]),
    )
    return [
        index
        for index, (channel_segments, channel_bounds) in enumerate(
            zip(water.segments, water.bounds, strict=True)
        )
        for piece, channel_bounds in zip(channel_segments, channel_bounds, strict=True)
        if not (
            segment_bounds[2] + EPSILON < channel_bounds[0]
            or channel_bounds[2] + EPSILON < segment_bounds[0]
            or segment_bounds[3] + EPSILON < channel_bounds[1]
            or channel_bounds[3] + EPSILON < segment_bounds[1]
        )
        if segments_intersect(segment, piece)
    ]


def _footpath_decks(
    rng: Random,
    water: _Water,
    decks: list[Bridge],
    channel: Polyline,
    junction: Point,
    target: Point,
) -> Iterator[tuple[Point, Point, Bridge, Point, Point]]:
    """Yield feasible deck spans in crossing-vertex order without drawing ahead of need."""
    order = sorted(
        range(1, len(channel.points) - 1),
        key=lambda index: distance(junction, channel.points[index]) + distance(channel.points[index], target),
    )
    for vertex_index in order[:_FOOTPATH_TRIES]:
        vertex = channel.points[vertex_index]
        if distance(vertex, water.fork) < _CROSSING_FORK_GAP:
            continue
        if any(existing.distance_to(vertex) < 4.0 for existing in decks):
            continue
        along = _unit(subtract(channel.points[vertex_index + 1], channel.points[vertex_index - 1]))
        normal = (-along[1], along[0])
        outward = subtract(target, junction)
        if normal[0] * outward[0] + normal[1] * outward[1] < 0.0:
            normal = (-normal[0], -normal[1])
        spanned = _deck(rng, channel, water, vertex, normal)
        if spanned is None:
            continue
        deck, near, far = spanned
        if any(
            existing.distance_to(deck.position) < 1.0 or deck.distance_to(existing.position) < 1.0
            for existing in decks
        ):
            continue
        yield vertex, normal, deck, near, far


def _footpath(
    rng: Random,
    terrain: _Terrain,
    water: _Water,
    road: Polyline,
    decks: list[Bridge],
    bridged: set[int],
    used: set[int],
    target: Point,
    avoid: tuple[tuple[Point, ...], ...],
    buildings: tuple[Building, ...],
) -> tuple[Polyline, int, Bridge | None, int | None] | None:
    """Walk a footpath from a road junction to its target, bridging one channel when it must.

    Junctions are road vertices clear of the decks, tried nearest first. A junction whose straight
    line to the target crosses no water is preferred; failing that, a single crossing on a channel
    whose footpath bridge is still free threads the path over a new deck. A failed round redraws
    its blend locally. Returns the path, its junction vertex, and the deck with its channel index
    or None twice, or None when every round fails.
    """
    candidates = [
        index
        for index in range(1, len(road.points) - 1)
        if index not in used
        and all(deck.distance_to(road.points[index]) >= _JUNCTION_DECK_GAP for deck in decks)
    ]
    candidates.sort(key=lambda index: distance(road.points[index], target))
    del candidates[12:]
    dry: list[int] = []
    wet: list[tuple[int, int]] = []
    for index in candidates:
        crossings = _straight_crossings((road.points[index], target), water)
        if not crossings:
            dry.append(index)
        elif len(crossings) == 1 and crossings[0] != 0 and crossings[0] not in bridged:
            wet.append((index, crossings[0]))
    for _ in range(_FOOTPATH_REDRAWS):
        weights = (rng.uniform(0.5, 0.8), rng.uniform(0.4, 1.0), rng.uniform(0.5, 0.8))
        width = rng.uniform(1.5, 2.5)
        swing = rng.uniform(-35.0, 35.0)
        for index in dry[:_FOOTPATH_TRIES]:
            junction = road.points[index]
            heading = _angled(_unit(subtract(target, junction)), swing)
            course = _walk(
                terrain,
                junction,
                target,
                weights,
                heading,
                avoid,
                repel_radius=8.0,
                limit=_leg_limit(junction, target),
            )
            if course is None:
                continue
            points = _resample(course)
            if _self_intersects(points) or _pierces_building(points, buildings):
                continue
            if _wet_off_deck(points, water, decks):
                continue
            return Polyline(points, width), index, None, None
        for index, channel_index in wet[:_FOOTPATH_TRIES]:
            junction = road.points[index]
            channel = water.channels[channel_index]
            for vertex, normal, deck, near, far in _footpath_decks(
                rng, water, decks, channel, junction, target
            ):
                approach_heading = _angled(_unit(subtract(near, junction)), swing)
                first = _walk(
                    terrain,
                    junction,
                    near,
                    weights,
                    approach_heading,
                    avoid,
                    repel_radius=8.0,
                    limit=_leg_limit(junction, near),
                )
                if first is None:
                    continue
                second = _walk(
                    terrain,
                    far,
                    target,
                    weights,
                    normal,
                    avoid,
                    repel_radius=8.0,
                    limit=_leg_limit(far, target),
                )
                if second is None:
                    continue
                points = _thread([first, second], [vertex])
                if points is None or _self_intersects(points) or _pierces_building(points, buildings):
                    continue
                if _wet_off_deck(points, water, [*decks, deck]):
                    continue
                return Polyline(points, width), index, deck, channel_index
    return None


def _shrine_stubs(
    rng: Random,
    road: Polyline,
    decks: list[Bridge],
    used: set[int],
    water: _Water,
    buildings: tuple[Building, ...],
) -> tuple[tuple[Point, ...], tuple[Polyline, ...]] | None:
    """Stand a shrine spot just off the road at each of the two sharpest free bends, with its stub."""
    ranked: list[tuple[float, int]] = []
    for index in range(1, len(road.points) - 1):
        point = road.points[index]
        if index in used or any(deck.distance_to(point) < _JUNCTION_DECK_GAP for deck in decks):
            continue
        before = _unit(subtract(point, road.points[index - 1]))
        after = _unit(subtract(road.points[index + 1], point))
        ranked.append((before[0] * after[0] + before[1] * after[1], index))
    ranked.sort()
    spots: list[Point] = []
    stubs: list[Polyline] = []
    bends: list[Point] = []
    for _turn, index in ranked:
        if len(spots) == 2:
            break
        vertex = road.points[index]
        if any(distance(vertex, bend) < _SHRINE_SEPARATION for bend in bends):
            continue
        along = _unit(subtract(road.points[index + 1], road.points[index - 1]))
        normal = (-along[1], along[0])
        side = _drawn_side(rng)
        for orientation in (side, -side):
            spot = add(vertex, normal, orientation * (road.width / 2.0 + rng.uniform(1.5, 2.5)))
            if not _inside_frame(spot, 3.0):
                continue
            if any(
                not (
                    spot[0] < extent[0] - channel.width / 2.0 - _SHRINE_CLEARANCE - EPSILON
                    or extent[2] + channel.width / 2.0 + _SHRINE_CLEARANCE + EPSILON < spot[0]
                    or spot[1] < extent[1] - channel.width / 2.0 - _SHRINE_CLEARANCE - EPSILON
                    or extent[3] + channel.width / 2.0 + _SHRINE_CLEARANCE + EPSILON < spot[1]
                )
                and _water_gap(spot, channel) < _SHRINE_CLEARANCE
                for channel, extent in zip(water.channels, water.extents, strict=True)
            ):
                continue
            if distance(spot, water.fork) < water.cap_radius + _SHRINE_CLEARANCE:
                continue
            if any(
                distance_to_rectangle(
                    spot, building.center, building.width, building.depth, building.rotation
                )
                < BUILDING_GAP
                for building in buildings
            ):
                continue
            if not _padded_room(spot, BUILDING_GAP) or any(
                deck.distance_to(spot) < BUILDING_GAP for deck in decks
            ):
                continue
            spots.append(spot)
            stubs.append(Polyline((vertex, spot), rng.uniform(1.5, 2.0)))
            bends.append(vertex)
            break
    if len(spots) < 2:
        return None
    return tuple(spots), tuple(stubs)


def _aimed_at_paths(buildings: tuple[Building, ...], paths: tuple[Polyline, ...]) -> tuple[Building, ...]:
    """Re-aim every doorway at the path nearest its building, the network's final doorway rule."""
    aimed: list[Building] = []
    for building in buildings:
        nearest = min(paths, key=lambda path: polyline_distance(building.center, path.points))
        aim, _span_squared = _nearest_on(building.center, nearest.points)
        size = (building.width, building.depth)
        doorway = _doorway(building.center, size, building.rotation, aim)
        aimed.append(replace(building, doorway=doorway))
    return tuple(aimed)


def _spawn_point(road: Polyline) -> Point | None:
    """The road centerline point one meter in from the west edge."""
    for (x1, y1), (x2, y2) in itertools.pairwise(road.points):
        if min(x1, x2) <= 1.0 <= max(x1, x2) and x1 != x2:
            return (1.0, y1 + (y2 - y1) * (1.0 - x1) / (x2 - x1))
    return None


def _spawn_clear(spawn: Point, buildings: tuple[Building, ...]) -> bool:
    """Whether the spawn clearance disk is free of every building and padded footprint."""
    if any(
        distance_to_rectangle(spawn, building.center, building.width, building.depth, building.rotation)
        < SPAWN_CLEARANCE
        for building in buildings
    ):
        return False
    if any(
        distance_to_rectangle(spawn, prop.position, *prop.footprint, prop.rotation) < SPAWN_CLEARANCE
        for prop in FIXTURE_VILLAGE.props
    ):
        return False
    return all(
        distance(spawn, item.position) - item.radius >= SPAWN_CLEARANCE for item in FIXTURE_VILLAGE.scenery
    )


def _threaded_road(
    rng: Random,
    terrain: _Terrain,
    water: _Water,
    sites: _Sites,
    avoid: tuple[tuple[Point, ...], ...],
) -> tuple[Polyline, list[Bridge]] | None:
    """One attempt at the road: entry to exit through a drawn crossing and deck per channel."""
    entry = (0.0, sites.corridor_y + rng.uniform(-5.0, 5.0))
    exit_point = (WORLD_SIZE, sites.corridor_y + rng.uniform(-5.0, 5.0))
    weights = (rng.uniform(0.55, 0.85), rng.uniform(0.25, 0.6), rng.uniform(0.5, 0.8))
    heading = _angled((1.0, 0.0), rng.uniform(-30.0, 30.0))

    road_decks: list[Bridge] = []
    legs: list[list[Point]] = []
    joints: list[Point] = []
    position = entry
    minimum_x = 0.0
    for channel in water.channels[1:]:
        spanned: tuple[Bridge, Point, Point] | None = None
        vertex: Point
        axis: Point
        for _ in range(8):
            drawn = _crossing(rng, channel, sites.corridor_y, water.fork, minimum_x)
            if drawn is None:
                return None
            vertex, axis = drawn
            spanned = _deck(rng, channel, water, vertex, axis)
            if spanned is not None:
                break
        if spanned is None:
            return None
        deck, near, far = spanned
        leg = _walk(
            terrain,
            position,
            near,
            weights,
            heading,
            avoid,
            repel_radius=6.0,
            limit=_leg_limit(position, near),
        )
        if leg is None:
            return None
        legs.append(leg)
        joints.append(vertex)
        road_decks.append(deck)
        position = far
        heading = axis
        minimum_x = vertex[0] + 8.0
    last = _walk(
        terrain,
        position,
        exit_point,
        weights,
        heading,
        avoid,
        repel_radius=6.0,
        limit=_leg_limit(position, exit_point),
    )
    if last is None:
        return None
    legs.append(last)
    course = _thread(legs, joints)
    if course is None:
        return None
    road = Polyline(course, rng.uniform(4.0, 5.0))
    if _self_intersects(road.points):
        return None
    if _wet_off_deck(road.points, water, road_decks):
        return None
    if not _road_clears_buildings(road.points, road.width / 2.0, sites.buildings):
        return None
    return road, road_decks


def _network_layer(rng: Random, terrain: _Terrain, water: _Water, sites: _Sites) -> _Network | None:
    """Thread the road across the channels, hang the footpaths off it, and fix the spawn.

    The road uses ten attempts, each drawing entry and exit offsets, weights, heading, crossings,
    deck widths, and road width. A successful road then anchors two network rounds. Each round
    redraws every footpath, its possible deck widths, the shrine, and checks the spawn. Doorway
    re-aiming draws nothing and runs only after a complete round succeeds.
    """
    avoid = (*_coarse(water.channels), *_rings(sites.buildings))
    threaded = None
    for _ in range(_ROAD_TRIES):
        threaded = _threaded_road(rng, terrain, water, sites, avoid)
        if threaded is not None:
            break
    if threaded is None:
        return None
    road, road_decks = threaded

    for _ in range(_NETWORK_TRIES):
        decks = list(road_decks)
        bridged: set[int] = set()
        used: set[int] = set()
        footpaths: list[Polyline] = []
        for target in (sites.plaza, *sites.clusters):
            pathed = _footpath(
                rng,
                terrain,
                water,
                road,
                decks,
                bridged,
                used,
                target,
                avoid,
                sites.buildings,
            )
            if pathed is None:
                break
            path, junction, deck, channel_index = pathed
            footpaths.append(path)
            used.add(junction)
            if deck is not None and channel_index is not None:
                decks.append(deck)
                bridged.add(channel_index)
        else:
            shrined = _shrine_stubs(rng, road, decks, used, water, sites.buildings)
            if shrined is None:
                continue
            spots, stubs = shrined
            footpaths.extend(stubs)

            spawn = _spawn_point(road)
            if spawn is None or not _spawn_clear(spawn, sites.buildings):
                continue
            buildings = _aimed_at_paths(sites.buildings, (road, *footpaths))
            return _Network(road, tuple(footpaths), tuple(decks), spawn, spots, buildings)
    return None


def build_village(seed: int) -> Layout:
    """Build the seeded village: generated terrain, sites, and road network over fixture props.

    Only the accessories layer still comes from the fixture: its props and scenery pad the layout
    until the generator replaces them.
    """
    rng = Random(f"{seed}:village")
    for _ in range(MAX_REDRAWS):
        land = _terrain_layer(rng)
        if land is None:
            continue
        terrain, channels, fields, reed_banks = land
        water = _Water.of(channels)
        sites = _sites_layer(rng, terrain, water)
        if sites is None:
            continue
        network = _network_layer(rng, terrain, water, sites)
        if network is None:
            continue
        try:
            return Layout(
                channels=water.channels,
                road=network.road,
                footpaths=network.footpaths,
                bridges=network.bridges,
                buildings=network.buildings,
                fields=fields,
                reed_banks=reed_banks,
                props=FIXTURE_VILLAGE.props,
                scenery=FIXTURE_VILLAGE.scenery,
                spawn=network.spawn,
            )
        except ValueError:
            continue
    raise RuntimeError(f"could not build a village for seed {seed} within {MAX_REDRAWS} redraws")
