"""The PettingZoo AEC environment for four-player partnership Spades.

This module lifts the pure rules engine in :mod:`spades.rules` into a PettingZoo
:class:`~pettingzoo.utils.env.AECEnv`, so the harness only ever sees the standard turn-based
agent-cycle interface. It owns no game logic of its own: every legality, transition, and scoring
question is delegated to ``rules``, and this file is purely the observation/action/reward plumbing
around it.

One combined ``Discrete(66)`` action space covers both phases of the hand: actions ``0..51`` are
cards and action ``52 + k`` is a bid of ``k``. The per-step action mask selects the phase-legal
subset (only bids during the bidding round, only cards during play), so the agent interface is a
single integer everywhere, and the on-turn seat's observation carries the mask the renderers grey
from.

Determinism is fully seed-driven: ``reset(seed=...)`` constructs a ``random.Random(seed)`` and
hands it to :func:`spades.rules.deal`, so two resets with the same seed produce identical deals and
therefore identical observation, action-mask, and overlay sequences under a fixed policy.

Reward shape (per the AEC contract): rewards are ``0.0`` for every agent during the hand and become
the per-seat :func:`spades.rules.leaderboard_scores` (each seat's team hand score, so partners
share) for every agent on the terminal step. The authoritative per-seat display lives in the
overlay, not in the rewards.
"""

from __future__ import annotations

import random
from typing import Any

import numpy as np
from gymnasium import spaces
from pettingzoo.utils.env import AECEnv

from . import rules

#: Sentinel action meaning "the player timed out": ``step`` resolves it against the live state to a
#: never-nil suggested bid during bidding, or the lowest legal card during play.
AUTO_ACTION = -1


class IllegalMoveError(ValueError):
    """Raised by :meth:`SpadesEnv.step` when a non-sentinel action is not legal in the phase."""


def make_env(render_mode: str | None = None) -> SpadesEnv:
    """Return a fresh :class:`SpadesEnv`. The seed arrives later at :meth:`SpadesEnv.reset`."""
    return SpadesEnv(render_mode=render_mode)


