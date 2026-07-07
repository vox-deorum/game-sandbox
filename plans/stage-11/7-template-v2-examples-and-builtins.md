# Stage 11.7: Template v2, Examples, and Builtins

Status: not started.

Part of [Stage 11](../stage-11-semantic-contract.md). This is build-order step 7, the convention made official on the participant path. Every agent-facing artifact moves to the object-shaped observation and the helper-driven action (the template helper modules, the starter agents, the worked examples, the built-in Naive agents), and the template dependency set bumps from version 1 to version 2 so submission validation, the session images, and the season pin all agree about which contract an agent targets. The hands-on surface is the participant path: a composed template plays a hand end to end on the new observation shape.

## Why this is its own seam

The observation shape change is breaking for any agent that read the old `MultiBinary`/`Box` fields, so it earns the version bump. That bump is one number wearing several hats (the template release tag, the pinned dependency set, the session image tag, and the `template_version` a manifest targets), so everything it stamps must flip together: helpers, templates, examples, builtins, manifests, and the versioned image directory. Landing it after the environments, generation, and renderers means version 2 is born onto a platform whose observations are already object-shaped, and no artifact ever ships half-converted.

## What to build

### Helper modules and templates — the read/write split

`templates/hearts/sandbox/cards.py` and `templates/spades/sandbox/cards.py` are rewritten over the object-shaped observation and the `sandbox.spaces` codec, embodying the convention's ergonomic half:

- **Read side (object-shaped state):** the hand and tricks are already card objects, so helpers stop decoding card ids. `legal_cards(obs)` decodes `obs["action_mask"]` into a list of `{suit, rank}` objects; `legal_bids(obs)` does the same for the bid half; plus `card_points(card)`, trick inspection, and `card_name(card)`/`SUIT_NAMES` display helpers over card objects.
- **Write side (index hidden):** `play(card) -> card_from_obj(card)` returns the integer card id; `bid(n) -> 52 + n` hides the offset; every builder returns a plain `int` the `Discrete` action space and the mask accept. No student writes a bit or an index.

`templates/flappy_bird/sandbox/features.py` becomes pixel-space helpers over the object-shaped observation (`next_pipe`, `gap_center`, and the `FLAP = 1` / `IDLE = 0` constants) instead of a twelve-float decoder.

The starter `agent.py` in each template rewrites to read object-shaped state and `return play(card)` / `return bid(n)` / `return FLAP`, and the template play loops replace their deleted-sentinel usage with `entry.default_action(env, slot)` for unwatched seats. Template tests, including the interface-parity test against the real harness, update alongside.

### Examples and built-in agents

Every worked example converts its **observation reads** (actions were already integers, now produced through the helpers): `examples/hearts/{duck,closer,assassin,moonshot}`, `examples/spades/{counter,daredevil,signaler}`, and `examples/flappy_bird/hello`, with their tests. The signaler and daredevil keep their stage 8 behaviors (the message-dependent play and the covered nil) expressed over the new observation fields; `partner_seat` replaces the local partner arithmetic.

Run `uv run python scripts/bump_template_version.py --version 2`, which mechanically edits the template manifests, the e2e submission fixtures, `backend/src/deps-version.ts`, and snapshots `backend/images/session-base/deps-v2/`. Then rewrite the snapshotted `deps-v2/builtin/{hearts,spades,flappy_bird}/agent.py` over the object-shaped observation; the Spades builtin keeps a vendored `suggested_bid` over card objects, and the existing cross-check test in `environments/tests/test_spades.py` keeps pinning it against the rules engine. A comment in `deps-version.ts` records that `deps-v1` is incompatible with checkouts past this stage, because its image builds harness and environments from the current tree; the clean break accepts that a season pinned to version 1 cannot run new sessions, and no adapter is built.

Finish with the regeneration pass and the version consistency check (`npm run generate`, then `bump_template_version.py --check`) so the manifests, image directory, and registry entry all agree on version 2.

## Tests

- The rewritten helper modules are covered where the old ones were: `legal_cards`/`legal_bids` agree with the `action_mask` on fixtures, action builders emit the correct integer indices, and every helper returns plain types.
- Each template's starter agent completes a hand through the composed sandbox, and the interface-parity test passes against the real harness.
- Every example's own test suite passes on the new observation, including the signaler's message-dependent play and the daredevil's covered nil.
- The Spades builtin's vendored `suggested_bid` still matches the rules engine on fixture hands.
- Submission validation accepts a manifest targeting version 2 and rejects version 1 with the existing mismatch error, pinned in the backend validator tests.
- `bump_template_version.py --check` and the generation freshness check both pass.

## Done when

A student-shaped user can compose a template, run its tests, play a hand locally, read object-shaped state, and return actions through helpers — never hand-decoding the mask or computing an index. All examples and builtins play on the new observation, the platform's version pins agree on 2 everywhere they appear, and the Python and TypeScript suites are green.
