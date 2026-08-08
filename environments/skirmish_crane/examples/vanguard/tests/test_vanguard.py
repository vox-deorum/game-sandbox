"""Example-specific tests, added on top of the inherited template tests.

Two kinds. The first builds an activation by hand, one observation dict with a chosen action
mask, and checks that a unit type's state machine reads it the way its docstring promises.
The second plays whole matches: the detachment against the built-in naive side, on a pinned
set of seeds it is expected to win every time.
"""

from __future__ import annotations

import agent
from sandbox.crane import paths, tile
from sandbox.env import META, make_env
from sandbox.env.skirmish_crane import naive
from sandbox.harness.environment import resolve_parameters
from sandbox.play import play_episode

# The pinned seeds. Every one of them is a win for the example, from either side of the field.
RED_SEEDS = (0, 1, 2, 3, 4, 5)
BLUE_SEEDS = (6, 7)
ARMY_SEEDS = (0, 1)
SEASON_3 = {"seat_plan": "army", "field_extent": 10, "terrain": True, "unit_abilities": True}
WIN_SCORE = 70.0

FIELD_EXTENT = 7
FIELD_SIDE = 2 * FIELD_EXTENT + 1
PATH_VALUES = 1555
SKIRMISH_ROSTER = ("footman", "archer", "cavalry")
STATS = {  # hit points and movement points per type, from the ruleset
    "footman": (12, 2),
    "archer": (6, 2),
    "cavalry": (10, 4),
}


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


def _observation(
    unit_id: str,
    coordinates: tuple[int, int],
    walkable: tuple[tuple[int, ...], ...],
    seen: tuple[dict[str, object], ...] = (),
    *,
    red: tuple[str, ...] = SKIRMISH_ROSTER,
    blue: tuple[str, ...] = SKIRMISH_ROSTER,
):
    """Assemble one activation: who we are, what we see, and exactly what the mask allows.

    ``walkable`` lists the direction tuples the mask marks walkable; standing still is always
    legal and is added for you. Every visible enemy is nameable, as it is in a real match.
    """
    side, unit_type, _ = unit_id.split("_")
    rosters = {"red": _roster("red", red), "blue": _roster("blue", blue)}
    enemies = rosters["blue" if side == "red" else "red"]
    path_mask = [0] * PATH_VALUES
    for directions in ((), *walkable):
        path_mask[paths.encode(directions)] = 1
    watched = {unit["unit_id"] for unit in seen}
    target_mask = [1] + [int(entry["unit_id"] in watched) for entry in enemies]
    hit_points, movement = STATS[unit_type]
    return {
        "observation": {
            "self": {
                "unit_id": unit_id,
                "type": unit_type,
                "position": _position(coordinates),
                "hit_points": hit_points,
                "movement_points": movement,
                "direction": 2 if side == "red" else 5,
            },
            "visible_units": tuple(seen),
            "round": 3,
            "capture": {"red": 0, "blue": 0, "target": 0},
            "battlefield": {"side": FIELD_SIDE, "tiles": (), "zones": ()},
            "rosters": rosters,
            "parameters": {
                "seat_plan": "skirmish",
                "field_extent": FIELD_EXTENT,
                "terrain": 0,
                "wasteland": 0,
                "unit_abilities": 1,
                "capture_zones": 0,
                "capture_target": 200,
                "round_cap": 1000,
            },
        },
        "action_mask": {"path": path_mask, "target": target_mask},
    }


def _endpoint(coordinates: tuple[int, int], path_id: int) -> dict[str, int]:
    """Walk a chosen path from a starting tile to the tile the order ends on."""
    return tile.at_path_end(_position(coordinates), path_id)


# -- the three state machines on constructed activations -----------------------------------------

ARCHER_TILE = (7, 7)


def _hunted_archer():
    """Our archer with an enemy cavalry right on top of it and the enemy archer four tiles east."""
    return _observation(
        "red_archer_0",
        ARCHER_TILE,
        ((5,), (5, 5)),
        (_visible("blue_cavalry_0", (8, 7), 10), _visible("blue_archer_0", (11, 7), 6)),
    )


