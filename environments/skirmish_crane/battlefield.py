"""Constructive, point-symmetric tactical battlefield generation."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from random import Random

from .hexes import Position, Tile, field_positions, neighbors, rotate_position, tile_array

MAX_REDRAWS = 12


@dataclass(frozen=True)
class CaptureZone:
    center: Position
    tiles: tuple[Position, ...]


@dataclass(frozen=True)
class Battlefield:
    extent: int
    tiles: dict[Position, Tile]
    spawns: dict[str, tuple[Position, ...]]
    zones: tuple[CaptureZone, ...]
    passage_tiles: tuple[tuple[Position, ...], ...]
    redraw_count: int = 0

    @property
    def side(self) -> int:
        return 2 * self.extent + 1

    @property
    def array(self) -> tuple[tuple[Tile, ...], ...]:
        return tile_array(self.extent, self.tiles)

    @property
    def passage_count(self) -> int:
        return len(self.passage_tiles)

    @property
    def passage_widths(self) -> tuple[int, ...]:
        return tuple(len(passage) for passage in self.passage_tiles)

    def tile_at(self, position: Position) -> Tile:
        return self.tiles.get(position, Tile("void"))

    def snapshot(self) -> BattlefieldSnapshot:
        """Return a deeply immutable view suitable for participant perception."""
        return BattlefieldSnapshot(
            self.extent,
            self.side,
            self.array,
            tuple((side, positions) for side, positions in self.spawns.items()),
            self.zones,
            self.passage_tiles,
        )

    def connected(self) -> bool:
        passable = {position for position, tile in self.tiles.items() if tile.passable}
        if not passable:
            return False
        seen = {next(iter(passable))}
        queue = deque(seen)
        while queue:
            position = queue.popleft()
            for candidate in neighbors(position, self.extent):
                if candidate in passable and candidate not in seen:
                    seen.add(candidate)
                    queue.append(candidate)
        return seen == passable


@dataclass(frozen=True)
class BattlefieldSnapshot:
    extent: int
    side: int
    tiles: tuple[tuple[Tile, ...], ...]
    spawns: tuple[tuple[str, tuple[Position, ...]], ...]
    zones: tuple[CaptureZone, ...]
    passage_tiles: tuple[tuple[Position, ...], ...]


def _passage_ranges(extent: int, count: int, rng: Random) -> tuple[range, ...]:
    """Return reflected seam gaps. Ranges are separated by at least one water tile."""
    side = 2 * extent + 1
    if count == 2:
        width = rng.randint(2, 4)
        lower_start = 1
        return range(lower_start, lower_start + width), range(side - lower_start - width, side - lower_start)
    # A three-wide central gap is the only self-reflecting contiguous gap. It
    # also leaves room for two reflected outer passages at every supported size.
    width = rng.randint(2, min(4, extent - 3))
    central = range(extent - 1, extent + 2)
    return range(1, 1 + width), central, range(side - 1 - width, side - 1)


def _terrain_tiles(
    extent: int, rng: Random, terrain: bool, zone_count: int
) -> tuple[dict[Position, Tile], tuple[tuple[Position, ...], ...]]:
    tiles = {position: Tile() for position in field_positions(extent)}
    if not terrain:
        return tiles, ()
    passage_count = 3 if zone_count or rng.choice((False, True)) else 2
    passages = _passage_ranges(extent, passage_count, rng)
    gap_rows = {r for passage in passages for r in passage}
    for r in range(2 * extent + 1):
        position = (extent, r)
        if position in tiles and r not in gap_rows:
            tiles[position] = Tile("water")

    # Only select one representative from each reflected pair. The seam was
    # already made symmetric and is left alone so passage metadata stays exact.
    for position in sorted(tiles):
        mirror = rotate_position(position, extent)
        if position > mirror or position[0] == extent:
            continue
        if not tiles[position].passable:
            continue
        roll = rng.randrange(20)
        if roll == 0:
            tile = Tile("hill")
        elif roll == 1:
            tile = Tile("grass", "forest")
        elif roll == 2:
            tile = Tile("grass", "marsh")
        else:
            continue
        tiles[position] = tile
        tiles[mirror] = tile
    passage_tiles = tuple(tuple((extent, r) for r in passage) for passage in passages)
    return tiles, passage_tiles


def _zone_tiles(center: Position, extent: int) -> tuple[Position, ...]:
    return (center, *neighbors(center, extent))


def _zones(extent: int, tiles: dict[Position, Tile], count: int) -> tuple[CaptureZone, ...]:
    if count == 0:
        return ()
    valid = [
        position
        for position in sorted(tiles)
        if len(_zone_tiles(position, extent)) == 7
        and all(tiles[candidate].passable for candidate in _zone_tiles(position, extent))
    ]
    chosen: list[Position] = []
    center = (extent, extent)
    if count % 2:
        if center not in valid:
            raise ValueError("battlefield has no passable central capture zone")
        chosen.append(center)
    for candidate in valid:
        mirror = rotate_position(candidate, extent)
        if len(chosen) >= count:
            break
        if candidate == mirror or candidate > mirror or mirror not in valid:
            continue
        if candidate in chosen or mirror in chosen:
            continue
        chosen.extend((candidate, mirror))
    if len(chosen) != count:
        raise ValueError("battlefield has insufficient passable capture zones")
    return tuple(CaptureZone(position, _zone_tiles(position, extent)) for position in chosen)


def _spawns(extent: int, tiles: dict[Position, Tile], units_per_side: int) -> dict[str, tuple[Position, ...]]:
    left = [position for position in sorted(tiles) if position[0] < extent and tiles[position].passable]
    # Spread a roster across the half deterministically, avoiding any dependence
    # on match-play randomness.
    if len(left) < units_per_side:
        raise ValueError("battlefield does not have enough spawn tiles")
    selected = tuple(left[index * len(left) // units_per_side] for index in range(units_per_side))
    return {"red": selected, "blue": tuple(rotate_position(position, extent) for position in selected)}


def generate_battlefield(
    extent: int,
    rng: Random,
    *,
    terrain: bool = False,
    capture_zones: int = 0,
    units_per_side: int = 3,
) -> Battlefield:
    """Build a connected field using only the supplied battlefield RNG stream."""
    if not 5 <= extent <= 22:
        raise ValueError("field extent must be from 5 through 22")
    if not 0 <= capture_zones <= 5:
        raise ValueError("capture zones must be from 0 through 5")
    for redraw in range(MAX_REDRAWS):
        tiles, passages = _terrain_tiles(extent, rng, terrain, capture_zones)
        try:
            zones = _zones(extent, tiles, capture_zones)
            field = Battlefield(
                extent, tiles, _spawns(extent, tiles, units_per_side), zones, passages, redraw
            )
        except ValueError:
            continue
        if field.connected():
            return field
    raise RuntimeError("could not construct a connected battlefield within the redraw limit")
