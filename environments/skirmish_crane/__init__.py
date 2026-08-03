"""Pure rules for Skirmish at Crane Reach.

This package deliberately has no environment entry point. Stage 2 wraps these
rules in PettingZoo after the rules have been proven independently.
"""

from .engine import Match, MatchConfig, Order

__all__ = ["Match", "MatchConfig", "Order"]
