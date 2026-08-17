"""Everything placed once the ground, the buildings, and the routes are committed.

Dressing changes no ground. A prop reserves its catalog rectangle turned to its facing, stands on
the class already painted under it, and banks one standing cell it can be used from. That witness is
found when the prop is placed and protected from everything placed after it, which is what makes the
guarantee hold without any stage having to look back.

Most spots come off the road. A station is a point along the road's centreline with the direction of
travel there, so a stall, a lantern, a shrine, or a pine can be set a fixed distance to one side of
it and turned to face the road. The market is the stretch of that centreline nearest the anchor.

Stalls, the board, benches, shrines, gardens, the interior props, the pump, and the bell are
mandatory: running out of candidates discards the layout. Lanterns and pines are not. They skip a
blocked spot and carry on, and what fits is kept in the shipped village.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from math import atan2, dist, hypot, pi

from ..catalog import BUILDING_BY_TOKEN, CATALOG, PROP_BY_TOKEN, SCENERY_BY_TOKEN, PropType
from ..geometry import Circle, Point, Rect, circle_intersects_circle, circle_intersects_rect, nearest_point
from ..grid import Cell
from ..layout import PlacedProp, Scenery, footprint, footprint_cells
from ..rules import FRAME, GROUND_BY_CODE, PROFILE
from .config import Accessories, Retry
from .network import Road
from .sites import Settlement, Site

# Ground an outdoor prop may stand on. Road, path, bridge, and doorway all carry people.
_STANDABLE = frozenset({"g", "f", "e"})
_FACINGS = ("north", "east", "south", "west")
# Props are published in catalog type order, which is the order the catalog lists them in.
_ORDER = {kind.token: index for index, kind in enumerate(CATALOG.props)}


@dataclass(frozen=True, slots=True)
class Station:
    """A point on the road's centreline and the way the road is running there."""

    point: Point
    tangent: Point
    arc: float


@dataclass(frozen=True, slots=True)
class Dressing:
    """Everything the accessory stage placed."""

    props: tuple[PlacedProp, ...]
    scenery: tuple[Scenery, ...]
    witnesses: tuple[tuple[str, Cell], ...]


def stations(road: Road, spacing: float) -> tuple[Station, ...]:
    """Walk the road's centreline and stand a station every spacing of it."""
    found: list[Station] = []
    arc = 0.0
    next_at = 0.0
    for before, after in zip(road.centreline, road.centreline[1:], strict=False):
        length = dist(before, after)
        if length == 0.0:
            continue
        tangent = ((after[0] - before[0]) / length, (after[1] - before[1]) / length)
        while next_at <= arc + length:
            share = (next_at - arc) / length
            point = (before[0] + tangent[0] * length * share, before[1] + tangent[1] * length * share)
            found.append(Station(point, tangent, next_at))
            next_at += spacing
        arc += length
    return tuple(found)


def _posts(road: Road, spacing: float) -> tuple[Station, ...]:
    """Stations dressing may use: the road, less the stretches where it is up on a bridge."""
    return tuple(
        station
        for station in stations(road, spacing)
        if not any(
            crossing.span[0] - 1 <= station.point[0] <= crossing.span[1] + 1 for crossing in road.crossings
        )
    )


def shrine_spots(road: Road, tuning: Accessories) -> tuple[Station, ...]:
    """Find where the road turns hardest, keeping the shrines that stand there apart.

    Sharpness is read over a window either side rather than step to step, so it answers the shape of
    a bend instead of one step's wobble.
    """
    window = tuning.shrine.window
    line = road.centreline
    lengths = [dist(before, after) for before, after in zip(line, line[1:], strict=False)]
    arcs = [0.0]
    for length in lengths:
        arcs.append(arcs[-1] + length)
    turns: list[tuple[float, Station]] = []
    for index in range(window, len(line) - window):
        point = line[index]
        if any(crossing.span[0] <= point[0] <= crossing.span[1] for crossing in road.crossings):
            continue
        before = _unit((point[0] - line[index - window][0], point[1] - line[index - window][1]))
        after = _unit((line[index + window][0] - point[0], line[index + window][1] - point[1]))
        turn = abs(_wrap(atan2(after[1], after[0]) - atan2(before[1], before[0])))
        turns.append((turn, Station(point, after, arcs[index])))
    found: list[Station] = []
    for _, station in sorted(turns, key=lambda item: (-item[0], item[1].arc)):
        if len(found) == tuning.shrine.count:
            break
        if all(abs(station.arc - other.arc) >= tuning.shrine.separation for other in found):
            found.append(station)
    if len(found) < tuning.shrine.count:
        raise Retry("the road did not bend often enough to stand every shrine")
    return tuple(sorted(found, key=lambda station: station.arc))


