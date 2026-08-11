"""Layer 4: the pine clusters, the prop catalog with a banked witness per prop, and their scenery.

Pines land first, then the props in canonical catalog order, each accepted only with a banked
witness: a standing point within the use reach where the body is clear and the line to the prop is
unblocked. Every later solid is checked against the banked witnesses, the doorway thresholds, and
the spawn disk, so nothing placed afterward can break them. Stall crates and shrine roof posts land
with their prop as one unit, before its witness is banked.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass
from random import Random

from ..geometry import (
    Point,
    add,
    distance,
    distance_to_rectangle,
    distance_to_segment,
    heading_to,
    point_in_polygon,
    point_in_rectangle,
    rectangle_corners,
    segments_intersect,
    subtract,
)
from ..layout import SEGMENT_RADIUS, WORLD_SIZE, Building, Prop, Scenery, building_wall_segments
from ..prop_types import PROP_TYPE_BY_TOKEN
from ..rules import PROFILE
from .network import SPAWN_CLEARANCE, _Network
from .sites import _Sites
from .terrain import _Water
from .walker import _Bounds, _drawn_side, _edges, _inside_frame, _polar, _unit, _water_gap

PINE_RADIUS = 0.8
CRATE_RADIUS = 0.5
POST_RADIUS = 0.2

_BODY_ROOM = PROFILE.body_radius + SEGMENT_RADIUS + 0.02
_WITNESS_SOLID_GAP = PROFILE.body_radius + 0.1
_PROP_GAP = 0.3
_PROP_WATER_MARGIN = 1.0
_PROP_PATH_MARGIN = 0.3
_PROP_BUILDING_GAP = 0.5
_PROP_FRAME_MARGIN = 1.0
_THRESHOLD_GAP = 1.0
_SPAWN_SLACK = 0.05
_PROTECTED_GAP = 2.2
_STALL_DRY_STRETCH = 3.0
_LANTERN_DRY_STRETCH = 2.0

_PINE_CLUSTERS = (4, 6)
_PINE_SIZE_SPREADS = {2: (0.6, 1.6), 3: (0.6, 1.05), 4: (0.7, 1.05), 5: (0.85, 1.05)}
_PINE_MIN_SPACING = 1.1
_PINE_PATH_GAP = 2.0
_PINE_SOLID_GAP = 1.2
_PINE_BUILDING_GAP = 3.0
_PINE_ANCHOR_GAP = 2.0
_PINE_CENTER_GAP = 8.0
_CLUSTER_TRIES = 40
_PINE_TRIES = 30

_PROP_TRIES = 80
_CRATE_TRIES = 12
_LANTERN_SETS = 4
_LANTERN_TRIES = 24
_LANTERN_SPACING = 4.0
_SHRINE_TRIES = 60
_PLOT_SLIDES = 8
_INTERIOR_TRIES = 20

_WITNESS_ANGLES = 16
_WITNESS_FIRST_RING = 0.06
_WITNESS_RADIUS_STEP = 0.1


@dataclass(frozen=True)
class _Accessories:
    """The accessories layer's output: the catalog, its scenery, and the banked witnesses."""

    props: tuple[Prop, ...]
    scenery: tuple[Scenery, ...]
    witnesses: tuple[Point, ...]


def _rect_samples(corners: tuple[Point, ...], center: Point) -> tuple[Point, ...]:
    """A rectangle's corners, edge midpoints, and center, the probe set the clearances scan."""
    midpoints = tuple(
        ((start[0] + end[0]) / 2.0, (start[1] + end[1]) / 2.0)
        for start, end in zip(corners, (*corners[1:], corners[0]), strict=True)
    )
    return (*corners, *midpoints, center)


def _arc_lengths(points: tuple[Point, ...]) -> list[float]:
    lengths = [0.0]
    for start, end in itertools.pairwise(points):
        lengths.append(lengths[-1] + distance(start, end))
    return lengths


def _arc_point(points: tuple[Point, ...], lengths: list[float], along: float) -> tuple[Point, Point]:
    """The polyline point at an arc length, with the local unit direction."""
    along = min(max(along, 0.0), lengths[-1])
    for index in range(1, len(lengths)):
        if along <= lengths[index] or index == len(lengths) - 1:
            start, end = points[index - 1], points[index]
            span = lengths[index] - lengths[index - 1]
            fraction = 0.0 if span <= 0.0 else (along - lengths[index - 1]) / span
            direction = _unit(subtract(end, start))
            return add(start, subtract(end, start), fraction), direction
    return points[-1], _unit(subtract(points[-1], points[-2]))


