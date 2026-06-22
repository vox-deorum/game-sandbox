"""Agent ABC, structural hook detection, and template/AgentBase interface parity."""

from __future__ import annotations

import importlib.util
import inspect
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
    # Load a template agent.py under a unique module name so it never collides with a repo's
    # own 'agent' module in sys.modules.
    module_name = f"template_agent_stub_{path.parent.name}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Agent


@pytest.mark.parametrize("agent_path", TEMPLATE_AGENTS, ids=lambda p: p.parent.name)
def test_template_stub_and_agentbase_agree_method_for_method(agent_path: Path):
    template_cls = _load_template_agent_class(agent_path)
    for name in ("reset", "act"):
        base_sig = inspect.signature(getattr(AgentBase, name))
        stub_sig = inspect.signature(getattr(template_cls, name))
        assert list(base_sig.parameters) == list(stub_sig.parameters), name
    # The template stub structurally satisfies the agent interface.
    assert is_agent(template_cls())
