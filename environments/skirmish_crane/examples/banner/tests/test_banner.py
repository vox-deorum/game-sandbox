"""Example-specific tests, added on top of the inherited template tests.

Three kinds. The first builds one activation by hand per block, a single observation dict with a
chosen action mask, and checks that the block reads it the way its docstring promises. The second
checks the shipped ``assign`` mapping and the dispatch fallback in ``agent.py``: replacing
``assign`` only requires re-pinning ``test_assign_pins_the_shipped_mapping``, since the rest of
that section checks properties a replacement should still keep. The third plays whole Season 4
matches: a wrapper that runs every block in the library against each live activation and checks
every returned order stays mask legal, and the detachment against the built-in naive side on a
pinned set of seeds it is expected to win from either side of the field.
"""

from __future__ import annotations

import agent
import blocks
from sandbox.crane import action, paths, tile, units
from sandbox.env import META, make_env
from sandbox.env.skirmish_crane import naive
from sandbox.harness.environment import resolve_parameters
from sandbox.play import play_episode

# Season 4 read straight from the environment metadata, so these tests stay honest if the preset
# ever changes.
SEASON_4 = dict(next(preset for preset in META.presets if preset.name == "season_4").values)
SEASON_4_PARAMETERS = resolve_parameters(META, SEASON_4)

# Pinned seeds for the coherence bar. Every one of them is a win for banner, from either side of
# the field, under Season 4 parameters.
RED_SEEDS = (0, 1, 2, 3, 4, 5)
BLUE_SEEDS = (6, 7)
FUZZ_SEEDS = (0, 1)
WIN_SCORE = 70.0

FIELD_EXTENT = 7
FIELD_SIDE = 2 * FIELD_EXTENT + 1
PATH_VALUES = 1555
SKIRMISH_ROSTER = ("footman", "archer", "cavalry")


# -- building an activation by hand ------------------------------------------------------------


def _position(coordinates: tuple[int, int]) -> dict[str, int]:
    return {"q": coordinates[0], "r": coordinates[1]}


def _roster(side: str, types: tuple[str, ...]) -> tuple[dict[str, str], ...]:
    """Number one side's units the way the environment does: by type, in roster order."""
    seen: dict[str, int] = {}
    entries = []
    for index, unit_type in enumerate(types):
        number = seen.get(unit_type, 0)
        seen[unit_type] = number + 1
        entries.append(
            {
                "player": f"player_{index}",
                "unit_id": f"{side}_{unit_type}_{number}",
                "side": side,
                "type": unit_type,
            }
        )
    return tuple(entries)


def _visible(unit_id: str, coordinates: tuple[int, int], hit_points: int) -> dict[str, object]:
    side, unit_type, _ = unit_id.split("_")
    return {
        "unit_id": unit_id,
        "side": side,
        "type": unit_type,
        "position": _position(coordinates),
        "hit_points": hit_points,
    }


def _zone(center: tuple[int, int]) -> dict[str, object]:
    """Build one capture zone the way the battlefield does: a center plus its six neighbors."""
    center_position = _position(center)
    return {"center": center_position, "tiles": (center_position, *tile.neighbors(center_position).values())}


