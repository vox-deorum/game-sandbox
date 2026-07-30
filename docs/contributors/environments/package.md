# Environment Package

An environment package defines the PettingZoo behavior and the public metadata that the backend and browser consume.

Read the [environment specification](../../specs/environment.md) before changing this contract.

## Package shape

`env.py` exposes `make_env(parameters)`, a factory that receives the complete resolved gameplay parameter map and returns the PettingZoo environment selected by metadata. A sequential environment returns a fresh agent-environment-cycle (AEC) environment. A simultaneous environment returns a fresh parallel environment. The map contains the synthesized `players` value for player bounds or `seat_plan` for declared plans. The seed is passed to `reset`, not to the factory.

It also defines `default_action(env, player_id)`, which returns the legal integer applied when a player has no action. For example, Flappy Bird returns idle, Hearts returns the lowest legal card, and Spades returns a never-nil bid or the lowest legal card.

Every module copied into the composed `sandbox.env` package must be self-contained for imports. It may use relative and third-party imports, but only `__init__.py` may import the harness.

### Single-agent games

`GymnasiumToAEC` in `single_agent.py` adapts a native `gymnasium.Env` into a one-player AEC environment. It forwards the reset seed and handles stepping, observations, and termination bookkeeping through the wrapped environment.

The single player id is `player_0`. Player ids are PettingZoo agent ids verbatim in state objects, metadata, and harness APIs.

Sequential multi-agent games subclass `pettingzoo.AECEnv` directly and do not use the adapter. Simultaneous games implement PettingZoo's parallel environment interface.

### Overlay

`overlay.py` exposes `extract_overlay(env)`, returning JSON-compatible display data. The browser renderer never inspects the live environment, so the overlay contains everything needed to draw a frame.

The environment owns its display state. Test that every overlay field exists and is finite.

### Registry entry and metadata

`__init__.py` exports an `EnvironmentEntry` made from `EnvironmentMeta`, the environment factory, `default_action`, and the optional overlay hook.

`EnvironmentMeta.to_json()` must round-trip through `json.dumps` because the backend serves it to the frontend.

| Field | Meaning |
| --- | --- |
| `env_id` | Stable id and entry-point name. |
| `display_name`, `description` | Public website text. |
| `layout` | Either player bounds or the environment's declared seat plans. |
| `human_players` | PettingZoo players that a person may control. |
| `parameters` | Typed gameplay parameter declarations. The public JSON also includes the synthesized `players` or `seat_plan` parameter. |
| `human_timeout_ms` | Human move clock, or `None` when pacing is the deadline. |
| `stepping` | Required `sequential` or `simultaneous` PettingZoo contract. |
| `recommended_episode_ticks` | Suggested episode length. |
| `pace_interval_ms` | Realtime cadence for sequential play, or the required positive input window for simultaneous play. |
| `view_interval_ms`, `live_interval_ms` | Optional replay and live viewing cadence. They never affect scoring. |
| `step_limit_ms`, `episode_limit_ms` | Default agent compute limits. |
| `messaging`, `message_cap`, `llm` | Optional agent capabilities. |
| `seat_order_matters` | Whether scheduler seat order creates a distinct game. |
| `renderer` | Browser renderer id. |

The harness checks the constructed environment against `stepping` after it receives the resolved parameters. A simultaneous environment has no separate `human_timeout_ms` and must declare a positive `pace_interval_ms`.

Declare gameplay parameters with the frozen `EnvParameter` and `EnvParameterChoice` dataclasses from `game_sandbox_harness.environment`. Names use snake_case, must be unique, and cannot be `players` or `seat_plan`. Numeric parameters declare inclusive bounds. Choice values are stable non-empty strings with separate friendly labels.

The factory must use the values it owns:

- Read resolved integer parameters with `int_parameter` from `game_sandbox_harness.environment`, which rejects missing values, booleans, non-integers, and integers outside the JSON-safe range at runtime. Do not use `assert` for parameter validation because optimized Python removes assertions.
- A module copied into the composed `sandbox.env` package cannot import the harness at runtime, so give it an equivalent local helper or a runtime-safe shared helper.
- A fixed-player factory must explicitly reject a `players` value that disagrees with its construction. Flappy Bird, for example, validates that `players` is `1`, narrows `pipe_gap` as an integer, and passes that value to its game constructor.
- An environment with flexible player bounds reads `players` when it creates `possible_agents`. An environment with declared plans reads `seat_plan` and uses the resolved plan's player count.
- The harness validates and normalizes the map before calling the factory, then verifies that the resulting agent count matches the resolved layout.

Use `effective_parameters(meta)` when a consumer needs declarations including the synthesized layout parameter, and use `resolve_parameters(meta, overrides)` before constructing an environment outside the session harness. Do not build a partial map by hand.

## Registration and distribution

Do not edit the entry-point table or wheel package list by hand. `npm run sync:envs` discovers packages under `environments/`, reads `ENTRY`, and regenerates `environments/pyproject.toml` and backend metadata.

`environments/.envignore` lists Python packages that are not environments. For example, `local_play/` contains shared helpers and is excluded from registration.

The wheel excludes `*/renderer`, `*/tests`, `*/template`, and `*/examples`, so browser code and student authoring layers stay in the repository without shipping in the environment wheel.

## Conformance

Every environment runs the mode-selected PettingZoo conformance check through the shared guard in `environments/test_conformance.py`.

```python
from pettingzoo.test import api_test, parallel_api_test

parameters = resolve_parameters(ENTRY.meta)
env = make_env(parameters)
if ENTRY.meta.stepping == "sequential":
    api_test(env, num_cycles=100)
else:
    parallel_api_test(env, num_cycles=100)
```

The shared guard also checks the configured parallel roster and mapping rules, deterministic rollout output, overlay JSON, and finite values. Direct `observation_space.contains()` checks still cover a full episode.

The discovery-driven suite also checks determinism, overlay JSON and finite values, and the required colocated template and example shape. Keep game-specific rules and regressions in `environments/<env>/tests/`.
