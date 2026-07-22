"""Focused ownership tests for the Stage 13 template generator additions."""

from __future__ import annotations

import importlib
import inspect
import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import generate  # noqa: E402
from _paths import TemplateEnvironmentSpec  # noqa: E402
from game_sandbox_harness.environment import EnvironmentMeta  # noqa: E402


def _meta() -> EnvironmentMeta:
    return EnvironmentMeta(
        env_id="example",
        display_name="Example",
        description="A complete metadata fixture.",
        min_slots=1,
        max_slots=2,
        human_slots=("player_0", "player_1"),
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


def test_rendered_template_env_exports_full_registry_metadata():
    spec = TemplateEnvironmentSpec("Example", "example", ("example/env.py",))

    rendered = generate._render_sandbox_init("example", spec, _meta())

    assert "from sandbox.harness.environment import EnvironmentMeta" in rendered
    assert "META = EnvironmentMeta(" in rendered
    for field in _meta().to_json():
        assert f'"{field}"' in rendered
    assert '"META",' in rendered
    assert "make_human_controller" not in rendered


def test_generator_does_not_own_the_local_browser_bundle():
    """Publication, not generation, builds and injects the disposable browser bundle."""
    source = inspect.getsource(generate.main)

    assert not hasattr(generate, "build_local_frontend")
    assert not hasattr(generate, "sync_template_web")
    assert "frontend" not in source


def test_base_sync_removes_every_retired_generated_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    source_root = tmp_path / "environment-source"
    source = source_root / "local_play" / "card_utils.py"
    source.parent.mkdir(parents=True)
    source.write_text("VALUE = 1\n", encoding="utf-8")
    sandbox = tmp_path / "template" / "sandbox"
    sandbox.mkdir(parents=True)
    for name in ("hidpi.py", "render_base.py", "render_cards.py", "multiseat_play.py"):
        (sandbox / name).write_text("retired\n", encoding="utf-8")

    monkeypatch.setattr(generate, "ENVIRONMENTS_SRC", source_root)
    monkeypatch.setattr(generate, "TEMPLATE_BASE_MODULES", {"card_utils.py": "local_play/card_utils.py"})
    retired = tuple(path.name for path in sandbox.iterdir())
    monkeypatch.setattr(generate, "RETIRED_TEMPLATE_BASE_PATHS", retired)
    monkeypatch.setattr(generate, "template_sandbox_base", lambda: sandbox)

    generate.sync_template_base()

    assert (sandbox / "card_utils.py").read_text(encoding="utf-8") == "VALUE = 1\n"
    assert not any(
        (sandbox / name).exists()
        for name in ("hidpi.py", "render_base.py", "render_cards.py", "multiseat_play.py")
    )


def test_owned_directory_sync_replaces_stale_contents(tmp_path: Path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "fresh.txt").write_text("fresh\n", encoding="utf-8")
    cache = source / "__pycache__"
    cache.mkdir()
    (cache / "module.cpython-312.pyc").write_bytes(b"bytecode")
    destination = tmp_path / "destination"
    destination.mkdir()
    (destination / "stale.txt").write_text("stale\n", encoding="utf-8")

    generate._replace_owned_directory(source, destination, "test")

    assert (destination / "fresh.txt").read_text(encoding="utf-8") == "fresh\n"
    assert not (destination / "stale.txt").exists()
    assert not (destination / "__pycache__").exists()
    assert not list(destination.rglob("*.pyc"))


def test_synced_template_harness_loads_packaged_schemas_and_local_shim(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    """A template-local harness validates through its copied schemas without starting a browser."""
    sandbox = tmp_path / "sandbox"
    sandbox.mkdir()
    monkeypatch.setattr(generate, "template_sandbox_harness", lambda: sandbox / "harness")
    generate.sync_template_harness()
    shutil.copyfile(generate.template_sandbox_base() / "live_local.py", sandbox / "live_local.py")
    env_dir = sandbox / "env"
    env_dir.mkdir()
    (env_dir / "__init__.py").write_text(
        """from sandbox.harness.environment import EnvironmentMeta

META = EnvironmentMeta(
    env_id=\"example\", display_name=\"Example\", description=\"Test environment.\",
    min_slots=1, max_slots=1, human_slots=(\"player_0\",), human_timeout_ms=None,
    recommended_episode_ticks=1, pace_interval_ms=None, step_limit_ms=None,
    episode_limit_ms=None, messaging=False, message_cap=0, llm=False, renderer=\"example\",
    seat_order_matters=True, view_interval_ms=None, live_interval_ms=None,
)

def make_env():
    raise AssertionError(\"invalid config must not build an environment\")

def default_action(agent, observation):
    return 0

def extract_overlay(environment):
    return {}
""",
        encoding="utf-8",
    )
    for name in [name for name in sys.modules if name == "sandbox" or name.startswith("sandbox.")]:
        monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.syspath_prepend(str(tmp_path))
    importlib.invalidate_caches()

    schema = importlib.import_module("sandbox.harness.schema")
    schema.validate_header({"schema_version": 1, "environment": "example"})
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
