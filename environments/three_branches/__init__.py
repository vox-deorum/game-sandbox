"""Days at Three Branches environment entry."""

from __future__ import annotations

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

from .env import default_action, make_env
from .overlay import extract_overlay, extract_overlay_static

ENV_ID = "three_branches"
PUBLISHED_EXAMPLES = ()

META = EnvironmentMeta(
    env_id=ENV_ID,
    display_name="Days at Three Branches",
    description=(
        "A seeded village day in which separately running NPCs make one village feel alive around "
        "a human-played visitor."
    ),
    stepping="simultaneous",
    builtin_agents=(
        BuiltinAgent(name="naive", label="Naive"),
        BuiltinAgent(name="scripted_visitor", label="Scripted visitor"),
    ),
    layout=SeatPlans(
        (
            SeatPlan(
                "cast_5",
                "Five villagers",
                (SeatDeclaration((1, 2, 3, 4, 5)), SeatDeclaration((0,), "scripted_visitor")),
            ),
            SeatPlan(
                "cast_10",
                "Ten villagers",
                (SeatDeclaration(tuple(range(1, 11))), SeatDeclaration((0,), "scripted_visitor")),
            ),
        )
    ),
    human_players=("player_0",),
    human_timeout_ms=None,
    recommended_episode_ticks=1200,
    pace_interval_ms=250,
    view_interval_ms=250,
    live_interval_ms=None,
    step_limit_ms=250,
    episode_limit_ms=120_000,
    messaging=True,
    message_cap=200,
    llm=True,
    renderer="three-branches-village",
    seat_order_matters=False,
    parameters=(EnvParameter("daynight", "Day and night", "Enables the named day phases.", "bool", False),),
    presets=(
        EnvPreset("season_1", "Season 1: Village routines", {}),
        EnvPreset("season_2", "Season 2: A larger village", {"seat_plan": "cast_10"}),
        EnvPreset("season_3", "Season 3: Village relationships", {"seat_plan": "cast_10"}),
        EnvPreset("season_4", "Season 4: Day and night", {"seat_plan": "cast_10", "daynight": True}),
        EnvPreset("season_5", "Season 5: Village dialogue", {"seat_plan": "cast_10", "daynight": True}),
        EnvPreset("season_6", "Season 6: Living village", {"seat_plan": "cast_10", "daynight": True}),
    ),
)

ENTRY = EnvironmentEntry(
    meta=META,
    make=make_env,
    default_action=default_action,
    overlay=extract_overlay,
    overlay_static=extract_overlay_static,
)

__all__ = ["ENTRY", "META", "PUBLISHED_EXAMPLES"]
