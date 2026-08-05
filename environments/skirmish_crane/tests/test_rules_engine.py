"""Pure regression tests for every Skirmish at Crane Reach Stage 1 rule."""

from __future__ import annotations

from dataclasses import replace
from itertools import product
from random import Random

import pytest

from skirmish_crane.ascii_runner import render, run_scripted_match
from skirmish_crane.battlefield import Battlefield, generate_battlefield
from skirmish_crane.combat import damage, resolve_strike
from skirmish_crane.engine import Match, MatchConfig, Order, Unit
from skirmish_crane.hexes import (
    DIRECTIONS,
    VOID,
    Tile,
    distance,
    field_positions,
    neighbor,
    neighbors,
    on_field,
    opposite,
    path_positions,
    retrace_path,
    rotate_path,
    rotate_position,
    tile_array,
)
from skirmish_crane.movement import legal_paths, walk
from skirmish_crane.paths import MAX_PATH_ID, decode_path, encode_path
from skirmish_crane.scoring import capture_result, elimination_result, score_capture


def _with_tile(field: Battlefield, position: tuple[int, int], tile: Tile) -> Battlefield:
    """Return the field with one tile replaced, since a battlefield is immutable."""
    q, r = position
    rows = [list(row) for row in field.tiles]
    rows[r][q] = tile
    return replace(field, tiles=tuple(tuple(row) for row in rows))


def _planted(match: Match, units: tuple[Unit, ...], order: tuple[str, ...] | None = None) -> Match:
    """Replace a generated roster with hand-placed units for one scripted scenario."""
    match.units = {unit.unit_id: unit for unit in units}
    match.activation_order = list(order if order is not None else (unit.unit_id for unit in units))
    match.activation_index = 0
    return match


def _seam_passages(field: Battlefield) -> tuple[tuple[tuple[int, int], ...], ...]:
    """Read water passages from the tiles, never from generator metadata."""
    cells = [
        (field.extent, r) for r in range(2 * field.extent + 1) if field.tile_at((field.extent, r)).passable
    ]
    groups: list[list[tuple[int, int]]] = []
    for cell in cells:
        if not groups or cell[1] != groups[-1][-1][1] + 1:
            groups.append([cell])
        else:
            groups[-1].append(cell)
    return tuple(tuple(group) for group in groups)


@pytest.mark.parametrize("extent", range(5, 23))
@pytest.mark.parametrize("terrain", (False, True))
@pytest.mark.parametrize("capture_zones", range(6))
@pytest.mark.parametrize("seed", range(5))
def test_battlefields_hold_topology_symmetry_and_zone_guarantees(
    extent: int, terrain: bool, capture_zones: int, seed: int
) -> None:
    field = generate_battlefield(
        extent,
        Random(f"{extent}:{terrain}:{capture_zones}:{seed}"),
        terrain=terrain,
        wasteland=terrain,
        capture_zones=capture_zones,
        units_per_side=20,
    )

    assert field.connected()
    assert len(field.tiles) == field.side and all(len(row) == field.side for row in field.tiles)
    # The grid covers the square exactly: void outside the hexagon, never inside it.
    on_hexagon = set(field_positions(extent))
    assert all(
        (field.tiles[r][q] == VOID) is ((q, r) not in on_hexagon)
        for r in range(field.side)
        for q in range(field.side)
    )
    assert all(
        field.tile_at(position) == field.tile_at(rotate_position(position, extent))
        for position in field_positions(extent)
    )
    assert field.spawns["blue"] == tuple(
        rotate_position(position, extent) for position in field.spawns["red"]
    )
    assert len(field.zones) == capture_zones
    assert all(
        len(zone.tiles) == 7 and all(field.tile_at(tile).passable for tile in zone.tiles)
        for zone in field.zones
    )
    assert all(set(zone.tiles) == {zone.center, *neighbors(zone.center, extent)} for zone in field.zones)
    assert ((extent, extent) in {zone.center for zone in field.zones}) is bool(capture_zones % 2)
    assert {zone.center for zone in field.zones} == {
        rotate_position(zone.center, extent) for zone in field.zones
    }
    # No unit may ever stand in two zones at once, so one activation cannot score twice.
    assert all(
        not set(first.tiles) & set(second.tiles)
        for index, first in enumerate(field.zones)
        for second in field.zones[index + 1 :]
    )

    passages = _seam_passages(field)
    if terrain:
        assert len(passages) in (2, 3)
        assert all(2 <= len(passage) <= 4 for passage in passages)
    else:
        assert all(field.tile_at(position) == Tile() for position in field_positions(extent))
        assert not passages or passages == (tuple((extent, r) for r in range(2 * extent + 1)),)


