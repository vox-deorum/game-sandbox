"""Footpaths, which are searched rather than walked.

The road is carved by a walker because its shape is the village's spine. A footpath is the opposite:
somebody wore it in going somewhere, so it takes the cheapest way there. One weighted search over
cells answers both questions this module is asked. ``reachable`` asks whether somewhere could ever
be joined to the road, which is what lets a building site reject a doorway before it is painted.
``lay_footpaths`` asks for the route itself and paints it.

Every road and bridge cell is a source at no cost, so a route is a spur off the nearest useful part
of the road rather than a line from one chosen point. Ground speed is the cost, which sends paths
around reed and field rather than through them, and an existing path is discounted, which is what
makes two spurs share a stretch instead of running side by side.

Ground class alone is the same everywhere open, and the cheapest way across ground that costs the
same everywhere is a straight line. So the terrain counts too: wet, uneven going costs more, and a
route bends around it the way a worn path does.

Nothing here draws from the stream. The search is deterministic, and ties break on the cell.
"""

from __future__ import annotations

import heapq
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from math import sqrt

from ..grid import Cell
from ..rules import FRAME, GROUND_BY_CODE
from . import carve
from .config import Path, Retry
from .water import Water

# How hard the going is per cell, in the unit range the noise fields are normalised to.
Terrain = list[list[float]]

# Ground a footpath may run over. Interiors, walls, and doorways are not routes: a path stops at the
# approach cell outside a door, and the door run itself is painted with the site.
_WALKABLE = frozenset({"r", "p", "b", "g", "f", "e"})
# Ground a footpath may paint itself over. Everything else already carries people.
_PAINTABLE = frozenset({"g", "f", "e"})
# Ground that already carries people, which is where every committed search starts.
_JOINABLE = frozenset({"r", "b", "p"})
# Steps a route may take, with what each costs in cell lengths. A footpath only repaints ground
# that already carries a body, so it may cut a corner; water is only ever crossed square on.
_STEPS = (
    (0, -1, 1.0),
    (-1, 0, 1.0),
    (1, 0, 1.0),
    (0, 1, 1.0),
    (-1, -1, sqrt(2.0)),
    (1, -1, sqrt(2.0)),
    (-1, 1, sqrt(2.0)),
    (1, 1, sqrt(2.0)),
)
# Recorded on a move that stepped rather than bridged.
_NO_CHANNEL = -1


@dataclass(frozen=True, slots=True)
class Crossing:
    """One channel a committed footpath bridged, and the water it bridged."""

    channel: int
    cells: tuple[Cell, ...]


@dataclass(frozen=True, slots=True)
class Footpaths:
    """Everything the footpath stage committed."""

    cells: frozenset[Cell]
    crossings: tuple[Crossing, ...]


def _sources(rows: list[list[str]]) -> tuple[Cell, ...]:
    """Every cell a committed footpath may leave from: the road, and any path already worn.

    A route joins the nearest way that already goes somewhere rather than always running its own
    line back to the road, which is what makes the footpaths a branching network instead of a set
    of private spurs.
    """
    return tuple((x, y) for y, row in enumerate(rows) for x, code in enumerate(row) if code in _JOINABLE)


def joinable(
    rows: list[list[str]], courses: Water, effort: Terrain, starts: Iterable[Cell], tuning: Path
) -> frozenset[Cell]:
    """Return every cell a footpath could ever reach from the given ground.

    Settlement asks this once, before it stands anything, and then a candidate doorway only has to
    be a member. The road is not walked yet, so the question is asked of the road's band, which the
    road is going to span. Buildings placed afterwards only ever add obstacles, so this is the
    optimistic answer; the committed routing is what has the last word.
    """
    channels = {cell: index for index, channel in enumerate(courses.channels) for cell in channel}
    seen: set[Cell] = {cell for cell in starts if _inside(cell) and rows[cell[1]][cell[0]] in _WALKABLE}
    pending = list(seen)
    while pending:
        cell = pending.pop()
        for spot, _, _, _ in _moves(rows, courses, effort, channels, cell, frozenset(), frozenset(), tuning):
            if spot not in seen:
                seen.add(spot)
                pending.append(spot)
    return frozenset(seen)


