"""The reset validation: the engine's own static space, flood filled from the spawn.

The fill runs on a 0.5 m grid. The grid's blocked cells are rasterized from the same solids the
engine's pymunk space holds, walls, water banks, the confluence cap, props, and scenery, with the
water interior sealing itself behind its blocked banks. Doorway corridors and bridge decks are
narrower than the grid, so each is probed against the pymunk space with a fine sampling along its
axis and stitched into the fill as an extra adjacency. Every target, doorway thresholds, start
poses, and prop witnesses, attaches to the flooded region through a fine-sampled straight line,
with a short quarter-step crawl as the fallback for targets standing in tight prop clusters. A
failed probe or a detached target rejects the whole village.
"""

from __future__ import annotations

import math

import pymunk

from ..geometry import (
    Point,
    add,
    distance,
    distance_to_rectangle,
    distance_to_segment,
    heading_vector,
    rectangle_corners,
    subtract,
)
from ..layout import SEGMENT_RADIUS, WORLD_SIZE, Layout
from ..physics import Physics
from ..rules import PROFILE
from .walker import _unit

_GRID = 0.5
_PROBE_STEP = 0.1
_ATTACH_REACH = 1.3
_CRAWL_STEP = 0.25
_CRAWL_REACH = 2.0
_CRAWL_LIMIT = 300
_CELLS = int(WORLD_SIZE / _GRID) + 1
_BODY_CLEARANCE = PROFILE.body_radius + SEGMENT_RADIUS + 0.02
_SOLID_CLEARANCE = PROFILE.body_radius + 0.02

type _Cell = tuple[int, int]