def dress(
    stream: random.Random,
    rows: list[list[str]],
    settlement: Settlement,
    road: Road,
    shrines: tuple[Station, ...],
    tuning: Accessories,
    clearance: tuple[Point, float],
) -> Dressing:
    """Place every accessory in a fixed order, banking a witness for each interactive prop."""
    yard = _Yard(rows, settlement, tuning, clearance)
    market = _market_arc(road, settlement)
    _stalls(stream, yard, road, market, tuning)
    _crates(stream, yard, tuning)
    _board(stream, yard, road, market, tuning)
    _benches(stream, yard, settlement, tuning)
    _shrines(stream, yard, road, shrines, tuning)
    _gardens(yard, settlement)
    _interiors(yard, settlement)
    _pump(stream, yard, settlement, tuning)
    _bell(stream, yard, road, tuning)
    _lanterns(stream, yard, road, market, tuning)
    _pines(stream, yard, road, tuning)
    return yard.dressing()


class _Yard:
    """The village as dressing sees it: what is taken, what is placed, and what must stay usable."""

    def __init__(
        self,
        rows: list[list[str]],
        settlement: Settlement,
        tuning: Accessories,
        clearance: tuple[Point, float],
    ) -> None:
        self.rows = rows
        self.settlement = settlement
        self.tuning = tuning
        self.props: list[PlacedProp] = []
        self.scenery: list[Scenery] = []
        self.witnesses: dict[str, Cell] = {}
        self.taken: set[Cell] = set()
        self.solids: list[Rect | Circle] = []
        # What no later solid may close off: the spawn, every doorway approach, and each witness
        # as it is banked.
        self.protected: list[tuple[Point, float]] = [clearance]
        for site in settlement.sites:
            self.protected.extend((_centre(cell), PROFILE.body_radius) for cell in site.approaches)

    def place(self, token: str, cell: Cell, facing: str, *, interior: bool = False) -> bool:
        """Stand one prop if its footprint is free and it can be reached, and bank its witness."""
        held = sum(1 for item in self.props if item.type == token)
        item = PlacedProp(f"{token}_{held}", token, cell, facing)
        if not self._footprint_free(item, interior=interior):
            return False
        shape = _shape_for(item)
        if not self._keeps_promises(shape):
            return False
        witness = self._witness(item, shape)
        if witness is None:
            return False
        self.props.append(item)
        self.witnesses[item.id] = witness
        self.taken.update(footprint_cells(item))
        self.solids.append(shape)
        self.protected.append((_centre(witness), PROFILE.body_radius))
        return True

    def stand(self, token: str, cell: Cell, *, scale: float = 1.0) -> bool:
        """Stand one piece of scenery, which is solid but is never used and banks no witness."""
        item = Scenery(token, cell, scale)
        if not self._footprint_free(item):
            return False
        shape = _shape_for(item)
        if not self._keeps_promises(shape):
            return False
        self.scenery.append(item)
        self.taken.update(footprint_cells(item))
        self.solids.append(shape)
        return True

    def dressing(self) -> Dressing:
        ordered = tuple(sorted(self.props, key=lambda item: (_ORDER[item.type], _number(item.id))))
        return Dressing(ordered, tuple(self.scenery), tuple(sorted(self.witnesses.items())))

    def _footprint_free(self, item: PlacedProp | Scenery, *, interior: bool = False) -> bool:
        """An interior prop stands on floor. Everything else stands on ground nobody walks over."""
        allowed = frozenset({"i"}) if interior else _STANDABLE
        for cell in footprint_cells(item):
            if not _inside(cell) or cell in self.taken:
                return False
            if self.rows[cell[1]][cell[0]] not in allowed:
                return False
        return True

    def _keeps_promises(self, shape: Rect | Circle) -> bool:
        """Refuse a solid that would close off the spawn, a doorway, or a banked witness."""
        return not any(_touches(shape, point, radius) for point, radius in self.protected)

    def _witness(self, item: PlacedProp, shape: Rect | Circle) -> Cell | None:
        """Find the nearest standing cell in reach of a prop, with a clear line to it."""
        reach = int(PROFILE.prop_reach) + 1
        width, height = footprint(item)
        x, y = item.cell
        ring = [
            (column, row)
            for row in range(y - reach, y + height + reach)
            for column in range(x - reach, x + width + reach)
            if not (x <= column < x + width and y <= row < y + height)
        ]
        middle = (x + width / 2, y + height / 2)
        for cell in sorted(ring, key=lambda spot: (dist(_centre(spot), middle), spot)):
            if not _inside(cell) or cell in self.taken:
                continue
            if not GROUND_BY_CODE[self.rows[cell[1]][cell[0]]].passable:
                continue
            centre = _centre(cell)
            if _touches(shape, centre, PROFILE.body_radius):
                continue
            if any(_touches(other, centre, PROFILE.body_radius) for other in self.solids):
                continue
            spot = nearest_point(centre, shape)
            if dist(centre, spot) > PROFILE.prop_reach or not self._sees(centre, spot):
                continue
            return cell
        return None

    def _sees(self, start: Point, end: Point) -> bool:
        """Walk the short line to a prop, refusing anything that blocks sight along it."""
        span = dist(start, end)
        steps = max(int(span / 0.1), 1)
        for index in range(steps + 1):
            share = index / steps
            cell = (
                int(start[0] + (end[0] - start[0]) * share),
                int(start[1] + (end[1] - start[1]) * share),
            )
            if not _inside(cell) or GROUND_BY_CODE[self.rows[cell[1]][cell[0]]].blocks_sight:
                return False
        return True