def lay_footpaths(
    rows: list[list[str]],
    courses: Water,
    effort: Terrain,
    targets: tuple[tuple[Cell, ...], ...],
    forbidden: frozenset[Cell],
    tuning: Path,
) -> Footpaths:
    """Route and paint one footpath to each target group, in the order given.

    Each route is committed before the next is searched, so later routes see the paths already
    painted and reuse them. A channel one route bridged is closed to the rest, which is what holds
    every channel to at most one footpath crossing.
    """
    painted: set[Cell] = set()
    crossings: list[Crossing] = []
    for group in targets:
        wanted = frozenset(group)
        if not wanted:
            continue
        found = _search(
            rows,
            courses,
            effort,
            _sources(rows),
            wanted.__contains__,
            forbidden,
            frozenset(crossing.channel for crossing in crossings),
            tuning,
        )
        if found is None:
            raise Retry("a footpath target could not be reached from the road")
        cells, crossed = _commit(rows, found, tuning)
        painted.update(cells)
        crossings.extend(crossed)
        # A route arrives at one cell of a doorway's approach. The rest of it is the same doorstep,
        # so it is worn too, and the whole run opens onto path rather than half of it.
        for cell in sorted(wanted):
            if rows[cell[1]][cell[0]] in _PAINTABLE:
                rows[cell[1]][cell[0]] = "p"
                painted.add(cell)
    return Footpaths(frozenset(painted), tuple(crossings))


# How each cell was reached: from where, over which water, and which channel that water was.
_Trail = dict[Cell, tuple[Cell, tuple[Cell, ...], int]]


def _search(
    rows: list[list[str]],
    courses: Water,
    effort: Terrain,
    starts: tuple[Cell, ...],
    is_target: Callable[[Cell], bool],
    forbidden: frozenset[Cell],
    banned: frozenset[int],
    tuning: Path,
) -> tuple[Cell, _Trail] | None:
    """Run the weighted search, returning the target reached and the trail that reached it."""
    channels = {cell: index for index, channel in enumerate(courses.channels) for cell in channel}
    best: dict[Cell, float] = {}
    came: _Trail = {}
    queue: list[tuple[float, Cell]] = []
    for cell in starts:
        if _inside(cell) and cell not in forbidden and cell not in best:
            best[cell] = 0.0
            heapq.heappush(queue, (0.0, cell))
    while queue:
        cost, cell = heapq.heappop(queue)
        if cost > best.get(cell, cost):
            continue
        if is_target(cell):
            return cell, came
        for spot, water_cells, channel, price in _moves(
            rows, courses, effort, channels, cell, forbidden, banned, tuning
        ):
            through = cost + price
            if through < best.get(spot, through + 1.0):
                best[spot] = through
                came[spot] = (cell, water_cells, channel)
                heapq.heappush(queue, (through, spot))
    return None


def _moves(
    rows: list[list[str]],
    courses: Water,
    effort: Terrain,
    channels: dict[Cell, int],
    cell: Cell,
    forbidden: frozenset[Cell],
    banned: frozenset[int],
    tuning: Path,
) -> Iterable[tuple[Cell, tuple[Cell, ...], int, float]]:
    """Yield every move out of a cell: one step onto land, or one straight run over a channel."""
    x, y = cell
    for dx, dy, length in _STEPS:
        spot = (x + dx, y + dy)
        if not _inside(spot) or spot in forbidden:
            continue
        # A corner step needs one of its two sides open. Cutting between two blocked cells is a
        # move no body could make, and it would leave the painted path split at the corner.
        if length > 1.0 and _corner(rows, cell, (dx, dy), forbidden) is None:
            continue
        code = rows[spot[1]][spot[0]]
        if code in _WALKABLE:
            yield spot, (), _NO_CHANNEL, _price(code, spot, effort, tuning) * length
        elif code == "w" and length == 1.0:
            crossing = _crossing(rows, courses, effort, channels, cell, (dx, dy), forbidden, banned, tuning)
            if crossing is not None:
                yield crossing