def _covered_archer():
    """The same archer with the fight still at a distance, standing behind a friendly footman."""
    return _observation(
        "red_archer_0",
        ARCHER_TILE,
        ((5,), (2,)),
        (
            _visible("blue_cavalry_0", (12, 7), 10),
            _visible("blue_archer_0", (11, 7), 6),
            _visible("red_footman_0", (7, 8), 12),
        ),
    )


def test_the_archer_gives_ground_and_still_covers_its_victim():
    memory = agent.Memory(seed=7)

    action = agent.archer_order(_hunted_archer(), memory)

    end = _endpoint(ARCHER_TILE, action["path"])
    assert memory.state == agent.FALL_BACK
    # It walks the full two tiles away from the cavalry that is on it, and the enemy archer it
    # names is still inside bow range from where it lands, so the retreat is also a shot.
    assert tile.distance(end, _position((8, 7))) == 3
    assert tile.distance(end, _position((11, 7))) <= agent.ARCHER_RANGE
    assert action["target"] == 2  # blue_archer_0, the second slot of the enemy roster


def test_the_archer_holds_its_line_and_fires_while_the_fight_is_far():
    memory = agent.Memory(seed=7)

    action = agent.archer_order(_covered_archer(), memory)

    assert memory.state == agent.FIRE
    assert action["path"] == 0  # nothing is closing, so it shoots from where it stands
    assert action["target"] == 2


def test_the_archer_switches_to_falling_back_when_an_enemy_closes():
    memory = agent.Memory(seed=7)

    agent.archer_order(_covered_archer(), memory)
    assert memory.state == agent.FIRE

    agent.archer_order(_hunted_archer(), memory)
    assert memory.state == agent.FALL_BACK


def test_the_cavalry_charges_the_archer_from_the_tile_no_escort_covers():
    position = (7, 7)
    seen = (_visible("blue_archer_0", (10, 7), 6), _visible("blue_footman_0", (9, 8), 12))
    # Two tiles beside the enemy archer are on offer: a short step into its escort's reach, and
    # a three-tile ride that lands where only the archer stands next to it.
    walkable = ((2, 2), (2, 2, 1))
    memory = agent.Memory(seed=7)

    action = agent.cavalry_order(_observation("red_cavalry_0", position, walkable, seen), memory)

    end = _endpoint(position, action["path"])
    assert memory.state == agent.CHARGE
    assert tile.distance(_position(position), end) >= agent.CHARGE_DISTANCE
    assert tile.distance(end, _position((10, 7))) == 1  # beside the victim
    assert tile.distance(end, _position((9, 8))) > 1  # and out of the escort's reach
    assert action["target"] == 2  # blue_archer_0


def test_the_footman_steps_back_into_the_shield_wall_to_screen():
    # It starts two tiles out of the wall, so holding still would fail both assertions below.
    position = (8, 7)
    seen = (
        _visible("red_footman_1", (6, 7), 12),
        _visible("red_archer_0", (5, 7), 6),
        _visible("blue_footman_0", (11, 7), 12),
    )
    walkable = ((5,), (6,), (1,))
    memory = agent.Memory(seed=7)
    observation = _observation(
        "red_footman_0", position, walkable, seen, red=("footman", "footman", "archer", "cavalry")
    )

    action = agent.footman_order(observation, memory)

    end = _endpoint(position, action["path"])
    assert memory.state == agent.SCREEN
    assert action["path"] == paths.encode((5,))  # the one offered step that closes the wall
    assert tile.distance(end, _position((6, 7))) == 1  # shoulder to shoulder with the other footman
    assert tile.distance(end, _position((5, 7))) <= 2  # still covering the archer