def _nearest_arc(points: tuple[Point, ...], lengths: list[float], target: Point) -> float:
    """The arc length of the polyline vertex nearest a target point."""
    index = min(range(len(points)), key=lambda candidate: distance(points[candidate], target))
    return lengths[index]


class _Placer:
    """The accessories layer's working state: everything placed so far, with its clearances."""

    def __init__(
        self,
        water: _Water,
        sites: _Sites,
        network: _Network,
        fields: tuple[tuple[Point, ...], ...],
        reed_banks: tuple[tuple[Point, ...], ...],
    ) -> None:
        self.water = water
        self.spawn = network.spawn
        self.buildings = network.buildings
        self.polygons = (*fields, *reed_banks)
        self.decks = network.bridges
        self.walls = tuple(
            segment for building in network.buildings for segment in building_wall_segments(building)
        )
        self.anchors = (
            *sites.stalls,
            sites.board,
            sites.market,
            sites.plaza,
            sites.bell,
            *network.shrine_spots,
        )
        self.protected = network.shrine_spots
        self.thresholds = tuple(
            add(building.doorway.position, _unit(subtract(building.doorway.position, building.center)), 1.0)
            for building in network.buildings
        )
        self.paths: list[tuple[tuple[Point, ...], float, tuple[_Bounds, ...], _Bounds]] = []
        for line in (network.road, *network.footpaths):
            bounds = tuple(
                (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))
                for a, b in itertools.pairwise(line.points)
            )
            extent = (
                min(bound[0] for bound in bounds),
                min(bound[1] for bound in bounds),
                max(bound[2] for bound in bounds),
                max(bound[3] for bound in bounds),
            )
            self.paths.append((line.points, line.width / 2.0, bounds, extent))
        self.props: list[Prop] = []
        self.witnesses: list[Point] = []
        self.pines: list[Scenery] = []
        self.crates: list[Scenery] = []
        self.posts: list[Scenery] = []
        self._counters: dict[str, int] = {}

    def scenery(self) -> tuple[Scenery, ...]:
        return (*self.pines, *self.crates, *self.posts)

    def mark(self) -> tuple[int, int, dict[str, int]]:
        return len(self.props), len(self.witnesses), dict(self._counters)

    def rewind(self, mark: tuple[int, int, dict[str, int]]) -> None:
        del self.props[mark[0] :]
        del self.witnesses[mark[1] :]
        self._counters = dict(mark[2])

    def bank(self, token: str, center: Point, rotation: float, witness: Point) -> Prop:
        """Emit the next prop of a type with its witness; ids follow placement order."""
        prop_type = PROP_TYPE_BY_TOKEN[token]
        index = self._counters.get(token, 0)
        self._counters[token] = index + 1
        prop = Prop(
            f"{token}_{index}",
            token,
            center,
            (prop_type.footprint.width, prop_type.footprint.depth),
            rotation,
        )
        self.props.append(prop)
        self.witnesses.append(witness)
        return prop

    def stretch_wet(self, point: Point, room: float) -> bool:
        """Whether a road stretch point lacks the dry room a roadside prop needs beside it."""
        if distance(point, self.water.fork) < self.water.cap_radius + room:
            return True
        for channel, extent in zip(self.water.channels, self.water.extents, strict=True):
            reach = channel.width / 2.0 + room
            if (
                point[0] < extent[0] - reach
                or extent[2] + reach < point[0]
                or point[1] < extent[1] - reach
                or extent[3] + reach < point[1]
            ):
                continue
            if _water_gap(point, channel) < room:
                return True
        return False

    def _water_clear(self, samples: tuple[Point, ...], extra: float) -> bool:
        """Whether every sample keeps the extra margin from the water's edge and the cap."""
        bbox = (
            min(sample[0] for sample in samples),
            min(sample[1] for sample in samples),
            max(sample[0] for sample in samples),
            max(sample[1] for sample in samples),
        )
        fork = self.water.fork
        cap = self.water.cap_radius + extra
        if any(distance(sample, fork) < cap for sample in samples):
            return False
        for channel, extent in zip(self.water.channels, self.water.extents, strict=True):
            reach = channel.width / 2.0 + extra
            if (
                bbox[2] + reach < extent[0]
                or extent[2] + reach < bbox[0]
                or bbox[3] + reach < extent[1]
                or extent[3] + reach < bbox[1]
            ):
                continue
            if any(_water_gap(sample, channel) < extra for sample in samples):
                return False
        return True

    def _paths_clear(self, samples: tuple[Point, ...], extra: float, skip_paths: tuple[int, ...]) -> bool:
        """Whether every sample keeps the extra margin off every path surface and deck.

        A shrine and its posts stand at the end of their own stub, so a caller can exempt that one
        path by index.
        """
        bbox = (
            min(sample[0] for sample in samples),
            min(sample[1] for sample in samples),
            max(sample[0] for sample in samples),
            max(sample[1] for sample in samples),
        )
        for index, (points, half, bounds, extent) in enumerate(self.paths):
            if index in skip_paths:
                continue
            need = half + extra
            if (
                bbox[2] + need < extent[0]
                or extent[2] + need < bbox[0]
                or bbox[3] + need < extent[1]
                or extent[3] + need < bbox[1]
            ):
                continue
            for (start, end), segment_bounds in zip(itertools.pairwise(points), bounds, strict=True):
                if (
                    bbox[2] + need < segment_bounds[0]
                    or segment_bounds[2] + need < bbox[0]
                    or bbox[3] + need < segment_bounds[1]
                    or segment_bounds[3] + need < bbox[1]
                ):
                    continue
                if any(distance_to_segment(sample, start, end) < need for sample in samples):
                    return False
        return all(deck.distance_to(sample) >= extra for deck in self.decks for sample in samples)

    def rect_clear(
        self,
        center: Point,
        footprint: tuple[float, float],
        rotation: float,
        *,
        path_margin: float = _PROP_PATH_MARGIN,
        skip_building: Building | None = None,
        skip_paths: tuple[int, ...] = (),
        skip_protected: bool = False,
    ) -> bool:
        """Whether a prop rectangle clears the frame, water, paths, solids, and banked ground.

        The cheap point checks run first so a doomed candidate costs as little as possible. The
        protected points are the shrine spots, which every earlier prop keeps off; the shrine
        itself skips them.
        """
        corners = rectangle_corners(center, footprint[0], footprint[1], rotation)
        samples = _rect_samples(corners, center)
        if not all(_inside_frame(corner, _PROP_FRAME_MARGIN) for corner in corners):
            return False
        rectangle = (center, footprint[0], footprint[1], rotation)
        if distance_to_rectangle(self.spawn, *rectangle) < SPAWN_CLEARANCE + _SPAWN_SLACK:
            return False
        if not skip_protected and any(
            distance_to_rectangle(spot, *rectangle) < _PROTECTED_GAP for spot in self.protected
        ):
            return False
        if any(
            distance_to_rectangle(threshold, *rectangle) < _THRESHOLD_GAP for threshold in self.thresholds
        ):
            return False
        if any(distance_to_rectangle(witness, *rectangle) < _WITNESS_SOLID_GAP for witness in self.witnesses):
            return False
        if any(
            distance_to_rectangle(item.position, *rectangle) < item.radius + _PROP_GAP
            for item in self.scenery()
        ):
            return False
        edges = _edges(corners)
        for building in self.buildings:
            if building is skip_building:
                continue
            other = (building.center, building.width, building.depth, building.rotation)
            other_corners = rectangle_corners(*other)
            if any(segments_intersect(edge, wall) for edge in edges for wall in _edges(other_corners)):
                return False
            if any(distance_to_rectangle(corner, *other) < _PROP_BUILDING_GAP for corner in corners):
                return False
            if any(
                distance_to_rectangle(corner, center, *footprint, rotation) < _PROP_BUILDING_GAP
                for corner in other_corners
            ):
                return False
        for prop in self.props:
            other = (prop.position, prop.footprint[0], prop.footprint[1], prop.rotation)
            other_corners = rectangle_corners(*other)
            if any(segments_intersect(edge, wall) for edge in edges for wall in _edges(other_corners)):
                return False
            if any(distance_to_rectangle(corner, *other) < _PROP_GAP for corner in corners):
                return False
            if any(distance_to_rectangle(corner, *rectangle) < _PROP_GAP for corner in other_corners):
                return False
        if not self._water_clear(samples, _PROP_WATER_MARGIN):
            return False
        return self._paths_clear(samples, path_margin, skip_paths)

    def circle_clear(
        self,
        center: Point,
        radius: float,
        *,
        path_margin: float = _PROP_PATH_MARGIN,
        water_margin: float = 0.5,
        exempt: Prop | None = None,
        skip_paths: tuple[int, ...] = (),
        skip_protected: bool = False,
    ) -> bool:
        """Whether a scenery circle clears the frame, water, paths, solids, and banked ground."""
        samples = (center,)
        if not _inside_frame(center, radius + _PROP_FRAME_MARGIN):
            return False
        if distance(center, self.spawn) - radius < SPAWN_CLEARANCE + _SPAWN_SLACK:
            return False
        if not skip_protected and any(
            distance(center, spot) < radius + _PROTECTED_GAP for spot in self.protected
        ):
            return False
        if any(distance(center, threshold) < radius + _THRESHOLD_GAP for threshold in self.thresholds):
            return False
        if any(distance(center, witness) < radius + _WITNESS_SOLID_GAP for witness in self.witnesses):
            return False
        if any(distance(center, item.position) < radius + item.radius + _PROP_GAP for item in self.scenery()):
            return False
        if any(
            distance_to_rectangle(center, building.center, building.width, building.depth, building.rotation)
            < radius + _PROP_BUILDING_GAP
            for building in self.buildings
        ):
            return False
        for prop in self.props:
            if prop is exempt:
                continue
            if (
                distance_to_rectangle(center, prop.position, *prop.footprint, prop.rotation)
                < radius + _PROP_GAP
            ):
                return False
        if not self._water_clear(samples, radius + water_margin):
            return False
        return self._paths_clear(samples, radius + path_margin, skip_paths)

    def pine_clear(self, center: Point, cluster: list[Point]) -> bool:
        """Whether a pine keeps the layer's wide margins from everything outside its own cluster."""
        if not _inside_frame(center, PINE_RADIUS + _PINE_SOLID_GAP):
            return False
        if distance(center, self.spawn) - PINE_RADIUS < SPAWN_CLEARANCE + _SPAWN_SLACK:
            return False
        if any(distance(center, anchor) < PINE_RADIUS + _PINE_ANCHOR_GAP for anchor in self.anchors):
            return False
        if any(distance(center, threshold) < PINE_RADIUS + _PINE_ANCHOR_GAP for threshold in self.thresholds):
            return False
        if any(distance(center, pine.position) < 2.0 * PINE_RADIUS + _PINE_SOLID_GAP for pine in self.pines):
            return False
        if any(
            distance_to_rectangle(center, building.center, building.width, building.depth, building.rotation)
            < PINE_RADIUS + _PINE_BUILDING_GAP
            for building in self.buildings
        ):
            return False
        if any(point_in_polygon(center, polygon) for polygon in self.polygons):
            return False
        if not self._water_clear((center,), PINE_RADIUS + _PINE_SOLID_GAP):
            return False
        return self._paths_clear((center,), PINE_RADIUS + _PINE_PATH_GAP, ())

    def open_ground(
        self,
        point: Point,
        inside: Building | None = None,
        pending_rects: tuple[tuple[Point, float, float, float], ...] = (),
        pending_circles: tuple[tuple[Point, float], ...] = (),
    ) -> bool:
        """Whether a standing body is clear here, against everything placed so far."""
        if not _inside_frame(point, _BODY_ROOM):
            return False
        if inside is not None and not point_in_rectangle(
            point, inside.center, inside.width, inside.depth, inside.rotation
        ):
            return False
        if not self._water_clear((point,), _BODY_ROOM):
            return False
        if any(distance_to_segment(point, start, end) < _BODY_ROOM for start, end in self.walls):
            return False
        for prop in self.props:
            if (
                distance_to_rectangle(point, prop.position, *prop.footprint, prop.rotation)
                < PROFILE.body_radius + 0.05
            ):
                return False
        for center, width, depth, rotation in pending_rects:
            if distance_to_rectangle(point, center, width, depth, rotation) < PROFILE.body_radius + 0.05:
                return False
        if any(
            distance(point, item.position) < item.radius + PROFILE.body_radius + 0.05
            for item in self.scenery()
        ):
            return False
        return all(
            distance(point, center) >= radius + PROFILE.body_radius + 0.05
            for center, radius in pending_circles
        )

    def line_open(self, start: Point, end: Point) -> bool:
        return not any(segments_intersect((start, end), wall) for wall in self.walls)

    def witness_for(
        self,
        center: Point,
        footprint: tuple[float, float],
        rotation: float,
        inside: Building | None = None,
        pending_rects: tuple[tuple[Point, float, float, float], ...] = (),
        pending_circles: tuple[tuple[Point, float], ...] = (),
    ) -> Point | None:
        """Scan for a standing point within reach of the prop, or None when none exists.

        The scan is deterministic and draws nothing: radii walk outward from the prop's near edge,
        angles walk the compass from the prop's own rotation, and the first point that stands clear
        with an unblocked line to the prop wins.
        """
        reach = PROFILE.prop_reach - 0.02
        radius = min(footprint) / 2.0 + PROFILE.body_radius + _WITNESS_FIRST_RING
        radii: list[float] = []
        while radius <= reach:
            radii.append(radius)
            radius += _WITNESS_RADIUS_STEP
        own = (center, footprint[0], footprint[1], rotation)
        for candidate_radius in radii:
            for step in range(_WITNESS_ANGLES):
                angle = rotation + step * (360.0 / _WITNESS_ANGLES)
                offset = _heading_offset(angle)
                candidate = add(center, offset, candidate_radius)
                if distance_to_rectangle(candidate, *own) < PROFILE.body_radius + 0.05:
                    continue
                if not self.open_ground(candidate, inside, pending_rects, pending_circles):
                    continue
                if not self.line_open(candidate, center):
                    continue
                return candidate
        return None


