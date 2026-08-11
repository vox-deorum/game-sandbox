"""Layer 2: settlement anchors scored on the terrain and the buildings standing on them."""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from random import Random
from typing import NamedTuple

from ..geometry import (
    EPSILON,
    Point,
    add,
    distance,
    distance_to_rectangle,
    distance_to_segment,
    rectangle_corners,
    segments_intersect,
    subtract,
)
from ..layout import Building, Doorway
from .config import GENERATION_CONFIG
from .terrain import _Water
from .walker import (
    _drawn_side,
    _edges,
    _inside_frame,
    _midpoint,
    _nearest_on,
    _polar,
    _Segment,
    _Terrain,
    _unit,
    _water_gap,
)

BUILDING_GAP = GENERATION_CONFIG.sites.building_gap
WATER_CLEARANCE = GENERATION_CONFIG.sites.water_clearance
BOUNDARY_MARGIN = GENERATION_CONFIG.sites.boundary_margin
HOME_CLUSTER_RADIUS = GENERATION_CONFIG.sites.home_cluster_radius
HOME_CLUSTER_SEPARATION = GENERATION_CONFIG.sites.home_cluster_separation


_PLACEMENT_BUDGET = GENERATION_CONFIG.sites.placement_budget
_ANCHOR_BUDGET = GENERATION_CONFIG.sites.anchor_budget
_SPOT_CLEARANCE = GENERATION_CONFIG.sites.spot_clearance
_SPOT_BUDGET = GENERATION_CONFIG.sites.spot_budget
_MARKET_WATER_ROOM = GENERATION_CONFIG.sites.market_water_room
_LANDMARK_WATER_ROOM = GENERATION_CONFIG.sites.landmark_water_room
_HOME_SIZE = GENERATION_CONFIG.sites.home_size
_INN_SIZE = GENERATION_CONFIG.sites.inn_size
_SHED_SIZE = GENERATION_CONFIG.sites.shed_size
_PLAZA_CLEARANCE = GENERATION_CONFIG.sites.plaza_clearance


_SITES_TRIES = GENERATION_CONFIG.sites.tries


_WEDGE_HALF_OPENING = GENERATION_CONFIG.sites.wedge_half_opening
_CLUSTER_RADIUS_LOW = GENERATION_CONFIG.sites.cluster_radius_low
_CLUSTER_RING_DEPTH = GENERATION_CONFIG.sites.cluster_ring_depth
_CLUSTER_WATER_MIN = GENERATION_CONFIG.sites.cluster_water_min
_CLUSTER_CORRIDOR_ROOM = GENERATION_CONFIG.sites.cluster_corridor_room


_WEDGE_SLIDE_LIMIT = GENERATION_CONFIG.sites.wedge_slide_limit


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
    """The fixed things every building candidate has to stand clear of.

    The spots are the round's drawn prop anchors, the stalls, the board, the bell, and the market
    center; keeping buildings off them is what leaves the accessories layer room to serve them.
    """

    water: _Water
    plaza: Point
    spots: tuple[Point, ...] = ()


