# Stage 17.2: Parallel contract and stepping metadata

Status: complete.

Part of [Stage 17](../stage-17-simultaneous-stepping.md), build-order step 2.

## Outcome

Every environment explicitly declares whether it follows the PettingZoo AEC or parallel contract. The harness checks the environment built for the session's actual parameters, registered conformance selects the matching PettingZoo test and rollout, and an unregistered fixture proves the parallel contract before a public simultaneous environment exists.

This step establishes the contract and metadata only. Stage 17.3 adds the parallel episode loop.

## Required metadata

`EnvironmentMeta` gains the required field:

```python
stepping: Literal["sequential", "simultaneous"]
```

There is no Python default and no wire fallback. Flappy Bird, Hearts, and Spades declare `sequential` explicitly. Every test fixture constructing `EnvironmentMeta` does the same.

Metadata validation requires:

- `stepping` is exactly `sequential` or `simultaneous`;
- simultaneous stepping has a positive `pace_interval_ms`;
- simultaneous stepping has no separate `human_timeout_ms`;
- existing sequential timing combinations remain valid.

`to_json()` emits the field. `schema/ts/src/environment.ts` adds the required string union and rejects missing or unknown values in `isEnvironmentMeta`. The generated backend environment catalog, backend metadata fixtures, frontend fixtures, and schema tests are regenerated or revised together.

The field is not a season override or gameplay parameter. The backend session boundary and harness `LiveConfig` parser reject a supplied human-timeout override for a simultaneous environment. `StartForm` and `SeatAssignmentDialog` hide that override and describe `pace_interval_ms` as the input window. Sequential paced environments retain their current form and launch behavior.

## AEC and parallel entry contract

Revise `EnvironmentEntry` and its contributor documentation so `make(parameters)` returns the PettingZoo protocol selected by `meta.stepping`:

- `sequential` returns an AEC environment with `agent_selection`, `last()`, scalar `step(action)`, and the ordinary agent, reward, termination, and truncation mappings.
- `simultaneous` returns a parallel environment whose `reset()` supplies observation and info mappings and whose `step(actions)` consumes and returns player-keyed mappings.

The harness continues to use `Any` at the package boundary and does not import PettingZoo in production. Small runtime-checkable protocols document the surfaces the two episode paths use.

Add `EnvironmentContractError`, carrying the environment ID, declared stepping mode, and missing or contradictory protocol fact.

Game Sandbox adopts a stricter parallel subset than `parallel_api_test` enforces:

- After reset, `env.agents`, observations, and infos exactly cover every resolved player in canonical order.
- The active set is monotonic. A removed player never returns, and no player appears after reset.
- Each `actions` mapping exactly covers the pre-step active set.
- The returned observations, rewards, terminations, truncations, and infos each exactly cover that same pre-step active set, with no shared or extra keys.
- Post-step `env.agents` is the canonical subsequence of pre-step players whose returned termination and truncation flags are both false.

The exact return-key rule lets the harness record the terminal reward and final observation facts for a player removed by that step. The post-step observation mapping may contain a terminal player's final observation, but it is not carried into another tick.

## Validate the configured instance

`load_environment()` remains discovery-only. It has no resolved gameplay parameters and does not call a factory.

`Episode.start()` performs the configured contract check:

1. Call `entry.make()` with the complete parameters already validated by `Episode`.
2. Check the constructed object's protocol surface against `meta.stepping`.
3. Reset it with the episode seed.
4. Verify its `possible_agents` against the resolved layout as today.
5. For parallel mode, require the exact full resolved roster and reset mapping keys above.

This order catches factories whose return shape depends on a selected player count or seat plan. A declared simultaneous factory returning AEC behavior, or a declared sequential factory returning parallel behavior, fails before a participant reset, recording writer, or live step begins.

Closing remains best-effort on every partial-start failure, and the typed contract error remains an infrastructure error rather than an attributable participant failure.

## Registered conformance

Refactor `environments/test_conformance.py` into mode-specific helpers:

- Sequential entries continue through `api_test` and the existing AEC rollout.
- Simultaneous entries run `parallel_api_test` and a parallel rollout.