def _stalls(stream: random.Random, yard: _Yard, road: Road, market: float, tuning: Accessories) -> None:
    """Scatter the stalls along both sides of the road through the market."""
    stall = tuning.stall
    posts = _near(_posts(road, float(stall.spacing)), market, float(stall.span))
    side = 1 if stream.random() < 0.5 else -1
    for index in range(stall.count):
        turn = side if index % 2 == 0 else -side
        if not _try(stream, yard, "stall", posts, turn, tuning, stall.budget):
            raise Retry("a market stall found nowhere to stand beside the road")


def _crates(stream: random.Random, yard: _Yard, tuning: Accessories) -> None:
    """Stack one crate beside each stall, and sometimes a second. A crowded stall gets neither."""
    crate = tuning.crate
    for stall in [item for item in yard.props if item.type == "stall"]:
        wanted = 2 if stream.random() < crate.second_chance else 1
        stood = 0
        for cell in _skirt(stall)[: crate.budget]:
            if stood == wanted:
                break
            if yard.stand("crate", cell):
                stood += 1


def _board(stream: random.Random, yard: _Yard, road: Road, market: float, tuning: Accessories) -> None:
    posts = _near(_posts(road, 1.0), market, float(tuning.stall.span))
    if not _try(stream, yard, "board", posts, 1, tuning, tuning.board.budget):
        raise Retry("the notice board found nowhere to stand in the market")


def _benches(stream: random.Random, yard: _Yard, settlement: Settlement, tuning: Accessories) -> None:
    """Split the benches between the plaza, the market, and the front of the inn."""
    bench = tuning.bench
    wanted = (
        (settlement.plaza, bench.plaza),
        (settlement.anchors[1], bench.market),
        (settlement.site("inn").approaches[0], bench.inn),
    )
    for spot, count in wanted:
        for _ in range(count):
            if not _around(stream, yard, "bench", spot, bench.budget):
                raise Retry("a bench found nowhere to sit")


def _shrines(
    stream: random.Random, yard: _Yard, road: Road, shrines: tuple[Station, ...], tuning: Accessories
) -> None:
    """Stand each shrine at its turn, letting it slide a little along the road to find room."""
    for station in shrines:
        posts = _near(_posts(road, 1.0), station.arc, float(tuning.shrine.window))
        if not _try(stream, yard, "shrine", posts or (station,), 1, tuning, tuning.shrine.budget):
            raise Retry("a shrine found nowhere to stand at the turn it belongs to")


def _gardens(yard: _Yard, settlement: Settlement) -> None:
    """Stand each home's garden on the cells its site already set aside. It never slides."""
    for site in settlement.sites:
        if not site.garden:
            continue
        origin = (min(x for x, _ in site.garden), min(y for _, y in site.garden))
        if not yard.place("plot", origin, site.building.facing):
            raise Retry("a garden would not fit against the wall its home left for it")


