"""Read static village ground and test routes against static collision geometry."""

# pyright: reportArgumentType=false, reportIndexIssue=false

from __future__ import annotations

from collections.abc import Mapping

from ._model import (
    GROUND_BY_CODE,
    body_clear,
    cell,
    center,
    ground,
    line_clear,
    model,
    segment_clear,
)
from .geometry import BODY_RADIUS

SPEED_LIMITS = {item["name"]: float(item["speed"]) for item in GROUND_BY_CODE.values()}


def frame(observation: Mapping[str, object]):
    """Return the village grid dimensions and cell scale, as the ``cells_x``, ``cells_y``, and
    ``cell_size`` mapping from ``observation["village"]["size"]``. ``cell_size`` arrives as a NumPy
    ``float32`` scalar."""
    return observation["village"]["size"]


def cell_at(observation: Mapping[str, object], position: Mapping[str, object]):
    """Return the zero-based grid cell a position falls in, as an ``{"x": int, "y": int}``
    mapping, or ``None`` when the position is outside the village."""
    found = cell(model(observation), position)
    return None if found is None else {"x": found[0], "y": found[1]}


def ground_at(observation: Mapping[str, object], cell_value: Mapping[str, object]) -> str | None:
    """Return the ground name under one cell, such as ``"ground"``, ``"road"``, ``"water"``, or
    ``"interior"``. ``None`` for a cell outside the village."""
    item = ground(model(observation), cell_value)
    return None if item is None else str(item["name"])


def walkable(observation: Mapping[str, object], cell_value: Mapping[str, object]) -> bool:
    """Return whether a character can stand on a cell: its ground is passable and a body the size
    of a villager clears it (no wall, water, or blocking prop)."""
    village_model = model(observation)
    point = center(village_model, cell_value)
    item = ground(village_model, cell_value)
    return (
        point is not None
        and item is not None
        and bool(item["passable"])
        and body_clear(village_model, point, BODY_RADIUS)
    )


def can_step(
    observation: Mapping[str, object], start_cell: Mapping[str, object], end_cell: Mapping[str, object]
) -> bool:
    """Return whether a character can legally move from one cardinally adjacent cell to the next:
    both cells are walkable and the body clears the path between their centres."""
    village_model = model(observation)
    start, end = center(village_model, start_cell), center(village_model, end_cell)
    if start is None or end is None:
        return False
    start_x, start_y = int(start_cell["x"]), int(start_cell["y"])
    end_x, end_y = int(end_cell["x"]), int(end_cell["y"])
    if abs(start_x - end_x) + abs(start_y - end_y) != 1:
        return False
    return (
        walkable(observation, start_cell)
        and walkable(observation, end_cell)
        and segment_clear(village_model, start, end, BODY_RADIUS)
    )


def line_of_sight(
    observation: Mapping[str, object], start_pos: Mapping[str, object], end_pos: Mapping[str, object]
) -> bool:
    """Return whether the straight line between two positions is clear, meaning no sight-blocking
    ground such as a wall lies across it. Props are not tested and doorways do not block, so this
    is "could the two points see each other, ignoring the vision cone". A position outside the
    village is never clear."""
    return line_clear(model(observation), start_pos, end_pos)


def buildings(observation: Mapping[str, object]):
    """Return every building placement in the village, each with an ``id``, ``type``, and
    ``cell``."""
    return observation["village"]["buildings"]


def building(observation: Mapping[str, object], building_id: str):
    """Return the building placement with the given id, or ``None`` when there is no such
    building."""
    return next((item for item in buildings(observation) if item["id"] == building_id), None)


def doorway(observation: Mapping[str, object], building_id: str) -> dict[str, float] | None:
    """Return the center of the doorway run nearest one building's anchor."""
    item = building(observation, building_id)
    if item is None:
        return None
    village_model = model(observation)
    if not village_model.doorways:
        return None

    anchor = (
        (float(item["cell"]["x"]) + 0.5) * village_model.cell_size,
        (float(item["cell"]["y"]) + 0.5) * village_model.cell_size,
    )

    def run_key(run: tuple[tuple[int, int], ...]):
        point = _run_center(run, village_model.cell_size)
        earliest = min(run, key=lambda value: (value[1], value[0]))
        return (point[0] - anchor[0]) ** 2 + (point[1] - anchor[1]) ** 2, earliest[1], earliest[0]

    chosen = min(village_model.doorways, key=run_key)
    x, y = _run_center(chosen, village_model.cell_size)
    return {"x": x, "y": y}


def _run_center(run: tuple[tuple[int, int], ...], cell_size: float) -> tuple[float, float]:
    return (
        sum((x + 0.5) * cell_size for x, _ in run) / len(run),
        sum((y + 0.5) * cell_size for _, y in run) / len(run),
    )


def spawn(observation: Mapping[str, object]):
    """Return the village spawn position as an ``{"x": float, "y": float}`` mapping, in metres
    from the village southwest corner. Both values arrive as NumPy ``float32`` scalars."""
    return observation["village"]["spawn"]
