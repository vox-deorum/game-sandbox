"""Provided helpers for Skirmish at Crane Reach agents, grouped into six small namespaces.

Import the namespaces you need at the top of ``agent.py``, not inside a method::

    from sandbox.crane import action, me, tile, visible

Besides ``sandbox.observation_types``, this package is the only piece of ``sandbox`` you are
meant to use. It is plain Python with no third-party dependencies, so importing it does not drag
in the environment engine.

- ``action``: read what is legal this turn and build the order your ``act`` returns.
- ``me``: your own unit's fields, including ``direction``, the digit toward the enemy side.
- ``visible``: the units your unit can see, split into enemies and allies.
- ``roster``: both sides' starting rosters, standing knowledge for units you cannot see.
- ``tile``: hex geometry and the ground, including where a path ends and what terrain is where.
- ``paths``: the stable path encoding, for when you plan a route longer than one step.

Everything here reads the observation and the authoritative action mask. Nothing here decides
anything: no helper picks a target, a route, or a tile for you.

There is deliberately no pathfinder. Turning a route toward a distant tile into a legal,
mask-checked order, and re-planning as the battlefield changes, is your own work. The full
observation and action reference lives in ``environment.md``, shipped alongside this template.
"""

from __future__ import annotations

from . import action, me, paths, roster, tile, visible

__all__ = ["action", "me", "paths", "roster", "tile", "visible"]
