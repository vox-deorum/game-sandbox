"""A Dict action space with a per-key mask, end to end through the harness.

Five things are proved here, because no shipped environment declares a composite action yet:
PettingZoo accepts the shape, the mask means exactly what the environment contract says it means,
the harness charges a per-key violation to the right player, a mask entry the platform cannot read
costs nobody the episode, and the action survives a recording.

``DictActionEnv`` covers the two-Discrete shape a real environment would most likely declare. The
subspaces beyond it (MultiDiscrete, a nested Dict, Box), the ``start`` offset, and the malformed
entries all use small rigs defined here, the way ``MaskedEnv`` sits beside its tests in
``test_session.py``.
"""

from __future__ import annotations

import json
import warnings
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from gymnasium import spaces
from pettingzoo.test import api_test
from support_dict_action import BID, INDEX_SIZE, PLAY, DictActionEnv, make_entry

from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import (
    BuiltinAgent,
    EnvironmentEntry,
    EnvironmentMeta,
    PlayerBounds,
    action_mask_problems,
    resolve_parameters,
)
from game_sandbox_harness.participant_runner import illegal_action_reason
from game_sandbox_harness.recording.local import FolderRecordingStore, dump_line
from game_sandbox_harness.session import (
    AgentPlayer,
    Episode,
    ExternalPlayer,
    IllegalAgentActionError,
    ScriptedSource,
    run_episode,
)

ENTRY = make_entry()


class ScriptedAgent:
    """Replays fixed composite actions."""

    def __init__(self, actions: list[Any]) -> None:
        self._actions = actions

    def reset(self, seed: int, observation: Any) -> None:
        self._i = 0

    def act(self, observation: Any) -> Any:
        action = self._actions[min(self._i, len(self._actions) - 1)]
        self._i += 1
        return action


class MaskedSamplingAgent:
    """Plays whatever the published mask allows, the way the contract tells an agent to."""

    def __init__(self, space: Any) -> None:
        self._space = space

    def reset(self, seed: int, observation: Any) -> None:
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


#: The one legal move in the rig below, as ``(kind, row, column)``.
RIGGED_LEGAL = {(0, 0, 0)}
GRID = 3


def _move(kind: int, row: int, column: int) -> dict[str, Any]:
    """One rigged action: a scalar phase paired with a two-dimensional coordinate."""
    return {"kind": kind, "cell": np.array([row, column])}


def _cell_mask(rows: tuple[int, ...], columns: tuple[int, ...]) -> tuple[Any, ...]:
    """A MultiDiscrete mask: one binary vector per dimension."""
    return tuple(
        np.array([1 if value in legal else 0 for value in range(GRID)], np.int8) for legal in (rows, columns)
    )


class _SpaceEnv:
    """An environment that declares one action space and nothing else."""

    def __init__(self, space: Any) -> None:
        self._space = space

    def action_space(self, player_id: str) -> Any:
        return self._space


class _RiggedDictEnv:
    """A 2-player env pairing a Discrete phase with a MultiDiscrete coordinate.

    Its mask is injected rather than derived, so a test can hand it a shape the platform cannot
    read and watch which key still earns a verdict. ``step`` rejects anything outside the legal
    set, which is the unowned abort a missing verdict would cause.
    """

    def __init__(self, mask: Any) -> None:
        self.possible_agents = ["player_0", "player_1"]
        self._mask = mask
        self._space = spaces.Dict({"kind": spaces.Discrete(2), "cell": spaces.MultiDiscrete([GRID, GRID])})

    def action_space(self, agent: str) -> spaces.Space[Any]:
        return self._space

    def reset(self, seed: int | None = None, options: Any = None) -> None:
        self.agents = list(self.possible_agents)
        self._played = 0
        self.agent_selection = self.agents[0]
        self.rewards = dict.fromkeys(self.agents, 0.0)
        self.terminations = dict.fromkeys(self.agents, False)
        self.truncations = dict.fromkeys(self.agents, False)

    def observe(self, agent: str) -> dict[str, Any]:
        return {"observation": {}, "action_mask": self._mask}

    def last(self) -> tuple[Any, float, bool, bool, dict[str, Any]]:
        agent = self.agent_selection
        return (
            self.observe(agent),
            self.rewards[agent],
            self.terminations[agent],
            self.truncations[agent],
            {},
        )

    def step(self, action: Any) -> None:
        agent = self.agent_selection
        if self.terminations[agent] or self.truncations[agent]:
            self.agents.remove(agent)
            return
        move = (int(action["kind"]), int(action["cell"][0]), int(action["cell"][1]))
        if move not in RIGGED_LEGAL:
            raise ValueError(f"env rejects illegal action {move!r}")
        self._played += 1
        if self._played >= len(self.possible_agents):
            self.terminations = dict.fromkeys(self.possible_agents, True)
            self.agent_selection = self.possible_agents[0]
        else:
            self.agent_selection = self.possible_agents[self._played]


