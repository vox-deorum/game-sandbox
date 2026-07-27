# Spades

Spades is a four-player partnership card game. You and the player across the table form a team. Your team bids how many tricks it expects to take, then tries to take that many and score more points than the other team. Your agent controls one player. The [agent interface](../../docs/students/agent-interface.md) explains the `reset` and `act` methods shared by every environment. This page covers everything specific to Spades.

## How the game works

Each player receives 13 cards from a standard 52-card deck. A hand has two phases: a **bidding round**, followed by 13 rounds of card play called **tricks**.

**Bidding.** Starting with player 0 and moving clockwise, each player bids once. A bid is a whole number from `0` to `13` that says how many tricks the player expects to take. A bid of `0` is **nil**, a promise to take no tricks. Your team's **contract** is the sum of your bid and your partner's bid.

**Tricks.** Player 0 starts the first trick. One player **leads** by playing the first card. The other players each add one card in clockwise order. The first card sets the **led suit**. If you hold a card of that suit, you must play one. This rule is called **following suit**. If you hold none, you may play any card.

Spades are always **trump**, which means any spade beats a card from another suit. The highest spade wins a trick. If no one plays a spade, the highest card of the led suit wins. The winner takes the trick and leads the next one.

This environment uses these Spades rules:

- Player 0 bids first and leads the first trick.
- You may not **lead** a spade until spades are **broken**, which means a spade has been played on an earlier trick. The one exception is a hand that holds nothing but spades, which may lead one.
- There is no blind or double nil: every bid is made with your hand in view.

You do not need to program these rules yourself. Every observation contains an **action mask**, an array that marks which actions are legal on the current turn.

