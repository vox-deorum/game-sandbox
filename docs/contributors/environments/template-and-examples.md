# Environment Template and Examples

Each environment owns the student-facing files that differ from the shared starter kit. Keep them beside the environment package so an environment can be understood and changed in one place.

Read [Template product and releases](templates.md) for composition, dependency versions, and publication.

## Hand-authored layers

Put the starting `agent.py`, `README.md`, student helper modules, and pin tests in `environments/<env>/template/`. This directory has no `__init__.py`.

Put each worked example overlay in `environments/<env>/examples/<name>/`. An example contains only the files that differ from its composed template, such as an agent, README, tests, and optional `requirements.extra.txt`.

Every environment package must also declare `PUBLISHED_EXAMPLES`, a tuple of example names that may be published. Use an empty tuple when the environment has no examples to publish. Each name must identify an immediate child directory under that environment's `examples/` directory. This tuple is a publication allowlist, not an inventory: every checked-in example remains available to composition and the examples CI job.

The top-level `templates/` directory now contains only `templates/base/`. Generated `sandbox/env/`, `sandbox/harness/`, and shared helper files exist only in a composed tree under `build/`.

## Helpers and pin tests

Give students a small helper module when they need game-specific code to interpret observations or produce integer actions. Hearts and Spades provide `sandbox/cards.py`; Flappy Bird provides `sandbox/features.py`.

Keep helpers plain Python and import them at the top of `agent.py`. Do not put hand-authored files under `sandbox/env/`, which compose owns in its build output.

Add a pin test under `template/tests/` when the helper repeats facts defined by the environment. Composed examples inherit these tests, so the `examples` CI job catches inconsistencies.

Hearts and Spades may re-export game-independent names from `sandbox.semantic_cards`, but legality, scoring, bidding, partnership, and observation access remain environment-specific.

## Composed kit

`uv run python scripts/compose.py <env>` writes a complete student repository to `build/templates/<env>/`. Passing an example name writes the example tree under `build/examples/<env>/<name>/`.

Read [Template product and releases](templates.md#composition) for the composition order, generated packages, dependency merge rule, and student-documentation rewrites.

## Student documentation

Write the canonical student guide at `environments/<env>/environment.md`. It should explain the game, starting agent, scoring, helper module, raw contract, time limits, and a first improvement. The documentation catalog discovers the guide and exposes it as the virtual page `students/environments/<slug>.md`; do not create a manual catalog entry, generated mirror, or committed mirror.

The starting `agent.py` body must match the canonical guide's starter-agent listing. Its `README.md`, `agent.py`, and helper modules point students to the composed local `environment.md` instead of duplicating the game reference.

Compose copies the canonical guide into each kit as `environment.md` and the shared LLM guide as `llm.md`, then rewrites their relative documentation links to the published docs URL. MkDocs exposes the canonical guide as a virtual student page; links inside the canonical guide stay relative in the source page, while links to repository files use stable GitHub URLs.

Every environment must have at least one example. Examples should use the helper module so they demonstrate the style students should adopt, but student pages must not link their source as a solution.

Only names in `PUBLISHED_EXAMPLES` become student-repository `examples/<env>/<name>` branches. Keep an example in source when it is useful for CI, development, or tests but should not be published.
