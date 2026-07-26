"""The chat loop integration: hook order, next-turn delivery, budgets, and the human queue.

Own multiplayer fixtures so ``test_session.py`` stays untouched. A round-robin AEC env cycles the
players for a fixed number of ticks, so a player gets several turns and a message sent on tick T can be
observed on the recipient's *next* turn. All on ``ManualClock``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import (
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


def make_chat_entry(
    players: tuple[str, ...] = ("player_0", "player_1"),
    n_ticks: int = 4,
    *,
    messaging: bool = True,
    message_cap: int | None = None,
    step_log: list[Any] | None = None,
) -> EnvironmentEntry:
    meta = EnvironmentMeta(
        env_id="chat-fake",
        display_name="Chat Fake",
        description="A deterministic round-robin fake with messaging.",
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
    return EnvironmentEntry(
        meta=meta,
        make=lambda _parameters: RoundRobinEnv(list(players), n_ticks, step_log),
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

    def __init__(self, frames: list[dict] | None = None) -> None:
        self._frames = list(frames or [])
        self._drained = False

    def get_action(self, player_id: str, observation: Any, deadline_ms: int | None) -> Any:
        return None

    def take_messages(self, player_id: str) -> list[dict]:
        if self._drained:
            return []
        self._drained = True
        return self._frames


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
    source = QueueSource([{"to": None, "text": "must stay queued"}])
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
    # A human player (player_1) queues a message; it is drained on the tick player_0 acts (not player_1's
    # turn), recorded there, and delivered to the agent on the agent's next turn.
    receiver = ChattyAgent()
    source = QueueSource([{"to": "player_0", "text": "from the human"}])
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
    )
    recording = store.open("r")
    states = list(recording.steps())
    # The human message was recorded on tick 0 (player_0's turn), stamped from player_1.
    assert states[0]["messages"] == [{"from": "player_1", "to": "player_0", "text": "from the human"}]
    # Delivered to the agent on its next turn (tick 2), tagged with tick 0.
    assert receiver.inboxes[1] == [
        {"from": "player_1", "to": "player_0", "text": "from the human", "tick": 0}
    ]


def test_agent_batch_is_ordered_before_the_human_batch_in_one_tick(tmp_path: Path):
    # On player_0's tick, both its own chat and the human queue produce a message. The recorded order
    # is deterministic: the acting agent's batch first, then external players in mapping order.
    sender = ChattyAgent([[{"to": None, "text": "agent says"}]])
    source = QueueSource([{"to": None, "text": "human says"}])
    store = FolderRecordingStore(tmp_path)
    entry = make_chat_entry(players=("player_0", "player_1"), n_ticks=2)
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
    )
    recording = store.open("r")
    first = next(recording.steps())
    assert [m["text"] for m in first["messages"]] == ["agent says", "human says"]


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
    )
    # The message the documented agent returned was accepted and recorded verbatim on its sending tick.
    first = next(store.open("r").steps())
    assert first["messages"] == [{"from": "player_0", "to": "player_1", "text": "hello"}]
    # It received player_1's reply, and every inbox item carried exactly the four documented keys.
    assert seen_inbox_keys
    assert all(keys == frozenset({"from", "to", "text", "tick"}) for keys in seen_inbox_keys)
