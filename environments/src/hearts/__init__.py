"""Hearts: the registry entry that ties the factory, default action, overlay, and the
public-facing metadata together.

This is the only module in the environment that imports the harness (for the metadata
types), so it is *not* synced into the student template — students need a steppable
PettingZoo env, not the metadata layer or the harness. The generate script writes a minimal
``__init__`` in its place under ``sandbox/env/hearts/``.
"""

from __future__ import annotations

from typing import Any

from game_sandbox_harness.environment import EnvironmentEntry, EnvironmentMeta

from . import rules
from .env import make_env
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
    # Live human play paces the *other* seats' moves at this cadence so a burst of fast AI replies
    # animates one card at a time (the human's own move still renders instantly). Snappier than the
    # 3s spectator pace above: ~0.9s/move, so a four-card trick resolves in ~3.6s. Tune here.
    live_interval_ms=900,
    step_limit_ms=1_000,
    episode_limit_ms=120_000,
    messaging=False,
    message_cap=None,
    llm=False,
    renderer="hearts",
    # Positional trick-taking game: seating A before B is not the same match as B before A.
    seat_order_matters=True,
)


def _default_action(env: Any, slot_id: str) -> int:
    """The legal default for a timed-out seat: its lowest legal card.

    The hook reads the live env and returns the concrete ``Discrete(52)`` card (not a sentinel), so
    the recording holds the real move. It matches ``env.step``'s own resolution, so gameplay is unchanged.
    """
    seat = env.possible_agents.index(slot_id)
    return rules.lowest_legal_card(env.state, seat)


ENTRY = EnvironmentEntry(
    meta=META,
    make=make_env,
    default_action=_default_action,
    overlay=extract_overlay,
)
