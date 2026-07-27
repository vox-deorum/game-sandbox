# Hearts

Hearts is a four-player card game. Your goal is to finish with as few penalty points as possible. Each heart is worth 1 point, and the queen of spades is worth 13. Your agent controls one player. The [agent interface](../../docs/students/agent-interface.md) explains the `reset` and `act` methods shared by every environment. This page covers everything specific to Hearts.

## How the game works

Each player receives 13 cards from a standard 52-card deck. Players use those cards in 13 rounds called **tricks**. One player **leads** by playing the first card. The other players each add one card in clockwise order. The first card sets the **led suit**. The highest card of that suit wins the trick, and its player takes all four cards and leads the next trick.

If you hold a card of the led suit, you must play one. This rule is called **following suit**. If you hold none, you may play another suit. That card cannot win the trick, so this can be a good time to discard a dangerous card.

This environment uses these Hearts rules:

- The player holding the two of clubs leads it on the first trick.
- No heart or queen of spades may be played on the first trick unless the player has no other kind of card.
- A player may not lead a heart until hearts are **broken**, which means someone played a heart on an earlier trick. The one exception is a hand that holds nothing but hearts, which may lead one. The queen of spades does not break hearts in this variant.

You do not need to program these rules yourself. The template's `legal_cards` helper reads the observation and lists the cards you may play on the current turn.