class _Fill:
    """A flood fill over grid cells rasterized from the layout's static solids."""

    def __init__(self, layout: Layout) -> None:
        self._space = Physics(layout, {}).space
        self._filter = pymunk.ShapeFilter()
        self._bridges = layout.bridges
        self._channels = tuple((channel.points, channel.width / 2.0) for channel in layout.channels)
        self._channel_bounds = tuple(
            (
                min(point[0] for point in points) - half,
                min(point[1] for point in points) - half,
                max(point[0] for point in points) + half,
                max(point[1] for point in points) + half,
            )
            for points, half in self._channels
        )
        self.blocked = bytearray(_CELLS * _CELLS)
        self.reached = bytearray(_CELLS * _CELLS)
        for edge in range(_CELLS):
            self.blocked[edge] = 1
            self.blocked[edge + (_CELLS - 1) * _CELLS] = 1
            self.blocked[edge * _CELLS] = 1
            self.blocked[edge * _CELLS + _CELLS - 1] = 1
        for start, end in (*layout.wall_segments, *layout.water_bank_segments):
            self._mark_segment(start, end, _BODY_CLEARANCE)
        for position, radius in layout.water_confluence_disks:
            self._mark_circle(position, radius + _SOLID_CLEARANCE)
        for prop in layout.props:
            self._mark_rectangle(prop.position, prop.footprint, prop.rotation, _SOLID_CLEARANCE)
        for scenery in layout.scenery:
            self._mark_circle(scenery.position, scenery.radius + _SOLID_CLEARANCE)

    def _cell_window(
        self, low_x: float, low_y: float, high_x: float, high_y: float
    ) -> tuple[int, int, int, int]:
        return (
            max(1, math.ceil(low_x / _GRID)),
            max(1, math.ceil(low_y / _GRID)),
            min(_CELLS - 2, math.floor(high_x / _GRID)),
            min(_CELLS - 2, math.floor(high_y / _GRID)),
        )

    def _mark_segment(self, start: Point, end: Point, reach: float) -> None:
        i_low, j_low, i_high, j_high = self._cell_window(
            min(start[0], end[0]) - reach,
            min(start[1], end[1]) - reach,
            max(start[0], end[0]) + reach,
            max(start[1], end[1]) + reach,
        )
        for column in range(i_low, i_high + 1):
            x = column * _GRID
            base = column * _CELLS
            for row in range(j_low, j_high + 1):
                if distance_to_segment((x, row * _GRID), start, end) <= reach:
                    self.blocked[base + row] = 1

    def _mark_circle(self, center: Point, reach: float) -> None:
        i_low, j_low, i_high, j_high = self._cell_window(
            center[0] - reach, center[1] - reach, center[0] + reach, center[1] + reach
        )
        for column in range(i_low, i_high + 1):
            x = column * _GRID
            base = column * _CELLS
            for row in range(j_low, j_high + 1):
                if distance((x, row * _GRID), center) <= reach:
                    self.blocked[base + row] = 1

    def _mark_rectangle(
        self, center: Point, footprint: tuple[float, float], rotation: float, reach: float
    ) -> None:
        corners = rectangle_corners(center, footprint[0], footprint[1], rotation)
        i_low, j_low, i_high, j_high = self._cell_window(
            min(corner[0] for corner in corners) - reach,
            min(corner[1] for corner in corners) - reach,
            max(corner[0] for corner in corners) + reach,
            max(corner[1] for corner in corners) + reach,
        )
        for column in range(i_low, i_high + 1):
            x = column * _GRID
            base = column * _CELLS
            for row in range(j_low, j_high + 1):
                if distance_to_rectangle((x, row * _GRID), center, *footprint, rotation) <= reach:
                    self.blocked[base + row] = 1

    def cell_open(self, cell: _Cell) -> bool:
        column, row = cell
        if not (0 <= column < _CELLS and 0 <= row < _CELLS):
            return False
        return not self.blocked[column * _CELLS + row]

    def cell_reached(self, cell: _Cell) -> bool:
        column, row = cell
        if not (0 <= column < _CELLS and 0 <= row < _CELLS):
            return False
        return bool(self.reached[column * _CELLS + row])

    def point_clear(self, point: Point) -> bool:
        """Whether a body stands clear here against the real pymunk space.

        A bridge deck carries dry ground over its channel, so deck points skip the water check and
        the deck's edge walls in the space bound them instead.
        """
        margin = PROFILE.body_radius + SEGMENT_RADIUS
        if not (margin <= point[0] <= WORLD_SIZE - margin and margin <= point[1] <= WORLD_SIZE - margin):
            return False
        wet = False
        for (points, half), bounds in zip(self._channels, self._channel_bounds, strict=True):
            if not (bounds[0] <= point[0] <= bounds[2] and bounds[1] <= point[1] <= bounds[3]):
                continue
            if any(
                distance_to_segment(point, start, end) <= half
                for start, end in zip(points, points[1:], strict=False)
            ):
                wet = True
                break
        if wet and not any(bridge.contains(point) for bridge in self._bridges):
            return False
        return self._space.point_query_nearest(point, PROFILE.body_radius, self._filter) is None

    def line_clear(self, start: Point, end: Point) -> bool:
        length = distance(start, end)
        steps = max(1, round(length / _PROBE_STEP))
        run = subtract(end, start)
        return all(self.point_clear(add(start, run, step / steps)) for step in range(steps + 1))

    def attach(self, point: Point) -> _Cell | None:
        """The nearest open cell whose center this point reaches along a clear straight line."""
        base = (round(point[0] / _GRID), round(point[1] / _GRID))
        candidates = sorted(
            ((base[0] + dx, base[1] + dy) for dx in (-2, -1, 0, 1, 2) for dy in (-2, -1, 0, 1, 2)),
            key=lambda cell: distance(point, (cell[0] * _GRID, cell[1] * _GRID)),
        )
        for cell in candidates:
            center = (cell[0] * _GRID, cell[1] * _GRID)
            if distance(point, center) > _ATTACH_REACH:
                continue
            if self.cell_open(cell) and self.line_clear(point, center):
                return cell
        return None

    def flood(self, seed: _Cell, stitches: dict[_Cell, list[_Cell]]) -> None:
        jumps: dict[int, list[int]] = {}
        for cell, neighbors in stitches.items():
            jumps[cell[0] * _CELLS + cell[1]] = [neighbor[0] * _CELLS + neighbor[1] for neighbor in neighbors]
        blocked = self.blocked
        reached = self.reached
        frontier = [seed[0] * _CELLS + seed[1]]
        reached[frontier[0]] = 1
        while frontier:
            index = frontier.pop()
            for neighbor in (index + 1, index - 1, index + _CELLS, index - _CELLS):
                if 0 <= neighbor < len(blocked) and not reached[neighbor] and not blocked[neighbor]:
                    reached[neighbor] = 1
                    frontier.append(neighbor)
            extra = jumps.get(index)
            if extra:
                for neighbor in extra:
                    if not reached[neighbor] and not blocked[neighbor]:
                        reached[neighbor] = 1
                        frontier.append(neighbor)

    def connected(self, point: Point) -> bool:
        """Whether this point stands in the flooded region.

        The straight-line attach covers nearly every target; a target hemmed in by prop clusters
        falls back to a short quarter-step crawl over the pymunk space until it touches a flooded
        cell.
        """
        base = (round(point[0] / _GRID), round(point[1] / _GRID))
        candidates = sorted(
            ((base[0] + dx, base[1] + dy) for dx in (-2, -1, 0, 1, 2) for dy in (-2, -1, 0, 1, 2)),
            key=lambda cell: distance(point, (cell[0] * _GRID, cell[1] * _GRID)),
        )
        for cell in candidates:
            center = (cell[0] * _GRID, cell[1] * _GRID)
            if distance(point, center) > _ATTACH_REACH:
                continue
            if self.cell_reached(cell) and self.line_clear(point, center):
                return True
        start = (round(point[0] / _CRAWL_STEP), round(point[1] / _CRAWL_STEP))
        start_point = (start[0] * _CRAWL_STEP, start[1] * _CRAWL_STEP)
        if not self.point_clear(start_point) or not self.line_clear(point, start_point):
            return False
        seen = {start}
        frontier = [start]
        visits = 0
        while frontier and visits < _CRAWL_LIMIT:
            node = frontier.pop()
            visits += 1
            if node[0] % 2 == 0 and node[1] % 2 == 0 and self.cell_reached((node[0] // 2, node[1] // 2)):
                return True
            for step in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                neighbor = (node[0] + step[0], node[1] + step[1])
                if neighbor in seen:
                    continue
                seen.add(neighbor)
                neighbor_point = (neighbor[0] * _CRAWL_STEP, neighbor[1] * _CRAWL_STEP)
                if distance(point, neighbor_point) > _CRAWL_REACH:
                    continue
                if self.point_clear(neighbor_point):
                    frontier.append(neighbor)
        return False


def _validated(layout: Layout, witnesses: tuple[Point, ...]) -> bool:
    """Whether every doorway threshold, start pose, and witness shares the spawn's region."""
    fill = _Fill(layout)
    stitches: dict[_Cell, list[_Cell]] = {}
    targets: list[Point] = list(witnesses)
    for building in layout.buildings:
        door = building.doorway.position
        outward = _unit(subtract(door, building.center))
        outside = add(door, outward, 0.8)
        inside = add(door, outward, -0.8)
        if not fill.line_clear(outside, inside):
            return False
        outside_cell = fill.attach(outside)
        inside_cell = fill.attach(inside)
        if outside_cell is None or inside_cell is None:
            return False
        stitches.setdefault(outside_cell, []).append(inside_cell)
        stitches.setdefault(inside_cell, []).append(outside_cell)
        targets.append(add(door, outward, 1.0))
    for bridge in layout.bridges:
        forward = heading_vector(bridge.heading)
        near = add(bridge.position, forward, -bridge.span / 2.0)
        far = add(bridge.position, forward, bridge.span / 2.0)
        if not fill.line_clear(near, far):
            return False
        near_cell = fill.attach(near)
        far_cell = fill.attach(far)
        if near_cell is None or far_cell is None:
            return False
        stitches.setdefault(near_cell, []).append(far_cell)
        stitches.setdefault(far_cell, []).append(near_cell)
    targets.extend(pose.position for pose in layout.start_poses(10).values())
    seed = fill.attach(layout.spawn)
    if seed is None:
        return False
    fill.flood(seed, stitches)
    return all(fill.connected(target) for target in targets)
