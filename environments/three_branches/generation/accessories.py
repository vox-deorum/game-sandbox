"""Layer 4: required village props followed by optional lantern and pine dressing.

Props are placed in constraint order and then restored to catalog order. Each prop is accepted only
with a standing witness in reach. Later solids preserve those witnesses, doorway thresholds, and the
spawn disk. Stall crates and shrine roof posts land with their prop before its witness is banked.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, replace
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
    wrap_heading,
)
from ..layout import SEGMENT_RADIUS, WORLD_SIZE, Building, Polyline, Prop, Scenery, building_wall_segments
from ..prop_types import PROP_TYPE_BY_TOKEN, PROP_TYPES, fixed_prop_count
from ..rules import PROFILE
from .config import GENERATION_CONFIG
from .network import SPAWN_CLEARANCE, _Network
from .sites import _Sites
from .terrain import _Water
from .walker import _Bounds, _drawn_side, _edges, _inside_frame, _polar, _unit, _water_gap

PINE_RADIUS = GENERATION_CONFIG.accessories.pine.radius
CRATE_RADIUS = GENERATION_CONFIG.accessories.crate.radius
POST_RADIUS = GENERATION_CONFIG.accessories.post.radius

_BODY_ROOM = PROFILE.body_radius + SEGMENT_RADIUS + 0.02
_BODY_CLEARANCE_SLACK = 0.05
_WITNESS_SOLID_GAP = PROFILE.body_radius + 0.1
_PROP_GAP = GENERATION_CONFIG.accessories.prop.gap
_PROP_WATER_MARGIN = GENERATION_CONFIG.accessories.prop.water_margin
_PROP_PATH_MARGIN = GENERATION_CONFIG.accessories.prop.path_margin
_PROP_BUILDING_GAP = GENERATION_CONFIG.accessories.prop.building_gap
_PROP_FRAME_MARGIN = GENERATION_CONFIG.accessories.prop.frame_margin
_THRESHOLD_GAP = GENERATION_CONFIG.accessories.prop.threshold_gap
_SPAWN_SLACK = GENERATION_CONFIG.accessories.prop.spawn_slack
_PROTECTED_GAP = GENERATION_CONFIG.accessories.prop.protected_gap
_STALL_DRY_STRETCH = GENERATION_CONFIG.accessories.stall.dry_stretch
_LANTERN_DRY_STRETCH = GENERATION_CONFIG.accessories.lantern.dry_stretch

_PINE_PATH_GAP = GENERATION_CONFIG.accessories.pine.path_edge_gap
_PINE_SOLID_GAP = GENERATION_CONFIG.accessories.pine.solid_gap
_PINE_BUILDING_GAP = GENERATION_CONFIG.accessories.pine.building_gap
_PINE_ANCHOR_GAP = GENERATION_CONFIG.accessories.pine.anchor_gap

_PROP_TRIES = GENERATION_CONFIG.accessories.prop.tries
_CRATE_TRIES = GENERATION_CONFIG.accessories.crate.tries
_SHRINE_TRIES = GENERATION_CONFIG.accessories.shrine.tries
_PLOT_SLIDES = GENERATION_CONFIG.accessories.plot.slides
_INTERIOR_TRIES = GENERATION_CONFIG.accessories.interior.tries

_WITNESS_ANGLES = GENERATION_CONFIG.accessories.witness.angles
_WITNESS_FIRST_RING = GENERATION_CONFIG.accessories.witness.first_ring
_WITNESS_RADIUS_STEP = GENERATION_CONFIG.accessories.witness.radius_step

_GOLDEN_ANGLE = 137.50776405003785


@dataclass(frozen=True)
class _Accessories:
    """The accessories layer's output: the catalog, its scenery, and the banked witnesses."""

    mandatory_props: tuple[Prop, ...]
    lantern_props: tuple[Prop, ...]
    mandatory_scenery: tuple[Scenery, ...]
    pines: tuple[Scenery, ...]
    mandatory_witnesses: tuple[Point, ...]
    lantern_witnesses: tuple[Point, ...]

    def layout_parts(
        self, include_pines: bool, include_lanterns: bool
    ) -> tuple[tuple[Prop, ...], tuple[Scenery, ...], tuple[Point, ...]]:
        """Return one validation candidate without drawing or changing placement state."""
        props = self.mandatory_props + (self.lantern_props if include_lanterns else ())
        scenery = self.mandatory_scenery + (self.pines if include_pines else ())
        witnesses = self.mandatory_witnesses + (self.lantern_witnesses if include_lanterns else ())
        return _ordered_props(props), scenery, witnesses


