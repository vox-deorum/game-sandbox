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


def test_backend_env_opts_into_loopback_auth_defaults():
    # Both launch modes run this same env (there is no per-mode variant anymore): the backend must
    # be explicitly opted into the published insecure development defaults, the same way the e2e
    # "main" backend is (see frontend/playwright.config.ts), so its bootstrap admin re-syncs to the
    # published dev credentials and a loopback origin is set for the cookie/session config to work.
    env = demo._demo_env()
    assert env["AUTH_ALLOW_INSECURE_DEFAULTS"] == "true"
    assert env["PUBLIC_ORIGIN"].startswith(("http://localhost", "http://127.0.0.1"))


def test_backend_env_points_the_llm_proxy_at_the_fake_upstream(monkeypatch):
    # A real provider configured in .env must not leak into the demo: the blank tiers mask its
    # model names, and the upstream URL and key come from the process environment, which wins.
    monkeypatch.setenv("LLM_MODEL_LARGE", "real-large")
    env = demo._demo_env("http://127.0.0.1:1234/v1")
    assert env["LLM_UPSTREAM_URL"] == "http://127.0.0.1:1234/v1"
    assert env["LLM_MODEL_SMALL"] == "provider-small"
    assert env["LLM_MODEL_LARGE"] == ""
    assert env["LLM_MODEL_MEDIUM"] == ""


def test_backend_env_leaves_llm_settings_to_env_files_with_real_llm():
    def llm(env):
        return {key: value for key, value in env.items() if key.startswith("LLM_")}

    assert llm(demo._demo_env()) == llm(demo.os.environ)


def test_run_backend_returns_child_exit_code_after_keyboard_interrupt(monkeypatch):
    class FakeProcess:
        wait_calls = 0

        def wait(self):
            self.wait_calls += 1
            if self.wait_calls == 1:
                raise KeyboardInterrupt
            return 130

    process = FakeProcess()
    monkeypatch.setattr(demo.subprocess, "Popen", lambda *args, **kwargs: process)

    assert demo.run_backend() == 130


def test_launch_prints_both_example_accounts(capsys):
    # The single demo launch prints both the bootstrap admin (role admin) and the ordinary member
    # ada-lovelace ("student", role user) so either can be signed in with at /login. The static
    # recovery guidance points at the command that rebuilds a stale or incomplete fixture.
    demo._print_credentials()
    out = capsys.readouterr().out
    assert "admin@example.com" in out
    assert "admin-dev-password" in out
    assert "ada-lovelace@e2e.local" in out
    assert "e2e-member-password" in out
    assert "--rerun-e2e" in out


def test_rebuild_skips_slow_tests_and_replaces_the_main_fixture(tmp_path, monkeypatch):
    main = tmp_path / "main"
    database = main / "sandbox.db"
    main.mkdir()
    (main / "stale.txt").write_text("stale", encoding="utf-8")
    calls = []

    def run_e2e(**kwargs):
        calls.append(kwargs)
        main.mkdir()
        database.write_bytes(b"fresh")

    monkeypatch.setattr(demo, "E2E_MAIN_DATA_DIR", main)
    monkeypatch.setattr(demo, "E2E_MAIN_DB", database)
    monkeypatch.setattr(demo, "job_frontend_e2e", run_e2e)

    demo.rebuild_e2e_db()

    assert calls == [{"include_slow": False, "demo_fixture": True}]
    assert database.read_bytes() == b"fresh"
    assert not (main / "stale.txt").exists()


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
