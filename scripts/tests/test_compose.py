"""Two-layer template composition, the example overlay, and the merge/conflict rules."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# The dev scripts are run as top-level modules (scripts/ on sys.path), so mirror that here.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from compose import (  # noqa: E402
    ComposeError,
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

    with pytest.raises(ComposeError, match="requirements file"):
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
