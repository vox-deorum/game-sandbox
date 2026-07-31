# Environment Template and Examples

Each environment owns the student-facing files that differ from the shared `templates/base` layer. Keep them beside the package.

Read [Template product and releases](templates.md) for composition, dependency versions, and publication.

## Hand-authored layers

Put the starting `agent.py`, `README.md`, student helper modules, and pin tests in `environments/<env>/template/`. This directory has no `__init__.py`.

Put each worked example's layer in `environments/<env>/examples/<name>/`. An example contains only the files that differ from its composed template, such as an agent, README, tests, and optional `requirements.extra.txt`.

Every environment package must also declare `PUBLISHED_EXAMPLES`, a tuple of example names that may be published, or an empty tuple when the environment has none to publish. Each name must identify an immediate child of that environment's `examples/` directory. A name starts with a lowercase letter or digit, contains only lowercase letters, digits, dots, underscores, and hyphens, excludes `..`, and ends in neither a dot nor `.lock`. This tuple is a publication allowlist, not an inventory: every checked-in example remains available to composition and the examples CI job.

The top-level `templates/` directory holds nothing but `templates/base/`. Generated `sandbox/env/`, `sandbox/harness/`, and shared helper files exist only in a composed tree under `build/`.

Compose renders declared `EnvParameter` and `EnvParameterChoice` values into `sandbox.env` and derives `players` and `seat_plan` from the layout (all defined in [Environment package](package.md#registry-entry-and-metadata)).

## Helpers and pin tests

Give students a small helper module when they need game-specific code to interpret observations or produce integer actions. Hearts and Spades provide `sandbox/cards.py`, Flappy Bird `sandbox/features.py`.

Keep helpers plain Python and import them at the top of `agent.py`. Do not put hand-authored files under `sandbox/env/`, which compose owns in its build output.

Add a pin test under `template/tests/` when the helper repeats facts defined by the environment. Composed examples inherit these tests, so the `examples` CI job catches inconsistencies.

Hearts and Spades may re-export game-independent names from `sandbox.semantic_cards`, but legality, scoring, bidding, partnership, and observation access remain environment-specific.

## Composed template

[Composition](templates.md#composition) covers how `scripts/compose.py` assembles a complete student repository under `build/`: the composition order, generated packages, dependency merge rule, and student-documentation rewrites.

The generated environment factory uses the required `make_env(parameters)` signature. Local play and evaluation resolve the complete default map before constructing the environment, so a composed template exercises the same contract as a server session.

## Student documentation

Write the canonical student guide at `environments/<env>/environment.md`. It should explain the game, starting agent, scoring, helper module, raw contract, time limits, and a first improvement. The documentation catalog discovers the guide and exposes it as the virtual page `students/environments/<slug>.md`; do not create a manual catalog entry, generated mirror, or committed mirror.

Keep the starting `agent.py` body identical to the canonical guide's starter-agent listing (no automated check enforces this). The template's `README.md`, `agent.py`, and helper modules point students to the composed local `environment.md` instead of duplicating the game reference.

Links inside the canonical guide stay relative in the source page, and links to repository files use stable GitHub URLs. [Composition](templates.md#composition) explains how the guide ships into each composed template and how its links are rewritten to resolve from a student's clone.

Every environment must have at least one example. Examples should use the helper module, modeling the style students should adopt, but student pages must not link their source as a solution. Keep an example out of `PUBLISHED_EXAMPLES` when it is useful for CI, development, or tests but should not be published.
