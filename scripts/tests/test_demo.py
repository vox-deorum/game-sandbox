"""The demo launch modes: the default operator demo vs. the ``demo:user`` ordinary-member mock.

Better Auth model: the backend no longer takes a mock identity header or an allowlist, so both
launch modes run the backend with the identical loopback auth env (mirroring the e2e "main"
backend in frontend/playwright.config.ts) and differ only in which persona's real Better Auth
credentials the command prints for the user to sign in with at /login.
"""

from __future__ import annotations

import sys
from pathlib import Path

# The dev scripts are run as top-level modules (scripts/ on sys.path), so mirror that here.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import demo  # noqa: E402


def test_backend_env_has_no_mock_identity_or_allowlist():
    # The old mock-identity/allowlist model is gone: no baked frontend user variable and no
    # session/operator allowlist keys must resurface in the demo backend env. Matched on substrings
    # so this guard names no removed variable literally.
    env = demo._demo_env()
    assert not any("ALLOWLIST" in key for key in env)
    assert not any("SANDBOX_USER" in key for key in env)


def test_backend_env_opts_into_loopback_auth_defaults():
    # Both launch modes run this same env (there is no per-mode variant anymore): the backend must
    # be explicitly opted into the published insecure development defaults, the same way the e2e
    # "main" backend is (see frontend/playwright.config.ts), so its bootstrap admin re-syncs to the
    # published dev credentials and a loopback origin is set for the cookie/session config to work.
    env = demo._demo_env()
    assert env["AUTH_ALLOW_INSECURE_DEFAULTS"] == "true"
    assert env["PUBLIC_ORIGIN"].startswith(("http://localhost", "http://127.0.0.1"))


def test_default_mode_selects_the_bootstrap_admin():
    # No --user: the printed/selected persona is the bootstrap admin the backend seeds under
    # AUTH_ALLOW_INSECURE_DEFAULTS (role admin), reached by a real sign-in at /login.
    assert demo._credentials(acting_user=False) == (demo._ADMIN_EMAIL, demo._ADMIN_PASSWORD)


def test_user_mode_selects_adas_member_account():
    # --user selects the ordinary e2e member ada-lovelace instead (role user), never the admin.
    assert demo._credentials(acting_user=True) == (demo._MEMBER_EMAIL, demo._MEMBER_PASSWORD)


def test_member_credentials_match_the_e2e_fixture():
    # The credentials --user names must be a real account the e2e fixtures create, with the exact
    # email/password the e2e suite signs in with (frontend/e2e/support/auth.ts): emailFor(
    # 'ada-lovelace') and MEMBER_PASSWORD. Keeping these constants in sync is what makes a real
    # /login sign-in succeed against the copied fixture database.
    assert demo._MEMBER_EMAIL == "ada-lovelace@e2e.local"
    assert demo._MEMBER_PASSWORD == "e2e-member-password"


def test_bootstrap_admin_and_ordinary_member_are_distinct_personas():
    # The bootstrap account is role `admin`; the e2e member fixture stays role `user`. There is no
    # allowlist left to encode that distinction in env, so it is encoded in the two separate
    # persona constants: different emails, and the member is specifically Ada (the data-rich
    # non-admin), never promoted to admin.
    assert demo._ADMIN_EMAIL != demo._MEMBER_EMAIL
    assert demo._MEMBER_EMAIL.startswith("ada-lovelace@")
