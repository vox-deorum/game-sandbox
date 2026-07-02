"""Your agent.

Implement the two required methods. The two optional hooks (``learn`` and ``chat``) are shown
commented out: the harness detects them *by presence*, so leaving them commented means "this
agent does not learn / does not chat" and the harness will not spend time calling them.
Uncomment and implement only the ones you want.

The only thing you may import from the sandbox is the ``sandbox.cards`` helper module, and only
at the top of this file (a commented import is ready below). It is plain Python that decodes the
card encoding and reads the observation for you, so ``act`` can work with card ids and lists
instead of raw NumPy arrays. Everything else you develop against vanilla PettingZoo, and the
server runs this exact class through the same interface. Episode state belongs in ``reset``; the
constructor takes no arguments.

Hearts in one paragraph: four seats, follow suit if you can, you cannot lead a heart until one
has been played ("hearts broken"), the 2 of clubs leads the first trick, and no penalty cards
land on that first trick. Every heart you take is worth 1 point and the queen of spades is 13;
a LOWER total is better. The exception is "shooting the moon", taking *every* heart and the
queen flips your score to 0 and gives everyone else 26. The full rules, the card encoding, and
every observation field are on the Hearts page: {{DOCS_URL}}students/environments/hearts/
"""

from __future__ import annotations

from typing import Any

# Uncomment to use the provided card helpers, for example:
#   from sandbox.cards import legal_cards, led_suit, rank_of
# then in act: play your lowest legal card with min(legal_cards(observation), key=rank_of).


class Agent:
    """A Hearts agent that plays one seat at the table.

    A card is an int ``0..51`` with ``card = suit * 13 + rank``. Suits are
    ``0=clubs, 1=diamonds, 2=spades, 3=hearts``; ranks run ``0=2 .. 8=10, 9=J, 10=Q, 11=K,
    12=A``. So the 2 of clubs is ``0`` and the queen of spades is ``36``.

    ``observation`` is a dict with an ``"action_mask"`` (length-52; ``mask[c] == 1`` exactly for
    the cards you may legally play, and **you must return a card whose bit is set**) and an
    ``"observation"`` holding the table state (your hand, the current trick, the led suit, and
    more). The ``sandbox.cards`` helpers read all of this for you: ``legal_cards(observation)``,
    ``led_suit(observation)``, ``current_trick(observation)``, and so on. The Hearts page above
    documents every field in full.
    """

    def reset(self, seed: int) -> None:
        """Prepare for a new game. The same seed the environment got is passed here, so a
        stochastic agent can be made reproducible. Called once before the first ``act``."""
        raise NotImplementedError("implement Agent.reset")

    def act(self, observation: Any) -> int:
        """Return a card to play. It must be legal: ``observation['action_mask'][card] == 1``."""
        raise NotImplementedError("implement Agent.act")

    # Optional: a reinforcement-learning hook called after every step with that step's
    # transition. Its time counts against your timing and episode budget.
    #
    # def learn(self, observation: Any, action: int, reward: float, terminated: bool) -> None:
    #     ...

    # Optional: a messaging hook (only used in environments with messaging enabled). Called
    # on your turn with the messages addressed to your slot; return messages to send, or
    # nothing to stay silent.
    #
    # def chat(self, inbox: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    #     ...