def _crossing(
    rows: list[list[str]],
    courses: Water,
    effort: Terrain,
    channels: dict[Cell, int],
    cell: Cell,
    step: tuple[int, int],
    forbidden: frozenset[Cell],
    banned: frozenset[int],
    tuning: Path,
) -> tuple[Cell, tuple[Cell, ...], int, float] | None:
    """Scan straight across water for a landing, keeping the run inside one unbanned channel."""
    x, y = cell
    dx, dy = step
    run: list[Cell] = []
    for reach in range(1, tuning.crossing_run + 1):
        over = (x + dx * reach, y + dy * reach)
        if not _inside(over) or over in forbidden:
            return None
        code = rows[over[1]][over[0]]
        if code == "w":
            # Sharing the trunk or the fork would put a bridge where the water is widest and where
            # the courses run together, so only a plain channel cell is bridgeable.
            if over in courses.trunk or over in courses.fork_mask or over not in channels:
                return None
            if channels[over] in banned or (run and channels[over] != channels[run[0]]):
                return None
            run.append(over)
            continue
        if code not in _WALKABLE or not run:
            return None
        # A crossing is priced by the water it spans, so the search bridges only where it must.
        price = len(run) * tuning.crossing_cost + _price(code, over, effort, tuning)
        return over, tuple(run), channels[run[0]], price
    return None


def _commit(
    rows: list[list[str]], found: tuple[Cell, _Trail], tuning: Path
) -> tuple[frozenset[Cell], tuple[Crossing, ...]]:
    """Paint the trail that reached a target, back to whichever road cell it started from."""
    target, came = found
    centre: list[Cell] = [target]
    crossings: list[Crossing] = []
    cell = target
    while cell in came:
        previous, water_cells, channel = came[cell]
        if water_cells:
            crossings.append(Crossing(channel, water_cells))
            centre.extend(water_cells)
        # A corner step touches only at the corner, which would leave the path as a dotted line of
        # separate cells. Filling one side of the corner keeps it a path somebody could have worn.
        if previous[0] != cell[0] and previous[1] != cell[1]:
            corner = _corner(rows, previous, (cell[0] - previous[0], cell[1] - previous[1]), frozenset())
            if corner is not None:
                centre.append(corner)
        cell = previous
        centre.append(cell)
    painted: set[Cell] = set()
    for spot in centre:
        for column, row in carve.stamp(spot, tuning.width):
            code = rows[row][column]
            if code == "w":
                rows[row][column] = "b"
            elif code in _PAINTABLE:
                rows[row][column] = "p"
            else:
                continue
            painted.add((column, row))
    return frozenset(painted), tuple(crossings)


def _corner(
    rows: list[list[str]], cell: Cell, step: tuple[int, int], forbidden: frozenset[Cell]
) -> Cell | None:
    """The cell a corner step is painted through, or nothing when both its sides are blocked."""
    x, y = cell
    dx, dy = step
    for spot in ((x + dx, y), (x, y + dy)):
        if _inside(spot) and spot not in forbidden and rows[spot[1]][spot[0]] in _WALKABLE:
            return spot
    return None


def _price(code: str, cell: Cell, effort: Terrain, tuning: Path) -> float:
    """What entering a cell costs: its ground, how hard the going is, less any path already worn."""
    cost = FRAME.cell_size / GROUND_BY_CODE[code].speed
    cost *= 1.0 + tuning.wander * effort[cell[1]][cell[0]]
    return cost * (1.0 - tuning.merge_discount) if code == "p" else cost


def _inside(cell: Cell) -> bool:
    return 0 <= cell[0] < FRAME.cells_x and 0 <= cell[1] < FRAME.cells_y
