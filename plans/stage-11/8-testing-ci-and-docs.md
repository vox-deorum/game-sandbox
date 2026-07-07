# Stage 11.8: Testing, CI, and Docs

Status: not started.

Part of [Stage 11](../stage-11-semantic-contract.md). This is build-order step 8, the cross-cutting companion. Per-step tests live in each subplan; this step carries the whole-stage journeys (the Docker-gated integration lane and the browser e2e suite on the new observation), the documentation that describes the convention to students and contributors, and the specification and plan reconciliation the repo's governance requires. It closes the stage: after it, no document in the repo describes the old observation shape as current, and the convention — object-shaped observations, a simple `Discrete` action via helpers — is written down.

## Why this is its own seam

The integration and e2e lanes exercise the full stack (backend, container, browser) and can only go green once every piece has converted, so they reconcile here rather than piecemeal. The documentation work is a single coherent pass across student guides, specs, and contributor guides, and per the repo rules the spec and plan edits belong in the same change set as the behavior they describe. Crucially, because the environments stay PettingZoo-conformant, the specs' "PettingZoo is the only environment interface" framing is preserved, not narrowed.

## What to build

### Integration and e2e lanes

`backend/test/integration/session.test.ts` still sends `{kind: "input", slot: "player_0", action: 1}` for Flappy (the integer flap is unchanged). `backend/test/integration/hearts-multi-slot.test.ts` updates its inline Python agents to read the object-shaped observation and the `action_mask` and return an integer card id, and replaces the sentinel-equality timeout assertion: a timed-out seat's recorded action is now the real card index `default_action(env, slot)` produced (not `-1`), so anything that needs to know a seat timed out reads the timing fields instead. `backend/test/integration/spades-chat.test.ts` gets the same treatment for its scripted bids and plays. The Playwright journeys (`frontend/e2e/hearts.spec.ts`, `spades.spec.ts`, and the session flows) re-run against the converted stack; they click by geometry, so changes should be confined to any fixture manifests already bumped in step 7, but the suite is the proof.

### Student documentation

The in-app student guides rewrite where they taught the old encoding: `docs/students/environments/hearts.md`, `spades.md`, and `flappy-bird.md` replace their card-id tables and old observation walkthroughs with the object-shaped observation examples and field tables from the subplans, and `docs/students/agent-interface.md` restates the `act` contract: read the object-shaped observation, and return the environment's `Discrete` action — in practice through the `play(card)` / `bid(n)` / `FLAP` helpers, which build the index from a card object and the `action_mask`. `getting-started.md` and `submitting.md` are spot-checked. The strict docs build (`uv run python scripts/ci.py docs`) gates the rewrite.

### Specs and contributor guides

Per the repo governance, the specs revise in this same change set, **keeping the PettingZoo framing**: [environment.md](../../docs/specs/environment.md) states the observation is an object-shaped composite space (hand/trick of typed card objects) while the action stays a `Discrete` space with a binary `action_mask` — the PettingZoo AEC interface and `api_test` conformance are unchanged; [interaction.md](../../docs/specs/interaction.md) keeps legality as the `action_mask` carried in the observation; [submission.md](../../docs/specs/submission.md) updates the `act` row to "read object-shaped state, return a `Discrete` action via helpers"; [recording.md](../../docs/specs/recording.md) is spot-checked for old-observation references. Contributor guides follow and **codify the convention** for future environments: `docs/contributors/environments.md` adds "object-shaped observations, a simple `Discrete` action space with a binary `action_mask`, and helpers that hide the index — do not use composite/tagged action spaces, because Gymnasium masking cannot constrain them to a legal set"; `examples-and-template.md` and `rendering.md` update their old-observation passages.

### Plan reconciliation

The stage 7 and stage 8 plan files describe the old observation shape and the sentinel `default_action` as current. Following the plan README's rule that a stage file is revised when the implementation it describes changes, those passages are annotated to their stage 11 replacements without rewriting history: the stages remain a true record of what was built, with a pointer to what superseded it. The `Discrete(66)` action space and the mask-driven greying are **not** annotated — they are unchanged.

## Tests

This step's deliverable largely is tests; the checklist is the full matrix:

- `uv run python scripts/ci.py python` (Ruff, pyright, pytest, including `test_passes_pettingzoo_api_test` for all three environments) and the generation and version freshness checks.
- `npm run check` and `npm run test` (schema, backend, frontend unit suites).
- The Docker-gated backend integration lane, all three suites above included.
- `uv run python scripts/ci.py frontend-e2e` for the browser journeys.
- `uv run python scripts/ci.py docs` for the strict documentation build.
- The manual pass: a live Flappy session with taps, a full human Hearts hand (opening lead, follow-suit greying, a deliberate timeout, standings), a Spades hand through bidding (nil included) with the chat panel, and a composed-template hand, each on the object-shaped observation.

## Done when

Every automated lane is green on template version 2 with `api_test` still passing, the manual pass holds, and a reader of the student guides, the specs, or the contributor guides meets the convention — object-shaped observations, a simple `Discrete` action via helpers — and still reads that the environments are PettingZoo-conformant. Stage 7 and stage 8 files point at their superseded observation passages, and this stage's status lines record what shipped.
