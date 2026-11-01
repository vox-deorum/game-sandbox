"""Manifest parsing and agent loading: a good repo loads and plays; each malformed variant
raises a ManifestError that names the actual problem.

Fixtures are written into tmp_path with a unique entry-point module name per test, so the
``sys.path``/import mechanism the loader shares with the Stage 3 container never collides on
a cached ``agent`` module across tests.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

from game_sandbox_harness.manifest import (
    _LOADED_REPO_ROOTS,
    Manifest,
    ManifestError,
    describe_agent_hooks,
    load_agent,
    load_manifest,
)

_AGENT_SOURCE = """
class Agent:
    def reset(self, seed, observation):
        self.seed = seed
    def act(self, observation):
        return 1
    def learn(self, observation, action, reward, terminated):
        pass
"""


def _write_repo(root: Path, module: str, *, manifest: dict | str | None, source: str) -> Path:
    (root / f"{module}.py").write_text(source, encoding="utf-8")
    if manifest is not None:
        text = manifest if isinstance(manifest, str) else json.dumps(manifest)
        (root / "manifest.json").write_text(text, encoding="utf-8")
    return root


def _cleanup(root: Path) -> None:
    resolved = str(root.resolve())
    sys.path[:] = [p for p in sys.path if p != resolved]
    _LOADED_REPO_ROOTS.discard(root.resolve())


def test_good_repo_loads_and_exposes_hooks(tmp_path: Path):
    module = "good_agent"
    _write_repo(
        tmp_path,
        module,
        manifest={"entry_point": module, "class_name": "Agent", "template_version": 1},
        source=_AGENT_SOURCE,
    )
    try:
        manifest = load_manifest(tmp_path)
        assert manifest == Manifest(entry_point=module, class_name="Agent", template_version=1)
        agent = load_agent(tmp_path)
        agent.reset(7, None)
        assert agent.act(None) == 1
        assert describe_agent_hooks(agent) == {"learn": True, "chat": False}
    finally:
        _cleanup(tmp_path)


def test_loading_repo_keeps_modules_from_its_active_virtualenv(tmp_path: Path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    module = "venv_safe_agent"
    _write_repo(
        repo,
        module,
        manifest={"entry_point": module, "class_name": "Agent", "template_version": 1},
        source="import kept_dependency\n" + _AGENT_SOURCE.replace("return 1", "return kept_dependency.VALUE"),
    )
    interpreter_root = repo / ".venv"
    dependency_path = interpreter_root / "Lib" / "site-packages" / "kept_dependency.py"
    dependency_path.parent.mkdir(parents=True)
    dependency_path.write_text("raise RuntimeError('dependency was reloaded')\n", encoding="utf-8")
    dependency = ModuleType("kept_dependency")
    dependency.__file__ = str(dependency_path)
    dependency.VALUE = 73
    sys.modules[dependency.__name__] = dependency
    monkeypatch.setattr(sys, "prefix", str(interpreter_root))
    monkeypatch.syspath_prepend(str(dependency_path.parent))

    try:
        assert load_agent(repo).act(None) == 73
    finally:
        _cleanup(repo)
        sys.modules.pop(module, None)
        sys.modules.pop(dependency.__name__, None)


def test_same_helper_module_name_in_two_repo_roots_loads_each_repo_helper(tmp_path: Path):
    repo_a = tmp_path / "a"
    repo_b = tmp_path / "b"
    repo_a.mkdir()
    repo_b.mkdir()
    manifest = {"entry_point": "agent", "class_name": "Agent", "template_version": 1}
    agent_source = """
import helper

class Agent:
    def reset(self, seed, observation):
        pass
    def act(self, observation):
        return helper.VALUE
"""
    _write_repo(repo_a, "agent", manifest=manifest, source=agent_source)
    _write_repo(repo_b, "agent", manifest=manifest, source=agent_source)
    (repo_a / "helper.py").write_text('VALUE = "a"\n', encoding="utf-8")
    (repo_b / "helper.py").write_text('VALUE = "b"\n', encoding="utf-8")

    try:
        assert load_agent(repo_a).act(None) == "a"
        assert load_agent(repo_b).act(None) == "b"
    finally:
        _cleanup(repo_a)
        _cleanup(repo_b)
        sys.modules.pop("agent", None)
        sys.modules.pop("helper", None)


def test_two_instances_held_at_once_keep_isolated_module_state(tmp_path: Path):
    # The same-submission-for-two-players path: the SAME code is copied into two per-player directories,
    # and a multiplayer session loads every player up front and only then steps them. Loading the second
    # root evicts the first's `agent` module from sys.modules, so this proves each instance keeps its
    # own module-level state afterwards (interleaved acts must not share the module global).
    repo_a = tmp_path / "player_0"
    repo_b = tmp_path / "player_1"
    repo_a.mkdir()
    repo_b.mkdir()
    manifest = {"entry_point": "agent", "class_name": "Agent", "template_version": 1}
    # A module-level counter act() bumps and returns: a shared module would interleave the two players.
    source = """
calls = 0

class Agent:
    def reset(self, seed, observation):
        pass
    def act(self, observation):
        global calls
        calls += 1
        return calls
