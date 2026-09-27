"""Conversation: answer the visitor and the neighbors without ever making a routine tick wait.

A resident hears two kinds of speaker: the visitor (``player_0``) and the other residents. Both go
through the same steps:

1. Someone says something to this resident. ``receive`` keeps each speaker's newest line waiting.
2. ``messages`` answers one waiting line per tick, the visitor's first. ``scripted_answer`` decides
   how: it returns a line to say right away, or ``None`` to ask the LLM instead.
3. An LLM answer takes much longer than one tick, so ``BackgroundLLM`` writes it in the background
   while the resident carries on with its day. ``messages`` sends it on a later tick.

The agent can also start a conversation with ``say``, as ``agent.py`` does at the midday meeting.

As shipped, the visitor gets LLM answers and neighbors get canned ones. That way ten residents
chatting at midday spend no LLM budget. To let the LLM talk with neighbors too, change
``scripted_answer``. Two residents who always answer each other would talk forever, so a resident
says at most ``NEIGHBOR_TURNS`` lines to one neighbor until that neighbor walks away.

A resident only talks to someone who can hear it: within hearing range, with no wall between.
When a speaker walks away, their waiting line and any answer still on its way are dropped. When
the LLM cannot answer (it is not set up, or the budget ran out), the resident says ``FALLBACK``.

Who sees what: watchers and replays show every line, but the visitor only sees lines addressed to
them and lines said to everyone (``say(None, ...)``). A neighbor chat sent directly, as below, is
part of the village's life for watchers rather than for the visitor.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from sandbox.llm import BackgroundLLM
from sandbox.village import day, me, people

# The longest line a resident sends, in characters. The game allows 200.
MAX_LINE_LENGTH = 200
# What a resident says when the LLM cannot answer.
FALLBACK = "I need to get back to my work, but it is good to see you."
# The canned lines of the midday small talk.
GOOD_DAY = "Good day."
GOOD_DAY_REPLY = "Good day to you."
# The most lines a resident says to one neighbor before that neighbor walks away. With 1, a
# greeting gets one answer and the conversation ends there.
NEIGHBOR_TURNS = 1

# A chat message: who it is for (a player id, or None for everyone in hearing) and what it says.
Message = dict[str, str | None]


class Dialogue:
    """One resident's side of every conversation it is part of."""

    def __init__(self, persona: str) -> None:
        # Who the resident is, in a few words, such as "a resident who works at the stall".
        self.persona = persona
        self.llm = BackgroundLLM()
        # The newest observation. Everything is checked against it, never against an older one.
        self.latest: Mapping[str, object] | None = None
        # Each speaker's newest line that has not been answered yet, keyed by player id.
        self.waiting: dict[str, str] = {}
        # Lines queued with ``say``, sent on the next call to ``messages``.
        self.outbox: list[Message] = []
        # Who the running LLM request is answering, or None when nobody is still listening.
        self.asking: str | None = None
        # How many lines this resident has said to each listener since they came within hearing.
        self.turns: dict[str, int] = {}

    def observe(self, observation: Mapping[str, object]) -> None:
        """Remember this tick's observation, and forget everyone who can no longer hear us.

        The agent calls this on every tick, before ``say`` and ``messages``.
        """
        self.latest = observation
        listeners = self._listeners()
        self.waiting = {speaker: line for speaker, line in self.waiting.items() if speaker in listeners}
        self.turns = {speaker: count for speaker, count in self.turns.items() if speaker in listeners}
        # The request keeps running, but its answer is dropped when it arrives.
        if self.asking not in listeners:
            self.asking = None

    def receive(self, inbox: Sequence[Mapping[str, object]]) -> None:
        """Keep each speaker's newest line from this tick's messages, replacing any older one."""
        for message in inbox:
            speaker = str(message["from"])
            text = _clean(message.get("text"))
            # A neighbor's line to everyone is overheard, not answered, or a crowd would all answer
            # at once. The visitor usually talks to everyone nearby, so their lines always count.
            if text and (message.get("to") is not None or people.is_visitor(speaker)):
                self.waiting[speaker] = text

    def say(self, to: str | None, text: str) -> bool:
        """Queue a line for this tick, to one player id or to everyone in hearing (``None``).

        Returns ``False`` without queueing when the line cannot go out this tick: the listener
        cannot hear us, this resident owes them an answer, or it already has a line for them. The
        game takes one line per listener, plus one line for everyone, per tick.
        """
        owes_answer = to is not None and (to in self.waiting or to == self.asking)
        if owes_answer or any(line["to"] == to for line in self.outbox):
            return False
        if to is not None and to not in self._listeners():
            return False
        self.outbox.append(self._line(to, text))
        return True

    def messages(self) -> list[Message]:
        """Return this tick's lines: everything queued with ``say``, then at most one answer."""
        lines, self.outbox = self.outbox, []
        answer = self._answer(busy={line["to"] for line in lines})
        return lines if answer is None else [*lines, answer]

    def scripted_answer(self, speaker: str, text: str) -> str | None:
        """Return a line to answer with right away, or ``None`` to ask the LLM instead.

        This is the switch between scripted and LLM dialogue. Return a line for anything a script
        handles well, such as a greeting or a question about the way to the inn, and ``None`` for
        everything else.
        """
        del text  # the shipped script answers every neighbor the same way
        return None if people.is_visitor(speaker) else GOOD_DAY_REPLY

    def _answer(self, busy: set[str | None]) -> Message | None:
        """Finish or start one answer. ``busy`` names listeners who already get a line this tick."""
        # A request is running, or it just finished or failed.
        if self.llm.requesting or self.llm.error is not None:
            text = FALLBACK if self.llm.error is not None else self.llm.response()
            if text is None:
                return None  # still being written
            self.llm.error = None
            speaker, self.asking = self.asking, None
            # The speaker may have walked away while the answer was being written.
            return None if speaker is None else self._line(speaker, _clean(text) or FALLBACK)

        # Nothing is running, so answer the next waiting line. The visitor goes first.
        speakers = [speaker for speaker in self.waiting if speaker not in busy]
        if not speakers:
            return None
        speaker = next((speaker for speaker in speakers if people.is_visitor(speaker)), speakers[0])
        line = self.waiting.pop(speaker)
        if not people.is_visitor(speaker) and self.turns.get(speaker, 0) >= NEIGHBOR_TURNS:
            return None  # this conversation has run its course

        scripted = self.scripted_answer(speaker, line)
        if scripted is not None:
            return self._line(speaker, scripted)
        try:
            self.llm.request(model="small", messages=self._messages(speaker, line))
        except Exception:
            # The request could not even start, for example because the LLM API is not set up.
            return self._line(speaker, FALLBACK)
        self.asking = speaker
        return None

    def _messages(self, speaker: str, heard: str) -> list[dict[str, str]]:
        """Write the prompt: who the resident is, what it can perceive, and what it just heard.

        The model only knows what this prompt tells it. Adding more of the observation here (what
        the resident is doing, the props it can see) gives it more to talk about.
        """
        observation = self.latest
        assert observation is not None
        position = me.position(observation)
        visible = ", ".join(str(person["id"]) for person in people.seen(observation)) or "nobody"
        partner = "the visitor" if people.is_visitor(speaker) else f"your neighbor {speaker}"
        state = (
            f"You are {self.persona}. It is {day.phase(observation)}. You are at "
            f"({position['x']:.1f}, {position['y']:.1f}). You can see {visible}. "
            f"You are talking with {partner}. Reply in one short in-character sentence using only "
            "this state."
        )
        return [{"role": "system", "content": state}, {"role": "user", "content": heard}]

    def _line(self, to: str | None, text: str) -> Message:
        """Build a chat message and count it as one of this resident's turns with ``to``."""
        if to is not None:
            self.turns[to] = self.turns.get(to, 0) + 1
        return {"to": to, "text": _clean(text)}

    def _listeners(self) -> set[str]:
        """Return who can hear this resident: within hearing range, with no wall between."""
        if self.latest is None:
            return set()
        return {str(person["id"]) for person in people.nearby(self.latest)}


def _clean(value: object) -> str:
    """Collapse runs of whitespace into single spaces and cut the line to ``MAX_LINE_LENGTH``."""
    return " ".join(str(value or "").split())[:MAX_LINE_LENGTH]
