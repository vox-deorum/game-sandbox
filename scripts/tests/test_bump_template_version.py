"""The version-bump script: the pure transforms, the end-to-end apply, and the consistency check.

Most tests run against a synthetic repo tree built under ``tmp_path`` with the module's path
constants monkeypatched onto it (the pattern ``test_compose.py`` uses), so a bump can be applied and
re-applied without touching the real repo. One test runs ``check()`` against the live checkout, which
is exactly what CI runs — but nothing here asserts byte-equality between a fresh freeze and the real
``deps-v1/requirements.txt``, because the live template set may legitimately drift after a release.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

# The dev scripts are run as top-level modules (scripts/ on sys.path), so mirror that here.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import bump_template_version as bump  # noqa: E402
from bump_template_version import (  # noqa: E402
    BumpError,
    bump_deps_version_ts,
    freeze_requirements,
    rewrite_dockerfile,
)

# A pip-compile-shaped requirements file: pins interleaved with indented "# via" provenance blocks.
_PIP_COMPILE = """\
annotated-types==0.7.0
    # via pydantic
anyio==4.13.0
    # via
    #   httpx
    #   openai
numpy==2.4.6
    # via
    #   -r templates/base/requirements.in
    #   matplotlib
"""

# A minimal deps-version.ts carrying the two anchors the bump edits.
_DEPS_TS = """\
import type { SessionBaseImageSpec } from './driver/index.js'

/** current version */
export const DEPS_VERSION = 1

