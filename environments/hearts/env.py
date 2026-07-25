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

import importlib
import random
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

import numpy as np
from gymnasium import spaces
from pettingzoo.utils.env import AECEnv

from . import rules

if TYPE_CHECKING:
    from game_sandbox_harness.environment import ParameterValue


def _shared_card_modules() -> tuple[Any, Any]:
    """Return the shared ``(card_utils, card_spaces)`` modules under whichever name this file runs as.

    One source syncs into two layouts: :mod:`local_play` inside the environments package,
    ``sandbox`` in a composed template. A :class:`ModuleNotFoundError` naming the absent candidate
    package is swallowed; one naming a real dependency is re-raised. Mirrors
    ``hearts.rules._shared_card_utils``.
    """
    for package in ("local_play", "sandbox"):
        try:
            card_utils = importlib.import_module(f"{package}.card_utils")
            card_spaces = importlib.import_module(f"{package}.card_spaces")
        except ModuleNotFoundError as exc:
            missing = exc.name or ""
            if missing == package or missing.startswith(f"{package}."):
                continue
            raise
        else:
            return card_utils, card_spaces
    raise ModuleNotFoundError("no shared card_utils/card_spaces found (tried local_play, sandbox)")


if TYPE_CHECKING:  # pyright sees the real modules; this branch never executes at runtime
    from local_play import card_spaces as _card_spaces
    from local_play import card_utils as _card_utils
else:
    _card_utils, _card_spaces = _shared_card_modules()

card_to_obj = _card_utils.card_to_obj
HAND = _card_spaces.HAND
TRICK = _card_spaces.TRICK


class IllegalMoveError(ValueError):
    """Raised by :meth:`HeartsEnv.step` when an action is not a legal card."""


def make_env(parameters: Mapping[str, ParameterValue]) -> HeartsEnv:
    """Return a fresh :class:`HeartsEnv`. The seed arrives later at :meth:`HeartsEnv.reset`."""
    del parameters
    return HeartsEnv()


def default_action(env: HeartsEnv, player_id: str) -> int:
    """The legal default for a timed-out seat: its lowest legal card.

    Reads the live env and returns the concrete ``Discrete(52)`` card (not a sentinel), so the
    recording holds the real move. It matches ``env.step``'s own resolution, so gameplay is unchanged.
    """
    seat = env.possible_agents.index(player_id)
    return rules.lowest_legal_card(env.state, seat)


class HeartsEnv(AECEnv):
    """Four-player Hearts as a PettingZoo AEC environment over :mod:`hearts.rules`."""

    metadata = {
        "name": "hearts_v0",
        "is_parallelizable": False,
    }

    def __init__(self) -> None:
        super().__init__()
        self.possible_agents = [f"player_{i}" for i in range(rules.NUM_PLAYERS)]
        self.agents: list[str] = []
        # Bound in reset(); declared (not None-initialised) so the type stays HeartsState and
        # every access below is free of Optional-narrowing noise. api_test always resets first.
        self.state: rules.HeartsState

        # Build the spaces exactly once so the accessors can return the same object every call
        # (api_test asserts space identity). The space mirrors observe()'s structure: the semantic
        # state leaves nested under "observation" alongside a top-level "action_mask", matching the
        # AEC convention. Cards are semantic objects (HAND/TRICK), not integer-indexed arrays.
        obs_space = spaces.Dict(
            {
                "observation": spaces.Dict(
                    {
                        "seat": spaces.Discrete(4),
                        "hand": HAND,
                        "current_trick": TRICK,
                        "trick_leader": spaces.Discrete(4),
                        "led_suit": spaces.Discrete(5),
                        "hearts_broken": spaces.Discrete(2),
                        "scores": spaces.Box(low=0, high=26, shape=(4,), dtype=np.int64),
                    }
                ),
                "action_mask": spaces.Box(low=0, high=1, shape=(rules.NUM_CARDS,), dtype=np.int8),
            }
        )
        self.observation_spaces = {agent: obs_space for agent in self.possible_agents}
        self.action_spaces = {agent: spaces.Discrete(rules.NUM_CARDS) for agent in self.possible_agents}

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

        hand = tuple(card_to_obj(card) for card in state.hands[seat])
        current_trick = tuple(
            {"seat": int(played_seat), "card": card_to_obj(card)} for played_seat, card in state.current_trick
        )

        led = rules.led_suit(state)
        led_suit = 4 if led is None else int(led)
        hearts_broken = int(bool(state.hearts_broken))
        trick_leader = int(state.trick_leader)
        # The display score (lower is better): the running penalty during play, and the
        # shoot-the-moon-flipped final at terminal. Using penalty_scores rather than the raw
        # points_taken keeps this leaf in agreement with the overlay's display_scores, which the
        # renderer draws, so the two never disagree on the last step of a moon-shot hand.
        scores = np.array(rules.penalty_scores(state), dtype=np.int64)

        # The action mask is meaningful only for the seat whose turn it is; an off-turn seat is not
        # choosing, so it gets an all-zero mask (matching the overlay, which lists legal actions for
        # the acting seat alone). The AEC loop reads a seat's observation through last() only on that
        # seat's turn, where state.turn == seat, so the acting mask is always populated.
        action_mask = np.zeros(rules.NUM_CARDS, np.int8)
        if state.turn == seat:
            for card in rules.legal_moves(state, seat):
                action_mask[card] = 1

        return {
            "observation": {
                "seat": int(seat),
                "hand": hand,
                "current_trick": current_trick,
                "trick_leader": trick_leader,
                "led_suit": led_suit,
                "hearts_broken": hearts_broken,
                "scores": scores,
            },
            "action_mask": action_mask,
        }

    def step(self, action: Any) -> None:
        if self.terminations[self.agent_selection] or self.truncations[self.agent_selection]:
            return self._was_dead_step(action)

        seat = self._seat(self.agent_selection)
        card = int(action)

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

    def render(self) -> Any:
        """Return no pixels: browser renderers consume the semantic overlay instead."""
        return None
