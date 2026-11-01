"""Agent ABC, structural hook detection, and template/AgentBase interface parity."""

from __future__ import annotations

import importlib.util
import inspect
import sys
import tempfile
from pathlib import Path
from types import ModuleType, SimpleNamespace

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


@pytest.mark.parametrize(
    ("hooks", "expected"),
    [
        ({}, (False, False, False)),
        ({"reset": print}, (False, False, False)),
        ({"act": print}, (False, False, False)),
        ({"reset": 1, "act": print}, (False, False, False)),
        ({"reset": print, "act": 1}, (False, False, False)),
        ({"reset": print, "act": print}, (True, False, False)),
        ({"reset": print, "act": print, "learn": print}, (True, True, False)),
        ({"reset": print, "act": print, "chat": print}, (True, False, True)),
        ({"reset": print, "act": print, "learn": print, "chat": print}, (True, True, True)),
        ({"reset": print, "act": print, "learn": 1, "chat": 1}, (True, False, False)),
    ],
)
def test_concrete_subclass_satisfies_detection(hooks, expected):
    class Concrete(AgentBase):
        def reset(self, seed: int, observation: object) -> None: ...

        def act(self, observation):
            return 0

    inherited = Concrete()
    assert is_agent(inherited)
    assert not has_learn(inherited)
    assert not has_chat(inherited)
    agent = SimpleNamespace(**hooks)
    assert (is_agent(agent), has_learn(agent), has_chat(agent)) == expected


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
    for cls in (AgentBase, template_cls):
        for name, expected in (("reset", ["self", "seed", "observation"]), ("act", ["self", "observation"])):
            parameters = list(inspect.signature(getattr(cls, name)).parameters.values())
            assert [parameter.name for parameter in parameters] == expected
            assert all(parameter.kind == inspect.Parameter.POSITIONAL_OR_KEYWORD for parameter in parameters)
            assert all(parameter.default == inspect.Parameter.empty for parameter in parameters)
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
    assert example.act(observation) == {"heading": 15.0, "speed": 0.0, "action": 1}

    doorway = {"x": 3.0, "y": 1.0}
    monkeypatch.setattr(module.props, "usable", lambda _observation: None)
    monkeypatch.setattr(module.me, "position", lambda _observation: here)
    monkeypatch.setattr(module.me, "home", lambda _observation: "home_1")
    monkeypatch.setattr(module.people, "seen", lambda _observation: ())
    monkeypatch.setattr(module.layout, "doorway", lambda _observation, _home: doorway)
    monkeypatch.setattr(module.layout, "cell_at", lambda _observation, _position: {"x": 1, "y": 1})
    monkeypatch.setattr(module.layout, "ground_at", lambda _observation, _cell: "interior")
    assert example.act(observation) == {"heading": 0.0, "speed": 1.0, "action": 0}

    pump = {"type": "pump", "cell": {"x": 5, "y": 6}}
    monkeypatch.setattr(module.layout, "ground_at", lambda _observation, _cell: "ground")
    monkeypatch.setattr(module.people, "seen", lambda _observation: ({"id": "player_0"},))
    monkeypatch.setattr(module.props, "all", lambda _observation: (pump,))
    monkeypatch.setattr(module.layout, "cell_center", lambda _observation, _cell: {"x": 1.0, "y": 6.5})
    assert example.act(observation) == {"heading": 90.0, "speed": 1.0, "action": 2}

    monkeypatch.setattr(module.people, "seen", lambda _observation: ())
    monkeypatch.setattr(module.props, "all", lambda _observation: ())
    assert example.act(observation) == {"heading": 15.0, "speed": 0.0, "action": 0}