def _heading_offset(angle: float) -> Point:
    """The unit vector for a heading in degrees."""
    radians = math.radians(angle)
    return (math.cos(radians), math.sin(radians))


def _pines(rng: Random, placer: _Placer) -> bool:
    """Stand the pine clusters on open land, tight enough that a cluster is one solid blob."""
    target = rng.randint(*_PINE_CLUSTERS)
    centers: list[Point] = []
    for _ in range(target):
        for _ in range(_CLUSTER_TRIES):
            candidate = (rng.uniform(0.0, WORLD_SIZE), rng.uniform(0.0, WORLD_SIZE))
            if any(distance(candidate, taken) < _PINE_CENTER_GAP for taken in centers):
                continue
            if not placer.pine_clear(candidate, []):
                continue
            size = rng.randint(2, 5)
            spread = _PINE_SIZE_SPREADS[size]
            cluster: list[Point] = []
            for _ in range(size):
                for _ in range(_PINE_TRIES):
                    member = add(candidate, _polar(rng, *spread))
                    if any(distance(member, other) < _PINE_MIN_SPACING for other in cluster):
                        continue
                    if not placer.pine_clear(member, cluster):
                        continue
                    cluster.append(member)
                    break
                else:
                    break
            if len(cluster) == size:
                placer.pines.extend(Scenery("pine", member, PINE_RADIUS) for member in cluster)
                centers.append(candidate)
                break
        else:
            return False
    return True


