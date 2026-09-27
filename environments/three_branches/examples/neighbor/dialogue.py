"""Conversation: answer the visitor in character without ever making a routine tick wait.

A reply from the LLM API takes much longer than one tick, so the request runs in the background
with ``BackgroundLLM`` while the resident carries on with its day. A conversation goes like this:

1. The visitor says something. ``receive`` keeps their newest line waiting.
2. ``reply`` sends the waiting line to the LLM, unless a request is already running.
3. On a later tick, ``reply`` finds the answer and returns it as a chat message.

A resident only talks while the visitor can hear it. If the visitor walks out of hearing range,
or behind a wall, the waiting line and any answer still on its way are dropped. When the LLM
cannot answer (it is not set up, or the budget ran out), the resident says ``FALLBACK`` instead.

To change how residents talk, start with ``_messages``, which writes the prompt.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from sandbox.llm import BackgroundLLM
from sandbox.village import day, me, people

# The longest line a resident sends, in characters.
MAX_LINE_LENGTH = 200
# What a resident says when the LLM cannot answer.
FALLBACK = "I need to get back to my work, but it is good to see you."


class Dialogue:
    """One resident's side of the conversation with the visitor."""

    def __init__(self, persona: str) -> None:
        # Who the resident is, in a few words, such as "the grower of Three Branches".
        self.persona = persona
        self.llm = BackgroundLLM()
        # The newest observation. Replies are checked against it, never against an older one.
        self.latest: Mapping[str, object] | None = None
        # The visitor's newest line that has not been sent to the LLM yet.
        self.waiting: str | None = None
        # True when the visitor left while a request was running, so its answer must be dropped.
        self.invalidated = False

    def observe(self, observation: Mapping[str, object]) -> None:
        """Remember this tick's observation. The agent calls this on every tick."""
        self.latest = observation
        if not self._visitor_nearby():
            self.waiting = None
            self.invalidated = self.invalidated or self.llm.requesting

    def receive(self, inbox: object) -> None:
        """Keep the visitor's newest line from this tick's messages, replacing any older one."""
        if not isinstance(inbox, Sequence) or isinstance(inbox, str | bytes):
            return
        for message in inbox:
            if isinstance(message, Mapping) and people.is_visitor(str(message.get("from"))):
                text = _clean(message.get("text"))
                if text:
                    self.waiting = text

    def reply(self) -> dict[str, str] | None:
        """Return a chat message for the visitor when an answer is ready, or ``None``.

        Call this once per tick. Each call does at most one of these things: drop everything
        because the visitor cannot hear, return an answer (or ``FALLBACK``), or start a request.
        """
        # The visitor cannot hear this resident, so there is nobody to answer.
        if not self._visitor_nearby():
            self.waiting = None
            self.llm.response()  # throw away any finished answer
            self.llm.error = None
            return None

        # The last request failed. Apologize with FALLBACK, unless it was for an earlier visit.
        if self.llm.error is not None:
            self.llm.error = None
            if self.invalidated:
                self.invalidated = False
                return None
            return {"to": "player_0", "text": FALLBACK}

        # An answer arrived. Say it, unless the visitor left while it was being written.
        completed = self.llm.response()
        if completed is not None:
            if self.invalidated:
                self.invalidated = False
                return None
            return {"to": "player_0", "text": _clean(completed) or FALLBACK}

        # Nothing to answer yet, or a request is already running: wait.
        if self.waiting is None or self.llm.requesting:
            return None

        # Send the waiting line. The answer shows up on a later tick.
        line = self.waiting
        self.waiting = None
        self.invalidated = False
        try:
            self.llm.request(model="small", messages=self._messages(line))
        except Exception:
            # The request could not even start, for example because the LLM API is not set up.
            return {"to": "player_0", "text": FALLBACK}
        return None

    def _messages(self, visitor_line: str) -> list[dict[str, str]]:
        """Write the prompt: who the resident is, what it can perceive, and what the visitor said.

        The model only knows what this prompt tells it. Adding more of the observation here (the
        resident's job, what it is doing, the props it can see) gives it more to talk about.
        """
        observation = self.latest
        assert observation is not None
        position = me.position(observation)
        visible = ", ".join(str(person["id"]) for person in people.seen(observation)) or "nobody"
        state = (
            f"You are {self.persona}. It is {day.phase(observation)}. You are at "
            f"({position['x']:.1f}, {position['y']:.1f}). "
            f"You can see {visible}. Reply in one short in-character sentence using only this state."
        )
        return [{"role": "system", "content": state}, {"role": "user", "content": visitor_line}]

    def _visitor_nearby(self) -> bool:
        """Return whether the visitor can hear this resident: within hearing range, no wall between."""
        return self.latest is not None and any(
            people.is_visitor(str(person["id"])) for person in people.nearby(self.latest)
        )


def _clean(value: object) -> str:
    """Collapse runs of whitespace into single spaces and cut the line to ``MAX_LINE_LENGTH``."""
    return " ".join(str(value or "").split())[:MAX_LINE_LENGTH]
