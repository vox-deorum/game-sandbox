"""Two-layer template composition, the example overlay, and the merge/conflict rules."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path, PurePosixPath
from types import SimpleNamespace

import pytest

# The dev scripts are run as top-level modules (scripts/ on sys.path), so mirror that here.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from compose import (  # noqa: E402
    ComposeError,
    _localize_docs_links,
    _merge_requirements,
    compose_example,
    compose_template,
    list_envs,
    list_examples,
    list_published_examples,
)


def test_compose_template_has_base_and_env_files():
    out = compose_template("flappy_bird")
    # A base-layer file and an env-layer file both land in the composed template.
    assert (out / "sandbox" / "play.py").exists()  # from templates/base/
    assert (out / "agent.py").exists()  # from the colocated Flappy Bird layer
    assert (out / "sandbox" / "env" / "__init__.py").exists()  # generated during composition
    assert (out / "sandbox" / "card_utils.py").exists()  # generated shared helper


def test_composed_template_ships_relocated_harness_and_local_shim(monkeypatch: pytest.MonkeyPatch, capsys):
    """The composed template imports its copied harness and validates through its packaged schemas."""
    out = compose_template("flappy_bird")
    package = out / "sandbox" / "env" / "flappy_bird"
    assert (package / "game.py").is_file()
    assert (package / "UPSTREAM_LICENSE.md").is_file()
    assert not any((package / name).is_dir() for name in ("assets", "images", "resources"))
    assert (out / "sandbox" / "harness" / "schema_data" / "step-state.schema.json").is_file()
    assert (out / "sandbox" / "harness" / "schema_data" / "recording-header.schema.json").is_file()

    for name in [name for name in sys.modules if name == "sandbox" or name.startswith("sandbox.")]:
        monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.syspath_prepend(str(out))
    importlib.invalidate_caches()

    schema = importlib.import_module("sandbox.harness.schema")
    schema.validate_step(
        {
            "schema_version": 1,
            "tick": 0,
            "agents": {},
            "timing": {"started_at": 1_700_000_000_000, "duration_ms": 0.0},
        }
    )
    live_local = importlib.import_module("sandbox.live_local")
    assert live_local.main(["{}"]) == 2
    assert "live_local: invalid config" in capsys.readouterr().err


def test_env_layer_wins_over_base():
    out = compose_template("flappy_bird")
    # The env layer's README is the Flappy Bird one, not a base placeholder.
    assert "Flappy Bird" in (out / "README.md").read_text(encoding="utf-8")


def test_compose_template_unknown_env_raises():
    with pytest.raises(ComposeError, match="environment template layer"):
        compose_template("does-not-exist")


def test_compose_template_writes_to_requested_output_directory(tmp_path: Path):
    out = compose_template("flappy_bird", out_dir=tmp_path / "kit")

    assert out == tmp_path / "kit"
    assert (out / "sandbox" / "env" / "__init__.py").is_file()


def test_compose_example_writes_directly_to_requested_output_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    import compose as compose_mod

    monkeypatch.setattr(compose_mod, "BUILD_DIR", tmp_path / "default-build")
    default_template = compose_mod.BUILD_DIR / "templates" / "flappy_bird"
    default_template.mkdir(parents=True, exist_ok=True)
    marker = default_template / "keep.txt"
    marker.write_text("unchanged\n", encoding="utf-8")

    requested = compose_mod.BUILD_DIR / "custom" / "example-kit"
    out = compose_example("flappy_bird", "hello", out_dir=requested)

    assert out == requested
    assert (out / "tests" / "test_hello.py").is_file()
    assert marker.read_text(encoding="utf-8") == "unchanged\n"


def test_output_safety_accepts_only_safe_replacement_targets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import compose as compose_mod

    repo = tmp_path / "repo"
    build = repo / "build"
    build.mkdir(parents=True)
    monkeypatch.setattr(compose_mod, "REPO_ROOT", repo)
    monkeypatch.setattr(compose_mod, "BUILD_DIR", build)

    inside_repo = repo / "source"
    inside_repo.mkdir()
    source_marker = inside_repo / "keep.txt"
    source_marker.write_text("keep\n", encoding="utf-8")
    with pytest.raises(ComposeError, match="inside the repository"):
        compose_mod._prepare_output_dir(inside_repo)
    with pytest.raises(ComposeError, match="build root"):
        compose_mod._prepare_output_dir(build)
    with pytest.raises(ComposeError, match="repository root or its ancestor"):
        compose_mod._prepare_output_dir(tmp_path)
    assert source_marker.read_text(encoding="utf-8") == "keep\n"

    build_child = build / "templates" / "example"
    build_child.mkdir(parents=True)
    (build_child / "stale.txt").write_text("stale\n", encoding="utf-8")
    assert compose_mod._prepare_output_dir(build_child) == build_child.resolve()
    assert not any(build_child.iterdir())

    empty_external = tmp_path / "empty-external"
    empty_external.mkdir()
    assert compose_mod._prepare_output_dir(empty_external) == empty_external.resolve()

    nonempty_external = tmp_path / "nonempty-external"
    nonempty_external.mkdir()
    external_marker = nonempty_external / "keep.txt"
    external_marker.write_text("keep\n", encoding="utf-8")
    with pytest.raises(ComposeError, match="non-empty output directory"):
        compose_mod._prepare_output_dir(nonempty_external)
    assert external_marker.read_text(encoding="utf-8") == "keep\n"


def test_composition_ignores_bytecode_in_base_and_overlay(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import compose as compose_mod

    base = tmp_path / "layers" / "base"
    env = tmp_path / "layers" / "env"
    base_cache = base / "__pycache__"
    env_cache = env / "__pycache__"
    base_cache.mkdir(parents=True)
    env_cache.mkdir(parents=True)
    (base / "base.txt").write_text("base\n", encoding="utf-8")
    (base / "loose.pyc").write_bytes(b"bytecode")
    (base_cache / "cached.pyc").write_bytes(b"bytecode")
    (env / "agent.py").write_text("# agent\n", encoding="utf-8")
    (env / "loose.pyo").write_bytes(b"bytecode")
    (env_cache / "cached.pyc").write_bytes(b"bytecode")

    discovered = SimpleNamespace(spec=object(), entry=SimpleNamespace(meta=object()))
    monkeypatch.setattr(compose_mod, "TEMPLATE_BASE_DIR", base)
    monkeypatch.setattr(compose_mod, "env_template_layer", lambda _: env)
    monkeypatch.setattr(compose_mod, "discover_environments", lambda: {"example": discovered})
    monkeypatch.setattr(compose_mod, "write_harness", lambda _: None)
    monkeypatch.setattr(compose_mod, "write_base_helpers", lambda _: None)
    monkeypatch.setattr(compose_mod, "write_env_package", lambda *_: None)
    monkeypatch.setattr(compose_mod, "_copy_environment_page", lambda *_: None)
    monkeypatch.setattr(compose_mod, "_copy_llm_page", lambda _: None)
    monkeypatch.setattr(compose_mod, "_substitute_docs_url", lambda _: None)

    out = compose_mod.compose_template("example", out_dir=tmp_path / "composed")

    assert (out / "base.txt").read_text(encoding="utf-8") == "base\n"
    assert (out / "agent.py").read_text(encoding="utf-8") == "# agent\n"
    assert not list(out.rglob("__pycache__"))
    assert not list(out.rglob("*.py[cod]"))


def test_env_layer_with_requirements_file_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # Build a throwaway colocated env layer that illegally carries a pin file.
    import compose as compose_mod

    base = tmp_path / "templates" / "base"
    base.mkdir(parents=True)
    (base / "play.py").write_text("# base\n", encoding="utf-8")
    env = tmp_path / "environments" / "stray" / "template"
    env.mkdir(parents=True)
    (env / "agent.py").write_text("# env\n", encoding="utf-8")
    (env / "requirements.txt").write_text("attrs==24.2.0\n", encoding="utf-8")

    monkeypatch.setattr(compose_mod, "TEMPLATE_BASE_DIR", base)
    monkeypatch.setattr(compose_mod, "BUILD_DIR", tmp_path / "build")
    monkeypatch.setattr(compose_mod, "env_template_layer", lambda _: env)
    monkeypatch.setattr(compose_mod, "discover_environments", lambda: {"stray": object()})

    with pytest.raises(ComposeError, match="requirements file"):
        compose_mod.compose_template("stray")


def test_compose_ships_environment_page():
    out = compose_template("flappy_bird")
    env_doc = out / "environment.md"
    # The environment's student docs page is copied in as environment.md, so the README can
    # point at a local reference instead of duplicating the observation/action tables.
    assert env_doc.exists()
    text = env_doc.read_text(encoding="utf-8")
    assert "# Flappy Bird" in text
    assert "## Observations" in text


def test_environment_page_cross_doc_links_resolve_to_absolute_urls():
    out = compose_template("flappy_bird")
    text = (out / "environment.md").read_text(encoding="utf-8")
    # The page's ../agent-interface.md link would dangle in a student's clone, so compose rewrites
    # it to an absolute docs-site URL. No relative doc link and no unresolved token may survive.
    assert "](../agent-interface.md" not in text
    assert "{{DOCS_URL}}" not in text
    assert "students/agent-interface/" in text
    assert "students/agent-interface/#time-limits" in text


def test_localize_docs_links_rewrites_only_cross_doc_links():
    page_dir = PurePosixPath("students/environments")
    text = (
        "[interface](../agent-interface.md) "
        "[limits](../agent-interface.md#time-limits) "
        "[peer](hearts.md) "
        "[index](index.md) "
        "[here](#actions) "
        "[wiki](https://example.com/x)"
    )
    out = _localize_docs_links(text, page_dir)
    # Cross-doc links resolve to {{DOCS_URL}} directory URLs, carrying any anchor through.
    assert "[interface]({{DOCS_URL}}students/agent-interface/)" in out
    assert "[limits]({{DOCS_URL}}students/agent-interface/#time-limits)" in out
    assert "[peer]({{DOCS_URL}}students/environments/hearts/)" in out
    # index.md collapses to its directory URL (MkDocs serves it as the directory root).
    assert "[index]({{DOCS_URL}}students/environments/)" in out
    # In-page anchors and external links are left untouched.
    assert "[here](#actions)" in out
    assert "[wiki](https://example.com/x)" in out


def test_example_inherits_environment_page():
    out = compose_example("flappy_bird", "hello")
    # The example is composed on top of the template, so it inherits environment.md too.
    assert (out / "environment.md").exists()


@pytest.mark.parametrize("env", list_envs())
def test_every_template_ships_localized_llm_guide_and_smoke_command(env: str):
    out = compose_template(env)
    guide = (out / "llm.md").read_text(encoding="utf-8")
    readme = (out / "README.md").read_text(encoding="utf-8")
    example = (out / "sandbox" / "llm_example.py").read_text(encoding="utf-8")
    dispatcher = (out / "sandbox" / "__main__.py").read_text(encoding="utf-8")
    dotenv = (out / ".env.example").read_text(encoding="utf-8")

    assert "# Using the LLM API" in guide
    assert "{{DOCS_URL}}" not in guide
    assert "students/agent-interface/#llm-calls" in guide
    assert "[LLM API specification](https://" in guide
    assert "[Using the LLM API](llm.md)" in readme
    assert "python -m sandbox llm" in readme
    assert "python -m sandbox llm [small|medium|large]" in example
    # Compose only owns that the smoke command's surfaces ship together; the dispatcher's exact
    # wiring (probe constant, table formatting) is the dispatcher test's contract, not this one.
    assert '"llm"' in dispatcher
    assert "sandbox.llm_example" in dispatcher
    dotenv_lines = dotenv.splitlines()
    assert "OPENAI_BASE_URL=" in dotenv_lines
    assert "OPENAI_API_KEY=" in dotenv_lines

    documentation = "\n".join(path.read_text(encoding="utf-8") for path in out.rglob("*.md"))
    assert "python -m sandbox.llm_example" not in documentation


def test_oracle_example_composes_with_its_agent_and_failure_tests():
    out = compose_example("hearts", "oracle")
    assert "class Agent" in (out / "agent.py").read_text(encoding="utf-8")
    assert (out / "tests" / "test_oracle.py").exists()
    assert (out / "llm.md").exists()


def test_compose_env_without_canonical_guide_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # A template layer whose environment has no root environment.md cannot compose.
    import compose as compose_mod

    base = tmp_path / "templates" / "base"
    base.mkdir(parents=True)
    (base / "play.py").write_text("# base\n", encoding="utf-8")
    env = tmp_path / "environments" / "stray" / "template"
    env.mkdir(parents=True)
    (env / "agent.py").write_text("# env\n", encoding="utf-8")

    monkeypatch.setattr(compose_mod, "TEMPLATE_BASE_DIR", base)
    monkeypatch.setattr(compose_mod, "BUILD_DIR", tmp_path / "build")
    monkeypatch.setattr(compose_mod, "env_template_layer", lambda _: env)
    monkeypatch.setattr(
        compose_mod,
        "discover_environments",
        lambda: {"stray": SimpleNamespace(spec=object(), entry=SimpleNamespace(meta=object()))},
    )
    monkeypatch.setattr(compose_mod, "write_harness", lambda _: None)
    monkeypatch.setattr(compose_mod, "write_base_helpers", lambda _: None)
    monkeypatch.setattr(compose_mod, "write_env_package", lambda *_: None)

    with pytest.raises(ComposeError, match="no canonical guide"):
        compose_mod.compose_template("stray")


def test_overlay_file_wins_over_template():
    out = compose_example("flappy_bird", "hello")
    # The colocated Flappy Bird hello agent overrides the template placeholder.
    assert "hello" in (out / "agent.py").read_text(encoding="utf-8")
    assert "wcwidth" in (out / "agent.py").read_text(encoding="utf-8")


def test_extra_requirements_are_appended():
    out = compose_example("flappy_bird", "hello")
    composed = (out / "requirements.txt").read_text(encoding="utf-8")
    # A template pin and the example's extra pin both end up in the composed file.
    assert "websockets==" in composed
    assert "flappy-bird-gymnasium" not in composed
    assert "wcwidth==0.2.13" in composed


def test_inherited_and_overlay_tests_coexist():
    out = compose_example("flappy_bird", "hello")
    assert (out / "tests" / "test_agent.py").exists()  # inherited from the base layer
    assert (out / "tests" / "test_hello.py").exists()  # added by the example


def test_merge_appends_non_conflicting_extra():
    merged = _merge_requirements("attrs==24.2.0\n", "wcwidth==0.2.13\n")
    assert "attrs==24.2.0" in merged
    assert "wcwidth==0.2.13" in merged


def test_merge_fails_loudly_on_conflicting_pin():
    with pytest.raises(ComposeError, match="pinned in both"):
        _merge_requirements("attrs==24.2.0\n", "attrs==23.0.0\n")


def test_compose_unknown_example_raises():
    with pytest.raises(ComposeError):
        compose_example("flappy_bird", "does-not-exist")


def test_flappy_bird_is_a_registered_env():
    # Sanity: the worked example env exists, so the tests above compose against real content.
    assert "flappy_bird" in list_envs()
    assert "base" not in list_envs()


def test_published_examples_are_sorted_allowlists_while_source_inventory_stays_complete():
    assert list_published_examples() == []
    assert list_examples() == [
        ("flappy_bird", "hello"),
        ("hearts", "assassin"),
        ("hearts", "closer"),
        ("hearts", "duck"),
        ("hearts", "moonshot"),
        ("hearts", "oracle"),
        ("spades", "counter"),
        ("spades", "daredevil"),
        ("spades", "signaler"),
    ]