The parallel rollout applies both PettingZoo conformance and the stricter product contract:

1. Resets with a fixed seed and validates both returned mappings.
2. Visits active players in canonical order.
3. Validates every observation with that player's observation space.
4. Builds one action mapping from `entry.default_action(env, player)` and validates each action.
5. Calls one parallel step.
6. Requires observation, reward, termination, truncation, and info key sets to equal the pre-step active set.
7. Requires post-step `env.agents` to equal the canonical nonterminal subsequence and rejects revival or newly appearing players.
8. Validates and canonicalizes the post-step overlay.
9. Repeats through termination.

Two runs from the same seed compare canonical observation and overlay snapshots byte for byte. All leaves remain finite and JSON-safe under the existing canonical encoder.

Contributor documentation under `docs/contributors/environments/`, `environments/README.md`, and the harness package description stops describing every native environment as AEC. [Environments](../../docs/specs/environment.md) defines the explicit declaration and mode-selected conformance test.

## Internal fixture

Add a minimal `ParallelEnv` fixture under harness test support, not `environments/`:

- at least three canonical players;
- discrete legal actions and object-shaped observations;
- deterministic reset and transition behavior;
- a state value proving every action was applied together;
- one player that terminates before the others;
- one later individual truncation;
- stable rewards and overlay data;
- a legal default-action provider;
- optional messaging policy whose permitted recipients follow the active player set.

The fixture is not an entry point, has no renderer or student guide, and never appears in generated environment metadata. Direct tests run `parallel_api_test`, the shared parallel rollout helper, and the Stage 17.3 tick path against its `EnvironmentEntry`.

The registered conformance branch is also tested by injecting the fixture entry into the mode-specific helper rather than registering a test-only environment.

## Affected surfaces

At minimum, implementation covers:

- `harness/src/game_sandbox_harness/environment.py`;
- `harness/src/game_sandbox_harness/session.py` startup and error handling;
- `harness/tests/test_environment.py` and episode-start tests;
- all existing Python `EnvironmentMeta` declarations and fixtures;
- `schema/ts/src/environment.ts` and `schema/ts/tests/environment.test.ts`;
- the generated backend catalog and generated-code freshness;
- backend and frontend metadata fixtures accepted by the structural guard;
- backend request and orchestration validation, harness live-config parsing, and both human-timeout forms;
- `environments/test_conformance.py`;
- contributor environment and harness documentation;
- [Environments](../../docs/specs/environment.md).

## Tests

- Missing `stepping` is a Python construction or TypeScript shape error.
- Unknown stepping values fail on both sides.
- Simultaneous without a pace interval, with a nonpositive interval, or with a separate human timeout is rejected.
- Every existing environment declares sequential and still passes AEC conformance and deterministic rollout.
- Both declaration-versus-shape mismatches raise `EnvironmentContractError` at episode start using the actual resolved parameters.
- Parallel reset rejects a missing, extra, reordered, or inactive resolved player and missing or extra observation or info keys.
- Parallel stepping rejects missing or extra keys in any returned mapping, a revived or newly introduced player, and an active set that contradicts the returned terminal flags.
- A partial contract failure closes the constructed environment and opens no recording.
- The internal fixture passes `parallel_api_test`, the parallel deterministic rollout, overlay serialization, and active-player key checks.
- The fixture remains absent from discovery and generated `environments.json`.
- Jsdom coverage supplies simultaneous metadata to `StartForm` and `SeatAssignmentDialog`, verifies that neither offers a separate human-timeout override, and preserves the existing paced-sequential control.
- A Playwright journey intercepts the environment catalog with the same simultaneous metadata and checks both start surfaces without registering or launching a public simultaneous environment.
- The backend and harness reject a simultaneous human-timeout override supplied directly.

## Done when

- Public metadata and every authored environment make the stepping contract explicit.
- Production discovery remains side-effect free.
- The configured environment instance is rejected before participant work when it contradicts its declaration.
- Registered AEC and parallel environments have separate, tested conformance and deterministic-rollout paths.
- Stage 17.3 can select the parallel path without guessing from object shape.