def test_hex_geometry_and_path_codec_are_complete_and_pinned() -> None:
    assert set(DIRECTIONS) == set(range(1, 7))
    assert distance((1, 4), (4, 2)) == 3
    assert neighbor((3, 3), 1) == (4, 2)
    assert encode_path([]) == 0
    assert encode_path([1]) == 1
    assert encode_path([6]) == 6
    assert encode_path([1, 1]) == 7
    assert encode_path([6, 6, 6, 6]) == 1554
    assert [encode_path(decode_path(path_id)) for path_id in range(MAX_PATH_ID + 1)] == list(
        range(MAX_PATH_ID + 1)
    )
    for invalid in ([0], [7], [1, 2, 3, 4, 5]):
        with pytest.raises(ValueError):
            encode_path(invalid)
    with pytest.raises(ValueError):
        encode_path([True])
    with pytest.raises(ValueError):
        Order(path=(True,))
    for invalid in (-1, True, 1555):
        with pytest.raises(ValueError):
            decode_path(invalid)


def test_hex_field_shape_rotation_and_void_array_are_pinned() -> None:
    for extent in range(1, 6):
        positions = tuple(field_positions(extent))
        assert len(positions) == 3 * extent**2 + 3 * extent + 1
        assert all(
            0 <= q <= 2 * extent and 0 <= r <= 2 * extent and extent <= q + r <= 3 * extent
            for q, r in positions
        )
    assert on_field((0, 2), 2)
    assert on_field((2, 0), 2)
    assert on_field((4, 2), 2)
    assert not on_field((0, 0), 2)
    assert not on_field((-1, 3), 2)
    assert not on_field((5, 0), 2)
    array = tile_array(2, {position: Tile() for position in field_positions(2)})
    assert len(array) == 5 and all(len(row) == 5 for row in array)
    assert array[0][0] == VOID
    assert array[4][4] == VOID
    assert array[2][0] == Tile()
    assert tuple(opposite(direction) for direction in range(1, 7)) == (4, 5, 6, 1, 2, 3)
    assert rotate_position((0, 2), 2) == (4, 2)
    assert rotate_path((1, 2)) == (4, 5)
    assert retrace_path((1, 2)) == (5, 4)
    assert path_positions((7, 7), ()) == ()
    assert path_positions((7, 7), (2, 3)) == ((8, 7), (8, 8))


def test_wasteland_scatters_only_when_its_parameter_and_terrain_are_both_on() -> None:
    def field(terrain: bool, wasteland: bool) -> Battlefield:
        return generate_battlefield(
            10, Random("waste"), terrain=terrain, wasteland=wasteland, units_per_side=20
        )

    scattered = field(True, True)
    withheld = field(True, False)
    bare = field(False, True)
    assert any(scattered.tile_at(position).feature == "waste" for position in field_positions(10))
    assert not any(withheld.tile_at(position).feature == "waste" for position in field_positions(10))
    assert all(bare.tile_at(position) == Tile() for position in field_positions(10))
    assert all(
        scattered.tile_at(position) == scattered.tile_at(rotate_position(position, 10))
        for position in field_positions(10)
    )
    # Withholding wasteland leaves the rest of the draw untouched: those tiles stay plain.
    for position in field_positions(10):
        drawn = scattered.tile_at(position)
        expected = Tile(drawn.terrain) if drawn.feature == "waste" else drawn
        assert withheld.tile_at(position) == expected