def _observation(
    unit_id: str,
    coordinates: tuple[int, int],
    walkable: tuple[tuple[int, ...], ...],
    seen: tuple[dict[str, object], ...] = (),
    *,
    red: tuple[str, ...] = SKIRMISH_ROSTER,
    blue: tuple[str, ...] = SKIRMISH_ROSTER,
    zones: tuple[dict[str, object], ...] = (),
    capture_zones: int = 0,
    unit_abilities: int = 1,
):
    """Assemble one activation: who we are, what we see, and exactly what the mask allows.

    ``walkable`` lists the direction tuples the mask marks walkable; standing still is always
    legal and is added for you. Every visible enemy is nameable, as it is in a real match.
    ``unit_abilities`` defaults to on, since only :func:`blocks.charge` reads it and most charge
    tests want it on; pass a nonzero ``zones`` and ``capture_zones`` together where a test needs
    a capture zone on the battlefield.
    """
    side, unit_type, _ = unit_id.split("_")
    rosters = {"red": _roster("red", red), "blue": _roster("blue", blue)}
    enemies = rosters["blue" if side == "red" else "red"]
    path_mask = [0] * PATH_VALUES
    for directions in ((), *walkable):
        path_mask[paths.encode(directions)] = 1
    watched = {unit["unit_id"] for unit in seen}
    target_mask = [1] + [int(entry["unit_id"] in watched) for entry in enemies]
    stats = units.STATS[unit_type]
    return {
        "observation": {
            "self": {
                "unit_id": unit_id,
                "type": unit_type,
                "position": _position(coordinates),
                "hit_points": stats.hit_points,
                "movement_points": stats.movement_points,
                "direction": 2 if side == "red" else 5,
            },
            "visible_units": tuple(seen),
            "round": 3,
            "capture": {"red": 0, "blue": 0, "target": 200 if capture_zones else 0},
            "battlefield": {"side": FIELD_SIDE, "tiles": (), "zones": zones},
            "rosters": rosters,
            "parameters": {
                "seat_plan": "skirmish",
                "field_extent": FIELD_EXTENT,
                "terrain": 0,
                "wasteland": 0,
                "unit_abilities": unit_abilities,
                "capture_zones": capture_zones,
                "capture_target": 200,
                "round_cap": 1000,
            },
        },
        "action_mask": {"path": path_mask, "target": target_mask},
    }


def _endpoint(coordinates: tuple[int, int], path_id: int) -> dict[str, int]:
    """Walk a chosen path from a starting tile to the tile the order ends on."""
    return tile.at_path_end(_position(coordinates), path_id)


def _slot(observation, unit_id: str) -> int:
    """Return the 1-based target slot naming ``unit_id``, the number an order's target carries."""
    side = unit_id.split("_", 1)[0]
    roster = observation["observation"]["rosters"][side]
    return next(index for index, entry in enumerate(roster) if entry["unit_id"] == unit_id) + 1


# -- advance --------------------------------------------------------------------------------------


def test_advance_lands_strictly_closer_to_the_goal():
    start = (5, 5)
    goal = _position((12, 5))
    observation = _observation("red_footman_0", start, ((2,),))

    order = blocks.advance(observation, {}, goal)

    end = _endpoint(start, order["path"])
    assert tile.distance(end, goal) < tile.distance(_position(start), goal)


# -- hold_ground ------------------------------------------------------------------------------------


def test_hold_ground_stays_tethered_and_names_a_victim_in_range():
    start = (5, 5)
    goal = _position((6, 5))
    enemy = _visible("blue_footman_0", (8, 5), 12)
    observation = _observation("red_footman_0", start, ((2,), (2, 2)), (enemy,))

    order = blocks.hold_ground(observation, {}, goal)

    end = _endpoint(start, order["path"])
    assert tile.distance(end, goal) <= blocks.TETHER
    # Naming a target only happens through _victim, which only names an enemy in range, so a
    # named target here is itself the proof this landing gives the unit something to strike.
    assert order["target"] != 0


# -- kite -------------------------------------------------------------------------------------------


def test_kite_gives_ground_while_staying_in_bow_range():
    start = (7, 7)
    enemy = _visible("blue_cavalry_0", (8, 7), 10)
    observation = _observation("red_archer_0", start, ((5,),), (enemy,))

    order = blocks.kite(observation, {}, None)

    end = _endpoint(start, order["path"])
    enemy_position = _position((8, 7))
    assert tile.distance(end, enemy_position) > tile.distance(_position(start), enemy_position)
    assert tile.distance(end, enemy_position) <= units.STATS["archer"].attack_range
    assert order["target"] == _slot(observation, "blue_cavalry_0")


def test_kite_returns_none_with_nothing_visible():
    observation = _observation("red_archer_0", (7, 7), ((5,),))

    assert blocks.kite(observation, {}, None) is None


# -- charge -----------------------------------------------------------------------------------------


