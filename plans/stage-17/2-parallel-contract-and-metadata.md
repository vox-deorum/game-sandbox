# Stage 17.2: Parallel contract and stepping metadata

Status: not started.

Part of [Stage 17](../stage-17-simultaneous-stepping.md), build-order step 2.

## Outcome

An environment can declare `stepping: simultaneous` and ship a `ParallelEnv`, the platform validates the declaration end to end, and an internal fixture environment proves the contract in tests. No public environment changes.

## Metadata

`EnvironmentMeta` gains `stepping`, defaulting to `sequential`. Validation requires `pace_interval_ms` when simultaneous. The field serializes through `to_json()`, the registry JSON, and the `schema/ts/src/environment.ts` mirror with its shape guards. The backend and frontend treat it as opaque except where later steps read it.

`load_environment` cross-checks the declaration against the shape `make()` returns: a simultaneous declaration whose factory returns an AEC env, or the reverse, fails with a typed error naming the environment. The check is duck-typed, consistent with the harness never importing PettingZoo.

## Conformance and fixture

- `environments/test_conformance.py` branches on the mode: sequential environments keep `api_test`, simultaneous ones run `parallel_api_test` plus the seeded determinism and JSON-serializability rollout adapted to parallel stepping.
- An internal fixture environment, a minimal parallel game with a handful of players, lives with the harness tests rather than in `environments/`, is not registered as an entry point, and is exercised directly by the conformance helpers and the step 3 tick-loop tests. The first registered simultaneous environment is the future role-playing one.

## Specification

[Environments](../../docs/specs/environment.md) gains the stepping declaration, revises the sentence making the pace interval the only turn-based versus real-time distinction, and states that simultaneous environments pass `parallel_api_test`.

## Tests

- Metadata validation: simultaneous without a pace interval rejected; mode-versus-shape mismatch rejected at load.
- The fixture passes the parallel conformance branch; registry JSON freshness holds.
