"""Path and target helpers for Skirmish at Crane Reach agents: the stable order encoding.

You may import this module from your ``agent.py`` (``from sandbox import crane``). Besides
``sandbox.observation_types``, it is the only piece of ``sandbox`` you are meant to use: it is
plain Python with no third-party dependencies, so it does not drag in the environment engine.
Import it at the top of ``agent.py``, not inside a method.

A path is a sequence of zero through four direction digits, each one hex step, packed into a
single stable id: :func:`encode_path` turns a digit sequence into that id and :func:`decode_path`
reverses it. The empty path (id 0) means stand still. Direction digits run clockwise from
northeast: ``1`` northeast, ``2`` east, ``3`` southeast, ``4`` southwest, ``5`` west, ``6``
northwest. A target id is one enemy unit's stable id (for example ``"blue_archer_0"``), the id you
may name so your unit's strike prefers that enemy over the automatic in-range draw.

Two accessors read the current turn's action mask, the sole authority on what is legal right now:
:func:`legal_paths` for the walkable path ids and :func:`nameable_targets` for the nameable enemy
ids. Build your order with :func:`move` (walk an encoded path) or :func:`stay` (hold your
position); either accepts an optional ``target_id``, resolved against the observation you read it
from. Neither helper checks the mask itself: pick a path from :func:`legal_paths` and a target
from :func:`nameable_targets` to keep your order legal.

Two small non-strategic utilities round the module out: :func:`distance`, hex distance between two
axial positions, and :func:`neighbors`, the six coordinates adjacent to one position (pure
coordinate math, with no field-bounds check: the mask stays the legality authority, and an
off-field neighbor is simply never offered there).

There is deliberately no pathfinder here. Turning a route toward a distant tile into a legal,
mask-checked order, and re-planning as the battlefield changes, is your own work. The full
observation and action reference lives in ``environment.md``, shipped alongside this template.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sandbox.observation_types import AxialPosition, RosterEntry, SkirmishAction, SkirmishObservation

__all__ = [
    "DIRECTIONS",
    "MAX_PATH_ID",
    "MAX_PATH_STEPS",
    "decode_path",
    "distance",
    "encode_path",
    "legal_paths",
    "move",
    "nameable_targets",
    "neighbors",
    "stay",
]

MAX_PATH_STEPS = 4
# Clockwise from northeast. These digits are part of the student contract.
DIRECTIONS: dict[int, tuple[int, int]] = {
    1: (1, -1),
    2: (1, 0),
    3: (0, 1),
    4: (-1, 1),
    5: (-1, 0),
    6: (0, -1),
}
# One id per direction sequence of each length, so 6 + 36 + 216 + 1296 = 1554 alongside id 0.
MAX_PATH_ID = sum(len(DIRECTIONS) ** length for length in range(1, MAX_PATH_STEPS + 1))


# -- the path encoding --------------------------------------------------------------------------


def encode_path(directions: tuple[int, ...] | list[int]) -> int:
    """Encode zero through four direction digits into their stable path id.

    Paths are ordered first by length, then lexically by digit, so ``encode_path([])`` is 0 and
    ``encode_path([6, 6, 6, 6])`` is the largest id, 1554. Raises ``ValueError`` for anything that
    is not zero through four digits, each one of the six direction numbers.
    """
    try:
        digits = tuple(directions)
    except TypeError as error:
        raise ValueError("a path must be an iterable of directions") from error
    if len(digits) > MAX_PATH_STEPS or any(
        type(digit) is not int or digit not in DIRECTIONS for digit in digits
    ):
        raise ValueError("a path must contain zero through four directions numbered 1 through 6")
    if not digits:
        return 0
    return (
        sum(6**power for power in range(1, len(digits)))
        + sum((digit - 1) * 6 ** (len(digits) - offset - 1) for offset, digit in enumerate(digits))
        + 1
    )


def decode_path(path_id: int) -> tuple[int, ...]:
    """Decode a stable path id back into its direction digits, the inverse of :func:`encode_path`.

    Raises ``ValueError`` unless ``path_id`` is an integer from 0 through :data:`MAX_PATH_ID`.
    """
    if isinstance(path_id, bool) or not isinstance(path_id, int) or not 0 <= path_id <= MAX_PATH_ID:
        raise ValueError(f"path id must be an integer from 0 through {MAX_PATH_ID}")
    if path_id == 0:
        return ()
    remaining = path_id - 1
    length = 1
    while remaining >= 6**length:
        remaining -= 6**length
        length += 1
    digits: list[int] = []
    for power in range(length - 1, -1, -1):
        digit, remaining = divmod(remaining, 6**power)
        digits.append(digit + 1)
    return tuple(digits)


# -- hex geometry ---------------------------------------------------------------------------------


def distance(first: AxialPosition, second: AxialPosition) -> int:
    """Return the hex distance between two axial positions."""
    dq = first["q"] - second["q"]
    dr = first["r"] - second["r"]
    return (abs(dq) + abs(dr) + abs(dq + dr)) // 2


def neighbors(position: AxialPosition) -> dict[int, AxialPosition]:
    """Return every direction digit's adjacent coordinate around ``position``.

    This is pure coordinate math: it says nothing about whether a neighbor is actually on the
    battlefield or walkable. The action mask (see :func:`legal_paths`) stays the sole legality
    authority; an off-field neighbor is simply never offered there.
    """
    return {
        digit: {"q": position["q"] + dq, "r": position["r"] + dr} for digit, (dq, dr) in DIRECTIONS.items()
    }


# -- reading the mask -----------------------------------------------------------------------------


def legal_paths(observation: SkirmishObservation) -> list[int]:
    """Return every path id legal this turn, ascending, including 0 for stay."""
    mask = observation["action_mask"]["path"]
    return [path_id for path_id, allowed in enumerate(mask) if allowed]


def _own_side(observation: SkirmishObservation) -> str:
    return observation["observation"]["self"]["unit_id"].split("_", 1)[0]


def _enemy_roster(observation: SkirmishObservation) -> tuple[RosterEntry, ...]:
    rosters = observation["observation"]["rosters"]
    return rosters["blue"] if _own_side(observation) == "red" else rosters["red"]


def nameable_targets(observation: SkirmishObservation) -> list[str]:
    """Return the ids of enemies you may name as a target this turn, in enemy roster order.

    Reads your own side from your unit id (the text before the first underscore), then the other
    side's roster, then the target mask: bit ``i + 1`` means roster slot ``i`` is nameable.
    """
    mask = observation["action_mask"]["target"]
    roster = _enemy_roster(observation)
    return [entry["unit_id"] for index, entry in enumerate(roster) if mask[index + 1]]


# -- building an order ----------------------------------------------------------------------------


def _resolve_target(target_id: str | None, observation: SkirmishObservation | None) -> int:
    if target_id is None:
        return 0
    if observation is None:
        raise ValueError("naming a target requires the observation it was read from")
    for index, entry in enumerate(_enemy_roster(observation)):
        if entry["unit_id"] == target_id:
            return index + 1
    raise ValueError(f"{target_id!r} is not an enemy unit id in this observation's roster")


def stay(target_id: str | None = None, observation: SkirmishObservation | None = None) -> SkirmishAction:
    """Return an order that holds this activation's position, optionally naming a target.

    Your unit still strikes from where it stands if an enemy ends up in range. Naming a target
    requires the ``observation`` it came from: pass one of the ids :func:`nameable_targets` returns,
    otherwise this raises ``ValueError``.
    """
    return {"path": 0, "target": _resolve_target(target_id, observation)}


def move(
    path_id: int, target_id: str | None = None, observation: SkirmishObservation | None = None
) -> SkirmishAction:
    """Return an order that walks the encoded path, optionally naming a target.

    ``path_id`` only needs to be a valid encoded id (0 through :data:`MAX_PATH_ID`, see
    :func:`decode_path`); it is not checked against the mask here, since legality depends on the
    live battlefield. Use :func:`legal_paths` to choose one that is actually walkable this turn.
    Naming a target requires the ``observation`` it came from: pass one of the ids
    :func:`nameable_targets` returns, otherwise this raises ``ValueError``.
    """
    decode_path(path_id)
    return {"path": path_id, "target": _resolve_target(target_id, observation)}
