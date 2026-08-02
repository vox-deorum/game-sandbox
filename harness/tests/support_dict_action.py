"""A tiny deterministic AEC env with a Dict action space, and its registry entry.

The fixture is deliberately unregistered and lives here rather than under ``environments/``, so it
stays out of the catalogue and out of the authoring-shape conformance test, which would otherwise
demand a renderer, a thumbnail, a template, an example, and a student guide for it.

It is the composite-action counterpart to the flat ``MaskedEnv`` in ``test_session.py``: one action
is two independent choices, ``kind`` and ``index``, and the mask is an object with the same keys.
``kind`` is pinned to the current phase every turn, which leaves ``index`` free within that phase,
so the cross product of the two sub-masks is exactly the legal move set. That is the factorization
rule the environment contract states, and :meth:`DictActionEnv.legal_actions` is the authority the
tests compare against.

It is sequential on purpose. PettingZoo's ``parallel_api_test`` reduces a mask with ``np.flatnonzero``
before sampling, which is meaningless for an object mask, so a parallel fixture could not be
conformance-tested on the pinned version.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from gymnasium import spaces
from pettingzoo.utils import AgentSelector
from pettingzoo.utils.env import AECEnv

from game_sandbox_harness.environment import (
    BuiltinAgent,
    EnvironmentEntry,
    EnvironmentMeta,
    PlayerBounds,
)

#: The two values of the ``kind`` component: bid during the opening round, then play a card.
BID = 0
PLAY = 1
#: The ``index`` component is shared by both phases. Which subset is legal depends on the phase,
#: which is exactly what pinning ``kind`` decides, so the two components never constrain each other.
INDEX_SIZE = 8
LEGAL_BIDS = (0, 1, 2)
HANDS = {"player_0": (1, 3, 5), "player_1": (0, 2, 4)}
HAND_SIZE = len(HANDS["player_0"])


class DictActionEnv(AECEnv[str, dict[str, Any], dict[str, int]]):
    """Two players bid once each, then play their hands out one card per turn."""

    metadata = {"name": "dict_action_test", "render_modes": [], "is_parallelizable": False}

    def __init__(self) -> None:
        super().__init__()
        self.possible_agents = ["player_0", "player_1"]
        self.render_mode = None
        # Built once so every accessor returns the same object, which api_test asserts. The mask
        # mirrors the observation convention Hearts uses, one binary array per maskable subspace.
        self._observation_space = spaces.Dict(
            {
                "observation": spaces.Dict(
                    {
                        "phase": spaces.Discrete(2),
                        "cards_left": spaces.Discrete(HAND_SIZE + 1),
                    }
                ),
                "action_mask": spaces.Dict(
                    {
                        "kind": spaces.Box(low=0, high=1, shape=(2,), dtype=np.int8),
                        "index": spaces.Box(low=0, high=1, shape=(INDEX_SIZE,), dtype=np.int8),
                    }
                ),
            }
        )
        self._action_space = spaces.Dict({"kind": spaces.Discrete(2), "index": spaces.Discrete(INDEX_SIZE)})

    def observation_space(self, agent: str) -> spaces.Space[Any]:
        return self._observation_space

    def action_space(self, agent: str) -> spaces.Space[Any]:
        return self._action_space

    @property
    def _bidding(self) -> bool:
        return len(self._bids) < len(self.possible_agents)

    def legal_actions(self, agent: str) -> set[tuple[int, int]]:
        """The authoritative legal moves for ``agent``, empty when it is not the one on turn."""
        if agent != self.agent_selection:
            return set()
        if self._bidding:
            return {(BID, bid) for bid in LEGAL_BIDS}
        return {(PLAY, card) for card in self._hands[agent]}

    def reset(self, seed: int | None = None, options: Any = None) -> None:
        self.agents = list(self.possible_agents)
        self._hands = {agent: list(HANDS[agent]) for agent in self.agents}
        self._bids: dict[str, int] = {}
        self.rewards = dict.fromkeys(self.agents, 0.0)
        self._cumulative_rewards = dict.fromkeys(self.agents, 0.0)
        self.terminations = dict.fromkeys(self.agents, False)
        self.truncations = dict.fromkeys(self.agents, False)
        self.infos: dict[str, dict[str, Any]] = {agent: {} for agent in self.agents}
        self._selector = AgentSelector(self.agents)
        self.agent_selection = self._selector.reset()

    def observe(self, agent: str) -> dict[str, Any]:
        # A player not on turn gets an all-zero mask, matching how Hearts publishes one. The AEC
        # loop only reads a player's observation on its own turn, so the acting mask is populated.
        kind_mask = np.zeros(2, np.int8)
        index_mask = np.zeros(INDEX_SIZE, np.int8)
        for kind, index in self.legal_actions(agent):
            kind_mask[kind] = 1
            index_mask[index] = 1
        return {
            "observation": {
                "phase": np.int64(BID if self._bidding else PLAY),
                "cards_left": np.int64(len(self._hands[agent])),
            },
            "action_mask": {"kind": kind_mask, "index": index_mask},
        }

    def step(self, action: Any) -> None:
        agent = self.agent_selection
        if self.terminations[agent] or self.truncations[agent]:
            self._was_dead_step(action)
            return
        move = (int(action["kind"]), int(action["index"]))
        # The environment is the only place the rules live, so a sample the mask should never have
        # produced fails loudly here rather than being absorbed.
        if move not in self.legal_actions(agent):
            raise ValueError(f"{agent} cannot play {move}")

        self._cumulative_rewards[agent] = 0.0
        self.rewards = dict.fromkeys(self.agents, 0.0)
        if move[0] == BID:
            self._bids[agent] = move[1]
        else:
            self._hands[agent].remove(move[1])
            self.rewards[agent] = 1.0
        if not any(self._hands.values()):
            self.terminations = dict.fromkeys(self.agents, True)
        self.agent_selection = self._selector.next()
        self._accumulate_rewards()

    def render(self) -> None:
        return None

    def close(self) -> None:
        return None


def default_action(env: DictActionEnv, player_id: str) -> dict[str, int]:
    """The lowest legal move for the player on turn, as plain Python integers.

    Plain integers on purpose: this is the timeout path, its result is recorded like any other
    move, and it models the authoring style the environment contract recommends.
    """
    kind, index = min(env.legal_actions(player_id))
    return {"kind": kind, "index": index}


def make_entry() -> EnvironmentEntry:
    """The one declaration of the fixture's metadata."""
    meta = EnvironmentMeta(
        env_id="dict_action",
        display_name="Dict action",
        description="A 2-player fake with a Dict action space and a per-key action mask.",
        stepping="sequential",
        builtin_agents=(BuiltinAgent("naive", "Naive agent"),),
        layout=PlayerBounds(2, 2),
        human_players=("player_0", "player_1"),
        human_timeout_ms=None,
        recommended_episode_ticks=2 + 2 * HAND_SIZE,
        pace_interval_ms=None,
        step_limit_ms=1000,
        episode_limit_ms=120_000,
        messaging=False,
        message_cap=None,
        llm=False,
        renderer="dict_action",
        seat_order_matters=True,
    )
    return EnvironmentEntry(
        meta=meta,
        make=lambda _parameters: DictActionEnv(),
        default_action=default_action,
        overlay=None,
    )
