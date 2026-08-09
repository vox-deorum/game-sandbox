"""The deterministic non-platform state machine for one village day."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from math import isfinite

from .generation import build_village
from .geometry import Point, distance, heading_vector, wrap_heading
from .layout import Layout
from .perception import audible, can_see_prop, phase_at, visible
from .physics import Physics
from .prop_types import BELL_ID, BELL_RINGING, PROP_TYPE_BY_TOKEN
from .prop_use import resolve_uses, transition_states
from .rules import DAY_TICKS, EMOTES


@dataclass(frozen=True)
class DayConfig:
    seed: int = 0
    cast_size: int = 5
    daynight: bool = False

    def __post_init__(self) -> None:
        if not 1 <= self.cast_size <= 10:
            raise ValueError("cast_size must be from 1 through 10")


@dataclass(frozen=True)
class Order:
    """One character's movement and expression command for a simultaneous tick."""

    heading: float | None = None
    speed: float = 0.0
    action: str = "none"


@dataclass(frozen=True)
class Expression:
    type: str = "none"
    target: str = "none"


@dataclass
class CharacterState:
    id: str
    position: Point
    heading: float
    moved: float = 0.0
    expression: Expression = Expression()


@dataclass(frozen=True)
class PropPerception:
    id: str
    state: str


@dataclass(frozen=True)
class Perception:
    self: CharacterState
    seen: tuple[CharacterState, ...]
    nearby: tuple[CharacterState, ...]
    props: tuple[PropPerception, ...]
    bell: bool
    tick: int
    phase: str


class Day:
    """One deterministic day. Physics is the only mutable implementation dependency."""

    def __init__(self, config: DayConfig | None = None, layout: Layout | None = None) -> None:
        self.config = DayConfig() if config is None else config
        self.layout = build_village(self.config.seed) if layout is None else layout
        poses = self.layout.start_poses(self.config.cast_size)
        self.character_order = tuple(f"npc_{index}" for index in range(self.config.cast_size)) + ("visitor",)
        self.characters = {
            character_id: CharacterState(character_id, pose.position, pose.heading)
            for character_id, pose in poses.items()
        }
        self.physics = Physics(
            self.layout, {character_id: state.position for character_id, state in self.characters.items()}
        )
        self.tick = 1
        self.transitions = 0
        self.prop_states = {prop.id: PROP_TYPE_BY_TOKEN[prop.type].start for prop in self.layout.props}
        self.prop_holders: dict[str, str | None] = {prop.id: None for prop in self.layout.props}
        self.prop_timers: dict[str, int] = {prop.id: 0 for prop in self.layout.props}

    @property
    def terminal(self) -> bool:
        return self.transitions >= DAY_TICKS

    @property
    def phase(self) -> str:
        return phase_at(self.tick, self.config.daynight)

    def default_order(self, character_id: str) -> Order:
        return Order(heading=self.characters[character_id].heading)

    def _degrade(self, character_id: str, order: Order) -> Order:
        """Clamp one commanded order to the ruleset; junk values degrade like the default order."""
        heading = self.characters[character_id].heading if order.heading is None else float(order.heading)
        if not isfinite(heading):
            heading = self.characters[character_id].heading
        speed = float(order.speed)
        speed = max(0.0, min(1.0, speed)) if isfinite(speed) else 0.0
        action = order.action if order.action in {"none", "use", *EMOTES} else "none"
        return Order(wrap_heading(heading), speed, action)

    def step(self, orders: Mapping[str, Order]) -> None:
        """Resolve complete pre-tick orders, movement, then state transitions together."""
        if self.terminal:
            raise RuntimeError("the day is already complete")
        if set(orders) != set(self.character_order):
            raise ValueError("orders must cover every character exactly once")
        degraded = {
            character_id: self._degrade(character_id, orders[character_id])
            for character_id in self.character_order
        }
        previous_holders = dict(self.prop_holders)
        uses = resolve_uses(self.layout, self.characters, degraded, previous_holders, self.character_order)
        for character_id, state in self.characters.items():
            order = degraded[character_id]
            assert order.heading is not None
            state.heading = order.heading
            target = uses.targets.get(character_id)
            if target is not None:
                state.expression = Expression("use", target)
            elif order.action in EMOTES:
                state.expression = Expression(order.action, "none")
            else:
                state.expression = Expression()
        before = {character_id: state.position for character_id, state in self.characters.items()}
        velocities = {
            character_id: (
                heading_vector(self.characters[character_id].heading)[0]
                * degraded[character_id].speed
                * self.layout.ground_speed(before[character_id]),
                heading_vector(self.characters[character_id].heading)[1]
                * degraded[character_id].speed
                * self.layout.ground_speed(before[character_id]),
            )
            for character_id in self.character_order
        }
        positions = self.physics.step(
            velocities,
            {character_id for character_id, order in degraded.items() if order.speed == 0},
        )
        for character_id, state in self.characters.items():
            state.position = positions[character_id]
            state.moved = distance(before[character_id], state.position)
        self.prop_states, self.prop_timers = transition_states(
            self.prop_states, self.prop_timers, previous_holders, uses.holders
        )
        self.prop_holders = dict(uses.holders)
        self.transitions += 1
        self.tick = min(DAY_TICKS, self.tick + 1)

    def perception(self, character_id: str) -> Perception:
        """Return this character's exact post-tick rules knowledge."""
        observer = self.characters[character_id]
        character_values = tuple(self.characters.values())
        seen_ids = visible(self.layout, observer, character_values)
        nearby_ids = audible(self.layout, observer, character_values)
        seen_props = [
            PropPerception(prop.id, self.prop_states[prop.id])
            for prop in self.layout.props
            if can_see_prop(self.layout, observer, prop)
        ]
        if self.prop_states[BELL_ID] == BELL_RINGING and all(prop.id != BELL_ID for prop in seen_props):
            seen_props.append(PropPerception(BELL_ID, BELL_RINGING))
        return Perception(
            self._snapshot(observer),
            tuple(self._snapshot(self.characters[seen_id]) for seen_id in seen_ids),
            tuple(self._snapshot(self.characters[nearby_id]) for nearby_id in nearby_ids),
            tuple(seen_props),
            self.prop_states[BELL_ID] == BELL_RINGING,
            self.tick,
            self.phase,
        )

    @staticmethod
    def _snapshot(state: CharacterState) -> CharacterState:
        return CharacterState(state.id, state.position, state.heading, state.moved, state.expression)
