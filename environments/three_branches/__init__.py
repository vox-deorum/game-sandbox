"""Days at Three Branches environment entry and public rules types."""

from __future__ import annotations

from typing import Any

from game_sandbox_harness.environment import (
    BuiltinAgent,
    EnvironmentEntry,
    EnvironmentMeta,
    EnvParameter,
    EnvPreset,
    SeatDeclaration,
    SeatPlan,
    SeatPlans,
)

from .engine import Day, DayConfig, Order
from .env import SEAT_PLAN_SPECS, default_action, make_env

ENV_ID = "three_branches"
PUBLISHED_EXAMPLES = ()

THREE_BRANCHES_SEAT_PLANS = tuple(
    SeatPlan(
        key=key,
        title=title,
        seats=(
            SeatDeclaration(players=seats[0]),
            SeatDeclaration(players=seats[1], restricted_builtin="scripted_visitor"),
        ),
    )
    for key, title, seats in SEAT_PLAN_SPECS
)

META = EnvironmentMeta(
    env_id=ENV_ID,
    display_name="Days at Three Branches",
    description=(
        "A seeded village day in which separately running NPCs make one village feel alive around a "
        "human-played visitor."
    ),
    stepping="simultaneous",
    builtin_agents=(
        BuiltinAgent(name="naive", label="Naive"),
        BuiltinAgent(name="scripted_visitor", label="Scripted visitor"),
    ),
    layout=SeatPlans(THREE_BRANCHES_SEAT_PLANS),
    human_players=("player_0",),
    human_timeout_ms=None,
    recommended_episode_ticks=1200,
    pace_interval_ms=250,
    view_interval_ms=250,
    step_limit_ms=250,
    episode_limit_ms=120_000,
    messaging=True,
    message_cap=200,
    llm=True,
    renderer="three-branches-village",
    parameters=(
        EnvParameter("daynight", "Day and night", "Enables the ruleset's day phases.", "bool", False),
    ),
    presets=(
        EnvPreset("season_1", "Season 1", {"seat_plan": "cast_5", "daynight": False}),
        EnvPreset("season_2", "Season 2", {"seat_plan": "cast_10", "daynight": False}),
        EnvPreset("season_3", "Season 3", {"seat_plan": "cast_10", "daynight": False}),
        EnvPreset("season_4", "Season 4", {"seat_plan": "cast_10", "daynight": True}),
        EnvPreset("season_5", "Season 5", {"seat_plan": "cast_10", "daynight": True}),
        EnvPreset("season_6", "Season 6", {"seat_plan": "cast_10", "daynight": True}),
    ),
)


def _extract_overlay(env: Any) -> dict[str, Any]:
    """Defer the renderer-owned overlay import until an overlay is requested."""
    from .overlay import extract_overlay

    return extract_overlay(env)


ENTRY = EnvironmentEntry(meta=META, make=make_env, default_action=default_action, overlay=_extract_overlay)

__all__ = ["Day", "DayConfig", "ENTRY", "ENV_ID", "META", "Order", "PUBLISHED_EXAMPLES"]