def _interiors(yard: _Yard, settlement: Settlement) -> None:
    """Stand the hearth and the repair bench against the wall opposite their doorway."""
    for building_id, token in (("inn", "hearth"), ("shed", "repair_bench")):
        site = settlement.site(building_id)
        cell = _interior_spot(site, token)
        if not yard.place(token, cell, site.building.facing, interior=True):
            raise Retry(f"the {token} would not stand inside the {building_id}")


def _pump(stream: random.Random, yard: _Yard, settlement: Settlement, tuning: Accessories) -> None:
    if not _around(stream, yard, "pump", settlement.plaza, tuning.pump.budget):
        raise Retry("the well pump found nowhere to stand in the plaza")


def _bell(stream: random.Random, yard: _Yard, road: Road, tuning: Accessories) -> None:
    """Hang the bell beside the west stretch of the road."""
    posts = tuple(station for station in _posts(road, 2.0) if station.point[0] < FRAME.cells_x / 3)
    if not posts or not _try(stream, yard, "bell", posts, 1, tuning, tuning.bell.budget):
        raise Retry("the beacon bell found nowhere to hang beside the west road")


def _lanterns(stream: random.Random, yard: _Yard, road: Road, market: float, tuning: Accessories) -> None:
    """Light the road, closer together at the market. A blocked station is simply skipped."""
    lantern = tuning.lantern
    side = 1 if stream.random() < 0.5 else -1
    posts = set(_posts(road, float(lantern.spacing)))
    posts.update(_near(_posts(road, float(lantern.market_spacing)), market, float(tuning.stall.span)))
    for index, station in enumerate(sorted(posts, key=lambda item: item.arc)):
        turn = side if index % 2 == 0 else -side
        # Alternate sides, try the other one once, and leave a station that takes neither.
        for attempt in (turn, -turn):
            if _stand_beside(yard, "lantern", station, attempt, tuning):
                break


def _pines(stream: random.Random, yard: _Yard, road: Road, tuning: Accessories) -> None:
    """Plant the pines last, at road stations and scattered over open ground, with companions."""
    pine = tuning.pine
    low, high = pine.size
    for index, station in enumerate(_posts(road, float(pine.spacing))):
        _stand_beside(
            yard, "pine", station, 1 if index % 2 == 0 else -1, tuning, scale=_pine_scale(stream, low, high)
        )
    for _ in range(pine.scatter):
        cell = (stream.randrange(FRAME.cells_x), stream.randrange(FRAME.cells_y))
        if not _spaced(yard, cell, pine.gap):
            continue
        if not yard.stand("pine", cell, scale=_pine_scale(stream, low, high)):
            continue
        if stream.random() >= pine.companion_chance:
            continue
        for _ in range(pine.companions):
            near = (
                cell[0] + stream.randint(-pine.gap, pine.gap),
                cell[1] + stream.randint(-pine.gap, pine.gap),
            )
            if _spaced(yard, near, pine.gap - 1):
                yard.stand("pine", near, scale=_pine_scale(stream, low, high))


def _pine_scale(stream: random.Random, low: float, high: float) -> float:
    """Draw one pine's size. Being drawn at placement, the solid it makes keeps its true radius."""
    return round(stream.uniform(low, high), 3)


def _try(
    stream: random.Random,
    yard: _Yard,
    token: str,
    posts: tuple[Station, ...],
    side: int,
    tuning: Accessories,
    budget: int,
) -> bool:
    """Sweep the stations from a drawn start until one takes the prop, on its side or the other."""
    if not posts:
        return False
    start = stream.randrange(len(posts))
    for offset in range(min(budget, len(posts))):
        station = posts[(start + offset) % len(posts)]
        for turn in (side, -side):
            if _stand_beside(yard, token, station, turn, tuning):
                return True
    return False


def _stand_beside(
    yard: _Yard, token: str, station: Station, side: int, tuning: Accessories, *, scale: float = 1.0
) -> bool:
    """Set a prop one setback off the road at a station, turned to face the road it serves."""
    kind = PROP_BY_TOKEN.get(token)
    normal = (-station.tangent[1] * side, station.tangent[0] * side)
    facing = _facing_of((-normal[0], -normal[1]))
    width, height = (kind.width, kind.height) if kind is not None else (1, 1)
    if kind is not None and facing in {"east", "west"}:
        width, height = height, width
    away = tuning.setback + max(width, height) / 2 + 1.5
    centre = (station.point[0] + normal[0] * away, station.point[1] + normal[1] * away)
    cell = (int(centre[0] - width / 2), int(centre[1] - height / 2))
    return yard.place(token, cell, facing) if kind is not None else yard.stand(token, cell, scale=scale)


