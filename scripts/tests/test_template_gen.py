"""Generated package pieces written into composed template output."""

from __future__ import annotations

import importlib
import sys
from dataclasses import replace
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
    EnvPreset,
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


@pytest.mark.parametrize("has_overlay_static", [True, False], ids=["static-overlay", "no-static-overlay"])
def test_write_env_package_exports_metadata_and_hooks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, has_overlay_static: bool
):
    source = tmp_path / "source"
    package = source / "example"
    package.mkdir(parents=True)
    env_source = "def make_env(): return 'example'\ndef default_action(env, player): return 7\n"
    (package / "env.py").write_text(env_source, encoding="utf-8")
    overlay_source = "def extract_overlay(env): return {'score': 3}\n"
    if has_overlay_static:
        overlay_source += "def extract_overlay_static(env): return {'width': 10}\n"
    (package / "overlay.py").write_text(overlay_source, encoding="utf-8")
    monkeypatch.setattr(template_gen, "ENVIRONMENT_PACKAGES_DIR", source)
    dest = tmp_path / "sandbox" / "env"
    spec = TemplateEnvironmentSpec(
        "Example",
        "example",
        ("example/env.py", "example/overlay.py"),
        player_id="player_1",
        has_overlay_static=has_overlay_static,
    )
    meta = replace(
        _meta(),
        layout=SeatPlans(
            (
                SeatPlan(
                    "duo",
                    "Duo",
                    (
                        SeatDeclaration((0,), restricted_builtin="naive"),
                        SeatDeclaration((1,)),
                    ),
                ),
            )
        ),
        parameters=(
            EnvParameter(
                name="mode",
                title="Player's mode",
                description="Select one mode.",
                type="choice",
                default="normal",
                choices=(EnvParameterChoice("normal", "Normal"),),
            ),
        ),
        presets=(EnvPreset("starter", "Starter", {}), EnvPreset("faster", "Faster", {"mode": "normal"})),
    )
    template_gen.write_env_package("example", spec, meta, dest)
    template_gen.write_harness(tmp_path / "sandbox" / "harness")
    (tmp_path / "sandbox" / "__init__.py").write_text("", encoding="utf-8")

    assert (dest / "example" / "env.py").read_text(encoding="utf-8") == env_source
    # Keep imports of this generated package local to this test.
    for name in list(sys.modules):
        if name == "sandbox" or name.startswith("sandbox."):
            monkeypatch.delitem(sys.modules, name)
    monkeypatch.syspath_prepend(str(tmp_path))
    try:
        generated = importlib.import_module("sandbox.env")
        assert generated.ENV_ID == "example"
        assert generated.PLAYER_ID == "player_1"
        assert generated.make_env() == "example"
        assert generated.default_action(None, "player_1") == 7
        assert generated.extract_overlay(None) == {"score": 3}
        if has_overlay_static:
            assert generated.extract_overlay_static(None) == {"width": 10}
        else:
            assert generated.extract_overlay_static is None
        actual = generated.META
        expected = {
            "env_id": "example",
            "display_name": "Example",
            "description": "A complete metadata fixture.",
            "stepping": "sequential",
            "human_players": ("player_0", "player_1"),
            "human_timeout_ms": 50,
            "recommended_episode_ticks": 10,
            "pace_interval_ms": None,
            "step_limit_ms": 100,
            "episode_limit_ms": 1000,
            "messaging": True,
            "message_cap": 12,
            "llm": True,
            "renderer": "example",
            "seat_order_matters": True,
            "view_interval_ms": 500,
            "live_interval_ms": 250,
        }
        assert {field: getattr(actual, field) for field in expected} == expected
        assert [(agent.name, agent.label) for agent in actual.builtin_agents] == [("naive", "Naive")]
        (plan,) = actual.layout.plans
        assert (plan.key, plan.title) == ("duo", "Duo")
        assert [(seat.players, seat.restricted_builtin) for seat in plan.seats] == [
            ((0,), "naive"),
            ((1,), None),
        ]
        (parameter,) = actual.parameters
        assert (parameter.name, parameter.title, parameter.default) == ("mode", "Player's mode", "normal")
        assert [(choice.value, choice.label) for choice in parameter.choices] == [("normal", "Normal")]
        assert [(preset.name, preset.title, preset.values) for preset in actual.presets] == [
            ("starter", "Starter", {}),
            ("faster", "Faster", {"mode": "normal"}),
        ]
    finally:
        for name in list(sys.modules):
            if name == "sandbox" or name.startswith("sandbox."):
                del sys.modules[name]


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
    env_module = source / "example" / "cards.py"
    env_module.parent.mkdir(parents=True)
    env_module.write_text("VALUE = 2\n", encoding="utf-8")
    monkeypatch.setattr(template_gen, "ENVIRONMENT_PACKAGES_DIR", source)
    monkeypatch.setattr(template_gen, "TEMPLATE_BASE_MODULES", {"card_utils.py": "local_play/card_utils.py"})
    spec = TemplateEnvironmentSpec(
        "Example", "example", ("example/env.py",), env_sandbox_modules={"cards.py": "example/cards.py"}
    )

    template_gen.write_base_helpers(tmp_path / "sandbox", spec)

    assert (tmp_path / "sandbox" / "card_utils.py").read_text(encoding="utf-8") == "VALUE = 1\n"
    assert (tmp_path / "sandbox" / "cards.py").read_text(encoding="utf-8") == "VALUE = 2\n"