def test_charge_rides_a_displacement_three_path_into_a_strike():
    start = (7, 7)
    enemy = _visible("blue_footman_0", (11, 7), 12)
    observation = _observation("red_cavalry_0", start, ((2, 2, 2),), (enemy,))

    order = blocks.charge(observation, {}, None)

    end = _endpoint(start, order["path"])
    assert tile.distance(_position(start), end) >= blocks.CHARGE_DISTANCE
    assert order["target"] == _slot(observation, "blue_footman_0")


def test_charge_returns_none_without_a_displacement_three_path():
    # A cavalry with abilities on, so the two guards charge checks first are both satisfied and
    # cannot explain the None. Every path this mask offers is shorter than CHARGE_DISTANCE, and an
    # enemy sits in range of the two-step landing, so a missing target is not the reason either.
    start = (7, 7)
    enemy = _visible("blue_footman_0", (9, 7), 12)
    observation = _observation("red_cavalry_0", start, ((2,), (2, 2)), (enemy,))

    assert blocks.charge(observation, {}, None) is None


def test_charge_returns_none_for_a_unit_that_is_not_cavalry():
    # The ride is only worth taking for the unit type that earns the bonus. Nothing else about
    # this activation would stop it: the three-step path is offered and it ends beside an enemy.
    start = (7, 7)
    enemy = _visible("blue_footman_0", (11, 7), 12)
    observation = _observation("red_archer_0", start, ((2, 2, 2),), (enemy,))

    assert blocks.charge(observation, {}, None) is None


def test_charge_returns_none_when_the_abilities_variant_is_off():
    # With no charge bonus in the rules there is nothing to ride for, and sprinting three tiles
    # would only walk the cavalry past nearer enemies for a reward that does not exist.
    start = (7, 7)
    enemy = _visible("blue_footman_0", (11, 7), 12)
    observation = _observation("red_cavalry_0", start, ((2, 2, 2),), (enemy,), unit_abilities=0)

    assert blocks.charge(observation, {}, None) is None


def test_charge_prefers_the_defender_the_bonus_actually_lands_on():
    # One displacement-3 ride ends beside both a nearly-dead footman braced by an allied footman
    # and a full-health archer standing alone. Charge should name the archer, since the bonus lands
    # there, even though the footman's hit points look far more tempting.
    start = (7, 7)
    sheltered_defender = _visible("blue_footman_1", (11, 7), 1)
    sheltering_ally = _visible("blue_footman_2", (12, 7), 12)
    exposed_defender = _visible("blue_archer_0", (10, 8), 6)
    observation = _observation(
        "red_cavalry_0",
        start,
        ((2, 2, 2),),
        (sheltered_defender, sheltering_ally, exposed_defender),
        blue=("footman", "footman", "footman", "archer", "cavalry"),
    )

    order = blocks.charge(observation, {}, None)

    assert order["target"] == _slot(observation, "blue_archer_0")


# -- capture ----------------------------------------------------------------------------------------


def test_capture_holds_inside_an_uncontested_zone():
    # A deliberately lopsided zone: only the center and one tile three hexes east of it. Standing
    # still lands a hex closer to the center than either zone tile, so advance would rather not
    # move at all; only capture's preference for zone membership over raw closeness can pick the
    # farther tile that is actually part of the zone.
    center = _position((7, 7))
    far_tile = _position((10, 7))
    zone = {"center": center, "tiles": (center, far_tile)}
    start = (8, 7)  # outside the zone, one hex from the center
    observation = _observation("red_footman_0", start, ((2,), (2, 2)), zones=(zone,), capture_zones=1)

    order = blocks.capture(observation, {}, center)

    end = _endpoint(start, order["path"])
    assert (end["q"], end["r"]) == (far_tile["q"], far_tile["r"])


def test_capture_returns_none_when_the_goal_is_not_in_a_zone():
    zone = _zone((7, 7))
    observation = _observation("red_footman_0", (7, 7), ((2,),), zones=(zone,), capture_zones=1)

    assert blocks.capture(observation, {}, _position((0, 0))) is None


# -- fall_back --------------------------------------------------------------------------------------


