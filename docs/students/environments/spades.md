# Spades

Spades is a four-player partnership card game in which you and the player across the table are a team, and the goal is to score more points than the other team by bidding the number of tricks you will take and then taking them. Your agent controls one of the four players. The [agent interface](../agent-interface.md) explains the parts that work the same in every environment, including the `reset` and `act` methods. This page explains everything specific to Spades.

## How the game works

Each player receives 13 cards from a standard 52-card deck. A hand has two phases: a **bidding round**, then thirteen **tricks**.

**Bidding.** Starting with seat 0 and going clockwise, each player bids once: a whole number from `0` to `13` saying how many tricks they expect to take. A bid of `0` is **nil**, a promise to take no tricks at all. Your team's **contract** is the sum of you and your partner's bids.

**Tricks.** Seat 0 leads the first trick. One player **leads** by playing the first card of a trick, then the other three players each play one card in clockwise order. The suit of the first card is the **led suit**. If you have a card of the led suit, you must play one; this is **following suit**. If you have none, you may play any card.

Spades are always **trump**: a trick is won by the highest spade played to it, or, if no spade is played, by the highest card of the led suit. The winner takes the trick and leads the next one.

This environment uses these Spades rules:

- Seat 0 bids first and leads the first trick.
- You may not **lead** a spade until spades are **broken**, which means a spade has been played on an earlier trick. The one exception is a hand that holds nothing but spades, which may lead one.
- There is no blind or double nil: every bid is made with your hand in view.

You do not need to reproduce these rules in your agent. Every observation includes an action mask that identifies the actions that are legal on the current turn.

