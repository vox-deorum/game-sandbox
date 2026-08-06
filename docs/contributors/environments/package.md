# Environment Package

An environment package defines the PettingZoo behavior and the public metadata that the backend and browser consume. PettingZoo is the standard Python API this project uses for multi-agent games.

Read the [environment specification](../../specs/environment.md) before changing this contract.

## Package shape

### The factory contract

`env.py` exposes `make_env(parameters)`, a factory that receives the complete resolved gameplay parameter map and returns the PettingZoo environment selected by metadata. For a sequential game, `make_env` returns a fresh agent-environment-cycle (AEC) environment; for a simultaneous game, it returns a fresh parallel environment. The map contains the synthesized `players` value for player bounds or `seat_plan` for declared plans. The seed is passed to `reset`, not to the factory.

It also defines `default_action(env, player_id)`, which returns the legal action applied when a player has no action. For example, Flappy Bird returns idle, Hearts returns the lowest legal card, and Spades returns a never-nil bid or the lowest legal card. Return plain Python values, because the result is recorded like any other move.

An environment that removes players before their final outcome is known may implement `result_scores()`. Return `None` until the environment reaches natural completion. At natural completion, return a mapping whose keys exactly match the episode player ids and whose values are finite real numbers. The harness validates and caches the mapping before `env.close()`, then uses it for the reported episode scores. It does not call the hook when an episode stops, fails, or reaches a compute or tick limit before natural completion.

Every module copied into the composed `sandbox.env` package must be self-contained for imports. It may use relative and third-party imports, but only `__init__.py` may import the [harness](../../specs/overview.md#core-model).

The factory must use the values it owns:

- Read resolved integer parameters with `int_parameter` from `game_sandbox_harness.environment`, which rejects missing values, booleans, non-integers, and integers outside the JSON-safe range at runtime. Do not use `assert` for parameter validation because optimized Python removes assertions.
- A module copied into the composed package cannot import the harness at runtime; give it an equivalent local helper or a runtime-safe shared helper.
- A fixed-player factory must explicitly reject a `players` value that disagrees with its construction. Flappy Bird, for example, validates that `players` is `1`, narrows `pipe_gap` as an integer, and passes that value to its game constructor.
- An environment with flexible player bounds reads `players` when it creates `possible_agents`, while one with declared plans reads `seat_plan` and uses the resolved plan's player count.
- The harness validates and normalizes the map before calling the factory, then verifies that the resulting agent count matches the resolved layout.

### Single-agent games

Gymnasium, the single-agent RL API, provides `gymnasium.Env`. `GymnasiumToAEC` in `single_agent.py` adapts a native instance into a one-player AEC environment. It forwards the reset seed and handles stepping, observations, and termination bookkeeping through the wrapped environment.

The single player id is `player_0`. Player ids are PettingZoo agent ids verbatim in state objects, metadata, and harness APIs.

Sequential multi-agent games subclass `pettingzoo.AECEnv` directly and do not use the adapter. Simultaneous games implement PettingZoo's parallel environment interface.

### Overlay

`overlay.py` exposes `extract_overlay(env)`, returning JSON-compatible display data. See [Per-step state object](../../specs/interaction.md#per-step-state-object) for why the overlay must contain everything needed to draw a frame.

The environment owns its display state. Test that every overlay field exists and is finite.

### Registry entry and metadata

`__init__.py` exports an `EnvironmentEntry` made from `EnvironmentMeta`, the environment factory, `default_action`, and the optional overlay hook.

`EnvironmentMeta.to_json()` must round-trip through `json.dumps` because the backend serves it to the frontend.

| Field | Meaning |
| --- | --- |
| `env_id` | Stable id and entry-point name. |
| `display_name`, `description` | Public website text. |
| `layout` | Player bounds or seat plans. See [Players and seats](../../specs/environment.md#players-and-seats). |
| `human_players` | Human-capable players. See [Players and seats](../../specs/environment.md#players-and-seats). |
| `parameters` | Typed gameplay parameter declarations. See [Configurable gameplay parameters](../../specs/environment.md#configurable-gameplay-parameters). |
| `presets` | Named partial parameter maps for common configurations. |
| `human_timeout_ms` | Human move clock, or `None` when pacing is the deadline. |
| `stepping` | Required `sequential` or `simultaneous` contract. See [Stepping contract](../../specs/environment.md#stepping-contract). |
| `recommended_episode_ticks` | Suggested episode length. |
| `pace_interval_ms` | Sequential or simultaneous cadence. See [Stepping contract](../../specs/environment.md#stepping-contract). |
| `view_interval_ms`, `live_interval_ms` | Optional viewing cadence, independent of scoring. |
| `step_limit_ms`, `episode_limit_ms` | Default agent compute limits. |
| `messaging`, `message_cap`, `llm` | Optional agent capabilities. |
| `seat_order_matters` | Whether seat order changes the game. See [Seat order](../../specs/environment.md#seat-order). |
| `renderer` | Browser renderer id. |

The harness checks the constructed environment against `stepping` after receiving the resolved parameters. A simultaneous environment has no separate `human_timeout_ms` and must declare a positive `pace_interval_ms`.

Declare gameplay parameters with the frozen `EnvParameter` and `EnvParameterChoice` dataclasses from `game_sandbox_harness.environment`. Names use snake_case, must be unique, and cannot be `players` or `seat_plan`. Numeric parameters declare inclusive bounds. Choice values are stable non-empty strings with separate friendly labels. Declare common partial configurations with `EnvPreset`; preset names must be unique, and every value must satisfy its parameter declaration.

Use `effective_parameters(meta)` when a consumer needs declarations including the synthesized layout parameter, and `resolve_parameters(meta, overrides)` before constructing an environment outside the session harness. Do not build a partial map by hand.

## Registration and distribution

Do not edit the entry-point table or wheel package list by hand. `npm run sync:envs` discovers packages under `environments/`, reads `ENTRY`, and regenerates `environments/pyproject.toml` and backend metadata.

`environments/.envignore` lists Python packages that are not environments. For example, `local_play/` contains shared helpers and is excluded from registration.

The wheel excludes `*/environment.md`, `*/renderer`, `*/tests`, `*/template`, and `*/examples`, so the student guide, browser code, and student authoring layers stay in the repository without shipping in it.

## Conformance

Every environment runs the mode-selected PettingZoo conformance check through the shared guard in `environments/test_conformance.py`.

The suite builds the environment through the registry entry (`entry.make(resolve_parameters(entry.meta))`), not by calling `make_env` directly. For a sequential environment it runs PettingZoo's `api_test` through a wrapper that tolerates two known PettingZoo warnings and one known dtype bug. For a simultaneous environment it calls `parallel_api_test` directly.

The shared guard also checks the configured parallel roster and mapping rules, deterministic rollout output, overlay JSON and finite values, the required colocated template and example shape, and each published action mask against the declared action space, including the permitted child types of a composite space. Direct `observation_space.contains()` checks still cover a full episode. Game-specific rules and regressions belong in `environments/<env>/tests/`.

A [composite action space](../../specs/environment.md#composite-actions) is sequential-only for now. `parallel_api_test` reduces an action mask to a single index before sampling, so a simultaneous environment declaring one cannot pass conformance until a PettingZoo release carries the fix. The suite does not block it, so the failure comes from PettingZoo rather than from a check here.