def _rigged_episode(mask: Any, players: dict[str, Any]) -> Episode:
    """An episode over the rig, publishing ``mask`` to whichever player is on turn."""
    meta = EnvironmentMeta(
        env_id="rigged_dict",
        display_name="Rigged dict",
        description="A 2-player fake whose composite mask is injected rather than derived.",
        stepping="sequential",
        builtin_agents=(BuiltinAgent("naive", "Naive agent"),),
        layout=PlayerBounds(2, 2),
        human_players=("player_0", "player_1"),
        human_timeout_ms=None,
        recommended_episode_ticks=2,
        pace_interval_ms=None,
        step_limit_ms=1000,
        episode_limit_ms=120_000,
        messaging=False,
        message_cap=None,
        llm=False,
        renderer="rigged_dict",
        seat_order_matters=True,
    )
    entry = EnvironmentEntry(
        meta=meta,
        make=lambda _parameters: _RiggedDictEnv(mask),
        default_action=lambda _env, _player_id: _move(*min(RIGGED_LEGAL)),
        overlay=None,
    )
    return Episode(entry, players, parameters=resolve_parameters(meta), seed=1, clock=ManualClock())


def _reason(space: Any, mask: Any, action: Any) -> str | None:
    """The verdict on one action, judged against a declared space when there is one."""
    env = None if space is None else _SpaceEnv(space)
    return illegal_action_reason(env, "player_0", {"observation": {}, "action_mask": mask}, {}, action)


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


def test_a_masked_out_multidiscrete_dimension_is_charged_to_the_acting_player():
    # Every declared subspace is judged, not only the scalar ones. Column 2 is masked out, so the
    # boundary must refuse the move. Without a verdict it reaches env.step, whose raise no player
    # owns, and the whole table loses the session over one player's move.
    mask = {"kind": np.array([1, 0], np.int8), "cell": _cell_mask((0,), (0,))}
    players = {
        "player_0": AgentPlayer(ScriptedAgent([_move(0, 0, 2)])),
        "player_1": AgentPlayer(ScriptedAgent([_move(0, 0, 0)])),
    }
    episode = _rigged_episode(mask, players)
    episode.start()
    with pytest.raises(IllegalAgentActionError, match="legal-move mask"):
        episode.step_once()
    assert episode.failed_player == "player_0"


def test_an_unreadable_mask_entry_leaves_the_other_component_charging_the_player():
    # A zero-dimensional array cannot be indexed by an action, so `kind` earns no verdict at all.
    # `cell` is still read, and the violation there still belongs to the player who committed it.
    mask = {"kind": np.array(1, np.int8), "cell": _cell_mask((0,), (0,))}
    players = {
        "player_0": AgentPlayer(ScriptedAgent([_move(0, 0, 2)])),
        "player_1": AgentPlayer(ScriptedAgent([_move(0, 0, 0)])),
    }
    episode = _rigged_episode(mask, players)
    episode.start()
    with pytest.raises(IllegalAgentActionError, match="legal-move mask"):
        episode.step_once()
    assert episode.failed_player == "player_0"