The [Wikipedia article about Spades](https://en.wikipedia.org/wiki/Spades_%28card_game%29) provides a broader introduction if the game is new to you.

## Your first agent

Your template contains a complete working agent. You can run it before changing anything. This section explains how it handles bidding and card play.

On each turn, the game harness calls `act` with an observation of the table. During the bidding round, your agent returns a bid. During card play, it returns a card. The template's helper module tells you which phase the game is in and converts the observation into card objects and plain Python values, so you do not need to handle raw numbers.

A card is a small object shaped like `{"suit": 0..3, "rank": 2..14}`. The rank matches its face value: `11` is the jack, `12` is the queen, `13` is the king, and `14` is the ace. The ace of spades is therefore `{"suit": 2, "rank": 14}`.

`is_bidding(observation)` returns `True` during bidding and `False` during card play. A single `if` can therefore send each turn to the right part of your code.

`bid(n)` converts a bid of `n` tricks into the integer that `act` must return. The starting agent calls `bid(1)` to promise one trick.

`legal_cards(observation)` returns the cards you may play this turn. It applies every rule, including following suit and not leading spades before they are broken. Every card in the returned list is legal.

The `"rank"` entry gives a card's face-value rank from two through ace, without considering its suit. Python's built-in `min` can find the lowest rank when you pass `lambda c: c["rank"]` as its `key`. `play(card)` then converts the chosen card into the integer returned by `act`. If you prefer a named function, the helper module's `rank_of(card)` reads the rank.

The strategy has two parts. During bidding, it always promises one trick. A bid of `0` is nil, a risky promise to take none, so `1` is the smallest safe bid for a simple agent. During play, it chooses the lowest-ranked legal card because low cards rarely win unplanned tricks. This strategy will not win often, but it is legal, complete, and ready to improve.

```python
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
```

This agent cannot make an illegal move. Every bid from `0` through `13` is legal during bidding, and during play it only chooses from `legal_cards`. You do not need to check the rules again.

Run the agent from the template folder:

```console
python -m sandbox play    # watch it play a player in your browser
python -m sandbox eval    # play several seeded games and report the mean score
python -m sandbox test    # run the checks, which pass before you change anything
```

`eval` reports a score explained in [Scoring and rewards](#scoring-and-rewards). `test` passes in a fresh template because the starting agent is complete.

The `TODO(you)` comment inside `act` marks where you take over. A better agent should improve both the fixed bid and the strategy of never trying to win. [Your first improvement](#your-first-improvement) helps you find a first step. In your repository, this page is named `environment.md`, which is the file named in the template comments.

## Scoring and rewards

Each team's score is calculated once at the end of the hand.

- Your team's **contract** is the sum of your non-nil bid and your partner's non-nil bid. If the team takes at least that many tricks, it **makes** the contract and scores **10 points for each bid trick**. Each extra trick is an **overtrick**, also called a **bag**, and adds 1 point. If the team takes too few tricks, it is **set** and loses 10 points for each bid trick.
- A **nil** bid is scored separately from the team's contract. A successful nil, in which the bidder takes no tricks, earns **100 points**. A failed nil, in which the bidder takes at least one, loses 100. Tricks from a failed nil still count toward the team's total. They can help make the contract or become bags under the normal rules.
- When both partners bid nil, the team contract is zero and automatically made. Every trick either partner takes becomes a bag in addition to the nil penalties.

For example, if your partner bid 4 and took 3 tricks while you bid nil and took 2, your team's contract is 4 and it took 5 tricks: a made contract worth 40, plus 1 bag, minus your 100 nil penalty, for a team total of minus 59.

Both partners share the same team score. Every action during play gives all players a reward of `0.0`. At the end, each player's reward is their **team hand score**. Partners receive the same value, and higher is better:

| Outcome                                   | Reward   |
| ----------------------------------------- | -------- |
| Made a contract of 4 with no bags         | `40.0`   |
| Made a contract of 4 with 2 bags          | `42.0`   |
| Set on a contract of 4                    | `-40.0`  |
| Both partners bid 13 (impossible to make) | `-260.0` |

The lowest possible team score is minus 260 (both partners bidding 13, a contract of 26 that thirteen tricks can never satisfy), so a crashed or timed-out player can never outscore honest play.

## The helper module

The starting agent uses the template's `sandbox.cards` helper module. Import what you need at the top of `agent.py`, not inside a method. The helpers turn the observation into card objects, bid numbers, lists, and plain Python values. Your `act` method therefore does not need to read a raw NumPy array, action mask, or encoded bid.

`is_bidding(observation)` identifies the phase. `bid(n)` and `play(card)` build the two kinds of action. `legal_bids(observation)` and `legal_cards(observation)` list your legal choices, while `partner_player(observation)` identifies your teammate. [Under the hood](#under-the-hood) documents the raw fields and encodings, but most agents do not need them.

The module provides these helpers and constants:

| Helper or constant | Result |
| --- | --- |
| `is_bidding(observation)` | `True` during the bidding round, `False` during play |
| `legal_bids(observation)` | Bids you may make now, as numbers `0..13` (empty during play) |
| `legal_cards(observation)` | Legal card objects for this turn (empty during bidding) |
| `bid(n)` | The integer action for a bid of `n` tricks (`0..13`) |
| `play(card)` | The integer action for a card object, the value `act` returns |
| `action_to_bid(action)` | The bid `k` a bid action `52 + k` names |
| `hand_cards(observation)` | Every card object in your hand |
| `my_player(observation)` | Your player ID |
| `partner_player(observation)` | Your partner's player, read from the observation |
| `partner_of(player)` | A player's partner, `(player + 2) % 4`, when you only have a player number |
| `bids(observation)` | The four players' bids indexed by player (`-1` before a player bids) |
| `tricks_won(observation)` | Tricks taken so far, indexed by player |
| `team_scores(observation)` | The two teams' running hand scores, `[team of 0/2, team of 1/3]` |
| `led_suit(observation)` | Led suit ID, or `None` when you are leading |
| `spades_broken(observation)` | `True` after spades are broken, otherwise `False` |
| `current_trick(observation)` | `(player, card)` pairs in the current trick, in play order |
| `last_trick(observation)` | `(player, card)` pairs of the most recently completed trick |
| `last_trick_winner(observation)` | Player that won the last completed trick, or `None` |
| `trick_winner_so_far(observation)` | The `(player, card)` currently winning the trick (spades are trump), or `None` |
| `beats_current_winner(observation, card)` | Whether playing `card` now would take the trick |
| `suit_of(card)` / `rank_of(card)` | A card object's suit ID `0..3` / face-value rank `2..14` |
| `make_card(suit, rank)` | A card object `{"suit": suit, "rank": rank}` from a suit ID and face-value rank |
| `card_name(card)` | Readable text such as `"A of spades"` |
| `CLUBS`, `DIAMONDS`, `SPADES`, `HEARTS` | Names for suit IDs `0`, `1`, `2`, and `3` |
| `SUIT_NAMES` | Suit names indexed by suit ID, `("clubs", "diamonds", "spades", "hearts")`; the `signaler` example uses this to build and parse chat text about suits |
| `RANK_NAMES` | Rank names indexed by face-value rank; `RANK_NAMES[rank_of(card)]` gives `"2"` through `"10"`, then `"J"`, `"Q"`, `"K"`, `"A"` |
| `NIL_BID`, `BID_OFFSET` | The nil bid (`0`) and the bid action offset (`52`) |

## Under the hood

The starting agent uses helpers instead of raw action numbers and observation arrays. This section is a complete reference for reading those values yourself.

Without the helpers, a minimal agent has to read the mask by hand and know that bids live above card 51:

```python
def act(self, observation):
    mask = observation["action_mask"]
    if observation["observation"]["phase"] == 0:          # bidding
        return 52 + 1                                     # bid one trick
    legal = [card for card in range(52) if mask[card]]
    return min(legal, key=lambda card: card % 13)         # lowest legal card
```

### Actions

Your `act` method returns one integer from a combined set of bidding and card actions. During bidding, it must return a **bid**. During play, it must return a **card**. The action mask identifies the phase because it allows only bids during bidding and only cards during play.

#### Bids

A bid of `k` tricks uses action `52 + k`, where `k` is from `0` through `13`. A bid of three is action `55`, and nil (`k = 0`) is action `52`. The helper `bid(k)` builds this action. `legal_bids(observation)` lists the allowed bids as plain numbers from `0` through `13`.

#### Cards

During play, `act` returns a **card ID**, an integer from `0` through `51` that identifies one card. Card IDs count upward through all clubs, then all diamonds, spades, and hearts:

| Suit | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | J | Q | K | A |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Clubs | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| Diamonds | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 |
| Spades | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 |
| Hearts | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 49 | 50 | 51 |

For example, card `0` is the two of clubs, card `26` is the two of spades, and card `38` is the ace of spades, the highest card in the game. These numbers are identifiers, not positions on the table.

The encoding can also be written as `card = suit * 13 + rank`. The suit and rank numbers mean:

| Kind | Values |
| --- | --- |
| Suit | `0` clubs, `1` diamonds, `2` spades, `3` hearts |
| Rank | `0` two, `1` three, through `8` ten, `9` jack, `10` queen, `11` king, `12` ace |

To decode card `38`, divide it by 13. The whole-number result, `2`, means spades. The remainder, `12`, means ace. A card ID uses ranks `0` through `12`, while observation card objects and `rank_of` use face values `2` through `14`. You rarely need to convert either scale. Work with card objects and let `play(card)` build the ID.

#### The action mask

The action you return must have a `1` at the same position in `observation["action_mask"]`, which contains one entry for every action from `0` through `65`. The environment rejects an action whose entry is `0`. This includes a card you do not hold, a card that breaks a rule, a bid during play, or a card during bidding. Only one phase is legal at a time, so `legal_bids(observation)` is empty during play and `legal_cards(observation)` is empty during bidding.

### Observations

Your `act` method receives a dictionary with two keys:

```text
observation
├── "action_mask"    66 entries that say which actions are legal
└── "observation"    an object with your hand, the bids, the tricks, and the scores
```

The top-level `action_mask` is a 66-entry NumPy array indexed by action. Entries `0..51` are cards, and entries `52..65` are bids (`52 + k`). A `1` marks an action as legal. `legal_cards` and `legal_bids` read this array for you.

Everything else is under the `"observation"` key and uses meaningful structures. Your hand and tricks are sequences of card objects shaped like `{"suit", "rank"}`, and other small numbers represent categories. A few raw fields need a special code for "none yet": `14` means a player has not bid, and `4` means there is no led suit or completed trick. The matching helpers translate these codes to `None` or `-1`.

| Field | Shape | Values and meaning |
| --- | --- | --- |
| `hand` | sequence of cards | The card objects you are holding, in the order dealt. |
| `phase` | `0` or `1` | `0` during the bidding round, `1` during play. `is_bidding` reads this. |
| `bids` | 4 categories | Each player's bid indexed by player (`0..13`, where `0` is nil); `14` marks a player that has not bid yet. |
| `team_scores` | length-2 array | The two teams' running hand scores: `[team of players 0/2, team of players 1/3]`. |
| `current_trick` | sequence of `{player, card}` | The cards played to the current trick so far, in play order (the leader first). Empty when you are leading a fresh trick. |
| `last_trick` | sequence of `{player, card}` | The most recently completed trick, in play order, so a player that already played still sees it after it is swept away. Empty until the first trick of the hand completes. |
| `last_trick_winner` | `0..4` | The player that won the most recently completed trick; `4` means none has completed yet. |
| `led_suit` | `0..4` | `0` clubs, `1` diamonds, `2` spades, `3` hearts; `4` means no card has been led because you are starting the trick. |
| `spades_broken` | `0` or `1` | `0` means no spade has been played on an earlier trick; `1` means spades have been broken. |
| `player` | `0..3` | Your own player ID. |
| `partner_player` | `0..3` | Your partner's player, `(player + 2) % 4`, already computed for you. |
| `trick_leader` | `0..3` | The player that led the current trick. |
| `tricks_won` | length-4 array | Tricks taken so far, indexed by player. |

Read these through `observation["observation"]`, or let the helpers do it: `hand_cards`, `bids`, `team_scores`, `current_trick`, `last_trick`, `my_player`, `partner_player`, and the rest each return one of these fields as plain Python values.

#### How player numbers and partnerships work

Player IDs label PettingZoo positions rather than fixed screen positions. Player `0` controls `player_0`, player `1` controls `player_1`, and so on. Turns move clockwise. A platform **seat** is a separate assignment unit. The default `partnership` plan gives one seat to players 0 and 2 and another to players 1 and 3. The `solo` plan gives each player a separate seat:

```text
0 → 1 → 2 → 3 → 0
```

**Players determine partnerships.** Players `0` and `2` form one team, while players `1` and `3` form the other. Your partner is always directly across the table at `(your player + 2) % 4`. The observation provides this value as `partner_player`. A failed nil bidder's tricks still count for the team, and the team's contract combines both bids, so treat the game as two teams rather than four independent players.

The viewer rotates the table so that the player being viewed is at the bottom, with their partner at the top and the two opponents left and right. Therefore player `0` is not always at a fixed screen position.

Suppose `player` is `2`. Your agent controls player 2, so your `partner_player` is 0 and your opponents are players 1 and 3. If `bids` is `[3, 0, 4, 5]`, then player 0 bid 3, player 1 bid nil, your player 2 bid 4, and player 3 bid 5. Your team's contract is `3 + 4 = 7`. `current_trick` carries absolute player IDs too; because it is already in play order, its first entry is the player named by `trick_leader`.

## Time limits

Spades is turn-based, so moves have no fixed delay between them. Each call to `act` has a 1-second limit, and the agent may use up to 120 seconds of measured computation during one game. If `act` returns late during bidding, the environment makes a non-nil estimate from the hand. During card play, it chooses the legal card with the lowest rank, breaking ties with the lower suit ID. A human-controlled player has 60 seconds to move. See [Time limits](../../docs/students/agent-interface.md#time-limits) for how these limits are measured and enforced.

## Messaging

Spades supports messaging, so your agent may talk during a hand. If you add the optional `chat` method, the harness calls it on your turn immediately after `act` and before the trick is resolved:

```python
def chat(self, inbox):
    # inbox: messages sent to you since your last turn, each
    # {"from": player, "to": player_or_None, "text": str, "tick": int}.
    for message in inbox:
        ...  # read what your partner told you
    # Return messages to send: {"to": player_or_None, "text": str}.
    # "to": None broadcasts to the whole table; a player id is a private line.
    return [{"to": None, "text": "spades are mine"}]
```

`chat` receives the inbox but not the observation. Save anything it needs, such as your player or hand, in `act`, which runs first on every turn. Your partner is the player across from you: `player_((your_player + 2) % 4)`.

A **targeted** message is delivered only to the selected player, while a **broadcast** (`"to": None`) is delivered to the whole table. Direct choices come from the live game state. Your partner is listed first and is the default direct target on your turn. Broadcast to everyone is always available. Every message is recorded and shown in replays, so even a targeted message is not secret. In Spades, each message is limited to **120 Unicode code points**. An emoji counts as one code point, and a season may lower the limit. The [agent interface](../../docs/students/agent-interface.md#chatinbox) explains delivery timing, send limits, and how chat time counts toward your limits.

The two worked examples show both shapes: `signaler` sends its partner a targeted suit signal and leads the suit it is told about, and `daredevil` bids nil, broadcasts a warning, and covers a partner who did the same.

## Your first improvement

Run `python -m sandbox play` a few times. Watch the bidding round and the final score. Your agent promises one trick regardless of its cards. What does that fixed bid cost?

> Reread [Scoring and rewards](#scoring-and-rewards) next to a finished deal: every trick promised in advance is worth ten points, and every extra trick beyond the promise is worth one.

So the bid should depend on the hand. Knowing only your 13 cards, and that spades are always trump, how many tricks could you promise, and can your agent read those cards on its bidding turn?

> Scan the table in [The helper module](#the-helper-module) for what a bidding turn can see.

Record the average score from `python -m sandbox eval` before the change and again afterward. A bidding improvement appears over many deals, so compare averages across several games.

When the bid is honest, notice what has not changed: your agent still always plays its lowest card, which is a strategy for _losing_ tricks. Your team is now promising to win some. At what point in the thirteen tricks should your agent start trying to keep that promise?
