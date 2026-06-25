"""The PettingZoo AEC environment for four-player Hearts.

This module lifts the pure rules engine in :mod:`hearts.rules` into a PettingZoo
:class:`~pettingzoo.utils.env.AECEnv`, so the harness only ever sees the standard turn-based
agent-cycle interface. It owns no game logic of its own: every legality, transition, and
scoring question is delegated to ``rules``, and this file is purely the observation/action/
reward plumbing around it.

Determinism is fully seed-driven: ``reset(seed=...)`` constructs a ``random.Random(seed)`` and
hands it to :func:`hearts.rules.deal`, so two resets with the same seed produce identical deals
and therefore identical observation, action-mask, and overlay sequences under a fixed policy.

Reward shape (per the AEC contract): rewards are ``0.0`` for every agent during play and become
the per-seat :func:`hearts.rules.leaderboard_scores` for every agent on the terminal step. The
authoritative per-seat penalty/leaderboard display lives in the overlay, not in the rewards.
"""

from __future__ import annotations

import random
from typing import Any

import numpy as np
from gymnasium import spaces
from pettingzoo.utils.env import AECEnv

from . import rules

#: Sentinel action meaning "the player timed out": ``step`` plays ``rules.lowest_legal_card``.
AUTO_ACTION = -1


class IllegalMoveError(ValueError):
    """Raised by :meth:`HeartsEnv.step` when a non-sentinel action is not a legal card."""


def make_env(render_mode: str | None = None) -> HeartsEnv:
    """Return a fresh :class:`HeartsEnv`. The seed arrives later at :meth:`HeartsEnv.reset`."""
    return HeartsEnv(render_mode=render_mode)


