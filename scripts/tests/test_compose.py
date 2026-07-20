"""Two-layer template composition, the example overlay, and the merge/conflict rules."""

from __future__ import annotations

import sys
from pathlib import Path, PurePosixPath

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
)


def test_compose_template_has_base_and_env_files():
    out = compose_template("flappy_bird")
    # A base-layer file and an env-layer file both land in the composed template.
    assert (out / "sandbox" / "play.py").exists()  # from templates/base/
    assert (out / "agent.py").exists()  # from templates/flappy_bird/
    assert (out / "sandbox" / "env" / "__init__.py").exists()  # generated env sync


def test_env_layer_wins_over_base():
    out = compose_template("flappy_bird")
    # The env layer's README is the Flappy Bird one, not a base placeholder.
    assert "Flappy Bird" in (out / "README.md").read_text(encoding="utf-8")


def test_compose_template_unknown_env_raises():
    with pytest.raises(ComposeError, match="environment template layer"):
        compose_template("does-not-exist")


def test_env_layer_with_requirements_file_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # Build a throwaway templates/ tree with an env layer that illegally carries a pin file.
    import compose as compose_mod

    base = tmp_path / "templates" / "base"
    base.mkdir(parents=True)
    (base / "play.py").write_text("# base\n", encoding="utf-8")
    env = tmp_path / "templates" / "stray"
    env.mkdir(parents=True)
    (env / "agent.py").write_text("# env\n", encoding="utf-8")
    (env / "requirements.txt").write_text("attrs==24.2.0\n", encoding="utf-8")

    monkeypatch.setattr(compose_mod, "TEMPLATES_DIR", tmp_path / "templates")
    monkeypatch.setattr(compose_mod, "TEMPLATE_BASE_DIR", base)
    monkeypatch.setattr(compose_mod, "BUILD_DIR", tmp_path / "build")
    monkeypatch.setattr(compose_mod, "TEMPLATE_ENVIRONMENTS", {"stray": object()})

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


def test_compose_env_without_docs_page_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # A template layer whose environment has no docs/students/environments page cannot compose:
    # there is no source for its environment.md.
    import compose as compose_mod

    base = tmp_path / "templates" / "base"
    base.mkdir(parents=True)
    (base / "play.py").write_text("# base\n", encoding="utf-8")
    env = tmp_path / "templates" / "stray"
    env.mkdir(parents=True)
    (env / "agent.py").write_text("# env\n", encoding="utf-8")

    monkeypatch.setattr(compose_mod, "TEMPLATES_DIR", tmp_path / "templates")
    monkeypatch.setattr(compose_mod, "TEMPLATE_BASE_DIR", base)
    monkeypatch.setattr(compose_mod, "BUILD_DIR", tmp_path / "build")
    monkeypatch.setattr(compose_mod, "TEMPLATE_ENVIRONMENTS", {"stray": object()})

    with pytest.raises(ComposeError, match="student docs page"):
        compose_mod.compose_template("stray")


def test_overlay_file_wins_over_template():
    out = compose_example("flappy_bird", "hello")
    # examples/flappy_bird/hello/agent.py overrides the template placeholder.
    assert "hello" in (out / "agent.py").read_text(encoding="utf-8")
    assert "wcwidth" in (out / "agent.py").read_text(encoding="utf-8")


def test_extra_requirements_are_appended():
    out = compose_example("flappy_bird", "hello")
    composed = (out / "requirements.txt").read_text(encoding="utf-8")
    # A template pin and the example's extra pin both end up in the composed file.
    assert "flappy-bird-gymnasium==0.4.0" in composed
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