def _rect_samples(corners: tuple[Point, ...], center: Point) -> tuple[Point, ...]:
    """A rectangle's corners, edge midpoints, and center, the probe set the clearances scan."""
    midpoints = tuple(
        ((start[0] + end[0]) / 2.0, (start[1] + end[1]) / 2.0)
        for start, end in zip(corners, (*corners[1:], corners[0]), strict=True)
    )
    return (*corners, *midpoints, center)


@dataclass(frozen=True)
class RoadArc:
    """Exact arc-length projection and local frames for the threaded road."""

    points: tuple[Point, ...]
    lengths: tuple[float, ...]

    @classmethod
    def of(cls, points: tuple[Point, ...]) -> RoadArc:
        lengths = [0.0]
        for start, end in itertools.pairwise(points):
            lengths.append(lengths[-1] + distance(start, end))
        return cls(points, tuple(lengths))

    @property
    def total(self) -> float:
        return self.lengths[-1]

    def frame(self, along: float) -> tuple[Point, Point, Point]:
        """Return the clamped point, unit tangent, and unit left normal at an arc length."""
        along = min(max(along, 0.0), self.total)
        for index in range(1, len(self.lengths)):
            if along <= self.lengths[index] or index == len(self.lengths) - 1:
                start, end = self.points[index - 1], self.points[index]
                span = self.lengths[index] - self.lengths[index - 1]
                fraction = 0.0 if span <= 0.0 else (along - self.lengths[index - 1]) / span
                tangent = _unit(subtract(end, start))
                return add(start, subtract(end, start), fraction), tangent, (-tangent[1], tangent[0])
        tangent = _unit(subtract(self.points[-1], self.points[-2]))
        return self.points[-1], tangent, (-tangent[1], tangent[0])

    def nearest(self, target: Point) -> float:
        """Project a point on every segment, returning the exact nearest arc length."""
        best_along = 0.0
        best_span = math.inf
        for index, (start, end) in enumerate(itertools.pairwise(self.points)):
            run = subtract(end, start)
            length_squared = run[0] * run[0] + run[1] * run[1]
            if length_squared == 0.0:
                fraction = 0.0
            else:
                offset = subtract(target, start)
                fraction = min(1.0, max(0.0, (offset[0] * run[0] + offset[1] * run[1]) / length_squared))
            point = add(start, run, fraction)
            span = distance(target, point)
            if span < best_span:
                best_span = span
                best_along = self.lengths[index] + (self.lengths[index + 1] - self.lengths[index]) * fraction
        return best_along


