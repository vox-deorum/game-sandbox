"""The demo launch: one backend, both example accounts printed for a real /login sign-in.

Better Auth model: the backend no longer takes a mock identity header or an allowlist, so the
demo runs the backend with a loopback auth env (mirroring the e2e "main" backend in
frontend/playwright.config.ts) and, on launch, prints the real Better Auth credentials for both
the bootstrap admin and the ordinary member ("student") so either can be signed in with at /login.
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


def test_launch_prints_both_example_accounts(capsys, monkeypatch):
    # The single demo launch prints both the bootstrap admin (role admin) and the ordinary member
    # ada-lovelace ("student", role user) so either can be signed in with at /login — there is no
    # separate member-only mode anymore. Pretend the member fixture is present so no "missing" note
    # is added and the check does not touch the filesystem.
    monkeypatch.setattr(demo, "_member_account_present", lambda: True)
    demo._print_credentials()
    out = capsys.readouterr().out
    assert demo._ADMIN_EMAIL in out
    assert demo._ADMIN_PASSWORD in out
    assert demo._MEMBER_EMAIL in out
    assert demo._MEMBER_PASSWORD in out


def test_launch_flags_a_missing_member_without_failing(capsys, monkeypatch):
    # When the reused e2e database lacks the member fixture (a partial run), her credentials are
    # still printed but flagged with the rebuild hint; the launch does not abort, since the admin
    # demo is unaffected.
    monkeypatch.setattr(demo, "_member_account_present", lambda: False)
    demo._print_credentials()
    out = capsys.readouterr().out
    assert demo._MEMBER_EMAIL in out
    assert "--rerun-e2e" in out


def test_member_credentials_match_the_e2e_fixture():
    # The member credentials the demo prints must name a real account the e2e fixtures create, with
    # the exact email/password the e2e suite signs in with (frontend/e2e/support/auth.ts): emailFor(
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