def _crates(rng: Random, placer: _Placer, stall: Prop) -> bool:
    """Land one or two crates at the stall's corners, walking the corners until one fits."""
    count = rng.randint(1, 2)
    corners = rectangle_corners(stall.position, *stall.footprint, stall.rotation)
    first = rng.randrange(4)
    placed = 0
    for offset in range(4):
        if placed == count:
            break
        corner = corners[(first + offset) % 4]
        for _ in range(_CRATE_TRIES):
            reach = CRATE_RADIUS + rng.uniform(0.1, 0.35)
            center = add(corner, _unit(subtract(corner, stall.position)), reach)
            if placer.circle_clear(center, CRATE_RADIUS, exempt=stall):
                placer.crates.append(Scenery("crate", center, CRATE_RADIUS))
                placed += 1
                break
    return placed >= 1


def _stalls(rng: Random, placer: _Placer, sites: _Sites, network: _Network) -> bool:
    """Stand the stalls just off the road on their spots' sides, each with witness and crates.

    A spot fixes which stretch of road its stall serves and which side it stands on; the stall
    itself is drawn against the road that was actually threaded, so the market hugs the road the
    way the fixture's did whatever the road's meander.
    """
    footprint = _footprint("stall")
    road = network.road
    lengths = _arc_lengths(road.points)
    half_depth = footprint[1] / 2.0
    for spot in sites.stalls[: PROP_TYPE_BY_TOKEN["stall"].count]:
        anchor_along = _nearest_arc(road.points, lengths, spot)
        for attempt in range(_PROP_TRIES):
            along = anchor_along + rng.uniform(-12.0, 12.0)
            point, direction = _arc_point(road.points, lengths, along)
            if placer.stretch_wet(point, _STALL_DRY_STRETCH):
                continue
            normal = (-direction[1], direction[0])
            toward = subtract(spot, point)
            side = 1.0 if normal[0] * toward[0] + normal[1] * toward[1] >= 0.0 else -1.0
            if attempt >= _PROP_TRIES // 2:
                side = -side
            offset = road.width / 2.0 + half_depth + _PROP_PATH_MARGIN + rng.uniform(0.15, 1.6)
            center = add(point, normal, side * offset)
            rotation = heading_to(point, add(point, direction)) + rng.uniform(-20.0, 20.0)
            if not placer.rect_clear(center, footprint, rotation):
                continue
            witness = placer.witness_for(center, footprint, rotation)
            if witness is None:
                continue
            mark = placer.mark()
            stall = placer.bank("stall", center, rotation, witness)
            if _crates(rng, placer, stall):
                break
            placer.rewind(mark)
        else:
            return False
    return True


