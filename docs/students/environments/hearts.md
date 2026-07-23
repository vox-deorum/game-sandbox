# Hearts

Hearts is a four-player card game in which the goal is to finish with as few penalty points as possible. Every heart is worth 1 penalty point, and the queen of spades is worth 13. Your agent controls one of the four players. The [agent interface](../agent-interface.md) explains the parts that work the same in every environment, including the `reset` and `act` methods. This page explains everything specific to Hearts.

## How the game works

Each player receives 13 cards from a standard 52-card deck. Play happens in **tricks**. One player **leads** by playing the first card of a trick, then the other three players each play one card in clockwise order. The suit of the first card is the **led suit**. The highest card of that suit wins the trick, and that player takes all four cards and leads the next trick.

If you have a card of the led suit, you must play one. This is called **following suit**. If you have no card of that suit, you may play a card from another suit. A card from another suit cannot win the trick, so this is often a good chance to discard a dangerous card.

This environment uses these Hearts rules:

- The player holding the two of clubs leads it on the first trick.
- No heart or queen of spades may be played on the first trick unless the player has no other kind of card.
- A player may not lead a heart until hearts are **broken**, which means someone played a heart on an earlier trick. The queen of spades does not break hearts in this variant.

You do not need to reproduce these rules in your agent. Every observation includes an action mask that identifies the cards that are legal on the current turn.

