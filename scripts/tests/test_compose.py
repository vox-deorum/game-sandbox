"""Compose precedence, the requirements.extra.txt merge, and the loud conflicting-pin fail."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# The dev scripts are run as top-level modules (scripts/ on sys.path), so mirror that here.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from compose_example import ComposeError, _merge_requirements, compose  # noqa: E402


def test_overlay_file_wins_over_template():
    out = compose("hello")
    # examples/hello/agent.py overrides the template placeholder.
    assert "hello" in (out / "agent.py").read_text(encoding="utf-8")
    assert "wcwidth" in (out / "agent.py").read_text(encoding="utf-8")


def test_extra_requirements_are_appended():
    out = compose("hello")
    composed = (out / "requirements.txt").read_text(encoding="utf-8")
    # A template pin and the example's extra pin both end up in the composed file.
    assert "flappy-bird-gymnasium==0.4.0" in composed
    assert "wcwidth==0.2.13" in composed


def test_inherited_and_overlay_tests_coexist():
    out = compose("hello")
    assert (out / "tests" / "test_agent.py").exists()  # inherited from the template
    assert (out / "tests" / "test_hello.py").exists()  # added by the example


def test_merge_appends_non_conflicting_extra():
    merged = _merge_requirements("attrs==24.2.0\n", "wcwidth==0.2.13\n")
    assert "attrs==24.2.0" in merged
    assert "wcwidth==0.2.13" in merged


def test_merge_fails_loudly_on_conflicting_pin():
    with pytest.raises(ComposeError, match="pinned in both"):
        _merge_requirements("attrs==24.2.0\n", "attrs==23.0.0\n")


def test_compose_unknown_example_raises():
    with pytest.raises(ComposeError):
        compose("does-not-exist")
