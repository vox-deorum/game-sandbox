"""Immutable village layout, its painted ground, and static collision queries."""

from __future__ import annotations

from dataclasses import dataclass, field

from .catalog import BUILDING_BY_TOKEN, PROP_BY_TOKEN, SCENERY_BY_TOKEN
from .geometry import Circle, Point, Rect, circle_intersects_circle, circle_intersects_rect
from .grid import Cell, Grid
from .rules import FRAME, GROUND_BY_CODE, PROFILE, Ground

_FACING = {"north", "east", "south", "west"}


@dataclass(frozen=True, slots=True)
class Building:
    id: str
    type: str
    cell: Cell
    facing: str


@dataclass(frozen=True, slots=True)
class PlacedProp:
    id: str
    type: str
    cell: Cell
    facing: str = "north"


@dataclass(frozen=True, slots=True)
class Scenery:
    type: str
    cell: Cell


@dataclass(frozen=True, slots=True)
class Pose:
    position: Point
    heading: float


def doorway_cells(building: Building) -> tuple[Cell, ...]:
    """Return the door run on a building's facing side, from the catalog alone."""
    kind = BUILDING_BY_TOKEN[building.type]
    x, y = building.cell
    if building.facing in {"north", "south"}:
        start = x + (kind.width - kind.door_width) // 2
        row = y + kind.height - 1 if building.facing == "north" else y
        return tuple((column, row) for column in range(start, start + kind.door_width))
    start = y + (kind.height - kind.door_width) // 2
    column = x + kind.width - 1 if building.facing == "east" else x
    return tuple((column, row) for row in range(start, start + kind.door_width))


def _rectangles(cells: set[Cell]) -> tuple[Rect, ...]:
    """Coalesce cells deterministically, producing non-overlapping maximal row runs."""
    rectangles: list[Rect] = []
    remaining = set(cells)
    while remaining:
        x, y = min(remaining, key=lambda cell: (cell[1], cell[0]))
        width = 1
        while (x + width, y) in remaining:
            width += 1
        height = 1
        while all((column, y + height) in remaining for column in range(x, x + width)):
            height += 1
        for row in range(y, y + height):
            for column in range(x, x + width):
                remaining.remove((column, row))
        rectangles.append(Rect(float(x), float(y), float(width), float(height)))
    return tuple(rectangles)