If you have never played, the [Wikipedia article about Hearts](https://en.wikipedia.org/wiki/Hearts_%28card_game%29) provides a broader introduction.

## Your first agent

Your template already contains a complete, working agent, the one this section builds. It runs before you change anything, and the rest of this section explains it line by line so you can see exactly how a turn is decided.

On each of your turns the harness calls `act` with an observation of the table, and your job is to return the one card you want to play. You don't have to touch raw numbers to do it: the template's helper module turns the observation into card objects and plain Python values, and this agent uses just two of its helpers.

A card is a small object, `{"suit": 0..3, "rank": 2..14}`, where the rank is the face value printed on the card (`11` is the jack, `12` the queen, `13` the king, `14` the ace). So the queen of spades is `{"suit": 2, "rank": 12}`.

`legal_cards(observation)` gives you the list of card objects you are allowed to play this turn. It already accounts for every rule, following suit, not leading a heart before hearts are broken, and the first-trick restrictions, so every card it returns is a legal move.

A card object's `"rank"` entry is its face-value rank, from the two up to the ace, ignoring its suit. Passing `lambda c: c["rank"]` as the `key` to Python's built-in `min` picks the lowest-ranked card out of a list. The helper module also offers `rank_of(card)`, which reads the same value, if you prefer a named function over the lambda.

`play(card)` turns a card object into the integer your `act` method must return. You choose with card objects and convert to an action only at the very end, so you don't have to build that integer by hand.

The strategy is one idea: always play the lowest-ranked legal card. Low cards rarely win a trick, and in Hearts winning a trick is how you collect the penalty cards you want to avoid, so ducking low is a reasonable default. It is also exactly how the built-in opponents play, so any smarter idea you add is a real edge over them.

```python
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
```

This agent will not make an illegal move, because it only ever plays a card that came from `legal_cards`. You don't have to check the rules yourself; picking from that list is enough.

With the agent already in place, you can run it straight away from the template folder:

```console
python -m sandbox play    # watch it take a seat, in a window
python -m sandbox eval    # play several seeded games and report the mean score
python -m sandbox test    # run the checks, which pass before you change anything
```

`eval` reports a score you can read with the [Scoring and rewards](#scoring-and-rewards) section below, and `test` is green on the fresh template because this agent is already complete.

The `TODO(you)` comment inside `act` marks the one line where you take over. Everything above it is plumbing you can keep; the return statement is the decision to improve. When you are ready, the [Your first improvement](#your-first-improvement) section shows you how to find a smarter one yourself. In your own repository this page is the `environment.md` file, which is what the template's comments point to.

## Scoring and rewards

Each heart taken in a trick adds 1 penalty point, and the queen of spades adds 13. There are 26 penalty points available in one game. Lower is better.

**Shooting the moon** is the exception. If one player takes all 13 hearts and the queen of spades, that player finishes with 0 penalty points and each other player finishes with 26.

During play, every player receives a reward of `0.0` after each action. When the game ends, each player's reward is the negative of that player's final penalty score. This converts a lower-is-better card-game score into a higher-is-better reward:

| Final penalty score | Final reward |
| ------------------- | ------------ |
| `0`                 | `0.0`        |
| `5`                 | `-5.0`       |
| `13`                | `-13.0`      |
| `26`                | `-26.0`      |

After a successful moon shot, the shooter receives `0.0` and each other player receives `-26.0`. The `scores` observation shows raw penalty cards taken while the game is still running. The moon-shot adjustment is applied to the final score and reward when the game ends.

## The helper module

Your first agent used `sandbox.cards`, the template's plain Python helper module. Import what you need from it at the top of `agent.py`, not inside a method. It reads the observation for you and hands back card objects, lists, and plain Python values, so `act` doesn't have to touch a raw NumPy array or the action mask directly.

`legal_cards(observation)` returns a list of the card objects you may play, and the list is never empty on your turn. A card's `"rank"` entry is its face value, so `min(legal, key=lambda c: c["rank"])` selects the lowest-ranked legal card (`rank_of(card)` reads the same value), and `play(card)` turns the card you chose into the integer `act` returns. Because the choice always comes from `legal_cards`, an agent automatically follows suit and obeys the other rules.

The module provides these helpers and constants:

| Helper or constant | Result |
| --- | --- |
| `legal_cards(observation)` | Legal card objects for this turn |
| `play(card)` | The integer action for a card object, the value `act` returns |
| `hand_cards(observation)` | Every card object in your hand |
| `suit_of(card)` | A card object's suit ID, from `0` through `3` |
| `rank_of(card)` | A card object's face-value rank, from `2` (the two) through `14` (the ace) |
| `make_card(suit, rank)` | A card object `{"suit": suit, "rank": rank}` from a suit ID and face-value rank |
| `card_name(card)` | Readable text such as `"Q of spades"` |
| `card_points(card)` | `13` for the queen of spades, `1` for a heart, or `0` otherwise |
| `led_suit(observation)` | Led suit ID, or `None` when you are leading |
| `current_trick(observation)` | `(seat, card)` pairs in the order played |
| `trick_winner_so_far(observation)` | The currently winning `(seat, card)` pair, or `None` before any card is played |
| `hearts_broken(observation)` | `True` after hearts are broken, otherwise `False` |
| `my_seat(observation)` | Your seat ID |
| `scores(observation)` | Four running penalty scores indexed by seat |
| `CLUBS`, `DIAMONDS`, `SPADES`, `HEARTS` | Names for suit IDs `0`, `1`, `2`, and `3` |
| `TWO_OF_CLUBS`, `QUEEN_OF_SPADES` | The card objects `{"suit": 0, "rank": 2}` and `{"suit": 2, "rank": 12}` |

## Under the hood

Your first agent didn't have to touch a raw action integer or a raw observation array; the helpers handled both. This section is the full reference for what `act` returns and what the observation contains, for when you outgrow the helpers and want to read the table yourself.

Without the helpers, finding the legal cards means reading all 52 mask entries by hand:

```python
legal = [card for card in range(52) if observation["action_mask"][card] == 1]
return min(legal, key=lambda card: card % 13)
```

### Actions

Your `act` method returns one integer from `0` through `51`. The integer is a **card ID**, a label that identifies one card. Card IDs count upward through all clubs, then all diamonds, spades, and hearts:

| Suit | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | J | Q | K | A |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Clubs | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| Diamonds | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 |
| Spades | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 |
| Hearts | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 49 | 50 | 51 |

For example, card `0` is the two of clubs, card `15` is the four of diamonds, card `36` is the queen of spades, and card `51` is the ace of hearts. These numbers are identifiers. Card `0` is not on the left or top of the table, and card `51` is not physically farther right or lower.

The encoding can also be written as `card = suit * 13 + rank`. The suit and rank numbers mean:

| Kind | Values |
| --- | --- |
| Suit | `0` clubs, `1` diamonds, `2` spades, `3` hearts |
| Rank | `0` two, `1` three, through `8` ten, `9` jack, `10` queen, `11` king, `12` ace |

To decode card `36`, divide by 13: the whole-number result `2` means spades and the remainder `10` means queen. The rank digit inside an ID runs `0`–`12`, while the card objects you read from the observation (and `rank_of`) use the printed face value `2`–`14`. You rarely need either scale: stay in card objects and let `play(card)` build the ID for you.

The card you return must have a `1` in the same position of `observation["action_mask"]`. The environment rejects a card whose mask entry is `0`, including a card you do not hold or a card that breaks a game rule.

### Observations

Your `act` method receives a dictionary with two keys:

```text
observation
├── "action_mask"    52 entries that say which card IDs are legal
└── "observation"    an object with your hand, the trick, the seats, and the scores
```

The top-level `action_mask` is a length-52 NumPy array indexed by card ID: `1` means you may play that card now, `0` means you may not. It is the one place indices survive, and `legal_cards` reads it for you.

Everything else lives under the `"observation"` key, and it is **semantic**: cards are objects `{"suit", "rank"}`, your hand and the trick are ordinary sequences of them, and the small numbers are plain categories. Nothing here is a 52-long bitmask.

| Field | Shape | Values and meaning |
| --- | --- | --- |
| `hand` | sequence of cards | The card objects you are holding, in the order dealt. Grows shorter as the hand plays out; some may still be illegal this turn. |
| `current_trick` | sequence of `{seat, card}` | The cards played to the current trick so far, in play order (the leader first). Empty when you are leading a fresh trick. |
| `trick_leader` | `0..3` | The seat that led the current trick. |
| `led_suit` | `0..4` | `0` clubs, `1` diamonds, `2` spades, `3` hearts; `4` means no card has been led yet because you are starting the trick. |
| `hearts_broken` | `0` or `1` | `0` means no heart has been played on an earlier trick; `1` means hearts have been broken. |
| `seat` | `0..3` | Your own seat ID. |
| `scores` | length-4 array | Running penalty points indexed by seat. Each value is from `0` through `26`, and lower is better. |

Read these through `observation["observation"]`, for example `observation["observation"]["seat"]`, or let the helpers do it: `hand_cards`, `current_trick`, `led_suit`, `my_seat`, and `scores` each return one of these fields as plain Python values.

#### How seat numbers work

Seat IDs are player labels, not fixed locations on the screen. Seat `0` controls `player_0`, seat `1` controls `player_1`, and so on. Turns move clockwise in this order:

```text
0 → 1 → 2 → 3 → 0
```

The viewer rotates the table so that the player being viewed is at the bottom. From that player's view, the next seat in the sequence is on the left, the seat after that is at the top, and the previous seat is on the right. Therefore, seat `0` is not always the bottom, top, left, or right seat.

Suppose `seat` is `2`. Your agent controls seat 2, which the viewer places at the bottom. Seat 3 appears on the left, seat 0 at the top, and seat 1 on the right. If `scores` is `[3, 0, 5, 1]`, then seat 0 has 3 penalty points, seat 1 has 0, your seat 2 has 5, and seat 3 has 1.

`current_trick` carries absolute seat IDs too. If it is `[{"seat": 0, "card": {"suit": 1, "rank": 4}}, {"seat": 1, "card": {"suit": 1, "rank": 13}}]`, then seat 0 led the four of diamonds and seat 1 followed with the king of diamonds; seats 2 and 3 have not played yet. Because the list is already in play order, its first entry is the seat named by `trick_leader`.

## Time limits

Hearts is turn-based, so there is no fixed delay between moves. Each call to `act` has a 1-second limit, and one game has a 120-second limit on the agent's total measured compute. If `act` returns late, the environment chooses a legal card for the agent. It selects the lowest rank, and if several legal cards have that rank, it selects the one with the lower suit ID. When a human controls a seat, the move deadline is 60 seconds. See [Time limits](../agent-interface.md#time-limits) for how these limits are enforced and measured.

## Your first improvement

Run `python -m sandbox play` and follow your agent through a full game. Play against it `python -m sandbox` if you like. Sooner or later it wins a trick with a high card and takes penalty points. Was that trick where the game went wrong?

> Usually not, the mistake happened earlier. Your agent was trigger-happy, throwing lower cards away even when it does not make sense.

You may have known this fix, **ducking**: playing a high card under one (from another player) that already beats it. Does the observation provide enough information to "duck"?

> Scan the table in [The helper module](#the-helper-module) for the rows that describe the current trick.

Record the mean score from `python -m sandbox eval` before the change, make it, and run `eval` again. Ducking pays off a few points at a time over many deals, so you need to evaluate with the mean over more games.

One more thing to notice while you watch: ducking only exists when you must follow suit. Sooner or later you will have no card of the led suit at all, and a card from another suit can never win the trick. What is a turn you cannot possibly win actually _for_?
