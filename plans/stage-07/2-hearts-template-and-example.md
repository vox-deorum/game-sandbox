# Stage 7.2: Hearts Template Layer and Example

Status: complete. The `templates/hearts/` layer ships over `templates/base/`: an `agent.py` stub and `README.md` for the card-int/action-mask interface, a thin `sandbox/play.py` adapter for the Hearts-specific window and human-seat flow, and the generated `sandbox/env/`. Its single `TemplateEnvironmentSpec` in the static `TEMPLATE_ENVIRONMENTS` catalog owns both module synchronization and generated init facts. The adapter delegates manifest loading and the standard headless four-seat episode loop to the dependency-free base `sandbox.multiseat_play`. `sandbox.cards` imports game-independent semantic-card operations from `sandbox.semantic_cards`, re-exports its established public names, and keeps Hearts legality, scoring, and observation helpers local. The synced renderer subclasses a shared card-table renderer that ships in the base layer (`templates/base/sandbox/render_cards.py` over `render_base.py`, synced from `local_play/`); it resolves that shared module under either the `local_play.*` (env package) or `sandbox.*` (student template) name so the one file works in both layouts, and the shared base reaches its sibling HiDPI shim by a plain relative import that resolves the same way. The `examples/hearts/duck/` worked example (a points-ducking heuristic plus a `wcwidth` extra) loads through the local loader, plays a full game against the built-in opponents, drives the renderer headlessly, and beats the lowest-legal baseline across seeds. Three further example strategies sit alongside it (`examples/hearts/{moonshot,assassin,closer}/`), each a single-idea agent with its own deterministic behavioural test, so Hearts ships a roster of distinct agents; that roster is what the Stage 7.8 browser e2e submits into its scheduled multi-seat matchup. The shared single dependency set is unchanged (no new `template-v<N>` axis). `scripts/ci.py examples`, `python`, and `generated-code-fresh` pass locally with no Docker.

Part of [Stage 7](../stage-07-multi-agent.md). This is build-order step 2. It packages the Hearts environment from step 1 so a participant can write a Hearts agent, and it ships at least one worked example. It is Docker-free: template generation and example loading run locally through the harness.

## Why this is its own seam

The environment (step 1) is the game; this step is the participant-facing surface over it. Splitting it out keeps the rules engine free of packaging concerns and gives the later watch and play flows (step 6) a real submittable example to schedule and run. Hearts is the second environment to exercise the two-layer template machinery, which proves the machinery generalizes beyond Flappy Bird without a rewrite.

## What to build

Hearts lands as a second environment template on the existing two-layer machinery, described in the [examples and template contributor guide](../../docs/contributors/examples-and-template.md).

- A `templates/hearts/` layer over the shared `templates/base/`: its `agent.py` stub, a Hearts-specific `README.md`, and the generated `sandbox/env/`. It mirrors the structure of `templates/flappy_bird/`.
- One `TemplateEnvironmentSpec` in the static `TEMPLATE_ENVIRONMENTS` catalog in `scripts/_paths.py`, so `scripts/generate.py` syncs the Hearts modules and renders the generated `sandbox.env` exports from the same facts.
- At least one `examples/hearts/<name>` example over the template, mirroring `examples/flappy_bird/hello/`: an overriding `agent.py`, an optional `requirements.extra.txt`, and tests.

Hearts shares the single global dependency set, so this introduces no new `template-v<N>` axis. The agent interface is unchanged from Flappy Bird; only the observation and action shapes differ, which the stub and README explain.

The template's local `play.py` opens the Hearts game in a render window through the step 1 Python renderer (`make_env(render_mode="human")`). Because Hearts is turn-based, the template also exposes an interactive mode where the student takes a seat and clicks legal cards against the built-in agents, wiring the renderer's click hit-test (step 1) into the local adapter. Manifest loading and the normal headless episode loop come from `sandbox.multiseat_play`; Hearts-specific rendering, interaction, scoring presentation, and pacing stay in the adapter. This lets a student feel the game and test their agent locally, with no backend, before submitting.

## Tests

Docker-free:

- The template generation sync check passes for Hearts: regenerating `templates/hearts/sandbox/env/` from the environment produces no diff, the same check the build already runs for Flappy Bird.
- The `examples/hearts/<name>` example loads through the harness loader and plays a full local Hearts game to completion against built-in opponents, with no Docker.
- `play.py` runs headlessly against the Hearts template (`--headless`) and reports a final score, exercising the local loop and the step 1 renderer without opening a window.
- The example's own tests pass.

## Done when

A `templates/hearts/` layer exists over `templates/base/`, has one entry in `TEMPLATE_ENVIRONMENTS`, and regenerates cleanly. At least one `examples/hearts/<name>` example loads and plays a complete local Hearts game through the harness. A student can run `python play.py` to watch the game in a window or play a seat interactively against the built-in agents. The template and example follow the same shape as the Flappy Bird ones, share the single global dependency set, and add no new template-version axis.