def test_an_unreadable_mask_entry_defaults_a_human_instead_of_crashing():
    # The human path is designed never to fail a player, so a mask the platform cannot read must
    # not turn into an exception there. The illegal move is swapped for the environment default
    # and the step lands.
    mask = {"kind": np.array(1, np.int8), "cell": _cell_mask((0,), (0,))}
    players = {
        "player_0": ExternalPlayer(ScriptedSource([_move(0, 0, 2)])),
        "player_1": AgentPlayer(ScriptedAgent([_move(0, 0, 0)])),
    }
    episode = _rigged_episode(mask, players)
    episode.start()
    episode.step_once()
    assert episode.tick == 1
    assert episode.failed_player is None


@pytest.mark.parametrize(
    "entry",
    [
        pytest.param(np.array(1, np.int8), id="zero-dimensional-array"),
        pytest.param({"legal": [0]}, id="object-under-a-scalar-subspace"),
        pytest.param(3, id="bare-integer"),
    ],
)
def test_a_mask_entry_the_platform_cannot_read_withholds_its_verdict(entry: Any):
    assert _reason(spaces.Dict({"kind": spaces.Discrete(2)}), {"kind": entry}, {"kind": 1}) is None


def test_a_mask_shorter_than_its_subspace_vetoes_nothing():
    # A position the mask does not reach is not a rejection. The vector is the environment's
    # defect, so the action passes rather than the player being charged for reading it.
    space = spaces.Dict({"kind": spaces.Discrete(4)})
    assert _reason(space, {"kind": np.array([0, 1], np.int8)}, {"kind": 3}) is None


def test_a_null_mask_entry_leaves_its_component_unrestricted():
    space = spaces.Dict({"kind": spaces.Discrete(2), "index": spaces.Discrete(4)})
    mask = {"kind": None, "index": np.array([1, 0, 0, 0], np.int8)}
    assert _reason(space, mask, {"kind": 1, "index": 0}) is None
    assert "index" in str(_reason(space, mask, {"kind": 1, "index": 2}))


@pytest.mark.parametrize(("action", "legal"), [(5, True), (6, False)])
def test_a_flat_mask_counts_positions_from_the_spaces_start(action: int, legal: bool):
    # Position i covers the action start + i, so a space that starts at 5 shifts the whole vector.
    reason = _reason(spaces.Discrete(3, start=5), np.array([1, 0, 1], np.int8), action)
    assert (reason is None) is legal


def test_a_component_mask_counts_positions_from_its_subspaces_start():
    space = spaces.Dict({"bid": spaces.Discrete(3, start=1)})
    mask = {"bid": np.array([1, 0, 0], np.int8)}
    assert _reason(space, mask, {"bid": 1}) is None
    assert "bid" in str(_reason(space, mask, {"bid": 2}))


def test_a_multidiscrete_mask_counts_positions_from_each_dimensions_start():
    space = spaces.Dict({"cell": spaces.MultiDiscrete([3, 3], start=[1, 1])})
    mask = {"cell": (np.array([1, 0, 0], np.int8), np.array([1, 1, 0], np.int8))}
    assert _reason(space, mask, {"cell": np.array([1, 2])}) is None
    assert "cell" in str(_reason(space, mask, {"cell": np.array([1, 3])}))


def test_a_nested_dict_component_is_judged_key_by_key():
    space = spaces.Dict({"move": spaces.Dict({"unit": spaces.Discrete(3)})})
    mask = {"move": {"unit": np.array([1, 1, 0], np.int8)}}
    assert _reason(space, mask, {"move": {"unit": 1}}) is None
    assert "move" in str(_reason(space, mask, {"move": {"unit": 2}}))


def test_a_box_component_carries_no_mask_to_read():
    # A continuous range cannot be masked, so its entry is null. Anything else there is the
    # environment's defect and earns no verdict either.
    space = spaces.Dict({"thrust": spaces.Box(low=0.0, high=1.0, shape=(1,))})
    action = {"thrust": np.array([0.5], np.float32)}
    assert _reason(space, {"thrust": None}, action) is None
    assert _reason(space, {"thrust": np.array([0, 0], np.int8)}, action) is None


