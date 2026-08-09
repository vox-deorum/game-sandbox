"""Focused behavioural tests for the Days at Three Branches builtin agents."""

from __future__ import annotations

import ast
import json
from pathlib import Path
from sys import stdlib_module_names

from three_branches.env import ThreeBranchesEnv
from three_branches.naive import Agent as Naive
from three_branches.scripted_visitor import Agent as ScriptedVisitor
from three_branches.scripted_visitor import _route_graph


def _village() -> dict:
    return {
        "road": {"points": [{"x": 0.0, "y": 0.0}, {"x": 4.0, "y": 0.0}]},
        "footpaths": [
            {"points": [{"x": 4.0, "y": 0.0}, {"x": 4.0, "y": 2.0}]},
            {"points": [{"x": 4.0, "y": 2.0}, {"x": 4.0, "y": 4.0}]},
        ],
    }


def _observation(
    *,
    tick: int = 1,
    position: tuple[float, float] = (0.0, 0.0),
    heading: float = 0.0,
    moved: float = 0.0,
    seen: list[dict] | None = None,
) -> dict:
    return {
        "self": {"position": {"x": position[0], "y": position[1]}, "heading": heading, "moved": moved},
        "tick": tick,
        "seen": [] if seen is None else seen,
        "village": _village(),
    }


def _npc(character_id: str = "npc_0", position: tuple[float, float] = (2.0, 0.0)) -> dict:
    return {"id": character_id, "position": {"x": position[0], "y": position[1]}}


def test_naive_preserves_heading_and_stands_still() -> None:
    agent = Naive()
    observation = _observation(heading=271.5)

    agent.reset(14, observation)

    assert agent.act(observation) == {"heading": 271.5, "speed": 0.0, "action": 0}


def test_scripted_visitor_builds_a_joined_road_and_footpath_graph() -> None:
    nodes, neighbors = _route_graph(_village())

    assert nodes == [(0.0, 0.0), (4.0, 0.0), (4.0, 2.0), (4.0, 4.0)]
    assert neighbors == [[1], [0, 2], [1, 3], [2]]


def test_scripted_visitor_splits_the_fixture_road_at_footpath_junctions() -> None:
    env = ThreeBranchesEnv(seat_plan="cast_5")
    observations, _infos = env.reset(seed=1)
    nodes, neighbors = _route_graph(observations["player_0"]["village"])
    junction = nodes.index((12.0, 25.0))

    reached = {0}
    frontier = [0]
    while frontier:
        current = frontier.pop()
        for neighbor in neighbors[current]:
            if neighbor not in reached:
                reached.add(neighbor)
                frontier.append(neighbor)

    assert len(neighbors[junction]) == 3
    assert len(reached) == len(nodes)


def test_scripted_visitor_greets_replies_lingers_and_resumes_wandering() -> None:
    agent = ScriptedVisitor()
    first = _observation(seen=[_npc()])
    agent.reset(9, first)

    assert agent.act(first) == {"heading": 0.0, "speed": 0.0, "action": 2}
    greeting = agent.chat([])
    assert greeting[0]["to"] == "player_1"
    assert greeting[0]["text"] in {
        "Good day. How fares the village?",
        "Well met. Is the road ahead clear?",
        "Hello there. What news from Three Branches?",
        "A fine day for walking. How are you?",
    }

    second = _observation(tick=2, seen=[_npc()])
    assert agent.act(second)["speed"] == 0.0
    assert agent.chat([{"from": "player_1", "to": "player_0", "text": "Hello."}]) == [
        {"to": "player_1", "text": "Thank you. I should keep walking."}
    ]
    assert agent.chat([{"from": "player_1", "to": "player_0", "text": "One more thing."}]) == []

    agent.act(_observation(tick=3, seen=[_npc()]))
    agent.act(_observation(tick=4, seen=[_npc()]))
    resumed = agent.act(_observation(tick=5, seen=[_npc()]))

    assert resumed["speed"] == 0.65
    assert resumed["action"] == 0


def test_scripted_visitor_takes_a_seeded_detour_after_two_stalled_walks() -> None:
    agent = ScriptedVisitor()
    first = _observation()
    agent.reset(4, first)

    assert agent.act(first) == {"heading": 0.0, "speed": 0.65, "action": 0}
    assert agent.act(_observation(tick=2, moved=0.0))["heading"] == 0.0
    detour = agent.act(_observation(tick=3, moved=0.0))

    assert detour["speed"] == 0.65
    assert detour["heading"] in {90.0, 270.0}


def test_staged_builtin_copies_and_manifests_match_the_package() -> None:
    root = Path(__file__).resolve().parents[3]
    staged_root = root / "backend/images/session-base/deps-v1/builtin/three_branches"
    for name in ("naive", "scripted_visitor"):
        package = root / "environments/three_branches" / f"{name}.py"
        staged = staged_root / name / "agent.py"
        manifest = json.loads((staged_root / name / "manifest.json").read_text(encoding="utf-8"))

        assert staged.read_bytes() == package.read_bytes()
        assert manifest == {"entry_point": "agent", "class_name": "Agent", "template_version": 1}


def test_source_builtins_import_only_the_standard_library() -> None:
    root = Path(__file__).resolve().parents[3]
    for name in ("naive", "scripted_visitor"):
        source = (root / "environments/three_branches" / f"{name}.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        imported_roots: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported_roots.update(alias.name.partition(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                assert node.level == 0
                if node.module is not None:
                    imported_roots.add(node.module.partition(".")[0])

        assert imported_roots <= stdlib_module_names | {"__future__"}