const SESSION_BASE_IMAGES: ReadonlyMap<number, SessionBaseImageDefinition> = new Map([
  [1, { dockerfile: 'backend/images/session-base/deps-v1/Dockerfile' }],
])
"""

# A tiny stand-in Dockerfile with the version in both COPY paths and comment prose.
_DOCKERFILE = """\
# The session base image for dependency-set version 1, tagged game-sandbox/session-base:deps-v1.
FROM python:3.12-slim
# The frozen v1 dependency set installs first.
COPY backend/images/session-base/deps-v1/requirements.txt ./requirements.txt
COPY backend/images/session-base/deps-v1/builtin /opt/agents/builtin
"""


# --- pure transforms --------------------------------------------------------------------------


def test_freeze_requirements_strips_comments_and_headers():
    frozen = freeze_requirements(_PIP_COMPILE, 3)
    assert frozen.startswith("# Frozen v3 dependency set for the deps-v3 session base image.")
    lines = frozen.splitlines()
    # Two header lines, then only the pins, in order, no "# via" blocks.
    assert lines[0].startswith("# Frozen v3")
    assert lines[1].startswith("# do not edit")
    assert lines[2:] == ["annotated-types==0.7.0", "anyio==4.13.0", "numpy==2.4.6"]
    assert frozen.endswith("\n")


def test_freeze_requirements_rejects_a_non_pin():
    with pytest.raises(BumpError, match="'==' pin"):
        freeze_requirements("-e .\nanyio==4.13.0\n", 2)


def test_rewrite_dockerfile_rewrites_paths_and_comment_prose_only():
    out = rewrite_dockerfile(_DOCKERFILE, 1, 2)
    # Every deps-v1 path is now deps-v2; none of the old marker survives.
    assert "deps-v1" not in out
    assert out.count("deps-v2") == 3  # one comment mention + two COPY paths
    # Comment prose is rewritten...
    assert "dependency-set version 2" in out
    assert "frozen v2 dependency set" in out
    assert "session-base:deps-v2" in out
    # ...but image content on non-comment lines is untouched.
    assert "FROM python:3.12-slim" in out


def test_rewrite_dockerfile_fails_without_its_own_version():
    with pytest.raises(BumpError, match="does not reference"):
        rewrite_dockerfile("FROM python:3.12-slim\n", 1, 2)


def test_bump_deps_version_ts_sets_constant_and_appends_entry():
    out = bump_deps_version_ts(_DEPS_TS, 1, 2)
    assert "export const DEPS_VERSION = 2" in out
    assert "export const DEPS_VERSION = 1" not in out
    # The old entry is kept and the new one appended before the closing "])".
    assert "[1, { dockerfile: 'backend/images/session-base/deps-v1/Dockerfile' }]," in out
    assert "[2, { dockerfile: 'backend/images/session-base/deps-v2/Dockerfile' }]," in out


def test_bump_deps_version_ts_rejects_wrong_previous():
    # The file's constant is 1, but the caller claims the previous version was 2.
    with pytest.raises(BumpError, match="expected 2"):
        bump_deps_version_ts(_DEPS_TS, 2, 3)


def test_bump_deps_version_ts_rejects_missing_anchor():
    with pytest.raises(BumpError, match="DEPS_VERSION"):
        bump_deps_version_ts("const x = 1\n", 1, 2)


# --- synthetic-repo fixtures for apply()/check() ----------------------------------------------


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _manifest(version: int) -> str:
    return (
        json.dumps({"entry_point": "agent", "class_name": "Agent", "template_version": version}, indent=2)
        + "\n"
    )


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A synthetic repo at version 1 with every touchpoint the bump script edits."""
    base_manifest = tmp_path / "templates" / "base" / "manifest.json"
    base_requirements = tmp_path / "templates" / "base" / "requirements.txt"
    deps_ts = tmp_path / "backend" / "src" / "deps-version.ts"
    images = tmp_path / "backend" / "images" / "session-base"
    fixtures = tmp_path / "frontend" / "e2e" / "fixtures" / "submission"

    _write(base_manifest, _manifest(1))
    _write(base_requirements, _PIP_COMPILE)
    _write(deps_ts, _DEPS_TS)

    deps_v1 = images / "deps-v1"
    _write(deps_v1 / "Dockerfile", _DOCKERFILE)
    _write(deps_v1 / "requirements.txt", freeze_requirements(_PIP_COMPILE, 1))
    _write(deps_v1 / "builtin" / "flappy_bird" / "manifest.json", _manifest(1))
    _write(deps_v1 / "builtin" / "flappy_bird" / "requirements.txt", "wcwidth==0.2.13\n")
    _write(deps_v1 / "builtin" / "flappy_bird" / "agent.py", "# agent\n")
    _write(deps_v1 / "builtin" / "hearts" / "manifest.json", _manifest(1))
    _write(deps_v1 / "builtin" / "hearts" / "agent.py", "# agent\n")

    for name in ("good", "bad-class"):
        _write(fixtures / name / "manifest.json", _manifest(1))

    monkeypatch.setattr(bump, "TEMPLATE_BASE_MANIFEST", base_manifest)
    monkeypatch.setattr(bump, "TEMPLATE_BASE_REQUIREMENTS", base_requirements)
    monkeypatch.setattr(bump, "DEPS_VERSION_TS", deps_ts)
    monkeypatch.setattr(bump, "SESSION_BASE_IMAGES_DIR", images)
    monkeypatch.setattr(bump, "E2E_SUBMISSION_FIXTURES_DIR", fixtures)
    return tmp_path


