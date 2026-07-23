# Stage 11: Semantic Contract

Status: complete. One deviation carried through every step: since template version 1 was never published, the stage reshapes version 1 in place rather than publishing a version 2 (see the [semantic rollout](stage-11/2-semantic-rollout.md) note). Read "version 2" below as the reshaped version 1.

## Goal

Agents read observations as meaningful game objects and choose actions through helpers. A Hearts agent sees cards such as `{"suit": 2, "rank": 12}` and returns `play(card)`. It does not decode a 52-bit hand or calculate an action index. Each environment still exposes real Gymnasium spaces through a conformant PettingZoo AEC interface.

The platform convention is an object-shaped observation and a simple `Discrete` action space. Environments with state-dependent legality also publish a top-level binary `action_mask`. Helpers turn semantic choices such as playing a card or placing a bid into the integer accepted by the action space. Flappy Bird needs no mask because idle and flap are always legal while its agent is active.

## Scope

Card observations use shared Gymnasium spaces. A card is `{"suit": <0..3>, "rank": <2..14>}`. Suit is `Discrete(4)`, with names supplied by helpers, and rank is `Discrete(13, start=2)`, so face cards and aces compare by their familiar values. A hand is a `Sequence(CARD)`. A trick is a play-ordered `Sequence` of `{"seat": <0..3>, "card": {...}}` records. Nullable values use an extra `Discrete` category, such as `4` for no led suit and `14` for a Spades seat that has not bid.

The card games use the `{"observation": {...}, "action_mask": ...}` wrapper: an object-shaped composite inner `observation` Dict beside the top-level `action_mask`, where PettingZoo's masked sampling expects the mask. Pinned PettingZoo 1.26.1 carries a known, open api_test bug ([PettingZoo#1211](https://github.com/Farama-Foundation/PettingZoo/issues/1211)): for a composite inner `observation`, `api_test` reads `observation_space(agent)["observation"].dtype` and raises `AttributeError: 'dict' object has no attribute 'dtype'`, with two related UserWarnings. CI tolerates that one error until upstream fixes it, and `observation_space.contains()` validates the complete composite observation throughout. The first build step establishes the shape without changing a production environment.

Hearts gains semantic hands and tricks without changing its rules. Spades gains the same card representation, plus `partner_seat`, a running `team_scores` projection, and a play-ordered `last_trick`. Flappy Bird replaces its twelve-float vector with the player and pipe objects already used by its renderer.

Actions remain integers accepted by a flat `Discrete` space: Hearts uses `Discrete(52)`, Spades uses `Discrete(66)`, and Flappy Bird uses `Discrete(2)`. Hearts and Spades keep their binary masks as the source of current legality. `env.step()` still accepts an integer and rejects an illegal one. Helpers such as `play(card)`, `bid(n)`, `legal_cards(obs)`, and `legal_bids(obs)` keep indices and mask decoding out of student agents. Flappy Bird uses the named `FLAP` and `IDLE` constants because its two actions are already simple. A flat `Discrete` action keeps `action_mask` effective: Gymnasium's masked sampling covers `Discrete` spaces, and a composite `Dict`/`OneOf` action would sample outside the legal set.

Shared card code is split by responsibility. A standard-library-only `environments/local_play/card_utils.py` owns the integer codec, suit and rank accessors, and display names. The pure Hearts and Spades rules engines import from it without gaining NumPy or Gymnasium dependencies. `environments/local_play/card_spaces.py` imports that codec and declares `CARD`, `HAND`, and `TRICK`. Both modules sync into every template beside each template's own game-specific `sandbox/cards.py` helper module, which imports the shared codec.

Timeout defaults become real actions. `EnvironmentEntry.default_action` receives `(env, slot_id)` and returns the legal integer that will be applied. Recordings therefore contain the action that was played instead of an environment-specific sentinel.

The observation change breaks agents written for the prerelease template version 1. Since version 1 never shipped publicly, this stage reshapes version 1 in place — updating templates, examples, built-in agents, fixtures, student documentation, and tests — rather than publishing a version 2 or adding a compatibility adapter.

Rules engines remain integer-based internally. Environments convert their state to semantic objects for observations and overlays. Browser renderers use those objects directly for drawing, animation, legality, and hit testing. A selected card becomes an integer only when a human action is passed to `env.step()` or sent through the browser session channel.

Out of scope are new environments, changes to the AEC loop, changes to integer action encoding, chat, the LLM gateway, and replay compatibility for recordings made before this stage.

## Spec references

[environment.md](../docs/specs/environment.md) defines the PettingZoo interface and live spaces. [interaction.md](../docs/specs/interaction.md) defines action legality and browser input. [submission.md](../docs/specs/submission.md) defines the agent `act` contract and template version. [recording.md](../docs/specs/recording.md) defines the recorded overlay. [leaderboard.md](../docs/specs/leaderboard.md) defines timeout and forfeit policy.

## Depends on

Stage 2 provides the harness and metadata types. Stages 7 and 8 provide Hearts and Spades. Stage 4 provides browser renderers. Stages 5 and 6 provide template versioning, submission validation, and season dependency pins. Stage 10 provides the student documentation revised here. Stage 11 is independent of Stage 9.

## Build order

Stage 11 has three implementation steps. The first is a non-breaking proof and foundation. The second is the one breaking change, so it moves environments and every consumer together rather than leaving temporary mixed contracts in the repository.

1. **[Foundation and compatibility proof](stage-11/1-foundation-and-compatibility.md).** Add the dependency-free card codec and shared Gymnasium spaces, establish the nested composite observation against pinned PettingZoo (tolerating the known api_test #1211 error in CI), and change the timeout hook while retaining sentinel aliases for direct callers.
2. **[Semantic rollout](stage-11/2-semantic-rollout.md).** Convert all three environments, overlays, browser renderers, fixtures, templates, examples, built-in agents, and integration-test consumers in one atomic contract change. Remove sentinels only after every caller moves.
3. **[Testing, CI, and docs](stage-11/3-testing-ci-and-docs.md).** Run the complete integration and browser journeys, revise student and contributor documentation, update the specs, and reconcile earlier stage plans.

## Done when

Agents for all three environments read object-shaped observations and return simple integer actions through helpers. Hearts and Spades publish masks that agree with their rules, and Flappy Bird exposes both always-legal actions without a mask. Every observation satisfies its declared space through a complete episode, and PettingZoo's pinned `api_test` passes for all three environments except for the known #1211 `dtype` access on the composite observation, which CI tolerates behind a documented guard.

All three games are watchable, playable, and replayable in the browser, including through loopback local play. A composed template (the reshaped version 1) completes a game, timeout recordings contain the real action used, generated files are current, and the complete Python, TypeScript, integration, browser, and documentation checks pass. The specs, student guides, contributor guides, and earlier stage plans describe the new contract consistently.