def test_fall_back_widens_the_gap_to_the_nearest_enemy():
    start = (7, 7)
    enemy = _visible("blue_footman_0", (8, 7), 12)
    observation = _observation("red_footman_0", start, ((5,),), (enemy,))

    order = blocks.fall_back(observation, {}, None)

    end = _endpoint(start, order["path"])
    enemy_position = _position((8, 7))
    assert tile.distance(end, enemy_position) > tile.distance(_position(start), enemy_position)


def test_fall_back_returns_none_with_nothing_visible():
    observation = _observation("red_footman_0", (7, 7), ((5,),))

    assert blocks.fall_back(observation, {}, None) is None


# -- screen -----------------------------------------------------------------------------------------


def test_screen_stands_on_the_line_between_goal_and_threat():
    # Two landings are on offer, both within tether. Standing still is closer to the goal but off
    # the goal-threat line; the three-step walk is farther from the goal but sits squarely on that
    # line. Only screen's preference for the line over raw closeness can pick the walk.
    start = (7, 6)
    goal = _position((7, 7))
    enemy = _visible("blue_footman_0", (14, 7), 12)
    observation = _observation("red_footman_0", start, ((2, 2, 3),), (enemy,))

    order = blocks.screen(observation, {}, goal)

    end = _endpoint(start, order["path"])
    threat_position = _position((14, 7))
    span = tile.distance(goal, threat_position)
    detour = tile.distance(goal, end) + tile.distance(end, threat_position) - span
    assert detour == 0
    assert tile.distance(end, goal) <= blocks.TETHER


def test_screen_returns_none_with_nothing_visible():
    observation = _observation("red_footman_0", (8, 7), ((2,),))

    assert blocks.screen(observation, {}, _position((7, 7))) is None


# -- flank ------------------------------------------------------------------------------------------


def test_flank_closes_distance_while_staying_out_of_strike_range():
    # Two landings make progress toward the goal: a three-step walk that lands well inside the
    # enemy's strike radius, and a shorter one-step walk that lands outside it. Advance would take
    # the three-step walk, since it is the closer of the two; only flank's requirement that a
    # landing also be clear can pick the shorter, safer one.
    start = (7, 7)
    goal = _position((7, 2))
    enemy = _visible("blue_footman_0", (7, 1), 12)
    observation = _observation("red_footman_0", start, ((6,), (6, 6, 6)), (enemy,))
    threat_radius = units.STATS["footman"].movement_points + units.STATS["footman"].attack_range

    order = blocks.flank(observation, {}, goal)

    end = _endpoint(start, order["path"])
    assert tile.distance(end, goal) < tile.distance(_position(start), goal)
    assert tile.distance(end, _position((7, 1))) > threat_radius
    assert (end["q"], end["r"]) == (7, 6)


def test_flank_returns_none_when_every_landing_is_covered():
    # An archer's movement plus range covers nearly the whole reachable neighborhood, so every
    # landing the mask offers is inside its strike radius on its next activation.
    enemy = _visible("blue_archer_0", (8, 7), 6)
    observation = _observation("red_footman_0", (7, 7), ((6,),), (enemy,))

    assert blocks.flank(observation, {}, _position((0, 0))) is None


def test_flank_returns_none_when_every_closer_landing_is_covered():
    # A landing that only matches the goal on distance is not enough: flank must refuse to drift
    # sideways or backward when every landing that actually closes the distance is covered. The
    # one-step walk closes the distance but lands inside the enemy's strike radius; the retreat
    # is clear but lands farther from the goal than the unit already stands.
    start = (7, 7)
    goal = _position((7, 2))
    enemy = _visible("blue_footman_0", (7, 3), 12)
    observation = _observation("red_footman_0", start, ((6,), (3,)), (enemy,))

    assert blocks.flank(observation, {}, goal) is None


# -- harass -----------------------------------------------------------------------------------------