def test_features_sit_on_any_passable_terrain_and_stack_their_costs() -> None:
    assert Tile("grass", "waste").move_cost == 1
    assert Tile("hill", "waste").move_cost == 2
    assert Tile("hill", "forest").move_cost == 3
    assert Tile("hill", "marsh").move_cost == 4
    # A path costs the same across wasteland as across the plain ground it replaces.
    field = generate_battlefield(5, Random(1))
    plain = legal_paths(field, (5, 5), 2, set())
    wasted = _with_tile(field, (6, 5), Tile("grass", "waste"))
    assert legal_paths(wasted, (5, 5), 2, set()) == plain


def _waste_walk(
    kind: str, hit_points: int, waste: tuple[tuple[int, int], ...], path: tuple[int, ...]
) -> Unit:
    """Walk one planted unit over a field carrying wasteland on the given tiles."""
    unit = Unit(f"red_{kind}_0", "red", kind, (7, 7), hit_points)
    # The enemy sits outside every attack range so only the walk changes hit points.
    enemy = Unit("blue_archer_0", "blue", "archer", (0, 14), 6)
    match = _planted(Match(MatchConfig(seed=0, round_cap=5)), (unit, enemy), (unit.unit_id,))
    for position in waste:
        match.battlefield = _with_tile(match.battlefield, position, Tile("grass", "waste"))
    match.apply_order(Order(path=path))
    return unit


def test_entering_wasteland_wounds_a_unit_once_for_every_tile_it_enters() -> None:
    # Two waste tiles walked in one order, the second of them the tile the unit ends on.
    assert _waste_walk("footman", 12, ((8, 7), (9, 7)), (2, 2)).hit_points == 8
    # Crossing wasteland still costs even when the unit ends on clean ground.
    assert _waste_walk("footman", 12, ((8, 7),), (2, 2)).hit_points == 10
    # A path that re-enters the same tile pays for it again.
    assert _waste_walk("cavalry", 10, ((8, 7),), (2, 5, 2, 5)).hit_points == 6
    # Standing still is safe, even standing on wasteland.
    assert _waste_walk("footman", 12, ((7, 7),), ()).hit_points == 12


def test_wasteland_damage_floors_at_one_hit_point_and_never_kills() -> None:
    match = _planted(
        Match(MatchConfig(seed=0, round_cap=5)),
        (
            Unit("red_footman_0", "red", "footman", (7, 7), 2),
            Unit("blue_archer_0", "blue", "archer", (0, 14), 6),
        ),
        ("red_footman_0",),
    )
    match.battlefield = _with_tile(match.battlefield, (8, 7), Tile("grass", "waste"))
    match.battlefield = _with_tile(match.battlefield, (9, 7), Tile("grass", "waste"))
    activation = match.apply_order(Order(path=(2, 2)))

    assert match.units["red_footman_0"].hit_points == 1
    assert activation.killed_id is None
    assert "red_footman_0" in match.units


def test_movement_matrix_covers_cost_balance_blocking_and_length() -> None:
    field = generate_battlefield(5, Random(1))
    start = (5, 5)
    field = _with_tile(field, (6, 5), Tile("hill"))
    assert walk(field, start, 1, (2,), set()) == (6, 5)
    assert walk(field, start, 2, (2,), set()) == (6, 5)
    with pytest.raises(ValueError, match="negative"):
        walk(field, start, 1, (2, 3), set())
    with pytest.raises(ValueError, match="occupied"):
        walk(field, start, 2, (2,), {(6, 5)})
    field = _with_tile(field, (6, 5), Tile("water"))
    with pytest.raises(ValueError, match="impassable"):
        walk(field, start, 2, (2,), set())
    with pytest.raises(ValueError, match="four"):
        walk(field, start, 4, (1, 2, 3, 4, 5), set())


