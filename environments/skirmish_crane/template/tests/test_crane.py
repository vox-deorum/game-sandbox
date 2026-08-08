"""Tests for the provided ``sandbox.crane`` helpers.

These pin the two guarantees the helpers rely on: that the path encoding matches the synced
rules engine exactly and never drifts (so the helpers stay a stable compatibility promise), and
that the readers agree with the raw observation and mask the environment produces while driving
real match states. A final check confirms that importing the helpers does not drag in the heavy
environment stack, which is why an agent may import them at module top without slowing down
loading.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from sandbox.crane import action, me, paths, roster, tile, visible
from sandbox.env import META, make_env
from sandbox.env.skirmish_crane import hexes
from sandbox.env.skirmish_crane import paths as engine_paths
from sandbox.harness.environment import resolve_parameters

REPO_ROOT = Path(__file__).resolve().parents[1]
SEED = 5
STEP_BUDGET = 60
FIELD_SIDE = 15


def _position(q: int, r: int) -> dict:
    return {"q": q, "r": r}


def _unit(unit_id: str, q: int, r: int) -> dict:
    side, kind, _ = unit_id.split("_")
    return {
        "unit_id": unit_id,
        "side": side,
        "type": kind,
        "position": _position(q, r),
        "hit_points": 7,
    }


def _observation(
    own_id: str = "red_footman_0",
    enemy_ids: tuple[str, ...] = ("blue_footman_0", "blue_archer_0"),
    seen: tuple[dict, ...] = (),
    tiles: tuple[tuple[dict, ...], ...] = (),
) -> dict:
    own_side = own_id.split("_", 1)[0]
    enemy_side = "blue" if own_side == "red" else "red"
    return {
        "observation": {
            "self": {
                "unit_id": own_id,
                "type": own_id.split("_")[1],
                "position": _position(3, 4),
                "hit_points": 9,
                "movement_points": 2,
                "direction": 2 if own_side == "red" else 5,
            },
            "visible_units": seen,
            "battlefield": {"side": FIELD_SIDE, "tiles": tiles, "zones": ()},
            "rosters": {
                own_side: ({"unit_id": own_id, "side": own_side},),
                enemy_side: tuple({"unit_id": enemy_id, "side": enemy_side} for enemy_id in enemy_ids),
            },
        },
        "action_mask": {"path": [1, 0], "target": [1, 1, 1]},
    }


# -- the path encoding, frozen forever -----------------------------------------------------------


def test_encode_and_decode_pin_the_stable_vectors():
    assert paths.encode([]) == 0
    assert paths.encode([1]) == 1
    assert paths.encode([6]) == 6
    assert paths.encode([1, 1]) == 7
    assert paths.encode([6, 6, 6, 6]) == 1554

    assert paths.decode(0) == ()
    assert paths.decode(1) == (1,)
    assert paths.decode(6) == (6,)
    assert paths.decode(7) == (1, 1)
    assert paths.decode(1554) == (6, 6, 6, 6)


def test_full_range_round_trips_against_the_step_one_decoder():
    assert tile.DIRECTIONS == hexes.DIRECTIONS
    assert paths.MAX_ID == engine_paths.MAX_PATH_ID
    for path_id in range(paths.MAX_ID + 1):
        digits = paths.decode(path_id)
        assert digits == engine_paths.decode_path(path_id)
        assert paths.encode(digits) == path_id
        assert engine_paths.encode_path(digits) == path_id


@pytest.mark.parametrize(
    "directions",
    [(0,), (7,), (1, 1, 1, 1, 1), (True,), (1.0,)],
    ids=["digit-zero", "digit-seven", "five-steps", "bool-digit", "non-int-digit"],
)
def test_encode_rejects_invalid_digit_sequences(directions):
    with pytest.raises(ValueError):
        paths.encode(directions)


@pytest.mark.parametrize("path_id", [-1, 1555, True, "3"])
def test_decode_rejects_invalid_ids(path_id):
    with pytest.raises(ValueError):
        paths.decode(path_id)


def test_importing_the_helpers_stays_light():
    # An agent imports sandbox.crane at module top, so it must not pull in the environment engine.
    # Check in a fresh interpreter, since this test process has already loaded it.
    code = (
        "import sys; from sandbox.crane import action, me, paths, roster, tile, visible; "
        "assert 'pettingzoo' not in sys.modules; "
        "assert 'gymnasium' not in sys.modules; "
        "assert 'numpy' not in sys.modules"
    )
    subprocess.run([sys.executable, "-c", code], cwd=REPO_ROOT, check=True)


# -- hex geometry and the ground ------------------------------------------------------------------


def test_at_path_end_agrees_with_walking_the_neighbors_one_digit_at_a_time():
    start = _position(6, 5)
    assert tile.at_path_end(start, 0) == start
    for path_id in range(paths.MAX_ID + 1):
        walked = start
        for digit in paths.decode(path_id):
            walked = tile.neighbors(walked)[digit]
        assert tile.at_path_end(start, path_id) == walked


@pytest.mark.parametrize("path_id", [-1, 1555])
def test_at_path_end_rejects_invalid_ids(path_id):
    with pytest.raises(ValueError):
        tile.at_path_end(_position(0, 0), path_id)


def test_at_center_is_the_middle_of_the_field():
    assert tile.at_center(_observation()) == _position(7, 7)


def test_at_mirror_reflects_through_the_center_and_undoes_itself():
    observation = _observation()
    center = tile.at_center(observation)

    assert tile.at_mirror(center, observation) == center
    spawn = _position(2, 6)
    opposite = tile.at_mirror(spawn, observation)
    assert opposite == _position(12, 8)
    assert tile.at_mirror(opposite, observation) == spawn
    # The reflection is a rotation about the middle, so it never changes how far a tile sits.
    assert tile.distance(opposite, center) == tile.distance(spawn, center)


def test_terrain_at_reads_the_grid_row_first_and_calls_everything_outside_it_void():
    grass = {"terrain": "grass", "feature": "none"}
    marsh = {"terrain": "marsh", "feature": "none"}
    observation = _observation(tiles=((grass, grass), (grass, marsh)))

    assert tile.terrain_at(observation, _position(1, 1)) == marsh
    assert tile.terrain_at(observation, _position(0, 1)) == grass
    assert tile.terrain_at(observation, _position(9, 9)) == {"terrain": "void", "feature": "none"}
    assert tile.terrain_at(observation, _position(-1, 0)) == {"terrain": "void", "feature": "none"}


# -- reading your own unit, the rosters, and what is in sight --------------------------------------


def test_me_reads_every_field_of_your_own_unit():
    observation = _observation("blue_archer_1")

    assert me.unit_id(observation) == "blue_archer_1"
    assert me.side(observation) == "blue"
    assert me.unit_type(observation) == "archer"
    assert me.position(observation) == _position(3, 4)
    assert me.direction(observation) == 5
    assert me.hit_points(observation) == 9
    assert me.movement_points(observation) == 2


def test_rosters_are_picked_by_your_own_side():
    observation = _observation()

    assert [entry["unit_id"] for entry in roster.allies(observation)] == ["red_footman_0"]
    assert [entry["unit_id"] for entry in roster.enemies(observation)] == [
        "blue_footman_0",
        "blue_archer_0",
    ]


def test_visible_splits_what_the_unit_sees_and_keeps_the_observation_order():
    seen = (
        _unit("blue_footman_0", 4, 4),
        _unit("red_archer_0", 2, 4),
        _unit("blue_archer_0", 5, 4),
    )
    observation = _observation(seen=seen)

    assert [unit["unit_id"] for unit in visible.enemies(observation)] == [
        "blue_footman_0",
        "blue_archer_0",
    ]
    assert [unit["unit_id"] for unit in visible.allies(observation)] == ["red_archer_0"]


# -- the mask and the order it builds ---------------------------------------------------------------


def test_helper_accessors_agree_with_live_environment_states():
    parameters = resolve_parameters(META)
    extent = parameters["field_extent"]
    env = make_env(parameters)
    try:
        env.reset(seed=SEED)
        acted = 0
        while env.agents and acted < STEP_BUDGET:
            observation, _reward, termination, truncation, _info = env.last()
            if termination or truncation:
                env.step(None)
                continue
            agent = env.agent_selection
            state = observation["observation"]
            mask = observation["action_mask"]

            expected_paths = [path_id for path_id, bit in enumerate(mask["path"]) if bit]
            assert action.legal_paths(observation) == expected_paths
            assert action.legal_steps(observation) == [
                path_id for path_id in expected_paths if 1 <= path_id <= 6
            ]

            own_side = state["self"]["unit_id"].split("_", 1)[0]
            enemy_side = "blue" if own_side == "red" else "red"
            enemy_roster = state["rosters"][enemy_side]
            expected_targets = [
                entry["unit_id"] for index, entry in enumerate(enemy_roster) if mask["target"][index + 1]
            ]
            assert action.possible_targets(observation) == expected_targets

            # Independent oracle: the mask-based checks above restate legal_paths and
            # possible_targets almost verbatim, so they cannot catch a wrong assumption the helper
            # and the test happen to share. Ask the engine directly instead, bypassing the mask.
            unit_id = state["self"]["unit_id"]
            walkable_paths, nameable_unit_ids = env.unwrapped.match.legal_orders(unit_id)
            oracle_paths = {0, *(engine_paths.encode_path(walked) for walked in walkable_paths)}
            assert set(action.legal_paths(observation)) == oracle_paths
            assert set(action.possible_targets(observation)) == set(nameable_unit_ids)

            # The unit's own readings agree with the raw observation, and the two visible-unit
            # readers partition it. Every enemy in sight is one this unit may name, which is what
            # lets an agent name a target straight off visible.enemies.
            assert me.unit_id(observation) == unit_id
            assert me.side(observation) == own_side
            assert me.position(observation) == state["self"]["position"]
            assert me.direction(observation) == (2 if own_side == "red" else 5)
            assert roster.enemies(observation) == enemy_roster
            assert roster.allies(observation) == state["rosters"][own_side]
            partition = visible.enemies(observation) + visible.allies(observation)
            assert sorted(unit["unit_id"] for unit in partition) == sorted(
                unit["unit_id"] for unit in state["visible_units"]
            )
            assert {unit["unit_id"] for unit in visible.enemies(observation)} == set(expected_targets)

            assert tile.at_center(observation) == {"q": extent, "r": extent}
            here = me.position(observation)
            assert tile.terrain_at(observation, here) == state["battlefield"]["tiles"][here["r"]][here["q"]]

            sampled_path = max(expected_paths)
            space = env.action_space(agent)
            assert space.contains(action.stay())
            assert space.contains(action.move(sampled_path))
            assert mask["path"][sampled_path] == 1
            assert mask["target"][0] == 1

            if expected_targets:
                name = expected_targets[0]
                slot = next(i for i, entry in enumerate(enemy_roster) if entry["unit_id"] == name)
                order = action.move(sampled_path, target_id=name, observation=observation)
                assert order["target"] == slot + 1

            env.step(action.move(sampled_path))
            acted += 1
        assert acted > 0
    finally:
        env.close()


def test_naming_a_target_without_an_observation_raises():
    with pytest.raises(ValueError):
        action.stay(target_id="blue_footman_0")
    with pytest.raises(ValueError):
        action.move(0, target_id="blue_footman_0")


def test_naming_an_unknown_unit_id_raises():
    observation = _observation()
    with pytest.raises(ValueError):
        action.move(0, target_id="blue_cavalry_9", observation=observation)


def test_naming_an_allied_unit_id_raises():
    observation = _observation()
    with pytest.raises(ValueError):
        action.move(0, target_id="red_footman_0", observation=observation)


def test_move_rejects_out_of_range_path_ids():
    with pytest.raises(ValueError):
        action.move(-1)
    with pytest.raises(ValueError):
        action.move(paths.MAX_ID + 1)
