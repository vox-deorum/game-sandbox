"""Pymunk movement over the static collision truth derived from a village layout."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pymunk

from .geometry import Point, rectangle_corners
from .layout import SEGMENT_RADIUS, WORLD_SIZE, Layout
from .rules import PROFILE

SUBSTEPS = 8
_CHARACTER_MASS = 1.0
_CHARACTER_MOMENT = float("inf")


class Physics:
    """One reset-scoped physics space holding the village and every character body."""

    def __init__(self, layout: Layout, positions: Mapping[str, Point]) -> None:
        self.layout = layout
        self.space = pymunk.Space()
        self.space.gravity = (0.0, 0.0)
        self.space.damping = 1.0
        self.space.iterations = 30
        self._static_shapes: list[Any] = []
        self._character_shapes: dict[str, pymunk.Circle] = {}
        self.bodies: dict[str, pymunk.Body] = {}
        self._build_static_solids()
        for character_id, position in positions.items():
            body = pymunk.Body(_CHARACTER_MASS, _CHARACTER_MOMENT)
            body.position = position
            shape = pymunk.Circle(body, PROFILE.body_radius)
            shape.friction = 0.0
            shape.elasticity = 0.0
            self.space.add(body, shape)
            self.bodies[character_id] = body
            self._character_shapes[character_id] = shape

    def _add_segment(self, start: Point, end: Point) -> None:
        shape = pymunk.Segment(self.space.static_body, start, end, SEGMENT_RADIUS)
        shape.friction = 0.0
        shape.elasticity = 0.0
        self.space.add(shape)
        self._static_shapes.append(shape)

    def _add_circle(self, position: Point, radius: float) -> None:
        shape = pymunk.Circle(self.space.static_body, radius, position)
        shape.friction = 0.0
        shape.elasticity = 0.0
        self.space.add(shape)
        self._static_shapes.append(shape)

    def _build_static_solids(self) -> None:
        layout = self.layout
        for segment in (*layout.wall_segments, *layout.water_bank_segments):
            self._add_segment(*segment)
        for position, radius in layout.water_confluence_disks:
            self._add_circle(position, radius)
        for start, end in (
            ((0.0, 0.0), (WORLD_SIZE, 0.0)),
            ((WORLD_SIZE, 0.0), (WORLD_SIZE, WORLD_SIZE)),
            ((WORLD_SIZE, WORLD_SIZE), (0.0, WORLD_SIZE)),
            ((0.0, WORLD_SIZE), (0.0, 0.0)),
        ):
            self._add_segment(start, end)
        for prop in layout.props:
            shape = pymunk.Poly(
                self.space.static_body,
                rectangle_corners(prop.position, prop.footprint[0], prop.footprint[1], prop.rotation),
            )
            shape.friction = 0.0
            shape.elasticity = 0.0
            self.space.add(shape)
            self._static_shapes.append(shape)
        for scenery in layout.scenery:
            shape = pymunk.Circle(self.space.static_body, scenery.radius, scenery.position)
            shape.friction = 0.0
            shape.elasticity = 0.0
            self.space.add(shape)
            self._static_shapes.append(shape)

    def positions(self) -> dict[str, Point]:
        return {
            character_id: (body.position.x, body.position.y) for character_id, body in self.bodies.items()
        }

    def step(self, velocities: Mapping[str, Point], immovable: set[str]) -> dict[str, Point]:
        """Advance one tick, treating speed-zero characters as immovable for all eight substeps."""
        original_types: dict[str, int] = {}
        for character_id, body in self.bodies.items():
            if character_id in immovable:
                original_types[character_id] = body.body_type
                body.velocity = (0.0, 0.0)
                body.body_type = pymunk.Body.STATIC
                self.space.reindex_shapes_for_body(body)
            else:
                body.velocity = velocities[character_id]
        for _ in range(SUBSTEPS):
            self.space.step(1 / SUBSTEPS)
        for character_id, body in self.bodies.items():
            body.velocity = (0.0, 0.0)
            if character_id in original_types:
                body.body_type = original_types[character_id]
                # Pymunk clears mass and moment when a static body becomes dynamic. Restore the
                # character's ordinary dynamic body before the next tick can move it.
                body.mass = _CHARACTER_MASS
                body.moment = _CHARACTER_MOMENT
                self.space.reindex_shapes_for_body(body)
        return self.positions()
