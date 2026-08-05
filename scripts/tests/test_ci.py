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


def test_complete_run_passes_no_filters() -> None:
    """The default must stay unfiltered: anything less cannot seed the demo fixture."""
    assert ci._e2e_playwright_args([], include_slow=True) == []


def test_fast_run_drops_the_slow_arcs() -> None:
    assert ci._e2e_playwright_args([], include_slow=False) == ["--grep-invert", "@slow"]


def test_a_group_becomes_a_project_and_skips_the_arcs() -> None:
    assert ci._e2e_playwright_args(["hearts"], include_slow=False) == [
        "--project",
        "hearts",
        "--grep-invert",
        "@slow",
    ]


def test_groups_repeat_the_project_flag() -> None:
    assert ci._e2e_playwright_args(["auth", "play"], include_slow=True) == [
        "--project",
        "auth",
        "--project",
        "play",
    ]


def test_groups_are_the_spec_directories() -> None:
    """A group is a directory holding specs, so the filesystem is the only registry to keep in step."""
    groups = ci.e2e_groups()
    assert groups == tuple(sorted(groups)), "callers rely on a stable order"
    assert "hearts" in groups
    for name in groups:
        assert list((ci.E2E_DIR / name).glob("*.spec.ts")), f"{name} holds no spec"


def test_shared_machinery_is_not_a_group() -> None:
    """support/ and fixtures/ sit beside the groups and hold no specs, so they must not become projects."""
    assert "support" not in ci.e2e_groups()
    assert "fixtures" not in ci.e2e_groups()


def test_a_new_spec_directory_becomes_a_group(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Adding a directory with a spec in it is the whole procedure for adding a group."""
    (tmp_path / "support").mkdir()
    (tmp_path / "support" / "api.ts").write_text("", encoding="utf-8")
    (tmp_path / "replays").mkdir()
    (tmp_path / "replays" / "replays.spec.ts").write_text("", encoding="utf-8")
    monkeypatch.setattr(ci, "E2E_DIR", tmp_path)
    assert ci.e2e_groups() == ("replays",)


@pytest.mark.parametrize("flag", ["--group", "--fast", "--include-slow", "--no-build"])
def test_selection_flags_are_refused_on_other_jobs(flag: str) -> None:
    argv = ["python", flag, "hearts"] if flag == "--group" else ["python", flag]
    with pytest.raises(SystemExit):
        ci.main(argv)
