"""Message routing and validation for the optional ``chat`` hook.

This is the correctness core of agent communication, deliberately separate from the session
loop: every outbound rule in the communication spec is enforced here at one point, so the
session loop only ever hands a validated batch to the recording and the router only ever
decides delivery. The module imports nothing from :mod:`session` or :mod:`live_io` so it stays
cycle-free; it needs only the :class:`~game_sandbox_harness.state.Message` shape.

A :class:`ChatRouter` exists only when messaging is effectively enabled for the episode (the
environment metadata and the session config agree). With messaging off, no router is created and
the loop is byte-identical to a pre-chat run.

Validation is a drop-with-diagnostic discipline, never a raise: a chatty agent's malformed
message must not take down the session, exactly as an illegal *action* is charged and refused
without smearing the fault across every seat. Rejections print one stderr diagnostic (the
harness never configures logging, so an INFO record would be silently dropped) and continue.
"""

from __future__ import annotations

import sys
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, cast

from .state import Message


def _diag(message: str) -> None:
    """Write a chat diagnostic to stderr (the harness never configures logging)."""
    print(message, file=sys.stderr, flush=True)


class ChatRouter:
    """Routes and validates messages for one episode's slots.

    Owns the pending inboxes only; the accepted batch for a tick is returned to the caller
    (the :class:`~game_sandbox_harness.session.Episode`), which records it and hands it back to
    :meth:`deliver` at the end of the step. The cap counts Unicode code points (``len(text)`` on a
    Python ``str``), pinned here so both sides of every boundary agree.
    """

    def __init__(self, slot_ids: Iterable[str], cap: int | None) -> None:
        self._slots = frozenset(slot_ids)
        self._cap = cap
        self._inboxes: dict[str, list[dict[str, Any]]] = {slot_id: [] for slot_id in self._slots}

    def validate_outgoing(self, sender: str, batch: object) -> list[Message]:
        """Validate one batch an agent or human returned, stamping ``from`` with ``sender``.

        Returns the accepted messages in order. Every rejected message is dropped with a stderr
        diagnostic and never raises. Enforced, in order: the recipient is a known slot other than
        the sender or ``None`` for broadcast; the text is a ``str`` within the code-point cap; and a
        batch carries at most one message per distinct recipient plus one broadcast.
        """
        # "returns messages or nothing": None or an empty batch is silent, not an error.
        if batch is None:
            return []
        if isinstance(batch, (str, bytes)) or not isinstance(batch, Sequence):
            _diag(f"chat: {sender} returned a non-list batch {type(batch).__name__}; dropping it")
            return []

        accepted: list[Message] = []
        seen: set[str | None] = set()
        for raw_item in cast("Sequence[object]", batch):
            if not isinstance(raw_item, Mapping):
                _diag(f"chat: {sender} sent a non-object message {raw_item!r}; dropping it")
                continue
            item = cast("Mapping[str, object]", raw_item)
            to = item.get("to")
            # A bool is an int, never a str, so a bool recipient falls through the str check below.
            if to is not None and (not isinstance(to, str) or to not in self._slots):
                _diag(f"chat: {sender} sent to unknown recipient {to!r}; dropping it")
                continue
            if to == sender:
                _diag(f"chat: {sender} sent to itself; dropping it")
                continue
            text = item.get("text")
            # A non-str text (including a bool, which is an int, not a str) is dropped here.
            if not isinstance(text, str):
                _diag(f"chat: {sender} sent non-string text {text!r}; dropping it")
                continue
            if self._cap is not None and len(text) > self._cap:
                _diag(f"chat: {sender} sent {len(text)} code points over the cap of {self._cap}; dropping it")
                continue
            if to in seen:
                where = "broadcast" if to is None else f"message to {to}"
                _diag(f"chat: {sender} sent a second {where} in one turn; dropping it")
                continue
            seen.add(to)
            accepted.append({"from": sender, "to": to, "text": text})
        return accepted

    def deliver(self, messages: list[Message], tick: int) -> None:
        """Deliver a tick's accepted messages to pending inboxes, stamping each with ``tick``.

        A targeted message reaches its recipient's inbox; a broadcast reaches every slot except the
        sender. Called at the end of the sending tick, after the acting agent's inbox was drained,
        so a message sent on tick T is first seen strictly after T.
        """
        for message in messages:
            sender = message["from"]
            recipient = message["to"]
            item = {**message, "tick": tick}
            if recipient is None:
                for slot_id in self._slots:
                    if slot_id != sender:
                        self._inboxes[slot_id].append(dict(item))
            else:
                self._inboxes[recipient].append(item)

    def drain(self, slot_id: str) -> list[dict[str, Any]]:
        """Return and clear a slot's pending inbox.

        Called on every acting slot's turn, chat-less agents included, so an inbox can never grow
        without bound behind an agent that will never read it.
        """
        inbox = self._inboxes[slot_id]
        self._inboxes[slot_id] = []
        return inbox
