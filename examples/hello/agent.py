"""The 'hello' example agent. Overrides the template's placeholder agent module.

It uses the extra pinned dependency (wcwidth) declared in requirements.extra.txt to show
that the dependency-set extension reaches the composed example.
"""

from __future__ import annotations

from wcwidth import wcswidth


def agent_name() -> str:
    return "hello"


def greeting_width(text: str = "hello") -> int:
    """Display width of the greeting, computed via the extra dependency."""
    return wcswidth(text)
