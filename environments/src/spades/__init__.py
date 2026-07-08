"""Spades: the registry entry that ties the factory, default action, overlay, and the
public-facing metadata together.

This is the only module in the environment that imports the harness (for the metadata types), so
it is *not* synced into the student template: students need a steppable PettingZoo env, not the
metadata layer or the harness. The generate script writes a minimal ``__init__`` in its place
under ``sandbox/env/spades/``.

The ``messaging`` flag is declared here from day one and left inert: nothing reads it until the
Stage 8 chat hook is wired, but declaring the environment's final metadata shape once means the
metadata tests pin it from the start.
"""

from __future__ import annotations

from game_sandbox_harness.environment import EnvironmentEntry, EnvironmentMeta

from .env import default_action, make_env
from .overlay import extract_overlay

ENV_ID = "spades"

META = EnvironmentMeta(
    env_id=ENV_ID,
    display_name="Spades",
    description=(
        "Four-player partnership Spades: bid the tricks you will take, then follow suit and play "
        "them out with spades trump. Your agent play in teams."
    ),
    min_slots=4,
    max_slots=4,
    human_slots=("player_0", "player_1", "player_2", "player_3"),
    # Turn-based, so there is no pace interval; the move clock is the human deadline.
    human_timeout_ms=60_000,
    # Four bids plus fifty-two plays.
    recommended_episode_ticks=56,
    pace_interval_ms=None,
    # Turn-based stepping (pace_interval_ms stays None), but watch/replay plays each move out at
    # this cadence so a spectator can follow the bids and cards; it does not affect live human play.
    view_interval_ms=3_000,
    # Live human play paces the *other* seats' moves at this cadence so a burst of fast AI replies
    # animates one at a time (the human's own move still renders instantly). Same cadences as Hearts.
    live_interval_ms=900,
    step_limit_ms=1_000,
    episode_limit_ms=120_000,
    # Spades is the messaging-enabled environment of the stage; the cap counts Unicode code points.
    # The flag stays inert until the chat hook is wired in a later step.
    messaging=True,
    message_cap=120,
    llm=False,
    renderer="spades",
    # Partnership assignment and lead position both depend on seating, so seating A before B is not
    # the same match as B before A: the scheduler enumerates ordered seatings.
    seat_order_matters=True,
)


ENTRY = EnvironmentEntry(
    meta=META,
    make=make_env,
    default_action=default_action,
    overlay=extract_overlay,
)
