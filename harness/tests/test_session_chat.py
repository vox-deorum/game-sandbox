"""The chat loop integration: hook order, next-turn delivery, budgets, and the human queue.

Own multiplayer fixtures so ``test_session.py`` stays untouched. A round-robin AEC env cycles the
players for a fixed number of ticks, so a player gets several turns and a message sent on tick T can be
observed on the recipient's *next* turn. All on ``ManualClock``.
"""

from __future__ import annotations

from collections.abc import Callable
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
    REASON_EPISODE_LIMIT,
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


def make_chat_entry(
    players: tuple[str, ...] = ("player_0", "player_1"),
    n_ticks: int = 4,
    *,
    messaging: bool = True,
    message_cap: int | None = None,
    step_log: list[Any] | None = None,
    chat_policy: Callable[[RoundRobinEnv, str], object] | None = None,
) -> EnvironmentEntry:
    meta = EnvironmentMeta(
        env_id="chat-fake",
        display_name="Chat Fake",
        description="A deterministic round-robin fake with messaging.",
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

    def reset(self, seed: int) -> None:
        self._log.append(("reset", seed))

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
        batches: list[list[dict]] | None = None,
        *,
        clock: ManualClock | None = None,
        cost_ms: int = 0,
    ) -> None:
        self._batches = batches or []
        self._clock = clock
        self._cost = cost_ms
        self.inboxes: list[list[dict]] = []

    def reset(self, seed: int) -> None:
        self._turn = 0

    def act(self, observation: Any) -> int:
        return 0

    def chat(self, inbox: Any) -> list:
        self.inboxes.append(list(inbox))
        if self._clock is not None and self._cost:
            self._clock.advance(self._cost)
        batch = self._batches[self._turn] if self._turn < len(self._batches) else []
        self._turn += 1
        return batch


class SilentAgent:
    """A chat-less, learn-less agent: only the required interface."""

    def reset(self, seed: int) -> None: ...

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

    def get_action(self, player_id: str, observation: Any, deadline_ms: int | None) -> Any:
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
    # reset first, then per tick: act, chat, the env step, learn.
    assert log[0] == ("reset", 1)
    first_tick = log[1:5]
    assert [entry[0] for entry in first_tick] == ["act", "chat", "step", "learn"]


# --- delivery timing ----------------------------------------------------------------------------


def test_message_is_delivered_next_turn_never_on_the_sending_tick():
    # player_0 sends to player_1 on its first turn (tick 0). player_1 must not see it on tick 0 (it
    # does not act then); it sees it on its own next turn, tagged with the sending tick.
    sender = ChattyAgent([[{"to": "player_1", "text": "hi partner"}]])
    receiver = ChattyAgent()
    entry = make_chat_entry(players=("player_0", "player_1"), n_ticks=4)
    run_episode(
        entry,
        {"player_0": AgentPlayer(sender), "player_1": AgentPlayer(receiver)},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=ManualClock(),
    )
    # player_1's first inbox (its first turn, tick 1) carries the message stamped with tick 0.
    assert receiver.inboxes[0] == [{"from": "player_0", "to": "player_1", "text": "hi partner", "tick": 0}]
    # The sender never received its own message.
    assert all(item == [] for item in sender.inboxes)


