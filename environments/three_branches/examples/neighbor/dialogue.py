"""One non-blocking, grounded conversation controller for a village resident."""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from sandbox.llm import BackgroundLLM
from sandbox.village import people

MAX_LINE_LENGTH = 200
FALLBACK = "I need to get back to my work, but it is good to see you."


class Dialogue:
    """Keep one visitor line waiting while ``BackgroundLLM`` owns the request thread."""

    def __init__(self, persona: str) -> None:
        self.persona = persona
        self.llm = BackgroundLLM()
        self.latest: Mapping[str, object] | None = None
        self.waiting: str | None = None
        self.invalidated = False

    def observe(self, observation: Mapping[str, object]) -> None:
        """Remember the only observation that may authorise a request or reply."""
        self.latest = observation
        if not self._visitor_nearby():
            self.waiting = None
            self.invalidated = self.invalidated or self.llm.requesting

    def receive(self, inbox: object) -> None:
        """Keep only the visitor's newest line. The request starts from ``reply``."""
        if not isinstance(inbox, Sequence) or isinstance(inbox, str | bytes):
            return
        for message in inbox:
            if isinstance(message, Mapping) and message.get("from") == "player_0":
                text = _line(message.get("text"))
                if text:
                    self.waiting = text

    def reply(self):
        """Return one raw direct chat dictionary when a valid response is ready."""
        if not self._visitor_nearby():
            self.waiting = None
            self.llm.response()
            self.llm.error = None
            return None
        if self.llm.error is not None:
            self.llm.error = None
            if self.invalidated:
                self.invalidated = False
                return None
            return {"to": "player_0", "text": FALLBACK}
        completed = self.llm.response()
        if completed is not None:
            if self.invalidated or not self._visitor_nearby():
                self.invalidated = False
                return None
            return {"to": "player_0", "text": _line(completed) or FALLBACK}
        if self.waiting is None or self.llm.requesting:
            return None
        line = self.waiting
        self.waiting = None
        self.invalidated = False
        try:
            started = self.llm.request(model="small", messages=self._messages(line))
        except Exception:
            return {"to": "player_0", "text": FALLBACK}
        if not started:
            return None
        return None

    def _messages(self, visitor_line: str) -> list[dict[str, str]]:
        observation = self.latest
        assert observation is not None
        self_record = observation["self"]
        visible = ", ".join(str(person["id"]) for person in people.seen(observation)) or "nobody"
        state = (
            f"You are {self.persona}. It is {observation['phase']}. You are at "
            f"({float(self_record['position']['x']):.1f}, {float(self_record['position']['y']):.1f}). "
            f"You can see {visible}. Reply in one short in-character sentence using only this state."
        )
        return [{"role": "system", "content": state}, {"role": "user", "content": visitor_line}]

    def _visitor_nearby(self) -> bool:
        return self.latest is not None and any(
            person["id"] == "player_0" for person in people.nearby(self.latest)
        )


def _line(value: object) -> str:
    return " ".join(str(value or "").split())[:MAX_LINE_LENGTH]
