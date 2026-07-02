# Hearts

Hearts is a classic trick-taking card game for four players. Unlike most card games, the goal is to score as _few_ points as possible: every heart you collect costs one penalty point and the queen of spades costs thirteen, so the whole game is about dodging cards the other players would love to hand you. The one twist is "shooting the moon" — take _every_ penalty card and the punishment flips onto everyone else. If you have never played, the [Wikipedia article](https://en.wikipedia.org/wiki/Hearts_%28card_game%29) is a good primer, but everything you need to build an agent is on this page.

Your agent fills one of the four seats. Whenever it is your turn, the environment shows your agent the state of the table and asks for one card to play. The parts that work the same in every environment — the `reset` and `act` methods, the manifest, and how time limits are enforced — are covered in the [agent interface](../agent-interface.md); everything specific to Hearts is here.

## How a hand plays out

Each player is dealt 13 cards from a standard 52-card deck. Play happens in **tricks**: one player leads a card, the other three each add one card going clockwise, and whoever played the highest card _of the suit that was led_ takes the trick — along with any penalty points in it — and leads the next one. If you hold a card of the led suit you must play one (this is called **following suit**); only when you have none may you throw a card of another suit. An off-suit card can never win the trick, which makes it the perfect moment to get rid of something dangerous.

Three extra rules shape the play:

- The player holding the two of clubs leads it to the first trick.
- No hearts or the queen of spades may be played on that first trick, unless that is all you hold.
- You may not _lead_ a heart until hearts are **broken**, which happens once someone has played a heart on an earlier trick. (In this variant only a heart breaks hearts — the queen of spades does not.)

Here is the good news: you never have to check any of these rules yourself. Every observation includes a legal-move mask that already accounts for all of them, so any card the mask marks as legal is a valid play.

## Observations

When it is your turn, your `act` method receives a dictionary with two keys. Throughout, a card is an integer from `0` to `51` — the exact encoding is explained in [Actions](#actions) below.

The first key, `observation["action_mask"]`, is the legal-move mask: an array with 52 entries, one per card in the deck, where `mask[card] == 1` exactly for the cards you may play this turn.

The second key, `observation["observation"]`, holds the rest of the table state:

| Field | Shape | Meaning |
| --- | --- | --- |
| `hand` | 52 | `1` at each card currently in your hand, `0` elsewhere. |
| `trick` | 4 | Indexed by seat: `trick[seat]` is the card that seat has played to the current trick, or `-1` if it has not played yet. |
| `led_suit` | 1 | The suit led this trick (`0`–`3`), or `-1` when you are the one leading. |
| `hearts_broken` | 1 | `1` once hearts have been broken, `0` before. |
| `position` | 1 | Your own seat, `0`–`3`. |
| `trick_leader` | 1 | The seat that led the current trick. Play proceeds clockwise from there. |
| `scores` | 4 | Penalty points taken so far, indexed by seat. |

Two things make the raw fields fiddly to read. Every value is a NumPy array, so even single numbers arrive as one-element arrays — the led suit is really `observation["observation"]["led_suit"][0]`. And `trick` is indexed by seat rather than by play order, so reconstructing who played what in order means starting from `trick_leader` and walking clockwise.

In practice you rarely touch the raw arrays, because a helper module named `sandbox.cards` sits next to your agent and reads them for you. It is plain Python with no heavy dependencies, so import what you need at the top of `agent.py`:

```python
from sandbox.cards import legal_cards, led_suit, current_trick
```

These helpers each take the whole observation and give you back plain Python values. The examples in the table all read the same moment of one game: you are seat 2, hearts have been broken, seat 0 led the 4 of diamonds (card `15`), seat 1 followed with the king of diamonds (card `24`), and your hand is the 5 of clubs, the 6 and 9 of diamonds, the queen of spades, and the 8 of hearts.

| Helper | What it gives you | Example |
| --- | --- | --- |
| `legal_cards(observation)` | The cards you may play right now, as a list of ints. | `[17, 20]` — you must follow diamonds, so only the 6 and 9 of diamonds |
| `hand_cards(observation)` | Every card in your hand, playable this turn or not. | `[3, 17, 20, 36, 45]` |
| `led_suit(observation)` | The suit led this trick, or `None` when you are leading. | `1` — diamonds |
| `current_trick(observation)` | The `(seat, card)` pairs played to this trick so far, in play order. Empty when you lead. | `[(0, 15), (1, 24)]` |
| `trick_winner_so_far(observation)` | The `(seat, card)` currently winning — the highest card of the led suit so far — or `None` when no card is down yet. | `(1, 24)` — seat 1's king of diamonds |
| `hearts_broken(observation)` | Whether hearts have been broken. | `True` |
| `my_seat(observation)` | Your seat number, `0`–`3`. | `2` |
| `scores(observation)` | The four seats' running penalty totals, indexed by seat. | `[3, 0, 5, 1]` |

## Actions

Your `act` method returns one integer: the card you want to play. A card is an int from `0` to `51` with the fixed encoding `card = suit * 13 + rank`. Suits are `0` clubs, `1` diamonds, `2` spades, `3` hearts. Ranks run `0` for the 2 up to `12` for the ace, so `9` is the jack, `10` the queen, `11` the king, and `12` the ace.

This table lists every card's integer. Read down to the suit and across to the rank.

| Suit | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | J | Q | K | A |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Clubs | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| Diamonds | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 |
| Spades | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 |
| Hearts | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 49 | 50 | 51 |

So the two of clubs is `0`, the queen of spades is `36`, and the ace of hearts is `51`. The card you return must be one the mask allows — the environment rejects an illegal card — and if `act` runs out of time, the environment plays your lowest legal card for you.

You rarely need to do this arithmetic yourself. `sandbox.cards` also covers working with individual cards:

| Helper | What it does | Example |
| --- | --- | --- |
| `suit_of(card)` / `rank_of(card)` | Split a card id into its suit (`0`–`3`) and rank (`0`–`12`). | `suit_of(36)` is `2`, `rank_of(36)` is `10` |
| `make_card(suit, rank)` | Build a card id from a suit and a rank. | `make_card(2, 10)` is `36`, the queen of spades |
| `card_name(card)` | A readable name for the card — handy in debug prints. | `card_name(36)` is `"Q of spades"` |
| `card_points(card)` | The penalty points the card carries: `1` for a heart, `13` for the queen of spades, `0` otherwise. | `card_points(36)` is `13`, `card_points(51)` is `1` |

The module also exports the constants `CLUBS`, `DIAMONDS`, `SPADES`, and `HEARTS` for the four suit numbers, plus `TWO_OF_CLUBS` and `QUEEN_OF_SPADES` for the two cards the rules single out, so your code never needs magic numbers like `36`.

## The smallest agent

Here is the entire decision logic of a working Hearts agent. Drop it into the `act` method of the template's agent class:

```python
from sandbox.cards import legal_cards, rank_of

def act(self, observation):
    legal = legal_cards(observation)
    return min(legal, key=rank_of)
```

Take it line by line. `legal_cards(observation)` unpacks the action mask into a plain list of card ids — every card you are allowed to play this turn. On your turn this list is never empty, because you always hold at least one legal card. `min(legal, key=rank_of)` then walks that list and keeps the card whose _rank_ is lowest, ignoring suit. Returning that integer plays the card.

This agent never breaks a rule, because it only ever chooses from the mask: when it can follow suit the mask contains only cards of the led suit, so it automatically follows with its smallest one. And it is a genuinely reasonable baseline, because low cards rarely win tricks, and an agent that rarely wins tricks rarely collects points. Its blind spot is just as instructive: when it cannot follow suit it throws its lowest-ranked card, wasting a perfect chance to dump the queen of spades or a high heart. Every stronger agent is a refinement of this same loop — compute `legal`, then think harder about which element to return.

## Scoring and rewards

Hearts is scored in penalty points, and a lower total is better. Each heart you take in a trick is worth 1 point, and the queen of spades is worth 13, for 26 points in a full hand. The one reversal is shooting the moon: if a single seat takes every heart _and_ the queen of spades, that seat scores 0 and each of the other three takes 26.

During play the per-step reward is `0.0` for every seat. On the final step each seat receives its leaderboard score, which is the _negation_ of its penalty total — so the reward is higher-is-better even though penalty points are lower-is-better. The running `scores` field in the observation stays in raw penalty points, where lower is better.

## Time limits

Hearts is turn-based, so there is no fixed pace between moves. Each call to `act` has a step limit of 1 second, and your agent's total measured compute for one game is capped by an episode limit of 120 seconds. If `act` is late, the environment plays your lowest legal card instead. When a human plays a seat, the move deadline is 60 seconds. See [Time limits](../agent-interface.md#time-limits) for how the step and episode limits are enforced and accounted.

## Ideas to try

A good way to improve is one idea at a time, each building on the last:

- **Duck.** When following suit, play your highest card that still loses to the current winner of the trick — you shed a big card without taking the trick. `current_trick` and `trick_winner_so_far` tell you what you need to beat (or stay under).
- **Dump when void.** When you cannot follow suit, do not throw your lowest card — throw your most dangerous one. The queen of spades first, then high hearts, then high spades that might win the queen later.
- **Lead low.** When you lead, a low card usually loses the trick to someone else. Leading your shortest suit also makes you void sooner, which earns you more chances to dump.
- **Use your seat.** When you are the last to play in a trick, you have complete information: you know exactly which card wins and what points are on the table. You can safely win a cheap trick with just enough, or duck with precision.
- **Count what you have seen.** Each turn, remember the cards visible in the current trick. Over a hand you build a partial picture of what is gone — most importantly whether the queen of spades has already been played, after which high spades are safe.
- **Shoot the moon.** The opposite policy: win every trick that contains points, using high cards you would normally avoid. It is high risk — miss a single heart and you keep all the points you collected — but the payoff is 26 points to everyone else.
