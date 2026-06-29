"""Hearts: the registry entry that ties the factory, default action, overlay, and the
public-facing metadata together.

This is the only module in the environment that imports the harness (for the metadata
types), so it is *not* synced into the student template — students need a steppable
PettingZoo env, not the metadata layer or the harness. The generate script writes a minimal
``__init__`` in its place under ``sandbox/env/hearts/``.
"""

from __future__ import annotations

from game_sandbox_harness.environment import EnvironmentEntry, EnvironmentMeta

from .env import AUTO_ACTION, make_env
from .overlay import extract_overlay

ENV_ID = "hearts"

META = EnvironmentMeta(
    env_id=ENV_ID,
    display_name="Hearts",
    description=(
        "Four-player trick-taking Hearts: follow suit, avoid taking hearts and the queen of "
        "spades. Or, shoot the moon by taking them all to flip the score!"
    ),
    min_slots=4,
    max_slots=4,
    human_slots=("player_0", "player_1", "player_2", "player_3"),
    # Turn-based, so there is no pace interval; the move clock is the human deadline.
    human_timeout_ms=60_000,
    recommended_episode_ticks=52,
    pace_interval_ms=None,
    # Turn-based stepping (pace_interval_ms stays None), but watch/replay plays each move out at this
    # cadence so a spectator can follow the cards; it does not affect live human play.
    view_interval_ms=3_000,
    step_limit_ms=1_000,
    episode_limit_ms=120_000,
    messaging=False,
    message_cap=None,
    llm=False,
    renderer="hearts",
    # Positional trick-taking game: seating A before B is not the same match as B before A.
    seat_order_matters=True,
)


def _default_action(slot_id: str) -> int:
    """The legal default applied on every timeout path: the env plays the lowest legal card."""
    return AUTO_ACTION


ENTRY = EnvironmentEntry(
    meta=META,
    make=make_env,
    default_action=_default_action,
    overlay=extract_overlay,
)