def _lanterns(rng: Random, placer: _Placer, network: _Network, sites: _Sites) -> bool:
    """Space the lanterns just off the road edge, denser near the market."""
    count = PROP_TYPE_BY_TOKEN["lantern"].count
    footprint = _footprint("lantern")
    road = network.road
    lengths = _arc_lengths(road.points)
    total = lengths[-1]
    market_along = _nearest_arc(road.points, lengths, sites.market)
    near_market = count // 2
    for _ in range(_LANTERN_SETS):
        stations = []
        for index in range(count):
            if index < near_market:
                along = market_along + rng.uniform(-18.0, 18.0)
            else:
                along = rng.uniform(0.03, 0.97) * total
            stations.append(min(max(along, 2.0), total - 2.0))
        stations.sort()
        spaced: list[float] = []
        for station in stations:
            spaced.append(station if not spaced else max(station, spaced[-1] + _LANTERN_SPACING))
        if spaced[-1] > total - 2.0:
            continue
        mark = placer.mark()
        placed = 0
        for station in spaced:
            for _ in range(_LANTERN_TRIES):
                jitter = rng.uniform(-6.0, 6.0)
                side = _drawn_side(rng)
                extra = rng.uniform(0.2, 0.6)
                point, direction = _arc_point(road.points, lengths, station + jitter)
                if placer.stretch_wet(point, _LANTERN_DRY_STRETCH):
                    continue
                normal = (-direction[1], direction[0])
                center = add(point, normal, side * (road.width / 2.0 + footprint[0] / 2.0 + extra))
                rotation = heading_to(point, add(point, direction))
                if not placer.rect_clear(center, footprint, rotation, path_margin=0.05):
                    continue
                witness = placer.witness_for(center, footprint, rotation)
                if witness is None:
                    continue
                placer.bank("lantern", center, rotation, witness)
                placed += 1
                break
            else:
                break
        if placed == count:
            return True
        placer.rewind(mark)
    return False


