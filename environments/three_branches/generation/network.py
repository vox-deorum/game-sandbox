"""Layer 3: the road threaded across the channels, the footpaths, and the spawn."""

from __future__ import annotations

import itertools
import math
from collections.abc import Iterator
from dataclasses import dataclass, replace
from random import Random

from ..geometry import (
    EPSILON,
    Point,
    add,
    distance,
    distance_to_rectangle,
    distance_to_segment,
    heading_to,
    polyline_distance,
    rectangle_corners,
    segments_intersect,
    subtract,
)
from ..layout import WORLD_SIZE, Bridge, Building, Polyline
from .config import GENERATION_CONFIG
from .gardens import Rectangle, plot_rectangles
from .sites import BUILDING_GAP, _doorway, _Sites
from .terrain import _Water
from .walker import (
    _angled,
    _coarse,
    _draw_weights,
    _drawn_side,
    _edges,
    _inside_frame,
    _leg_limit,
    _midpoint,
    _nearest_on,
    _resample,
    _Segment,
    _self_intersects,
    _Terrain,
    _thread,
    _unit,
    _walk,
    _water_gap,
)

SPAWN_CLEARANCE = GENERATION_CONFIG.network.spawn_clearance


_DECK_APRON = GENERATION_CONFIG.network.deck_apron
_DRY_MARGIN = GENERATION_CONFIG.network.dry_margin
_CROSSING_BAND = GENERATION_CONFIG.network.crossing_band
_CROSSING_FORK_GAP = GENERATION_CONFIG.network.crossing_fork_gap
_JUNCTION_DECK_GAP = GENERATION_CONFIG.network.junction_deck_gap
_ROUTE_GAP = GENERATION_CONFIG.network.route_gap
_ROAD_TRIES = GENERATION_CONFIG.network.road_tries


_NETWORK_TRIES = GENERATION_CONFIG.network.network_tries


_FOOTPATH_TRIES = GENERATION_CONFIG.network.footpath_tries
_FOOTPATH_REDRAWS = GENERATION_CONFIG.network.footpath_redraws


_SHRINE_CLEARANCE = GENERATION_CONFIG.network.shrine_clearance
_SHRINE_SEPARATION = GENERATION_CONFIG.network.shrine_separation


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


def _rings(buildings: tuple[Building, ...], *, include_gardens: bool = True) -> tuple[tuple[Point, ...], ...]:
    """Closed building and reserved-garden rings the walker steers around."""
    rings: list[tuple[Point, ...]] = []
    rectangles = tuple(
        (building.center, building.width, building.depth, building.rotation) for building in buildings
    )
    if include_gardens:
        rectangles += plot_rectangles(buildings)
    for rectangle in rectangles:
        corners = rectangle_corners(*rectangle)
        rings.append((*corners, corners[0]))
    return tuple(rings)