class SpadesEnv(AECEnv):
    """Four-player partnership Spades as a PettingZoo AEC environment over :mod:`spades.rules`."""

    metadata = {
        "name": "spades_v0",
        "is_parallelizable": False,
        "render_modes": ["human", "rgb_array"],
    }

    def __init__(self, render_mode: str | None = None) -> None:
        super().__init__()
        self.render_mode = render_mode
        # Local-renderer view options, set by the demo/template before rendering: the seat shown at
        # the bottom of the table, and whether every hand is revealed (spectator/replay).
        self.view_seat = 0
        self.reveal_all = False
        self.possible_agents = [f"player_{i}" for i in range(rules.NUM_PLAYERS)]
        self.agents: list[str] = []
        # Bound in reset(); declared (not None-initialised) so the type stays SpadesState and every
        # access below is free of Optional-narrowing noise. api_test always resets first.
        self.state: rules.SpadesState
        self._renderer: Any = None

        # Build the spaces exactly once so the accessors can return the same object every call
        # (api_test asserts space identity). Every leaf is int8 for api_test's dtype check. The
        # space mirrors observe()'s structure: the state leaves nested under "observation" alongside
        # a top-level "action_mask", matching the AEC convention. There is no score leaf; the score
        # lives in the overlay, not the observation.
        obs_space = spaces.Dict(
            {
                "observation": spaces.Dict(
                    {
                        "hand": spaces.MultiBinary(rules.NUM_CARDS),
                        "phase": spaces.Box(low=0, high=1, shape=(1,), dtype=np.int8),
                        "bids": spaces.Box(low=-1, high=rules.HAND_SIZE, shape=(4,), dtype=np.int8),
                        "trick": spaces.Box(low=-1, high=51, shape=(4,), dtype=np.int8),
                        "last_trick": spaces.Box(low=-1, high=51, shape=(4,), dtype=np.int8),
                        "last_trick_winner": spaces.Box(low=-1, high=3, shape=(1,), dtype=np.int8),
                        "led_suit": spaces.Box(low=-1, high=3, shape=(1,), dtype=np.int8),
                        "spades_broken": spaces.Box(low=0, high=1, shape=(1,), dtype=np.int8),
                        "position": spaces.Box(low=0, high=3, shape=(1,), dtype=np.int8),
                        "trick_leader": spaces.Box(low=0, high=3, shape=(1,), dtype=np.int8),
                        "tricks_won": spaces.Box(low=0, high=rules.NUM_TRICKS, shape=(4,), dtype=np.int8),
                    }
                ),
                "action_mask": spaces.Box(low=0, high=1, shape=(rules.ACTION_SPACE_SIZE,), dtype=np.int8),
            }
        )
        self.observation_spaces = {agent: obs_space for agent in self.possible_agents}
        self.action_spaces = {
            agent: spaces.Discrete(rules.ACTION_SPACE_SIZE) for agent in self.possible_agents
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

        phase = np.array([0 if rules.in_bidding(state) else 1], np.int8)
        bids = np.array(state.bids, np.int8)

        trick = np.full(4, -1, np.int8)
        for played_seat, card in state.current_trick:
            trick[played_seat] = card

        # The immediately-preceding completed trick, indexed by seat like ``trick``. rules clears
        # current_trick the instant a trick completes, so without this leaf a seat that led the next
        # trick (or was off turn for the later plays) would never observe the cards played after its
        # own move, silently losing public history it needs to count cards. Every seat is -1 until
        # the first trick completes; last_trick_winner is -1 until then too.
        last_trick = np.full(4, -1, np.int8)
        if state.last_trick is not None:
            for played_seat, card in state.last_trick:
                last_trick[played_seat] = card
        winner = state.last_trick_winner
        last_trick_winner = np.array([winner if winner is not None else -1], np.int8)

        led = rules.led_suit(state)
        led_suit = np.array([led if led is not None else -1], np.int8)
        spades_broken = np.array([1 if state.spades_broken else 0], np.int8)
        position = np.array([seat], np.int8)
        trick_leader = np.array([state.trick_leader], np.int8)
        tricks_won = np.array(state.tricks_won, np.int8)

        # The action mask is meaningful only for the seat whose turn it is; an off-turn seat is not
        # choosing, so it gets an all-zero mask (matching the overlay, which lists legal actions for
        # the acting seat alone). The AEC loop reads a seat's observation through last() only on that
        # seat's turn, where state.turn == seat, so the acting mask is always populated.
        action_mask = np.zeros(rules.ACTION_SPACE_SIZE, np.int8)
        if state.turn == seat:
            for action in rules.legal_actions(state, seat):
                action_mask[action] = 1

        return {
            "observation": {
                "hand": hand,
                "phase": phase,
                "bids": bids,
                "trick": trick,
                "last_trick": last_trick,
                "last_trick_winner": last_trick_winner,
                "led_suit": led_suit,
                "spades_broken": spades_broken,
                "position": position,
                "trick_leader": trick_leader,
                "tricks_won": tricks_won,
            },
            "action_mask": action_mask,
        }

    def step(self, action: Any) -> None:
        if self.terminations[self.agent_selection] or self.truncations[self.agent_selection]:
            return self._was_dead_step(action)

        seat = self._seat(self.agent_selection)
        # The timeout sentinel resolves against the live state (a suggested bid or lowest card); any
        # other action is a literal action-space integer (a card 0..51 or a bid 52 + k).
        resolved = rules.resolve_auto_action(self.state, seat) if action == AUTO_ACTION else int(action)

        if not rules.is_legal_action(self.state, seat, resolved):
            raise IllegalMoveError(
                f"{self.agent_selection} cannot take action {resolved}; "
                f"legal: {rules.legal_actions(self.state, seat)}"
            )

        if rules.in_bidding(self.state):
            rules.place_bid(self.state, rules.action_to_bid(resolved))
        else:
            rules.play_card(self.state, resolved)

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
        # Lazy-import so env.py imports cleanly without pulling in pygame. The renderer is never
        # touched when render_mode is None, so api_test stays free of any pygame dependency.
        from .render import SpadesRenderer

        if self._renderer is None:
            self._renderer = SpadesRenderer(self.render_mode)
        return self._renderer.render(self)

    def close(self) -> None:
        if self._renderer is not None:
            self._renderer.close()
            self._renderer = None
