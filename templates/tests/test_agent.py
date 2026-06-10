"""Template tests. Every composed example inherits these and must pass them in CI."""

from __future__ import annotations

import agent
import attrs


def test_agent_name_is_a_nonempty_string():
    name = agent.agent_name()
    assert isinstance(name, str)
    assert name


def test_pinned_runtime_dependency_is_importable():
    # attrs stands in for the real dependency set; it must come from requirements.txt.
    @attrs.define
    class _Probe:
        value: int

    assert _Probe(value=1).value == 1
