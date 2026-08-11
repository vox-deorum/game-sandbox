# Hearts

Hearts is a four-player card game where your goal is to take as few penalty points as possible. Your agent controls one player. The [agent interface](../../docs/students/agent-interface.md) explains the `reset` and `act` methods shared by every environment. This page covers everything specific to Hearts.

After you complete [Getting Started](../../docs/students/getting-started.md), open `agent.py`, run `python -m sandbox play`, then follow [Your first agent](#your-first-agent).

## How the game works

Each player receives 13 cards from a standard 52-card deck. They play those cards in 13 rounds called **tricks**. One player **leads** by playing the first card, and the others each add one card in clockwise order. The first card sets the **led suit**. The highest card of that suit wins the trick, and that player takes all four cards and leads the next trick.

If you hold a card of the led suit, you must play one. This rule is called **following suit**. If you hold none, you may play another suit. That card cannot win the trick, so this can be a good time to discard a dangerous card.

This environment uses these Hearts rules:

- The player holding the two of clubs leads it on the first trick.
- No heart or queen of spades may be played on the first trick unless the player has no other kind of card.
- A player may not lead a heart until hearts are **broken**, which means someone played a heart on an earlier trick. The one exception is a hand that holds nothing but hearts, which may lead one. The queen of spades does not break hearts in this variant.

You do not need to program these rules yourself: the template's `legal_cards` helper reads the observation and lists the cards you may play on the current turn.

> _Never played Hearts?_ The [Wikipedia article about Hearts](https://en.wikipedia.org/wiki/Hearts_%28card_game%29) provides a broader introduction.

## Player indices

Observation player indices `0..3` are fixed turn-order labels, not screen positions. Turns move clockwise:

```text
0 → 1 → 2 → 3 → 0
```

The viewer rotates the table to put the viewed player at the bottom, so any player index can appear on any side. `current_trick`, `trick_leader`, and `scores` use the same indices.

## Your first agent

Your template contains a working agent. On each turn, `act` receives an observation of the table and returns a card. The helper module presents the observation as card objects and plain Python values.

A card is a small object with a `suit` number from `0` through `3` (clubs, diamonds, spades, hearts, in that order) and a `rank` number from `2` through `14`. The rank matches its face value: `11` is the jack, `12` is the queen, `13` is the king, and `14` is the ace. The queen of spades is therefore `{"suit": 2, "rank": 12}`.

The starting strategy always plays the lowest-ranked legal card. `legal_cards(observation)` returns cards already checked against every rule, `min` selects the lowest rank, and `play` converts that card into the integer `act` returns. [The helper module](#the-helper-module) lists each helper, and the comments below explain the strategy.

```python
from sandbox.cards import HeartsObservation, legal_cards, play, rank_of


class Agent:
    """Plays the lowest-ranked card that is legal right now."""

    def reset(self, seed, observation) -> None:
        # Called once before each game. The opening observation is available here for
        # precomputation outside the decision clock. This agent keeps no state between turns.
        pass

    def act(self, observation: HeartsObservation) -> int:
        # legal_cards reads the observation for you: every card object in this
        # list is a card you hold and may play right now, so the rules (follow
        # suit, hearts not broken yet, no points on the first trick) are already
        # taken care of.
        legal = legal_cards(observation)

        # TODO(you): low cards rarely win tricks, so this is a safe start.
        # Replace it with a strategy that avoids penalty cards. play(card)
        # turns the chosen card object into the integer act() must return.
        return play(min(legal, key=rank_of))
```

Run the agent from the template folder:

```console
python -m sandbox play                 # watch separate copies of your agent play all four positions
python -m sandbox eval                 # compare your agent with Naive over repeatable games
python -m sandbox eval --vs rivals/v1  # play against a saved rival
python -m sandbox test                 # run the checks
```

`eval` plays your selected position against three copies of **Naive**, a simple built-in agent. One episode is a complete 13-trick deal. `eval` reports the [higher-is-better reward](#scoring-and-rewards): `-2` is better than `-10` because it is closer to zero. Compare the same seeds before and after a change.

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

While the game is still running, the `scores` observation shows the penalty points taken so far. The moon-shot adjustment applies to the final score and reward when the game ends.

## The helper module

The starting agent uses the template's `sandbox.cards` helper module to avoid raw arrays and action numbers. Import what you need at the top of `agent.py`. `Card` and `HeartsObservation` are available for editors and type checkers.

`legal_cards(observation)` returns the card objects you may play. `min(legal, key=rank_of)` selects the lowest rank, `rank_of(card)` reads its face value, and `play(card)` produces the action. Choosing only from `legal_cards` follows every rule.

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
| `current_trick(observation)` | `(player index, card)` pairs in the order played |
| `trick_winner_so_far(observation)` | The currently winning `(player index, card)` pair, or `None` before any card is played |
| `hearts_broken(observation)` | `True` after hearts are broken, otherwise `False` |
| `my_player(observation)` | Your player index |
| `scores(observation)` | Four running penalty scores indexed by player index |
| `CLUBS`, `DIAMONDS`, `SPADES`, `HEARTS` | Names for suit IDs `0`, `1`, `2`, and `3` |
| `SUIT_NAMES` | Suit names indexed by suit ID, `("clubs", "diamonds", "spades", "hearts")`, useful for printing or chat text |
| `RANK_NAMES` | Rank names indexed by face-value rank; `RANK_NAMES[rank_of(card)]` gives `"2"` through `"10"`, then `"J"`, `"Q"`, `"K"`, `"A"` |
| `TWO_OF_CLUBS`, `QUEEN_OF_SPADES` | The card objects `{"suit": 0, "rank": 2}` and `{"suit": 2, "rank": 12}` |

## Your first improvement

Keep the starting strategy when you can follow suit. For your first improvement, discard the legal card with the most penalty points when you cannot. Add `card_points`, `led_suit`, and `suit_of` to the import, then replace the final return with:

```python
if led_suit(observation) is not None and all(suit_of(card) != led_suit(observation) for card in legal):
    return play(max(legal, key=card_points))
return play(min(legal, key=rank_of))
```

This prioritizes giving away a heart or the queen of spades only when you cannot follow suit. Record the mean reward from `python -m sandbox eval` before and after the change. An episode is a full deal, so compare several seeded deals.

When your agent is ready, the [submitting guide](../../docs/students/submitting.md) explains how to submit it.

## Under the hood

This optional raw reference shows the values behind the helpers. Most agents can use the helpers instead.

Without the helpers, finding the legal cards means reading all 52 mask entries by hand:

```python
def card_rank(card):
    return card % 13


def act(self, observation):
    legal = [card for card in range(52) if observation["action_mask"][card] == 1]
    return min(legal, key=card_rank)
```

### Actions

Your `act` method returns a **card ID** from `0` through `51`. IDs count through clubs, diamonds, spades, then hearts:

| Suit | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | J | Q | K | A |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Clubs | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| Diamonds | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 |
| Spades | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 |
| Hearts | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 49 | 50 | 51 |

For example, card `0` is the two of clubs, card `15` the four of diamonds, card `36` the queen of spades, and card `51` the ace of hearts. These are identifiers, not table positions.

You can calculate a card ID with `card = suit * 13 + rank`. In this formula, suit and rank use these values:

| Kind | Values |
| --- | --- |
| Suit | `0` clubs, `1` diamonds, `2` spades, `3` hearts |
| Rank | `0` two, `1` three, through `8` ten, `9` jack, `10` queen, `11` king, `12` ace |

To decode card `36`, divide it by 13. The whole-number result, `2`, means spades. The remainder, `10`, means queen. A card ID uses ranks `0` through `12`, while observation card objects and `rank_of` use face values `2` through `14`. You rarely need to convert between them: work with card objects and let `play(card)` build the ID.

The card you return must have a `1` at the same position in `observation["action_mask"]`. The environment rejects a card whose entry is `0`. This includes cards you do not hold and cards that break a rule.

### Observations

Your `act` method receives a dictionary with two keys:

```text
observation
├── "action_mask"    52 entries that say which card IDs are legal
└── "observation"    an object with your hand, the trick, the players, and the scores
```

The top-level `action_mask` is a 52-entry NumPy array indexed by card ID. `1` is legal and `0` is not. `legal_cards` reads it for you.

Everything else sits under the `"observation"` key in readable structures. Cards are objects shaped like `{"suit", "rank"}`, your hand and current trick are ordinary card sequences, and small numbers represent categories. None of these fields is another 52-entry mask.

| Field | Shape | Values and meaning |
| --- | --- | --- |
| `hand` | sequence of cards | The card objects you are holding, in the order dealt. Grows shorter as the hand plays out; some may still be illegal this turn. |
| `current_trick` | sequence of `{player, card}` | The cards played to the current trick so far, in play order (the leader first). Empty when you are leading a fresh trick. |
| `trick_leader` | `0..3` | The player index that led the current trick. |
| `led_suit` | `0..4` | `0` clubs, `1` diamonds, `2` spades, `3` hearts; `4` means no card has been led yet because you are starting the trick. |
| `hearts_broken` | `0` or `1` | `0` means no heart has been played on an earlier trick; `1` means hearts have been broken. |
| `player` | `0..3` | Your own player index. |
| `scores` | length-4 array | Running penalty points indexed by player index. Each value is from `0` through `26`, and lower is better. |

Read these through `observation["observation"]`, or use the matching helpers.

## Time limits

Hearts is turn-based, so moves have no fixed delay between them. By default, each call to `act` has a 1-second limit, and the agent may use up to 120 seconds of measured computation during one game. A season may override these limits. If `act` returns late, the environment plays the legal card with the lowest rank, breaking ties by the lower suit ID. By default, a human-controlled player has 60 seconds to move. See [Time limits](../../docs/students/agent-interface.md#time-limits) for how these limits are measured and enforced.
