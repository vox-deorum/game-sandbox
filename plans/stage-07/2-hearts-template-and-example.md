# Stage 7.2: Hearts Template Layer and Example

Status: complete. The hand-authored `environments/hearts/template/` layer ships over `templates/base/`: an `agent.py` stub, `README.md`, and `sandbox/cards.py` for the card-int/action-mask interface. Composition writes the shared `sandbox/play.py` entry point's runtime dependencies, `sandbox/harness/`, `sandbox/env/`, and shared helpers only into build output. Directory discovery builds its `TemplateEnvironmentSpec` from `environments/hearts/`. `sandbox.cards` imports game-independent semantic-card operations from `sandbox.semantic_cards`, re-exports its established public names, and keeps Hearts legality, scoring, and observation helpers local. The `environments/hearts/examples/duck/` worked example and its colocated peers (`moonshot`, `assassin`, and `closer`) provide the roster used by the Stage 7.8 browser e2e. The shared single dependency set is unchanged. `scripts/ci.py examples` and `python` pass locally with no Docker; generated-code freshness no longer tracks composed template files.

Part of [Stage 7](../stage-07-multi-agent.md). This is build-order step 2. It packages the Hearts environment from step 1 so a participant can write a Hearts agent, and it ships at least one worked example. It is Docker-free: template generation and example loading run locally through the harness.

## Why this is its own seam

The environment (step 1) is the game; this step is the participant-facing surface over it. Splitting it out keeps the rules engine free of packaging concerns and gives the later watch and play flows (step 6) a real submittable example to schedule and run. Hearts is the second environment to exercise the two-layer template machinery, which proves the machinery generalizes beyond Flappy Bird without a rewrite.

## What to build

Hearts lands as a second environment template on the existing two-layer machinery, described in the [template contributor guide](../../docs/contributors/environments/templates.md).

- A colocated `environments/hearts/template/` layer over `templates/base/`: its `agent.py` stub, a Hearts-specific `README.md`, and `sandbox/cards.py`.
- A discovered `TemplateEnvironmentSpec` built from Hearts metadata and direct package modules, so `scripts/compose.py` writes the generated `sandbox.env` exports into build output from the same facts.
- At least one `environments/hearts/examples/<name>/` example over the template: an overriding `agent.py`, an optional `requirements.extra.txt`, and tests.

Hearts shares the single global dependency set, so this introduces no new `template-v<N>` axis. The agent interface is unchanged from Flappy Bird; only the observation and action shapes differ, which the stub and README explain.

The shared template `play.py` starts the loopback relay and browser page with the same live runner and Hearts renderer used in a session. A student can choose a seat and click legal cards against the built-in agents. The environment supplies the action mask and the browser renderer maps a selected card to the integer action sent through the live protocol. This lets a student feel the game and test their agent locally, with no backend, before submitting.

## Tests

Docker-free:

- The composed Hearts template contains freshly generated `sandbox/env/`, `sandbox/harness/`, and shared helpers.
- The `environments/hearts/examples/<name>/` example loads through the harness loader and plays a full local Hearts game to completion against built-in opponents, with no Docker.
- `sandbox.play` runs headlessly against the Hearts template (`--headless`) and reports a final score, exercising the shared live loop without opening a browser.
- The example's own tests pass.

## Done when

A `environments/hearts/template/` layer exists over `templates/base/`, and composition creates its runtime package pieces in build output. At least one `environments/hearts/examples/<name>/` example loads and plays a complete local Hearts game through the harness. A student can run `python -m sandbox play` to watch the game in a browser or `python -m sandbox human` to play a seat interactively against the built-in agents. The template and example follow the same shape as the Flappy Bird ones, share the single global dependency set, and add no new template-version axis.
