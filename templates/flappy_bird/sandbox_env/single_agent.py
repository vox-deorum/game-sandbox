"""A general-purpose Gymnasium-to-PettingZoo (AEC) compatibility wrapper.

No off-the-shelf converter exists in this direction — Shimmy adapts external suites *to*
Gymnasium/PettingZoo, and PettingZoo's own conversions are AEC<->Parallel — so this small
adapter is in-house by design. It lifts any single-agent ``gymnasium.Env`` into a one-slot
AEC environment, so the harness only ever sees a PettingZoo interface and any future
single-agent game comes in with zero new machinery. The single agent id is ``player_0``,
following the PettingZoo naming convention.

``reset(seed=...)`` forwards the seed to the underlying ``gymnasium.Env.reset``, which is
what makes the wrapped game's own RNG fully determined by the seed: two resets with the same
seed produce identical observation sequences. Everything else — ``step``, ``observe``,
``last``, the space accessors, termination/truncation bookkeeping — is straight delegation.
Conformance is checked by PettingZoo's own ``api_test`` rather than by our assumptions.

This module imports only third-party packages, so it is copied verbatim into the student
template's ``sandbox_env/`` by the generate script.
"""

from __future__ import annotations

from typing import Any

import gymnasium
import numpy as np
from pettingzoo.utils import AgentSelector
from pettingzoo.utils.env import AECEnv

#: The id of the single slot every wrapped single-agent game exposes.
DEFAULT_AGENT_ID = "player_0"


class GymnasiumToAEC(AECEnv):
    """Wrap a single-agent ``gymnasium.Env`` as a one-slot PettingZoo AEC environment."""

    def __init__(
        self,
        gym_env: gymnasium.Env,
        *,
        name: str = "single_agent_v0",
        agent_id: str = DEFAULT_AGENT_ID,
    ) -> None:
        super().__init__()
        self.gym_env = gym_env
        self._agent_id = agent_id
        self.possible_agents = [agent_id]
        self.agents: list[str] = []

        self.observation_spaces = {agent_id: gym_env.observation_space}
        self.action_spaces = {agent_id: gym_env.action_space}

        render_modes = list(gym_env.metadata.get("render_modes", []))
        self.metadata = {
            "name": name,
            "is_parallelizable": False,
            "render_modes": render_modes,
        }
        self._last_obs: Any = None

    def observation_space(self, agent: str) -> Any:
        return self.observation_spaces[agent]

    def action_space(self, agent: str) -> Any:
        return self.action_spaces[agent]

    def reset(self, seed: int | None = None, options: dict[str, Any] | None = None) -> None:
        obs, info = self.gym_env.reset(seed=seed, options=options)
        self._last_obs = obs

        self.agents = list(self.possible_agents)
        self.rewards = {agent: 0.0 for agent in self.agents}
        self._cumulative_rewards = {agent: 0.0 for agent in self.agents}
        self.terminations = {agent: False for agent in self.agents}
        self.truncations = {agent: False for agent in self.agents}
        self.infos = {agent: dict(info) for agent in self.agents}

        self._agent_selector = AgentSelector(self.agents)
        self.agent_selection = self._agent_selector.reset()

    def observe(self, agent: str) -> Any:
        # The wrapped game is single-agent, so every slot observes the same latest frame.
        return np.array(self._last_obs, copy=True)

    def step(self, action: Any) -> None:
        agent = self.agent_selection
        if self.terminations[agent] or self.truncations[agent]:
            self._was_dead_step(action)
            return

        obs, reward, terminated, truncated, info = self.gym_env.step(action)
        self._last_obs = obs

        # Clear this agent's cumulative bucket before accumulating, per the AEC contract.
        self._cumulative_rewards[agent] = 0
        self.rewards[agent] = float(reward)
        self.terminations[agent] = bool(terminated)
        self.truncations[agent] = bool(truncated)
        self.infos[agent] = dict(info)

        self.agent_selection = self._agent_selector.next()
        self._accumulate_rewards()

    def render(self) -> Any:
        return self.gym_env.render()

    def close(self) -> None:
        self.gym_env.close()
