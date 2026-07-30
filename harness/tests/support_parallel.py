"""A tiny deterministic ParallelEnv, and its registry entry, used by the parallel contract tests.

The fixture is deliberately unregistered. It gives the parallel scheduler a stable three-player
game with two different departure paths without adding an environment to the public catalogue.
:func:`make_entry` is the one declaration of its metadata, shared with the registered conformance
suite in ``environments/test_conformance.py``.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from gymnasium import spaces
from pettingzoo.utils.env import ParallelEnv

from game_sandbox_harness.environment import (
    BuiltinAgent,
    EnvironmentEntry,
    EnvironmentMeta,
    PlayerBounds,
    SteppingMode,
)


class ThreePlayerParallelEnv(ParallelEnv[str, dict[str, int], int]):
    """Three players act together, then leave through deterministic terminal states."""

    metadata = {"name": "three_player_parallel_test", "render_modes": []}
    possible_agents = ["player_0", "player_1", "player_2"]

    def __init__(self) -> None:
        self.agents: list[str] = []
        self._tick = 0
        self._joint_action = 0
        self._last_actions: dict[str, int] = {}
        self._observation_spaces = {
            agent: spaces.Dict(
                {
                    "joint_action": spaces.Discrete(7),
                    "tick": spaces.Discrete(4),
                }
            )
            for agent in self.possible_agents
        }
        self._action_spaces = {agent: spaces.Discrete(3) for agent in self.possible_agents}

    def observation_space(self, agent: str) -> spaces.Dict:
        self._require_known_agent(agent)
        return self._observation_spaces[agent]

    def action_space(self, agent: str) -> spaces.Discrete:
        self._require_known_agent(agent)
        return self._action_spaces[agent]

    def reset(
        self, seed: int | None = None, options: dict[str, object] | None = None
    ) -> tuple[dict[str, dict[str, int]], dict[str, dict[str, object]]]:
        self.agents = self.possible_agents[:]
        self._tick = 0
        self._joint_action = 0
        self._last_actions = {}
        return self._observations(self.agents), {agent: {} for agent in self.agents}

    def step(
        self, actions: dict[str, int]
    ) -> tuple[
        dict[str, dict[str, int]],
        dict[str, float],
        dict[str, bool],
        dict[str, bool],
        dict[str, dict[str, object]],
    ]:
        active_agents = self.agents[:]
        if set(actions) != set(active_agents):
            raise ValueError("parallel steps require one action for every active player")
        for agent, action in actions.items():
            if not self.action_space(agent).contains(action):
                raise ValueError(f"invalid action for {agent!r}: {action!r}")

        self._tick += 1
        self._last_actions = dict(actions)
        self._joint_action = sum(actions.values())
        terminations = {agent: self._tick == 1 and agent == "player_0" for agent in active_agents}
        truncations = {agent: self._tick == 2 and agent == "player_1" for agent in active_agents}
        if self._tick == 3:
            terminations = {agent: True for agent in active_agents}
        rewards = {agent: float(self._joint_action) for agent in active_agents}
        infos = {agent: {"joint_action": self._joint_action} for agent in active_agents}
        self.agents = [agent for agent in active_agents if not terminations[agent] and not truncations[agent]]
        return self._observations(active_agents), rewards, terminations, truncations, infos

    def overlay(self) -> dict[str, Any]:
        """Return the JSON-safe fixture state that a parallel renderer would consume."""
        return {
            "active_players": self.agents[:],
            "joint_action": self._joint_action,
            "last_actions": dict(sorted(self._last_actions.items())),
            "tick": self._tick,
        }

    def chat_policy(self, sender: str) -> dict[str, object]:
        """Allow direct messages only to other currently active players."""
        if sender not in self.agents:
            raise ValueError(f"inactive player {sender!r} cannot send chat")
        recipients = [agent for agent in self.agents if agent != sender]
        return {
            "target_recipients": recipients,
            "default_recipient": recipients[0] if recipients else None,
        }

    def _observations(self, agents: list[str]) -> dict[str, dict[str, int]]:
        return {agent: {"joint_action": self._joint_action, "tick": self._tick} for agent in agents}

    def _require_known_agent(self, agent: str) -> None:
        if agent not in self.possible_agents:
            raise ValueError(f"unknown player {agent!r}")


def default_action(env: ThreePlayerParallelEnv, player_id: str) -> int:
    """Return the stable legal timeout action for an active fixture player."""
    if player_id not in env.agents:
        raise ValueError(f"inactive player {player_id!r} has no default action")
    return 0


def extract_overlay(env: ThreePlayerParallelEnv) -> dict[str, Any]:
    """Expose the fixture overlay with the same hook shape as an EnvironmentEntry."""
    return env.overlay()


def make_entry(
    make: Callable[[], object] = ThreePlayerParallelEnv,
    *,
    stepping: SteppingMode = "simultaneous",
    messaging: bool = False,
) -> EnvironmentEntry:
    """Build the fixture's registry entry, so every contract suite declares it once.

    ``make`` substitutes a differently shaped object and ``stepping`` mislabels the declaration, which
    is how the contract tests drive both mismatch directions.
    """
    return EnvironmentEntry(
        meta=EnvironmentMeta(
            env_id="three_player_parallel_test",
            display_name="Parallel test fixture",
            description="An internal deterministic parallel fixture.",
            stepping=stepping,
            builtin_agents=(BuiltinAgent("naive", "Naive agent"),),
            layout=PlayerBounds(3, 3),
            human_players=("player_0", "player_1", "player_2"),
            human_timeout_ms=None,
            recommended_episode_ticks=3,
            pace_interval_ms=50,
            step_limit_ms=1000,
            episode_limit_ms=120_000,
            messaging=messaging,
            message_cap=None,
            llm=False,
            renderer="parallel-test",
        ),
        make=lambda _parameters: make(),
        default_action=default_action,
        overlay=extract_overlay,
    )
