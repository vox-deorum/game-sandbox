"""A Dict action space with a per-key mask, end to end through the harness.

Four things are proved here, because no shipped environment declares a composite action yet:
PettingZoo accepts the shape, the mask means exactly what the environment contract says it means,
the harness charges a per-key violation to the right player, and the action survives a recording.
"""

from __future__ import annotations

import json
import warnings
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from pettingzoo.test import api_test
from support_dict_action import BID, INDEX_SIZE, PLAY, DictActionEnv, make_entry

from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import resolve_parameters
from game_sandbox_harness.participant_runner import illegal_action_reason
from game_sandbox_harness.recording.local import FolderRecordingStore, dump_line
from game_sandbox_harness.session import (
    AgentPlayer,
    Episode,
    IllegalAgentActionError,
    run_episode,
)

ENTRY = make_entry()


class ScriptedAgent:
    """Replays fixed composite actions."""

    def __init__(self, actions: list[Any]) -> None:
        self._actions = actions

    def reset(self, seed: int) -> None:
        self._i = 0

    def act(self, observation: Any) -> Any:
        action = self._actions[min(self._i, len(self._actions) - 1)]
        self._i += 1
        return action


class MaskedSamplingAgent:
    """Plays whatever the published mask allows, the way the contract tells an agent to."""

    def __init__(self, space: Any) -> None:
        self._space = space

    def reset(self, seed: int) -> None:
        self._space.seed(seed)

    def act(self, observation: Any) -> Any:
        return self._space.sample(mask=observation["action_mask"])


def _attribution() -> dict[str, dict[str, str]]:
    return {
        player: {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}
        for player in ("player_0", "player_1")
    }


def _episode(players: dict[str, AgentPlayer], **kwargs: Any) -> Episode:
    return Episode(
        ENTRY,
        players,
        parameters=resolve_parameters(ENTRY.meta),
        seed=1,
        clock=ManualClock(),
        **kwargs,
    )


def _masked_product(mask: dict[str, Any]) -> set[tuple[int, int]]:
    """Every move masked sampling can draw: one masked-in value per key, combined."""
    return {
        (int(kind), int(index))
        for kind in np.flatnonzero(mask["kind"])
        for index in np.flatnonzero(mask["index"])
    }


def test_dict_action_fixture_passes_the_pettingzoo_api_test():
    # The sequential api_test samples through `action_space.sample(mask)`, which Gymnasium
    # implements for a Dict space by masking each subspace, so an object mask needs no special
    # handling. Only PettingZoo's own mask shape check warns, since it expects one array.
    #
    # This is a weaker statement than it is for Hearts: `test_action_flexibility` branches on
    # Discrete and Box only, so it skips a Dict action space silently. The enumeration test below
    # exists to cover what api_test therefore never checks.
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message="Action mask is not a NumPy array")
        warnings.filterwarnings("ignore", message="Action space for each agent probably should be")
        warnings.filterwarnings("ignore", message="Observation space for each agent probably should be")
        warnings.filterwarnings("ignore", message="Observation is not a NumPy array")
        api_test(DictActionEnv(), num_cycles=30)


def test_the_masked_cross_product_is_exactly_the_legal_move_set():
    # The factorization rule, checked by enumeration rather than sampling so it is exact: every
    # combination of individually masked-in values must be a legal move, and every legal move must
    # be reachable. The episode is then driven by real masked sampling, so the path an agent
    # actually takes is exercised too, and the env raises if a draw was never legal.
    env = DictActionEnv()
    env.reset(seed=0)
    turns = 0
    for agent in env.agent_iter():
        observation, _reward, terminated, truncated, _info = env.last()
        if terminated or truncated:
            env.step(None)
            continue
        assert _masked_product(observation["action_mask"]) == env.legal_actions(agent)
        turns += 1
        env.step(env.action_space(agent).sample(mask=observation["action_mask"]))
    # Two bids and three cards each, so the property held on every turn of a complete episode.
    assert turns == ENTRY.meta.recommended_episode_ticks


def test_a_masked_out_component_is_charged_to_the_acting_player():
    # player_1 bids 7, which the `index` sub-mask rules out while only bids 0..2 are legal. The
    # boundary must reject it and charge player_1 alone, exactly as it does for a flat mask.
    players = {
        "player_0": AgentPlayer(ScriptedAgent([{"kind": BID, "index": 1}])),
        "player_1": AgentPlayer(ScriptedAgent([{"kind": BID, "index": 7}])),
    }
    episode = _episode(players)
    episode.start()
    episode.step_once()
    with pytest.raises(IllegalAgentActionError, match="legal-move mask"):
        episode.step_once()
    assert episode.failed_player == "player_1"
    assert episode.result().failed_player == "player_1"