def _ordered_props(props: tuple[Prop, ...]) -> tuple[Prop, ...]:
    """Restore catalog type order and contiguous ids after placement-priority ordering."""
    ordered: list[Prop] = []
    for prop_type in PROP_TYPES:
        typed = [prop for prop in props if prop.type == prop_type.token]
        ordered.extend(replace(prop, id=f"{prop_type.token}_{index}") for index, prop in enumerate(typed))
    return tuple(ordered)


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
        witness_gap: float = _WITNESS_SOLID_GAP,
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
        if any(distance_to_rectangle(witness, *rectangle) < witness_gap for witness in self.witnesses):
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
        water_margin: float = GENERATION_CONFIG.accessories.crate.water_margin,
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

    def pine_clear(self, center: Point, group: tuple[Point, ...] = ()) -> bool:
        """Whether a pine clears all solids, with only its own group using the close gap."""
        if not _inside_frame(center, PINE_RADIUS + _PINE_SOLID_GAP):
            return False
        if distance(center, self.spawn) - PINE_RADIUS < SPAWN_CLEARANCE + _SPAWN_SLACK:
            return False
        if any(distance(center, anchor) < PINE_RADIUS + _PINE_ANCHOR_GAP for anchor in self.anchors):
            return False
        if any(distance(center, threshold) < PINE_RADIUS + _PINE_ANCHOR_GAP for threshold in self.thresholds):
            return False
        if any(distance(center, witness) < PINE_RADIUS + _WITNESS_SOLID_GAP for witness in self.witnesses):
            return False
        for pine in self.pines:
            minimum = (
                2.0 * PINE_RADIUS + GENERATION_CONFIG.accessories.pine.companion_gap
                if pine.position in group
                else 2.0 * PINE_RADIUS + _PINE_SOLID_GAP
            )
            if distance(center, pine.position) < minimum:
                return False
        if any(
            distance_to_rectangle(center, building.center, building.width, building.depth, building.rotation)
            < PINE_RADIUS + _PINE_BUILDING_GAP
            for building in self.buildings
        ):
            return False
        if any(
            distance_to_rectangle(center, prop.position, *prop.footprint, prop.rotation)
            < PINE_RADIUS + _PROP_GAP
            for prop in self.props
        ):
            return False
        if any(
            distance(center, item.position) < PINE_RADIUS + item.radius + _PROP_GAP
            for item in (*self.crates, *self.posts)
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
                < PROFILE.body_radius + _BODY_CLEARANCE_SLACK
            ):
                return False
        for center, width, depth, rotation in pending_rects:
            if (
                distance_to_rectangle(point, center, width, depth, rotation)
                < PROFILE.body_radius + _BODY_CLEARANCE_SLACK
            ):
                return False
        if any(
            distance(point, item.position) < item.radius + PROFILE.body_radius + _BODY_CLEARANCE_SLACK
            for item in self.scenery()
        ):
            return False
        return all(
            distance(point, center) >= radius + PROFILE.body_radius + _BODY_CLEARANCE_SLACK
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
        toward: Point | None = None,
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
        first_angle = rotation if toward is None else heading_to(center, toward)
        for candidate_radius in radii:
            for step in range(_WITNESS_ANGLES):
                angle = first_angle + step * (360.0 / _WITNESS_ANGLES)
                offset = _heading_offset(angle)
                candidate = add(center, offset, candidate_radius)
                if distance_to_rectangle(candidate, *own) < PROFILE.body_radius + _BODY_CLEARANCE_SLACK:
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


def _pine_anchor(rng: Random, placer: _Placer, candidate: Point) -> None:
    """Place one anchor and its optional companions, skipping every invalid candidate."""
    if not placer.pine_clear(candidate):
        return
    group = [candidate]
    placer.pines.append(Scenery("pine", candidate, PINE_RADIUS))
    if rng.random() >= GENERATION_CONFIG.accessories.pine.companion_probability:
        return
    for _ in range(rng.randint(*GENERATION_CONFIG.accessories.pine.companions)):
        member = add(
            candidate,
            _polar(
                rng,
                GENERATION_CONFIG.accessories.pine.companion_distance.low,
                GENERATION_CONFIG.accessories.pine.companion_distance.high,
            ),
        )
        if not placer.pine_clear(member, tuple(group)):
            continue
        placer.pines.append(Scenery("pine", member, PINE_RADIUS))
        group.append(member)


def _road_stations(total: float, margin: float, spacing: float) -> tuple[float, ...]:
    """Enumerate bounded road stations without a quota or any random retry loop."""
    if total <= margin * 2.0:
        return ()
    stations: list[float] = []
    station = margin
    while station <= total - margin:
        stations.append(station)
        station += spacing
    return tuple(stations)


def _polar_candidates(
    rng: Random, anchor: Point, low: float, high: float, count: int
) -> tuple[tuple[Point, float], ...]:
    """Enumerate a seeded, even spiral over an annulus without repeated random retries."""
    phase = rng.uniform(0.0, 360.0)
    low_squared = low * low
    span_squared = high * high - low_squared
    return tuple(
        (
            add(
                anchor,
                _heading_offset(phase + index * _GOLDEN_ANGLE),
                math.sqrt(low_squared + span_squared * ((index + 0.5) / count)),
            ),
            (phase + index * _GOLDEN_ANGLE) % 360.0,
        )
        for index in range(count)
    )


def _centered_values(low: float, high: float, count: int) -> tuple[float, ...]:
    """Return evenly spread values, trying those nearest zero first."""
    if count == 1:
        return ((low + high) / 2.0,)
    values = tuple(low + (high - low) * index / (count - 1) for index in range(count))
    return tuple(sorted(values, key=lambda value: (abs(value), value)))


def _pines(rng: Random, placer: _Placer, network: _Network) -> None:
    """Dress road stations and selected scatter cells with independently optional pines."""
    arc = RoadArc.of(network.road.points)
    for index, station in enumerate(
        _road_stations(
            arc.total,
            GENERATION_CONFIG.accessories.pine.road_end_margin,
            GENERATION_CONFIG.accessories.pine.road_spacing,
        )
    ):
        point, _tangent, normal = arc.frame(station)
        side = 1.0 if index % 2 == 0 else -1.0
        offset = network.road.width / 2.0 + PINE_RADIUS + GENERATION_CONFIG.accessories.pine.path_edge_gap
        _pine_anchor(rng, placer, add(point, normal, side * offset))
    cell = GENERATION_CONFIG.accessories.pine.scatter_cell
    columns = math.ceil(WORLD_SIZE / cell)
    for column in range(columns):
        for row in range(columns):
            if rng.random() >= GENERATION_CONFIG.accessories.pine.scatter_probability:
                continue
            candidate = (
                min(WORLD_SIZE, (column + rng.random()) * cell),
                min(WORLD_SIZE, (row + rng.random()) * cell),
            )
            _pine_anchor(rng, placer, candidate)


def _crates(rng: Random, placer: _Placer, stall: Prop) -> bool:
    """Land one or two crates at the stall's corners, walking the corners until one fits."""
    count = rng.randint(*GENERATION_CONFIG.accessories.crate.count)
    corners = rectangle_corners(stall.position, *stall.footprint, stall.rotation)
    first = rng.randrange(4)
    placed = 0
    for offset in range(4):
        if placed == count:
            break
        corner = corners[(first + offset) % 4]
        for _ in range(_CRATE_TRIES):
            reach = CRATE_RADIUS + rng.uniform(
                GENERATION_CONFIG.accessories.crate.offset.low,
                GENERATION_CONFIG.accessories.crate.offset.high,
            )
            center = add(corner, _unit(subtract(corner, stall.position)), reach)
            if placer.circle_clear(center, CRATE_RADIUS, exempt=stall):
                placer.crates.append(Scenery("crate", center, CRATE_RADIUS))
                placed += 1
                break
    return placed >= 1


def _roadside_stall(rng: Random, placer: _Placer, road: Polyline, arc: RoadArc, anchor: Point) -> bool:
    """Use the shared road schedule when a market spot's local candidates are all blocked."""
    footprint = _footprint("stall")
    anchor_along = arc.nearest(anchor)
    stations = sorted(
        _road_stations(
            arc.total,
            GENERATION_CONFIG.accessories.stall.fallback_end_margin,
            GENERATION_CONFIG.accessories.stall.fallback_spacing,
        ),
        key=lambda station: abs(station - anchor_along),
    )
    for station in stations:
        point, direction, normal = arc.frame(station)
        if placer.stretch_wet(point, _STALL_DRY_STRETCH):
            continue
        toward = subtract(anchor, point)
        preferred = 1.0 if normal[0] * toward[0] + normal[1] * toward[1] >= 0.0 else -1.0
        for side in (preferred, -preferred):
            center = add(
                point,
                normal,
                side
                * (
                    road.width / 2.0
                    + footprint[1] / 2.0
                    + _PROP_PATH_MARGIN
                    + GENERATION_CONFIG.accessories.stall.edge_gap.low
                ),
            )
            rotation = heading_to(point, add(point, direction))
            if not placer.rect_clear(center, footprint, rotation):
                continue
            witness = placer.witness_for(center, footprint, rotation, toward=point)
            if witness is None:
                continue
            mark = placer.mark()
            stall = placer.bank("stall", center, rotation, witness)
            if _crates(rng, placer, stall):
                return True
            placer.rewind(mark)
    return False


def _stalls(rng: Random, placer: _Placer, sites: _Sites, network: _Network) -> bool:
    """Stand the stalls just off the road on their spots' sides, each with witness and crates.

    A spot fixes which stretch of road its stall serves and which side it stands on; the stall
    itself is drawn against the road that was actually threaded, so the market hugs the road the
    way the fixture's did whatever the road's meander.
    """
    footprint = _footprint("stall")
    road = network.road
    arc = RoadArc.of(road.points)
    half_depth = footprint[1] / 2.0
    samples = max(1, (_PROP_TRIES + 1) // 2)
    along_offsets = _centered_values(
        GENERATION_CONFIG.accessories.stall.arc_jitter.low,
        GENERATION_CONFIG.accessories.stall.arc_jitter.high,
        samples,
    )
    edge_gaps = _centered_values(
        GENERATION_CONFIG.accessories.stall.edge_gap.low,
        GENERATION_CONFIG.accessories.stall.edge_gap.high,
        samples,
    )
    rotation_offsets = _centered_values(
        GENERATION_CONFIG.accessories.stall.rotation_jitter.low,
        GENERATION_CONFIG.accessories.stall.rotation_jitter.high,
        samples,
    )
    stall_count = fixed_prop_count(PROP_TYPE_BY_TOKEN["stall"])
    for spot in sites.stalls[:stall_count]:
        anchor_along = arc.nearest(spot)
        for attempt in range(_PROP_TRIES):
            candidate_index = attempt // 2
            along = anchor_along + along_offsets[candidate_index]
            point, direction, normal = arc.frame(along)
            if placer.stretch_wet(point, _STALL_DRY_STRETCH):
                continue
            toward = subtract(spot, point)
            side = 1.0 if normal[0] * toward[0] + normal[1] * toward[1] >= 0.0 else -1.0
            if attempt % 2:
                side = -side
            offset = (
                road.width / 2.0
                + half_depth
                + _PROP_PATH_MARGIN
                + edge_gaps[(candidate_index * 17) % samples]
            )
            center = add(point, normal, side * offset)
            rotation = wrap_heading(
                heading_to(point, add(point, direction)) + rotation_offsets[(candidate_index * 23) % samples]
            )
            if not placer.rect_clear(center, footprint, rotation):
                continue
            witness = placer.witness_for(center, footprint, rotation, toward=point)
            if witness is None:
                continue
            mark = placer.mark()
            stall = placer.bank("stall", center, rotation, witness)
            if _crates(rng, placer, stall):
                break
            placer.rewind(mark)
        else:
            if _roadside_stall(rng, placer, road, arc, spot):
                continue
            return False
    return True


def _lanterns(rng: Random, placer: _Placer, network: _Network, sites: _Sites) -> None:
    """Follow the road with deterministic stations, skipping a blocked station outright."""
    footprint = _footprint("lantern")
    arc = RoadArc.of(network.road.points)
    market_along = arc.nearest(sites.market)
    initial_side = _drawn_side(rng)
    station = GENERATION_CONFIG.accessories.lantern.end_margin
    index = 0
    while station <= arc.total - GENERATION_CONFIG.accessories.lantern.end_margin:
        point, direction, normal = arc.frame(station)
        spacing = (
            GENERATION_CONFIG.accessories.lantern.market_spacing
            if abs(station - market_along) <= GENERATION_CONFIG.accessories.lantern.market_radius
            else GENERATION_CONFIG.accessories.lantern.spacing
        )
        if not placer.stretch_wet(point, _LANTERN_DRY_STRETCH):
            preferred = initial_side if index % 2 == 0 else -initial_side
            for side in (preferred, -preferred):
                center = add(
                    point,
                    normal,
                    side
                    * (
                        network.road.width / 2.0
                        + footprint[0] / 2.0
                        + GENERATION_CONFIG.accessories.lantern.road_edge_gap
                    ),
                )
                rotation = heading_to(point, add(point, direction))
                if not placer.rect_clear(
                    center,
                    footprint,
                    rotation,
                    path_margin=GENERATION_CONFIG.accessories.lantern.path_margin,
                    witness_gap=PROFILE.body_radius * 2.0 + 0.1,
                ):
                    continue
                witness = placer.witness_for(center, footprint, rotation, toward=point)
                if witness is None:
                    continue
                placer.bank("lantern", center, rotation, witness)
                break
        station += spacing
        index += 1


def _roadside_bench(placer: _Placer, road: Polyline, anchor: Point) -> bool:
    """Place a bench at the nearest available road station when its district anchor is crowded."""
    footprint = _footprint("bench")
    arc = RoadArc.of(road.points)
    anchor_along = arc.nearest(anchor)
    stations = sorted(
        _road_stations(
            arc.total,
            GENERATION_CONFIG.accessories.bench.fallback_end_margin,
            GENERATION_CONFIG.accessories.bench.fallback_spacing,
        ),
        key=lambda station: abs(station - anchor_along),
    )
    for station in stations:
        point, direction, normal = arc.frame(station)
        toward = subtract(anchor, point)
        preferred = 1.0 if normal[0] * toward[0] + normal[1] * toward[1] >= 0.0 else -1.0
        for side in (preferred, -preferred):
            center = add(
                point,
                normal,
                side
                * (
                    road.width / 2.0
                    + footprint[1] / 2.0
                    + _PROP_PATH_MARGIN
                    + GENERATION_CONFIG.accessories.bench.road_edge_gap
                ),
            )
            rotation = heading_to(point, add(point, direction))
            if not placer.rect_clear(center, footprint, rotation):
                continue
            witness = placer.witness_for(center, footprint, rotation, toward=point)
            if witness is None:
                continue
            placer.bank("bench", center, rotation, witness)
            return True
    return False


def _benches(rng: Random, placer: _Placer, sites: _Sites, network: _Network) -> bool:
    """Split the benches across the plaza, the market, and the inn front, every site served."""
    footprint = _footprint("bench")
    anchored = (
        (
            sites.plaza,
            (
                GENERATION_CONFIG.accessories.bench.plaza_reach.low,
                GENERATION_CONFIG.accessories.bench.plaza_reach.high,
            ),
        ),
        (
            sites.plaza,
            (
                GENERATION_CONFIG.accessories.bench.plaza_reach.low,
                GENERATION_CONFIG.accessories.bench.plaza_reach.high,
            ),
        ),
        (
            sites.market,
            (
                GENERATION_CONFIG.accessories.bench.market_reach.low,
                GENERATION_CONFIG.accessories.bench.market_reach.high,
            ),
        ),
        (
            sites.market,
            (
                GENERATION_CONFIG.accessories.bench.market_reach.low,
                GENERATION_CONFIG.accessories.bench.market_reach.high,
            ),
        ),
    )
    for anchor, reach in anchored:
        for center, _angle in _polar_candidates(rng, anchor, *reach, _PROP_TRIES):
            rotation = wrap_heading(heading_to(center, anchor) + 90.0)
            if not placer.rect_clear(center, footprint, rotation):
                continue
            witness = placer.witness_for(center, footprint, rotation, toward=anchor)
            if witness is None:
                continue
            placer.bank("bench", center, rotation, witness)
            break
        else:
            if not _roadside_bench(placer, network.road, anchor):
                return False
    inn = network.buildings[5]
    door = inn.doorway.position
    outward = _unit(subtract(door, inn.center))
    along_wall = (-outward[1], outward[0])
    for _ in range(_PROP_TRIES):
        side = _drawn_side(rng)
        center = add(
            add(
                door,
                outward,
                rng.uniform(
                    GENERATION_CONFIG.accessories.bench.inn_forward.low,
                    GENERATION_CONFIG.accessories.bench.inn_forward.high,
                ),
            ),
            along_wall,
            side
            * rng.uniform(
                GENERATION_CONFIG.accessories.bench.inn_side.low,
                GENERATION_CONFIG.accessories.bench.inn_side.high,
            ),
        )
        rotation = heading_to(door, add(door, along_wall))
        if not placer.rect_clear(center, footprint, rotation, skip_building=inn):
            continue
        witness = placer.witness_for(center, footprint, rotation, toward=door)
        if witness is None:
            continue
        placer.bank("bench", center, rotation, witness)
        return True
    return _roadside_bench(placer, network.road, door)


def _shrines(rng: Random, placer: _Placer, network: _Network) -> bool:
    """Stand each shrine on its road-bend spot with four roof posts at its corners.

    A shrine stands at the end of its own stub footpath, the last paths the network emitted in
    spot order, so that one path is exempt from the shrine's and its posts' path clearances.
    """
    footprint = _footprint("shrine")
    road = network.road
    arc = RoadArc.of(road.points)
    first_stub = len(placer.paths) - len(network.shrine_spots)
    for spot_index, spot in enumerate(network.shrine_spots):
        stub = (first_stub + spot_index,)
        along = arc.nearest(spot)
        _, direction, _normal = arc.frame(along)
        rotation = heading_to(spot, add(spot, direction))
        for _ in range(_SHRINE_TRIES):
            center = add(
                spot,
                _polar(
                    rng,
                    GENERATION_CONFIG.accessories.shrine.jitter.low,
                    GENERATION_CONFIG.accessories.shrine.jitter.high,
                ),
            )
            if not placer.rect_clear(
                center,
                footprint,
                rotation,
                path_margin=GENERATION_CONFIG.accessories.shrine.path_margin,
                skip_paths=stub,
                skip_protected=True,
            ):
                continue
            posts = rectangle_corners(
                center,
                GENERATION_CONFIG.accessories.shrine.post_size,
                GENERATION_CONFIG.accessories.shrine.post_size,
                rotation,
            )
            if not all(
                placer.circle_clear(
                    post,
                    POST_RADIUS,
                    path_margin=GENERATION_CONFIG.accessories.shrine.post_path_margin,
                    water_margin=GENERATION_CONFIG.accessories.shrine.post_water_margin,
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
    for center, angle in _polar_candidates(
        rng,
        host.position,
        GENERATION_CONFIG.accessories.board.reach.low,
        GENERATION_CONFIG.accessories.board.reach.high,
        _PROP_TRIES,
    ):
        rotation = angle
        if not placer.rect_clear(center, footprint, rotation):
            continue
        witness = placer.witness_for(center, footprint, rotation, toward=host.position)
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
            slide_limit = max(
                0.0,
                distance(start, end) / 2.0 - footprint[0] / 2.0 - GENERATION_CONFIG.accessories.plot.gap,
            )
            for _ in range(_PLOT_SLIDES):
                slide = rng.uniform(-slide_limit, slide_limit)
                center = add(
                    add(middle, along, slide),
                    outward,
                    half_depth + GENERATION_CONFIG.accessories.plot.wall_gap,
                )
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
        slide = rng.uniform(
            GENERATION_CONFIG.accessories.interior.slide.low,
            GENERATION_CONFIG.accessories.interior.slide.high,
        )
        center = add(base, along_wall, slide)
        corners = rectangle_corners(center, footprint[0], footprint[1], rotation)
        if not all(
            point_in_rectangle(corner, building.center, building.width, building.depth, building.rotation)
            for corner in corners
        ):
            continue
        rectangle = (center, footprint[0], footprint[1], rotation)
        if distance_to_rectangle(door, *rectangle) < GENERATION_CONFIG.accessories.interior.door_gap:
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
    plaza_path = (0,)
    for center, angle in _polar_candidates(
        rng,
        sites.plaza,
        GENERATION_CONFIG.accessories.pump.reach.low,
        GENERATION_CONFIG.accessories.pump.reach.high,
        _PROP_TRIES,
    ):
        rotation = angle
        if not placer.rect_clear(center, footprint, rotation, skip_paths=plaza_path):
            continue
        witness = placer.witness_for(center, footprint, rotation, toward=sites.plaza)
        if witness is None:
            continue
        placer.bank("pump", center, rotation, witness)
        return True
    return False


def _bell(rng: Random, placer: _Placer, sites: _Sites, network: _Network) -> bool:
    """Stand the bell just off the road, on the stretch nearest its drawn west spot."""
    footprint = _footprint("bell")
    road = network.road
    arc = RoadArc.of(road.points)
    anchor_along = arc.nearest(sites.bell)
    for _ in range(_PROP_TRIES):
        along = anchor_along + rng.uniform(
            GENERATION_CONFIG.accessories.bell.arc_jitter.low,
            GENERATION_CONFIG.accessories.bell.arc_jitter.high,
        )
        point, direction, normal = arc.frame(along)
        toward = subtract(sites.bell, point)
        side = 1.0 if normal[0] * toward[0] + normal[1] * toward[1] >= 0.0 else -1.0
        center = add(
            point,
            normal,
            side
            * (
                road.width / 2.0
                + footprint[0] / 2.0
                + rng.uniform(
                    GENERATION_CONFIG.accessories.bell.edge_gap.low,
                    GENERATION_CONFIG.accessories.bell.edge_gap.high,
                )
            ),
        )
        rotation = heading_to(point, add(point, direction))
        if not placer.rect_clear(
            center,
            footprint,
            rotation,
            path_margin=GENERATION_CONFIG.accessories.bell.path_margin,
        ):
            continue
        witness = placer.witness_for(center, footprint, rotation, toward=point)
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
    """Place required props first, then optional roadside dressing without redraw pressure."""
    placer = _Placer(water, sites, network, fields, reed_banks)
    if not _interior(rng, placer, network.buildings[5], "hearth"):
        return None
    if not _interior(rng, placer, network.buildings[6], "repair_bench"):
        return None
    if not _pump(rng, placer, sites):
        return None
    if not _bell(rng, placer, sites, network):
        return None
    if not _shrines(rng, placer, network):
        return None
    if not _stalls(rng, placer, sites, network):
        return None
    if not _board(rng, placer, sites):
        return None
    if not _plots(rng, placer):
        return None
    if not _benches(rng, placer, sites, network):
        return None
    mandatory_props = tuple(placer.props)
    mandatory_witnesses = tuple(placer.witnesses)
    mandatory_scenery = (*placer.crates, *placer.posts)
    _lanterns(rng, placer, network, sites)
    lantern_props = tuple(placer.props[len(mandatory_props) :])
    lantern_witnesses = tuple(placer.witnesses[len(mandatory_witnesses) :])
    _pines(rng, placer, network)
    return _Accessories(
        mandatory_props,
        lantern_props,
        mandatory_scenery,
        tuple(placer.pines),
        mandatory_witnesses,
        lantern_witnesses,
    )
