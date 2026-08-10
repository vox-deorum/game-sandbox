"""Static village layout types and geometry derived from their observation shape."""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import chain

from .geometry import (
    Point,
    Segment,
    add,
    distance,
    distance_to_rectangle,
    distance_to_segment,
    heading_to,
    heading_vector,
    point_in_polygon,
    point_in_rectangle,
    polyline_distance,
    rectangle_corners,
    segments_intersect,
)
from .prop_types import PROP_TYPES
from .rules import GROUND_BY_TOKEN, PROFILE

WORLD_SIZE = 100.0
DOORWAY_WIDTH = 1.2
SEGMENT_RADIUS = 0.05
BUILDING_ROSTER = (
    ("home_0", "home"),
    ("home_1", "home"),
    ("home_2", "home"),
    ("home_3", "home"),
    ("home_4", "home"),
    ("inn", "inn"),
    ("shed", "shed"),
)


@dataclass(frozen=True)
class Polyline:
    points: tuple[Point, ...]
    width: float

    def __post_init__(self) -> None:
        if len(self.points) < 2 or self.width <= 0:
            raise ValueError("a polyline needs at least two points and a positive width")


@dataclass(frozen=True)
class Bridge:
    position: Point
    heading: float
    width: float
    span: float

    def __post_init__(self) -> None:
        if self.width <= 0 or self.span <= 0:
            raise ValueError("a bridge needs positive width and span")

    def contains(self, point: Point) -> bool:
        return point_in_rectangle(point, self.position, self.span, self.width, self.heading)

    def distance_to(self, point: Point) -> float:
        """Return the exact distance from a point to this rotated deck."""
        return distance_to_rectangle(point, self.position, self.span, self.width, self.heading)


@dataclass(frozen=True)
class Doorway:
    position: Point
    width: float = DOORWAY_WIDTH

    def __post_init__(self) -> None:
        if self.width <= 0:
            raise ValueError("a doorway needs a positive width")


@dataclass(frozen=True)
class Building:
    id: str
    type: str
    center: Point
    width: float
    depth: float
    rotation: float
    doorway: Doorway

    def __post_init__(self) -> None:
        if self.width <= 0 or self.depth <= 0:
            raise ValueError("a building needs positive dimensions")
        corners = rectangle_corners(self.center, self.width, self.depth, self.rotation)
        edges = tuple(zip(corners, (*corners[1:], corners[0]), strict=True))
        edge = min(edges, key=lambda candidate: distance_to_segment(self.doorway.position, *candidate))
        if distance_to_segment(self.doorway.position, *edge) > 1e-8:
            raise ValueError("a building doorway must lie on its perimeter")
        if distance(*edge) + 1e-8 < self.doorway.width:
            raise ValueError("a building doorway does not fit on its wall")


@dataclass(frozen=True)
class Prop:
    id: str
    type: str
    position: Point
    footprint: tuple[float, float]
    rotation: float = 0.0

    def __post_init__(self) -> None:
        if self.footprint[0] <= 0 or self.footprint[1] <= 0:
            raise ValueError("a prop needs a positive footprint")


@dataclass(frozen=True)
class Scenery:
    type: str
    position: Point
    radius: float


@dataclass(frozen=True)
class StartPose:
    position: Point
    heading: float
    home: str


def _offset_points(line: Polyline, side: float) -> tuple[Point, ...]:
    """Make a simple bank polyline offset from each centerline vertex."""
    offset: list[Point] = []
    for index, point in enumerate(line.points):
        previous = line.points[max(0, index - 1)]
        following = line.points[min(len(line.points) - 1, index + 1)]
        heading = heading_to(previous, following)
        forward = heading_vector(heading)
        normal = -forward[1], forward[0]
        offset.append(add(point, normal, side))
    return tuple(offset)


def _segment_outside_rect(segment: Segment, bridge: Bridge) -> tuple[Segment, ...]:
    """Split a segment around a bridge deck using a local-axis slab clip."""
    start, end = segment
    forward = heading_vector(bridge.heading)
    normal = -forward[1], forward[0]

    def local(point: Point) -> Point:
        relative = point[0] - bridge.position[0], point[1] - bridge.position[1]
        return relative[0] * forward[0] + relative[1] * forward[1], relative[0] * normal[0] + relative[
            1
        ] * normal[1]

    first, second = local(start), local(end)
    delta = second[0] - first[0], second[1] - first[1]
    low, high = 0.0, 1.0
    for position, direction, limit in (
        (first[0], delta[0], bridge.span / 2),
        (first[1], delta[1], bridge.width / 2),
    ):
        if abs(direction) < 1e-9:
            if abs(position) > limit:
                return (segment,)
            continue
        enter = (-limit - position) / direction
        leave = (limit - position) / direction
        if enter > leave:
            enter, leave = leave, enter
        low, high = max(low, enter), min(high, leave)
    if low >= high or high <= 0 or low >= 1:
        return (segment,)
    # Leave the contact solver a small physical opening rather than terminating a bank exactly on
    # the deck boundary, where inclusive collision tests would still catch the endpoint.
    low = max(0.0, low - 1e-6)
    high = min(1.0, high + 1e-6)
    pieces: list[Segment] = []
    if low > 0:
        pieces.append((start, add(start, (end[0] - start[0], end[1] - start[1]), low)))
    if high < 1:
        pieces.append((add(start, (end[0] - start[0], end[1] - start[1]), high), end))
    return tuple(pieces)


