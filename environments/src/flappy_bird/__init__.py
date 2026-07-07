"""Flappy Bird: the registry entry that ties the factory, default action, overlay, and the
public-facing metadata together.

This is the only module in the environment that imports the harness (for the metadata
types), so it is *not* synced into the student template — students need a steppable
PettingZoo env, not the metadata layer or the harness. The generate script writes a minimal
``__init__`` in its place under ``sandbox/env/flappy_bird/``.

The metadata values below are the proposed Stage 2 set; ``pace_interval_ms`` in particular is
flagged for tuning during Stage 4 playtesting with a real renderer, and the field is trivial
to change.
"""

from __future__ import annotations

from typing import Any

from game_sandbox_harness.environment import EnvironmentEntry, EnvironmentMeta

from .env import NOOP_ACTION, make_env
from .overlay import extract_overlay

ENV_ID = "flappy_bird"

META = EnvironmentMeta(
    env_id=ENV_ID,
    display_name="Flappy Bird",
    description=(
        "A Flappy Bird style single-agent game: tap to flap and steer the bird through the "
        "gaps between pipes. Brought in through the single-agent compatibility wrapper."
    ),
    min_slots=1,
    max_slots=1,
    human_slots=("player_0",),
    # A pace interval is set, so the interval itself is the human deadline.
    human_timeout_ms=None,
    recommended_episode_ticks=1000,
    pace_interval_ms=50,  # 20 steps/second; flagged for Stage 4 playtesting.
    step_limit_ms=1000,
    episode_limit_ms=120_000,
    messaging=False,
    message_cap=None,
    llm=False,
    renderer="flappy-bird",
    # Single-slot, so seat order is moot; the scheduler never multi-seats this environment.
    seat_order_matters=False,
)


def _default_action(env: Any, slot_id: str) -> int:
    """The legal default on every timeout path: do nothing (idle).

    Idle (integer ``0``) is always legal, so it is already a real ``Discrete(2)`` action; the env and
    slot id are accepted only for the uniform two-argument hook.
    """
    return NOOP_ACTION


ENTRY = EnvironmentEntry(
    meta=META,
    make=make_env,
    default_action=_default_action,
    overlay=extract_overlay,
)
