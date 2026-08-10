"""Seeded village generation: the terrain layer over fixture placements until later layers land."""

from __future__ import annotations

import itertools
import math
from random import Random

from .fixture import FIXTURE_VILLAGE
from .geometry import Point, add, distance, polyline_distance, segments_intersect, subtract
from .layout import WORLD_SIZE, Layout, Polyline

MAX_REDRAWS = 64
MAX_POLYLINE_POINTS = 35

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
        self._lattices: list[tuple[float, float, dict[tuple[int, int], float]]] = []
        for spacing, amplitude in zip(_OCTAVE_SPACINGS, amplitudes, strict=True):
            nodes = math.ceil(WORLD_SIZE / spacing) + 3
            lattice = {(column, row): rng.random() for column in range(-2, nodes) for row in range(-2, nodes)}
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
            low = lattice[(column, row)] + (lattice[(column + 1, row)] - lattice[(column, row)]) * fu
            high = (
                lattice[(column, row + 1)]
                + (lattice[(column + 1, row + 1)] - lattice[(column, row + 1)]) * fu
            )
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


def _away_from(point: Point, polyline: tuple[Point, ...]) -> tuple[float, Point]:
    """The distance to a polyline and the unit direction away from its nearest point."""
    best_distance = math.inf
    best = polyline[0]
    for start, end in itertools.pairwise(polyline):
        run = subtract(end, start)
        length_squared = run[0] * run[0] + run[1] * run[1]
        if length_squared == 0.0:
            nearest = start
        else:
            offset = subtract(point, start)
            t = max(0.0, min(1.0, (offset[0] * run[0] + offset[1] * run[1]) / length_squared))
            nearest = add(start, run, t)
        span = distance(point, nearest)
        if span < best_distance:
            best_distance = span
            best = nearest
    return best_distance, _unit(subtract(point, best))


def _walk(
    terrain: _Terrain,
    start: Point,
    target: Point,
    weights: tuple[float, float, float],
    start_heading: Point | None = None,
    avoid: tuple[Polyline, ...] = (),
) -> list[Point] | None:
    """Trace a course from start to target as a blend of momentum, downhill flow, and target pull.

    Water already on the map pushes the course away, so siblings spread instead of hugging.
    The pull ramps up as the target nears so every course arrives, and the final point is the
    target verbatim. Returns None when the course leaves the frame or fails to arrive.
    """
    momentum_weight, downhill_weight, pull_weight = weights
    points = [start]
    heading = _unit(subtract(target, start)) if start_heading is None else start_heading
    for _ in range(_MAX_WALK_STEPS):
        position = points[-1]
        remaining = distance(position, target)
        if remaining <= _WALK_STEP * 1.5:
            points.append(target)
            return points
        toward = _unit(subtract(target, position))
        slope = _unit(terrain.downhill(position))
        along = slope[0] * toward[0] + slope[1] * toward[1]
        lateral = (slope[0] - along * toward[0], slope[1] - along * toward[1])
        repel = (0.0, 0.0)
        for line in avoid:
            span, away = _away_from(position, line.points)
            if span < _REPEL_RADIUS:
                push = _REPEL_WEIGHT * (1.0 - span / _REPEL_RADIUS)
                repel = (repel[0] + away[0] * push, repel[1] + away[1] * push)
        arrival = max(0.0, 1.0 - remaining / 20.0)
        blended = _unit(
            (
                momentum_weight * heading[0]
                + downhill_weight * lateral[0]
                + repel[0]
                + (pull_weight + arrival) * toward[0],
                momentum_weight * heading[1]
                + downhill_weight * lateral[1]
                + repel[1]
                + (pull_weight + arrival) * toward[1],
            )
        )
        heading = toward if blended == (0.0, 0.0) else blended
        candidate = add(position, heading, _WALK_STEP)
        if not (0.0 <= candidate[0] <= WORLD_SIZE and 0.0 <= candidate[1] <= WORLD_SIZE):
            return None
        points.append(candidate)
    return None


def _resample(points: list[Point]) -> tuple[Point, ...]:
    """Even arc-length resampling under the overlay point cap, keeping both endpoints exact."""
    lengths = [0.0]
    for previous, current in itertools.pairwise(points):
        lengths.append(lengths[-1] + distance(previous, current))
    total = lengths[-1]
    count = min(MAX_POLYLINE_POINTS, max(2, math.ceil(total / _SAMPLE_SPACING) + 1))
    if len(points) <= count:
        return tuple(points)
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


def _segments(points: tuple[Point, ...], closed: bool) -> list[tuple[Point, Point]]:
    segments = list(itertools.pairwise(points))
    if closed:
        segments.append((points[-1], points[0]))
    return segments


def _self_intersects(points: tuple[Point, ...], closed: bool = False) -> bool:
    """Whether a polyline or polygon crosses itself, ignoring segments that share an endpoint."""
    segments = _segments(points, closed)
    for index, first in enumerate(segments):
        for second in segments[index + 1 :]:
            if first[0] in second or first[1] in second:
                continue
            if segments_intersect(first, second):
                return True
    return False


def _lines_cross(first: tuple[Point, ...], second: tuple[Point, ...]) -> bool:
    """Whether two polylines cross anywhere away from a shared endpoint like the fork."""
    for a in itertools.pairwise(first):
        for b in itertools.pairwise(second):
            if a[0] in b or a[1] in b:
                continue
            if segments_intersect(a, b):
                return True
    return False


