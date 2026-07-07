# Stage 11.2: Hearts Semantic Observation

Status: not started.

Part of [Stage 11](../stage-11-semantic-contract.md). This is build-order step 2, the first environment conversion and the pattern the Spades conversion mirrors. Hearts keeps its `Discrete(52)` action and its 52-entry `action_mask` exactly as they are, and only re-shapes the observation: the inner state becomes object-shaped composite spaces (a hand of card objects, a play-ordered trick of `{seat, card}` records) built over the shared `local_play/spaces.py`, while the observation keeps its `{"observation": {...}, "action_mask": Box(52)}` wrapper. `pettingzoo.test.api_test` stays and keeps passing. The hands-on surface is local play: a full Hearts hand watchable and playable in a pygame window over the object-shaped observation.

## Why this is its own seam

Hearts is the simplest card game on the platform (one phase, one action form), so it converts first and settles every shared convention: the object-shaped inner observation, the play-ordered trick shape, the overlay normalization both renderer stacks reuse, and — critically — the proof that a composite `Dict`/`Sequence` observation space still passes `api_test`. Spades then inherits all of it and adds only what Spades genuinely adds. Because the action and mask do not change, this step is the low-risk spike that de-risks the composite observation space for the rest of the stage.

## What to build

### Codec from the shared module

`environments/src/hearts/rules.py` stays int-based internally (the engine is pure and heavily tested) and sources its suit/rank semantics and the int↔object codec (`card_to_obj`, `card_from_obj`, `SUIT_NAMES`) from `local_play/spaces.py` instead of its own duplicated `suit_of`/`rank_of` constants. Conversion happens only in `env.py` and `overlay.py`; no rules function changes signature, and `step()` still takes an integer card id.

### Object-shaped observation

`environments/src/hearts/env.py` keeps its `Discrete(52)` action space, its `observation_space`/`action_space` accessors (returning the same objects by identity, as `api_test` requires), `AUTO_ACTION`'s replacement by a real default, and its `IllegalMoveError`. The `observation_space` becomes:

```python
observation_space = spaces.Dict({
    "observation": spaces.Dict({
        "seat": spaces.Discrete(4),
        "hand": HAND,                       # from local_play.spaces
        "current_trick": TRICK,             # play-ordered [{seat, card}] records
        "trick_leader": spaces.Discrete(4),
        "led_suit": spaces.Discrete(5),     # 4 = no suit led
        "hearts_broken": spaces.Discrete(2),
        "scores": spaces.Box(0, 26, shape=(4,), dtype=np.int64)}),
    "action_mask": spaces.Box(0, 1, shape=(52,), dtype=np.int8)})  # unchanged
```

`observe()` builds this dict: `seat` is the acting seat 0–3 (the field the old observation called `position`); `hand` keeps today's ordering (ascending by suit clubs, diamonds, spades, hearts, then by rank), emitted as a tuple of card objects; `current_trick` is a play-ordered tuple of `{"seat": <0..3>, "card": {...}}` records holding only the seats that have played (a sparse seat-keyed dict is impossible — `Dict.contains` requires every key); `led_suit` is `0..3` or `4` for none; `scores` is the per-seat running penalty count as a numpy array. `observe()` emits real tuples for the `Sequence` fields and a numpy array for `scores`, or `contains` fails; the card objects inside `hand`/`current_trick` carry plain python `int`s straight from `card_to_obj`, never NumPy scalars, so the nested records serialize cleanly. The top-level `action_mask` is built exactly as today.

`step()` is unchanged: it takes an integer card id, applies it, and raises `IllegalMoveError` on an illegal one. A module-level `default_action(env, slot_id)` returns the lowest legal card index for the timeout path, and `__init__.py` points `ENTRY.default_action` at it. No `schemas.py`, no metadata change.

`environments/src/hearts/overlay.py` goes object-shaped in the same shapes: hands and tricks as card objects with play-ordered `{seat, card}` records and `led_suit` as `0..3` or `4`, because the overlay is part of the recorded artifact and must carry the same shape the observation does.

### Local pygame path

The shared card-table renderer in `environments/src/local_play/render_cards.py` gains a single overlay normalization point that maps card objects back to ints (reusing `card_from_obj`), so its geometry and hit-test code stays int-keyed; `hearts/render.py` adjusts its game-specific overlay reads, and `hearts/human.py`/`hearts/demo.py` keep returning integer card ids (the human click already hit-tests to a card id; no action wrapping is needed since the action is still an index).

## Tests

`environments/tests/test_hearts.py` is updated where it asserted on the old observation shape:

- **`test_passes_pettingzoo_api_test` stays** and passes over the object-shaped observation, including the terminal `step(None)` dead-step cycle — this is the core proof of the stage.
- Every observation across a full seeded episode satisfies `observation_space.contains(obs)`, and round-trips unchanged through `json.dumps`/`json.loads` after a numpy→list coercion that **recurses into the nested `Sequence`-of-`Dict` records** — not only top-level arrays — so no NumPy scalar buried in a card dict breaks `json.dumps` at record time (pinning that the recorded overlay carries the same shape).
- `hand`/`current_trick` decode back to the same card ids `rules` produced; the codec round-trips all 52 cards.
- The `action_mask` still agrees with `rules.legal_moves`, is empty off-turn, and `env.step` still raises on an illegal card id.
- `default_action(env, seat)` returns the lowest legal card index on fixture states.
- The headless renderer still frames both a live trick and a hand, and hit-tests map a card click to the expected card id.

## Done when

A full Hearts hand plays to completion through the harness with built-in defaults in all four seats, over the object-shaped observation, and a timeout records the real card index the default produced. The hand is watchable and playable locally in the pygame window, with illegal cards greyed from the `action_mask`. `test_passes_pettingzoo_api_test` passes on the new observation, and the Python suite is green.