def test_the_footman_fights_with_support_and_waits_without_it():
    position = (7, 7)
    enemy = _visible("blue_footman_0", (9, 7), 12)
    ally = _visible("red_footman_1", (6, 7), 12)
    walkable = ((2,), (6,))
    roster = ("footman", "footman", "archer", "cavalry")

    supported = agent.Memory(seed=7)
    action = agent.footman_order(
        _observation("red_footman_0", position, walkable, (enemy, ally), red=roster), supported
    )
    assert supported.state == agent.ENGAGE
    assert tile.distance(_endpoint(position, action["path"]), _position((9, 7))) == 1
    assert action["target"] == 1  # blue_footman_0, the first slot of the enemy roster

    alone = agent.Memory(seed=7)
    action = agent.footman_order(
        _observation("red_footman_0", position, walkable, (enemy,), red=roster), alone
    )
    assert alone.state == agent.SCREEN
    # A healthy enemy footman with no friend of ours near it is not a fight to start alone.
    assert tile.distance(_endpoint(position, action["path"]), _position((9, 7))) > 1


def test_a_kill_out_of_reach_does_not_license_a_melee_with_somebody_else():
    # The dying archer four tiles west is worth any risk, but it cannot be reached this
    # activation. That is no reason to walk into the healthy footman standing two tiles east.
    position = (7, 7)
    seen = (_visible("blue_archer_0", (3, 7), 1), _visible("blue_footman_0", (9, 7), 12))
    walkable = ((2,), (6,), (5,))
    memory = agent.Memory(seed=7)

    action = agent.footman_order(
        _observation(
            "red_footman_0", position, walkable, seen, red=("footman", "footman", "archer", "cavalry")
        ),
        memory,
    )

    assert memory.state == agent.SCREEN
    assert tile.distance(_endpoint(position, action["path"]), _position((9, 7))) > 1


# -- whole matches against the built-in naive side -------------------------------------------------


class _Checked:
    """The example agent, with every order it returns checked against the mask it read."""

    def __init__(self) -> None:
        self.inner = agent.Agent()
        self.decisions = 0
        self.illegal: list[dict[str, int]] = []

    def reset(self, seed: int) -> None:
        self.inner.reset(seed)

    def act(self, observation):
        action = self.inner.act(observation)
        mask = observation["action_mask"]
        self.decisions += 1
        if not mask["path"][action["path"]] or not mask["target"][action["target"]]:
            self.illegal.append(action)
        return action


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


def _skirmish(seed: int, *, blue: bool = False, wrap=agent.Agent):
    """One default skirmish: three units a side, our detachment seated red or blue."""
    everyone = tuple(f"player_{index}" for index in range(6))
    players = everyone[3:] if blue else everyone[:3]
    return _match(seed, players, everyone, resolve_parameters(META), wrap)


def _battle(seed: int, *, wrap=agent.Agent):
    """One Season 3 battle: twenty units a side on a bigger field, with terrain and abilities."""
    everyone = tuple(f"player_{index}" for index in range(40))
    return _match(seed, everyone[:20], everyone, resolve_parameters(META, SEASON_3), wrap)


def test_the_detachment_beats_naive_on_every_pinned_seed():
    for seed in RED_SEEDS:
        score, _ = _skirmish(seed)
        assert score >= WIN_SCORE, f"seed {seed} as red scored {score}"
    for seed in BLUE_SEEDS:
        score, _ = _skirmish(seed, blue=True)
        assert score >= WIN_SCORE, f"seed {seed} as blue scored {score}"


def test_the_detachment_beats_naive_in_a_season_three_battle():
    # The shape this example is written for: twenty units a side, terrain underfoot, and the
    # charge and shield wall switched on. Every order stays mask legal at that scale too.
    for seed in ARMY_SEEDS:
        score, ours = _battle(seed, wrap=_Checked)
        assert score >= WIN_SCORE, f"seed {seed} as red scored {score}"
        assert [action for unit in ours for action in unit.illegal] == []


def test_every_order_the_detachment_gives_is_mask_legal():
    score, ours = _skirmish(1, wrap=_Checked)

    assert 0.0 <= score <= 100.0
    assert sum(unit.decisions for unit in ours) > 0
    assert [action for unit in ours for action in unit.illegal] == []
