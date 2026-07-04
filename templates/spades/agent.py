"""Your agent.

The template starts as a working agent: it bids one trick, then always plays its lowest-ranked
legal card. Run ``python -m sandbox play`` to watch it and ``python -m sandbox test`` to check it;
both work before you change anything. Your job starts at the ``TODO(you)`` comment inside ``act``.

Spades in one paragraph: four seats in two partnerships, you and the seat across from you (seat
``(you + 2) % 4``) are a team, against the other two. A hand has two phases. First everyone **bids**
the number of tricks they expect to take, an integer ``0..13`` where ``0`` is *nil* (a promise to
take none, worth a hundred points won or lost). Then thirteen **tricks** are played: follow the led
suit if you can, and you may not lead a spade until spades are "broken" (one has been played), unless
your hand is nothing but spades. A trick is won by the highest spade in it, or, if no spade was
played, the highest card of the led suit. Your team scores ten points per bid trick when it makes its
combined contract (plus one per overtrick "bag"), or loses ten per bid trick when it falls short.
``environment.md``, shipped alongside this file, walks through building this exact agent and then
goes deeper into the rules, the action encoding, and every observation field.

The only thing you may import from the sandbox is the ``sandbox.cards`` helper module, and only at
the top of this file. It is plain Python that decodes the action encoding and reads the observation
for you, so ``act`` works with card ids, bid numbers, and lists instead of raw NumPy arrays.
Everything else you develop against vanilla PettingZoo, and the server runs this exact class through
the same interface. The optional ``learn`` hook is detected by presence, so leave it commented unless
you use it. Episode state belongs in ``reset``; the constructor takes no arguments.
"""

from sandbox.cards import bid_to_action, is_bidding, legal_cards, rank_of


class Agent:
    """Bids one trick, then always plays its lowest-ranked legal card."""

    def reset(self, seed: int) -> None:
        # Called once before each hand. This agent keeps no state between turns,
        # so there is nothing to prepare here; a learning agent would reset its
        # memory in this method.
        pass

    def act(self, observation) -> int:
        # A hand has two phases, and is_bidding tells you which one this turn
        # belongs to: first everyone bids, then thirteen tricks are played.
        if is_bidding(observation):
            # Promise to take one trick. A bid of 0 is nil, a risky promise to
            # take none at all, so 1 is the smallest safe bid a simple agent
            # can make. bid_to_action turns the bid into the integer act returns.
            return bid_to_action(1)

        # legal_cards reads the action mask for you: every card ID in this list
        # is a card you hold and may play right now, so the rules (follow suit,
        # spades not led until broken) are already taken care of.
        legal = legal_cards(observation)

        # TODO(you): this is the whole playing strategy. Low cards rarely win
        # tricks, but a team that never wins tricks never makes its contract.
        # Count what your hand is worth before bidding, and win tricks while
        # your team still needs them; the "Ideas and examples" section of
        # environment.md lists good next steps.
        return min(legal, key=rank_of)

    # Optional: a reinforcement-learning hook called after every step with that step's
    # transition. Its time counts against your timing and episode budget.
    #
    # def learn(self, observation, action: int, reward: float, terminated: bool) -> None:
    #     ...