def test_broadcast_reaches_every_other_player_but_not_the_sender():
    sender = ChattyAgent([[{"to": None, "text": "table!"}]])
    b = ChattyAgent()
    c = ChattyAgent()
    entry = make_chat_entry(players=("player_0", "player_1", "player_2"), n_ticks=6)
    run_episode(
        entry,
        {
            "player_0": AgentPlayer(sender),
            "player_1": AgentPlayer(b),
            "player_2": AgentPlayer(c),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=ManualClock(),
    )
    broadcast = {"from": "player_0", "to": None, "text": "table!", "tick": 0}
    assert b.inboxes[0] == [broadcast]
    assert c.inboxes[0] == [broadcast]
    assert all(item == [] for item in sender.inboxes)


# --- chat-less agent ----------------------------------------------------------------------------


def test_chatless_agent_is_never_called_and_charged_nothing(tmp_path: Path):
    # player_1 is chat-less; player_0 sends it a message every one of its turns. The chat-less player's
    # recorded steps carry no chat_ms, and its inbox is drained (never accumulated) on every turn,
    # because the loop calls drain unconditionally before the has_chat check.
    sender = ChattyAgent([[{"to": "player_1", "text": "a"}], [{"to": "player_1", "text": "b"}]])
    store = FolderRecordingStore(tmp_path)
    entry = make_chat_entry(players=("player_0", "player_1"), n_ticks=4)
    run_episode(
        entry,
        {"player_0": AgentPlayer(sender), "player_1": AgentPlayer(SilentAgent())},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
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
    recording = store.open("r")
    for state in recording.steps():
        for player_id, agent in state["agents"].items():
            if player_id == "player_1":
                assert "chat_ms" not in agent.get("timing", {})


# --- budgets and timing -------------------------------------------------------------------------


def test_chat_ms_lands_in_recorded_timing(tmp_path: Path):
    clock = ManualClock()
    sender = ChattyAgent([[{"to": "player_1", "text": "x"}]], clock=clock, cost_ms=7)
    store = FolderRecordingStore(tmp_path)
    entry = make_chat_entry(players=("player_0", "player_1"), n_ticks=2)
    run_episode(
        entry,
        {"player_0": AgentPlayer(sender), "player_1": AgentPlayer(ChattyAgent())},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=clock,
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
    recording = store.open("r")
    first = next(recording.steps())
    assert first["agents"]["player_0"]["timing"]["chat_ms"] == 7


def test_chat_that_busts_the_episode_limit_charges_the_player():
    clock = ManualClock()
    # Each chat costs 800ms; the cumulative budget is 2000ms, so the third turn trips the limit.
    slow = ChattyAgent(clock=clock, cost_ms=800)
    entry = make_chat_entry(players=("player_0",), n_ticks=10)
    result = run_episode(
        entry,
        {"player_0": AgentPlayer(slow)},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=clock,
        episode_limit_ms=2000,
    )
    assert result.reason == REASON_EPISODE_LIMIT
    assert result.failed_player == "player_0"


def test_chat_crash_sets_failed_player():
    class CrashingChat:
        def reset(self, seed: int) -> None: ...

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


def test_action_source_is_not_implicitly_used_as_a_message_source():
    source = QueueSource([{"player": "player_0", "tick": 0, "to": None, "text": "must stay queued"}])
    entry = make_chat_entry(players=("player_0",), n_ticks=1)

    run_episode(
        entry,
        {"player_0": ExternalPlayer(source)},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=ManualClock(),
    )

    assert source._drained is False


def test_human_queue_is_drained_once_per_stepped_tick_and_delivered_next(tmp_path: Path):
    # A human player (player_1) queues a message against the state published after player_0 acts. It is
    # drained only when player_1 becomes the current external actor, then delivered on player_0's turn.
    receiver = ChattyAgent()
    source = QueueSource(
        [
            {
                "player": "player_1",
                "tick": 0,
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
    assert "messages" not in states[0]
    assert states[0]["chat_options"] == {
        "sender": "player_1",
        "target_recipients": ["player_0"],
        "default_recipient": None,
    }
    # The human message is recorded on its own turn, then delivered to the agent on tick 2.
    assert states[1]["messages"] == [{"from": "player_1", "to": "player_0", "text": "from the human"}]
    assert receiver.inboxes[1] == [
        {"from": "player_1", "to": "player_0", "text": "from the human", "tick": 1}
    ]


def test_human_chat_accepts_the_previous_opportunity_once_when_it_races_the_drain(
    tmp_path: Path,
    capsys: Any,
):
    receiver = ChattyAgent()
    source = QueueSource()
    store = FolderRecordingStore(tmp_path)
    entry = make_chat_entry(players=("player_0", "player_1"), n_ticks=5)
    episode = Episode(
        entry,
        {
            "player_0": ExternalPlayer(source, message_source=source),
            "player_1": AgentPlayer(receiver),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
        player_attribution={
            "player_0": {
                "kind": "human",
                "label": "Human",
            },
            "player_1": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            },
        },
    )
    episode.start()
    episode.step_once()
    source.queue(
        {
            "player": "player_0",
            "tick": 0,
            "to": "player_1",
            "text": "arrived after the drain",
        }
    )
    episode.step_once()
    episode.step_once()

    # The one-drain grace is consumed there. Replaying the same tick afterward remains stale.
    source.queue(
        {
            "player": "player_0",
            "tick": 0,
            "to": "player_1",
            "text": "arrived two drains late",
        }
    )
    episode.step_once()
    episode.step_once()
    episode.close()

    states = list(store.open("r").steps())
    assert states[2]["messages"] == [
        {
            "from": "player_0",
            "to": "player_1",
            "text": "arrived after the drain",
        }
    ]
    assert "messages" not in states[4]
    assert receiver.inboxes[1] == [
        {
            "from": "player_0",
            "to": "player_1",
            "text": "arrived after the drain",
            "tick": 2,
        }
    ]
    assert "stale external message" in capsys.readouterr().err


def test_human_queue_is_not_drained_on_an_agent_turn(tmp_path: Path):
    sender = ChattyAgent([[{"to": None, "text": "agent says"}]])
    source = QueueSource([{"player": "player_1", "tick": 0, "to": None, "text": "human says"}])
    store = FolderRecordingStore(tmp_path)
    entry = make_chat_entry(players=("player_0", "player_1"), n_ticks=1)
    run_episode(
        entry,
        {
            "player_0": AgentPlayer(sender),
            "player_1": ExternalPlayer(source, message_source=source),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
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
    first = next(recording.steps())
    assert [m["text"] for m in first["messages"]] == ["agent says"]
    assert source._drained is False


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
    )
    episode.start()
    assert episode.opening_state()["chat_options"] == {  # type: ignore[index]
        "sender": "player_0",
        "target_recipients": ["player_1", "player_2"],
        "default_recipient": None,
    }
    episode.close()


def test_human_chat_checks_sender_tick_and_announced_policy_at_drain(
    tmp_path: Path,
    capsys: Any,
):
    source = QueueSource(
        [
            {"player": "player_0", "tick": 0, "to": "player_1", "text": "partner"},
            {"player": "player_0", "tick": 0, "to": None, "text": "table"},
            {"player": "player_0", "tick": 9, "to": "player_1", "text": "stale"},
            {"player": "player_2", "tick": 0, "to": "player_1", "text": "spoofed"},
            {"player": "player_0", "tick": 0, "to": "player_2", "text": "disallowed"},
        ]
    )
    store = FolderRecordingStore(tmp_path)
    entry = make_chat_entry(
        players=("player_0", "player_1", "player_2"),
        n_ticks=1,
        chat_policy=lambda _env, _sender: {
            "target_recipients": ("player_1",),
            "default_recipient": "player_1",
        },
    )
    run_episode(
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
        player_attribution={
            "player_0": {
                "kind": "human",
                "label": "Human",
            },
            "player_1": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            },
            "player_2": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            },
        },
    )
    first = next(store.open("r").steps())
    assert [message["text"] for message in first["messages"]] == ["partner", "table"]
    diagnostic = capsys.readouterr().err
    assert "stale external message" in diagnostic
    assert "spoofed or inactive" in diagnostic
    assert "policy-disallowed" in diagnostic


def test_external_chat_enforces_the_policy_announced_for_the_turn_once(
    tmp_path: Path,
    capsys: Any,
):
    calls: list[str] = []

    def alternating_policy(_env: RoundRobinEnv, sender: str) -> object:
        calls.append(sender)
        recipient = "player_1" if len(calls) == 1 else "player_2"
        return {
            "target_recipients": (recipient,),
            "default_recipient": recipient,
        }

    source = QueueSource(
        [
            {"player": "player_0", "tick": 0, "to": "player_1", "text": "announced"},
            {"player": "player_0", "tick": 0, "to": "player_2", "text": "would be next"},
        ]
    )
    store = FolderRecordingStore(tmp_path)
    entry = make_chat_entry(
        players=("player_0", "player_1", "player_2"),
        n_ticks=1,
        chat_policy=alternating_policy,
    )
    episode = Episode(
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
        player_attribution={
            "player_0": {
                "kind": "human",
                "label": "Human",
            },
            "player_1": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            },
            "player_2": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            },
        },
    )

    episode.start()
    assert episode.opening_state()["chat_options"] == {  # type: ignore[index]
        "sender": "player_0",
        "target_recipients": ["player_1"],
        "default_recipient": "player_1",
    }
    episode.step_once()
    episode.close()

    first = next(store.open("r").steps())
    assert [message["text"] for message in first["messages"]] == ["announced"]
    assert calls == ["player_0"]
    assert "policy-disallowed recipient 'player_2'" in capsys.readouterr().err


def test_external_chat_grace_uses_each_announced_policy(
    tmp_path: Path,
    capsys: Any,
):
    calls: list[str] = []

    def alternating_policy(_env: RoundRobinEnv, sender: str) -> object:
        calls.append(sender)
        recipient = "player_1" if len(calls) == 1 else "player_2"
        return {
            "target_recipients": (recipient,),
            "default_recipient": recipient,
        }

    source = QueueSource()
    store = FolderRecordingStore(tmp_path)
    entry = make_chat_entry(
        players=("player_0", "player_1", "player_2"),
        n_ticks=4,
        chat_policy=alternating_policy,
    )
    episode = Episode(
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
        player_attribution={
            "player_0": {
                "kind": "human",
                "label": "Human",
            },
            "player_1": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            },
            "player_2": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            },
        },
    )

    episode.start()
    episode.step_once()
    episode.step_once()
    episode.step_once()
    source.queue({"player": "player_0", "tick": 2, "to": "player_2", "text": "new allowed"})
    source.queue({"player": "player_0", "tick": 0, "to": "player_1", "text": "old allowed"})
    source.queue({"player": "player_0", "tick": 2, "to": "player_1", "text": "new denied"})
    source.queue({"player": "player_0", "tick": 0, "to": "player_2", "text": "old denied"})
    source.queue({"player": "player_0", "tick": 2, "to": None, "text": "new broadcast"})
    source.queue({"player": "player_0", "tick": 0, "to": None, "text": "old broadcast"})
    episode.step_once()
    episode.close()

    states = list(store.open("r").steps())
    assert [message["text"] for message in states[3]["messages"]] == [
        "new allowed",
        "old allowed",
        "new broadcast",
    ]
    assert calls == ["player_0", "player_0"]
    diagnostic = capsys.readouterr().err
    assert diagnostic.count("policy-disallowed") == 2
    assert "sent a second broadcast" in diagnostic


def test_agent_output_uses_the_same_live_recipient_policy(tmp_path: Path, capsys: Any):
    sender = ChattyAgent(
        [
            [
                {"to": "player_1", "text": "allowed"},
                {"to": "player_2", "text": "disallowed"},
                {"to": None, "text": "broadcast"},
            ]
        ]
    )
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
            "player_0": AgentPlayer(sender),
            "player_1": AgentPlayer(SilentAgent()),
            "player_2": AgentPlayer(SilentAgent()),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
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
            "player_2": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            },
        },
    )
    first = next(store.open("r").steps())
    assert [message["text"] for message in first["messages"]] == ["allowed", "broadcast"]
    assert "policy-disallowed" in capsys.readouterr().err