@pytest.mark.parametrize(
    ("charge", "attacker_hill", "defender_hill", "forest", "shield"), product((False, True), repeat=5)
)
def test_damage_modifier_matrix(
    charge: bool,
    attacker_hill: bool,
    defender_hill: bool,
    forest: bool,
    shield: bool,
) -> None:
    field = generate_battlefield(5, Random(2))
    attacker = Unit("red_cavalry_0", "red", "cavalry", (5, 5), 10)
    defender = Unit("blue_footman_0", "blue", "footman", (8, 5), 12)
    units = {attacker.unit_id: attacker, defender.unit_id: defender}
    if attacker_hill:
        field = _with_tile(field, attacker.position, Tile("hill"))
    if defender_hill:
        field = _with_tile(field, defender.position, Tile("hill"))
    if forest:
        field = _with_tile(field, defender.position, Tile(field.tile_at(defender.position).terrain, "forest"))
    if shield:
        ally = Unit("blue_footman_1", "blue", "footman", (7, 5), 12)
        units[ally.unit_id] = ally
    start = (2, 5) if charge else attacker.position
    expected = 3
    effective_charge = charge and not forest and not shield
    if effective_charge:
        expected += 2
    if attacker_hill and not defender_hill:
        expected += 1
    if defender_hill and not attacker_hill:
        expected -= 1
    if forest:
        expected -= 1
    if shield:
        expected -= 1
    assert damage(attacker, defender, field, units, abilities=True, start=start) == max(1, expected)


def test_abilities_off_suppresses_charge_and_shield_but_keeps_terrain() -> None:
    field = generate_battlefield(5, Random(21))
    cavalry = Unit("red_cavalry_0", "red", "cavalry", (5, 5), 10)
    footman = Unit("blue_footman_0", "blue", "footman", (8, 5), 12)
    units = {cavalry.unit_id: cavalry, footman.unit_id: footman}
    assert damage(cavalry, footman, field, units, abilities=False, start=(2, 5)) == 3
    assert damage(cavalry, footman, field, units, abilities=True, start=(2, 5)) == 5

    ally = Unit("blue_footman_1", "blue", "footman", (7, 5), 12)
    units[ally.unit_id] = ally
    assert damage(cavalry, footman, field, units, abilities=False, start=cavalry.position) == 3
    assert damage(cavalry, footman, field, units, abilities=True, start=cavalry.position) == 2

    on_hill = _with_tile(field, cavalry.position, Tile("hill"))
    assert damage(cavalry, footman, on_hill, units, abilities=False, start=cavalry.position) == 4
    in_forest = _with_tile(field, footman.position, Tile("grass", "forest"))
    assert damage(cavalry, footman, in_forest, units, abilities=False, start=cavalry.position) == 2


def test_strike_rule_matrix_named_automatic_mandatory_range_and_visibility() -> None:
    field = generate_battlefield(5, Random(3))
    attacker = Unit("red_archer_0", "red", "archer", (5, 5), 6)
    nearest = Unit("blue_footman_0", "blue", "footman", (6, 5), 12)
    named = Unit("blue_archer_0", "blue", "archer", (7, 5), 6)
    units = {unit.unit_id: unit for unit in (attacker, nearest, named)}
    named_strike = resolve_strike(
        attacker,
        units,
        field,
        Random(7),
        named_target=named.unit_id,
        visible_at_activation={named.unit_id},
        abilities=False,
        start=attacker.position,
    )
    assert named_strike is not None
    assert (named_strike.target_id, named_strike.automatic) == (named.unit_id, False)
    automatic = resolve_strike(
        attacker,
        units,
        field,
        Random(7),
        named_target=named.unit_id,
        visible_at_activation=set(),
        abilities=False,
        start=attacker.position,
    )
    assert automatic is not None
    assert (automatic.target_id, automatic.automatic) == (nearest.unit_id, True)
    attacker.position = (0, 5)
    attacker.kind = "footman"
    assert (
        resolve_strike(
            attacker,
            units,
            field,
            Random(7),
            named_target=None,
            visible_at_activation=set(),
            abilities=False,
            start=attacker.position,
        )
        is None
    )


