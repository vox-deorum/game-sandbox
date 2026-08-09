"""Closed-form sight, hearing, reed concealment, and day phase rules."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Protocol

from .geometry import Point, in_cone, point_in_polygon
from .layout import Layout
from .rules import OFF_PHASE, PHASES, PROFILE


class Positioned(Protocol):
    @property
    def id(self) -> str: ...

    @property
    def position(self) -> Point: ...


class Facing(Positioned, Protocol):
    @property
    def heading(self) -> float: ...


def reed_bank(layout: Layout, point: Point) -> int | None:
    """Return the containing reed-bank identity, if any."""
    return next(
        (index for index, bank in enumerate(layout.reed_banks) if point_in_polygon(point, bank)), None
    )


def _in_sight(layout: Layout, observer: Facing, target: Positioned) -> bool:
    """Apply the shared range, cone, and wall rules for sight."""
    return in_cone(
        observer.position,
        observer.heading,
        target.position,
        PROFILE.vision_degrees,
        PROFILE.vision_range,
    ) and not layout.line_blocked(observer.position, target.position)


def can_see(layout: Layout, observer: Facing, target: Positioned) -> bool:
    """Apply sight rules for characters, including asymmetric reed concealment."""
    target_bank = reed_bank(layout, target.position)
    if target_bank is not None and target_bank != reed_bank(layout, observer.position):
        return False
    return _in_sight(layout, observer, target)


def can_see_prop(layout: Layout, observer: Facing, target: Positioned) -> bool:
    """Apply sight rules for props, which reeds do not conceal."""
    return _in_sight(layout, observer, target)


def can_hear(layout: Layout, observer: Positioned, target: Positioned) -> bool:
    """Apply the all-facing hearing range and wall rule."""
    return layout.reaches(observer.position, target.position, PROFILE.hearing_range)


def visible(layout: Layout, observer: Facing, candidates: Iterable[Positioned]) -> tuple[str, ...]:
    return tuple(
        candidate.id
        for candidate in candidates
        if candidate.id != observer.id and can_see(layout, observer, candidate)
    )


def audible(layout: Layout, observer: Positioned, candidates: Iterable[Positioned]) -> tuple[str, ...]:
    return tuple(
        candidate.id
        for candidate in candidates
        if candidate.id != observer.id and can_hear(layout, observer, candidate)
    )


def phase_at(tick: int, daynight: bool) -> str:
    """Return the configured day phase, or the fixed off-variant phase."""
    if not daynight:
        return OFF_PHASE
    return next(phase.name for phase in PHASES if phase.start <= tick <= phase.end)
