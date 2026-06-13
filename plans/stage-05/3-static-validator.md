# Stage 5.3: Static Validator

Status: not started.

Part of [Stage 5](../stage-05-submissions.md). This is build-order step 3 and **the first demonstrable slice of the stage**: a pure TypeScript check over the fetched tree that runs no participant code, mirrors the static half of the harness loader, and returns either a typed accept or one specific, owner-visible rejection reason. Fully unit-testable against local fixtures with no Docker and no network.

## What it checks

A single function in `backend/src/submission/validate/static.ts` taking a fetched tree (the handle from step 2), the open iteration's `deps_version`, and the set of dependency-set versions the deployment has a base image for. It returns a discriminated result: `{ ok: true, manifest }` or `{ ok: false, reason }`, where `reason` is one of a closed set of typed codes and each code carries an owner-facing message. The checks, in order, mirror `load_manifest` in [manifest.py](../../harness/src/game_sandbox_harness/manifest.py) plus the checks this layer owns (entry-point existence, known `template_version`, and matching the iteration), per [submission.md](../../docs/specs/submission.md)'s static-checks list:

1. `manifest.json` is present at the tree root, else `manifest_missing`.
2. It is valid JSON, else `manifest_invalid_json`.
3. It carries **exactly** the required fields with the right types and **no unknown keys**: the entry-point module, the agent class name, and the `template_version` (the fields [submission.md](../../docs/specs/submission.md) Packaging names). A missing or mistyped field or an extra key is its own reason (`manifest_field_invalid` with the offending field, `manifest_unknown_key` with the key). The strictness is deliberate so typos surface here, not at load time.
4. The entry-point module file the manifest names **exists** in the tree, else `entry_point_missing`. Treat `entry_point` as a Python module path rooted at the repo: `agent` may resolve to `agent.py` or `agent/__init__.py`, and `package.agent` may resolve to `package/agent.py` or `package/agent/__init__.py`. This layer checks existence only; importing it is the step-4 load check's job.
5. The manifest's `template_version` targets a dependency-set version the deployment has a base image for, else `unknown_template_version`.
6. The manifest's `template_version` matches the open iteration's `deps_version`, else `template_version_mismatch`. This keeps the Stage 5 seed aligned with [leaderboard.md](../../docs/specs/leaderboard.md)'s rule that every submission in an iteration runs on the same dependency set.

Reachability and ref-resolution failures from step 2 are folded into the same typed-reason vocabulary so the API and form treat every static rejection uniformly, even though they are detected during source resolution rather than here.

## Mirroring the harness loader, not importing it

The harness `load_manifest` is Python inside the container; this is TypeScript in the backend. They must agree on the manifest contract, so this file and [manifest.py](../../harness/src/game_sandbox_harness/manifest.py) are kept deliberately in lockstep. The required-fields, field-types, and no-unknown-keys rules are the shared contract, and a change to one is a change to both in the same change set (the plan-stays-connected rule in [the plan README](../README.md)). The contract itself traces to the versioned packaging spec, so neither side invents fields. This is only the static half; the dynamic half (import, instantiate, confirm `reset`/`act`) is reused, not reimplemented, by the harness `validate` command in step 4.

## Wiring

The static check is the first manifest gate in the submission pipeline (source resolution in step 2 is the gate before it): a tree that fails it never reaches the sandboxed load check or the build. On failure the submission row (step 1) is updated to `static_failed` with the reason, and the worker (step 5) records the `static` stage of the validation log as `failed` with the same reason as its `detail`; on success it records the `static` stage `passed`. The API (step 5) returns both the rollup status and the per-stage log, and the form and agent profile show which stage rejected. This pure function stays log-agnostic — it returns the typed accept/reason and the worker is what writes the check — so it remains exercisable now against fixtures. This file delivers the pure function and its tests; the route and the log-writing land in step 5.

## Tests

This is the Docker-free, fixtures-driven heart of the stage's "Done when". A `fixtures/` set of small repos, each isolating one failure plus a valid control:

- valid manifest plus present entry point accepts and returns the parsed manifest.
- missing `manifest.json` returns `manifest_missing`.
- malformed JSON returns `manifest_invalid_json`.
- each required field missing or wrong-typed returns `manifest_field_invalid` naming that field.
- an extra unknown key returns `manifest_unknown_key` naming the key.
- entry-point module named but absent returns `entry_point_missing`.
- `template_version` with no deployment base image returns `unknown_template_version`.
- `template_version` known to the deployment but different from the open iteration returns `template_version_mismatch`.

Every malformed fixture rejects with the correct, specific reason, matching the exit criterion verbatim, and the worked example's real manifest passes. These run in plain Vitest, no Docker, no network, and are the proof this stage is demonstrable before any container work exists.

## Done when

The validator accepts the template repo's manifest and rejects each malformed fixture with its correct specific reason, proven by Docker-free unit tests. This is the slice the parent plan flags as first-demonstrable; steps 4-6 build on the accept result, and a static rejection short-circuits the rest of the pipeline.