def _around(stream: random.Random, yard: _Yard, token: str, centre: Cell, budget: int) -> bool:
    """Draw cells around a district centre until one of them takes the prop."""
    reach = 4
    for _ in range(budget):
        cell = (centre[0] + stream.randint(-reach, reach), centre[1] + stream.randint(-reach, reach))
        if yard.place(token, cell, _FACINGS[stream.randrange(len(_FACINGS))]):
            return True
    return False


def _skirt(item: PlacedProp) -> tuple[Cell, ...]:
    """The ring of cells around a placement, nearest the middle of it first."""
    width, height = footprint(item)
    x, y = item.cell
    middle = (x + width / 2, y + height / 2)
    ring = [
        (column, row)
        for row in range(y - 1, y + height + 1)
        for column in range(x - 1, x + width + 1)
        if not (x <= column < x + width and y <= row < y + height)
    ]
    return tuple(sorted(ring, key=lambda cell: (dist(_centre(cell), middle), cell)))


def _spaced(yard: _Yard, cell: Cell, gap: int) -> bool:
    """Keep pines apart, so a stand of them reads as trees rather than as a hedge."""
    return _inside(cell) and all(dist(cell, item.cell) >= gap for item in yard.scenery if item.type == "pine")


def _market_arc(road: Road, settlement: Settlement) -> float:
    """Where along the road the market is, measured in the road's own arc length."""
    anchor = _centre(settlement.anchors[1])
    posts = stations(road, 1.0)
    return min(posts, key=lambda station: dist(station.point, anchor)).arc


def _near(posts: tuple[Station, ...], arc: float, span: float) -> tuple[Station, ...]:
    return tuple(station for station in posts if abs(station.arc - arc) <= span)


def _interior_spot(site: Site, token: str) -> Cell:
    """Centre an interior prop against the inside of the wall opposite the doorway."""
    kind = BUILDING_BY_TOKEN[site.building.type]
    facing = site.building.facing
    width, height = footprint(PlacedProp("probe", token, (0, 0), facing))
    x, y = site.building.cell
    floor = (x + 1, y + 1, kind.width - 2, kind.height - 2)
    if facing == "north":
        return (floor[0] + (floor[2] - width) // 2, floor[1])
    if facing == "south":
        return (floor[0] + (floor[2] - width) // 2, floor[1] + floor[3] - height)
    if facing == "east":
        return (floor[0], floor[1] + (floor[3] - height) // 2)
    return (floor[0] + floor[2] - width, floor[1] + (floor[3] - height) // 2)


def _shape_for(item: PlacedProp | Scenery) -> Rect | Circle:
    """The catalog collision shape, before there is a layout to ask for it."""
    source = PROP_BY_TOKEN[item.type] if isinstance(item, PlacedProp) else SCENERY_BY_TOKEN[item.type]
    width, height = footprint(item)
    x, y = item.cell
    if source.shape == "box":
        return Rect(float(x), float(y), float(width), float(height))
    scale = source.collision_scale if isinstance(source, PropType) else 1.0
    if isinstance(item, Scenery):
        scale *= item.scale
    return Circle(x + width / 2, y + height / 2, min(width, height) / 2 * scale)


def _touches(shape: Rect | Circle, point: Point, radius: float) -> bool:
    if isinstance(shape, Rect):
        return circle_intersects_rect(point, radius, shape)
    return circle_intersects_circle(point, radius, shape)


def _facing_of(direction: Point) -> str:
    if abs(direction[0]) >= abs(direction[1]):
        return "east" if direction[0] >= 0 else "west"
    return "north" if direction[1] >= 0 else "south"


def _centre(cell: Cell) -> Point:
    return (cell[0] + 0.5, cell[1] + 0.5)


def _number(prop_id: str) -> int:
    return int(prop_id.rsplit("_", 1)[1])


def _wrap(angle: float) -> float:
    while angle > pi:
        angle -= 2.0 * pi
    while angle < -pi:
        angle += 2.0 * pi
    return angle


def _unit(vector: Point) -> Point:
    length = hypot(*vector)
    return (1.0, 0.0) if length == 0.0 else (vector[0] / length, vector[1] / length)


def _inside(cell: Cell) -> bool:
    return 0 <= cell[0] < FRAME.cells_x and 0 <= cell[1] < FRAME.cells_y
