"""Pre-movement prop selection, contention, and data-driven state transitions."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

from .geometry import Point, distance
from .layout import Layout, Prop
from .prop_types import PROP_TYPE_BY_TOKEN
from .rules import PROFILE


class User(Protocol):
    @property
    def id(self) -> str: ...

    @property
    def position(self) -> Point: ...


class UseOrder(Protocol):
    @property
    def speed(self) -> float: ...

    @property
    def action(self) -> str: ...


@dataclass(frozen=True)
class PropUseResolution:
    targets: Mapping[str, str]
    holders: Mapping[str, str | None]


def usable_prop(layout: Layout, position: Point) -> Prop | None:
    """Return the nearest canonical prop in reach with an unblocked rules line."""
    candidates = (
        (distance(position, prop.nearest_point(position)), index, prop)
        for index, prop in enumerate(layout.props)
        if layout.reaches_prop(position, prop, PROFILE.prop_reach)
    )
    return min(candidates, default=(0.0, 0, None), key=lambda candidate: candidate[:2])[2]


def resolve_uses(
    layout: Layout,
    characters: Mapping[str, User],
    orders: Mapping[str, UseOrder],
    previous_holders: Mapping[str, str | None],
    character_order: tuple[str, ...],
) -> PropUseResolution:
    """Resolve same-tick claims in ruleset character order from the pre-tick state."""
    holders = dict(previous_holders)
    targets: dict[str, str] = {}
    for character_id in character_order:
        order = orders[character_id]
        if order.action != "use" or order.speed > 0:
            continue
        prop = usable_prop(layout, characters[character_id].position)
        if prop is None:
            continue
        holder = previous_holders[prop.id]
        if holder is not None and holder != character_id:
            continue
        claimed = holders[prop.id]
        if claimed is not None and claimed != character_id:
            continue
        targets[character_id] = prop.id
        holders[prop.id] = character_id
    # Every non-renewed hold ends at this tick's expression-resolution point.
    for prop_id, holder in tuple(holders.items()):
        if holder is not None and targets.get(holder) != prop_id:
            holders[prop_id] = None
    return PropUseResolution(targets, holders)


def transition_states(
    states: Mapping[str, str],
    timers: Mapping[str, int],
    previous_holders: Mapping[str, str | None],
    holders: Mapping[str, str | None],
) -> tuple[dict[str, str], dict[str, int]]:
    """Advance toggle, occupancy, timed, and stateless prop state at tick end."""
    next_states = dict(states)
    next_timers = dict(timers)
    for prop_id, holder in holders.items():
        prop_type = PROP_TYPE_BY_TOKEN[prop_id.rsplit("_", 1)[0]]
        transition = prop_type.transition
        active = prop_type.states[0]
        if transition.kind == "toggle":
            if holder is not None and previous_holders[prop_id] is None:
                next_states[prop_id] = prop_type.states[1] if next_states[prop_id] == active else active
        elif transition.kind == "occupancy":
            next_states[prop_id] = active if holder is not None else prop_type.start
        elif transition.kind == "timed":
            if holder is not None:
                next_states[prop_id] = active
                assert transition.ticks is not None
                next_timers[prop_id] = transition.ticks
            elif next_timers[prop_id] > 0:
                next_timers[prop_id] -= 1
                if next_timers[prop_id] == 0:
                    next_states[prop_id] = prop_type.start
    return next_states, next_timers
