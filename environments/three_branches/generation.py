"""Seeded village generation: the terrain and site layers over fixture placements."""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass
from random import Random

from .fixture import FIXTURE_VILLAGE
from .geometry import (
    Point,
    add,
    distance,
    distance_to_rectangle,
    distance_to_segment,
    polyline_distance,
    rectangle_corners,
    segments_intersect,
    subtract,
)
from .layout import WORLD_SIZE, Building, Doorway, Layout, Polyline

type _Polygons = tuple[tuple[Point, ...], ...]
type _Segment = tuple[Point, Point]

MAX_REDRAWS = 64
MAX_POLYLINE_POINTS = 35
BUILDING_GAP = 2.0
WATER_CLEARANCE = 2.0
BOUNDARY_MARGIN = 2.0
HOME_CLUSTER_RADIUS = 7.0
HOME_CLUSTER_SEPARATION = 32.0

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
_PLACEMENT_BUDGET = 300
_ANCHOR_BUDGET = 150
_HOME_SIZE = (6.0, 5.0)
_INN_SIZE = (10.0, 8.0)
_SHED_SIZE = (6.0, 6.0)
_SPAWN_CLEARANCE = 2.0
_PLAZA_CLEARANCE = 5.0
_WEDGE_HALF_OPENING = 4.0
_CLUSTER_RADIUS_LOW = 6.5
_CLUSTER_RING_DEPTH = 2.0
_CLUSTER_WATER_MIN = 12.0
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
    trunk = Polyline(_resample(trunk_course), rng.uniform(5.0, 7.0))
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

    channels: tuple[Polyline, ...]
    fork: Point
    cap_radius: float
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
    return polyline_distance(point, channel.points) - channel.width / 2.0


def _inside_frame(point: Point, margin: float) -> bool:
    return all(margin <= value <= WORLD_SIZE - margin for value in point)


def _well_plaza(rng: Random, channels: tuple[Polyline, ...]) -> Point | None:
    """Slide out from the fork along a crook bisector until the wedge between its channels opens.

    A crook is the wedge between an adjacent channel pair, west with center or center with east,
    and which one is tried first is drawn. Returns None when neither crook ever opens.
    """
    fork = channels[0].points[-1]
    cap_radius = max(channel.width for channel in channels) / 2.0
    crooks = ((channels[1], channels[2]), (channels[2], channels[3]))
    for first, second in crooks if rng.random() < 0.5 else crooks[::-1]:
        left = _unit(subtract(first.points[2], fork))
        right = _unit(subtract(second.points[2], fork))
        bisector = _unit((left[0] + right[0], left[1] + right[1]))
        if bisector == (0.0, 0.0):
            continue
        reach = cap_radius + 3.0
        while reach <= _WEDGE_SLIDE_LIMIT:
            candidate = add(fork, bisector, reach)
            opening = min(_water_gap(candidate, first), _water_gap(candidate, second))
            if opening >= _WEDGE_HALF_OPENING and _inside_frame(candidate, BOUNDARY_MARGIN):
                return candidate
            reach += 1.0
    return None


def _padded_gap(point: Point) -> float:
    """The room a point has around the fixture objects still padding the layout.

    This measure leaves with the padding, like the placement rule that keeps buildings off those
    objects. The corridor runs straight through the fixture's market and road dressing, so an
    anchor that ignored them would spend its whole placement budget inside a prop field.
    """
    return min(
        itertools.chain(
            (
                distance(point, prop.position) - math.hypot(*prop.footprint) / 2.0
                for prop in FIXTURE_VILLAGE.props
            ),
            (distance(point, item.position) - item.radius for item in FIXTURE_VILLAGE.scenery),
            (distance(point, FIXTURE_VILLAGE.spawn),),
        )
    )


def _corridor_anchor(
    rng: Random,
    channels: tuple[Polyline, ...],
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
            all(_water_gap(candidate, channel) >= room for channel in channels)
            and _inside_frame(candidate, BOUNDARY_MARGIN + half_diagonal)
            and _padded_gap(candidate) >= half_diagonal
        ):
            return candidate
    return None