If you have never played, the [Wikipedia article about Spades](https://en.wikipedia.org/wiki/Spades_%28card_game%29) provides a broader introduction.

## Your first agent

Your template already contains a complete, working agent, the one this section builds. It runs before you change anything, and the rest of this section explains it line by line so you can see exactly how a turn is decided.

On each of your turns the harness calls `act` with an observation of the table, and your job is to return one action. Spades has two kinds of turn, though: during the bidding round you return a bid, and during play you return a card. The template's helper module turns the observation into card objects and plain Python values and tells you which kind of turn you are on, so you never handle raw numbers.

A card is a small object, `{"suit": 0..3, "rank": 2..14}`, where the rank is the face value printed on the card (`11` is the jack, `12` the queen, `13` the king, `14` the ace). So the ace of spades is `{"suit": 2, "rank": 14}`.

`is_bidding(observation)` returns `True` while the table is still bidding and `False` once the cards are being played, so a single `if` sends each turn down the right path.

`bid(n)` turns a bid of `n` tricks into the integer that `act` must return for it. During the bidding round this agent calls `bid(1)` to promise one trick.

`legal_cards(observation)` gives you the list of card objects you are allowed to play this turn. It already accounts for every rule, following suit and not leading a spade before spades are broken, so every card it returns is a legal move.

`rank_of(card)` reads a card object's face-value rank, from the two up to the ace, ignoring its suit. Passing it as the `key` to Python's built-in `min` picks the lowest-ranked card out of a list, and `play(card)` turns the card you chose into the integer `act` returns.

The strategy is two simple ideas. When bidding, always promise exactly one trick: a bid of `0` is nil, a risky promise to take no tricks at all, so `1` is the smallest safe bid a simple agent can make. When playing, always play the lowest-ranked legal card, since low cards rarely win a trick you did not plan to take. It will not win many hands, but it is legal, complete, and a base you can build on.

```python
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
        # a better bid. play() turns your chosen card object into the integer
        # act() must return.
        return play(min(legal, key=rank_of))
```

This agent can never make an illegal move. During bidding every bid from `0` to `13` is always allowed, so promising one is safe; during play it only ever returns a card that came from `legal_cards`. You never have to check the rules yourself.

With the agent already in place, you can run it straight away from the template folder:

```console
python -m sandbox play    # watch it take a seat in your browser
python -m sandbox eval    # play several seeded games and report the mean score
python -m sandbox test    # run the checks, which pass before you change anything
```

`eval` reports a score you can read with the [Scoring and rewards](#scoring-and-rewards) section below, and `test` is green on the fresh template because this agent is already complete.

The `TODO(you)` comment inside `act` marks where you take over. Bidding a flat one and never trying to win a trick is exactly what a good agent improves on. When you are ready, the [Your first improvement](#your-first-improvement) section shows you how to find the first step yourself.

## Scoring and rewards

Scoring is settled once, at the end of the single hand, per team.

- Your team's **contract** is the sum of you and your partner's non-nil bids. If your team takes at least that many tricks, it **makes** the contract and scores **ten points per bid trick**, plus **one point per overtrick** (an extra trick beyond the contract, called a **bag**). If it takes fewer, it is **set** and scores **minus ten points per bid trick**.
- A **nil** bid is scored separately for the bidder, on top of the team's contract score. A made nil (the nil bidder took no tricks) earns **one hundred points**; a set nil (they took at least one) loses one hundred. A set nil's tricks still count toward the partnership's trick total, so they can help make the team's contract and can become bags, under the normal rules.
- When both partners bid nil, the team contract is zero and is trivially made, so every trick either partner takes lands as a bag beside the nil penalties.

For example, if your partner bid 4 and took 3 tricks while you bid nil and took 2, your team's contract is 4 and it took 5 tricks: a made contract worth 40, plus 1 bag, minus your 100 nil penalty, for a team total of minus 59.

Both partners always share the same team score. During play, every player receives a reward of `0.0` after each action. When the hand ends, each player's reward is that player's **team hand score**, so partners receive the same number, and higher is better:

| Outcome                                   | Reward   |
| ----------------------------------------- | -------- |
| Made a contract of 4 with no bags         | `40.0`   |
| Made a contract of 4 with 2 bags          | `42.0`   |
| Set on a contract of 4                    | `-40.0`  |
| Both partners bid 13 (impossible to make) | `-260.0` |

The lowest possible team score is minus 260 (both partners bidding 13, a contract of 26 that thirteen tricks can never satisfy), so a crashed or timed-out seat can never outscore honest play.

## The helper module

Your first agent used `sandbox.cards`, the template's plain Python helper module. Import what you need from it at the top of `agent.py`, never inside a method. It reads the observation for you and hands back card objects, bid numbers, lists, and plain Python values, so `act` never touches a raw NumPy array, the action mask, or the bid encoding.

`is_bidding(observation)` tells you which phase the turn belongs to, `bid(n)` and `play(card)` build the two kinds of action, `legal_bids(observation)` and `legal_cards(observation)` list your legal choices, and `partner_seat(observation)` names your teammate. The [Under the hood](#under-the-hood) section below documents the raw fields and encodings these read from, but most agents never need them.

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
| `my_seat(observation)` | Your seat ID |
| `partner_seat(observation)` | Your partner's seat, read from the observation |
| `partner_of(seat)` | A seat's partner, `(seat + 2) % 4`, when you only have a seat number |
| `bids(observation)` | The four seats' bids indexed by seat (`-1` before a seat bids) |
| `tricks_won(observation)` | Tricks taken so far, indexed by seat |
| `team_scores(observation)` | The two teams' running hand scores, `[team of 0/2, team of 1/3]` |
| `led_suit(observation)` | Led suit ID, or `None` when you are leading |
| `spades_broken(observation)` | `True` after spades are broken, otherwise `False` |
| `current_trick(observation)` | `(seat, card)` pairs in the current trick, in play order |
| `last_trick(observation)` | `(seat, card)` pairs of the most recently completed trick |
| `last_trick_winner(observation)` | Seat that won the last completed trick, or `None` |
| `trick_winner_so_far(observation)` | The `(seat, card)` currently winning the trick (spades are trump), or `None` |
| `beats_current_winner(observation, card)` | Whether playing `card` now would take the trick |
| `suit_of(card)` / `rank_of(card)` | A card object's suit ID `0..3` / face-value rank `2..14` |
| `make_card(suit, rank)` | A card object `{"suit": suit, "rank": rank}` from a suit ID and face-value rank |
| `card_name(card)` | Readable text such as `"A of spades"` |
| `CLUBS`, `DIAMONDS`, `SPADES`, `HEARTS` | Names for suit IDs `0`, `1`, `2`, and `3` |
| `NIL_BID`, `BID_OFFSET` | The nil bid (`0`) and the bid action offset (`52`) |

## Under the hood

Your first agent never touched a raw action integer or a raw observation array; the helpers handled both. This section is the full reference for what `act` returns and what the observation contains, for when you outgrow the helpers and want to read the table yourself.

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

Your `act` method returns one integer from a single combined action space that covers both phases. During the bidding round it must be a **bid**; during play it must be a **card**. The action mask tells you which phase it is: only bids are legal while bidding, only cards while playing.

#### Bids

A bid of `k` tricks is the action `52 + k`, for `k` from `0` through `13`. So a bid of three tricks is action `55`, and a nil bid (`k = 0`) is action `52`. The helper `bid(k)` builds this for you, and `legal_bids(observation)` lists the bids you may make as plain numbers `0..13`.

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

To decode card `38`, divide by 13: the whole-number result `2` means spades and the remainder `12` means ace. The rank digit inside an ID runs `0`–`12`, while the card objects you read from the observation (and `rank_of`) use the printed face value `2`–`14`. You rarely need either scale: stay in card objects and let `play(card)` build the ID for you.

#### The action mask

The action you return must have a `1` in the same position of `observation["action_mask"]`, which has one entry per action `0..65`. The environment rejects any action whose mask entry is `0`: a card you do not hold, a card that breaks a game rule, a bid during play, or a card during bidding. On your turn exactly one phase's actions are unmasked, so `legal_bids(observation)` is empty during play and `legal_cards(observation)` is empty during bidding.

### Observations

Your `act` method receives a dictionary with two keys:

```text
observation
├── "action_mask"    66 entries that say which actions are legal
└── "observation"    an object with your hand, the bids, the tricks, and the scores
```

The top-level `action_mask` is a length-66 NumPy array indexed by action: entries `0..51` are cards, `52..65` are bids (`52 + k`), and a `1` marks a legal action. It is the one place indices survive, and `legal_cards` and `legal_bids` read it for you.

Everything else lives under the `"observation"` key, and it is **semantic**: your hand and the tricks are sequences of card objects `{"suit", "rank"}`, and the rest are plain categories. A few fields carry a raw "none yet" code — `14` for a seat that has not bid, `4` for no led suit or no completed trick — and the matching helper translates it to `None` or `-1` for you.

| Field | Shape | Values and meaning |
| --- | --- | --- |
| `hand` | sequence of cards | The card objects you are holding, in the order dealt. |
| `phase` | `0` or `1` | `0` during the bidding round, `1` during play. `is_bidding` reads this. |
| `bids` | 4 categories | Each seat's bid indexed by seat (`0..13`, where `0` is nil); `14` marks a seat that has not bid yet. |
| `team_scores` | length-2 array | The two teams' running hand scores: `[team of seats 0/2, team of seats 1/3]`. |
| `current_trick` | sequence of `{seat, card}` | The cards played to the current trick so far, in play order (the leader first). Empty when you are leading a fresh trick. |
| `last_trick` | sequence of `{seat, card}` | The most recently completed trick, in play order, so a seat that already played still sees it after it is swept away. Empty until the first trick of the hand completes. |
| `last_trick_winner` | `0..4` | The seat that won the most recently completed trick; `4` means none has completed yet. |
| `led_suit` | `0..4` | `0` clubs, `1` diamonds, `2` spades, `3` hearts; `4` means no card has been led because you are starting the trick. |
| `spades_broken` | `0` or `1` | `0` means no spade has been played on an earlier trick; `1` means spades have been broken. |
| `seat` | `0..3` | Your own seat ID. |
| `partner_seat` | `0..3` | Your partner's seat, `(seat + 2) % 4`, already computed for you. |
| `trick_leader` | `0..3` | The seat that led the current trick. |
| `tricks_won` | length-4 array | Tricks taken so far, indexed by seat. |

Read these through `observation["observation"]`, or let the helpers do it: `hand_cards`, `bids`, `team_scores`, `current_trick`, `last_trick`, `my_seat`, `partner_seat`, and the rest each return one of these fields as plain Python values.

#### How seat numbers and partnerships work

Seat IDs are player labels, not fixed locations on the screen. Seat `0` controls `player_0`, seat `1` controls `player_1`, and so on. Turns move clockwise in this order:

```text
0 → 1 → 2 → 3 → 0
```

**Partnerships are fixed by seat.** Seats `0` and `2` are one team; seats `1` and `3` are the other. Your partner is always the seat directly across the table, `(your seat + 2) % 4`, which the observation gives you directly as `partner_seat`. Because a set nil's tricks still count toward the partnership, and because your team's contract combines both bids, you always read the game as two teams, not four players.

The viewer rotates the table so that the player being viewed is at the bottom, with their partner at the top and the two opponents left and right. Therefore seat `0` is not always the bottom, top, left, or right seat.

Suppose `seat` is `2`. Your agent controls seat 2, so your `partner_seat` is 0 and your opponents are seats 1 and 3. If `bids` is `[3, 0, 4, 5]`, then seat 0 bid 3, seat 1 bid nil, your seat 2 bid 4, and seat 3 bid 5. Your team's contract is `3 + 4 = 7`. `current_trick` carries absolute seat IDs too; because it is already in play order, its first entry is the seat named by `trick_leader`.

## Time limits

Spades is turn-based, so there is no fixed delay between moves. Each call to `act` has a 1-second limit, and one game has a 120-second limit on the agent's total measured compute. If `act` returns late, the environment chooses a legal action for the agent: during bidding it bids a never-nil estimate derived from the hand, and during play it plays the lowest legal card (lowest rank, ties broken by the lower suit ID). When a human controls a seat, the move deadline is 60 seconds. See [Time limits](../agent-interface.md#time-limits) for how these limits are enforced and measured.

## Messaging

Spades has messaging **enabled**, so your agent may talk during a hand. Add the optional `chat` hook and the harness calls it on your turn, right after `act` and before the trick resolves:

```python
def chat(self, inbox):
    # inbox: messages sent to you since your last turn, each
    # {"from": slot, "to": slot_or_None, "text": str, "tick": int}.
    for message in inbox:
        ...  # read what your partner told you
    # Return messages to send: {"to": slot_or_None, "text": str}.
    # "to": None broadcasts to the whole table; a slot id is a private line.
    return [{"to": None, "text": "spades are mine"}]
```

`chat` receives only the inbox, not the observation, so stash anything it needs (your seat, your hand) in `act`, which runs first every turn. Your partner is the seat across, `player_((your_seat + 2) % 4)`.

Because you and the seat across are partners, a **targeted** message to that seat is a private signal, while a **broadcast** (`"to": None`) is heard by the whole table, two genuinely different acts. You may send at most one message to each recipient plus one broadcast per turn, and each message is plain text capped at **120 Unicode code points** (an emoji counts as one; a season may lower the cap). A message you send reaches its recipients on **their next turn**, never the tick you sent it, so `chat` announces intent rather than reacting to a result. Every message is recorded and shown in replays, so nothing you send is secret, and chat time counts against your step and episode limits like `act` and `learn`.

The two worked examples show both shapes: `signaler` sends its partner a targeted suit signal and leads the suit it is told about, and `daredevil` bids nil, broadcasts a warning, and covers a partner who did the same. See the [agent interface](../agent-interface.md#chatinbox) for the full contract.

## Your first improvement

Run `python -m sandbox play` a few times and watch the bidding round, then the score at the end. Your agent promises one trick no matter what it was dealt. What does that flat bid cost it?

> Reread [Scoring and rewards](#scoring-and-rewards) next to a finished deal: every trick promised in advance is worth ten points, and every extra trick beyond the promise is worth one.

So the bid should depend on the hand. Knowing only your 13 cards, and that spades are always trump, how many tricks could you promise, and can your agent read those cards on its bidding turn?

> Scan the table in [The helper module](#the-helper-module) for what a bidding turn can see.

Record the mean score from `python -m sandbox eval` before the change, and again after. A bid change shows up over many deals, not one, so evaluate your agent with the mean over several games.

When the bid is honest, notice what has not changed: your agent still always plays its lowest card, which is a strategy for _losing_ tricks. Your team is now promising to win some. At what point in the thirteen tricks should your agent start trying to keep that promise?