def test_a_wrong_phase_component_is_charged_even_when_the_other_component_is_legal():
    # Each key is judged on its own. Card 1 is in player_0's hand and so is masked in under
    # `index`, but `kind` is pinned to bidding on the opening turn, so the move is still illegal.
    # A check that only looked at one key, or at the pair, would miss this.
    players = {
        "player_0": AgentPlayer(ScriptedAgent([{"kind": PLAY, "index": 1}])),
        "player_1": AgentPlayer(ScriptedAgent([{"kind": BID, "index": 0}])),
    }
    episode = _episode(players)
    episode.start()
    with pytest.raises(IllegalAgentActionError, match="legal-move mask"):
        episode.step_once()
    assert episode.failed_player == "player_0"


def test_an_action_missing_a_component_is_charged_by_the_space_check():
    # A mask cannot judge a value that is not there, so the action space owns this one.
    players = {
        "player_0": AgentPlayer(ScriptedAgent([{"kind": BID}])),
        "player_1": AgentPlayer(ScriptedAgent([{"kind": BID, "index": 0}])),
    }
    episode = _episode(players)
    episode.start()
    with pytest.raises(IllegalAgentActionError, match="action space"):
        episode.step_once()
    assert episode.failed_player == "player_0"


@pytest.mark.parametrize(
    ("mask", "action"),
    [
        pytest.param({"kind": np.array([1, 0], np.int8)}, 0, id="object-mask-flat-action"),
        pytest.param(np.array([0, 1], np.int8), {"kind": 0}, id="flat-mask-object-action"),
    ],
)
def test_a_mask_that_disagrees_with_the_action_shape_charges_nobody(mask: Any, action: Any):
    # A mask whose shape does not match the action is the environment's defect. Withholding a
    # verdict keeps the agent from being failed for it, and keeps the flat branch from indexing an
    # object mask, which used to raise KeyError as an unowned fault.
    observation = {"observation": {}, "action_mask": mask}
    assert illegal_action_reason(None, "player_0", observation, {}, action) is None


def test_a_sampled_composite_action_round_trips_through_the_recording(tmp_path: Path):
    # `space.sample(mask=...)` returns NumPy scalars by construction, which is what the contract
    # tells an agent to call, so the recording writer has to accept them. They land as plain JSON
    # integers, and the whole episode is readable back.
    space = ENTRY.make({}).action_space("player_0")
    result = run_episode(
        ENTRY,
        {player: AgentPlayer(MaskedSamplingAgent(space)) for player in ("player_0", "player_1")},
        seed=1,
        parameters=resolve_parameters(ENTRY.meta),
        store=FolderRecordingStore(tmp_path),
        recording_id="composite",
        clock=ManualClock(),
        player_attribution=_attribution(),
    )
    assert result.failed_player is None

    states = list(FolderRecordingStore(tmp_path).open("composite").steps())
    assert len(states) == ENTRY.meta.recommended_episode_ticks
    # One acting player per AEC step. A non-actor carrying only a terminal lifecycle delta has no
    # action key at all, which is the contract build_agent_step promises.
    actions = [step["action"] for state in states for step in state["agents"].values() if "action" in step]
    assert len(actions) == ENTRY.meta.recommended_episode_ticks
    for action in actions:
        assert set(action) == {"kind", "index"}
        # Plain ints, not NumPy scalars, and inside their declared subspaces.
        assert type(action["kind"]) is int and action["kind"] in (BID, PLAY)
        assert type(action["index"]) is int and 0 <= action["index"] < INDEX_SIZE


def test_the_recording_serializer_normalizes_numpy_and_rejects_everything_else():
    # The split the writer promises: a NumPy leaf is the same value in a different wrapper, so it
    # normalizes silently, while a type a recording cannot carry stays a loud failure.
    line = dump_line({"action": {"kind": np.int64(1), "index": np.int64(3)}})
    assert json.loads(line) == {"action": {"kind": 1, "index": 3}}
    assert dump_line({"mask": np.array([0, 1], np.int8)}) == '{"mask":[0,1]}\n'
    with pytest.raises(TypeError):
        dump_line({"action": {1, 2}})