def test_automatic_strike_draws_every_tied_nearest_target_and_never_farther() -> None:
    selected: set[str] = set()
    for seed in range(20):
        field = generate_battlefield(5, Random(31))
        attacker = Unit("red_archer_0", "red", "archer", (5, 5), 6)
        left = Unit("blue_footman_0", "blue", "footman", (6, 5), 12)
        right = Unit("blue_footman_1", "blue", "footman", (5, 6), 12)
        farther = Unit("blue_footman_2", "blue", "footman", (7, 5), 12)
        units = {unit.unit_id: unit for unit in (attacker, left, right, farther)}
        strike = resolve_strike(
            attacker,
            units,
            field,
            Random(seed),
            named_target=None,
            visible_at_activation=set(),
            abilities=False,
            start=attacker.position,
        )
        assert strike is not None
        selected.add(strike.target_id)
    assert selected == {"blue_footman_0", "blue_footman_1"}


def test_automatic_strikes_consume_match_play_randomness_in_execution_order() -> None:
    field = generate_battlefield(5, Random(4))
    attacker = Unit("red_archer_0", "red", "archer", (5, 5), 6)
    left = Unit("blue_footman_0", "blue", "footman", (6, 5), 12)
    right = Unit("blue_footman_1", "blue", "footman", (5, 6), 12)
    units = {unit.unit_id: unit for unit in (attacker, left, right)}
    named_rng, automatic_rng = Random(10), Random(10)
    resolve_strike(
        attacker,
        units,
        field,
        named_rng,
        named_target=left.unit_id,
        visible_at_activation={left.unit_id},
        abilities=False,
        start=attacker.position,
    )
    resolve_strike(
        attacker,
        units,
        field,
        automatic_rng,
        named_target=None,
        visible_at_activation=set(),
        abilities=False,
        start=attacker.position,
    )
    assert named_rng.getstate() != automatic_rng.getstate()
    named_later = list(range(12))
    automatic_later = list(range(12))
    named_rng.shuffle(named_later)
    automatic_rng.shuffle(automatic_later)
    assert named_later != automatic_later


def _match_with_tied_automatic_targets() -> Match:
    attacker = Unit("red_archer_0", "red", "archer", (5, 5), 6)
    left = Unit("blue_footman_0", "blue", "footman", (6, 5), 12)
    right = Unit("blue_footman_1", "blue", "footman", (5, 6), 12)
    return _planted(Match(MatchConfig(seed=0, round_cap=2)), (attacker, left, right), (attacker.unit_id,))


def test_match_order_resolution_consumes_rng_only_for_automatic_strikes() -> None:
    named = _match_with_tied_automatic_targets()
    expected_rng = Random()
    expected_rng.setstate(named.match_rng.getstate())
    expected_shuffle = sorted(named.units)
    expected_rng.shuffle(expected_shuffle)
    expected_state_after_shuffle = expected_rng.getstate()
    named.apply_order(Order(target="blue_footman_0"))
    assert named.activation_order == expected_shuffle
    assert named.match_rng.getstate() == expected_state_after_shuffle
    expected_next_draw = expected_rng.random()
    assert named.match_rng.random() == expected_next_draw

    automatic = _match_with_tied_automatic_targets()
    automatic.apply_order(Order())
    assert automatic.activation_order != expected_shuffle
    assert automatic.match_rng.getstate() != expected_state_after_shuffle
    assert automatic.match_rng.random() != expected_next_draw


def test_battlefield_randomness_never_consumes_match_play_randomness() -> None:
    plain = Match(MatchConfig(seed=12, terrain=False, capture_zones=0))
    generated = Match(MatchConfig(seed=12, terrain=True, capture_zones=3))
    assert plain.activation_order == generated.activation_order
    assert plain.match_rng.getstate() == generated.match_rng.getstate()


