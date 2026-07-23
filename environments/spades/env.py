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

import importlib
import random
from typing import TYPE_CHECKING, Any

import numpy as np
from gymnasium import spaces
from pettingzoo.utils.env import AECEnv

from . import rules


def _shared_card_modules() -> tuple[Any, Any]:
    """Return the shared ``(card_utils, card_spaces)`` modules under whichever name this file runs as.

    One source syncs into two layouts: :mod:`local_play` inside the environments package,
    ``sandbox`` in a composed template. A :class:`ModuleNotFoundError` naming the absent candidate
    package is swallowed; one naming a real dependency is re-raised. Mirrors
    ``hearts.env._shared_card_modules`` / ``spades.rules._shared_card_utils``.
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

#: ``bids`` entries encode "not yet bid" as ``14`` in the semantic observation (the engine uses
#: ``-1``); this is the single place that offset is applied.
UNBID = 14


class IllegalMoveError(ValueError):
    """Raised by :meth:`SpadesEnv.step` when an action is not legal in the current phase."""


def make_env() -> SpadesEnv:
    """Return a fresh :class:`SpadesEnv`. The seed arrives later at :meth:`SpadesEnv.reset`."""
    return SpadesEnv()


def default_action(env: SpadesEnv, slot_id: str) -> int:
    """The legal default for a timed-out seat: a never-nil suggested bid, or the lowest legal card.

    Reads the live env and returns the concrete ``Discrete(66)`` action (not a sentinel) — a
    never-nil suggested bid while bidding, the lowest legal card in play. It mirrors
    ``env.step``'s own resolution, so gameplay is unchanged and the recording holds the real action.
    """
    seat = env.possible_agents.index(slot_id)
    return rules.resolve_auto_action(env.state, seat)


class SpadesEnv(AECEnv):
    """Four-player partnership Spades as a PettingZoo AEC environment over :mod:`spades.rules`."""

    metadata = {
        "name": "spades_v0",
        "is_parallelizable": False,
    }

    def __init__(self) -> None:
        super().__init__()
        self.possible_agents = [f"player_{i}" for i in range(rules.NUM_PLAYERS)]
        self.agents: list[str] = []
        # Bound in reset(); declared (not None-initialised) so the type stays SpadesState and every
        # access below is free of Optional-narrowing noise. api_test always resets first.
        self.state: rules.SpadesState

        # Build the spaces exactly once so the accessors can return the same object every call
        # (api_test asserts space identity). The space mirrors observe()'s structure: the semantic
        # state leaves nested under "observation" alongside a top-level "action_mask", matching the
        # AEC convention. Cards are semantic objects (HAND/TRICK), not integer-indexed arrays. There
        # is no score leaf beyond team_scores; the full per-seat score view lives in the overlay.
        obs_space = spaces.Dict(
            {
                "observation": spaces.Dict(
                    {
                        "seat": spaces.Discrete(4),
                        "partner_seat": spaces.Discrete(4),
                        "phase": spaces.Discrete(2),
                        "hand": HAND,
                        "bids": spaces.Tuple([spaces.Discrete(15)] * 4),
                        "team_scores": spaces.Box(low=-1000, high=1000, shape=(2,), dtype=np.int64),
                        "current_trick": TRICK,
                        "last_trick": TRICK,
                        "last_trick_winner": spaces.Discrete(5),
                        "trick_leader": spaces.Discrete(4),
                        "led_suit": spaces.Discrete(5),
                        "spades_broken": spaces.Discrete(2),
                        "tricks_won": spaces.Box(low=0, high=13, shape=(4,), dtype=np.int64),
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

        hand = tuple(card_to_obj(c) for c in state.hands[seat])
        current_trick = tuple({"seat": int(s), "card": card_to_obj(c)} for s, c in state.current_trick)
        last_trick: tuple[dict[str, Any], ...]
        if state.last_trick is None:
            last_trick = ()
        else:
            last_trick = tuple({"seat": int(s), "card": card_to_obj(c)} for s, c in state.last_trick)

        bids = tuple(UNBID if b == -1 else int(b) for b in state.bids)
        phase = 0 if rules.in_bidding(state) else 1
        team_scores = np.array(rules.hand_team_scores(state), dtype=np.int64)
        tricks_won = np.array(state.tricks_won, dtype=np.int64)

        winner = state.last_trick_winner
        last_trick_winner = 4 if winner is None else int(winner)
        led = rules.led_suit(state)
        led_suit = 4 if led is None else int(led)

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
                "seat": int(seat),
                "partner_seat": (seat + 2) % 4,
                "phase": phase,
                "hand": hand,
                "bids": bids,
                "team_scores": team_scores,
                "current_trick": current_trick,
                "last_trick": last_trick,
                "last_trick_winner": last_trick_winner,
                "trick_leader": int(state.trick_leader),
                "led_suit": led_suit,
                "spades_broken": int(bool(state.spades_broken)),
                "tricks_won": tricks_won,
            },
            "action_mask": action_mask,
        }

    def step(self, action: Any) -> None:
        if self.terminations[self.agent_selection] or self.truncations[self.agent_selection]:
            return self._was_dead_step(action)

        seat = self._seat(self.agent_selection)
        resolved = int(action)

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

    def render(self) -> Any:
        """Return no pixels: browser renderers consume the semantic overlay instead."""
        return None
