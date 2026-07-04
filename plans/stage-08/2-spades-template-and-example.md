# Stage 8.2: Spades Template Layer and Example

Status: completed.

Part of [Stage 8](../stage-08-communication.md). This is build-order step 2. It packages the Spades environment from step 1 so a participant can write a Spades agent, and it ships the first worked example plus the built-in Naive opponent. It is Docker-free: template generation and example loading run locally through the harness. The hands-on surface at the end of this step is the student loop: `python play.py` from the template watches a hand, and `--human` seats the student to bid and play interactively against built-ins.

## Why this is its own seam

The environment (step 1) is the game; this step is the participant-facing surface over it, split out for the same reason Stage 7 split the Hearts template: the rules engine stays free of packaging concerns, and the later steps get real agents to run. The browser renderer step (step 3) needs the built-in Naive agent so an all-Naive watch session can start, and the chat steps (4 through 6) need a submittable roster to demonstrate messaging against. Spades is the third environment through the two-layer template machinery, so this step should be almost entirely mechanical; any friction it hits is a machinery bug worth finding.

This step ships the template chat-less. The `agent.py` stub documents bidding and play; the chat stub, the messaging documentation, and the chatting examples land with the hook itself in step 4, so the template never documents a method the harness does not yet call.

## What to build

Spades lands as a third environment template on the existing two-layer machinery, described in the [examples and template contributor guide](../../docs/contributors/examples-and-template.md).

- A `templates/spades/` layer over the shared `templates/base/`: an `agent.py` stub and `README.md` explaining the `Discrete(66)` encoding (cards 0–51, bids as `52 + k`), the two-phase mask, and the partnership (your partner is the seat across), a whole-file `sandbox/play.py` override for the bid-then-play four-seat local loop (watch, `--human`, and `--headless`), and the generated `sandbox/env/`. It mirrors the structure of `templates/hearts/`.
- Registration in `TEMPLATE_ENVS` in `scripts/_paths.py` with its `_TemplateEnvInit` spec in `scripts/generate.py`, so generation syncs the Spades env modules into `sandbox/env/`.
- A helper module `templates/spades/sandbox/cards.py` (following `templates/hearts/sandbox/cards.py`): `is_bidding`, `legal_bids`, `legal_cards`, `partner_of`, and bid and trick readers, so student code never hand-decodes the combined action space. A pin test asserts the helper against the synced `sandbox.env.spades.rules`, and the subprocess check proves importing the helper never pulls in pygame, both following `templates/hearts/tests/test_cards.py`.
- A student docs page `docs/students/environments/spades.md` plus its row in `docs/students/environments/index.md`, covering the rules, the action encoding, the observation, and the scoring. `scripts/compose.py` copies the page into the template and fails loudly if it is missing. The page's "Messaging" section is deferred to step 4 with the rest of the chat surface.
- One worked example, `examples/spades/counter/`: an honest bidder that counts likely tricks (high spades and side-suit aces), bids that number, and plays to make it. It is deliberately chat-less: it is the baseline the chatting examples of step 4 are measured against, and it proves a Spades agent needs nothing beyond the Stage 2 interface.
- The built-in Naive Spades agent at `backend/images/session-base/deps-v1/builtin/spades/` (`agent.py`, `manifest.json`), mirroring the Hearts built-in: additive content in the existing dependency set, so no template-version bump, following the Hearts precedent.

Spades shares the single global dependency set, so this introduces no new `template-v<N>` axis.

## Tests

Docker-free:

- The template generation sync check passes for Spades: regenerating `templates/spades/sandbox/env/` from the environment produces no diff.
- The `examples/spades/counter` example loads through the harness loader and plays a complete local hand against built-in opponents, and its own behavioural test pins the honest-bid heuristic on a fixed deal.
- `play.py` runs headlessly against the Spades template (`--headless`) and reports final team scores, exercising the bid-then-play loop and the step 1 renderer without opening a window.
- The `cards.py` pin test agrees with the synced rules module, and the subprocess check proves the helper imports without pygame.
- `scripts/ci.py examples`, `python`, `generated-code-fresh`, and `docs` pass locally.

## Done when

A `templates/spades/` layer exists over `templates/base/`, is registered in `TEMPLATE_ENVS`, and regenerates cleanly. The counter example loads and plays a complete local hand through the harness, and the built-in Naive Spades agent is in place for the session image. A student can run `python play.py` to watch a hand in a window, or take a seat with `--human` and click a bid chip and then legal cards against the built-in agents, all locally with no backend. The student docs page exists and composes into the template. The template and example follow the same shape as the Hearts ones, share the single global dependency set, and add no new template-version axis.
