"""Public-facing environment metadata and the registry entry.

These types live in the harness, not the environments package, because the harness loop and
the Stage 3 container consume them while the environments package already depends on the
harness; putting them the other way round would be an import cycle. The harness itself never
imports the environments package or PettingZoo — environments are discovered through Python
entry points and their AEC envs are used duck-typed (hence the ``Any`` factory return).

:class:`EnvironmentMeta` is pure, serialisable data — the layer the backend serves to the
frontend verbatim. :class:`EnvironmentEntry` adds the non-serialisable hooks (the factory,
the default-action provider, the overlay extractor) and is what an environment registers.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import InitVar, dataclass
from importlib.metadata import entry_points
from typing import Any, Literal, Protocol, TypeGuard, cast, runtime_checkable

#: The entry-point group every environment registers its ``ENTRY`` under.
ENTRY_POINT_GROUP = "game_sandbox.environments"

# JSON numbers lose integer precision beyond this range in JavaScript, which is part of every
# environment parameter's public contract.
_MAX_JSON_SAFE_INTEGER = 2**53 - 1
_PARAMETER_NAME = re.compile(r"^[a-z][a-z0-9_]*$")
_RESERVED_PARAMETER_NAMES = frozenset({"players", "seat_plan"})

type ParameterValue = bool | int | float | str | list[str]
"""A JSON-safe environment parameter value."""


class EnvParameterValueError(ValueError):
    """Raised when a parameter value does not satisfy its declaration."""


@dataclass(frozen=True)
class EnvParameterChoice:
    """One friendly-labelled option for a choice parameter."""

    value: str
    label: str

    def __post_init__(self) -> None:
        if not _is_nonempty_string(self.value):
            raise ValueError("parameter choice value must be a non-empty string")
        if not _is_nonempty_string(self.label):
            raise ValueError("parameter choice label must be a non-empty string")

    def to_json(self) -> dict[str, str]:
        """Return the public wire representation."""
        return {"value": self.value, "label": self.label}


@dataclass(frozen=True)
class EnvParameter:
    """A typed, player-facing gameplay parameter declared by an environment."""

    name: str
    title: str
    description: str
    type: Literal["int", "float", "string", "bool", "choice", "multi_choice"]
    default: ParameterValue
    min: int | float | None = None
    max: int | float | None = None
    choices: tuple[EnvParameterChoice, ...] = ()
    _allow_reserved: InitVar[bool] = False

    def __post_init__(self, _allow_reserved: bool) -> None:
        if not _is_parameter_name(self.name):
            raise ValueError("parameter name must be a snake_case identifier")
        if self.name in _RESERVED_PARAMETER_NAMES and not _allow_reserved:
            raise ValueError(f"{self.name!r} is reserved for the synthesized layout parameter")
        if not _is_nonempty_string(self.title):
            raise ValueError("parameter title must be a non-empty string")
        if not _is_nonempty_string(self.description):
            raise ValueError("parameter description must be a non-empty string")
        if self.type not in {"int", "float", "string", "bool", "choice", "multi_choice"}:
            raise ValueError(f"unsupported parameter type {self.type!r}")

        numeric = self.type in {"int", "float"}
        if numeric:
            if self.min is None or self.max is None:
                raise ValueError(f"{self.type} parameters require min and max")
            self._validate_numeric_bound(self.min, "min")
            self._validate_numeric_bound(self.max, "max")
            if self.min > self.max:
                raise ValueError("parameter min must be no greater than max")
        elif self.min is not None or self.max is not None:
            raise ValueError("only numeric parameters may declare min or max")

        if self.type in {"choice", "multi_choice"}:
            if not self.choices:
                raise ValueError("choice parameters require at least one choice")
            if not all(_is_parameter_choice(choice) for choice in self.choices):
                raise ValueError("parameter choices must be EnvParameterChoice instances")
            values = [choice.value for choice in self.choices]
            if len(values) != len(set(values)):
                raise ValueError("parameter choice values must be unique")
        elif self.choices:
            raise ValueError("only choice parameters may declare choices")

        # Validate the declaration eagerly, including bounds and choice membership.
        self.validate_value(self.default)

    def _validate_numeric_bound(self, value: int | float, field: str) -> None:
        if self.type == "int":
            if not is_json_safe_integer(value):
                raise ValueError(f"int parameter {field} must be a JSON-safe integer")
        elif not _is_finite_number(value):
            raise ValueError(f"float parameter {field} must be finite")

    def validate_value(self, value: object) -> ParameterValue:
        """Validate and normalize one supplied value for this declaration."""
        if self.type == "int":
            if not is_json_safe_integer(value):
                raise EnvParameterValueError(f"{self.name} must be a JSON-safe integer")
            assert isinstance(self.min, int) and isinstance(self.max, int)
            if not self.min <= value <= self.max:
                raise EnvParameterValueError(f"{self.name} must be between {self.min} and {self.max}")
            return value
        if self.type == "float":
            if not _is_finite_number(value):
                raise EnvParameterValueError(f"{self.name} must be a finite number")
            assert self.min is not None and self.max is not None
            normalized = float(value)
            if not self.min <= normalized <= self.max:
                raise EnvParameterValueError(f"{self.name} must be between {self.min} and {self.max}")
            return normalized
        if self.type == "string":
            if not isinstance(value, str):
                raise EnvParameterValueError(f"{self.name} must be a string")
            return value
        if self.type == "bool":
            if not isinstance(value, bool):
                raise EnvParameterValueError(f"{self.name} must be a boolean")
            return value
        values = {choice.value for choice in self.choices}
        if self.type == "choice":
            if not isinstance(value, str) or value not in values:
                raise EnvParameterValueError(f"{self.name} must be a declared choice value")
            return value
        if not _is_string_list(value):
            raise EnvParameterValueError(f"{self.name} must be a list of declared choice values")
        if len(value) != len(set(value)) or any(item not in values for item in value):
            raise EnvParameterValueError(f"{self.name} must be unique declared choice values")
        return [choice.value for choice in self.choices if choice.value in value]

    def to_json(self) -> dict[str, Any]:
        """Return the snake_case wire representation served by the registry.

        Only the keys a declaration's type actually uses are emitted. ``__post_init__`` already rejects
        bounds on a non-numeric type and choices on a non-choice type, so serialising them as ``null``
        and ``[]`` would put fields on the wire that the declaration is not allowed to have, and that
        the consuming TypeScript type does not model.
        """
        payload: dict[str, Any] = {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "type": self.type,
            "default": self.validate_value(self.default),
        }
        if self.type in {"int", "float"}:
            payload["min"] = self.min
            payload["max"] = self.max
        if self.type in {"choice", "multi_choice"}:
            payload["choices"] = [choice.to_json() for choice in self.choices]
        return payload


def _is_nonempty_string(value: object) -> TypeGuard[str]:
    return isinstance(value, str) and bool(value)


def _is_parameter_name(value: object) -> TypeGuard[str]:
    return isinstance(value, str) and _PARAMETER_NAME.fullmatch(value) is not None


def _is_parameter_choice(value: object) -> TypeGuard[EnvParameterChoice]:
    return isinstance(value, EnvParameterChoice)


def _is_string_list(value: object) -> TypeGuard[list[str]]:
    return isinstance(value, list) and all(isinstance(item, str) for item in cast("list[object]", value))


def is_json_safe_integer(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and abs(value) <= _MAX_JSON_SAFE_INTEGER


def _is_finite_number(value: object) -> TypeGuard[int | float]:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(float(value))
    except OverflowError:
        return False


@dataclass(frozen=True)
class PlayerBounds:
    """A player-count range where every player receives one assignable seat."""

    min: int
    max: int


@dataclass(frozen=True)
class SeatPlan:
    """One named, complete assignment of PettingZoo players to seats."""

    key: str
    title: str
    seats: tuple[tuple[int, ...], ...]


@dataclass(frozen=True)
class SeatPlans:
    """The ordered layouts an environment may select through ``seat_plan``."""

    plans: tuple[SeatPlan, ...]


type EnvironmentLayout = PlayerBounds | SeatPlans


@dataclass(frozen=True)
class ResolvedSeat:
    """One canonical seat and its ordered PettingZoo player members."""

    seat_id: str
    players: tuple[str, ...]


@dataclass(frozen=True)
class ResolvedLayout:
    """The complete, canonical seat-to-player layout for resolved parameters."""

    plan_key: str
    seats: tuple[ResolvedSeat, ...]
    player_count: int
    seat_count: int


def canonical_player_order(player_ids: Iterable[str]) -> tuple[str, ...]:
    """Sort player ids into their canonical numeric order.

    :func:`resolve_layout` names every player ``player_<index>``, but callers reach them through
    orderings that do not preserve that numbering: a mapping's key order, or a wide seat plan whose
    seats group non-adjacent players. Anything that presents players to a human or an environment
    sorts through here so one convention is applied in one place.
    """
    return tuple(sorted(player_ids, key=lambda player_id: int(player_id.removeprefix("player_"))))


@dataclass(frozen=True)
class ChatPolicy:
    """One acting player's live direct-message choices.

    ``target_recipients`` is ordered for presentation and limits direct messages only. Broadcast is
    always allowed. ``default_recipient`` is ``None`` for broadcast or one member of that tuple. The
    harness validates an environment hook's returned policy against the resolved players before
    using it.
    """

    target_recipients: tuple[str, ...]
    default_recipient: str | None


@runtime_checkable
class ChatPolicySource(Protocol):
    """A running environment that supplies live direct-message choices."""

    def chat_policy(self, sender: str) -> object: ...


def _player_count_parameter(bounds: PlayerBounds) -> EnvParameter:
    """Build the reserved declaration derived from player bounds."""
    return EnvParameter(
        name="players",
        title="Players",
        description="Number of PettingZoo players in each game.",
        type="int",
        default=bounds.max,
        min=bounds.min,
        max=bounds.max,
        _allow_reserved=True,
    )


def _seat_plan_parameter(layout: SeatPlans) -> EnvParameter:
    """Build the reserved declaration selecting one declared seat plan."""
    return EnvParameter(
        name="seat_plan",
        title="Seat plan",
        description="Seat-to-player layout for each game.",
        type="choice",
        default=layout.plans[0].key,
        choices=tuple(EnvParameterChoice(plan.key, plan.title) for plan in layout.plans),
        _allow_reserved=True,
    )


@dataclass(frozen=True)
class EnvironmentMeta:
    """The serialisable public-facing metadata for one environment.

    Field-for-field the layer described in the environment spec. ``human_timeout_ms`` is
    ``None`` when a ``pace_interval_ms`` is set, because a set pace interval is itself the
    human deadline; ``pace_interval_ms`` is ``None`` for turn-based environments.
    """

    env_id: str
    display_name: str
    description: str
    layout: EnvironmentLayout
    human_players: tuple[str, ...]
    human_timeout_ms: int | None
    recommended_episode_ticks: int
    pace_interval_ms: int | None
    step_limit_ms: int
    episode_limit_ms: int
    messaging: bool
    message_cap: int | None
    llm: bool
    renderer: str
    #: Whether two agents swapping seats produce a genuinely different game. ``True`` for a
    #: positional game (Hearts: seat order is part of play), ``False`` for a symmetric one
    #: where only the participant set matters. The Stage 6/7 multi-seat scheduler reads this to
    #: choose ordered (permutation) versus unordered (combination) seat expansion; single-player
    #: environments leave it ``False``. Defaulted so additive declaration never breaks a caller.
    seat_order_matters: bool = False
    #: Optional viewing cadence (ms) for watch/replay playback, independent of ``pace_interval_ms`` so a
    #: turn-based game (Hearts) can slow its playback without becoming realtime. ``None`` falls back to
    #: the frontend's default viewing cadence; it never affects live human stepping or scoring.
    view_interval_ms: int | None = None
    #: Optional cadence (ms) at which a *live human* turn-based session plays out the other players'
    #: moves, so a burst of fast AI replies animates one at a time instead of snapping together. The
    #: human's own move still renders the instant it arrives. ``None`` (the default, and what a realtime
    #: env like Flappy Bird keeps) means "render every frame on arrival" — today's behaviour. Distinct
    #: from ``view_interval_ms`` (spectator/replay pace, typically slower) and never affects scoring.
    live_interval_ms: int | None = None
    #: Explicit gameplay parameters. The public layout parameter is synthesized from ``layout``.
    parameters: tuple[EnvParameter, ...] = ()

    def __post_init__(self) -> None:
        _validate_layout(self.env_id, self.layout)
        names = [parameter.name for parameter in self.parameters]
        if len(names) != len(set(names)):
            raise ValueError("environment parameter names must be unique")
        collisions = sorted(set(names) & _RESERVED_PARAMETER_NAMES)
        if collisions:
            raise ValueError(f"{collisions[0]!r} is synthesized from the environment layout")

    def to_json(self) -> dict[str, Any]:
        """Return the snake_case JSON-serialisable dict the backend serves verbatim."""
        return {
            "env_id": self.env_id,
            "display_name": self.display_name,
            "description": self.description,
            "layout": _layout_to_json(self.layout),
            "human_players": list(self.human_players),
            "human_timeout_ms": self.human_timeout_ms,
            "recommended_episode_ticks": self.recommended_episode_ticks,
            "pace_interval_ms": self.pace_interval_ms,
            "step_limit_ms": self.step_limit_ms,
            "episode_limit_ms": self.episode_limit_ms,
            "messaging": self.messaging,
            "message_cap": self.message_cap,
            "llm": self.llm,
            "renderer": self.renderer,
            "seat_order_matters": self.seat_order_matters,
            "view_interval_ms": self.view_interval_ms,
            "live_interval_ms": self.live_interval_ms,
            "parameters": [parameter.to_json() for parameter in effective_parameters(self)],
        }


@dataclass(frozen=True)
class EnvironmentEntry:
    """A full environment registration: metadata plus the harness-facing hooks.

    - ``meta`` is the pure data above.
    - ``make`` receives a fully resolved parameter map and returns a fresh AEC env; the seed
      arrives at ``reset``, not here, so a factory can be called once per episode.
    - ``default_action(env, player_id)`` returns the concrete legal action, in that env's action
      space, the loop applies on every timeout path. Passing the live env lets a provider read
      current state (Hearts' lowest legal card, Spades' suggested bid) so the recording holds the
      action actually played; Flappy Bird just returns its noop (idle).
    - ``overlay`` optionally extracts the per-step overlay dict from a live env instance.
    """

    meta: EnvironmentMeta
    make: Callable[[Mapping[str, ParameterValue]], Any]
    default_action: Callable[[Any, str], Any]
    overlay: Callable[[Any], dict[str, Any]] | None = None


def effective_parameters(meta: EnvironmentMeta) -> tuple[EnvParameter, ...]:
    """Return the environment declarations with its synthesized layout parameter first."""
    if isinstance(meta.layout, PlayerBounds):
        return (_player_count_parameter(meta.layout), *meta.parameters)
    return (_seat_plan_parameter(meta.layout), *meta.parameters)


def resolve_layout(meta: EnvironmentMeta, parameters: Mapping[str, ParameterValue]) -> ResolvedLayout:
    """Resolve the canonical seat-to-player layout from a complete validated parameter map.

    This deliberately performs no defaulting. A missing, malformed, or unknown reserved value means an
    upstream caller broke the complete-parameter contract and must not silently run a different layout.
    """
    if isinstance(meta.layout, PlayerBounds):
        value = parameters.get("players")
        if not is_json_safe_integer(value) or not meta.layout.min <= value <= meta.layout.max:
            raise ValueError("resolved parameters carry no valid players value")
        seats = tuple(
            ResolvedSeat(seat_id=f"seat_{index}", players=(f"player_{index}",)) for index in range(value)
        )
        return ResolvedLayout("solo", seats, value, value)

    selected = parameters.get("seat_plan")
    if not isinstance(selected, str):
        raise ValueError("resolved parameters carry no valid seat_plan value")
    plan = next((plan for plan in meta.layout.plans if plan.key == selected), None)
    if plan is None:
        raise ValueError(f"resolved parameters select unknown seat plan {selected!r}")
    seats = tuple(
        ResolvedSeat(
            seat_id=f"seat_{seat_index}",
            players=tuple(f"player_{player_index}" for player_index in members),
        )
        for seat_index, members in enumerate(plan.seats)
    )
    player_count = sum(len(members) for members in plan.seats)
    return ResolvedLayout(plan.key, seats, player_count, len(seats))


def _layout_to_json(layout: EnvironmentLayout) -> dict[str, Any]:
    if isinstance(layout, PlayerBounds):
        return {"kind": "player_bounds", "min": layout.min, "max": layout.max}
    return {
        "kind": "seat_plans",
        "plans": [
            {"key": plan.key, "title": plan.title, "seats": [list(seat) for seat in plan.seats]}
            for plan in layout.plans
        ],
    }


def _validate_layout(env_id: str, layout: object) -> None:
    if isinstance(layout, PlayerBounds):
        if not is_json_safe_integer(layout.min) or layout.min <= 0:
            raise ValueError(f"environment {env_id!r} player bounds min must be a positive integer")
        if not is_json_safe_integer(layout.max) or layout.max <= 0:
            raise ValueError(f"environment {env_id!r} player bounds max must be a positive integer")
        if layout.min > layout.max:
            raise ValueError(f"environment {env_id!r} player bounds min must be no greater than max")
        return
    if not isinstance(layout, SeatPlans):
        raise ValueError(f"environment {env_id!r} layout must be PlayerBounds or SeatPlans")
    if not layout.plans:
        raise ValueError(f"environment {env_id!r} seat plans must not be empty")
    keys: set[str] = set()
    for plan in layout.plans:
        if not _is_parameter_name(plan.key):
            raise ValueError(f"environment {env_id!r} plan {plan.key!r} key must be snake_case")
        if plan.key in keys:
            raise ValueError(f"environment {env_id!r} plan {plan.key!r} key is duplicated")
        keys.add(plan.key)
        if not _is_nonempty_string(plan.title):
            raise ValueError(f"environment {env_id!r} plan {plan.key!r} title must be non-empty")
        if not plan.seats:
            raise ValueError(f"environment {env_id!r} plan {plan.key!r} must contain at least one seat")
        indices: list[int] = []
        for seat in plan.seats:
            if not seat:
                raise ValueError(f"environment {env_id!r} plan {plan.key!r} has an empty seat")
            if not all(is_json_safe_integer(index) and index >= 0 for index in seat):
                raise ValueError(
                    f"environment {env_id!r} plan {plan.key!r} player indices must be non-negative integers"
                )
            indices.extend(seat)
        if sorted(indices) != list(range(len(indices))):
            raise ValueError(
                f"environment {env_id!r} plan {plan.key!r} must partition players from index 0 without gaps"
            )


def resolve_parameters(
    meta: EnvironmentMeta, *layers: Mapping[str, ParameterValue]
) -> dict[str, ParameterValue]:
    """Fill defaults and apply ordered parameter override layers, raising on the first bad value.

    Use this where a partial layer is expected and a bad one should stop the caller: local play, the
    CLI, and tests. A boundary that receives an already complete map wants
    :func:`validate_complete_parameters` instead, so a missing name fails rather than silently
    resolving to a default nobody chose.
    """
    declarations = effective_parameters(meta)
    by_name = {parameter.name: parameter for parameter in declarations}
    values = {parameter.name: parameter.validate_value(parameter.default) for parameter in declarations}
    for layer in layers:
        for name, value in layer.items():
            try:
                declaration = by_name[name]
            except KeyError:
                raise EnvParameterValueError(f"unknown environment parameter {name!r}") from None
            values[name] = declaration.validate_value(value)
    return values


def validate_complete_parameters(
    meta: EnvironmentMeta, parameters: Mapping[str, ParameterValue]
) -> dict[str, ParameterValue]:
    """Validate and normalize a map that must already carry every effective parameter.

    Unlike :func:`resolve_parameters`, this applies no defaults. A launch configuration is produced by
    a caller that resolved the values already, so filling a missing name here would let an upstream bug
    run a game on a value nobody chose and then record it as though it had been chosen.
    """
    declarations = effective_parameters(meta)
    names = {declaration.name for declaration in declarations}
    for name in parameters:
        if name not in names:
            raise EnvParameterValueError(f"unknown environment parameter {name!r}")
    values: dict[str, ParameterValue] = {}
    for declaration in declarations:
        if declaration.name not in parameters:
            raise EnvParameterValueError(f"missing environment parameter {declaration.name!r}")
        values[declaration.name] = declaration.validate_value(parameters[declaration.name])
    return values


def int_parameter(parameters: Mapping[str, ParameterValue], name: str) -> int:
    """Read one integer parameter from a resolved map, narrowing its type for the caller.

    Environment factories use this rather than an ``assert``. An assert is stripped under ``python -O``,
    so the narrowing it performs would quietly disappear from an optimized run.
    """
    if name not in parameters:
        raise EnvParameterValueError(f"missing environment parameter {name!r}")
    value = parameters[name]
    if not is_json_safe_integer(value):
        raise EnvParameterValueError(f"{name} must be a JSON-safe integer")
    return value


class EnvironmentLookupError(LookupError):
    """Raised when an environment id is not registered as an installed entry point."""


def discover_environments() -> dict[str, EnvironmentEntry]:
    """Return every installed environment keyed by id, via the entry-point registry.

    Uses ``importlib.metadata`` so the harness never imports the environments package: the
    dependency arrow points one way (environments -> harness) and stays there.
    """
    found: dict[str, EnvironmentEntry] = {}
    for ep in entry_points(group=ENTRY_POINT_GROUP):
        entry = ep.load()
        if not isinstance(entry, EnvironmentEntry):
            raise TypeError(
                f"entry point {ep.name!r} in group {ENTRY_POINT_GROUP!r} loaded a "
                f"{type(entry).__name__}, expected EnvironmentEntry"
            )
        # Lookups key on the entry-point name while recordings stamp meta.env_id; a mismatch
        # would silently disagree between the registry and the recorded environment id, so it
        # is rejected at the source instead.
        if ep.name != entry.meta.env_id:
            raise ValueError(
                f"entry point {ep.name!r} in group {ENTRY_POINT_GROUP!r} registers an "
                f"environment whose meta.env_id is {entry.meta.env_id!r}; the entry-point "
                f"name and env_id must match"
            )
        found[ep.name] = entry
    return found


def load_environment(env_id: str) -> EnvironmentEntry:
    """Return the installed environment registered under ``env_id``.

    Raises :class:`EnvironmentLookupError` naming the available ids when none matches.
    """
    found = discover_environments()
    try:
        return found[env_id]
    except KeyError:
        available = ", ".join(sorted(found)) or "(none installed)"
        raise EnvironmentLookupError(
            f"no environment registered as {env_id!r}; available: {available}"
        ) from None
