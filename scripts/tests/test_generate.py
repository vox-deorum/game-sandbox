"""Focused ownership tests for the Stage 13 template generator additions."""

from __future__ import annotations

import json
import subprocess
import sys
import zipfile
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import _envs  # noqa: E402
import generate  # noqa: E402
from _paths import REPO_ROOT  # noqa: E402
from game_sandbox_harness.environment import BuiltinAgent, EnvironmentMeta, PlayerBounds  # noqa: E402


def _meta() -> EnvironmentMeta:
    return EnvironmentMeta(
        env_id="example",
        display_name="Example",
        description="A complete metadata fixture.",
        stepping="sequential",
        builtin_agents=(BuiltinAgent("naive", "Naive"),),
        layout=PlayerBounds(1, 2),
        human_players=("player_0", "player_1"),
        human_timeout_ms=50,
        recommended_episode_ticks=10,
        pace_interval_ms=None,
        step_limit_ms=100,
        episode_limit_ms=1000,
        messaging=True,
        message_cap=12,
        llm=True,
        renderer="example",
        seat_order_matters=True,
        view_interval_ms=500,
        live_interval_ms=250,
    )


def test_environment_metadata_generation_uses_source_discovery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    output = tmp_path / "generated" / "environments.json"
    discovered = {"example": SimpleNamespace(entry=SimpleNamespace(meta=_meta()))}
    monkeypatch.setattr(generate, "discover_environments", lambda: discovered)
    monkeypatch.setattr(generate, "BACKEND_GENERATED_DIR", output.parent)
    monkeypatch.setattr(generate, "BACKEND_ENVIRONMENTS_JSON", output)

    generate.generate_environments_json()

    assert json.loads(output.read_text(encoding="utf-8")) == [_meta().to_json()]


def test_environment_pyproject_sync_writes_recognized_entries_and_all_packages(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    pyproject = tmp_path / "pyproject.toml"
    pyproject.write_text(
        """[project.entry-points."game_sandbox.environments"]
# BEGIN GENERATED ENTRY POINTS
stale = "stale:ENTRY"
# END GENERATED ENTRY POINTS
[tool.hatch.build.targets.wheel]
# BEGIN GENERATED WHEEL PACKAGES
packages = ["stale"]
# END GENERATED WHEEL PACKAGES
""",
        encoding="utf-8",
    )
    package_dirs = [tmp_path / "alpha", tmp_path / "shared_helpers"]
    monkeypatch.setattr(generate, "ENVIRONMENTS_PYPROJECT", pyproject)
    monkeypatch.setattr(generate, "discover_environments", lambda: {"alpha": object()})
    monkeypatch.setattr(generate, "package_dirs", lambda: package_dirs)

    generate.sync_environments_pyproject()

    text = pyproject.read_text(encoding="utf-8")
    assert 'alpha = "alpha:ENTRY"' in text
    assert "stale:ENTRY" not in text
    assert 'packages = ["alpha", "shared_helpers"]' in text


def test_ignore_patterns_and_template_modules_follow_authoring_conventions(tmp_path: Path):
    ignore = tmp_path / ".envignore"
    ignore.write_text("# shared code\nlocal_play/\nscratch_*\n", encoding="utf-8")
    patterns = _envs._ignore_patterns(ignore)
    assert _envs._is_ignored("local_play", patterns)
    assert _envs._is_ignored("scratch_demo", patterns)
    assert not _envs._is_ignored("hearts", patterns)

    package = tmp_path / "hearts"
    package.mkdir()
    for name in ("__init__.py", "env.py", "environment.md", "UPSTREAM_LICENSE.md"):
        (package / name).write_text("", encoding="utf-8")
    (package / "renderer").mkdir()
    (package / "tests").mkdir()

    spec = _envs._template_spec(package, SimpleNamespace(display_name="Hearts", human_players=()))
    assert set(spec.modules) == {"hearts/UPSTREAM_LICENSE.md", "hearts/env.py"}
    assert spec.player_id == "player_0"


def test_environment_wheel_excludes_canonical_guides_and_keeps_license(tmp_path: Path):
    subprocess.run(
        [
            "uv",
            "build",
            "--package",
            "game-sandbox-environments",
            "--wheel",
            "--out-dir",
            str(tmp_path),
        ],
        check=True,
    )
    wheel = next(tmp_path.glob("*.whl"))
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())

    assert "flappy_bird/UPSTREAM_LICENSE.md" in names
    assert "skirmish_crane/__init__.py" in names
    assert not any(name.endswith("/environment.md") for name in names)


