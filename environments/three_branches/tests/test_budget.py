"""Full-day recording and cadence budgets for Days at Three Branches."""

from __future__ import annotations

import json
from pathlib import Path
from time import perf_counter
from typing import Any, Literal

import pytest

from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import resolve_parameters
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import AgentPlayer, run_episode
from three_branches import ENTRY, META
from three_branches.env import ThreeBranchesEnv
from three_branches.naive import Agent as Naive
from three_branches.scripted_visitor import Agent as ScriptedVisitor

_MAX_RECORDING_BYTES = 10 * 1024 * 1024
_CADENCE_SECONDS = 0.250
_GAME_SECONDS = 120.0
_CAST_SIZES = {"cast_5": 5, "cast_10": 10}
SeatPlan = Literal["cast_5", "cast_10"]


def _players(cast_size: int) -> dict[str, AgentPlayer]:
    return {
        f"player_{index}": AgentPlayer(ScriptedVisitor() if index == 0 else Naive())
        for index in range(cast_size + 1)
    }


def _agents(player_ids: list[str]) -> dict[str, Naive | ScriptedVisitor]:
    return {player_id: ScriptedVisitor() if player_id == "player_0" else Naive() for player_id in player_ids}


def _attribution(cast_size: int) -> dict[str, dict[str, str]]:
    return {
        f"player_{index}": {
            "kind": "agent",
            "builtin_name": "scripted_visitor" if index == 0 else "naive",
            "label": "Scripted visitor" if index == 0 else "Naive",
        }
        for index in range(cast_size + 1)
    }


def _run_day(root: Path, seat_plan: SeatPlan) -> Path:
    cast_size = _CAST_SIZES[seat_plan]
    run_episode(
        ENTRY,
        _players(cast_size),
        parameters=resolve_parameters(META, {"seat_plan": seat_plan, "daynight": True}),
        seed=31,
        store=FolderRecordingStore(root),
        recording_id="day",
        clock=ManualClock(),
        player_attribution=_attribution(cast_size),
    )
    return root / "day" / "recording.jsonl"


def _without_timing(path: Path) -> list[dict[str, Any]]:
    frames = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    for frame in frames[1:]:
        frame.pop("timing")
        for agent in frame["agents"].values():
            agent.pop("timing", None)
    return frames


@pytest.mark.parametrize("seat_plan", ("cast_5", "cast_10"))
def test_full_recording_stays_under_budget_and_same_seed_replays_identically(
    tmp_path: Path, seat_plan: SeatPlan
) -> None:
    first = _run_day(tmp_path / "first", seat_plan)
    second = _run_day(tmp_path / "second", seat_plan)
    first_frames = _without_timing(first)
    second_frames = _without_timing(second)

    assert first.stat().st_size < _MAX_RECORDING_BYTES
    assert len(first_frames) == 1201
    assert first_frames == second_frames


def test_cast_10_engine_transitions_and_charged_agent_work_stay_below_the_250ms_cadence() -> None:
    env = ThreeBranchesEnv(seat_plan="cast_10", daynight=True)
    observations, _infos = env.reset(seed=31)
    agents = _agents(env.agents)
    reset_seconds: dict[str, float] = {}
    for player_id, agent in agents.items():
        started = perf_counter()
        agent.reset(31, observations[player_id])
        reset_seconds[player_id] = perf_counter() - started

    agent_seconds: dict[str, list[float]] = {player_id: [] for player_id in env.agents}
    transition_seconds: list[float] = []
    full_tick_seconds: list[float] = []
    while env.agents:
        actions: dict[str, dict[str, float | int]] = {}
        tick_agent_seconds = 0.0
        for player_id in env.agents:
            started = perf_counter()
            actions[player_id] = agents[player_id].act(observations[player_id])
            elapsed = perf_counter() - started
            agent_seconds[player_id].append(elapsed)
            tick_agent_seconds += elapsed
        # An empty inbox still times chat and drains any greeting that act queued on this tick.
        for player_id in env.agents:
            chat = getattr(agents[player_id], "chat", None)
            if chat is None:
                continue
            started = perf_counter()
            chat([])
            elapsed = perf_counter() - started
            agent_seconds[player_id][-1] += elapsed
            tick_agent_seconds += elapsed
        started = perf_counter()
        observations, _rewards, _terminations, _truncations, _infos = env.step(actions)
        transition = perf_counter() - started
        transition_seconds.append(transition)
        full_tick_seconds.append(tick_agent_seconds + transition)

    assert max(max(times) for times in agent_seconds.values()) < _CADENCE_SECONDS
    assert all(
        reset_seconds[player_id] + sum(times) < _GAME_SECONDS for player_id, times in agent_seconds.items()
    )
    assert max(transition_seconds) < _CADENCE_SECONDS
    assert max(full_tick_seconds) < _CADENCE_SECONDS