def test_harass_strikes_then_withdraws_across_two_activations():
    start = (7, 7)
    victim = _visible("blue_archer_0", (9, 7), 6)
    # This second enemy can answer one of the two candidate strike tiles but not the other, so
    # harass has to actually check, not just take the nearer or the weaker option.
    other = _visible("blue_footman_1", (13, 7), 12)
    observation = _observation(
        "red_footman_0",
        start,
        ((2,), (2, 2, 2)),
        (victim, other),
        blue=("footman", "footman", "archer", "cavalry"),
    )
    memory: dict = {}

    struck = blocks.harass(observation, memory, None)

    assert memory["harass.struck"] is True
    end = _endpoint(start, struck["path"])
    other_stats = units.STATS["footman"]
    assert tile.distance(end, _position((13, 7))) > other_stats.movement_points + other_stats.attack_range
    assert struck["target"] == _slot(observation, "blue_archer_0")

    withdrawn = blocks.harass(observation, memory, None)

    assert memory["harass.struck"] is False
    # The docstring promises the quietest tile near the goal: the landing with the fewest threats
    # against it, no matter what else is on offer.
    view = blocks._View(observation)
    counts = [
        len(blocks._threats(view, _endpoint(start, path_id))) for path_id in action.legal_paths(observation)
    ]
    end = _endpoint(start, withdrawn["path"])
    assert len(blocks._threats(view, end)) == min(counts)


def test_harass_returns_none_with_nothing_visible():
    observation = _observation("red_footman_0", (7, 7), ((2,),))

    assert blocks.harass(observation, {}, None) is None


# -- shield_wall ------------------------------------------------------------------------------------


def test_shield_wall_picks_a_tile_beside_an_allied_footman():
    start = (7, 7)
    goal = _position((7, 7))
    ally = _visible("red_footman_1", (9, 7), 12)
    observation = _observation(
        "red_footman_0", start, ((2,),), (ally,), red=("footman", "footman", "archer", "cavalry")
    )

    order = blocks.shield_wall(observation, {}, goal)

    end = _endpoint(start, order["path"])
    assert tile.distance(end, goal) <= blocks.TETHER
    assert tile.distance(end, _position((9, 7))) == 1


def test_shield_wall_returns_none_for_a_non_footman():
    observation = _observation("red_archer_0", (7, 7), ((2,),))

    assert blocks.shield_wall(observation, {}, None) is None


# -- the shipped assignment --------------------------------------------------------------------------

ZONE = _zone((7, 7))
ASSIGN_ROSTER = ("footman", "footman", "archer", "archer", "cavalry", "cavalry")


def _assignment(unit_id: str, *, zones: tuple[dict[str, object], ...] = (ZONE,)):
    observation = _observation(
        unit_id, (2, 2), (), red=ASSIGN_ROSTER, zones=zones, capture_zones=1 if zones else 0
    )
    return blocks.assign(observation, {}), observation


def test_assign_pins_the_shipped_mapping():
    """Pins every choice the shipped ``assign`` makes. Replacing ``assign`` means re-pinning this
    one test to whatever mapping the rewrite produces; the properties test below it should still
    hold without changes.
    """
    (block, goal), _ = _assignment("red_footman_0")
    assert block is blocks.capture
    assert goal == ZONE["center"]

    (block, goal), _ = _assignment("red_footman_1")
    assert block is blocks.shield_wall
    assert goal == ZONE["center"]

    (block, goal), _ = _assignment("red_archer_0")
    assert block is blocks.kite
    assert goal == ZONE["center"]

    (block, goal), _ = _assignment("red_cavalry_0")
    assert block is blocks.charge
    assert goal == tile.neighbors(ZONE["center"])[1]

    (block, goal), _ = _assignment("red_cavalry_1")
    assert block is blocks.harass
    assert goal == tile.neighbors(ZONE["center"])[3]


def test_assign_gives_every_unit_a_library_block_and_a_goal_on_or_beside_the_zone():
    """Loose enough to survive a rewrite of ``assign``, unlike the pinned test above it."""
    center = ZONE["center"]
    beside = tile.neighbors(center).values()
    for entry in _roster("red", ASSIGN_ROSTER):
        (block, goal), _ = _assignment(entry["unit_id"])
        assert block in blocks.BLOCKS
        assert goal == center or goal in beside


def test_assign_falls_back_to_the_field_center_with_no_zones():
    (_, goal), observation = _assignment("red_footman_0", zones=())

    assert goal == tile.at_center(observation)