def _benches(rng: Random, placer: _Placer, sites: _Sites, network: _Network) -> bool:
    """Split the benches across the plaza, the market, and the inn front, every site served."""
    footprint = _footprint("bench")
    anchored = (
        (sites.plaza, (1.5, 5.0)),
        (sites.plaza, (1.5, 5.0)),
        (sites.market, (2.0, 7.5)),
        (sites.market, (2.0, 7.5)),
    )
    for anchor, reach in anchored:
        for _ in range(_PROP_TRIES):
            center = add(anchor, _polar(rng, *reach))
            rotation = heading_to(center, anchor) + 90.0
            if not placer.rect_clear(center, footprint, rotation):
                continue
            witness = placer.witness_for(center, footprint, rotation)
            if witness is None:
                continue
            placer.bank("bench", center, rotation, witness)
            break
        else:
            return False
    inn = network.buildings[5]
    door = inn.doorway.position
    outward = _unit(subtract(door, inn.center))
    along_wall = (-outward[1], outward[0])
    for _ in range(_PROP_TRIES):
        side = _drawn_side(rng)
        center = add(add(door, outward, rng.uniform(1.0, 4.5)), along_wall, side * rng.uniform(1.9, 6.0))
        rotation = heading_to(door, add(door, along_wall))
        if not placer.rect_clear(center, footprint, rotation, skip_building=inn):
            continue
        witness = placer.witness_for(center, footprint, rotation)
        if witness is None:
            continue
        placer.bank("bench", center, rotation, witness)
        return True
    return False


