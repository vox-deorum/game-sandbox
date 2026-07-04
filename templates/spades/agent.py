"""Your agent.

Implement the two required methods. The optional ``learn`` hook is shown commented out: the harness
detects it *by presence*, so leaving it commented means "this agent does not learn" and the harness
will not spend time calling it. Uncomment and implement it only if you want it.

The only thing you may import from the sandbox is the ``sandbox.cards`` helper module, and only at
the top of this file (a commented import is ready below). It is plain Python that decodes the action
encoding and reads the observation for you, so ``act`` can work with card ids, bid numbers, and lists
instead of raw NumPy arrays. Everything else you develop against vanilla PettingZoo, and the server
runs this exact class through the same interface. Episode state belongs in ``reset``; the constructor
takes no arguments.

Spades in one paragraph: four seats in two partnerships — you and the seat across from you (seat
``(you + 2) % 4``) are a team, against the other two. A hand has two phases. First everyone **bids**
the number of tricks they expect to take, an integer ``0..13`` where ``0`` is *nil* (a promise to
take none, worth a hundred points won or lost). Then thirteen **tricks** are played: follow the led
suit if you can, and you may not lead a spade until spades are "broken" (one has been played), unless
your hand is nothing but spades. A trick is won by the highest spade in it, or, if no spade was
played, the highest card of the led suit. Your team scores ten points per bid trick when it makes its
combined contract (plus one per overtrick "bag"), or loses ten per bid trick when it falls short.
The full rules, the action encoding, and every observation field are in ``environment.md``, shipped
alongside this file.
"""

from __future__ import annotations

from typing import Any

# Uncomment to use the provided card helpers, for example:
#   from sandbox.cards import is_bidding, legal_bids, legal_cards, bid_to_action, rank_of
# then in act: during bidding return bid_to_action(min(legal_bids(observation))), and during play
# play your lowest legal card with min(legal_cards(observation), key=rank_of).


class Agent:
    """A Spades agent that plays one seat at the table across both phases of a hand.

    Your ``act`` returns a single integer from the combined ``Discrete(66)`` action space:

    * During the **bidding round**, return a bid encoded as ``52 + k`` for a bid of ``k`` tricks
      (``0..13``). ``sandbox.cards.bid_to_action(k)`` builds it, and ``legal_bids(observation)`` lists
      the bids you may make (every bid ``0..13`` is legal).
    * During **play**, return a card id ``0..51`` with ``card = suit * 13 + rank``. Suits are
      ``0=clubs, 1=diamonds, 2=spades, 3=hearts``; ranks run ``0=2 .. 8=10, 9=J, 10=Q, 11=K,
      12=A``. So the 2 of clubs is ``0`` and the ace of spades is ``38``.

    ``observation`` is a dict with an ``"action_mask"`` (length-66; ``mask[a] == 1`` exactly for the
    actions you may take now, and **you must return an action whose bit is set**) and an
    ``"observation"`` holding the table state (your hand, the bids, the current trick, the led suit,
    tricks won, and more). The ``sandbox.cards`` helpers read all of this for you:
    ``is_bidding(observation)`` tells you which phase it is, ``legal_bids`` / ``legal_cards`` give the
    legal actions, and ``partner_of(my_seat(observation))`` names your partner. The Spades page above
    documents every field in full.
    """

    def reset(self, seed: int) -> None:
        """Prepare for a new game. The same seed the environment got is passed here, so a
        stochastic agent can be made reproducible. Called once before the first ``act``."""
        raise NotImplementedError("implement Agent.reset")

    def act(self, observation: Any) -> int:
        """Return your action: a bid ``52 + k`` while bidding, or a card ``0..51`` during play.

        It must be legal: ``observation['action_mask'][action] == 1``.
        """
        raise NotImplementedError("implement Agent.act")

    # Optional: a reinforcement-learning hook called after every step with that step's
    # transition. Its time counts against your timing and episode budget.
    #
    # def learn(self, observation: Any, action: int, reward: float, terminated: bool) -> None:
    #     ...
