# Spades

Spades is a four-player partnership card game. You and the player across the table form a team. Your team bids how many tricks it expects to take, then tries to take that many and score more points than the other team. The [agent interface](../../docs/students/agent-interface.md) explains the `reset` and `act` methods shared by every environment. This page covers everything specific to Spades.

After you complete [Getting Started](../../docs/students/getting-started.md), open `agent.py`, run `python -m sandbox play`, then follow [Your first agent](#your-first-agent).

## Seats and players

A **player** is one position at the card table. A **seat** is the set of players that one submission controls. Spades offers two seat plans:

| Plan | What one submission controls |
| --- | --- |
| `partnership` (default) | One partnership: player indices 0 and 2, or 1 and 3 |
| `solo` | One player index |

The default `partnership` plan runs one submission for each team. Game Sandbox creates a separate `Agent()` object for each player index controlled by that submission. The objects share code, not variables, so use optional `chat` to exchange information. A season can choose `solo`, which assigns one submission to each player index.

Player indices `0..3` are fixed clockwise turn-order labels. Indices `0` and `2` are partners, as are `1` and `3`; your partner is `(your player index + 2) % 4`. The viewer rotates the table, so an index is not a screen position.

## How the game works

Each player receives 13 cards from a standard 52-card deck. A hand has two phases: a **bidding round**, followed by 13 rounds of card play called **tricks**.

**Bidding.** Starting with player 0 and moving clockwise, each player bids once. A bid is a whole number from `0` to `13` that says how many tricks the player expects to take. A bid of `0` is **nil**, a promise to take no tricks. Your team's **contract** is the sum of your bid and your partner's bid.

**Tricks.** Player 0 starts the first trick. Whoever starts a trick **leads** it by playing the first card, and the others each add one card in clockwise order. The first card sets the **led suit**. If you hold a card of that suit, you must play one. This rule is called **following suit**. If you hold none, you may play any card.

Spades are always **trump**, which means any spade beats a card from another suit. The highest spade wins a trick. If no one plays a spade, the highest card of the led suit wins. The winner takes the trick and leads the next one.

This environment uses these Spades rules:

- Player 0 bids first and leads the first trick.
- You may not **lead** a spade until spades are **broken**, which means a spade has been played on an earlier trick. The one exception is a hand that holds nothing but spades, which may lead one.
- There is no blind or double nil: every bid is made with your hand in view.

You do not need to program these rules yourself. The template helpers read the observation and list the bids or cards you may choose on the current turn.

> _Never played Spades?_ The [Wikipedia article about Spades](https://en.wikipedia.org/wiki/Spades_%28card_game%29) provides a broader introduction.

## Your first agent

Your template contains a working agent. On each turn, `act` receives an observation of the table and returns a bid during bidding or a card during play. The helper module identifies the phase and presents raw values as card objects and plain Python values.

A card is a small object with a `suit` number from `0` through `3` and a `rank` number from `2` through `14`. The rank matches its face value: `11` is the jack, `12` is the queen, `13` is the king, and `14` is the ace. The ace of spades is therefore `{"suit": 2, "rank": 14}`.

The starting agent uses `is_bidding(observation)` to choose the right phase. It always bids one trick, then chooses the lowest-ranked legal card during play. [The helper module](#the-helper-module) defines these helpers.

```python
from sandbox.cards import SpadesObservation, bid, is_bidding, legal_cards, play, rank_of


class Agent:
    """Bids one trick, then always plays its lowest-ranked legal card."""

    def reset(self, seed, observation) -> None:
        # Called once before each hand. The opening observation is available here for
        # precomputation outside the decision clock. This agent keeps no state between turns.
        pass

    def act(self, observation: SpadesObservation) -> int:
        # A hand has two phases, and is_bidding tells you which one this turn
        # belongs to: first everyone bids, then thirteen tricks are played.
        if is_bidding(observation):
            # TODO(you): make this estimate depend on the cards in your hand.
            # A bid of 0 is nil, a risky promise to take none at all.
            return bid(1)

        # legal_cards reads the observation for you: every card object in this
        # list is a card you hold and may play right now, so the rules (follow
        # suit, spades not led until broken) are already taken care of.
        legal = legal_cards(observation)

        # TODO(you): low cards rarely win tricks, but your team must make its
        # contract. play(card) turns the chosen card into the action.
        return play(min(legal, key=rank_of))
```

Run the agent from the template folder:

```console
python -m sandbox play                 # watch separate copies of your agent play all four positions
python -m sandbox eval                 # play several seeded episodes and report the mean score
python -m sandbox eval --vs rivals/v1  # play against a saved copy of your agent
python -m sandbox test                 # run the checks
```

An episode is one complete hand, from bidding through trick 13. `eval` reports the higher-is-better [team score](#scoring-and-rewards); compare the same seeds, not one run.

## Scoring and rewards

Each team's final score is awarded at the end of the hand, while `team_scores` shows a running projection during the hand. Bags do not carry into a later hand, so the traditional ten-bag penalty does not apply.

- Your team's **contract** is the sum of your non-nil bid and your partner's non-nil bid. If the team takes at least that many tricks, it **makes** the contract and scores **10 points for each bid trick**. Each extra trick is an **overtrick**, also called a **bag**, and adds 1 point. If the team takes too few tricks, it is **set** and loses 10 points for each bid trick.
- A **nil** bid is scored separately from the team's contract. A successful nil, in which the bidder takes no tricks, earns **100 points**. A failed nil, in which the bidder takes at least one, loses 100. Tricks from a failed nil still count toward the team's total. They can help make the contract or become bags under the normal rules.
- When both partners bid nil, the team contract is zero and automatically made. Every trick either partner takes becomes a bag in addition to the nil penalties.

For example, if your partner bid 4 and took 3 tricks while you bid nil and took 2, your team's contract is 4 and it took 5 tricks: a made contract worth 40, plus 1 bag, minus your 100 nil penalty, for a team total of minus 59.

During play, every action gives a reward of `0.0`. When the game ends, each player's reward is their **team hand score**, so both partners receive the same value, and higher is better:

| Outcome                                   | Reward   |
| ----------------------------------------- | -------- |
| Made a contract of 4 with no bags         | `40.0`   |
| Made a contract of 4 with 2 bags          | `42.0`   |
| Set on a contract of 4                    | `-40.0`  |
| Both partners bid 13 (impossible to make) | `-260.0` |

The lowest possible team score is minus 260 (both partners bidding 13, a contract of 26 that thirteen tricks can never satisfy).

## The helper module

The starting agent uses the template's `sandbox.cards` helper module to avoid raw arrays and action numbers. Import what you need at the top of `agent.py`.

`is_bidding(observation)` tells you the phase, `bid(n)` and `play(card)` build actions, `legal_bids(observation)` and `legal_cards(observation)` list legal choices, and `partner_player(observation)` identifies your partner's player index. `Card` and `SpadesObservation` are importable for editors and type checkers. The [raw reference](#under-the-hood) documents encodings.

The module provides these helpers and constants:

| Helper or constant | Result |
| --- | --- |
| `is_bidding(observation)` | `True` during the bidding round, `False` during play |
| `legal_bids(observation)` | Bids you may make now, as numbers `0..13` (empty during play) |
| `legal_cards(observation)` | Legal card objects for this turn (empty during bidding) |
| `bid(n)` | The integer action for a bid of `n` tricks (`0..13`) |
| `play(card)` | The integer action for a card object, the value `act` returns |
| `hand_cards(observation)` | Every card object in your hand |
| `my_player(observation)` | Your player index |
| `partner_player(observation)` | Your partner's player index, read from the observation |
| `partner_of(player)` | A player index's partner, `(player + 2) % 4` |
| `bids(observation)` | The four bids indexed by player index (`-1` before a player bids) |
| `tricks_won(observation)` | Tricks taken so far, indexed by player index |
| `team_scores(observation)` | The two teams' running projected hand scores, `[team of 0/2, team of 1/3]` |
| `led_suit(observation)` | Led suit ID, or `None` when you are leading |
| `spades_broken(observation)` | `True` after spades are broken, otherwise `False` |
| `current_trick(observation)` | `(player index, card)` pairs in the current trick, in play order |
| `last_trick(observation)` | `(player index, card)` pairs of the most recently completed trick |
| `last_trick_winner(observation)` | Player index that won the last completed trick, or `None` |
| `trick_winner_so_far(observation)` | The `(player index, card)` currently winning the trick (spades are trump), or `None` |
| `beats_current_winner(observation, card)` | Whether playing `card` now would take the trick |
| `suit_of(card)` / `rank_of(card)` | A card object's suit ID `0..3` / face-value rank `2..14` |
| `make_card(suit, rank)` | A card object `{"suit": suit, "rank": rank}` from a suit ID and face-value rank |
| `card_name(card)` | Readable text such as `"A of spades"` |
| `CLUBS`, `DIAMONDS`, `SPADES`, `HEARTS` | Names for suit IDs `0`, `1`, `2`, and `3` |
| `SUIT_NAMES` | Suit names indexed by suit ID, `("clubs", "diamonds", "spades", "hearts")`, useful for messages about suits |
| `RANK_NAMES` | Rank names indexed by face-value rank; `RANK_NAMES[rank_of(card)]` gives `"2"` through `"10"`, then `"J"`, `"Q"`, `"K"`, `"A"` |

## Your first improvement

For your first improvement, make the fixed bid depend on your hand. Add `hand_cards` to the import, then replace `return bid(1)` with this small estimate: one trick for each king or ace, but never nil.

```python
return bid(max(1, sum(rank_of(card) >= 13 for card in hand_cards(observation))))
```

Run `python -m sandbox eval` before and after the edit, comparing averages across complete seeded hands. Keep the playing strategy unchanged for now. It still spends low cards even when the team needs tricks.

When your agent is ready, follow the [submitting guide](../../docs/students/submitting.md) to submit it.

## Under the hood

This optional raw reference shows the values behind the helpers. Most agents can use the helpers instead.

Without the helpers, a minimal agent has to read the mask by hand and know that bids live above card 51:

```python
def card_rank(card):
    return card % 13


def act(self, observation):
    mask = observation["action_mask"]
    if observation["observation"]["phase"] == 0:          # bidding
        return 52 + 1                                     # bid one trick
    legal = [card for card in range(52) if mask[card]]
    return min(legal, key=card_rank)  # lowest legal card
```

### Actions

Your `act` method returns one integer from combined bidding and card actions: a **bid** during bidding and a **card** during play. The action mask permits only the matching phase.

#### Bids

A bid of `k` tricks uses action `52 + k`, where `k` is from `0` through `13`. A bid of three is action `55`, and nil (`k = 0`) is action `52`. The helper `bid(k)` builds this action. `legal_bids(observation)` lists the allowed bids as plain numbers from `0` through `13`. The helper `action_to_bid(action)` reverses the encoding, and the constants `NIL_BID` (`0`) and `BID_OFFSET` (`52`) name the two numbers it uses.

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

To decode card `38`, divide it by 13. The whole-number result, `2`, means spades. The remainder, `12`, means ace. A card ID uses ranks `0` through `12`, while observation card objects and `rank_of` use face values `2` through `14`. You rarely need to convert between the two: work with card objects and let `play(card)` build the ID.

#### The action mask

`observation["action_mask"]` contains one entry for every action from `0` through `65`. The action you return must have a `1` at the same position. The environment rejects an action whose entry is `0`, including a card you do not hold, a card that breaks a rule, a bid during play, or a card during bidding. Only one phase is legal at a time, so `legal_bids(observation)` is empty during play and `legal_cards(observation)` is empty during bidding.

### Observations

Your `act` method receives a dictionary with two keys:

```text
observation
├── "action_mask"    66 entries that say which actions are legal
└── "observation"    an object with your hand, the bids, the tricks, and the scores
```

The top-level `action_mask` is a 66-entry NumPy array indexed by action. Entries `0..51` are cards and `52..65` are bids (`52 + k`). A `1` is legal. `legal_cards` and `legal_bids` read it for you.

Everything else lives under the `"observation"` key. Your hand and tricks are sequences of card objects shaped like `{"suit", "rank"}`, and the other small numbers stand for categories. A few raw fields need a special code for "none yet": `14` means a player has not bid, and `4` means there is no led suit or completed trick. The matching helpers translate these codes to `None` or `-1`.

| Field | Shape | Values and meaning |
| --- | --- | --- |
| `hand` | sequence of cards | The card objects you are holding, in the order dealt. |
| `phase` | `0` or `1` | `0` during the bidding round, `1` during play. `is_bidding` reads this. |
| `bids` | 4 categories | Each bid indexed by player index (`0..13`, where `0` is nil); `14` marks an index that has not bid yet. |
| `team_scores` | length-2 array | The two teams' running projected hand scores: `[team of player indices 0/2, team of 1/3]`. |
| `current_trick` | sequence of `{player, card}` | The cards played to the current trick so far, in play order (the leader first). Empty when you are leading a fresh trick. |
| `last_trick` | sequence of `{player, card}` | The most recently completed trick, in play order. Empty until the first trick completes. |
| `last_trick_winner` | `0..4` | The player index that won the most recent trick; `4` means none has completed yet. |
| `led_suit` | `0..4` | `0` clubs, `1` diamonds, `2` spades, `3` hearts; `4` means no card has been led because you are starting the trick. |
| `spades_broken` | `0` or `1` | `0` means no spade has been played on an earlier trick; `1` means spades have been broken. |
| `player` | `0..3` | Your own player index. |
| `partner_player` | `0..3` | Your partner's player index, `(player + 2) % 4`. |
| `trick_leader` | `0..3` | The player index that led the current trick. |
| `tricks_won` | length-4 array | Tricks taken so far, indexed by player index. |

Read these through `observation["observation"]`, or use the matching helpers.

## Time limits

Spades is turn-based, so moves have no fixed delay between them. If `act` returns late during bidding, the environment makes a non-nil estimate from the hand. During card play, it chooses the legal card with the lowest rank, breaking ties with the lower suit ID. The game continues after this legal default. See [Time limits](../../docs/students/agent-interface.md#time-limits) for the applicable limits and forfeit rules.

## Messaging

Spades enables messaging by default, so your agent may talk during a hand. `agent.py` includes a commented-out `chat` method to start from. The complete agent below sends one direct message to its partner on every turn:

```python
from sandbox.cards import bid, is_bidding, legal_cards, partner_player, play


class Agent:
    def reset(self, seed, observation):
        self.partner = None
        self.partner_message = None

    def act(self, observation):
        partner_index = partner_player(observation)
        self.partner = f"player_{partner_index}"
        if is_bidding(observation):
            return bid(1)
        return play(legal_cards(observation)[0])

    def chat(self, inbox):
        for message in inbox:
            if message["from"] == self.partner:
                self.partner_message = message["text"]
        return [{"to": self.partner, "text": "I am ready"}]
```

Messages use a platform player ID string such as `"player_2"`, not the player index in the observation. The example builds the platform player ID from the partner index and saves it during `act`, because `chat` does not receive the observation. A message can hold up to 120 characters by default (some emoji count as more than one). A season can lower that cap or disable messaging, but cannot raise it. See the [agent interface](../../docs/students/agent-interface.md#chatinbox) for delivery timing, broadcast and targeted messages, replay visibility, and how chat time counts toward your limits.
