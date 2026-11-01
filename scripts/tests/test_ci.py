"""The CI job runner's browser-suite selection.

`ci.py frontend-e2e` runs everything by default, because that complete run is what CI checks and what
scripts/demo.py turns into the demo's fixture database. The flags below narrow it for a local loop, so
these tests pin the translation into Playwright's own arguments and the guard that keeps the flags off
every other job.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# The dev scripts are run as top-level modules (scripts/ on sys.path), so mirror that here.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import ci  # noqa: E402


@pytest.mark.parametrize(
    ("groups", "include_slow", "demo_fixture", "flags", "data_subdir", "seed"),
    [
        ([], None, False, [], "main", None),
        ([], False, False, ["--grep-invert", "@slow"], "partial", None),
        ([], False, True, ["--grep-invert", "@slow"], "main", "1"),
        (["hearts"], None, False, ["--project", "hearts", "--grep-invert", "@slow"], "partial", None),
        (["play", "auth"], True, False, ["--project", "auth", "--project", "play"], "partial", None),
    ],
    ids=["complete", "fast", "fast-demo", "one-group", "multiple-groups-with-slow"],
)
def test_browser_job_selects_tests_and_fixture(
    groups: list[str],
    include_slow: bool | None,
    demo_fixture: bool,
    flags: list[str],
    data_subdir: str,
    seed: str | None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[list[str], dict[str, str]]] = []

    def capture(args: list[str], *, env: dict[str, str] | None = None, **_: object) -> None:
        if env is not None:
            calls.append((args, env))

    monkeypatch.delenv("E2E_DEMO_SEED", raising=False)
    monkeypatch.setattr(ci, "_run", capture)

    ci.job_frontend_e2e(groups, include_slow=include_slow, demo_fixture=demo_fixture)

    args, env = calls[-1]
    assert args[1:] == ["exec", "--workspace", "@game-sandbox/frontend", "--", "playwright", "test", *flags]
    assert env["E2E_DATA_SUBDIR"] == data_subdir
    assert env.get("E2E_DEMO_SEED") == seed


def test_a_new_spec_directory_becomes_a_group(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for directory, filename in (
        ("replays", "replays.spec.ts"),
        ("auth", "login.spec.ts"),
        ("support", "api.ts"),
        ("fixtures", "recording.json"),
    ):
        (tmp_path / directory).mkdir()
        (tmp_path / directory / filename).write_text("", encoding="utf-8")
    monkeypatch.setattr(ci, "E2E_DIR", tmp_path)
    assert ci.e2e_groups() == ("auth", "replays")


@pytest.mark.parametrize("flag", ["--group", "--fast", "--include-slow", "--no-build"])
def test_selection_flags_are_refused_on_other_jobs(flag: str) -> None:
    argv = ["python", flag, "hearts"] if flag == "--group" else ["python", flag]
    with pytest.raises(SystemExit):
        ci.main(argv)


def test_aop_check_requires_a_client_certificate_alert(monkeypatch: pytest.MonkeyPatch) -> None:
    rejected = ci.subprocess.CompletedProcess([], 1, stdout="", stderr="alert certificate required")
    monkeypatch.setattr(ci.subprocess, "run", lambda *args, **kwargs: rejected)

    ci._require_aop_client_certificate(["docker", "compose", "--project-name", "smoke"])


def test_aop_check_rejects_a_successful_handshake(monkeypatch: pytest.MonkeyPatch) -> None:
    accepted = ci.subprocess.CompletedProcess([], 0, stdout="Verification: OK", stderr="")
    monkeypatch.setattr(ci.subprocess, "run", lambda *args, **kwargs: accepted)

    with pytest.raises(SystemExit, match="did not require"):
        ci._require_aop_client_certificate(["docker", "compose", "--project-name", "smoke"])


def _proxy_inspection(ports: str):
    """Answer both calls the published-port check makes: the container lookup, then the inspection."""

    def run(args: list[str], **kwargs: object) -> ci.subprocess.CompletedProcess[str]:
        stdout = ports if "inspect" in args else "proxy-container-id\n"
        return ci.subprocess.CompletedProcess(args, 0, stdout=stdout, stderr="")

    return run


def test_published_port_check_accepts_real_host_bindings(monkeypatch: pytest.MonkeyPatch) -> None:
    bound = (
        '{"443/tcp": [{"HostIp": "0.0.0.0", "HostPort": "443"}], '
        '"8443/tcp": [{"HostIp": "127.0.0.1", "HostPort": "18443"}]}'
    )
    monkeypatch.setattr(ci.subprocess, "run", _proxy_inspection(bound))

    ci._require_published_proxy_ports(["docker", "compose", "--project-name", "smoke"])


def test_published_port_check_catches_an_internal_only_proxy(monkeypatch: pytest.MonkeyPatch) -> None:
    """The failure this guards: Docker records the request but binds nothing, so the host refuses."""
    monkeypatch.setattr(ci.subprocess, "run", _proxy_inspection('{"443/tcp": null, "8443/tcp": null}'))

    with pytest.raises(SystemExit, match="443/tcp, 8443/tcp"):
        ci._require_published_proxy_ports(["docker", "compose", "--project-name", "smoke"])
