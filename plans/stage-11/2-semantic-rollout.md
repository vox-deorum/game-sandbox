# Stage 11.2: Semantic Rollout

Status: complete. The semantic contract was rolled out across every environment and consumer as one change. One deviation from the original plan: since template version 1 was never published, this stage keeps version 1 and updates the v1 built-in agents in place instead of publishing a version 2 (see the "Templates, examples, and built-ins" section below).

Part of [Stage 11](../stage-11-semantic-contract.md). This is the breaking contract change. It converts every environment and every consumer in one change so observations, overlays, renderers, templates, built-in agents, fixtures, and tests never disagree about card representation or default actions.

## Observation contract

Hearts and Spades keep the `{"observation": {...}, "action_mask": ...}` wrapper: the semantic state becomes an object-shaped composite inner `observation` Dict beside the top-level `action_mask` (see the #1211 workaround in step 1). Sequence values are tuples, card and categorical values are plain Python integers, and numeric arrays retain their declared NumPy dtypes.

Hearts keeps `Discrete(52)` actions and this observation shape:

```python
spaces.Dict({
    "observation": spaces.Dict({
        "seat": spaces.Discrete(4),
        "hand": HAND,
        "current_trick": TRICK,
        "trick_leader": spaces.Discrete(4),
        "led_suit": spaces.Discrete(5),
        "hearts_broken": spaces.Discrete(2),
        "scores": spaces.Box(0, 26, shape=(4,), dtype=np.int64),
    }),
    "action_mask": spaces.Box(0, 1, shape=(52,), dtype=np.int8),
})
```

`seat` replaces `position`. Hands keep their current suit-and-rank order. Tricks contain only played seats in play order. `led_suit` uses 4 when no suit is led. The mask remains empty off-turn and agrees with `rules.legal_moves`.

Spades keeps `Discrete(66)` actions and adds bidding and partnership state:

```python
spaces.Dict({
    "observation": spaces.Dict({
        "seat": spaces.Discrete(4),
        "partner_seat": spaces.Discrete(4),
        "phase": spaces.Discrete(2),
        "hand": HAND,
        "bids": spaces.Tuple([spaces.Discrete(15)] * 4),
        "team_scores": spaces.Box(-1000, 1000, shape=(2,), dtype=np.int64),
        "current_trick": TRICK,
        "last_trick": TRICK,
        "last_trick_winner": spaces.Discrete(5),
        "trick_leader": spaces.Discrete(4),
        "led_suit": spaces.Discrete(5),
        "spades_broken": spaces.Discrete(2),
        "tricks_won": spaces.Box(0, 13, shape=(4,), dtype=np.int64),
    }),
    "action_mask": spaces.Box(0, 1, shape=(66,), dtype=np.int8),
})
```

`phase` is 0 for bidding and 1 for play. Bid category 14 means unbid. `partner_seat` is `(seat + 2) % 4`. `team_scores` comes from `rules.hand_team_scores`. `last_trick` is empty before the first completed trick, and `last_trick_winner` uses 4 for none. The phase-aware mask remains the only agent legality channel.

Flappy Bird replaces its twelve-float vector with the object already used for rendering:

```python
spaces.Dict({
    "player": spaces.Dict({
        key: spaces.Box(-np.inf, np.inf, shape=(), dtype=np.float32)
        for key in ("x", "y", "vel_y", "rot")
    }),
    "pipes": spaces.Sequence(spaces.Dict({
        key: spaces.Box(-np.inf, np.inf, shape=(), dtype=np.float32)
        for key in ("x", "gap_top", "gap_bottom")
    })),
    "pipes_passed": spaces.Box(0, np.iinfo(np.int64).max, shape=(), dtype=np.int64),
    "width": spaces.Discrete(4096),
    "height": spaces.Discrete(4096),
})
```

Add `FlappyBirdEnv(GymnasiumToAEC)` and replace the inherited public `observation_spaces` and `action_spaces` mappings so the inherited accessors and callers share one source of truth. Refactor the overlay reader so observations receive a pipe tuple and recorded overlays receive a JSON list from the same ordered values. Flappy keeps `Discrete(2)` and has no mask because idle and flap are always legal on a live turn.

Each `observation_space(agent)` and `action_space(agent)` accessor returns the same instance on every call — `api_test` asserts this identity — so each space is built once and cached. The two Spades phases therefore share one `Discrete(66)` space, with the mask lighting the legal half.

Rules remain integer-based. Hearts and Spades convert cards only in their environment and overlay code. `step()` still takes an integer and raises `IllegalMoveError` for an illegal or wrong-phase action.

## Semantic overlays and renderers

Recorded card overlays use card objects for hands and play-ordered tricks. Hearts exposes `legal_cards`. Spades exposes `legal_cards` during play and `legal_bids` during bidding. These semantic legality values and the agent masks come from the same rules functions.

Define one frontend `Card` type and keep it through Pixi scene state, drawing, animation, legality, and hit testing. `readCardOverlay` validates semantic overlays without re-encoding them. Replace integer card constants with object constants or predicates, and use `cardKey(card)` for stable keys.

Convert only at the browser send boundary. A card tap calls `cardToAction(card)`, a bid chip calls `bidToAction(n)`, and Flappy Bird sends `1`. Recorded actions, the WebSocket relay, the decision log, and `formatAction` remain integer-based.

## Templates, examples, and built-ins

The per-game helper modules `environments/hearts/template/sandbox/cards.py` and `environments/spades/template/sandbox/cards.py` move to the object-shaped observation and import the shared codec (`suit_of`, `rank_of`, `card_to_obj`, `card_from_obj`, `SUIT_NAMES`) from `sandbox.card_utils`. Each carries its own game-specific surface: Hearts `legal_cards(obs)`, `play(card)`, `card_points(card)`, `card_name(card)`, and trick helpers; Spades `legal_cards(obs)`, `legal_bids(obs)`, `play(card)`, and `bid(n)`. A helper reads the inner `obs["observation"]` fields and the top-level `obs["action_mask"]` and returns a plain integer action. Flappy's `features.py` reads the player-and-pipes object and exposes `FLAP` and `IDLE`. The game-neutral `card_utils.py` and `card_spaces.py` hold no game-specific helper code, so the pure rules engines import only the codec.

Rewrite all starter agents and worked examples for the new observations: Hearts `duck`, `closer`, `assassin`, and `moonshot`; Spades `counter`, `daredevil`, and `signaler`; and Flappy Bird `hello`. Preserve the signaler's message-dependent play, the daredevil's covered nil, and the Spades built-in `suggested_bid` cross-check. Use `partner_seat` instead of repeating partner arithmetic.

Update template play loops to import module-level `default_action` from `sandbox.env` and call `default_action(env, slot)` for unwatched seats. Remove `AUTO_ACTION` and `NOOP_ACTION` from environments and generated exports only after all direct callers, demos, tests, examples, and built-ins have moved. There is no template `entry` object.

Because template version 1 was never public, this stage keeps version 1 rather than publishing a version 2: it updates the frozen v1 built-in agents in place. The Hearts built-in reads only the top-level `action_mask` and needs no change; the Spades built-in decodes the object hand back to engine card ids before its vendored `suggested_bid` count; the Flappy built-in reads the player-and-pipes object. Regenerate every template artifact and run the version consistency check, which stays at version 1. No compatibility adapter is required. Do not add observation schemas or metadata fields; the live Gymnasium spaces remain the contract.

## Fixtures and contract-dependent tests

Update Hearts and Spades fixture agents for the nested object-shaped observations and helper-built actions. Add a deterministic Flappy fixture generator. Regenerate all three recorded fixtures with semantic overlays and integer recorded actions.

Update Python environment tests, frontend scene and playback tests, template tests, example tests, and generated-file tests in the same change. Move the Hearts integration timeout assertion from sentinel `-1` to the real recorded default action here. Other integration sources should already consume the examples and built-ins migrated above; adjust a source only when it directly names a removed field or sentinel.

Coverage must include:

- Pinned PettingZoo `api_test` (through the #1211 guard) and `observation_space.contains()` through complete episodes and dead steps for all three environments.
- JSON-safe normalization of Sequence tuples before observation round-trip checks.
- Card codec and action conversion across all 52 cards, including the queen of spades example.
- Spades phase masks, never-nil timeout bid, partnership fields, score projection, and previous trick.
- Flappy observation and overlay agreement, nearest-first pipes, and public space mappings.
- Object-based Pixi drawing, animation, legality, and hit testing.
- Integer conversion only at environment and browser action boundaries.
- Complete template, example, built-in, generation, Python, and TypeScript unit checks.

## Done when

The repository has one semantic contract across all production code and participant artifacts. Renderers never rebuild integer card models, masks and semantic legality agree with the rules, all sentinels and consumers move together, the version-1 touchpoints stay internally consistent, generated files are current, and the non-Docker Python and TypeScript checks are green.