def test_capture_scoring_and_all_end_condition_score_formulas() -> None:
    field = generate_battlefield(5, Random(5), capture_zones=1)
    red = Unit("red_footman_0", "red", "footman", field.zones[0].center, 12)
    blue = Unit("blue_footman_0", "blue", "footman", (0, 5), 12)
    assert score_capture(field, {blue.unit_id: blue}, {"red": 0, "blue": 0}) == {
        "red": 0,
        "blue": 0,
    }
    assert score_capture(field, {red.unit_id: red, blue.unit_id: blue}, {"red": 0, "blue": 0}) == {
        "red": 1,
        "blue": 0,
    }
    blue.position = field.zones[0].tiles[1]
    assert score_capture(field, {red.unit_id: red, blue.unit_id: blue}, {"red": 0, "blue": 0}) == {
        "red": 0,
        "blue": 0,
    }
    assert elimination_result({"red": 15, "blue": 0}, {"red": 30, "blue": 30}, round_cap=False).red == 85
    blue_elimination = elimination_result({"red": 0, "blue": 15}, {"red": 30, "blue": 30}, round_cap=False)
    assert (blue_elimination.red, blue_elimination.blue, blue_elimination.winner) == (0, 85, "blue")
    capped = elimination_result({"red": 25, "blue": 10}, {"red": 30, "blue": 30}, round_cap=True)
    assert (capped.red, capped.blue, capped.winner) == (85, 15, "red")
    assert elimination_result({"red": 10, "blue": 10}, {"red": 30, "blue": 30}, round_cap=True).red == 50
    eliminated = capture_result(
        {"red": 1, "blue": 0}, {"red": 0, "blue": 0}, 20, capture_won=False, capped=True
    )
    # Elimination outranks the round cap, and names itself whatever the caller was expecting.
    assert (eliminated.red, eliminated.reason) == (100, "elimination")
    won = capture_result({"red": 10, "blue": 10}, {"red": 20, "blue": 10}, 20, capture_won=True, capped=False)
    assert (won.red, won.reason) == (85, "capture")
    blue_capture = capture_result(
        {"red": 10, "blue": 10}, {"red": 10, "blue": 20}, 20, capture_won=True, capped=False
    )
    assert (blue_capture.red, blue_capture.blue, blue_capture.winner) == (15, 85, "blue")
    drawn = capture_result({"red": 10, "blue": 10}, {"red": 5, "blue": 5}, 20, capture_won=False, capped=True)
    assert (drawn.red, drawn.reason) == (50, "round_cap")
    hp_tiebreak = capture_result(
        {"red": 11, "blue": 10}, {"red": 5, "blue": 5}, 20, capture_won=False, capped=True
    )
    assert (hp_tiebreak.red, hp_tiebreak.blue, hp_tiebreak.winner) == (70, 30, "red")


def test_killed_unit_is_skipped_and_initial_roster_survives() -> None:
    match = Match(MatchConfig(seed=6, round_cap=2))
    assert {entry.unit_id for entry in match.initial_rosters["red"]} == {
        "red_footman_0",
        "red_archer_0",
        "red_cavalry_0",
    }
    original_red_roster = match.initial_rosters["red"]
    killer = Unit("red_archer_0", "red", "archer", (5, 5), 6)
    victim = Unit("blue_archer_0", "blue", "archer", (6, 5), 1)
    _planted(match, (killer, victim))
    activation = match.apply_order(Order(target=victim.unit_id))
    assert activation.killed_id == victim.unit_id
    assert victim.unit_id not in match.units
    assert match.current_unit_id is None
    assert match.initial_rosters["red"] == original_red_roster
    assert victim.unit_id in {entry.unit_id for entry in match.initial_rosters["blue"]}
    with pytest.raises(TypeError):
        match.initial_rosters["red"] = ()  # type: ignore[index]


def test_orders_with_unwalkable_paths_or_unnameable_targets_are_rejected() -> None:
    """The ruleset rejects both outright, so neither may quietly degrade into something legal."""
    match = Match(MatchConfig(seed=17))
    archer = Unit("red_archer_0", "red", "archer", (7, 7), 6)
    adjacent = Unit("blue_footman_0", "blue", "footman", (8, 7), 12)
    unseen = Unit("blue_footman_1", "blue", "footman", (0, 10), 12)
    _planted(match, (archer, adjacent, unseen))
    assert distance(archer.position, unseen.position) > archer.stats.vision

    with pytest.raises(ValueError, match="not walkable"):
        match.apply_order(Order(path=(5, 5, 5)))  # three steps on two movement points
    with pytest.raises(ValueError, match="not walkable"):
        match.apply_order(Order(path=(2,)))  # the only step lands on an occupied tile
    with pytest.raises(ValueError, match="not nameable"):
        match.apply_order(Order(target=unseen.unit_id))
    with pytest.raises(ValueError, match="not nameable"):
        match.apply_order(Order(target="red_archer_0"))
    assert (archer.position, match.activation_index) == ((7, 7), 0)

    activation = match.apply_order(Order(path=(5,), target=adjacent.unit_id))
    assert (activation.end, activation.strike is not None) == ((6, 7), True)


