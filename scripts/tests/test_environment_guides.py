"""Canonical environment-guide rendering and virtual publishing checks."""

from __future__ import annotations

import sys
from pathlib import Path, PurePosixPath

import pytest
from mkdocs.config.defaults import MkDocsConfig
from mkdocs.structure.files import Files

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import _environment_guides as guides  # noqa: E402
import mkdocs_environment_guides as mkdocs_guides  # noqa: E402
from _environment_guides import (  # noqa: E402
    ENVIRONMENT_CATALOG_MARKER,
    ENVIRONMENT_CATALOG_PATH,
    EnvironmentGuideError,
    discover_environment_guides,
    environment_guide_slug,
    environment_guide_virtual_path,
    render_environment_catalog,
    render_environment_guide,
)
from _envs import discover_environments  # noqa: E402


def _configure_guide_tree(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    sources: dict[str, str],
) -> tuple[Path, Path]:
    docs_dir = tmp_path / "docs"
    pages_dir = docs_dir / "students" / "environments"
    pages_dir.mkdir(parents=True)
    (docs_dir / "students" / "agent-interface.md").write_text(
        "# Agent Interface\n\n## Time limits\n", encoding="utf-8"
    )
    (pages_dir / "index.md").write_text(
        f"# Environments\n\n## Available environments\n\n{ENVIRONMENT_CATALOG_MARKER}\n",
        encoding="utf-8",
    )

    environments_dir = tmp_path / "environments"
    environments_dir.mkdir()
    for env_id, text in sources.items():
        source = environments_dir / env_id / "environment.md"
        source.parent.mkdir()
        source.write_text(text, encoding="utf-8")

    monkeypatch.setattr(guides, "DOCS_DIR", docs_dir)
    monkeypatch.setattr(guides, "ENVIRONMENT_PACKAGES_DIR", environments_dir)
    monkeypatch.setattr(
        guides,
        "env_environment_guide",
        lambda env_id: environments_dir / env_id / "environment.md",
    )
    return docs_dir, environments_dir


@pytest.mark.parametrize("env_id", discover_environments())
def test_real_environment_guides_render_for_docs_and_composed_kits(env_id: str):
    docs_page = render_environment_guide(env_id, "docs_site")
    composed = render_environment_guide(env_id, "composed_kit")
    canonical_path = Path("environments") / env_id / "environment.md"
    canonical = canonical_path.read_text(encoding="utf-8")
    heading = next(line for line in canonical.splitlines() if line.startswith("# "))

    assert heading in docs_page
    assert "](../agent-interface.md" in docs_page
    assert "{{DOCS_URL}}students/agent-interface/" in composed
    assert "](../../docs/" not in docs_page
    assert "](../../docs/" not in composed
    assert not (Path("docs") / "students" / "environments" / f"{environment_guide_slug(env_id)}.md").exists()


def test_discovery_finds_new_guides_without_a_hard_coded_environment_list(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    _configure_guide_tree(
        tmp_path,
        monkeypatch,
        {
            "alpha": "# Alpha\n",
            "new_game": "# New Game\n",
        },
    )

    assert discover_environment_guides() == ["alpha", "new_game"]
    assert environment_guide_virtual_path("new_game") == PurePosixPath("students/environments/new-game.md")
    assert "- [New Game](new-game.md)" in render_environment_catalog(discover_environment_guides())


def test_catalog_renders_every_real_environment_without_hard_coded_rows():
    catalog = render_environment_catalog(discover_environment_guides())
    shell = (Path("docs") / ENVIRONMENT_CATALOG_PATH).read_text(encoding="utf-8")

    assert ENVIRONMENT_CATALOG_MARKER not in catalog
    assert ENVIRONMENT_CATALOG_MARKER in shell
    for env_id in discover_environments():
        guide = render_environment_guide(env_id, "docs_site")
        heading = next(line.removeprefix("# ") for line in guide.splitlines() if line.startswith("# "))
        assert f"- [{heading}]({environment_guide_slug(env_id)}.md)" in catalog
        assert f"({environment_guide_slug(env_id)}.md)" not in shell


@pytest.mark.parametrize("env_id", ["Index", "index", "two__words", "two-words"])
def test_invalid_or_reserved_guide_slugs_fail(env_id: str):
    with pytest.raises(EnvironmentGuideError):
        environment_guide_slug(env_id)


def test_slug_collisions_are_rejected_before_publishing(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(guides, "environment_guide_slug", lambda _: "same")

    with pytest.raises(EnvironmentGuideError, match="both map"):
        guides._environment_ids(["alpha", "beta"])


def test_render_modes_rewrite_docs_links_and_preserve_external_targets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    source = """# Alpha

[limits](../../docs/students/agent-interface.md#time-limits)
[web](https://example.com/page?q=1)
[mail](mailto:teacher@example.com)
[section](#details)
[reference][external]

[external]: https://example.com/reference
"""
    _configure_guide_tree(tmp_path, monkeypatch, {"alpha": source})

    docs_page = render_environment_guide("alpha", "docs_site")
    composed = render_environment_guide("alpha", "composed_kit")

    assert "[limits](../agent-interface.md#time-limits)" in docs_page
    assert "[limits]({{DOCS_URL}}students/agent-interface/#time-limits)" in composed
    for target in (
        "https://example.com/page?q=1",
        "mailto:teacher@example.com",
        "#details",
        "https://example.com/reference",
    ):
        assert target in docs_page
        assert target in composed


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ("[asset](asset.png)", "must target a relative documentation .md file"),
        ("![asset](asset.png)", "local image"),
        ("[query](../../docs/students/agent-interface.md?view=full)", "plain relative .md link"),
        ("[angle](<../../docs/students/agent-interface.md>)", "unsupported local link syntax"),
        ("[license](UPSTREAM_LICENSE.md)", "must resolve inside"),
        (
            "[interface][guide]\n\n[guide]: ../../docs/students/agent-interface.md",
            "local reference-style link",
        ),
        ("[missing](../../docs/students/missing.md)", "does not exist"),
    ],
)
def test_unsupported_or_broken_local_links_fail(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    body: str,
    message: str,
):
    _configure_guide_tree(tmp_path, monkeypatch, {"alpha": f"# Alpha\n\n{body}\n"})

    with pytest.raises(EnvironmentGuideError, match=message):
        render_environment_guide("alpha", "docs_site")


