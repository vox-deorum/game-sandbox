# Stage 11.1: Foundation and Compatibility Proof

Status: complete.

Part of [Stage 11](../stage-11-semantic-contract.md). This non-breaking step adds shared card modules and changes timeout defaults to return the action actually played. Production environment observations do not change until step 2, where the shared conformance suite validates the resulting observation design.

## Shared card modules

Create standard-library-only `environments/local_play/card_utils.py` for `SUIT_NAMES`, card constants, `suit_of`, `rank_of`, `card_to_obj`, and `card_from_obj`. Card ids remain suit-major, with engine rank indices from 0 through 12. Semantic objects use face values from 2 through 14. The queen of spades is card id 36, `rank_of(36)` is 10, and its semantic form is `{"suit": 2, "rank": 12}`. The two rank conventions must never be interchanged: `rules.py` compares on the engine index (queen = 10), while `card_to_obj`/`card_from_obj` are the face-value codec (queen = 12) applied only at the `env.py` and `overlay.py` boundary. Reaching for `card_to_obj(c)["rank"]` where the engine expects `rank_of(c)` shifts every rank by two and silently corrupts the pure, heavily-tested engine.

Hearts and Spades import their shared suit, rank, and card constants from this module through the existing `local_play` and generated `sandbox` import fallback. They remain standard-library-only and keep the same integer rules API.

Create `environments/local_play/card_spaces.py` for Gymnasium declarations. It exports `CARD`, a `spaces.Dict` containing `suit: spaces.Discrete(4)` and `rank: spaces.Discrete(13, start=2)`; `HAND`, a `spaces.Sequence(CARD)`; and `TRICK`, a play-ordered `spaces.Sequence` of `{"seat": ..., "card": ...}` records. Neither rules engine imports this module.

Add `card_utils.py` and `card_spaces.py` to `TEMPLATE_BASE_MODULES`. During composition, `compose.py` copies those canonical modules into the build output before overlaying each environment's colocated template layer. The distinct `card_utils` and `card_spaces` names keep the shared modules and each template's game-specific `sandbox/cards.py` as separate files through that merge. Version 1 agents do not import them, so publishing them is additive before the breaking rollout.

## PettingZoo compatibility and the api_test #1211 workaround

The production card environments publish a top-level `spaces.Dict` whose inner `observation` Dict holds the semantic `Discrete`, `Sequence`, and `Box` fields beside a top-level `action_mask`. This is the established masked-observation wrapper, and `action_mask` stays where masked sampling expects it.

Pinned PettingZoo 1.26.1 carries a known, open api_test bug ([PettingZoo#1211](https://github.com/Farama-Foundation/PettingZoo/issues/1211)): for a composite inner `observation`, `api_test` evaluates `observation_space(agent)["observation"].dtype` and raises `AttributeError: 'dict' object has no attribute 'dtype'`, alongside the `"Observation is not a NumPy array"` and `"should be box or discrete"` UserWarnings. CI absorbs a matching failure, and the observation keeps its designed shape.

Encode the tolerance in the shared production conformance test, not an environment: wrap `pettingzoo.test.api_test` in a guard that filters the two related warnings, tolerates an `AttributeError` whose message contains `dtype`, and re-raises other `AttributeError`s. Focused shared-module tests validate representative empty and populated sequences with `contains()`, while production environment tests cover complete episodes and the terminal dead-step cycle.

## Real timeout actions

Change `EnvironmentEntry.default_action` from `Callable[[str], Any]` to `Callable[[Any, str], Any]`. The hook receives the live environment and slot id and returns a real action in that environment's action space. Update the three timeout paths in `session.py` and the call in `scripts/play.py` to use `default_action(env, slot_id)`.

Adapt all three registry providers. Hearts returns its lowest legal card, Spades returns its existing never-nil suggested bid or lowest legal card, and Flappy Bird returns integer `0`. Gameplay does not change, but a timeout recording now contains the action that was applied instead of a sentinel.

Keep `AUTO_ACTION` and `NOOP_ACTION` as compatibility aliases for direct environment, demo, template, and test callers. The harness stops supplying them in this step. Step 2 removes the aliases only after every remaining consumer has moved.

The harness boundary continues checking `action_space(slot).contains(action)` and a top-level mask when one is present. Do not add JSON Schema, `legal_actions`, metadata fields, or action wrapping.

## Tests

- Round-trip all 52 cards through the shared codec and pin the queen of spades example.
- Confirm Hearts and Spades retain their existing suit and rank behavior after importing the shared module.
- Run pinned PettingZoo `api_test` against the production environments through the shared #1211 guard, and verify the shared spaces accept representative semantic values.
- Update harness fakes and tests for the two-argument default hook.
- Prove that a timeout provider receives the live environment and slot id and that its returned integer is recorded.
- Run generation freshness after syncing both new modules.
- Keep the existing environment, template, and renderer behavior unchanged.

## Done when

The production observation design is validated against pinned PettingZoo, with the known api_test #1211 error tolerated behind a documented shared guard. Shared card rules remain dependency-free, template copies are current, timeout recordings contain real actions, compatibility sentinels still support existing direct callers, and the Python and generation checks are green.