def test_elimination_on_the_capped_round_uses_elimination_scoring() -> None:
    match = Match(MatchConfig(seed=13, round_cap=1))
    killer = Unit("red_archer_0", "red", "archer", (5, 5), 6)
    victim = Unit("blue_archer_0", "blue", "archer", (6, 5), 1)
    _planted(match, (killer, victim))
    match.starting_hit_points = {"red": 6, "blue": 6}
    match.apply_order(Order(target=victim.unit_id))
    assert match.result is not None
    assert (match.result.reason, match.result.red, match.result.blue) == ("elimination", 100, 0)


def test_capture_elimination_on_the_capped_round_reports_elimination_not_round_cap() -> None:
    """The terminal reason is decided once, by the scorer, not by the caller."""
    match = Match(MatchConfig(seed=13, capture_zones=1, round_cap=1))
    killer = Unit("red_archer_0", "red", "archer", (7, 7), 6)
    victim = Unit("blue_archer_0", "blue", "archer", (8, 7), 1)
    _planted(match, (killer, victim))
    match.apply_order(Order(target=victim.unit_id))
    assert match.result is not None
    assert (match.result.reason, match.result.red, match.result.blue) == ("elimination", 100, 0)


def test_perception_is_defensive_and_exposes_authoritative_legality() -> None:
    match = Match(MatchConfig(seed=7))
    unit_id = match.current_unit_id
    assert unit_id is not None
    observation = match.perception(unit_id)
    assert "walkable_paths" in observation
    assert "nameable_targets" in observation
    assert tuple(observation["walkable_paths"]) == match.legal_orders(unit_id)[0]
    assert tuple(observation["nameable_targets"]) == match.legal_orders(unit_id)[1]
    observation["self"]["hit_points"] = 0  # type: ignore[index]
    with pytest.raises((TypeError, AttributeError)):
        observation["battlefield"].tiles[(5, 5)] = Tile("water")  # type: ignore[union-attr,index]
    assert match.units[unit_id].hit_points == match.units[unit_id].stats.hit_points


def test_messages_are_not_part_of_stage_one_orders_and_the_flag_is_inert() -> None:
    assert "messages" not in Order.__dataclass_fields__
    plain = Match(MatchConfig(seed=11, round_cap=1))
    enabled = Match(MatchConfig(seed=11, messages=True, round_cap=1))
    assert plain.run_scripted(lambda _match, _unit_id: Order()) == enabled.run_scripted(
        lambda _match, _unit_id: Order()
    )
    with pytest.raises(TypeError):
        Order(messages=())  # type: ignore[call-arg]


@pytest.mark.parametrize("seat_plan", ("skirmish", "army"))
def test_completed_all_variant_scripted_replays_are_deterministic(seat_plan: str) -> None:
    config = MatchConfig(
        seed=8,
        seat_plan=seat_plan,
        terrain=True,
        unit_abilities=True,
        messages=True,
        capture_zones=3,
        round_cap=2,
    )
    first, second = Match(config), Match(config)
    assert first.battlefield == second.battlefield
    assert first.activation_order == second.activation_order
    assert first.run_scripted(lambda _match, _unit_id: Order()) is not None
    assert second.run_scripted(lambda _match, _unit_id: Order()) is not None
    assert first.result == second.result
    assert first.history == second.history
    assert render(first) == render(second)
    replay, transcript = run_scripted_match(config)
    assert replay.result == first.result
    assert replay.history == first.history
    assert transcript.count("round ") == config.round_cap