"""
    _write_repo(repo_a, "agent", manifest=manifest, source=source)
    _write_repo(repo_b, "agent", manifest=manifest, source=source)

    try:
        agent_a = load_agent(repo_a)
        agent_b = load_agent(repo_b)  # evicts repo_a's `agent` from sys.modules
        # Interleave the two players: independent module state keeps each counter on its own track.
        assert agent_a.act(None) == 1
        assert agent_b.act(None) == 1
        assert agent_a.act(None) == 2
        assert agent_b.act(None) == 2
    finally:
        _cleanup(repo_a)
        _cleanup(repo_b)
        sys.modules.pop("agent", None)


def test_helper_from_a_failed_load_does_not_leak_into_the_next_repo(tmp_path: Path):
    # repo_a's agent imports its helper at module load (caching it), then load fails because the
    # manifest names a class the module doesn't define. The next repo with a same-named helper
    # must still get its own helper, not the one the failed load left in sys.modules.
    repo_a = tmp_path / "a"
    repo_b = tmp_path / "b"
    repo_a.mkdir()
    repo_b.mkdir()
    agent_source = """
import helper

class Agent:
    def reset(self, seed, observation):
        pass
    def act(self, observation):
        return helper.VALUE
"""
    _write_repo(
        repo_a,
        "agent",
        manifest={"entry_point": "agent", "class_name": "Missing", "template_version": 1},
        source=agent_source,
    )
    _write_repo(
        repo_b,
        "agent",
        manifest={"entry_point": "agent", "class_name": "Agent", "template_version": 1},
        source=agent_source,
    )
    (repo_a / "helper.py").write_text('VALUE = "a"\n', encoding="utf-8")
    (repo_b / "helper.py").write_text('VALUE = "b"\n', encoding="utf-8")

    try:
        with pytest.raises(ManifestError, match="has no class"):
            load_agent(repo_a)
        assert load_agent(repo_b).act(None) == "b"
    finally:
        _cleanup(repo_a)
        _cleanup(repo_b)
        sys.modules.pop("agent", None)
        sys.modules.pop("helper", None)


def test_missing_manifest_raises(tmp_path: Path):
    with pytest.raises(ManifestError, match="no manifest.json"):
        load_manifest(tmp_path)


@pytest.mark.parametrize(
    ("contents", "reason"),
    [
        ("{not json", "not valid JSON"),
        ([], "JSON object"),
        ({"class_name": "Agent", "template_version": 1}, "entry_point"),
        ({"entry_point": "agent", "template_version": 1}, "class_name"),
        ({"entry_point": "agent", "class_name": "Agent"}, "template_version"),
        ({"entry_point": "agent", "class_name": "Agent", "template_version": 1, "oops": 1}, "unknown key"),
        ({"entry_point": "agent", "class_name": "Agent", "template_version": "1"}, "integer"),
        ({"entry_point": "agent", "class_name": "Agent", "template_version": True}, "integer"),
        ({"entry_point": "", "class_name": "Agent", "template_version": 1}, "entry_point"),
        ({"entry_point": 1, "class_name": "Agent", "template_version": 1}, "entry_point"),
        ({"entry_point": "agent", "class_name": "", "template_version": 1}, "class_name"),
        ({"entry_point": "agent", "class_name": None, "template_version": 1}, "class_name"),
    ],
)
def test_malformed_json_raises(tmp_path: Path, contents, reason):
    text = contents if isinstance(contents, str) else json.dumps(contents)
    (tmp_path / "manifest.json").write_text(text, encoding="utf-8")
    with pytest.raises(ManifestError, match=reason):
        load_manifest(tmp_path)


@pytest.mark.parametrize(
    ("source", "class_name", "code", "reason"),
    [
        (None, "Agent", "import_error", "could not import"),
        ("raise RuntimeError('import failed')", "Agent", "import_error", "import failed"),
        (_AGENT_SOURCE, "Missing", "class_not_found", "Missing"),
        (
            _AGENT_SOURCE + "\n    def __init__(self):\n        raise ValueError('constructor failed')\n",
            "Agent",
            "constructor_error",
            "constructor failed",
        ),
        (
            _AGENT_SOURCE.replace("def reset(", "def other_reset("),
            "Agent",
            "missing_hook",
            "callable 'reset'",
        ),
        (_AGENT_SOURCE.replace("def act(", "def other_act("), "Agent", "missing_hook", "callable 'act'"),
        (_AGENT_SOURCE + "\n    reset = None\n", "Agent", "missing_hook", "callable 'reset'"),
        (_AGENT_SOURCE + "\n    act = 1\n", "Agent", "missing_hook", "callable 'act'"),
    ],
)
def test_import_error_raises(tmp_path: Path, source, class_name, code, reason):
    module = "missing_loader_module" if source is None else "load_failure_agent"
    _write_repo(
        tmp_path,
        "load_failure_agent",
        manifest={"entry_point": module, "class_name": class_name, "template_version": 1},
        source=source or "",
    )
    try:
        with pytest.raises(ManifestError, match=reason) as raised:
            load_agent(tmp_path)
        assert raised.value.code == code
    finally:
        _cleanup(tmp_path)
        sys.modules.pop(module, None)
