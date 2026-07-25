"""Your agent.

The template starts as a working agent: it bids one trick, then always plays its lowest-ranked
legal card. Run ``python -m sandbox play`` to watch it and ``python -m sandbox test`` to check it;
both work before you change anything. Your job starts at the ``TODO(you)`` comment inside ``act``.

Spades in one paragraph: four players in two partnerships, you and the player across from you (player
``(you + 2) % 4``) are a team, against the other two. A hand has two phases. First everyone **bids**
the number of tricks they expect to take, an integer ``0..13`` where ``0`` is *nil* (a promise to
take none, worth a hundred points won or lost). Then thirteen **tricks** are played: follow the led
suit if you can, and you may not lead a spade until spades are "broken" (one has been played), unless
your hand is nothing but spades. A trick is won by the highest spade in it, or, if no spade was
played, the highest card of the led suit. Your team scores ten points per bid trick when it makes its
combined contract (plus one per overtrick "bag"), or loses ten per bid trick when it falls short.
``environment.md``, shipped alongside this file, walks through building this exact agent and then
goes deeper into the rules, the card encoding, and every observation field.

A card is a semantic object ``{"suit": 0..3, "rank": 2..14}`` where the rank is the face value
printed on the card (``11=J, 12=Q, 13=K, 14=A``). Your ``act`` method still returns an integer
action, which you get by calling ``cards.play(card)`` on whichever card object you chose, or
``cards.bid(n)`` on whichever bid you chose.

The only thing you may import from the sandbox is the ``sandbox.cards`` helper module, and only at
the top of this file. It is plain Python that decodes the action encoding and reads the observation
for you, so ``act`` works with card objects, bid numbers, and lists instead of raw NumPy arrays.
Everything else you develop against vanilla PettingZoo, and the server runs this exact class through
the same interface. The optional hooks (``learn`` and ``chat``) are detected by presence, so leave
them commented unless you use them. Episode state belongs in ``reset``; the constructor takes no
arguments.
"""

from sandbox.cards import bid, is_bidding, legal_cards, play


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
            # can make. bid(n) turns the bid into the integer act returns.
            return bid(1)

        # legal_cards reads the action mask for you: every card object in this
        # list is a card you hold and may play right now, so the rules (follow
        # suit, spades not led until broken) are already taken care of.
        legal = legal_cards(observation)

        # TODO(you): this is the whole playing strategy. Low cards rarely win
        # tricks, but a team that never wins tricks never makes its contract,
        # and the flat bid above never looks at the hand at all. The "Your
        # first improvement" section of environment.md shows you how to find
        # a better bid. cards.play(card) turns your chosen card object into
        # the integer act() must return.
        return play(min(legal, key=lambda c: c["rank"]))

    # Optional: a reinforcement-learning hook called after every step with that step's
    # transition. Its time counts against your timing and episode budget.
    #
    # def learn(self, observation, action: int, reward: float, terminated: bool) -> None:
    #     ...

    # Optional: messaging. Spades enables it, so you may talk to the table. On your turn, right
    # after act and before the trick resolves, the harness calls chat with your inbox: a list of
    # {"from": player, "to": player_or_None, "text": str, "tick": int} messages sent to you since your
    # last turn. Return a list of {"to": player_or_None, "text": str} to send ("to": None broadcasts
    # to the whole table, a player id sends only to that player), with at most one message per recipient
    # plus one broadcast per turn. Text is plain and capped at 120 Unicode code points. Your partner
    # is the player across, player_((your_player + 2) % 4); cards.partner_player(observation) returns that
    # player index during act. Every message is recorded and shown in replays, so nothing you send is
    # ever secret. Return nothing to stay silent.
    #
    # def chat(self, inbox: list[dict]) -> list[dict] | None:
    #     ...
