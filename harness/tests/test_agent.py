"""Agent ABC, structural hook detection, and template/AgentBase interface parity."""

from __future__ import annotations

import importlib.util
import inspect
import re
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

from game_sandbox_harness.agent import AgentBase, has_chat, has_learn, is_agent

REPO_ROOT = Path(__file__).resolve().parents[2]
# One agent.py stub per environment template layer (templates/<env>/agent.py); the
# env-agnostic templates/base/ carries no agent stub. Every env stub gets the parity check.
TEMPLATE_AGENTS = sorted(p for p in (REPO_ROOT / "templates").glob("*/agent.py") if p.parent.name != "base")


def test_agentbase_is_abstract():
    with pytest.raises(TypeError):
        AgentBase()  # type: ignore[abstract]


def test_concrete_subclass_satisfies_detection():
    class Concrete(AgentBase):
        def reset(self, seed: int) -> None: ...

        def act(self, observation):
            return 0

    agent = Concrete()
    assert is_agent(agent)
    assert not has_learn(agent)
    assert not has_chat(agent)


def test_duck_typed_agent_is_detected_without_inheritance():
    class Plain:
        def reset(self, seed): ...

        def act(self, observation):
            return 0

        def learn(self, observation, action, reward, terminated): ...

    agent = Plain()
    assert is_agent(agent)
    assert has_learn(agent)
    assert not has_chat(agent)


def test_missing_required_method_fails_detection():
    class NoAct:
        def reset(self, seed): ...

    assert not is_agent(NoAct())


def _load_template_agent_class(path: Path) -> type:
    # Load a template agent.py under a unique module name so it never collides with a repo's own
    # 'agent' module in sys.modules. The template ships a working agent whose top-level
    # ``from sandbox.<name> import ...`` is live, and that helper (``sandbox.cards`` /
    # ``sandbox.features``) in turn imports the shared codec ``sandbox.card_utils`` — which lives in
    # the *base* layer, not the env layer. So the two layers are composed (base then the env overlay,
    # whole-file, exactly like ``scripts/compose.py``) into a throwaway dir, and that dir is put on
    # sys.path for the load so every ``sandbox.*`` import resolves against a real composed template.
    # sys.path and sys.modules are restored afterward so nothing leaks into other tests.
    env = path.parent.name
    module_name = f"template_agent_stub_{env}"
    saved_path = list(sys.path)
    saved_sandbox = {k: v for k, v in sys.modules.items() if k == "sandbox" or k.startswith("sandbox.")}
    for key in saved_sandbox:
        del sys.modules[key]
    composed = tempfile.mkdtemp(prefix=f"template_stub_{env}_")
    try:
        shutil.copytree(REPO_ROOT / "templates" / "base", composed, dirs_exist_ok=True)
        shutil.copytree(REPO_ROOT / "templates" / env, composed, dirs_exist_ok=True)
        sys.path.insert(0, composed)
        spec = importlib.util.spec_from_file_location(module_name, Path(composed) / "agent.py")
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.Agent
    finally:
        sys.path[:] = saved_path
        for key in [k for k in sys.modules if k == "sandbox" or k.startswith("sandbox.")]:
            del sys.modules[key]
        sys.modules.update(saved_sandbox)
        shutil.rmtree(composed, ignore_errors=True)


@pytest.mark.parametrize("agent_path", TEMPLATE_AGENTS, ids=lambda p: p.parent.name)
def test_template_stub_and_agentbase_agree_method_for_method(agent_path: Path):
    template_cls = _load_template_agent_class(agent_path)
    for name in ("reset", "act"):
        base_sig = inspect.signature(getattr(AgentBase, name))
        stub_sig = inspect.signature(getattr(template_cls, name))
        assert list(base_sig.parameters) == list(stub_sig.parameters), name
    # The template stub structurally satisfies the agent interface.
    assert is_agent(template_cls())


@pytest.mark.parametrize("agent_path", TEMPLATE_AGENTS, ids=lambda p: p.parent.name)
def test_messaging_template_documents_the_chat_hook(agent_path: Path):
    """A template whose environment enables messaging must document the ``chat`` hook, so the stub
    can never drift from the shape the harness actually calls. The stub is commented out (like
    ``learn``): declaring it live would make every derived agent register as chatting and pay a timed
    hook call each turn. The functional half (that the documented shapes work against a real Episode)
    lives in test_session_chat.py."""
    load_environment = pytest.importorskip(
        "game_sandbox_harness.environment", reason="environments not installed"
    ).load_environment
    meta = load_environment(agent_path.parent.name).meta
    if not meta.messaging:
        pytest.skip(f"{agent_path.parent.name} has messaging disabled; chat stub is optional")
    source = agent_path.read_text(encoding="utf-8")
    # Tolerant of the leading comment marker: the stub is documented, live or commented.
    assert re.search(r"def chat\(self, inbox", source), (
        f"{agent_path} enables messaging but does not document a `def chat(self, inbox` stub"
    )
