"""Pure match state and sequential tactical activation resolution."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from random import Random
from types import MappingProxyType

from .battlefield import Battlefield, generate_battlefield
from .combat import Strike, resolve_strike, visible_units
from .hexes import DIRECTIONS, Position
from .movement import legal_paths, walk
from .paths import MAX_PATH_STEPS
from .scoring import Result, capture_result, elimination_result, score_capture


@dataclass(frozen=True)
class UnitStats:
    hit_points: int
    movement_points: int
    attack_range: int
    damage: int
    vision: int


UNIT_STATS = {
    "footman": UnitStats(12, 2, 1, 3, 4),
    "archer": UnitStats(6, 2, 6, 2, 6),
    "cavalry": UnitStats(10, 4, 1, 3, 6),
}
COMPOSITIONS = {
    "skirmish": {"footman": 1, "archer": 1, "cavalry": 1},
    "army": {"footman": 8, "archer": 6, "cavalry": 6},
}

# Scripted sides are either a function of the match state or a fixed order per unit.
OrderSource = Callable[["Match", str], "Order"] | dict[str, "Order"]


@dataclass(frozen=True)
class MatchConfig:
    seed: int = 0
    seat_plan: str = "skirmish"
    field_extent: int = 7
    terrain: bool = False
    unit_abilities: bool = False
    messages: bool = False
    capture_zones: int = 0
    capture_target: int = 200
    round_cap: int = 1000

    def __post_init__(self) -> None:
        # generate_battlefield owns the field_extent and capture_zones bounds.
        if self.seat_plan not in COMPOSITIONS:
            raise ValueError("seat plan must be skirmish or army")
        if self.capture_target < 1:
            raise ValueError("capture target must be positive")
        if self.round_cap < 1:
            raise ValueError("round cap must be positive")

    @property
    def capture(self) -> bool:
        return self.capture_zones > 0


@dataclass
class Unit:
    unit_id: str
    side: str
    kind: str
    position: Position
    hit_points: int

    @property
    def stats(self) -> UnitStats:
        return UNIT_STATS[self.kind]


@dataclass(frozen=True)
class RosterEntry:
    unit_id: str
    side: str
    kind: str


@dataclass(frozen=True)
class Order:
    path: tuple[int, ...] = ()
    target: str | None = None

    def __post_init__(self) -> None:
        try:
            directions = tuple(self.path)
        except TypeError as error:
            raise ValueError("an order path must be an iterable of directions") from error
        object.__setattr__(self, "path", directions)
        if len(directions) > MAX_PATH_STEPS:
            raise ValueError("an order path may contain at most four steps")
        if any(type(direction) is not int or direction not in DIRECTIONS for direction in directions):
            raise ValueError("order directions must be integers from 1 through 6")
        if self.target is not None and not isinstance(self.target, str):
            raise ValueError("an order target must be a unit id or None")


def _hit_points_by_side(units: dict[str, Unit]) -> dict[str, int]:
    return {
        side: sum(unit.hit_points for unit in units.values() if unit.side == side) for side in ("red", "blue")
    }


def _nameable_targets(unit: Unit, visible: tuple[Unit, ...]) -> tuple[str, ...]:
    return tuple(other.unit_id for other in visible if other.side != unit.side)


def scripted_order(source: OrderSource, match: Match, unit_id: str) -> Order:
    """Read one order from a callable or a lookup table, defaulting to standing still."""
    return source(match, unit_id) if callable(source) else source.get(unit_id, Order())


@dataclass(frozen=True)
class Activation:
    unit_id: str
    start: Position
    end: Position
    strike: Strike | None
    killed_id: str | None


@dataclass
class Match:
    config: MatchConfig
    battlefield: Battlefield = field(init=False)
    units: dict[str, Unit] = field(init=False)
    initial_rosters: Mapping[str, tuple[RosterEntry, ...]] = field(init=False)
    starting_hit_points: dict[str, int] = field(init=False)
    capture_scores: dict[str, int] = field(default_factory=lambda: {"red": 0, "blue": 0})
    round: int = 1
    activation_order: list[str] = field(init=False)
    activation_index: int = 0
    result: Result | None = None
    history: list[Activation] = field(default_factory=list)
    battlefield_rng: Random = field(init=False, repr=False)
    match_rng: Random = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self.battlefield_rng = Random(f"{self.config.seed}:battlefield")
        self.match_rng = Random(f"{self.config.seed}:match-play")
        counts = COMPOSITIONS[self.config.seat_plan]
        self.battlefield = generate_battlefield(
            self.config.field_extent,
            self.battlefield_rng,
            terrain=self.config.terrain,
            capture_zones=self.config.capture_zones,
            units_per_side=sum(counts.values()),
        )
        self.units = {}
        for side in ("red", "blue"):
            spawn_iter = iter(self.battlefield.spawns[side])
            for kind, count in counts.items():
                for index in range(count):
                    unit_id = f"{side}_{kind}_{index}"
                    self.units[unit_id] = Unit(
                        unit_id, side, kind, next(spawn_iter), UNIT_STATS[kind].hit_points
                    )
        self.starting_hit_points = _hit_points_by_side(self.units)
        self.initial_rosters = MappingProxyType(
            {
                side: tuple(
                    RosterEntry(unit.unit_id, unit.side, unit.kind)
                    for unit in self.units.values()
                    if unit.side == side
                )
                for side in ("red", "blue")
            }
        )
        self.activation_order = self._draw_activation_order()

    def _draw_activation_order(self) -> list[str]:
        order = sorted(self.units)
        self.match_rng.shuffle(order)
        return order

    @property
    def current_unit_id(self) -> str | None:
        while self.activation_index < len(self.activation_order):
            unit_id = self.activation_order[self.activation_index]
            if unit_id in self.units:
                return unit_id
            self.activation_index += 1
        return None

    def occupied(self, except_id: str | None = None) -> set[Position]:
        return {unit.position for unit_id, unit in self.units.items() if unit_id != except_id}

    def perception(self, unit_id: str) -> dict[str, object]:
        unit = self.units[unit_id]
        visible = visible_units(unit, self.units, self.battlefield)
        walkable_paths, nameable_targets = self.legal_orders(unit_id)
        return {
            "self": {
                "unit_id": unit.unit_id,
                "type": unit.kind,
                "position": unit.position,
                "hit_points": unit.hit_points,
                "movement_points": unit.stats.movement_points,
            },
            "visible_units": tuple(
                {
                    "unit_id": other.unit_id,
                    "side": other.side,
                    "type": other.kind,
                    "position": other.position,
                    "hit_points": other.hit_points,
                }
                for other in visible
            ),
            "round": self.round,
            "capture": dict(self.capture_scores),
            "battlefield": self.battlefield.snapshot(),
            "rosters": self.initial_rosters,
            "parameters": self.config,
            "walkable_paths": walkable_paths,
            "nameable_targets": nameable_targets,
        }

    def legal_orders(self, unit_id: str) -> tuple[tuple[tuple[int, ...], ...], tuple[str, ...]]:
        unit = self.units[unit_id]
        paths = legal_paths(
            self.battlefield, unit.position, unit.stats.movement_points, self.occupied(unit_id)
        )
        return paths, _nameable_targets(unit, visible_units(unit, self.units, self.battlefield))

    def apply_order(self, order: Order) -> Activation:
        """Apply the current living unit's order, then advance match state."""
        unit_id = self.current_unit_id
        if unit_id is None:
            raise RuntimeError("there is no current activation")
        unit = self.units[unit_id]
        visible = visible_units(unit, self.units, self.battlefield)
        visible_at_activation = {other.unit_id for other in visible}
        start = unit.position
        # walk is the sole authority on path legality, so ask it rather than searching
        # the enumeration that perception uses to advertise every walkable path.
        try:
            end = walk(
                self.battlefield, start, unit.stats.movement_points, order.path, self.occupied(unit_id)
            )
        except ValueError as error:
            raise ValueError("order path is not walkable") from error
        if order.target is not None and order.target not in _nameable_targets(unit, visible):
            raise ValueError("order target is not nameable")
        unit.position = end
        strike = resolve_strike(
            unit,
            self.units,
            self.battlefield,
            self.match_rng,
            named_target=order.target,
            visible_at_activation=visible_at_activation,
            abilities=self.config.unit_abilities,
            start=start,
        )
        killed_id = None
        if strike is not None and self.units[strike.target_id].hit_points <= 0:
            killed_id = strike.target_id
            del self.units[killed_id]
        activation = Activation(unit_id, start, unit.position, strike, killed_id)
        self.history.append(activation)
        self.activation_index += 1
        self._advance_after_activation()
        return activation

    def _advance_after_activation(self) -> None:
        if self.current_unit_id is not None:
            return
        if self.config.capture:
            self.capture_scores = score_capture(self.battlefield, self.units, self.capture_scores)
        remaining = _hit_points_by_side(self.units)
        eliminated = remaining["red"] == 0 or remaining["blue"] == 0
        capture_won = self.config.capture and max(self.capture_scores.values()) >= self.config.capture_target
        capped = self.round >= self.config.round_cap
        if self.config.capture and (eliminated or capture_won or capped):
            self.result = capture_result(
                remaining,
                self.capture_scores,
                self.config.capture_target,
                capture_won=capture_won,
                capped=capped,
            )
        elif not self.config.capture and (eliminated or capped):
            self.result = elimination_result(
                remaining, self.starting_hit_points, round_cap=capped and not eliminated
            )
        if self.result is None:
            self.round += 1
            self.activation_order = self._draw_activation_order()
            self.activation_index = 0

    def run_scripted(self, orders: OrderSource, *, max_activations: int | None = None) -> Result | None:
        """Run deterministic scripted orders until completion or a requested limit."""
        count = 0
        while self.result is None and (max_activations is None or count < max_activations):
            unit_id = self.current_unit_id
            if unit_id is None:
                break
            self.apply_order(scripted_order(orders, self, unit_id))
            count += 1
        return self.result
