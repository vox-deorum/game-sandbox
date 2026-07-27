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

A card is a small object such as ``{"suit": 2, "rank": 14}``. Its rank is the value printed on
the card (``11=J, 12=Q, 13=K, 14=A``). Your ``act`` method returns a whole-number action, which
you get by calling ``cards.play(card)`` on whichever card object you chose, or ``cards.bid(n)``
on whichever bid you chose.

The only thing you may import from the sandbox is the ``sandbox.cards`` helper module, and only at
the top of this file. It reads the observation for you, so ``act`` works with card objects, bid
numbers, and lists instead of internal arrays. The server runs this exact class through the same
interface. The optional hooks (``learn`` and ``chat``) are detected by presence, so leave them
commented unless you use them. Episode state belongs in ``reset``; the constructor takes no
arguments.
"""

from sandbox.cards import bid, is_bidding, legal_cards, play, rank_of


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
            # TODO(you): make this estimate depend on the cards in your hand.
            # Promise to take one trick. A bid of 0 is nil, a risky promise to
            # take none at all, so 1 is the smallest safe bid a simple agent
            # can make. bid(n) turns the bid into the integer act returns.
            return bid(1)

        # legal_cards reads the observation for you: every card object in this
        # list is a card you hold and may play right now, so the rules (follow
        # suit, spades not led until broken) are already taken care of.
        legal = legal_cards(observation)

        # TODO(you): improve this playing strategy too. Low cards rarely win
        # tricks, but a team that never wins tricks never makes its contract.
        # The "Your first improvement" section of environment.md starts with
        # bidding, then returns to card play. cards.play(card) turns your
        # chosen card object into the integer act() must return.
        return play(min(legal, key=rank_of))

    # Optional: a reinforcement-learning hook called after every step with that step's
    # transition. Its time counts against your timing and episode budget.
    #
    # def learn(self, observation, action: int, reward: float, terminated: bool) -> None:
    #     ...

    # Optional: messaging. Spades enables it, so you may talk to the table. On your turn, right
    # after act and before the trick resolves, the harness calls chat with messages sent to you since
    # your last turn. Return messages with a recipient and text. Use None as the recipient to broadcast
    # to the whole table, or a player ID such as "player_2" to send directly. You may send one message
    # per recipient and one broadcast per turn. By default, text is limited to 120 characters as counted
    # by the system. cards.partner_player(observation) returns your partner's number during act; format
    # that number as f"player_{number}" for a direct message. Every message is recorded and shown in
    # replays, so nothing you send is ever secret. Return nothing to stay silent.
    #
    # def chat(self, inbox: list[dict]) -> list[dict] | None:
    #     ...
