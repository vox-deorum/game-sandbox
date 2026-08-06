"""Skirmish at Crane Reach environment entry and pure tactical rules."""

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

from .battlefield import CAPTURE_ZONES_BOUNDS, FIELD_EXTENT_BOUNDS
from .engine import Match, MatchConfig, Order
from .env import CAPTURE_TARGET_BOUNDS, ROUND_CAP_BOUNDS, SEAT_PLAN_SPECS, default_action, make_env
from .overlay import extract_overlay

ENV_ID = "skirmish_crane"
PUBLISHED_EXAMPLES = ()

SKIRMISH_SEAT_PLANS = tuple(
    SeatPlan(key=key, title=title, seats=tuple(SeatDeclaration(players=players) for players in seats))
    for key, title, seats in SEAT_PLAN_SPECS
)

META = EnvironmentMeta(
    env_id=ENV_ID,
    display_name="Skirmish at Crane Reach",
    description=(
        "A seeded, turn-based team tactics game in which separately running units coordinate through "
        "perception and delayed messages."
    ),
    stepping="sequential",
    builtin_agents=(BuiltinAgent(name="naive", label="Naive"),),
    layout=SeatPlans(SKIRMISH_SEAT_PLANS),
    human_players=tuple(f"player_{index}" for index in range(40)),
    human_timeout_ms=30_000,
    recommended_episode_ticks=6000,
    pace_interval_ms=None,
    view_interval_ms=1000,
    live_interval_ms=1000,
    step_limit_ms=1_000,
    episode_limit_ms=600_000,
    messaging=True,
    message_cap=200,
    llm=False,
    renderer="crane-reach-field",
    seat_order_matters=True,
    parameters=(
        EnvParameter(
            "field_extent",
            "Field extent",
            "Hex distance from the center to the field edge.",
            "int",
            7,
            *FIELD_EXTENT_BOUNDS,
        ),
        EnvParameter("terrain", "Terrain", "Enables water, hills, forests, and marshes.", "bool", False),
        EnvParameter(
            "wasteland",
            "Wasteland",
            "Scatters magical waste that wounds any unit entering it. Needs terrain.",
            "bool",
            False,
        ),
        EnvParameter(
            "unit_abilities",
            "Unit abilities",
            "Enables cavalry charge and footman shield wall.",
            "bool",
            False,
        ),
        EnvParameter(
            "capture_zones",
            "Capture zones",
            "Number of scoring zones. Zero disables capture play.",
            "int",
            0,
            *CAPTURE_ZONES_BOUNDS,
        ),
        EnvParameter(
            "capture_target",
            "Capture target",
            "Score needed to end a capture match.",
            "int",
            200,
            *CAPTURE_TARGET_BOUNDS,
        ),
        EnvParameter(
            "round_cap", "Round cap", "Maximum number of completed rounds.", "int", 1000, *ROUND_CAP_BOUNDS
        ),
    ),
    presets=(
        EnvPreset(
            "season_1",
            "Season 1: The Skirmish",
            {},
        ),
        EnvPreset(
            "season_2",
            "Season 2: The March",
            {"terrain": True},
        ),
        EnvPreset(
            "season_3",
            "Season 3: The Army",
            {
                "seat_plan": "army",
                "field_extent": 10,
                "terrain": True,
                "unit_abilities": True,
            },
        ),
        EnvPreset(
            "season_4",
            "Season 4: The Commander",
            {
                "seat_plan": "army",
                "field_extent": 10,
                "terrain": True,
                "unit_abilities": True,
                "capture_zones": 1,
            },
        ),
        EnvPreset(
            "season_5",
            "Season 5: The General",
            {
                "seat_plan": "army",
                "field_extent": 10,
                "terrain": True,
                "unit_abilities": True,
                "capture_zones": 3,
            },
        ),
        EnvPreset(
            "season_6",
            "Season 6: The Rivals",
            {
                "seat_plan": "army",
                "field_extent": 10,
                "terrain": True,
                "wasteland": True,
                "unit_abilities": True,
                "capture_zones": 3,
            },
        ),
    ),
)

ENTRY = EnvironmentEntry(meta=META, make=make_env, default_action=default_action, overlay=extract_overlay)

__all__ = ["ENTRY", "META", "Match", "MatchConfig", "Order", "PUBLISHED_EXAMPLES"]