def _angled(base: Point, degrees: float) -> Point:
    """The base direction rotated by the drawn angle."""
    radians = math.radians(degrees)
    cosine, sine = math.cos(radians), math.sin(radians)
    return (base[0] * cosine - base[1] * sine, base[0] * sine + base[1] * cosine)


def _crowds(channel: Polyline, prior: Polyline) -> bool:
    """Whether a channel hugs a sibling so closely their waters read as one.

    Points near the shared fork are exempt, since touching there is the point of a fork.
    """
    clearance = (channel.width + prior.width) / 2.0 + _SIBLING_CLEARANCE
    origin = channel.points[0]
    return any(
        polyline_distance(point, prior.points) < clearance
        for point in channel.points
        if distance(point, origin) > 15.0
    )


def _waterways(terrain: _Terrain, rng: Random) -> tuple[Polyline, ...] | None:
    """Draw the water topology and walk the trunk and channels through the terrain.

    The mouth targets are drawn constructively inside their feasibility bands, so the only
    redraw triggers are a wandering walk, a crossing, and a crowded sibling.
    """
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
    trunk_heading = _angled((0.0, -1.0), rng.uniform(-45.0, 45.0))
    trunk_course = _walk(terrain, entry, fork, weights, trunk_heading)
    if trunk_course is None:
        return None
    trunk = Polyline(_resample(trunk_course), rng.uniform(4.0, 6.0))
    if _self_intersects(trunk.points):
        return None
    channels: list[Polyline] = [trunk]
    for mouth in (west_mouth, center_mouth, east_mouth):
        approach = (mouth, 6.0)
        channel_heading = _angled(_unit(subtract(approach, fork)), rng.uniform(-20.0, 20.0))
        course = _walk(terrain, fork, approach, weights, channel_heading, avoid=tuple(channels))
        if course is None:
            return None
        course.append((mouth, 0.0))
        channel = Polyline(_resample(course), rng.uniform(2.5, 4.0))
        if _self_intersects(channel.points):
            return None
        if any(_lines_cross(prior.points, channel.points) for prior in channels):
            return None
        if any(_crowds(channel, prior) for prior in channels):
            return None
        channels.append(channel)
    return tuple(channels)


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
    for channel in channels[1:]:
        window = channel.points[max(0, len(channel.points) - 5) : -1]
        side = _moister_side(terrain, window, channel.width / 2.0 + 2.0)
        flat = _strip(window, side, channel.width / 2.0 - 0.2, rng.uniform(2.0, 4.0), terrain.moisture)
        if flat is not None:
            flats.append(flat)
    for channel in channels:
        placed = 0
        for start in range(2, len(channel.points) - 6, 4):
            if placed >= 2:
                break
            window = channel.points[start : start + 4]
            if terrain.moisture(window[1]) <= 0.62:
                continue
            side = _moister_side(terrain, window, channel.width / 2.0 + 2.0)
            flat = _strip(window, side, channel.width / 2.0 - 0.2, rng.uniform(2.0, 4.0), terrain.moisture)
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
        for start in range(2, len(channel.points) - 6, 5):
            window = channel.points[start : start + 4]
            middle = window[1]
            if middle[1] > 35.0 or terrain.elevation(middle) > 0.5:
                continue
            side = _moister_side(terrain, window, channel.width / 2.0 + 4.0)
            terrace = _strip(window, side, channel.width / 2.0 + 1.5, rng.uniform(5.0, 8.0), terrain.moisture)
            if terrace is not None:
                terraces.append(terrace)
                break
    return tuple(terraces)


def _terrain_layer(
    rng: Random,
) -> tuple[tuple[Polyline, ...], tuple[tuple[Point, ...], ...], tuple[tuple[Point, ...], ...]] | None:
    """The terrain layer: fields, waterways, reed flats, and terraces, or None to redraw."""
    terrain = _Terrain(rng)
    channels = _waterways(terrain, rng)
    if channels is None:
        return None
    return channels, _terraces(terrain, rng, channels), _reed_banks(terrain, rng, channels)


def build_village(seed: int) -> Layout:
    """Build the seeded village: generated terrain padded with fixture placements.

    The sites, road network, and accessories layers still come from the fixture. Bridges stay
    empty because the layout splits water banks around every deck, so a fixture deck overlapping
    generated water would punch a phantom gap in a bank.
    """
    rng = Random(f"{seed}:village")
    for _ in range(MAX_REDRAWS):
        parts = _terrain_layer(rng)
        if parts is None:
            continue
        channels, fields, reed_banks = parts
        try:
            return Layout(
                channels=channels,
                road=FIXTURE_VILLAGE.road,
                footpaths=FIXTURE_VILLAGE.footpaths,
                bridges=(),
                buildings=FIXTURE_VILLAGE.buildings,
                fields=fields,
                reed_banks=reed_banks,
                props=FIXTURE_VILLAGE.props,
                scenery=FIXTURE_VILLAGE.scenery,
                spawn=FIXTURE_VILLAGE.spawn,
            )
        except ValueError:
            continue
    raise RuntimeError(f"could not build a village for seed {seed} within {MAX_REDRAWS} redraws")