@dataclass(frozen=True)
class Layout:
    channels: tuple[Polyline, ...]
    road: Polyline
    footpaths: tuple[Polyline, ...]
    bridges: tuple[Bridge, ...]
    buildings: tuple[Building, ...]
    fields: tuple[tuple[Point, ...], ...]
    reed_banks: tuple[tuple[Point, ...], ...]
    props: tuple[Prop, ...]
    scenery: tuple[Scenery, ...]
    spawn: Point
    # A layout is hashed and compared through wall_segments, which holds the same walls in one flat
    # tuple, so this grouped view stays out of both.
    building_walls: dict[str, tuple[Segment, ...]] = field(init=False, compare=False)
    wall_segments: tuple[Segment, ...] = field(init=False)
    water_bank_segments: tuple[Segment, ...] = field(init=False)
    water_confluence_disks: tuple[tuple[Point, float], ...] = field(init=False)

    def __post_init__(self) -> None:
        if len(self.channels) != 4:
            raise ValueError("the village needs the trunk and three channels")
        if tuple((building.id, building.type) for building in self.buildings) != BUILDING_ROSTER:
            raise ValueError("buildings must use the canonical id and type sequence")
        expected_props = tuple(
            (f"{prop_type.token}_{index}", prop_type.token)
            for prop_type in PROP_TYPES
            for index in range(prop_type.count)
        )
        if tuple((prop.id, prop.type) for prop in self.props) != expected_props:
            raise ValueError("props must use the canonical id and type sequence")
        confluence_disks = self._water_confluence_disks()
        if any(
            bridge.distance_to(position) <= radius
            for bridge in self.bridges
            for position, radius in confluence_disks
        ):
            raise ValueError("a bridge deck cannot overlap a channel confluence")
        building_walls = self._building_walls()
        object.__setattr__(self, "building_walls", building_walls)
        object.__setattr__(self, "wall_segments", tuple(chain.from_iterable(building_walls.values())))
        object.__setattr__(self, "water_bank_segments", self._water_bank_segments())
        object.__setattr__(self, "water_confluence_disks", confluence_disks)

    def _building_walls(self) -> dict[str, tuple[Segment, ...]]:
        """Split each building's perimeter around its doorway gap, keyed by building id."""
        by_building: dict[str, tuple[Segment, ...]] = {}
        for building in self.buildings:
            corners = rectangle_corners(building.center, building.width, building.depth, building.rotation)
            edges = tuple(zip(corners, (*corners[1:], corners[0]), strict=True))
            doorway_edge = min(
                edges,
                key=lambda edge: distance_to_segment(building.doorway.position, edge[0], edge[1]),
            )
            walls: list[Segment] = []
            for edge in edges:
                if edge != doorway_edge:
                    walls.append(edge)
                    continue
                start, end = edge
                edge_heading = heading_to(start, end)
                direction = heading_vector(edge_heading)
                projected = (building.doorway.position[0] - start[0]) * direction[0] + (
                    building.doorway.position[1] - start[1]
                ) * direction[1]
                gap_start = add(start, direction, max(0.0, projected - building.doorway.width / 2))
                gap_end = add(
                    start, direction, min(distance(start, end), projected + building.doorway.width / 2)
                )
                if gap_start != start:
                    walls.append((start, gap_start))
                if gap_end != end:
                    walls.append((gap_end, end))
            by_building[building.id] = tuple(walls)
        return by_building

    def _water_bank_segments(self) -> tuple[Segment, ...]:
        banks: list[Segment] = []
        for channel in self.channels:
            for side in (-channel.width / 2, channel.width / 2):
                points = _offset_points(channel, side)
                for segment in zip(points, points[1:], strict=False):
                    pieces = (segment,)
                    for bridge in self.bridges:
                        pieces = tuple(
                            piece for piece in pieces for piece in _segment_outside_rect(piece, bridge)
                        )
                    banks.extend(pieces)
        for bridge in self.bridges:
            forward = heading_vector(bridge.heading)
            normal = -forward[1], forward[0]
            start = add(bridge.position, forward, -bridge.span / 2)
            end = add(bridge.position, forward, bridge.span / 2)
            banks.extend(
                (
                    (add(start, normal, -bridge.width / 2), add(end, normal, -bridge.width / 2)),
                    (add(start, normal, bridge.width / 2), add(end, normal, bridge.width / 2)),
                )
            )
        return tuple(banks)

    def _water_confluence_disks(self) -> tuple[tuple[Point, float], ...]:
        """Fill shared channel endpoints so the bank chains have no fork-sized gaps."""
        endpoints: list[tuple[Point, float]] = []
        for channel in self.channels:
            endpoints.extend(
                ((channel.points[0], channel.width / 2), (channel.points[-1], channel.width / 2))
            )
        disks: list[tuple[Point, float]] = []
        while endpoints:
            point, radius = endpoints.pop()
            matches = [(point, radius)]
            remaining: list[tuple[Point, float]] = []
            for candidate, candidate_radius in endpoints:
                if distance(point, candidate) <= 1e-8:
                    matches.append((candidate, candidate_radius))
                else:
                    remaining.append((candidate, candidate_radius))
            endpoints = remaining
            if len(matches) > 1:
                disks.append((point, max(candidate_radius for _, candidate_radius in matches)))
        return tuple(disks)

    def ground_at(self, point: Point) -> str:
        """Classify ground with bridge decks and water taking their specified precedence."""
        if any(bridge.contains(point) for bridge in self.bridges):
            return "road"
        if any(polyline_distance(point, channel.points) <= channel.width / 2 for channel in self.channels):
            return "water"
        if polyline_distance(point, self.road.points) <= self.road.width / 2 or any(
            polyline_distance(point, path.points) <= path.width / 2 for path in self.footpaths
        ):
            return "road"
        if any(point_in_polygon(point, polygon) for polygon in self.fields):
            return "field"
        if any(point_in_polygon(point, polygon) for polygon in self.reed_banks):
            return "reeds"
        return "open"

    def ground_speed(self, point: Point) -> float:
        return GROUND_BY_TOKEN[self.ground_at(point)].speed

    def line_blocked(self, start: Point, end: Point) -> bool:
        """Return whether a static wall blocks the ruleset's zero-width sight line."""
        return any(segments_intersect((start, end), wall) for wall in self.wall_segments)

    def reaches(self, start: Point, end: Point, limit: float) -> bool:
        """Return whether ``end`` lies within ``limit`` meters of ``start`` along an unblocked line."""
        return distance(start, end) <= limit and not self.line_blocked(start, end)

    def body_clear(self, point: Point, radius: float = PROFILE.body_radius) -> bool:
        """Return whether a character circle stands clear of every static movement solid."""
        if not self.in_bounds(point, radius) or self.ground_at(point) == "water":
            return False
        # Physics fills each fork with its widest channel's round endpoint cap. Expand that cap by
        # the requested body radius so this closed-form query agrees at the water's dry shoulder.
        if any(
            distance(point, position) <= cap_radius + radius
            for position, cap_radius in self.water_confluence_disks
        ):
            return False
        if any(
            distance_to_segment(point, start, end) <= radius + SEGMENT_RADIUS
            for start, end in self.wall_segments
        ):
            return False
        if any(
            distance_to_segment(point, start, end) <= radius + SEGMENT_RADIUS
            for start, end in self.water_bank_segments
        ):
            return False
        if any(
            distance_to_rectangle(point, prop.position, *prop.footprint, prop.rotation) <= radius
            for prop in self.props
        ):
            return False
        return not any(
            distance(point, scenery.position) <= scenery.radius + radius for scenery in self.scenery
        )

    def start_poses(self, cast_size: int) -> dict[str, StartPose]:
        """Derive every roster start from the five home doorway axes."""
        if not 1 <= cast_size <= 10:
            raise ValueError("cast_size must be from 1 through 10")
        homes = {building.id: building for building in self.buildings if building.type == "home"}
        poses: dict[str, StartPose] = {}
        for index in range(cast_size):
            home_id = f"home_{index % 5}"
            home = homes[home_id]
            heading = heading_to(home.center, home.doorway.position)
            axis = heading_vector(heading)
            side = -axis[1], axis[0]
            slot = -0.6 if index // 5 == 0 else 0.6
            poses[f"npc_{index}"] = StartPose(add(home.center, side, slot), heading, home_id)
        poses["visitor"] = StartPose(self.spawn, heading_to(self.road.points[0], self.road.points[1]), "none")
        return poses

    def in_bounds(self, point: Point, radius: float = PROFILE.body_radius) -> bool:
        clearance = radius + SEGMENT_RADIUS
        return (
            clearance <= point[0] <= WORLD_SIZE - clearance
            and clearance <= point[1] <= WORLD_SIZE - clearance
        )
