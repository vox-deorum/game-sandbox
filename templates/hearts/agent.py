"""Your agent.

The template starts as a working agent: it plays the lowest-ranked card that is legal right now.
Run ``python -m sandbox play`` to watch it and ``python -m sandbox test`` to check it; both work
before you change anything. Your job starts at the ``TODO(you)`` comment inside ``act``.

Hearts in one paragraph: four seats, follow suit if you can, you cannot lead a heart until one
has been played ("hearts broken"), the 2 of clubs leads the first trick, and no penalty cards
land on that first trick. Every heart you take is worth 1 point and the queen of spades is 13;
a LOWER total is better. The exception is "shooting the moon", taking *every* heart and the queen
flips your score to 0 and gives everyone else 26. ``environment.md``, shipped alongside this file,
walks through building this exact agent and then goes deeper into the rules, the card encoding,
and every observation field.

A card is a semantic object ``{"suit": 0..3, "rank": 2..14}`` where the rank is the face value
printed on the card (``11=J, 12=Q, 13=K, 14=A``). Your ``act`` method still returns an integer
action, which you get by calling ``cards.play(card)`` on whichever card object you chose.

The only thing you may import from the sandbox is the ``sandbox.cards`` helper module, and only at
the top of this file. It is plain Python that reads the observation for you, so ``act`` works with
card objects and lists instead of raw NumPy arrays. Everything else you develop against vanilla
PettingZoo, and the server runs this exact class through the same interface. The optional hooks
(``learn`` and ``chat``) are detected by presence, so leave them commented unless you use them.
Episode state belongs in ``reset``; the constructor takes no arguments.
"""

from sandbox.cards import legal_cards, play


class Agent:
    """Plays the lowest-ranked card that is legal right now."""

    def reset(self, seed: int) -> None:
        # Called once before each game. This agent keeps no state between turns,
        # so there is nothing to prepare here; a learning agent would reset its
        # memory in this method.
        pass

    def act(self, observation) -> int:
        # legal_cards reads the action mask for you: every card object in this
        # list is a card you hold and may play right now, so the rules (follow
        # suit, hearts not broken yet, no points on the first trick) are already
        # taken care of.
        legal = legal_cards(observation)

        # TODO(you): this one line is the whole strategy. Low cards rarely win
        # tricks, and tricks are how you collect penalty points, so playing the
        # lowest-ranked legal card is a sane start. It is also exactly how the
        # built-in opponents play. Replace it with something smarter; the
        # "Your first improvement" section of environment.md shows you how to
        # find one. cards.play(card) turns your chosen card object into the
        # integer act() must return.
        return play(min(legal, key=lambda c: c["rank"]))

    # Optional: a reinforcement-learning hook called after every step with that step's
    # transition. Its time counts against your timing and episode budget.
    #
    # def learn(self, observation, action: int, reward: float, terminated: bool) -> None:
    #     ...

    # Optional: a messaging hook (only used in environments with messaging enabled). Called
    # on your turn with the messages addressed to your slot; return messages to send, or
    # nothing to stay silent.
    #
    # def chat(self, inbox: list[dict]) -> list[dict] | None:
    #     ...
