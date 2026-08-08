"""Tests for the provided ``sandbox.crane`` helpers.

These pin the two guarantees the helpers rely on: that the path encoding matches the synced
rules engine exactly and never drifts (so the helpers stay a stable compatibility promise), and
that the mask-reading and order-building accessors agree with the raw observation the environment
produces while driving real match states. A final check confirms that importing the helpers does
not drag in the heavy environment stack, which is why an agent may import them at module top
without slowing down loading.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from sandbox import crane
from sandbox.env import META, make_env
from sandbox.env.skirmish_crane import hexes, paths
from sandbox.harness.environment import resolve_parameters

REPO_ROOT = Path(__file__).resolve().parents[1]
SEED = 5
STEP_BUDGET = 60


def _observation(
    own_id: str = "red_footman_0",
    enemy_ids: tuple[str, ...] = ("blue_footman_0", "blue_archer_0"),
) -> dict:
    own_side = own_id.split("_", 1)[0]
    enemy_side = "blue" if own_side == "red" else "red"
    return {
        "observation": {
            "self": {"unit_id": own_id},
            "rosters": {
                own_side: ({"unit_id": own_id, "side": own_side},),
                enemy_side: tuple({"unit_id": enemy_id, "side": enemy_side} for enemy_id in enemy_ids),
            },
        },
        "action_mask": {"path": [1, 0], "target": [1, 1, 1]},
    }


def test_encode_and_decode_path_pin_the_stable_vectors():
    assert crane.encode_path([]) == 0
    assert crane.encode_path([1]) == 1
    assert crane.encode_path([6]) == 6
    assert crane.encode_path([1, 1]) == 7
    assert crane.encode_path([6, 6, 6, 6]) == 1554

    assert crane.decode_path(0) == ()
    assert crane.decode_path(1) == (1,)
    assert crane.decode_path(6) == (6,)
    assert crane.decode_path(7) == (1, 1)
    assert crane.decode_path(1554) == (6, 6, 6, 6)


def test_full_range_round_trips_against_the_step_one_decoder():
    assert crane.DIRECTIONS == hexes.DIRECTIONS
    assert crane.MAX_PATH_ID == paths.MAX_PATH_ID
    for path_id in range(crane.MAX_PATH_ID + 1):
        digits = crane.decode_path(path_id)
        assert digits == paths.decode_path(path_id)
        assert crane.encode_path(digits) == path_id
        assert paths.encode_path(digits) == path_id


@pytest.mark.parametrize(
    "directions",
    [(0,), (7,), (1, 1, 1, 1, 1), (True,), (1.0,)],
    ids=["digit-zero", "digit-seven", "five-steps", "bool-digit", "non-int-digit"],
)
def test_encode_path_rejects_invalid_digit_sequences(directions):
    with pytest.raises(ValueError):
        crane.encode_path(directions)


@pytest.mark.parametrize("path_id", [-1, 1555, True, "3"])
def test_decode_path_rejects_invalid_ids(path_id):
    with pytest.raises(ValueError):
        crane.decode_path(path_id)


def test_importing_the_helpers_stays_light():
    # An agent imports sandbox.crane at module top, so it must not pull in the environment engine.
    # Check in a fresh interpreter, since this test process has already loaded it.
    code = (
        "import sys; from sandbox.crane import ("
        "DIRECTIONS, MAX_PATH_ID, MAX_PATH_STEPS, decode_path, distance, encode_path, "
        "legal_paths, move, nameable_targets, neighbors, stay); "
        "assert 'pettingzoo' not in sys.modules; "
        "assert 'gymnasium' not in sys.modules; "
        "assert 'numpy' not in sys.modules"
    )
    subprocess.run([sys.executable, "-c", code], cwd=REPO_ROOT, check=True)


def test_helper_accessors_agree_with_live_environment_states():
    parameters = resolve_parameters(META)
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
            mask = observation["action_mask"]

            expected_paths = [path_id for path_id, bit in enumerate(mask["path"]) if bit]
            assert crane.legal_paths(observation) == expected_paths

            own_side = observation["observation"]["self"]["unit_id"].split("_", 1)[0]
            enemy_side = "blue" if own_side == "red" else "red"
            roster = observation["observation"]["rosters"][enemy_side]
            expected_targets = [
                entry["unit_id"] for index, entry in enumerate(roster) if mask["target"][index + 1]
            ]
            assert crane.nameable_targets(observation) == expected_targets

            # Independent oracle: the mask-based checks above restate legal_paths and
            # nameable_targets almost verbatim, so they cannot catch a wrong assumption the helper
            # and the test happen to share. Ask the engine directly instead, bypassing the mask.
            unit_id = observation["observation"]["self"]["unit_id"]
            walkable_paths, nameable_unit_ids = env.unwrapped.match.legal_orders(unit_id)
            oracle_paths = {0, *(paths.encode_path(walked) for walked in walkable_paths)}
            assert set(crane.legal_paths(observation)) == oracle_paths
            assert set(crane.nameable_targets(observation)) == set(nameable_unit_ids)

            sampled_path = max(expected_paths)
            space = env.action_space(agent)
            assert space.contains(crane.stay())
            assert space.contains(crane.move(sampled_path))
            assert mask["path"][sampled_path] == 1
            assert mask["target"][0] == 1

            if expected_targets:
                name = expected_targets[0]
                roster_index = next(i for i, entry in enumerate(roster) if entry["unit_id"] == name)
                action = crane.move(sampled_path, target_id=name, observation=observation)
                assert action["target"] == roster_index + 1

            env.step(crane.move(sampled_path))
            acted += 1
        assert acted > 0
    finally:
        env.close()


def test_naming_a_target_without_an_observation_raises():
    with pytest.raises(ValueError):
        crane.stay(target_id="blue_footman_0")
    with pytest.raises(ValueError):
        crane.move(0, target_id="blue_footman_0")


def test_naming_an_unknown_unit_id_raises():
    observation = _observation()
    with pytest.raises(ValueError):
        crane.move(0, target_id="blue_cavalry_9", observation=observation)


def test_naming_an_allied_unit_id_raises():
    observation = _observation()
    with pytest.raises(ValueError):
        crane.move(0, target_id="red_footman_0", observation=observation)


def test_move_rejects_out_of_range_path_ids():
    with pytest.raises(ValueError):
        crane.move(-1)
    with pytest.raises(ValueError):
        crane.move(crane.MAX_PATH_ID + 1)