def test_a_component_type_the_platform_does_not_mask_withholds_its_verdict():
    # MultiBinary is not a permitted component, and its own mask dialect means a forced value
    # rather than a legal one. The conformance check is what tells an author so; the boundary
    # declines to invent a verdict from a dialect it does not read.
    space = spaces.Dict({"bits": spaces.MultiBinary(3)})
    mask = {"bits": np.array([1, 0, 0], np.int8)}
    assert _reason(space, mask, {"bits": np.array([1, 1, 0], np.int8)}) is None


def test_an_array_component_without_a_declared_space_withholds_its_verdict():
    # With no space to align the vectors against, a wrong verdict would be worse than none.
    assert _reason(None, {"cell": _cell_mask((0,), (0,))}, {"cell": np.array([0, 2])}) is None


def test_the_conformance_check_accepts_the_fixture_mask_on_every_turn():
    env = DictActionEnv()
    env.reset(seed=0)
    for agent in env.agent_iter():
        observation, _reward, terminated, truncated, _info = env.last()
        if terminated or truncated:
            env.step(None)
            continue
        assert action_mask_problems(env.action_space(agent), observation["action_mask"]) == []
        env.step(env.action_space(agent).sample(mask=observation["action_mask"]))


def test_the_conformance_check_accepts_a_flat_mask_including_an_all_zero_one():
    # A player who is not on turn gets an all-zero mask, which is how Hearts and Spades publish
    # one, and an environment with always-legal actions publishes none at all.
    assert action_mask_problems(spaces.Discrete(4), np.zeros(4, np.int8)) == []
    assert action_mask_problems(spaces.Discrete(4), None) == []


@pytest.mark.parametrize(
    ("space", "mask", "expected"),
    [
        pytest.param(spaces.Discrete(3), np.zeros(2, np.int8), "carries 2 values", id="short-vector"),
        pytest.param(spaces.Discrete(3), np.array([0, 1, 2]), "other than 0 and 1", id="not-binary"),
        pytest.param(spaces.Discrete(3), np.array(1), "not a vector", id="zero-dimensional"),
        pytest.param(
            spaces.Dict({"kind": spaces.Discrete(2)}),
            np.zeros(2, np.int8),
            "not an object",
            id="flat-mask-for-a-composite-space",
        ),
        pytest.param(
            spaces.Dict({"kind": spaces.Discrete(2), "index": spaces.Discrete(3)}),
            {"kind": np.ones(2, np.int8)},
            "the action space declares",
            id="missing-key",
        ),
        pytest.param(
            spaces.Dict({"cell": spaces.MultiDiscrete([2, 3])}),
            {"cell": [np.ones(2, np.int8), np.ones(3, np.int8)]},
            "not a tuple",
            id="multidiscrete-vectors-not-in-a-tuple",
        ),
        pytest.param(
            spaces.Dict({"cell": spaces.MultiDiscrete([2, 3])}),
            {"cell": (np.ones(2, np.int8), np.ones(2, np.int8))},
            "carries 2 values, but the subspace has 3",
            id="multidiscrete-dimension-of-the-wrong-length",
        ),
        pytest.param(
            spaces.Dict({"thrust": spaces.Box(low=0.0, high=1.0, shape=(1,))}),
            {"thrust": np.ones(2, np.int8)},
            "must be null",
            id="masked-box",
        ),
    ],
)
def test_the_conformance_check_names_a_mask_that_disagrees_with_its_space(
    space: Any, mask: Any, expected: str
):
    problems = action_mask_problems(space, mask)
    assert any(expected in problem for problem in problems), problems


@pytest.mark.parametrize(
    ("subspace", "expected"),
    [
        pytest.param(spaces.MultiBinary(3), "MultiDiscrete with two values", id="multibinary"),
        pytest.param(spaces.Tuple((spaces.Discrete(2),)), "Dict with a name per component", id="tuple"),
    ],
)
def test_the_conformance_check_names_the_component_shape_to_declare_instead(subspace: Any, expected: str):
    problems = action_mask_problems(spaces.Dict({"choice": subspace}), None)
    assert any(expected in problem for problem in problems), problems


def test_the_conformance_check_accepts_a_nested_dict_component():
    space = spaces.Dict({"move": spaces.Dict({"unit": spaces.Discrete(3)})})
    assert action_mask_problems(space, {"move": {"unit": np.ones(3, np.int8)}}) == []
