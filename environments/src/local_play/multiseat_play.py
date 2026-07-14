"""Dependency-free episode utilities shared by multi-seat student templates."""

from __future__ import annotations

import importlib
import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any


def load_agent(repo_root: Path) -> Any:
    """Load and instantiate the agent named by ``manifest.json``."""
    manifest = json.loads((repo_root / "manifest.json").read_text(encoding="utf-8"))
    root_str = str(repo_root)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)
    module = importlib.import_module(manifest["entry_point"])
    return getattr(module, manifest["class_name"])()


def play_episode(
    agent: Any,
    env: Any,
    *,
    seed: int,
    player_slot: str,
    default_action: Callable[[Any, str], Any],
    max_steps: int | None = None,
    on_frame: Callable[[], None] | None = None,
) -> float:
    """Play one episode with ``agent`` in ``player_slot`` and default actions elsewhere."""
    env.reset(seed=seed)
    agent.reset(seed)
    score = 0.0
    decisions = 0
    while env.agents:
        agent_id = env.agent_selection
        observation, _reward, termination, truncation, _info = env.last()
        if termination or truncation:
            env.step(None)
            continue
        if agent_id == player_slot:
            action = agent.act(observation)
            decisions += 1
        else:
            action = default_action(env, agent_id)
        env.step(action)
        score += float(env.rewards[player_slot])
        if on_frame is not None:
            on_frame()
        if max_steps is not None and decisions >= max_steps:
            break
    return score