def _water_reach(origin: Point, direction: Point, channel: Polyline) -> float | None:
    """How far a channel's water band extends from a centerline point along a crossing direction."""
    half = channel.width / 2.0
    low = 0.0
    high = GENERATION_CONFIG.network.water_reach_step
    while (
        high <= GENERATION_CONFIG.network.water_reach_limit
        and polyline_distance(add(origin, direction, high), channel.points) <= half
    ):
        low = high
        high += GENERATION_CONFIG.network.water_reach_step
    if high > GENERATION_CONFIG.network.water_reach_limit:
        return None
    for _ in range(GENERATION_CONFIG.network.water_reach_refinements):
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
    for band in (
        _CROSSING_BAND,
        GENERATION_CONFIG.network.crossing_band_multiplier * _CROSSING_BAND,
    ):
        candidates: list[tuple[Point, Point]] = []
        for index in range(1, len(channel.points) - 1):
            point = channel.points[index]
            if abs(point[1] - corridor_y) > band:
                continue
            if (
                not max(GENERATION_CONFIG.network.crossing_min_x, minimum_x)
                <= point[0]
                <= (WORLD_SIZE - GENERATION_CONFIG.network.crossing_edge_margin)
            ):
                continue
            if distance(point, fork) < _CROSSING_FORK_GAP:
                continue
            along = _unit(subtract(channel.points[index + 1], channel.points[index - 1]))
            normal = (-along[1], along[0])
            if normal[0] < 0.0:
                normal = (-normal[0], -normal[1])
            if normal[0] < GENERATION_CONFIG.network.crossing_min_normal_x:
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
        if not _inside_frame(endpoint, GENERATION_CONFIG.network.deck_frame_margin):
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
    bridge = Bridge(
        _midpoint(near, far),
        heading_to(near, far),
        rng.uniform(GENERATION_CONFIG.network.deck_width.low, GENERATION_CONFIG.network.deck_width.high),
        distance(near, far),
    )
    if bridge.distance_to(water.fork) <= water.cap_radius + GENERATION_CONFIG.network.deck_fork_gap:
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
        margin = other.width / 2.0 + GENERATION_CONFIG.network.deck_sibling_margin
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
    """Whether a course crosses into a building or reserved garden rectangle."""
    segments = tuple(itertools.pairwise(points))
    segment_bounds = tuple(
        (min(start[0], end[0]), min(start[1], end[1]), max(start[0], end[0]), max(start[1], end[1]))
        for start, end in segments
    )
    rectangles: tuple[Rectangle, ...] = (
        *((building.center, building.width, building.depth, building.rotation) for building in buildings),
        *plot_rectangles(buildings),
    )
    for rectangle in rectangles:
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
    points: tuple[Point, ...],
    half_width: float,
    buildings: tuple[Building, ...],
    *,
    include_gardens: bool = True,
) -> bool:
    """Whether every building and reserved garden keeps its rectangle off the road surface."""
    margin = half_width + _ROUTE_GAP
    segments = tuple(itertools.pairwise(points))
    segment_bounds = tuple(
        (min(start[0], end[0]), min(start[1], end[1]), max(start[0], end[0]), max(start[1], end[1]))
        for start, end in segments
    )
    rectangles = tuple(
        (building.center, building.width, building.depth, building.rotation) for building in buildings
    )
    if include_gardens:
        rectangles += plot_rectangles(buildings)
    for rectangle in rectangles:
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
        if any(
            existing.distance_to(vertex) < GENERATION_CONFIG.network.footpath_deck_vertex_gap
            for existing in decks
        ):
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
            existing.distance_to(deck.position) < GENERATION_CONFIG.network.footpath_deck_gap
            or deck.distance_to(existing.position) < GENERATION_CONFIG.network.footpath_deck_gap
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
    del candidates[GENERATION_CONFIG.network.junction_candidate_limit :]
    dry: list[int] = []
    wet: list[tuple[int, int]] = []
    for index in candidates:
        crossings = _straight_crossings((road.points[index], target), water)
        if not crossings:
            dry.append(index)
        elif len(crossings) == 1 and crossings[0] != 0 and crossings[0] not in bridged:
            wet.append((index, crossings[0]))
    for _ in range(_FOOTPATH_REDRAWS):
        weights = _draw_weights(rng, GENERATION_CONFIG.network.footpath_weights)
        width = rng.uniform(
            GENERATION_CONFIG.network.footpath_width.low, GENERATION_CONFIG.network.footpath_width.high
        )
        swing = rng.uniform(
            GENERATION_CONFIG.network.footpath_swing.low, GENERATION_CONFIG.network.footpath_swing.high
        )
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
                repel_radius=GENERATION_CONFIG.network.footpath_repel_radius,
                limit=_leg_limit(junction, target),
            )
            if course is None:
                continue
            points = _resample(course)
            if (
                _self_intersects(points)
                or _pierces_building(points, buildings)
                or not _road_clears_buildings(points, width / 2.0, buildings)
            ):
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
                    repel_radius=GENERATION_CONFIG.network.footpath_repel_radius,
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
                    repel_radius=GENERATION_CONFIG.network.footpath_repel_radius,
                    limit=_leg_limit(far, target),
                )
                if second is None:
                    continue
                points = _thread([first, second], [vertex])
                if (
                    points is None
                    or _self_intersects(points)
                    or _pierces_building(points, buildings)
                    or not _road_clears_buildings(points, width / 2.0, buildings)
                ):
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
    footpaths: tuple[Polyline, ...],
) -> tuple[tuple[Point, ...], tuple[Polyline, ...]] | None:
    """Stand a shrine spot just off the road at each of the two sharpest free bends, with its stub.

    A spot keeps clear of every footpath band, so the accessories layer has room to stand the
    shrine and its roof posts on it.
    """
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
            spot = add(
                vertex,
                normal,
                orientation
                * (
                    road.width / 2.0
                    + rng.uniform(
                        GENERATION_CONFIG.network.shrine_offset.low,
                        GENERATION_CONFIG.network.shrine_offset.high,
                    )
                ),
            )
            if not _inside_frame(spot, GENERATION_CONFIG.network.shrine_frame_margin):
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
            if any(deck.distance_to(spot) < BUILDING_GAP for deck in decks):
                continue
            if any(
                polyline_distance(spot, path.points) < path.width / 2.0 + _SHRINE_CLEARANCE
                for path in footpaths
            ):
                continue
            spots.append(spot)
            stubs.append(
                Polyline(
                    (vertex, spot),
                    rng.uniform(
                        GENERATION_CONFIG.network.shrine_path_width.low,
                        GENERATION_CONFIG.network.shrine_path_width.high,
                    ),
                )
            )
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
    """Whether the spawn clearance disk is free of every building.

    The accessories layer holds every prop and scenery placement off the same disk, so the
    building check is the only one the network needs.
    """
    rectangles: tuple[Rectangle, ...] = (
        *((building.center, building.width, building.depth, building.rotation) for building in buildings),
        *plot_rectangles(buildings),
    )
    return all(distance_to_rectangle(spawn, *rectangle) >= SPAWN_CLEARANCE for rectangle in rectangles)