def _snapshot_tree(root: Path) -> dict[str, str]:
    """Every file under root as {relative-posix-path: text}, for whole-tree equality checks."""
    return {
        str(p.relative_to(root).as_posix()): p.read_text(encoding="utf-8")
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


# --- apply() and check() ----------------------------------------------------------------------


def test_check_passes_on_a_consistent_synthetic_repo(repo: Path):
    assert bump.check() == []


def test_apply_bumps_every_touchpoint(repo: Path):
    bump.apply(2)

    assert bump.current_version() == 2
    assert '"template_version": 2' in (repo / "templates" / "base" / "manifest.json").read_text()
    for name in ("good", "bad-class"):
        text = (repo / "frontend" / "e2e" / "fixtures" / "submission" / name / "manifest.json").read_text()
        assert '"template_version": 2' in text

    ts = (repo / "backend" / "src" / "deps-version.ts").read_text()
    assert "export const DEPS_VERSION = 2" in ts
    assert "deps-v2/Dockerfile" in ts

    deps_v2 = repo / "backend" / "images" / "session-base" / "deps-v2"
    assert (deps_v2 / "requirements.txt").read_text().startswith("# Frozen v2")
    assert '"template_version": 2' in (deps_v2 / "builtin" / "hearts" / "manifest.json").read_text()
    # Non-manifest builtin files are copied verbatim.
    assert (deps_v2 / "builtin" / "flappy_bird" / "requirements.txt").read_text() == "wcwidth==0.2.13\n"
    assert (deps_v2 / "builtin" / "flappy_bird" / "agent.py").read_text() == "# agent\n"
    # check() agrees the bumped tree is consistent.
    assert bump.check() == []


def test_apply_is_idempotent(repo: Path):
    bump.apply(2)
    after_first = _snapshot_tree(repo)
    bump.apply(2)  # already at 2: a validated no-op
    assert _snapshot_tree(repo) == after_first


def test_apply_same_version_is_a_noop(repo: Path):
    before = _snapshot_tree(repo)
    bump.apply(1)
    assert _snapshot_tree(repo) == before


def test_apply_refuses_to_bump_down(repo: Path):
    bump.apply(3)
    with pytest.raises(BumpError, match="refusing to bump down"):
        bump.apply(2)


def test_apply_can_skip_versions(repo: Path):
    # N need not be prev+1; the registry just gains the requested version.
    bump.apply(5)
    assert bump.current_version() == 5
    ts = (repo / "backend" / "src" / "deps-version.ts").read_text()
    assert "deps-v5/Dockerfile" in ts
    assert "deps-v1/Dockerfile" in ts  # old entry retained


# --- escape hatch -----------------------------------------------------------------------------


def test_apply_keeps_a_valid_hand_crafted_snapshot(repo: Path):
    # A maintainer pre-creates deps-v2/ with a recipe change (an extra RUN line). apply must keep it.
    deps_v2 = repo / "backend" / "images" / "session-base" / "deps-v2"
    hand_dockerfile = (
        "# dependency-set version 2, deps-v2\n"
        "FROM python:3.12-slim\n"
        "RUN echo hand-crafted\n"
        "COPY backend/images/session-base/deps-v2/requirements.txt ./requirements.txt\n"
        "COPY backend/images/session-base/deps-v2/builtin /opt/agents/builtin\n"
    )
    _write(deps_v2 / "Dockerfile", hand_dockerfile)
    _write(deps_v2 / "requirements.txt", freeze_requirements(_PIP_COMPILE, 2))
    _write(deps_v2 / "builtin" / "hearts" / "manifest.json", _manifest(2))

    bump.apply(2)
    assert (deps_v2 / "Dockerfile").read_text() == hand_dockerfile  # untouched


def test_apply_rejects_an_inconsistent_hand_crafted_snapshot(repo: Path):
    deps_v2 = repo / "backend" / "images" / "session-base" / "deps-v2"
    # Its Dockerfile still names deps-v1 paths — a stale hand-crafted snapshot.
    _write(deps_v2 / "Dockerfile", _DOCKERFILE)
    _write(deps_v2 / "requirements.txt", freeze_requirements(_PIP_COMPILE, 2))
    _write(deps_v2 / "builtin" / "hearts" / "manifest.json", _manifest(2))

    with pytest.raises(BumpError, match="not a valid deps-v2 snapshot"):
        bump.apply(2)


# --- check() catches each single divergence ---------------------------------------------------


def test_check_flags_manifest_constant_mismatch(repo: Path):
    ts = repo / "backend" / "src" / "deps-version.ts"
    ts.write_text(_DEPS_TS.replace("DEPS_VERSION = 1", "DEPS_VERSION = 2"), encoding="utf-8")
    problems = bump.check()
    assert any("DEPS_VERSION is 2" in p for p in problems)


def test_check_flags_drifted_fixture(repo: Path):
    fixture = repo / "frontend" / "e2e" / "fixtures" / "submission" / "good" / "manifest.json"
    fixture.write_text(_manifest(7), encoding="utf-8")
    problems = bump.check()
    assert any("template_version is 7" in p for p in problems)


def test_check_flags_missing_snapshot_dir(repo: Path):
    import shutil

    shutil.rmtree(repo / "backend" / "images" / "session-base" / "deps-v1")
    problems = bump.check()
    assert any("is missing" in p for p in problems)


# --- live tree --------------------------------------------------------------------------------


def test_check_passes_on_the_real_repo():
    # No monkeypatching: this is exactly what CI's generated-code-fresh job runs.
    assert bump.check() == []