> _Never played Hearts?_ The [Wikipedia article about Hearts](https://en.wikipedia.org/wiki/Hearts_%28card_game%29) provides a broader introduction.

## Your first agent

Your template contains a complete working agent. This section explains how it chooses a card.

On each turn, the game harness calls `act` with an observation of the table. Your agent must return the card it wants to play. The template's helper module converts the observation into card objects and plain Python values, so you do not need to work with raw numbers.

A card is a small object with a `suit` number from `0` through `3` and a `rank` number from `2` through `14`. The rank matches its face value: `11` is the jack, `12` is the queen, `13` is the king, and `14` is the ace. The queen of spades is therefore `{"suit": 2, "rank": 12}`.

`legal_cards(observation)` returns the cards you may play this turn. It applies every rule, including following suit, not leading hearts before they are broken, and the first-trick restrictions. Every card in the returned list is legal.

`rank_of(card)` gives a card's face-value rank from two through ace, without considering its suit. Python's built-in `min` can use that helper to find the lowest-ranked card.

`play(card)` converts a card object into the integer that `act` must return. Choose a card object first, then convert it at the end instead of building the integer yourself.

The strategy is simple: always play the lowest-ranked legal card. Low cards rarely win tricks, and winning tricks is how you collect penalty cards. Playing low is therefore a reasonable starting point.

```python
from sandbox.cards import legal_cards, play, rank_of


class Agent:
    """Plays the lowest-ranked card that is legal right now."""

    def reset(self, seed: int) -> None:
        # Called once before each game. This agent keeps no state between turns,
        # so there is nothing to prepare here; a learning agent would reset its
        # memory in this method.
        pass

    def act(self, observation) -> int:
        # legal_cards reads the observation for you: every card object in this
        # list is a card you hold and may play right now, so the rules (follow
        # suit, hearts not broken yet, no points on the first trick) are already
        # taken care of.
        legal = legal_cards(observation)

        # TODO(you): this one line is the whole strategy. Low cards rarely win
        # tricks, and tricks are how you collect penalty points, so playing the
        # lowest-ranked legal card is a sane start. It is also exactly how the
        # local runner gives every agent-controlled player this same strategy.
        # Replace it with something smarter; the
        # "Your first improvement" section of environment.md shows you how to
        # find one. cards.play(card) turns your chosen card object into the
        # integer act() must return.
        return play(min(legal, key=rank_of))
```

This agent cannot make an illegal move because it only chooses from `legal_cards`. You do not need to check the rules again.

Run the agent from the template folder:

```console
python -m sandbox play    # watch separate copies of your agent play all four positions
python -m sandbox eval    # play several seeded games and report the mean score
python -m sandbox test    # run the checks
```

`eval` reports the higher-is-better leaderboard score from [Scoring and rewards](#scoring-and-rewards), so a result closer to zero is better. It is useful for comparing changes against the same seeds, not for predicting leaderboard results.

The `TODO(you)` comment inside `act` marks the line for you to improve. You can keep the setup above it and change the decision in the return statement. [Your first improvement](#your-first-improvement) helps you find a smarter strategy. This page is the `environment.md` file that the template comments mention.

## Scoring and rewards

Each heart taken in a trick adds 1 penalty point, and the queen of spades adds 13. There are 26 penalty points available in one game. Lower is better.

**Shooting the moon** is the exception. If one player takes all 13 hearts and the queen of spades, that player scores 0 penalty points and every other player scores 26.

During play, every action gives a reward of `0.0`. When the game ends, each player's reward is the negative of their final penalty score, which turns the lower-is-better score into a higher-is-better reward:

| Final penalty score | Final reward |
| ------------------- | ------------ |
| `0`                 | `0.0`        |
| `5`                 | `-5.0`       |
| `13`                | `-13.0`      |
| `26`                | `-26.0`      |

After a successful moon shot, the shooter receives `0.0` and each other player receives `-26.0`. While the game is still running, the `scores` observation shows the penalty points taken so far. The moon-shot adjustment is applied to the final score and reward when the game ends.

## The helper module

The starting agent uses the template's `sandbox.cards` helper module. Import what you need at the top of `agent.py`, not inside a method. The helpers turn the observation into card objects, lists, and plain Python values. Your `act` method therefore does not need to read internal arrays or action numbers.

`legal_cards(observation)` returns the card objects you may play. This list is never empty on your turn. `min(legal, key=rank_of)` selects the lowest-ranked legal card. `rank_of(card)` reads a card's face value, and `play(card)` converts the chosen card into the integer returned by `act`. Choosing only from `legal_cards` automatically follows suit and obeys the other rules.

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
| `current_trick(observation)` | `(player, card)` pairs in the order played |
| `trick_winner_so_far(observation)` | The currently winning `(player, card)` pair, or `None` before any card is played |
| `hearts_broken(observation)` | `True` after hearts are broken, otherwise `False` |
| `my_player(observation)` | Your player ID |
| `scores(observation)` | Four running penalty scores indexed by player |
| `CLUBS`, `DIAMONDS`, `SPADES`, `HEARTS` | Names for suit IDs `0`, `1`, `2`, and `3` |
| `SUIT_NAMES` | Suit names indexed by suit ID, `("clubs", "diamonds", "spades", "hearts")`, useful for printing or chat text |
| `RANK_NAMES` | Rank names indexed by face-value rank; `RANK_NAMES[rank_of(card)]` gives `"2"` through `"10"`, then `"J"`, `"Q"`, `"K"`, `"A"` |
| `TWO_OF_CLUBS`, `QUEEN_OF_SPADES` | The card objects `{"suit": 0, "rank": 2}` and `{"suit": 2, "rank": 12}` |

## Under the hood

This is optional advanced reference material. The starting agent uses helpers instead of raw action numbers and observation arrays, and most agents never need this section.

Without the helpers, finding the legal cards means reading all 52 mask entries by hand:

```python
def card_rank(card):
    return card % 13


def act(self, observation):
    legal = [card for card in range(52) if observation["action_mask"][card] == 1]
    return min(legal, key=card_rank)
```

### Actions

Your `act` method returns an integer from `0` through `51`. This **card ID** is a label for one card. The IDs count through all clubs first, then diamonds, spades, and hearts:

| Suit | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | J | Q | K | A |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Clubs | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| Diamonds | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 |
| Spades | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 |
| Hearts | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 49 | 50 | 51 |

For example, card `0` is the two of clubs, card `15` is the four of diamonds, card `36` is the queen of spades, and card `51` is the ace of hearts. These numbers are identifiers. Card `0` is not on the left or top of the table, and card `51` is not physically farther right or lower.

You can calculate a card ID with `card = suit * 13 + rank`. In this formula, suit and rank use these values:

| Kind | Values |
| --- | --- |
| Suit | `0` clubs, `1` diamonds, `2` spades, `3` hearts |
| Rank | `0` two, `1` three, through `8` ten, `9` jack, `10` queen, `11` king, `12` ace |

To decode card `36`, divide it by 13. The whole-number result, `2`, means spades. The remainder, `10`, means queen. A card ID uses ranks `0` through `12`, while observation card objects and `rank_of` use face values `2` through `14`. You rarely need to convert either scale. Work with card objects and let `play(card)` build the ID.

The card you return must have a `1` at the same position in `observation["action_mask"]`. The environment rejects a card whose entry is `0`. This includes cards you do not hold and cards that break a rule.

### Observations

Your `act` method receives a dictionary with two keys:

```text
observation
├── "action_mask"    52 entries that say which card IDs are legal
└── "observation"    an object with your hand, the trick, the players, and the scores
```

The top-level `action_mask` is a 52-entry NumPy array indexed by card ID. `1` means you may play that card now, and `0` means you may not. `legal_cards` reads this array for you.

Everything else is under the `"observation"` key and uses meaningful structures. Cards are objects shaped like `{"suit", "rank"}`. Your hand and current trick are ordinary sequences of cards, and small numbers represent categories. None of these fields is another 52-entry mask.

| Field | Shape | Values and meaning |
| --- | --- | --- |
| `hand` | sequence of cards | The card objects you are holding, in the order dealt. Grows shorter as the hand plays out; some may still be illegal this turn. |
| `current_trick` | sequence of `{player, card}` | The cards played to the current trick so far, in play order (the leader first). Empty when you are leading a fresh trick. |
| `trick_leader` | `0..3` | The player that led the current trick. |
| `led_suit` | `0..4` | `0` clubs, `1` diamonds, `2` spades, `3` hearts; `4` means no card has been led yet because you are starting the trick. |
| `hearts_broken` | `0` or `1` | `0` means no heart has been played on an earlier trick; `1` means hearts have been broken. |
| `player` | `0..3` | Your own player ID. |
| `scores` | length-4 array | Running penalty points indexed by player. Each value is from `0` through `26`, and lower is better. |

Read these through `observation["observation"]`, for example `observation["observation"]["player"]`, or let the helpers do it: `hand_cards`, `current_trick`, `led_suit`, `my_player`, and `scores` each return one of these fields as plain Python values.

#### How player numbers work

Player IDs are fixed labels in the turn order, not positions on the screen. Turns move clockwise:

```text
0 → 1 → 2 → 3 → 0
```

The viewer rotates the table to place the player being watched at the bottom. From that view, the next player is on the left, the following player is at the top, and the previous player is on the right. Player `0` can therefore appear at any side of the screen.

Suppose `player` is `2`. Your agent controls player 2, which the viewer places at the bottom. Player 3 appears on the left, player 0 at the top, and player 1 on the right. If `scores` is `[3, 0, 5, 1]`, then player 0 has 3 penalty points, player 1 has 0, your player 2 has 5, and player 3 has 1.

`current_trick` carries absolute player IDs too. If it is `[{"player": 0, "card": {"suit": 1, "rank": 4}}, {"player": 1, "card": {"suit": 1, "rank": 13}}]`, then player 0 led the four of diamonds and player 1 followed with the king of diamonds; players 2 and 3 have not played yet. Because the list is already in play order, its first entry is the player named by `trick_leader`.

## Time limits

Hearts is turn-based, so moves have no fixed delay between them. By default, each call to `act` has a 1-second limit, and the agent may use up to 120 seconds of measured computation during one game. A season may override these limits. If `act` returns late, the environment plays the legal card with the lowest rank. When several cards have that rank, it chooses the lower suit ID. By default, a human-controlled player has 60 seconds to move. See [Time limits](../../docs/students/agent-interface.md#time-limits) for how these limits are measured and enforced.

## Your first improvement

Run `python -m sandbox play` and watch your agent for a full game. You can also play against it with `python -m sandbox`. Eventually it wins a trick with a high card and takes penalty points. Did the mistake happen on that trick?

> Usually not. The mistake happened earlier, when the agent discarded lower cards that it could have saved.

One possible improvement is **ducking**: playing a high card below another player's higher card, so yours cannot win. Does the observation provide enough information to duck?

> Scan the table in [The helper module](#the-helper-module) for the rows that describe the current trick.

Record the average score from `python -m sandbox eval` before the change, then run it again afterward. Ducking saves a few points at a time over many deals, so compare averages over several games.

One more thing to notice while you watch: ducking only exists when you must follow suit. Sooner or later you will have no card of the led suit at all, and a card from another suit can never win the trick. What is a turn you cannot possibly win actually _for_?
