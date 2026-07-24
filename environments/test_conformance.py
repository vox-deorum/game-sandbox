"""Shared structural and runtime checks for every recognized environment package."""

from __future__ import annotations

import json
import sys
import warnings
from pathlib import Path
from typing import Any

import pytest
from pettingzoo.test import api_test

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from _envs import discover_environments, package_dirs  # noqa: E402
from _paths import ENVIRONMENT_PACKAGES_DIR, ENVIRONMENTS_PYPROJECT  # noqa: E402
from game_sandbox_harness.environment import resolve_parameters  # noqa: E402


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


def _json_default(item: Any) -> Any:
    """Convert NumPy-like scalar or array leaves, preserving JSON's normal error for other types."""
    for method_name in ("tolist", "item"):
        method = getattr(item, method_name, None)
        if callable(method):
            return method()
    return json.JSONEncoder().default(item)


def _json_bytes(value: Any) -> str:
    """Canonicalize JSON values while rejecting NaN, infinity, and unsupported leaf types."""
    return json.dumps(
        value,
        allow_nan=False,
        default=_json_default,
        sort_keys=True,
        separators=(",", ":"),
    )


def _rollout(entry: Any, seed: int) -> list[tuple[str, str]]:
    """Drive an environment with its own legal timeout hook, recording observations and overlays."""
    env = entry.make(resolve_parameters(entry.meta))
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
    entry = ENVIRONMENTS[env_id].entry
    _api_test_tolerating_1211(entry.make(resolve_parameters(entry.meta)))


@pytest.mark.parametrize("env_id", ENVIRONMENTS)
def test_seeded_runtime_output_is_deterministic_json_and_finite(env_id: str):
    entry = ENVIRONMENTS[env_id].entry
    first = _rollout(entry, seed=17)
    assert first == _rollout(entry, seed=17)


@pytest.mark.parametrize("env_id", ENVIRONMENTS)
def test_metadata_round_trips_through_json(env_id: str):
    meta = ENVIRONMENTS[env_id].entry.meta.to_json()
    assert json.loads(_json_bytes(meta)) == meta


@pytest.mark.parametrize("env_id", ENVIRONMENTS)
def test_environment_authoring_shape_is_complete_and_fresh(env_id: str):
    environment_dir = ENVIRONMENT_PACKAGES_DIR / env_id
    assert (environment_dir / "environment.md").is_file()
    renderer = environment_dir / "renderer"
    assert renderer.is_dir()
    assert (renderer / "index.ts").is_file()
    assert (renderer / "thumbnail.svg").is_file()
    assert (environment_dir / "tests").is_dir()
    template = environment_dir / "template"
    assert (template / "agent.py").is_file()
    assert (template / "README.md").is_file()
    examples = environment_dir / "examples"
    assert examples.is_dir()
    assert any((example / "agent.py").is_file() for example in examples.iterdir() if example.is_dir())
    pyproject = ENVIRONMENTS_PYPROJECT.read_text(encoding="utf-8")
    assert f'{env_id} = "{env_id}:ENTRY"' in pyproject


def test_environment_catalog_has_unambiguous_renderer_ownership():
    ignored_packages = [path for path in package_dirs() if path.name not in ENVIRONMENTS]
    assert not [path / "renderer" for path in ignored_packages if (path / "renderer").exists()]
    renderer_keys = [discovered.entry.meta.renderer for discovered in ENVIRONMENTS.values()]
    assert len(renderer_keys) == len(set(renderer_keys))
