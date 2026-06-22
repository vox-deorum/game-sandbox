"""The demo launch modes: the default operator demo vs. the ``demo:user`` ordinary-member mock."""

from __future__ import annotations

import sys
from pathlib import Path

# The dev scripts are run as top-level modules (scripts/ on sys.path), so mirror that here.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import demo  # noqa: E402


def test_default_demo_acts_as_the_operator():
    # No --user: both allowlists are the operator dev-user, so the demo shows the admin console.
    env = demo._demo_env()
    assert env["SESSION_ALLOWLIST"] == demo._DEV_USER
    assert env["OPERATOR_ALLOWLIST"] == demo._DEV_USER


def test_user_demo_mocks_an_allowlisted_non_operator():
    # --user signs in as a fixed e2e member: allowlisted to play, but never an operator, so the
    # admin console stays locked exactly as it is for a real member.
    env = demo._demo_env(demo._DEMO_USER)
    assert env["SESSION_ALLOWLIST"] == demo._DEMO_USER
    assert env["OPERATOR_ALLOWLIST"] == demo._DEV_USER
    assert demo._DEMO_USER != demo._DEV_USER


def test_user_demo_picks_a_real_e2e_member():
    # The hardcoded member must be a genuine e2e owner so its member-facing pages have real data;
    # ada-lovelace (the glider) is the most data-rich, per frontend/e2e/support/names.ts.
    assert demo._DEMO_USER == "ada-lovelace"
