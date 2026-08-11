"""The seeded terrain fields and the course walker the generation layers share."""

from __future__ import annotations

import itertools
import math
from random import Random

from ..geometry import EPSILON, Point, add, distance, segments_intersect, subtract
from ..layout import WORLD_SIZE, Polyline
from .config import GENERATION_CONFIG, Range

type _Polygons = tuple[tuple[Point, ...], ...]
type _Segment = tuple[Point, Point]
type _Bounds = tuple[float, float, float, float]


MAX_POLYLINE_POINTS = 35


_OCTAVE_SPACINGS = GENERATION_CONFIG.walker.octave_spacings
_WALK_STEP = GENERATION_CONFIG.walker.step
_MAX_WALK_STEPS = GENERATION_CONFIG.walker.max_steps
_SAMPLE_SPACING = GENERATION_CONFIG.walker.sample_spacing


_REPEL_RADIUS = GENERATION_CONFIG.walker.repel_radius
_REPEL_WEIGHT = GENERATION_CONFIG.walker.repel_weight
_EDGE_RADIUS = GENERATION_CONFIG.walker.edge_radius
_EDGE_WEIGHT = GENERATION_CONFIG.walker.edge_weight
_EDGE_FADE = GENERATION_CONFIG.walker.edge_fade


def _draw_weights(rng: Random, ranges: tuple[Range, Range, Range]) -> tuple[float, float, float]:
    """Draw one walker blend weight from each configured range in order."""
    first, second, third = ranges
    return (
        rng.uniform(first.low, first.high),
        rng.uniform(second.low, second.high),
        rng.uniform(third.low, third.high),
    )


_ABORT_SLACK = GENERATION_CONFIG.walker.abort_slack


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
        roughness = rng.uniform(
            GENERATION_CONFIG.walker.roughness.low, GENERATION_CONFIG.walker.roughness.high
        )
        self._relief = _Field(rng, roughness)
        self.moisture = _Field(rng, roughness)
        self._slope = rng.uniform(GENERATION_CONFIG.walker.slope.low, GENERATION_CONFIG.walker.slope.high)

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
        if remaining <= _WALK_STEP * GENERATION_CONFIG.walker.finish_step_factor:
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
        arrival = max(0.0, 1.0 - remaining / GENERATION_CONFIG.walker.arrival_pull_radius)
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
    return min(
        _MAX_WALK_STEPS,
        math.ceil(distance(start, end) / _WALK_STEP) * GENERATION_CONFIG.walker.leg_distance_multiplier
        + GENERATION_CONFIG.walker.leg_base_steps,
    )


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


def _inside_frame(point: Point, margin: float) -> bool:
    return all(margin <= value <= WORLD_SIZE - margin for value in point)


def _water_gap(point: Point, channel: Polyline) -> float:
    """The distance from a point to a channel's water edge."""
    nearest, _span_squared = _nearest_on(point, channel.points)
    return math.hypot(point[0] - nearest[0], point[1] - nearest[1]) - channel.width / 2.0


def _midpoint(first: Point, second: Point) -> Point:
    return ((first[0] + second[0]) / 2.0, (first[1] + second[1]) / 2.0)


def _edges(corners: tuple[Point, ...]) -> tuple[_Segment, ...]:
    return tuple(zip(corners, (*corners[1:], corners[0]), strict=True))


def _polar(rng: Random, low: float, high: float) -> Point:
    """A drawn offset vector, radius first and then angle."""
    radius = rng.uniform(low, high)
    angle = math.radians(rng.uniform(0.0, 360.0))
    return (radius * math.cos(angle), radius * math.sin(angle))


def _drawn_side(rng: Random) -> float:
    """One side of the corridor, north or south."""
    return 1.0 if rng.random() < 0.5 else -1.0
