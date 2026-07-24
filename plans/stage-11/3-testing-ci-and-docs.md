# Stage 11.3: Testing, CI, and Documentation

Status: complete. The full-stack verification passed, and the student docs, contributor guides, specs, and earlier Stage 7/8 plans were revised to the semantic contract. Because template version 1 was never published, "version 2" throughout Stage 11 refers to the reshaped version 1 (see the [semantic rollout](2-semantic-rollout.md) deviation note); the version touchpoints stay consistent at v1.

Part of [Stage 11](../stage-11-semantic-contract.md). This final step verifies the atomic rollout through the live stack and updates the public explanation of the contract. Contract-dependent source changes belong in step 2; this step runs the complete system and fixes only integration or journey assumptions revealed by that verification.

## Full-stack verification (Passed)

Run the Docker-gated backend integration suite. `hearts-multi-slot.test.ts` should already expect the real timeout action from step 2. `spades-chat.test.ts` exercises the migrated examples and built-ins rather than carrying a separate observation decoder. Flappy session input remains `{kind: "input", slot: "player_0", action: 1}`.

Run the Playwright Hearts, Spades, and session journeys against the reshaped template image (kept at version 1). Verify live watch, human play, replay, card and bid input, legal-choice greying, timeouts, standings, Flappy taps, and chat. Renderers should receive only semantic game objects; session actions should remain integers.

Run the complete verification matrix:

- `uv run python scripts/ci.py python`, including the guarded PettingZoo `api_test` for all three environments.
- `uv run python scripts/ci.py generated-code-fresh` for committed schema and registry artifacts, plus composed-example tests for build-time template helpers and the template version check.
- `npm run check` and `npm run test`.
- The Docker-gated backend integration suite.
- `uv run python scripts/ci.py frontend-e2e`.
- `uv run python scripts/ci.py docs`.

Complete a manual pass with a live Flappy session, a full Hearts hand including a deliberate timeout, a Spades hand through bidding and nil with chat open, replay for all three games, and a composed template agent (the reshaped version 1).

## Student documentation

Rewrite `environments/hearts/environment.md`, `environments/spades/environment.md`, and `environments/flappy_bird/environment.md` around the semantic observations. MkDocs and the in-app documentation API expose those canonical files at their stable virtual paths under `students/environments/`. Card examples show the object-shaped `observation` fields beside the top-level `action_mask`. Flappy examples show player and pipes without a mask.

Update `docs/students/agent-interface.md` to explain object-shaped observations and simple `Discrete` actions. Hearts and Spades students normally use `legal_cards`, `legal_bids`, `play`, and `bid`. Flappy students use `FLAP` and `IDLE`. Spot-check `getting-started.md` and `submitting.md` for the removed encodings and sentinel names.

## Specifications and contributor guides

Update [environment.md](../../docs/specs/environment.md), [interaction.md](../../docs/specs/interaction.md), and [submission.md](../../docs/specs/submission.md) without changing the PettingZoo interface. Describe object-shaped observations carried inside the `{observation, action_mask}` wrapper and simple `Discrete` actions. Require `action_mask` when legality changes with state — Hearts and Spades carry one; Flappy Bird has none. Note the tolerated PettingZoo #1211 api_test bug where the spec or contributor guide explains conformance. Spot-check [recording.md](../../docs/specs/recording.md) for old overlay descriptions.

Update `docs/contributors/environments/package.md` with the same convention. Renderers should consume semantic overlay objects directly, and action encoding belongs only at the environment and session-input boundaries. Composite action spaces are not the convention because Gymnasium masking cannot express every legal subset. Update `docs/contributors/environments/templates.md` and `docs/contributors/environments/rendering.md` where they describe the old representation.

Revise the Stage 7 and Stage 8 plans wherever they present old observations or sentinel defaults as current behavior. Plans are living descriptions, so replace superseded instructions directly and retain earlier rationale only when it still explains the current design. Reconcile Stage 11 status and links after implementation.

## Done when

Every automated lane and the manual pass succeed on the reshaped template (kept at version 1). All three environments pass pinned PettingZoo `api_test` through the documented #1211 guard. Live play, watch, and replay use semantic renderer state and integer session actions. Student docs, contributor guides, specs, and earlier plans describe the same current contract.
