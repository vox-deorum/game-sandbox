"""Shared structural and runtime checks for every recognized environment package."""

from __future__ import annotations

import json
import math
import re
import sys
import warnings
from pathlib import Path
from typing import Any

import pytest
from pettingzoo.test import api_test

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from _envs import discover_environments, package_dirs  # noqa: E402
from _paths import ENVIRONMENTS_PYPROJECT, ENVIRONMENTS_SRC  # noqa: E402


def _api_test_tolerating_1211(env: Any, num_cycles: int = 100) -> None:
    """Run PettingZoo's API test, allowing only its known composite-observation dtype bug."""
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message="Observation is not a NumPy array")
        warnings.filterwarnings("ignore", message="Observation space for each agent probably should be")
        try:
            api_test(env, num_cycles=num_cycles)
        except AttributeError as error:
            if "dtype" not in str(error):
                raise


def _json_bytes(value: Any) -> str:
    """Canonicalize native JSON values and NumPy scalar or array leaves for equality checks."""
    return json.dumps(
        value,
        allow_nan=False,
        default=lambda item: item.tolist() if hasattr(item, "tolist") else item.item(),
        sort_keys=True,
        separators=(",", ":"),
    )


def _rollout(entry: Any, seed: int) -> list[tuple[str, str]]:
    """Drive an environment with its own legal timeout hook, recording observations and overlays."""
    env = entry.make()
    snapshots: list[tuple[str, str]] = []
    try:
        env.reset(seed=seed)
        while env.agents:
            agent = env.agent_selection
            observation, _, terminated, truncated, _ = env.last()
            if terminated or truncated:
                env.step(None)
                continue
            assert env.observation_space(agent).contains(observation)
            overlay = entry.overlay(env) if entry.overlay is not None else {}
            overlay_json = _json_bytes(overlay)
            assert json.loads(overlay_json) == overlay
            snapshots.append((_json_bytes(observation), overlay_json))
            action = entry.default_action(env, agent)
            assert env.action_space(agent).contains(action)
            env.step(action)
    finally:
        env.close()
    return snapshots


ENVIRONMENTS = discover_environments()


@pytest.mark.parametrize("env_id", ENVIRONMENTS)
def test_passes_pettingzoo_api_test(env_id: str):
    _api_test_tolerating_1211(ENVIRONMENTS[env_id].entry.make())


@pytest.mark.parametrize("env_id", ENVIRONMENTS)
def test_seeded_runtime_output_is_deterministic_json_and_finite(env_id: str):
    entry = ENVIRONMENTS[env_id].entry
    first = _rollout(entry, seed=17)
    assert first == _rollout(entry, seed=17)
    for _, overlay in first:
        assert all(math.isfinite(value) for value in _numbers(json.loads(overlay)))


@pytest.mark.parametrize("env_id", ENVIRONMENTS)
def test_metadata_round_trips_through_json(env_id: str):
    meta = ENVIRONMENTS[env_id].entry.meta.to_json()
    assert json.loads(_json_bytes(meta)) == meta


@pytest.mark.parametrize("env_id", ENVIRONMENTS)
def test_environment_authoring_shape_is_complete_and_fresh(env_id: str):
    discovered = ENVIRONMENTS[env_id]
    renderer = ENVIRONMENTS_SRC / env_id / "renderer"
    assert renderer.is_dir()
    assert (renderer / "index.ts").is_file()
    assert (renderer / "thumbnail.svg").is_file()
    assert (ENVIRONMENTS_SRC / env_id / "tests").is_dir()
    renderer_source = (renderer / "index.ts").read_text(encoding="utf-8")
    key = re.escape(discovered.entry.meta.renderer)
    assert re.search(rf"\bkey\s*:\s*(['\"]){key}\1", renderer_source)
    pyproject = ENVIRONMENTS_PYPROJECT.read_text(encoding="utf-8")
    assert f'{env_id} = "{env_id}:ENTRY"' in pyproject


def test_environment_catalog_has_unambiguous_renderer_ownership():
    ignored_packages = [path for path in package_dirs() if path.name not in ENVIRONMENTS]
    assert not [path / "renderer" for path in ignored_packages if (path / "renderer").exists()]
    renderer_keys = [discovered.entry.meta.renderer for discovered in ENVIRONMENTS.values()]
    assert len(renderer_keys) == len(set(renderer_keys))


def _numbers(value: Any):
    if isinstance(value, dict):
        for child in value.values():
            yield from _numbers(child)
    elif isinstance(value, list):
        for child in value:
            yield from _numbers(child)
    elif isinstance(value, float):
        yield value