_CLUSTER_GRID = tuple(
    (float(x), float(y))
    for x in range(
        GENERATION_CONFIG.sites.cluster_grid_start,
        GENERATION_CONFIG.sites.cluster_grid_stop,
        GENERATION_CONFIG.sites.cluster_grid_step,
    )
    for y in range(
        GENERATION_CONFIG.sites.cluster_grid_start,
        GENERATION_CONFIG.sites.cluster_grid_stop,
        GENERATION_CONFIG.sites.cluster_grid_step,
    )
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
        reach = water.cap_radius + GENERATION_CONFIG.sites.plaza_reach_offset
        while reach <= _WEDGE_SLIDE_LIMIT:
            candidate = add(water.fork, bisector, reach)
            opening = min(_water_gap(candidate, first), _water_gap(candidate, second))
            if opening >= _WEDGE_HALF_OPENING and _inside_frame(candidate, BOUNDARY_MARGIN):
                return candidate
            reach += GENERATION_CONFIG.sites.plaza_reach_step
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
    longer side plus the bank margin away from the water, and its half diagonal away from the
    frame. Returns None when the anchor budget runs out.
    """
    half_diagonal = math.hypot(size[0], size[1]) / 2.0
    room = max(size) / 2.0 + WATER_CLEARANCE
    for _ in range(_ANCHOR_BUDGET):
        x = rng.uniform(*band)
        side = _drawn_side(rng)
        candidate = (
            x,
            corridor_y
            + side
            * rng.uniform(
                GENERATION_CONFIG.sites.corridor_anchor_offset.low,
                GENERATION_CONFIG.sites.corridor_anchor_offset.high,
            ),
        )
        if all(
            candidate[0] < extent[0] - channel.width / 2.0 - room - EPSILON
            or extent[2] + channel.width / 2.0 + room + EPSILON < candidate[0]
            or candidate[1] < extent[1] - channel.width / 2.0 - room - EPSILON
            or extent[3] + channel.width / 2.0 + room + EPSILON < candidate[1]
            or _water_gap(candidate, channel) >= room
            for channel, extent in zip(water.channels, water.extents, strict=True)
        ) and _inside_frame(candidate, BOUNDARY_MARGIN + half_diagonal):
            return candidate
    return None


def _cluster_scores(terrain: _Terrain, water: _Water, plaza: Point) -> list[tuple[float, Point]]:
    """Score every feasible home cluster center without consuming the generation stream.

    A fixed grid is scored on bank proximity, flatness, and dryness, and the coarse channel
    polylines keep the water term cheap. A grid point only enters the running when its homes have a
    ring to stand on, clear of the water and the plaza clearing, so a cluster does not seed where
    its homes cannot follow.
    """
    stride = GENERATION_CONFIG.sites.cluster_channel_stride
    coarse = tuple(
        ((*channel.points[::stride], channel.points[-1]), channel.width / 2.0) for channel in water.channels
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
        bank = 1.0 - min(
            abs(water_gap - GENERATION_CONFIG.sites.cluster_bank_target)
            / GENERATION_CONFIG.sites.cluster_bank_band,
            1.0,
        )
        flat = 1.0 - min(
            math.hypot(*terrain.downhill(point)) * GENERATION_CONFIG.sites.cluster_slope_scale,
            1.0,
        )
        dry = 1.0 - terrain.moisture(point)
        bank_weight, flat_weight, dry_weight = GENERATION_CONFIG.sites.cluster_score_weights
        scored.append((bank_weight * bank + flat_weight * flat + dry_weight * dry, point))
    scored.sort(key=lambda entry: (-entry[0], entry[1]))
    return scored


def _pick_clusters(
    rng: Random, scored: list[tuple[float, Point]], corridor_y: float
) -> tuple[tuple[Point, ...], tuple[float, ...]] | None:
    """Draw two or three separated cluster centers, falling back from three to two when possible.

    Clusters keep off the corridor band, so homes never straddle the stretch the road threads.
    """
    count = rng.randint(*GENERATION_CONFIG.sites.cluster_count)
    centers: list[Point] = []
    for _score, point in scored:
        if len(centers) == count:
            break
        if abs(point[1] - corridor_y) < _CLUSTER_CORRIDOR_ROOM:
            continue
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
    if any(
        distance_to_rectangle(spot, center, width, depth, rotation) < _SPOT_CLEARANCE
        for spot in clearances.spots
    ):
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
    farthest = (
        reach[1] + math.hypot(*size) / 2.0 + WATER_CLEARANCE + GENERATION_CONFIG.sites.placement_prune_slack
    )
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


def _dry(water: _Water, point: Point, room: float) -> bool:
    """Whether a prop anchor keeps enough dry ground around it for its prop and witness."""
    if distance(point, water.fork) < water.cap_radius + room:
        return False
    return all(_water_gap(point, channel) >= room for channel in water.channels)


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
    for _ in range(_SITES_TRIES):
        corridor_y = water.fork[1] - rng.uniform(
            GENERATION_CONFIG.sites.corridor_below_fork.low,
            GENERATION_CONFIG.sites.corridor_below_fork.high,
        )

        shed_anchor = _corridor_anchor(
            rng,
            water,
            corridor_y,
            (GENERATION_CONFIG.sites.shed_x.low, GENERATION_CONFIG.sites.shed_x.high),
            _SHED_SIZE,
        )
        if shed_anchor is None:
            continue
        bell = None
        for _ in range(_SPOT_BUDGET):
            bell_x = rng.uniform(GENERATION_CONFIG.sites.bell_x.low, GENERATION_CONFIG.sites.bell_x.high)
            bell_side = _drawn_side(rng)
            candidate = (
                bell_x,
                corridor_y
                + bell_side
                * rng.uniform(
                    GENERATION_CONFIG.sites.bell_offset.low, GENERATION_CONFIG.sites.bell_offset.high
                ),
            )
            if _dry(water, candidate, _LANDMARK_WATER_ROOM):
                bell = candidate
                break
        if bell is None:
            continue

        market = None
        for _ in range(_SPOT_BUDGET):
            candidate = (
                rng.uniform(GENERATION_CONFIG.sites.market_x.low, GENERATION_CONFIG.sites.market_x.high),
                corridor_y,
            )
            if _dry(water, candidate, _MARKET_WATER_ROOM):
                market = candidate
                break
        if market is None:
            continue
        stall_side = _drawn_side(rng)
        stalls: list[Point] = []
        for _ in range(5):
            spot = None
            for attempt in range(_SPOT_BUDGET):
                side = stall_side if attempt < _SPOT_BUDGET // 2 else -stall_side
                stall_x = market[0] + rng.uniform(
                    GENERATION_CONFIG.sites.stall_x_offset.low,
                    GENERATION_CONFIG.sites.stall_x_offset.high,
                )
                candidate = (
                    stall_x,
                    corridor_y
                    + side
                    * rng.uniform(
                        GENERATION_CONFIG.sites.stall_offset.low, GENERATION_CONFIG.sites.stall_offset.high
                    ),
                )
                if _dry(water, candidate, _LANDMARK_WATER_ROOM):
                    spot = candidate
                    break
            if spot is None:
                break
            stalls.append(spot)
            stall_side = -stall_side
        if len(stalls) < 5:
            continue
        host = stalls[rng.randrange(5)]
        board = None
        for _ in range(_SPOT_BUDGET):
            candidate = (
                host[0]
                + rng.uniform(
                    GENERATION_CONFIG.sites.board_offset.low, GENERATION_CONFIG.sites.board_offset.high
                ),
                host[1]
                + rng.uniform(
                    GENERATION_CONFIG.sites.board_offset.low, GENERATION_CONFIG.sites.board_offset.high
                ),
            )
            if _dry(water, candidate, _LANDMARK_WATER_ROOM):
                board = candidate
                break
        if board is None:
            continue

        inn_anchor = _corridor_anchor(
            rng,
            water,
            corridor_y,
            (GENERATION_CONFIG.sites.inn_x.low, GENERATION_CONFIG.sites.inn_x.high),
            _INN_SIZE,
        )
        if inn_anchor is None:
            continue
        seeded = _pick_clusters(rng, scored, corridor_y)
        if seeded is None:
            continue
        clusters, radii = seeded
        clearances = _Clearances(water, plaza, (*stalls, board, bell, market))

        placed: list[_Placement] = []
        corridor_buildings: list[Building] = []
        for identifier, size, anchor in (("inn", _INN_SIZE, inn_anchor), ("shed", _SHED_SIZE, shed_anchor)):
            placement = _draw_placement(
                rng,
                size,
                anchor,
                (GENERATION_CONFIG.sites.building_reach.low, GENERATION_CONFIG.sites.building_reach.high),
                (GENERATION_CONFIG.sites.building_spin.low, GENERATION_CONFIG.sites.building_spin.high),
                clearances,
                placed,
            )
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