def _shrines(rng: Random, placer: _Placer, network: _Network) -> bool:
    """Stand each shrine on its road-bend spot with four roof posts at its corners.

    A shrine stands at the end of its own stub footpath, the last paths the network emitted in
    spot order, so that one path is exempt from the shrine's and its posts' path clearances.
    """
    footprint = _footprint("shrine")
    road = network.road
    lengths = _arc_lengths(road.points)
    first_stub = len(placer.paths) - len(network.shrine_spots)
    for spot_index, spot in enumerate(network.shrine_spots):
        stub = (first_stub + spot_index,)
        along = _nearest_arc(road.points, lengths, spot)
        _, direction = _arc_point(road.points, lengths, along)
        rotation = heading_to(spot, add(spot, direction))
        for _ in range(_SHRINE_TRIES):
            center = add(spot, _polar(rng, 0.0, 0.8))
            if not placer.rect_clear(
                center, footprint, rotation, path_margin=0.15, skip_paths=stub, skip_protected=True
            ):
                continue
            posts = rectangle_corners(center, 2.0, 2.0, rotation)
            if not all(
                placer.circle_clear(
                    post,
                    POST_RADIUS,
                    path_margin=0.05,
                    water_margin=0.3,
                    skip_paths=stub,
                    skip_protected=True,
                )
                for post in posts
            ):
                continue
            witness = placer.witness_for(
                center,
                footprint,
                rotation,
                pending_rects=((center, footprint[0], footprint[1], rotation),),
                pending_circles=tuple((post, POST_RADIUS) for post in posts),
            )
            if witness is None:
                continue
            placer.bank("shrine", center, rotation, witness)
            placer.posts.extend(Scenery("post", post, POST_RADIUS) for post in posts)
            break
        else:
            return False
    return True


def _board(rng: Random, placer: _Placer, sites: _Sites) -> bool:
    """Post the notice board among the stalls, beside the placed stall its spot named."""
    footprint = _footprint("board")
    stalls = [prop for prop in placer.props if prop.type == "stall"]
    host = min(stalls, key=lambda prop: distance(prop.position, sites.board))
    for _ in range(_PROP_TRIES):
        center = add(host.position, _polar(rng, 1.4, 3.0))
        rotation = rng.uniform(0.0, 360.0)
        if not placer.rect_clear(center, footprint, rotation):
            continue
        witness = placer.witness_for(center, footprint, rotation)
        if witness is None:
            continue
        placer.bank("board", center, rotation, witness)
        return True
    return False


def _plots(rng: Random, placer: _Placer) -> bool:
    """Set a garden plot flush against a non-doorway wall of each home."""
    footprint = _footprint("plot")
    half_depth = footprint[1] / 2.0
    for home in placer.buildings[:5]:
        corners = rectangle_corners(home.center, home.width, home.depth, home.rotation)
        edges = _edges(corners)
        doorway_index = min(
            range(4), key=lambda index: distance_to_segment(home.doorway.position, *edges[index])
        )
        order = [index for index in range(4) if index != doorway_index]
        rng.shuffle(order)
        placed = False
        for wall_index in order:
            start, end = edges[wall_index]
            middle = ((start[0] + end[0]) / 2.0, (start[1] + end[1]) / 2.0)
            along = _unit(subtract(end, start))
            outward = _unit(subtract(middle, home.center))
            slide_limit = max(0.0, distance(start, end) / 2.0 - footprint[0] / 2.0 - 0.1)
            for _ in range(_PLOT_SLIDES):
                slide = rng.uniform(-slide_limit, slide_limit)
                center = add(add(middle, along, slide), outward, half_depth + 0.05)
                rotation = home.rotation
                if not placer.rect_clear(center, footprint, rotation, skip_building=home):
                    continue
                witness = placer.witness_for(center, footprint, rotation)
                if witness is None:
                    continue
                placer.bank("plot", center, rotation, witness)
                placed = True
                break
            if placed:
                break
        if not placed:
            return False
    return True


