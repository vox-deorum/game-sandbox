"""Generated package pieces written into composed template output."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import _template_gen as template_gen  # noqa: E402
from _paths import TemplateEnvironmentSpec  # noqa: E402
from game_sandbox_harness.environment import (  # noqa: E402
    BuiltinAgent,
    EnvironmentMeta,
    EnvParameter,
    EnvParameterChoice,
    PlayerBounds,
    SeatDeclaration,
    SeatPlan,
    SeatPlans,
)


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


def test_write_env_package_copies_modules_and_renders_uniform_inits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    source = tmp_path / "source"
    package = source / "example"
    package.mkdir(parents=True)
    (package / "env.py").write_text("VALUE = 1\n", encoding="utf-8")
    (package / "overlay.py").write_text("VALUE = 2\n", encoding="utf-8")
    monkeypatch.setattr(template_gen, "ENVIRONMENT_PACKAGES_DIR", source)
    dest = tmp_path / "sandbox" / "env"
    spec = TemplateEnvironmentSpec("Example", "example", ("example/env.py", "example/overlay.py"))

    template_gen.write_env_package("example", spec, _meta(), dest)

    assert (dest / "example" / "env.py").read_text(encoding="utf-8") == "VALUE = 1\n"
    rendered = (dest / "__init__.py").read_text(encoding="utf-8")
    assert "from sandbox.harness.environment import (" in rendered
    for name in (
        "BuiltinAgent",
        "EnvParameter",
        "EnvParameterChoice",
        "EnvironmentMeta",
        "PlayerBounds",
        "SeatDeclaration",
    ):
        assert f"    {name}," in rendered
    assert "META = EnvironmentMeta(" in rendered
    assert '"layout": PlayerBounds(min=1, max=2),' in rendered
    assert "\"builtin_agents\": (BuiltinAgent(name='naive', label='Naive'),)," in rendered
    for field in _meta().to_json():
        assert f'"{field}"' in rendered
    assert 'PLAYER_ID = "player_0"' in rendered
    assert '"PLAYER_ID",' in rendered
    assert '"META",' in rendered
    assert rendered.startswith("# GAME-SANDBOX-GENERATED-ENV: scripts/compose.py\n")


def test_rendered_metadata_constructs_declared_seats() -> None:
    meta = EnvironmentMeta(
        **{
            **_meta().__dict__,
            "layout": SeatPlans(
                (
                    SeatPlan(
                        key="duo",
                        title="Duo",
                        seats=(
                            SeatDeclaration(players=(0,), restricted_builtin="naive"),
                            SeatDeclaration((1,)),
                        ),
                    ),
                )
            ),
        }
    )
    spec = TemplateEnvironmentSpec("Example", "example", ("example/env.py",))

    rendered = template_gen._render_sandbox_init("example", spec, meta)

    assert "SeatDeclaration(players=(0,), restricted_builtin='naive')" in rendered
    assert "SeatDeclaration(players=(1,), restricted_builtin=None)" in rendered


def test_render_parameters_uses_evaluable_dataclass_representation() -> None:
    parameters = (
        EnvParameter(
            name="mode",
            title="Player's mode",
            description="Select one mode.",
            type="choice",
            default="normal",
            choices=(EnvParameterChoice(value="normal", label="Normal"),),
        ),
    )

    rendered = template_gen._render_parameters(parameters)

    assert rendered == repr(parameters)
    assert (
        eval(  # noqa: S307 - the generator output is built only from validated dataclass values
            rendered,
            {"EnvParameter": EnvParameter, "EnvParameterChoice": EnvParameterChoice},
        )
        == parameters
    )


def test_write_harness_replaces_existing_contents_and_skips_caches(tmp_path: Path):
    destination = tmp_path / "sandbox" / "harness"
    destination.mkdir(parents=True)
    (destination / "stale.txt").write_text("stale\n", encoding="utf-8")

    template_gen.write_harness(destination)

    assert (destination / "schema.py").is_file()
    assert (destination / "schema_data" / "step-state.schema.json").is_file()
    assert not (destination / "stale.txt").exists()
    assert not list(destination.rglob("*.pyc"))


def test_write_base_helpers_copies_canonical_sources(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    source = tmp_path / "source"
    helper = source / "local_play" / "card_utils.py"
    helper.parent.mkdir(parents=True)
    helper.write_text("VALUE = 1\n", encoding="utf-8")
    monkeypatch.setattr(template_gen, "ENVIRONMENT_PACKAGES_DIR", source)
    monkeypatch.setattr(template_gen, "TEMPLATE_BASE_MODULES", {"card_utils.py": "local_play/card_utils.py"})

    template_gen.write_base_helpers(tmp_path / "sandbox")

    assert (tmp_path / "sandbox" / "card_utils.py").read_text(encoding="utf-8") == "VALUE = 1\n"
