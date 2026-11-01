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


class _MetadataStandIn:
    def to_json(self) -> dict[str, object]:
        return {
            "env_id": "example",
            "display_name": "Example",
            "stepping": "sequential",
            "human_timeout_ms": 50,
        }


def test_environment_metadata_generation_uses_source_discovery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    output = tmp_path / "generated" / "environments.json"
    discovered = {"example": SimpleNamespace(entry=SimpleNamespace(meta=_MetadataStandIn()))}
    monkeypatch.setattr(generate, "discover_environments", lambda: discovered)
    monkeypatch.setattr(generate, "BACKEND_GENERATED_DIR", output.parent)
    monkeypatch.setattr(generate, "BACKEND_ENVIRONMENTS_JSON", output)

    generate.generate_environments_json()

    assert json.loads(output.read_text(encoding="utf-8")) == [
        {"env_id": "example", "display_name": "Example", "stepping": "sequential", "human_timeout_ms": 50}
    ]


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
    generation = package / "generation"
    generation.mkdir()
    for name in ("__init__.py", "build.py", "tuning.json"):
        (generation / name).write_text("", encoding="utf-8")
    cache = generation / "__pycache__"
    cache.mkdir()
    (cache / "build.pyc").write_bytes(b"")

    spec = _envs._template_spec(
        package,
        SimpleNamespace(
            meta=SimpleNamespace(display_name="Hearts", human_players=()),
            overlay_static=None,
        ),
    )
    assert set(spec.modules) == {
        "hearts/UPSTREAM_LICENSE.md",
        "hearts/env.py",
        "hearts/generation/__init__.py",
        "hearts/generation/build.py",
        "hearts/generation/tuning.json",
    }
    assert spec.player_id == "player_0"


@pytest.mark.parametrize(
    ("overlay_static", "expected"),
    [(None, False), (lambda _env: {"k": 1}, True)],
)
def test_template_spec_discovers_static_overlay_capability(
    overlay_static: object, expected: bool, tmp_path: Path
):
    package = tmp_path / "example"
    package.mkdir()
    (package / "env.py").write_text("", encoding="utf-8")

    spec = _envs._template_spec(
        package,
        SimpleNamespace(
            meta=SimpleNamespace(display_name="Example", human_players=()),
            overlay_static=overlay_static,
        ),
    )

    assert spec.has_overlay_static is expected


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


def test_preset_examples_must_be_published(tmp_path: Path):
    package = tmp_path / "example"
    meta = SimpleNamespace(
        presets=(
            SimpleNamespace(name="season_1", example=None),
            SimpleNamespace(name="season_2", example="known"),
        )
    )

    _envs._check_preset_examples(package, meta, ("known",))
    with pytest.raises(RuntimeError, match="preset 'season_2' names example 'known'"):
        _envs._check_preset_examples(package, meta, ())
