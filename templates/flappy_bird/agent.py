"""Your agent.

The template starts as a working agent: it flaps whenever the bird is below the middle of the
screen, so it holds its height at mid-screen. Run ``python -m sandbox play`` to watch it and
``python -m sandbox test`` to check it; both work before you change anything. Your job starts at the
``TODO(you)`` comment inside ``act``.

``environment.md``, shipped alongside this file, walks through building this exact agent and then
goes deeper into the helpers, the scoring, and the 12-number observation.

The only thing you may import from the sandbox is the ``sandbox.features`` helper module, and only at
the top of this file. It gives readable names to the 12 observation numbers and the two actions, so
``act`` reads ``player_y(observation)`` instead of a bare ``observation[9]``. Everything else you
develop against vanilla PettingZoo, and the server runs this exact class through the same interface.
The optional hooks (``learn`` and ``chat``) are detected by presence, so leave them commented unless
you use them. Episode state belongs in ``reset``; the constructor takes no arguments.
"""

from sandbox.features import FLAP, IDLE, player_y


class Agent:
    """Flaps whenever the bird is below the middle of the screen."""

    def reset(self, seed: int) -> None:
        # Called once before each episode. This agent keeps no state between
        # steps, so there is nothing to prepare here; a learning agent would
        # reset its memory in this method.
        pass

    def act(self, observation) -> int:
        # player_y is the bird's height as a fraction of the screen, where 0 is
        # the top and 1 is the bottom, so a larger value means lower on the
        # screen.
        below_middle = player_y(observation) > 0.5

        # TODO(you): this is the whole strategy: flap when the bird sits below
        # mid-screen, otherwise let it fall. It holds a steady height but never
        # looks at the pipes, so it crashes at the first gap that is not at the
        # middle of the screen. The "Your first improvement" section of
        # environment.md walks you through fixing that.
        return FLAP if below_middle else IDLE

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
