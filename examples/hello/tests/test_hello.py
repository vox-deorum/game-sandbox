"""Example-specific test, added on top of the inherited template tests."""

from __future__ import annotations

import agent


def test_agent_name_is_hello():
    assert agent.agent_name() == "hello"


def test_extra_dependency_is_usable():
    # wcwidth comes from requirements.extra.txt; a positive width proves it composed in.
    assert agent.greeting_width("hello") == 5