# -- the dispatch fallback in agent.py ----------------------------------------------------------------


def test_agent_falls_back_to_advance_when_the_assigned_block_is_silent():
    # An archer with nothing visible gets None from kite, so act() must still return whatever
    # blocks.advance(goal) would: a legal move that closes on the goal it was assigned.
    observation = _observation("red_archer_0", (2, 2), ((2,), (2, 2)), zones=())
    block, goal = blocks.assign(observation, {})
    assert block is blocks.kite
    expected = blocks.advance(observation, {}, goal)

    unit = agent.Agent()
    unit.reset(0, None)
    order = unit.act(observation)

    assert order == expected
    assert _legal(observation, order)


# -- every block against real episodes -----------------------------------------------------------------


def _legal(observation, order: dict[str, int]) -> bool:
    mask = observation["action_mask"]
    return bool(mask["path"][order["path"]]) and bool(mask["target"][order["target"]])


class _LibraryChecked:
    """Runs every block in the library against each live activation, then plays for real.

    Two variants of every block run each activation: once with the unit's own assigned goal and
    once with a goal of None, exercising the no-destination path every block supports. Any
    returned order that is not None must be legal against the mask that activation published, both
    its path bit and its target bit. The order actually played is whatever ``agent.Agent`` itself
    would return, so a match plays out normally around this check.
    """

    def __init__(self) -> None:
        self.inner = agent.Agent()
        self.memories_with_goal = {block: {} for block in blocks.BLOCKS}
        self.memories_without_goal = {block: {} for block in blocks.BLOCKS}
        self.illegal: list[dict[str, object]] = []
        self.decisions = 0

    def reset(self, seed, observation) -> None:
        self.inner.reset(seed, observation)
        self.memories_with_goal = {block: {} for block in blocks.BLOCKS}
        self.memories_without_goal = {block: {} for block in blocks.BLOCKS}

    def act(self, observation):
        order = self.inner.act(observation)
        self.decisions += 1
        for block in blocks.BLOCKS:
            for memory, goal in (
                (self.memories_with_goal[block], self.inner.goal),
                (self.memories_without_goal[block], None),
            ):
                candidate = block(observation, memory, goal)
                if candidate is not None and not _legal(observation, candidate):
                    self.illegal.append({"block": block.__name__, "goal": goal, "order": candidate})
        return order


def _match(seed: int, players: tuple[str, ...], everyone: tuple[str, ...], parameters, wrap):
    """Play one match with our detachment on ``players`` and the naive builtin on the rest."""
    ours = [wrap() for _ in players]
    others = dict(zip(players[1:], ours[1:], strict=True))
    others.update({player: naive.Agent() for player in everyone if player not in players})
    env = make_env(parameters)
    try:
        score = play_episode(
            ours[0],
            env,
            seed=seed,
            player_id=players[0],
            parameters=parameters,
            other_agents=others,
        )
    finally:
        env.close()
    return score, ours


def _season_4_match(seed: int, *, blue: bool = False, wrap=agent.Agent):
    """One Season 4 battle: twenty units a side, terrain, abilities, and one capture zone."""
    everyone = tuple(f"player_{index}" for index in range(40))
    players = everyone[20:] if blue else everyone[:20]
    return _match(seed, players, everyone, SEASON_4_PARAMETERS, wrap)


def test_every_block_stays_mask_legal_across_season_four_episodes():
    for seed in FUZZ_SEEDS:
        score, ours = _season_4_match(seed, wrap=_LibraryChecked)
        assert 0.0 <= score <= 100.0
        assert sum(unit.decisions for unit in ours) > 0
        assert [entry for unit in ours for entry in unit.illegal] == []


# -- the coherence bar --------------------------------------------------------------------------------


def test_banner_beats_naive_on_every_pinned_season_four_seed():
    for seed in RED_SEEDS:
        score, _ = _season_4_match(seed)
        assert score >= WIN_SCORE, f"seed {seed} as red scored {score}"
    for seed in BLUE_SEEDS:
        score, _ = _season_4_match(seed, blue=True)
        assert score >= WIN_SCORE, f"seed {seed} as blue scored {score}"