def _interior(rng: Random, placer: _Placer, building: Building, token: str) -> bool:
    """Stand an interior prop against the wall opposite the doorway, long side along the wall."""
    footprint = _footprint(token)
    door = building.doorway.position
    inward = _unit(subtract(building.center, door))
    span = distance(building.center, door)
    along_wall = (-inward[1], inward[0])
    base = add(building.center, inward, span - footprint[1] / 2.0)
    rotation = heading_to(door, add(door, along_wall))
    for _ in range(_INTERIOR_TRIES):
        slide = rng.uniform(-1.2, 1.2)
        center = add(base, along_wall, slide)
        corners = rectangle_corners(center, footprint[0], footprint[1], rotation)
        if not all(
            point_in_rectangle(corner, building.center, building.width, building.depth, building.rotation)
            for corner in corners
        ):
            continue
        rectangle = (center, footprint[0], footprint[1], rotation)
        if distance_to_rectangle(door, *rectangle) < 1.2:
            continue
        if any(distance_to_rectangle(prop.position, *rectangle) < _PROP_GAP for prop in placer.props):
            continue
        witness = placer.witness_for(center, footprint, rotation, inside=building)
        if witness is None:
            continue
        placer.bank(token, center, rotation, witness)
        return True
    return False


def _pump(rng: Random, placer: _Placer, sites: _Sites) -> bool:
    """Stand the pump on the plaza, at the end of the plaza footpath, which is exempt for it."""
    footprint = _footprint("pump")
    plaza_path = (1,)
    for _ in range(_PROP_TRIES):
        center = add(sites.plaza, _polar(rng, 0.0, 2.0))
        rotation = rng.uniform(0.0, 360.0)
        if not placer.rect_clear(center, footprint, rotation, skip_paths=plaza_path):
            continue
        witness = placer.witness_for(center, footprint, rotation)
        if witness is None:
            continue
        placer.bank("pump", center, rotation, witness)
        return True
    return False


def _bell(rng: Random, placer: _Placer, sites: _Sites, network: _Network) -> bool:
    """Stand the bell just off the road, on the stretch nearest its drawn west spot."""
    footprint = _footprint("bell")
    road = network.road
    lengths = _arc_lengths(road.points)
    anchor_along = _nearest_arc(road.points, lengths, sites.bell)
    for _ in range(_PROP_TRIES):
        along = anchor_along + rng.uniform(-4.0, 4.0)
        point, direction = _arc_point(road.points, lengths, along)
        normal = (-direction[1], direction[0])
        toward = subtract(sites.bell, point)
        side = 1.0 if normal[0] * toward[0] + normal[1] * toward[1] >= 0.0 else -1.0
        center = add(point, normal, side * (road.width / 2.0 + footprint[0] / 2.0 + rng.uniform(0.3, 0.9)))
        rotation = heading_to(point, add(point, direction))
        if not placer.rect_clear(center, footprint, rotation, path_margin=0.1):
            continue
        witness = placer.witness_for(center, footprint, rotation)
        if witness is None:
            continue
        placer.bank("bell", center, rotation, witness)
        return True
    return False


def _footprint(token: str) -> tuple[float, float]:
    footprint = PROP_TYPE_BY_TOKEN[token].footprint
    return (footprint.width, footprint.depth)


def _accessories_layer(
    rng: Random,
    water: _Water,
    sites: _Sites,
    network: _Network,
    fields: tuple[tuple[Point, ...], ...],
    reed_banks: tuple[tuple[Point, ...], ...],
) -> _Accessories | None:
    """Dress the village: pines, then the catalog in canonical order, or None to redraw."""
    placer = _Placer(water, sites, network, fields, reed_banks)
    if not _pines(rng, placer):
        return None
    if not _stalls(rng, placer, sites, network):
        return None
    if not _lanterns(rng, placer, network, sites):
        return None
    if not _benches(rng, placer, sites, network):
        return None
    if not _shrines(rng, placer, network):
        return None
    if not _board(rng, placer, sites):
        return None
    if not _plots(rng, placer):
        return None
    if not _interior(rng, placer, network.buildings[5], "hearth"):
        return None
    if not _interior(rng, placer, network.buildings[6], "repair_bench"):
        return None
    if not _pump(rng, placer, sites):
        return None
    if not _bell(rng, placer, sites, network):
        return None
    return _Accessories(tuple(placer.props), placer.scenery(), tuple(placer.witnesses))
