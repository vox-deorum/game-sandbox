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


def test_prepare_demo_data_snapshots_database_and_sidecars(tmp_path, monkeypatch):
    main = tmp_path / "main"
    demo_dir = tmp_path / "demo"
    (main / "recordings" / "recording-one").mkdir(parents=True)
    (main / "llm" / "development").mkdir(parents=True)
    (main / "submissions").mkdir(parents=True)
    (main / "sandbox.db").write_bytes(b"database")
    (main / "recordings" / "recording-one" / "recording.jsonl").write_text("recording", encoding="utf-8")
    (main / "llm" / "scope.sqlite").write_bytes(b"official telemetry")
    (main / "llm" / "development" / "season.sqlite").write_bytes(b"development telemetry")
    (main / "submissions" / "submission.tar.gz").write_bytes(b"submission")
    demo_dir.mkdir()
    (demo_dir / "stale.txt").write_text("stale", encoding="utf-8")

    monkeypatch.setattr(demo, "E2E_MAIN_DATA_DIR", main)
    monkeypatch.setattr(demo, "DEMO_DATA_DIR", demo_dir)

    demo.prepare_demo_data()

    assert (demo_dir / "sandbox.db").read_bytes() == b"database"
    assert (demo_dir / "recordings" / "recording-one" / "recording.jsonl").read_text(
        encoding="utf-8"
    ) == "recording"
    assert (demo_dir / "llm" / "scope.sqlite").read_bytes() == b"official telemetry"
    assert (demo_dir / "llm" / "development" / "season.sqlite").read_bytes() == b"development telemetry"
    assert (demo_dir / "submissions" / "submission.tar.gz").read_bytes() == b"submission"
    assert not (demo_dir / "stale.txt").exists()
