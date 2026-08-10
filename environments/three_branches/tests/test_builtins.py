"""Focused behavioural tests for the Days at Three Branches builtin agents."""

from __future__ import annotations

import ast
import json
import math
from pathlib import Path
from sys import stdlib_module_names

import pytest

from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import resolve_parameters
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import AgentPlayer, run_episode
from three_branches import ENTRY, META
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
    character_id: str = "npc_0",
    tick: int = 1,
    position: tuple[float, float] = (0.0, 0.0),
    heading: float = 0.0,
    moved: float = 0.0,
    seen: list[dict] | None = None,
) -> dict:
    return {
        "self": {
            "id": character_id,
            "position": {"x": position[0], "y": position[1]},
            "heading": heading,
            "moved": moved,
        },
        "tick": tick,
        "seen": [] if seen is None else seen,
        "village": _village(),
    }


def _npc(character_id: str = "npc_0", position: tuple[float, float] = (2.0, 0.0)) -> dict:
    return {"id": character_id, "position": {"x": position[0], "y": position[1]}}


def test_naive_starts_along_its_heading_then_takes_a_seeded_random_walk() -> None:
    first = _observation(heading=271.5)
    left, right = Naive(), Naive()
    left.reset(14, first)
    right.reset(14, first)

    left_actions = [left.act(_observation(tick=tick, heading=271.5, moved=0.6)) for tick in range(1, 80)]
    right_actions = [right.act(_observation(tick=tick, heading=271.5, moved=0.6)) for tick in range(1, 80)]

    assert left_actions == right_actions
    assert left_actions[0] == {"heading": 271.5, "speed": 0.6, "action": 0}
    assert all(action["heading"] == 271.5 for action in left_actions[:14])
    assert any(action["heading"] != 271.5 for action in left_actions[14:])
    assert all(action["action"] == 0 for action in left_actions)


def test_naive_turns_after_two_stalled_walks() -> None:
    agent = Naive()
    first = _observation(heading=90.0)
    agent.reset(8, first)

    assert agent.act(first)["heading"] == 90.0
    assert agent.act(_observation(tick=2, heading=90.0, moved=0.0))["heading"] == 90.0
    recovered = agent.act(_observation(tick=3, heading=90.0, moved=0.0))

    assert recovered["speed"] == 0.6
    assert recovered["action"] == 0
    assert recovered["heading"] != 90.0


def test_naive_walks_with_valid_finite_orders_in_the_real_environment() -> None:
    env = ThreeBranchesEnv(seat_plan="cast_5")
    observations, _infos = env.reset(seed=14)
    agents = {player_id: Naive() for player_id in env.agents}
    for player_id, agent in agents.items():
        agent.reset(14, observations[player_id])

    initial_headings = {character_id: state.heading for character_id, state in env.day.characters.items()}
    moved = False
    turned = False
    for _ in range(80):
        actions = {player_id: agent.act(observations[player_id]) for player_id, agent in agents.items()}
        assert all(env.action_space(player_id).contains(action) for player_id, action in actions.items())
        observations, _rewards, _terminations, _truncations, _infos = env.step(actions)
        moved = moved or any(state.moved > 0.0 for state in env.day.characters.values())
        turned = turned or any(
            state.heading != initial_headings[character_id]
            for character_id, state in env.day.characters.items()
        )
        assert all(math.isfinite(value) for state in env.day.characters.values() for value in state.position)

    assert moved
    assert turned


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


@pytest.mark.parametrize(("seed", "ticks"), ((14, 127), (22, 107), (23, 107), (25, 109)))
def test_scripted_visitor_keeps_a_finite_position_after_leaving_a_conversation(seed: int, ticks: int) -> None:
    """Exercise the movement sequence that used to turn the visitor position into NaN."""
    env = ThreeBranchesEnv(seat_plan="cast_5")
    observations, _infos = env.reset(seed=seed)
    agents = {
        player_id: ScriptedVisitor() if player_id == "player_0" else Naive() for player_id in env.agents
    }
    for player_id, agent in agents.items():
        agent.reset(seed, observations[player_id])

    for _ in range(ticks):
        actions = {player_id: agent.act(observations[player_id]) for player_id, agent in agents.items()}
        observations, _rewards, _terminations, _truncations, _infos = env.step(actions)
        assert all(math.isfinite(value) for value in env.day.characters["visitor"].position)


def test_scripted_visitor_records_an_opening_canned_line_for_seed_22(tmp_path: Path) -> None:
    """Pin the earliest fixture-village greeting through the real recording path."""
    players = {
        f"player_{index}": AgentPlayer(ScriptedVisitor() if index == 0 else Naive()) for index in range(6)
    }
    attributions = {
        player_id: {
            "kind": "agent",
            "builtin_name": "scripted_visitor" if player_id == "player_0" else "naive",
            "label": "Scripted visitor" if player_id == "player_0" else "Naive",
        }
        for player_id in players
    }
    recording_id = "opening-chat"
    run_episode(
        ENTRY,
        players,
        parameters=resolve_parameters(META, {"seat_plan": "cast_5", "daynight": False}),
        seed=22,
        store=FolderRecordingStore(tmp_path),
        recording_id=recording_id,
        clock=ManualClock(),
        max_steps=106,
        player_attribution=attributions,
    )

    states = [
        json.loads(line)
        for line in (tmp_path / recording_id / "recording.jsonl").read_text(encoding="utf-8").splitlines()[1:]
    ]
    assert states[105]["messages"] == [
        {"from": "player_0", "to": "player_2", "text": "A fine day for walking. How are you?"}
    ]


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