def _home_clusters(
    rng: Random, terrain: _Terrain, channels: tuple[Polyline, ...], plaza: Point
) -> tuple[tuple[Point, ...], tuple[float, ...]] | None:
    """Seed two or three home clusters on the best-scoring bank regions.

    A fixed 6 m grid is scored on bank proximity, flatness, and dryness, and the coarse channel
    polylines keep the water term cheap. A grid point only enters the running when its homes have a
    ring to stand on, clear of the water, the plaza clearing, and the padded fixture objects, so a
    cluster does not seed where its homes cannot follow. Scoring takes nothing from the stream, so
    only the cluster count and the per-cluster radii move it. Returns None when too few separated
    seeds are found.
    """
    coarse = tuple(((*channel.points[::3], channel.points[-1]), channel.width / 2.0) for channel in channels)
    ring = HOME_CLUSTER_RADIUS + BUILDING_GAP
    scored: list[tuple[float, Point]] = []
    for x in range(12, 89, 6):
        for y in range(12, 89, 6):
            point = (float(x), float(y))
            water = min(polyline_distance(point, points) - half for points, half in coarse)
            if water < _CLUSTER_WATER_MIN:
                continue
            if distance(point, plaza) < HOME_CLUSTER_RADIUS + _PLAZA_CLEARANCE or _padded_gap(point) < ring:
                continue
            bank = 1.0 - min(abs(water - 10.0) / 12.0, 1.0)
            flat = 1.0 - min(math.hypot(*terrain.downhill(point)) * 25.0, 1.0)
            dry = 1.0 - terrain.moisture(point)
            scored.append((1.2 * bank + 0.8 * flat + 0.6 * dry, point))
    scored.sort(key=lambda entry: (-entry[0], entry[1]))
    count = rng.choice((2, 3))
    centers: list[Point] = []
    for _score, point in scored:
        if len(centers) == count:
            break
        if all(distance(point, taken) >= HOME_CLUSTER_SEPARATION for taken in centers):
            centers.append(point)
    if len(centers) < count:
        return None
    return tuple(centers), tuple(rng.uniform(_CLUSTER_RADIUS_LOW, HOME_CLUSTER_RADIUS) for _ in centers)


def _clear_of_water(
    center: Point,
    size: tuple[float, float],
    rotation: float,
    corners: tuple[Point, ...],
    edges: tuple[_Segment, ...],
    channels: tuple[Polyline, ...],
) -> bool:
    """Whether a rectangle keeps the bank margin from every channel.

    A channel whose centerline is a rectangle diagonal away needs no further work, so the exact
    crossing and distance tests only run on the water that is actually nearby.
    """
    half_diagonal = math.hypot(size[0], size[1]) / 2.0
    for channel in channels:
        margin = channel.width / 2.0 + WATER_CLEARANCE
        if _water_gap(center, channel) >= half_diagonal + WATER_CLEARANCE:
            continue
        water = tuple(itertools.pairwise(channel.points))
        if any(segments_intersect(segment, edge) for segment in water for edge in edges):
            return False
        if any(
            distance_to_segment(corner, start, end) < margin for corner in corners for start, end in water
        ):
            return False
        if any(distance_to_rectangle(point, center, *size, rotation) < margin for point in channel.points):
            return False
    return True


def _clear_of_padding(center: Point, size: tuple[float, float], rotation: float) -> bool:
    """Whether a rectangle keeps clear of the fixture objects still padding the layout.

    This rule leaves with the padding: the accessories layer replaces these objects, and until then
    the padded suites derive their standing points from them.
    """
    if any(
        distance_to_rectangle(prop.position, center, *size, rotation)
        < math.hypot(*prop.footprint) / 2.0 + BUILDING_GAP
        for prop in FIXTURE_VILLAGE.props
    ):
        return False
    if any(
        distance_to_rectangle(item.position, center, *size, rotation) < item.radius + BUILDING_GAP
        for item in FIXTURE_VILLAGE.scenery
    ):
        return False
    return distance_to_rectangle(FIXTURE_VILLAGE.spawn, center, *size, rotation) >= _SPAWN_CLEARANCE


def _clears(
    center: Point,
    size: tuple[float, float],
    rotation: float,
    clearances: _Clearances,
    placed: list[Building],
) -> bool:
    """Whether a candidate rectangle clears the frame, the water, the clearings, and every solid."""
    width, depth = size
    corners = rectangle_corners(center, width, depth, rotation)
    if not all(_inside_frame(corner, BOUNDARY_MARGIN) for corner in corners):
        return False
    cap = distance_to_rectangle(clearances.fork, center, width, depth, rotation)
    if cap < clearances.cap_radius + WATER_CLEARANCE:
        return False
    if distance_to_rectangle(clearances.plaza, center, width, depth, rotation) < _PLAZA_CLEARANCE:
        return False
    edges = _edges(corners)
    if not _clear_of_water(center, size, rotation, corners, edges, clearances.channels):
        return False
    for other in placed:
        neighbor = (other.center, other.width, other.depth, other.rotation)
        other_corners = rectangle_corners(*neighbor)
        other_edges = _edges(other_corners)
        if any(segments_intersect(edge, other_edge) for edge in edges for other_edge in other_edges):
            return False
        if any(distance_to_rectangle(corner, *neighbor) < BUILDING_GAP for corner in corners):
            return False
        if any(
            distance_to_rectangle(corner, center, width, depth, rotation) < BUILDING_GAP
            for corner in other_corners
        ):
            return False
    return _clear_of_padding(center, size, rotation)