class HeartsEnv(AECEnv):
    """Four-player Hearts as a PettingZoo AEC environment over :mod:`hearts.rules`."""

    metadata = {
        "name": "hearts_v0",
        "is_parallelizable": False,
        "render_modes": ["human", "rgb_array"],
    }

    def __init__(self, render_mode: str | None = None) -> None:
        super().__init__()
        self.render_mode = render_mode
        # Local-renderer view options, set by the demo/template before rendering: the seat shown
        # at the bottom of the table, and whether every hand is revealed (spectator/replay).
        self.view_seat = 0
        self.reveal_all = False
        self.possible_agents = [f"player_{i}" for i in range(rules.NUM_PLAYERS)]
        self.agents: list[str] = []
        # Bound in reset(); declared (not None-initialised) so the type stays HeartsState and
        # every access below is free of Optional-narrowing noise. api_test always resets first.
        self.state: rules.HeartsState
        self._renderer: Any = None

        # Build the spaces exactly once so the accessors can return the same object every call
        # (api_test asserts space identity). Every leaf is int8 for api_test's dtype check.
        # The space mirrors observe()'s structure: the seven state leaves nested under
        # "observation" alongside a top-level "action_mask", matching the AEC convention.
        obs_space = spaces.Dict(
            {
                "observation": spaces.Dict(
                    {
                        "hand": spaces.MultiBinary(rules.NUM_CARDS),
                        "trick": spaces.Box(low=-1, high=51, shape=(4,), dtype=np.int8),
                        "led_suit": spaces.Box(low=-1, high=3, shape=(1,), dtype=np.int8),
                        "hearts_broken": spaces.Box(low=0, high=1, shape=(1,), dtype=np.int8),
                        "position": spaces.Box(low=0, high=3, shape=(1,), dtype=np.int8),
                        "trick_leader": spaces.Box(low=0, high=3, shape=(1,), dtype=np.int8),
                        "scores": spaces.Box(low=0, high=26, shape=(4,), dtype=np.int8),
                    }
                ),
                "action_mask": spaces.Box(low=0, high=1, shape=(rules.NUM_CARDS,), dtype=np.int8),
            }
        )
        self.observation_spaces = {agent: obs_space for agent in self.possible_agents}
        self.action_spaces = {
            agent: spaces.Discrete(rules.NUM_CARDS) for agent in self.possible_agents
        }

    def observation_space(self, agent: str) -> spaces.Space:
        return self.observation_spaces[agent]

    def action_space(self, agent: str) -> spaces.Space:
        return self.action_spaces[agent]

    def _seat(self, agent: str) -> int:
        """Return the seat index ``0..3`` for an agent id."""
        return self.possible_agents.index(agent)

    def _agent(self, seat: int) -> str:
        """Return the agent id for a seat index ``0..3``."""
        return self.possible_agents[seat]

    def reset(self, seed: int | None = None, options: dict[str, Any] | None = None) -> None:
        self.state = rules.deal(random.Random(seed))
        self.agents = list(self.possible_agents)
        self.rewards = {agent: 0.0 for agent in self.agents}
        self._cumulative_rewards = {agent: 0.0 for agent in self.agents}
        self.terminations = {agent: False for agent in self.agents}
        self.truncations = {agent: False for agent in self.agents}
        self.infos = {agent: {} for agent in self.agents}
        self.agent_selection = self._agent(self.state.turn)

    def observe(self, agent: str) -> dict[str, Any]:
        seat = self._seat(agent)
        state = self.state

        hand = np.zeros(rules.NUM_CARDS, np.int8)
        for card in state.hands[seat]:
            hand[card] = 1

        trick = np.full(4, -1, np.int8)
        for played_seat, card in state.current_trick:
            trick[played_seat] = card

        led = rules.led_suit(state)
        led_suit = np.array([led if led is not None else -1], np.int8)
        hearts_broken = np.array([1 if state.hearts_broken else 0], np.int8)
        position = np.array([seat], np.int8)
        trick_leader = np.array([state.trick_leader], np.int8)
        scores = np.array(rules.points_taken(state), np.int8)

        action_mask = np.zeros(rules.NUM_CARDS, np.int8)
        for card in rules.legal_moves(state, seat):
            action_mask[card] = 1

        return {
            "observation": {
                "hand": hand,
                "trick": trick,
                "led_suit": led_suit,
                "hearts_broken": hearts_broken,
                "position": position,
                "trick_leader": trick_leader,
                "scores": scores,
            },
            "action_mask": action_mask,
        }

    def step(self, action: Any) -> None:
        if self.terminations[self.agent_selection] or self.truncations[self.agent_selection]:
            return self._was_dead_step(action)

        seat = self._seat(self.agent_selection)
        # The timeout sentinel plays the lowest legal card; any other action is a literal card.
        card = rules.lowest_legal_card(self.state, seat) if action == AUTO_ACTION else int(action)

        if not rules.is_legal(self.state, seat, card):
            raise IllegalMoveError(
                f"{self.agent_selection} cannot play card {card}; "
                f"legal: {rules.legal_moves(self.state, seat)}"
            )

        rules.play(self.state, card)

        if rules.is_terminal(self.state):
            scores = rules.leaderboard_scores(self.state)
            self.rewards = {self._agent(i): float(scores[i]) for i in range(rules.NUM_PLAYERS)}
            self.terminations = {agent: True for agent in self.agents}
        else:
            self.rewards = {agent: 0.0 for agent in self.agents}

        self._cumulative_rewards[self.agent_selection] = 0
        self.agent_selection = self._agent(self.state.turn)
        self._accumulate_rewards()
        self._deads_step_first()

        if self.render_mode == "human":
            self.render()

    def render(self) -> Any:
        if self.render_mode is None:
            return None
        # Lazy-import so env.py imports cleanly even before render.py exists (built in a later
        # step). The renderer is never touched when render_mode is None, so api_test stays
        # free of any pygame dependency.
        from .render import HeartsRenderer

        if self._renderer is None:
            self._renderer = HeartsRenderer(self.render_mode)
        return self._renderer.render(self)

    def close(self) -> None:
        if self._renderer is not None:
            self._renderer.close()
            self._renderer = None