def test_raising_policy_hook_uses_the_generic_default_without_failing(
    tmp_path: Path,
    capsys: Any,
):
    def raising_policy(_env: RoundRobinEnv, _sender: str) -> object:
        raise RuntimeError("broken hook")

    sender = ChattyAgent([[{"to": "player_1", "text": "fallback"}]])
    store = FolderRecordingStore(tmp_path)
    entry = make_chat_entry(
        players=("player_0", "player_1"),
        n_ticks=1,
        chat_policy=raising_policy,
    )
    result = run_episode(
        entry,
        {
            "player_0": AgentPlayer(sender),
            "player_1": AgentPlayer(SilentAgent()),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
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

    first = next(store.open("r").steps())
    assert first["messages"] == [{"from": "player_0", "to": "player_1", "text": "fallback"}]
    assert result.failed_player is None
    diagnostic = capsys.readouterr().err
    assert "environment policy failed" in diagnostic
    assert "using the default policy" in diagnostic


def test_malformed_policy_falls_back_for_agent_output_and_external_options(
    tmp_path: Path,
    capsys: Any,
):
    entry = make_chat_entry(
        players=("player_0", "player_1"),
        n_ticks=2,
        chat_policy=lambda _env, _sender: {
            "target_recipients": ("player_0", "player_0"),
            "default_recipient": "missing",
        },
    )
    source = QueueSource()
    episode = Episode(
        entry,
        {
            "player_0": ExternalPlayer(source, message_source=source),
            "player_1": AgentPlayer(ChattyAgent([[{"to": "player_0", "text": "fallback"}]])),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=FolderRecordingStore(tmp_path),
        recording_id="r",
        clock=ManualClock(),
        player_attribution={
            "player_0": {
                "kind": "human",
                "label": "Human",
            },
            "player_1": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            },
        },
    )
    episode.start()
    opening = episode.opening_state()
    assert opening is not None
    assert opening["chat_options"]["target_recipients"] == ["player_1"]
    assert opening["chat_options"]["default_recipient"] is None
    episode.step_once()
    episode.step_once()
    episode.close()
    states = list(FolderRecordingStore(tmp_path).open("r").steps())
    assert states[1]["messages"][0]["text"] == "fallback"
    assert "using the default policy" in capsys.readouterr().err


@pytest.mark.parametrize(
    "policy",
    [
        ChatPolicy(target_recipients=None, default_recipient=None),  # type: ignore[arg-type]
        {"target_recipients": ("player_1",)},
    ],
)
def test_malformed_policy_objects_never_end_the_episode(policy: object, capsys: Any):
    entry = make_chat_entry(
        players=("player_0", "player_1"),
        n_ticks=1,
        chat_policy=lambda _env, _sender: policy,
    )
    source = QueueSource()
    episode = Episode(
        entry,
        {
            "player_0": ExternalPlayer(source, message_source=source),
            "player_1": AgentPlayer(SilentAgent()),
        },
        parameters=resolve_parameters(entry.meta),
        seed=1,
        clock=ManualClock(),
    )
    episode.start()
    assert episode.opening_state()["chat_options"] == {  # type: ignore[index]
        "sender": "player_0",
        "target_recipients": ["player_1"],
        "default_recipient": None,
    }
    episode.step_once()
    episode.close()
    assert "using the default policy" in capsys.readouterr().err


# --- messaging off is byte-identical ------------------------------------------------------------


def _run_recording(root: Path, *, messaging_meta: bool, messaging_cfg: bool | None) -> bytes:
    entry = make_chat_entry(players=("player_0", "player_1"), n_ticks=4, messaging=messaging_meta)
    store = FolderRecordingStore(root)
    # A chatting agent that WOULD send if messaging were on, to prove the off path is inert.
    sender = ChattyAgent([[{"to": "player_1", "text": "hi"}]])
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


def test_messaging_off_by_meta_or_config_is_byte_identical(tmp_path: Path):
    by_meta = _run_recording(tmp_path / "meta", messaging_meta=False, messaging_cfg=None)
    by_config = _run_recording(tmp_path / "config", messaging_meta=True, messaging_cfg=False)
    assert by_meta == by_config
    # No messages line was ever written when messaging is off.
    assert b'"messages"' not in by_meta


def test_enabled_but_chatless_is_byte_identical_to_disabled(tmp_path: Path):
    # A messaging-enabled session whose agents never chat produces the same bytes as a disabled one,
    # proving the hook is free for a chat-less roster.
    disabled = _run_recording(tmp_path / "off", messaging_meta=False, messaging_cfg=None)

    entry = make_chat_entry(players=("player_0", "player_1"), n_ticks=4, messaging=True)
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
    enabled_chatless = (tmp_path / "on" / "r" / "recording.jsonl").read_bytes()
    assert enabled_chatless == disabled


# --- the documented template contract, executed against the real harness ------------------------


def test_documented_chat_contract_runs_against_the_real_harness(tmp_path: Path):
    """The spec-required stub verification: an agent implementing exactly the shapes the template
    stub documents (``chat(self, inbox)`` receiving ``{"from","to","text","tick"}`` items and
    returning ``[{"to": ..., "text": ...}]``) is accepted and recorded verbatim by a real Episode."""
    seen_inbox_keys: list[frozenset[str]] = []

    class DocumentedAgent:
        """Sends one targeted message on its first turn, then records the keys of each inbox item."""

        def reset(self, seed: int) -> None:
            self._sent = False

        def act(self, observation):
            return 0

        def chat(self, inbox):
            for item in inbox:
                seen_inbox_keys.append(frozenset(item.keys()))
            if not self._sent:
                self._sent = True
                return [{"to": "player_1", "text": "hello"}]
            return None

    store = FolderRecordingStore(tmp_path)
    entry = make_chat_entry(players=("player_0", "player_1"), n_ticks=4)
    # player_1 replies to player_0, so the documented agent actually receives an inbox item to inspect.
    replier = ChattyAgent([[{"to": "player_0", "text": "hi back"}]])
    run_episode(
        entry,
        {"player_0": AgentPlayer(DocumentedAgent()), "player_1": AgentPlayer(replier)},
        parameters=resolve_parameters(entry.meta),
        seed=1,
        store=store,
        recording_id="r",
        clock=ManualClock(),
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
    # The message the documented agent returned was accepted and recorded verbatim on its sending tick.
    first = next(store.open("r").steps())
    assert first["messages"] == [{"from": "player_0", "to": "player_1", "text": "hello"}]
    # It received player_1's reply, and every inbox item carried exactly the four documented keys.
    assert seen_inbox_keys
    assert all(keys == frozenset({"from", "to", "text", "tick"}) for keys in seen_inbox_keys)
