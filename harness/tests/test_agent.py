"""Agent ABC, structural hook detection, and template/AgentBase interface parity."""

from __future__ import annotations

import importlib.util
import inspect
import re
import sys
import tempfile
from pathlib import Path
from types import ModuleType

import pytest

from game_sandbox_harness.agent import AgentBase, has_chat, has_learn, is_agent

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from _paths import ENVIRONMENT_PACKAGES_DIR  # noqa: E402
from compose import compose_template  # noqa: E402

# One agent.py stub per environment template layer (environments/<env>/template/agent.py).
TEMPLATE_AGENTS = sorted(ENVIRONMENT_PACKAGES_DIR.glob("*/template/agent.py"))


def test_agentbase_is_abstract():
    with pytest.raises(TypeError):
        AgentBase()  # type: ignore[abstract]


def test_concrete_subclass_satisfies_detection():
    class Concrete(AgentBase):
        def reset(self, seed: int, observation: object) -> None: ...

        def act(self, observation):
            return 0

    agent = Concrete()
    assert is_agent(agent)
    assert not has_learn(agent)
    assert not has_chat(agent)


def test_duck_typed_agent_is_detected_without_inheritance():
    class Plain:
        def reset(self, seed, observation): ...

        def act(self, observation):
            return 0

        def learn(self, observation, action, reward, terminated): ...

    agent = Plain()
    assert is_agent(agent)
    assert has_learn(agent)
    assert not has_chat(agent)


def test_missing_required_method_fails_detection():
    class NoAct:
        def reset(self, seed, observation): ...

    assert not is_agent(NoAct())


def _load_template_agent_module(path: Path) -> ModuleType:
    # Load a template agent.py under a unique module name so it never collides with a repo's own
    # 'agent' module in sys.modules. The template ships a working agent whose top-level
    # ``from sandbox.<name> import ...`` is live, and that helper (``sandbox.cards`` /
    # ``sandbox.features``) in turn imports the shared codec ``sandbox.card_utils`` — which lives in
    # the *base* layer, not the env layer. So the two layers are composed (base then the env overlay,
    # whole-file, exactly like ``scripts/compose.py``) into a throwaway dir, and that dir is put on
    # sys.path for the load so every ``sandbox.*`` import resolves against a real composed template.
    # sys.path and sys.modules are restored afterward so nothing leaks into other tests.
    env = path.parent.parent.name
    module_name = f"template_agent_stub_{env}"
    saved_path = list(sys.path)
    saved_sandbox = {k: v for k, v in sys.modules.items() if k == "sandbox" or k.startswith("sandbox.")}
    for key in saved_sandbox:
        del sys.modules[key]
    with tempfile.TemporaryDirectory(prefix=f"template_stub_{env}_") as temporary_dir:
        composed = compose_template(env, out_dir=Path(temporary_dir) / "template")
        try:
            sys.path.insert(0, str(composed))
            spec = importlib.util.spec_from_file_location(module_name, composed / "agent.py")
            assert spec is not None and spec.loader is not None
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
        finally:
            sys.path[:] = saved_path
            for key in [k for k in sys.modules if k == "sandbox" or k.startswith("sandbox.")]:
                del sys.modules[key]
            sys.modules.update(saved_sandbox)


@pytest.mark.parametrize("agent_path", TEMPLATE_AGENTS, ids=lambda p: p.parent.name)
def test_template_stub_and_agentbase_agree_method_for_method(agent_path: Path):
    template_cls = _load_template_agent_module(agent_path).Agent
    for name in ("reset", "act"):
        base_sig = inspect.signature(getattr(AgentBase, name))
        stub_sig = inspect.signature(getattr(template_cls, name))
        base_parameters = [
            (parameter.name, parameter.kind, parameter.default) for parameter in base_sig.parameters.values()
        ]
        stub_parameters = [
            (parameter.name, parameter.kind, parameter.default) for parameter in stub_sig.parameters.values()
        ]
        assert base_parameters == stub_parameters, name
    # The template stub structurally satisfies the agent interface.
    assert is_agent(template_cls())


def test_three_branches_starter_prioritizes_benches_then_doorways_then_pumps_and_waves(
    monkeypatch: pytest.MonkeyPatch,
):
    path = ENVIRONMENT_PACKAGES_DIR / "three_branches" / "template" / "agent.py"
    module = _load_template_agent_module(path)
    observation = {}
    example = module.Agent()
    example.reset(7, observation)
    heading = 15.0
    here = {"x": 1.0, "y": 1.0}
    bench = {"type": "bench", "cell": {"x": 2, "y": 2}}

    monkeypatch.setattr(module.me, "heading", lambda _observation: heading)
    monkeypatch.setattr(module.props, "usable", lambda _observation: bench)
    assert example.act(observation) == module.action.stand(heading, "use")

    doorway = {"x": 3.0, "y": 4.0}
    monkeypatch.setattr(module.props, "usable", lambda _observation: None)
    monkeypatch.setattr(module.me, "position", lambda _observation: here)
    monkeypatch.setattr(module.me, "home", lambda _observation: "home_1")
    monkeypatch.setattr(module.people, "seen", lambda _observation: ())
    monkeypatch.setattr(module.layout, "doorway", lambda _observation, _home: doorway)
    monkeypatch.setattr(module.layout, "cell_at", lambda _observation, _position: {"x": 1, "y": 1})
    monkeypatch.setattr(module.layout, "ground_at", lambda _observation, _cell: "interior")
    assert example.act(observation) == module.action.walk(
        module.geometry.heading_to(here, doorway), 1.0, "none"
    )

    pump = {"type": "pump", "cell": {"x": 5, "y": 6}}
    monkeypatch.setattr(module.layout, "ground_at", lambda _observation, _cell: "ground")
    monkeypatch.setattr(module.people, "seen", lambda _observation: ({"id": "player_0"},))
    monkeypatch.setattr(module.props, "all", lambda _observation: (pump,))
    assert example.act(observation) == module.action.walk(
        module.geometry.heading_to(here, {"x": 5.5, "y": 6.5}), 1.0, "wave"
    )

    monkeypatch.setattr(module.people, "seen", lambda _observation: ())
    monkeypatch.setattr(module.props, "all", lambda _observation: ())
    assert example.act(observation) == module.action.walk(heading, 0.0, "none")


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
    meta = load_environment(agent_path.parent.parent.name).meta
    if not meta.messaging:
        pytest.skip(f"{agent_path.parent.parent.name} has messaging disabled; chat stub is optional")
    source = agent_path.read_text(encoding="utf-8")
    # Tolerant of the leading comment marker: the stub is documented, live or commented.
    assert re.search(r"def chat\(self, inbox", source), (
        f"{agent_path} enables messaging but does not document a `def chat(self, inbox` stub"
    )
