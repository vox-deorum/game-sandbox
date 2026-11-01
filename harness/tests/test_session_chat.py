"""The chat loop integration: hook order, next-turn delivery, budgets, and the human queue.

Deterministic round-robin fixtures give players several turns, so messages sent on tick T can be
observed at a later acting opportunity. All timing uses ``ManualClock``.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import (
    BuiltinAgent,
    ChatPolicy,
    EnvironmentEntry,
    EnvironmentMeta,
    PlayerBounds,
    resolve_parameters,
)
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import (
    AgentPlayer,
    Episode,
    ExternalChatFrame,
    ExternalPlayer,
    run_episode,
)


class RoundRobinEnv:
    """An N-player round-robin AEC env that lives for ``n_ticks`` steps, then terminates every player.

    The observation is the tick index. An optional ``step_log`` records ``("step",)`` on each real
    step so a test can prove the environment stepped between ``chat`` and ``learn``.
    """

    def __init__(self, players: list[str], n_ticks: int, step_log: list[Any] | None = None) -> None:
        self.possible_agents = list(players)
        self._n = n_ticks
        self._log = step_log

    def reset(self, seed: int | None = None, options: Any = None) -> None:
        self.agents = list(self.possible_agents)
        self._i = 0
        self._idx = 0
        self.agent_selection = self.agents[0]
        self.rewards = {a: 0.0 for a in self.agents}
        self.terminations = {a: False for a in self.agents}
        self.truncations = {a: False for a in self.agents}

    def last(self) -> tuple[Any, float, bool, bool, dict[str, Any]]:
        a = self.agent_selection
        return self._i, self.rewards[a], self.terminations[a], self.truncations[a], {}

    def observe(self, agent: str) -> Any:
        return self._i

    def step(self, action: Any) -> None:
        a = self.agent_selection
        if self.terminations[a] or self.truncations[a]:
            self.agents.remove(a)
            if self.agents:
                self.agent_selection = self.agents[0]
            return
        if self._log is not None:
            self._log.append(("step",))
        self._i += 1
        if self._i >= self._n:
            self.terminations = {x: True for x in self.possible_agents}
            self.agent_selection = self.possible_agents[0]
        else:
            self._idx = (self._idx + 1) % len(self.possible_agents)
            self.agent_selection = self.possible_agents[self._idx]


class PolicyRoundRobinEnv(RoundRobinEnv):
    """The round-robin fixture with an explicitly typed live chat policy hook."""

    def __init__(
        self,
        players: list[str],
        n_ticks: int,
        policy: Callable[[RoundRobinEnv, str], object],
        step_log: list[Any] | None = None,
    ) -> None:
        super().__init__(players, n_ticks, step_log)
        self._policy = policy

    def chat_policy(self, sender: str) -> object:
        return self._policy(self, sender)


class BroadcastRoundRobinEnv(PolicyRoundRobinEnv):
    """The round-robin fixture with a live broadcast audience hook."""

    def __init__(
        self,
        players: list[str],
        n_ticks: int,
        policy: Callable[[RoundRobinEnv, str], object],
        audience: Callable[[RoundRobinEnv, str], object],
        step_log: list[Any] | None = None,
    ) -> None:
        super().__init__(players, n_ticks, policy, step_log)
        self._audience = audience

    def broadcast_recipients(self, sender: str) -> object:
        return self._audience(self, sender)


def make_chat_entry(
    players: tuple[str, ...] = ("player_0", "player_1"),
    n_ticks: int = 4,
    *,
    messaging: bool = True,
    message_cap: int | None = None,
    step_log: list[Any] | None = None,
    chat_policy: Callable[[RoundRobinEnv, str], object] | None = None,
    broadcast_recipients: Callable[[RoundRobinEnv, str], object] | None = None,
) -> EnvironmentEntry:
    meta = EnvironmentMeta(
        env_id="chat-fake",
        display_name="Chat Fake",
        description="A deterministic round-robin fake with messaging.",
        stepping="sequential",
        builtin_agents=(BuiltinAgent("naive", "Naive agent"),),
        layout=PlayerBounds(len(players), len(players)),
        human_players=players,
        human_timeout_ms=None,
        recommended_episode_ticks=n_ticks,
        pace_interval_ms=None,
        step_limit_ms=1000,
        episode_limit_ms=120_000,
        messaging=messaging,
        message_cap=message_cap,
        llm=False,
        renderer="fake",
        seat_order_matters=True,
    )

    def make(_parameters):
        if broadcast_recipients is not None:
            return BroadcastRoundRobinEnv(
                list(players),
                n_ticks,
                chat_policy or (lambda _env, _sender: {"target_recipients": (), "default_recipient": None}),
                broadcast_recipients,
                step_log,
            )
        if chat_policy is not None:
            return PolicyRoundRobinEnv(list(players), n_ticks, chat_policy, step_log)
        return RoundRobinEnv(list(players), n_ticks, step_log)

    return EnvironmentEntry(
        meta=meta,
        make=make,
        default_action=lambda env, player_id: 0,
        overlay=None,
    )


class HookOrderAgent:
    """Records every hook call into a shared log, to pin the act → chat → step → learn order."""

    def __init__(self, log: list[Any]) -> None:
        self._log = log

    def reset(self, seed: int, observation: Any) -> None:
        self._log.append(("reset", seed, observation))

    def act(self, observation: Any) -> int:
        self._log.append(("act", observation))
        return 0

    def chat(self, inbox: Any) -> list:
        self._log.append(("chat", list(inbox)))
        return []

    def learn(self, observation, action, reward, terminated) -> None:
        self._log.append(("learn", observation, action, reward, terminated))


class ChattyAgent:
    """Sends a scripted batch on each turn and records every inbox it is handed.

    ``cost_ms`` (on a ``ManualClock``) simulates a slow chat hook so timing and budget can be asserted.
    """

    def __init__(
        self,
        batches: list[list[dict] | None] | None = None,
        *,
        clock: ManualClock | None = None,
        cost_ms: int = 0,
    ) -> None:
        self._batches = batches or []
        self._clock = clock
        self._cost = cost_ms
        self.inboxes: list[list[dict]] = []

    def reset(self, seed: int, observation: Any) -> None:
        self._turn = 0

    def act(self, observation: Any) -> int:
        return 0

    def chat(self, inbox: Any) -> list | None:
        self.inboxes.append(list(inbox))
        if self._clock is not None and self._cost:
            self._clock.advance(self._cost)
        batch = self._batches[self._turn] if self._turn < len(self._batches) else []
        self._turn += 1
        return batch


class SilentAgent:
    """A chat-less, learn-less agent: only the required interface."""

    def reset(self, seed: int, observation: Any) -> None: ...

    def act(self, observation: Any) -> int:
        return 0


class QueueSource:
    """A fake external source exposing ``get_action`` (always default) and ``take_messages``.

    ``take_messages`` returns each queued batch once, in order, mirroring the live transport's
    per-player FIFO drained once per stepped tick.
    """

    def __init__(self, frames: list[ExternalChatFrame] | None = None) -> None:
        self._frames = list(frames or [])
        self._drained = False

    def queue(self, frame: ExternalChatFrame) -> None:
        self._frames.append(frame)

    def get_action(self, player_id: str, observation: Any, window_ms: int | None) -> Any:
        return None

    def take_messages(self, player_id: str) -> list[ExternalChatFrame]:
        self._drained = True
        frames, self._frames = self._frames, []
        return frames


# --- hook order ---------------------------------------------------------------------------------


def test_hook_order_is_act_then_chat_then_env_step_then_learn():
    log: list[Any] = []
    entry = make_chat_entry(players=("player_0",), n_ticks=2, step_log=log)
    run_episode(
        entry,
        {"player_0": AgentPlayer(HookOrderAgent(log))},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=ManualClock(),
    )
    assert log == [
        ("reset", 1, 0),
        ("act", 0),
        ("chat", []),
        ("step",),
        ("learn", 0, 0, 0.0, False),
        ("act", 1),
        ("chat", []),
        ("step",),
        ("learn", 1, 0, 0.0, True),
    ]


# --- delivery timing ----------------------------------------------------------------------------


def test_message_is_delivered_next_turn_never_on_the_sending_tick(tmp_path: Path):
    sender = ChattyAgent([[{"to": "player_1", "text": "hello"}], None])
    receiver = ChattyAgent([[{"to": "player_0", "text": "hi back"}]])
    entry = make_chat_entry(n_ticks=4)
    store = FolderRecordingStore(tmp_path)
    run_episode(
        entry,
        {"player_0": AgentPlayer(sender), "player_1": AgentPlayer(receiver)},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=ManualClock(),
        store=store,
        recording_id="r",
        player_attribution={
            player: {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}
            for player in ("player_0", "player_1")
        },
    )
    assert sender.inboxes == [[], [{"from": "player_1", "to": "player_0", "text": "hi back", "tick": 1}]]
    assert receiver.inboxes == [[{"from": "player_0", "to": "player_1", "text": "hello", "tick": 0}], []]
    assert [state.get("messages", []) for state in store.open("r").steps()] == [
        [{"from": "player_0", "to": "player_1", "text": "hello"}],
        [{"from": "player_1", "to": "player_0", "text": "hi back"}],
        [],
        [],
    ]


# --- chat-less agent ----------------------------------------------------------------------------


def test_bounded_broadcast_annotates_the_live_stream_and_keeps_the_recording_clean(tmp_path: Path):
    agents = {
        "player_0": ChattyAgent([[{"to": None, "text": "ring"}]]),
        "player_1": ChattyAgent(),
        "player_2": ChattyAgent(),
    }
    streamed: list[str] = []
    store = FolderRecordingStore(tmp_path, on_line=streamed.append)
    entry = make_chat_entry(
        players=("player_0", "player_1", "player_2"),
        n_ticks=3,
        broadcast_recipients=lambda _env, _sender: ("player_1",),
    )
    run_episode(
        entry,
        {player: AgentPlayer(agent) for player, agent in agents.items()},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
        player_attribution={
            player: {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}
            for player in ("player_0", "player_1", "player_2")
        },
    )
    live = json.loads(streamed[1])
    assert live["messages"] == [{"from": "player_0", "to": None, "text": "ring", "recipients": ["player_1"]}]
    assert next(store.open("r").steps())["messages"] == [{"from": "player_0", "to": None, "text": "ring"}]
    assert agents["player_0"].inboxes == [[]]
    assert agents["player_1"].inboxes == [[{"from": "player_0", "to": None, "text": "ring", "tick": 0}]]
    assert agents["player_2"].inboxes == [[]]


def test_unbounded_broadcast_streams_the_exact_recorded_bytes(tmp_path: Path):
    agents = {
        "player_0": ChattyAgent([[{"to": None, "text": "table!"}]]),
        "player_1": ChattyAgent(),
        "player_2": ChattyAgent(),
    }
    streamed: list[str] = []
    store = FolderRecordingStore(tmp_path, on_line=streamed.append)
    entry = make_chat_entry(players=("player_0", "player_1", "player_2"), n_ticks=3)
    run_episode(
        entry,
        {player: AgentPlayer(agent) for player, agent in agents.items()},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
        player_attribution={
            player: {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}
            for player in ("player_0", "player_1", "player_2")
        },
    )
    on_disk = (tmp_path / "r" / "recording.jsonl").read_bytes()
    assert "".join(streamed).encode("utf-8") == on_disk
    assert b'"recipients"' not in on_disk
    assert agents["player_0"].inboxes == [[]]
    assert agents["player_1"].inboxes == [[{"from": "player_0", "to": None, "text": "table!", "tick": 0}]]
    assert agents["player_2"].inboxes == [[{"from": "player_0", "to": None, "text": "table!", "tick": 0}]]


# --- budgets and timing -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("length", "cost", "step_limit", "budget", "ticks", "reason", "timeouts"),
    [
        (2, 7, 1000, 120_000, 2, "terminated", 0),
        (10, 800, 1000, 2000, 3, "episode_limit", 0),
        (2, 70, 50, 120_000, 2, "terminated", 2),
    ],
)
def test_chat_ms_lands_in_recorded_timing(
    tmp_path: Path, length, cost, step_limit, budget, ticks, reason, timeouts
):
    clock = ManualClock()

    class ChoosingAgent(ChattyAgent):
        def act(self, observation: Any) -> int:
            return 1

    entry = make_chat_entry(players=("player_0",), n_ticks=length)
    store = FolderRecordingStore(tmp_path)
    result = run_episode(
        entry,
        {"player_0": AgentPlayer(ChoosingAgent([[{"to": None, "text": "x"}]], clock=clock, cost_ms=cost))},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=clock,
        step_limit_ms=step_limit,
        episode_limit_ms=budget,
        player_attribution={"player_0": {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}},
    )
    states = list(store.open("r").steps())
    assert [state["agents"]["player_0"]["action"] for state in states] == [1] * ticks
    assert [state["agents"]["player_0"]["timing"] for state in states] == [
        {"decision_ms": 0, "chat_ms": cost}
    ] * ticks
    assert states[0]["messages"] == [{"from": "player_0", "to": None, "text": "x"}]
    assert (result.ticks, result.reason, result.step_timeouts) == (ticks, reason, {"player_0": timeouts})
    assert result.failed_player == ("player_0" if reason == "episode_limit" else None)


def test_chat_crash_sets_failed_player():
    class CrashingChat:
        def reset(self, seed: int, observation: Any) -> None: ...

        def act(self, observation: Any) -> int:
            return 0

        def chat(self, inbox: Any) -> list:
            raise RuntimeError("boom")

    entry = make_chat_entry(players=("player_0",), n_ticks=3)
    episode = Episode(
        entry,
        {"player_0": AgentPlayer(CrashingChat())},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=ManualClock(),
    )
    episode.start()
    with pytest.raises(RuntimeError, match="boom"):
        episode.step_once()
    assert episode.failed_player == "player_0"


# --- human queue --------------------------------------------------------------------------------


def test_action_source_is_not_implicitly_used_as_a_message_source(tmp_path: Path):
    source = QueueSource([{"to": None, "text": "must stay queued"}])
    entry = make_chat_entry(players=("player_0",), n_ticks=1)
    store = FolderRecordingStore(tmp_path)
    run_episode(
        entry,
        {"player_0": ExternalPlayer(source)},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=ManualClock(),
        store=store,
        recording_id="r",
    )
    assert [state.get("messages", []) for state in store.open("r").steps()] == [[]]
    assert source.take_messages("player_0") == [{"to": None, "text": "must stay queued"}]


def test_human_queue_is_drained_on_an_agent_boundary_and_delivered_later(tmp_path: Path):
    # The designated human may compose during player_0's turn. The next completed boundary admits
    # it, records it, then delays visibility until the recipient acts later.
    receiver = ChattyAgent()
    source = QueueSource(
        [
            {
                "to": "player_0",
                "text": "from the human",
            }
        ]
    )
    store = FolderRecordingStore(tmp_path)
    entry = make_chat_entry(players=("player_0", "player_1"), n_ticks=4)
    run_episode(
        entry,
        {
            "player_0": AgentPlayer(receiver),
            "player_1": ExternalPlayer(source, message_source=source),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
        external_chat_player="player_1",
        player_attribution={
            "player_0": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            },
            "player_1": {
                "kind": "human",
                "label": "Human",
            },
        },
    )
    recording = store.open("r")
    states = list(recording.steps())
    assert states[0]["messages"] == [{"from": "player_1", "to": "player_0", "text": "from the human"}]
    assert states[0]["chat_options"] == {
        "sender": "player_1",
        "target_recipients": ["player_0"],
        "default_recipient": None,
    }
    # The human frame was invisible to player_0's hook on this boundary and reaches it next turn.
    assert receiver.inboxes[0] == []
    assert receiver.inboxes[1] == [
        {"from": "player_1", "to": "player_0", "text": "from the human", "tick": 0}
    ]


def test_human_frame_arriving_after_the_atomic_drain_waits_for_the_next_boundary(tmp_path: Path, capsys: Any):
    source = QueueSource()

    class ArrivingDuringChat(ChattyAgent):
        def chat(self, inbox: Any) -> list | None:
            if not self.inboxes:
                source.queue({"to": "player_0", "text": "after the drain"})
            return super().chat(inbox)

    receiver = ArrivingDuringChat()
    entry = make_chat_entry(n_ticks=3)
    store = FolderRecordingStore(tmp_path)
    run_episode(
        entry,
        {"player_0": AgentPlayer(receiver), "player_1": ExternalPlayer(source, message_source=source)},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
        external_chat_player="player_1",
        player_attribution={
            "player_0": {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"},
            "player_1": {"kind": "human", "label": "Human"},
        },
    )
    assert [state.get("messages", []) for state in store.open("r").steps()] == [
        [],
        [{"from": "player_1", "to": "player_0", "text": "after the drain"}],
        [],
    ]
    assert receiver.inboxes == [
        [],
        [{"from": "player_1", "to": "player_0", "text": "after the drain", "tick": 1}],
    ]
    assert "chat:" not in capsys.readouterr().err


def test_human_and_agent_messages_share_one_boundary_in_human_then_agent_order(tmp_path: Path):
    sender = ChattyAgent([[{"to": None, "text": "agent says"}]])
    source = QueueSource([{"to": None, "text": "human says"}])
    entry = make_chat_entry(n_ticks=1)
    store = FolderRecordingStore(tmp_path)
    run_episode(
        entry,
        {"player_0": AgentPlayer(sender), "player_1": ExternalPlayer(source, message_source=source)},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
        external_chat_player="player_1",
        player_attribution={
            "player_0": {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"},
            "player_1": {"kind": "human", "label": "Human"},
        },
    )
    assert next(store.open("r").steps())["messages"] == [
        {"from": "player_1", "to": None, "text": "human says"},
        {"from": "player_0", "to": None, "text": "agent says"},
    ]
    assert sender.inboxes == [[]]


def test_no_hook_chat_options_use_canonical_recipients_and_broadcast_default():
    source = QueueSource()
    entry = make_chat_entry(players=("player_0", "player_1", "player_2"), n_ticks=2)
    episode = Episode(
        entry,
        {
            "player_0": ExternalPlayer(source, message_source=source),
            "player_1": AgentPlayer(SilentAgent()),
            "player_2": AgentPlayer(SilentAgent()),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=ManualClock(),
        external_chat_player="player_0",
    )
    episode.start()
    assert episode.opening_state()["chat_options"] == {  # type: ignore[index]
        "sender": "player_0",
        "target_recipients": ["player_1", "player_2"],
        "default_recipient": None,
    }
    episode.close()


def test_explicit_designated_sender_allows_chat_with_multiple_external_players(tmp_path: Path):
    first_source = QueueSource([{"to": None, "text": "not designated"}])
    designated_source = QueueSource([{"to": "player_0", "text": "designated"}])
    entry = make_chat_entry(n_ticks=1)
    store = FolderRecordingStore(tmp_path)
    with Episode(
        entry,
        {
            "player_0": ExternalPlayer(first_source, message_source=first_source),
            "player_1": ExternalPlayer(designated_source, message_source=designated_source),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=ManualClock(),
        store=store,
        recording_id="r",
        external_chat_player="player_1",
    ) as episode:
        assert episode.external_chat_sender == "player_1"
        assert episode.opening_state()["chat_options"]["sender"] == "player_1"
        episode.step_once()
    assert next(store.open("r").steps())["messages"] == [
        {"from": "player_1", "to": "player_0", "text": "designated"}
    ]
    assert first_source.take_messages("player_0") == [{"to": None, "text": "not designated"}]
    assert designated_source.take_messages("player_1") == []


def test_an_inactive_human_sender_has_its_queue_drained_and_dropped(capsys: Any):
    """Once the human can no longer act, its frames are drained and dropped at each boundary.

    The queue is bounded by the transport, so nothing needs draining eagerly on the transition. What
    matters is that no frame from a departed sender is ever admitted, and that each drop says so.
    """
    source = QueueSource()

    class HumanTerminatingEnv(RoundRobinEnv):
        def step(self, action: Any) -> None:
            if self.agent_selection == "player_0" and not self.terminations["player_1"]:
                self.terminations["player_1"] = True
                source.queue({"to": "player_0", "text": "queued during transition"})
            super().step(action)

    entry = make_chat_entry(players=("player_0", "player_1"), n_ticks=3)
    entry = EnvironmentEntry(
        meta=entry.meta,
        make=lambda _parameters: HumanTerminatingEnv(["player_0", "player_1"], 3),
        default_action=entry.default_action,
        overlay=entry.overlay,
    )
    episode = Episode(
        entry,
        {
            "player_0": AgentPlayer(SilentAgent()),
            "player_1": ExternalPlayer(source, message_source=source),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=ManualClock(),
        external_chat_player="player_1",
    )
    episode.start()
    # player_0 acts and terminates player_1 on the way out, so this boundary's drain ran before the
    # frame existed. The recorded step carries nothing from the human.
    episode.step_once()
    assert source._drained is True
    assert source._frames == [{"to": "player_0", "text": "queued during transition"}]

    source.queue({"to": "player_0", "text": "queued after transition"})
    # player_1's required dead step neither drains the queue nor republishes a policy.
    episode.step_once()
    assert len(source._frames) == 2

    # The next completed boundary drains everything the departed sender left and drops all of it.
    episode.step_once()
    episode.close()
    assert source._frames == []
    assert "dropping inactive sender 'player_1'" in capsys.readouterr().err


def test_dead_steps_preserve_the_last_published_human_policy(tmp_path: Path, capsys: Any):
    class DeadStepChangesPolicy(RoundRobinEnv):
        after_dead_step = False

        def step(self, action: Any) -> None:
            if self.terminations[self.agent_selection]:
                self.after_dead_step = True
            elif self._i == 0:
                self.terminations["player_1"] = True
            super().step(action)

    def policy(env: DeadStepChangesPolicy, _sender: str) -> object:
        return {
            "target_recipients": () if env.after_dead_step else ("player_2",),
            "default_recipient": None if env.after_dead_step else "player_2",
        }

    env = DeadStepChangesPolicy(["player_0", "player_1", "player_2"], 4)
    env.chat_policy = lambda sender: policy(env, sender)
    entry = replace(
        make_chat_entry(players=("player_0", "player_1", "player_2")), make=lambda _parameters: env
    )
    source = QueueSource()
    store = FolderRecordingStore(tmp_path)
    with Episode(
        entry,
        {
            "player_0": ExternalPlayer(source, message_source=source),
            "player_1": AgentPlayer(SilentAgent()),
            "player_2": AgentPlayer(SilentAgent()),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
        external_chat_player="player_0",
        player_attribution={
            "player_0": {"kind": "human", "label": "Human"},
            **{
                player: {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}
                for player in ("player_1", "player_2")
            },
        },
    ) as episode:
        episode.step_once()
        source.queue({"to": "player_2", "text": "last published choice"})
        episode.step_once()
        assert episode.tick == 1
        episode.step_once()
    states = list(store.open("r").steps())
    assert [state["tick"] for state in states] == [0, 1]
    assert states[0]["chat_options"] == {
        "sender": "player_0",
        "target_recipients": ["player_2"],
        "default_recipient": "player_2",
    }
    assert states[1]["messages"] == [{"from": "player_0", "to": "player_2", "text": "last published choice"}]
    assert states[1]["chat_options"] == {
        "sender": "player_0",
        "target_recipients": [],
        "default_recipient": None,
    }
    assert "chat:" not in capsys.readouterr().err


def test_external_chat_uses_one_cached_policy_for_the_whole_boundary(tmp_path: Path, capsys: Any):
    def policy(env: RoundRobinEnv, _sender: str) -> object:
        recipient = "player_1" if env._i == 0 else "player_2"
        return {"target_recipients": (recipient,), "default_recipient": recipient}

    source = QueueSource(
        [
            {"to": "player_1", "text": "announced"},
            {"to": "player_2", "text": "future"},
            {"to": None, "text": "first broadcast"},
        ]
    )
    entry = make_chat_entry(players=("player_0", "player_1", "player_2"), chat_policy=policy)
    store = FolderRecordingStore(tmp_path)
    with Episode(
        entry,
        {
            "player_0": ExternalPlayer(source, message_source=source),
            "player_1": AgentPlayer(SilentAgent()),
            "player_2": AgentPlayer(SilentAgent()),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
        external_chat_player="player_0",
        player_attribution={
            "player_0": {"kind": "human", "label": "Human"},
            **{
                player: {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}
                for player in ("player_1", "player_2")
            },
        },
    ) as episode:
        assert episode.opening_state()["chat_options"] == {
            "sender": "player_0",
            "target_recipients": ["player_1"],
            "default_recipient": "player_1",
        }
        episode.step_once()
        for frame in [
            {"to": "player_2", "text": "allowed"},
            {"to": "player_1", "text": "denied"},
            {"to": "player_2", "text": "duplicate"},
            {"to": None, "text": "broadcast"},
            {"to": None, "text": "second broadcast"},
        ]:
            source.queue(frame)
        episode.step_once()
    states = list(store.open("r").steps())
    assert [state["messages"] for state in states] == [
        [
            {"from": "player_0", "to": "player_1", "text": "announced"},
            {"from": "player_0", "to": None, "text": "first broadcast"},
        ],
        [
            {"from": "player_0", "to": "player_2", "text": "allowed"},
            {"from": "player_0", "to": None, "text": "broadcast"},
        ],
    ]
    assert [state["chat_options"] for state in states] == [
        {"sender": "player_0", "target_recipients": ["player_2"], "default_recipient": "player_2"}
    ] * 2
    diagnostic = capsys.readouterr().err
    assert "policy-disallowed" in diagnostic
    assert "second message to player_2" in diagnostic
    assert "second broadcast" in diagnostic


@pytest.mark.parametrize("human", [False, True])
def test_agent_output_uses_the_same_live_recipient_policy(tmp_path: Path, capsys: Any, human):
    batch = [
        {"to": "player_1", "text": "allowed"},
        {"to": "player_2", "text": "disallowed"},
        {"to": None, "text": "broadcast"},
    ]
    source = QueueSource(batch)
    entry = make_chat_entry(
        players=("player_0", "player_1", "player_2"),
        n_ticks=1,
        chat_policy=lambda _env, _sender: {
            "target_recipients": ("player_1",),
            "default_recipient": "player_1",
        },
    )
    store = FolderRecordingStore(tmp_path)
    run_episode(
        entry,
        {
            "player_0": ExternalPlayer(source, message_source=source)
            if human
            else AgentPlayer(ChattyAgent([batch])),
            "player_1": AgentPlayer(SilentAgent()),
            "player_2": AgentPlayer(SilentAgent()),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
        external_chat_player="player_0" if human else None,
        player_attribution={
            player: {"kind": "human", "label": "Human"}
            if human and player == "player_0"
            else {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}
            for player in ("player_0", "player_1", "player_2")
        },
    )
    assert next(store.open("r").steps())["messages"] == [
        {"from": "player_0", "to": "player_1", "text": "allowed"},
        {"from": "player_0", "to": None, "text": "broadcast"},
    ]
    assert "policy-disallowed" in capsys.readouterr().err


@pytest.mark.parametrize(
    ("declared", "diagnostic"),
    [
        ("raises", "environment policy failed"),
        ("self", "sender as one of its own"),
        (
            {"target_recipients": ("player_0", "player_0"), "default_recipient": "missing"},
            "same recipient twice",
        ),
        ({"target_recipients": ("player_9",), "default_recipient": None}, "unknown recipient"),
        ({"target_recipients": (1,), "default_recipient": None}, "non-string recipient"),
        ({"target_recipients": (), "default_recipient": "player_1"}, "which it does not offer"),
        (ChatPolicy(target_recipients=None, default_recipient=None), "not a sequence"),
        ({"target_recipients": ("player_1",)}, "wrong shape"),
    ],
)
def test_raising_policy_hook_uses_the_generic_default_without_failing(
    tmp_path: Path, capsys: Any, declared, diagnostic
):
    def policy(_env: RoundRobinEnv, sender: str) -> object:
        if declared == "raises":
            raise RuntimeError("broken hook")
        if declared == "self":
            return {"target_recipients": (sender,), "default_recipient": None}
        return declared

    source = QueueSource()
    entry = make_chat_entry(n_ticks=2, chat_policy=policy)
    store = FolderRecordingStore(tmp_path)
    with Episode(
        entry,
        {
            "player_0": ExternalPlayer(source, message_source=source),
            "player_1": AgentPlayer(ChattyAgent([[{"to": "player_0", "text": "fallback"}]])),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
        external_chat_player="player_0",
        player_attribution={
            "player_0": {"kind": "human", "label": "Human"},
            "player_1": {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"},
        },
    ) as episode:
        assert episode.opening_state()["chat_options"] == {
            "sender": "player_0",
            "target_recipients": ["player_1"],
            "default_recipient": None,
        }
        while not episode.done:
            episode.advance()
    assert list(store.open("r").steps())[1]["messages"] == [
        {"from": "player_1", "to": "player_0", "text": "fallback"}
    ]
    assert episode.result().failed_player is None
    errors = capsys.readouterr().err
    assert diagnostic in errors
    assert "using the default policy" in errors


# --- messaging off is byte-identical ------------------------------------------------------------


def _run_recording(root: Path, *, messaging_meta: bool, messaging_cfg: bool | None) -> bytes:
    entry = make_chat_entry(players=("player_0", "player_1"), n_ticks=4, messaging=messaging_meta)
    store = FolderRecordingStore(root)

    class DisabledChat(SilentAgent):
        def chat(self, inbox: Any) -> list:
            raise AssertionError("disabled messaging invoked chat")

    sender = DisabledChat()
    run_episode(
        entry,
        {"player_0": AgentPlayer(sender), "player_1": AgentPlayer(SilentAgent())},
        parameters=resolve_parameters(entry.meta),
        seed=7,
        store=store,
        recording_id="r",
        clock=ManualClock(),
        messaging=messaging_cfg,
        player_attribution={
            "player_0": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            },
            "player_1": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            },
        },
    )
    return (root / "r" / "recording.jsonl").read_bytes()


@pytest.mark.parametrize(("metadata", "configured"), [(False, None), (False, True), (True, False)])
def test_messaging_off_by_meta_or_config_is_byte_identical(tmp_path: Path, metadata, configured):
    disabled = _run_recording(tmp_path / "off", messaging_meta=False, messaging_cfg=None)
    configured_bytes = _run_recording(
        tmp_path / "configured", messaging_meta=metadata, messaging_cfg=configured
    )
    assert configured_bytes == disabled
    assert b'"messages"' not in configured_bytes


def test_enabled_but_chatless_is_byte_identical_to_disabled(tmp_path: Path):
    disabled = _run_recording(tmp_path / "off", messaging_meta=False, messaging_cfg=None)
    entry = make_chat_entry(n_ticks=4)
    store = FolderRecordingStore(tmp_path / "on")
    run_episode(
        entry,
        {"player_0": AgentPlayer(SilentAgent()), "player_1": AgentPlayer(SilentAgent())},
        parameters=resolve_parameters(entry.meta),
        seed=7,
        store=store,
        recording_id="r",
        clock=ManualClock(),
        player_attribution={
            player: {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}
            for player in ("player_0", "player_1")
        },
    )
    assert (tmp_path / "on" / "r" / "recording.jsonl").read_bytes() == disabled
    agents = [
        agent for state in store.open("r").steps() for agent in state["agents"].values() if "action" in agent
    ]
    assert len(agents) == 4
    assert [agent["timing"] for agent in agents] == [{"decision_ms": 0}] * 4


@pytest.mark.parametrize("human", [False, True])
@pytest.mark.parametrize(
    ("metadata_cap", "configured_cap", "accepted_texts"),
    [
        (3, None, ["😀😀😀"]),
        (3, 5, ["😀😀😀"]),
        (5, 3, ["😀😀😀"]),
        (None, 3, ["😀😀😀"]),
        (5, None, ["😀😀😀", "😀😀😀😀"]),
        (None, None, ["😀😀😀", "😀😀😀😀"]),
    ],
)
def test_effective_message_cap_only_tightens_the_environment_limit(
    tmp_path: Path, capsys: Any, human, metadata_cap, configured_cap, accepted_texts
):
    batch = [{"to": "player_1", "text": "😀😀😀"}, {"to": None, "text": "😀😀😀😀"}]
    source = QueueSource(batch)
    entry = make_chat_entry(n_ticks=1, message_cap=metadata_cap)
    store = FolderRecordingStore(tmp_path)
    result = run_episode(
        entry,
        {
            "player_0": ExternalPlayer(source, message_source=source)
            if human
            else AgentPlayer(ChattyAgent([batch])),
            "player_1": AgentPlayer(SilentAgent()),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
        message_cap=configured_cap,
        external_chat_player="player_0" if human else None,
        player_attribution={
            "player_0": {"kind": "human", "label": "Human"}
            if human
            else {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"},
            "player_1": {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"},
        },
    )
    assert [message["text"] for message in next(store.open("r").steps())["messages"]] == accepted_texts
    assert result.reason == "terminated"
    assert result.failed_player is None
    errors = capsys.readouterr().err
    if accepted_texts == ["😀😀😀"]:
        assert "4 code points over the cap of 3" in errors
    else:
        assert "chat:" not in errors