def test_missing_canonical_guide_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _configure_guide_tree(tmp_path, monkeypatch, {})

    with pytest.raises(EnvironmentGuideError, match="no canonical guide"):
        render_environment_guide("missing", "docs_site")


def test_catalog_requires_exactly_one_dynamic_marker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    docs_dir, _ = _configure_guide_tree(tmp_path, monkeypatch, {"alpha": "# Alpha\n"})
    catalog = docs_dir / ENVIRONMENT_CATALOG_PATH
    catalog.write_text("# Environments\n", encoding="utf-8")

    with pytest.raises(EnvironmentGuideError, match="marker exactly once"):
        render_environment_catalog(["alpha"])


def test_mkdocs_hook_adds_pre_rendered_virtual_files_and_dynamic_nav(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    docs_dir, _ = _configure_guide_tree(
        tmp_path,
        monkeypatch,
        {
            "alpha": "# Alpha\n\n[interface](../../docs/students/agent-interface.md)\n",
            "new_game": "# New Game\n",
        },
    )
    config = MkDocsConfig()
    config.load_dict(
        {
            "site_name": "Test",
            "docs_dir": str(docs_dir),
            "site_dir": str(tmp_path / "site"),
            "nav": [
                {
                    "Students": [
                        {
                            "Environments": [
                                "students/environments/index.md",
                            ]
                        }
                    ]
                }
            ],
        }
    )
    errors, _ = config.validate()
    assert not errors
    config["plugins"]._current_plugin = "test-environment-guide-hook"
    files = Files(
        [
            mkdocs_guides.File(
                ENVIRONMENT_CATALOG_PATH.as_posix(),
                str(docs_dir),
                str(tmp_path / "site"),
                True,
            )
        ]
    )

    result = mkdocs_guides.on_files(files, config=config)

    virtual = {file.src_uri: file.content_string for file in result}
    assert virtual == {
        "students/environments/index.md": (
            "# Environments\n\n## Available environments\n\n- [Alpha](alpha.md)\n- [New Game](new-game.md)\n"
        ),
        "students/environments/alpha.md": "# Alpha\n\n[interface](../agent-interface.md)\n",
        "students/environments/new-game.md": "# New Game\n",
    }
    assert config["nav"] == [
        {
            "Students": [
                {
                    "Environments": [
                        "students/environments/index.md",
                        "students/environments/alpha.md",
                        "students/environments/new-game.md",
                    ]
                }
            ]
        }
    ]


def test_mkdocs_hook_rejects_an_on_disk_duplicate_before_mutating_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    docs_dir, _ = _configure_guide_tree(
        tmp_path,
        monkeypatch,
        {"alpha": "# Alpha\n"},
    )
    duplicate = docs_dir / "students" / "environments" / "alpha.md"
    duplicate.write_text("# Duplicate\n", encoding="utf-8")
    config = MkDocsConfig()
    config.load_dict(
        {
            "site_name": "Test",
            "docs_dir": str(docs_dir),
            "site_dir": str(tmp_path / "site"),
            "nav": ["students/environments/index.md"],
        }
    )
    errors, _ = config.validate()
    assert not errors
    files = Files(
        [
            mkdocs_guides.File(
                "students/environments/alpha.md",
                str(docs_dir),
                str(tmp_path / "site"),
                True,
            )
        ]
    )

    with pytest.raises(EnvironmentGuideError, match="collide"):
        mkdocs_guides.on_files(files, config=config)

    assert len(files) == 1