def test_skirmish_crane_is_installable_and_discovered_as_an_environment():
    package_names = {path.name for path in _envs.package_dirs()}
    patterns = _envs._ignore_patterns()
    recognized_names = {path.name for path in _envs.recognized_package_dirs()}
    discovered_names = set(_envs.discover_environments())
    pyproject = (REPO_ROOT / "environments" / "pyproject.toml").read_text(encoding="utf-8")

    assert "skirmish_crane" in package_names
    assert not _envs._is_ignored("skirmish_crane", patterns)
    assert "skirmish_crane" in recognized_names
    assert "skirmish_crane" in discovered_names
    assert 'packages = ["flappy_bird", "hearts", "local_play", "skirmish_crane", "spades"]' in pyproject
    assert 'skirmish_crane = "skirmish_crane:ENTRY"' in pyproject


def test_source_import_replaces_a_cached_package(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    source_root = tmp_path / "src"
    package = source_root / "example"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("VALUE = 'source'\n", encoding="utf-8")
    cached = ModuleType("example")
    cached.__file__ = str(tmp_path / "installed" / "example" / "__init__.py")
    cached.VALUE = "cached"  # type: ignore[attr-defined]
    monkeypatch.setattr(_envs, "ENVIRONMENT_PACKAGES_DIR", source_root)
    monkeypatch.setitem(sys.modules, "example", cached)

    imported = _envs._import_source_package(package)

    assert imported.VALUE == "source"
    assert Path(imported.__file__).resolve() == (package / "__init__.py").resolve()


def test_published_example_declarations_require_valid_immediate_example_directories(tmp_path: Path):
    package = tmp_path / "example"
    (package / "examples" / "known").mkdir(parents=True)

    assert _envs._published_examples(package, SimpleNamespace(PUBLISHED_EXAMPLES=("known",))) == ("known",)
    assert _envs._published_examples(package, SimpleNamespace(PUBLISHED_EXAMPLES=())) == ()

    cases = [
        (SimpleNamespace(), "must export"),
        (SimpleNamespace(PUBLISHED_EXAMPLES=["known"]), "must be a tuple"),
        (SimpleNamespace(PUBLISHED_EXAMPLES=("known", "known")), "duplicate"),
        (SimpleNamespace(PUBLISHED_EXAMPLES=("known/child",)), "immediate"),
        (SimpleNamespace(PUBLISHED_EXAMPLES=("a..b",)), "safe Git branch"),
        (SimpleNamespace(PUBLISHED_EXAMPLES=("a.lock",)), "safe Git branch"),
        (SimpleNamespace(PUBLISHED_EXAMPLES=("trailing.",)), "safe Git branch"),
        (SimpleNamespace(PUBLISHED_EXAMPLES=("missing",)), "has no directory"),
        (SimpleNamespace(PUBLISHED_EXAMPLES=(" ",)), "nonblank"),
    ]
    for module, message in cases:
        with pytest.raises(RuntimeError, match=message):
            _envs._published_examples(package, module)


def test_current_student_surfaces_exclude_retired_card_player_names():
    roots = [
        REPO_ROOT / "templates" / "base",
        REPO_ROOT / "environments" / "hearts" / "template",
        REPO_ROOT / "environments" / "hearts" / "examples",
        REPO_ROOT / "environments" / "spades" / "template",
        REPO_ROOT / "environments" / "spades" / "examples",
        REPO_ROOT / "docs" / "students",
        REPO_ROOT / "docs" / "contributors" / "environments",
        REPO_ROOT / "docs" / "contributors" / "testing" / "browser-e2e.md",
        REPO_ROOT / "environments" / "hearts" / "environment.md",
        REPO_ROOT / "environments" / "spades" / "environment.md",
    ]
    files = [
        path
        for root in roots
        for path in ([root] if root.is_file() else root.rglob("*"))
        if path.is_file() and path.suffix in {".example", ".md", ".py"}
    ]
    retired_names = ("my_seat", "partner_seat", "turn_slot")
    offenders = {
        str(path.relative_to(REPO_ROOT)): name
        for path in files
        for name in retired_names
        if name in path.read_text(encoding="utf-8")
    }
    assert offenders == {}

    code_files = [path for path in files if path.suffix == ".py"]
    retired_observation_keys = ('"seat"', "'seat'")
    key_offenders = {
        str(path.relative_to(REPO_ROOT)): key
        for path in code_files
        for key in retired_observation_keys
        if key in path.read_text(encoding="utf-8")
    }
    assert key_offenders == {}