def _draw_placement(
    rng: Random,
    size: tuple[float, float],
    anchor: Point,
    reach: tuple[float, float],
    spin: tuple[float, float],
    clearances: _Clearances,
    placed: list[Building],
) -> tuple[Point, float] | None:
    """Draw centers and rotations around an anchor until one clears, or None when the budget runs out."""
    for _ in range(_PLACEMENT_BUDGET):
        center = add(anchor, _polar(rng, *reach))
        rotation = rng.uniform(*spin) % 360.0
        if _clears(center, size, rotation, clearances, placed):
            return center, rotation
    return None


def _doorway(center: Point, size: tuple[float, float], rotation: float, aim: Point) -> Doorway:
    """Open the wall whose middle faces the aim point, provisionally until the road network lands."""
    edges = _edges(rectangle_corners(center, size[0], size[1], rotation))
    start, end = min(edges, key=lambda edge: distance(_midpoint(*edge), aim))
    return Doorway(_midpoint(start, end))


def _sites_layer(rng: Random, terrain: _Terrain, channels: tuple[Polyline, ...]) -> _Sites | None:
    """Anchor the settlement on the terrain and stand its buildings, or None to redraw.

    The stream is consumed in a fixed order: the well plaza, the corridor, the west stretch's shed
    anchor and bell spot, the market center with its five stall spots and the board spot, the inn
    anchor, the home clusters (the count, then one radius each), and then the buildings, inn and
    shed first so the corridor keeps its landmarks, then home_0 through home_4 around their
    clusters. Homes take their clusters round robin.
    """
    plaza = _well_plaza(rng, channels)
    if plaza is None:
        return None
    fork = channels[0].points[-1]
    corridor_y = fork[1] - rng.uniform(14.0, 24.0)

    shed_anchor = _corridor_anchor(rng, channels, corridor_y, (10.0, 30.0), _SHED_SIZE)
    if shed_anchor is None:
        return None
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

    inn_anchor = _corridor_anchor(rng, channels, corridor_y, (70.0, 90.0), _INN_SIZE)
    if inn_anchor is None:
        return None
    seeded = _home_clusters(rng, terrain, channels, plaza)
    if seeded is None:
        return None
    clusters, radii = seeded

    clearances = _Clearances(channels, fork, max(channel.width for channel in channels) / 2.0, plaza)
    placed: list[Building] = []
    corridor_buildings: list[Building] = []
    for identifier, size, anchor in (("inn", _INN_SIZE, inn_anchor), ("shed", _SHED_SIZE, shed_anchor)):
        placement = _draw_placement(rng, size, anchor, (0.0, 4.0), (-15.0, 15.0), clearances, placed)
        if placement is None:
            return None
        center, rotation = placement
        aim = (center[0], corridor_y)
        building = Building(
            identifier, identifier, center, *size, rotation, _doorway(center, size, rotation, aim)
        )
        placed.append(building)
        corridor_buildings.append(building)

    homes: list[Building] = []
    for index in range(5):
        cluster = clusters[index % len(clusters)]
        radius = radii[index % len(clusters)]
        spread = (radius - _CLUSTER_RING_DEPTH, radius)
        placement = _draw_placement(rng, _HOME_SIZE, cluster, spread, (0.0, 360.0), clearances, placed)
        if placement is None:
            return None
        center, rotation = placement
        doorway = _doorway(center, _HOME_SIZE, rotation, cluster)
        home = Building(f"home_{index}", "home", center, *_HOME_SIZE, rotation, doorway)
        placed.append(home)
        homes.append(home)

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


def build_village(seed: int) -> Layout:
    """Build the seeded village: generated terrain and sites padded with fixture placements.

    The road network and accessories layers still come from the fixture. Bridges stay empty because
    the layout splits water banks around every deck, so a fixture deck overlapping generated water
    would punch a phantom gap in a bank.
    """
    rng = Random(f"{seed}:village")
    for _ in range(MAX_REDRAWS):
        land = _terrain_layer(rng)
        if land is None:
            continue
        terrain, channels, fields, reed_banks = land
        sites = _sites_layer(rng, terrain, channels)
        if sites is None:
            continue
        try:
            return Layout(
                channels=channels,
                road=FIXTURE_VILLAGE.road,
                footpaths=FIXTURE_VILLAGE.footpaths,
                bridges=(),
                buildings=sites.buildings,
                fields=fields,
                reed_banks=reed_banks,
                props=FIXTURE_VILLAGE.props,
                scenery=FIXTURE_VILLAGE.scenery,
                spawn=FIXTURE_VILLAGE.spawn,
            )
        except ValueError:
            continue
    raise RuntimeError(f"could not build a village for seed {seed} within {MAX_REDRAWS} redraws")
