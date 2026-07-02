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

## Actions

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

To decode card `36`, divide by 13. The whole-number result is `2`, which means spades, and the remainder is `10`, which means queen. You usually do not need to do this arithmetic yourself because the template provides card helpers.

The card you return must have a `1` in the same position of `observation["action_mask"]`. The environment rejects a card whose mask entry is `0`, including a card you do not hold or a card that breaks a game rule.

## Observations

Your `act` method receives a dictionary with this structure:

```text
observation
├── "action_mask"    52 entries that say which card IDs are legal
└── "observation"    the cards, seats, trick, and scores
```

The values are NumPy arrays. An array's **length** is the number of values it contains. For example, a length-52 array has one entry for each card ID from `0` through `51`. A field with length 1 is still an array, so you read its single value with index `[0]`.

| Field | Array length | Values and meaning |
| --- | --- | --- |
| `action_mask` | 52 | Indexed by card ID. `1` means you may play that card now; `0` means you may not. |
| `hand` | 52 | Indexed by card ID. `1` means the card is in your hand; `0` means it is not. Some cards in your hand may still be illegal this turn. |
| `trick` | 4 | Indexed by seat. Each entry is the card ID that seat played in the current trick, or `-1` if that seat has not played yet. |
| `led_suit` | 1 | `0` clubs, `1` diamonds, `2` spades, or `3` hearts. `-1` means no card has been led because you are starting the trick. |
| `hearts_broken` | 1 | `0` means no heart has been played on an earlier trick; `1` means hearts have been broken. |
| `position` | 1 | Your seat ID, from `0` through `3`. |
| `trick_leader` | 1 | The seat ID of the player who led the current trick, from `0` through `3`. |
| `scores` | 4 | Running penalty points indexed by seat. Each value is from `0` through `26`, and lower is better. |

### How seat numbers work

Seat IDs are player labels, not fixed locations on the screen. Seat `0` controls `player_0`, seat `1` controls `player_1`, and so on. Turns move clockwise in this order:

```text
0 → 1 → 2 → 3 → 0
```

The viewer rotates the table so that the player being viewed is at the bottom. From that player's view, the next seat in the sequence is on the left, the seat after that is at the top, and the previous seat is on the right. Therefore, seat `0` is not always the bottom, top, left, or right seat.

Suppose `position` is `[2]`. Your agent controls seat 2, which the viewer places at the bottom. Seat 3 appears on the left, seat 0 at the top, and seat 1 on the right. If `scores` is `[3, 0, 5, 1]`, then seat 0 has 3 penalty points, seat 1 has 0, your seat 2 has 5, and seat 3 has 1.

The `trick` array also uses absolute seat IDs. If it is `[15, 24, -1, -1]`, seat 0 played card `15`, the four of diamonds, and seat 1 played card `24`, the king of diamonds. Seats 2 and 3 have not played yet. Use `trick_leader` to know which of the played cards came first.

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

## Time limits

Hearts is turn-based, so there is no fixed delay between moves. Each call to `act` has a 1-second limit, and one game has a 120-second limit on the agent's total measured compute. If `act` returns late, the environment chooses a legal card for the agent. It selects the lowest rank, and if several legal cards have that rank, it selects the one with the lower suit ID. When a human controls a seat, the move deadline is 60 seconds. See [Time limits](../agent-interface.md#time-limits) for how these limits are enforced and measured.

## Template helpers

The template includes a plain Python module named `sandbox.cards`. Import from it at the top of `agent.py`. It converts the raw arrays and card IDs into ordinary Python values with readable names.

Without the helpers, finding the legal cards requires reading all 52 mask entries:

```python
legal = [card for card in range(52) if observation["action_mask"][card] == 1]
return min(legal, key=lambda card: card % 13)
```

The helpers express the same agent more clearly:

```python
from sandbox.cards import legal_cards, rank_of

def act(self, observation):
    legal = legal_cards(observation)
    return min(legal, key=rank_of)
```

`legal_cards(observation)` returns a list of the card IDs whose mask entry is `1`. The list is never empty on your turn. `rank_of(card)` returns the card's rank number, so `min(legal, key=rank_of)` selects the lowest-ranked legal card. Because the choice always comes from `legal`, the agent automatically follows suit and obeys the other rules.

The module provides these helpers and constants:

| Helper or constant | Result |
| --- | --- |
| `legal_cards(observation)` | Legal card IDs for this turn |
| `hand_cards(observation)` | All card IDs in your hand |
| `suit_of(card)` | Suit ID from `0` through `3` |
| `rank_of(card)` | Rank ID from `0` through `12` |
| `make_card(suit, rank)` | Card ID built from a suit ID and rank ID |
| `card_name(card)` | Readable text such as `"Q of spades"` |
| `card_points(card)` | `13` for the queen of spades, `1` for a heart, or `0` otherwise |
| `led_suit(observation)` | Led suit ID, or `None` when you are leading |
| `current_trick(observation)` | `(seat, card)` pairs in the order played |
| `trick_winner_so_far(observation)` | The currently winning `(seat, card)` pair, or `None` before any card is played |
| `hearts_broken(observation)` | `True` after hearts are broken, otherwise `False` |
| `my_seat(observation)` | Your seat ID |
| `scores(observation)` | Four running penalty scores indexed by seat |
| `CLUBS`, `DIAMONDS`, `SPADES`, `HEARTS` | Names for suit IDs `0`, `1`, `2`, and `3` |
| `TWO_OF_CLUBS`, `QUEEN_OF_SPADES` | Names for card IDs `0` and `36` |

## Ideas and examples

A low-card agent is a useful starting point because low cards are less likely to win tricks. You can improve it one idea at a time:

- **Duck.** When following suit, play the highest card that still loses to the current winner. This removes a high card without taking the trick.
- **Discard danger.** When you cannot follow suit, discard the queen of spades or a high heart instead of your lowest card.
- **Lead low.** A low lead is less likely to win the trick. Leading from a short suit may also help you run out of that suit sooner.
- **Use your seat.** The last player in a trick knows every card already played and can decide precisely whether to win or lose it.
- **Remember played cards.** Track cards as they appear. Once the queen of spades has been played, high spades are much safer.
- **Shoot the moon carefully.** Trying to collect every penalty card requires a strategy that is nearly the opposite of ordinary Hearts. Missing even one penalty card leaves you with the points you collected.

The repository includes complete worked agents with progressively different strategies: [Duck](https://github.com/vox-deorum/game-sandbox/blob/main/examples/hearts/duck/agent.py), [Closer](https://github.com/vox-deorum/game-sandbox/blob/main/examples/hearts/closer/agent.py), [Assassin](https://github.com/vox-deorum/game-sandbox/blob/main/examples/hearts/assassin/agent.py), and [Moonshot](https://github.com/vox-deorum/game-sandbox/blob/main/examples/hearts/moonshot/agent.py).
