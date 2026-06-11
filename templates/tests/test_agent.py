"""Template tests. Every composed example inherits these and must pass them in CI.

They encode what every submittable repo should satisfy: the manifest parses and names a
loadable, instantiable agent class with the required interface, and that agent can actually
drive a few steps of the synced environment headlessly. (The bare template stub raises
``NotImplementedError`` in ``act`` on purpose, so this episode check stays red until you
implement your agent — that is the signal that you have something to do.)
"""

from __future__ import annotations

import json
from pathlib import Path

from play import load_agent, play_episode
from sandbox_env.flappy_bird.env import make_env

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_manifest_parses_and_names_a_loadable_class():
    manifest = json.loads((REPO_ROOT / "manifest.json").read_text(encoding="utf-8"))
    assert set(manifest) == {"entry_point", "class_name", "template_version"}
    assert isinstance(manifest["template_version"], int)
    agent = load_agent(REPO_ROOT)
    assert agent is not None


def test_agent_has_required_interface():
    agent = load_agent(REPO_ROOT)
    assert callable(getattr(agent, "reset", None))
    assert callable(getattr(agent, "act", None))


def test_three_step_headless_episode_runs():
    agent = load_agent(REPO_ROOT)
    env = make_env(render_mode=None)
    try:
        score = play_episode(agent, env, seed=0, max_steps=3)
    finally:
        env.close()
    assert isinstance(score, float)
