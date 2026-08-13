"""District anchors and the building sites placed against them.

Anchors come first and are chosen on the terrain alone, because the road has to know where it is
going before it can be walked. Each is a point inside the road band: the shed and bell to the west,
the market in the middle, the inn to the east. The well plaza is not a road anchor; it sits in the
crook below the fork and is reached by a footpath.

Buildings then stand beside those anchors, never inside the band. Keeping every site and its margin
out of the band is what leaves the road a clear run across the frame, so the road walker never has
to squeeze past a wall it cannot move.

A site is accepted only once its rectangle, its margin, its garden, and a doorway with a route to
the band all hold together. Running out of candidates for any of them discards the whole layout.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from math import dist, hypot

from ..catalog import BUILDING_BY_TOKEN, PROP_BY_TOKEN, BuildingType
from ..grid import Cell
from ..layout import Building, doorway_cells, paint_site
from ..rules import FRAME
from . import grounds, paths
from .config import Network, Retry, Sites
from .water import Water

# Ground a site may not be dropped on. Everything else is land the village may build over.
_KEEP_CLEAR = frozenset({"w"})
_FACINGS = ("north", "east", "south", "west")
# Buildings in layout order. Inn and shed are placed first, since they anchor their districts.
_PLACEMENT = ("inn", "shed", "home_0", "home_1", "home_2", "home_3", "home_4")
_LAYOUT = ("home_0", "home_1", "home_2", "home_3", "home_4", "inn", "shed")


@dataclass(frozen=True, slots=True)
class Site:
    """One placed building and everything placement promised about it."""

    building: Building
    # The rectangle plus its margin, which is what later stages must stay out of.
    reserved: frozenset[Cell]
    # The garden plot's cells, empty for the inn and the shed. Routes and dressing keep off them.
    garden: tuple[Cell, ...]
    # The cells immediately outside the door run, which a footpath has to reach.
    approaches: tuple[Cell, ...]


@dataclass(frozen=True, slots=True)
class Settlement:
    """Everything the settlement stage committed."""

    plaza: Cell
    # West, middle, and east road targets: the shed, the market, and the inn.
    anchors: tuple[Cell, Cell, Cell]
    clusters: tuple[Cell, ...]
    sites: tuple[Site, ...]
    reserved: frozenset[Cell]
    keep_clear: frozenset[Cell]

    def site(self, building_id: str) -> Site:
        return next(site for site in self.sites if site.building.id == building_id)

    @property
    def buildings(self) -> tuple[Building, ...]:
        return tuple(site.building for site in self.sites)


def settle(
    stream: random.Random,
    rows: list[list[str]],
    elevation: list[list[float]],
    moisture: list[list[float]],
    courses: Water,
    tuning: Sites,
    network: Network,
) -> Settlement:
    """Choose the districts and stand every building, painting each site as it is accepted."""
    distance = grounds.water_distance(rows)
    band = network.road.band
    # Everywhere a footpath could ever reach the road from, answered once rather than per candidate.
    # Somewhere the road can never be joined to is somewhere the village does not build.
    joinable = paths.joinable(
        rows,
        courses,
        ((x, y) for y in range(band[0], band[1] + 1) for x in range(FRAME.cells_x)),
        network.path,
    )
    plaza = _plaza(stream, rows, elevation, moisture, courses, tuning, band, joinable)
    reserved = set(_disc(plaza, tuning.plaza_radius))
    anchors = _anchors(stream, rows, elevation, moisture, tuning, inner_band(network))
    clusters = _clusters(stream, rows, elevation, moisture, distance, courses, tuning, band, joinable)
    sites: dict[str, Site] = {}
    wanted = {
        "inn": anchors[2],
        "shed": anchors[0],
        **{f"home_{index}": clusters[index % len(clusters)] for index in range(5)},
    }
    for building_id in _PLACEMENT:
        kind = BUILDING_BY_TOKEN["home" if building_id.startswith("home") else building_id]
        site = _stand(stream, rows, building_id, kind, wanted[building_id], reserved, joinable, tuning, band)
        paint_site(rows, site.building)
        reserved.update(site.reserved)
        sites[building_id] = site
    placed = tuple(sites[building_id] for building_id in _LAYOUT)
    gardens = frozenset(cell for site in placed for cell in site.garden)
    return Settlement(plaza, anchors, clusters, placed, frozenset(reserved), gardens)


def inner_band(network: Network) -> tuple[int, int]:
    """The rows the road actually uses.

    The band's outer rows are the wall the road is pushed off, so an anchor placed on one is an
    anchor the road can never come within reach of.
    """
    road = network.road
    return (road.band[0] + road.width, road.band[1] - road.width)


def _plaza(
    stream: random.Random,
    rows: list[list[str]],
    elevation: list[list[float]],
    moisture: list[list[float]],
    courses: Water,
    tuning: Sites,
    band: tuple[int, int],
    joinable: frozenset[Cell],
) -> Cell:
    """Find the well plaza in the crook below the fork: open, dry, and flat enough to gather on."""
    fork_x, fork_y = courses.fork
    best: tuple[float, Cell] | None = None
    for _ in range(tuning.budget):
        candidate = (
            fork_x + stream.randint(-tuning.plaza_reach, tuning.plaza_reach),
            fork_y - stream.randint(0, tuning.plaza_reach),
        )
        if candidate[1] <= band[1] or candidate not in joinable:
            continue
        if not _open(rows, _disc(candidate, tuning.plaza_radius)):
            continue
        score = (
            _dry(moisture, candidate) * tuning.scores.dry + _flat(elevation, candidate) * tuning.scores.flat
        )
        # The crook is the ground the fork closes around, so nearness to it settles ties.
        score -= dist(candidate, courses.fork) / FRAME.cells_y
        if best is None or score > best[0]:
            best = (score, candidate)
    if best is None:
        raise Retry("no room for a well plaza below the fork")
    return best[1]


def _anchors(
    stream: random.Random,
    rows: list[list[str]],
    elevation: list[list[float]],
    moisture: list[list[float]],
    tuning: Sites,
    band: tuple[int, int],
) -> tuple[Cell, Cell, Cell]:
    """Pick the west, middle, and east road targets on dry, flat ground inside the band."""
    third = FRAME.cells_x // 3
    spans = ((1, third), (third, 2 * third), (2 * third, FRAME.cells_x - 1))
    found: list[Cell] = []
    for low, high in spans:
        best: tuple[float, Cell] | None = None
        for _ in range(tuning.budget):
            candidate = (stream.randrange(low, high), stream.randint(*band))
            if rows[candidate[1]][candidate[0]] in _KEEP_CLEAR:
                continue
            score = (
                _dry(moisture, candidate) * tuning.scores.dry
                + _flat(elevation, candidate) * tuning.scores.flat
            )
            if best is None or score > best[0]:
                best = (score, candidate)
        if best is None:
            raise Retry("a district anchor found no dry ground inside the road band")
        found.append(best[1])
    return (found[0], found[1], found[2])


def _clusters(
    stream: random.Random,
    rows: list[list[str]],
    elevation: list[list[float]],
    moisture: list[list[float]],
    distance: list[list[int]],
    courses: Water,
    tuning: Sites,
    band: tuple[int, int],
    joinable: frozenset[Cell],
) -> tuple[Cell, ...]:
    """Seed loose bank-side groups for the homes, spread apart from one another.

    Homes live among the channels, south of the fork. Above it the trunk is too wide to bridge, so
    ground up there is somewhere a footpath could never carry anyone home from.
    """
    # What a home and its margin need around a centre before a home can stand on it at all.
    home = BUILDING_BY_TOKEN["home"]
    reach = max(home.width, home.height) // 2 + tuning.margin
    found: list[Cell] = []
    for _ in range(tuning.cluster_count):
        best: tuple[float, Cell] | None = None
        for _ in range(tuning.cluster_budget):
            candidate = (
                stream.randrange(1, FRAME.cells_x - 1),
                stream.randrange(1, courses.fork[1]),
            )
            if band[0] <= candidate[1] <= band[1] or candidate not in joinable:
                continue
            if not _open(rows, _disc(candidate, float(reach))):
                continue
            apart = min((dist(candidate, other) for other in found), default=float(FRAME.cells_x))
            score = (
                _bank(distance, candidate, reach) * tuning.scores.bank
                + _flat(elevation, candidate) * tuning.scores.flat
                + _dry(moisture, candidate) * tuning.scores.dry
                + min(apart / FRAME.cells_x, 1.0) * tuning.scores.apart
            )
            if best is None or score > best[0]:
                best = (score, candidate)
        if best is None:
            raise Retry("a home cluster found no bank to gather on")
        found.append(best[1])
    return tuple(found)


def _stand(
    stream: random.Random,
    rows: list[list[str]],
    building_id: str,
    kind: BuildingType,
    wanted: Cell,
    reserved: set[Cell],
    joinable: frozenset[Cell],
    tuning: Sites,
    band: tuple[int, int],
) -> Site:
    """Stand one building near where it belongs, taking the first candidate that holds together."""
    spread = tuning.cluster_radius + max(kind.width, kind.height)
    for _ in range(tuning.budget):
        origin = (
            wanted[0] + stream.randint(-spread, spread),
            wanted[1] + stream.randint(-spread, spread),
        )
        start = stream.randrange(len(_FACINGS))
        for turn in range(len(_FACINGS)):
            facing = _FACINGS[(start + turn) % len(_FACINGS)]
            site = _site(building_id, kind, origin, facing, tuning)
            if site is None or not _clear(rows, site, reserved, band):
                continue
            # The doorway has to open toward ground a footpath can carry back to the road.
            if any(cell in joinable for cell in site.approaches):
                return site
    raise Retry(f"nowhere to stand {building_id}")


def _site(building_id: str, kind: BuildingType, origin: Cell, facing: str, tuning: Sites) -> Site | None:
    """Assemble one candidate site, or report that its geometry leaves the frame."""
    x, y = origin
    if x < 1 or y < 1 or x + kind.width >= FRAME.cells_x or y + kind.height >= FRAME.cells_y:
        return None
    building = Building(building_id, _type_of(building_id), origin, facing)
    garden = _garden(kind, origin, facing) if building.type == "home" else ()
    if any(not _inside(cell) for cell in garden):
        return None
    reserved = frozenset(
        (column, row)
        for row in range(y - tuning.margin, y + kind.height + tuning.margin)
        for column in range(x - tuning.margin, x + kind.width + tuning.margin)
        if _inside((column, row))
    )
    return Site(building, reserved, garden, _approaches(building, kind))


def _garden(kind: BuildingType, origin: Cell, facing: str) -> tuple[Cell, ...]:
    """Place the garden flush against the wall opposite the doorway, centred on it.

    An odd difference centres on the lower index, and the plot never slides: a candidate whose
    garden does not fit is a candidate the site rejects.
    """
    plot = PROP_BY_TOKEN["plot"]
    width, height = (plot.height, plot.width) if facing in {"east", "west"} else (plot.width, plot.height)
    x, y = origin
    if facing == "north":
        spot = (x + (kind.width - width) // 2, y - height)
    elif facing == "south":
        spot = (x + (kind.width - width) // 2, y + kind.height)
    elif facing == "east":
        spot = (x - width, y + (kind.height - height) // 2)
    else:
        spot = (x + kind.width, y + (kind.height - height) // 2)
    return tuple((spot[0] + column, spot[1] + row) for row in range(height) for column in range(width))


def _approaches(building: Building, kind: BuildingType) -> tuple[Cell, ...]:
    """The cells a visitor stands on to use the door, one step outside the run."""
    x, y = building.cell
    door = doorway_cells(building)
    if building.facing == "north":
        return tuple((column, y + kind.height) for column, _ in door)
    if building.facing == "south":
        return tuple((column, y - 1) for column, _ in door)
    if building.facing == "east":
        return tuple((x + kind.width, row) for _, row in door)
    return tuple((x - 1, row) for _, row in door)


def _clear(rows: list[list[str]], site: Site, reserved: set[Cell], band: tuple[int, int]) -> bool:
    """Report whether a candidate stands on free land, out of the band and off every other site."""
    for cell in site.reserved:
        if cell in reserved or rows[cell[1]][cell[0]] in _KEEP_CLEAR:
            return False
        if band[0] <= cell[1] <= band[1]:
            return False
    return all(_inside(cell) and rows[cell[1]][cell[0]] not in _KEEP_CLEAR for cell in site.approaches)


def _open(rows: list[list[str]], cells: tuple[Cell, ...]) -> bool:
    return all(_inside(cell) and rows[cell[1]][cell[0]] not in _KEEP_CLEAR for cell in cells)


def _disc(centre: Cell, radius: float) -> tuple[Cell, ...]:
    reach = int(radius) + 1
    return tuple(
        (centre[0] + dx, centre[1] + dy)
        for dy in range(-reach, reach + 1)
        for dx in range(-reach, reach + 1)
        if hypot(dx, dy) <= radius
    )


def _flat(elevation: list[list[float]], cell: Cell) -> float:
    """How level the ground is, as a share of the unit range. Level ground scores one."""
    x, y = cell
    if not (0 < x < FRAME.cells_x - 1 and 0 < y < FRAME.cells_y - 1):
        return 0.0
    across = abs(elevation[y][x + 1] - elevation[y][x - 1]) / 2
    along = abs(elevation[y + 1][x] - elevation[y - 1][x]) / 2
    return max(0.0, 1.0 - max(across, along) * FRAME.cells_x)


def _dry(moisture: list[list[float]], cell: Cell) -> float:
    return 1.0 - moisture[cell[1]][cell[0]]


def _bank(distance: list[list[int]], cell: Cell, reach: int) -> float:
    """How much a cell reads as bank side: as near the water as a home and its margin can stand.

    Ground closer than that reach is bank a home would have its feet in, so it scores nothing at
    all rather than scoring best, which is the mistake that leaves five homes with nowhere to go.
    """
    span = distance[cell[1]][cell[0]]
    return 0.0 if span <= reach else 1.0 / (1.0 + span - reach)


def _type_of(building_id: str) -> str:
    return "home" if building_id.startswith("home") else building_id


def _inside(cell: Cell) -> bool:
    return 0 <= cell[0] < FRAME.cells_x and 0 <= cell[1] < FRAME.cells_y
