# Stage 11.3: Spades Semantic Observation

Status: not started.

Part of [Stage 11](../stage-11-semantic-contract.md). This is build-order step 3. Spades follows the Hearts pattern from step 2: it keeps its `Discrete(66)` action space and its 66-entry phase-aware `action_mask` exactly as they are, and only re-shapes the observation. The observation gains the partnership fields an agent previously had to derive or went without — `partner_seat` and the running `team_scores` — and its state goes object-shaped over the shared `local_play/spaces.py`. The `52 + k` bid encoding stays in the action, hidden behind a `bid(n)` helper (step 7). The hands-on surface is local play: a full bid-and-thirteen-tricks hand watchable and playable in a pygame window over the object-shaped observation.

## Why this is its own seam

Spades reuses everything Hearts settled — the shared card/hand/trick spaces, the play-ordered trick shape, the overlay normalization, the `api_test`-passes proof — and adds only what Spades genuinely adds: the two-phase observation (`phase`, `bids`), the partnership leaves, and the play-ordered `last_trick`. It converts after Hearts so those conventions are settled, and before the publication step so both card games flow into the generated artifacts together. `api_test` requires one fixed action space per agent (it asserts `action_space(agent) is action_space(agent)`), so the two phases stay in a single `Discrete(66)` with the mask lighting the legal half — the reason the action encoding is unchanged.

## What to build

### Codec from the shared module

`environments/src/spades/rules.py` sources its suit/rank semantics and the int↔object codec from `local_play/spaces.py`, replacing its own duplicated `suit_of`/`rank_of` (a test pins that both games now agree because they share the module). The action encoding is unchanged: `BID_OFFSET`, `bid_to_action`, `action_to_bid`, `action_is_bid` stay — they are what the `bid(n)` helper and the phase mask are built on. `step()` still takes an integer 0–65.

### Object-shaped observation

`environments/src/spades/env.py` keeps its `Discrete(66)` action space, the 66-entry `action_mask`, and its `IllegalMoveError`. The inner `observation` Dict becomes:

```python
"observation": spaces.Dict({
    "seat": spaces.Discrete(4), "partner_seat": spaces.Discrete(4),
    "phase": spaces.Discrete(2),                       # 0 = bidding, 1 = play
    "hand": HAND,
    "bids": spaces.Tuple([spaces.Discrete(15)] * 4),   # per seat 0..13, 14 = unbid
    "team_scores": spaces.Box(-1000, 1000, shape=(2,), dtype=np.int64),
    "current_trick": TRICK, "last_trick": TRICK,       # play-ordered; last_trick empty = none
    "last_trick_winner": spaces.Discrete(5),           # 4 = no completed trick
    "trick_leader": spaces.Discrete(4), "led_suit": spaces.Discrete(5),
    "spades_broken": spaces.Discrete(2),
    "tricks_won": spaces.Box(0, 13, shape=(4,), dtype=np.int64)}),
"action_mask": spaces.Box(0, 1, shape=(66,), dtype=np.int8)   # unchanged
```

Beyond the Hearts fields: `phase` is `0` (bidding) or `1` (play); `bids` holds category `14` for a seat that has not bid, replacing the minus-one sentinel; `last_trick` is a play-ordered `Sequence` of all four `{seat, card}` records, or the empty tuple before the first trick completes, with `last_trick_winner` following it (`4` = none); `partner_seat` is `(seat + 2) % 4`, stating the partnership (seats 0 and 2 against 1 and 3) instead of leaving it as table lore; `team_scores` is the two-element running projection from `rules.hand_team_scores` (team index `seat % 2`), final once the hand is terminal. Surfacing the score reverses the stage 8 decision to keep the observation score-free, deliberately, matching how the Hearts observation carries its running penalties. During play, `phase` flips, `bids` is fully populated, and the `action_mask` lights only the play half.

`step()` is unchanged: it dispatches on the integer (0–51 play, 52–65 bid), and a wrong-phase or illegal index raises `IllegalMoveError`. `default_action(env, slot_id)` returns `rules.resolve_auto_action(...)` as an integer index, preserving the never-nil timeout rule from stage 8.

`environments/src/spades/overlay.py` goes object-shaped in the same shapes, `bids` category-14 nulls included. On the pygame side, `spades/render.py` reads the normalized overlay from the step 2 machinery in `render_cards.py`, and `spades/human.py`/`spades/demo.py` keep returning integer action indices from the chip and card hit-tests (a bid chip → `52 + k`, a card → its id).

## Tests

`environments/tests/test_spades.py` and `test_spades_chat.py` are updated where they asserted on the old observation shape:

- **`test_passes_pettingzoo_api_test` stays** and passes over the object-shaped observation, dead-step cycle included.
- Every observation across a full seeded episode satisfies `observation_space.contains(obs)` and round-trips through JSON after a numpy→list coercion that recurses into the nested `Sequence`-of-`Dict` records (`current_trick`, `last_trick`) — card objects carry plain python `int`s from `card_to_obj`, never NumPy scalars, so no scalar buried in a card dict breaks `json.dumps`.
- Phase legality stays visible in the `action_mask`: the bid half lit during bidding, the play half after; `env.step` still raises on a wrong-phase or illegal index.
- `partner_seat` and `team_scores` are pinned against `rules.hand_team_scores` on worked fixtures, including a mid-hand projection and the terminal totals.
- `default_action(env, seat)` never returns nil during bidding and returns the lowest legal card index during play.
- The headless renderer hit-tests map a bid chip to index `52 + k` and a card to its id.

## Done when

A full Spades hand (four bids, thirteen tricks, team scores settled) plays to completion through the harness over the object-shaped observation, with scores matching the stage 8 worked examples. The hand is watchable and playable locally, bid chips and greyed cards driven by the `action_mask`, and a timed-out seat records the real bid or play index the default produced. `test_passes_pettingzoo_api_test` passes and the Python suite is green.
