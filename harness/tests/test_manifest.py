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
    def reset(self, seed):
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
        agent.reset(7)
        assert agent.act(None) == 1
        assert describe_agent_hooks(agent) == {"learn": True, "chat": False}
    finally:
        _cleanup(tmp_path)


def test_same_entry_point_in_two_repo_roots_loads_each_repo(tmp_path: Path):
    repo_a = tmp_path / "a"
    repo_b = tmp_path / "b"
    repo_a.mkdir()
    repo_b.mkdir()
    manifest = {"entry_point": "agent", "class_name": "Agent", "template_version": 1}
    _write_repo(
        repo_a,
        "agent",
        manifest=manifest,
        source="""
class Agent:
    def reset(self, seed):
        pass
    def act(self, observation):
        return "a"
""",
    )
    _write_repo(
        repo_b,
        "agent",
        manifest=manifest,
        source="""
class Agent:
    def reset(self, seed):
        pass
    def act(self, observation):
        return "b"
""",
    )

    try:
        assert load_agent(repo_a).act(None) == "a"
        assert load_agent(repo_b).act(None) == "b"
    finally:
        _cleanup(repo_a)
        _cleanup(repo_b)
        sys.modules.pop("agent", None)


def test_same_helper_module_name_in_two_repo_roots_loads_each_repo_helper(tmp_path: Path):
    repo_a = tmp_path / "a"
    repo_b = tmp_path / "b"
    repo_a.mkdir()
    repo_b.mkdir()
    manifest = {"entry_point": "agent", "class_name": "Agent", "template_version": 1}
    agent_source = """
import helper

class Agent:
    def reset(self, seed):
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
    # The same-submission-in-two-slots path: the SAME code is copied into two per-slot directories,
    # and a multi-slot session loads every slot up front and only then steps them. Loading the second
    # root evicts the first's `agent` module from sys.modules, so this proves each instance keeps its
    # own module-level state afterwards (interleaved acts must not share the module global).
    repo_a = tmp_path / "player_0"
    repo_b = tmp_path / "player_1"
    repo_a.mkdir()
    repo_b.mkdir()
    manifest = {"entry_point": "agent", "class_name": "Agent", "template_version": 1}
    # A module-level counter act() bumps and returns: a shared module would interleave the two seats.
    source = """
calls = 0

class Agent:
    def reset(self, seed):
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
        # Interleave the two seats: independent module state keeps each counter on its own track.
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
    def reset(self, seed):
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


def test_malformed_json_raises(tmp_path: Path):
    (tmp_path / "manifest.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(ManifestError, match="not valid JSON"):
        load_manifest(tmp_path)


def test_missing_field_raises(tmp_path: Path):
    (tmp_path / "manifest.json").write_text(
        json.dumps({"entry_point": "agent", "class_name": "Agent"}), encoding="utf-8"
    )
    with pytest.raises(ManifestError, match="missing required field"):
        load_manifest(tmp_path)


def test_unknown_key_raises(tmp_path: Path):
    (tmp_path / "manifest.json").write_text(
        json.dumps({"entry_point": "agent", "class_name": "Agent", "template_version": 1, "oops": 1}),
        encoding="utf-8",
    )
    with pytest.raises(ManifestError, match="unknown key"):
        load_manifest(tmp_path)


def test_non_integer_version_raises(tmp_path: Path):
    (tmp_path / "manifest.json").write_text(
        json.dumps({"entry_point": "agent", "class_name": "Agent", "template_version": "1"}),
        encoding="utf-8",
    )
    with pytest.raises(ManifestError, match="must be an integer"):
        load_manifest(tmp_path)


def test_bool_version_rejected(tmp_path: Path):
    (tmp_path / "manifest.json").write_text(
        json.dumps({"entry_point": "agent", "class_name": "Agent", "template_version": True}),
        encoding="utf-8",
    )
    with pytest.raises(ManifestError, match="must be an integer"):
        load_manifest(tmp_path)


def test_import_error_raises(tmp_path: Path):
    _write_repo(
        tmp_path,
        "broken_agent",
        manifest={
            "entry_point": "does_not_exist",
            "class_name": "Agent",
            "template_version": 1,
        },
        source="raise RuntimeError('unused')",
    )
    try:
        with pytest.raises(ManifestError, match="could not import entry-point module"):
            load_agent(tmp_path)
    finally:
        _cleanup(tmp_path)


def test_missing_class_raises(tmp_path: Path):
    module = "nomatch_agent"
    _write_repo(
        tmp_path,
        module,
        manifest={"entry_point": module, "class_name": "Missing", "template_version": 1},
        source=_AGENT_SOURCE,
    )
    try:
        with pytest.raises(ManifestError, match="has no class 'Missing'"):
            load_agent(tmp_path)
    finally:
        _cleanup(tmp_path)


def test_class_missing_act_raises(tmp_path: Path):
    module = "noact_agent"
    _write_repo(
        tmp_path,
        module,
        manifest={"entry_point": module, "class_name": "Agent", "template_version": 1},
        source="class Agent:\n    def reset(self, seed):\n        pass\n",
    )
    try:
        with pytest.raises(ManifestError, match="no callable 'act'"):
            load_agent(tmp_path)
    finally:
        _cleanup(tmp_path)
