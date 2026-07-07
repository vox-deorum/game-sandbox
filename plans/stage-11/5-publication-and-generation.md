# Stage 11.5: Publication and Generation

Status: not started.

Part of [Stage 11](../stage-11-semantic-contract.md). This is build-order step 5. The contract is the live space objects: the shared `local_play/spaces.py` joins the template base modules so students receive it, the generated template surface exports `default_action` instead of the deleted sentinels, and every generated file is regenerated in one pass so the freshness check stays green. Nothing new flows into `backend/src/generated/environments.json` or the TypeScript `EnvironmentMeta`.

## Why this is its own seam

Generated artifacts must change together or the freshness check fails, and the template-sync change can only land once all three environments have converted (steps 2 through 4) and `local_play/spaces.py` exists (step 1). Landing the generation pass as its own step keeps the environment steps free of generated-file churn and gives the renderers in step 6 a clean, regenerated tree to build on.

## What to build

### Template sync

`scripts/_paths.py` adds `"spaces.py": "local_play/spaces.py"` to `TEMPLATE_BASE_MODULES`, so the shared card/hand/trick spaces and codec sync into `templates/base/sandbox/spaces.py` and reach every template (the same channel that already ships `render_cards.py`). Students can then `from sandbox import spaces` and introspect `CARD`/`HAND`/`TRICK` locally. No game's `TEMPLATE_ENVS` tuple gains a `schemas.py` — there is no `schemas.py`.

In `scripts/generate.py`, `_TEMPLATE_ENV_INITS` stops exporting `AUTO_ACTION` and `NOOP_ACTION` (retired in steps 2 through 4) and exports each game's `default_action` instead, so the rendered template surface offers the real hook.

### No metadata change

`EnvironmentMeta` (Python, `schema/ts/src/environment.ts`, and `environments.json`) is untouched: the observation and action spaces are the contract and live in the registry entry, which the harness already reads. `isEnvironmentMeta` is unchanged. The synthetic fixtures under `schema/fixtures/` pin integer actions (the chatty fixture's bid `57`, the two-step fixture's `tick % 2`), and since the action encoding is unchanged, they need no edits.

### Regeneration

Run the full generation pass and commit its output as one change: the template `sandbox/` trees now including the synced `spaces.py` and the `default_action`-exporting `__init__` surface. `environments.json`, the step-state schema, and the generated TypeScript state types do not change.

## Tests

- The generation freshness check passes: running `scripts/generate.py` after this step produces no diff.
- `templates/base/sandbox/spaces.py` exists and deep-equals `environments/src/local_play/spaces.py`; a template can import `CARD`/`HAND`/`TRICK` from `sandbox.spaces`.
- The composed template surface exposes `default_action` and no longer exposes `AUTO_ACTION` or `NOOP_ACTION`, pinned by the template sync tests.
- The Python and TypeScript suites stay green with `EnvironmentMeta` and `environments.json` unchanged.

## Done when

`npm run generate` is idempotent on a clean checkout, every template ships `sandbox/spaces.py`, the template surface exports `default_action`, and the repo is green across the Python and TypeScript suites — with the browser renderers still reading the old overlay shapes only in the tests that step 6 is about to replace.