@dataclass(frozen=True, slots=True)
class Layout:
    grid: Grid
    buildings: tuple[Building, ...]
    props: tuple[PlacedProp, ...]
    scenery: tuple[Scenery, ...]
    spawn: Point
    # Static collision geometry, derived once the placements above are known to be valid.
    blocked: tuple[Rect, ...] = field(init=False, compare=False, repr=False)
    solids: tuple[Rect | Circle, ...] = field(init=False, compare=False, repr=False)

    def __post_init__(self) -> None:
        if self.grid.frame != FRAME:
            raise ValueError("layout must use the rules frame")
        if not self.grid.contains_point(self.spawn):
            raise ValueError("layout spawn is outside the grid")
        if len({building.id for building in self.buildings}) != len(self.buildings):
            raise ValueError("building ids must be unique")
        if len({prop.id for prop in self.props}) != len(self.props):
            raise ValueError("prop ids must be unique")
        for building in self.buildings:
            if building.type not in BUILDING_BY_TOKEN or building.facing not in _FACING:
                raise ValueError("building placement is invalid")
        for prop in self.props:
            if prop.type not in PROP_BY_TOKEN or prop.facing not in _FACING:
                raise ValueError("prop placement is invalid")
        if any(item.type not in SCENERY_BY_TOKEN for item in self.scenery):
            raise ValueError("scenery placement is invalid")
        for item in (*self.props, *self.scenery):
            if not self.grid.in_bounds(item.cell):
                raise ValueError("object placement is outside the grid")
        # Both tables read the placements the checks above just accepted, so they are built last.
        object.__setattr__(
            self,
            "blocked",
            _rectangles(
                {
                    (x, y)
                    for y, row in enumerate(self.grid.rows)
                    for x, code in enumerate(row)
                    if not GROUND_BY_CODE[code].passable
                }
            ),
        )
        object.__setattr__(
            self, "solids", tuple(self.shape_for(item) for item in (*self.props, *self.scenery))
        )

    def ground_at(self, point: Point) -> Ground | None:
        cell = self.grid.cell_at(point)
        return GROUND_BY_CODE[self.grid.value_at(cell)] if cell is not None else None

    def shape_for(self, item: PlacedProp | Scenery) -> Rect | Circle:
        source = PROP_BY_TOKEN[item.type] if isinstance(item, PlacedProp) else SCENERY_BY_TOKEN[item.type]
        x, y = item.cell
        if source.shape == "box":
            return Rect(float(x), float(y), float(source.width), float(source.height))
        return Circle(x + source.width / 2, y + source.height / 2, min(source.width, source.height) / 2)

    def doorway(self, building_id: str) -> tuple[Cell, ...]:
        building = next((item for item in self.buildings if item.id == building_id), None)
        if building is None:
            raise KeyError(building_id)
        return doorway_cells(building)

    def body_clear(self, point: Point, radius: float = PROFILE.body_radius) -> bool:
        """Report whether a body of this radius fits at a point, clear of every solid."""
        if radius <= 0:
            raise ValueError("a body clearance check needs a positive radius")
        if not (
            radius <= point[0] <= self.grid.frame.width - radius
            and radius <= point[1] <= self.grid.frame.height - radius
        ):
            return False
        return not any(circle_intersects_rect(point, radius, rect) for rect in self.blocked) and not any(
            circle_intersects_rect(point, radius, shape)
            if isinstance(shape, Rect)
            else circle_intersects_circle(point, radius, shape)
            for shape in self.solids
        )

    def line_clear(self, start: Point, end: Point) -> bool:
        return all(
            not GROUND_BY_CODE[self.grid.value_at(cell)].blocks_sight
            for cell in self.grid.supercover(start, end)
        )

    def residence_pose(self, home_id: str, resident: int = 0) -> Pose:
        home = next((building for building in self.buildings if building.id == home_id), None)
        if home is None or home.type != "home":
            raise KeyError(home_id)
        door = self.doorway(home.id)
        door_x = sum(cell[0] + 0.5 for cell in door) / len(door)
        door_y = sum(cell[1] + 0.5 for cell in door) / len(door)
        kind = BUILDING_BY_TOKEN[home.type]
        x, y = home.cell
        # Positions lead naturally toward the opening and keep shared homes one diameter apart.
        if home.facing in {"north", "south"}:
            position = (door_x + (resident % 2) * 0.9 - 0.45, y + kind.height / 2)
        else:
            position = (x + kind.width / 2, door_y + (resident % 2) * 0.9 - 0.45)
        headings = {"north": 90.0, "east": 0.0, "south": 270.0, "west": 180.0}
        return Pose(position, headings[home.facing])

    def village(self) -> dict[str, object]:
        """Produce a public static projection with fresh mappings for one observation.

        Every mapping is new so one player cannot reach another's observation, while the ground
        rows are shared: they are immutable strings, which the observation contract allows.
        """
        return {
            "size": {
                "cells_x": self.grid.frame.cells_x,
                "cells_y": self.grid.frame.cells_y,
                "cell_size": self.grid.frame.cell_size,
            },
            # The observation contract exposes each south-first row as one Text value.
            "ground": self.grid.rows,
            "buildings": tuple(
                {"id": item.id, "type": item.type, "cell": {"x": item.cell[0], "y": item.cell[1]}}
                for item in self.buildings
            ),
            "props": tuple(
                {
                    "id": item.id,
                    "type": item.type,
                    "cell": {"x": item.cell[0], "y": item.cell[1]},
                    "facing": item.facing,
                }
                for item in self.props
            ),
            "scenery": tuple(
                {"type": item.type, "cell": {"x": item.cell[0], "y": item.cell[1]}} for item in self.scenery
            ),
            "spawn": {"x": self.spawn[0], "y": self.spawn[1]},
        }


def paint_site(rows: list[list[str]], building: Building) -> None:
    """Paint a catalog building in-place. This is the only site-painting primitive."""
    kind = BUILDING_BY_TOKEN[building.type]
    x, y = building.cell
    if x < 1 or y < 1 or x + kind.width >= len(rows[0]) or y + kind.height >= len(rows):
        raise ValueError("building does not fit inside the frame")
    for row in range(y, y + kind.height):
        for column in range(x, x + kind.width):
            rows[row][column] = (
                "x" if column in {x, x + kind.width - 1} or row in {y, y + kind.height - 1} else "i"
            )
    for column, row in doorway_cells(building):
        rows[row][column] = "d"
