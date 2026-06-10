"""Placeholder agent module.

The real agent interface (reset, act, optional learn and chat) arrives with the Stage 2
template. For now this is a trivial module so composition and the test pipeline have
something concrete to build and run. An example overlay replaces this file wholesale.
"""

from __future__ import annotations


def agent_name() -> str:
    """Return the agent's display name. Overridden by examples that customize the agent."""
    return "placeholder-template-agent"