def _threaded_road(
    rng: Random,
    terrain: _Terrain,
    water: _Water,
    sites: _Sites,
    avoid: tuple[tuple[Point, ...], ...],
) -> tuple[Polyline, list[Bridge]] | None:
    """One attempt at the road: entry to exit through a drawn crossing and deck per channel."""
    entry = (
        0.0,
        sites.corridor_y
        + rng.uniform(
            GENERATION_CONFIG.network.road_edge_offset.low, GENERATION_CONFIG.network.road_edge_offset.high
        ),
    )
    exit_point = (
        WORLD_SIZE,
        sites.corridor_y
        + rng.uniform(
            GENERATION_CONFIG.network.road_edge_offset.low, GENERATION_CONFIG.network.road_edge_offset.high
        ),
    )
    weights = _draw_weights(rng, GENERATION_CONFIG.network.road_weights)
    heading = _angled(
        (1.0, 0.0),
        rng.uniform(GENERATION_CONFIG.network.road_heading.low, GENERATION_CONFIG.network.road_heading.high),
    )

    road_decks: list[Bridge] = []
    legs: list[list[Point]] = []
    joints: list[Point] = []
    position = entry
    minimum_x = 0.0
    for channel in water.channels[1:]:
        spanned: tuple[Bridge, Point, Point] | None = None
        vertex: Point
        axis: Point
        for _ in range(GENERATION_CONFIG.network.crossing_draws):
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
            repel_radius=GENERATION_CONFIG.network.road_repel_radius,
            limit=_leg_limit(position, near),
        )
        if leg is None or _pierces_building(tuple(leg), sites.buildings):
            return None
        legs.append(leg)
        joints.append(vertex)
        road_decks.append(deck)
        position = far
        heading = axis
        minimum_x = vertex[0] + GENERATION_CONFIG.network.crossing_min_gap
    last = _walk(
        terrain,
        position,
        exit_point,
        weights,
        heading,
        avoid,
        repel_radius=GENERATION_CONFIG.network.road_repel_radius,
        limit=_leg_limit(position, exit_point),
    )
    if last is None or _pierces_building(tuple(last), sites.buildings):
        return None
    legs.append(last)
    course = _thread(legs, joints)
    if course is None:
        return None
    road = Polyline(
        course,
        rng.uniform(GENERATION_CONFIG.network.road_width.low, GENERATION_CONFIG.network.road_width.high),
    )
    if _self_intersects(road.points):
        return None
    if _wet_off_deck(road.points, water, road_decks):
        return None
    if not _road_clears_buildings(
        road.points,
        road.width / 2.0,
        sites.buildings,
        include_gardens=False,
    ):
        return None
    return road, road_decks


def _network_layer(
    rng: Random,
    terrain: _Terrain,
    water: _Water,
    sites: _Sites,
) -> _Network | None:
    """Thread the road across the channels, hang the footpaths off it, and fix the spawn.

    The road uses ten attempts, each drawing entry and exit offsets, weights, heading, crossings,
    deck widths, and road width. A successful road then anchors two network rounds. Each round
    redraws every footpath, its possible deck widths, the shrine, and checks the spawn. Doorway
    re-aiming draws nothing and runs only after a complete round succeeds.
    """
    road_avoid = (*_coarse(water.channels), *_rings(sites.buildings, include_gardens=False))
    avoid = (*_coarse(water.channels), *_rings(sites.buildings))
    threaded = None
    for _ in range(_ROAD_TRIES):
        threaded = _threaded_road(rng, terrain, water, sites, road_avoid)
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
            shrined = _shrine_stubs(rng, road, decks, used, water, sites.buildings, tuple(footpaths))
            if shrined is None:
                continue
            spots, stubs = shrined
            footpaths.extend(stubs)

            spawn = _spawn_point(road)
            if spawn is None or not _spawn_clear(spawn, sites.buildings):
                continue
            buildings = _aimed_at_paths(sites.buildings, (road, *footpaths))
            if not _road_clears_buildings(road.points, road.width / 2.0, buildings) or any(
                not _road_clears_buildings(path.points, path.width / 2.0, buildings) for path in footpaths
            ):
                continue
            return _Network(road, tuple(footpaths), tuple(decks), spawn, spots, buildings)
    return None
